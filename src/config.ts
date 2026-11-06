/** Env settings. Names, defaults and the .env fallback match the Python gateway. */
import * as fs from 'fs';
import * as path from 'path';

export const BASE_DIR = path.resolve(__dirname, '..');

function loadToken(): string {
  let tok = (process.env.KIMICLAW_TOKEN || '').trim();
  if (!tok) {
    const envPath = path.join(BASE_DIR, '.env');
    if (fs.existsSync(envPath)) {
      const line = fs.readFileSync(envPath, 'utf8').split('\n').find((l) => l.startsWith('KIMICLAW_TOKEN='));
      if (line) tok = line.split('=').slice(1).join('=').trim();
    }
  }
  if (!tok) throw new Error('KIMICLAW_TOKEN not set (set the env var or add KIMICLAW_TOKEN=... to .env; empty is refused)');
  return tok;
}

function int(name: string, dflt: string): number {
  const raw = process.env[name] ?? dflt;
  if (!/^\s*[+-]?\d+\s*$/.test(raw)) throw new Error(`${name} must be an integer`);
  return parseInt(raw, 10);
}

export const TOKEN = loadToken();
export const NOTIFY_URL = (process.env.GATEWAY_NOTIFY_URL || '').trim();
export const NOTIFY_AUTH_MODE = (process.env.GATEWAY_NOTIFY_AUTH_MODE ?? 'raw').toLowerCase();
export const NOTIFY_AUTH_USER = process.env.GATEWAY_NOTIFY_AUTH_USER ?? 'agent';
export const NOTIFY_EVENTS = new Set(
  (process.env.GATEWAY_NOTIFY_EVENTS ?? 'task_completed,task_failed').split(',').map((e) => e.trim()).filter(Boolean),
);
export const NOTIFY_TIMEOUT_MS = 10_000;
export const NOTIFY_FAIL_LIMIT = int('GATEWAY_NOTIFY_FAIL_LIMIT', '5');
export const NOTIFY_COOLDOWN_S = int('GATEWAY_NOTIFY_COOLDOWN_S', '900');
export const MAX_TEXT = 200_000;
export const AGENT_TIMEOUT = 560; // seconds, passed to openclaw
export const AGENT_CONCURRENCY = 3;
export const TASK_TTL_MS = 24 * 3600 * 1000;
