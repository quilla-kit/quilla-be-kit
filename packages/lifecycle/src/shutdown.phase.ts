import type { Disposable } from './disposable.js';

export type ShutdownPhaseConfig = {
  readonly name: string;
  readonly participants: readonly Disposable[];
};
