import { ImapFlow, type MailboxObject, type MessageStructureObject } from "imapflow";
import { z } from "zod";
import { EXPORT_TYPES } from "../exports.ts";
import { resolvePublicHost, type NetworkPolicy } from "../net/safe-fetch.ts";
import { smtpTransport } from "../net/smtp.ts";
import { PermanentError, registerConnector } from "./types.ts";

const credentials = z.object({
  smtpHost: z.string().min(1),
  smtpPort: z.coerce.number().int().default(587),
  imapHost: z.string().optional(),
  imapPort: z.coerce.number().int().default(993),
  user: z.string().min(1),
  password: z.string().min(1),
  from: z.email(),
  allowedRecipientDomains: z.string().optional(),
});
type Credentials = z.infer<typeof credentials>;

const MAX_MESSAGES = 50;
const addresses = z.union([z.email(), z.array(z.email()).min(1).max(50)]);
const send = z.object({
  to: addresses, subject: z.string().min(1).max(500), text: z.string().min(1).max(100_000), cc: addresses.optional(),
  /** Also attach the text as a spreadsheet or a PDF, named after the subject. Its tables become real tables. */
  attachAs: z.enum(["none", "xlsx", "pdf"]).default("none").optional(),
});

/** With a list set, a manipulated agent or workflow cannot mail company data to an outside address. */
export function assertRecipients(c: { allowedRecipientDomains?: string }, list: string[]) {
  const allowed = (c.allowedRecipientDomains ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (!allowed.length) return;
  const refused = list.find((address) => !allowed.includes(address.split("@")[1]!.toLowerCase()));
  if (refused) throw new PermanentError(`Email to ${refused} is not allowed by this connection.`);
}

const asList = (value: string | string[] | undefined) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

const transport = (c: Credentials, network: NetworkPolicy) =>
  smtpTransport({ host: c.smtpHost, port: c.smtpPort, secure: c.smtpPort === 465, user: c.user, password: c.password }, network);

async function mailbox(c: Credentials, network: NetworkPolicy) {
  if (!c.imapHost) throw new PermanentError("This connection has no IMAP server for reading mail.");
  const client = new ImapFlow({
    host: await resolvePublicHost(c.imapHost, network),
    port: c.imapPort,
    secure: true,
    tls: { servername: c.imapHost },
    auth: { user: c.user, pass: c.password },
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
    disableAutoIdle: true,
  });
  // Without a listener, a connection dropping later would stop the whole worker.
  client.on("error", () => {});
  await client.connect();
  return client;
}

export const MAIL_LIMITS = {
  /** The whole of one mailbox check. A server that sends a byte now and then would otherwise never time out. */
  checkMs: 120_000,
  bodyBytes: 256 * 1024,
};
const MAX_STRUCTURE_PARTS = 200;
const MAX_ATTACHMENTS = 25;
const MAX_NAME = 200;

export interface MailEnvelope {
  uid: number;
  messageId: string;
  from: string;
  fromName: string;
  to: string[];
  subject: string;
  date: string;
  receivedAt: Date | undefined;
  size: number;
  attachments: string[];
  textPart: { part: string; html: boolean; size: number } | undefined;
}

export interface Mailbox {
  uidValidity: string;
  /** Addresses this connection sends as. */
  ownAddresses: string[];
  uidsAfter(uid: number): Promise<number[]>;
  uidsSince(date: Date): Promise<number[]>;
  envelopes(uids: number[]): Promise<MailEnvelope[]>;
  text(message: MailEnvelope): Promise<{ text: string; truncated: boolean }>;
}

/** Finds the readable text and the attachment names. A crafted message cannot make this walk forever. */
function readStructure(root: MessageStructureObject | undefined) {
  const attachments: string[] = [];
  const parts: { part: string; html: boolean; size: number }[] = [];
  const stack = root ? [root] : [];
  for (let seen = 0; stack.length && seen < MAX_STRUCTURE_PARTS; seen += 1) {
    const node = stack.shift()!;
    const type = (node.type ?? "").toLowerCase();
    const name = node.dispositionParameters?.filename ?? node.parameters?.name;
    if (node.disposition?.toLowerCase() === "attachment" || name) {
      if (name && attachments.length < MAX_ATTACHMENTS) attachments.push(name.slice(0, MAX_NAME));
    } else if (type === "text/plain" || type === "text/html") {
      parts.push({ part: node.part ?? "1", html: type === "text/html", size: node.size ?? 0 });
    }
    // A forwarded message is an attachment here, so what is inside it is not read as this message's text.
    if (type !== "message/rfc822") stack.unshift(...(node.childNodes ?? []));
  }
  return { attachments, textPart: parts.find((part) => !part.html) ?? parts[0] };
}

/** Keeps the words of an HTML mail. Searches by position, because a pattern could be made to run for a very long time. */
export function htmlToText(html: string) {
  let out = "";
  let at = 0;
  const lower = html.toLowerCase();
  while (at < html.length) {
    const start = lower.indexOf("<", at);
    if (start === -1) break;
    out += `${html.slice(at, start)} `;
    const block = ["style", "script"].find((tag) => lower.startsWith(tag, start + 1));
    const end = block ? lower.indexOf(`</${block}`, start) : lower.indexOf(">", start);
    if (end === -1) return out.replace(/\s+/g, " ").trim();
    at = block ? (lower.indexOf(">", end) + 1 || html.length) : end + 1;
  }
  out += html.slice(at);
  return out.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

/** Opens one folder read-only, so checking mail never marks it as read. */
export async function withMailbox<T>(connection: unknown, network: NetworkPolicy, folder: string, work: (box: Mailbox) => Promise<T>): Promise<T> {
  const c = credentials.parse(connection);
  const client = await mailbox(c, network);
  const deadline = setTimeout(() => client.close(), MAIL_LIMITS.checkMs);
  try {
    const lock = await client.getMailboxLock(folder, { readOnly: true }).catch((error) => {
      throw (error as { responseStatus?: string }).responseStatus === "NO" ? new PermanentError("This folder could not be opened.") : error;
    });
    try {
      const search = async (query: object) => [...((await client.search(query, { uid: true })) || [])].sort((a, b) => a - b);
      return await work({
        uidValidity: String((client.mailbox as MailboxObject).uidValidity),
        ownAddresses: [c.from, c.user].map((address) => address.toLowerCase()),
        // A range ending in * always includes the newest message, even one already read.
        uidsAfter: async (uid) => (await search({ uid: `${uid + 1}:*` })).filter((found) => found > uid),
        // IMAP compares whole days in the server's own zone, so this starts a day early. The caller compares exact times.
        uidsSince: (date) => search({ since: new Date(date.getTime() - 86_400_000) }),
        envelopes: async (uids) => {
          const found: MailEnvelope[] = [];
          if (!uids.length) return found;
          // Fetches cannot overlap other commands on a connection, so these are gathered first.
          for await (const message of client.fetch(uids.join(","), { uid: true, envelope: true, internalDate: true, size: true, bodyStructure: true }, { uid: true })) {
            const sender = message.envelope?.from?.[0];
            found.push({
              uid: message.uid,
              messageId: message.envelope?.messageId ?? "",
              from: (sender?.address ?? "").toLowerCase(),
              fromName: (sender?.name ?? "").slice(0, MAX_NAME),
              to: (message.envelope?.to ?? []).slice(0, MAX_ATTACHMENTS).flatMap((person) => person.address ?? []),
              subject: (message.envelope?.subject ?? "").slice(0, 1_000),
              date: message.envelope?.date ? new Date(message.envelope.date).toISOString() : "",
              receivedAt: message.internalDate ? new Date(message.internalDate) : undefined,
              size: message.size ?? 0,
              ...readStructure(message.bodyStructure),
            });
          }
          return found.sort((a, b) => a.uid - b.uid);
        },
        text: async ({ uid, textPart }) => {
          if (!textPart) return { text: "", truncated: false };
          try {
            const { content } = await client.download(String(uid), textPart.part, { uid: true, maxBytes: MAIL_LIMITS.bodyBytes });
            const chunks: Buffer[] = [];
            for await (const chunk of content ?? []) chunks.push(chunk as Buffer);
            const raw = Buffer.concat(chunks).toString("utf8");
            return { text: textPart.html ? htmlToText(raw) : raw, truncated: textPart.size > MAIL_LIMITS.bodyBytes };
          } catch (error) {
            if (!client.usable) throw error;
            // One unreadable message must not hold up the ones behind it.
            return { text: "", truncated: true };
          }
        },
      });
    } finally {
      lock.release();
    }
  } finally {
    clearTimeout(deadline);
    await client.logout().catch(() => client.close());
  }
}

registerConnector({
  name: "email",
  label: "Email",
  category: "email",
  description: "Send through SMTP and read through IMAP. Works with Gmail or Outlook using an app password.",
  fields: [
    { name: "smtpHost", label: "SMTP server", type: "text", required: true },
    { name: "smtpPort", label: "SMTP port", type: "number" },
    { name: "imapHost", label: "IMAP server (to read mail)", type: "text" },
    { name: "imapPort", label: "IMAP port", type: "number" },
    { name: "user", label: "Username", type: "text", required: true },
    { name: "password", label: "Password or app password", type: "password", required: true },
    { name: "from", label: "Send from", type: "text", required: true },
    { name: "allowedRecipientDomains", label: "Only send to these domains", type: "text", help: "Comma-separated. Strongly recommended." },
  ],
  credentials,
  actions: {
    send: {
      label: "Send an email",
      changesData: true,
      params: send,
      run: async (connection, params, { network, idempotencyKey }) => {
        const c = credentials.parse(connection);
        const { to, cc, subject, text, attachAs } = send.parse(params);
        assertRecipients(c, [...asList(to), ...asList(cc)]);
        const title = subject.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").trim().slice(0, 100) || "Report";
        const attachments = attachAs && attachAs !== "none"
          ? [{ filename: `${title}.${attachAs}`, content: await EXPORT_TYPES[attachAs].make(text, title), contentType: EXPORT_TYPES[attachAs].type }]
          : undefined;
        const info = await (await transport(c, network)).sendMail({
          from: c.from, to, cc, subject, text, attachments,
          messageId: `<${idempotencyKey}@agent-platform>`,
        });
        return { messageId: info.messageId, accepted: info.accepted };
      },
    },
    list_unread: {
      label: "List unread email",
      changesData: false,
      readsMail: true,
      params: z.object({ folder: z.string().default("INBOX"), limit: z.coerce.number().int().min(1).max(MAX_MESSAGES).default(20) }),
      run: async (connection, params, { network }) => {
        const { folder, limit } = z.object({ folder: z.string().default("INBOX"), limit: z.coerce.number().int().min(1).max(MAX_MESSAGES).default(20) }).parse(params);
        const client = await mailbox(credentials.parse(connection), network);
        try {
          const lock = await client.getMailboxLock(folder);
          try {
            const unseen = (await client.search({ seen: false }, { uid: true })) || [];
            const messages = [];
            for await (const message of client.fetch(unseen.slice(-limit), { envelope: true, uid: true }, { uid: true })) {
              messages.push({
                uid: message.uid, subject: message.envelope?.subject, date: message.envelope?.date,
                from: message.envelope?.from?.map((f) => f.address),
              });
            }
            return { messages };
          } finally {
            lock.release();
          }
        } finally {
          await client.logout();
        }
      },
    },
  },
  test: async (connection, { network }) => {
    await (await transport(credentials.parse(connection), network)).verify();
  },
});
