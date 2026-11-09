#!/usr/bin/env bash
# Writes an encrypted database backup and keeps the newest 14.
# Needs BACKUP_PASSPHRASE, and DATABASE_ADMIN_URL unless PG_DUMP_COMMAND is set.
# PG_DUMP_COMMAND replaces pg_dump, for a database with no open port. See docs/upgrades.md.
# PSQL_COMMAND does the same for psql. Without it or DATABASE_ADMIN_URL no row counts are kept, and a drill cannot compare them.
# BACKUP_OFFSITE_COMMAND copies the finished backup elsewhere, with the file as $1. It sees only encrypted data. A failed copy fails the backup.
# BACKUP_STATUS_DIR is where to record success, for monitoring.
# Keep the passphrase and SECRETS_MASTER_KEY away from the backups.
set -euo pipefail

[ -n "${PG_DUMP_COMMAND:-}" ] || : "${DATABASE_ADMIN_URL:?set DATABASE_ADMIN_URL}"
: "${BACKUP_PASSPHRASE:?set BACKUP_PASSPHRASE}"
directory="${BACKUP_DIR:-backups}"
keep="${BACKUP_KEEP:-14}"
# shellcheck source=scripts/pg-url.sh
. "$(dirname "$0")/pg-url.sh"
file="$directory/agent-platform-$(date -u +%Y%m%dT%H%M%SZ).dump.enc"

mkdir -p "$directory"
umask 077
dump() {
  if [ -n "${PG_DUMP_COMMAND:-}" ]; then bash -c "$PG_DUMP_COMMAND"; else
    split_password "$DATABASE_ADMIN_URL"
    pg_dump --format=custom --dbname="$safe_url"
  fi
}
count_rows() {
  local sql
  sql="$(counting_sql)"
  if [ -n "${PSQL_COMMAND:-}" ]; then
    printf '%s;\n' "$sql" | bash -c "$PSQL_COMMAND --tuples-only --no-align --field-separator=' '"
  elif [ -n "${DATABASE_ADMIN_URL:-}" ]; then
    split_password "$DATABASE_ADMIN_URL"
    psql --dbname="$safe_url" --tuples-only --no-align --field-separator=' ' --command "$sql"
  fi
}

# Counted first: a row added during the dump can only make the restore hold more than this says.
count_rows > "$file.counts.partial" || echo "Row counts were not recorded." >&2
dump \
  | openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -out "$file.partial"
mv "$file.partial" "$file"
mv "$file.counts.partial" "$file.counts"

if [ -n "${BACKUP_OFFSITE_COMMAND:-}" ]; then
  bash -c "$BACKUP_OFFSITE_COMMAND" offsite "$file"
fi

ls -1t "$directory"/*.dump.enc | tail -n +"$((keep + 1))" | while read -r old; do rm -f "$old" "$old.counts"; done
write_status backup-dump.prom "$(cat <<METRIC
# HELP agent_platform_backup_last_success_timestamp_seconds When a backup last finished, by kind.
# TYPE agent_platform_backup_last_success_timestamp_seconds gauge
agent_platform_backup_last_success_timestamp_seconds{kind="dump"} $(date +%s)
METRIC
)"
echo "$file"
