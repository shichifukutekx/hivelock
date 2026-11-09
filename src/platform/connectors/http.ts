import { z } from "zod";
import { NotStarted, PermanentError, registerConnector } from "./types.ts";
import { neverDelivered, safeFetch } from "../net/safe-fetch.ts";
import { serviceProblem } from "../plain-errors.ts";

const credentials = z.object({
  baseUrl: z.url(),
  authType: z.enum(["none", "bearer", "basic", "header"]).default("none"),
  token: z.string().optional(),
  username: z.string().optional(),
  headerName: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).optional(),
});

const RESERVED_HEADERS = new Set(["host", "authorization", "cookie", "content-length", "connection", "transfer-encoding", "proxy-authorization"]);
/** These make a server treat a GET as something else, which would get a change past the check on the method. */
const METHOD_OVERRIDE = /^x-(http-)?method/i;

const authHeaders = (c: z.infer<typeof credentials>): Record<string, string> => {
  if (c.authType === "bearer") return { authorization: `Bearer ${c.token}` };
  if (c.authType === "basic") return { authorization: `Basic ${Buffer.from(`${c.username ?? ""}:${c.token ?? ""}`).toString("base64")}` };
  if (c.authType === "header" && c.headerName) return { [c.headerName]: c.token ?? "" };
  return {};
};

const request = z.object({
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
  path: z.string().min(1).max(2_000).startsWith("/"),
  query: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
});

registerConnector({
  name: "http",
  label: "HTTP API",
  category: "web",
  description: "Call any web API. Credentials only ever go to the address you set here.",
  fields: [
    { name: "baseUrl", label: "Base URL", type: "url", required: true },
    { name: "authType", label: "Authentication (none, bearer, basic, header)", type: "text" },
    { name: "token", label: "Token or password", type: "password" },
    { name: "username", label: "Username", type: "text" },
    { name: "headerName", label: "Header name", type: "text" },
  ],
  credentials,
  actions: {
    request: {
      label: "Send a request",
      changesData: (params) => !["GET", "HEAD"].includes(params.method ?? "GET"),
      asksFirst: true,
      params: request,
      run: async (connection, params, { network, idempotencyKey }) => {
        const c = credentials.parse(connection);
        const { method, path, query, headers, body } = request.parse(params);
        const base = new URL(c.baseUrl);
        const prefix = base.pathname.replace(/\/$/, "");
        const url = new URL(`${prefix}${path}`, base.origin);
        // Credentials stay under the base URL, whatever the path tries: //evil.example, or /../admin.
        if (url.origin !== base.origin || !(url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) {
          throw new PermanentError("The path must stay on this connection's address.");
        }
        for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);

        const sent = new Headers();
        for (const [key, value] of Object.entries(headers ?? {})) {
          if (RESERVED_HEADERS.has(key.toLowerCase()) || METHOD_OVERRIDE.test(key)) throw new PermanentError(`The ${key} header cannot be set here.`);
          sent.set(key, value);
        }
        for (const [key, value] of Object.entries(authHeaders(c))) sent.set(key, value);
        const changing = !["GET", "HEAD"].includes(method);
        if (changing) sent.set("idempotency-key", idempotencyKey);
        if (body !== undefined) sent.set("content-type", sent.get("content-type") ?? "application/json");

        let response: Response;
        try {
          response = await safeFetch(url, {
            method, headers: sent, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
          }, { ...network, onlyOrigin: base.origin });
        } catch (error) {
          // Only these prove nothing was delivered. A dropped connection could be after the service acted.
          throw neverDelivered(error) ? new NotStarted((error as Error).message) : error;
        }
        const text = await response.text();
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {}
        if (!response.ok) throw new PermanentError(serviceProblem("The service", response.status, text));
        return { status: response.status, body: parsed };
      },
    },
  },
  test: async (connection, { network }) => {
    const c = credentials.parse(connection);
    await safeFetch(c.baseUrl, { method: "GET", headers: authHeaders(c) }, { ...network, onlyOrigin: new URL(c.baseUrl).origin });
  },
});
