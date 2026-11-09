import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getMigrations } from "better-auth/db/migration";
import { escapeIdentifier, escapeLiteral, type Pool } from "pg";
import { PgBoss } from "pg-boss";
import { createAuth } from "./auth.ts";
import { createPool } from "./db.ts";
import { ensureQueues } from "./engine/queue.ts";
import { adminUrl, loadEnv, type PlatformEnv } from "./env.ts";
import { extensions, loadExtensions } from "./extensions.ts";

const migrationsDir = fileURLToPath(new URL("./migrations/", import.meta.url));
/** Any fixed number. Only migrations take this lock. */
const MIGRATION_LOCK = 7_460_321;

interface Migration { name: string; path: string; replaces: string[] }

const inFolder = (directory: string): Migration[] => readdirSync(directory).filter((file) => file.endsWith(".sql")).sort().map((name) => {
  const path = join(directory, name);
  return { name, path, replaces: [...readFileSync(path, "utf8").matchAll(/^-- replaces: (\S+)$/gm)].map((match) => match[1]!) };
});

/**
 * The core's migrations in name order, then each extension's, so the order never depends on what else is installed.
 *
 * schema_migrations records names, so a recorded name means that file's work is done. That is why a migration keeps its name when it moves.
 * One file that had to be cut in two works like this: the part that moved keeps the old name, and the part that stayed takes a new name and
 * says `-- replaces: <old name>`. A database that ran the old file then counts as having both. A database that ran only the new part has
 * no record of the old name, so the moved part still runs when the package is added.
 * Two files with one name could never both run, so that is refused.
 */
export function migrationsInOrder(directory = migrationsDir) {
  const all = directory === migrationsDir
    ? [...inFolder(directory), ...extensions().flatMap(({ migrations }) => (migrations ? inFolder(migrations) : []))]
    : inFolder(directory);
  const seen = new Set<string>();
  for (const { name } of all) {
    if (seen.has(name)) throw new Error(`Two migrations are named ${name}. Only one of them would ever run.`);
    seen.add(name);
  }
  return all;
}

/** Makes the login in an address, or brings it back to this if someone changed it. It starts with no rights at all. */
async function limitedRole(admin: Pool, address: URL) {
  const name = decodeURIComponent(address.username);
  const role = escapeIdentifier(name);
  const password = escapeLiteral(decodeURIComponent(address.password));
  const { rows } = await admin.query("select 1 from pg_roles where rolname = $1", [name]);
  await admin.query(rows.length
    ? `alter role ${role} login nosuperuser nocreatedb nocreaterole nobypassrls password ${password}`
    : `create role ${role} login nosuperuser nocreatedb nocreaterole nobypassrls password ${password}`);
}

/**
 * Prepares the database as the admin role. The running app only ever connects as the limited role.
 * `directory` lets a test start from an older set of migrations.
 */
