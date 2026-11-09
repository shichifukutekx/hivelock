-- Secrets: encrypted values, one row per workspace and name.
create table secrets (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references organization (id) on delete cascade,
  name text not null check (name ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  ciphertext bytea not null,
  iv bytea not null,
  tag bytea not null,
  key_version int not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, name)
);

alter table secrets enable row level security;
alter table secrets force row level security;
create policy workspace_only on secrets
  using (workspace_id = current_setting('app.workspace_id', true))
  with check (workspace_id = current_setting('app.workspace_id', true));

-- Audit log: append-only, and each entry's hash covers the entry before it.
create table audit_events (
  id bigint generated always as identity primary key,
  workspace_id text,
  actor_id text,
  action text not null,
  target_type text,
  target_id text,
  details jsonb not null default '{}',
  ip text,
  at timestamptz not null default now(),
  prev_hash text not null,
  hash text not null
);
create index audit_events_workspace on audit_events (workspace_id, id desc);

create function audit_event_hash(e audit_events) returns text
language sql immutable as $$
  select encode(sha256(convert_to(concat_ws('|',
    e.prev_hash, coalesce(e.workspace_id, ''), coalesce(e.actor_id, ''), e.action,
    coalesce(e.target_type, ''), coalesce(e.target_id, ''), e.details::text, coalesce(e.ip, ''),
    extract(epoch from e.at)::text
  ), 'UTF8')), 'hex')
$$;

create function audit_events_link() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- One writer per chain at a time, so two entries can never share a parent.
  perform pg_advisory_xact_lock(hashtext('audit:' || coalesce(new.workspace_id, '')));
  new.at := now();
  select hash into new.prev_hash from audit_events
    where workspace_id is not distinct from new.workspace_id order by id desc limit 1;
  new.prev_hash := coalesce(new.prev_hash, 'genesis');
  new.hash := audit_event_hash(new);
  return new;
end $$;

create trigger audit_events_chain before insert on audit_events
  for each row execute function audit_events_link();

create function audit_events_refuse() returns trigger
language plpgsql as $$
begin
  raise exception 'The audit log cannot be changed.';
end $$;

create trigger audit_events_append_only before update or delete on audit_events
  for each row execute function audit_events_refuse();
create trigger audit_events_no_truncate before truncate on audit_events
  for each statement execute function audit_events_refuse();

alter table audit_events enable row level security;
alter table audit_events force row level security;
create policy workspace_reads on audit_events for select
  using (workspace_id = current_setting('app.workspace_id', true));
create policy any_insert on audit_events for insert with check (true);

-- Returns the first entry that does not match its hash, or null when the chain is intact.
create function audit_chain_break(target_workspace text) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  entry audit_events;
  expected text := 'genesis';
begin
  for entry in select * from audit_events
    where workspace_id is not distinct from target_workspace order by id
  loop
    if entry.prev_hash <> expected or entry.hash <> audit_event_hash(entry) then
      return entry.id;
    end if;
    expected := entry.hash;
  end loop;
  return null;
end $$;
revoke all on function audit_chain_break(text) from public;
