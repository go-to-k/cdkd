/**
 * go-to-k/cdkd#7061: a reader of a recorded or desired value asks
 * `secret-redaction/recorded-secrecy.ts` whether it carries a redaction marker,
 * and never tests for the marker by hand.
 *
 * THE POPULATION. Every `.ts` file of each MIGRATED module group in
 * {@link GROUPS}, parsed with a real parser (comments and the text of
 * cdkd-authored messages in a comment are never read). A HAND TEST is:
 * - an equality (`===`, `!==`, `==`, `!=`) with `SECRET_MASK` or a `'***'`
 *   literal on either side;
 * - a string search (`includes`, `startsWith`, `endsWith`, `indexOf`,
 *   `lastIndexOf`, `search`, `match`, `split`) whose first argument is
 *   `SECRET_MASK` or a string spelling `***` or `{{resolve`;
 * - a regular expression literal spelling `{{resolve` or `***`;
 * - a local binding of the `'***'` literal (a second mask constant).
 * Each one fails here, and so does an entry of {@link NOT_A_READER} that
 * nothing matches any more.
 *
 * BOUNDS. The groups grow one PR at a time (#7061's plan): update compare and
 * preflight first, then rollback and drift, export / delete / scrub, and the
 * diff rendering with the cross-stack preview. A file outside every group is
 * outside the fence. A hand test spelled through an alias of the mask (a
 * constant imported under another name) is outside it too.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseSync } from 'vite-plus';
import { describe, expect, it } from 'vite-plus/test';
import {
  isMaskLeaf,
  isUsableRecordedName,
  mentionsDynamicReference,
  mentionsMask,
  valueMentionsDynamicReference,
} from '../../../src/deployment/secret-redaction/recorded-secrecy.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');

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
    'src/deployment/deploy-engine/deploy-flow/plan-checks.ts',
    'src/deployment/replacement-name-holder',
    'src/deployment/type-change-guard.ts',
    'src/deployment/masked-property-fingerprints',
    'src/deployment/masked-baseline-recapture.ts',
  ],
};

/**
 * Hand tests that read no recorded or desired value, keyed
 * `<file>#<enclosing function>#<source text>`, each with the reason.
 */
const NOT_A_READER: Readonly<Record<string, string>> = {};

