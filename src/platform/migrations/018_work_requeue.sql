-- A conversation's next message reuses its turn's key. Sent just as the last turn ends, its job can reach a worker before that lease is released,
-- and is sent back to wait. The row already said it was on the queue, and leaving it so held a place for a job that no longer existed, until
-- the sweep cleared it half an hour later. The message waited all that time. This does what the last branch below does.
create or replace function work_acquire(target_workspace text, target_queue text, key text, job jsonb, worker text, place_limit integer, lease_seconds integer, takeover boolean)
returns table (granted boolean, waited_seconds double precision)
language plpgsql security definer set search_path = public as $$
declare
  own work_waiting;
  used bigint;
  ahead boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('work:' || target_workspace, 0));
  delete from work_leases where workspace_id = target_workspace and expires_at < now();
  select * into own from work_waiting w where w.job_key = key;
  if takeover then
    delete from work_leases l where l.job_key = key;
  elsif exists (select 1 from work_leases l where l.job_key = key) then
    -- A second copy of something already running. It waits, and finds the work done when its turn comes.
    insert into work_waiting (job_key, workspace_id, queue, data) values (key, target_workspace, target_queue, job)
      on conflict (job_key) do update set released_at = null;
    return query select false, 0::double precision;
    return;
  end if;
  select (select count(*) from work_leases l where l.workspace_id = target_workspace)
       + (select count(*) from work_waiting w where w.workspace_id = target_workspace and w.released_at is not null and w.job_key <> key)
    into used;
  select exists (
    select 1 from work_waiting w
    where w.workspace_id = target_workspace and w.released_at is null and w.job_key <> key
      and (own.job_key is null or w.deferred_at < own.deferred_at)
  ) into ahead;
  if used < place_limit and (own.released_at is not null or not ahead) then
    delete from work_waiting w where w.job_key = key;
    insert into work_leases (job_key, workspace_id, queue, holder, expires_at)
      values (key, target_workspace, target_queue, worker, now() + make_interval(secs => lease_seconds));
    return query select true, coalesce(extract(epoch from now() - own.deferred_at)::double precision, 0);
    return;
  end if;
  insert into work_waiting (job_key, workspace_id, queue, data) values (key, target_workspace, target_queue, job)
    on conflict (job_key) do update set released_at = null;
  return query select false, 0::double precision;
end $$;
revoke all on function work_acquire(text, text, text, jsonb, text, integer, integer, boolean) from public;
