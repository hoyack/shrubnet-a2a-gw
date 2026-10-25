# shrubnet-a2a-gw

NestJS twin of [kimiclaw-a2a-gateway](https://github.com/hoyack/kimiclaw-a2a-gateway): an A2A protocol (v1.0 subset)
gateway in front of the local OpenClaw agent. Same wire behaviour as the Python app, checked by replaying its golden
fixtures (26 cases, notify bodies byte for byte).

## Setup

```bash
npm ci && npm run build
export KIMICLAW_TOKEN=...      # or put KIMICLAW_TOKEN=... in .env (chmod 600, gitignored)
node dist/main.js              # listens on HOST:PORT, default 127.0.0.1:8000
```
`openclaw` must be on PATH. The app refuses to start without `KIMICLAW_TOKEN` ("KIMICLAW_TOKEN not set").

Docker: `docker build -t shrubnet-a2a-gw . && docker run -e KIMICLAW_TOKEN -p 8000:8000 shrubnet-a2a-gw`
(the image does not contain openclaw; add it in a derived image or mount it).

## Layout

```
src/main.ts              entrypoint: config check, telemetry, Nest app, middleware order
src/config.ts            env settings + .env fallback for the token
src/http.ts              bearer auth (constant-time) and FastAPI-style 404/405, JSON responses
src/telemetry.ts         OpenTelemetry: daily JSONL files or OTLP; request middleware (rpc span + http_request event)
src/a2a.controller.ts    GET /, agent card, POST / JSON-RPC dispatch + SSE
src/health.controller.ts /healthz, /readyz, /openapi.json, /docs, /redoc
src/task-store.ts        in-memory tasks, execution, concurrency limit (3)
src/agent-runner.ts      openclaw subprocess + reply parsing
src/notifier.ts          outbound webhook, auth modes, circuit breaker
src/py.ts                the few Python semantics the wire depends on (json.dumps format, isoformat, truthiness)
openapi.yaml             frozen API contract, identical to the Python repo's
test/                    behaviour tests; golden/ = fixtures copied from the Python repo + Node replay
```

Nest is used for routing only. Handlers write responses themselves (compact JSON, `content-type: application/json`)
so bytes match FastAPI. The body is parsed by the RPC handler, not a body parser, so parse errors keep the same codes.
## Endpoints

| Method | Path | Auth | |
|---|---|---|---|
| GET | `/.well-known/agent.json` | public | agent card |
| GET | `/` | bearer | service info |
| POST | `/` | bearer | JSON-RPC: `message/send`, `message/stream`, `tasks/get`, `tasks/cancel` |
| GET | `/healthz` | public | liveness, returns only `{"status":"ok"}` (no version/config) |
| GET | `/readyz` | bearer | 200 if `openclaw` is on PATH, else 503 |

| GET | `/docs`, `/redoc`, `/openapi.json` | bearer | Swagger UI, ReDoc and spec |

> **`/readyz` returning 503 is by design, not an outage**, when OpenClaw isn't installed (e.g. the stock Docker
> image, CI). Use `/healthz` for liveness; `/readyz` only means "can run agent turns". The Docker HEALTHCHECK uses `/healthz`.

`message/send` is blocking by default. Through Cloudflare it is capped at ~120 s; for longer turns use
`?wait=false` (or `params.configuration.blocking=false`) and poll `tasks/get`, or use `message/stream` (SSE, 15 s keepalives).
A2A `contextId` maps to OpenClaw session `a2a-<ctx>`; reuse it to continue a conversation.

### Example
```bash
curl -s https://kimiclaw.hoyack.ai/ -H "Authorization: Bearer $KIMICLAW_TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"1","method":"message/send","params":{"message":{"role":"user","messageId":"m1","parts":[{"kind":"text","text":"Summarize the systemd journal for yesterday"}]}}}'
```

## Environment variables (names only)

