export class FakeLease {
  readonly renewCalls: { instanceId: string; ids: readonly string[] }[] = [];
  readonly releaseCalls: { instanceId: string; ids: readonly string[] }[] = [];
  readonly lost = new Set<string>();
  renewError: Error | null = null;
  releaseError: Error | null = null;
  readonly release?: (instanceId: string, ids: readonly string[]) => Promise<readonly string[]>;

  constructor(
    readonly durationMs: number,
    options: { readonly release?: boolean } = {},
  ) {
    if (options.release !== false) {
      this.release = async (instanceId, ids) => {
        this.releaseCalls.push({ instanceId, ids: [...ids] });
        if (this.releaseError) throw this.releaseError;
        return ids.filter((id) => !this.lost.has(id));
      };
    }
  }

  async renew(instanceId: string, ids: readonly string[]): Promise<readonly string[]> {
    this.renewCalls.push({ instanceId, ids: [...ids] });
    if (this.renewError) throw this.renewError;
    return ids.filter((id) => !this.lost.has(id));
  }
}

type FailableEntry = {
  readonly id: string;
  readonly retryCount: number;
  readonly claimedBy?: string | undefined;
  readonly claimedAt?: Date | undefined;
  readonly leaseExpiresAt?: Date | undefined;
};

// The entry a markFailed fake returns, mirroring ClaimDao.markFailed's update.
export function failedCopy<E extends FailableEntry>(
  entry: E,
  reason: string,
  status: 'PENDING' | 'FAILED',
): E {
  const { claimedBy: _by, claimedAt: _at, leaseExpiresAt: _lease, ...rest } = entry;
  return {
    ...rest,
    status,
    retryCount: entry.retryCount + 1,
    lastError: reason,
    ...(status === 'FAILED' ? { failedAt: new Date() } : {}),
  } as unknown as E;
}
