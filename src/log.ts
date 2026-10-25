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
