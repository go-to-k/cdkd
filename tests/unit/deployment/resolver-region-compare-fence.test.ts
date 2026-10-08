import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import { parseSync } from 'vite-plus';
import { describe, it, expect } from 'vite-plus/test';
import { codeLines } from '../_code-lines.js';

import { CONTENDED_CASE_TIMEOUT_MS } from '../../contended-case-timeout.js';

/**
 * Issue #2209: no bare region comparison in the intrinsic resolver.
 *
 * `IntrinsicFunctionResolver.resolverRegion` is RAW by design (it keys
 * `getState` / `saveState`) while every value derived from it is folded, so a
 * `===` between two region values is wrong whenever the operands can arrive by
 * different paths. Issue #1882 hit it twice in a row: first
 * `region === this.resolverRegion`, then, after folding only one operand,
 * `region === canonicalizeRegion(this.resolverRegion)`. Every region equality
 * goes through `sameRegion` (`src/utils/aws-partition.ts`), which folds both.
 *
 * A comparison is refused when one operand is REGION-VALUED and the other is
 * anything but `undefined` / `null` / `''` (a presence test). Region-valued
 * means: a name ending in `region` (any case) — an identifier, a property, or
 * a string-literal key — a `canonicalizeRegion(...)` call, or a
 * `.toLowerCase()` / `.toLocaleLowerCase()` of a region-valued operand (#1882's
 * one-sided fold by another spelling), seen through parentheses, TS assertions
 * and the branches of `??` / `||` / `?:`. A name that merely CONTAINS it
 * (`producerRegions`, `explicitRegionLogText`) is not a region. So
 * `target === this.resolverRegion` is refused whatever `target` holds, while
 * two plain names neither ending in `region` (`target === other`) are out of
 * reach — a lint by NAME cannot see what a variable holds.
 *
 * Equalities spelled WITHOUT an equality operator are matched too, on the same
 * region-valued test: `Object.is(...)`, membership (`[a, region].includes(x)`,
 * `regions.indexOf(region)`), `localeCompare`, a `switch` on a region or with a
 * region `case`, and either side wrapped in `String(...)` or a bare
 * `` `${...}` `` template.
 *
 * Out of reach by design:
 * - a region used as a Map or cache KEY, which is not an equality at all.
 *   `cfn-fallback.ts`'s two memo keys are that class, and their own behaviour
 *   tests are what guard them;
 * - any other way to compare without an equality operator: a hand-rolled
 *   `.some(r => ...)` / `.find(...)` over a list, `startsWith` / `endsWith`, a
 *   `Set` / object lookup, `Array.prototype.includes.call(...)`, a template
 *   carrying more than the region, a comparison inside a helper of its own;
 * - two plain names neither ending in `region`, as above.
 *
 * A reader must not take the fence to cover those.
 *
 * A comparison that genuinely means "this exact string" carries
 * `// allow-raw-region-compare: <reason>` on the line above or the same line.
 * The marker exempts LINES, not one comparison: every comparison starting on
 * the marker's last line or the line after it.
 */

const MARKER = 'allow-raw-region-compare:';
const EQUALITY = new Set(['===', '!==', '==', '!=']);

type Node = { type: string; start: number; end: number; [key: string]: unknown };

const isNode = (v: unknown): v is Node =>
  typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string';

function unwrap(node: Node): Node {
  let n = node;
  while (
    n.type === 'ParenthesizedExpression' ||
    n.type === 'TSNonNullExpression' ||
    n.type === 'TSAsExpression' ||
    n.type === 'TSSatisfiesExpression' ||
    n.type === 'TSTypeAssertion' ||
    n.type === 'ChainExpression'
  ) {
    n = n['expression'] as Node;
  }
  return n;
}

function nameOf(node: Node): string | undefined {
  if (node.type === 'Identifier') return node['name'] as string;
  if (node.type === 'MemberExpression') {
    const property = node['property'] as Node;
    if (!node['computed'] && property.type === 'Identifier') return property['name'] as string;
    if (node['computed'] && property.type === 'Literal' && typeof property['value'] === 'string') {
      return property['value'];
    }
  }
  return undefined;
}

