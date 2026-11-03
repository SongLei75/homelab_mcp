import type { AppConfig } from '../config.js';
import { resolveCollabConfig } from '../config.js';
import { openCollabDatabase } from '../db/sqlite.js';
import { MessageStore } from '../messages/store.js';
import { EventSubscriptionStore } from '../events/store.js';
import { WebhookDispatcher } from '../events/dispatcher.js';
import { EventsRpcHandler } from '../events/rpc.js';
import type { CollabRuntime } from './collab.js';
import { PlaywrightBridge } from './playwright.js';

export interface McpRuntime {
  playwright?: PlaywrightBridge;
  collab: CollabRuntime;
  eventsRpc: EventsRpcHandler;
  dispatcher: WebhookDispatcher;
  messageStore: MessageStore;
  subscriptionStore: EventSubscriptionStore;
  setResourceNotifier(fn: (uri: string) => void | Promise<void>): void;
  close(): Promise<void>;
}

/** Single business runtime shared by the public and local HTTP MCP connections. */
export async function createMcpRuntime(config: AppConfig): Promise<McpRuntime> {
  const options = resolveCollabConfig(config);
  const db = openCollabDatabase(options.dbPath);
  const messages = new MessageStore(db, options);
  const subscriptions = new EventSubscriptionStore(db);
  const dispatcher = new WebhookDispatcher(subscriptions, options);
  const eventsRpc = new EventsRpcHandler(messages, subscriptions, dispatcher, config, options);
  let notifier: (uri: string) => void | Promise<void> = () => {};
  dispatcher.start();
  let playwright: PlaywrightBridge | undefined;
  if (config.playwrightEnabled !== false) {
    const candidate = new PlaywrightBridge();
    try {
      await candidate.discover();
      playwright = candidate;
    } catch (error) {
      await candidate.close();
      console.error('Playwright tool discovery failed; other MCP tools remain available:', error);
    }
  }
  const collab: CollabRuntime = {
    messageStore: messages,
    dispatcher: { notifyNewEvent: () => dispatcher.notifyNewEvent() },
    notifyResourceUpdated(uri) { return notifier(uri); }
  };
  return {
    playwright,
    collab, eventsRpc, dispatcher,
    messageStore: messages, subscriptionStore: subscriptions,
    setResourceNotifier(fn) { notifier = fn; },
    async close() {
      dispatcher.stop();
      await playwright?.close();
      db.close();
    }
  };
}
