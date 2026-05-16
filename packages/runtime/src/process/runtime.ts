import type { ShutdownResult } from '../shutdown/shutdown-result.type.js';
import type { ShutdownManager } from '../shutdown/shutdown.manager.js';
import type { RuntimeEvent } from './runtime-event.type.js';
import type { RuntimeOptions } from './runtime-options.type.js';
import type { RuntimeSignal } from './runtime-signal.type.js';
import type { ShutdownCause } from './shutdown-cause.type.js';

const DEFAULT_SIGNALS: readonly RuntimeSignal[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const NOOP_ON_EVENT: (event: RuntimeEvent) => void = () => {};
const DEFAULT_EXIT: (code: number) => void = (code) => process.exit(code);

export class Runtime {
  private readonly shutdownManager: ShutdownManager;
  private readonly signals: readonly RuntimeSignal[];
  private readonly trapUncaughtException: boolean;
  private readonly trapUnhandledRejection: boolean;
  private readonly onEvent: (event: RuntimeEvent) => void;
  private readonly exit: (code: number) => void;

  private readonly signalHandlers = new Map<RuntimeSignal, () => void>();
  private readonly uncaughtHandler = (error: unknown): void => {
    this.emit({ type: 'uncaught-exception', error });
    this.trigger({ type: 'uncaught-exception', error });
  };
  private readonly rejectionHandler = (reason: unknown): void => {
    this.emit({ type: 'unhandled-rejection', reason });
    this.trigger({ type: 'unhandled-rejection', reason });
  };

  private started = false;
  private triggered = false;
  private readonly triggerPromise: Promise<ShutdownCause>;
  private readonly triggerResolve: (cause: ShutdownCause) => void;

  constructor(options: RuntimeOptions) {
    this.shutdownManager = options.shutdownManager;
    this.signals = options.signals ?? DEFAULT_SIGNALS;
    this.trapUncaughtException = options.trapUncaughtException ?? true;
    this.trapUnhandledRejection = options.trapUnhandledRejection ?? true;
    this.onEvent = options.onEvent ?? NOOP_ON_EVENT;
    this.exit = options.exit ?? DEFAULT_EXIT;

    let resolve!: (cause: ShutdownCause) => void;
    this.triggerPromise = new Promise<ShutdownCause>((r) => {
      resolve = r;
    });
    this.triggerResolve = resolve;
  }

  async run(startup: () => Promise<void> | void): Promise<void> {
    if (this.started) {
      throw new Error('Runtime.run() can only be called once per instance');
    }
    this.started = true;

    this.arm();
    try {
      this.emit({ type: 'startup-start' });
      const startupStart = Date.now();
      try {
        await startup();
        this.emit({
          type: 'startup-complete',
          durationMs: Date.now() - startupStart,
        });
      } catch (error) {
        this.emit({ type: 'startup-error', error });
        this.trigger({ type: 'startup-error', error });
      }

      const cause = await this.triggerPromise;
      const result = await this.shutdownManager.shutdown();
      const exitCode = this.computeExitCode(cause, result);

      this.emit({ type: 'shutdown-complete', result, exitCode });
      this.exit(exitCode);
    } finally {
      this.disarm();
    }
  }

  triggerShutdown(): void {
    this.trigger({ type: 'programmatic' });
  }

  private arm(): void {
    for (const signal of this.signals) {
      const handler = (): void => {
        this.emit({ type: 'signal-received', signal });
        this.trigger({ type: 'signal', signal });
      };
      this.signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
    if (this.trapUncaughtException) {
      process.on('uncaughtException', this.uncaughtHandler);
    }
    if (this.trapUnhandledRejection) {
      process.on('unhandledRejection', this.rejectionHandler);
    }
  }

  private disarm(): void {
    for (const [signal, handler] of this.signalHandlers) {
      process.off(signal, handler);
    }
    this.signalHandlers.clear();
    if (this.trapUncaughtException) {
      process.off('uncaughtException', this.uncaughtHandler);
    }
    if (this.trapUnhandledRejection) {
      process.off('unhandledRejection', this.rejectionHandler);
    }
  }

  private trigger(cause: ShutdownCause): void {
    if (this.triggered) return;
    this.triggered = true;
    this.emit({ type: 'shutdown-triggered', cause });
    this.triggerResolve(cause);
  }

  private computeExitCode(cause: ShutdownCause, result: ShutdownResult): number {
    if (cause.type === 'startup-error') return 1;
    if (result.timedOut) return 1;
    if (result.totalErrors > 0) return 1;
    return 0;
  }

  private emit(event: RuntimeEvent): void {
    try {
      this.onEvent(event);
    } catch {
      // Runtime must not depend on the observer working.
    }
  }
}
