import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface UpsertSubscriptionInput {
  subscriberSub: string;
  eventName: string;
  channel: string;
  targetUrl: string;
  secret: string;
  ttlMs: number;
}

export interface DueDeliveryRecord {
  delivery_id: string;
  event_id: string;
  event_type: string;
  payload_json: string;
  event_created_at: string;
  subscription_id: string;
  target_url: string;
  secret: string;
  attempt_count: number;
}

export class EventSubscriptionStore {
  constructor(private readonly db: DatabaseSync) {}

  public computeSubscriptionId(
    subscriberSub: string,
    eventName: string,
    channel: string,
    targetUrl: string
  ): string {
    const canonical = JSON.stringify([
      subscriberSub,
      eventName,
      { channel },
      targetUrl
    ]);
    const digest = createHash('sha256')
      .update(canonical, 'utf8')
      .digest('hex')
      .slice(0, 24);
    return `sub_${digest}`;
  }

  public upsertSubscription(input: UpsertSubscriptionInput): {
    subscriptionId: string;
    expiresAt: number;
  } {
    const subscriptionId = this.computeSubscriptionId(
      input.subscriberSub,
      input.eventName,
      input.channel,
      input.targetUrl
    );
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const expiresAt = now + input.ttlMs;

    this.db
      .prepare(
        `INSERT INTO subscriptions (
           subscription_id, subscriber_sub, event_name, channel, target_url, secret, expires_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(subscription_id) DO UPDATE SET
           secret = excluded.secret,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`
      )
      .run(
        subscriptionId,
        input.subscriberSub,
        input.eventName,
        input.channel,
        input.targetUrl,
        input.secret,
        expiresAt,
        nowIso,
        nowIso
      );

    return { subscriptionId, expiresAt };
  }

  public removeSubscription(
    subscriberSub: string,
    eventName: string,
    channel: string,
    targetUrl: string
  ): boolean {
    const subscriptionId = this.computeSubscriptionId(
      subscriberSub,
      eventName,
      channel,
      targetUrl
    );
    const res = this.db
      .prepare(
        `DELETE FROM subscriptions
         WHERE subscription_id = ? AND subscriber_sub = ?`
      )
      .run(subscriptionId, subscriberSub);
    return Number(res.changes) > 0;
  }

  public removeSubscriptionById(subscriberSub: string, subscriptionId: string): boolean {
    const res = this.db
      .prepare(
        `DELETE FROM subscriptions
         WHERE subscription_id = ? AND subscriber_sub = ?`
      )
      .run(subscriptionId, subscriberSub);
    return Number(res.changes) > 0;
  }

  public fetchDueDeliveries(limit = 20): DueDeliveryRecord[] {
    const now = Date.now();
    return this.db
      .prepare(
        `SELECT
           d.delivery_id,
           d.event_id,
           e.event_type,
           e.payload_json,
           e.created_at AS event_created_at,
           d.subscription_id,
           s.target_url,
           s.secret,
           d.attempt_count
         FROM deliveries d
         JOIN events e ON e.event_id = d.event_id
         JOIN subscriptions s ON s.subscription_id = d.subscription_id
         WHERE d.status = 'pending'
           AND d.next_attempt_at <= ?
           AND s.expires_at > ?
         ORDER BY d.next_attempt_at ASC
         LIMIT ?`
      )
      .all(now, now, limit) as unknown as DueDeliveryRecord[];
  }

  public markDelivered(deliveryId: string, httpStatus: number): void {
    const nowIso = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE deliveries
         SET status = 'delivered',
             attempt_count = attempt_count + 1,
             last_http_status = ?,
             last_error = NULL,
             updated_at = ?
         WHERE delivery_id = ?`
      )
      .run(httpStatus, nowIso, deliveryId);
  }

  public markRetryOrFailed(
    deliveryId: string,
    nextAttemptCount: number,
    maxAttempts: number,
    httpStatus: number | null,
    errorMsg: string
  ): void {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const isPermanentHttpFailure =
      httpStatus !== null &&
      httpStatus >= 400 &&
      httpStatus < 500 &&
      httpStatus !== 408 &&
      httpStatus !== 429;

    if (isPermanentHttpFailure || nextAttemptCount >= maxAttempts) {
      this.db
        .prepare(
          `UPDATE deliveries
           SET status = 'failed',
               attempt_count = ?,
               last_http_status = ?,
               last_error = ?,
               updated_at = ?
           WHERE delivery_id = ?`
        )
        .run(
          nextAttemptCount,
          httpStatus,
          errorMsg.slice(0, 500),
          nowIso,
          deliveryId
        );
      return;
    }

    const backoffMs = Math.min(300_000, Math.pow(2, nextAttemptCount) * 1000);
    const nextAttemptAt = now + backoffMs;

    this.db
      .prepare(
        `UPDATE deliveries
         SET status = 'pending',
             attempt_count = ?,
             next_attempt_at = ?,
             last_http_status = ?,
             last_error = ?,
             updated_at = ?
         WHERE delivery_id = ?`
      )
      .run(
        nextAttemptCount,
        nextAttemptAt,
        httpStatus,
        errorMsg.slice(0, 500),
        nowIso,
        deliveryId
      );
  }
}
