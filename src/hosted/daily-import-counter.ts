/**
 * Timezone-aware daily import counter with onboarding burst support.
 * Counts only successful ingestions. Resets at midnight in the tenant's timezone.
 */

export class DailyImportCounter {
  private readonly limit: number;
  private readonly timezone: string;
  private readonly createdAt: Date;
  private readonly burstMultiplier: number;
  private readonly burstHours: number;
  private readonly counters = new Map<string, number>();

  constructor(opts: {
    limit: number;
    timezone: string;
    createdAt: Date;
    burstMultiplier: number;
    burstHours: number;
  }) {
    this.limit = opts.limit;
    this.timezone = opts.timezone;
    this.createdAt = opts.createdAt;
    this.burstMultiplier = opts.burstMultiplier;
    this.burstHours = opts.burstHours;
  }

  /** Record `count` successful imports for today. */
  record(count: number): void {
    const key = this.todayKey();
    this.counters.set(key, (this.counters.get(key) ?? 0) + count);
    this.cleanup(key);
  }

  /** Would recording `count` more exceed today's limit? */
  wouldExceed(count: number): boolean {
    const key = this.todayKey();
    const current = this.counters.get(key) ?? 0;
    return current + count > this.effectiveLimit();
  }

  /** How many imports remain today? */
  remaining(): number {
    const key = this.todayKey();
    const current = this.counters.get(key) ?? 0;
    return Math.max(0, this.effectiveLimit() - current);
  }

  /** Throw if recording `count` more would exceed today's limit. */
  checkOrThrow(count: number): void {
    if (this.wouldExceed(count)) {
      const key = this.todayKey();
      const current = this.counters.get(key) ?? 0;
      const eff = this.effectiveLimit();
      throw new Error(
        `Daily import limit reached: ${current} of ${eff} files today. Resets at midnight ${this.timezone}.`,
      );
    }
  }

  /** Current effective limit (with burst if applicable). */
  effectiveLimit(): number {
    const ageMs = Date.now() - this.createdAt.getTime();
    const burstMs = this.burstHours * 60 * 60 * 1000;
    if (ageMs < burstMs) {
      return Math.floor(this.limit * this.burstMultiplier);
    }
    return this.limit;
  }

  /** Date string in the tenant's timezone (determines counter reset). */
  private todayKey(): string {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: this.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }

  /** Remove old entries to prevent unbounded map growth. */
  private cleanup(currentKey: string): void {
    for (const key of this.counters.keys()) {
      if (key !== currentKey) this.counters.delete(key);
    }
  }
}
