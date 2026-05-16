import type { RuntimeSignal } from './runtime-signal.type.js';

export type ShutdownCause =
  | { readonly type: 'signal'; readonly signal: RuntimeSignal }
  | { readonly type: 'uncaught-exception'; readonly error: unknown }
  | { readonly type: 'unhandled-rejection'; readonly reason: unknown }
  | { readonly type: 'startup-error'; readonly error: unknown }
  | { readonly type: 'programmatic' };
