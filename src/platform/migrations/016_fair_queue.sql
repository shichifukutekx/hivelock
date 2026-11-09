-- Fair sharing of the workers. Each workspace has a limit on places, and a step or agent turn needs one to run.
-- Work over the limit stays in work_waiting and never enters the shared queue, so one workspace's backlog cannot sit in front of another's.
-- A running job holds a lease, which expires unless its worker renews it, so a dead worker cannot keep a place.
-- Nothing here holds a workspace's content: only ids.
create table work_leases (
  job_key text primary key,
  workspace_id text not null references organization (id) on delete cascade,
  queue text not null,
  holder text not null,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index work_leases_workspace on work_leases (workspace_id);
create index work_leases_expiry on work_leases (expires_at);

-- released_at is set when the job is on the shared queue. Until a worker takes it the row still holds a place, so a newcomer cannot take it.
create table work_waiting (
  job_key text primary key,
  workspace_id text not null references organization (id) on delete cascade,
  queue text not null,
  data jsonb not null,
  deferred_at timestamptz not null default now(),
  released_at timestamptz
);
create index work_waiting_order on work_waiting (workspace_id, deferred_at) where released_at is null;

-- Each worker process says it is alive here, for readiness and the status page.
create table worker_presence (
  worker_id text primary key,
  started_at timestamptz not null default now(),
  seen_at timestamptz not null default now()
);

-- No policy on purpose: these are server-wide, so only the functions below reach them.
alter table work_leases enable row level security;
alter table work_leases force row level security;
alter table work_waiting enable row level security;
alter table work_waiting force row level security;
alter table worker_presence enable row level security;
alter table worker_presence force row level security;
revoke all on work_leases, work_waiting, worker_presence from public;

-- Decides, as work is created, whether it goes on the shared queue now. True means the caller sends the job in this same transaction.
create function work_admit(target_workspace text, target_queue text, key text, job jsonb, place_limit integer) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  used bigint;
  free boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('work:' || target_workspace, 0));
  delete from work_leases where workspace_id = target_workspace and expires_at < now();
  if exists (select 1 from work_waiting w where w.job_key = key) then
    return false;
  end if;
  select (select count(*) from work_leases l where l.workspace_id = target_workspace)
       + (select count(*) from work_waiting w where w.workspace_id = target_workspace and w.released_at is not null)
    into used;
  free := used < place_limit and not exists (select 1 from work_waiting w where w.workspace_id = target_workspace and w.released_at is null);
  insert into work_waiting (job_key, workspace_id, queue, data, released_at)
    values (key, target_workspace, target_queue, job, case when free then now() end);
  return free;
end $$;

-- Takes a place when a worker has the job, or sends the job back to waiting. Decisions for a workspace run one at a time under its lock.
-- `takeover` is true for a job the queue is retrying: its worker has already been given up on, so its old lease does not count.
create function work_acquire(target_workspace text, target_queue text, key text, job jsonb, worker text, place_limit integer, lease_seconds integer, takeover boolean)
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
      on conflict (job_key) do nothing;
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

create function work_renew(worker text, keys text[], lease_seconds integer) returns setof text
language sql security definer set search_path = public as $$
  update work_leases set expires_at = now() + make_interval(secs => lease_seconds)
  where job_key = any(keys) and holder = worker returning job_key
$$;

create function work_release(key text, worker text) returns void
language sql security definer set search_path = public as $$
  delete from work_leases where job_key = key and holder = worker
$$;

-- Marks the next waiting jobs as going back to the queue, as many as there are free places. The caller sends them in this same transaction.
create function work_claim(target_workspace text, place_limit integer) returns table (queue text, job_key text, data jsonb)
language plpgsql security definer set search_path = public as $$
declare
  used bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('work:' || target_workspace, 0));
  delete from work_leases l where l.workspace_id = target_workspace and l.expires_at < now();
  select (select count(*) from work_leases l where l.workspace_id = target_workspace)
       + (select count(*) from work_waiting w where w.workspace_id = target_workspace and w.released_at is not null)
    into used;
  return query
    with next as (
      select w.job_key from work_waiting w
      where w.workspace_id = target_workspace and w.released_at is null
      order by w.deferred_at, w.job_key limit greatest(place_limit - used, 0)
    )
    update work_waiting w set released_at = now() from next
    where w.job_key = next.job_key returning w.queue, w.job_key, w.data;
end $$;

-- Clears what a dead worker left, and names the workspaces with work waiting. A job sent back but lost goes back in line.
create function work_sweep(worker text) returns setof text
language plpgsql security definer set search_path = public as $$
begin
  insert into worker_presence (worker_id) values (worker) on conflict (worker_id) do update set seen_at = now();
  delete from worker_presence where seen_at < now() - interval '1 day';
  delete from work_leases where expires_at < now();
  update work_waiting set released_at = null where released_at < now() - interval '30 minutes';
  return query select distinct w.workspace_id from work_waiting w where w.released_at is null;
end $$;

create function worker_left(worker text) returns void
language sql security definer set search_path = public as $$
  delete from worker_presence where worker_id = worker
$$;

-- Totals by queue, for /metrics. Numbers only, and no workspace is named.
create function work_depth() returns table (queue text, running bigint, waiting bigint, oldest_seconds double precision, workspaces_waiting bigint)
language sql stable security definer set search_path = public as $$
  with queues as (select l.queue from work_leases l union select w.queue from work_waiting w)
  select q.queue,
    (select count(*) from work_leases l where l.queue = q.queue and l.expires_at > now()),
    (select count(*) from work_waiting w where w.queue = q.queue and w.released_at is null),
    coalesce((select extract(epoch from now() - min(w.deferred_at))::double precision from work_waiting w where w.queue = q.queue and w.released_at is null), 0),
    (select count(distinct w.workspace_id) from work_waiting w where w.queue = q.queue and w.released_at is null)
  from queues q
$$;

create function workers_alive() returns bigint
language sql stable security definer set search_path = public as $$
  select count(*) from worker_presence where seen_at > now() - interval '60 seconds'
$$;

-- The app role cannot read schema_migrations, and readiness needs to know whether this code's migrations have run.
create function applied_migrations() returns setof text
language sql stable security definer set search_path = public as $$
  select name from schema_migrations
$$;

revoke all on function work_admit(text, text, text, jsonb, integer) from public;
revoke all on function work_acquire(text, text, text, jsonb, text, integer, integer, boolean) from public;
revoke all on function work_renew(text, text[], integer) from public;
revoke all on function work_release(text, text) from public;
revoke all on function work_claim(text, integer) from public;
revoke all on function work_sweep(text) from public;
revoke all on function worker_left(text) from public;
revoke all on function work_depth() from public;
revoke all on function workers_alive() from public;
revoke all on function applied_migrations() from public;
