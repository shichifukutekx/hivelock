# Monitoring

## Starting it

The stack is optional and needs two things named: the file, and the profile.

1. Set `METRICS_TOKEN` and `ALERT_WEBHOOK_URL` in `.env.production`.
2. Put `GRAFANA_ADMIN_PASSWORD=<a password>` in a file called `.env.monitoring`.
3. Run:

```
docker compose -f compose.yaml -f deploy/monitoring/compose.yaml --profile monitoring \
  --env-file .env.production --env-file .env.migrate --env-file .env.monitoring up -d
```

| Service | Address | Sign-in |
|---|---|---|
| Grafana | `http://127.0.0.1:3000` | `admin` and your password. The Hivelock dashboard is already there |
| Prometheus | `http://127.0.0.1:9090` | None, so it stays on this machine |
| Alertmanager | `http://127.0.0.1:9093` | None, so it stays on this machine |

Use an SSH tunnel to reach them from elsewhere. Backup alerts need the option in `docs/disaster-recovery.md`, and fire until it, or something else, records a backup.

## Alerts

All go to `ALERT_WEBHOOK_URL`. Rules are in `deploy/monitoring/alerts.yml`.

| Area | Alerts |
|---|---|
| Down | `HivelockDown`, `PublicAddressDown`, `WebReplicaDown`, `NoWorkers` |
| Errors and speed | `HighErrorRate` (over 2%), `SlowRequests` (p95 over 2 seconds), `DatabasePoolExhausted` |
| Work | `QueueBacklog`, `WorkHeldBack`, `JobFailures`, `RunsFailing` |
| Disk | `DiskFilling` (under 15%), `DiskNearlyFull` (under 5%) |
| Recovery | `BackupTooOld`, `BackupNeverRecorded`, `WalArchiveStale`, `RestoreDrillStale`, `RestoreDrillFailed` |
| Certificates | `CertificateExpiring` (14 days), `CertificateNearlyExpired` (3 days) |

## Metrics

Everything starts `agent_platform_`. No metric names a workspace or a person.

| Metric | Labels |
|---|---|
| `http_requests_total` | `method`, `route`, `status` (`2xx` and so on) |
| `http_request_duration_seconds` | `method`, `route` |
| `http_requests_in_flight` | |
| `queue_depth` | `queue`, `state` (`queued`, `active`, `deferred`, `leased`, `waiting`) |
| `queue_wait_seconds` | `queue` |
| `queue_deferrals_total` | `queue` |
| `queue_oldest_waiting_seconds`, `queue_workspaces_waiting` | `queue` |
| `job_failures_total`, `job_duration_seconds` | `queue` |
| `run_outcomes_total` | `outcome` |
| `db_pool_connections` | `pool`, `state` |
| `db_pool_waiting` | `pool` |
| `workers_alive` | |
| `errors_reported_total` | `result` |

`route` is the route's pattern, such as `/api/v1/workspaces/:workspaceId/runs`.

## Logs

Each process writes one JSON object a line, with `level`, `event` and `at`. Every line written during a request carries its `requestId`. Caddy sets the id, and the app returns it as `x-request-id` and in error answers, so one id finds a request in both logs. Bodies, headers and prompts are never logged, and messages have credentials removed.

## Error reporting

Set `ERROR_REPORTING_DSN` to the DSN from any Sentry-compatible service. It is off without one, and needs no extra package.

Unexpected request errors, failed jobs and crashes are sent. Credentials are removed from the message and stack first. Request bodies, headers, prompts and workspace names are never sent. The same error is sent once a minute at most, and 30 errors a minute in all. A tracker that is down harms nothing.
