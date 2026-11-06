# For Tugboat: test commands (CI workflow is yours; none is committed here)

Node 20+. No secrets or network access needed; tests use a fake `openclaw` (test/golden/fakebin, a Node script)
and local mock webhook receivers.

```bash
npm ci
npm test               # build + behaviour tests (test/gateway.test.mjs), ~35 s
npm run golden         # golden replay: expect "[default] 24 passed" and "[n8n_basic] 2 passed"
./check.sh             # everything at once, non-zero exit on failure
```

The golden fixtures in test/golden/cases are copied unchanged from kimiclaw-a2a-gateway (recorded from its original
main). The only thing the replay ignores is the outbound `User-Agent`, which names the implementation.
openapi.yaml is the same frozen file as the Python repo (sha256 pinned in the tests). Do not edit it here; change it
there and copy it over.

Docker smoke: `docker build -t shrubnet-a2a-gw .`; the HEALTHCHECK hits public `/healthz`.

**`/readyz` returns 503 without OpenClaw installed. That is by design, not an outage.** CI and the stock image
have no `openclaw`. Probe `/healthz` for liveness.

- Daily telemetry log rotation assumes a single process; multiple processes would race on rotation.
