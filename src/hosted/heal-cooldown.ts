/**
 * Heal cooldown enforcement. Prevents tenants from running heal operations
 * more frequently than their plan allows.
 */

export class HealCooldown {
  private readonly cooldownMs: number;
  private lastHealTime = 0;

  constructor(cooldownSeconds: number) {
    this.cooldownMs = cooldownSeconds * 1000;
  }

  /** Record that a heal operation just completed. */
  recordHeal(): void {
    this.lastHealTime = Date.now();
  }

  /** Check if a heal can run now. Throws if cooldown is active. */
  checkOrThrow(): void {
    const elapsed = Date.now() - this.lastHealTime;
    if (this.lastHealTime > 0 && elapsed < this.cooldownMs) {
      const waitMinutes = Math.ceil((this.cooldownMs - elapsed) / 60_000);
      throw new Error(`Heal cooldown active — try again in ${waitMinutes} minutes.`);
    }
  }

  /** Whether a heal can run now (non-throwing). */
  canHeal(): boolean {
    if (this.lastHealTime === 0) return true;
    return Date.now() - this.lastHealTime >= this.cooldownMs;
  }
}
