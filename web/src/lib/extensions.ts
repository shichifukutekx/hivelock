/**
 * The web side of src/platform/extensions.ts: the one way to add to this app from outside it. See docs/extensions.md.
 * The glob below finds nothing when the optional package is missing, so its code is not in the build at all.
 */
import type { LucideIcon } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import type { Permission } from "../../../src/platform/permissions.ts";
import type { Me, Workspace } from "./api.ts";

export interface SettingsSection {
  id: string;
  /** Where it goes on the page. "edition" is inside the edition section, for what goes with it. */
  place: "top" | "edition" | "people" | "bottom";
  Component: ComponentType;
}

export interface WebExtension {
  /** Pages inside a workspace. A path the core also names replaces the core's page. */
  routes?: { path: string; element: ReactNode }[];
  navigation?: { to: string; label: string; icon: LucideIcon; permission?: Permission }[];
  /** Pages outside any workspace, for anyone signed in. Each checks for itself who may see it. */
  appRoutes?: { path: string; element: ReactNode }[];
  /** Links to those pages, in the main menu. `shown` is a courtesy: the server still checks. */
  appLinks?: { to: string; label: string; icon: LucideIcon; shown(me: Me): boolean }[];
  settingsSections?: SettingsSection[];
  /** This server's name, logo and colour. Read once, before the first render. */
  loadBrand?(): Promise<{ name?: string; logo?: string; accent?: string }>;
  /** Marks for connectors, as ConnectorIcon draws them. */
  connectorIcons?: Record<string, { color: string; dark?: string; d?: string; text?: string }>;
  /** Another way to sign in. */
  signIn?: { label: string; icon: LucideIcon; problem?(params: URLSearchParams): string; Form: ComponentType<{ email: string; setEmail: (value: string) => void; onBack: () => void }> };
  /** A session that had its second step somewhere else, as the server also accepts. */
  trustsSession?(session: unknown): boolean;
  /** Stands in for the whole workspace when this person cannot enter it yet. */
  workspaceGate?: { applies(workspace: Workspace): boolean; Component: ComponentType<{ owner: boolean; onDone: () => void }> };
  /** The agent page's Tests panel. */
  AgentTests?: ComponentType<{ name: string; onClose: () => void }>;
  /** More ways to start a workflow, in its Triggers panel. */
  EmailTriggerForm?: ComponentType<{ onAdd: (body: unknown) => void; busy: boolean }>;
  /** What can be done with a saved workflow version. */
  VersionActions?: ComponentType<{ workflowId: string; entry: any; current: number; others: any[]; dirty: boolean; onRestored: () => void }>;
}

const packages = import.meta.glob<{ default: WebExtension }>("../../../ee/web/index.tsx");

export let web: WebExtension = {};

/** Runs once before the first render, so no screen is drawn twice. */
export async function loadWebExtension() {
  for (const load of Object.values(packages)) web = (await load()).default;
}

/** The links beyond any workspace that this person gets. */
export const appLinksFor = (me: Me | undefined) => (me ? (web.appLinks ?? []).filter(({ shown }) => shown(me)) : []);
