// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
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
  /** Moves a successful move edit recorded, as [old, new] pairs, for the `R` output lines. */
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

// ---- Section 5: matching lines (SPEC.md) ----
function trimEndWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function trimWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}
function occurrences(O: string[], F: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= F.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(O[j]!, F[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}
function findTier(O: string[], F: string[], strict: boolean, from: number): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(O, F, t, from);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}
function findTierEof(O: string[], F: string[], strict: boolean, from: number): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(O, F, t, from).filter((p) => p + O.length === F.length);
    if (pos.length > 0) return { tier: t, pos: pos[0]! };
  }
  return null;
}

/** One hunk/chunk: old lines O and new lines N; a new line that is a context line names its index in O. */
interface Piece {
  o: string[];
  n: Array<{ text: string; ctx: number | null }>;
}
function bodyPiece(body: string[]): Piece {
  const o: string[] = [];
  const n: Array<{ text: string; ctx: number | null }> = [];
  for (const l of body) {
    if (l.startsWith(' ')) {
      const t = l.slice(1);
      o.push(t);
      n.push({ text: t, ctx: o.length - 1 });
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
    } else if (l.startsWith('+')) {
      n.push({ text: l.slice(1), ctx: null });
    } else if (l === '') {
      o.push('');
      n.push({ text: '', ctx: o.length - 1 });
    }
  }
  return { o, n };
}
function applyPiece(F: string[], piece: Piece, at: number, tier: number): string[] {
  const out = F.slice(0, at);
  const P = piece.o.length > 0 ? leadWs(piece.o[0]!) : '';
  const F0 = F[at] !== undefined ? leadWs(F[at]!) : '';
  for (const nl of piece.n) {
    if (nl.ctx !== null) {
      out.push(F[at + nl.ctx]!);
      continue;
    }
    let t = nl.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(P)) t = F0 + t.slice(P.length);
    out.push(t);
  }
  out.push(...F.slice(at + piece.o.length));
  return out;
}

function fileSplit(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}
function fileJoin(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

// ---- Section 6: unified diffs ----
function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  return p.trim();
}
function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}
interface UniHunk {
  a: number;
  piece: Piece;
  noEol: boolean;
  plusNoEol: boolean;
}
interface UniSection {
  pairOld: string | null;
  pairNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  gitOld: string | null;
  gitNew: string | null;
  create: boolean;
  del: boolean;
  hunks: UniHunk[];
  createNoEol: boolean;
}
function uniPaths(sec: UniSection): { oldPath: string | null; newPath: string | null } {
  return { oldPath: sec.pairOld ?? sec.renameOld ?? sec.gitOld, newPath: sec.pairNew ?? sec.renameNew ?? sec.gitNew };
}
function applyUniHunk(lines: string[], fin: boolean, hunk: UniHunk, d: number, strict: boolean, path: string): { lines: string[]; final: boolean } {
  const { o } = hunk.piece;
  if (o.length === 0) {
    const pos = Math.min(hunk.a + d, lines.length);
    const out = applyPiece(lines, hunk.piece, pos, 0);
    return { lines: out, final: pos === lines.length ? !hunk.noEol : fin };
  }
  const found = findTier(o, lines, strict, 0);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let best = found.positions[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of found.positions) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const out = applyPiece(lines, hunk.piece, best, found.tier);
  const final = best + o.length === lines.length ? !hunk.noEol : fin;
  return { lines: out, final };
}
function unifiedSectionEdit(sec: UniSection, strict: boolean): Edit {
  const { oldPath, newPath } = uniPaths(sec);
  return (tree) => {
    const named: string[] = [];
    if (oldPath !== null && oldPath !== '/dev/null') named.push(oldPath);
    if (newPath !== null && newPath !== '/dev/null' && newPath !== oldPath) named.push(newPath);
    for (const p of named) if (!safe(p)) throw new Fail('unsafe', p);
    const isCreate = oldPath === '/dev/null' || sec.create;
    const isDelete = newPath === '/dev/null' || sec.del;
    if (isCreate) {
      const p = newPath;
      if (p === null) return;
      if (p === '/dev/null') throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const nl of h.piece.n) if (nl.ctx === null) plus.push(nl.text);
      const text = plus.length === 0 ? '' : plus.join('\n') + (sec.createNoEol ? '' : '\n');
      tree.now.set(p, text);
      return;
    }
    if (isDelete) {
      const p = oldPath;
      if (p === null) return;
      if (p === '/dev/null') throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const o = oldPath ?? newPath;
    const nw = newPath ?? oldPath;
    if (o === null || nw === null) return;
    const cur = tree.get(o);
    if (cur === null) throw new Fail('missing', o);
    if (o !== nw && tree.get(nw) !== null) throw new Fail('exists', nw);
    const split = fileSplit(cur);
    let lines = split.lines;
    let fin = split.final;
    let d = 0;
    for (const h of sec.hunks) {
      const res = applyUniHunk(lines, fin, h, d, strict, o);
      lines = res.lines;
      fin = res.final;
      d += h.piece.n.length - h.piece.o.length;
    }
    const text = fileJoin(lines, split.br, fin);
    if (o !== nw) {
      tree.now.set(o, null);
      tree.now.set(nw, text);
      tree.moves.push([o, nw]);
    } else {
      tree.now.set(o, text);
    }
  };
}
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@( .*)?$/;
  const diffGitRe = /^diff --git a\/(.+?) b\/(.+)$/;
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let state: 'header' | 'after' = 'header';
  let i = 0;
  const n = lines.length;
  const newSection = (): UniSection => ({
    pairOld: null,
    pairNew: null,
    renameOld: null,
    renameNew: null,
    gitOld: null,
    gitNew: null,
    create: false,
    del: false,
    hunks: [],
    createNoEol: false,
  });
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = diffGitRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      sections.push(cur);
      state = 'header';
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || state === 'after') {
        cur = newSection();
        sections.push(cur);
        state = 'header';
      }
      cur.pairOld = stripAB(headerPath(line));
      cur.pairNew = stripAB(headerPath(lines[i + 1]!));
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      let j = i + 1;
      const body: string[] = [];
      while (j < n) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
          body.push(l);
          j++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      let lastCtxPlus = -1;
      let lastPlus = -1;
      for (let k = 0; k < body.length; k++) {
        if (body[k]!.startsWith(' ') || body[k]!.startsWith('+')) lastCtxPlus = k;
        if (body[k]!.startsWith('+')) lastPlus = k;
      }
      const noEol = lastCtxPlus >= 0 && lastCtxPlus + 1 < body.length && body[lastCtxPlus + 1]!.startsWith('\\');
      const plusNoEol = lastPlus >= 0 && lastPlus + 1 < body.length && body[lastPlus + 1]!.startsWith('\\');
      const piece = bodyPiece(body);
      cur.hunks.push({ a, piece, noEol, plusNoEol });
      if (piece.n.some((x) => x.ctx === null)) cur.createNoEol = plusNoEol;
      state = 'after';
      i = j;
      continue;
    }
    if (cur !== null && state === 'header') {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) {
        cur.renameOld = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameNew = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line === 'new file mode' || line.startsWith('new file mode ')) {
        cur.create = true;
        i++;
        continue;
      }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        cur.del = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => unifiedSectionEdit(sec, strict));
}

