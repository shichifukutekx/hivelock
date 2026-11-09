-- A workspace's own edited copies of templates. Each row holds only the words that changed, on top of a template in the code,
-- so its steps, connections and approvals are always the original's and cannot be edited away.
create table workspace_templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references organization (id) on delete cascade,
  base_template_id text not null,
  name text not null check (length(name) between 3 and 80),
  outcome text not null,
  description text not null,
  instructions text,
  prompts jsonb not null default '{}',
  cron text,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, name)
);
alter table workspace_templates enable row level security;
alter table workspace_templates force row level security;
create policy workspace_only on workspace_templates
  using (workspace_id = current_setting('app.workspace_id', true))
  with check (workspace_id = current_setting('app.workspace_id', true));
