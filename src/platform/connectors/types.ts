import { z } from "zod";
import type { NetworkPolicy } from "../net/safe-fetch.ts";

export interface ActionContext {
  network: NetworkPolicy;
  /** The same on every attempt of a step, so a receiving service can ignore a repeat. */
  idempotencyKey: string;
}

export interface ConnectorAction {
  label: string;
  /** True if this changes something outside the platform. Such actions run at most once. */
  changesData: boolean | ((params: any) => boolean);
  params: z.ZodType;
  run(credentials: any, params: any, context: ActionContext): Promise<unknown>;
  /** An agent always asks a person first, because the method alone does not say what a service will do. */
  asksFirst?: boolean;
  /** Gives whoever sets it up a mailbox's contents, so it needs the same right as a mailbox trigger. */
  readsMail?: boolean;
  /** Extra words for an agent using this action, from the connection's own settings, such as which SQL dialect it speaks. */
  guide?(credentials: any): string | undefined;
}

export interface CredentialField {
  name: string;
  label: string;
  type: "text" | "password" | "number" | "boolean" | "url";
  required?: boolean;
  help?: string;
  /** What a box starts as. The form shows it, so what a person sees is what gets saved. */
  default?: boolean;
}

export interface Connector {
  name: string;
  label: string;
  category: "web" | "email" | "database" | "chat" | "files" | "mcp" | "productivity" | "customers" | "developer" | "commerce";
  description: string;
  fields: CredentialField[];
  credentials: z.ZodType;
  actions: Record<string, ConnectorAction>;
  /** Proves the credentials work without changing anything. */
  test(credentials: any, context: ActionContext): Promise<void>;
}

export const MAIL_READ_REFUSED = "Only an admin can use an action that reads a mailbox, because its results show the messages.";

export class MailReadRefused extends Error {
  readonly code = "mail_read_refused";
  constructor() {
    super(MAIL_READ_REFUSED);
  }
}

/** The action failed and must not be retried. */
export class PermanentError extends Error {}

/** The action failed before anything happened, so a retry is safe. */
export class NotStarted extends Error {}

const connectors = new Map<string, Connector>();

/** Adds a connector. This is the whole of the connector kit: a new file calling this is all a new service needs. */
export function registerConnector(connector: Connector) {
  if (connectors.has(connector.name)) throw new Error(`Connector ${connector.name} already exists.`);
  connectors.set(connector.name, connector);
}

export const getConnector = (name: string) => connectors.get(name);

export const listConnectors = () => [...connectors.values()].map(({ name, label, category, description, fields, actions }) => ({
  name, label, category, description, fields,
  actions: Object.entries(actions).map(([id, action]) => ({
    id, label: action.label,
    changesData: typeof action.changesData === "function" ? "depends" : action.changesData,
    // Lets the builder draw a form for this action.
    params: z.toJSONSchema(action.params, { unrepresentable: "any" }),
  })),
}));
