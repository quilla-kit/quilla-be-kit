import {
  setControllerAuthStack,
  setControllerPrefix,
  setControllerVersion,
} from './route.metadata.js';

export type ControllerOptions = {
  // Controller-level default version segment. Applies to every route on the
  // class unless a route sets its own version; itself overrides a module-level
  // version. See the resolution rule in the Router.
  readonly version?: string;

  // Controller-level default auth stack. Applies to every non-public route on
  // the class unless a route sets its own; itself overrides a module-level
  // stack. `*Public` routes on the class are unaffected — auth is skipped there.
  readonly authStack?: string;
};

export function Controller(prefix: string, options?: ControllerOptions) {
  return (_target: unknown, context: ClassDecoratorContext): void => {
    const metadata = context.metadata as Record<string | symbol, unknown>;
    setControllerPrefix(metadata, prefix);
    setControllerVersion(metadata, options?.version);
    setControllerAuthStack(metadata, options?.authStack);
  };
}
