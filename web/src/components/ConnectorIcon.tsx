import { Cable, FolderOpen } from "lucide-react";
import type { CSSProperties } from "react";
import { web } from "../lib/extensions.ts";

/**
 * Connector marks, copied from site/docs/connectors.html: the same paths, brand colors and monograms.
 * `dark` applies under the dark theme, where these brand colors would fade into the tile.
 */
const BRANDS: Record<string, { color: string; dark?: string; d?: string; text?: string }> = {
  mcp: { color: "#052719", dark: "#ECEEEE", d: "M13.85 0a4.16 4.16 0 0 0-2.95 1.217L1.456 10.66a.835.835 0 0 0 0 1.18.835.835 0 0 0 1.18 0l9.442-9.442a2.49 2.49 0 0 1 3.541 0 2.49 2.49 0 0 1 0 3.541L8.59 12.97l-.1.1a.835.835 0 0 0 0 1.18.835.835 0 0 0 1.18 0l.1-.098 7.03-7.034a2.49 2.49 0 0 1 3.542 0l.049.05a2.49 2.49 0 0 1 0 3.54l-8.54 8.54a1.96 1.96 0 0 0 0 2.755l1.753 1.753a.835.835 0 0 0 1.18 0 .835.835 0 0 0 0-1.18l-1.753-1.753a.266.266 0 0 1 0-.394l8.54-8.54a4.185 4.185 0 0 0 0-5.9l-.05-.05a4.16 4.16 0 0 0-2.95-1.218c-.2 0-.401.02-.6.048a4.17 4.17 0 0 0-1.17-3.552A4.16 4.16 0 0 0 13.85 0m0 3.333a.84.84 0 0 0-.59.245L6.275 10.56a4.186 4.186 0 0 0 0 5.902 4.186 4.186 0 0 0 5.902 0L19.16 9.48a.835.835 0 0 0 0-1.18.835.835 0 0 0-1.18 0l-6.985 6.984a2.49 2.49 0 0 1-3.54 0 2.49 2.49 0 0 1 0-3.54l6.983-6.985a.835.835 0 0 0 0-1.18.84.84 0 0 0-.59-.245" },
  slack: { text: "Sl", color: "#4A154B", dark: "#C9A2CB" },
  teams: { text: "Te", color: "#4B53BC", dark: "#8B92EC" },
};

/** HTTP, Email and Database are not brands, so they draw in the theme's accent, as on the site. */
const NEUTRAL: Record<string, React.ReactNode> = {
  http: <g strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.8 2.6 4 5.6 4 9s-1.2 6.400-4 9c-2.800-2.600-4-5.600-4-9s1.200-6.400 4-9z" /></g>,
  email: <g strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M3.500 7.500L12 13l8.500-5.500" /></g>,
  database: <g><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v12c0 1.700 3.600 3 8 3s8-1.300 8-3V6M4 12c0 1.700 3.600 3 8 3s8-1.300 8-3" /></g>,
};

/** A connector's mark in a soft tile, keyed by connector name. Decorative: the name is always written next to it. */
export function ConnectorIcon({ name, size = 28, className = "" }: { name?: string; size?: number; className?: string }) {
  const brand = name ? BRANDS[name] ?? web.connectorIcons?.[name] : undefined;
  const neutral = name ? NEUTRAL[name] : undefined;
  const style = { "--tile": `${size}px`, ...(brand && { "--brand": brand.color, "--brand-dark": brand.dark ?? brand.color }) } as CSSProperties;
  const Fallback = name === "files" ? FolderOpen : Cable;
  return (
    <span aria-hidden="true" style={style} className={`conn-tile ${brand ? "conn-brand" : ""} ${className}`}>
      {neutral ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>{neutral}</svg>
        : brand?.d ? <svg viewBox="0 0 24 24"><path fill="currentColor" d={brand.d} /></svg>
        : brand?.text ? <b>{brand.text}</b>
        : <Fallback />}
    </span>
  );
}
