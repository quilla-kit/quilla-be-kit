export type ShutdownEvent =
  | {
      readonly type: 'shutdown-start';
      readonly phases: readonly string[];
      readonly timeoutMs: number;
    }
  | {
      readonly type: 'phase-start';
      readonly phase: string;
      readonly participants: readonly string[];
    }
  | {
      readonly type: 'phase-end';
      readonly phase: string;
      readonly durationMs: number;
      readonly errorCount: number;
    }
  | {
      readonly type: 'participant-error';
      readonly phase: string;
      readonly participant: string;
      readonly error: unknown;
    }
  | {
      readonly type: 'timeout';
      readonly timeoutMs: number;
    }
  | {
      readonly type: 'shutdown-complete';
      readonly durationMs: number;
      readonly totalErrors: number;
    };
