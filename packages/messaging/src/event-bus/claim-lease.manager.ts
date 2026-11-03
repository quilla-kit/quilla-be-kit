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

type RenewOutcome = 'held' | 'lost' | 'error';

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

// Drives one batch at a time. Only the in-flight entry is renewed; the rest of the batch is
// left to expire so idle replicas can take it. Renewal runs on a timer, so a handler that
// blocks the event loop (CPU-bound sync work) starves it.
// An aggregate stays open from acquire until its entry settles 'done'; while it is open, later
// entries of that aggregate in the batch are refused. So any entry that fails, loses its claim
// or is otherwise left unsettled holds back the rest of its aggregate: those entries keep the
// batch's claim-time lease, expire together, and come back in seq order behind it.
export class ClaimLeaseManager {
  readonly leaseMs: number | undefined;
  readonly renewIntervalMs: number;
  private readonly renewLease: ClaimLease | null;
  private readonly instanceId: string;
  private readonly logger: Logger;
  private readonly onLeaseLost: ((info: LeaseLostInfo) => void) | undefined;
  private readonly confirmedAt = new Map<string, number>();
  private readonly reported = new Set<string>();
  private readonly openAggregates = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private held: ClaimedEntry | null = null;
  private renewing = false;

  constructor(options: ClaimLeaseManagerOptions) {
    this.leaseMs = options.lease?.durationMs;
    this.renewIntervalMs = resolveRenewInterval(options.lease, options.renewIntervalMs);
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
    this.end();
    if (entries.length === 0) return;
    const now = Date.now();
    for (const entry of entries) this.confirmedAt.set(entry.id, now);
    if (this.renewLease) {
      this.timer = setInterval(() => {
        void this.renewHeld();
      }, this.renewIntervalMs);
    }
  }

  end(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.held = null;
    this.confirmedAt.clear();
    this.reported.clear();
    this.openAggregates.clear();
  }

  async acquire(entry: ClaimedEntry): Promise<boolean> {
    if (entry.aggregateId !== undefined) {
      if (this.openAggregates.has(entry.aggregateId)) return false;
      this.openAggregates.add(entry.aggregateId);
    }
    if (!this.renewLease) return true;
    const confirmed = this.confirmedAt.get(entry.id) ?? 0;
    if (Date.now() - confirmed <= this.renewIntervalMs) return true;
    const outcome = await this.renewOne(entry);
    if (outcome === 'lost') this.reportLost(entry, 'renew');
    return outcome !== 'lost';
  }

  hold(entry: ClaimedEntry): void {
    this.held = entry;
  }

  // Releases before writing so an in-flight renew can't report the completed entry as lost.
  async settle(
    entry: ClaimedEntry,
    stage: LeaseLostStage,
    write: () => Promise<void>,
  ): Promise<void> {
    this.held = null;
    try {
      await write();
    } catch (err) {
      if (!ClaimLostError.is(err)) throw err;
      this.reportLost(entry, stage);
      return;
    }
    // An entry reported lost keeps its aggregate open: later entries may have been reset too.
    if (stage === 'done' && entry.aggregateId !== undefined && !this.reported.has(entry.id)) {
      this.openAggregates.delete(entry.aggregateId);
    }
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

  private async renewHeld(): Promise<void> {
    const entry = this.held;
    if (!entry || this.renewing || this.reported.has(entry.id)) return;
    this.renewing = true;
    try {
      const outcome = await this.renewOne(entry);
      // Released while the renew was in flight: the entry completed, absence is not a loss.
      if (outcome === 'lost' && this.held === entry) this.reportLost(entry, 'renew');
    } finally {
      this.renewing = false;
    }
  }

  private async renewOne(entry: ClaimedEntry): Promise<RenewOutcome> {
    if (!this.renewLease) return 'held';
    try {
      const held = await this.renewLease.renew(this.instanceId, [entry.id]);
      if (!held.includes(entry.id)) return 'lost';
      this.confirmedAt.set(entry.id, Date.now());
      return 'held';
    } catch (err) {
      this.logger.error('lease renewal failed', err, { meta: { eventId: entry.id } });
      return 'error';
    }
  }
}
