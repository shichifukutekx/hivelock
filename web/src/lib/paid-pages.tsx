import { MessageCircle } from "lucide-react";
import { PageHeader } from "../components/ui.tsx";
import { Locked } from "./edition.tsx";
import { web } from "./extensions.ts";

/** Paid pages keep their place in the app, and say how to get them, so nothing just disappears. An extension's own page replaces this. */
const LOCKED = [{ to: "/channels", path: "channels", label: "Channels", icon: MessageCircle, permission: "connections:list" as const, description: "Let people talk to an agent outside this app.", locked: "WhatsApp channels are locked." }];

/** What the navigation lists beyond the core's own pages. */
export const workspacePages = () => [...(web.navigation ?? []), ...LOCKED.filter(({ to }) => !web.navigation?.some((item) => item.to === to))];

export const lockedPages = () => LOCKED.filter(({ path }) => !web.routes?.some((route) => route.path === path)).map(({ path, label, icon, description, locked }) => ({
  path, element: <><PageHeader icon={icon} title={label} description={description} /><Locked>{locked}</Locked></>,
}));
