import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { CollabConfig } from '../config.js';
import { assertSafeWebhookUrl, postWebhook, signStandardWebhook } from './security.js';
import type { DueDeliveryRecord, EventSubscriptionStore } from './store.js';

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class WebhookDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(
    private readonly store: EventSubscriptionStore,
    private readonly config: CollabConfig
  ) {}

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.dispatcherIntervalMs);
    this.timer.unref();
    void this.tick();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public notifyNewEvent(): void {
    // Deliveries were inserted atomically with the message/event transaction.
    void this.tick();
  }

  public async verifySubscriptionChallenge(
    targetUrl: string,
    secret: string,
    subscriptionId: string
  ): Promise<void> {
    await assertSafeWebhookUrl(targetUrl);

    const challengeToken = `chl_${randomUUID().replace(/-/g, '')}`;
    const webhookId = `msg_challenge_${randomUUID().replace(/-/g, '')}`;
    const timestampSeconds = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      type: 'verification',
      challenge: challengeToken
    });

    const signature = signStandardWebhook(
      webhookId,
      timestampSeconds,
      body,
      secret
    );

    const response = await postWebhook(targetUrl, {
      'content-type': 'application/json',
      'webhook-id': webhookId,
      'webhook-timestamp': String(timestampSeconds),
      'webhook-signature': signature,
      'X-MCP-Subscription-Id': subscriptionId
    }, body, this.config.webhookTimeoutMs);

    if (!response.ok) {
      throw new Error(
        `Webhook challenge failed with HTTP status ${response.status}.`
      );
    }

    const contentType = response.contentType;
    if (contentType.includes('application/json')) {
      const json = JSON.parse(response.body) as { challenge?: string };
      if (typeof json.challenge !== 'string' || !sameSecret(json.challenge, challengeToken)) {
        throw new Error('Webhook challenge response token mismatch.');
      }
    } else {
      const text = response.body.trim();
      if (!sameSecret(text, challengeToken)) {
        throw new Error('Webhook challenge response body mismatch.');
      }
    }
  }

  public async tick(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const dueList = this.store.fetchDueDeliveries(20);
      for (const item of dueList) {
        await this.deliverSingle(item);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private async deliverSingle(item: DueDeliveryRecord): Promise<void> {
    const nextAttempt = item.attempt_count + 1;
    try {
      await assertSafeWebhookUrl(item.target_url);

      const timestampSeconds = Math.floor(Date.now() / 1000);
      const envelope = JSON.stringify({
        eventId: item.event_id,
        name: item.event_type,
        timestamp: item.event_created_at,
        data: JSON.parse(item.payload_json),
        cursor: null
      });

      const signature = signStandardWebhook(
        item.event_id,
        timestampSeconds,
        envelope,
        item.secret
      );

      const response = await postWebhook(item.target_url, {
        'content-type': 'application/json',
        'webhook-id': item.event_id,
        'webhook-timestamp': String(timestampSeconds),
        'webhook-signature': signature,
        'X-MCP-Subscription-Id': item.subscription_id
      }, envelope, this.config.webhookTimeoutMs);

      if (response.status >= 200 && response.status < 300) {
        this.store.markDelivered(item.delivery_id, response.status);
      } else {
        this.store.markRetryOrFailed(
          item.delivery_id,
          nextAttempt,
          this.config.webhookMaxAttempts,
          response.status,
          `HTTP ${response.status}`
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.store.markRetryOrFailed(
        item.delivery_id,
        nextAttempt,
        this.config.webhookMaxAttempts,
        null,
        message
      );
    }
  }
}
