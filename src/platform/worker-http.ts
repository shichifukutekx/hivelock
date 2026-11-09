import { createServer } from "node:http";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { metricsAllowed, metricsText, readiness } from "./routes/health.ts";

interface Deps {
  pool: Pool;
  boss: PgBoss;
  port: number;
  host: string;
  metricsToken?: string;
  stopping: () => boolean;
}

/** A worker takes no requests, but its orchestrator and Prometheus still need to reach it. Only these three addresses answer. */
export function startWorkerHttp({ pool, boss, port, host, metricsToken, stopping }: Deps) {
  const server = createServer((request, response) => {
    const send = (status: number, body: string, type = "application/json") => {
      response.writeHead(status, { "content-type": type });
      response.end(body);
    };
    void (async () => {
      if (request.url === "/health") return send(200, JSON.stringify({ status: "ok" }));
      if (request.url === "/ready") {
        const { ready, checks } = await readiness({ pool, boss, stopping });
        return send(ready ? 200 : 503, JSON.stringify({ status: ready ? "ready" : "unavailable", checks }));
      }
      if (request.url === "/metrics" && metricsAllowed(metricsToken, request.headers.authorization)) return send(200, await metricsText(pool, boss), "text/plain; version=0.0.4");
      return send(404, JSON.stringify({ error: "Not found." }));
    })().catch(() => send(500, JSON.stringify({ error: "Something went wrong." })));
  });
  server.listen(port, host);
  return server;
}
