import type { ShutdownManager } from '../shutdown/shutdown.manager.js';
import type { RuntimeEvent } from './runtime-event.type.js';
import type { RuntimeSignal } from './runtime-signal.type.js';

export type RuntimeOptions = {
  readonly shutdownManager: ShutdownManager;
  readonly signals?: readonly RuntimeSignal[];
  readonly trapUncaughtException?: boolean;
  readonly trapUnhandledRejection?: boolean;
  readonly onEvent?: (event: RuntimeEvent) => void;
  readonly exit?: (code: number) => void;
};
