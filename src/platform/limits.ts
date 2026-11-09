import type { Pool, PoolClient } from "pg";
import { hostedMode } from "../config.ts";
import { getConnector } from "./connectors/types.ts";
import { inWorkspace } from "./db.ts";
import { workspaceFolders } from "./engine/nodes.ts";
import { allFiles } from "./workspace-files.ts";
import { editionOf, upgradeHint } from "./edition.ts";
import { hostedPolicy } from "./extensions.ts";
import { COMMUNITY_READABLE_VERSIONS, FEATURE_NAMES, PAID_CONNECTOR_LABELS, SALES_EMAIL, type Edition, type PaidFeature } from "./plans.ts";

/** Refused because of the plan. Everything already stored stays as it is. */
export class PlanLimit extends Error {
  readonly code: string = "plan_limit";
}

/** Refused because of the self-hosted edition. Callers that handle a plan limit handle this too. */
export class EditionLimit extends PlanLimit {
  override readonly code = "edition_limit";
}

const overLimit = (edition: Edition, what: string) => new EditionLimit(`The ${edition.name} edition allows ${what}. ${upgradeHint()}`);

/** A person pressed Pause all. Work is held, not lost. */
export class WorkspacePaused extends PlanLimit {
  override readonly code = "workspace_paused";
  constructor() {
    super("This workspace is paused. Resume it to carry on.");
  }
}

/** How often held work looks again, so Resume takes effect within this long. */
export const PAUSE_CHECK_SECONDS = 15;

export async function isPaused(db: PoolClient, workspaceId: string) {
  const { rows: [row] } = await db.query("select paused_at from workspace_settings where workspace_id = $1", [workspaceId]);
  return !!row?.paused_at;
}

export async function assertNotPaused(db: PoolClient, workspaceId: string) {
  if (await isPaused(db, workspaceId)) throw new WorkspacePaused();
}

/** Staff have stopped this workspace. A self-hosted server has no staff, so this is only ever true when hosted. */
export async function isSuspended(db: PoolClient, workspaceId: string) {
  return hostedMode() && hostedPolicy().isSuspended(db, workspaceId);
}

/** Stops new work in a workspace that is read-only. Does nothing self-hosted. */
export async function assertActive(db: PoolClient, workspaceId: string) {
  if (!hostedMode()) return undefined;
  return hostedPolicy().assertActive(db, workspaceId);
}

/** The caller's transaction holds the lock until it ends, so two creations at once cannot both take the last place. */
export async function assertAgentRoom(db: PoolClient, workspaceId: string) {
  const plan = await assertActive(db, workspaceId);
  const edition = plan ? undefined : await editionOf(db);
  const limit = plan ? plan.agents : edition!.limits.agents;
  if (limit === null) return;
  await db.query("select pg_advisory_xact_lock(hashtext($1))", [`agents:${workspaceId}`]);
  const { rows: [{ count }] } = await db.query("select count(*)::int from workspace_agents");
  if (count < limit) return;
  throw plan ? new PlanLimit(`The ${plan.name} plan allows ${limit} agents. Upgrade, or delete one first.`) : overLimit(edition!, `${limit} agents`);
}

/** Same as agents, for workflows. Hosted plans set no such limit. */
export async function assertWorkflowRoom(db: PoolClient, workspaceId: string) {
  if (hostedMode()) return;
  const edition = await editionOf(db);
  const limit = edition.limits.workflows;
  if (limit === null) return;
  await db.query("select pg_advisory_xact_lock(hashtext($1))", [`workflows:${workspaceId}`]);
  const { rows: [{ count }] } = await db.query("select count(*)::int from workflows");
  if (count >= limit) throw overLimit(edition, `${limit} workflows`);
}

/** Self-hosted only. Only the administrator creates workspaces, one at a time, so the caller's lock makes this count safe. */
export async function assertWorkspaceRoom(db: Pool | PoolClient) {
  if (hostedMode()) return;
  const edition = await editionOf(db);
  const limit = edition.limits.workspaces;
  if (limit === null) return;
  const { rows: [{ count }] } = await db.query("select count(*)::int from organization");
  if (count >= limit) throw overLimit(edition, `${limit} workspace`);
}

const PEOPLE_COUNT = `
  select (select count(distinct "userId")::int from member) as members,
         (select count(distinct lower(i.email))::int from invitation i
          where i.status = 'pending' and i."expiresAt" > now()
            and not exists (select 1 from member m join "user" u on u.id = m."userId" where lower(u.email) = lower(i.email))) as invited,
         exists (select 1 from member m join "user" u on u.id = m."userId" where lower(u.email) = $1) as known,
         exists (select 1 from invitation where lower(email) = $1 and status = 'pending' and "expiresAt" > now()) as pending`;

/**
 * Hosted plans count seats in the database, which cannot check a licence key's signature, so a self-hosted server counts here.
 * The caller holds PEOPLE_LOCK. An invitation holds a place, and someone already on the server takes no new one.
 */
export const PEOPLE_LOCK = "people";
export async function assertPeopleRoom(db: Pool | PoolClient, { email, joining }: { email: string; joining: boolean }) {
  if (hostedMode()) return;
  const edition = await editionOf(db);
  const limit = edition.limits.people;
  if (limit === null) return;
  const { rows: [row] } = await db.query(PEOPLE_COUNT, [email.trim().toLowerCase()]);
  if (row.known || (!joining && row.pending)) return;
  if ((joining ? row.members : row.members + row.invited) < limit) return;
  throw edition.id === "community" ? overLimit(edition, `${limit} people`) : new EditionLimit(`This licence key allows ${limit} people. To add more, contact ${SALES_EMAIL}.`);
}

