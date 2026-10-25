#!/usr/bin/env node
// Golden replay, ported from kimiclaw-a2a-gateway/tests/golden/golden.py.
//   node test/golden/golden.mjs              starts dist/main.js per profile with stubs, replays every case
//   node test/golden/golden.mjs --only NAME  replay one case
// Normalized: timestamps, UUIDs, durationMs. The notify User-Agent is ignored (it names the implementation).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CASES = path.join(HERE, 'cases');
const TOKEN = 'dummy-test-token';
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const TS = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?\+00:00/g;
const KEEP_HDR = new Set(['content-type', 'cache-control', 'authorization']);
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

function norm(o) {
  if (Array.isArray(o)) return o.map(norm);
  if (o && typeof o === 'object') {
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, k === 'durationMs' && Number.isInteger(v) ? '<int>' : norm(v)]));
  }
  if (typeof o === 'string') return o.replace(UUID, '<uuid>').replace(TS, '<ts>');
  return o;
}

function bodyOf(raw, ctype) {
  if (ctype.startsWith('text/event-stream')) {
    return { sse_frames: raw.split('\n\n').filter(Boolean).map((f) => (f.startsWith('data: ') ? norm(JSON.parse(f.slice(6))) : f)) };
  }
  try {
    const j = JSON.parse(raw);
    return { json: norm(j), raw_key_order: raw.startsWith('{') ? Object.keys(j) : null };
  } catch {
    return { text: raw };
  }
}

function n8nStub() {
  const reqs = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const b = Buffer.concat(chunks).toString('utf8');
      const names = req.rawHeaders.filter((_, i) => i % 2 === 0).map((k) => k.toLowerCase());
      const headers = {};
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i].toLowerCase();
        if (KEEP_HDR.has(k)) headers[k] = norm(req.rawHeaders[i + 1]);
      }
      const j = JSON.parse(b);
      reqs.push({
        method: 'POST', path: req.url, headers,
        header_names: names.filter((k) => k !== 'user-agent').sort(),
        json: norm(j), key_order: Object.keys(j),
        default_separators: b.startsWith('{"event": '),
      });
      res.end('ok');
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ reqs, srv, port: srv.address().port })));
}

const rpc = (method, params, id = '1') => ({ jsonrpc: '2.0', id, method, params });
const msg = (text, kw = {}) => ({ message: { role: 'user', messageId: 'm1', parts: [{ kind: 'text', text }], ...kw } });
const post = (json, p = '/', extra = {}) => ({ m: 'POST', p, json, ...extra });

const CASE_DEFS = {
  get_root: [{ m: 'GET', p: '/' }],
  get_root_unauth: [{ m: 'GET', p: '/', auth: null }],
  get_root_wrong_scheme: [{ m: 'GET', p: '/', auth: { Authorization: TOKEN } }],
  get_agent_card: [{ m: 'GET', p: '/.well-known/agent.json', auth: null }],
  post_parse_error: [{ m: 'POST', p: '/', raw: '{bad' }],
  post_unknown_method: [post(rpc('foo/bar', {}, 7))],
  post_unauth: [post(rpc('tasks/get', { id: 'x' }), '/', { auth: null })],
  send_agent_role: [post(rpc('message/send', { message: { role: 'agent', parts: [{ kind: 'text', text: 'x' }] } }))],
  send_empty: [post(rpc('message/send', {}))],
  send_too_large: [post(rpc('message/send', msg('x'.repeat(200_001))))],
  send_blocking_completed: [post(rpc('message/send', msg('hello', { taskId: 't-ok', contextId: 'ctx/1 x' })))],
  send_mixed_parts: [post(rpc('message/send', { message: { parts: [
    { kind: 'text', text: 'a' }, { kind: 'data', data: { k: 1 } }, { kind: 'file', file: { name: 'f.txt' } }, { kind: 'file' }] } }))],
  send_blocking_failed: [post(rpc('message/send', msg('FAIL', { taskId: 't-fail', contextId: 'c-fail' })))],
  send_nonblocking_query_then_get: [
    post(rpc('message/send', msg('SLOW', { taskId: 't-nb', contextId: 'c-nb' })), '/?wait=false'),
    { sleep: 3.5 },
    post(rpc('tasks/get', { id: 't-nb' }))],
  send_nonblocking_config: [post(rpc('message/send', { ...msg('SLOW', { taskId: 't-nb2' }), configuration: { blocking: false } })), { sleep: 3.5 }],
  stream_completed: [post(rpc('message/stream', msg('hi', { taskId: 't-s', contextId: 'c-s' }), 9))],
  stream_failed: [post(rpc('message/stream', msg('FAIL', { taskId: 't-sf', contextId: 'c-sf' }), 10))],
  stream_validation_error: [post(rpc('message/stream', {}))],
  tasks_get_taskid_alias: [
    post(rpc('message/send', msg('hello', { taskId: 't-g' }))),
    post(rpc('tasks/get', { taskId: 't-g' }))],
  tasks_get_not_found: [post(rpc('tasks/get', { id: 'nope' }))],
  tasks_cancel_not_found: [post(rpc('tasks/cancel', { id: 'nope' }))],
  tasks_cancel_then_overwritten_by_completion: [
    post(rpc('message/send', msg('SLOW', { taskId: 't-c', contextId: 'c-c' })), '/?wait=false'),
    post(rpc('tasks/cancel', { id: 't-c' })),
    { sleep: 3.5 },
    post(rpc('tasks/get', { id: 't-c' }))],
  tasks_cancel_completed_task: [
    post(rpc('message/send', msg('hello', { taskId: 't-cc' }))),
    post(rpc('tasks/cancel', { id: 't-cc' }))],
  // A2A_Firewall n8n workflow inputs
  n8n_inbound_nonblocking_submitted: [
    post({ jsonrpc: '2.0', id: 'req-123', method: 'message/send', params: { message: {
      role: 'user', messageId: 'msg-123', contextId: 'ctx-n8n-default', parts: [{ kind: 'text', text: 'hello from n8n' }] } } }, '/?wait=false'),
    { sleep: 1 }],
  n8n_basic_notify_completed: [post(rpc('message/send', msg('hello', { taskId: 't-bc', contextId: 'c-bc' })))],
  n8n_basic_notify_failed: [post(rpc('message/send', msg('FAIL', { taskId: 't-bf', contextId: 'c-bf' })))],
};
const PROFILES = { default: {}, n8n_basic: { GATEWAY_NOTIFY_AUTH_MODE: 'basic', GATEWAY_NOTIFY_AUTH_USER: 'n8n-dummy-user' } };
const profileOf = (name) => (name.startsWith('n8n_basic_') ? 'n8n_basic' : 'default');

