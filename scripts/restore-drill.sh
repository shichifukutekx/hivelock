#!/usr/bin/env bash
# Proves the newest backup can be restored: restores it into a throwaway Postgres this script starts and removes, and checks what came back.
# The throwaway server takes no connections except on its own socket, so nothing here can reach a real database.
#
# DRILL_SOURCE    dump (default) reads the newest *.dump.enc in BACKUP_DIR, and needs BACKUP_PASSPHRASE.
#                 pgbackrest restores the newest backup and all archived WAL, and needs the PGBACKREST_ settings. See deploy/backup.
# BACKUP_DIR      where the dumps are (default: backups)
# BACKUP_STATUS_DIR  where to record the result, as restore-drill.json and restore-drill.prom (default: $BACKUP_DIR/status)
# DRILL_USER      for pgbackrest, the superuser in the backup (default: agent_platform_admin)
# DRILL_ALLOW_PENDING=1  reports migrations missing from the backup without failing, for a backup taken before this code's newest migration
# MIGRATION_DIRS  folders of .sql files to compare with (default: the core's, and any package's beside it)
#
# Needs initdb, pg_ctl, psql and pg_restore, of the backup's Postgres version or newer, and the vector extension. Exits non-zero if any check fails.
set -euo pipefail

# Postgres refuses to start on some systems without a valid locale, and this keeps text handling the same everywhere.
export LC_ALL=C

# Debian and Ubuntu keep the server programs out of PATH, under /usr/lib/postgresql/<version>/bin. The newest is used.
if ! command -v initdb > /dev/null 2>&1; then
  for bin in $(ls -d /usr/lib/postgresql/*/bin 2> /dev/null | sort -t/ -k5 -n -r); do
    if [ -x "$bin/initdb" ]; then export PATH="$bin:$PATH"; break; fi
  done
fi

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/pg-url.sh
. "$here/pg-url.sh"
source_kind="${DRILL_SOURCE:-dump}"
directory="${BACKUP_DIR:-backups}"
BACKUP_STATUS_DIR="${BACKUP_STATUS_DIR:-$directory/status}"
migration_dirs="${MIGRATION_DIRS:-$(printf '%s ' "$here"/../src/platform/migrations "$here"/../*/migrations)}"
started="$(date +%s)"
restore_seconds=0
backup_name=""
backup_age=""
problems=""
notes=""
result_rows=""

# Under /tmp, as a socket path has a short length limit.
work="$(mktemp -d "${DRILL_TMP:-/tmp}/hivelock-drill.XXXXXX")"
cluster="$work/data"
port=54397

fail_check() { problems="$problems$1; "; echo "FAILED: $1" >&2; }
ok_check() { echo "ok: $1"; }

json_text() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

finish() {
  local status=$?
  # The folder goes next, so what the server said has to be shown now.
  if [ "$status" -ne 0 ] && [ -f "$work/server.log" ]; then tail -n 20 "$work/server.log" >&2; fi
  if [ -f "$cluster/postmaster.pid" ]; then pg_ctl --pgdata="$cluster" --mode=immediate --wait stop > /dev/null 2>&1 || true; fi
  rm -rf "$work"
  [ "$status" -eq 0 ] || [ -n "$problems" ] || problems="the drill stopped early, with exit code $status"
  local now result total passed
  now="$(date +%s)"
  total=$((now - started))
  if [ -z "$problems" ]; then result="passed"; passed=1; else result="failed"; passed=0; fi
  write_status restore-drill.json "{\"result\":\"$result\",\"source\":\"$source_kind\",\"backup\":\"$(json_text "$backup_name")\",\"backupAgeSeconds\":${backup_age:-null},\"finishedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"totalSeconds\":$total,\"restoreSeconds\":$restore_seconds,\"rows\":{${result_rows%,}},\"problems\":\"$(json_text "$problems")\",\"notes\":\"$(json_text "$notes")\"}"
  local last_success="" previous="$BACKUP_STATUS_DIR/restore-drill.prom"
  if [ "$passed" -eq 1 ]; then last_success="$now"
  elif [ -f "$previous" ]; then last_success="$(sed -n 's/^agent_platform_restore_drill_last_success_timestamp_seconds //p' "$previous")"; fi
  write_status restore-drill.prom "$(cat <<METRIC
# HELP agent_platform_restore_drill_last_result 1 if the last drill passed, 0 if it failed.
# TYPE agent_platform_restore_drill_last_result gauge
agent_platform_restore_drill_last_result $passed
# HELP agent_platform_restore_drill_last_duration_seconds How long the last drill took.
# TYPE agent_platform_restore_drill_last_duration_seconds gauge
agent_platform_restore_drill_last_duration_seconds $total
# HELP agent_platform_restore_drill_last_success_timestamp_seconds When a drill last passed.
# TYPE agent_platform_restore_drill_last_success_timestamp_seconds gauge
agent_platform_restore_drill_last_success_timestamp_seconds ${last_success:-0}
METRIC
)"
  echo "Drill $result in ${total}s. Restore took ${restore_seconds}s."
  [ "$passed" -eq 1 ] || exit 1
}
trap finish EXIT

start_server() {
  pg_ctl --pgdata="$cluster" --wait --timeout="${1:-60}" --log="$work/server.log" \
    --options="-c listen_addresses='' -c unix_socket_directories='$work' -c port=$port -c fsync=off -c archive_mode=off -c max_connections=20" start > /dev/null
}
sql() { psql --host="$work" --port="$port" --username="$user" --dbname="$database" --tuples-only --no-align --quiet --set=ON_ERROR_STOP=1 "$@"; }

