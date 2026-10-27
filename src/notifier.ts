/** Outbound task-event webhook (n8n AI firewall). The body is byte-identical to the Python gateway's
 * (json.dumps default separators, same key order); headers are the same set apart from User-Agent. */
import * as http from 'http';
import * as https from 'https';
import { LOG, logSafe } from './log';
import { NOTIFY_AUTH_MODE, NOTIFY_AUTH_USER, NOTIFY_COOLDOWN_S, NOTIFY_EVENTS, NOTIFY_FAIL_LIMIT, NOTIFY_TIMEOUT_MS, NOTIFY_URL, TOKEN } from './config';
import { now, pyDumps } from './py';
import { metric, tracer } from './telemetry';

let fails = 0;
let disabledUntil = 0;

function authorization(): string {
  if (NOTIFY_AUTH_MODE === 'basic') return 'Basic ' + Buffer.from(`${NOTIFY_AUTH_USER}:${TOKEN}`).toString('base64');
  if (NOTIFY_AUTH_MODE === 'bearer') return `Bearer ${TOKEN}`;
  return TOKEN;
}

class HTTPError extends Error { name = 'HTTPError'; }

function postJson(url: string, body: string): Promise<number> {
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(u, {
      method: 'POST',
      agent: false, // "Connection: close", like urllib
      headers: {
        'Accept-Encoding': 'identity',
        'Content-Type': 'application/json',
        Authorization: authorization(),
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'kimiclaw-a2a-gateway-node',
      },
      timeout: NOTIFY_TIMEOUT_MS,
    }, (res) => {
      res.resume();
      res.on('end', () => (res.statusCode >= 400 ? reject(new HTTPError(`HTTP Error ${res.statusCode}`)) : resolve(res.statusCode)));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { name: 'TimeoutError' })));
    req.on('error', (e) => reject(e.name === 'Error' ? Object.assign(e, { name: 'URLError' }) : e));
    req.end(body);
  });
}

export async function notify(event: string, taskId: string, ctxId: string, extra?: Record<string, unknown>) {
  if (!NOTIFY_URL || !NOTIFY_EVENTS.has(event)) return;
  if (Date.now() < disabledUntil) return;
  const payload = { event, source: 'kimiclaw-a2a-gateway', taskId, contextId: ctxId, timestamp: now(), ...(extra || {}) };
  const span = tracer().startSpan('notify', { attributes: { 'notify.event': event, 'task.id': taskId } });
  try {
    const status = await postJson(NOTIFY_URL, pyDumps(payload));
    span.setAttribute('http.response.status_code', status);
    fails = 0;
    LOG.info(`notify ${event} task=${logSafe(taskId)} -> ${status}`);
  } catch (e) {
    fails += 1;
    metric().notifyFailures.add(1, { 'notify.event': event });
    span.setAttribute('error', true);
    let host = 'None';
    try { host = new URL(NOTIFY_URL).hostname || 'None'; } catch { /* keep None */ }
    LOG.warning(`notify ${event} task=${logSafe(taskId)} failed (${fails}/${NOTIFY_FAIL_LIMIT}) host=${host} error_type=${e.name}`);
    if (fails >= NOTIFY_FAIL_LIMIT) {
      disabledUntil = Date.now() + NOTIFY_COOLDOWN_S * 1000;
      fails = 0;
      metric().breakerOpens.add(1);
      LOG.error(`notify circuit breaker OPEN: outbound webhooks paused ${NOTIFY_COOLDOWN_S}s`);
    }
  } finally {
    span.end();
  }
}
