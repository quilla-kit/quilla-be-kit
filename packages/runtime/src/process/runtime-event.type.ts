import type { ShutdownResult } from '../shutdown/shutdown-result.type.js';
import type { RuntimeSignal } from './runtime-signal.type.js';
import type { ShutdownCause } from './shutdown-cause.type.js';

export type RuntimeEvent =
  | { readonly type: 'startup-start' }
  | { readonly type: 'startup-complete'; readonly durationMs: number }
  | { readonly type: 'startup-error'; readonly error: unknown }
  | { readonly type: 'signal-received'; readonly signal: RuntimeSignal }
  | { readonly type: 'uncaught-exception'; readonly error: unknown }
  | { readonly type: 'unhandled-rejection'; readonly reason: unknown }
  | { readonly type: 'shutdown-triggered'; readonly cause: ShutdownCause }
  | {
      readonly type: 'shutdown-complete';
      readonly result: ShutdownResult;
      readonly exitCode: number;
    };
