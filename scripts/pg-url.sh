# Sourced by the backup scripts.

# Row counts kept beside each backup, so a restore can be compared with what went in.
COUNTED_TABLES='organization "user" member workflows runs run_steps agent_sessions agent_messages secrets audit_events schema_migrations'
counting_sql() {
  local table sql=""
  for table in $COUNTED_TABLES; do
    sql="$sql${sql:+ union all }select '$table', count(*) from $table"
  done
  printf '%s' "$sql"
}

# Writes one metric where node_exporter reads it, and stays quiet with nowhere to write. Replaces the whole file at once, so a half-written one is never read.
write_status() {
  local name="$1" text="$2" directory="${BACKUP_STATUS_DIR:-}"
  [ -n "$directory" ] || return 0
  mkdir -p "$directory"
  printf '%s\n' "$text" > "$directory/$name.partial"
  mv "$directory/$name.partial" "$directory/$name"
}

# Arguments show in the process list and the environment does not,
# so the password moves to PGPASSWORD and the address that remains is safe to pass.
split_password() {
  local url="$1" scheme rest authority path userinfo password
  scheme="${url%%://*}"
  rest="${url#*://}"
  authority="${rest%%/*}"
  path="${rest#"$authority"}"
  safe_url="$url"
  [[ "$authority" == *@* ]] || return 0
  userinfo="${authority%@*}"
  [[ "$userinfo" == *:* ]] || return 0
  password="${userinfo#*:}"
  password="${password//\\/\\\\}"
  PGPASSWORD="$(printf '%b' "${password//%/\\x}")"
  export PGPASSWORD
  safe_url="$scheme://${userinfo%%:*}@${authority##*@}$path"
}
