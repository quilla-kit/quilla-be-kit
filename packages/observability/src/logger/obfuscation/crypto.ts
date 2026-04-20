import type { webcrypto } from 'node:crypto';
import type { LogObfuscationStrategy } from './log-obfuscator.js';

type CryptoKey = webcrypto.CryptoKey;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function importAesKey(secret: string): Promise<CryptoKey> {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function importObfuscationKey(
  strategy: LogObfuscationStrategy,
  secret: string,
): Promise<CryptoKey> {
  return strategy === 'encrypt' ? importAesKey(secret) : importHmacKey(secret);
}

/**
 * Produces a stable pseudonym via HMAC-SHA256. Same input + same key → same
 * output. Enables log correlation without exposing the original value.
 *
 * Wire format: `HMAC(<base64>)`.
 */
export async function hmacValue(value: string, key: CryptoKey): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  const bytes = new Uint8Array(signature);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `HMAC(${btoa(binary)})`;
}

/**
 * Encrypts a value using AES-GCM with a fresh 96-bit random IV. The IV is
 * prepended to the ciphertext before base64 encoding so `decryptValue` can
 * recover it without a separate storage field.
 *
 * Wire format: `ENCRYPTED(<base64>)` where base64 = IV(12 bytes) + ciphertext.
 */
export async function encryptValue(value: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(value),
  );
  const cipherBytes = new Uint8Array(ciphertext);
  const combined = new Uint8Array(iv.byteLength + cipherBytes.byteLength);
  combined.set(iv, 0);
  combined.set(cipherBytes, iv.byteLength);
  let binary = '';
  for (const byte of combined) binary += String.fromCharCode(byte);
  return `ENCRYPTED(${btoa(binary)})`;
}

/**
 * Reverses `encryptValue`. Strips the `ENCRYPTED(...)` wrapper, decodes base64,
 * separates IV from ciphertext, and decrypts with AES-GCM. Intended for
 * incident-response and audit replay — not for hot paths.
 */
export async function decryptValue(obfuscated: string, key: CryptoKey): Promise<string> {
  if (!obfuscated.startsWith('ENCRYPTED(') || !obfuscated.endsWith(')')) {
    throw new Error('decryptValue: input is not in ENCRYPTED(...) format');
  }
  const b64 = obfuscated.slice('ENCRYPTED('.length, -1);
  const combined = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return decoder.decode(plaintext);
}
