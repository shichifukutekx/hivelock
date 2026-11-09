import { brandTokens } from "./brand-colors.ts";

/** Who this app says it is. A server with custom branding changes this once, before the first render. */
export const brand: { name: string; logo?: string } = { name: "Hivelock" };

const block = (selector: string, tokens: Record<string, string>) => `${selector} { ${Object.entries(tokens).map(([name, value]) => `${name}: ${value};`).join(" ")} }`;

export function applyBrand({ name, logo, accent }: { name?: string; logo?: string; accent?: string }) {
  if (name) brand.name = name;
  if (logo) brand.logo = logo;
  document.title = brand.name;
  if (logo) document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.setAttribute("href", logo);
  if (!accent) return;
  // The page allows no inline styles, and a constructed sheet is not one.
  const { light, dark } = brandTokens(accent);
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`${block(':root:not([data-theme="dark"])', light)}\n${block('[data-theme="dark"]', dark)}`);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}
