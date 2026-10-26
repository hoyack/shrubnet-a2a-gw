/** In-memory task store and task execution. Mirrors gateway/services/task_store.py, quirks included:
 * notify is awaited inline, and a cancel can be overwritten by the agent finishing later. */
import { randomUUID } from 'crypto';
import { AGENT_CONCURRENCY, MAX_TEXT, TASK_TTL_MS } from './config';
import { LOG } from './log';
import { runAgent } from './agent-runner';
import { notify } from './notifier';
import { get, hashable, now, or, pyDumps, pyStr } from './py';
import { event } from './telemetry';

export type Json = any;

/** asyncio.Event */
export class Done {
  isSet = false;
  private resolve!: () => void;
  readonly wait = new Promise<void>((r) => (this.resolve = r));
  set() { this.isSet = true; this.resolve(); }
}

const TIMEOUT = Symbol('timeout');
/** Unbounded asyncio.Queue with a per-get timeout. */
export class Queue<T> {
  private items: T[] = [];
  private waiters: ((v: T) => void)[] = [];
  put(v: T) { const w = this.waiters.shift(); if (w) w(v); else this.items.push(v); }
  get(timeoutMs: number): Promise<T | typeof TIMEOUT> {
    if (this.items.length) return Promise.resolve(this.items.shift()!);
    return new Promise((resolve) => {
      const w = (v: T) => { clearTimeout(t); resolve(v); };
      const t = setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); resolve(TIMEOUT); }, timeoutMs);
      this.waiters.push(w);
    });
  }
  static readonly TIMEOUT = TIMEOUT;
}

interface Entry { task: Json; created: number; expires: number; done: Done }
export const tasks = new Map<unknown, Entry>();

/** asyncio.Semaphore(AGENT_CONCURRENCY): at most 3 openclaw subprocesses at once. */
let running = 0;
const waiting: (() => void)[] = [];
async function withAgentSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= AGENT_CONCURRENCY) await new Promise<void>((r) => waiting.push(r));
  else running += 1;
  try { return await fn(); } finally {
    const next = waiting.shift();
    if (next) next(); else running -= 1;
  }
}

export function rpcError(reqId: Json, code: number, message: string, data?: Json) {
  const err: Json = { code, message };
  if (data !== undefined && data !== null) err.data = data;
  return { jsonrpc: '2.0', id: reqId ?? null, error: err };
}

const makeAgentMessage = (text: string) => ({ role: 'agent', parts: [{ kind: 'text', text }], messageId: randomUUID() });

/** Python str.strip() whitespace set. */
const strip = (s: string) => s.replace(/^[\s\x1c-\x1f\x85]+|[\s\x1c-\x1f\x85]+$/g, '');

export function extractText(msg: Json): string {
  const out: string[] = [];
  const parts = or(get(msg, 'parts'), []);
  for (const p of parts) {
    const kind = get(p, 'kind');
    if (kind === 'text') {
      const t = 'text' in p ? p.text : '';
      if (typeof t !== 'string') throw new TypeError('sequence item: expected str instance');
      out.push(t);
    } else if (kind === 'data') out.push(pyDumps(p.data));
    else if (kind === 'file') {
      const file = or(get(p, 'file'), {});
      const name = get(file, 'name');
      out.push(`[file: ${name === undefined ? '?' : pyStr(name)}]`);
    }
  }
  return strip(out.join('\n'));
}

const codePoints = (s: string) => { let n = 0; for (const _ of s) n++; return n; };

function pruneTasks() {
  const t = Date.now();
  for (const [k, v] of tasks) if (v.expires < t) tasks.delete(k);
}

async function executeTask(taskId: Json, ctxId: Json, text: string, queue: Queue<Json> | null) {
  const session = 'a2a-' + String(ctxId).replace(/[^A-Za-z0-9-]/gu, '-').slice(0, 64);
  const emit = (ev: Json) => queue?.put(ev);
  const entry = tasks.get(taskId)!;
  const task = entry.task;
  const started = Date.now();

  await notify('task_started', taskId, ctxId);
  emit({ kind: 'status-update', taskId, contextId: ctxId, final: false, status: { state: 'working', timestamp: now() } });

  let reply: string;
  let state: 'completed' | 'failed';
  await withAgentSlot(async () => {
    try {
      reply = await runAgent(session, text);
      state = 'completed';
    } catch (e) {
      LOG.error(`agent run failed task=${taskId} error_type=${e.name}`);
      reply = `agent error: ${e.message}`;
      state = 'failed';
    }
  });

  const status = { state, message: makeAgentMessage(reply), timestamp: now() };
  task.status = status;
  task.final = true;
  (task.history ??= []).push(status.message);
  if (state === 'completed') {
    const artifact = { artifactId: randomUUID(), name: 'reply', index: 0, parts: [{ kind: 'text', text: reply }] };
    task.artifacts = [artifact];
    emit({ kind: 'artifact-update', taskId, contextId: ctxId, final: false, artifact });
  }
  emit({ kind: 'status-update', taskId, contextId: ctxId, final: true, status });
  queue?.put(null);
  entry.done.set();
  event('task_finished', { task_id: taskId, context_id: ctxId, state, duration_ms: Date.now() - started });
  await notify(`task_${state}`, taskId, ctxId, {
    state,
    reply: [...reply].slice(0, 4000).join(''),
    durationMs: Date.now() - started,
  });
}

/** Validates params.message and starts the task in the background. Returns a JSON-RPC error or the ids. */
export function startTask(reqId: Json, params: Json, queue: Queue<Json> | null): { error: Json } | { taskId: Json; contextId: Json } {
  const msg = or(get(params, 'message'), {});
  const role = get(msg, 'role');
  if (role !== undefined && role !== null && role !== 'user') return rpcError(reqId, -32602, 'only user-role messages accepted');
  const text = extractText(msg);
  if (!text) return rpcError(reqId, -32602, 'empty message');
  if (text.length > MAX_TEXT && codePoints(text) > MAX_TEXT) return rpcError(reqId, -32602, 'message too large');

  const taskId = hashable(or(get(msg, 'taskId'), randomUUID()));
  const ctxId = or(get(msg, 'contextId'), randomUUID());

  // F26: never log message bodies; ids and length only.
  const messageId = get(msg, 'messageId');
  if (messageId) {
    LOG.info(`inbound task_id=${taskId} message_id=${messageId} len=${codePoints(text)}`);
  } else {
    LOG.info(`inbound task_id=${taskId} len=${codePoints(text)}`);
  }

  pruneTasks();
  tasks.set(taskId, {
    task: {
      id: taskId, contextId: ctxId, kind: 'task',
      status: { state: 'submitted', timestamp: now() },
      artifacts: [], history: [], final: false,
    },
    created: Date.now(),
    expires: Date.now() + TASK_TTL_MS,
    done: new Done(),
  });
  executeTask(taskId, ctxId, text, queue).catch((e) => LOG.error(`task crashed task=${taskId} error_type=${e.name}`));
  return { taskId, contextId: ctxId };
}