function isRegionValued(raw: Node): boolean {
  const node = unwrap(raw);
  if (node.type === 'CallExpression') {
    const callee = unwrap(node['callee'] as Node);
    const name = nameOf(callee);
    if (name === 'canonicalizeRegion') return true;
    // `String(region)`: a coercion keeps the spelling.
    if (callee.type === 'Identifier' && name === 'String') {
      const [arg] = node['arguments'] as Node[];
      return arg !== undefined && isRegionValued(arg);
    }
    return (
      (name === 'toLowerCase' || name === 'toLocaleLowerCase') &&
      callee.type === 'MemberExpression' &&
      isRegionValued(callee['object'] as Node)
    );
  }
  // `${region}`: a template holding nothing else is the region's own spelling.
  if (node.type === 'TemplateLiteral') {
    const expressions = node['expressions'] as Node[];
    const quasis = node['quasis'] as Array<{ value: { cooked?: string } }>;
    return (
      expressions.length === 1 &&
      quasis.every((q) => q.value.cooked === '') &&
      isRegionValued(expressions[0]!)
    );
  }
  if (node.type === 'LogicalExpression' && node['operator'] !== '&&') {
    return isRegionValued(node['left'] as Node) || isRegionValued(node['right'] as Node);
  }
  if (node.type === 'ConditionalExpression') {
    return isRegionValued(node['consequent'] as Node) || isRegionValued(node['alternate'] as Node);
  }
  const name = nameOf(node);
  return name !== undefined && /region$/i.test(name);
}

/** `undefined`, `null` or `''`: a presence test, not a region equality. */
function isAbsenceLiteral(raw: Node): boolean {
  const node = unwrap(raw);
  return (
    (node.type === 'Identifier' && node['name'] === 'undefined') ||
    (node.type === 'Literal' && (node['value'] === null || node['value'] === ''))
  );
}

/** An equality spelled as a call: `Object.is`, membership, `localeCompare`. */
function isRegionComparingCall(node: Node): boolean {
  const callee = unwrap(node['callee'] as Node);
  if (callee.type !== 'MemberExpression') return false;
  const object = unwrap(callee['object'] as Node);
  const args = node['arguments'] as Node[];
  const name = nameOf(callee);
  if (object.type === 'Identifier' && object['name'] === 'Object' && name === 'is') {
    return args.some((a) => isRegionValued(a));
  }
  // Membership: `regions.includes(region)` or `[a, region].includes(x)`. A
  // region's OWN `.includes('gov')` is a substring test, so not matched.
  if (name === 'includes' || name === 'indexOf') {
    return (
      args.some((a) => isRegionValued(a)) ||
      (object.type === 'ArrayExpression' &&
        (object['elements'] as Array<Node | null>).some((e) => e !== null && isRegionValued(e)))
    );
  }
  if (name === 'localeCompare') {
    return isRegionValued(object) || args.some((a) => isRegionValued(a));
  }
  return false;
}

/** `switch (region) { case x: }`, or a region as a `case` label. */
function isRegionSwitch(node: Node): boolean {
  const tests = (node['cases'] as Node[])
    .map((c) => c['test'] as Node | null)
    .filter((t): t is Node => t !== null);
  if (isRegionValued(node['discriminant'] as Node)) {
    return tests.some((t) => !isAbsenceLiteral(t));
  }
  return tests.some((t) => isRegionValued(t));
}

function isBareRegionComparison(node: Node): boolean {
  if (node.type === 'CallExpression') return isRegionComparingCall(node);
  if (node.type === 'SwitchStatement') return isRegionSwitch(node);
  if (node.type !== 'BinaryExpression' || !EQUALITY.has(node['operator'] as string)) return false;
  const left = node['left'] as Node;
  const right = node['right'] as Node;
  // One region operand marks the other side as a region whatever it is named:
  // the pre-fix tree held `target === canonicalizeRegion(this.explicitRegion)`.
  return (
    (isRegionValued(left) && !isAbsenceLiteral(right)) ||
    (isRegionValued(right) && !isAbsenceLiteral(left))
  );
}

