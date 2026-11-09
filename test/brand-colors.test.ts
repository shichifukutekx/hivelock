import assert from "node:assert/strict";
import { test } from "node:test";
import { brandTokens, contrast } from "../web/src/lib/brand-colors.ts";

const WHITE = "#ffffff";
const DARK_SURFACE = "#1a1b1d";
const COLOURS = ["#000000", "#ffffff", "#ffff00", "#ff0000", "#00ff00", "#0000ff", "#1f5fbf", "#0d6e5f", "#f2a93b", "#808080", "#ffc0cb", "#6a0dad", "#c8102e", "#00b5e2", "#f7f7f7", "#111111"];

for (const colour of COLOURS) {
  test(`${colour} stays readable in both themes`, () => {
    const { light, dark } = brandTokens(colour);
    assert.ok(contrast(light["--accent"], WHITE) >= 4.5, "accent on white");
    assert.ok(contrast(light["--accent-ink"], light["--accent"]) >= 4.5, "button text");
    for (const text of ["--ink", "--muted", "--faint"] as const) assert.ok(contrast(light[text], light["--canvas"]) >= 4.5, `${text} on the page`);
    assert.ok(contrast(light["--rail-ink"], light["--rail"]) >= 4.5, "menu text");
    assert.ok(contrast(light["--rail-muted"], light["--rail"]) >= 4.5, "quiet menu text");
    assert.ok(contrast(dark["--accent"], DARK_SURFACE) >= 4.5, "accent on dark");
    assert.ok(contrast(dark["--accent-ink"], dark["--accent"]) >= 4.5, "dark button text");
  });
}
