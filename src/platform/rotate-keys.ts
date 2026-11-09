import { pathToFileURL } from "node:url";
import { escapeIdentifier as id, type Pool } from "pg";
import { connectionSecretName } from "./connectors/store.ts";
import { createPool } from "./db.ts";
import { adminUrl, loadEnv, type PlatformEnv } from "./env.ts";
import { extensions, loadExtensions } from "./extensions.ts";
import { MAIL_PASSWORD_NAME, MAIL_SCOPE } from "./mailer.ts";
import { keyName } from "./model-providers.ts";
import { webhookSecretName } from "./routes/webhooks.ts";
import { decryptWithKey, encryptSecret, packSealed, sealName, unpackSealed } from "./secrets.ts";

const BATCH = 500;
/** How many unreadable rows the report names. The counts stay exact. */
const MAX_LISTED = 200;

interface Binary {
  kind: "binary";
  table: string;
  key: string[];
  columns: [ciphertext: string, iv: string, tag: string];
  /** What the value is bound to, which must match how it was first encrypted. */
  name: (row: any) => string;
  /** Other columns `name` reads. */
  also?: string[];
  /** Set for the one value outside any workspace. */
  scope?: string;
}
interface Sealed {
  kind: "json" | "text";
  table: string;
  key: string[];
  column: string;
}
export type EncryptedColumn = Binary | Sealed;

const json = (table: string, column: string, key = ["id"]): Sealed => ({ kind: "json", table, key, column });

/**
 * Every place in the core an encrypted value is stored. test/key-rotation.test.ts fails when a new one appears without being added here.
 * audit_events is left out on purpose: it is append-only.
 */
export const ENCRYPTED_COLUMNS: EncryptedColumn[] = [
  { kind: "binary", table: "secrets", key: ["id"], columns: ["ciphertext", "iv", "tag"], name: (row) => row.name, also: ["name"] },
  { kind: "binary", table: "connections", key: ["id"], columns: ["ciphertext", "iv", "tag"], name: (row) => connectionSecretName(row.id) },
  { kind: "binary", table: "triggers", key: ["id"], columns: ["secret_ciphertext", "secret_iv", "secret_tag"], name: (row) => webhookSecretName(row.id) },
  { kind: "binary", table: "model_providers", key: ["id"], columns: ["key_ciphertext", "key_iv", "key_tag"], name: (row) => keyName(row.id) },
  { kind: "binary", table: "platform_mail_settings", key: ["only_row"], columns: ["password_ciphertext", "password_iv", "password_tag"], name: () => MAIL_PASSWORD_NAME, scope: MAIL_SCOPE },
  json("runs", "input"),
  // Holds each last step's sealed output, nested under the step's id.
  json("runs", "output"),
  json("run_steps", "output"),
  { kind: "text", table: "run_steps", key: ["id"], column: "error" },
  json("run_events", "event"),
  json("run_effects", "result", ["run_id", "node_id"]),
  json("agent_messages", "content"),
  json("agent_activity", "event"),
  json("agent_approvals", "args"),
  json("agent_memories", "content"),
  json("company_notes", "content"),
  json("agent_sessions", "contact"),
  json("knowledge_chunks", "content"),
];

/** The list above and whatever an extension adds. Values in a table this install does not know are reported as unlisted, so the old key is not given up by mistake. */
export const encryptedColumns = () => [...ENCRYPTED_COLUMNS, ...extensions().flatMap((extension) => extension.encryptedColumns ?? [])];

const label = (column: EncryptedColumn) => `${column.table}.${column.kind === "binary" ? column.columns[0] : column.column}`;

type Encrypted = { ciphertext: Buffer; iv: Buffer; tag: Buffer };
interface Keys { current: string; previous?: string }

/** Which key opens a value: "current", "previous", or undefined for neither. Each key is tried alone. */
function underKey({ current, previous }: Keys, workspaceId: string, name: string, stored: Encrypted) {
  const tryKey = (key: string) => {
    try {
      return decryptWithKey(key, workspaceId, name, stored);
    } catch {
      return undefined;
    }
  };
  if (tryKey(current) !== undefined) return { state: "current" as const };
  const plain = previous ? tryKey(previous) : undefined;
  return plain === undefined ? { state: "unreadable" as const } : { state: "previous" as const, plain };
}

