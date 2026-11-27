/**
 * go-to-k/cdkd#7061: a reader of a recorded or desired value asks
 * `secret-redaction/recorded-secrecy.ts` whether it carries a redaction marker,
 * and never tests for the marker by hand.
 *
 * THE POPULATION. Every `.ts` file of each MIGRATED module group in
 * {@link GROUPS}, parsed with a real parser, so a comment is never read. A
 * MARKER is `SECRET_MASK`, any constant bound anywhere under `src/` to a string
 * spelling `***` or `{{resolve` (`DYNAMIC_REFERENCE_OPENING`, ...), or such a
 * string or template literal itself. Literals are FOLDED first: a `+` chain, a
 * template literal, `[...].join(sep)` and `.concat(...)` over literal parts
 * read as the text they build (`'{{' + 'resolve:'`). A marker FRAGMENT is a
 * literal run of two or more `*` (`'**'`) or a prefix of the opener at least two
 * characters long (`'{{'`). A HAND TEST is:
 * - an equality (`===`, `!==`, `==`, `!=`), an `Object.is` or a `switch` case
 *   with a marker or a fragment;
 * - a string search or edit (`includes`, `startsWith`, `endsWith`, `indexOf`,
 *   `lastIndexOf`, `search`, `match`, `matchAll`, `split`, `replace`,
 *   `replaceAll`, `localeCompare`), by name or computed key, whose first
 *   argument is a marker or a fragment;
 * - an `includes` / `has` / `indexOf` on an array or `Set` literal holding one;
 * - a regular expression (a literal, or `RegExp(...)` of a marker) that
 *   matches a marker and not the same text with one character changed;
 * - a local binding of a marker literal (a second mask constant);
 * - a direct `carriesSecretMask` call: the helper's `holdsMaskLeaf` is the one
 *   spelling of that question.
 * Each one fails here unless {@link NOT_A_READER} lists it, and an entry that
 * matches nothing fails too.
 *
 * BOUNDS. The groups grow one PR at a time (#7061's plan): update compare and
 * preflight, then rollback and drift, are here; export and import, delete,
 * nested child resolution and scrub follow; and the diff rendering with the cross-stack
 * preview. A file outside every group is outside the fence (the legacy-row
 * output mask joins the export group). Within a group, the fence finds hand
 * tests for a MARKER only: a reader that compares, sends or addresses a
 * recorded value with no secrecy test at all is not seen, and neither is a
 * marker reached through a value no constant names (a string built at run
 * time from parts that are not literals), nor a one-character piece of one
 * (`'*'`, which an IAM wildcard spells too), nor a marker handed as an argument to any other
 * function (a deep-equality helper, a local comparator `same(v, SECRET_MASK)`). The record-provenance entry point and the fence arm that routes
 * record readers onto it are later steps of the same plan.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseSync } from 'vite-plus';
import { describe, expect, it } from 'vite-plus/test';
import {
  dynamicReferenceBody,
  dynamicReferenceOpeners,
  isMaskLeaf,
  isMaskRun,
  mentionsDynamicReference,
  mentionsMask,
  usableRecordedName,
  valueMentionsDynamicReference,
} from '../../../src/deployment/secret-redaction/recorded-secrecy.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const HELPER = 'src/deployment/secret-redaction/recorded-secrecy.ts';

type Node = { type: string; start: number; end: number; [k: string]: unknown };

function isNode(v: unknown): v is Node {
  return typeof v === 'object' && v !== null && typeof (v as Node).type === 'string';
}

/** Parse `text`, refusing a file the parser cannot read (a scan of half a file proves nothing). */
function parseOrThrow(file: string, text: string): Node {
  const parsed = parseSync(file, text);
  if (parsed.errors.length > 0) throw new Error(`cannot parse ${file}: ${parsed.errors[0]!.message}`);
  return parsed.program as unknown as Node;
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...tsFiles(path));
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

