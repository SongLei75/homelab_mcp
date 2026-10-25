import { randomUUID } from 'node:crypto';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { ResourceTemplate } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { AuditLogger } from '../audit/audit.js';
import type { AuthContext } from '../auth/types.js';
import type { WebhookDispatcher } from '../events/dispatcher.js';
import type { MessageStore } from '../messages/store.js';
import { getMcpRequestContext } from '../observability/request-context.js';
import { toolResult } from '../tools/schema.js';

export interface CollabRuntime {
  messageStore: MessageStore;
  dispatcher: Pick<WebhookDispatcher, 'notifyNewEvent'>;
  notifyResourceUpdated: (uri: string) => Promise<void> | void;
}

export function buildChannelResourceUri(channel: string): string {
  return `collab://channels/${encodeURIComponent(channel)}/messages`;
}

export const messagePublishInputSchema = z.object({
  channel: z.string().min(1).max(64),
  content: z.string().min(1),
  sender_name: z.string().max(64).optional(),
  idempotency_key: z.string().max(128).optional()
}).strict();

export const messagePublishOutputSchema = z.object({
  message_id: z.string(),
  channel: z.string(),
  created_at: z.string()
}).strict();

export const messageReadInputSchema = z.object({
  channel: z.string().min(1).max(64),
  after_id: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(200).optional()
}).strict();

export const messageReadOutputSchema = z.object({
  channel: z.string(),
  messages: z.array(
    z.object({
      id: z.number().int(),
      message_id: z.string(),
      channel: z.string(),
      content: z.string(),
      sender_sub: z.string(),
      sender_name: z.string().nullable(),
      created_at: z.string()
    }).strict()
  ),
  next_after_id: z.number().int()
}).strict();

export function createMessagePublishTool(
  audit: AuditLogger,
  collab: CollabRuntime,
  auth?: AuthContext
) {
  return {
    name: 'message_publish',
    definition: {
      title: 'Publish channel message',
      description: 'Publish a persistent message to a shared channel and emit a message.created event.',
      inputSchema: messagePublishInputSchema,
      outputSchema: messagePublishOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    handler: async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const requestId = getMcpRequestContext()?.requestId ?? randomUUID();
      const executionId = randomUUID();
      const parsed = messagePublishInputSchema.parse(args ?? {});
      const senderSub = auth?.subject ?? 'local-anonymous';

      const result = collab.messageStore.publishMessage({
        channel: parsed.channel,
        content: parsed.content,
        senderSub,
        senderName: parsed.sender_name,
        idempotencyKey: parsed.idempotency_key
      });

      const resourceUri = buildChannelResourceUri(result.channel);
      if (!result.deduplicated) {
        await Promise.resolve(collab.notifyResourceUpdated(resourceUri));
        collab.dispatcher.notifyNewEvent();
      }

      await audit.write({
        requestId,
        executionId,
        event: 'tool.exec',
        decision: 'allow',
        toolName: 'message_publish',
        tool: 'message_publish',
        subject: senderSub,
        args: { channel: result.channel, message_id: result.messageId }
      });

      return toolResult({
        message_id: result.messageId,
        channel: result.channel,
        created_at: result.createdAt
      });
    }
  };
}

export function createMessageReadTool(
  audit: AuditLogger,
  collab: CollabRuntime,
  auth?: AuthContext
) {
  return {
    name: 'message_read',
    definition: {
      title: 'Read channel messages',
      description: 'Read incremental messages from a shared channel in creation order.',
      inputSchema: messageReadInputSchema,
      outputSchema: messageReadOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    handler: async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const requestId = getMcpRequestContext()?.requestId ?? randomUUID();
      const executionId = randomUUID();
      const parsed = messageReadInputSchema.parse(args ?? {});
      const snapshot = collab.messageStore.readMessages(
        parsed.channel,
        parsed.after_id ?? 0,
        parsed.limit ?? 50
      );

      await audit.write({
        requestId,
        executionId,
        event: 'tool.exec',
        decision: 'allow',
        toolName: 'message_read',
        tool: 'message_read',
        subject: auth?.subject,
        args: { channel: snapshot.channel, after_id: parsed.after_id ?? 0, limit: parsed.limit ?? 50 }
      });

      return toolResult({
        channel: snapshot.channel,
        messages: snapshot.messages,
        next_after_id: snapshot.next_after_id
      });
    }
  };
}

export function registerCollabResources(
  server: McpServer,
  collab: CollabRuntime
): void {
  const template = new ResourceTemplate('collab://channels/{channel}/messages', {
    list: async () => ({
      resources: collab.messageStore.listChannels().map(ch => ({
        uri: buildChannelResourceUri(ch),
        name: `${ch} messages`,
        title: `Channel #${ch} messages`,
        mimeType: 'application/json',
        description: `Subscribable message snapshot for channel ${ch}`
      }))
    })
  });

  server.registerResource(
    'channel_messages',
    template,
    {
      title: 'Channel Messages',
      description: 'Subscribable channel message snapshot',
      mimeType: 'application/json'
    },
    async (uri, variables) => {
      const rawChannel = typeof variables.channel === 'string' ? variables.channel : 'general';
      const channel = decodeURIComponent(rawChannel);
      const snapshot = collab.messageStore.readMessages(channel, 0, 50);
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'application/json',
            text: JSON.stringify(snapshot)
          }
        ]
      };
    }
  );
}
