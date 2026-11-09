import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const css = readFileSync("web/src/app.css", "utf8");
const block = (start: string) => css.slice(css.indexOf(start)).split(/\n}/)[0]!;
const tokens = (text: string) => Object.fromEntries([...text.matchAll(/--([a-z-]+): (#[0-9a-f]{6});/g)].map((match) => [match[1]!, match[2]!]));
const light = tokens(block(":root {"));
const dark = { ...light, ...tokens(block('[data-theme="dark"] {')) };

const channel = (value: number) => {
  const part = value / 255;
  return part <= 0.04045 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((start) => channel(parseInt(hex.slice(start, start + 2), 16)));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
};

/** Every place text sits on a colour in the app. Faint and muted text appear on all four page surfaces. */
const PAIRS: [text: string, on: string][] = [
  ...["ink", "muted", "faint", "accent", "danger"].flatMap((text) => ["canvas", "surface", "raised"].map((on): [string, string] => [text, on])),
  ["ink", "sunken"], ["muted", "sunken"], ["faint", "sunken"], ["accent", "sunken"],
  ["accent", "accent-soft"], ["accent", "honey-soft"], ["accent-ink", "accent"], ["ink", "accent-soft"],
  ["honey-ink", "honey"],
  ["ok", "ok-soft"], ["warn", "warn-soft"], ["danger", "danger-soft"], ["info", "info-soft"],
  ["ok", "surface"], ["warn", "surface"], ["info", "surface"],
  ["rail-ink", "rail"], ["rail-muted", "rail"], ["rail-ink", "rail-active"], ["rail-muted", "rail-active"], ["honey", "rail"],
  ["ink", "brand-from"], ["ink", "brand-mid"], ["ink", "brand-to"],
  ["accent", "brand-from"], ["accent", "brand-mid"], ["accent", "brand-to"],
];

for (const [name, theme] of [["light", light], ["dark", dark]] as const) {
  test(`text is at least 4.5:1 on everything it sits on, in the ${name} theme`, () => {
    for (const [text, on] of PAIRS) {
      assert.ok(theme[text] && theme[on], `${text} on ${on} names a colour that does not exist`);
      const ratio = contrast(theme[text]!, theme[on]!);
      assert.ok(ratio >= 4.5, `${text} on ${on} is ${ratio.toFixed(2)}:1`);
    }
    assert.ok(contrast("#ffffff", theme.rail!) >= 4.5 && contrast("#ffffff", theme["rail-active"]!) >= 4.5, "white text in the rail");
  });
}

test("the palette is the landing page's", () => {
  assert.equal(light.ink, "#052719");
  assert.equal(light.accent, "#0d6e5f");
  assert.equal(light.honey, "#f2a93b");
  assert.equal(dark.honey, "#f2a93b");
});

test("fonts are bundled, and the app asks no other server for anything", () => {
  const face = css.match(/@font-face \{[\s\S]*?\}/)![0];
  assert.match(face, /font-family: "Onest"/);
  const file = face.match(/url\("\.\/([^"]+)"\)/)![1]!;
  assert.ok(existsSync(join("web/src", file)), file);
  assert.match(css, /--font-sans: "Inter Variable"/);
  assert.match(css, /h1, h2, h3 \{ font-family: var\(--font-display\); \}/);
  const outside = [...css.replace(/data:image\/svg\+xml[^"]*/g, "").matchAll(/https?:\/\//g)];
  assert.equal(outside.length, 0, "no address in the styles");
  assert.doesNotMatch(readFileSync("web/index.html", "utf8"), /https?:\/\//);
});

test("buttons stay rounded rectangles", () => {
  const ui = readFileSync("web/src/components/ui.tsx", "utf8");
  const button = ui.slice(ui.indexOf("export function Button"), ui.indexOf("const fieldClass"));
  assert.match(button, /rounded-lg/);
  const sources = readdirSync("web/src", { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".tsx"));
  for (const file of sources) {
    for (const line of readFileSync(join("web/src", file), "utf8").split("\n")) {
      if (/<(Button|button|a|Link)\b[^>]*className="[^"]*rounded-full/.test(line)) assert.fail(`a pill in ${file}: ${line.trim().slice(0, 100)}`);
    }
  }
});

test("motion uses only opacity and transform, and stops for those who ask", () => {
  for (const [, rule] of css.matchAll(/transition: ([^;]+);/g)) {
    if (rule === "none !important") continue;
    assert.match(rule!, /^(transform|opacity) /, rule);
  }
  for (const [, body] of css.matchAll(/@keyframes [\w-]+ \{(.*)\}$/gm)) {
    for (const [, property] of body!.matchAll(/([a-z-]+):/g)) assert.ok(["opacity", "transform"].includes(property!), property);
  }
  assert.match(css, /prefers-reduced-motion: reduce\) \{\n  \*, \*::before, \*::after \{ animation: none !important; transition: none !important; \}/);
});

test("the logo's keyhole is a real hole, so no surface can show the wrong colour through it", () => {
  const logo = readFileSync("web/src/components/Logo.tsx", "utf8");
  assert.match(logo, /<mask /);
  assert.match(logo, /fill="black"/);
  assert.doesNotMatch(css, /--logo-key/);
  assert.doesNotMatch(css, /\.logo-key \{[^}]*fill/);
  const favicon = readFileSync("web/public/assets/hivelock-mark.svg", "utf8");
  assert.match(favicon, /fill-rule="evenodd"/);
  assert.match(favicon, /prefers-color-scheme:dark/);
});
