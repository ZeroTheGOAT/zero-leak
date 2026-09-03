// Second pass of the UI tokenisation: replace Tailwind's fixed palette classes
// (bg-emerald-500/10, text-sky-400, border-amber-500/30 ...) with the theme
// tokens, so every accent follows data-theme + light/dark like the rest of the UI.
//
//   node .uifix/palette.mjs           # report only
//   node .uifix/palette.mjs --apply   # rewrite in place
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Colour family -> semantic token. Hue is preserved where the palette already
// agreed with a token (green=success, amber=warning, red=destructive,
// sky/cyan=info); violet/pink map to --accent-2 (chart-2) so the memory-scope
// and block-kind distinctions survive, and orange becomes the brand primary.
const FAMILY = {
  emerald: 'success', green: 'success', teal: 'success', lime: 'success',
  amber: 'warning', yellow: 'warning',
  red: 'destructive', rose: 'destructive',
  sky: 'info', blue: 'info', cyan: 'info', indigo: 'info',
  violet: 'accent-2', purple: 'accent-2', fuchsia: 'accent-2', pink: 'accent-2',
  orange: 'primary',
};

// Neutrals never carried meaning here; they collapse onto the surface tokens.
const NEUTRAL = { slate: 1, gray: 1, zinc: 1, neutral: 1, stone: 1 };
const neutralToken = (shade) => {
  const n = Number(shade);
  if (n >= 700) return 'background';
  if (n >= 600) return 'card';
  if (n >= 500) return 'border';
  if (n >= 400) return 'muted-foreground';
  return 'foreground';
};

// A translucent fill becomes the -soft variant, a translucent edge the -ring
// variant; translucent text just uses the token (a token at 70-90% reads the same).
function token(prefix, family, shade, alpha) {
  if (NEUTRAL[family]) return neutralToken(shade);
  const base = FAMILY[family];
  if (!base) return null;
  if (!alpha) return base;
  if (prefix === 'bg' || prefix === 'from' || prefix === 'to' || prefix === 'via') return `${base}-soft`;
  if (prefix === 'border' || prefix === 'divide' || prefix === 'ring' || prefix === 'outline') return `${base}-ring`;
  return base;
}

const PREFIX = 'bg|text|border|from|to|via|ring|fill|stroke|divide|placeholder|decoration|outline|accent|caret|shadow';
const RE = new RegExp(
  `\\b(${PREFIX})-(${[...Object.keys(FAMILY), ...Object.keys(NEUTRAL)].join('|')})-(\\d{2,3})(?:/(\\[[^\\]]+\\]|\\d{1,3}))?`,
  'g',
);

const apply = process.argv.includes('--apply');
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx|ts|css)$/.test(e)) files.push(p);
  }
})('src');

let total = 0;
const unmapped = new Map();
for (const file of files) {
  const before = readFileSync(file, 'utf8');
  let hits = 0;
  const after = before.replace(RE, (whole, prefix, family, shade, alpha) => {
    const t = token(prefix, family, shade, alpha);
    if (!t) {
      unmapped.set(whole, (unmapped.get(whole) ?? 0) + 1);
      return whole;
    }
    hits++;
    return `${prefix}-[var(--${t})]`;
  });
  if (!hits) continue;
  total += hits;
  console.log(`${hits.toString().padStart(3)}  ${file}`);
  if (apply) writeFileSync(file, after);
}
console.log(`\n${total} replacement(s) across ${files.length} scanned file(s)${apply ? ' — written' : ' — dry run'}`);
if (unmapped.size) {
  console.log('\nunmapped:');
  for (const [k, v] of [...unmapped].sort((a, b) => b[1] - a[1])) console.log(`  ${v}  ${k}`);
}
