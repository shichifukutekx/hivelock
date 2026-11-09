-- Two-step sign-in is on for everyone by default. A person may turn it off for their own account, after confirming
-- their password, and this row records that choice. Turning it on again removes the row.
create table two_factor_opt_outs (
  user_id text primary key references "user" (id) on delete cascade,
  created_at timestamptz not null default now()
);
