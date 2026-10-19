/**
 * State schema v13 (go-to-k/cdkd#5064): every `StackState` builder in `src/`
 * carries `stackInstanceId` through `stackInstanceIdCarriedFrom`.
 *
 * A builder that drops the field is SILENT: the record saves, every test of
 * the builder's own purpose stays green, and the stack has turned legacy for
 * every later reader. So this reads the source: each object literal that
 * builds a state record must spread `stackInstanceIdCarriedFrom(...)`, unless
 * it builds an EMPTY record (`resources: {}`, no spread: a stack with no
 * record has no id to carry) or is listed in `EXEMPT` with its reason.
 *
 * A literal BUILDS a state record when it holds
 * `version: STATE_SCHEMA_VERSION_CURRENT`, is typed `StackState` (a variable,
 * an arrow's or function's return), or is a `state:` member opening with a
 * spread. The population is checked against a floor, so a scanner that stops
 * finding builders fails instead of passing vacuously, and the scanner is run
 * against a literal that lacks the carrier first.
 *
 * What the carriers DO at runtime is pinned through the real engine in
 * `tests/unit/deployment/deploy-engine-stack-instance-id-5064.test.ts`.
 */
import { describe, it, expect } from 'vite-plus/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SRC = join(ROOT, 'src');
const CARRIER = 'stackInstanceIdCarriedFrom(';

/** Literals that build a record no state write ever persists. */
const EXEMPT: ReadonlyArray<{ file: string; marker: string; reason: string }> = [
  {
    file: 'src/cli/commands/local-start-api.ts',
    marker: 'const syntheticState: StackState = {',
    reason: 'an in-memory view for env-var substitution; never saved',
  },
];

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...listTs(path));
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

/**
 * Every `{`'s matching `}` offset, skipping strings, template literals,
 * comments and regex literals. Throws on an unbalanced file, so a scanner
 * confused by an unusual token fails the test instead of mis-reading it.
 */
function bracePairs(text: string): Map<number, number> {
  const pairs = new Map<number, number>();
  // Each entry: '{' offset, or -1 for a template literal's `${` (which
  // returns to the template on its `}`).
  const stack: Array<{ open: number; template: boolean }> = [];
  let lastSignificant = '';
  let i = 0;
  const n = text.length;
  const skipTemplate = (): void => {
    // At a backtick-or-`}` inside a template: scan to the closing backtick or `${`.
    while (i < n) {
      const c = text[i]!;
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '`') {
        i++;
        lastSignificant = '`';
        return;
      }
      if (c === '$' && text[i + 1] === '{') {
        stack.push({ open: i + 1, template: true });
        i += 2;
        lastSignificant = '{';
        return;
      }
      i++;
    }
    throw new Error('unterminated template literal');
  };
  while (i < n) {
    const c = text[i]!;
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? n : end;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw new Error('unterminated comment');
      i = end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      i++;
      while (i < n && text[i] !== c) {
        if (text[i] === '\\') i++;
        if (text[i] === '\n') throw new Error(`unterminated string at ${i}`);
        i++;
      }
      i++;
      lastSignificant = c;
      continue;
    }
    if (c === '`') {
      i++;
      skipTemplate();
      continue;
    }
    if (c === '/' && (lastSignificant === '' || '(,=:[!&|?{};'.includes(lastSignificant))) {
      // A regex literal.
      i++;
      let inClass = false;
      while (i < n) {
        const r = text[i]!;
        if (r === '\\') {
          i += 2;
          continue;
        }
        if (r === '\n') throw new Error(`unterminated regex at ${i}`);
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) break;
        i++;
      }
      i++;
      lastSignificant = '/';
      continue;
    }
    if (c === '{') {
      stack.push({ open: i, template: false });
    } else if (c === '}') {
      const top = stack.pop();
      if (top === undefined) throw new Error(`unbalanced '}' at ${i}`);
      pairs.set(top.open, i);
      if (top.template) {
        i++;
        skipTemplate();
        continue;
      }
    }
    if (!/\s/.test(c)) {
      // `return /re/` and friends: a keyword ending a word before a regex.
      lastSignificant = /[A-Za-z0-9_$]/.test(c) ? (endsKeyword(text, i) ? '(' : 'a') : c;
    }
    i++;
  }
  if (stack.length > 0) throw new Error('unbalanced braces at end of file');
  return pairs;
}

