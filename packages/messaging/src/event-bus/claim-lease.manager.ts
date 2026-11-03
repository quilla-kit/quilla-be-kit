import type { Logger } from '@quilla-be-kit/observability';
import type { ClaimLease, LeaseLostInfo, LeaseLostStage } from './claim-lease.type.js';
import { ClaimLostError } from './claim-lost.error.js';

type ClaimedEntry = {
  readonly id: string;
  readonly eventType: string;
  readonly aggregateId?: string | undefined;
};

export type ClaimLeaseManagerOptions = {
  readonly lease: ClaimLease | undefined;
  readonly instanceId: string;
  readonly renewIntervalMs: number | undefined;
  readonly logger: Logger;
  readonly onLeaseLost: ((info: LeaseLostInfo) => void) | undefined;
};

function resolveRenewInterval(
  lease: ClaimLease | undefined,
  renewIntervalMs: number | undefined,
): number {
  if (!lease) return 0;
  const interval = renewIntervalMs ?? Math.floor(lease.durationMs / 3);
  if (interval < 0 || (interval > 0 && interval >= lease.durationMs)) {
    throw new Error(
      `renewIntervalMs (${interval}) must be 0 (disabled) or below the lease (${lease.durationMs}ms)`,
    );
  }
  return interval;
}

// Drives one batch at a time. Only the in-flight entry is renewed. Entries not yet started are
// handed back to the queue once the batch outlives one renewal interval, and again when the batch
// ends, so idle replicas can take them; a lease without `release` renews them instead. Renewal
// runs on a timer, so a handler that blocks the event loop (CPU-bound sync work) starves it.
// An aggregate stays open from acquire until its entry settles 'done'; while it is open, later
// entries of that aggregate in the batch are refused. So any entry that fails, loses its claim
// or is otherwise left unsettled holds back the rest of its aggregate: those entries are handed
// back together and come back in seq order behind it.
export class ClaimLeaseManager {
  readonly leaseMs: number | undefined;
  readonly renewIntervalMs: number;
  private readonly lease: ClaimLease | null;
  private readonly renewLease: ClaimLease | null;
  private readonly instanceId: string;
  private readonly logger: Logger;
  private readonly onLeaseLost: ((info: LeaseLostInfo) => void) | undefined;
  private readonly confirmedAt = new Map<string, number>();
  private readonly reported = new Set<string>();
  private readonly openAggregates = new Set<string>();
  // Started here or handed back; acquire sees each entry once, so either way it's not dispatched.
  private readonly taken = new Set<string>();
  private batch: readonly ClaimedEntry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private held: ClaimedEntry | null = null;
  private renewing = false;

  constructor(options: ClaimLeaseManagerOptions) {
    this.leaseMs = options.lease?.durationMs;
    this.renewIntervalMs = resolveRenewInterval(options.lease, options.renewIntervalMs);
    this.lease = options.lease ?? null;
    this.renewLease = this.renewIntervalMs > 0 ? (options.lease ?? null) : null;
    this.instanceId = options.instanceId;
    this.logger = options.logger;
    this.onLeaseLost = options.onLeaseLost;
  }

  warnIfDisabled(): void {
    if (this.leaseMs === undefined || this.renewLease) return;
    this.logger.warn('claim renewal disabled; work longer than the lease will be re-dispatched', {
      meta: { leaseMs: this.leaseMs },
    });
  }

  begin(entries: readonly ClaimedEntry[]): void {
    this.reset();
    if (entries.length === 0) return;
    this.batch = entries;
    const now = Date.now();
    for (const entry of entries) this.confirmedAt.set(entry.id, now);
    if (this.renewLease) {
      this.timer = setInterval(() => {
        void this.tick();
      }, this.renewIntervalMs);
    }
  }

  async finish(): Promise<void> {
    this.stopTimer();
    await this.handBack();
    this.reset();
  }

