/** Turns one chosen colour into the app's colour tokens. Every pair of text and background still meets 4.5:1. */
const channels = (hex: string) => [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
const toHex = (rgb: number[]) => `#${rgb.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;

/** Moves `share` of the way from a to b. */
export const mix = (a: string, b: string, share: number) => {
  const [from, to] = [channels(a), channels(b)];
  return toHex(from.map((value, index) => value + (to[index]! - value) * share));
};

const luminance = (hex: string) => {
  const [r, g, b] = channels(hex).map((value) => {
    const part = value / 255;
    return part <= 0.04045 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

export const contrast = (a: string, b: string) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
};

/** Steps a colour towards `target` until it reads on `background`. */
const until = (color: string, target: string, background: string, ratio: number) => {
  let result = color;
  for (let step = 0; step < 40 && contrast(result, background) < ratio; step++) result = mix(result, target, 0.08);
  return result;
};

const WHITE = "#ffffff";
const BLACK = "#000000";
const DARK_SURFACE = "#1a1b1d";

export function brandTokens(accent: string) {
  const main = until(accent, BLACK, WHITE, 4.6);
  const canvas = mix(accent, WHITE, 0.965);
  const rail = until(mix(accent, BLACK, 0.8), BLACK, WHITE, 12);
  const bright = until(accent, WHITE, DARK_SURFACE, 6);
  const light = {
    "--canvas": canvas,
    "--raised": mix(accent, WHITE, 0.98),
    "--sunken": mix(accent, WHITE, 0.92),
    "--ink": until(mix(accent, BLACK, 0.86), BLACK, canvas, 13),
    "--muted": until(mix(accent, BLACK, 0.6), BLACK, canvas, 7),
    "--faint": until(mix(accent, BLACK, 0.45), BLACK, canvas, 4.6),
    "--line": mix(accent, WHITE, 0.87),
    "--line-strong": mix(accent, WHITE, 0.76),
    "--accent": main,
    "--accent-ink": WHITE,
    "--accent-soft": mix(accent, WHITE, 0.86),
    "--rail": rail,
    "--rail-ink": until(mix(accent, WHITE, 0.88), WHITE, rail, 10),
    "--rail-muted": until(mix(accent, WHITE, 0.62), WHITE, rail, 4.6),
    "--rail-active": mix(rail, accent, 0.25),
    "--brand-from": mix(accent, WHITE, 0.92),
    "--brand-mid": mix(accent, WHITE, 0.84),
  };
  const dark = {
    "--accent": bright,
    "--accent-ink": until(mix(bright, BLACK, 0.8), BLACK, bright, 4.6),
    "--accent-soft": mix(bright, DARK_SURFACE, 0.8),
  };
  return { light, dark };
}
