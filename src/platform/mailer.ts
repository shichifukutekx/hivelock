import nodemailer from "nodemailer";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { networkPolicy, type PlatformEnv } from "./env.ts";
import { BlockedAddress } from "./net/safe-fetch.ts";
import { smtpTransport } from "./net/smtp.ts";
import { decryptSecret, encryptSecret } from "./secrets.ts";

export type Mailer = (message: { to: string; subject: string; text: string }) => Promise<void>;

/** Not a workspace, so its key never serves any workspace's data. */
export const MAIL_SCOPE = "platform";
export const MAIL_PASSWORD_NAME = "mail-password";

export class MailNotConfigured extends Error {
  constructor() {
    super("Mail is not set up yet. Add it under Settings.");
  }
}

export const mailBody = z.object({
  host: z.string().trim().toLowerCase().max(253).regex(/^[a-z0-9:]([a-z0-9.:-]*[a-z0-9:])?$/),
  port: z.coerce.number().int().min(1).max(65_535),
  security: z.enum(["starttls", "tls"]),
  username: z.string().trim().max(320).default(""),
  /** Left blank when editing, which keeps the saved password. */
  password: z.string().max(4_000).optional().transform((value) => value || undefined),
  fromAddress: z.email().max(320),
  fromName: z.string().trim().max(120).regex(/^[^\u0000-\u001f\u007f]*$/).default(""),
});
export type MailBody = z.infer<typeof mailBody>;

// A server from before migration 010 has no such function yet, and neither does the database migrate.ts starts from.
const NOT_MIGRATED = new Set(["42883", "42P01"]);

export async function readMailSettings(db: Pool | PoolClient) {
  try {
    const { rows } = await db.query("select * from platform_mail_read()");
    return rows[0] as Record<string, any> | undefined;
  } catch (error) {
    if (NOT_MIGRATED.has((error as { code?: string }).code ?? "")) return undefined;
    throw error;
  }
}

/** Saves the row. Returns false if a saved password would go to a different server. */
export async function saveMailSettings(db: PoolClient, env: PlatformEnv, body: MailBody, actorId: string) {
  const key = body.password ? encryptSecret(env.SECRETS_MASTER_KEY, MAIL_SCOPE, MAIL_PASSWORD_NAME, body.password) : undefined;
  const { rows: [row] } = await db.query(
    "select platform_mail_write($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) as saved",
    [body.host, body.port, body.security, body.username, key?.ciphertext ?? null, key?.iv ?? null, key?.tag ?? null, body.fromAddress, body.fromName, actorId],
  );
  return row.saved as boolean;
}

export const environmentMail = (env: PlatformEnv) => !!env.SMTP_URL && !!env.MAIL_FROM;

/** Which mail settings a send would use right now. */
export async function mailSource(pool: Pool, env: PlatformEnv): Promise<"settings" | "environment" | "none"> {
  if (await readMailSettings(pool)) return "settings";
  return environmentMail(env) ? "environment" : "none";
}

/**
 * The platform's own mail, separate from any workspace's email connection.
 * It looks up its settings for each message, so a change in Settings needs no restart.
 * The environment's SMTP_URL is the operator's own choice, so the network rules for saved settings do not apply to it.
 */
export function createMailer(pool: Pool, env: PlatformEnv): Mailer {
  return async (message) => {
    const saved = await readMailSettings(pool);
    if (saved) {
      const password = saved.password_ciphertext
        ? decryptSecret(env.SECRETS_MASTER_KEY, MAIL_SCOPE, MAIL_PASSWORD_NAME, { ciphertext: saved.password_ciphertext, iv: saved.password_iv, tag: saved.password_tag })
        : undefined;
      const transport = await smtpTransport(
        { host: saved.host, port: saved.port, secure: saved.security === "tls", user: saved.username || undefined, password },
        networkPolicy(env),
      );
      await transport.sendMail({ from: { name: saved.from_name, address: saved.from_address }, ...message });
      return;
    }
    if (!environmentMail(env)) throw new MailNotConfigured();
    await nodemailer.createTransport(env.SMTP_URL).sendMail({ from: env.MAIL_FROM, ...message });
  };
}

/** Says what went wrong without repeating the server's reply, which can quote credentials. */
export function explainMailError(error: unknown) {
  if (error instanceof MailNotConfigured) return error.message;
  if (error instanceof BlockedAddress) return "That mail server is on a private network, which is blocked to keep your data safe. Your IT team can allow it.";
  const { code } = error as { code?: string };
  if (code === "EAUTH" || code === "ENOAUTH") return "The mail server refused the username or password.";
  if (code === "ENOTFOUND" || code === "EDNS") return "That mail server could not be found.";
  if (code === "ETIMEDOUT" || code === "ECONNECTION" || code === "ECONNREFUSED" || code === "ESOCKET") return "Could not reach the mail server. Check the host, port and security setting.";
  if (code === "ETLS") return "The mail server did not offer a secure connection, so nothing was sent.";
  if (code === "EENVELOPE") return "The mail server refused the sender or the recipient.";
  return "The mail could not be sent. Check the settings.";
}
