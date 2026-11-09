import { randomUUID } from "node:crypto";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { AgentDefinition } from "../../agents/types.ts";
import { z } from "zod";
import type { Pool } from "pg";
import { guardedTool, type ToolContext } from "../../tools.ts";
import { actionRules, BLOCKED_MESSAGE, ruleFor } from "../action-rules.ts";
import { suggestNote } from "../company-memory.ts";
import { inWorkspace } from "../db.ts";
import { DATA_NOTICE, markAsData } from "../engine/template.ts";
import { redactSecrets } from "../guardrails.ts";
import { seal } from "../secrets.ts";
import type { NetworkPolicy } from "../net/safe-fetch.ts";
import { callReviewedTool } from "./mcp.ts";
import { connectorEdition, connectorLabel, connectorLocked, lockedConnectorMessage } from "../limits.ts";
import { loadConnection } from "./store.ts";
import { getConnector, type ConnectorAction } from "./types.ts";
import type { Passage } from "../knowledge.ts";

interface Source {
  pool: Pool;
  workspaceId: string;
  masterKey: string;
  network: NetworkPolicy;
}

/** Whether a call must wait for a person. Arguments that do not parse will fail anyway, so they count as the riskier case. */
export function actionNeedsApproval(definition: ConnectorAction, args: unknown) {
  if (definition.asksFirst) return true;
  if (typeof definition.changesData !== "function") return definition.changesData;
  const parsed = definition.params.safeParse(args);
  return !parsed.success || definition.changesData(parsed.data);
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30) || "connection";

/**
 * Builds the tools an agent's definition asks for, from this workspace's connections.
 * Credentials stay in these closures, so the model can use an account but never sees it.
 * Anything that may change data asks a person first, and is refused where nobody is watching.
 */
