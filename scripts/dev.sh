#!/usr/bin/env bash
# Runs the platform on port 4320 using the settings in .env.
set -euo pipefail
cd "$(dirname "$0")/.."

npx tsx src/platform/migrate.ts
npx vite build web --logLevel warn
npx tsx src/platform/worker.ts &
worker=$!
trap 'kill "$worker" 2>/dev/null || true' EXIT
npx tsx src/platform/server.ts
