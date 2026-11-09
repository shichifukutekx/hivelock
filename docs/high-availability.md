# High availability

## What runs

| Service | Does | Scale with | Stops within |
|---|---|---|---|
| `web` | Answers requests and live text | `WEB_REPLICAS` (default 2) | 40 seconds |
| `worker` | Runs steps, agent turns and scheduled jobs | `WORKER_REPLICAS` (default 1) | 75 seconds |
| `migrate` | Runs once before the others, then exits | Do not scale | |
| `proxy` | Caddy: TLS, and shares requests across `web` | One | |
| `database` | Postgres | One, plus backups. See `docs/disaster-recovery.md` | |

```
docker compose --env-file .env.production --env-file .env.migrate up -d --scale web=4 --scale worker=3
```

Caddy finds the `web` replicas through the internal DNS every 5 seconds, and Prometheus finds both kinds the same way, so scaling changes nothing else. Each web replica can hold 18 database connections and each worker 25, so raise `POSTGRES_MAX_CONNECTIONS` with them.

## What replicas share

Nothing that matters lives in one process, so any replica can answer anyone.

| Thing | Where it lives | Tested by |
|---|---|---|
| Sessions | The database | `test/high-availability.test.ts` |
| Sign-in rate limits | The database | same |
| API rate limits | The database | same |
| Live text | Postgres `NOTIFY`, which reaches every replica | same |
| Migrations | Serialised by an advisory lock | same |
| Workspace limits on work | The database | `test/fair-queue.test.ts` |
| Uploaded files | The `workspace-files` volume | Not tested across hosts |

**Files limit you to one host.** Compose shares `workspace-files` between containers on one machine. To run replicas on several machines, that folder must be on shared storage. Compose gives protection against a process failing, not a machine failing. For a machine or region failing, see `docs/disaster-recovery.md`.

Metrics are per process, which is why Prometheus reads each replica itself. Totals read from the database, such as `queue_depth`, are the same on every replica, so alert rules take the `max` of them and never the `sum`.

## Sharing workers fairly

Each workspace has a limit on steps and agent turns running at once, across all workers: `WORKSPACE_WORK_LIMIT` (default 4), or the plan's limit in hosted mode.

- Work over the limit is written to `work_waiting` and never enters the shared queue, so a backlog in one workspace is never in front of another's. It is not failed, and in a run it simply shows as pending.
- When a place frees, the oldest waiting work in that workspace goes on the queue, with its place held for it.
- A running job holds a lease, renewed every 20 seconds, which expires after 60. If a worker dies, its place comes back by itself, and every worker sweeps for this every 10 seconds.

**Keep the limit below `WORKER_CONCURRENCY`.** If one workspace can fill a worker, others wait for that worker until something finishes. Total capacity is workers times concurrency, for steps and for turns separately.

The limit counts a turn waiting for a person's approval, for up to 15 minutes, because it holds a worker's slot all that time. A server with one workspace can raise the limit to suit it, since there is nobody else to be fair to.

## Stopping

`web`, on SIGTERM:

1. `/ready` starts failing.
2. It carries on answering for `SHUTDOWN_DRAIN_SECONDS`.
3. It ends live streams. Browsers reconnect to another replica by themselves, and polling shows everything regardless.
4. Requests in progress finish, for up to `SHUTDOWN_GRACE_SECONDS`.

Caddy runs active health checks only on fixed addresses, so with replicas found through DNS it notices a stopping replica when connections fail, and retries on another for up to 10 seconds.

`worker`, on SIGTERM, takes no new work and lets running work finish for up to `SHUTDOWN_GRACE_SECONDS`. Then it hands back what is left:

- A step goes back in line for another worker, and the attempt is not counted against it.
- An agent turn ends with a message asking the person to check what was done and send again, because its tools may already have acted, so it is never run twice.

`stop_grace_period` must be longer than these settings. A worker killed before then counts as a crash: its work is recovered, but only once its lease and heartbeat run out.

## Health addresses

| Address | Answers | Use it for |
|---|---|---|
| `/health` | The process is up | Nothing else: restarting would not fix what `/ready` finds |
| `/ready` | Can write to the database, migrations have run, the queue and live text work, and it is not stopping | Sending traffic or work |
| `/status` | A public summary, cached for 10 seconds, with no counts or names | A status page |
| `/metrics` | Numbers, with `METRICS_TOKEN`. Caddy hides it from outside | Prometheus |

A worker answers the first two and `/metrics` on `WORKER_HTTP_PORT`, which is off unless set.