async function runCase(base, n8n, steps) {
  n8n.reqs.length = 0;
  const out = [];
  for (const s of steps) {
    if ('sleep' in s) { await sleep(s.sleep); continue; }
    const h = { ...('auth' in s ? s.auth || {} : AUTH) };
    let body;
    if ('json' in s) { body = JSON.stringify(s.json); h['Content-Type'] = 'application/json'; }
    if ('raw' in s) { body = s.raw; h['Content-Type'] = 'application/json'; }
    const r = await fetch(base + s.p, { method: s.m, headers: h, body });
    const raw = await r.text();
    const ct = r.headers.get('content-type') || '';
    const headers = {};
    for (const [k, v] of r.headers) if (k === 'content-type' || k === 'cache-control') headers[k] = v;
    const a = h.Authorization || '';
    out.push({
      request: {
        method: s.m, path: s.p, auth: a.startsWith('Bearer ') ? 'bearer' : a ? 'raw-token' : null,
        ...('json' in s && JSON.stringify(s.json).length < 5000 ? { json: s.json } : {}),
        ...('raw' in s ? { raw: s.raw } : {}),
      },
      response: { status: r.status, headers, ...bodyOf(raw, ct) },
    });
  }
  await sleep(0.7);
  return { steps: out, n8n_outbound: [...n8n.reqs].sort((x, y) => (x.json.event < y.json.event ? -1 : x.json.event > y.json.event ? 1 : 0)) };
}

/** The recorded fixtures keep the Python stub's user-agent; it names the implementation, so it is not compared. */
function dropUserAgent(c) {
  for (const q of c.n8n_outbound) {
    delete q.headers['user-agent'];
    q.header_names = q.header_names.filter((k) => k !== 'user-agent');
  }
  return c;
}

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

async function startApp(n8nPort, extra) {
  const port = await freePort();
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GATEWAY_') && !k.startsWith('KIMICLAW_') && !k.startsWith('OTEL_')));
  Object.assign(env, {
    KIMICLAW_TOKEN: TOKEN, PORT: String(port), HOST: '127.0.0.1',
    PATH: path.join(HERE, 'fakebin') + path.delimiter + env.PATH,
    FAKE_OPENCLAW_RECORD: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'golden-')), 'openclaw-argv.jsonl'),
    GATEWAY_NOTIFY_URL: `http://127.0.0.1:${n8nPort}/webhook/firewall`,
    GATEWAY_TELEMETRY_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'golden-tel-')),
    ...extra,
  });
  const p = spawn(process.execPath, [path.join(ROOT, 'dist/main.js')], { env, stdio: ['ignore', 'ignore', 'inherit'] });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { await fetch(base + '/.well-known/agent.json'); break; } catch { await sleep(0.1); }
  }
  return { p, base };
}

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
let total = 0, fails = 0;
for (const [prof, extra] of Object.entries(PROFILES)) {
  const names = fs.readdirSync(CASES).sort().map((f) => f.slice(0, -5)).filter((n) => profileOf(n) === prof && (!only || n === only));
  if (!names.length) continue;
  const n8n = await n8nStub();
  const { p, base } = await startApp(n8n.port, extra);
  let pf = 0;
  try {
    for (const name of names) {
      const want = dropUserAgent(JSON.parse(fs.readFileSync(path.join(CASES, name + '.json'), 'utf8')));
      const got = await runCase(base, n8n, CASE_DEFS[name]);
      const ok = isDeepStrictEqual(got, want);
      pf += !ok;
      console.log((ok ? 'PASS ' : 'FAIL ') + name);
      if (!ok) { console.log('  want:', JSON.stringify(want).slice(0, 1500)); console.log('  got: ', JSON.stringify(got).slice(0, 1500)); }
    }
  } finally {
    p.kill('SIGTERM');
    n8n.srv.close();
  }
  console.log(`[${prof}] ${names.length - pf} passed, ${pf} failed`);
  total += names.length; fails += pf;
}
console.log(`golden: ${total - fails}/${total} passed`);
process.exit(fails ? 1 : 0);
