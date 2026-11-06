export const JobInstances = {
  All: 'all',
  Any: 'any',
} as const;
export type JobInstances = (typeof JobInstances)[keyof typeof JobInstances];

export type JobRunOn =
  | { readonly instances: typeof JobInstances.All }
  | {
      readonly instances: typeof JobInstances.Any;
      /** How long a dead holder keeps the job before another instance can take it; defaults to the runner's. */
      readonly leaseMs?: number | undefined;
    };
