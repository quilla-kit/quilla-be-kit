import { setControllerPrefix } from './route.metadata.js';

export function Controller(prefix: string) {
  return (_target: unknown, context: ClassDecoratorContext): void => {
    setControllerPrefix(context.metadata as Record<string | symbol, unknown>, prefix);
  };
}
