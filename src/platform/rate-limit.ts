import { createHash } from "node:crypto";
import type { Pool } from "pg";

export const LIMITS = {
  /** All API calls by one person. */
  user: { limit: 600, windowSeconds: 60 },
  /** Run starts in one workspace. */
  runStart: { limit: 120, windowSeconds: 60 },
  /** Document searches in one workspace. Each can cost a call to the embedding service. */
  documentSearch: { limit: 60, windowSeconds: 60 },
  /** Template installs in one workspace. */
  templateInstall: { limit: 30, windowSeconds: 60 },
  /** Webhook calls from one address, counted before any signature check. */
  webhookAddress: { limit: 120, windowSeconds: 60 },
  /** Correctly signed calls to one trigger. Only these count, so forged calls cannot lock out the real sender. */
  webhookTrigger: { limit: 60, windowSeconds: 60 },
};

/** Counts a request. Returns false once the limit for this window is used up. */
export async function allow(pool: Pool, key: string, { limit, windowSeconds }: { limit: number; windowSeconds: number }) {
  const hashed = createHash("sha256").update(key).digest("base64url");
  const { rows: [row] } = await pool.query<{ hits: number }>(
    `insert into rate_limits (key, window_start, hits) values ($1, now(), 1)
     on conflict (key) do update set
       hits = case when rate_limits.window_start < now() - make_interval(secs => $2) then 1 else rate_limits.hits + 1 end,
       window_start = case when rate_limits.window_start < now() - make_interval(secs => $2) then now() else rate_limits.window_start end
     returning hits`,
    [hashed, windowSeconds],
  );
  return row!.hits <= limit;
}