  // Everything before the first await is synchronous, so a timer tick can't hand back an entry
  // between the check and `taken.add`.
  async acquire(entry: ClaimedEntry): Promise<boolean> {
    if (this.taken.has(entry.id)) return false;
    if (entry.aggregateId !== undefined) {
      if (this.openAggregates.has(entry.aggregateId)) return false;
      this.openAggregates.add(entry.aggregateId);
    }
    this.taken.add(entry.id);
    if (!this.renewLease) return true;
    const confirmed = this.confirmedAt.get(entry.id) ?? 0;
    if (Date.now() - confirmed <= this.renewIntervalMs) return true;
    const held = await this.renew([entry.id], entry.id);
    // Never started here, so it can't run twice: not a lost lease. A failed renew fails open.
    if (held && !held.includes(entry.id)) {
      this.logger.debug('claim expired before dispatch; skipping', {
        meta: { eventId: entry.id, eventType: entry.eventType },
      });
      return false;
    }
    return true;
  }

  hold(entry: ClaimedEntry): void {
    this.held = entry;
  }

  // Releases before writing so an in-flight renew can't report the completed entry as lost.
  // Resolves to the write's result, or undefined when the claim was lost.
  async settle<T>(
    entry: ClaimedEntry,
    stage: LeaseLostStage,
    write: () => Promise<T>,
  ): Promise<T | undefined> {
    this.held = null;
    let result: T;
    try {
      result = await write();
    } catch (err) {
      if (!ClaimLostError.is(err)) throw err;
      this.reportLost(entry, stage);
      return undefined;
    }
    // An entry reported lost keeps its aggregate open: later entries may have been reset too.
    if (stage === 'done' && entry.aggregateId !== undefined && !this.reported.has(entry.id)) {
      this.openAggregates.delete(entry.aggregateId);
    }
    return result;
  }

  reportLost(entry: ClaimedEntry, stage: LeaseLostStage): void {
    if (this.reported.has(entry.id)) return;
    this.reported.add(entry.id);
    this.logger.warn('claim lease lost; event may run more than once', {
      meta: { eventId: entry.id, eventType: entry.eventType, stage },
    });
    try {
      this.onLeaseLost?.({ id: entry.id, eventType: entry.eventType, stage });
    } catch (err) {
      this.logger.error('onLeaseLost hook threw', err);
    }
  }

  // After the first hand-back nothing is left unstarted, so later ticks renew only the held entry;
  // a lease without `release` keeps renewing the waiting entries along with it.
  private async tick(): Promise<void> {
    await this.handBack();
    await this.renewHeld(this.unstarted());
  }

  private async renewHeld(waiting: readonly string[]): Promise<void> {
    const entry = this.held && !this.reported.has(this.held.id) ? this.held : null;
    if (this.renewing || (!entry && waiting.length === 0)) return;
    this.renewing = true;
    try {
      const held = await this.renew(entry ? [entry.id, ...waiting] : waiting, entry?.id);
      // Released while the renew was in flight: the entry completed, absence is not a loss.
      if (entry && held && !held.includes(entry.id) && this.held === entry) {
        this.reportLost(entry, 'renew');
      }
    } finally {
      this.renewing = false;
    }
  }

  // Resolves to the ids still held, or null when the renew query failed.
  private async renew(
    ids: readonly string[],
    eventId: string | undefined,
  ): Promise<readonly string[] | null> {
    if (!this.renewLease) return ids;
    try {
      const held = await this.renewLease.renew(this.instanceId, ids);
      const now = Date.now();
      for (const id of held) this.confirmedAt.set(id, now);
      return held;
    } catch (err) {
      this.logger.error('lease renewal failed', err, { meta: { eventId } });
      return null;
    }
  }

  private unstarted(): string[] {
    return this.batch.filter((entry) => !this.taken.has(entry.id)).map((entry) => entry.id);
  }

  // Ids the lease doesn't return were already reset elsewhere; they never ran here, so dropping
  // them is silent. On error the claims fall back to expiring.
  private async handBack(): Promise<void> {
    if (!this.lease?.release) return;
    const ids = this.unstarted();
    if (ids.length === 0) return;
    for (const id of ids) this.taken.add(id);
    try {
      const released = await this.lease.release(this.instanceId, ids);
      if (released.length > 0) {
        this.logger.debug(`handed back ${released.length} unstarted claim(s)`);
      }
    } catch (err) {
      this.logger.error('handing back unstarted claims failed', err, {
        meta: { count: ids.length },
      });
    }
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private reset(): void {
    this.stopTimer();
    this.batch = [];
    this.held = null;
    this.confirmedAt.clear();
    this.reported.clear();
    this.openAggregates.clear();
    this.taken.clear();
  }
}
