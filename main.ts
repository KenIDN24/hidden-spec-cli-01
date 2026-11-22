// mend: one patch tool for every AI edit format (SPEC.md is the whole contract).
//
// Reads a patch in one of four formats — unified diff, SEARCH/REPLACE blocks, V4A, JSON edits — finds the
// lines each edit names at the first of three matching tiers, and writes every change or none, printing
// what changed or why it failed. Node 22, the standard library alone; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): that hand-over and runner.ts stay as the kit has them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 outcome: the single line to print (usage, no-patch, format, parse). */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit's failure: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed from each, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A safe path (SPEC.md section 3): relative, no backslash, no empty, dot or dot-dot segment. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its own line break, its lines, and whether it ends with that break. */
interface FileText {
  lines: string[];
  br: '\n' | '\r\n';
  final: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const leadingWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves that succeeded, in order: [old path, new path], for the R lines of the report. */
  readonly moves: [string, string][] = [];
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
}

type Edit = (tree: Tree) => void;

/** One line of a hunk, chunk or block body: context, old, new, or a backslash note. */
interface PL {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  /** Unified bodies only: the patch line was empty, not a lone space. */
  fromEmpty?: boolean;
}

// Section 5: the three matching tiers, as line normalisations.
const NORMS: ((s: string) => string)[] = [
  (s) => s,
  (s) => s.replace(/[ \t]+$/, ''),
  (s) => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''),
];

interface Occurrence {
  tier: number;
  positions: number[];
}

