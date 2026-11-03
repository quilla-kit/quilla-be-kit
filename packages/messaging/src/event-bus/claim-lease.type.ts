export type ClaimLease = {
  readonly durationMs: number;
  // Extends the lease on each id still claimed by `instanceId`; resolves to the ids still held.
  renew(instanceId: string, ids: readonly string[]): Promise<readonly string[]>;
  // Returns each id still claimed by `instanceId` to the queue; resolves to the ids released.
  // Without it, unstarted claims are renewed instead of handed to other replicas.
  release?(instanceId: string, ids: readonly string[]): Promise<readonly string[]>;
};

export type LeaseLostStage = 'renew' | 'done' | 'failed';

export type LeaseLostInfo = {
  readonly id: string;
  readonly eventType: string;
  readonly stage: LeaseLostStage;
};
