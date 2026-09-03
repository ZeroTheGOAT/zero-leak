// Third pass: `text-white` is invisible on a light theme, so route it through
// --foreground. Genuinely-white surfaces stay literal: the document page canvas
// is paper, and the modal scrims are meant to be black in both themes.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const apply = process.argv.includes('--apply');
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx|ts)$/.test(e)) files.push(p);
  }
})('src');

// Only text-* : bg-white / ring-white/N / bg-black/N are deliberate.
const RE = /\btext-white\b(?!\/)/g;

let total = 0;
for (const file of files) {
  const before = readFileSync(file, 'utf8');
  const after = before.replace(RE, 'text-[var(--foreground)]');
  if (after === before) continue;
  const hits = before.match(RE).length;
  total += hits;
  console.log(`${hits.toString().padStart(3)}  ${file}`);
  if (apply) writeFileSync(file, after);
}
console.log(`\n${total} replacement(s)${apply ? ' — written' : ' — dry run'}`);
