export class FakeLease {
  readonly renewCalls: { instanceId: string; ids: readonly string[] }[] = [];
  readonly lost = new Set<string>();
  renewError: Error | null = null;

  constructor(readonly durationMs: number) {}

  async renew(instanceId: string, ids: readonly string[]): Promise<readonly string[]> {
    this.renewCalls.push({ instanceId, ids: [...ids] });
    if (this.renewError) throw this.renewError;
    return ids.filter((id) => !this.lost.has(id));
  }
}
