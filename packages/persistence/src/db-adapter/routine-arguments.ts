import type { StoredProcedureCall } from './routine-db-adapter.interface.js';

/**
 * Validates a call's arguments and returns the names of its `out`/`inout`
 * arguments in declaration order: those arguments must be named, positional
 * arguments must precede named ones, and names must be unique.
 */
export function routineOutputNames(call: StoredProcedureCall): readonly string[] {
  const fail = (message: string): never => {
    throw new Error(`Routine ${JSON.stringify(call.routine)}: ${message}.`);
  };
  const names = new Set<string>();
  const outputNames: string[] = [];

  for (const { name, mode = 'in' } of call.args ?? []) {
    if (name === undefined && mode !== 'in') fail(`${mode} arguments must be named`);
    if (name === undefined && names.size > 0) fail('positional arguments must precede named ones');
    if (name === undefined) continue;
    if (names.has(name)) fail(`duplicate argument ${JSON.stringify(name)}`);
    names.add(name);
    if (mode !== 'in') outputNames.push(name);
  }
  return outputNames;
}