interface Tally { current: number; previous: number; unreadable: number }

/** Walks a value as unseal does, and rebuilds it with every old sealed value under the current key. */
function rewalk(keys: Keys, workspaceId: string, value: any, tally: Tally): any {
  if (Array.isArray(value)) return value.map((item) => rewalk(keys, workspaceId, item, tally));
  if (value === null || typeof value !== "object") return value;
  if (typeof value.$sealed === "string") {
    const name = sealName(workspaceId);
    let opened: ReturnType<typeof underKey>;
    try {
      opened = underKey(keys, workspaceId, name, unpackSealed(value.$sealed));
    } catch {
      opened = { state: "unreadable" };
    }
    tally[opened.state] += 1;
    if (opened.state !== "previous") return value;
    return { $sealed: packSealed(encryptSecret(keys.current, workspaceId, name, opened.plain)) };
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewalk(keys, workspaceId, item, tally)]));
}

/** The sealed structure in a row, or undefined for text that was never sealed. */
function sealedIn(column: Sealed, row: any) {
  const value = row[column.column];
  if (column.kind === "json") return value;
  if (!value.startsWith('{"$sealed"')) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    // It claims to be sealed and is not whole, so it counts as unreadable and stays as it is.
    return { $sealed: "" };
  }
}

/** Reads a table in key order, so it can be stopped at any point and started again. */
async function* rows(pool: Pool, column: EncryptedColumn) {
  const key = column.key.map(id).join(", ");
  const fixed = column.kind === "binary" && column.scope ? [column.scope] : [];
  const scope = fixed.length ? "$1::text as workspace_id" : "workspace_id";
  const wanted = (column.kind === "binary" ? [...column.columns, ...(column.also ?? [])] : [column.column]).map(id).join(", ");
  const notNull = id(column.kind === "binary" ? column.columns[0] : column.column);
  let after: unknown[] | undefined;
  for (;;) {
    const page = after ? `and (${key}) > (${column.key.map((_, i) => `$${fixed.length + i + 1}`).join(", ")})` : "";
    const { rows: found } = await pool.query(
      `select ${key}, ${scope}, ${wanted} from ${id(column.table)} where ${notNull} is not null ${page} order by ${key} limit ${BATCH}`,
      [...fixed, ...(after ?? [])],
    );
    yield* found;
    if (found.length < BATCH) return;
    const last = found.at(-1)!;
    after = column.key.map((name) => last[name]);
  }
}

const keyParams = (column: EncryptedColumn, row: any, from: number) => ({
  where: column.key.map((name, i) => `${id(name)} = $${from + i}`).join(" and "),
  values: column.key.map((name) => row[name]),
});

/**
 * Writes one value, each in its own commit. Comparing the old value means a change the app made
 * in the meantime is never overwritten; the app writes under the current key anyway.
 */
async function writeBinary(pool: Pool, column: Binary, row: any, next: Encrypted) {
  const [ciphertext, iv, tag] = column.columns.map(id);
  const { where, values } = keyParams(column, row, 7);
  const { rowCount } = await pool.query(
    `update ${id(column.table)} set ${ciphertext} = $1, ${iv} = $2, ${tag} = $3 where ${ciphertext} = $4 and ${iv} = $5 and ${tag} = $6 and ${where}`,
    [next.ciphertext, next.iv, next.tag, row[column.columns[0]], row[column.columns[1]], row[column.columns[2]], ...values],
  );
  return rowCount === 1;
}

export async function writeSealed(pool: Pool, column: Sealed, row: any, next: string) {
  const cast = column.kind === "json" ? "::jsonb" : "";
  const { where, values } = keyParams(column, row, 3);
  const old = column.kind === "json" ? JSON.stringify(row[column.column]) : row[column.column];
  const { rowCount } = await pool.query(`update ${id(column.table)} set ${id(column.column)} = $1${cast} where ${id(column.column)} = $2${cast} and ${where}`, [next, old, ...values]);
  return rowCount === 1;
}

