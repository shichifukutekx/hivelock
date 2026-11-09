import { connect } from "node:net";
import type { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";
import mysql from "mysql2/promise";
import pg from "pg";
import Cursor from "pg-cursor";
import { z } from "zod";
import { resolvePublicHost, type NetworkPolicy } from "../net/safe-fetch.ts";
import { asPostgres, MYSQL_GUIDE, POSTGRES_GUIDE } from "./sql-dialect.ts";
import { PermanentError, registerConnector } from "./types.ts";

/** A real true or false. The text "false" must mean false, which z.coerce.boolean gets wrong. */
const flag = (fallback: boolean) => z.union([z.boolean(), z.enum(["true", "false"]).transform((value) => value === "true")]).default(fallback);

const credentials = z.object({
  engine: z.enum(["postgres", "mysql"]),
  host: z.string().min(1),
  port: z.coerce.number().int().optional(),
  database: z.string().min(1),
  user: z.string().min(1),
  password: z.string().default(""),
  ssl: flag(true),
  allowWrites: flag(false),
});
type Credentials = z.infer<typeof credentials>;

/** The driver's connection under its promise wrapper, which is the only part that can stream a prepared statement. */
interface StreamingConnection extends EventEmitter {
  stream: Duplex;
  execute(options: { sql: string; values: unknown[]; timeout: number }): EventEmitter;
}

const MAX_ROWS = 1_000;
const MAX_BYTES = 16 * 1024 * 1024;
const BATCH = 100;
const TIMEOUT_MS = 30_000;
const CLOSE_MS = 2_000;
const statement = z.object({
  sql: z.string().min(1).max(10_000),
  values: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).max(100).default([]),
});

interface Result {
  rows: unknown[];
  rowCount: number;
  truncated: boolean;
}

interface Session {
  run(sql: string, values: unknown[], readOnly: boolean): Promise<Result>;
  close(): Promise<void>;
}

/**
 * A connection can point at a server its tenant controls, so a statement may be answered with anything, or nothing.
 * Bytes are counted as they arrive, before any row exists, and going over either limit ends the connection.
 */
function limited<T>(socket: Duplex, work: () => Promise<T>) {
  return new Promise<T>((resolve, reject) => {
    let bytes = 0;
    const stop = (message: string) => {
      reject(new PermanentError(message));
      socket.destroy();
    };
    const count = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) stop(`The result was larger than the ${MAX_BYTES / 1024 / 1024} MB limit. Ask for fewer rows or columns.`);
    };
    const timer = setTimeout(() => stop("The statement took too long."), TIMEOUT_MS + 1_000);
    socket.on("data", count);
    work().then(resolve, reject).finally(() => {
      clearTimeout(timer);
      socket.off("data", count);
    });
  });
}

/** Ends politely if the other side plays along. */
async function closeSocket(socket: Duplex, ending: () => Promise<unknown>) {
  if (!socket.destroyed) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([ending().catch(() => {}), new Promise((resolve) => { timer = setTimeout(resolve, CLOSE_MS); })]);
    clearTimeout(timer);
  }
  socket.destroy();
}

/**
 * PostgreSQL sends exact decimals as text with every stored digit, such as 1011.0000000000000.
 * Trailing zeros are dropped, and a value a JavaScript number holds exactly becomes a number.
 */
export function tidyDecimal(text: string | null): string | number | null {
  if (text === null) return null;
  const trimmed = text.includes(".") ? text.replace(/\.?0+$/, "") : text;
  const digits = trimmed.replace(/^-/, "").replace(".", "").replace(/^0+/, "");
  return digits.length <= 15 && /^-?\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : trimmed;
}
const NUMERIC_OID = 1700;
const pgTypes = { getTypeParser: (oid: number, format?: string) => (oid === NUMERIC_OID ? tidyDecimal : (pg.types.getTypeParser as any)(oid, format)) };

