export type ReticulumInboundTrafficClass =
  | 'critical'
  | 'live-hint'
  | 'sync'
  | 'ephemeral'
  | 'resource';

export type ReticulumInboundAdmissionInput = {
  trafficClass: ReticulumInboundTrafficClass;
  /** Cryptographically derived Qortal address, when the wire provides one. */
  account?: string;
  /** Cryptographically bound Reticulum destination, when the wire provides one. */
  device?: string;
  /** Group, conversation, call, or resource scope. */
  scope?: string;
  /** The admitted overlay Link that delivered unsigned traffic. */
  immediatePeer?: string;
  cost?: number;
};

export type ReticulumInboundAdmissionDecision = {
  allowed: boolean;
  coalesce: boolean;
  reason?: 'account' | 'device' | 'scope' | 'peer' | 'global';
};

type Bucket = {
  tokens: number;
  updatedAt: number;
  lastUsedAt: number;
};

type Limit = {
  refillPerSecond: number;
  burst: number;
};

type ClassLimits = {
  account: Limit;
  device: Limit;
  scope: Limit;
  peer: Limit;
  global: Limit;
};

export type ReticulumInboundAdmissionStats = Record<
  ReticulumInboundTrafficClass,
  { accepted: number; coalesced: number }
>;

const DEFAULT_LIMITS: Record<ReticulumInboundTrafficClass, ClassLimits> = {
  // Critical signalling receives a deliberately large reserve. It is not used
  // for media frames and is never shared with sync or resource work.
  critical: {
    account: { refillPerSecond: 20, burst: 80 },
    device: { refillPerSecond: 16, burst: 64 },
    scope: { refillPerSecond: 30, burst: 120 },
    peer: { refillPerSecond: 40, burst: 160 },
    global: { refillPerSecond: 200, burst: 800 },
  },
  // A real person can type or react quickly, so the burst is generous. A
  // sustained flood is converted into one page/cursor reconciliation.
  'live-hint': {
    account: { refillPerSecond: 8, burst: 32 },
    device: { refillPerSecond: 6, burst: 24 },
    scope: { refillPerSecond: 40, burst: 160 },
    peer: { refillPerSecond: 60, burst: 240 },
    global: { refillPerSecond: 160, burst: 640 },
  },
  sync: {
    account: { refillPerSecond: 2, burst: 10 },
    device: { refillPerSecond: 2, burst: 8 },
    scope: { refillPerSecond: 10, burst: 40 },
    peer: { refillPerSecond: 20, burst: 80 },
    global: { refillPerSecond: 80, burst: 320 },
  },
  ephemeral: {
    account: { refillPerSecond: 4, burst: 16 },
    device: { refillPerSecond: 4, burst: 16 },
    scope: { refillPerSecond: 20, burst: 80 },
    peer: { refillPerSecond: 30, burst: 120 },
    global: { refillPerSecond: 120, burst: 480 },
  },
  resource: {
    account: { refillPerSecond: 4, burst: 16 },
    device: { refillPerSecond: 4, burst: 16 },
    scope: { refillPerSecond: 12, burst: 48 },
    peer: { refillPerSecond: 20, burst: 80 },
    global: { refillPerSecond: 80, burst: 320 },
  },
};

const BUCKET_IDLE_TTL_MS = 15 * 60_000;
const MAX_BUCKETS = 16_384;

function normalizedOpaque(value: string | undefined): string {
  return String(value || '').trim();
}

function normalizedHash(value: string | undefined): string {
  return normalizedOpaque(value).toLowerCase();
}

function emptyStats(): ReticulumInboundAdmissionStats {
  return {
    critical: { accepted: 0, coalesced: 0 },
    'live-hint': { accepted: 0, coalesced: 0 },
    sync: { accepted: 0, coalesced: 0 },
    ephemeral: { accepted: 0, coalesced: 0 },
    resource: { accepted: 0, coalesced: 0 },
  };
}

/**
 * Bounded, in-memory admission for work triggered by Reticulum controls.
 *
 * Account and device buckets are intentionally independent: the account cap
 * bounds all of a user's devices together, while the device cap prevents one
 * installation from consuming the whole account allowance. Unsigned traffic
 * is charged only to its immediate authenticated overlay peer.
 */
