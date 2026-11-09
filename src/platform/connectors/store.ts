import type { Pool, PoolClient } from "pg";
import { inWorkspace } from "../db.ts";
import { decryptSecret, encryptSecret } from "../secrets.ts";
import { getConnector, MailReadRefused } from "./types.ts";

// Credentials are bound to their connection, so a stored value cannot be moved to another one.
export const connectionSecretName = (connectionId: string) => `connection:${connectionId}`;

export async function saveCredentials(client: PoolClient, masterKey: string, workspaceId: string, connectionId: string, credentials: unknown) {
  const { ciphertext, iv, tag } = encryptSecret(masterKey, workspaceId, connectionSecretName(connectionId), JSON.stringify(credentials));
  return { ciphertext, iv, tag };
}

export async function loadConnection(db: Pool | PoolClient, masterKey: string, workspaceId: string, connectionId: string) {
  const { rows: [row] } = await db.query("select id, connector, name, ciphertext, iv, tag from connections where id = $1", [connectionId]);
  if (!row) return undefined;
  const credentials = JSON.parse(decryptSecret(masterKey, workspaceId, connectionSecretName(row.id), row));
  return { id: row.id as string, connector: row.connector as string, name: row.name as string, credentials };
}

/** Refuses a request whose links include an action that reads a mailbox. Links that are not shaped right fail later, in their own checks. */
export async function assertMayReadMail(pool: Pool, workspaceId: string, links: unknown) {
  const list = (Array.isArray(links) ? links : []) as { connectionId?: unknown; action?: unknown }[];
  if (!list.length) return;
  const rows = await inWorkspace(pool, workspaceId, async (db) => (await db.query("select id, connector from connections")).rows);
  // The database reads one id in many spellings, so both sides are reduced to the same one before comparing.
  const same = (id: unknown) => String(id).toLowerCase().replace(/[^0-9a-f]/g, "");
  const kinds = new Map(rows.map((row) => [same(row.id), row.connector as string]));
  if (list.some((link) => getConnector(kinds.get(same(link?.connectionId)) ?? "")?.actions[String(link?.action)]?.readsMail)) throw new MailReadRefused();
}
