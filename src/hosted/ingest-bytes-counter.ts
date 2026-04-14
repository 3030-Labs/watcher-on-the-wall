/**
 * Timezone-aware daily ingest-bytes counter. Same pattern as DailyImportCounter
 * but tracks total bytes ingested per day instead of file count.
 */

export class IngestBytesCounter {
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

  record(bytes: number): void {
    const key = this.todayKey();
    this.counters.set(key, (this.counters.get(key) ?? 0) + bytes);
    for (const k of this.counters.keys()) {
      if (k !== key) this.counters.delete(k);
    }
  }

  wouldExceed(bytes: number): boolean {
    const key = this.todayKey();
    const current = this.counters.get(key) ?? 0;
    return current + bytes > this.effectiveLimit();
  }

  checkOrThrow(bytes: number): void {
    if (this.wouldExceed(bytes)) {
      const key = this.todayKey();
      const current = this.counters.get(key) ?? 0;
      const eff = this.effectiveLimit();
      const currentMB = (current / 1024 ** 2).toFixed(1);
      const limitMB = (eff / 1024 ** 2).toFixed(0);
      throw new Error(
        `Daily ingest bytes limit reached: ${currentMB} MB of ${limitMB} MB today. Resets at midnight ${this.timezone}.`,
      );
    }
  }

  private effectiveLimit(): number {
    const ageMs = Date.now() - this.createdAt.getTime();
    const burstMs = this.burstHours * 60 * 60 * 1000;
    if (ageMs < burstMs) {
      return Math.floor(this.limit * this.burstMultiplier);
    }
    return this.limit;
  }

  private todayKey(): string {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: this.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }
}
