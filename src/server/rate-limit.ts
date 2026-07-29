/**
 * Bounded fixed-window rate limiter.
 *
 * Two properties matter more than precision here:
 *
 * 1. The key must be something the caller cannot choose. Callers pass an
 *    authenticated session token, or the real peer address — never a value
 *    lifted from a request header. See `Relay.getClientIp`.
 * 2. The table must not grow without limit. Anything that can mint fresh keys
 *    could otherwise turn the limiter itself into the memory-exhaustion path it
 *    was added to prevent, so entries are swept once a window has elapsed and
 *    the table is hard-capped at `maxKeys`.
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the current window resets. Zero when the call was allowed. */
  retryAfter: number;
}

export interface FixedWindowRateLimiterOptions {
  /** Requests permitted per key per window. */
  limit: number;
  windowMs: number;
  /** Hard ceiling on tracked keys. */
  maxKeys: number;
  /** Injectable clock, for tests. */
  now?: () => number;
}

interface Window {
  count: number;
  resetAt: number;
}

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;
  private lastSweepAt: number;

  constructor(options: FixedWindowRateLimiterOptions) {
    this.limit = Math.max(1, Math.floor(options.limit));
    this.windowMs = Math.max(1, Math.floor(options.windowMs));
    this.maxKeys = Math.max(1, Math.floor(options.maxKeys));
    this.now = options.now ?? (() => Date.now());
    this.lastSweepAt = this.now();
  }

  /** Tracked key count. Exposed so the bound itself is testable. */
  get size(): number {
    return this.windows.size;
  }

  check(key: string): RateLimitDecision {
    const now = this.now();
    this.sweep(now);

    const existing = this.windows.get(key);
    if (existing && now < existing.resetAt) {
      if (existing.count >= this.limit) {
        return { allowed: false, retryAfter: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)) };
      }
      existing.count++;
      return { allowed: true, retryAfter: 0 };
    }

    // A brand new key (or a key whose window has rolled over) is about to take
    // a slot, so make room first.
    if (!existing) this.evictTo(this.maxKeys - 1, now);
    this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
    return { allowed: true, retryAfter: 0 };
  }

  /** Drop every window that has already reset, at most once per window. */
  private sweep(now: number): void {
    if (now - this.lastSweepAt < this.windowMs) return;
    this.lastSweepAt = now;
    for (const [key, window] of this.windows) {
      if (now >= window.resetAt) this.windows.delete(key);
    }
  }

  /**
   * Force the table down to `target` entries. Expired windows go first; if the
   * table is still full, the entries closest to resetting are dropped. Windows
   * are created with a single duration, so insertion order is expiry order.
   */
  private evictTo(target: number, now: number): void {
    if (this.windows.size <= target) return;
    for (const [key, window] of this.windows) {
      if (this.windows.size <= target) return;
      if (now >= window.resetAt) this.windows.delete(key);
    }
    for (const key of this.windows.keys()) {
      if (this.windows.size <= target) return;
      this.windows.delete(key);
    }
  }
}
