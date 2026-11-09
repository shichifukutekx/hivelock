-- Lists now page through everything, so these answer "this workflow's last run" and "the failed runs" without walking all runs.
create index runs_workflow_recent on runs (workspace_id, workflow_id, created_at desc);
create index runs_status_recent on runs (workspace_id, status, created_at desc);
