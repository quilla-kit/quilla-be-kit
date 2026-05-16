import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeEvent } from '../../src/process/runtime-event.type.js';
import { Runtime } from '../../src/process/runtime.js';
import { ShutdownManager } from '../../src/shutdown/shutdown.manager.js';

const noopExit = (): void => {};

const collect = (): {
  events: RuntimeEvent[];
  onEvent: (event: RuntimeEvent) => void;
} => {
  const events: RuntimeEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
};

describe('Runtime', () => {
  afterEach(() => {
    // Prevent leaked signal/error handlers from polluting later test files.
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGHUP');
  });

  describe('single-use', () => {
    it('throws if run() is called twice', async () => {
      const shutdownManager = new ShutdownManager({ timeoutMs: 100 });
      const runtime = new Runtime({
        shutdownManager,
        exit: noopExit,
        trapUncaughtException: false,
        trapUnhandledRejection: false,
      });

      const runPromise = runtime.run(async () => {
        runtime.triggerShutdown();
      });
      await runPromise;

      await expect(runtime.run(async () => {})).rejects.toThrow(/only be called once/);
    });
  });

  describe('clean shutdown', () => {
    it('exits 0 when startup succeeds and shutdown is clean', async () => {
      const exit = vi.fn();
      const shutdownManager = new ShutdownManager({ timeoutMs: 100 });
      const runtime = new Runtime({
        shutdownManager,
        exit,
        trapUncaughtException: false,
        trapUnhandledRejection: false,
      });

      await runtime.run(async () => {
        runtime.triggerShutdown();
      });

      expect(exit).toHaveBeenCalledWith(0);
    });

    it('emits startup and shutdown events in order', async () => {
      const { events, onEvent } = collect();
      const shutdownManager = new ShutdownManager({ timeoutMs: 100 });
      const runtime = new Runtime({
        shutdownManager,
        onEvent,
        exit: noopExit,
        trapUncaughtException: false,
        trapUnhandledRejection: false,
      });

      await runtime.run(async () => {
        setImmediate(() => runtime.triggerShutdown());
      });

      const types = events.map((e) => e.type);
      expect(types).toEqual([
        'startup-start',
        'startup-complete',
        'shutdown-triggered',
        'shutdown-complete',
      ]);
    });
  });

  describe('startup error', () => {
    it('exits 1 and triggers shutdown with startup-error cause', async () => {
      const exit = vi.fn();
      const { events, onEvent } = collect();
      const shutdownManager = new ShutdownManager({ timeoutMs: 100 });
      const runtime = new Runtime({
        shutdownManager,
        onEvent,
        exit,
        trapUncaughtException: false,
        trapUnhandledRejection: false,
      });

      const boom = new Error('startup failed');
      await runtime.run(async () => {
        throw boom;
      });

      expect(exit).toHaveBeenCalledWith(1);
      const triggered = events.find((e) => e.type === 'shutdown-triggered');
      expect(triggered).toEqual({
        type: 'shutdown-triggered',
        cause: { type: 'startup-error', error: boom },
      });
    });
  });

  describe('drain errors', () => {
    it('exits 1 when shutdown phase has a participant error', async () => {
      const exit = vi.fn();
      const shutdownManager = new ShutdownManager({ timeoutMs: 100 });
      shutdownManager.addPhase({
        name: 'bad',
        participants: [{ name: 'bad', dispose: () => Promise.reject(new Error('drain')) }],
      });

      const runtime = new Runtime({
        shutdownManager,
        exit,
        trapUncaughtException: false,
        trapUnhandledRejection: false,
      });

      await runtime.run(async () => {
        runtime.triggerShutdown();
      });

      expect(exit).toHaveBeenCalledWith(1);
    });

    it('exits 1 when shutdown times out', async () => {
      const exit = vi.fn();
      const shutdownManager = new ShutdownManager({ timeoutMs: 10 });
      shutdownManager.addPhase({
        name: 'slow',
        participants: [{ name: 'slow', dispose: () => new Promise((r) => setTimeout(r, 100)) }],
      });

      const runtime = new Runtime({
        shutdownManager,
        exit,
        trapUncaughtException: false,
        trapUnhandledRejection: false,
      });

      await runtime.run(async () => {
        runtime.triggerShutdown();
      });

      expect(exit).toHaveBeenCalledWith(1);
    });
  });

  describe('trigger coalescing', () => {
    it('only shuts down once even when multiple triggers fire', async () => {
      const exit = vi.fn();
      const { events, onEvent } = collect();
      const shutdownManager = new ShutdownManager({ timeoutMs: 100 });
      const runtime = new Runtime({
        shutdownManager,
        onEvent,
        exit,
        trapUncaughtException: false,
        trapUnhandledRejection: false,
      });

      await runtime.run(async () => {
        runtime.triggerShutdown();
        runtime.triggerShutdown();
        runtime.triggerShutdown();
      });

      const triggered = events.filter((e) => e.type === 'shutdown-triggered');
      expect(triggered).toHaveLength(1);
      expect(exit).toHaveBeenCalledTimes(1);
    });
  });

  describe('signal handling', () => {
    it('triggers shutdown on SIGTERM', async () => {
      const exit = vi.fn();
      const { events, onEvent } = collect();
      const shutdownManager = new ShutdownManager({ timeoutMs: 100 });
      const runtime = new Runtime({
        shutdownManager,
        onEvent,
        exit,
        signals: ['SIGTERM'],
        trapUncaughtException: false,
        trapUnhandledRejection: false,
      });

      await runtime.run(async () => {
        process.emit('SIGTERM');
      });

      const signalReceived = events.find((e) => e.type === 'signal-received');
      expect(signalReceived).toEqual({ type: 'signal-received', signal: 'SIGTERM' });

      const triggered = events.find((e) => e.type === 'shutdown-triggered');
      expect(triggered).toEqual({
        type: 'shutdown-triggered',
        cause: { type: 'signal', signal: 'SIGTERM' },
      });
      expect(exit).toHaveBeenCalledWith(0);
    });

    it('disarms handlers after shutdown completes', async () => {
      const shutdownManager = new ShutdownManager({ timeoutMs: 100 });
      const runtime = new Runtime({
        shutdownManager,
        exit: noopExit,
        signals: ['SIGTERM'],
        trapUncaughtException: false,
        trapUnhandledRejection: false,
      });

      await runtime.run(async () => {
        runtime.triggerShutdown();
      });

      expect(process.listenerCount('SIGTERM')).toBe(0);
    });
  });

  describe('uncaught exception', () => {
    it('triggers shutdown on uncaughtException', async () => {
      const exit = vi.fn();
      const { events, onEvent } = collect();
      const shutdownManager = new ShutdownManager({ timeoutMs: 100 });
      const runtime = new Runtime({
        shutdownManager,
        onEvent,
        exit,
        trapUncaughtException: true,
        trapUnhandledRejection: false,
      });

      const boom = new Error('uncaught');
      await runtime.run(async () => {
        process.emit('uncaughtException', boom);
      });

      const triggered = events.find((e) => e.type === 'shutdown-triggered');
      expect(triggered).toEqual({
        type: 'shutdown-triggered',
        cause: { type: 'uncaught-exception', error: boom },
      });
    });
  });

  describe('onEvent isolation', () => {
    it('swallows observer errors', async () => {
      const exit = vi.fn();
      const shutdownManager = new ShutdownManager({ timeoutMs: 100 });
      const runtime = new Runtime({
        shutdownManager,
        onEvent: () => {
          throw new Error('observer boom');
        },
        exit,
        trapUncaughtException: false,
        trapUnhandledRejection: false,
      });

      await expect(
        runtime.run(async () => {
          runtime.triggerShutdown();
        }),
      ).resolves.toBeUndefined();
      expect(exit).toHaveBeenCalledWith(0);
    });
  });
});
