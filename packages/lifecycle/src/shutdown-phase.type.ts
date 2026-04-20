import type { Disposable } from './disposable.interface.js';

export type ShutdownPhaseConfig = {
  readonly name: string;
  readonly participants: readonly Disposable[];
};
