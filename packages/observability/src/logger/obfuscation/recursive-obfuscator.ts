import type { webcrypto } from 'node:crypto';
import { encryptValue, hmacValue, importObfuscationKey } from './crypto.js';
import type { LogObfuscationStrategy, LogObfuscator } from './log-obfuscator.js';

type CryptoKey = webcrypto.CryptoKey;

const MIN_SECRET_KEY_LENGTH = 32;

export type RecursiveObfuscatorOptions = {
  readonly strategy: LogObfuscationStrategy;
  readonly secretKey: string;
};

/**
 * Recursively obfuscates all leaf values in a `Record<string, unknown>`.
 *
 * Invariants:
 * - Keys are never obfuscated — structure stays readable.
 * - Strings, numbers, and booleans are coerced to string then obfuscated.
 * - Nested objects are recursed into.
 * - Arrays are processed element-by-element.
 * - `null` and `undefined` are preserved as-is.
 */
export class RecursiveObfuscator implements LogObfuscator {
  constructor(
    private readonly key: CryptoKey,
    private readonly strategy: LogObfuscationStrategy,
  ) {}

  async obfuscate(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.obfuscateObject(data);
  }

  private async obfuscateValue(value: unknown): Promise<unknown> {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) {
      return Promise.all(value.map((item) => this.obfuscateValue(item)));
    }
    if (typeof value === 'object') {
      return this.obfuscateObject(value as Record<string, unknown>);
    }
    const str = String(value);
    return this.strategy === 'encrypt' ? encryptValue(str, this.key) : hmacValue(str, this.key);
  }

  private async obfuscateObject(obj: Record<string, unknown>): Promise<Record<string, unknown>> {
    const entries = Object.entries(obj);
    const processed = await Promise.all(
      entries.map(async ([key, val]) => [key, await this.obfuscateValue(val)] as const),
    );
    return Object.fromEntries(processed);
  }
}

/**
 * Constructs a `RecursiveObfuscator`. Async because the `CryptoKey` is imported
 * once from the raw secret. Throws if `secretKey` is shorter than 32 characters.
 */
export async function createRecursiveObfuscator(
  opts: RecursiveObfuscatorOptions,
): Promise<RecursiveObfuscator> {
  if (opts.secretKey.length < MIN_SECRET_KEY_LENGTH) {
    throw new Error(
      `createRecursiveObfuscator: secretKey must be at least ${MIN_SECRET_KEY_LENGTH} characters`,
    );
  }
  const key = await importObfuscationKey(opts.strategy, opts.secretKey);
  return new RecursiveObfuscator(key, opts.strategy);
}