/** The migrated module groups: directories (recursive) and single files. */
const GROUPS: Readonly<Record<string, readonly string[]>> = {
  'update compare and preflight': [
    'src/analyzer/diff-calculator',
    'src/analyzer/diff-calculator.ts',
    'src/analyzer/replacement-rules',
    'src/deployment/deploy-engine/update',
    'src/deployment/deploy-engine/update-in-place',
    'src/deployment/deploy-engine/update-policy.ts',
    'src/deployment/deploy-engine/replacement',
    'src/deployment/deploy-engine/read-provenance-moved.ts',
    'src/deployment/deploy-engine/noecho.ts',
    'src/deployment/deploy-engine/deploy-flow/plan-checks.ts',
    'src/deployment/export-change-guard.ts',
    'src/deployment/replacement-name-holder',
    'src/deployment/type-change-guard.ts',
    'src/deployment/recorded-identity-attributes.ts',
    'src/deployment/custom-resource-service-token.ts',
    'src/deployment/masked-property-fingerprints',
    'src/deployment/masked-baseline-recapture.ts',
    'src/provisioning/cloud-control/unapplied-update.ts',
    'src/cli/commands/recreate-downstream-consumers.ts',
  ],
  'rollback and drift': [
    'src/deployment/rollback-executor',
    'src/deployment/rollback-executor.ts',
    'src/deployment/deploy-engine/rollback',
    'src/deployment/deploy-engine/rollback.ts',
    'src/deployment/deploy-engine/execute/rollback-after-failure.ts',
    'src/deployment/inline-policy-claims/rollback-writers.ts',
    'src/cli/commands/rollback',
    'src/cli/commands/rollback.ts',
    'src/cli/commands/rollback-drop-failed.ts',
    'src/types/rollback-journal.ts',
    'src/analyzer/drift-calculator.ts',
    'src/analyzer/drift-normalize.ts',
    'src/analyzer/drift-principal-normalize.ts',
    'src/analyzer/drift-protocol-normalize.ts',
    'src/analyzer/drift-undeclared-grants.ts',
    'src/analyzer/drift-verbatim-paths.ts',
    'src/cli/commands/drift',
    'src/cli/commands/drift.ts',
    'src/cli/commands/state/refresh-observed-stack.ts',
    'src/cli/commands/state/refresh-observed.ts',
    'src/provisioning/drift-declared-projection.ts',
    'src/provisioning/providers/codebuild/drift.ts',
    'src/provisioning/providers/dynamodb-globaltable/drift.ts',
    'src/provisioning/providers/dynamodb-table/drift.ts',
    'src/provisioning/providers/ec2/drift.ts',
    'src/provisioning/providers/rds/drift.ts',
    // The journal's readers of an attempted bag or name, and the token-free body test.
    'src/deployment/deploy-engine/deploy-flow/journal-at-start.ts',
    'src/state/unsettled-properties.ts',
    'src/state/token-free-state.ts',
  ],
};

/**
 * Hand tests that read no recorded or desired value, keyed
 * `<file>#<enclosing function>#<source text>`, with how many and why.
 */
const NOT_A_READER: Readonly<Record<string, { count: number; why: string }>> = {};

