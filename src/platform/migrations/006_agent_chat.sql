-- A conversation with an agent. Messages and activity are sealed like run data.
create table agent_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references organization (id) on delete cascade,
  agent_name text not null,
  title text not null,
  status text not null default 'idle' check (status in ('idle', 'running', 'waiting')),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index agent_sessions_recent on agent_sessions (workspace_id, updated_at desc);

create table agent_messages (
  id bigint generated always as identity primary key,
  workspace_id text not null references organization (id) on delete cascade,
  session_id uuid not null references agent_sessions (id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'error')),
  content jsonb not null,
  at timestamptz not null default now()
);
create index agent_messages_session on agent_messages (session_id, id);

create table agent_activity (
  id bigint generated always as identity primary key,
  workspace_id text not null references organization (id) on delete cascade,
  session_id uuid not null references agent_sessions (id) on delete cascade,
  event jsonb not null,
  at timestamptz not null default now()
);
create index agent_activity_session on agent_activity (session_id, id);

create table agent_approvals (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references organization (id) on delete cascade,
  session_id uuid not null references agent_sessions (id) on delete cascade,
  tool text not null,
  args jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'expired')),
  decided_by text,
  created_at timestamptz not null default now()
);

do $$
declare
  name text;
begin
  foreach name in array array['agent_sessions', 'agent_messages', 'agent_activity', 'agent_approvals']
  loop
    execute format('alter table %I enable row level security', name);
    execute format('alter table %I force row level security', name);
    execute format($p$create policy workspace_only on %I
      using (workspace_id = current_setting('app.workspace_id', true))
      with check (workspace_id = current_setting('app.workspace_id', true))$p$, name);
  end loop;
end $$;
