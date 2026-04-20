export type ShutdownParticipantError = {
  readonly participant: string;
  readonly error: unknown;
};

export type ShutdownPhaseResult = {
  readonly name: string;
  readonly durationMs: number;
  readonly errors: readonly ShutdownParticipantError[];
};

export type ShutdownResult = {
  readonly durationMs: number;
  readonly phases: readonly ShutdownPhaseResult[];
  readonly totalErrors: number;
  readonly timedOut: boolean;
};
