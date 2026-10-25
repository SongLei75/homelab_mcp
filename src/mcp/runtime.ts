import type { AppConfig } from '../config.js';
import { resolveCollabConfig } from '../config.js';
import { openCollabDatabase } from '../db/sqlite.js';
import { MessageStore } from '../messages/store.js';
import { EventSubscriptionStore } from '../events/store.js';
import { WebhookDispatcher } from '../events/dispatcher.js';
import { EventsRpcHandler } from '../events/rpc.js';
import { createNotificationClient, createNotificationHub, type NotificationBridge } from './notify.js';
import type { CollabRuntime } from './collab.js';

export interface McpRuntime {
  collab: CollabRuntime;
  eventsRpc: EventsRpcHandler;
  dispatcher: WebhookDispatcher;
  messageStore: MessageStore;
  subscriptionStore: EventSubscriptionStore;
  setResourceNotifier(fn: (uri: string) => void | Promise<void>): void;
  close(): void;
}

/** Business runtime shared by both MCP transports. Only the HTTP process runs the
 * Webhook outbox worker; stdio uses the same persisted data and RPC methods. */
export async function createMcpRuntime(config: AppConfig, owner: 'http' | 'stdio'): Promise<McpRuntime> {
  const options = resolveCollabConfig(config);
  const db = openCollabDatabase(options.dbPath);
  const messages = new MessageStore(db, options);
  const subscriptions = new EventSubscriptionStore(db);
  const dispatcher = new WebhookDispatcher(subscriptions, options);
  const eventsRpc = new EventsRpcHandler(messages, subscriptions, dispatcher, config, options);
  let notifier: (uri: string) => void | Promise<void> = () => {};
  let bridge: NotificationBridge;
  try {
    bridge = owner === 'http'
      ? await createNotificationHub(options.dbPath, uri => { void notifier(uri); })
      : createNotificationClient(options.dbPath, uri => { void notifier(uri); });
  } catch (err) { db.close(); throw err; }
  if (owner === 'http') dispatcher.start();
  const collab: CollabRuntime = {
    messageStore: messages,
    dispatcher: { notifyNewEvent: () => { if (owner === 'http') dispatcher.notifyNewEvent(); } },
    notifyResourceUpdated(uri) {
      bridge.publish(uri);
      return notifier(uri);
    }
  };
  return {
    collab, eventsRpc, dispatcher,
    messageStore: messages, subscriptionStore: subscriptions,
    setResourceNotifier(fn) { notifier = fn; },
    close() { dispatcher.stop(); bridge.close(); db.close(); }
  };
}
