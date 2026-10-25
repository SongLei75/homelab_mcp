import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CollabConfig } from '../config.js';

const CHANNEL_REGEX = /^[a-zA-Z0-9._-]{1,64}$/;

export interface PublishMessageInput {
  channel: string;
  content: string;
  senderSub: string;
  senderName?: string;
  idempotencyKey?: string;
}

export interface PublishedMessageResult {
  seq: number;
  messageId: string;
  eventId: string;
  channel: string;
  createdAt: string;
  deduplicated: boolean;
}

export interface ChannelMessageRecord {
  id: number;
  message_id: string;
  channel: string;
  content: string;
  sender_sub: string;
  sender_name: string | null;
  created_at: string;
}

export interface ReadMessagesResult {
  channel: string;
  messages: ChannelMessageRecord[];
  next_after_id: number;
}

export class MessageStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly config: CollabConfig
  ) {}

  public validateChannel(channel: string): string {
    const trimmed = channel.trim();
    if (
      !trimmed ||
      trimmed.length > this.config.maxChannelNameLength ||
      !CHANNEL_REGEX.test(trimmed)
    ) {
      throw new Error(
        `Invalid channel name "${channel}". Allowed: 1-${this.config.maxChannelNameLength} chars [a-zA-Z0-9._-].`
      );
    }
    return trimmed;
  }

  public publishMessage(input: PublishMessageInput): PublishedMessageResult {
    const channel = this.validateChannel(input.channel);
    const byteLength = Buffer.byteLength(input.content, 'utf8');
    if (byteLength === 0 || byteLength > this.config.maxMessageContentBytes) {
      throw new Error(
        `Message content must be between 1 and ${this.config.maxMessageContentBytes} bytes.`
      );
    }

    const idempotencyKey = input.idempotencyKey?.trim() || null;
    if (idempotencyKey && idempotencyKey.length > 128) {
      throw new Error('idempotencyKey must not exceed 128 characters.');
    }

    this.db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      if (idempotencyKey) {
        const existing = this.db
          .prepare(
            `SELECT m.seq, m.message_id, m.channel, m.created_at, e.event_id
             FROM messages m
             JOIN events e ON e.message_id = m.message_id
             WHERE m.sender_sub = ? AND m.channel = ? AND m.idempotency_key = ?`
          )
          .get(input.senderSub, channel, idempotencyKey) as
          | {
              seq: number;
              message_id: string;
              channel: string;
              created_at: string;
              event_id: string;
            }
          | undefined;

        if (existing) {
          this.db.exec('COMMIT');
          return {
            seq: existing.seq,
            messageId: existing.message_id,
            eventId: existing.event_id,
            channel: existing.channel,
            createdAt: existing.created_at,
            deduplicated: true
          };
        }
      }

      const messageId = `msg_${randomUUID().replace(/-/g, '')}`;
      const eventId = `evt_${randomUUID().replace(/-/g, '')}`;
      const createdAt = new Date().toISOString();

      const msgResult = this.db
        .prepare(
          `INSERT INTO messages (message_id, channel, content, sender_sub, sender_name, idempotency_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          messageId,
          channel,
          input.content,
          input.senderSub,
          input.senderName?.trim() || null,
          idempotencyKey,
          createdAt
        );

      const seq = Number(msgResult.lastInsertRowid);
      const payloadJson = JSON.stringify({
        message_id: messageId,
        channel,
        created_at: createdAt
      });

      this.db
        .prepare(
          `INSERT INTO events (event_id, event_type, channel, message_id, payload_json, created_at)
           VALUES (?, 'message.created', ?, ?, ?, ?)`
        )
        .run(eventId, channel, messageId, payloadJson, createdAt);

      this.db.prepare(`
        INSERT OR IGNORE INTO deliveries
          (delivery_id, event_id, subscription_id, status, attempt_count, next_attempt_at, created_at, updated_at)
        SELECT lower(hex(randomblob(16))), ?, subscription_id, 'pending', 0, ?, ?, ?
        FROM subscriptions
        WHERE event_name = 'message.created' AND channel = ? AND expires_at > ?
      `).run(eventId, Date.now(), createdAt, createdAt, channel, Date.now());

      this.db.exec('COMMIT');
      return {
        seq,
        messageId,
        eventId,
        channel,
        createdAt,
        deduplicated: false
      };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  public readMessages(
    rawChannel: string,
    afterId = 0,
    limit = this.config.defaultReadLimit
  ): ReadMessagesResult {
    const channel = this.validateChannel(rawChannel);
    const safeAfterId = Math.max(0, Math.floor(afterId));
    const safeLimit = Math.min(
      this.config.maxReadLimit,
      Math.max(1, Math.floor(limit))
    );

    const rows = this.db
      .prepare(
        `SELECT seq AS id, message_id, channel, content, sender_sub, sender_name, created_at
         FROM messages
         WHERE channel = ? AND seq > ?
         ORDER BY seq ASC
         LIMIT ?`
      )
      .all(channel, safeAfterId, safeLimit) as unknown as ChannelMessageRecord[];

    const nextAfterId = rows.length > 0 ? rows[rows.length - 1].id : safeAfterId;

    return {
      channel,
      messages: rows,
      next_after_id: nextAfterId
    };
  }

  public listChannels(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT channel FROM messages ORDER BY channel ASC LIMIT 100')
      .all() as unknown as Array<{ channel: string }>;
    const set = new Set<string>(['general']);
    for (const row of rows) {
      set.add(row.channel);
    }
    return Array.from(set);
  }
}