const SEARCHES = new Set([
  'includes',
  'startsWith',
  'endsWith',
  'indexOf',
  'lastIndexOf',
  'search',
  'match',
  'matchAll',
  'split',
  'replace',
  'replaceAll',
  'localeCompare',
]);
const COLLECTION_SEARCHES = new Set(['includes', 'has', 'indexOf']);
const MARKER_TEXT = /\*\*\*|\{\{resolve/;
/** A CONSTANT's whole text that is a marker (the mask, the opener, an opener with its service), not prose naming one. */
const MARKER_CONSTANT = /^(?:\*{3,4}|\{\{resolve:(?:[a-z-]+:)?)$/;
/** Each marker, and the same text with one character changed: a pattern matching the first but not the second names the marker. */
const MARKER_SAMPLES: ReadonlyArray<readonly [string, string]> = [
  ['***', '*+*'],
  ['"***"', '"*+*"'],
  ['a***b', 'a*+*b'],
  ['{{resolve:', '{{resolvX:'],
  ['{{resolve:ssm:/p}}', '{{resolvX:ssm:/p}}'],
  ['{{resolve:ssm-secure:/p}}', '{{resolvX:ssm-secure:/p}}'],
  ['{{resolve:secretsmanager:s:SecretString:k::}}', '{{resolvX:secretsmanager:s:SecretString:k::}}'],
];

function groupFiles(): string[] {
  const out = new Set<string>();
  for (const entries of Object.values(GROUPS)) {
    for (const entry of entries) {
      const abs = join(ROOT, entry);
      const files = entry.endsWith('.ts') ? [abs] : tsFiles(abs);
      // A group entry that names nothing is a stale group, not an empty one.
      if (files.length === 0) throw new Error(`group entry ${entry} holds no module`);
      for (const f of files) out.add(relative(ROOT, f).split('\\').join('/'));
    }
  }
  return [...out].sort();
}

/** The operands of a `+` chain, left to right (`a + b + c` is `(a + b) + c`). */
function plusOperands(raw: unknown): unknown[] {
  const node = unwrap(raw);
  if (isNode(node) && node.type === 'BinaryExpression' && node['operator'] === '+') {
    return [...plusOperands(node['left']), ...plusOperands(node['right'])];
  }
  return [node];
}

/**
 * The text a string expression folds to from literals alone, else undefined: a
 * string literal, a template literal whose parts all fold, a `+` of folding
 * operands, `[...].join(sep)` over folding elements and `s.concat(...)` of
 * folding parts (`'{{' + 'resolve:'`, `['*', '**'].join('')`).
 */
function literalText(raw: unknown): string | undefined {
  const node = unwrap(raw);
  if (!isNode(node)) return undefined;
  if (node.type === 'Literal' && typeof node['value'] === 'string') return node['value'];
  if (node.type === 'TemplateLiteral') {
    const quasis = node['quasis'] as Node[];
    const exprs = node['expressions'] as unknown[];
    let out = '';
    for (let i = 0; i < quasis.length; i++) {
      const cooked = (quasis[i]!['value'] as { cooked?: string }).cooked;
      if (cooked === undefined) return undefined;
      out += cooked;
      if (i < exprs.length) {
        const part = literalText(exprs[i]);
        if (part === undefined) return undefined;
        out += part;
      }
    }
    return out;
  }
  if (node.type === 'BinaryExpression' && node['operator'] === '+') {
    const left = literalText(node['left']);
    const right = left === undefined ? undefined : literalText(node['right']);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (node.type === 'CallExpression') {
    const callee = unwrap(node['callee']);
    if (!isNode(callee)) return undefined;
    const name = memberName(callee);
    const args = node['arguments'] as unknown[];
    const parts = (list: unknown[]): string[] | undefined => {
      const out: string[] = [];
      for (const item of list) {
        const t = literalText(item);
        if (t === undefined) return undefined;
        out.push(t);
      }
      return out;
    };
    const object = unwrap(callee['object']);
    if (name === 'join' && isNode(object) && object.type === 'ArrayExpression') {
      const elements = parts(object['elements'] as unknown[]);
      const separator = args.length === 0 ? ',' : literalText(args[0]);
      return elements === undefined || separator === undefined ? undefined : elements.join(separator);
    }
    if (name === 'concat') {
      const base = literalText(object);
      const rest = parts(args);
      return base === undefined || rest === undefined ? undefined : base + rest.join('');
    }
  }
  return undefined;
}

/**
 * The literal runs of a string expression: the text of each maximal stretch of
 * a `+` chain or template literal that folds, with whatever does not fold
 * breaking the run (`'{{' + 'resolve:' + x` holds the run `{{resolve:`).
 */
function literalRuns(raw: unknown): string[] {
  const node = unwrap(raw);
  if (!isNode(node)) return [];
  const whole = literalText(node);
  if (whole !== undefined) return [whole];
  const pieces: Array<string | undefined> = [];
  if (node.type === 'TemplateLiteral') {
    const quasis = node['quasis'] as Node[];
    const exprs = node['expressions'] as unknown[];
    quasis.forEach((q, i) => {
      pieces.push((q['value'] as { cooked?: string }).cooked ?? '');
      if (i < exprs.length) pieces.push(literalText(exprs[i]));
    });
  } else if (node.type === 'BinaryExpression' && node['operator'] === '+') {
    for (const operand of plusOperands(node)) pieces.push(literalText(operand));
  } else {
    return [];
  }
  const runs: string[] = [];
  let run: string | undefined;
  for (const piece of pieces) {
    if (piece === undefined) {
      if (run !== undefined) runs.push(run);
      run = undefined;
    } else {
      run = (run ?? '') + piece;
    }
  }
  if (run !== undefined) runs.push(run);
  return runs;
}

/** A literal spelling a marker: a string, a fold of literals, or a template literal or `+` chain any run of which does. */
function spellsMarkerLiteral(node: unknown): boolean {
  return literalRuns(node).some((run) => MARKER_TEXT.test(run));
}

/**
 * A PIECE of a marker that only a marker test searches for: a run of two or
 * more `*` (`v.startsWith('**')` answers for the mask), or a prefix of the
 * reference opener at least two characters long (`'{{'`, `'{{resol'`). One
 * character (`'*'`, `'{'`) is no such piece: an IAM wildcard or a brace test
 * spells it too.
 */
function isMarkerFragment(raw: unknown): boolean {
  const text = literalText(raw);
  if (text === undefined || text.length < 2) return false;
  return /^\*{2,}$/.test(text) || '{{resolve:'.startsWith(text);
}

/** Every module-level name bound under `src/` to a marker literal (the helper's own private one aside). */
function markerNames(): Set<string> {
  const names = new Set(['SECRET_MASK']);
  for (const abs of tsFiles(join(ROOT, 'src'))) {
    const rel = relative(ROOT, abs).split('\\').join('/');
    if (rel === HELPER) continue;
    // No text prefilter: a folded constant (`'{{' + 'resolve:'`) spells no marker in its source.
    const text = readFileSync(abs, 'utf8');
    // MODULE-level bindings only (exported or not): a function's local of the
    // same name is no constant another module can import.
    for (const stmt of parseOrThrow(abs, text)['body'] as Node[]) {
      const decl = stmt.type === 'ExportNamedDeclaration' ? (stmt['declaration'] as Node | null) : stmt;
      if (decl?.type !== 'VariableDeclaration') continue;
      for (const d of decl['declarations'] as Node[]) {
        if (!isNode(d['id']) || d['id'].type !== 'Identifier') continue;
        const init = d['init'] as Node | null;
        const isConstant = (n: unknown): boolean => {
          const t = literalText(n);
          return t !== undefined && MARKER_CONSTANT.test(t);
        };
        // A marker constant, or a list of them (`MASKS.includes(v)`).
        if (
          isConstant(init) ||
          (init?.type === 'ArrayExpression' && (init['elements'] as unknown[]).some(isConstant))
        ) {
          names.add(d['id']['name'] as string);
        }
      }
    }
  }
  return names;
}

function patternNamesMarker(pattern: string, flags: string): boolean {
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags.replace(/[gy]/g, ''));
  } catch {
    return false;
  }
  return MARKER_SAMPLES.some(([marker, near]) => re.test(marker) && !re.test(near));
}

function memberName(callee: Node): string | undefined {
  if (callee.type !== 'MemberExpression') return undefined;
  const property = callee['property'] as Node;
  if (callee['computed'] === true) return literalText(property);
  return property.type === 'Identifier' ? (property['name'] as string) : undefined;
}

/** Strip value-position wrappers that change nothing: `(x)`, `x as T`, `x satisfies T`, `x!`. */
function unwrap(node: unknown): unknown {
  let n = node;
  while (
    isNode(n) &&
    ['ParenthesizedExpression', 'TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression'].includes(n.type)
  ) {
    n = n['expression'];
  }
  return n;
}

/** The file's own spellings of a marker name: a renamed import, or a destructuring alias. */
function aliasesIn(program: Node, names: ReadonlySet<string>): Set<string> {
  const local = new Set(names);
  const nameOf = (n: unknown): string | undefined =>
    isNode(n) ? ((n['name'] as string | undefined) ?? literalText(n)) : undefined;
  const visit = (node: Node): void => {
    if (node.type === 'ImportSpecifier') {
      const imported = nameOf(node['imported']);
      const as = nameOf(node['local']);
      if (imported !== undefined && as !== undefined && names.has(imported)) local.add(as);
    }
    if (node.type === 'ObjectPattern') {
      for (const prop of node['properties'] as Node[]) {
        if (prop.type !== 'Property') continue;
        const key = nameOf(prop['key']);
        const value = unwrap(prop['value']);
        const as = isNode(value) && value.type === 'AssignmentPattern' ? nameOf(value['left']) : nameOf(value);
        if (key !== undefined && as !== undefined && names.has(key)) local.add(as);
      }
    }
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) {
        for (const c of v) if (isNode(c)) visit(c);
      } else if (isNode(v)) {
        visit(v);
      }
    }
  };
  visit(program);
  return local;
}

function handTestsIn(file: string, text: string, globalNames: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const program = parseOrThrow(file, text);
  const names = aliasesIn(program, globalNames);
  // `carriesSecretMask` under any local name (a renamed import, a destructured alias).
  const maskWalkers = aliasesIn(program, new Set(['carriesSecretMask']));
  const isMarker = (raw: unknown): boolean => {
    const node = unwrap(raw);
    if (!isNode(node)) return false;
    if (node.type === 'Identifier') return names.has(node['name'] as string);
    // A namespace import's member (`sr.SECRET_MASK`).
    if (node.type === 'MemberExpression' && node['computed'] !== true && isNode(node['property'])) {
      if (names.has(node['property']['name'] as string)) return true;
    }
    // A template literal interpolating one (`${SECRET_MASK}`), or a `+` chain holding one.
    if (node.type === 'TemplateLiteral' && (node['expressions'] as unknown[]).some(isMarker)) return true;
    if (node.type === 'BinaryExpression' && node['operator'] === '+' && plusOperands(node).some(isMarker)) return true;
    return spellsMarkerLiteral(node);
  };
  const isMarkerOrFragment = (raw: unknown): boolean => isMarker(raw) || isMarkerFragment(raw);
  const holdsMarker = (raw: Node): boolean => {
    const node = unwrap(raw) as Node;
    if (node.type === 'Identifier') return names.has(node['name'] as string);
    if (node.type === 'ArrayExpression') return (node['elements'] as unknown[]).some(isMarkerOrFragment);
    if (node.type === 'NewExpression' && isNode(node['callee']) && node['callee']['name'] === 'Set') {
      const first = (node['arguments'] as Node[])[0];
      return first !== undefined && first.type === 'ArrayExpression' && holdsMarker(first);
    }
    return false;
  };
  const walk = (node: Node, fn: string): void => {
    let here = fn;
    if (node.type === 'FunctionDeclaration' && isNode(node['id'])) here = node['id']['name'] as string;
    // `const name = (...) => ...`: the binding names the function.
    if (
      node.type === 'VariableDeclarator' &&
      isNode(node['id']) &&
      isNode(node['init']) &&
      ['ArrowFunctionExpression', 'FunctionExpression'].includes((node['init'] as Node).type)
    ) {
      here = (node['id'] as Node)['name'] as string;
    }
    if (node.type === 'MethodDefinition' && isNode(node['key'])) here = (node['key'] as Node)['name'] as string;
    // An object literal's method or function-valued property.
    if (
      node.type === 'Property' &&
      isNode(node['key']) &&
      isNode(node['value']) &&
      ['ArrowFunctionExpression', 'FunctionExpression'].includes((node['value'] as Node).type)
    ) {
      here = ((node['key'] as Node)['name'] as string | undefined) ?? here;
    }
    const flag = (): void => {
      out.push(`${file}#${here}#${text.slice(node.start, node.end).replace(/\s+/g, ' ')}`);
    };
    if (node.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(node['operator'] as string)) {
      if (isMarkerOrFragment(node['left']) || isMarkerOrFragment(node['right'])) flag();
    }
    if (node.type === 'SwitchCase' && isMarkerOrFragment(node['test'])) flag();
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      const callee = node['callee'] as Node;
      const args = node['arguments'] as Node[];
      const name = memberName(callee);
      if (node.type === 'CallExpression' && name !== undefined && SEARCHES.has(name) && isMarkerOrFragment(args[0])) flag();
      else if (name !== undefined && COLLECTION_SEARCHES.has(name) && holdsMarker(callee['object'] as Node)) flag();
      else if (
        (callee.type === 'Identifier' && maskWalkers.has(callee['name'] as string)) ||
        name === 'carriesSecretMask'
      ) {
        flag();
      }
      else if (
        callee.type === 'MemberExpression' &&
        isNode(callee['object']) &&
        callee['object']['name'] === 'Object' &&
        name === 'is' &&
        args.some(isMarkerOrFragment)
      ) {
        flag();
      } else if (callee.type === 'Identifier' && callee['name'] === 'RegExp') {
        const first = args[0];
        const pattern = literalText(first);
        if ((first !== undefined && isMarker(first)) || (pattern !== undefined && patternNamesMarker(pattern, literalText(args[1]) ?? ''))) {
          flag();
        }
      }
    }
    if (node.type === 'Literal' && typeof node['regex'] === 'object' && node['regex'] !== null) {
      const { pattern, flags } = node['regex'] as { pattern: string; flags: string };
      if (patternNamesMarker(pattern, flags)) flag();
    }
    if (
      node.type === 'VariableDeclarator' &&
      (spellsMarkerLiteral(node['init']) ||
        (isNode(node['init']) &&
          (node['init'] as Node).type === 'ArrayExpression' &&
          ((node['init'] as Node)['elements'] as unknown[]).some(spellsMarkerLiteral)))
    ) {
      flag();
      // ...and every later use of it is a hand test too.
      if (isNode(node['id']) && node['id'].type === 'Identifier') names.add(node['id']['name'] as string);
    }
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) {
        for (const c of v) if (isNode(c)) walk(c, here);
      } else if (isNode(v)) {
        walk(v, here);
      }
    }
  };
  walk(program, '<module>');
  return out;
}