See `.env.example` for a placeholder template. For the n8n A2A_Firewall webhook set `GATEWAY_NOTIFY_AUTH_MODE=basic`
(the default `raw` will be rejected by that webhook's Basic auth).


| Name | Default | Purpose |
|---|---|---|
| `KIMICLAW_TOKEN` | required (env or `.env`) | inbound bearer token; also the outbound notify credential |
| `GATEWAY_NOTIFY_URL` | empty (disabled) | task-event webhook (n8n AI firewall) |
| `GATEWAY_NOTIFY_AUTH_MODE` | `raw` | `raw` (token), `bearer`, or `basic` (user:token). **Must be `basic` for the n8n A2A_Firewall webhook** |
| `GATEWAY_NOTIFY_AUTH_USER` | `agent` | user for `basic` |
| `GATEWAY_NOTIFY_EVENTS` | `task_completed,task_failed` | `task_started` also allowed |
| `GATEWAY_NOTIFY_FAIL_LIMIT` | `5` | consecutive failures before circuit breaker opens |
| `GATEWAY_NOTIFY_COOLDOWN_S` | `900` | breaker pause |
| `GATEWAY_LOG_PAYLOADS` | `0` | `1` logs inbound message text (first 2000 chars) to stdout; otherwise only task id and length |
| `GATEWAY_TELEMETRY_DIR` | `telemetry` | where trace/metric/log files go |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | when set (e.g. `https://otel.example.com:4318`), traces, metrics and logs go via OTLP/HTTP **instead of** the files. Standard `OTEL_*` vars apply. `http://` to a non-localhost host logs a plaintext warning |
| `OTEL_SERVICE_NAME` | `kimiclaw-a2a-gateway` | |

## Telemetry

Daily-rotated files (7 days kept; replaced by OTLP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set) in `GATEWAY_TELEMETRY_DIR`: `traces.jsonl` (spans `rpc`, `agent.run`, `notify`),
`metrics.jsonl` (`gateway.requests`, `gateway.request.duration`, `gateway.agent.duration`, `gateway.notify.failures`,
`gateway.notify.breaker_opens`; flushed every 60 s and on shutdown), `logs.jsonl` (one JSON line per request and per
finished task: IDs, method, status, timing; never message or reply text). Stdout carries one JSON log line per message (`{ts, level, logger, msg}`), with the same `msg` text as the Python app.

## Notify webhook

Disabled unless `GATEWAY_NOTIFY_URL` is set. On the configured events the gateway POSTs
`{event, source:"kimiclaw-a2a-gateway", taskId, contextId, timestamp, state?, reply? (first 4000 chars), durationMs?}`
with `Content-Type: application/json` and an `Authorization` header per `GATEWAY_NOTIFY_AUTH_MODE` (10 s timeout).
Circuit breaker: after `GATEWAY_NOTIFY_FAIL_LIMIT` consecutive failures, webhooks pause for `GATEWAY_NOTIFY_COOLDOWN_S`.

Hard rule for the receiving flow: never call back into the gateway for `task_*` events. A single unfiltered round trip
fans out exponentially. The n8n side MUST filter on `event`.

## Known issues (kept on purpose; changing them changes the wire behavior)

- **HTTP 200 on JSON-RPC errors.** -32602 (bad role, empty, >200k chars), -32601, -32001 and -32000 return HTTP 200; only parse errors return 400. A non-object JSON body returns a plain 500.
- **Inline n8n call.** The notify POST is awaited inside the task (not fire-and-forget). The blocking `message/send` response is released first, but a slow webhook holds the task for up to 10 s.
- **Cancel then completed.** `tasks/cancel` marks the task canceled but does not stop openclaw; when the run finishes it overwrites the state with `completed` or `failed`.
- **Shared token.** `KIMICLAW_TOKEN` is both the inbound bearer token and the outbound webhook credential. Rotating it means updating the n8n side too.

## Differences from the Python app

Nothing a client or the n8n flow sees in normal use. Edge cases that differ:

- Outbound `User-Agent` is `kimiclaw-a2a-gateway-node` (Python sends `Python-urllib/3.x`). This repo's Node golden replay ignores it.
  Running the Python repo's unmodified `golden.py` against this server fails only on that header (its `KEEP_HDR` keeps
  `user-agent`): 13 passed / 11 failed on default, 0 / 2 on n8n_basic. With `user-agent` ignored, all 26 pass.
- Integer env settings (`config.ts` `int()`) are stricter than Python's `int()`: `_` digit separators (`1_000`) and
  non-ASCII digits are rejected here but accepted by Python. Surrounding whitespace is accepted by both.
- Stdout log lines are JSON rather than Python's logging format; the message text is the same.
- Inputs JavaScript JSON can't represent the same way: `NaN`/`Infinity` (Python accepts, here a parse error),
  integers above 2^53 (lose precision), `1.0` (echoed as `1`), and objects with integer-like keys (reordered).
- `/healthz/` (trailing slash) with a valid token returns 404 here; Starlette redirects with 307.
- Logging follows the hardening in kimiclaw-a2a-gateway at head 6889e48 (secret-free failure logs).
- `/docs/oauth2-redirect` is not served.

## Tests

See TUGBOAT.md. `./check.sh` runs the build, behaviour tests and the golden replay.