function endsKeyword(text: string, i: number): boolean {
  const before = text.slice(Math.max(0, i - 9), i + 1);
  return /(?:^|[^A-Za-z0-9_$])(?:return|typeof|case|in|of|yield|await)$/.test(before);
}

interface Builder {
  file: string;
  line: number;
  text: string;
  /** `text` with every nested `{...}` emptied: the literal's OWN members. */
  topLevel: string;
}

/** The literal at `open` with the contents of every nested pair removed. */
function topLevelOf(text: string, pairs: Map<number, number>, open: number): string {
  const close = pairs.get(open)!;
  let out = '';
  let i = open + 1;
  while (i < close) {
    const nested = pairs.get(i);
    if (nested !== undefined && nested < close) {
      out += '{}';
      i = nested + 1;
      continue;
    }
    out += text[i];
    i++;
  }
  return `{${out}}`;
}

/** The innermost `{...}` around `offset`. */
function enclosing(pairs: Map<number, number>, offset: number): [number, number] | undefined {
  let best: [number, number] | undefined;
  for (const [open, close] of pairs) {
    if (open < offset && close > offset && (best === undefined || open > best[0])) {
      best = [open, close];
    }
  }
  return best;
}

/** Every literal in `text` that builds a state record. */
function buildersIn(file: string, text: string): Builder[] {
  const pairs = bracePairs(text);
  const opens = new Set<number>();
  // Anchored INSIDE the literal.
  for (const m of text.matchAll(/\bversion: STATE_SCHEMA_VERSION_CURRENT\b/g)) {
    const span = enclosing(pairs, m.index);
    if (span !== undefined) opens.add(span[0]);
  }
  // Anchored at the literal's own `{`.
  for (const m of text.matchAll(
    /(?::\s*StackState\s*=\s*|\):\s*StackState\s*=>\s*\(\s*|\bstate:\s*)\{(?=\s*\.\.\.)?/g
  )) {
    const open = m.index + m[0].length - 1;
    if (!pairs.has(open)) continue;
    // `state:` only when the member opens with a spread (a rebuilt record).
    if (/\bstate:\s*\{$/.test(m[0]) && !/^\{\s*\.\.\./.test(text.slice(open, open + 200))) continue;
    opens.add(open);
  }
  // A record literal handed straight to a state save, after plain arguments.
  for (const m of text.matchAll(/\b(?:saveState|saveScrubbedState)\(/g)) {
    const open = text.indexOf('{', m.index + m[0].length);
    if (open === -1 || !pairs.has(open)) continue;
    if (!plainArgumentsBefore(text.slice(m.index + m[0].length, open))) continue;
    // The record, not the save's options bag: it names `resources`.
    if (/\bresources\b/.test(topLevelOf(text, pairs, open))) opens.add(open);
  }
  // `return {` directly inside a block-bodied function typed `: StackState`.
  for (const m of text.matchAll(/\):\s*StackState\s*(?:=>\s*)?\{/g)) {
    const bodyOpen = m.index + m[0].length - 1;
    const bodyClose = pairs.get(bodyOpen);
    if (bodyClose === undefined) continue;
    for (const r of text.slice(bodyOpen, bodyClose).matchAll(/\breturn\s+\{/g)) {
      const open = bodyOpen + r.index + r[0].length - 1;
      if (pairs.has(open) && !insideNestedFunction(text, pairs, bodyOpen, open)) opens.add(open);
    }
  }
  return [...opens].map((open) => ({
    file,
    line: text.slice(0, open).split('\n').length,
    text: text.slice(open, pairs.get(open)! + 1),
    topLevel: topLevelOf(text, pairs, open),
  }));
}

/**
 * Do the characters between a call's `(` and a `{` hold only complete earlier
 * arguments (calls included), ending in a comma at the call's own depth?
 */
function plainArgumentsBefore(between: string): boolean {
  let depth = 0;
  for (const c of between) {
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth < 0) return false;
    } else if (c === '{' || c === '}' || c === ';') return false;
  }
  return depth === 0 && /,\s*$/.test(between);
}

/**
 * Is `offset` inside a function body nested in the one opening at `bodyOpen`
 * (a callback's `return` builds something else)?
 */
function insideNestedFunction(
  text: string,
  pairs: Map<number, number>,
  bodyOpen: number,
  offset: number
): boolean {
  for (const [open, close] of pairs) {
    if (open <= bodyOpen || open >= offset || close < offset) continue;
    const before = text.slice(Math.max(0, open - 200), open);
    if (/=>\s*$/.test(before) || /\bfunction\b[^{;]*\)\s*(?::[^{;]+)?$/.test(before)) return true;
  }
  return false;
}

const isEmptyRecord = (literal: string): boolean =>
  /\bresources:\s*\{\s*\}/.test(literal) && !literal.includes('...');

function violations(builders: readonly Builder[], sources: Map<string, string>): Builder[] {
  return builders.filter((b) => {
    if (b.topLevel.includes(CARRIER) || isEmptyRecord(b.text)) return false;
    return !EXEMPT.some(
      (e) => e.file === b.file && (sources.get(b.file) ?? '').includes(e.marker + b.text.slice(1))
    );
  });
}

describe('every StackState builder carries stackInstanceId (go-to-k/cdkd#5064)', () => {
  const sources = new Map<string, string>();
  for (const path of listTs(SRC)) {
    sources.set(relative(ROOT, path).split('\\').join('/'), readFileSync(path, 'utf8'));
  }

  it('the scanner flags a builder without the carrier, and passes one with it', () => {
    const without = `const s: StackState = {\n  ...prev,\n  resources: next,\n  note: '}{',\n};\n`;
    const withIt = `const s: StackState = {\n  ...prev,\n  ...${CARRIER}prev),\n  resources: next,\n};\n`;
    const fresh = `const s = {\n  version: STATE_SCHEMA_VERSION_CURRENT,\n  resources: {},\n};\n`;
    const arrow = `const f = (): StackState => {\n  const x = /[{]/;\n  return {\n    ...rest,\n    resources: r,\n  };\n};\n`;
    const member = `return {\n  state: {\n    ...carried,\n    resources: r,\n  },\n};\n`;
    const nested = `const f = (): StackState => {\n  const o = list.map((e) => {\n    return {\n      ...e,\n      x: 1,\n    };\n  });\n  return {\n    ...rest,\n    ...${CARRIER}rest),\n  };\n};\n`;
    const scan = (text: string): Builder[] => {
      const builders = buildersIn('x.ts', text);
      return violations(builders, new Map([['x.ts', text]]));
    };
    expect(buildersIn('x.ts', without)).toHaveLength(1);
    expect(scan(without)).toHaveLength(1);
    expect(scan(withIt)).toHaveLength(0);
    expect(buildersIn('x.ts', fresh)).toHaveLength(1);
    expect(scan(fresh)).toHaveLength(0);
    expect(scan(arrow)).toHaveLength(1);
    expect(scan(member)).toHaveLength(1);
    // A literal handed straight to a save, and a carrier that only a nested
    // callback holds.
    const direct = `await saveState(\n  name,\n  region,\n  {\n    ...prev,\n    resources: r,\n  },\n  opts\n);\n`;
    const nestedOnly = `const s: StackState = {\n  ...prev,\n  extra: list.map((e) => { return { ...${CARRIER}e) }; }),\n};\n`;
    expect(buildersIn('x.ts', direct)).toHaveLength(1);
    const directAfterCall = `await saveState(name, displaySafe(region), {\n  ...prev,\n  resources: r,\n});\n`;
    expect(scan(directAfterCall)).toHaveLength(1);
    expect(scan(direct)).toHaveLength(1);
    expect(scan(nestedOnly)).toHaveLength(1);
    // A callback's `return` inside the builder is not the builder.
    expect(buildersIn('x.ts', nested)).toHaveLength(1);
    expect(scan(nested)).toHaveLength(0);
  });

  it('every builder in src/ spreads stackInstanceIdCarriedFrom', () => {
    const builders = [...sources].flatMap(([file, text]) => buildersIn(file, text));
    const missing = violations(builders, sources).map((b) => `${b.file}:${b.line}`);
    expect(missing).toEqual([]);
    // The population at the time of writing: a scanner that finds fewer has
    // stopped reading builders, which must not pass as "none missing".
    expect(builders.length).toBeGreaterThanOrEqual(26);
    // And the files that hold one, by name.
    const files = new Set(builders.map((b) => b.file));
    for (const file of [
      'src/deployment/deploy-engine/deploy-flow.ts',
      'src/deployment/deploy-engine/execute.ts',
      'src/deployment/nested-child-journal.ts',
      'src/cli/commands/import.ts',
      'src/cli/commands/rollback.ts',
      'src/cli/commands/drift.ts',
      'src/cli/commands/scrub.ts',
      'src/cli/commands/destroy-runner.ts',
      'src/analyzer/orphan-rewriter.ts',
      'src/state/s3-state-backend.ts',
    ]) {
      expect(files).toContain(file);
    }
  });

  it('each EXEMPT entry still names a builder', () => {
    for (const e of EXEMPT) {
      expect(sources.get(e.file) ?? '').toContain(e.marker);
    }
  });
});

/**
 * go-to-k/cdkd#5064 phase 2: every `ResourceState` a writer builds FIELD BY
 * FIELD into a resources map states the record's name generation -- carried
 * (`nameGenerationCarriedFrom`), written for a new resource
 * (`nameGenerationField`) or rebuilt (`nameGenerationReachedField`, an import
 * helper). A literal that drops it is silent: the next replacement then asks
 * for a name an earlier generation already holds. A literal that SPREADS a
 * record carries the fields already.
 */
describe('every field-by-field ResourceState writer states the name generation (go-to-k/cdkd#5064 phase 2)', () => {
  const sources = new Map<string, string>();
  for (const path of listTs(SRC)) {
    sources.set(relative(ROOT, path).split('\\').join('/'), readFileSync(path, 'utf8'));
  }

  /** `<x>Resources[...] = {` / `resources[...] = {` literals naming a physical id. */
  function recordWritersIn(file: string, text: string): Builder[] {
    const pairs = bracePairs(text);
    const out: Builder[] = [];
    for (const m of text.matchAll(/(?<![.\w])(?:[a-z][A-Za-z]*Resources|resources)\[[^\]\n]+\]\s*=\s*\{/g)) {
      const open = m.index + m[0].length - 1;
      if (!pairs.has(open)) continue;
      const topLevel = topLevelOf(text, pairs, open);
      if (!/\bphysicalId\s*:/.test(topLevel)) continue;
      out.push({
        file,
        line: text.slice(0, open).split('\n').length,
        text: text.slice(open, pairs.get(open)! + 1),
        topLevel,
      });
    }
    return out;
  }
  /** Opens by spreading a record, or names a generation helper or field. */
  const states = (b: Builder): boolean =>
    /^\{\s*\.\.\.[A-Za-z_$][\w$.]*\s*,/.test(b.topLevel) || /[nN]ameGeneration/.test(b.text);

  it('the scanner flags a literal without the generation, and passes one with it or a spread', () => {
    const scan = (text: string) => recordWritersIn('x.ts', text).filter((b) => !states(b));
    expect(scan(`stateResources[id] = {\n  physicalId: p,\n  resourceType: t,\n};\n`)).toHaveLength(1);
    expect(
      scan(`stateResources[id] = {\n  physicalId: p,\n  ...nameGenerationField(g),\n};\n`)
    ).toHaveLength(0);
    expect(scan(`resources[id] = {\n  ...record,\n  physicalId: p,\n};\n`)).toHaveLength(0);
    // `template.Resources[...]` is a template, never a record.
    expect(recordWritersIn('x.ts', `template.Resources[id] = {\n  physicalId: p,\n};\n`)).toHaveLength(0);
  });

  it('every such writer in src/ states it', () => {
    const writers = [...sources].flatMap(([file, text]) => recordWritersIn(file, text));
    const missing = writers.filter((b) => !states(b)).map((b) => `${b.file}:${b.line}`);
    expect(missing).toEqual([]);
    expect(writers.length).toBeGreaterThanOrEqual(4);
    const files = new Set(writers.map((b) => b.file));
    for (const file of [
      'src/deployment/deploy-engine/create.ts',
      'src/deployment/deploy-engine/update-replace.ts',
      'src/deployment/deploy-engine/update-in-place.ts',
      'src/cli/commands/import.ts',
    ]) {
      expect(files).toContain(file);
    }
  });
});
