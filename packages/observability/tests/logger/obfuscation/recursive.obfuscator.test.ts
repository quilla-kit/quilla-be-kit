import { describe, expect, it } from 'vitest';
import { decryptValue } from '../../../src/logger/obfuscation/crypto.js';
import { createRecursiveObfuscator } from '../../../src/logger/obfuscation/recursive.obfuscator.js';

const SECRET = 'this-is-a-32-char-secret-key-abc';

describe('RecursiveObfuscator (hmac)', () => {
  it('produces stable pseudonyms for the same input', async () => {
    const obf = await createRecursiveObfuscator({ strategy: 'hmac', secretKey: SECRET });
    const a = await obf.obfuscate({ email: 'alice@example.com' });
    const b = await obf.obfuscate({ email: 'alice@example.com' });
    expect(a.email).toBe(b.email);
    expect(typeof a.email).toBe('string');
    expect((a.email as string).startsWith('HMAC(')).toBe(true);
  });

  it('produces different pseudonyms for different inputs', async () => {
    const obf = await createRecursiveObfuscator({ strategy: 'hmac', secretKey: SECRET });
    const a = await obf.obfuscate({ email: 'alice@example.com' });
    const b = await obf.obfuscate({ email: 'bob@example.com' });
    expect(a.email).not.toBe(b.email);
  });

  it('preserves keys and structure', async () => {
    const obf = await createRecursiveObfuscator({ strategy: 'hmac', secretKey: SECRET });
    const out = await obf.obfuscate({
      user: { id: 'u-1', name: 'Alice' },
      roles: ['admin', 'editor'],
      flag: true,
      count: 42,
      nothing: null,
      missing: undefined,
    });

    expect(Object.keys(out).sort()).toEqual(
      ['count', 'flag', 'missing', 'nothing', 'roles', 'user'].sort(),
    );
    const user = out.user as Record<string, unknown>;
    expect(Object.keys(user).sort()).toEqual(['id', 'name']);
    expect(Array.isArray(out.roles)).toBe(true);
    expect((out.roles as unknown[]).length).toBe(2);
  });

  it('preserves null and undefined leaves', async () => {
    const obf = await createRecursiveObfuscator({ strategy: 'hmac', secretKey: SECRET });
    const out = await obf.obfuscate({ a: null, b: undefined });
    expect(out.a).toBeNull();
    expect(out.b).toBeUndefined();
  });

  it('coerces numbers and booleans before obfuscating', async () => {
    const obf = await createRecursiveObfuscator({ strategy: 'hmac', secretKey: SECRET });
    const out = await obf.obfuscate({ n: 42, b: true });
    expect(typeof out.n).toBe('string');
    expect(typeof out.b).toBe('string');
    expect((out.n as string).startsWith('HMAC(')).toBe(true);
    expect((out.b as string).startsWith('HMAC(')).toBe(true);
  });
});

describe('RecursiveObfuscator (encrypt)', () => {
  it('produces different ciphertext on each call (random IV)', async () => {
    const obf = await createRecursiveObfuscator({ strategy: 'encrypt', secretKey: SECRET });
    const a = await obf.obfuscate({ email: 'alice@example.com' });
    const b = await obf.obfuscate({ email: 'alice@example.com' });
    expect(a.email).not.toBe(b.email);
    expect((a.email as string).startsWith('ENCRYPTED(')).toBe(true);
  });

  it('round-trips through decryptValue', async () => {
    const obf = await createRecursiveObfuscator({ strategy: 'encrypt', secretKey: SECRET });
    const out = await obf.obfuscate({ email: 'alice@example.com' });

    // Re-derive the key the same way the obfuscator does (via SHA-256 of the secret).
    const encoder = new TextEncoder();
    const hash = await crypto.subtle.digest('SHA-256', encoder.encode(SECRET));
    const key = await crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);

    const decrypted = await decryptValue(out.email as string, key);
    expect(decrypted).toBe('alice@example.com');
  });
});

describe('createRecursiveObfuscator', () => {
  it('throws when secretKey is shorter than 32 characters', async () => {
    await expect(
      createRecursiveObfuscator({ strategy: 'hmac', secretKey: 'too-short' }),
    ).rejects.toThrow(/at least 32 characters/);
  });
});
