/**
 * go-to-k/cdkd#7061: a reader of a recorded or desired value asks
 * `secret-redaction/recorded-secrecy.ts` whether it carries a redaction marker,
 * and never tests for the marker by hand.
 *
 * THE POPULATION. Every `.ts` file of each MIGRATED module group in
 * {@link GROUPS}, parsed with a real parser, so a comment is never read. A
 * MARKER is `SECRET_MASK`, any constant bound anywhere under `src/` to a string
 * spelling `***` or `{{resolve` (`DYNAMIC_REFERENCE_OPENING`, ...), or such a
 * string or template literal itself. A HAND TEST is:
 * - an equality (`===`, `!==`, `==`, `!=`), an `Object.is` or a `switch` case
 *   with a marker;
 * - a string search or edit (`includes`, `startsWith`, `endsWith`, `indexOf`,
 *   `lastIndexOf`, `search`, `match`, `matchAll`, `split`, `replace`,
 *   `replaceAll`), by name or computed key, whose first argument is a marker;
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
 * preflight here; then rollback and drift; export and import, delete, nested
 * child resolution and scrub; and the diff rendering with the cross-stack
 * preview. A file outside every group is outside the fence (the legacy-row
 * output mask joins the export group). Within a group, the fence finds hand
 * tests for a MARKER only: a reader that compares, sends or addresses a
 * recorded value with no secrecy test at all is not seen, and neither is a
 * marker reached through a value no constant names (a string built at run
 * time). The record-provenance entry point and the fence arm that routes
 * record readers onto it are later steps of the same plan.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseSync } from 'vite-plus';
import { describe, expect, it } from 'vite-plus/test';
import {
  dynamicReferenceOpeners,
  isMaskLeaf,
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
]);
const COLLECTION_SEARCHES = new Set(['includes', 'has', 'indexOf']);
const MARKER_TEXT = /\*\*\*|\{\{resolve/;
/** Each marker, and the same text with one character changed: a pattern matching the first but not the second names the marker. */
const MARKER_SAMPLES: ReadonlyArray<readonly [string, string]> = [
  ['***', '*+*'],
  ['{{resolve:', '{{resolvX:'],
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

/** The text of a string literal or an expression-free template literal, else undefined. */
function literalText(node: unknown): string | undefined {
  if (!isNode(node)) return undefined;
  if (node.type === 'Literal' && typeof node['value'] === 'string') return node['value'];
  if (node.type === 'TemplateLiteral' && (node['expressions'] as unknown[]).length === 0) {
    return ((node['quasis'] as Node[])[0]?.['value'] as { cooked?: string } | undefined)?.cooked;
  }
  return undefined;
}

/** A literal spelling a marker: a string, or a template literal any of whose parts does. */
function spellsMarkerLiteral(node: unknown): boolean {
  if (!isNode(node)) return false;
  const text = literalText(node);
  if (text !== undefined) return MARKER_TEXT.test(text);
  if (node.type === 'TemplateLiteral') {
    return (node['quasis'] as Node[]).some((q) => MARKER_TEXT.test((q['value'] as { cooked?: string }).cooked ?? ''));
  }
  return false;
}

/** Every module-level name bound under `src/` to a marker literal (the helper's own private one aside). */
function markerNames(): Set<string> {
  const names = new Set(['SECRET_MASK']);
  for (const abs of tsFiles(join(ROOT, 'src'))) {
    const rel = relative(ROOT, abs).split('\\').join('/');
    if (rel === HELPER) continue;
    const text = readFileSync(abs, 'utf8');
    if (!MARKER_TEXT.test(text)) continue;
    // MODULE-level bindings only (exported or not): a function's local of the
    // same name is no constant another module can import.
    for (const stmt of parseOrThrow(abs, text)['body'] as Node[]) {
      const decl = stmt.type === 'ExportNamedDeclaration' ? (stmt['declaration'] as Node | null) : stmt;
      if (decl?.type !== 'VariableDeclaration') continue;
      for (const d of decl['declarations'] as Node[]) {
        if (isNode(d['id']) && d['id'].type === 'Identifier' && spellsMarkerLiteral(d['init'])) {
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

function handTestsIn(file: string, text: string, names: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const isMarker = (node: unknown): boolean =>
    isNode(node) &&
    ((node.type === 'Identifier' && names.has(node['name'] as string)) || spellsMarkerLiteral(node));
  const holdsMarker = (node: Node): boolean => {
    if (node.type === 'ArrayExpression') return (node['elements'] as unknown[]).some(isMarker);
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
    const flag = (): void => {
      out.push(`${file}#${here}#${text.slice(node.start, node.end).replace(/\s+/g, ' ')}`);
    };
    if (node.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(node['operator'] as string)) {
      if (isMarker(node['left']) || isMarker(node['right'])) flag();
    }
    if (node.type === 'SwitchCase' && isMarker(node['test'])) flag();
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      const callee = node['callee'] as Node;
      const args = node['arguments'] as Node[];
      const name = memberName(callee);
      if (node.type === 'CallExpression' && name !== undefined && SEARCHES.has(name) && isMarker(args[0])) flag();
      else if (name !== undefined && COLLECTION_SEARCHES.has(name) && holdsMarker(callee['object'] as Node)) flag();
      else if (callee.type === 'Identifier' && callee['name'] === 'carriesSecretMask') flag();
      else if (
        callee.type === 'MemberExpression' &&
        isNode(callee['object']) &&
        callee['object']['name'] === 'Object' &&
        name === 'is' &&
        args.some(isMarker)
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
    if (node.type === 'VariableDeclarator' && spellsMarkerLiteral(node['init'])) flag();
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) {
        for (const c of v) if (isNode(c)) walk(c, here);
      } else if (isNode(v)) {
        walk(v, here);
      }
    }
  };
  walk(parseOrThrow(file, text), '<module>');
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
    expect(groupFiles().length).toBeGreaterThanOrEqual(63);
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
      "export const i = (v: string) => v.includes('arn:') && /./.test(v) && /\\*/.test(v);";
    expect(violations({ [NAME]: `${real(NAME)}\n${line}\n` })).toEqual([]);
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
