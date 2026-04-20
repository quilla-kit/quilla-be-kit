import { describe, expect, it, vi } from 'vitest';
import type { Disposable } from '../src/disposable.interface.js';
import type { ShutdownEvent } from '../src/shutdown-event.type.js';
import { ShutdownManager } from '../src/shutdown.manager.js';

const disposable = (name: string, fn?: () => Promise<void>): Disposable => ({
  name,
  dispose: fn ?? (() => Promise.resolve()),
});

describe('ShutdownManager', () => {
  it('runs phases sequentially in insertion order', async () => {
    const order: string[] = [];
    const mgr = new ShutdownManager({ timeoutMs: 1000 });

    mgr
      .addPhase({
        name: 'http',
        participants: [
          disposable('HonoServer', async () => {
            order.push('http');
          }),
        ],
      })
      .addPhase({
        name: 'database',
        participants: [
          disposable('Pg', async () => {
            order.push('database');
          }),
        ],
      });

    const result = await mgr.shutdown();

    expect(order).toEqual(['http', 'database']);
    expect(result.phases.map((p) => p.name)).toEqual(['http', 'database']);
    expect(result.totalErrors).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('runs participants within a phase concurrently', async () => {
    const startedAt: number[] = [];
    const mgr = new ShutdownManager({ timeoutMs: 1000 });

    const slow = (name: string): Disposable => ({
      name,
      dispose: async () => {
        startedAt.push(Date.now());
        await new Promise((r) => setTimeout(r, 30));
      },
    });

    mgr.addPhase({
      name: 'modules',
      participants: [slow('a'), slow('b'), slow('c')],
    });

    const begin = Date.now();
    const result = await mgr.shutdown();
    const elapsed = Date.now() - begin;

    expect(startedAt.length).toBe(3);
    expect(Math.max(...startedAt) - Math.min(...startedAt)).toBeLessThan(20);
    expect(elapsed).toBeLessThan(80);
    expect(result.totalErrors).toBe(0);
  });

  it('isDraining flips true once shutdown begins', async () => {
    const mgr = new ShutdownManager({ timeoutMs: 1000 });
    expect(mgr.isDraining()).toBe(false);

    mgr.addPhase({
      name: 'x',
      participants: [disposable('X', () => new Promise((r) => setTimeout(r, 20)))],
    });

    const promise = mgr.shutdown();
    expect(mgr.isDraining()).toBe(true);
    await promise;
    expect(mgr.isDraining()).toBe(true);
  });

  it('is idempotent — concurrent calls share the same in-flight run', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const mgr = new ShutdownManager({ timeoutMs: 1000 });
    mgr.addPhase({
      name: 'x',
      participants: [{ name: 'X', dispose }],
    });

    const [a, b, c] = await Promise.all([mgr.shutdown(), mgr.shutdown(), mgr.shutdown()]);

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('continues after a participant error and collects errors', async () => {
    const mgr = new ShutdownManager({ timeoutMs: 1000 });
    const later = vi.fn().mockResolvedValue(undefined);
    const boom = new Error('boom');

    mgr
      .addPhase({
        name: 'http',
        participants: [
          disposable('good', async () => {}),
          { name: 'bad', dispose: () => Promise.reject(boom) },
        ],
      })
      .addPhase({
        name: 'database',
        participants: [{ name: 'Pg', dispose: later }],
      });

    const result = await mgr.shutdown();

    expect(later).toHaveBeenCalledTimes(1);
    expect(result.totalErrors).toBe(1);
    expect(result.phases[0]?.errors).toEqual([{ participant: 'bad', error: boom }]);
    expect(result.phases[1]?.errors).toEqual([]);
  });

  it('emits events in expected order', async () => {
    const events: ShutdownEvent[] = [];
    const mgr = new ShutdownManager({
      timeoutMs: 1000,
      onEvent: (e) => events.push(e),
    });

    mgr.addPhase({
      name: 'http',
      participants: [disposable('HonoServer')],
    });

    await mgr.shutdown();

    expect(events.map((e) => e.type)).toEqual([
      'shutdown-start',
      'phase-start',
      'phase-end',
      'shutdown-complete',
    ]);
  });

  it('emits participant-error on failure', async () => {
    const events: ShutdownEvent[] = [];
    const boom = new Error('boom');
    const mgr = new ShutdownManager({
      timeoutMs: 1000,
      onEvent: (e) => events.push(e),
    });

    mgr.addPhase({
      name: 'http',
      participants: [{ name: 'bad', dispose: () => Promise.reject(boom) }],
    });

    await mgr.shutdown();

    const err = events.find((e) => e.type === 'participant-error');
    expect(err).toEqual({
      type: 'participant-error',
      phase: 'http',
      participant: 'bad',
      error: boom,
    });
  });

  it('marks timedOut and emits timeout event when phases exceed timeout', async () => {
    const events: ShutdownEvent[] = [];
    const mgr = new ShutdownManager({
      timeoutMs: 30,
      onEvent: (e) => events.push(e),
    });

    mgr.addPhase({
      name: 'slow',
      participants: [disposable('Slow', () => new Promise((r) => setTimeout(r, 200)))],
    });

    const result = await mgr.shutdown();

    expect(result.timedOut).toBe(true);
    expect(events.some((e) => e.type === 'timeout')).toBe(true);
  });

  it('swallows observer errors', async () => {
    const mgr = new ShutdownManager({
      timeoutMs: 1000,
      onEvent: () => {
        throw new Error('observer boom');
      },
    });

    mgr.addPhase({ name: 'x', participants: [disposable('X')] });

    await expect(mgr.shutdown()).resolves.toBeDefined();
  });

  it('resolves cleanly with no phases registered', async () => {
    const mgr = new ShutdownManager({ timeoutMs: 1000 });
    const result = await mgr.shutdown();

    expect(result.phases).toEqual([]);
    expect(result.totalErrors).toBe(0);
    expect(result.timedOut).toBe(false);
  });
});
