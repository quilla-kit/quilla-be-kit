export type RuntimeSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';

export const RuntimeSignals = {
  SIGINT: 'SIGINT',
  SIGTERM: 'SIGTERM',
  SIGHUP: 'SIGHUP',
} as const satisfies Record<string, RuntimeSignal>;