// ---- Section 7: SEARCH/REPLACE blocks ----
function srEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchIdx = i;
      let path: string | null = null;
      for (let j = searchIdx - 1; j > prevReplaceEnd; j--) {
        const l = lines[j]!;
        if (blank(l)) continue;
        const t = l.trim();
        if (t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
        path = prevPath;
      }
      let sep = -1;
      for (let j = searchIdx + 1; j < lines.length; j++) {
        const t = lines[j]!.trimEnd();
        if (t === '=======') {
          sep = j;
          break;
        }
        if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
      }
      if (sep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
      let rep = -1;
      for (let j = sep + 1; j < lines.length; j++) {
        const t = lines[j]!.trimEnd();
        if (t === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
        if (t === '<<<<<<< SEARCH') break;
      }
      if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
      blocks.push({ path, oldLines: lines.slice(searchIdx + 1, sep), newLines: lines.slice(sep + 1, rep) });
      prevPath = path;
      prevReplaceEnd = rep;
      i = rep + 1;
      continue;
    }
    i++;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => {
    const { path, oldLines, newLines } = b;
    return (tree: Tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (oldLines.length === 0) {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        const text = newLines.length === 0 ? '' : newLines.join('\n') + '\n';
        tree.now.set(path, text);
        return;
      }
      const cur = tree.get(path);
      if (cur === null) throw new Fail('missing', path);
      const split = fileSplit(cur);
      const found = findTier(oldLines, split.lines, strict, 0);
      if (found === null) throw new Fail('no-match', path);
      if (found.positions.length > 1) throw new Fail('ambiguous', path);
      const piece: Piece = { o: oldLines, n: newLines.map((t) => ({ text: t, ctx: null })) };
      const out = applyPiece(split.lines, piece, found.positions[0]!, found.tier);
      tree.now.set(path, fileJoin(out, split.br, split.final));
    };
  });
}

