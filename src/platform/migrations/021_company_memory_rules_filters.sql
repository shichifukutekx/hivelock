-- Company memory: notes every agent in a workspace reads. People write them; an agent may only suggest one,
-- and a suggestion does nothing until someone with agents:write accepts it. The text is sealed like agent memories.
create table company_notes (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references organization (id) on delete cascade,
  content jsonb not null,
  status text not null default 'active' check (status in ('active', 'suggested')),
  suggested_by_agent text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index company_notes_list on company_notes (workspace_id, status, created_at desc);

-- An admin's rule for one action on one connection. With no row, the action follows its normal rule:
-- reading runs, changing asks a person. "ask" makes agents ask every time; "block" turns the action off everywhere.
create table action_rules (
  workspace_id text not null references organization (id) on delete cascade,
  connection_id uuid not null references connections (id) on delete cascade,
  action text not null check (length(action) between 1 and 100),
  rule text not null check (rule in ('ask', 'block')),
  set_by text not null,
  set_at timestamptz not null default now(),
  primary key (workspace_id, connection_id, action)
);

do $$
declare
  name text;
begin
  foreach name in array array['company_notes', 'action_rules']
  loop
    execute format('alter table %I enable row level security', name);
    execute format('alter table %I force row level security', name);
    execute format($p$create policy workspace_only on %I
      using (workspace_id = current_setting('app.workspace_id', true))
      with check (workspace_id = current_setting('app.workspace_id', true))$p$, name);
  end loop;
end $$;

-- A webhook's filter: conditions on the sent JSON that must all hold, checked before any run or model starts.
-- Deliveries that do not match are counted, so a filter that drops everything is easy to notice.
-- Kept apart from triggers, so a trigger's own row never changes shape.
create table trigger_filters (
  trigger_id uuid primary key references triggers (id) on delete cascade,
  workspace_id text not null references organization (id) on delete cascade,
  filter jsonb not null,
  skipped_count integer not null default 0,
  last_skipped_at timestamptz,
  updated_by text not null,
  updated_at timestamptz not null default now()
);
alter table trigger_filters enable row level security;
alter table trigger_filters force row level security;
create policy workspace_only on trigger_filters
  using (workspace_id = current_setting('app.workspace_id', true))
  with check (workspace_id = current_setting('app.workspace_id', true));

-- One agent turned off, without pausing the whole workspace. Works for built-in agents too, so it goes by name.
-- While a row exists the agent starts no chat turn, workflow step or hand-off. Removing the row turns it on again.
create table agent_switches (
  workspace_id text not null references organization (id) on delete cascade,
  agent_name text not null,
  reason text check (length(reason) <= 200),
  turned_off_by text not null,
  turned_off_at timestamptz not null default now(),
  primary key (workspace_id, agent_name)
);
alter table agent_switches enable row level security;
alter table agent_switches force row level security;
create policy workspace_only on agent_switches
  using (workspace_id = current_setting('app.workspace_id', true))
  with check (workspace_id = current_setting('app.workspace_id', true));