let cachedNames: Set<string> | undefined;
function violations(extra: Record<string, string> = {}): string[] {
  cachedNames ??= markerNames();
  const found: string[] = [];
  const files = new Set([...groupFiles(), ...Object.keys(extra)]);
  for (const file of files) {
    found.push(...handTestsIn(file, extra[file] ?? readFileSync(join(ROOT, file), 'utf8'), cachedNames));
  }
  const counts = new Map<string, number>();
  for (const key of found) counts.set(key, (counts.get(key) ?? 0) + 1);
  const problems: string[] = [];
  for (const [key, n] of counts) {
    const exempt = NOT_A_READER[key];
    if (exempt === undefined) problems.push(`hand test: ${key}`);
    else if (exempt.count !== n) problems.push(`${key}: ${n} sites, exempted ${exempt.count}`);
  }
  for (const key of Object.keys(NOT_A_READER)) {
    if (!counts.has(key)) problems.push(`exemption matches nothing: ${key}`);
  }
  return problems;
}

describe('readers ask recorded-secrecy, never test a marker by hand (go-to-k/cdkd#7061)', () => {
  it('no migrated group holds a hand test', () => {
    // A floor the scan does not read: a group that lost its files proves nothing.
    expect(groupFiles().length).toBeGreaterThanOrEqual(161);
    expect(violations()).toEqual([]);
  });

  it('the marker names include the constants other modules bind', () => {
    cachedNames ??= markerNames();
    expect([...cachedNames]).toEqual(expect.arrayContaining(['SECRET_MASK', 'DYNAMIC_REFERENCE_OPENING']));
  });

  const real = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
  const NAME = 'src/deployment/deploy-engine/replacement/name-change.ts';
  it.each([
    ['an equality with the constant', 'export const a = (v: unknown) => v === SECRET_MASK;'],
    ['an equality with the literal', "export const b = (v: unknown) => '***' !== v;"],
    ['an equality with a template literal', 'export const b2 = (v: unknown) => v === `***`;'],
    ['a substring search for the mask', 'export const c = (v: string) => v.includes(SECRET_MASK);'],
    ['a search for the reference opener', "export const d = (v: string) => v.startsWith('{{resolve:');"],
    ['a template-literal search', 'export const e = (v: string) => v.indexOf(`{{resolve:${"x"}`);'],
    ['a computed-key search', "export const e2 = (v: string) => v['includes']('{{resolve:');"],
    ['a replace of the mask', "export const e3 = (v: string) => v.replace('***', '');"],
    ['another module\'s opener constant', 'export const e4 = (v: string) => v.includes(DYNAMIC_REFERENCE_OPENING);'],
    ['a regular expression', 'export const f = (v: string) => /\\{\\{resolve:/.test(v);'],
    ['a quantified regular expression', 'export const f2 = (v: string) => /\\*{3}/.test(v);'],
    ['a class regular expression', 'export const f3 = (v: string) => /[{][{]resolve/.test(v);'],
    ['a RegExp of the opener', "export const f4 = (v: string) => new RegExp('\\\\{\\\\{resolve').test(v);"],
    ['a second mask constant', "const MASK = '***';\nexport const g = MASK;"],
    ['a second opener constant', "const OPEN = `{{resolve:`;\nexport const g2 = OPEN;"],
    ['Object.is', 'export const h = (v: unknown) => Object.is(v, SECRET_MASK);'],
    ['a switch case', "export function h2(v: unknown) { switch (v) { case '***': return 1; } return 0; }"],
    ['an array literal search', "export const h3 = (v: string) => ['***'].includes(v);"],
    ['a Set literal search', 'export const h4 = (v: string) => new Set([SECRET_MASK]).has(v);'],
    ['a direct carriesSecretMask call', 'export const h5 = (v: unknown) => carriesSecretMask(v);'],
    ['a renamed carriesSecretMask import', "import { carriesSecretMask as hasMask } from '../../secret-redaction/mask-only.js';\nexport const h6 = (v: unknown) => hasMask(v);"],
    ['a namespace carriesSecretMask call', "import * as mo from '../../secret-redaction/mask-only.js';\nexport const h7 = (v: unknown) => mo.carriesSecretMask(v);"],
    ['a localeCompare with the mask', 'export const h8 = (v: string) => v.localeCompare(SECRET_MASK) === 0;'],
    ['a renamed import of the mask', "import { SECRET_MASK as M } from '../../secret-redaction/pairs.js';\nexport const j = (v: unknown) => v === M;"],
    ['a destructured alias', "import * as pairs from '../../secret-redaction/pairs.js';\nconst { SECRET_MASK: M2 } = pairs;\nexport const j2 = (v: unknown) => v === M2;"],
    ['a namespace member', "import * as sr from '../../secret-redaction/pairs.js';\nexport const j3 = (v: unknown) => v === sr.SECRET_MASK;"],
    ['a parenthesized mask', 'export const j4 = (v: unknown) => v === (SECRET_MASK);'],
    ['a cast mask', "export const j5 = (v: unknown) => v === ('***' as string);"],
    ['an interpolated mask', 'export const j6 = (v: unknown) => v === `${SECRET_MASK}`;'],
    ['a list constant of markers', "const MASKS = ['***'];\nexport const j7 = (v: string) => MASKS.includes(v);"],
    ['a regex naming a reference service', 'export const j8 = (v: string) => /\\{\\{resolve:ssm:/.test(v);'],
    ['a regex naming a quoted mask', 'export const j9 = (v: string) => /"\\*\\*\\*"/.test(v);'],
    ['a concatenated opener', "export const k = (v: string) => v.includes('{{' + 'resolve:');"],
    ['a concatenated mask', "export const k2 = (v: unknown) => v === '*' + '**';"],
    ['a joined opener', "export const k3 = (v: string) => v.startsWith(['{{', 'resolve:'].join(''));"],
    ['a joined mask in a computed-key search', "export const k4 = (v: string) => v['inc' + 'ludes'](['**', '*'].join(''));"],
    ['a concat() opener', "export const k5 = (v: string) => v.indexOf('{{'.concat('resolve:')) >= 0;"],
    ['an opener concatenated before a variable', "export const k6 = (v: string, s: string) => v.startsWith('{{' + 'resolve:' + s);"],
    ['a template of folded parts', "export const k7 = (v: string) => v.includes(`{{${'resolve'}:`);"],
    ['a second opener constant built by concatenation', "const OPEN2 = '{{' + 'resolve:';\nexport const k8 = (v: string) => v.includes(OPEN2);"],
    ['a second mask constant built by join', "const MASK2 = ['*', '*', '*'].join('');\nexport const k9 = (v: unknown) => v === MASK2;"],
    ['a mask prefix search', "export const m = (v: string) => v.startsWith('**');"],
    ['a mask prefix equality', "export const m2 = (v: string) => v.slice(0, 2) === '**';"],
    ['an opener prefix search', "export const m3 = (v: string) => v.indexOf('{{') >= 0;"],
    ['a mask prefix in a list', "export const m4 = (v: string) => ['**'].includes(v.slice(0, 2));"],
  ])('probe: %s fails', (_what, line) => {
    const problems = violations({ [NAME]: `${real(NAME)}\n${line}\n` });
    expect(problems.length).toBeGreaterThanOrEqual(1);
    for (const p of problems) {
      expect(p).toMatch(/^hand test: src\/deployment\/deploy-engine\/replacement\/name-change\.ts#/);
    }
  });

  it('probe: a comment, an unrelated string or an unrelated pattern is no hand test', () => {
    const line =
      "// v === SECRET_MASK, v.includes('{{resolve:')\n" +
      "export const i = (v: string) => v.includes('arn:') && /./.test(v) && /\\*/.test(v);\n" +
      "export const i2 = (v: string, s: string) => v.startsWith('*') && v === ['a', 'b'].join('') && v.includes('arn:' + s) && v === '{' + s;";
    expect(violations({ [NAME]: `${real(NAME)}\n${line}\n` })).toEqual([]);
  });

  it('probe: a hand test in an object method is keyed by the method', () => {
    const line = 'export const o = { pick(v: unknown) { return v === SECRET_MASK; } };';
    expect(violations({ [NAME]: `${real(NAME)}\n${line}\n` })).toEqual([`hand test: ${NAME}#pick#v === SECRET_MASK`]);
  });

  it('probe: putting a migrated site back fails', () => {
    const text = real(NAME).replace(
      'if (desired === undefined) return undefined;',
      'if (desired === SECRET_MASK) return undefined;'
    );
    expect(text).not.toBe(real(NAME));
    expect(violations({ [NAME]: text })).toEqual([`hand test: ${NAME}#typeChangeNameQuestion#desired === SECRET_MASK`]);
  });

  // The helper keeps each hand test's meaning exactly.
  it.each<[string, unknown, boolean]>([
    ['the mask', '***', true],
    ['an embedded mask', 'a-***', false],
    ['a list holding it', ['***'], false],
  ])('isMaskLeaf(%s)', (_what, value, expected) => {
    expect(isMaskLeaf(value)).toBe(expected);
  });

  it.each<[string, unknown, boolean]>([
    ['undefined', undefined, false],
    ['null', null, false],
    ['an embedded mask', 'a-***', true],
    ['a string with a quote', 'a"***', true],
    ['a nested leaf', { a: ['x', '***'] }, true],
    ['a key named like it', { '***': 1 }, true],
    ['plain', { a: 'b' }, false],
  ])('mentionsMask(%s)', (_what, value, expected) => {
    expect(mentionsMask(value)).toBe(expected);
    // Both hand spellings it replaced: a string's own `includes`, and the JSON substring.
    expect(mentionsMask(value)).toBe((JSON.stringify(value) ?? '').includes('***'));
    if (typeof value === 'string') expect(mentionsMask(value)).toBe(value.includes('***'));
  });

  it.each<[unknown, boolean]>([
    ['x{{resolve:ssm:/p}}', true],
    [{ a: '{{resolve:secretsmanager:s}}' }, true],
    ['{{ resolve', false],
    [undefined, false],
  ])('valueMentionsDynamicReference(%j)', (value, expected) => {
    expect(valueMentionsDynamicReference(value)).toBe(expected);
    if (typeof value === 'string') expect(mentionsDynamicReference(value)).toBe(expected);
  });

  it.each(['', 'none', '{{resolve:ssm:/a}}', 'a{{resolve:secretsmanager:s}}b{{resolve:ssm:/c}}', '{{resolve:{{resolve:'])(
    'dynamicReferenceOpeners(%j) visits each opener, as the hand loop did',
    (text) => {
      const before: Array<{ at: number; rest: string }> = [];
      const OPEN = ['{{', 'resolve:'].join('');
      let at = text.indexOf(OPEN);
      while (at >= 0) {
        before.push({ at, rest: text.slice(at + OPEN.length) });
        at = text.indexOf(OPEN, at + OPEN.length);
      }
      expect(dynamicReferenceOpeners(text)).toEqual(before);
    }
  );

  it.each([
    '{{resolve:secretsmanager:s}}',
    '{{resolve:secretsmanager:arn:aws:secretsmanager:r:1:secret:s:SecretString:k::}}',
    '{{resolve:secretsmanager:}}',
    '{{resolve:ssm:/p}}',
    'x{{resolve:secretsmanager:s}}',
    '{{resolve:secretsmanager:s}}x',
    '{{resolve:secretsmanager:s',
  ])('dynamicReferenceBody(%j, secretsmanager) is the hand slice it replaced', (token) => {
    const prefix = ['{{', 'resolve:secretsmanager:'].join('');
    const before = !token.startsWith(prefix) || !token.endsWith('}}') ? undefined : token.slice(prefix.length, -2);
    expect(dynamicReferenceBody(token, 'secretsmanager')).toBe(before);
  });

  it.each(['', '*', '**', '***', '****', '***a', ' ***', '*+*'])('isMaskRun(%j)', (text) => {
    expect(isMaskRun(text)).toBe(/^\*{3,}$/.test(text));
  });

  it.each<[unknown, string | undefined]>([
    ['my-name', 'my-name'],
    ['', undefined],
    ['***', undefined],
    ['a-***', 'a-***'],
    ['{{resolve:secretsmanager:s}}', undefined],
    ['pre-{{resolve:ssm:/n}}', undefined],
    [undefined, undefined],
    [7, undefined],
  ])('usableRecordedName(%j)', (value, expected) => {
    expect(usableRecordedName(value)).toBe(expected);
    // The hand test it replaced, verbatim.
    const before =
      typeof value !== 'string' || value === '' || value === '***' || value.includes('{{resolve:')
        ? undefined
        : value;
    expect(usableRecordedName(value)).toBe(before);
  });
});