const SEARCHES = new Set(['includes', 'startsWith', 'endsWith', 'indexOf', 'lastIndexOf', 'search', 'match', 'split']);
const MARKER_TEXT = /\*\*\*|\{\{resolve/;
const MARKER_PATTERN = /\\?\{\\?\{resolve|\\\*\\\*\\\*|\*\*\*/;

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

/** Whether `node` is the mask: the `SECRET_MASK` constant or a `'***'` literal. */
function isMask(node: unknown): boolean {
  if (!isNode(node)) return false;
  if (node.type === 'Identifier') return node['name'] === 'SECRET_MASK';
  if (node.type === 'Literal') return node['value'] === '***';
  return false;
}

/** A string argument spelling a marker: `SECRET_MASK`, or a literal holding `***` / `{{resolve`. */
function spellsMarker(node: unknown): boolean {
  if (isMask(node)) return true;
  if (!isNode(node)) return false;
  if (node.type === 'Literal') return typeof node['value'] === 'string' && MARKER_TEXT.test(node['value']);
  if (node.type === 'TemplateLiteral') {
    return (node['quasis'] as Node[]).some((q) =>
      MARKER_TEXT.test((q['value'] as { cooked?: string }).cooked ?? '')
    );
  }
  return false;
}

function handTestsIn(file: string, text: string): string[] {
  const out: string[] = [];
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
    const at = (): string => `${file}#${here}#${text.slice(node.start, node.end).replace(/\s+/g, ' ')}`;
    if (node.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(node['operator'] as string)) {
      if (isMask(node['left']) || isMask(node['right'])) out.push(at());
    }
    if (node.type === 'CallExpression') {
      const callee = node['callee'] as Node;
      const args = node['arguments'] as Node[];
      if (
        callee.type === 'MemberExpression' &&
        isNode(callee['property']) &&
        SEARCHES.has(callee['property']['name'] as string) &&
        spellsMarker(args[0])
      ) {
        out.push(at());
      }
    }
    if (node.type === 'Literal' && isNode(node['regex'] as unknown) === false && node['regex'] !== undefined) {
      const pattern = (node['regex'] as { pattern: string }).pattern;
      if (MARKER_PATTERN.test(pattern)) out.push(at());
    }
    if (node.type === 'VariableDeclarator' && isNode(node['init']) && (node['init'] as Node).type === 'Literal') {
      if ((node['init'] as Node)['value'] === '***') out.push(at());
    }
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

function violations(extra: Record<string, string> = {}): string[] {
  const found: string[] = [];
  const files = new Set([...groupFiles(), ...Object.keys(extra)]);
  for (const file of files) {
    found.push(...handTestsIn(file, extra[file] ?? readFileSync(join(ROOT, file), 'utf8')));
  }
  const problems = found.filter((key) => NOT_A_READER[key] === undefined).map((k) => `hand test: ${k}`);
  for (const key of Object.keys(NOT_A_READER)) {
    if (!found.includes(key)) problems.push(`exemption matches nothing: ${key}`);
  }
  return problems;
}

describe('readers ask recorded-secrecy, never test a marker by hand (go-to-k/cdkd#7061)', () => {
  it('no migrated group holds a hand test', () => {
    // A floor the scan does not read: a group that lost its files proves nothing.
    expect(groupFiles().length).toBeGreaterThanOrEqual(56);
    expect(violations()).toEqual([]);
  });

  const real = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
  const NAME = 'src/deployment/deploy-engine/replacement/name-change.ts';
  it.each([
    ['an equality with the constant', 'export const a = (v: unknown) => v === SECRET_MASK;'],
    ['an equality with the literal', "export const b = (v: unknown) => '***' !== v;"],
    ['a substring search for the mask', 'export const c = (v: string) => v.includes(SECRET_MASK);'],
    ['a search for the reference opener', "export const d = (v: string) => v.startsWith('{{resolve:');"],
    ['a template-literal search', 'export const e = (v: string) => v.indexOf(`{{resolve:${"x"}`);'],
    ['a regular expression', 'export const f = (v: string) => /\\{\\{resolve:/.test(v);'],
    ['a second mask constant', "const MASK = '***';\nexport const g = MASK;"],
  ])('probe: %s fails', (_what, line) => {
    const problems = violations({ [NAME]: `${real(NAME)}\n${line}\n` });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^hand test: src\/deployment\/deploy-engine\/replacement\/name-change\.ts#/);
  });

  it('probe: a comment or an unrelated string is no hand test', () => {
    const line = "// v === SECRET_MASK, v.includes('{{resolve:')\nexport const h = (v: string) => v.includes('arn:');";
    expect(violations({ [NAME]: `${real(NAME)}\n${line}\n` })).toEqual([]);
  });

  it('probe: putting a migrated site back fails', () => {
    const text = real(NAME).replace('if (!isUsableRecordedName(desired)) return undefined;', "if (desired === SECRET_MASK) return undefined;");
    expect(text).not.toBe(real(NAME));
    expect(violations({ [NAME]: text })).toEqual([
      `hand test: ${NAME}#typeChangeNameQuestion#desired === SECRET_MASK`,
    ]);
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
    ['a nested leaf', { a: ['x', '***'] }, true],
    ['a key named like it', { '***': 1 }, true],
    ['plain', { a: 'b' }, false],
  ])('mentionsMask(%s)', (_what, value, expected) => {
    expect(mentionsMask(value)).toBe(expected);
    expect(mentionsMask(value)).toBe((JSON.stringify(value) ?? '').includes('***'));
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

  it.each<[unknown, boolean]>([
    ['my-name', true],
    ['', false],
    ['***', false],
    ['a-***', true],
    ['{{resolve:secretsmanager:s}}', false],
    ['pre-{{resolve:ssm:/n}}', false],
    [undefined, false],
    [7, false],
  ])('isUsableRecordedName(%j)', (value, expected) => {
    expect(isUsableRecordedName(value)).toBe(expected);
    // The hand test it replaced, verbatim.
    const before = !(
      typeof value !== 'string' || value === '' || value === '***' || value.includes('{{resolve:')
    );
    expect(isUsableRecordedName(value)).toBe(before);
  });
});
