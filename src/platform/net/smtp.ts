import nodemailer from "nodemailer";
import { resolvePublicHost, type NetworkPolicy } from "./safe-fetch.ts";

export interface SmtpTarget {
  host: string;
  port: number;
  /** TLS from the first byte. Otherwise the connection upgrades with STARTTLS. */
  secure: boolean;
  user?: string;
  password?: string;
}

/** Connects to the checked address, and insists on TLS unless the operator allowed this host. */
export async function smtpOptions({ host, port, secure, user, password }: SmtpTarget, network: NetworkPolicy) {
  const allowedHost = network.allowedPrivateHosts.includes(host.toLowerCase());
  return {
    host: await resolvePublicHost(host, network),
    port,
    secure,
    requireTLS: !allowedHost,
    ignoreTLS: allowedHost,
    tls: { servername: host },
    auth: user ? { user, pass: password } : undefined,
    connectionTimeout: 15_000,
    socketTimeout: 30_000,
  };
}

export const smtpTransport = async (target: SmtpTarget, network: NetworkPolicy) => nodemailer.createTransport(await smtpOptions(target, network));
