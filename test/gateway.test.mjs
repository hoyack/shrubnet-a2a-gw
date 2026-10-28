// Behaviour tests against the built server (port of the Python characterization + contract tests).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { AUTH, ROOT, TOKEN, boot, gateway, sleep, userMsg, webhook } from './helpers.mjs';

const OPENAPI_SHA = '5b2c7fc0441a220f248aedd833775847a6fbd35054659b0a5ca1d23c1d9d916b';

test('openapi.yaml is the frozen copy and /openapi.json serves it exactly', async (t) => {
  const yamlText = fs.readFileSync(path.join(ROOT, 'openapi.yaml'));
  assert.equal(createHash('sha256').update(yamlText).digest('hex'), OPENAPI_SHA);
  const gw = await gateway(t);
  const served = await (await gw.fetch('/openapi.json')).json();
  assert.deepEqual(served, parse(yamlText.toString()));
  // every documented path/method is routed (not 404/405)
  for (const [p, ops] of Object.entries(served.paths)) {
    for (const m of Object.keys(ops)) {
      const r = await gw.fetch(p, m === 'post' ? { method: 'POST', body: '{}' } : {});
      assert.ok(![404, 405].includes(r.status), `${m} ${p} -> ${r.status}`);
    }
  }
  for (const p of ['/docs', '/redoc']) assert.equal((await gw.fetch(p)).status, 200);
  assert.equal((await fetch(gw.base + '/docs')).status, 401);
});

test('agent card is public and byte-identical to the Python app', async (t) => {
  const gw = await gateway(t);
  const r = await fetch(gw.base + '/.well-known/agent.json');
  assert.equal(r.headers.get('content-type'), 'application/json');
  assert.equal(await r.text(), JSON.parse(fs.readFileSync(path.join(ROOT, 'test/golden/agent_card.raw.json'), 'utf8')));
});

test('auth: bearer required except agent card and /healthz; 404/405 like the Python app', async (t) => {
  const gw = await gateway(t);
  for (const h of [{}, { Authorization: TOKEN }, { Authorization: `Bearer ${TOKEN}x` }, { Authorization: `bearer ${TOKEN}` }]) {
    const r = await fetch(gw.base + '/', { headers: h });
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { error: 'unauthorized' });
  }
  assert.deepEqual(await (await fetch(gw.base + '/healthz')).json(), { status: 'ok' });
  assert.equal((await fetch(gw.base + '/readyz')).status, 401);
  assert.deepEqual(await (await gw.fetch('/readyz')).json(), { status: 'ready' });
  assert.equal((await fetch(gw.base + '/nope')).status, 401);
  const nf = await gw.fetch('/nope');
  assert.equal(nf.status, 404);
  assert.deepEqual(await nf.json(), { detail: 'Not Found' });
  const na = await gw.fetch('/healthz', { method: 'POST' });
  assert.equal(na.status, 405);
  assert.deepEqual(await na.json(), { detail: 'Method Not Allowed' });
  assert.equal(gw.out().includes(TOKEN), false);
});

test('readyz is 503 without openclaw on PATH', async (t) => {
  const gw = await gateway(t, { PATH: '/nonexistent' });
  const r = await gw.fetch('/readyz');
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { status: 'not ready', reason: 'openclaw binary not found on PATH' });
});

test('JSON-RPC errors: parse error 400, non-object 500, unknown method, validation at HTTP 200', async (t) => {
  const gw = await gateway(t);
  const pe = await gw.fetch('/', { method: 'POST', body: '{bad' });
  assert.equal(pe.status, 400);
  assert.deepEqual(await pe.json(), { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
  const arr = await gw.fetch('/', { method: 'POST', body: '[1]' });
  assert.equal(arr.status, 500);
  assert.equal(await arr.text(), 'Internal Server Error');
  assert.equal((await gw.rpc('foo/bar', {})).error.message, 'method not found: foo/bar');
  const cases = [
    [{}, 'empty message'],
    [{ message: { role: 'agent', parts: [{ kind: 'text', text: 'x' }] } }, 'only user-role messages accepted'],
    [userMsg('x'.repeat(200_001)), 'message too large'],
  ];
  for (const [params, message] of cases) {
    const r = await gw.fetch('/', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params }) });
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).error, { code: -32602, message });
  }
});

