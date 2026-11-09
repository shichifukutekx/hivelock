-- A connected account. Credentials are encrypted, and no route returns them.
create table connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references organization (id) on delete cascade,
  connector text not null,
  name text not null check (length(name) between 1 and 120),
  ciphertext bytea not null,
  iv bytea not null,
  tag bytea not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, name)
);

-- One row per action that changes something, claimed before it happens.
-- A retry finds the row, so the action cannot silently happen twice.
create table run_effects (
  workspace_id text not null references organization (id) on delete cascade,
  run_id uuid not null references runs (id) on delete cascade,
  node_id text not null,
  status text not null check (status in ('started', 'done')),
  result jsonb,
  created_at timestamptz not null default now(),
  primary key (run_id, node_id)
);

-- Tools offered by a custom MCP server. A person reviews each one before it can be used.
create table mcp_tools (
  workspace_id text not null references organization (id) on delete cascade,
  connection_id uuid not null references connections (id) on delete cascade,
  name text not null,
  description text not null default '',
  input_schema jsonb not null default '{}',
  fingerprint text not null,
  status text not null default 'disabled' check (status in ('disabled', 'enabled')),
  changed boolean not null default false,
  reviewed_by text,
  reviewed_at timestamptz,
  primary key (connection_id, name)
);

do $$
declare
  name text;
begin
  foreach name in array array['connections', 'run_effects', 'mcp_tools']
  loop
    execute format('alter table %I enable row level security', name);
    execute format('alter table %I force row level security', name);
    execute format($p$create policy workspace_only on %I
      using (workspace_id = current_setting('app.workspace_id', true))
      with check (workspace_id = current_setting('app.workspace_id', true))$p$, name);
  end loop;
end $$;
