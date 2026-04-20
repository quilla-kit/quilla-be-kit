export type LogObfuscationStrategy = 'hmac' | 'encrypt';

export interface LogObfuscator {
  obfuscate(data: Record<string, unknown>): Promise<Record<string, unknown>>;
}