export async function migrate(env: PlatformEnv, { directory = migrationsDir }: { directory?: string } = {}) {
  await loadExtensions();
  const adminAddress = adminUrl(env);
  // One more than it takes to work, because the lock below keeps a connection for itself.
  const admin = createPool(adminAddress, 3);
  const app = new URL(env.DATABASE_URL);
  const appRole = escapeIdentifier(decodeURIComponent(app.username));
  // Held to the end, so replicas that start together take turns. The second finds nothing left to do.
  const lock = await admin.connect();
  try {
    await lock.query("select pg_advisory_lock($1)", [MIGRATION_LOCK]);
    // Audit checks and webhook lookups run as this role, and row security would hide rows from them otherwise.
    const { rows: [self] } = await admin.query("select rolsuper or rolbypassrls as allowed from pg_roles where rolname = current_user");
    if (!self?.allowed) throw new Error("DATABASE_ADMIN_URL needs a role with SUPERUSER or BYPASSRLS.");

    await limitedRole(admin, app);

    const { runMigrations } = await getMigrations(createAuth(admin, env).options);
    await runMigrations();

    await admin.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    // One connection throughout: a pool may give each statement a different one, which would leave no transaction.
    const db = await admin.connect();
    try {
      for (const { name, path, replaces } of migrationsInOrder(directory)) {
        const { rowCount } = await db.query("select 1 from schema_migrations where name = any($1::text[])", [[name, ...replaces]]);
        if (rowCount) continue;
        await db.query("begin");
        try {
          await db.query(readFileSync(path, "utf8"));
          await db.query("insert into schema_migrations (name) values ($1)", [name]);
          await db.query("commit");
        } catch (error) {
          await db.query("rollback");
          throw error;
        }
      }
    } finally {
      db.release();
    }

    // The queue manages its own tables, so it is installed here and used by the limited role afterwards.
    const boss = new PgBoss({ connectionString: adminAddress, max: 2, schedule: false, supervise: false });
    boss.on("error", (error: Error) => console.error(error.message));
    await boss.start();
    await ensureQueues(boss);
    await boss.stop({ graceful: false });

    // A table with row security and no policy is for its own functions alone. That is found from the table itself, so it stays true whichever package made the table.
    const tables = await admin.query<{ tablename: string; closed: boolean }>(
      `select t.tablename, t.rowsecurity and not exists (select 1 from pg_policies p where p.schemaname = t.schemaname and p.tablename = t.tablename) as closed
       from pg_tables t where t.schemaname = 'public'`,
    );
    await admin.query(`grant usage on schema public to ${appRole}`);
    for (const { tablename, closed } of tables.rows) {
      if (tablename === "schema_migrations") continue;
      // Server-wide, so only their own functions reach them. Stated here so that no later grant adds it by accident.
      if (closed) {
        await admin.query(`revoke all on ${escapeIdentifier(tablename)} from ${appRole}`);
        continue;
      }
      const rights = tablename === "audit_events" ? "select, insert"
        // Pruning needs delete. A saved version is never edited.
        : tablename === "workflow_versions" ? "select, insert, delete"
        : "select, insert, update, delete";
      await admin.query(`grant ${rights} on ${escapeIdentifier(tablename)} to ${appRole}`);
    }
    await admin.query(`revoke update, delete, truncate on audit_events from ${appRole}`);
    await admin.query(`grant execute on function audit_chain_break(text) to ${appRole}`);
    await admin.query(`grant execute on function webhook_trigger(uuid) to ${appRole}`);
    await admin.query(`grant execute on function audit_chain_head(text) to ${appRole}`);
    await admin.query(`grant execute on function platform_metrics() to ${appRole}`);
    const functions = await admin.query<{ name: string }>(
      "select oid::regprocedure::text as name from pg_proc where proname = any($1::text[]) and pronamespace = 'public'::regnamespace",
      [["platform_mail_read", "platform_mail_write", "platform_audit_page", "work_admit", "work_acquire", "work_renew", "work_release", "work_claim", "work_sweep", "worker_left", "work_depth", "workers_alive", "applied_migrations", ...extensions().flatMap(({ databaseFunctions }) => databaseFunctions ?? [])]],
    );
    for (const { name } of functions.rows) await admin.query(`grant execute on function ${name} to ${appRole}`);
    // Stated here and not left to the migrations, because a database may already have granted these to the app role.
    for (const { address, functions: named } of extensions().flatMap(({ databaseRoles }) => databaseRoles ?? [])) {
      const { rows: own } = await admin.query<{ name: string }>(
        "select oid::regprocedure::text as name from pg_proc where proname = any($1::text[]) and pronamespace = 'public'::regnamespace", [named],
      );
      for (const { name } of own) await admin.query(`revoke all on function ${name} from ${appRole}, public`);
      const setting = address(process.env);
      if (!setting) continue;
      const login = new URL(setting);
      if (login.username === app.username) throw new Error("A package's database role must not be the app role, or the app role would keep what this takes away.");
      await limitedRole(admin, login);
      const role = escapeIdentifier(decodeURIComponent(login.username));
      await admin.query(`grant usage on schema public to ${role}`);
      for (const { name } of own) await admin.query(`grant execute on function ${name} to ${role}`);
    }
    // A test that starts from older migrations has none of a package's tables yet.
    if (directory === migrationsDir) for (const { prepareDatabase } of extensions()) await prepareDatabase?.(admin, env);
    await admin.query(`grant usage, create on schema pgboss to ${appRole}`);
    await admin.query(`grant all on all tables in schema pgboss to ${appRole}`);
    await admin.query(`grant all on all sequences in schema pgboss to ${appRole}`);
    await admin.query(`grant execute on all functions in schema pgboss to ${appRole}`);
  } finally {
    // Ending the connection frees the lock too, if this fails.
    await lock.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => {});
    lock.release();
    await admin.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await loadExtensions();
  await migrate(loadEnv());
  console.log("Database is up to date.");
}