export function capabilityTools({ pool, workspaceId, masterKey, network }: Source, search?: (workspaceId: string, query: string) => Promise<Passage[]>) {
  return async (agent: AgentDefinition) => {
    const prepared = await inWorkspace(pool, workspaceId, async (db) => {
      const edition = await connectorEdition(db);
      const actions = [];
      const locked = [];
      const rules = await actionRules(db, (agent.connections ?? []).map((item) => item.connectionId));
      for (const { connectionId, action } of agent.connections ?? []) {
        const connection = await loadConnection(db, masterKey, workspaceId, connectionId);
        const connector = connection && getConnector(connection.connector);
        const definition = connector?.actions[action];
        const rule = ruleFor(rules, connectionId, action);
        // This install may not have the connector at all, and the agent is still told why.
        if (connection && connectorLocked(edition, connection.connector)) locked.push({ connection, action, label: definition?.label ?? action, reason: lockedConnectorMessage(edition!, connection.connector) });
        else if (connection && definition && rule === "block") locked.push({ connection, action, label: definition.label, reason: BLOCKED_MESSAGE });
        else if (connection && definition && connection.connector !== "mcp") actions.push({ connection, connector: connector!, action, definition, askAlways: rule === "ask" });
      }
      const reviewed = [];
      for (const { connectionId, tool } of agent.mcp ?? []) {
        const { rows: [review] } = await db.query(
          "select name, description, input_schema, fingerprint from mcp_tools where connection_id = $1 and name = $2 and status = 'enabled'",
          [connectionId, tool],
        );
        const connection = review ? await loadConnection(db, masterKey, workspaceId, connectionId) : undefined;
        if (connection) reviewed.push({ review, credentials: connection.credentials });
      }
      return { actions, locked, reviewed };
    });

    return (context: ToolContext): StructuredToolInterface[] => [
      ...prepared.actions.map(({ connection, connector, action, definition, askAlways }, index) => guardedTool(context, {
        name: `${slug(connection.name)}_${action}_${index}`.slice(0, 64),
        description: [`${connector.label}, connection "${connection.name}": ${definition.label}.`, definition.guide?.(connection.credentials)].filter(Boolean).join(" "),
        schema: z.toJSONSchema(definition.params, { unrepresentable: "any" }) as Record<string, unknown>,
        needsApproval: (args) => askAlways || actionNeedsApproval(definition, args),
        run: async (args, { toolCallId }) => {
          const parsed = definition.params.parse(args);
          // The same call keeps the same key, so a receiving service can ignore a repeat.
          const result = await definition.run(connection.credentials, parsed, { network, idempotencyKey: `${context.runId}:${index}:${toolCallId ?? randomUUID()}` });
          return `${markAsData(redactSecrets(JSON.stringify(result ?? null)).text)}\n\n${DATA_NOTICE}`;
        },
      })),
      // Kept as a tool so the agent can say why it cannot act, instead of not knowing the action exists. It holds no credentials.
      ...prepared.locked.map(({ connection, action, label, reason }, index) => guardedTool(context, {
        name: `${slug(connection.name)}_${action}_locked_${index}`.slice(0, 64),
        description: `${connectorLabel(connection.connector)}, connection "${connection.name}": ${label}. Not available here.`,
        schema: { type: "object", properties: {} },
        run: async () => reason,
      })),
      ...prepared.reviewed.map(({ review, credentials }, index) => guardedTool(context, {
        name: `mcp_${slug(review.name)}_${index}`.slice(0, 64),
        description: review.description || review.name,
        schema: review.input_schema,
        // Nothing says what an outside tool changes, so each use is approved.
        needsApproval: () => true,
        run: async (args) => `${markAsData(redactSecrets(await callReviewedTool(credentials, network, review, args)).text)}\n\n${DATA_NOTICE}`,
      })),
      ...(agent.knowledge && search ? [guardedTool(context, {
        name: "search_knowledge",
        description: "Search this workspace's documents. Returns the most relevant passages with their file names. Name the file when you use a passage.",
        schema: { type: "object", properties: { query: { type: "string", description: "What to look for, in plain words." } }, required: ["query"] },
        run: async (args) => {
          const found = await search(workspaceId, String(args.query ?? ""));
          if (!found.length) return "Nothing relevant was found in the workspace's documents.";
          const passages = found.map((item) => `${item.file}, part ${item.part}:\n${markAsData(redactSecrets(item.text).text)}`);
          return `${passages.join("\n\n")}\n\n${DATA_NOTICE}`;
        },
      })] : []),
      ...(agent.memory ? [guardedTool(context, {
        name: "remember",
        description: "Save a short note to use in future chats. A person approves each one.",
        schema: { type: "object", properties: { note: { type: "string", description: "One fact or preference, up to 500 characters." } }, required: ["note"] },
        // A poisoned document must not be able to plant lasting instructions, so a person sees each note first.
        needsApproval: () => true,
        run: async (args) => {
          const note = redactSecrets(String(args.note ?? "").slice(0, 500)).text;
          await inWorkspace(pool, workspaceId, (db) => db.query(
            "insert into agent_memories (workspace_id, agent_name, content) values ($1, $2, $3)",
            [workspaceId, agent.name, JSON.stringify(seal(masterKey, workspaceId, note))],
          ));
          return "Saved.";
        },
      }), guardedTool(context, {
        name: "suggest_company_note",
        description: "Suggest a lasting fact or rule for company memory, which every agent here reads. Use it for things that hold for the whole company, such as a policy, a preferred format or a standing deadline, not for one person's taste. It is only a suggestion: a person accepts or declines it later.",
        schema: { type: "object", properties: { note: { type: "string", description: "One fact or rule, in plain words, up to 1,000 characters." } }, required: ["note"] },
        // Nothing takes effect until a person accepts it under Company memory, so asking here as well would only interrupt.
        run: async (args) => inWorkspace(pool, workspaceId, (db) => suggestNote(db, masterKey, workspaceId, agent.name, String(args.note ?? ""))),
      })] : []),
    ];
  };
}
