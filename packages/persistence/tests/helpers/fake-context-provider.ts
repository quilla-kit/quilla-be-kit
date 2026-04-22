import {
  type ExecutionContext,
  type ExecutionContextFactory,
  type ExecutionContextProvider,
  executionContextFactory,
} from '@quilla-kit/execution-context';

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
