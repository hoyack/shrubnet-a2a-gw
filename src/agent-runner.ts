/** Runs one OpenClaw turn as a CLI subprocess and extracts the reply. */
import { spawn } from 'child_process';
import { SpanStatusCode } from '@opentelemetry/api';
import { AGENT_TIMEOUT } from './config';
import { LOG } from './log';
import { isDict } from './py';
import { metric, tracer } from './telemetry';

/** Error types carry Python's names so logs and spans read the same in both gateways. */
class PyError extends Error {
  constructor(name: string, message: string) { super(message); this.name = name; }
}

/** Find the last parseable top-level JSON object in a noisy stream. */
function lastJsonBlock(raw: string): unknown {
  let idx = raw.lastIndexOf('\n{');
  while (idx !== -1) {
    try { return JSON.parse(raw.slice(idx + 1)); } catch { /* keep looking */ }
    idx = idx === 0 ? -1 : raw.lastIndexOf('\n{', idx - 1);
  }
  try { return JSON.parse(raw); } catch { return undefined; }
}

/** Best-effort extraction of reply text from `openclaw --json` output. */
export function parseAgentReply(raw: string): string {
  raw = raw.trim();
  const obj = lastJsonBlock(raw);
  if (obj === undefined) return raw;
  if (isDict(obj)) {
    const payloads = Array.isArray(obj.payloads) ? obj.payloads : [];
    const texts = payloads.filter((p) => isDict(p) && typeof p.text === 'string' && p.text).map((p) => p.text);
    if (texts.length) return texts.join('\n');
    for (const key of ['reply', 'text', 'result', 'message', 'output', 'response']) {
      const v = obj[key];
      if (typeof v === 'string' && v.trim()) return v;
    }
  }
  return raw;
}

export async function runAgent(sessionId: string, text: string): Promise<string> {
  const started = performance.now();
  // No recordException: agent stderr can echo message text, and telemetry must never carry it.
  return tracer().startActiveSpan('agent.run', { attributes: { 'session.id': sessionId } }, async (span) => {
    try {
      return await run(sessionId, text);
    } catch (e) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: e.name });
      span.setAttribute('error.type', e.name);
      throw e;
    } finally {
      metric().agentMs.record(performance.now() - started);
      span.end();
    }
  });
}

function run(sessionId: string, text: string): Promise<string> {
  const args = ['agent', '--local', '--session-id', sessionId, '--message', text, '--json', '--timeout', String(AGENT_TIMEOUT)];
  LOG.info(`agent run start session=${sessionId} len=${[...text].length}`);
  return new Promise((resolve, reject) => {
    const proc = spawn('openclaw', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, (AGENT_TIMEOUT + 30) * 1000);
    proc.stdout.on('data', (b) => out.push(b));
    proc.stderr.on('data', (b) => err.push(b));
    proc.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT'
        ? new PyError('FileNotFoundError', "[Errno 2] No such file or directory: 'openclaw'")
        : new PyError('OSError', e.message));
    });
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return reject(new PyError('RuntimeError', 'agent timeout'));
      const rawErrFull = Buffer.concat(err).toString('utf8');
      const returncode = code ?? -(require('os').constants.signals[signal] ?? 1);
      if (returncode !== 0) {
        const tail = [...rawErrFull].slice(-500).join('');
        return reject(new PyError('RuntimeError', `agent exited ${returncode}: ${tail}`));
      }
      // openclaw --json emits the result envelope on stderr after log noise
      const rawOut = Buffer.concat(out).toString('utf8').trim();
      const rawErr = rawErrFull.trim();
      let reply: string | null = rawOut ? parseAgentReply(rawOut) : null;
      if (!reply || (reply === rawOut && rawErr)) {
        const parsed = parseAgentReply(rawErr);
        if (parsed !== rawErr || !reply) reply = parsed;
      }
      reply = reply || '';
      LOG.info(`agent run done session=${sessionId} reply_len=${[...reply].length}`);
      resolve(reply);
    });
  });
}