/** Every bare region comparison in `text`, as `line: source`. */
function bareRegionComparisons(text: string, file = 'input.ts'): string[] {
  const parsed = parseSync(file, text);
  if (parsed.errors.length > 0) {
    throw new Error(`cannot parse ${file}: ${parsed.errors[0]!.message}`);
  }
  const lineAt = (offset: number): number => text.slice(0, offset).split('\n').length;
  const allowedLines = new Set<number>();
  for (const c of parsed.comments) {
    const body = text.slice(c.start, c.end);
    const at = body.indexOf(MARKER);
    // A block comment's own `*/`, and a JSDoc line's leading `*`, are not a reason.
    const reason = body
      .slice(at + MARKER.length)
      .replace(/\*\/$/, '')
      .replace(/^\s*\*+/gm, '')
      .trim();
    if (at >= 0 && reason !== '') {
      const last = lineAt(c.end);
      allowedLines.add(last);
      allowedLines.add(last + 1);
    }
  }
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const v of value) visit(v);
      return;
    }
    if (!isNode(value)) return;
    if (isBareRegionComparison(value)) {
      const line = lineAt(value.start);
      if (!allowedLines.has(line)) found.push(`${line}: ${text.slice(value.start, value.end)}`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'type' && key !== 'start' && key !== 'end') visit(child);
    }
  };
  visit(parsed.program);
  return found;
}

describe('the bare-region-comparison scanner (issue #2209)', () => {
  const flagged = (expr: string): boolean =>
    bareRegionComparisons(`const v = ${expr};`).length === 1;

  it('flags both shapes issue #1882 shipped', () => {
    // As the source spelled them: the guard before #2220 folded anything, and
    // the round that folded only the right operand.
    expect(
      bareRegionComparisons(
        'if (!roleArn && context.stackName && context.stackName === stackName && region === this.resolverRegion) {}'
      )
    ).toEqual(['1: region === this.resolverRegion']);
    expect(flagged('region === canonicalizeRegion(this.resolverRegion)')).toBe(true);
  });

  it.each([
    'region !== this.resolverRegion',
    'this.resolverRegion === region',
    'canonicalizeRegion(this.resolverRegion) !== region',
    'region == this.resolverRegion',
    'region != this.resolverRegion',
    '(region) === this.resolverRegion!',
    '(region as string) === this.resolverRegion',
    'e.sourceRegion === producerRegion',
    "args['Region'] === this.resolverRegion",
    "region === 'us-east-1'",
    "'us-east-1' === region",
    'region === `us-east-1`',
    '(refRegion ?? this.resolverRegion) === region',
    'canonicalizeRegion(region) === canonicalizeRegion(this.resolverRegion)',
    'this?.resolverRegion === region',
    'target === canonicalizeRegion(this.explicitRegion)',
    'canonicalizeRegion(ambient.configuredRegion) !== target',
    // One region-named side: `target` is folded, `resolverRegion` raw.
    'target === this.resolverRegion',
    'this.resolverRegion === target',
    // #1882's one-sided fold, spelled by hand.
    'region.toLowerCase() === target',
    'target !== this.resolverRegion.toLocaleLowerCase()',
    // A mask test, not a region equality: the real site carries the marker.
    'this.logTextOfLeaf(resolvedRegion, context) !== resolvedRegion',
    // Equalities spelled without an equality operator (go-to-k/cdkd#4716 review).
    '[this.resolverRegion].includes(region)',
    '[a, region].includes(target)',
    'regions.includes(this.resolverRegion)',
    'regions.indexOf(region) >= 0',
    'Object.is(region, this.resolverRegion)',
    'Object.is(target, region)',
    'region.localeCompare(this.resolverRegion) === 0',
    'target.localeCompare(region)',
    'String(region) === String(this.resolverRegion)',
    'String(region) === target',
    '`${region}` === `${this.resolverRegion}`',
    '`${region}` === target',
  ])('flags %s', (expr) => {
    expect(flagged(expr)).toBe(true);
  });

  it.each([
    'switch (region) { case this.resolverRegion: break; }',
    "switch (region) { case 'us-east-1': break; default: break; }",
    'switch (target) { case region: break; }',
  ])('flags %s', (statement) => {
    expect(bareRegionComparisons(statement)).toHaveLength(1);
  });

  it.each([
    'switch (region) { case undefined: break; default: break; }',
    "switch (kind) { case 'a': break; }",
  ])('does not flag %s', (statement) => {
    expect(bareRegionComparisons(statement)).toEqual([]);
  });

  it.each([
    'sameRegion(region, this.resolverRegion)',
    "resolvedRegion === ''",
    "typeof region === 'string'",
    'region === undefined',
    'region !== null',
    "regionVerdict.kind === 'ambiguous'",
    'cached.explicitRegionLogText !== guestRegionText',
    'context?.producerRegions === undefined',
    'name.toLowerCase() === other',
    'region.length === 0',
    'canonicalizeRegion(region) === undefined',
    "canonicalizeRegion(region) !== ''",
    // A region's OWN substring test is not an equality.
    "region.includes('-gov-')",
    'producerRegions.includes(x)',
    'Object.is(a, b)',
    'String(name) === other',
    '`${region}-suffix` === target',
    'names.localeCompare(other)',
  ])('does not flag %s', (expr) => {
    expect(flagged(expr)).toBe(false);
  });

  it('honours the marker on the line above or the same line, with a reason', () => {
    const above = `// ${MARKER} exact log-text twin\nconst a = region === this.resolverRegion;`;
    const same = `const a = region === this.resolverRegion; // ${MARKER} exact twin`;
    expect(bareRegionComparisons(above)).toEqual([]);
    expect(bareRegionComparisons(same)).toEqual([]);
  });

  it('does not honour a marker two lines above, or one without a reason', () => {
    const far = `// ${MARKER} exact twin\n\nconst a = region === this.resolverRegion;`;
    const bare = `// ${MARKER}\nconst a = region === this.resolverRegion;`;
    const bareBlock = `/* ${MARKER} */\nconst a = region === this.resolverRegion;`;
    const bareJsDoc = `/**\n * ${MARKER}\n *\n */\nconst a = region === this.resolverRegion;`;
    expect(bareRegionComparisons(far)).toHaveLength(1);
    expect(bareRegionComparisons(bare)).toHaveLength(1);
    expect(bareRegionComparisons(bareBlock)).toHaveLength(1);
    expect(bareRegionComparisons(bareJsDoc)).toHaveLength(1);
  });

  it('honours a block-comment marker that carries a reason', () => {
    const block = `/* ${MARKER} exact twin */\nconst a = region === this.resolverRegion;`;
    expect(bareRegionComparisons(block)).toEqual([]);
  });

  it('refuses a file it cannot parse rather than skipping it', () => {
    expect(() => bareRegionComparisons('const = ;', 'broken.ts')).toThrow(/cannot parse broken\.ts/);
  });
});