test('message/send blocks and runs openclaw with the session derived from contextId', async (t) => {
  const gw = await gateway(t);
  const r = await gw.rpc('message/send', userMsg('hello', { taskId: 't1', contextId: 'ctx/1 x' }));
  assert.equal(r.result.status.state, 'completed');
  assert.equal(r.result.artifacts[0].parts[0].text, 'echo: hello');
  assert.deepEqual(gw.argv()[0], ['agent', '--local', '--session-id', 'a2a-ctx-1-x', '--message', 'hello', '--json', '--timeout', '560']);
  const f = await gw.rpc('message/send', userMsg('FAIL'));
  assert.equal(f.result.status.state, 'failed');
  assert.equal(f.result.status.message.parts[0].text, 'agent error: agent exited 3: boom\n');
});

test('non-blocking send, tasks/get by taskId, cancel overwritten by completion', async (t) => {
  const gw = await gateway(t);
  const nb = await gw.rpc('message/send', userMsg('SLOW', { taskId: 'a' }), '?wait=false');
  assert.equal(nb.result.status.state, 'submitted');
  const nb2 = await gw.rpc('message/send', { ...userMsg('SLOW', { taskId: 'b' }), configuration: { blocking: false } });
  assert.equal(nb2.result.status.state, 'submitted');
  assert.equal((await gw.rpc('tasks/cancel', { taskId: 'a' })).result.status.state, 'canceled');
  await sleep(2600);
  assert.equal((await gw.rpc('tasks/get', { id: 'a' })).result.status.state, 'completed');
  assert.equal((await gw.rpc('tasks/get', { taskId: 'b' })).result.status.state, 'completed');
  assert.equal((await gw.rpc('tasks/get', { id: 'nope' })).error.code, -32001);
});

test('message/stream sends SSE frames; validation errors stay JSON', async (t) => {
  const gw = await gateway(t);
  const r = await gw.fetch('/', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'message/stream', params: userMsg('hi') }) });
  assert.equal(r.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  const frames = (await r.text()).split('\n\n').filter(Boolean).map((f) => JSON.parse(f.slice(6)).result);
  assert.deepEqual(frames.map((f) => [f.kind, f.final]), [['status-update', false], ['artifact-update', false], ['status-update', true]]);
  const v = await gw.fetch('/', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/stream', params: {} }) });
  assert.equal(v.headers.get('content-type'), 'application/json');
});

test('notify: exact body bytes, header set, raw auth by default', async (t) => {
  const hook = await webhook(t);
  const gw = await gateway(t, { GATEWAY_NOTIFY_URL: hook.url });
  await gw.rpc('message/send', userMsg('hello', { taskId: 't9', contextId: 'c9' }));
  const [q] = await hook.wait(1);
  await sleep(300);
  assert.equal(hook.requests.length, 1); // task_started is off by default
  assert.equal(q.path, '/webhook/firewall');
  assert.equal(q.headers.authorization, TOKEN);
  assert.equal(q.headers['content-length'], String(q.body.length));
  assert.deepEqual(q.rawHeaders.filter((_, i) => i % 2 === 0).map((k) => k.toLowerCase()).sort(),
    ['accept-encoding', 'authorization', 'connection', 'content-length', 'content-type', 'host', 'user-agent']);
  const body = JSON.parse(q.body);
  const expected = `{"event": "task_completed", "source": "kimiclaw-a2a-gateway", "taskId": "t9", "contextId": "c9", "timestamp": "${body.timestamp}", "state": "completed", "reply": "echo: hello", "durationMs": ${body.durationMs}}`;
  assert.equal(q.body.toString(), expected);
  assert.match(body.timestamp, /\+00:00$/);
});

