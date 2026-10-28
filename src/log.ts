/** Structured stdout logging: one JSON object per line. Never pass message or reply text here. */
type Level = 'INFO' | 'WARNING' | 'ERROR';

function write(level: Level, msg: string) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, logger: 'kimiclaw', msg }) + '\n');
}

export const LOG = {
  info: (msg: string) => write('INFO', msg),
  warning: (msg: string) => write('WARNING', msg),
  error: (msg: string) => write('ERROR', msg),
};

const MAX_LOG_ID = 128;

/** Client-supplied values (taskId, messageId, JSON-RPC id) go in log lines: escape control chars, line/paragraph
 * separators and NEL (no log forging) and cap the length (matches Python log_safe). */
export function logSafe(value: unknown): string {
  return [...String(value)].slice(0, MAX_LOG_ID).map((c) => {
    if (!/[\p{C}\p{Z}]/u.test(c) || c === ' ') return c;
    const n = c.codePointAt(0)!;
    return n < 256 ? `\\x${n.toString(16).padStart(2, '0')}` : `\\u${n.toString(16).padStart(4, '0')}`;
  }).join('');
}
