// A real worker process for the crash test. It takes a step, then hangs until it is killed.
import "./licensed.ts";
import { z } from "zod";
import { createPool } from "../src/platform/db.ts";
import { createEngine } from "../src/platform/engine/engine.ts";
import { registerNodeType } from "../src/platform/engine/nodes.ts";
import { createBoss, startWorker } from "../src/platform/engine/queue.ts";
import { loadEnv } from "../src/platform/env.ts";

registerNodeType("test-crash", {
  label: "Crash",
  configSchema: z.object({}),
  run: () => new Promise(() => {}),
});
registerNodeType("test-echo", {
  label: "Echo",
  configSchema: z.object({ text: z.string() }),
  run: async ({ text }) => ({ output: text }),
});

const env = loadEnv();
const pool = createPool(env.DATABASE_URL);
const boss = createBoss(env.DATABASE_URL, "worker");
await boss.start();
await startWorker(boss, pool, createEngine(pool, boss, { masterKey: env.SECRETS_MASTER_KEY, network: { allowedPrivateHosts: [] }, heartbeatSeconds: 10 }), 5, undefined, undefined, {
  leaseSeconds: Number(process.env.TEST_LEASE_SECONDS ?? 60),
});
