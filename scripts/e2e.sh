#!/usr/bin/env bash
# Runs the whole platform against a throwaway database, for browser testing.
# Real accounts in the development database are untouched.
set -euo pipefail
cd "$(dirname "$0")/.."

dropdb --if-exists --force agent_platform_e2e
createdb agent_platform_e2e

export DATABASE_ADMIN_URL=postgres:///agent_platform_e2e
export DATABASE_URL=postgres://agent_platform_e2e_app:e2e-only@localhost/agent_platform_e2e
export BOOTSTRAP_ADMIN_EMAIL=e2e-owner@example.test
export PUBLIC_URL=http://127.0.0.1:4330
export PLATFORM_PORT=4330
export AUDIT_LOG=off
export SMTP_URL= MAIL_FROM=
export ALLOWED_PRIVATE_HOSTS=127.0.0.1,localhost

npx tsx src/platform/migrate.ts
npx vite build web --logLevel warn
npx tsx src/platform/worker.ts &
worker=$!
trap 'kill "$worker" 2>/dev/null || true' EXIT
npx tsx src/platform/server.ts
