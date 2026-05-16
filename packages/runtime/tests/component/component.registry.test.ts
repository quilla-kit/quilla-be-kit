import { describe, expect, it, vi } from 'vitest';
import { ComponentRegistry } from '../../src/component/component.registry.js';
import type { Component } from '../../src/component/component.type.js';

describe('ComponentRegistry', () => {
  describe('contract validation', () => {
    it('throws when two components provide the same token', () => {
      expect(
        () =>
          new ComponentRegistry({
            contracts: [
              { name: 'iam', provides: ['userService'], requires: [] },
              { name: 'admin', provides: ['userService'], requires: [] },
            ],
          }),
      ).toThrow(/provided by both "iam" and "admin"/);
    });

    it('throws when a component requires an unprovided token', () => {
      expect(
        () =>
          new ComponentRegistry({
            contracts: [{ name: 'iam', provides: [], requires: ['missingToken'] }],
          }),
      ).toThrow(/requires token "missingToken"/);
    });

    it('passes when graph is valid', () => {
      expect(
        () =>
          new ComponentRegistry({
            contracts: [
              { name: 'iam', provides: ['userService'], requires: [] },
              { name: 'dm', provides: [], requires: ['userService'] },
            ],
          }),
      ).not.toThrow();
    });

    it('allows construction without contracts', () => {
      expect(() => new ComponentRegistry()).not.toThrow();
    });
  });

  describe('registration', () => {
    it('registers a component and makes it retrievable', () => {
      const registry = new ComponentRegistry();
      const component: Component = { name: 'iam' };
      registry.register(component);

      expect(registry.getAll()).toEqual([component]);
      expect(registry.getByName('iam')).toBe(component);
    });

    it('throws on duplicate registration', () => {
      const registry = new ComponentRegistry();
      registry.register({ name: 'iam' });
      expect(() => registry.register({ name: 'iam' })).toThrow(/already registered/);
    });

    it('preserves registration order', () => {
      const registry = new ComponentRegistry();
      registry.register({ name: 'a' }).register({ name: 'b' }).register({ name: 'c' });

      expect(registry.getAll().map((c) => c.name)).toEqual(['a', 'b', 'c']);
    });
  });

  describe('toShutdownPhase', () => {
    it('produces a phase containing only components with dispose', () => {
      const registry = new ComponentRegistry();
      const disposeA = vi.fn().mockResolvedValue(undefined);
      registry.register({ name: 'a', dispose: disposeA }).register({ name: 'b' }); // no dispose

      const phase = registry.toShutdownPhase('modules');

      expect(phase.name).toBe('modules');
      expect(phase.participants.map((p) => p.name)).toEqual(['a']);
    });

    it('wraps dispose so the registered component is disposed', async () => {
      const registry = new ComponentRegistry();
      const disposeA = vi.fn().mockResolvedValue(undefined);
      registry.register({ name: 'a', dispose: disposeA });

      const phase = registry.toShutdownPhase('modules');
      await phase.participants[0]?.dispose();

      expect(disposeA).toHaveBeenCalledTimes(1);
    });
  });
});
