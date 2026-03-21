export interface SendQueueConfig {
  sendDelayMs: number;
  editDelayMs: number;
  maxRetries: number;
  maxQueueSize: number;
}

const DEFAULT_CONFIG: SendQueueConfig = {
  sendDelayMs: 500,
  editDelayMs: 100,
  maxRetries: 3,
  maxQueueSize: 100,
};

type Priority = 'edit' | 'send';

interface QueueItem {
  fn: () => Promise<unknown>;
  priority: Priority;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  retries: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class SendQueue {
  private config: SendQueueConfig;
  private queue: QueueItem[] = [];
  private processing = false;

  constructor(config?: Partial<SendQueueConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async enqueue<T>(fn: () => Promise<T>, priority: Priority = 'send'): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.queue.length >= this.config.maxQueueSize) {
        const dropIdx = this.queue.findIndex(item => item.priority === 'send');
        if (dropIdx !== -1) {
          const dropped = this.queue.splice(dropIdx, 1)[0];
          dropped.reject(new Error('Queue overflow: dropped'));
          console.warn(`[send-queue] Dropped oldest send (queue full at ${this.config.maxQueueSize})`);
        }
      }

      const item: QueueItem = {
        fn: fn as () => Promise<unknown>,
        priority,
        resolve: resolve as (v: unknown) => void,
        reject,
        retries: 0,
      };

      if (priority === 'edit') {
        const firstSendIdx = this.queue.findIndex(q => q.priority === 'send');
        if (firstSendIdx !== -1) {
          this.queue.splice(firstSendIdx, 0, item);
        } else {
          this.queue.push(item);
        }
      } else {
        this.queue.push(item);
      }

      this.process();
    });
  }

  get depth(): number {
    return this.queue.length;
  }

  private async process(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      const delay = item.priority === 'edit' ? this.config.editDelayMs : this.config.sendDelayMs;

      try {
        const result = await item.fn();
        item.resolve(result);
      } catch (err) {
        const retryAfter = this.extractRetryAfter(err);

        if (retryAfter !== null && item.retries < this.config.maxRetries) {
          item.retries++;
          const waitMs = (retryAfter + 1) * 1000;
          console.log(`[send-queue] 429 retry ${item.retries}/${this.config.maxRetries}, waiting ${waitMs}ms`);
          await sleep(waitMs);

          this.queue.unshift(item);
          continue;
        }

        item.reject(err);
      }

      if (this.queue.length > 0) {
        await sleep(delay);
      }
    }

    this.processing = false;
  }

  private extractRetryAfter(err: unknown): number | null {
    const msg = err instanceof Error ? err.message : String(err);
    const match = msg.match(/retry after (\d+)/i);
    if (match) return parseInt(match[1], 10);
    return null;
  }
}
