import type { ShutdownPhaseConfig } from '../shutdown/shutdown-phase.type.js';
import type { ComponentContract } from './component-contract.type.js';
import type { Component } from './component.type.js';

export type ComponentRegistryOptions = {
  readonly contracts?: readonly ComponentContract[];
};

export class ComponentRegistry<TMeta = unknown> {
  private readonly components: Component<TMeta>[] = [];
  private readonly byName = new Map<string, Component<TMeta>>();

  constructor(options?: ComponentRegistryOptions) {
    if (options?.contracts) {
      validateContracts(options.contracts);
    }
  }

  register(component: Component<TMeta>): this {
    if (this.byName.has(component.name)) {
      throw new Error(`Component "${component.name}" is already registered`);
    }
    this.components.push(component);
    this.byName.set(component.name, component);
    return this;
  }

  getAll(): readonly Component<TMeta>[] {
    return this.components;
  }

  getByName(name: string): Component<TMeta> | undefined {
    return this.byName.get(name);
  }

  toShutdownPhase(phaseName: string): ShutdownPhaseConfig {
    const participants = this.components
      .filter(
        (c): c is Component<TMeta> & { dispose: () => Promise<void> } =>
          typeof c.dispose === 'function',
      )
      .map((c) => ({
        name: c.name,
        dispose: () => c.dispose(),
      }));
    return { name: phaseName, participants };
  }
}

function validateContracts(contracts: readonly ComponentContract[]): void {
  const providers = new Map<string, string>();
  for (const contract of contracts) {
    for (const token of contract.provides) {
      const existing = providers.get(token);
      if (existing) {
        throw new Error(
          `Token "${token}" is provided by both "${existing}" and "${contract.name}"`,
        );
      }
      providers.set(token, contract.name);
    }
  }
  for (const contract of contracts) {
    for (const token of contract.requires) {
      if (!providers.has(token)) {
        throw new Error(
          `Component "${contract.name}" requires token "${token}" but no component provides it`,
        );
      }
    }
  }
}
