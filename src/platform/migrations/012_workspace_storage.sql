-- replaces: 012_hosted_sso_billing.sql
-- How much of its storage each workspace is using.
create table workspace_storage (
  workspace_id text primary key references organization (id) on delete cascade,
  bytes bigint not null default 0 check (bytes >= 0)
);

alter table workspace_storage enable row level security;
alter table workspace_storage force row level security;
create policy workspace_only on workspace_storage
  using (workspace_id = current_setting('app.workspace_id', true))
  with check (workspace_id = current_setting('app.workspace_id', true));