export interface ColumnReport { column: string; rotated: number; alreadyCurrent: number; unreadable: number; changedMeanwhile: number }

async function rotateColumn(pool: Pool, column: EncryptedColumn, keys: Keys, onUnreadable: (row: string) => void) {
  const report: ColumnReport = { column: label(column), rotated: 0, alreadyCurrent: 0, unreadable: 0, changedMeanwhile: 0 };
  const rowId = (row: any) => `${label(column)} ${column.key.map((name) => row[name]).join("/")}`;
  for await (const row of rows(pool, column)) {
    if (column.kind === "binary") {
      const [ciphertext, iv, tag] = column.columns.map((name) => row[name]);
      const name = column.name(row);
      const opened = underKey(keys, row.workspace_id, name, { ciphertext, iv, tag });
      if (opened.state === "current") report.alreadyCurrent += 1;
      else if (opened.state === "unreadable") {
        report.unreadable += 1;
        onUnreadable(rowId(row));
      } else if (await writeBinary(pool, column, row, encryptSecret(keys.current, row.workspace_id, name, opened.plain))) report.rotated += 1;
      else report.changedMeanwhile += 1;
      continue;
    }
    const original = sealedIn(column, row);
    if (original === undefined) continue;
    const tally: Tally = { current: 0, previous: 0, unreadable: 0 };
    const rebuilt = rewalk(keys, row.workspace_id, original, tally);
    report.alreadyCurrent += tally.current;
    // A row is rewritten whole, so one that is partly unreadable stays exactly as it was.
    if (tally.unreadable) {
      report.unreadable += tally.unreadable;
      onUnreadable(rowId(row));
    } else if (tally.previous) {
      if (await writeSealed(pool, column, row, JSON.stringify(rebuilt))) report.rotated += tally.previous;
      else report.changedMeanwhile += 1;
    }
  }
  return report;
}

/** Counts anything that does not open with the current key alone. */
async function countNotCurrent(pool: Pool, column: EncryptedColumn, current: string) {
  const keys = { current };
  let notCurrent = 0;
  for await (const row of rows(pool, column)) {
    if (column.kind === "binary") {
      const [ciphertext, iv, tag] = column.columns.map((name) => row[name]);
      if (underKey(keys, row.workspace_id, column.name(row), { ciphertext, iv, tag }).state !== "current") notCurrent += 1;
      continue;
    }
    const original = sealedIn(column, row);
    if (original === undefined) continue;
    const tally: Tally = { current: 0, previous: 0, unreadable: 0 };
    rewalk(keys, row.workspace_id, original, tally);
    notCurrent += tally.unreadable;
  }
  return notCurrent;
}

// The exact shape seal() writes, so ordinary text that mentions the word does not count.
const SEALED_SHAPE = `"\\$sealed": *"[A-Za-z0-9+/=]+\\.[A-Za-z0-9+/=]+\\.[A-Za-z0-9+/=]+"`;

/** Looks through every other column for sealed values, because rotation can only cover what it knows about. */
export async function findSealedElsewhere(pool: Pool, known: EncryptedColumn[] = encryptedColumns()) {
  const listed = new Set(known.flatMap((column) => (column.kind === "binary" ? column.columns.map((name) => `${column.table}.${name}`) : [`${column.table}.${column.column}`])));
  const { rows: columns } = await pool.query<{ table_name: string; column_name: string; data_type: string }>(
    `select c.table_name, c.column_name, c.data_type from information_schema.columns c
     join information_schema.tables t using (table_schema, table_name)
     where c.table_schema = 'public' and t.table_type = 'BASE TABLE' and c.data_type in ('jsonb', 'json', 'text', 'character varying', 'bytea')
     order by 1, 2`,
  );
  const unlisted: string[] = [];
  let inAudit = 0;
  for (const { table_name: table, column_name: name, data_type: type } of columns) {
    const full = `${table}.${name}`;
    if (listed.has(full)) continue;
    const test = type === "bytea" ? `${id(name)} is not null` : `${id(name)}::text ~ $1`;
    const { rows: [row] } = await pool.query<{ found: number }>(`select count(*)::int as found from ${id(table)} where ${test}`, type === "bytea" ? [] : [SEALED_SHAPE]);
    if (!row!.found) continue;
    if (table === "audit_events") inAudit += row!.found;
    else unlisted.push(`${full}: ${row!.found}`);
  }
  return { unlisted, inAudit };
}

