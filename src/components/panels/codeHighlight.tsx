import { useMemo } from 'react';
import type { ReactNode } from 'react';

/**
 * Dependency-free code coloring for the file viewer.
 *
 * A highlighting library would be the obvious choice, but every one worth
 * using arrives as a runtime dependency with its own theme model — dead
 * weight for an offline app that only needs VS Code-like hues for the dozen
 * file kinds the tree actually shows. This is a small ordered tokenizer:
 * comments, strings, numbers, decorators, keywords, then `name(` calls.
 * Anything it does not recognize stays plain text, so an unknown language
 * degrades to the old monochrome view instead of wrong colors.
 */

type Lang = 'py' | 'js' | 'c' | 'sh' | 'sql' | 'css' | 'html' | 'plain';

function langForFile(fileName: string): Lang {
  const ext = /\.([A-Za-z0-9]+)$/.exec(fileName)?.[1]?.toLowerCase() ?? '';
  if (ext === 'py' || ext === 'pyw' || ext === 'pyi') return 'py';
  if (['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'json', 'jsonc'].includes(ext))
    return 'js';
  if (['rs', 'c', 'h', 'hpp', 'hxx', 'cpp', 'cc', 'cxx', 'cs', 'java', 'kt', 'go', 'swift', 'dart', 'scala'].includes(ext))
    return 'c';
  if (['sh', 'bash', 'zsh', 'ps1', 'psm1', 'toml', 'yaml', 'yml'].includes(ext)) return 'sh';
  if (ext === 'sql') return 'sql';
  if (['css', 'scss', 'less'].includes(ext)) return 'css';
  if (['html', 'htm', 'xml', 'xhtml', 'svg', 'vue', 'svelte'].includes(ext)) return 'html';
  // Logs, prose and anything unrecognized stay plain — the reference shows
  // `.log` files uncolored too.
  return 'plain';
}

const PY_KEYWORDS = new Set(
  'False None True and as assert async await break case class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield'.split(' '),
);
const JS_KEYWORDS = new Set(
  'break case catch class const continue debugger default delete do else export extends false finally for function if import in instanceof let new null return super switch this throw true try typeof var void while with yield enum implements interface package private protected public static async await of from as get set'.split(' '),
);
const C_KEYWORDS = new Set(
  'break case catch class const continue default delete do else enum export extends extern false finally for fn if impl import in let match mod mut namespace new null nullptr private protected public return self sizeof static struct super switch this throw true try typedef typename union unsigned use virtual void while crate ref move where async await template package func var go defer interface map chan select string bool int long short char float double auto register signed sizeof volatile'.split(' '),
);
const SH_KEYWORDS = new Set(
  'if then else elif fi for while in do done case esac function return exit export local readonly declare select until try catch finally throw param begin process end switch default break continue'.split(' '),
);
const SQL_KEYWORDS = new Set(
  'select from where join left right inner outer full on group order having limit offset insert into values update set delete create table index view drop alter add column primary key foreign references unique not null default and or as distinct count sum avg min max union all case when then else end like in is between exists'.split(' '),
);

interface Rules {
  line: string[];
  block: boolean;
  htmlCom: boolean;
  triple: boolean;
  tpl: boolean;
  kw: Set<string>;
  dec: boolean;
}

const RULES: Record<Exclude<Lang, 'plain'>, Rules> = {
  py: { line: ['#'], block: false, htmlCom: false, triple: true, tpl: false, kw: PY_KEYWORDS, dec: true },
  js: { line: ['//'], block: true, htmlCom: false, triple: false, tpl: true, kw: JS_KEYWORDS, dec: true },
  c: { line: ['//'], block: true, htmlCom: false, triple: false, tpl: false, kw: C_KEYWORDS, dec: false },
  sh: { line: ['#'], block: false, htmlCom: false, triple: false, tpl: false, kw: SH_KEYWORDS, dec: false },
  sql: { line: ['--'], block: true, htmlCom: false, triple: false, tpl: false, kw: SQL_KEYWORDS, dec: false },
  css: { line: [], block: true, htmlCom: false, triple: false, tpl: false, kw: new Set(), dec: false },
  html: { line: [], block: false, htmlCom: true, triple: false, tpl: false, kw: new Set(), dec: false },
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function buildRe(r: Rules): RegExp {
  const alts: string[] = [];
  if (r.block) alts.push('/\\*[\\s\\S]*?\\*/');
  if (r.htmlCom) alts.push('<!--[\\s\\S]*?-->');
  if (r.triple) alts.push("'''(?:\\\\.|[\\s\\S])*?'''", '"""(?:\\\\.|[\\s\\S])*?"""');
  alts.push("'(?:\\\\.|[^'\\\\\\n])*'", '"(?:\\\\.|[^"\\\\\\n])*"');
  if (r.tpl) alts.push('`(?:\\\\.|[^`\\\\])*`');
  if (r.line.length > 0) alts.push(`(?:${r.line.map(esc).join('|')})[^\\n]*`);
  alts.push('\\b\\d[\\d_]*(?:\\.\\d+)?\\b');
  if (r.dec) alts.push('@[A-Za-z_]\\w*');
  alts.push('[A-Za-z_]\\w*');
  return new RegExp(alts.join('|'), 'g');
}

type TokClass = 'code-tok-com' | 'code-tok-str' | 'code-tok-num' | 'code-tok-kw' | 'code-tok-fn';

function classify(tok: string, r: Rules, after: string): TokClass | null {
  const first = tok[0];
  if (first === '"' || first === "'" || first === '`') return 'code-tok-str';
  // No other alternative starts with these opens — they are comments.
  if (first === '/' || first === '#' || first === '<' || first === '-') return 'code-tok-com';
  if (first === '@') return 'code-tok-fn';
  if (first >= '0' && first <= '9') return 'code-tok-num';
  if (r.kw.has(tok)) return 'code-tok-kw';
  // A bare word directly opening a paren is a call, like the reference.
  if (/^\s*\(/.test(after)) return 'code-tok-fn';
  return null;
}

interface Seg {
  t: string;
  c: TokClass | null;
}

function tokenize(text: string, r: Rules): Seg[] {
  const re = buildRe(r);
  const out: Seg[] = [];
  let pos = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > pos) out.push({ t: text.slice(pos, m.index), c: null });
    const tok = m[0];
    out.push({ t: tok, c: classify(tok, r, text.slice(re.lastIndex, re.lastIndex + 8)) });
    pos = re.lastIndex;
  }
  if (pos < text.length) out.push({ t: text.slice(pos), c: null });
  return out;
}

/** Keep the tokenizer off huge files — past this it would only jank. */
const HIGHLIGHT_MAX_CHARS = 300_000;
const HIGHLIGHT_MAX_LINES = 10_000;

/**
 * Code with a line-number gutter, like the reference editor. Plain text
 * (logs, prose, oversized files) renders the same gutter-free block as
 * before — only colored languages get numbers.
 */
export const CodeView: React.FC<{ text: string; fileName: string }> = ({ text, fileName }) => {
  const lang = langForFile(fileName);
  const lineCount = useMemo(() => {
    if (lang === 'plain' || text.length > HIGHLIGHT_MAX_CHARS) return 0;
    const n = text.split('\n').length;
    return n <= HIGHLIGHT_MAX_LINES ? n : 0;
  }, [text, lang]);

  const body = useMemo<ReactNode[]>(() => {
    if (lineCount === 0) return [text];
    const segs = tokenize(text, RULES[lang as Exclude<Lang, 'plain'>]);
    return segs.map((seg, i) =>
      seg.c ? (
        <span key={i} className={seg.c}>
          {seg.t}
        </span>
      ) : (
        seg.t
      ),
    );
  }, [text, lang, lineCount]);

  // Gutter rows share the code's exact type metrics so numbers never drift.
  const gutterType = 'pr-3 pl-4 py-4 text-right tabular-nums text-[11.5px] leading-relaxed';

  return (
    <div className="flex-1 overflow-auto min-h-0">
      <div className="flex items-stretch min-w-max min-h-full">
        {lineCount > 0 && (
          <div
            aria-hidden="true"
            className={`sticky left-0 select-none text-[var(--muted-foreground)] opacity-70 ${gutterType}`}
          >
            {Array.from({ length: lineCount }, (_, i) => (
              <div key={i + 1}>{i + 1}</div>
            ))}
          </div>
        )}
        <pre
          className={`m-0 min-w-0 flex-1 text-[11.5px] leading-relaxed text-[var(--foreground)] whitespace-pre tab-size-2 select-text ${
            lineCount > 0 ? 'py-4 pr-4' : 'p-4 min-w-full w-max'
          }`}
        >
          {body}
        </pre>
      </div>
    </div>
  );
};
