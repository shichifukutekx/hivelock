-- The run that repeated this one. A run can be run again once, so a double click or two people at once start one new run.
-- Checked at commit, because the new run is saved after this is set, in the same transaction.
alter table runs add column retried_as uuid references runs (id) on delete set null deferrable initially deferred;
create unique index runs_retried_as on runs (retried_as) where retried_as is not null;