describe('the intrinsic resolver compares regions only through sameRegion (issue #2209)', () => {
  const SRC = path.resolve(__dirname, '../../../src');
  const RESOLVER_DIR = path.join('deployment', 'intrinsic-resolver');
  const family = [
    path.join('deployment', 'intrinsic-function-resolver.ts'),
    ...readdirSync(path.join(SRC, RESOLVER_DIR))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => path.join(RESOLVER_DIR, f)),
  ].map((rel) => ({ rel, text: readFileSync(path.join(SRC, rel), 'utf8') }));

  it('scans the family it claims to police (floor)', () => {
    // A literal the fence does not read: the family had 26 files when #2209
    // landed, so a shrunken scope fails here. Deliberately NO floor on
    // `sameRegion` calls or markers: one would make an exemption mandatory and
    // turn an unrelated removal into a false catch.
    expect(family.length).toBeGreaterThanOrEqual(26);
  });

  it('has no bare region comparison', () => {
    const offenders = family.flatMap(({ rel, text }) =>
      bareRegionComparisons(text, rel).map((hit) => `src/${rel}:${hit}`)
    );
    expect(
      offenders,
      'Compare regions with `sameRegion(a, b)` from src/utils/aws-partition.ts: ' +
        '`resolverRegion` is raw while every value derived from it is folded (issue #2209). ' +
        `A comparison that means "this exact string" carries \`// ${MARKER} <reason>\`.`
    ).toEqual([]);
  });

  it('covers every file that reads resolverRegion', () => {
    // The scope is the family because `resolverRegion` is the raw operand; a
    // reader outside it would be a comparison site this fence does not see.
    function walk(dir: string): string[] {
      const out: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.name.endsWith('.ts')) out.push(full);
      }
      return out;
    }
    const inFamily = new Set(family.map((f) => f.rel));
    const readers = walk(SRC)
      .map((f) => ({ rel: path.relative(SRC, f), text: readFileSync(f, 'utf8') }))
      .filter(({ text }) => text.includes('resolverRegion'))
      .filter(({ rel, text }) =>
        codeLines(text, rel).some((l) => /\bresolverRegion\b/.test(l.text))
      )
      .map(({ rel }) => rel);
    expect(readers.length).toBeGreaterThanOrEqual(2);
    expect(readers.filter((rel) => !inFamily.has(rel))).toEqual([]);
  }, CONTENDED_CASE_TIMEOUT_MS);
});
