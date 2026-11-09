import { join } from "node:path";
import type { PgBoss } from "pg-boss";
import type { Pool, PoolClient } from "pg";
import { extractIsolated } from "../rfq/extract.ts";
import { inWorkspace } from "./db.ts";
import { workspaceFolders } from "./engine/nodes.ts";
import { isPaused, PAUSE_CHECK_SECONDS } from "./limits.ts";
import { guardedModelFetch, keyOf } from "./model-providers.ts";
import { seal, unseal } from "./secrets.ts";
import { isConfidential, recordTokens } from "./usage.ts";
import { serviceProblem } from "./plain-errors.ts";

export const KNOWLEDGE_QUEUE = "knowledge-index";
const CHUNK_SIZE = 1_200;
const OVERLAP = 150;
const BATCH = 32;
const RANK_CONSTANT = 60;
const CANDIDATES = 30;

export interface IndexJob {
  workspaceId: string;
  documentId: string;
  /** When the file was queued, as the database wrote it. A job for an older upload finds a newer stamp and does nothing. Missing on jobs queued before this existed. */
  stamp?: string;
}

export interface Passage {
  file: string;
  part: number;
  text: string;
  matched: "keywords" | "meaning" | "both";
  score: number;
}

/** Splits text into overlapping passages, preferring to break between paragraphs and sentences. */
export function chunkText(text: string, size = CHUNK_SIZE, overlap = OVERLAP) {
  const clean = text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(clean.length, start + size);
    if (end < clean.length) {
      const window = clean.slice(start + Math.floor(size / 2), end);
      const paragraph = window.lastIndexOf("\n\n");
      const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("\n"));
      const cut = paragraph >= 0 ? paragraph : sentence;
      if (cut >= 0) end = start + Math.floor(size / 2) + cut + 1;
    }
    const chunk = clean.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= clean.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

const embedVector = (values: number[]) => `[${values.join(",")}]`;