export class ReticulumInboundAdmissionController {
  private readonly buckets = new Map<string, Bucket>();
  private stats = emptyStats();
  private lastPruneAt = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly limits = DEFAULT_LIMITS
  ) {}

  admit(
    input: ReticulumInboundAdmissionInput
  ): ReticulumInboundAdmissionDecision {
    const now = this.now();
    const requestedCost = Number(input.cost ?? 1);
    const cost = Number.isFinite(requestedCost)
      ? Math.max(0.1, Math.min(100, requestedCost))
      : 1;
    const classLimits = this.limits[input.trafficClass];
    // Qortal addresses are Base58 and therefore case-sensitive. Destination
    // hashes and our internal scope identifiers are canonical lowercase keys.
    const account = normalizedOpaque(input.account);
    const device = normalizedHash(input.device);
    const scope = normalizedHash(input.scope);
    const peer = normalizedHash(input.immediatePeer);
    const checks: Array<{
      reason: NonNullable<ReticulumInboundAdmissionDecision['reason']>;
      key: string;
      limit: Limit;
    }> = [];
    if (account) {
      checks.push({
        reason: 'account',
        key: `${input.trafficClass}:account:${account}`,
        limit: classLimits.account,
      });
    }
    if (device) {
      checks.push({
        reason: 'device',
        key: `${input.trafficClass}:device:${device}`,
        limit: classLimits.device,
      });
    }
    if (scope) {
      checks.push({
        reason: 'scope',
        key: `${input.trafficClass}:scope:${scope}`,
        limit: classLimits.scope,
      });
    }
    // Signed controls are charged to their authenticated account/device. An
    // unsigned control is charged to the admitted immediate peer instead of a
    // claimed origin field that a relay could forge.
    if (peer && !account && !device) {
      checks.push({
        reason: 'peer',
        key: `${input.trafficClass}:peer:${peer}`,
        limit: classLimits.peer,
      });
    }
    checks.push({
      reason: 'global',
      key: `${input.trafficClass}:global`,
      limit: classLimits.global,
    });

    let deniedBy: ReticulumInboundAdmissionDecision['reason'];
    for (const check of checks) {
      const bucket = this.refill(check.key, check.limit, now);
      if (bucket.tokens < cost) {
        deniedBy = check.reason;
        break;
      }
    }
    if (deniedBy) {
      this.stats[input.trafficClass].coalesced += 1;
      this.pruneIfNeeded(now);
      return { allowed: false, coalesce: true, reason: deniedBy };
    }
    for (const check of checks) {
      const bucket = this.buckets.get(check.key)!;
      bucket.tokens = Math.max(0, bucket.tokens - cost);
      bucket.lastUsedAt = now;
    }
    this.stats[input.trafficClass].accepted += 1;
    this.pruneIfNeeded(now);
    return { allowed: true, coalesce: false };
  }

  snapshotAndResetStats(): ReticulumInboundAdmissionStats {
    const snapshot = this.stats;
    this.stats = emptyStats();
    return snapshot;
  }

  clear(): void {
    this.buckets.clear();
    this.stats = emptyStats();
    this.lastPruneAt = 0;
  }

  get size(): number {
    return this.buckets.size;
  }

  private refill(key: string, limit: Limit, now: number): Bucket {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: limit.burst, updatedAt: now, lastUsedAt: now };
      this.buckets.set(key, bucket);
      return bucket;
    }
    const elapsedMs = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(
      limit.burst,
      bucket.tokens + (elapsedMs / 1000) * limit.refillPerSecond
    );
    bucket.updatedAt = now;
    bucket.lastUsedAt = now;
    // Refresh insertion order so pressure eviction removes an actually idle
    // origin instead of an active origin that happened to arrive first.
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    return bucket;
  }

  private pruneIfNeeded(now: number): void {
    if (
      this.buckets.size <= MAX_BUCKETS &&
      now >= this.lastPruneAt &&
      now - this.lastPruneAt < 60_000
    ) {
      return;
    }
    this.lastPruneAt = now;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastUsedAt > BUCKET_IDLE_TTL_MS) {
        this.buckets.delete(key);
      }
    }
    while (this.buckets.size > MAX_BUCKETS) {
      const oldest = this.buckets.keys().next().value as string | undefined;
      if (!oldest) break;
      this.buckets.delete(oldest);
    }
  }
}
