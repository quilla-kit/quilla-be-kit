import type { ExecutionContext, ExecutionContextProvider } from '@quilla-kit/execution-context';

export class FakeExecutionContextProvider implements ExecutionContextProvider {
  constructor(private context: ExecutionContext) {}

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