// ---- Section 8: V4A patches ----
interface V4AChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}
interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  lines: string[];
  moveTo: string | null;
  chunks: V4AChunk[];
  seenContent: boolean;
}
function finishV4ASection(sec: V4ASection | null): void {
  if (sec === null) return;
  if (sec.kind === 'update' && sec.chunks.length === 0 && sec.moveTo === null) {
    throw new Exit2(`error: parse ${sec.lineNo}`);
  }
  if (sec.kind === 'add') {
    while (sec.lines.length > 0 && blank(sec.lines[sec.lines.length - 1]!)) sec.lines.pop();
  } else if (sec.kind === 'update') {
    const last = sec.chunks[sec.chunks.length - 1];
    if (last !== undefined && !last.eof) {
      while (last.body.length > 0 && blank(last.body[last.body.length - 1]!)) last.body.pop();
    }
  }
}
function v4aSectionEdit(sec: V4ASection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      const text = sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n';
      tree.now.set(sec.path, text);
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    const moveTo = sec.moveTo;
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(sec.path);
    if (cur === null) throw new Fail('missing', sec.path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const split = fileSplit(cur);
    let lines = split.lines;
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        let foundAt = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          for (let k = cursor; k < lines.length; k++) {
            if (lineEq(chunk.anchor, lines[k]!, t)) {
              foundAt = k;
              break;
            }
          }
          if (foundAt >= 0) break;
        }
        if (foundAt < 0) throw new Fail('no-match', sec.path);
        cursor = foundAt + 1;
      }
      const piece = bodyPiece(chunk.body);
      if (piece.o.length === 0) {
        const pos = chunk.eof ? lines.length : cursor;
        lines = applyPiece(lines, piece, pos, 0);
        cursor = pos + piece.n.length;
      } else if (chunk.eof) {
        const found = findTierEof(piece.o, lines, strict, cursor);
        if (found === null) throw new Fail('no-match', sec.path);
        lines = applyPiece(lines, piece, found.pos, found.tier);
        cursor = found.pos + piece.n.length;
      } else {
        const found = findTier(piece.o, lines, strict, cursor);
        if (found === null) throw new Fail('no-match', sec.path);
        const pos = found.positions[0]!;
        lines = applyPiece(lines, piece, pos, found.tier);
        cursor = pos + piece.n.length;
      }
    }
    const text = fileJoin(lines, split.br, split.final);
    if (moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(moveTo, text);
      tree.moves.push([sec.path, moveTo]);
    } else {
      tree.now.set(sec.path, text);
    }
  };
}
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4ASection[] = [];
  let cur: V4ASection | null = null;
  let curChunk: V4AChunk | null = null;
  const end = last;
  let i = first + 1;
  const makeSection = (kind: 'add' | 'delete' | 'update', line: string, lineNo: number): V4ASection => {
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
    return { kind, path: line.slice(prefix.length).trim(), lineNo, lines: [], moveTo: null, chunks: [], seenContent: false };
  };
  while (i < end) {
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ')) {
      finishV4ASection(cur);
      const kind = line.startsWith('*** Add File: ') ? 'add' : line.startsWith('*** Delete File: ') ? 'delete' : 'update';
      cur = makeSection(kind, line, i + 1);
      curChunk = null;
      sections.push(cur);
      i++;
      continue;
    }
    if (cur === null) {
      if (blank(line)) {
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur.kind === 'add') {
      if (line.startsWith('+')) {
        cur.lines.push(line.slice(1));
        cur.seenContent = true;
        i++;
        continue;
      }
      if (line === '') {
        cur.lines.push('');
        cur.seenContent = true;
        i++;
        continue;
      }
      if (blank(line)) {
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur.kind === 'delete') {
      if (blank(line)) {
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (!cur.seenContent && line.startsWith('*** Move to: ')) {
      cur.moveTo = line.slice('*** Move to: '.length).trim();
      cur.seenContent = true;
      i++;
      continue;
    }
    if (line === '*** End of File') {
      const lastChunk = cur.chunks[cur.chunks.length - 1];
      if (lastChunk !== undefined) lastChunk.eof = true;
      curChunk = null;
      cur.seenContent = true;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      curChunk = { anchor: line.slice(2).trim() === '' ? null : line.slice(2).trim(), body: [], eof: false };
      cur.chunks.push(curChunk);
      cur.seenContent = true;
      i++;
      continue;
    }
    if (blank(line) && curChunk === null && cur.chunks.length > 0) {
      i++;
      continue;
    }
    if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line === '') {
      if (curChunk === null) {
        if (cur.chunks.length === 0) {
          curChunk = { anchor: null, body: [], eof: false };
          cur.chunks.push(curChunk);
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
      }
      curChunk.body.push(line);
      cur.seenContent = true;
      i++;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  finishV4ASection(cur);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => v4aSectionEdit(sec, strict));
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
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
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
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const rowItems: Array<{ key: string; line: string }> = [];
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rowItems.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  const moved = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      moved.add(oldP);
      moved.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (moved.has(p)) continue;
    rowItems.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rowItems.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = rowItems.map((x) => x.line);
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
