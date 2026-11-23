// main.ts is mend, the CLI SPEC.md specifies, built on the kit's starter for it (MIT). It does all of SPEC.md: the
// command line, the output and exit codes, safe paths, format detection, JSON edits and the all-or-nothing write
// (sections 1 to 4, 9 and 10, from the starter), and unified diffs (section 6), SEARCH/REPLACE blocks (section 7)
// and V4A patches (section 8), all matching lines at three tiers (section 5). Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

/** Shared state for one run: the strict flag, and the move edits that succeeded (for section 2's R lines). */
interface Ctx {
  strict: boolean;
  moves: { from: string; to: string }[];
}

/** A file's text as its lines, its own line break and whether it ends with one (section 3). */
function splitFile(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

/** Lines back to text: a file of no lines is written empty (section 3). */
function serialize(lines: string[], br: string, final: boolean): string {
  return lines.length === 0 ? '' : lines.join(br) + (final ? br : '');
}

function leadingWs(s: string): string {
  return /^[ \t]*/.exec(s)![0];
}

/** A line as a tier reads it (section 5). */
function tierOf(line: string, tier: number): string {
  if (tier === 0) return line;
  const t = line.replace(/[ \t]+$/, '');
  return tier === 1 ? t : t.replace(/^[ \t]+/, '');
}

function tierList(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** Every position at which O occurs in lines at the tier; occurrences may overlap (section 5). */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const res: number[] = [];
  if (o.length === 0 || o.length > lines.length) return res;
  const want = o.map((l) => tierOf(l, tier));
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (tierOf(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

/** The first tier at which O occurs at least once, and its positions there (section 5). */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; positions: number[] } | null {
  for (const t of tierList(strict)) {
    const ps = occurrences(lines, o, t);
    if (ps.length > 0) return { tier: t, positions: ps };
  }
  return null;
}

/** A tier-2 line of N re-indented (section 5): F replaces P at its start, when it starts with P. */
function reindent(line: string, f: string, p: string): string {
  if (line === '' || line.trim() === '') return line;
  return line.startsWith(p) ? f + line.slice(p.length) : line;
}

/** One body line of a hunk or a chunk: kind is ' ' (context), '-' (old), '+' (new) or '\\' (the no-newline marker). */
interface BodyLine {
  kind: string;
  text: string;
}

/**
 * The lines a hunk or chunk writes over the file's lines matched at pos: a context line is written as the file's
 * own matched line, and at tier 2 the new lines are re-indented (section 5).
 */
function buildSegment(fileLines: string[], pos: number, entries: BodyLine[], tier: number): string[] {
  const out: string[] = [];
  const firstO = entries.find((e) => e.kind !== '+');
  const f = leadingWs(fileLines[pos] ?? '');
  const p = firstO === undefined ? '' : leadingWs(firstO.text);
  let oi = 0;
  for (const e of entries) {
    if (e.kind === ' ') {
      out.push(fileLines[pos + oi]!);
      oi += 1;
    } else if (e.kind === '-') {
      oi += 1;
    } else if (e.kind === '+') {
      out.push(tier === 2 ? reindent(e.text, f, p) : e.text);
    }
  }
  return out;
}

/** Whether a `\` line follows the entries' last context or new line (section 6's final-break rule). */
function slashAfterLast(entries: BodyLine[]): boolean {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const k = entries[i]!.kind;
    if (k === ' ' || k === '+') return entries[i + 1]?.kind === '\\';
  }
  return false;
}

interface UHunk {
  a: number;
  entries: (BodyLine & { raw: string })[];
}

interface USection {
  diffOld: string | null;
  diffNew: string | null;
  headOld: string | null | undefined;
  headNew: string | null | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hasPair: boolean;
  hunks: UHunk[];
}

/** The path a `--- `/`+++ ` line names: the text after the four characters, to the first tab, spaces removed (section 6). */
function headerPath(l: string): string | null {
  let t = l.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.replace(/^ +/, '').replace(/ +$/, '');
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

/** Unified diffs (section 6): sections and their hunks, read before any file is looked at. */
function unifiedEdits(lines: string[], ctx: Ctx): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  const diffRe = /^diff --git a\/(.+?) b\/(.+)$/;
  const hunkRe = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  const fresh = (): USection => ({
    diffOld: null,
    diffNew: null,
    headOld: undefined,
    headNew: undefined,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    delFile: false,
    hasPair: false,
    hunks: [],
  });
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = diffRe.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0 && !cur.hasPair) {
        cur.headOld = headerPath(l);
        cur.headNew = headerPath(lines[i + 1]!);
        cur.hasPair = true;
      } else {
        cur = fresh();
        cur.headOld = headerPath(l);
        cur.headNew = headerPath(lines[i + 1]!);
        cur.hasPair = true;
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (l.startsWith('--- ') && cur !== null && cur.hunks.length === 0) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: UHunk = { a: Number(m[1]), entries: [] };
      i += 1;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ')) break;
        const c = b[0];
        if (b === '') hunk.entries.push({ kind: ' ', text: '', raw: '' });
        else if (c === ' ' || c === '-' || c === '+' || c === '\\') hunk.entries.push({ kind: c, text: b.slice(1), raw: b });
        else break;
        i += 1;
      }
      while (hunk.entries.length > 0 && hunk.entries[hunk.entries.length - 1]!.raw === '') hunk.entries.pop();
      cur.hunks.push(hunk);
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (l.startsWith('rename from ')) cur.renameFrom = l.slice(12).trim();
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice(10).trim();
      else if (l.startsWith('new file mode')) cur.newFile = true;
      else if (l.startsWith('deleted file mode')) cur.delFile = true;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, ctx));
}

