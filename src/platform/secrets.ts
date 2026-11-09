import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";

const KEY_VERSION = 1;

/** Each workspace gets its own key, so one workspace's data can never decrypt another's. */
function workspaceKey(masterKey: string, workspaceId: string): Buffer {
  const derived = hkdfSync("sha256", Buffer.from(masterKey, "base64"), workspaceId, `agent-platform-secrets-v${KEY_VERSION}`, 32);
  return Buffer.from(derived);
}

// Binding the workspace and name stops a stored value being moved to another secret.
const boundTo = (workspaceId: string, name: string) => Buffer.from(`${workspaceId}\0${name}`);

export function encryptSecret(masterKey: string, workspaceId: string, name: string, value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", workspaceKey(masterKey, workspaceId), iv);
  cipher.setAAD(boundTo(workspaceId, name));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag(), keyVersion: KEY_VERSION };
}

type Encrypted = { ciphertext: Buffer; iv: Buffer; tag: Buffer };

/** Tries one key only. Key rotation uses this to tell which key a value is really under. */
export function decryptWithKey(key: string, workspaceId: string, name: string, stored: Encrypted): string {
  const decipher = createDecipheriv("aes-256-gcm", workspaceKey(key, workspaceId), stored.iv);
  decipher.setAAD(boundTo(workspaceId, name));
  decipher.setAuthTag(stored.tag);
  return Buffer.concat([decipher.update(stored.ciphertext), decipher.final()]).toString("utf8");
}

let previousKey: string | undefined;

/** Set while a rotation is under way. Only reading uses it: every new value goes under the current key. */
export const setPreviousMasterKey = (key: string | undefined) => {
  previousKey = key;
};

export function decryptSecret(masterKey: string, workspaceId: string, name: string, stored: Encrypted): string {
  try {
    return decryptWithKey(masterKey, workspaceId, name, stored);
  } catch (error) {
    if (!previousKey) throw error;
    return decryptWithKey(previousKey, workspaceId, name, stored);
  }
}

export async function putSecret(client: PoolClient, masterKey: string, workspaceId: string, name: string, value: string, actorId: string) {
  const { ciphertext, iv, tag, keyVersion } = encryptSecret(masterKey, workspaceId, name, value);
  await client.query(
    `insert into secrets (workspace_id, name, ciphertext, iv, tag, key_version, created_by)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (workspace_id, name) do update
       set ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag,
           key_version = excluded.key_version, updated_at = now()`,
    [workspaceId, name, ciphertext, iv, tag, keyVersion, actorId],
  );
}

/** For connectors only. No API route returns a secret's value. */
export async function readSecret(client: PoolClient, masterKey: string, workspaceId: string, name: string): Promise<string | undefined> {
  const { rows } = await client.query("select ciphertext, iv, tag from secrets where name = $1", [name]);
  return rows[0] ? decryptSecret(masterKey, workspaceId, name, rows[0]) : undefined;
}

const SEALED = "agent-platform-sealed-v1";
export const sealName = (workspaceId: string) => `${SEALED}:${workspaceId}`;
export const packSealed = ({ iv, tag, ciphertext }: Encrypted) => [iv, tag, ciphertext].map((part) => part.toString("base64")).join(".");
export const unpackSealed = (text: string): Encrypted => {
  const [iv, tag, ciphertext] = text.split(".").map((part) => Buffer.from(part, "base64"));
  return { iv: iv!, tag: tag!, ciphertext: ciphertext! };
};

/** Encrypts run data, so a database leak or backup alone does not reveal customer content. */
export function seal(masterKey: string, workspaceId: string, value: unknown) {
  return { $sealed: packSealed(encryptSecret(masterKey, workspaceId, sealName(workspaceId), JSON.stringify(value ?? null))) };
}

/** Opens sealed values anywhere inside a structure, and leaves everything else alone. */
export function unseal(masterKey: string, workspaceId: string, value: any): any {
  if (Array.isArray(value)) return value.map((item) => unseal(masterKey, workspaceId, item));
  // Only plain objects are walked, so values such as database timestamps pass through whole.
  if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return value;
  if (typeof value.$sealed === "string") {
    return JSON.parse(decryptSecret(masterKey, workspaceId, sealName(workspaceId), unpackSealed(value.$sealed)));
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unseal(masterKey, workspaceId, item)]));
}

/** The same for a text column, such as an error that quotes a service's reply. */
export const sealText = (masterKey: string, workspaceId: string, text: string) => JSON.stringify(seal(masterKey, workspaceId, text));

export function unsealText(masterKey: string, workspaceId: string, text: string | null) {
  if (!text?.startsWith('{"$sealed"')) return text;
  return unseal(masterKey, workspaceId, JSON.parse(text)) as string;
}
