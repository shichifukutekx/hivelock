import { lookup as dnsLookup } from "node:dns";
import { promises as dns } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [["::", 96], ["::ffff:0:0:0", 96], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["2002::", 16], ["2001:db8::", 32]] as const) {
  blocked.addSubnet(network, prefix, "ipv6");
}

/** Reads the IPv4 address carried inside an IPv6 one, because those reach the same private hosts. */
function embeddedIpv4(address: string): string | undefined {
  const dotted = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (dotted) return dotted[1];
  const hex = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hex) return undefined;
  const [high, low] = [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16)];
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  const inner = embeddedIpv4(address);
  if (inner) return blocked.check(inner, "ipv4");
  return blocked.check(address, family === 6 ? "ipv6" : "ipv4");
}

/** Cloud metadata services, which hand out server credentials. Refused even where private addresses are allowed. */
const metadata = new BlockList();
metadata.addSubnet("169.254.0.0", 16, "ipv4");
metadata.addAddress("100.100.100.200", "ipv4");
metadata.addSubnet("fe80::", 10, "ipv6");
metadata.addAddress("fd00:ec2::254", "ipv6");

export function isMetadataAddress(address: string) {
  const family = isIP(address);
  if (family === 0) return false;
  const inner = embeddedIpv4(address);
  if (inner) return metadata.check(inner, "ipv4");
  return metadata.check(address, family === 6 ? "ipv6" : "ipv4");
}

/** A refused outbound connection. `afterSend` means an earlier hop already delivered the request. */
export class BlockedAddress extends Error {
  constructor(host: string, readonly afterSend = false) {
    super(`For safety, this server cannot connect to ${host}.`);
  }
}

/** True only when nothing can have reached the service. A failure on a later hop is not one: an earlier hop already took the request. */
export const neverDelivered = (error: unknown) => {
  const { afterSend, cause } = error as { afterSend?: boolean; cause?: { code?: string } };
  return !afterSend && ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(cause?.code ?? "");
};
export const answeredAfterRedirect = (response: Response) => (response as { afterSend?: boolean }).afterSend === true;

export interface NetworkPolicy {
  /** Internal hosts the server's operator has allowed. Workflows and workspaces cannot change this. */
  allowedPrivateHosts: string[];
}

const hostName = (url: URL) => url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
const isAllowed = (policy: NetworkPolicy, host: string) => policy.allowedPrivateHosts.includes(host.toLowerCase());

/**
 * Checks where a host really points and returns an address to connect to.
 * For non-HTTP connections, using that address stops a name changing between check and connection.
 */
export async function resolvePublicHost(host: string, policy: NetworkPolicy): Promise<string> {
  if (isAllowed(policy, host)) return host;
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new BlockedAddress(host);
    return host;
  }
  const addresses = await dns.lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw new BlockedAddress(host);
  return addresses[0]!.address;
}

/** Checks the address at the moment of connecting, so a name cannot change after an earlier check. */
const guardedAgent = (refused: (address: string) => boolean) => new Agent({
  connect: {
    lookup: (host: string, options: any, callback: any) => {
      dnsLookup(host, { ...options, all: true }, (error, addresses) => {
        if (error) return callback(error);
        const found = addresses as unknown as { address: string; family: number }[];
        const bad = found.find(({ address }) => refused(address));
        if (bad) return callback(new BlockedAddress(host));
        if (options?.all) return callback(null, found);
        callback(null, found[0]!.address, found[0]!.family);
      });
    },
  },
});
const publicAgent = guardedAgent(isPrivateAddress);
const openAgent = guardedAgent(isMetadataAddress);
const directAgent = new Agent();

async function limitedBody(response: Awaited<ReturnType<typeof undiciFetch>>, limit: number) {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new Error("The response was too large.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export interface SafeFetchOptions extends NetworkPolicy {
  timeoutMs?: number;
  maxBytes?: number;
  /** Hosts allowed for this request. Redirects outside them are refused, so a credential cannot leave its host. */
  onlyOrigin?: string;
  /** For a server's own model hosts: private addresses and plain http work, and only cloud metadata stays refused. */
  anyAddress?: boolean;
  /** Hands the body on as it arrives, still under the size limit, so a model's reply can be shown live. */
  stream?: boolean;
  /** Returns a redirect instead of following it. */
  noRedirects?: boolean;
}

/**
 * The only way the platform makes outbound HTTP calls.
 * Redirects are followed by hand, so each hop is checked again.
 */
export async function safeFetch(input: string | URL, init: RequestInit = {}, options: SafeFetchOptions): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = MAX_RESPONSE_BYTES, onlyOrigin } = options;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  let url = new URL(input);
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  const originalHeaders = new Headers(init.headers);
  let headers = originalHeaders;

  for (let hop = 0; ; hop += 1) {
    const host = hostName(url);
    const open = !!options.anyAddress;
    const allowed = open || isAllowed(options, host);
    const sent = hop > 0;
    if (url.protocol !== "https:" && !(allowed && url.protocol === "http:")) throw new BlockedAddress(`${url.protocol}//${host}`, sent);
    if (url.username || url.password) throw new BlockedAddress(host, sent);
    if (onlyOrigin && url.origin !== onlyOrigin) throw new BlockedAddress(host, sent);
    if (isIP(host) && !allowed && isPrivateAddress(host)) throw new BlockedAddress(host, sent);
    if (open && isMetadataAddress(host)) throw new BlockedAddress(host, sent);

    const response = await undiciFetch(url, {
      method, headers, body: body as never, redirect: "manual", signal, dispatcher: open ? openAgent : allowed ? directAgent : publicAgent,
    } as never).catch((error) => {
      if (error?.cause instanceof BlockedAddress) throw new BlockedAddress(host, sent);
      if (sent) error.afterSend = true;
      throw error;
    });

    if (!options.noRedirects && response.status >= 300 && response.status < 400 && response.headers.has("location")) {
      if (hop >= MAX_REDIRECTS) throw new Error("Too many redirects.");
      await response.body?.cancel();
      const next = new URL(response.headers.get("location")!, url);
      // Credentials stay with their original origin.
      if (next.origin !== url.origin) {
        headers = new Headers(headers);
        for (const name of ["authorization", "cookie", "proxy-authorization", "x-api-key"]) headers.delete(name);
      }
      if ([301, 302, 303].includes(response.status)) {
        method = response.status === 303 || method === "POST" ? "GET" : method;
        if (method === "GET") body = undefined;
      }
      url = next;
      continue;
    }
    if (options.stream && response.body) {
      let size = 0;
      const limited = (response.body as unknown as ReadableStream<Uint8Array>).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          size += chunk.length;
          if (size > maxBytes) controller.error(new Error("The response was too large."));
          else controller.enqueue(chunk);
        },
      }) as never) as unknown as BodyInit;
      return new Response(limited, { status: response.status, statusText: response.statusText, headers: response.headers as unknown as Headers });
    }
    const finished = new Response(response.status === 204 || response.status === 304 ? null : await limitedBody(response, maxBytes), {
      status: response.status, statusText: response.statusText, headers: response.headers as unknown as Headers,
    });
    return sent ? Object.assign(finished, { afterSend: true }) : finished;
  }
}
