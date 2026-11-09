-- Workspace choices. Confidential mode starts on, so a new workspace is safe by default.
create table workspace_settings (
  workspace_id text primary key references organization (id) on delete cascade,
  confidential_mode boolean not null default true,
  updated_at timestamptz not null default now()
);

create table workspace_agents (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references organization (id) on delete cascade,
  name text not null,
  spec jsonb not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, name)
);

create table workflows (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references organization (id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  description text not null default '',
  definition jsonb not null,
  version int not null default 1,
  enabled boolean not null default false,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table triggers (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references organization (id) on delete cascade,
  workflow_id uuid not null references workflows (id) on delete cascade,
  kind text not null check (kind in ('schedule', 'webhook')),
  cron text,
  timezone text,
  secret_ciphertext bytea,
  secret_iv bytea,
  secret_tag bytea,
  enabled boolean not null default true,
  created_by text not null,
  created_at timestamptz not null default now(),
  check ((kind = 'schedule' and cron is not null and timezone is not null)
      or (kind = 'webhook' and secret_ciphertext is not null))
);

-- A run keeps its own copy of the definition, so editing a workflow never changes work in progress.
create table runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references organization (id) on delete cascade,
  workflow_id uuid references workflows (id) on delete set null,
  workflow_name text not null,
  workflow_version int not null,
  definition jsonb not null,
  trigger_kind text not null check (trigger_kind in ('manual', 'schedule', 'webhook')),
  trigger_id uuid,
  status text not null default 'running'
    check (status in ('running', 'waiting', 'succeeded', 'failed', 'cancelled')),
  input jsonb not null default '{}',
  output jsonb,
  error text,
  confidential boolean not null,
  created_by text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index runs_workspace on runs (workspace_id, created_at desc);
create index runs_active on runs (workspace_id) where status in ('running', 'waiting');

create table run_steps (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references organization (id) on delete cascade,
  run_id uuid not null references runs (id) on delete cascade,
  node_id text not null,
  node_type text not null,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'waiting', 'done', 'failed', 'skipped')),
  attempt int not null default 0,
  branch text,
  output jsonb,
  error text,
  decided_by text,
  started_at timestamptz,
  finished_at timestamptz,
  unique (run_id, node_id)
);

create table run_events (
  id bigint generated always as identity primary key,
  workspace_id text not null references organization (id) on delete cascade,
  run_id uuid not null references runs (id) on delete cascade,
  node_id text not null,
  event jsonb not null,
  at timestamptz not null default now()
);
create index run_events_run on run_events (run_id, id);

-- Remembers signatures already used, so a captured webhook call cannot be replayed.
create table webhook_deliveries (
  workspace_id text not null references organization (id) on delete cascade,
  trigger_id uuid not null references triggers (id) on delete cascade,
  signature text not null,
  received_at timestamptz not null default now(),
  primary key (trigger_id, signature)
);

do $$
declare
  name text;
begin
  foreach name in array array['workspace_settings', 'workspace_agents', 'workflows', 'triggers', 'runs', 'run_steps', 'run_events', 'webhook_deliveries']
  loop
    execute format('alter table %I enable row level security', name);
    execute format('alter table %I force row level security', name);
    execute format($p$create policy workspace_only on %I
      using (workspace_id = current_setting('app.workspace_id', true))
      with check (workspace_id = current_setting('app.workspace_id', true))$p$, name);
  end loop;
end $$;

-- A webhook arrives with no signed-in user, so this one lookup finds the workspace.
-- It returns only what is needed to check the signature.
create function webhook_trigger(target uuid) returns table (
  workspace_id text, workflow_id uuid, enabled boolean,
  secret_ciphertext bytea, secret_iv bytea, secret_tag bytea
)
language sql security definer set search_path = public as $$
  select t.workspace_id, t.workflow_id, t.enabled and w.enabled,
         t.secret_ciphertext, t.secret_iv, t.secret_tag
  from triggers t join workflows w on w.id = t.workflow_id
  where t.id = target and t.kind = 'webhook'
$$;
revoke all on function webhook_trigger(uuid) from public;
