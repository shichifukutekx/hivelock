#!/usr/bin/env bash
# Restores a backup into an EMPTY database.
# Usage: BACKUP_PASSPHRASE=... RESTORE_DATABASE_URL=<empty database URL> scripts/restore.sh <backup file>
# The address may also be the second argument, but then its password shows in the process list.
# The limited app role must already exist on the server.
set -euo pipefail

: "${BACKUP_PASSPHRASE:?set BACKUP_PASSPHRASE}"
file="${1:?give a backup file}"
target="${RESTORE_DATABASE_URL:-${2:?give an empty database URL}}"
# shellcheck source=scripts/pg-url.sh
. "$(dirname "$0")/pg-url.sh"
split_password "$target"
target="$safe_url"

tables=$(psql --dbname="$target" --tuples-only --no-align --command "select count(*) from pg_tables where schemaname = 'public'")
if [ "$tables" != "0" ]; then
  echo "Refusing to restore: the target database is not empty." >&2
  exit 1
fi

openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$file" \
  | pg_restore --dbname="$target" --no-owner --exit-on-error
