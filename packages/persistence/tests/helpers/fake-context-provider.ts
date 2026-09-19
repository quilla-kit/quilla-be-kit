import {
  type ExecutionContext,
  type ExecutionContextFactory,
  type ExecutionContextProvider,
  executionContextFactory,
} from '@quilla-be-kit/execution-context';

export class FakeExecutionContextProvider implements ExecutionContextProvider {
  readonly factory: ExecutionContextFactory;

  constructor(
    private context: ExecutionContext,
    factory: ExecutionContextFactory = executionContextFactory,
  ) {
    this.factory = factory;
  }

  setContext(context: ExecutionContext): void {
    this.context = context;
  }

  getContext(): ExecutionContext {
    return this.context;
  }

  runWithContext<T>(_ctx: ExecutionContext, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

/** Reproduces a provider called outside any `runWithContext` scope. */
export class ThrowingExecutionContextProvider implements ExecutionContextProvider {
  readonly factory: ExecutionContextFactory = executionContextFactory;
  calls = 0;

  getContext(): ExecutionContext {
    this.calls += 1;
    throw new Error('ExecutionContext not available');
  }

  runWithContext<T>(_ctx: ExecutionContext, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}
