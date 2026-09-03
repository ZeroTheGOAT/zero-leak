// Audit: for every arbitrary-value utility Tailwind emitted from a var() or
// color-mix() class, report which CSS property it actually produced. Tailwind
// has to guess the data type for `bg-[...]`, `shadow-[...]` etc., and a wrong
// guess silently emits the wrong property (that is what killed the popover
// shadows), so this makes the guesses visible.
import { readFileSync, readdirSync } from 'node:fs';

const dir = 'dist/assets';
const file = readdirSync(dir).filter((f) => /^index-.*\.css$/.test(f)).pop();
const css = readFileSync(`${dir}/${file}`, 'utf8');
console.log(`auditing ${dir}/${file}\n`);

// Class names carry escaped variants (hover\:, focus-visible\:, dark\:), so the
// prefix pattern has to allow them before the utility name.
const re = /\.((?:[a-zA-Z-]+\\:)*)([a-zA-Z-]+)\\\[(?:color-mix|var)[^{}]*\{([^}]*)\}/g;
const seen = new Map();
for (const m of css.matchAll(re)) {
  const prefix = `${m[1].replace(/\\/g, '')}${m[2]}`;
  // First declaration in the rule names the property Tailwind chose.
  const prop = m[3].split(':')[0];
  const key = `${prefix}\t${prop}`;
  seen.set(key, (seen.get(key) ?? 0) + 1);
}

// What each utility prefix is supposed to set.
const EXPECT = {
  bg: 'background-color', text: 'color', border: 'border-color',
  fill: 'fill', stroke: 'stroke', ring: '--tw-ring-color',
  divide: 'border-color', outline: 'outline-color', shadow: '--tw-shadow',
  from: '--tw-gradient-from', to: '--tw-gradient-to', via: '--tw-gradient-stops',
  placeholder: 'color', decoration: 'text-decoration-color', caret: 'caret-color',
  accent: 'accent-color',
};

let bad = 0;
for (const [key, n] of [...seen].sort()) {
  const [prefix, prop] = key.split('\t');
  const want = EXPECT[prefix.replace(/^.*:/, '')];
  const ok = !want || prop === want || prop.startsWith('--tw-');
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : '  !! '}${prefix.padEnd(14)} -> ${prop.padEnd(24)} x${n}${ok ? '' : `   expected ${want}`}`);
}
console.log(`\n${seen.size} distinct prefix/property pairing(s), ${bad} suspicious`);
