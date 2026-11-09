-- The platform's own mail, one row for the whole server. It belongs to no workspace.
-- The limited app role has no rights on this table and row security has no policy, so a query cannot reach it.
create table platform_mail_settings (
  only_row boolean primary key default true check (only_row),
  host text not null,
  port int not null check (port between 1 and 65535),
  security text not null check (security in ('starttls', 'tls')),
  username text not null default '',
  password_ciphertext bytea,
  password_iv bytea,
  password_tag bytea,
  from_address text not null,
  from_name text not null default '',
  updated_by text not null,
  updated_at timestamptz not null default now()
);
alter table platform_mail_settings enable row level security;
alter table platform_mail_settings force row level security;
revoke all on platform_mail_settings from public;

-- The app reaches the row only through these two calls, and neither works inside a workspace transaction.
create function platform_mail_read() returns setof platform_mail_settings
language sql stable security definer set search_path = public as $$
  select * from platform_mail_settings where coalesce(current_setting('app.workspace_id', true), '') = ''
$$;
revoke all on function platform_mail_read() from public;

-- Returns false when a saved password would go to a different server.
-- The rule lives here so that it holds under the row lock, whatever calls this.
create function platform_mail_write(
  new_host text, new_port int, new_security text, new_username text,
  new_ciphertext bytea, new_iv bytea, new_tag bytea,
  new_from_address text, new_from_name text, new_updated_by text
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  saved platform_mail_settings;
begin
  if coalesce(current_setting('app.workspace_id', true), '') <> '' then
    raise exception 'Platform settings cannot change inside a workspace.';
  end if;
  select * into saved from platform_mail_settings for update;
  if saved.password_ciphertext is not null and new_ciphertext is null
     and (lower(saved.host) <> lower(new_host) or saved.port <> new_port) then
    return false;
  end if;
  insert into platform_mail_settings (host, port, security, username, password_ciphertext, password_iv, password_tag, from_address, from_name, updated_by)
  values (new_host, new_port, new_security, new_username, new_ciphertext, new_iv, new_tag, new_from_address, new_from_name, new_updated_by)
  on conflict (only_row) do update set
    host = excluded.host, port = excluded.port, security = excluded.security, username = excluded.username,
    password_ciphertext = coalesce(excluded.password_ciphertext, platform_mail_settings.password_ciphertext),
    password_iv = coalesce(excluded.password_iv, platform_mail_settings.password_iv),
    password_tag = coalesce(excluded.password_tag, platform_mail_settings.password_tag),
    from_address = excluded.from_address, from_name = excluded.from_name,
    updated_by = excluded.updated_by, updated_at = now();
  return true;
end $$;
revoke all on function platform_mail_write(text, int, text, text, bytea, bytea, bytea, text, text, text) from public;
