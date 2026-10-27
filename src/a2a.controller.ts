/** A2A routes: GET /, the public agent card, and the JSON-RPC 2.0 dispatcher on POST /. */
import { Controller, Get, Post, Req, Res } from '@nestjs/common';
import { AGENT_TIMEOUT } from './config';
import { sendJson } from './http';
import { LOG, logSafe } from './log';
import { get, hashable, now, or, pyDumps, pyStr, truthy } from './py';
import { Json, Queue, rpcError, startTask, tasks } from './task-store';

export const AGENT_CARD = {
  protocolVersion: '1.0',
  name: 'Kimiclaw',
  description: 'A2A gateway into the OpenClaw agent (kimi-claw). Research, code, ops, writing, automation.',
  url: 'https://kimiclaw.hoyack.ai/',
  provider: { organization: 'hoyack' },
  version: '0.1.0',
  capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: false },
  securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
  security: [{ bearerAuth: [] }],
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  skills: [{
    id: 'general-agent',
    name: 'General agent',
    description: 'General-purpose agent: research, coding, shell ops, writing, planning, automation.',
    tags: ['general-purpose', 'agent', 'openclaw'],
  }],
  supportsAuthenticatedExtendedCard: false,
};

const ok = (reqId: Json, result: Json) => ({ jsonrpc: '2.0', id: reqId ?? null, result });

function readBody(req: any): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** SSE events; a keepalive comment every 15 s so proxies don't cut idle streams. */
export async function sseEvents(reqId: Json, queue: Queue<Json>, res: any) {
  let closed = false;
  res.on('close', () => { closed = true; queue.put(null); });
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
  try {
    while (!closed) {
      const ev = await queue.get(15_000);
      if (ev === Queue.TIMEOUT) { res.write(': keepalive\n\n'); continue; }
      if (ev === null) break;
      res.write(`data: ${pyDumps({ jsonrpc: '2.0', id: reqId ?? null, result: ev })}\n\n`);
      if (truthy(ev.final)) break;
    }
  } catch (e) {
    LOG.error(`sse error req_id=${logSafe(reqId)} error_type=${e.name}`);
    res.write(`data: ${pyDumps(rpcError(reqId, -32000, `stream error: ${e.message}`))}\n\n`);
  }
  res.end();
}

@Controller()
export class A2aController {
  @Get('/')
  root(@Res() res: any) {
    sendJson(res, 200, {
      service: 'kimiclaw-a2a-gateway',
      protocol: 'A2A 1.0',
      agent_card: '/.well-known/agent.json',
      rpc: 'POST / (JSON-RPC 2.0)',
    });
  }

  @Get('.well-known/agent.json')
  agentCard(@Res() res: any) {
    sendJson(res, 200, AGENT_CARD);
  }

  @Post('/')
  async rpc(@Req() req: any, @Res() res: any) {
    let body: Json;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, rpcError(null, -32700, 'parse error'));
    }
    try {
      await this.dispatch(body, req, res);
    } catch (e) {
      // Same outcome as an unhandled exception in FastAPI (e.g. a non-object body): plain-text 500.
      LOG.error(`rpc error error_type=${e.name}`);
      if (!res.headersSent) {
        res.status(500).setHeader('content-type', 'text/plain; charset=utf-8');
        res.end('Internal Server Error');
      } else res.end();
    }
  }

  private async dispatch(body: Json, req: any, res: any) {
    const method = get(body, 'method');
    const reqId = get(body, 'id');
    const params = or(get(body, 'params'), {});
    res.locals.ids = { rpc_method: method ?? null, rpc_id: reqId ?? null };

    if (method === 'message/send') {
      const started = startTask(reqId, params, null);
      if ('error' in started) return sendJson(res, 200, started);
      const { taskId } = started;
      Object.assign(res.locals.ids, { task_id: taskId, context_id: started.contextId });
      // Non-blocking: ?wait=false or params.configuration.blocking=false returns the task immediately
      // (client then polls tasks/get or uses the notify webhook; avoids the Cloudflare ~120 s proxy timeout).
      const cfg = or(get(params, 'configuration'), {});
      const q = req.query.wait;
      let wait = String((Array.isArray(q) ? q[q.length - 1] : q) ?? 'true').toLowerCase() !== 'false';
      if (get(cfg, 'blocking') === false) wait = false;
      if (!wait) return sendJson(res, 200, ok(reqId, tasks.get(taskId)!.task));
      let timer: NodeJS.Timeout;
      const timedOut = await Promise.race([
        tasks.get(taskId)!.done.wait.then(() => false),
        new Promise<boolean>((r) => (timer = setTimeout(() => r(true), (AGENT_TIMEOUT + 60) * 1000))),
      ]);
      clearTimeout(timer);
      if (timedOut) return sendJson(res, 200, rpcError(reqId, -32000, 'gateway timeout'));
      return sendJson(res, 200, ok(reqId, tasks.get(taskId)!.task));
    }

    if (method === 'message/stream') {
      const queue = new Queue<Json>();
      const started = startTask(reqId, params, queue);
      if ('error' in started) return sendJson(res, 200, started);
      return sseEvents(reqId, queue, res);
    }

    if (method === 'tasks/get' || method === 'tasks/cancel') {
      const entry = tasks.get(hashable(or(get(params, 'id'), get(params, 'taskId'))));
      if (!entry) return sendJson(res, 200, rpcError(reqId, -32001, 'task not found'));
      const task = entry.task;
      if (method === 'tasks/cancel' && !truthy(task.final)) {
        task.status = { state: 'canceled', timestamp: now() };
        task.final = true;
        entry.done.set();
      }
      return sendJson(res, 200, ok(reqId, task));
    }

    return sendJson(res, 200, rpcError(reqId, -32601, `method not found: ${pyStr(method)}`));
  }
}
