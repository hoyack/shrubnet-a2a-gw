#!/usr/bin/env bash
# Full local/CI check: build, behaviour tests (node:test), golden replay against fixtures recorded from the Python app.
set -euo pipefail
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "check.sh: node not found (need Node 20+)" >&2; exit 2; }
[ -d node_modules ] || npm ci --silent
rc=0
npx tsc -p . || exit 1
node --test --test-concurrency=4 --test-reporter=dot test/gateway.test.mjs 2>&1 | tail -12 || rc=1
out=$(node test/golden/golden.mjs 2>/dev/null) || rc=1
echo "$out" | grep -E "FAIL|passed" || true
exit $rc
