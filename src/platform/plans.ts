const GB = 1024 ** 3;

/**
 * The self-hosted editions. Community is what this code is on its own. Change a limit here and the server, the screens and the docs' numbers follow it.
 * Security and AI model choice are not in this list on purpose: no edition reduces them.
 */
export const SALES_EMAIL = "sales@shichifukutekx.ae";

export type PaidFeature = "sso" | "whatsapp" | "emailTriggers" | "versionHistory" | "evals" | "branding";

export const FEATURE_NAMES: Record<PaidFeature, string> = {
  sso: "Single sign-on",
  whatsapp: "WhatsApp channels",
  emailTriggers: "Email triggers",
  versionHistory: "Workflow version compare and restore",
  branding: "Custom branding",
  evals: "Agent tests",
};

export interface EditionLimits {
  /** Null means no limit, here and below. People and workspaces count across the server, the rest in each workspace. */
  workspaces: number | null;
  people: number | null;
  agents: number | null;
  workflows: number | null;
  storageBytes: number | null;
  /** The connector types that can run. Null means all of them. */
  connectors: readonly string[] | null;
  /** The features that stay switched off. */
  lockedFeatures: readonly PaidFeature[];
}

export const COMMUNITY_READABLE_VERSIONS = 10;

export const COMMUNITY: EditionLimits = {
  workspaces: 1,
  people: 5,
  agents: 5,
  workflows: 10,
  storageBytes: 1 * GB,
  connectors: ["http", "mcp", "email", "database", "slack", "teams"],
  lockedFeatures: ["sso", "whatsapp", "emailTriggers", "versionHistory", "evals", "branding"],
};

export interface Edition {
  id: "community" | "licensed";
  name: string;
  limits: EditionLimits;
  /** Why this server shows Community though a key was given, or that a key is in its grace period. */
  notice?: string;
  license?: { customer: string; expiresAt: string; graceUntil: string; inGrace: boolean; seats: number | null; source: "settings" | "environment" };
}

export const communityEdition: Edition = { id: "community", name: "Community", limits: COMMUNITY };

/** Names only, so a template or a saved connection can say what it needs. The connectors themselves are not in this package. */
export const PAID_CONNECTOR_LABELS: Record<string, string> = {
  airtable: "Airtable", discord: "Discord", github: "GitHub", gitlab: "GitLab", google_drive: "Google Drive", google_sheets: "Google Sheets", hubspot: "HubSpot", jira: "Jira",
  linear: "Linear", microsoft_graph: "Microsoft 365", notion: "Notion", onedrive: "OneDrive", s3: "Amazon S3", salesforce: "Salesforce", shopify: "Shopify", stripe: "Stripe",
  telegram: "Telegram", twilio: "Twilio SMS", whatsapp: "WhatsApp", zendesk: "Zendesk",
};