/** One unified section as one edit (section 6): a creation, a deletion, a move or a change. */
function unifiedEdit(sec: USection, ctx: Ctx): Edit {
  const oldPath = sec.headOld !== undefined ? sec.headOld : sec.renameFrom !== null ? sec.renameFrom : sec.diffOld;
  const newPath = sec.headNew !== undefined ? sec.headNew : sec.renameTo !== null ? sec.renameTo : sec.diffNew;
  const isCreate = sec.newFile || oldPath === null;
  const isDelete = !isCreate && (sec.delFile || newPath === null);
  return (tree) => {
    for (const p of [oldPath, newPath]) {
      if (p !== null && !safe(p)) throw new Fail('unsafe', p);
    }
    if (isCreate) {
      if (newPath === null) return;
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const flat: BodyLine[] = [];
      for (const h of sec.hunks) for (const e of h.entries) flat.push(e);
      const texts: string[] = [];
      let lastPlus = -1;
      flat.forEach((e, ix) => {
        if (e.kind === '+') {
          texts.push(e.text);
          lastPlus = ix;
        }
      });
      const fin = !(lastPlus >= 0 && flat[lastPlus + 1]?.kind === '\\');
      tree.now.set(newPath, serialize(texts, '\n', fin));
      return;
    }
    if (oldPath === null) return;
    if (isDelete) {
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    const isMove = newPath !== null && newPath !== oldPath;
    if (isMove && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    const f = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const o = h.entries.filter((e) => e.kind === ' ' || e.kind === '-');
      const nLen = h.entries.filter((e) => e.kind === ' ' || e.kind === '+').length;
      if (o.length === 0) {
        const at = Math.max(0, Math.min(h.a + d, f.lines.length));
        const seg = h.entries.filter((e) => e.kind === '+').map((e) => e.text);
        const reaches = at === f.lines.length;
        f.lines.splice(at, 0, ...seg);
        if (reaches) f.final = !slashAfterLast(h.entries);
        d += seg.length;
      } else {
        const found = findTier(f.lines, o.map((e) => e.text), ctx.strict);
        if (found === null) throw new Fail('no-match', oldPath);
        const target = h.a - 1 + d;
        let pos = found.positions[0]!;
        for (const p of found.positions) {
          if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
        }
        const reaches = pos + o.length === f.lines.length;
        const seg = buildSegment(f.lines, pos, h.entries, found.tier);
        f.lines.splice(pos, o.length, ...seg);
        if (reaches) f.final = !slashAfterLast(h.entries);
        d += nLen - o.length;
      }
    }
    const out = serialize(f.lines, f.br, f.final);
    if (isMove && newPath !== null) {
      tree.now.set(newPath, out);
      tree.now.set(oldPath, null);
      ctx.moves.push({ from: oldPath, to: newPath });
    } else {
      tree.now.set(oldPath, out);
    }
  };
}

/** SEARCH/REPLACE blocks (section 7): each block is one edit, in the patch's order. */
function searchReplaceEdits(lines: string[], ctx: Ctx): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l) || l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${i + 1}`);
      path = prevPath;
    }
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') j += 1;
    if (j >= lines.length) throw new Exit2(`error: parse ${i + 1}`);
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k += 1;
    if (k >= lines.length) throw new Exit2(`error: parse ${i + 1}`);
    const oldLines = lines.slice(i + 1, j);
    const newLines = lines.slice(j + 1, k);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, serialize(newLines, '\n', true));
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = splitFile(before);
      const found = findTier(f.lines, oldLines, ctx.strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = found.positions[0]!;
      const seg = found.tier === 2 ? newLines.map((l) => reindent(l, leadingWs(f.lines[pos]!), leadingWs(oldLines[0]!))) : newLines;
      f.lines.splice(pos, oldLines.length, ...seg);
      tree.now.set(p, serialize(f.lines, f.br, f.final));
    });
    prevPath = path;
    prevEnd = k;
    i = k + 1;
  }
  return edits;
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  entries: BodyLine[];
}

/** V4A patches (section 8): the Begin/End framing, then Add, Delete and Update sections. */
function v4aEdits(lines: string[], ctx: Ctx): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const secStart = (l: string): string | null =>
    l.startsWith('*** Add File: ')
      ? '*** Add File: '
      : l.startsWith('*** Delete File: ')
        ? '*** Delete File: '
        : l.startsWith('*** Update File: ')
          ? '*** Update File: '
          : null;
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const prefix = secStart(l);
    if (prefix === null) throw new Exit2(`error: parse ${i + 1}`);
    const headLine = i + 1;
    const path = l.slice(prefix.length).trim();
    i += 1;
    const body: { line: string; no: number }[] = [];
    while (i < last && secStart(lines[i]!) === null) {
      body.push({ line: lines[i]!, no: i + 1 });
      i += 1;
    }
    while (body.length > 0 && blank(body[body.length - 1]!.line)) body.pop();
    if (prefix === '*** Add File: ') {
      const content: string[] = [];
      for (const b of body) {
        if (b.line.startsWith('+')) content.push(b.line.slice(1));
        else if (b.line === '') content.push('');
        else throw new Exit2(`error: parse ${b.no}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, serialize(content, '\n', true));
      });
    } else if (prefix === '*** Delete File: ') {
      if (body.length > 0) throw new Exit2(`error: parse ${body[0]!.no}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | null = null;
      let start = 0;
      if (body.length > 0 && body[0]!.line.startsWith('*** Move to: ')) {
        moveTo = body[0]!.line.slice('*** Move to: '.length).trim();
        start = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (let bi = start; bi < body.length; bi += 1) {
        const b = body[bi]!;
        const bl = b.line;
        if (bl.startsWith('@@')) {
          const anchor = bl.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, entries: [] };
          chunks.push(cur);
          continue;
        }
        if (bl.trim() === '*** End of File' && !bl.startsWith(' ') && !bl.startsWith('-') && !bl.startsWith('+')) {
          if (cur === null) throw new Exit2(`error: parse ${b.no}`);
          cur.eof = true;
          cur = null;
          continue;
        }
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${b.no}`);
            cur = { anchor: null, eof: false, entries: [] };
            chunks.push(cur);
          }
          cur.entries.push(bl === '' ? { kind: ' ', text: '' } : { kind: bl[0]!, text: bl.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${b.no}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headLine}`);
      edits.push((tree) => v4aUpdate(tree, path, moveTo, chunks, ctx));
    }
  }
  return edits;
}

/** One V4A Update File section applied: its chunks in order, under a cursor (section 8). */
function v4aUpdate(tree: Tree, path: string, moveTo: string | null, chunks: VChunk[], ctx: Ctx): void {
  if (!safe(path)) throw new Fail('unsafe', path);
  if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
  const before = tree.get(path);
  if (before === null) throw new Fail('missing', path);
  if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
  const f = splitFile(before);
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      let at = -1;
      for (const t of tierList(ctx.strict)) {
        for (let ix = cursor; ix < f.lines.length; ix += 1) {
          if (tierOf(f.lines[ix]!, t) === tierOf(ch.anchor, t)) {
            at = ix;
            break;
          }
        }
        if (at >= 0) break;
      }
      if (at < 0) throw new Fail('no-match', path);
      cursor = at + 1;
    }
    const o = ch.entries.filter((e) => e.kind === ' ' || e.kind === '-').map((e) => e.text);
    if (o.length === 0) {
      const seg = ch.entries.filter((e) => e.kind === '+').map((e) => e.text);
      const at = ch.eof ? f.lines.length : cursor;
      f.lines.splice(at, 0, ...seg);
      cursor = at + seg.length;
      continue;
    }
    let chosen: { tier: number; pos: number } | null = null;
    for (const t of tierList(ctx.strict)) {
      let ps = occurrences(f.lines, o, t).filter((p) => p >= cursor);
      if (ch.eof) ps = ps.filter((p) => p + o.length === f.lines.length);
      if (ps.length > 0) {
        chosen = { tier: t, pos: ps[0]! };
        break;
      }
    }
    if (chosen === null) throw new Fail('no-match', path);
    const seg = buildSegment(f.lines, chosen.pos, ch.entries, chosen.tier);
    f.lines.splice(chosen.pos, o.length, ...seg);
    cursor = chosen.pos + seg.length;
  }
  const out = serialize(f.lines, f.br, f.final);
  if (moveTo !== null) {
    tree.now.set(moveTo, out);
    tree.now.set(path, null);
    ctx.moves.push({ from: path, to: moveTo });
  } else {
    tree.now.set(path, out);
  }
}

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
  const ctx: Ctx = { strict, moves: [] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, ctx)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, ctx)
            : v4aEdits(lines, ctx);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const entries: { key: string; text: string }[] = [];
  const changed: string[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push(p);
    entries.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  // A successful move whose old path is gone and whose new path is new replaces its D and A lines (section 2).
  for (const mv of ctx.moves) {
    const di = entries.findIndex((e) => e.text === `D ${mv.from}`);
    const ai = entries.findIndex((e) => e.text === `A ${mv.to}`);
    if (di < 0 || ai < 0) continue;
    entries.splice(Math.max(di, ai), 1);
    entries.splice(Math.min(di, ai), 1);
    entries.push({ key: mv.to, text: `R ${mv.from} -> ${mv.to}` });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const rows = entries.map((e) => e.text);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
