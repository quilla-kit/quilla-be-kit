import type { Logger } from '@quilla-kit/observability';

export function createFakeLogger(): Logger {
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    forMethod: () => logger,
  };
  return logger;
}