/** The first enabled provider with an embedding model that this workspace's data rules allow. */
async function embedder(pool: Pool, workspaceId: string, masterKey: string) {
  const confidential = await isConfidential(pool, workspaceId);
  const rows = await inWorkspace(pool, workspaceId, async (db) => (await db.query(
    "select * from model_providers where enabled and models ? 'embedding' and models->>'embedding' <> '' order by priority, created_at",
  )).rows);
  const row = rows.find((candidate) => !confidential || candidate.confidential_allowed);
  if (!row) return undefined;
  const model = row.models.embedding as string;
  const apiKey = keyOf(masterKey, workspaceId, row);
  return {
    model,
    embed: async (input: string[]) => {
      const response = await guardedModelFetch(row.base_url)(`${row.base_url.replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, input }),
      });
      if (!response.ok) throw new Error(serviceProblem("The embedding service", response.status));
      const body = await response.json() as { data: { embedding: number[]; index: number }[]; usage?: { total_tokens?: number } };
      if (body.usage?.total_tokens) await recordTokens(pool, workspaceId, body.usage.total_tokens);
      return [...body.data].sort((a, b) => a.index - b.index).map((item) => item.embedding);
    },
  };
}

/**
 * A document's lifecycle: queued → indexing → ready or failed, and back to queued when it is uploaded again or held
 * by a pause. Each job carries the stamp of the upload it is for, so only the newest upload's job can move it.
 */
const current = "($2::timestamptz is null or updated_at = $2::timestamptz)";

/** Longer than every attempt a job gets, so a document still indexing after this was left by a worker that died. */
export const STUCK_INDEXING_HOURS = 2;

export function createKnowledge(pool: Pool, boss: PgBoss, { masterKey }: { masterKey: string }) {
  /** Queues a file for indexing. Indexing it again replaces its passages. */
  async function enqueue(workspaceId: string, fileName: string) {
    await inWorkspace(pool, workspaceId, async (db) => {
      const { rows: [row] } = await db.query(
        `insert into knowledge_documents (workspace_id, file_name) values ($1, $2)
         on conflict (workspace_id, file_name) do update set status = 'queued', error = null, updated_at = clock_timestamp() returning id, updated_at::text as stamp`,
        [workspaceId, fileName],
      );
      await boss.send(KNOWLEDGE_QUEUE, { workspaceId, documentId: row.id, stamp: row.stamp }, jobOptions(db));
    });
  }

  const jobOptions = (db: PoolClient) => ({ retryLimit: 2, retryDelay: 5, expireInSeconds: 1_800, db: { executeSql: (sql: string, values?: unknown[]) => db.query(sql, values as unknown[]) } });

  /** Embedding spends the workspace's model allowance. While paused the file waits as queued, and its job comes back until Resume, as a held step does. */
  const heldByPause = (job: IndexJob) => inWorkspace(pool, job.workspaceId, async (db) => {
    if (!(await isPaused(db, job.workspaceId))) return false;
    const { rows: [row] } = await db.query(
      `update knowledge_documents set status = 'queued', updated_at = clock_timestamp() where id = $1 and ${current} returning updated_at::text as stamp`,
      [job.documentId, job.stamp ?? null],
    );
    // A newer upload already has its own job, so this one simply ends.
    if (row) await boss.send(KNOWLEDGE_QUEUE, { ...job, stamp: row.stamp }, { ...jobOptions(db), startAfter: PAUSE_CHECK_SECONDS });
    return true;
  });

  async function index(job: IndexJob) {
    const { workspaceId, documentId } = job;
    if (await heldByPause(job)) return;
    // queued → indexing, or indexing again when this same job is retried after a crash.
    const document = await inWorkspace(pool, workspaceId, async (db) => {
      const { rows: [row] } = await db.query(
        `update knowledge_documents set status = 'indexing' where id = $1 and status in ('queued', 'indexing') and ${current} returning file_name`,
        [documentId, job.stamp ?? null],
      );
      return row;
    });
    if (!document) return;
    try {
      const text = await extractIsolated(join(workspaceFolders(workspaceId).files, document.file_name));
      const chunks = chunkText(text);
      const service = await embedder(pool, workspaceId, masterKey).catch(() => undefined);
      let vectors: (number[] | undefined)[] = chunks.map(() => undefined);
      let embedded = false;
      // Keyword search still works if this fails, so a broken embedding service does not lose the file.
      if (service) {
        try {
          const found: number[][] = [];
          for (let start = 0; start < chunks.length; start += BATCH) {
            // A large file takes many calls, so a pause pressed part way through stops it here. It starts again after Resume.
            if (start > 0 && await heldByPause(job)) return;
            found.push(...await service.embed(chunks.slice(start, start + BATCH)));
          }
          vectors = found;
          embedded = found.length === chunks.length;
        } catch (error) {
          console.error(JSON.stringify({ level: "warn", event: "embedding_failed", message: (error as Error).message }));
          vectors = chunks.map(() => undefined);
        }
      }
      await inWorkspace(pool, workspaceId, async (db) => {
        // indexing → ready, only if no newer upload replaced this one while it was read.
        const { rows: [mine] } = await db.query(`select 1 from knowledge_documents where id = $1 and status = 'indexing' and ${current} for update`, [documentId, job.stamp ?? null]);
        if (!mine) return;
        await db.query("delete from knowledge_chunks where document_id = $1", [documentId]);
        for (const [position, chunk] of chunks.entries()) {
          await db.query(
            `insert into knowledge_chunks (workspace_id, document_id, position, content, search, embedding, embedding_model)
             values ($1, $2, $3, $4, to_tsvector('english', $5), $6::vector, $7)`,
            [workspaceId, documentId, position, JSON.stringify(seal(masterKey, workspaceId, chunk)), chunk, vectors[position] ? embedVector(vectors[position]!) : null, vectors[position] ? service!.model : null],
          );
        }
        await db.query("update knowledge_documents set status = 'ready', chunks = $2, embedded = $3, error = null, updated_at = now() where id = $1", [documentId, chunks.length, embedded]);
      });
    } catch (error) {
      await inWorkspace(pool, workspaceId, (db) => db.query(
        `update knowledge_documents set status = 'failed', error = $3, updated_at = clock_timestamp() where id = $1 and status = 'indexing' and ${current}`,
        [documentId, job.stamp ?? null, (error as Error).message.slice(0, 300)],
      ));
    }
  }

  /** Finds passages by keywords and, where available, by meaning, then merges both rankings. */
  async function search(workspaceId: string, query: string, limit = 6): Promise<Passage[]> {
    const text = query.slice(0, 2_000);
    const service = await embedder(pool, workspaceId, masterKey).catch(() => undefined);
    const vector = await service?.embed([text]).then(([first]) => first).catch(() => undefined);
    const { keyword, semantic } = await inWorkspace(pool, workspaceId, async (db) => {
      const select = "select c.id, c.position, c.content, d.file_name from knowledge_chunks c join knowledge_documents d on d.id = c.document_id";
      // Any word can match, because people ask in sentences. Passages matching more words rank higher.
      const terms = "to_tsquery('english', replace(plainto_tsquery('english', $1)::text, ' & ', ' | '))";
      const keyword = (await db.query(
        `${select} where c.search @@ ${terms} order by ts_rank_cd(c.search, ${terms}) desc limit $2`,
        [text, CANDIDATES],
      )).rows;
      const semantic = vector ? (await db.query(
        `${select} where c.embedding_model = $1 and vector_dims(c.embedding) = $2 order by c.embedding <=> $3::vector limit $4`,
        [service!.model, vector.length, embedVector(vector), CANDIDATES],
      )).rows : [];
      return { keyword, semantic };
    });
    const merged = new Map<string, { row: any; score: number; inKeyword: boolean; inMeaning: boolean }>();
    const add = (rows: any[], flag: "inKeyword" | "inMeaning") => rows.forEach((row, rank) => {
      const entry = merged.get(row.id) ?? { row, score: 0, inKeyword: false, inMeaning: false };
      entry.score += 1 / (RANK_CONSTANT + rank + 1);
      entry[flag] = true;
      merged.set(row.id, entry);
    });
    add(keyword, "inKeyword");
    add(semantic, "inMeaning");
    return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit).map(({ row, score, inKeyword, inMeaning }) => ({
      file: row.file_name,
      part: row.position + 1,
      text: unseal(masterKey, workspaceId, row.content) as string,
      matched: inKeyword && inMeaning ? "both" : inKeyword ? "keywords" : "meaning",
      score: Number(score.toFixed(5)),
    }));
  }

  const remove = (workspaceId: string, fileName: string) => inWorkspace(pool, workspaceId, (db) => db.query("delete from knowledge_documents where file_name = $1", [fileName]));

  return { enqueue, index, search, remove };
}

export type Knowledge = ReturnType<typeof createKnowledge>;
