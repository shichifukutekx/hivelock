# Disaster recovery

## Targets

| | With continuous backup | With nightly dumps only |
|---|---|---|
| **RPO**, the most data you can lose | 1 minute, set by `archive_timeout` | 24 hours |
| **RTO**, the time to be serving again | 1 hour for database loss, 4 hours for region loss | The same, once a server is ready |

These are targets, not measurements. The only thing measured so far is the small local drill below, so run a drill at your own data size and put the real time here. A restore's time grows with the data, and WAL replay with how long ago the last base backup was.

Uploaded files are **not** in either backup. They live in the `workspace-files` volume, so back it up too, or a restored database will point at files that are gone. Run that on the same schedule as the dumps, for example with `tar` piped to `openssl` and copied off-site.

## What to keep, and where

Keep these apart from the backups and from each other. A backup is useless without its key, and a key kept beside its backup protects nothing.

| Item | Without it |
|---|---|
| `SECRETS_MASTER_KEY` | Saved secrets, connections and sealed content cannot be read, **even from a perfect backup** |
| `PGBACKREST_REPO*_CIPHER_PASS` | Continuous backups cannot be read |
| `BACKUP_PASSPHRASE` | Dumps cannot be read |
| `BETTER_AUTH_SECRET` | Everyone is signed out. Nothing is lost |
| `.env.production`, `.env.migrate`, `.env.backup` | They can be rebuilt, slowly, if you have the items above |

Put them in a password manager that at least two people can reach, and test once a year that you can read them from there.

## Setting up continuous backup

1. Create a bucket, and for the off-site copy a second one in another region or with another provider. Give each a key that can reach only that bucket, and turn on versioning or object lock, so that a stolen key cannot delete history.
2. Copy `deploy/backup/backup.env.example` to `.env.backup` and fill it in. `openssl rand -base64 48` makes each cipher pass.
3. Add the file to every Compose command:

```
docker compose -f compose.yaml -f deploy/backup/compose.yaml --env-file .env.production --env-file .env.migrate up -d --build
```

This restarts the database once, to turn archiving on. Then `backup-scheduler` creates the stanza and takes the first full backup without waiting for its schedule.

4. Check it: `docker compose ... exec backup-scheduler pgbackrest info`.

| When (UTC) | What | Copies |
|---|---|---|
| Within a minute of each change | WAL | Both buckets |
| Daily at `BACKUP_HOUR` | Base backup: full on Sundays, differential otherwise | Both buckets |
| Daily at `BACKUP_HOUR` | Encrypted dump | `backups` volume, plus `BACKUP_OFFSITE_COMMAND` |
| Mondays at `DRILL_HOUR` | Restore drill of each kind | Throwaway server |

Without the Compose option, schedule the scripts yourself:

```
0 2 * * *  cd /srv/hivelock && BACKUP_PASSPHRASE=... DATABASE_ADMIN_URL=... BACKUP_STATUS_DIR=backups/status scripts/backup.sh
0 4 * * 1  cd /srv/hivelock && BACKUP_PASSPHRASE=... scripts/restore-drill.sh
```

## The restore drill

`scripts/restore-drill.sh` restores the newest backup into a throwaway Postgres that it starts itself, with no network port, and removes afterwards. It cannot reach your real database. It checks:

- every counted table reads, against the counts recorded with the backup, and the audit log has not shrunk
- the audit chain is intact for every workspace
- row security is in force
- every migration this code has is in the backup

The result goes to `restore-drill.json` and `restore-drill.prom` in `BACKUP_STATUS_DIR`, and alerts fire if it fails or has not passed for 8 days. A drill does **not** check that `SECRETS_MASTER_KEY` opens the secrets, because it does not hold that key. `test/backup.test.ts` covers that the data survives a restore, and the key is yours to test.

`DRILL_ALLOW_PENDING=1` reports missing migrations without failing. It is for a backup taken just before an upgrade.

### Results

| Date | Machine | Source | Data | Result | Time |
|---|---|---|---|---|---|
| 2026-11-07 | Mac, Postgres 18.4 | Encrypted dump of a 13 MB dev database | Default: **failed**, correctly. Rows, audit chain and row security passed, and 3 migrations were missing, because that database had not yet been upgraded to this code | 1 second |
| 2026-11-07 | Same | Same backup, with `DRILL_ALLOW_PENDING=1` | Passed: 11 tables matched their recorded counts, including 30 audit entries, and the audit chain and row security held | 1 second |

The dev database is small, so this proves the procedure and says nothing about RTO at real size. **Neither continuous backup nor the drill's `pgbackrest` mode has been run yet.** Do both before relying on them.

## Runbooks

Before any of these, write down the time, and tell people. Do not delete anything broken until you are serving again: it may be your only copy.

