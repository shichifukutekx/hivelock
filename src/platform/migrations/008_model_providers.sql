-- The AI services a workspace uses, tried in priority order. Keys are encrypted and never returned.
create table model_providers (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references organization (id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  preset text not null default 'custom',
  base_url text not null,
  key_ciphertext bytea,
  key_iv bytea,
  key_tag bytea,
  models jsonb not null default '{}',
  extra_body jsonb not null default '{}',
  enabled boolean not null default true,
  -- Set by a person who has checked this provider's data terms. Confidential mode uses only these.
  confidential_allowed boolean not null default false,
  priority int not null default 100,
  input_price numeric(12, 4),
  output_price numeric(12, 4),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, name)
);
create index model_providers_order on model_providers (workspace_id, priority, created_at);

alter table model_providers enable row level security;
alter table model_providers force row level security;
create policy workspace_only on model_providers
  using (workspace_id = current_setting('app.workspace_id', true))
  with check (workspace_id = current_setting('app.workspace_id', true));
