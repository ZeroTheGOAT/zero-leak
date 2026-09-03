// Each [data-theme-preview][data-color-mode] block must redefine every token the
// PreviewCards swatch reads, or the miniature silently inherits the live theme
// and all three options look identical.
import { readFileSync } from 'node:fs';

const css = readFileSync('src/nerve-theme.css', 'utf8');
const NEED = ['--background', '--sidebar', '--foreground', '--primary', '--border'];

const re = /\[data-theme-preview="(\w+)"\]\[data-color-mode="(\w+)"\]\s*\{([^}]*)\}/g;
let blocks = 0;
let bad = 0;
for (const m of css.matchAll(re)) {
  blocks++;
  const [, theme, mode, body] = m;
  const declared = new Set(
    [...body.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((d) => d[1]),
  );
  const missing = NEED.filter((t) => !declared.has(t));
  if (missing.length) bad++;
  console.log(
    `  ${`${theme}/${mode}`.padEnd(15)} ${declared.size} tokens  ${
      missing.length ? `MISSING ${missing.join(', ')}` : 'all required tokens present'
    }`,
  );
}
console.log(`\n${blocks} preview block(s) (expected 6), ${bad} incomplete`);
