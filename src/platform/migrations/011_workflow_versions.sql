-- replaces: 011_versions_and_email_triggers.sql
-- One numbered copy per save of a workflow. The limited role can add and prune rows, but not change them.
create table workflow_versions (
  workspace_id text not null references organization (id) on delete cascade,
  workflow_id uuid not null references workflows (id) on delete cascade,
  version int not null,
  name text not null,
  description text not null default '',
  definition jsonb not null,
  note text not null default '' check (length(note) <= 500),
  restored_from int,
  saved_by text,
  saved_at timestamptz not null default now(),
  primary key (workflow_id, version)
);

insert into workflow_versions (workspace_id, workflow_id, version, name, description, definition, note, saved_at)
select workspace_id, id, version, name, description, definition, 'Saved before version history began.', updated_at from workflows;

-- Both only widen. "not valid" skips rechecking old rows, which already pass, so a large runs table is not scanned under a lock.
alter table triggers drop constraint triggers_kind_check;
alter table triggers add constraint triggers_kind_check check (kind in ('schedule', 'webhook', 'email')) not valid;
alter table triggers drop constraint triggers_check;
alter table triggers add constraint triggers_check check (
  (kind = 'schedule' and cron is not null and timezone is not null)
  or (kind = 'webhook' and secret_ciphertext is not null)
  or kind = 'email'
) not valid;
alter table runs drop constraint runs_trigger_kind_check;
alter table runs add constraint runs_trigger_kind_check check (trigger_kind in ('manual', 'schedule', 'webhook', 'email')) not valid;

do $$
declare
  name text;
begin
  foreach name in array array['workflow_versions']
  loop
    execute format('alter table %I enable row level security', name);
    execute format('alter table %I force row level security', name);
    execute format($p$create policy workspace_only on %I
      using (workspace_id = current_setting('app.workspace_id', true))
      with check (workspace_id = current_setting('app.workspace_id', true))$p$, name);
  end loop;
end $$;
