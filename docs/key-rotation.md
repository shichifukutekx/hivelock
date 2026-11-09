# Rotating SECRETS_MASTER_KEY

`SECRETS_MASTER_KEY` encrypts stored secrets, connection credentials, webhook signing secrets, model provider keys, the saved mail password, and sealed run, chat, knowledge, channel, memory and approval data.

While a rotation is under way the app reads with either key and writes only with the new one, so it can keep running.

## Before you start

- Take a backup with `scripts/backup.sh`.
- Keep the **old** key for as long as you keep backups made under it. A backup can only be read with the key in use when it was taken. Label them together, and store the key apart from the backups.
- Finish any earlier rotation first. Only one previous key is supported.

## Steps

1. Generate a new key.

   ```
   openssl rand -base64 32
   ```

2. Set both keys in the server's settings. The new key goes in `SECRETS_MASTER_KEY`, and the old key moves to `SECRETS_MASTER_KEY_PREVIOUS`.

3. Restart the API and every worker. All of them must be on the new settings before the next step, or an old process can write under the old key.

4. Rotate. This needs `DATABASE_ADMIN_URL`, because it must see every workspace's rows.

   ```
   npm run keys:rotate
   ```

   With containers: `docker compose --env-file .env.production --env-file .env.migrate run --rm migrate node --import tsx src/platform/rotate-keys.ts`

5. Read the result. It must end with `Verified: every value opens with the current key alone.` and exit with status 0. If it does not, see below, and keep the previous key.

6. Remove `SECRETS_MASTER_KEY_PREVIOUS` from the settings.

7. Restart the API and every worker.

8. Take a fresh backup. This is the first one under the new key alone.

## How it behaves

- Each value commits on its own, so the command can be stopped at any time and run again. Values already under the new key are skipped.
- A row the app changes during rotation is left alone, because the app writes under the new key anyway. The final check confirms it.
- It prints counts, and row ids for anything unreadable. It never prints values or keys.
- It refuses to run without a previous key, with both keys the same, or with a database role that cannot see all rows.

## If it does not verify

- **Values open with neither key.** They are listed by table and id and are left exactly as they were. Usually `SECRETS_MASTER_KEY_PREVIOUS` is mistyped, or the rows date from an even older key. Correct the setting, restart and run again. If the key is really gone, those values cannot be recovered: re-enter them in the app, or delete the rows.
- **Columns rotation does not know about.** A new feature stores sealed values in a column missing from `ENCRYPTED_COLUMNS` in `src/platform/rotate-keys.ts`. Do not remove the previous key. Add the column and run again.
- **Values still under the old key, with nothing unreadable.** A process was probably still on the old settings. Restart everything and run again.

## What it does not cover

- **The audit log** is append-only and is never changed. The app does not put sealed values in it. If a future change did, the command reports how many rows hold them, and those stay under the old key. Rotation still verifies, because the app never opens them.
- **`BETTER_AUTH_SECRET`** is a separate key. It protects sessions and two-step verification secrets, and this command does not touch it.
- **Words in the document search index** are stored unencrypted, because keyword search needs them. Rotation has no effect on them.
- **Files in the `workspace-files` volume** are not encrypted with this key.
- **`secrets.key_version`** is the key derivation format, not a count of rotations, so it does not change.

If you suspect the key was stolen, rotating protects new and re-encrypted data, but anyone holding an old backup and the old key can still read that backup. Replace the credentials stored in the platform as well.
