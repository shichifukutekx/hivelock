-- The chain follows its own sequence, set after the lock, so simultaneous writers cannot cross over.
alter table audit_events disable trigger audit_events_append_only;
alter table audit_events add column seq bigint;
update audit_events set seq = id;
alter table audit_events enable trigger audit_events_append_only;
alter table audit_events alter column seq set not null;
create unique index audit_events_chain on audit_events (coalesce(workspace_id, ''), seq);

create or replace function audit_events_link() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  last audit_events;
begin
  perform pg_advisory_xact_lock(hashtext('audit:' || coalesce(new.workspace_id, '')));
  new.at := clock_timestamp();
  select * into last from audit_events
    where coalesce(workspace_id, '') = coalesce(new.workspace_id, '') order by seq desc limit 1;
  new.seq := coalesce(last.seq, 0) + 1;
  new.prev_hash := coalesce(last.hash, 'genesis');
  new.hash := audit_event_hash(new);
  return new;
end $$;

create or replace function audit_chain_break(target_workspace text) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  entry audit_events;
  expected text := 'genesis';
  next_seq bigint := 1;
begin
  for entry in select * from audit_events
    where coalesce(workspace_id, '') = coalesce(target_workspace, '') order by seq
  loop
    if entry.seq <> next_seq or entry.prev_hash <> expected or entry.hash <> audit_event_hash(entry) then
      return entry.id;
    end if;
    expected := entry.hash;
    next_seq := next_seq + 1;
  end loop;
  return null;
end $$;

-- The newest hash can be copied somewhere outside the database, so cutting off recent entries can be noticed.
create function audit_chain_head(target_workspace text) returns table (seq bigint, hash text)
language sql security definer set search_path = public as $$
  select seq, hash from audit_events where coalesce(workspace_id, '') = coalesce(target_workspace, '') order by seq desc limit 1
$$;
revoke all on function audit_chain_head(text) from public;
