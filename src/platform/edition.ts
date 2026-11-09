import type { Pool, PoolClient } from "pg";
import { extensions } from "./extensions.ts";
import { communityEdition, SALES_EMAIL, type Edition } from "./plans.ts";

/**
 * Which edition this server is. Worked out on every check, so a change reaches the worker with no restart and an expiry needs nothing to run.
 * It works inside a workspace transaction because limits are checked there, under their locks.
 */
export async function editionOf(db: Pool | PoolClient): Promise<Edition> {
  for (const { edition } of extensions()) if (edition) return edition.current(db);
  return communityEdition;
}

/** What a refusal adds, so the reader knows the next step on this install. */
export const upgradeHint = () => extensions().find(({ edition }) => edition)?.edition!.upgrade ?? `To upgrade, contact ${SALES_EMAIL} about the paid package and a licence key.`;