test('notify auth modes and task_started opt-in', async (t) => {
  const b64 = (s) => Buffer.from(s).toString('base64');
  for (const [mode, user, expect] of [
    ['bearer', undefined, `Bearer ${TOKEN}`], ['BASIC', undefined, 'Basic ' + b64(`agent:${TOKEN}`)],
    ['basic', 'n8n', 'Basic ' + b64(`n8n:${TOKEN}`)], ['whatever', undefined, TOKEN],
  ]) {
    const hook = await webhook(t);
    const gw = await gateway(t, { GATEWAY_NOTIFY_URL: hook.url, GATEWAY_NOTIFY_AUTH_MODE: mode, ...(user ? { GATEWAY_NOTIFY_AUTH_USER: user } : {}) });
    await gw.rpc('message/send', userMsg('hi'));
    assert.equal((await hook.wait(1))[0].headers.authorization, expect, mode);
    await gw.stop();
  }
  const hook = await webhook(t);
  const gw = await gateway(t, { GATEWAY_NOTIFY_URL: hook.url, GATEWAY_NOTIFY_EVENTS: 'task_started, task_completed' });
  await gw.rpc('message/send', userMsg('hi', { taskId: 'a', contextId: 'b' }));
  const [s0, s1] = (await hook.wait(2)).map((q) => JSON.parse(q.body));
  assert.deepEqual(s0, { event: 'task_started', source: 'kimiclaw-a2a-gateway', taskId: 'a', contextId: 'b', timestamp: s0.timestamp });
  assert.equal(s1.event, 'task_completed');
});

test('notify circuit breaker opens; failure logs carry host and error type only', async (t) => {
  const gw = await gateway(t, { GATEWAY_NOTIFY_URL: 'http://127.0.0.1:9/SECRET-HOOK-PATH/abc?k=SECRETQ', GATEWAY_NOTIFY_FAIL_LIMIT: '2' });
  for (let i = 0; i < 3; i++) assert.equal((await gw.rpc('message/send', userMsg('hi'))).result.status.state, 'completed');
  await sleep(500);
  await gw.stop();
  const out = gw.out();
  assert.ok(out.includes('failed (1/2)') && out.includes('failed (2/2)'));
  assert.ok(out.includes('notify circuit breaker OPEN: outbound webhooks paused 900s'));
  assert.equal(out.split('notify task_completed').length - 1, 2);
  assert.ok(out.includes('host=127.0.0.1') && out.includes('error_type='));
  for (const s of [out, gw.file('logs.jsonl')]) for (const n of ['SECRET-HOOK-PATH', 'SECRETQ', '    at ']) assert.equal(s.includes(n), false, n);
});

test('telemetry files: events, spans in one trace, no message or reply text', async (t) => {
  const hook = await webhook(t);
  const gw = await gateway(t, { GATEWAY_NOTIFY_URL: hook.url });
  await gw.rpc('message/send', userMsg('SECRET-OK-77', { taskId: 'ok1' }));
  await gw.rpc('message/send', userMsg('SECRET-FAIL-88 FAIL', { taskId: 'bad1' }));
  await hook.wait(2);
  await gw.fetch('/');
  await gw.stop();
  const logs = gw.file('logs.jsonl');
  const traces = gw.file('traces.jsonl');
  assert.ok(logs.includes('"task_id": "ok1"') && logs.includes('"status": 200') && logs.includes('"rpc_method": "message/send"'));
  assert.ok(logs.includes('"event": "task_finished"'));
  assert.ok(gw.file('metrics.jsonl').includes('gateway.requests'));
  const spans = traces.trim().split('\n').map((l) => JSON.parse(l));
  const agent = spans.filter((s) => s.name === 'agent.run');
  assert.equal(agent.length, 2);
  const tr = agent[0].context.trace_id;
  assert.ok(spans.some((s) => s.name === 'notify' && s.context.trace_id === tr));
  assert.ok(spans.some((s) => s.name === 'rpc' && s.context.trace_id === tr));
  for (const s of [logs, traces, gw.out()]) for (const n of ['SECRET-OK-77', 'SECRET-FAIL-88', 'echo:', 'boom']) assert.equal(s.includes(n), false, n);
  assert.match(gw.out(), /inbound task_id=ok1 (message_id=\S+ )?len=12/);
  assert.ok(gw.out().includes('agent run failed task=bad1 error_type='));
});

