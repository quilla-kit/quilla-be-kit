import type { LogEntry, LogLevel } from './log-entry.js';
import type { LogFormatter } from './log-formatter.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

/**
 * Human-readable, ANSI-colored output for local development.
 *
 * Format:
 *   TIMESTAMP [LEVEL] [module::location] message
 *     ctx:   key=value pairs from LogContext (only fields that are present)
 *     data:  JSON-stringified PII bucket (if present)
 *     meta:  JSON-stringified operational bucket (if present)
 *     extra: JSON-stringified enricher contributions (if present)
 *     error: name: message + optional cause + indented stack
 */
export class PrettyFormatter implements LogFormatter {
  format(entry: LogEntry): string {
    const color = LEVEL_COLORS[entry.level];
    const levelLabel = `${color}${BOLD}${entry.level.toUpperCase().padEnd(5)}${RESET}`;
    const location =
      entry.location !== undefined ? `${entry.module}::${entry.location}` : entry.module;
    const source = `${DIM}[${location}]${RESET}`;
    const ts = `${DIM}${entry.timestamp}${RESET}`;

    const lines: string[] = [`${ts} ${levelLabel} ${source} ${entry.message}`];

    const ctxParts: string[] = [];
    if (entry.context.scopeId !== undefined) ctxParts.push(`scopeId=${entry.context.scopeId}`);
    if (entry.context.userId !== undefined) ctxParts.push(`userId=${entry.context.userId}`);
    if (entry.context.actorType !== undefined)
      ctxParts.push(`actorType=${entry.context.actorType}`);
    if (entry.context.correlationId !== undefined) {
      ctxParts.push(`correlationId=${entry.context.correlationId}`);
    }
    if (ctxParts.length > 0) {
      lines.push(`  ${DIM}ctx:${RESET}   ${ctxParts.join(' ')}`);
    }

    if (entry.data !== undefined) {
      lines.push(`  ${DIM}data:${RESET}  ${JSON.stringify(entry.data)}`);
    }

    if (entry.meta !== undefined) {
      lines.push(`  ${DIM}meta:${RESET}  ${JSON.stringify(entry.meta)}`);
    }

    if (entry.extra !== undefined) {
      lines.push(`  ${DIM}extra:${RESET} ${JSON.stringify(entry.extra)}`);
    }

    if (entry.error !== undefined) {
      lines.push(`  ${color}${BOLD}${entry.error.name}:${RESET} ${entry.error.message}`);
      if (entry.error.cause !== undefined) {
        lines.push(`  ${DIM}cause:${RESET} ${entry.error.cause}`);
      }
      if (entry.error.stack !== undefined) {
        const stackLines = entry.error.stack
          .split('\n')
          .slice(1)
          .map((line) => `    ${DIM}${line.trim()}${RESET}`);
        lines.push(...stackLines);
      }
    }

    return lines.join('\n');
  }
}
