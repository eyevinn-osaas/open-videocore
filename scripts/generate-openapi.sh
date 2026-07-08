#!/usr/bin/env bash
# Generate openapi.json from the live Fastify swagger endpoint.
# Starts the server on an ephemeral port, fetches /api-docs/json, writes the file, then stops.
set -euo pipefail

PORT=3999
OUT="${1:-openapi.json}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

echo "Starting server on port $PORT..."
PORT=$PORT node --env-file-if-exists="$ROOT/.env" \
  --import tsx/esm \
  "$ROOT/src/main.ts" &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

# Wait up to 30s for the server to be ready
for i in $(seq 1 30); do
  if curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1; then
  echo "Server did not start within 30s" >&2
  exit 1
fi

echo "Fetching OpenAPI spec..."
curl -sf "http://localhost:$PORT/api-docs/json" | python3 -m json.tool --indent 2 > "$ROOT/$OUT"
echo "Written to $ROOT/$OUT"