test('stream rpc span and http_request duration cover the whole stream', async (t) => {
  const gw = await gateway(t);
  const r = await gw.fetch('/', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/stream', params: userMsg('SLOW') }) });
  assert.ok((await r.text()).includes('"completed"'));
  await gw.stop();
  const rpc = gw.file('traces.jsonl').trim().split('\n').map((l) => JSON.parse(l))
    .filter((s) => s.name === 'rpc' && s.attributes['http.request.method'] === 'POST');
  assert.equal(rpc.length, 1);
  assert.ok(Date.parse(rpc[0].end_time) - Date.parse(rpc[0].start_time) >= 1900);
  const req = gw.file('logs.jsonl').trim().split('\n').map((l) => JSON.parse(l)).find((l) => l.event === 'http_request' && l.method === 'POST');
  assert.ok(req.duration_ms >= 1900);
});

test('payload text is never logged, even with legacy GATEWAY_LOG_PAYLOADS=1 (F26)', async (t) => {
  const gw = await gateway(t, { GATEWAY_LOG_PAYLOADS: '1' });
  await gw.rpc('message/send', userMsg('PROMPT-OK-77 hello'));
  await gw.stop();
  const out = gw.out();
  assert.ok(out.includes('inbound task_id=') && out.includes('message_id=m1 len=18'), out);
  for (const text of [out, gw.file('logs.jsonl')]) assert.ok(!text.includes('PROMPT-OK-77'));
});

// Raw-text checks: JSON.stringify leaves U+2028/2029/NEL raw, so look for them in the raw output (and NEL, U+0085, explicitly).
const FORGE_TAIL = 'FORGED-LINE level=ERROR\x1b[31m\u2028\u2029\u0085\x1c\x1d\x1e\x0b\x0cx';
const BAD_RAW = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029]/; // C0 (minus \t,\n), DEL, C1 incl. NEL U+0085, LS, PS
function assertNoForgery(out) {
  for (const l of out.split('\n')) {
    if (!l) continue;
    assert.ok(!l.startsWith('FORGED-LINE'), l);
    assert.ok(!BAD_RAW.test(l) && !l.includes('\r'), `raw separator/control char in log line: ${JSON.stringify(l)}`);
  }
  assert.ok(!out.includes('\r'));
}

test('log-safety regex covers NEL (U+0085), LS and PS', () => {
  for (const c of ['\u0085', '\u2028', '\u2029', '\x1c', '\x1d', '\x1e', '\x1b', '\x7f']) assert.ok(BAD_RAW.test(c), JSON.stringify(c));
  assert.ok(!BAD_RAW.test('plain \\x85 text'));
});

test('client messageId cannot forge log lines: control chars escaped, length capped', async (t) => {
  const gw = await gateway(t);
  const forged = 'm1\r\n' + FORGE_TAIL + 'A'.repeat(500);
  await gw.rpc('message/send', userMsg('hello', { messageId: forged, taskId: 'forge1' }));
  await gw.stop();
  const lines = gw.out().split('\n');
  const inbound = lines.filter((l) => l.includes('inbound task_id=forge1'));
  assert.equal(inbound.length, 1, gw.out());
  assertNoForgery(gw.out());
  assert.ok(!inbound[0].includes('A'.repeat(129)));
});

test('client taskId cannot forge log lines (inbound, agent-failed, notify ok + failed)', async (t) => {
  const forged = 't1\r\n' + FORGE_TAIL + 'B'.repeat(500);
  const hook = await webhook(t);
  for (const url of [hook.url, 'http://127.0.0.1:9/hook']) {
    const gw = await gateway(t, { GATEWAY_NOTIFY_URL: url });
    await gw.rpc('message/send', userMsg('hello FAIL', { taskId: forged }));
    for (let i = 0; i < 50 && !gw.out().includes('notify task_failed'); i++) await sleep(100);
    await gw.stop();
    const lines = gw.out().split('\n');
    for (const needle of ['inbound task_id=t1', 'agent run failed task=t1', 'notify task_failed task=t1']) {
      const hits = lines.filter((l) => l.includes(needle));
      assert.equal(hits.length, 1, `${url} ${needle}\n${gw.out()}`);
      assert.ok(!hits[0].includes('B'.repeat(129)));
    }
    assertNoForgery(gw.out());
  }
});

test('JSON-RPC id (reqId) cannot forge log lines on SSE stream errors', () => {
  const forged = 'r1\r\n' + FORGE_TAIL + 'C'.repeat(500);
  const prog = `
    const { sseEvents } = require('./dist/a2a.controller.js');
    const queue = { get: async () => { throw new Error('boom'); } };
    const res = { on() {}, writeHead() {}, write() {}, end() {} };
    sseEvents(process.argv[1], queue, res).then(() => process.exit(0));`;
  const r = spawnSync(process.execPath, ['-e', prog, forged], { cwd: ROOT, env: { ...process.env, KIMICLAW_TOKEN: TOKEN }, encoding: 'utf8', timeout: 20_000 });
  assert.ok(r.stdout.includes('sse error req_id=r1'), `${r.stdout}\n${r.stderr}`);
  assertNoForgery(r.stdout);
  assert.ok(!r.stdout.includes('C'.repeat(129)));
});

