#!/usr/bin/env bash
# Runs in its own container beside the database. Starts the backups, and records when each last worked for monitoring.
# A failed job is logged and tried again the next time it is due: the alerts in deploy/monitoring say when something has gone too long.
set -uo pipefail

scripts=/opt/hivelock/scripts
# shellcheck source=scripts/pg-url.sh
. "$scripts/pg-url.sh"
mkdir -p /tmp/pgbackrest

say() { printf '{"level":"%s","event":"%s","at":"%s"}\n' "$1" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"; }

record() {
  local kind="$1" at="$2"
  write_status "backup-$kind.prom" "$(cat <<METRIC
# TYPE agent_platform_backup_last_success_timestamp_seconds gauge
agent_platform_backup_last_success_timestamp_seconds{kind="$kind"} $at
METRIC
)"
}

base_backup() {
  local type="diff"
  [ "$(date -u +%u)" = "7" ] && type="full"
  # With no full backup yet, pgBackRest takes one.
  if pgbackrest --type="$type" backup; then record pgbackrest "$(date +%s)"; say info base_backup_finished; else say error base_backup_failed; fi
}

dump() {
  if "$scripts/backup.sh" > /dev/null; then say info dump_finished; else say error dump_failed; fi
}

drills() {
  local source
  for source in pgbackrest dump; do
    if DRILL_SOURCE="$source" "$scripts/restore-drill.sh"; then say info drill_passed; else say error drill_failed; fi
  done
}

# Monitoring reads WAL progress from Postgres itself, so this holds whichever process did the archiving.
wal_status() {
  local at
  at="$(psql --no-psqlrc --dbname="$DATABASE_ADMIN_URL" --tuples-only --no-align --command "select coalesce(extract(epoch from last_archived_time)::bigint, 0) from pg_stat_archiver" 2> /dev/null)" || return 0
  [ -n "$at" ] && [ "$at" != "0" ] && record wal "$at"
}

until pgbackrest stanza-create; do
  say warn stanza_not_ready
  sleep 30
done
pgbackrest check || say error check_failed
# A new server has nothing to restore from until this finishes, so it does not wait for the schedule.
pgbackrest info --output=json | grep -q '"label"' || base_backup

last_daily=""
last_drill=""
while true; do
  wal_status
  today="$(date -u +%F)"
  hour="$(date -u +%H)"
  if [ "$hour" = "${BACKUP_HOUR:-02}" ] && [ "$last_daily" != "$today" ]; then
    last_daily="$today"
    base_backup
    dump
  fi
  if [ "$hour" = "${DRILL_HOUR:-04}" ] && [ "$(date -u +%u)" = "1" ] && [ "$last_drill" != "$today" ]; then
    last_drill="$today"
    drills
  fi
  sleep 60
done
