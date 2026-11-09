-- replaces: 007_observability.sql
-- One timed step of a run or chat: a model call, a tool call, or a guardrail.
-- Holds measurements only, never prompts or results, so it is safe to chart and export.
create table spans (
  id bigint generated always as identity primary key,
  workspace_id text not null references organization (id) on delete cascade,
  trace_id uuid not null,
  trace_kind text not null check (trace_kind in ('run', 'chat', 'eval')),
  kind text not null check (kind in ('model', 'tool', 'guardrail', 'agent')),
  name text not null,
  agent text,
  status text not null default 'ok' check (status in ('ok', 'error', 'refused')),
  duration_ms int,
  input_tokens int,
  output_tokens int,
  cost_usd numeric(12, 6),
  risk real,
  at timestamptz not null default now()
);
create index spans_trace on spans (trace_id, id);
create index spans_recent on spans (workspace_id, at desc);

create table agent_memories (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references organization (id) on delete cascade,
  agent_name text not null,
  content jsonb not null,
  created_at timestamptz not null default now()
);
create index agent_memories_agent on agent_memories (workspace_id, agent_name, created_at desc);

create table agent_skills (
  workspace_id text not null references organization (id) on delete cascade,
  name text not null check (name ~ '^[a-z][a-z0-9-]{2,39}$'),
  description text not null,
  instructions text not null check (length(instructions) <= 8000),
  created_by text not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, name)
);

alter table workspace_settings add column redact_personal_data boolean not null default false;

do $$
declare
  name text;
begin
  foreach name in array array['spans', 'agent_memories', 'agent_skills']
  loop
    execute format('alter table %I enable row level security', name);
    execute format('alter table %I force row level security', name);
    execute format($p$create policy workspace_only on %I
      using (workspace_id = current_setting('app.workspace_id', true))
      with check (workspace_id = current_setting('app.workspace_id', true))$p$, name);
  end loop;
end $$;

-- Totals across every workspace, for the operator's /metrics. Numbers only.
create function platform_metrics() returns table (name text, value bigint)
language sql security definer set search_path = public as $$
  select 'workspaces', count(*) from organization
  union all select 'runs_active', count(*) from runs where status in ('running', 'waiting')
  union all select 'runs_failed_24h', count(*) from runs where status = 'failed' and created_at > now() - interval '1 day'
  union all select 'runs_succeeded_24h', count(*) from runs where status = 'succeeded' and created_at > now() - interval '1 day'
  union all select 'model_calls_24h', count(*) from spans where kind = 'model' and at > now() - interval '1 day'
  union all select 'model_errors_24h', count(*) from spans where kind = 'model' and status = 'error' and at > now() - interval '1 day'
  union all select 'tokens_24h', coalesce(sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)), 0)::bigint from spans where at > now() - interval '1 day'
  union all select 'tool_errors_24h', count(*) from spans where kind = 'tool' and status = 'error' and at > now() - interval '1 day'
  union all select 'approvals_waiting', count(*) from agent_approvals where status = 'pending'
$$;
revoke all on function platform_metrics() from public;
