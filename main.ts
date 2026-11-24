// mend: one patch tool for every AI edit format. SPEC.md is the contract:
// it reads a patch in one of four formats (unified diff, SEARCH/REPLACE
// blocks, V4A, JSON edits), finds the lines each edit names at the first of
// three matching tiers, and writes every change or none. Node 22, the
// standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and then this file hands over to runner.ts (the last lines below): keep
// that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its line break, and whether it ends with one. */
interface FileDoc {
  lines: string[];
  br: '\n' | '\r\n';
  final: boolean;
}

function parseFile(text: string): FileDoc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function renderFile(d: FileDoc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /** The file's lines as the edits leave them, or null when it does not exist. */
  doc(p: string): FileDoc | null {
    const t = this.get(p);
    return t === null ? null : parseFile(t);
  }
  setDoc(p: string, d: FileDoc): void {
    this.now.set(p, renderFile(d));
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// --- Section 5: matching lines at three tiers. ----------------------------
// Tier 0: every line equal. Tier 1: equal once trailing spaces and tabs are
// removed from both. Tier 2: equal once leading and trailing spaces and tabs
// are removed from both. A line of N is a context line when it is also a
// line of O (oIndex is its index in O); context lines are written as the
// file's own matched line, never the patch's.

interface NewLine {
  text: string;
  oIndex: number | null;
}

function norm(line: string, tier: number): string {
  if (tier === 0) return line;
  const t = line.replace(/[ \t]+$/, '');
  return tier === 1 ? t : t.replace(/^[ \t]+/, '');
}

/** Positions where O occurs in F at one tier; occurrences may overlap. */
function occurrences(F: string[], O: string[], tier: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  const nO = O.map((l) => norm(l, tier));
  for (let i = 0; i + O.length <= F.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (norm(F[i + j]!, tier) !== nO[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs. */
function findTier(F: string[], O: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(F, O, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** Replace the k matched lines at `at` with N. At tier 2 every other line of
 * N is re-indented: F is the leading spaces and tabs of the file's first
 * matched line and P those of O's first line; a line of N that is not empty
 * and not only whitespace, and starts with P, has that P replaced by F. */
function applyReplace(F: string[], at: number, O: string[], N: NewLine[], tier: number): string[] {
  const out = F.slice(0, at);
  let F0 = '';
  let P0 = '';
  if (tier === 2 && O.length > 0) {
    F0 = /^[ \t]*/.exec(F[at]!)![0];
    P0 = /^[ \t]*/.exec(O[0]!)![0];
  }
  for (const n of N) {
    if (n.oIndex !== null) {
      out.push(F[at + n.oIndex]!);
    } else if (tier === 2 && n.text !== '' && n.text.trim() !== '' && n.text.startsWith(P0)) {
      out.push(F0 + n.text.slice(P0.length));
    } else {
      out.push(n.text);
    }
  }
  out.push(...F.slice(at + O.length));
  return out;
}

/** Find the single line `anchor` at or after `from`, at the first tier with
 * one (section 5, both sides a single line). Returns its index, or -1. */
function findAnchor(F: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const a = norm(anchor, t);
    for (let i = from; i < F.length; i++) {
      if (norm(F[i]!, t) === a) return i;
    }
  }
  return -1;
}

// --- Section 9: JSON edits. ------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// --- Section 6: unified diffs. ---------------------------------------------

interface Hunk {
  a: number; // old start line (1-based) from `@@ -A[,B] +C[,D] @@`
  body: string[]; // body lines: ' ', '-', '+', '\' or empty (empty = context '')
  noNl: boolean; // a '\' line follows the hunk's last context or '+' line
}

interface Section {
  hasPair: boolean;
  pairOld: string | null; // null: /dev/null
  pairNew: string | null;
  renOld: string | null;
  renNew: string | null;
  diffOld: string | null;
  diffNew: string | null;
  create: boolean; // `new file mode`
  remove: boolean; // `deleted file mode`
  hunks: Hunk[];
}

function parseDiffGit(line: string): [string, string] | null {
  if (!line.startsWith('diff --git a/')) return null;
  const rest = line.slice('diff --git a/'.length);
  const sep = rest.indexOf(' b/');
  if (sep < 0) return null;
  const x = rest.slice(0, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '' || /\s/.test(y)) return null;
  return [x, y];
}

/** The path after `--- ` / `+++ `: up to the first tab, spaces removed. */
function headerPath(line: string): string | null {
  const t = line.slice(4).split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

function parseHunkHeader(line: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (m === null) return null;
  return parseInt(m[1]!, 10);
}

/** Apply a section's hunks in order, each to the result of the ones before. */
function applyHunks(doc: FileDoc, hunks: Hunk[], strict: boolean, path: string): FileDoc {
  let lines = doc.lines.slice();
  let final = doc.final;
  const br = doc.br;
  let d = 0;
  for (const h of hunks) {
    const O: string[] = [];
    const N: NewLine[] = [];
    for (const bl of h.body) {
      if (bl.startsWith(' ')) {
        O.push(bl.slice(1));
        N.push({ text: bl.slice(1), oIndex: O.length - 1 });
      } else if (bl.startsWith('-')) {
        O.push(bl.slice(1));
      } else if (bl.startsWith('+')) {
        N.push({ text: bl.slice(1), oIndex: null });
      } else if (bl === '') {
        O.push('');
        N.push({ text: '', oIndex: O.length - 1 });
      }
      // '\' lines only affect the final break, through h.noNl.
    }
    if (O.length === 0) {
      const oldLen = lines.length;
      const pos = Math.max(0, Math.min(h.a + d, oldLen));
      const ins = N.map((x) => x.text);
      lines = [...lines.slice(0, pos), ...ins, ...lines.slice(pos)];
      if (pos === oldLen) final = !h.noNl;
      d += N.length;
    } else {
      const found = findTier(lines, O, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      for (const p of found.occ) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const runsToEnd = best + O.length === lines.length;
      lines = applyReplace(lines, best, O, N, found.tier);
      if (runsToEnd) final = !h.noNl;
      d += N.length - O.length;
    }
  }
  return { lines, br, final };
}

function sectionEdit(s: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = s.hasPair ? s.pairOld : (s.renOld ?? s.diffOld);
    const newP = s.hasPair ? s.pairNew : (s.renNew ?? s.diffNew);
    const isCreate = oldP === null || s.create;
    const isDelete = newP === null || s.remove;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (isCreate) {
      if (newP === null) throw new Fail('unsafe', '');
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of s.hunks) for (const b of h.body) if (b.startsWith('+')) plus.push(b.slice(1));
      let noNl = false;
      outer: for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
        const body = s.hunks[hi]!.body;
        for (let k = body.length - 1; k >= 0; k--) {
          if (body[k]!.startsWith('+')) {
            noNl = k + 1 < body.length && body[k + 1]!.startsWith('\\');
            break outer;
          }
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noNl ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (oldP === null) throw new Fail('unsafe', '');
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const oldPath = oldP!;
    const newPath = newP!;
    const doc = tree.doc(oldPath);
    if (doc === null) throw new Fail('missing', oldPath);
    if (oldPath !== newPath && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    const out = applyHunks(doc, s.hunks, strict, oldPath);
    if (oldPath !== newPath) {
      tree.now.set(oldPath, null);
      tree.now.set(newPath, renderFile(out));
      tree.moves.push([oldPath, newPath]);
    } else {
      tree.setDoc(oldPath, out);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  const n = lines.length;
  const startSection = (): Section => {
    const s: Section = { hasPair: false, pairOld: null, pairNew: null, renOld: null, renNew: null, diffOld: null, diffNew: null, create: false, remove: false, hunks: [] };
    sections.push(s);
    return s;
  };
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const p = parseDiffGit(line.trimEnd());
      if (p === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = startSection();
      cur.diffOld = p[0];
      cur.diffNew = p[1];
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hunks.length > 0 || cur.hasPair) cur = startSection();
      cur!.hasPair = true;
      cur!.pairOld = headerPath(line);
      cur!.pairNew = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && cur.hunks.length === 0) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseHunkHeader(line);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      let j = i + 1;
      const body: string[] = [];
      while (j < n) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\') || l === '') {
          body.push(l);
          j++;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      let noNl = false;
      for (let k = body.length - 1; k >= 0; k--) {
        const b = body[k]!;
        if (b.startsWith(' ') || b === '' || b.startsWith('+')) {
          noNl = k + 1 < body.length && body[k + 1]!.startsWith('\\');
          break;
        }
      }
      cur.hunks.push({ a, body, noNl });
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.create = true;
      else if (line.startsWith('deleted file mode')) cur.remove = true;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => sectionEdit(s, strict));
}

// --- Section 7: SEARCH/REPLACE blocks. -------------------------------------

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0; // index just after the previous block's REPLACE line
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    // The path: the nearest line before the SEARCH line, after the previous
    // block's REPLACE line, that is not blank and does not start with ```.
    let path: string | null = null;
    for (let k = searchLine - 1; k >= prevEnd; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    let sep = -1;
    let rep = -1;
    for (let k = searchLine + 1; k < n; k++) {
      const t = lines[k]!.trimEnd();
      if (sep < 0 && t === '=======') sep = k;
      else if (sep >= 0 && t === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (sep < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, sep);
    const newLines = lines.slice(sep + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const doc = tree.doc(p);
      if (doc === null) throw new Fail('missing', p);
      const found = findTier(doc.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const at = found.occ[0]!;
      const N: NewLine[] = newLines.map((t) => ({ text: t, oIndex: null }));
      tree.setDoc(p, { lines: applyReplace(doc.lines, at, oldLines, N, found.tier), br: doc.br, final: doc.final });
    });
    prevPath = p;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// --- Section 8: V4A patches. ------------------------------------------------

interface V4aChunk {
  anchor: string | null; // null: no anchor
  eof: boolean; // `*** End of File`: the chunk ends at the file's last line
  body: string[]; // ' ', '-', '+' or empty (empty = context '')
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[]; // Add File: the file's lines
  chunks: V4aChunk[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  const last = (() => {
    for (let k = lines.length - 1; k >= 0; k--) if (!blank(lines[k]!)) return k;
    return -1;
  })();
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const end = last; // index of `*** End Patch`
  while (i < end) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const head = lines[i]!;
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (head.startsWith('*** Add File: ')) {
      kind = 'add';
      path = head.slice('*** Add File: '.length).trim();
    } else if (head.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = head.slice('*** Delete File: '.length).trim();
    } else if (head.startsWith('*** Update File: ')) {
      kind = 'update';
      path = head.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    // The section's lines run to the next section start or `*** End Patch`;
    // blank lines at the end of a section are not part of it.
    let j = i + 1;
    while (j < end) {
      const l = lines[j]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      j++;
    }
    let raw = lines.slice(i + 1, j);
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k]!;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      const p = path;
      const fl = fileLines;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fl.length === 0 ? '' : fl.join('\n') + '\n');
      });
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${i + 2}`);
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      let moveTo: string | null = null;
      let k = 0;
      if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.slice('*** Move to: '.length).trim();
        k = 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let firstChunk = true;
      while (k < raw.length) {
        const l = raw[k]!;
        if (l.startsWith('@@')) {
          cur = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), eof: false, body: [] };
          chunks.push(cur);
          firstChunk = false;
          k++;
          continue;
        }
        if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 2 + k}`);
          cur.eof = true;
          cur = null;
          k++;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (cur === null) {
            if (!firstChunk) throw new Exit2(`error: parse ${i + 2 + k}`);
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
            firstChunk = false;
          }
          cur.body.push(l);
          k++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      const p = path;
      const mt = moveTo;
      const chs = chunks;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
        const doc = tree.doc(p);
        if (doc === null) throw new Fail('missing', p);
        if (mt !== null && tree.get(mt) !== null) throw new Fail('exists', mt);
        let lines = doc.lines.slice();
        const br = doc.br;
        const final = doc.final;
        let cursor = 0;
        for (const ch of chs) {
          if (ch.anchor !== null) {
            const at = findAnchor(lines, ch.anchor, cursor, strict);
            if (at < 0) throw new Fail('no-match', p);
            cursor = at + 1;
          }
          const O: string[] = [];
          const N: NewLine[] = [];
          for (const bl of ch.body) {
            if (bl.startsWith(' ')) {
              O.push(bl.slice(1));
              N.push({ text: bl.slice(1), oIndex: O.length - 1 });
            } else if (bl.startsWith('-')) {
              O.push(bl.slice(1));
            } else if (bl.startsWith('+')) {
              N.push({ text: bl.slice(1), oIndex: null });
            } else if (bl === '') {
              O.push('');
              N.push({ text: '', oIndex: O.length - 1 });
            }
          }
          if (O.length === 0) {
            const pos = ch.eof ? lines.length : cursor;
            const ins = N.map((x) => x.text);
            lines = [...lines.slice(0, pos), ...ins, ...lines.slice(pos)];
            cursor = pos + ins.length;
          } else {
            const found = findTierFrom(lines, O, cursor, strict);
            if (found === null) throw new Fail('no-match', p);
            if (ch.eof && found.at + O.length !== lines.length) throw new Fail('no-match', p);
            lines = applyReplace(lines, found.at, O, N, found.tier);
            cursor = found.at + N.length;
          }
        }
        const out: FileDoc = { lines, br, final };
        if (mt !== null) {
          tree.now.set(p, null);
          tree.now.set(mt, renderFile(out));
          tree.moves.push([p, mt]);
        } else {
          tree.setDoc(p, out);
        }
      });
    }
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** The first occurrence of O at or after `from`, at the first tier with one. */
function findTierFrom(F: string[], O: string[], from: number, strict: boolean): { tier: number; at: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(F, O, t).filter((x) => x >= from);
    if (occ.length > 0) return { tier: t, at: occ[0]! };
  }
  return null;
}

// --- The run: command line, dispatch, output and exit codes. --------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      for (const m of beforeMoves) tree.moves.push(m);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; line: string }> = [];
  const done = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      done.add(oldP);
      done.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (done.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  if (!check) {
    for (const [p, now] of tree.now) {
      const was = tree.original(p);
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
