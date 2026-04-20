import type { Disposable } from './disposable.js';
import type { ShutdownEvent } from './shutdown.event.js';
import type { ShutdownPhaseConfig } from './shutdown.phase.js';
import type {
  ShutdownParticipantError,
  ShutdownPhaseResult,
  ShutdownResult,
} from './shutdown.result.js';

export type ShutdownManagerOptions = {
  readonly timeoutMs: number;
  readonly onEvent?: (event: ShutdownEvent) => void;
};

export class ShutdownManager {
  private readonly timeoutMs: number;
  private readonly onEvent: (event: ShutdownEvent) => void;
  private readonly phases: ShutdownPhaseConfig[] = [];
  private draining = false;
  private inFlight: Promise<ShutdownResult> | undefined;

  constructor(options: ShutdownManagerOptions) {
    this.timeoutMs = options.timeoutMs;
    this.onEvent = options.onEvent ?? (() => {});
  }

  addPhase(phase: ShutdownPhaseConfig): this {
    this.phases.push(phase);
    return this;
  }

  isDraining(): boolean {
    return this.draining;
  }

  shutdown(): Promise<ShutdownResult> {
    if (this.inFlight) return this.inFlight;
    this.draining = true;
    this.inFlight = this.run();
    return this.inFlight;
  }

  private async run(): Promise<ShutdownResult> {
    const startedAt = Date.now();
    this.emit({
      type: 'shutdown-start',
      phases: this.phases.map((p) => p.name),
      timeoutMs: this.timeoutMs,
    });

    const phaseResults: ShutdownPhaseResult[] = [];
    let timedOut = false;

    const phasesComplete = (async () => {
      for (const phase of this.phases) {
        phaseResults.push(await this.runPhase(phase));
      }
    })();

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timeoutHandle = setTimeout(() => resolve('timeout'), this.timeoutMs);
    });

    const winner = await Promise.race([
      phasesComplete.then(() => 'complete' as const),
      timeoutPromise,
    ]);

    if (timeoutHandle) clearTimeout(timeoutHandle);

    if (winner === 'timeout') {
      timedOut = true;
      this.emit({ type: 'timeout', timeoutMs: this.timeoutMs });
    }

    const totalErrors = phaseResults.reduce((sum, p) => sum + p.errors.length, 0);
    const durationMs = Date.now() - startedAt;

    const result: ShutdownResult = {
      durationMs,
      phases: phaseResults,
      totalErrors,
      timedOut,
    };

    this.emit({ type: 'shutdown-complete', durationMs, totalErrors });
    return result;
  }

  private async runPhase(phase: ShutdownPhaseConfig): Promise<ShutdownPhaseResult> {
    const startedAt = Date.now();

    this.emit({
      type: 'phase-start',
      phase: phase.name,
      participants: phase.participants.map((p) => p.name),
    });

    const errors: ShutdownParticipantError[] = [];

    await Promise.all(
      phase.participants.map(async (participant) => {
        try {
          await participant.dispose();
        } catch (error) {
          errors.push({ participant: participant.name, error });
          this.emit({
            type: 'participant-error',
            phase: phase.name,
            participant: participant.name,
            error,
          });
        }
      }),
    );

    const durationMs = Date.now() - startedAt;
    this.emit({
      type: 'phase-end',
      phase: phase.name,
      durationMs,
      errorCount: errors.length,
    });

    return { name: phase.name, durationMs, errors };
  }

  private emit(event: ShutdownEvent): void {
    try {
      this.onEvent(event);
    } catch {
      // Shutdown must not depend on the observer working.
    }
  }
}
