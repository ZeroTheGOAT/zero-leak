import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MAP } from './map.mjs';

const APPLY = process.argv.includes('--apply');
const files = [];
(function walk(d){ for(const e of readdirSync(d)){ const p=join(d,e);
  if(statSync(p).isDirectory()) walk(p); else if(/\.tsx?$/.test(p)) files.push(p); } })('src');

const unmapped = new Map();
let totalHits = 0, touched = 0;

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  let hits = 0;
  // Replace Tailwind arbitrary-value colors: prefix-[#hex] and prefix-[#hex]/opacity
  const out = src.replace(/([a-z-]+)-\[(#[0-9a-fA-F]{3,8})\]/g, (whole, prefix, hex) => {
    const tok = MAP[hex.toLowerCase()];
    if (!tok) { unmapped.set(hex.toLowerCase(), (unmapped.get(hex.toLowerCase())||0)+1); return whole; }
    hits++; return `${prefix}-[${tok}]`;
  });
  if (hits) { totalHits += hits; touched++; if (APPLY) writeFileSync(f, out); 
    console.log(`${String(hits).padStart(4)}  ${f}`); }
}
console.log(`\n${APPLY?'APPLIED':'DRY RUN'}: ${totalHits} replacements across ${touched} files`);
if (unmapped.size) { console.log('\nUNMAPPED (left alone):');
  for (const [h,n] of [...unmapped].sort((a,b)=>b[1]-a[1])) console.log(`  ${h} x${n}`); }