test('task-crashed log escapes forged taskId and logs error_type only', () => {
  const forged = 'c1\r\n' + FORGE_TAIL + 'D'.repeat(500);
  // Force executeTask to reject before the agent try/catch: emit() calls queue.put and throws.
  const prog = `
    delete process.env.GATEWAY_NOTIFY_URL;
    const { startTask } = require('./dist/task-store.js');
    const queue = { put() { throw Object.assign(new Error('secret-crash-msg'), { name: 'CrashError' }); } };
    const params = { message: { role: 'user', messageId: 'm1', taskId: process.argv[1], parts: [{ kind: 'text', text: 'hello' }] } };
    startTask(1, params, queue);
    setTimeout(() => process.exit(0), 200);`;
  const r = spawnSync(process.execPath, ['-e', prog, forged], { cwd: ROOT, env: { ...process.env, KIMICLAW_TOKEN: TOKEN }, encoding: 'utf8', timeout: 20_000 });
  assert.ok(r.stdout.includes('task crashed task=c1'), `${r.stdout}\n${r.stderr}`);
  assert.ok(r.stdout.includes('error_type=CrashError'), r.stdout);
  assert.ok(!r.stdout.includes('secret-crash-msg'), 'must log error type only, not message');
  assertNoForgery(r.stdout);
  assert.ok(!r.stdout.includes('D'.repeat(129)));
});

test('missing or blank KIMICLAW_TOKEN fails clearly', () => {
  for (const env of [{}, { KIMICLAW_TOKEN: '   ' }]) {
    const r = boot(env);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes('KIMICLAW_TOKEN not set'), r.stderr);
  }
});

test('OTLP endpoint replaces files and warns on plaintext', async (t) => {
  const gw = await gateway(t, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel.invalid:4318' });
  assert.equal((await fetch(gw.base + '/healthz')).status, 200);
  await sleep(200);
  assert.ok(gw.out().includes('telemetry is sent unencrypted'));
  assert.equal(fs.existsSync(gw.tel) && fs.readdirSync(gw.tel).length > 0, false);
});

test('HEAD matches the Python app: 200 on docs routes, 405 elsewhere', async (t) => {
  const gw = await gateway(t);
  for (const p of ['/docs', '/redoc', '/openapi.json']) {
    const r = await gw.fetch(p, { method: 'HEAD' });
    assert.equal(r.status, 200, `HEAD ${p}`);
    assert.equal((await r.text()).length, 0, `HEAD ${p} body`);
    const u = await fetch(gw.base + p, { method: 'HEAD' });
    assert.equal(u.status, 401, `unauthorized HEAD ${p}`);
  }
  for (const p of ['/healthz', '/.well-known/agent.json', '/readyz', '/']) {
    const r = await gw.fetch(p, { method: 'HEAD' });
    assert.equal(r.status, 405, `HEAD ${p}`);
  }
  const r = await gw.fetch('/healthz', { method: 'HEAD' });
  assert.equal(r.headers.get('allow'), 'GET');
  assert.equal((await gw.fetch('/', { method: 'HEAD' })).headers.get('allow'), 'GET, POST');
});

test('telemetry setup() is idempotent', async () => {
  const { execFileSync } = await import('node:child_process');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tel-'));
  const code = `
    const t = require(${JSON.stringify(path.join(ROOT, 'dist/telemetry.js'))});
    const api = require('@opentelemetry/api');
    const a = t.setup(); const tp = api.trace.getTracerProvider();
    const b = t.setup(); const tp2 = api.trace.getTracerProvider();
    console.log(JSON.stringify({ a, b, same: tp === tp2 }));
    t.shutdown().then(() => process.exit(0));`;
  const out = execFileSync(process.execPath, ['-e', code], {
    cwd: ROOT, env: { ...process.env, GATEWAY_TELEMETRY_DIR: dir, OTEL_EXPORTER_OTLP_ENDPOINT: '', KIMICLAW_TOKEN: 'x' }, encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(out.trim().split('\n').pop()), { a: true, b: false, same: true });
  fs.rmSync(dir, { recursive: true, force: true });
});