### Database lost

The disk failed, the volume was deleted, or the data is corrupt. The machine is fine.

1. Stop the writers: `docker compose ... stop web worker backup-scheduler`.
2. If the volume survives, copy it aside first.
3. Remove the damaged volume, after that copy: `docker compose ... rm -sf database`, then `docker volume rm <project>_database`.
4. Restore. pgBackRest needs an empty data folder, and Postgres must not be running:

```
docker compose ... run --rm --no-deps --user postgres --entrypoint bash database -c \
  'mkdir -p "$PGBACKREST_PG1_PATH" && chmod 700 "$PGBACKREST_PG1_PATH" && pgbackrest restore'
```

To go to a moment before a bad change, add `--type=time --target="2026-01-15 09:30:00+00" --target-action=promote` after `restore`.

5. Start it: `docker compose ... up -d database`. It replays WAL, then opens. `docker compose ... logs -f database` shows progress.
6. Check it: run the checks below.
7. Start the rest: `docker compose ... up -d`.
8. Take a new full backup, because history has forked: `docker compose ... exec backup-scheduler pgbackrest --type=full backup`.

Without continuous backup, use the newest dump and `scripts/restore.sh`, as in "Going back" in `docs/upgrades.md`.

### Region lost

The machine and everything near it are gone, perhaps the first bucket too.

1. In another region, install Docker and get this repository at the version you ran.
2. Fetch `.env.production`, `.env.migrate` and `.env.backup` from your password manager.
3. If the first bucket is gone, restore from the second: add `--repo=2` to `pgbackrest restore` in the steps above.
4. Build and start only the database image's restore, as in "Database lost" steps 4 and 5.
5. Restore the `workspace-files` volume from its copy.
6. Point `DOMAIN` at the new address. Caddy gets a certificate once DNS arrives, so keep the record's TTL low in normal times.
7. Run the checks below, then start the rest.
8. Set up new buckets, because the old region's backup history must not be mixed with the new one's.

Data written after the last WAL reached the surviving bucket is lost. Say so to customers, with the time.

### Key lost

**`SECRETS_MASTER_KEY` lost, and no copy anywhere.** This cannot be recovered, and restoring a backup does not help, because it is encrypted with the same key.

1. Set a new key: `openssl rand -base64 32`.
2. Everything else in the app keeps working. Saved secrets, connection credentials and sealed run content cannot be read.
3. Tell each workspace owner to enter their secrets and connections again. Rotate those secrets at their source as well if the loss could also be a theft.
4. Old runs stay in the database but cannot be opened.

**`SECRETS_MASTER_KEY` may have been stolen, but you still have it.** Follow `docs/key-rotation.md`, then rotate every secret at its source, because a thief may hold old backups too.

**`BETTER_AUTH_SECRET` lost or stolen.** Set a new one and restart. Everyone signs in again. Nothing else changes.

**`BACKUP_PASSPHRASE` or a cipher pass lost.** Backups made with it cannot be read, so act while the database is healthy. Set a new one, take a new backup at once, confirm with a drill, and only then let the old ones age out. A pgBackRest cipher pass cannot be changed on an existing repository, so that means a new stanza and bucket.

**`METRICS_TOKEN` or a storage key stolen.** Replace it and restart. Check the bucket's access log for anything deleted.

### Failed upgrade

`scripts/upgrade.sh` prints what to do, and depends on how far it got.

- **It stopped at the backup.** Nothing changed.
- **It stopped at a migration.** A migration rolls back whole, so the database is as it was and the old version keeps serving. Fix the problem and run it again.
- **It stopped in the rolling restart.** The failing new container was removed, and the rest are still on the old version, which works on the new schema. Find out why with the printed logs. Nothing needs restoring.
- **It finished, but the new version misbehaves.** Put the old image back, and replace the containers: `HIVELOCK_IMAGE=<old tag> ROLLING_SERVICES="worker web" ...` with a `MIGRATE_COMMAND` of `true`. The migration rules keep the old code working on the new schema for one release, so this needs no restore and loses nothing.
- **A migration damaged data.** Only then restore, which loses what was written since. With continuous backup, restore to the moment before the upgrade, as in "Database lost". Otherwise use the backup the script printed. Keep the `SECRETS_MASTER_KEY` that was in use then.

### Checks after any restore

```
curl -s https://your-domain/ready     # every check says ok
curl -s https://your-domain/status    # status is ok once workers are running
```

Then in the app: sign in, open a saved connection to prove secrets can be read, run a small workflow, and open a workspace's audit log, which verifies the chain. `work_waiting` and `work_leases` come back from the backup as they were, and any leases expire by themselves, so no clean-up is needed.