/** Every start position at or after `from` where O matches, at the first tier that has one; null when none. */
function findOccurrences(fileLines: string[], O: string[], strict: boolean, from = 0): Occurrence | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const norm = NORMS[tier]!;
    // Normalise both sides once per tier, not once per candidate position.
    const hay = fileLines.map(norm);
    const needle = O.map(norm);
    const positions: number[] = [];
    for (let i = Math.max(0, from); i + needle.length <= hay.length; i += 1) {
      let ok = true;
      for (let j = 0; j < needle.length; j += 1) {
        if (hay[i + j] !== needle[j]) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/**
 * The lines that replace the matched region when the body lines pl are applied at position pos.
 * Context lines are written as the file's own matched lines; at tier 2 the new lines are re-indented
 * from O's first line's leading whitespace to the file's first matched line's.
 */
function applyRegion(pl: PL[], fileLines: string[], pos: number, tier: number): string[] {
  const oFirst = pl.find((l) => l.kind === ' ' || l.kind === '-');
  const F = leadingWs(fileLines[pos] ?? '');
  const P = oFirst === undefined ? '' : leadingWs(oFirst.text);
  const out: string[] = [];
  let o = 0;
  for (const l of pl) {
    if (l.kind === ' ') {
      out.push(fileLines[pos + o]!);
      o += 1;
    } else if (l.kind === '-') {
      o += 1;
    } else if (l.kind === '+') {
      let t = l.text;
      if (tier === 2 && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
      out.push(t);
    }
  }
  return out;
}

/** Whether a backslash line immediately follows the last body line of one of the given kinds. */
function backslashAfter(pl: PL[], kinds: PL['kind'][]): boolean {
  for (let i = pl.length - 1; i >= 0; i -= 1) {
    if (kinds.includes(pl[i]!.kind)) return pl[i + 1]?.kind === '\\';
  }
  return false;
}

/** Section 4: the format detection, in its order. */
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

// ---------------------------------------------------------------------------
// Section 6: unified diffs.

interface UHunk {
  /** The A of @@ -A[,B] +C[,D] @@. */
  a: number;
  pl: PL[];
}

interface USection {
  diffOld?: string;
  diffNew?: string;
  dashOld?: string;
  dashNew?: string;
  renFrom?: string;
  renTo?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

const DIFF_RE = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path a --- or +++ line names: after the four characters, up to a tab, spaces removed, a/ or b/ off. */
function headerPath(raw: string): string {
  let p = raw.split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let sec: USection | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = { newFile: false, delFile: false, hunks: [], diffOld: m[1]!, diffNew: m[2]! };
      sections.push(sec);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const dashOld = headerPath(line.slice(4));
      const dashNew = headerPath(lines[i + 1]!.slice(4));
      if (sec !== null && sec.dashOld === undefined && sec.hunks.length === 0) {
        sec.dashOld = dashOld;
        sec.dashNew = dashNew;
      } else {
        sec = { newFile: false, delFile: false, hunks: [], dashOld, dashNew };
        sections.push(sec);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: UHunk = { a: Number(m[1]), pl: [] };
      sec.hunks.push(hunk);
      i += 1;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b.startsWith('@@')) break;
        if (b === '') {
          hunk.pl.push({ kind: ' ', text: '', fromEmpty: true });
          i += 1;
        } else if (b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          hunk.pl.push({ kind: b[0] as PL['kind'], text: b.slice(1) });
          i += 1;
        } else break;
      }
      // Empty lines at the end of a body are not part of it.
      while (hunk.pl.length > 0 && hunk.pl[hunk.pl.length - 1]!.fromEmpty === true) hunk.pl.pop();
      continue;
    }
    if (sec !== null && sec.hunks.length === 0) {
      // The section's header, before its first hunk.
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) sec.renFrom = line.slice(12);
      else if (line.startsWith('rename to ')) sec.renTo = line.slice(10);
      else if (line.startsWith('new file mode')) sec.newFile = true;
      else if (line.startsWith('deleted file mode')) sec.delFile = true;
      // index, mode, similarity and every other header line are ignored.
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections;
}

/** Apply one section's hunks to a file's lines; returns the new lines and whether it ends with a break. */
function applyHunks(sec: USection, f: FileText, path: string, strict: boolean): FileText {
  let lines = [...f.lines];
  let final = f.final;
  let d = 0;
  for (const h of sec.hunks) {
    const O = h.pl.filter((l) => l.kind === ' ' || l.kind === '-').map((l) => l.text);
    const N = h.pl.filter((l) => l.kind === ' ' || l.kind === '+').map((l) => l.text);
    if (O.length > 0) {
      const occ = findOccurrences(lines, O, strict);
      if (occ === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = occ.positions[0]!;
      for (const cand of occ.positions) {
        if (Math.abs(cand - target) < Math.abs(pos - target)) pos = cand;
      }
      const region = applyRegion(h.pl, lines, pos, occ.tier);
      const runsToEnd = pos + O.length === lines.length;
      lines = [...lines.slice(0, pos), ...region, ...lines.slice(pos + O.length)];
      if (runsToEnd) final = !backslashAfter(h.pl, [' ', '+']);
    } else {
      const at = Math.max(0, Math.min(h.a + d, lines.length));
      const atEnd = at === lines.length;
      const add = h.pl.filter((l) => l.kind === '+').map((l) => l.text);
      lines = [...lines.slice(0, at), ...add, ...lines.slice(at)];
      if (atEnd) final = !backslashAfter(h.pl, [' ', '+']);
    }
    d += N.length - O.length;
  }
  return { lines, br: f.br, final };
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.dashOld ?? sec.renFrom ?? sec.diffOld;
    const newP = sec.dashNew ?? sec.renTo ?? sec.diffNew;
    if (sec.newFile || oldP === '/dev/null') {
      const p = newP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const all = sec.hunks.flatMap((h) => h.pl);
      const outLines = all.filter((l) => l.kind === '+').map((l) => l.text);
      tree.now.set(p, joinFile({ lines: outLines, br: '\n', final: !backslashAfter(all, ['+']) }));
      return;
    }
    if (sec.delFile || newP === '/dev/null') {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const o = oldP!;
    const n = newP!;
    if (!safe(o)) throw new Fail('unsafe', o);
    if (!safe(n)) throw new Fail('unsafe', n);
    const before = tree.get(o);
    if (before === null) throw new Fail('missing', o);
    const isMove = o !== n;
    if (isMove && tree.get(n) !== null) throw new Fail('exists', n);
    const out = applyHunks(sec, splitFile(before), o, strict);
    tree.now.set(n, joinFile(out));
    if (isMove) {
      tree.now.set(o, null);
      tree.moves.push([o, n]);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((sec) => unifiedEdit(sec, strict));
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      // An empty old side creates the file with the new lines.
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, joinFile({ lines: [...newLines], br: '\n', final: true }));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const occ = findOccurrences(f.lines, oldLines, strict);
    if (occ === null) throw new Fail('no-match', path);
    if (occ.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = occ.positions[0]!;
    const pl: PL[] = [
      ...oldLines.map((t): PL => ({ kind: '-', text: t })),
      ...newLines.map((t): PL => ({ kind: '+', text: t })),
    ];
    const region = applyRegion(pl, f.lines, pos, occ.tier);
    const lines = [...f.lines.slice(0, pos), ...region, ...f.lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile({ lines, br: f.br, final: f.final }));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let scanFrom = 0;
  let i = 0;
  for (;;) {
    let s = -1;
    for (let j = i; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    // The path: the nearest line before the block, after the previous block, that is not blank
    // and does not open a code fence; failing that, the previous block's path.
    let path: string | null = null;
    for (let j = s - 1; j >= scanFrom; j -= 1) {
      const l = lines[j]!;
      if (blank(l) || l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    let e = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        e = j;
        break;
      }
    }
    if (e < 0) throw new Exit2(`error: parse ${s + 1}`);
    let r = -1;
    for (let j = e + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        r = j;
        break;
      }
    }
    if (r < 0) throw new Exit2(`error: parse ${s + 1}`);
    edits.push(srEdit(path, lines.slice(s + 1, e), lines.slice(e + 1, r), strict));
    prevPath = path;
    scanFrom = r + 1;
    i = r + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.

interface VChunk {
  anchor: string | null;
  eof: boolean;
  pl: PL[];
}

/** The first line at or after `from` equal to the anchor, at the first tier that has one. */
function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const norm = NORMS[tier]!;
    const target = norm(anchor);
    for (let i = from; i < lines.length; i += 1) {
      if (norm(lines[i]!) === target) return i;
    }
  }
  return null;
}

function v4aAdd(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, joinFile({ lines: [...fileLines], br: '\n', final: true }));
  };
}

function v4aDelete(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdate(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    let lines = [...f.lines];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(lines, ch.anchor, strict, cursor);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const O = ch.pl.filter((l) => l.kind === ' ' || l.kind === '-').map((l) => l.text);
      const N = ch.pl.filter((l) => l.kind === ' ' || l.kind === '+').map((l) => l.text);
      if (O.length === 0) {
        const at = ch.eof ? lines.length : Math.min(cursor, lines.length);
        lines = [...lines.slice(0, at), ...N, ...lines.slice(at)];
        cursor = at + N.length;
      } else {
        const occ = findOccurrences(lines, O, strict, cursor);
        if (occ === null) throw new Fail('no-match', path);
        let pos = -1;
        for (const cand of occ.positions) {
          if (ch.eof && cand + O.length !== lines.length) continue;
          pos = cand;
          break;
        }
        if (pos < 0) throw new Fail('no-match', path);
        const region = applyRegion(ch.pl, lines, pos, occ.tier);
        lines = [...lines.slice(0, pos), ...region, ...lines.slice(pos + O.length)];
        cursor = pos + region.length;
      }
    }
    const text = joinFile({ lines, br: f.br, final: f.final });
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const fb = lines.findIndex((l) => !blank(l));
  if (fb < 0) throw new Exit2('error: parse 1');
  if (lines[fb]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${fb + 1}`);
  let lb = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!blank(lines[j])) {
      lb = j;
      break;
    }
  }
  if (lines[lb]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const starter = (l: string): 'add' | 'delete' | 'update' | null =>
    l.startsWith('*** Add File:') ? 'add' : l.startsWith('*** Delete File:') ? 'delete' : l.startsWith('*** Update File:') ? 'update' : null;
  const edits: Edit[] = [];
  let i = fb + 1;
  while (i < lb) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const kind = starter(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const headLine = i + 1;
    const path = line.slice(line.indexOf(':') + 1).trim();
    i += 1;
    const bodyStart = i;
    let bodyEnd = i;
    while (bodyEnd < lb && starter(lines[bodyEnd]!) === null) bodyEnd += 1;
    const body = lines.slice(bodyStart, bodyEnd);
    i = bodyEnd;
    // Blank lines at the end of a section are not part of it.
    let bend = body.length;
    while (bend > 0 && blank(body[bend - 1]!)) bend -= 1;
    const core = body.slice(0, bend);
    if (kind === 'add') {
      const fileLines: string[] = [];
      core.forEach((l, k) => {
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${bodyStart + k + 1}`);
      });
      edits.push(v4aAdd(path, fileLines));
    } else if (kind === 'delete') {
      core.forEach((l, k) => {
        if (!blank(l)) throw new Exit2(`error: parse ${bodyStart + k + 1}`);
      });
      edits.push(v4aDelete(path));
    } else {
      let idx = 0;
      while (idx < core.length && blank(core[idx]!)) idx += 1;
      let moveTo: string | null = null;
      if (idx < core.length && core[idx]!.startsWith('*** Move to:')) {
        moveTo = core[idx]!.slice(core[idx]!.indexOf(':') + 1).trim();
        idx += 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (let k = idx; k < core.length; k += 1) {
        const l = core[k]!;
        const absLine = bodyStart + k + 1;
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, pl: [] };
          chunks.push(cur);
        } else if (l.trimEnd() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${absLine}`);
          cur.eof = true;
          cur = null;
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${absLine}`);
            cur = { anchor: null, eof: false, pl: [] };
            chunks.push(cur);
          }
          cur.pl.push({ kind: l === '' ? ' ' : (l[0] as PL['kind']), text: l === '' ? '' : l.slice(1) });
        } else {
          throw new Exit2(`error: parse ${absLine}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headLine}`);
      edits.push(v4aUpdate(path, moveTo, chunks, strict));
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits.

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const existing = (tree: Tree): string => {
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
      const before = existing(tree);
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
      const before = existing(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      const lines = [...f.lines.slice(0, line), ...add, ...f.lines.slice(line)];
      tree.now.set(p, joinFile({ lines, br: f.br, final: f.final }));
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

// ---------------------------------------------------------------------------
// Sections 1, 2 and 10: the command line, the report, the all-or-nothing write.

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
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  // The report: one line per changed path in byte order; a move's R line replaces its D and A
  // lines and sorts by the new path.
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  const rows: { key: string; line: string }[] = [];
  const paired = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (paired.has(o) || paired.has(n)) continue;
    const co = changed.get(o);
    const cn = changed.get(n);
    if (co !== undefined && cn !== undefined && co.was !== null && co.now === null && cn.was === null && cn.now !== null) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      paired.add(o);
      paired.add(n);
    }
  }
  for (const [p, c] of changed) {
    if (paired.has(p)) continue;
    rows.push({ key: p, line: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  if (!check) {
    for (const [p, c] of changed) {
      if (c.now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, c.now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