age_of() { if stat -f %m "$1" > /dev/null 2>&1; then stat -f %m "$1"; else stat -c %Y "$1"; fi; }

restore_dump() {
  : "${BACKUP_PASSPHRASE:?set BACKUP_PASSPHRASE}"
  local file
  file="$(ls -1t "$directory"/*.dump.enc 2> /dev/null | head -n 1 || true)"
  if [ -z "$file" ]; then
    fail_check "no backup found in $directory"
    exit 1
  fi
  backup_name="$(basename "$file")"
  backup_age=$(($(date +%s) - $(age_of "$file")))
  counts_file="$file.counts"
  user="drill"
  database="hivelock_drill"
  initdb --pgdata="$cluster" --username="$user" --auth=trust --no-sync --encoding=UTF8 --locale=C > /dev/null
  start_server
  createdb --host="$work" --port="$port" --username="$user" "$database"
  # A dump's grants name roles that live outside it, so they are made here first. They never log in.
  # pg_restore stops reading once it has the schema, which closes openssl's pipe. That is not a failure, and a bad file fails in the restore below.
  local role
  (
    set +o pipefail
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$file" 2> /dev/null \
      | pg_restore --schema-only --file=- 2> /dev/null \
      | sed -n 's/^GRANT .* TO \([^;]*\);$/\1/p' | tr -d '"' | sort -u
  ) | while read -r role; do
    sql --command "create role \"$role\"" 2> /dev/null || true
  done
  local before
  before="$(date +%s)"
  RESTORE_DATABASE_URL="postgres://$user@/$database?host=$work&port=$port" "$here/restore.sh" "$file"
  restore_seconds=$(($(date +%s) - before))
}

restore_pgbackrest() {
  local info before
  user="${DRILL_USER:-agent_platform_admin}"
  database="${DRILL_DATABASE:-agent_platform}"
  info="$(pgbackrest info --output=json)"
  backup_name="$(printf '%s' "$info" | sed -n 's/.*"label":"\([^"]*\)".*/\1/p' | tail -n 1)"
  if [ -z "$backup_name" ]; then
    fail_check "pgbackrest holds no backup"
    exit 1
  fi
  mkdir -m 700 "$cluster"
  before="$(date +%s)"
  pgbackrest --pg1-path="$cluster" --archive-mode=off --link-all=n restore
  start_server 1800
  until [ "$(sql --command 'select pg_is_in_recovery()')" = "f" ]; do sleep 1; done
  restore_seconds=$(($(date +%s) - before))
  backup_age="$(sql --command "select coalesce(extract(epoch from now() - max(at))::bigint, 0) from audit_events")"
  notes="${notes}backupAgeSeconds is the age of the newest audit entry recovered, which is the most data this restore would lose. "
}

case "$source_kind" in
  dump) restore_dump ;;
  pgbackrest) restore_pgbackrest ;;
  *) fail_check "DRILL_SOURCE must be dump or pgbackrest"; exit 1 ;;
esac

# Row counts: every counted table reads, and matches what the backup recorded.
for table in $COUNTED_TABLES; do
  rows="$(sql --command "select count(*) from $table")"
  label="$(printf '%s' "$table" | tr -d '"')"
  result_rows="$result_rows\"$label\":$rows,"
  expected="$(awk -v name="$table" '$1 == name { print $2 }' "${counts_file:-/dev/null}" 2> /dev/null || true)"
  [ -n "$expected" ] || continue
  # Rows may arrive during a dump, and old runs may be pruned, so only the append-only log must never shrink. Nothing else may empty.
  if [ "$table" = "audit_events" ] && [ "$rows" -lt "$expected" ]; then fail_check "audit_events has $rows rows, and the backup recorded $expected"
  elif [ "$expected" -gt 0 ] && [ "$rows" -eq 0 ]; then fail_check "$label is empty, and the backup recorded $expected rows"
  else ok_check "$label: $rows rows, $expected recorded"; fi
done

# The audit chain, for every workspace and for the entries that belong to none.
broken="$(sql --command "select coalesce(workspace_id, '(server)') from (select distinct workspace_id from audit_events) w where audit_chain_break(workspace_id) is not null")"
if [ -z "$broken" ]; then ok_check "audit chain intact"; else fail_check "audit chain broken in: $(printf '%s' "$broken" | tr '\n' ' ')"; fi

# Row security must come back with the data, or a restored server would mix workspaces.
if [ "$(sql --command "select count(*) from pg_class where relkind = 'r' and relrowsecurity and relforcerowsecurity")" -gt 0 ]; then ok_check "row security in force"; else fail_check "no table has row security"; fi

# Migrations: each file here is recorded, or is replaced by one that is.
applied="$(sql --command "select name from schema_migrations")"
pending=""
for folder in $migration_dirs; do
  [ -d "$folder" ] || continue
  for path in "$folder"/*.sql; do
    name="$(basename "$path")"
    printf '%s\n' "$applied" | grep -qxF "$name" && continue
    replaced=""
    for old in $(sed -n 's/^-- replaces: \([^ ]*\)$/\1/p' "$path"); do
      if printf '%s\n' "$applied" | grep -qxF "$old"; then replaced="yes"; fi
    done
    [ -n "$replaced" ] || pending="$pending$name "
  done
done
if [ -z "$pending" ]; then ok_check "migrations current"
elif [ "${DRILL_ALLOW_PENDING:-}" = "1" ]; then notes="${notes}Older than this code, which also needs: $pending"; echo "note: migrations not in the backup: $pending"
else fail_check "migrations not in the backup: $pending"; fi