async function open(c: Credentials, network: NetworkPolicy): Promise<Session> {
  const host = await resolvePublicHost(c.host, network);
  if (c.engine === "postgres") {
    const client = new pg.Client({
      host, port: c.port ?? 5432, database: c.database, user: c.user, password: c.password,
      ssl: c.ssl ? { rejectUnauthorized: true, servername: c.host } : false,
      connectionTimeoutMillis: 10_000, statement_timeout: TIMEOUT_MS, query_timeout: TIMEOUT_MS + 1_000, types: pgTypes as any,
    });
    client.on("error", () => {});
    await client.connect();
    const socket = (client as unknown as { connection: { stream: Duplex } }).connection.stream;
    return {
      run: (sql, values, readOnly) => limited(socket, async () => {
        await client.query(readOnly ? "begin transaction read only" : "begin");
        try {
          // The cursor's protocol allows one statement only, so "commit; delete ..." cannot end the read-only transaction.
          const cursor = client.query(new Cursor(sql, values));
          const next = () => new Promise<{ rows: unknown[]; rowCount?: number | null }>((resolve, reject) => {
            cursor.read(BATCH, (error, rows, result) => (error ? reject(error) : resolve({ rows, rowCount: result?.rowCount })));
          });
          const rows: unknown[] = [];
          let changed = 0;
          let returned = 0;
          for (;;) {
            const batch = await next();
            changed = batch.rowCount ?? changed;
            returned += batch.rows.length;
            // A write's returned rows have nowhere to go, so they are only read past.
            if (readOnly) rows.push(...batch.rows);
            if (rows.length > MAX_ROWS) {
              socket.destroy();
              return { rows: rows.slice(0, MAX_ROWS), rowCount: MAX_ROWS, truncated: true };
            }
            if (!batch.rows.length) break;
          }
          await client.query(readOnly ? "rollback" : "commit");
          // Read in batches, the server's own count covers only the last one.
          return { rows, rowCount: readOnly ? rows.length : returned || changed, truncated: false };
        } catch (error) {
          await client.query("rollback").catch(() => {});
          throw error;
        }
      }),
      close: () => closeSocket(socket, () => client.end()),
    };
  }
  const connection = await mysql.createConnection({
    // Connects to the checked address, while TLS still verifies the certificate against the name.
    host: c.host, port: c.port ?? 3306, database: c.database, user: c.user, password: c.password,
    stream: connect({ host, port: c.port ?? 3306 }),
    ssl: c.ssl ? { rejectUnauthorized: true } : undefined,
    connectTimeout: 10_000, multipleStatements: false,
    typeCast: (field: any, next: () => unknown) => (field.type === "NEWDECIMAL" || field.type === "DECIMAL" ? tidyDecimal(field.string()) : next()),
  });
  const core = (connection as unknown as { connection: StreamingConnection }).connection;
  const socket = core.stream;
  connection.on("error", () => {});
  core.on("error", () => {});
  /** With no callback the driver hands over each row as it arrives and keeps none. */
  const collect = (sql: string, values: unknown[], keepRows: boolean) => new Promise<Result>((resolve, reject) => {
    const rows: unknown[] = [];
    let changed = 0;
    const command = core.execute({ sql, values, timeout: TIMEOUT_MS });
    command.on("result", (row) => {
      if (row?.constructor?.name === "ResultSetHeader") changed = (row as { affectedRows: number }).affectedRows;
      else if (keepRows && rows.length === MAX_ROWS) {
        socket.destroy();
        resolve({ rows, rowCount: MAX_ROWS, truncated: true });
      } else if (keepRows) rows.push(row);
    });
    command.on("error", reject);
    command.on("end", () => resolve({ rows, rowCount: keepRows ? rows.length : changed, truncated: false }));
  });
  return {
    run: (sql, values, readOnly) => limited(socket, async () => {
      await connection.query(readOnly ? "start transaction read only" : "start transaction");
      try {
        const result = await collect(sql, values, readOnly);
        if (!result.truncated) await connection.query(readOnly ? "rollback" : "commit");
        return result;
      } catch (error) {
        await connection.query("rollback").catch(() => {});
        throw error;
      }
    }),
    close: () => closeSocket(socket, () => connection.end()),
  };
}

async function withSession<T>(connection: unknown, network: NetworkPolicy, work: (session: Session, c: Credentials) => Promise<T>) {
  const c = credentials.parse(connection);
  const session = await open(c, network);
  try {
    return await work(session, c);
  } catch (error) {
    // The database refused the statement, and a second try would get the same answer.
    const { code, sqlState } = error as { code?: string; sqlState?: string };
    if (sqlState || /^[0-9A-Z]{5}$/.test(code ?? "")) {
      // A syntax error says which dialect to write, so the next try can be right.
      const hint = (sqlState ?? code) === "42601" ? ` ${c.engine === "mysql" ? MYSQL_GUIDE : POSTGRES_GUIDE}` : "";
      throw new PermanentError(`${(error as Error).message}${hint}`);
    }
    throw error;
  } finally {
    await session.close().catch(() => {});
  }
}

registerConnector({
  name: "database",
  label: "Database",
  category: "database",
  description: "Query PostgreSQL or MySQL. Read-only unless you turn on writes for this connection.",
  fields: [
    { name: "engine", label: "Type (postgres or mysql)", type: "text", required: true },
    { name: "host", label: "Host", type: "text", required: true },
    { name: "port", label: "Port", type: "number" },
    { name: "database", label: "Database", type: "text", required: true },
    { name: "user", label: "User", type: "text", required: true, help: "Use an account with only the access it needs." },
    { name: "password", label: "Password", type: "password" },
    { name: "ssl", label: "Use TLS", type: "boolean", default: true, help: "Turn off only for a database on the same private network as this server." },
    { name: "allowWrites", label: "Allow changes", type: "boolean", default: false },
  ],
  credentials,
  actions: {
    query: {
      label: "Read data",
      changesData: false,
      params: statement,
      guide: (connection) => (connection?.engine === "mysql" ? MYSQL_GUIDE : POSTGRES_GUIDE),
      run: (connection, params, { network }) => withSession(connection, network, async (session, c) => {
        const { sql, values } = statement.parse(params);
        return session.run(c.engine === "postgres" ? asPostgres(sql, values) : sql, values, true);
      }),
    },
    execute: {
      label: "Change data",
      changesData: true,
      params: statement,
      run: (connection, params, { network }) => withSession(connection, network, async (session, c) => {
        if (!c.allowWrites) throw new PermanentError("This connection is read-only.");
        const { sql, values } = statement.parse(params);
        const { rowCount } = await session.run(sql, values, false);
        return { rowCount };
      }),
    },
  },
  test: (connection, { network }) => withSession(connection, network, async (session) => {
    await session.run("select 1", [], true);
  }),
});
