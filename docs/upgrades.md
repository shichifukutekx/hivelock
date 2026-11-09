# Upgrading

## The short version

Run this from the new version's folder, with the app's settings in the environment:

```
BACKUP_PASSPHRASE=... scripts/upgrade.sh
```

It does these in order, and stops at the first failure:

1. Writes an encrypted backup with `scripts/backup.sh`, and checks that it can be read.
2. Runs the migrations. They take a lock, so two started together run one after the other.
3. Replaces each service in `ROLLING_SERVICES` one container at a time, or runs `RESTART_COMMAND`, if you set one.
4. Checks the app's `/ready` address.

If a step after the backup fails, it prints how to restore that backup. If the backup itself fails, nothing was changed.

| Setting | Meaning | Default |
|---|---|---|
| `DATABASE_ADMIN_URL` | Needed for the backup and migrations, not by the running app | required here |
| `BACKUP_PASSPHRASE` | Encrypts the backup | required |
| `MIGRATE_COMMAND` | How to run migrations | `npm run db:migrate` |
| `ROLLING_SERVICES` | Compose services to replace one container at a time | none |
| `COMPOSE_COMMAND` | How to call Compose for that | `docker compose` |
| `HEALTH_TIMEOUT` | Seconds a new container gets to report healthy | 120 |
| `STOP_TIMEOUT` | Seconds an old container gets to finish its work | 80 |
| `RESTART_COMMAND` | Moves the app to the new version, where there is no Compose | none |
| `READY_URL` | The app's readiness address | `http://127.0.0.1:$PLATFORM_PORT/ready` |
| `READY_ATTEMPTS`, `READY_DELAY` | How long to wait for it | 30 tries, 2 seconds apart |

`/ready` shows that the app can write to the database, that this code's migrations have run, and that the queue and live text are working. It cannot show that the new version behaves, so check the app yourself after an upgrade too.

Without either, the check runs against the old version on the new schema, which the rule below keeps safe. Restart afterwards to finish.

With containers, build the new images first, then:

```
PG_DUMP_COMMAND="docker compose --env-file .env.production --env-file .env.migrate exec -T database pg_dump --format=custom -U agent_platform_admin agent_platform" \
PG_RESTORE_COMMAND="docker compose --env-file .env.production --env-file .env.migrate exec -T database pg_restore" \
MIGRATE_COMMAND="docker compose --env-file .env.production --env-file .env.migrate run --rm migrate" \
COMPOSE_COMMAND="docker compose --env-file .env.production --env-file .env.migrate" \
ROLLING_SERVICES="worker web" \
READY_URL="https://your-domain/ready" \
BACKUP_PASSPHRASE=... scripts/upgrade.sh
```

A rolling restart adds one new container, waits for its health check, then stops one old one, and repeats. The old container finishes its requests or work first, and the count of healthy containers never drops. If a new container fails its check it is removed, the upgrade stops, and the rest stay on the old version, which the rule below keeps safe.

The database has no open port under Compose, so the two `PG_` settings run those tools inside its container. Without them, `scripts/upgrade.sh` runs `pg_dump` on the machine you start it from, and `DATABASE_ADMIN_URL` must be reachable from there. `scripts/backup.sh` takes `PG_DUMP_COMMAND` too, for scheduled backups. These commands, including the rolling restart, have not been run against real Docker yet.

## Going back

1. Stop the app and put the previous version's code back.
2. Create an empty database. The limited app role must already exist on the server.
3. `BACKUP_PASSPHRASE=... RESTORE_DATABASE_URL=<empty database URL> scripts/restore.sh <backup file>`
4. Point `DATABASE_URL` and `DATABASE_ADMIN_URL` at it and start the app.

Use the `SECRETS_MASTER_KEY` that was in use when the backup was taken. Anything written after the backup is lost.

## Rules for writing migrations

**A migration must work with the previous version of the app, for one release.**

During an upgrade the old code runs on the new schema until the restart. If something goes wrong, you may also want to run the old code a little longer. So:

- Add new tables and columns. A new column must be nullable or have a default.
- To remove or rename something, do it across two releases. The first stops using it, and the second removes it. A rename is: add the new column, write to both, copy the old rows, then later drop the old one.
- Do not tighten a constraint the old code could break in the same release that the code starts obeying it.
- Do not change what a stored value means, such as the format of encrypted data.

And:

- Number files in order, `NNN_name.sql`. Never edit one that has been released.
- Each file runs in one transaction, and rolls back whole if it fails. Do not use statements that cannot run in a transaction, such as `create index concurrently`.
- Think about locks. A long rewrite of a big table blocks the app while it runs.
- A table that can hold workspace data needs row-level security, forced, with the `workspace_only` policy. `src/platform/migrate.ts` grants the limited role access to every table, so a table it must not reach needs an exception there.
- Any new encrypted column goes in `ENCRYPTED_COLUMNS` in `src/platform/rotate-keys.ts`. The paid package lists its own in its entry file, and its key rotation test fails if one is left out.

The paid package's upgrade tests build a database from the migrations through 009, and from all 14 as they stood before the split, fill it with real data, and apply the rest. When you add a migration that changes those tables, add rows for it to its seed file.

## Upgrading to the separate operator login

This applies to the hosted version only. Add `DATABASE_OPERATOR_URL` to `.env.production` before you upgrade, with its own role name and password, because the hosted web server will not start without it. The migrate step creates the role. Self-hosted servers need nothing.

Web replicas still on the old code lose staff actions, support answers and `/api/v1/me` as soon as the migration runs, so stop them first on this one upgrade.

## Upgrading to editions

The paid package's migration `014_platform_license.sql` adds the licence key store. After this upgrade, a self-hosted server with no licence key runs as Community. Nothing is deleted, but paid connectors stop running and the features in `docs/editions.md` lock. Add a licence key under Settings, or set `HIVELOCK_LICENSE_KEY`, to carry on as before.

## Upgrading across the split into core and paid package

Paid tables moved to the paid package. This needs nothing from you, and no table is touched. A database that has run all 14 migrations stays exactly as it is.

- `schema_migrations` records names, so a recorded name means the work is done. A file that moved keeps its name.
- Four files held both core and paid tables, and were cut in two. The paid part kept the old name. The core part took a new name and starts with `-- replaces: <old name>`, so it counts as done wherever the old name is recorded. Its own name is never added to such a database.
- A database that began on the core alone has no record of the old names, so the paid parts run when the package is added.
- The core's files always run first, then the package's, each in name order. Two files with one name are refused.