/** Counts runs in one statement. It adds nothing once the month's allowance is used, however many arrive at once. */
export async function consumeRuns(db: PoolClient, workspaceId: string, count = 1) {
  const plan = await assertActive(db, workspaceId);
  if (plan) await hostedPolicy().consumeRuns(db, workspaceId, plan, count);
}

function filesOnDisk(workspaceId: string) {
  return allFiles(workspaceFolders(workspaceId).files).reduce((total, file) => total + file.size, 0);
}

/** Self-hosted servers counted nothing before editions, so the count starts from what is on disk. */
async function startStorageCount(db: PoolClient, workspaceId: string) {
  const { rowCount } = await db.query("select 1 from workspace_storage");
  if (!rowCount) await db.query("insert into workspace_storage (workspace_id, bytes) values ($1, $2) on conflict do nothing", [workspaceId, filesOnDisk(workspaceId)]);
}

/** Holds room for a file before it is written, so uploads at the same moment cannot overrun the plan together. A licensed server counts too, so a lapsed licence finds a true figure. */
export async function reserveStorage(pool: Pool, workspaceId: string, bytes: number) {
  await inWorkspace(pool, workspaceId, async (db) => {
    const plan = await assertActive(db, workspaceId);
    const edition = plan ? undefined : await editionOf(db);
    if (edition) await startStorageCount(db, workspaceId);
    const limit = plan ? plan.storageBytes : edition!.limits.storageBytes ?? Number.MAX_SAFE_INTEGER;
    const { rowCount } = await db.query(
      `insert into workspace_storage (workspace_id, bytes) select $1, $2::bigint where $2::bigint <= $3::bigint
       on conflict (workspace_id) do update set bytes = workspace_storage.bytes + excluded.bytes
         where workspace_storage.bytes + excluded.bytes <= $3::bigint`,
      [workspaceId, bytes, limit],
    );
    if (rowCount) return;
    throw plan ? new PlanLimit(`This file would take the workspace over the ${limit / 1024 ** 3} GB in its ${plan.name} plan.`) : overLimit(edition!, `${limit / 1024 ** 3} GB of document storage`);
  });
}

export async function releaseStorage(pool: Pool, workspaceId: string, bytes: number) {
  await inWorkspace(pool, workspaceId, (db) => db.query("update workspace_storage set bytes = greatest(bytes - $1::bigint, 0) where workspace_id = $2", [bytes, workspaceId]));
}

export type Feature = PaidFeature;

/** Hosted plans decide, or the edition does. */
export async function hasFeature(pool: Pool, workspaceId: string, feature: Feature) {
  if (hostedMode()) return hostedPolicy().hasFeature(pool, workspaceId, feature);
  return !(await editionOf(pool)).limits.lockedFeatures.includes(feature);
}

export async function assertFeature(pool: Pool, workspaceId: string, feature: Feature) {
  if (await hasFeature(pool, workspaceId, feature)) return;
  if (hostedMode()) throw new PlanLimit(hostedPolicy().featureRefusal(feature));
  throw new EditionLimit(`${FEATURE_NAMES[feature]} is not included in the ${(await editionOf(pool)).name} edition. ${upgradeHint()}`);
}

export const oldVersionRefused = () => new EditionLimit(`The Community edition keeps the last ${COMMUNITY_READABLE_VERSIONS} versions readable. Older ones stay stored. ${upgradeHint()}`);

/** A connector's name for people, including one this install does not have. */
export const connectorLabel = (name: string) => getConnector(name)?.label ?? PAID_CONNECTOR_LABELS[name] ?? name;

export const connectorRuns = (edition: Edition, name: string) => edition.limits.connectors === null || edition.limits.connectors.includes(name);

/** Saved connections of a type this edition leaves out stay listed. This says why they do not run. */
export const lockedConnectorMessage = (edition: Edition, name: string) =>
  `${connectorLabel(name)} connections cannot run on the ${edition.name} edition. The connection is still saved. ${upgradeHint()}`;

/** The edition to check connectors against. Hosted mode has every connector. */
export const connectorEdition = async (db: Pool | PoolClient): Promise<Edition | undefined> => (hostedMode() ? undefined : editionOf(db));
export const connectorLocked = (edition: Edition | undefined, name: string) => !!edition && !connectorRuns(edition, name);

export async function assertConnector(db: Pool | PoolClient, name: string) {
  const edition = await connectorEdition(db);
  if (edition && !connectorRuns(edition, name)) throw new EditionLimit(lockedConnectorMessage(edition, name));
}

/** What the Edition and licence section shows. */
export const editionUsage = (pool: Pool, workspaceId: string) => inWorkspace(pool, workspaceId, async (db) => {
  const { rows: [row] } = await db.query(
    `select (select count(*)::int from organization) as workspaces, (select count(*)::int from workspace_agents) as agents,
            (select count(*)::int from workflows) as workflows, (select bytes from workspace_storage) as bytes`,
  );
  const { rows: [people] } = await db.query(PEOPLE_COUNT, [""]);
  return { workspaces: row.workspaces, people: people.members + people.invited, agents: row.agents, workflows: row.workflows, storageBytes: row.bytes === null ? filesOnDisk(workspaceId) : Number(row.bytes) };
});
