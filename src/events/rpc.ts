import type { AppConfig, CollabConfig } from '../config.js';
import type { AuthContext } from '../auth/types.js';
import { hasScope } from '../auth/types.js';
import type { MessageStore } from '../messages/store.js';
import type { WebhookDispatcher } from './dispatcher.js';
import { assertSafeWebhookUrl, decodeWebhookSecret } from './security.js';
import type { EventSubscriptionStore } from './store.js';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export class EventsRpcHandler {
  constructor(
    private readonly messageStore: MessageStore,
    private readonly subStore: EventSubscriptionStore,
    private readonly dispatcher: WebhookDispatcher,
    private readonly appConfig: AppConfig,
    private readonly collabConfig: CollabConfig
  ) {}

  public isDirectEventsMethod(method: string): boolean {
    return (
      method === 'events/list' ||
      method === 'events/subscribe' ||
      method === 'events/unsubscribe'
    );
  }

  public async handleRpc(
    req: JsonRpcRequest,
    auth?: AuthContext
  ): Promise<JsonRpcResponse> {
    const id = req.id ?? null;

    if (this.appConfig.authMode === 'oauth_jwt' && !hasScope(auth, 'mcp:read')) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32001, message: 'Forbidden: missing required scope mcp:read.' }
      };
    }

    const subscriberSub = auth?.subject ?? 'local-anonymous';

    try {
      switch (req.method) {
        case 'events/list':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              events: [
                {
                  name: 'message.created',
                  description: '指定频道中产生了新消息',
                  delivery: ['webhook'],
                  inputSchema: {
                    type: 'object',
                    properties: {
                      channel: {
                        type: 'string',
                        description: '频道名称，例如 general'
                      }
                    },
                    required: ['channel'],
                    additionalProperties: false
                  },
                  payloadSchema: {
                    type: 'object',
                    properties: {
                      message_id: { type: 'string' },
                      channel: { type: 'string' },
                      created_at: { type: 'string', format: 'date-time' }
                    },
                    required: ['message_id', 'channel', 'created_at']
                  }
                }
              ]
            }
          };

        case 'events/subscribe': {
          const params = req.params ?? {};
          const name = params.name;
          const args = (params.arguments ?? {}) as Record<string, unknown>;
          const delivery = (params.delivery ?? {}) as Record<string, unknown>;
          const ttlMsRaw = params.ttlMs;
          if (params.cursor !== undefined && params.cursor !== null) {
            return this.invalidParams(id, 'Event replay is not supported (cursor must be null).');
          }

          if (name !== 'message.created') {
            return this.invalidParams(
              id,
              "Unsupported event name. Only 'message.created' is supported."
            );
          }

          if (typeof args.channel !== 'string') {
            return this.invalidParams(
              id,
              "Missing required filter argument: 'arguments.channel'."
            );
          }
          const channel = this.messageStore.validateChannel(args.channel);

          if (delivery.mode !== 'webhook') {
            return this.invalidParams(
              id,
              "Unsupported delivery mode. Only 'webhook' is supported."
            );
          }

          if (
            typeof delivery.url !== 'string' ||
            typeof delivery.secret !== 'string'
          ) {
            return this.invalidParams(
              id,
              "Webhook delivery requires 'url' and 'secret'."
            );
          }

          const parsedUrl = await assertSafeWebhookUrl(delivery.url, this.collabConfig);
          const normalizedUrl = parsedUrl.toString();
          decodeWebhookSecret(delivery.secret);

          let ttlMs = this.collabConfig.defaultSubscriptionTtlMs;
          if (ttlMsRaw !== undefined && ttlMsRaw !== null) {
            if (typeof ttlMsRaw !== 'number' || !Number.isSafeInteger(ttlMsRaw) || ttlMsRaw <= 0) {
              return this.invalidParams(id, 'ttlMs must be a positive integer.');
            }
            ttlMs = Math.min(this.collabConfig.maxSubscriptionTtlMs, ttlMsRaw);
          }

          const previewSubId = this.subStore.computeSubscriptionId(
            subscriberSub,
            'message.created',
            channel,
            normalizedUrl
          );

          try {
            await this.dispatcher.verifySubscriptionChallenge(
              normalizedUrl, delivery.secret, previewSubId
            );
          } catch (err) {
            return { jsonrpc: '2.0', id, error: {
              code: -32015, message: 'Callback verification failed',
              data: { reason: err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'challenge_failed' }
            } };
          }

          const saved = this.subStore.upsertSubscription({
            subscriberSub,
            eventName: 'message.created',
            channel,
            targetUrl: normalizedUrl,
            secret: delivery.secret,
            ttlMs
          });

          return {
            jsonrpc: '2.0',
            id,
            result: {
              id: saved.subscriptionId,
              refreshBefore: new Date(saved.expiresAt).toISOString(),
              cursor: null,
              truncated: false
            }
          };
        }

        case 'events/unsubscribe': {
          const params = req.params ?? {};
          const subscriptionId = typeof params.subscriptionId === 'string' ? params.subscriptionId : undefined;
          if (subscriptionId) {
            this.subStore.removeSubscriptionById(subscriberSub, subscriptionId);
            return {
              jsonrpc: '2.0',
              id,
              result: {}
            };
          }

          const name = params.name;
          const args = (params.arguments ?? {}) as Record<string, unknown>;
          const delivery = (params.delivery ?? {}) as Record<string, unknown>;
          const targetUrlRaw =
            typeof delivery.url === 'string'
              ? delivery.url
              : typeof params.url === 'string'
              ? params.url
              : '';

          if (
            name !== 'message.created' ||
            typeof args.channel !== 'string' ||
            !targetUrlRaw
          ) {
            return this.invalidParams(
              id,
              "events/unsubscribe requires 'name', 'arguments.channel', and 'delivery.url' (or 'subscriptionId')."
            );
          }

          const channel = this.messageStore.validateChannel(args.channel);
          const normalizedUrl = new URL(targetUrlRaw).toString();

          this.subStore.removeSubscription(
            subscriberSub,
            'message.created',
            channel,
            normalizedUrl
          );

          return {
            jsonrpc: '2.0',
            id,
            result: {}
          };
        }

        default:
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32601,
              message: `Method not found: ${req.method}`
            }
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      return this.invalidParams(id, message);
    }
  }

  private invalidParams(
    id: string | number | null,
    message: string
  ): JsonRpcResponse {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32602, message }
    };
  }
}
