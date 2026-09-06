// Console login rate limit (stage 6): a fixed window of failed attempts per
// organization name + client IP, in process memory. Pilot-only: a restart
// clears it and multiple replicas do not share it; a shared store is an SRE
// stage. The sixth attempt within a window is refused before the password
// is checked, so the limit also bounds the scrypt work an attacker can cause.
import { createHash } from 'node:crypto';

export interface RateLimitOptions {
  /** Failures allowed inside one window before the next attempt is refused. */
  maxFailures: number;
  windowMs: number;
}

export const LOGIN_RATE_LIMIT: RateLimitOptions = { maxFailures: 5, windowMs: 60_000 };

export class FailureWindow {
  private readonly failures = new Map<string, number[]>();

  constructor(private readonly options: RateLimitOptions = LOGIN_RATE_LIMIT) {}

  private key(subject: string, ip: string): string {
    // Hash the subject so the map never holds a submitted value verbatim.
    return createHash('sha256').update(`${subject}\n${ip}`, 'utf8').digest('hex');
  }

  private recent(key: string, now: number): number[] {
    const kept = (this.failures.get(key) ?? []).filter((t) => now - t < this.options.windowMs);
    if (kept.length === 0) this.failures.delete(key);
    else this.failures.set(key, kept);
    return kept;
  }

  /** Seconds to wait when the subject is currently blocked, else 0. */
  retryAfterSeconds(subject: string, ip: string, now: number = Date.now()): number {
    const key = this.key(subject, ip);
    const kept = this.recent(key, now);
    if (kept.length < this.options.maxFailures) return 0;
    const oldest = kept[0] as number;
    return Math.max(1, Math.ceil((oldest + this.options.windowMs - now) / 1000));
  }

  recordFailure(subject: string, ip: string, now: number = Date.now()): void {
    const key = this.key(subject, ip);
    const kept = this.recent(key, now);
    kept.push(now);
    this.failures.set(key, kept);
    if (this.failures.size > 10_000) this.prune(now);
  }

  clear(subject: string, ip: string): void {
    this.failures.delete(this.key(subject, ip));
  }

  private prune(now: number): void {
    for (const key of [...this.failures.keys()]) this.recent(key, now);
  }
}