export interface RotationReport {
  columns: ColumnReport[];
  rotated: number;
  unreadable: number;
  /** Rows that could not be opened with either key, by table and id. Never their contents. */
  unreadableRows: string[];
  /** Values left that the current key alone cannot open. Zero means the previous key can go. */
  notCurrent: number;
  /** Columns outside the list that hold sealed values. Anything here is lost if the previous key goes. */
  unlisted: string[];
  /** Sealed values in the append-only audit log, which are not rotated. */
  inAudit: number;
  verified: boolean;
}

export async function rotateKeys(env: PlatformEnv): Promise<RotationReport> {
  const { SECRETS_MASTER_KEY: current, SECRETS_MASTER_KEY_PREVIOUS: previous } = env;
  if (!previous) throw new Error("Set SECRETS_MASTER_KEY_PREVIOUS to the old key before rotating.");
  if (previous === current) throw new Error("SECRETS_MASTER_KEY_PREVIOUS is the same as SECRETS_MASTER_KEY. Generate a new key first.");

  const pool = createPool(adminUrl(env), 2);
  try {
    // Row security would otherwise hide every row, and an empty result would look like success.
    const { rows: [self] } = await pool.query("select rolsuper or rolbypassrls as allowed from pg_roles where rolname = current_user");
    if (!self?.allowed) throw new Error("DATABASE_ADMIN_URL needs a role with SUPERUSER or BYPASSRLS.");

    const keys = { current, previous };
    const listed = encryptedColumns();
    const columns: ColumnReport[] = [];
    const unreadableRows: string[] = [];
    for (const column of listed) {
      columns.push(await rotateColumn(pool, column, keys, (row) => {
        if (unreadableRows.length < MAX_LISTED) unreadableRows.push(row);
      }));
    }

    let notCurrent = 0;
    for (const column of listed) notCurrent += await countNotCurrent(pool, column, current);
    const { unlisted, inAudit } = await findSealedElsewhere(pool);

    const total = (field: "rotated" | "unreadable") => columns.reduce((sum, column) => sum + column[field], 0);
    return {
      columns, rotated: total("rotated"), unreadable: total("unreadable"), unreadableRows, notCurrent, unlisted, inAudit,
      verified: notCurrent === 0 && unlisted.length === 0,
    };
  } finally {
    await pool.end();
  }
}

/** Counts and row ids only. No value, key or connection address is ever printed. */
function print(report: RotationReport) {
  for (const { column, rotated, alreadyCurrent, unreadable, changedMeanwhile } of report.columns) {
    console.log(`${column}: ${rotated} rotated, ${alreadyCurrent} already current, ${unreadable} unreadable${changedMeanwhile ? `, ${changedMeanwhile} changed during rotation` : ""}`);
  }
  console.log(`Rotated ${report.rotated} values.`);
  if (report.unreadable) {
    console.error(`${report.unreadable} values open with neither key. They were left untouched:`);
    for (const row of report.unreadableRows) console.error(`  ${row}`);
    if (report.unreadable > report.unreadableRows.length) console.error("  (list shortened; run again after fixing these to see the rest)");
  }
  if (report.unlisted.length) {
    console.error("Sealed values were found in columns rotation does not know about. Do not remove the previous key:");
    for (const line of report.unlisted) console.error(`  ${line}`);
  }
  if (report.inAudit) console.warn(`The audit log holds ${report.inAudit} rows with sealed values. The audit log cannot be changed, so these stay under the old key.`);
  if (report.verified) console.log("Verified: every value opens with the current key alone. The previous key can be removed.");
  else console.error(`Not verified: ${report.notCurrent} values do not open with the current key alone. Keep the previous key and run this again.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await loadExtensions();
    const report = await rotateKeys(loadEnv());
    print(report);
    process.exitCode = report.verified ? 0 : 1;
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
