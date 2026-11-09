#!/usr/bin/env bash
# Upgrades in place: encrypted backup, migrations, a health-based rolling restart, then a readiness check. Stops at the first failure.
# Run it from the new version's folder. See docs/upgrades.md.
#
# Needs BACKUP_PASSPHRASE, DATABASE_ADMIN_URL unless PG_DUMP_COMMAND is set, and the app's own settings for the migration.
# Optional:
#   PG_DUMP_COMMAND, PG_RESTORE_COMMAND  replace pg_dump and pg_restore, for a database with no open port
#   MIGRATE_COMMAND  how to run migrations (default: npm run db:migrate)
#   ROLLING_SERVICES  Compose services to replace one container at a time, such as "web worker" (default: none)
#   COMPOSE_COMMAND  how to call Compose for that (default: docker compose)
#   HEALTH_TIMEOUT   seconds a new container gets to report healthy (default: 120)
#   STOP_TIMEOUT     seconds an old container gets to finish its work (default: 80)
#   RESTART_COMMAND  run after migrating, to move the app to the new version, where there is no Compose (default: none)
#   READY_URL        the app's readiness address (default: http://127.0.0.1:$PLATFORM_PORT/ready)
#   READY_ATTEMPTS, READY_DELAY  how long to wait for it (default: 30 tries, 2 seconds apart)
set -euo pipefail

[ -n "${PG_DUMP_COMMAND:-}" ] || : "${DATABASE_ADMIN_URL:?set DATABASE_ADMIN_URL}"
: "${BACKUP_PASSPHRASE:?set BACKUP_PASSPHRASE}"
here="$(cd "$(dirname "$0")" && pwd)"
migrate="${MIGRATE_COMMAND:-npm run db:migrate}"
ready="${READY_URL:-http://127.0.0.1:${PLATFORM_PORT:-4320}/ready}"
attempts="${READY_ATTEMPTS:-30}"
delay="${READY_DELAY:-2}"
compose="${COMPOSE_COMMAND:-docker compose}"
health_timeout="${HEALTH_TIMEOUT:-120}"
stop_timeout="${STOP_TIMEOUT:-80}"
step="backup"
backup=""
rolling=""

explain_failure() {
  local status=$?
  [ "$status" -eq 0 ] && return
  echo "Upgrade stopped: the $step step failed." >&2
  if [ -n "$rolling" ]; then
    echo "The containers not yet replaced are still serving on the old version, which works on the new schema. Fix the problem and run this again." >&2
  fi
  if [ -z "$backup" ]; then
    echo "The database was not changed." >&2
    return
  fi
  cat >&2 <<HELP
To go back:
  1. Stop the app and put the previous version's code back.
  2. Create an empty database, and make sure the limited app role exists on the server.
  3. BACKUP_PASSPHRASE=<passphrase> RESTORE_DATABASE_URL=<empty database URL> scripts/restore.sh $backup
  4. Point DATABASE_URL and DATABASE_ADMIN_URL at it and start the app.
Keep the SECRETS_MASTER_KEY that was in use when this backup was taken. Without it the backup's secrets cannot be read.
HELP
}
trap explain_failure EXIT

# Waits for a container's health check. A container that fails it never takes traffic or work.
wait_healthy() {
  local container="$1" deadline=$((SECONDS + health_timeout)) state
  while [ "$SECONDS" -lt "$deadline" ]; do
    state="$(docker inspect --format '{{.State.Health.Status}}' "$container")"
    [ "$state" = "healthy" ] && return 0
    [ "$state" = "unhealthy" ] && break
    sleep 2
  done
  echo "Container $container did not become healthy: ${state:-unknown}." >&2
  return 1
}

# Adds one new container, waits until it is healthy, then stops one old one, which finishes or hands back its work. The count never drops.
replace_containers() {
  local service="$1" old count id before after new
  old="$($compose ps --quiet "$service")"
  count="$(printf '%s\n' "$old" | grep -c . || true)"
  if [ "$count" -eq 0 ]; then
    echo "$service has no running containers, so it is simply started."
    $compose up -d --no-deps "$service"
    return
  fi
  for id in $old; do
    before="$($compose ps --quiet "$service" | sort)"
    $compose up -d --no-deps --no-recreate --scale "$service=$((count + 1))" "$service"
    after="$($compose ps --quiet "$service" | sort)"
    new="$(comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$after"))"
    if [ -z "$new" ]; then
      echo "No new $service container started." >&2
      return 1
    fi
    if ! wait_healthy "$new"; then
      docker logs --tail 30 "$new" >&2 || true
      docker rm --force "$new" > /dev/null
      return 1
    fi
    echo "$service: $new is healthy. Stopping ${id:0:12}."
    docker stop --time "$stop_timeout" "$id" > /dev/null
    docker rm "$id" > /dev/null
  done
}

echo "Backing up."
written="$("$here/backup.sh")"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$written" | bash -c "${PG_RESTORE_COMMAND:-pg_restore} --list" > /dev/null
backup="$written"
echo "Backup written and readable: $backup"

step="migration"
echo "Running migrations."
bash -c "$migrate"

if [ -n "${ROLLING_SERVICES:-}" ]; then
  step="rolling restart"
  rolling="yes"
  for service in $ROLLING_SERVICES; do
    echo "Replacing $service one container at a time."
    replace_containers "$service"
  done
  rolling=""
fi

if [ -n "${RESTART_COMMAND:-}" ]; then
  step="restart"
  echo "Restarting the app."
  bash -c "$RESTART_COMMAND"
fi

step="readiness"
echo "Checking the app is ready."
for ((try = 1; try <= attempts; try += 1)); do
  if curl --silent --fail --output /dev/null --max-time 5 "$ready"; then
    echo "Upgrade finished."
    [ -n "${RESTART_COMMAND:-}${ROLLING_SERVICES:-}" ] || echo "The app was not restarted, so it is still the old version on the new schema. Restart it to finish."
    exit 0
  fi
  sleep "$delay"
done
echo "The app did not report ready." >&2
exit 1
