-- Counters for rate limits, kept in the database so every server shares them.
-- Keys are hashed, so this table holds no addresses or ids.
create table rate_limits (
  key text primary key,
  window_start timestamptz not null,
  hits int not null
);
create index rate_limits_age on rate_limits (window_start);

-- Tokens used per calendar month, so a workspace cannot run up an unlimited bill.
create table workspace_usage (
  workspace_id text not null references organization (id) on delete cascade,
  month date not null,
  tokens bigint not null default 0,
  primary key (workspace_id, month)
);
alter table workspace_usage enable row level security;
alter table workspace_usage force row level security;
create policy workspace_only on workspace_usage
  using (workspace_id = current_setting('app.workspace_id', true))
  with check (workspace_id = current_setting('app.workspace_id', true));

alter table workspace_settings
  add column monthly_token_limit bigint not null default 5000000 check (monthly_token_limit >= 0),
  add column run_retention_days int not null default 90 check (run_retention_days between 1 and 3650);
