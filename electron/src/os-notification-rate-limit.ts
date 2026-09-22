export class DirectOsNotificationLimiter {
  private times = new Map<string, number[]>();

  constructor(
    private max = 3,
    private windowMs = 60_000
  ) {}

  canShow(appName: string, now = Date.now()): boolean {
    this.prune(now);
    return (this.times.get(appName.toLowerCase())?.length ?? 0) < this.max;
  }

  record(appName: string, now = Date.now()): void {
    this.prune(now);
    const key = appName.toLowerCase();
    this.times.set(key, [...(this.times.get(key) ?? []), now]);
  }

  private prune(now: number): void {
    for (const [key, times] of this.times) {
      const recent = times.filter((time) => now - time < this.windowMs);
      if (recent.length) this.times.set(key, recent);
      else this.times.delete(key);
    }
  }
}
