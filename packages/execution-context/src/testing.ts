import type { AuthSession } from './auth-session.type.js';
import type {
  ExecutionContextView,
  ScopedExecutionContextView,
  SessionExecutionContextView,
} from './execution-context-view.type.js';
import { executionContextFactory } from './execution-context.factory.js';
import type { ExecutionContext } from './execution-context.type.js';
import { toExecutionContextView } from './to-execution-context-view.js';

/** An `ExecutionContext` for tests: a system actor with random ids unless overridden. */
export function testExecutionContext(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return { ...executionContextFactory.createSystemContext('system'), ...overrides };
}

/** The `ExecutionContextView` of `testExecutionContext(overrides)`. */
export function testContextView(
  overrides: Partial<ExecutionContext> & {
    readonly session: AuthSession;
    readonly scopeId?: never;
  },
): SessionExecutionContextView;
export function testContextView(
  overrides: Partial<ExecutionContext> & { readonly scopeId: string; readonly session?: never },
): ScopedExecutionContextView;
export function testContextView(
  overrides?: Partial<ExecutionContext> &
    ({ readonly session?: never } | { readonly scopeId?: never }),
): ExecutionContextView;
export function testContextView(overrides: Partial<ExecutionContext> = {}): ExecutionContextView {
  return toExecutionContextView(testExecutionContext(overrides));
}
