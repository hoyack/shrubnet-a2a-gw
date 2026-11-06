// Shared harness: start dist/main.js with the fake openclaw and a scratch telemetry dir; a mock webhook receiver.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TOKEN = 'dummy-test-token';
export const AUTH = { Authorization: `Bearer ${TOKEN}` };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAIN = path.join(ROOT, 'dist/main.js');

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

function baseEnv(extra) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GATEWAY_|KIMICLAW_|OTEL_)/.test(k)));
  return { ...env, PATH: path.join(ROOT, 'test/golden/fakebin') + path.delimiter + env.PATH, ...extra };
}

/** Starts a gateway; returns helpers. `stop()` sends SIGTERM and waits so telemetry is flushed. */
export async function gateway(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-test-'));
  const port = await freePort();
  const tel = path.join(dir, 'tel');
  const p = spawn(process.execPath, [MAIN], {
    env: baseEnv({ KIMICLAW_TOKEN: TOKEN, PORT: String(port), FAKE_OPENCLAW_RECORD: path.join(dir, 'argv.jsonl'), GATEWAY_TELEMETRY_DIR: tel, ...extra }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  p.stdout.on('data', (c) => (out += c));
  p.stderr.on('data', (c) => (out += c));
  const exited = new Promise((r) => p.on('exit', r));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { await fetch(base + '/healthz'); break; } catch { await sleep(100); }
  }
  const gw = {
    base, tel, out: () => out,
    argv: () => fs.readFileSync(path.join(dir, 'argv.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)),
    file: (name) => fs.readFileSync(path.join(tel, name), 'utf8'),
    fetch: (p2, init = {}) => fetch(base + p2, { ...init, headers: { ...AUTH, ...(init.headers || {}) } }),
    rpc: async (method, params, query = '') => (await gw.fetch('/' + query, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: '1', method, params }) })).json(),
    stop: async () => { if (p.exitCode === null) { p.kill('SIGTERM'); await exited; } },
  };
  t.after(() => { if (p.exitCode === null) p.kill('SIGKILL'); });
  return gw;
}

export const userMsg = (text, kw = {}) => ({ message: { role: 'user', messageId: 'm1', parts: [{ kind: 'text', text }], ...kw } });

/** Runs main.js to completion (for boot failures). */
export const boot = (extra) => spawnSync(process.execPath, [MAIN], { env: baseEnv(extra), encoding: 'utf8', timeout: 20_000 });

export async function webhook(t) {
  const requests = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { requests.push({ path: req.url, headers: req.headers, rawHeaders: req.rawHeaders, body: Buffer.concat(chunks) }); res.end('ok'); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return {
    url: `http://127.0.0.1:${srv.address().port}/webhook/firewall`, requests,
    wait: async (n, ms = 10_000) => { const t0 = Date.now(); while (requests.length < n && Date.now() - t0 < ms) await sleep(50); return requests; },
  };
}
