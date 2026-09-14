import {
  markFailed,
  markPublished,
  publishPending,
  type EventRecord,
} from './event-outbox.js';

export interface DeliverResult {
  ok: boolean;
  error?: string;
}

export interface OutboxWorkerOptions {
  intervalMs?: number;
  batch?: number;
  leaseMs?: number;
  actionPrefix?: string;
  resourceType?: string;
  deliver: (event: EventRecord) => Promise<DeliverResult>;
}

function retryAt(attempts: number): string {
  const delay = Math.min(15 * 60_000, Math.max(1_000, 2 ** Math.min(attempts, 8) * 1_000));
  const date = new Date(Date.now() + delay);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export async function runOnce(options: OutboxWorkerOptions): Promise<number> {
  const events = await publishPending({
    limit: options.batch ?? 100,
    leaseMs: options.leaseMs,
    actionPrefix: options.actionPrefix,
    resourceType: options.resourceType,
  });
  let processed = 0;
  for (const event of events) {
    const lease = event.next_attempt_at
      ? { attempts: event.attempts, next_attempt_at: event.next_attempt_at }
      : undefined;
    try {
      const result = await options.deliver(event);
      if (result.ok) {
        await markPublished(event.id, lease);
      } else {
        await markFailed(event.id, result.error ?? 'outbox delivery failed', retryAt(event.attempts), lease);
      }
    } catch (error) {
      await markFailed(
        event.id,
        error instanceof Error ? error.message : String(error),
        retryAt(event.attempts),
        lease,
      );
    }
    processed += 1;
  }
  return processed;
}

export function startOutboxWorker(options: OutboxWorkerOptions): () => void {
  const intervalMs = Math.max(100, Math.floor(options.intervalMs ?? 5_000) || 5_000);
  let stopped = false;
  let running = false;
  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      await runOnce(options);
    } catch (error) {
      console.error('[outbox] worker failed:', error);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
