import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer as createTcpServer, type Socket } from "node:net";
import { createServer, type Server, type TLSSocket } from "node:tls";

export interface StubMail {
  uid: number;
  from?: string;
  fromName?: string;
  to?: string;
  subject?: string;
  text?: string;
  html?: string;
  attachments?: string[];
  messageId?: string;
  date?: Date;
  receivedAt?: Date;
}

const SENT = new Date("2026-01-02T03:04:05Z");
const quote = (value: string | undefined) => (value === undefined ? "NIL" : `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
const address = (mail: string, name?: string) => {
  const [box, host] = mail.split("@");
  return `((${quote(name)} NIL ${quote(box)} ${quote(host)}))`;
};
const textNode = (subtype: string, body: string) => `("TEXT" "${subtype}" ("CHARSET" "utf-8") NIL NIL "8BIT" ${Buffer.byteLength(body)} 1)`;

function structure(mail: StubMail) {
  const parts = [...(mail.text !== undefined ? [textNode("PLAIN", mail.text)] : []), ...(mail.html !== undefined ? [textNode("HTML", mail.html)] : [])];
  const attachments = (mail.attachments ?? []).map((name) => `("APPLICATION" "PDF" ("NAME" ${quote(name)}) NIL NIL "BASE64" 4 NIL ("ATTACHMENT" ("FILENAME" ${quote(name)})) NIL NIL)`);
  if (parts.length === 1 && !attachments.length) return parts[0]!;
  return `(${[...parts, ...attachments].join("")} "MIXED")`;
}
const partBody = (mail: StubMail, index: number) => [mail.text, mail.html].filter((part) => part !== undefined)[index - 1] ?? "";

/** A small IMAP server speaking just what the mail client asks, over TLS like a real one. */
export function createImapStub() {
  const directory = mkdtempSync(join(tmpdir(), "imap-stub-"));
  const [keyFile, certFile] = [join(directory, "key.pem"), join(directory, "cert.pem")];
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-subj", "/CN=localhost", "-days", "2"], { stdio: "ignore" });

  const state = {
    mail: [] as StubMail[],
    uidValidity: 100,
    folders: ["INBOX"],
    password: "right",
    /** Each connection's commands, oldest first. */
    commands: [] as string[],
    connections: 0,
    dropOnBody: false,
    hangOnFetch: false,
    reset() {
      Object.assign(state, { mail: [], uidValidity: 100, folders: ["INBOX"], password: "right", commands: [], connections: 0, dropOnBody: false, hangOnFetch: false });
    },
  };

  const answerFetch = (socket: TLSSocket, mail: StubMail, seq: number, request: string) => {
    const fields = [`UID ${mail.uid}`, "FLAGS ()"];
    if (/ENVELOPE/.test(request)) {
      // Fixed, as a real message's Date header is.
      const date = (mail.date ?? SENT).toUTCString();
      const from = address(mail.from ?? "someone@sender.test", mail.fromName);
      fields.push(`ENVELOPE (${quote(date)} ${quote(mail.subject ?? "")} ${from} ${from} ${from} ${address(mail.to ?? "box@mail.test")} NIL NIL NIL ${quote(mail.messageId)})`);
    }
    if (/INTERNALDATE/.test(request)) {
      const at = mail.receivedAt ?? new Date();
      const [d, m, y, t] = at.toUTCString().slice(5, 25).split(" ");
      fields.push(`INTERNALDATE "${d}-${m}-${y} ${t} +0000"`);
    }
    if (/RFC822\.SIZE/.test(request)) fields.push(`RFC822.SIZE ${Buffer.byteLength(mail.text ?? "") + Buffer.byteLength(mail.html ?? "")}`);
    if (/BODYSTRUCTURE/.test(request)) fields.push(`BODYSTRUCTURE ${structure(mail)}`);
    let literal = "";
    for (const [, section, start, length] of request.matchAll(/BODY(?:\.PEEK)?\[([^\]]*)\](?:<(\d+)\.(\d+)>)?/g)) {
      const name = section!.toUpperCase();
      const single = !structure(mail).endsWith('"MIXED")');
      let body = "";
      if (name.endsWith("MIME") || name === "HEADER") body = `Content-Type: text/${partBody(mail, 1) === mail.html && mail.text === undefined ? "html" : "plain"}; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n`;
      else if (name === "TEXT" && single) body = partBody(mail, 1);
      else body = partBody(mail, Number(name) || 1);
      const bytes = Buffer.from(body).subarray(Number(start ?? 0), start ? Number(start) + Number(length) : undefined);
      literal += `${literal || fields.length ? " " : ""}BODY[${section}]${start ? `<${start}>` : ""} {${bytes.length}}\r\n${bytes.toString("latin1")}`;
    }
    socket.write(Buffer.from(`* ${seq} FETCH (${fields.join(" ")}${literal})\r\n`, "latin1"));
  };

  const inSet = (set: string, uid: number, highest: number) => set.split(",").some((range) => {
    const [from, to] = range.split(":");
    const end = to === "*" ? Math.max(highest, Number(from)) : Number(to ?? from);
    // As in the IMAP rules, n:* always reaches the highest message, even below n.
    return to === "*" ? uid >= Number(from) || uid === highest : uid >= Number(from) && uid <= end;
  });

  const handle = (socket: TLSSocket, line: string) => {
    const [tag, ...rest] = line.split(" ");
    const command = rest.join(" ");
    const verb = rest[0]!.toUpperCase() === "UID" ? `UID ${rest[1]!.toUpperCase()}` : rest[0]!.toUpperCase();
    state.commands.push(command.startsWith("LOGIN") ? "LOGIN" : command);
    const ok = (text = "done") => socket.write(`${tag} OK ${text}\r\n`);
    const sorted = () => [...state.mail].sort((a, b) => a.uid - b.uid);
    switch (verb) {
      case "CAPABILITY":
        socket.write("* CAPABILITY IMAP4rev1 UIDPLUS\r\n");
        return ok();
      case "LOGIN":
        if (!command.includes(`"${state.password}"`) && !command.endsWith(` ${state.password}`)) return socket.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
        return ok("[CAPABILITY IMAP4rev1 UIDPLUS] logged in");
      case "LIST": case "LSUB":
        for (const folder of state.folders) socket.write(`* ${verb} () "/" ${quote(folder)}\r\n`);
        return ok();
      case "SELECT": case "EXAMINE": {
        const folder = rest.slice(1).join(" ").replace(/^"|"$/g, "");
        if (!state.folders.includes(folder)) return socket.write(`${tag} NO [NONEXISTENT] No such folder\r\n`);
        const next = (sorted().at(-1)?.uid ?? 0) + 1;
        socket.write(`* FLAGS (\\Seen)\r\n* OK [PERMANENTFLAGS ()] none\r\n* ${state.mail.length} EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY ${state.uidValidity}] ok\r\n* OK [UIDNEXT ${next}] ok\r\n`);
        return ok("[READ-ONLY] opened");
      }
      case "UID SEARCH": case "SEARCH": {
        const set = command.match(/UID ([\d:*,]+)$/i)?.[1];
        const since = command.match(/SINCE ("?)([^"\s]+)\1/i)?.[2];
        const highest = sorted().at(-1)?.uid ?? 0;
        const uids = sorted().filter((mail) => {
          if (set) return inSet(set, mail.uid, highest);
          if (since) return (mail.receivedAt ?? new Date()) >= new Date(since);
          return true;
        }).map((mail) => mail.uid);
        socket.write(`* SEARCH ${uids.join(" ")}\r\n`.replace("SEARCH \r", "SEARCH\r"));
        return ok();
      }
      case "UID FETCH": case "FETCH": {
        if (state.hangOnFetch) return undefined;
        const [, set, request] = command.match(/FETCH ([\d:*,]+) (.*)$/i) ?? [];
        if (state.dropOnBody && /BODY/.test(request!.replace(/BODYSTRUCTURE/g, ""))) return void [...fronts].forEach((front) => front.resetAndDestroy());
        const highest = sorted().at(-1)?.uid ?? 0;
        sorted().forEach((mail, index) => {
          if (inSet(set!, mail.uid, highest)) answerFetch(socket, mail, index + 1, request!);
        });
        return ok();
      }
      case "LOGOUT":
        socket.write("* BYE bye\r\n");
        ok();
        return socket.end();
      case "NOOP": case "CLOSE": case "UNSELECT":
        return ok();
      default:
        return socket.write(`${tag} BAD unknown\r\n`);
    }
  };

  const server: Server = createServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, (socket) => {
    state.connections += 1;
    socket.on("error", () => {});
    socket.write("* OK [CAPABILITY IMAP4rev1 UIDPLUS] stub ready\r\n");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (let end = buffer.indexOf("\r\n"); end !== -1; end = buffer.indexOf("\r\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (line) handle(socket, line);
      }
    });
  });
  // TLS sockets cannot send a connection reset, so plain TCP in front lets a test do that for real.
  const fronts = new Set<Socket>();
  const front = createTcpServer((outer) => {
    fronts.add(outer);
    const inner = connect((server.address() as { port: number }).port, "127.0.0.1");
    outer.on("error", () => {}).on("close", () => { fronts.delete(outer); inner.destroy(); });
    inner.on("error", () => outer.destroy()).on("close", () => outer.destroy());
    outer.pipe(inner).pipe(outer);
  });
  const listening = new Promise<number>((ready) => server.listen(0, "127.0.0.1", () => front.listen(0, "127.0.0.1", () => ready((front.address() as { port: number }).port))));
  const stop = () => new Promise((done) => {
    for (const outer of fronts) outer.destroy();
    front.close(() => server.close(done));
  });
  return { state, listening, stop };
}
