/**
 * Codegen: the spec-replacement candidates (go-to-k/cdkd#7070) cdkd REPLACES.
 *
 * `scripts/spec-replacement-candidates.ts` derives every property the spec
 * calls a replacement while the registry schema leaves it mutable. Each has a
 * verdict in `REPLACEMENT_EVIDENCE` (`replace` / `update`), a line in the
 * unmeasured baseline, or a hand rule; `tests/unit/analyzer/replacement-evidence.test.ts`
 * fails on one with none. This script writes:
 *
 *  - `src/analyzer/replacement-rules/spec-replacement-properties.generated.ts`:
 *    the `replace` rows, which `getCreateOnlyPropertyPaths` unions with the
 *    schema's create-only paths. Nothing else reaches the deploy path.
 *  - `docs/_generated/spec-replacement-candidates.md`: every candidate with
 *    its verdict, the `maybe` rows included, for review.
 *
 * `--check` fails on a stale output. Offline: the spec is the pinned dev
 * dependency and the registry side a committed snapshot.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPLACEMENT_EVIDENCE } from '../src/analyzer/replacement-rules/evidence.ts';
import { UNMEASURED_SPEC_REPLACEMENT_CANDIDATES } from '../src/analyzer/replacement-rules/evidence-baseline.ts';
import {
  candidateKey,
  loadSpecReplacementCandidates,
  SKIP_REASONS,
  SPEC_TYPES_WITHOUT_REGISTRY_SCHEMA,
  type SpecReplacementCandidate,
} from './spec-replacement-candidates.ts';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), '..');
export const OUT_SRC = resolve(
  repoRoot,
  'src/analyzer/replacement-rules/spec-replacement-properties.generated.ts'
);
export const OUT_MD = resolve(repoRoot, 'docs/_generated/spec-replacement-candidates.md');

type Label = 'replace' | 'update' | 'baseline' | 'hand rule' | 'unclassified';

const RULES = resolve(repoRoot, 'src/analyzer/replacement-rules/rules.ts');
const PLANNERS = resolve(repoRoot, 'src/analyzer/diff-calculator/provider-replacement.ts');

/** The quoted PascalCase strings of `code`, comments stripped. */
function quotedNames(code: string): string[] {
  const bare = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  return [...bare.matchAll(/'([A-Z][A-Za-z0-9]*)'/g)].map((m) => m[1]!);
}

/** Split `source` at each match of `opener` (capturing the type) into type -> names. */
function namesByType(source: string, opener: RegExp): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const starts = [...source.matchAll(opener)];
  starts.forEach((m, i) => {
    const end = i + 1 < starts.length ? starts[i + 1]!.index : source.length;
    const names = out.get(m[1]!) ?? new Set<string>();
    for (const name of quotedNames(source.slice(m.index + m[0].length, end))) names.add(name);
    out.set(m[1]!, names);
  });
  return out;
}

/**
 * The properties a hand rule or a provider-replacement planner decides, read
 * from the source TEXT (this script cannot load modules with `.js` imports).
 * `replacement-evidence.test.ts` holds it equal to the loaded registry over
 * every candidate, so a parse that drifts fails there.
 */
export function handDecidedProperties(): ReadonlyMap<string, ReadonlySet<string>> {
  const rules = namesByType(readFileSync(RULES, 'utf8'), /this\.rules\.set\('(AWS::[A-Za-z0-9]+::[A-Za-z0-9]+)'/g);
  const planners = namesByType(readFileSync(PLANNERS, 'utf8'), /^\s*'(AWS::[A-Za-z0-9]+::[A-Za-z0-9]+)',\s*$/gm);
  for (const [type, names] of planners) {
    const merged = rules.get(type) ?? new Set<string>();
    for (const name of names) merged.add(name);
    rules.set(type, merged);
  }
  return rules;
}

let handDecided: ReadonlyMap<string, ReadonlySet<string>> | undefined;

export function labelOf(candidate: SpecReplacementCandidate): Label {
  handDecided ??= handDecidedProperties();
  // A hand rule wins at runtime, so its candidates stay out of the table even
  // where an evidence row agrees (they would only duplicate the rule).
  if (handDecided.get(candidate.type)?.has(candidate.path[0]!)) return 'hand rule';
  const key = candidateKey(candidate.type, candidate.path);
  const verdict = REPLACEMENT_EVIDENCE.get(key)?.verdict;
  if (verdict === 'replace' || verdict === 'update') return verdict;
  if (UNMEASURED_SPEC_REPLACEMENT_CANDIDATES.has(key)) return 'baseline';
  return 'unclassified';
}

/**
 * One table row, broken where `vp fmt` breaks it (go-to-k/cdkd#7083): the
 * row at print width 100, then its paths, and always one path per line when
 * every path has two or more segments (Prettier's matrix rule). Otherwise a
 * formatter run reds the `--check` audit.
 */
export function renderRow(type: string, paths: readonly (readonly string[])[]): string[] {
  const each = paths.map((p) => `[${p.map((s) => `'${s}'`).join(', ')}]`);
  const flat = `  ['${type}', [${each.join(', ')}]],`;
  const matrix = paths.length > 1 && paths.every((p) => p.length > 1);
  if (!matrix && flat.length <= 100) return [flat];
  if (!matrix && `    [${each.join(', ')}],`.length <= 100) {
    return ['  [', `    '${type}',`, `    [${each.join(', ')}],`, '  ],'];
  }
  // A path too long for its own line breaks one segment per line, as
  // `vp fmt` does (FSx `WindowsConfiguration.SelfManagedActiveDirectoryConfiguration.*`).
  const lines = paths.flatMap((p, i) =>
    `      ${each[i]},`.length <= 100
      ? [`      ${each[i]},`]
      : ['      [', ...p.map((s) => `        '${s}',`), '      ],']
  );
  return ['  [', `    '${type}',`, '    [', ...lines, '    ],', '  ],'];
}

/** The `replace` rows as a `src/` module (formatted as `vp fmt` leaves it). */
export function renderSrc(candidates: readonly SpecReplacementCandidate[]): string {
  const byType = new Map<string, string[][]>();
  for (const c of candidates) {
    // An element row cannot be compared per element: never a table row (the
    // problem list below reports it).
    if (labelOf(c) !== 'replace' || c.path.includes('*')) continue;
    byType.set(c.type, [...(byType.get(c.type) ?? []), [...c.path]]);
  }
  const lines = [
    '/**',
    ' * AUTO-GENERATED by scripts/gen-spec-replacement-properties.ts — DO NOT EDIT BY HAND.',
    ' * Regenerate: `vp run gen:spec-replacement-properties`.',
    ' *',
    ' * Properties CloudFormation replaces although the registry schema leaves them',
    ' * mutable (go-to-k/cdkd#7070): the spec-replacement candidates whose',
    ' * `REPLACEMENT_EVIDENCE` verdict is `replace`. `getCreateOnlyPropertyPaths`',
    " * unions them with the schema's create-only paths. A property a hand rule",
    ' * decides is never a row: some readers of those paths consult no hand rule.',
    ' */',
    '',
    'export const SPEC_REPLACEMENT_PATHS: ReadonlyMap<',
    '  string,',
    '  ReadonlyArray<readonly string[]>',
    '> = new Map<string, ReadonlyArray<readonly string[]>>([',
  ];
  for (const [type, paths] of byType) {
    lines.push(...renderRow(type, paths));
  }
  lines.push(']);', '');
  // go-to-k/cdkd#7100: the rows a CloudFormation execution measured, which
  // alone may say "CloudFormation was measured replacing" in a refusal.
  const measuredRows = candidates.filter(
    (c) =>
      labelOf(c) === 'replace' &&
      !c.path.includes('*') &&
      REPLACEMENT_EVIDENCE.get(candidateKey(c.type, c.path))?.kind === 'cfn-measured'
  );
  // go-to-k/cdkd#7126: a row whose measured replacement failed on the name it
  // keeps cannot say the data is lost under CloudFormation too.
  const keptName = (c: SpecReplacementCandidate): string | undefined =>
    REPLACEMENT_EVIDENCE.get(candidateKey(c.type, c.path))?.cfnKeepsName;
  const measured = measuredRows
    .filter((c) => keptName(c) === undefined)
    .map((c) => candidateKey(c.type, c.path))
    .sort();
  const keepsName = measuredRows
    .filter((c) => keptName(c) !== undefined)
    .map((c) => [candidateKey(c.type, c.path), keptName(c)!] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  lines.push(
    '/** `<Type>#<path>` of the rows above that a CloudFormation execution measured replacing (#7100). */',
    'export const SPEC_REPLACEMENT_CFN_MEASURED: ReadonlySet<string> = new Set([',
    ...measured.map((k) => `  '${k}',`),
    ']);',
    '',
    '/**',
    ' * `<Type>#<path>` -> the name property, for the measured rows whose CloudFormation',
    ' * replacement failed on that name, which it keeps (#7126).',
    ' */',
    'export const SPEC_REPLACEMENT_CFN_KEEPS_NAME: ReadonlyMap<string, string> = new Map([',
    ...keepsName.map(([k, n]) => `  ['${k}', '${n}'],`),
    ']);',
    ''
  );
  return lines.join('\n');
}

export function renderMarkdown(
  candidates: readonly SpecReplacementCandidate[],
  specVersion: string
): string {
  const count = (label: Label): number => candidates.filter((c) => labelOf(c) === label).length;
  const lines = [
    '---',
    'title: "Spec-replacement candidates"',
    'unlisted: true',
    '---',
    '',
    '<!-- AUTO-GENERATED by scripts/gen-spec-replacement-properties.ts — DO NOT EDIT. Regenerate: `vp run gen:spec-replacement-properties`. -->',
    '',
    '# Spec-replacement candidates',
    '',
    `Source: \`@aws-cdk/aws-service-spec\` ${specVersion}, against \`tests/fixtures/cfn-registry-create-only-paths.json\`.`,
    '',
    'Every property the spec calls a replacement (`causesReplacement: yes` or `maybe`) while the',
    "type's registry schema leaves it mutable (go-to-k/cdkd#7070). Only `replace` rows change",
    'what cdkd does; `update` and `baseline` rows keep the in-place update, and a `hand rule` row',
    'is decided by `src/analyzer/replacement-rules/rules.ts` or a provider-replacement planner.',
    'Evidence: `REPLACEMENT_EVIDENCE`.',
    '',
    `Candidates: ${candidates.length} (replace ${count('replace')}, update ${count('update')}, ` +
      `baseline ${count('baseline')}, hand rule ${count('hand rule')}).`,
    '',
    '| Candidate | Spec | Verdict |',
    '| --- | --- | --- |',
  ];
  for (const c of candidates) {
    lines.push(`| \`${candidateKey(c.type, c.path)}\` | ${c.spec} | ${labelOf(c)} |`);
  }
  lines.push(
    '',
    '## Spec types with no registry schema',
    '',
    'They yield no candidate (`SPEC_TYPES_WITHOUT_REGISTRY_SCHEMA`).',
    '',
    '| Type | Why |',
    '| --- | --- |'
  );
  for (const [type, kind] of SPEC_TYPES_WITHOUT_REGISTRY_SCHEMA) {
    lines.push(`| \`${type}\` | ${SKIP_REASONS[kind]} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function main(): void {
  const { candidates, specVersion, typesWithoutSchema } = loadSpecReplacementCandidates();
  const check = process.argv.includes('--check');
  const problems: string[] = [];
  const unclassified = candidates.filter((c) => labelOf(c) === 'unclassified');
  if (unclassified.length > 0) {
    problems.push(
      'candidates with no verdict — measure each and add a REPLACEMENT_EVIDENCE row, or add it to ' +
        'evidence-baseline.ts: ' +
        unclassified.map((c) => candidateKey(c.type, c.path)).join(', ')
    );
  }
  const elementReplace = candidates.filter((c) => labelOf(c) === 'replace' && c.path.includes('*'));
  if (elementReplace.length > 0) {
    problems.push(
      `a \`replace\` verdict on an array or map member cannot be compared per element: ` +
        elementReplace.map((c) => candidateKey(c.type, c.path)).join(', ')
    );
  }
  const src = renderSrc(candidates);
  const md = renderMarkdown(candidates, specVersion);
  if (check) {
    const stale =
      !existsSync(OUT_SRC) ||
      readFileSync(OUT_SRC, 'utf8') !== src ||
      !existsSync(OUT_MD) ||
      readFileSync(OUT_MD, 'utf8') !== md;
    if (stale) {
      problems.push(
        'src/analyzer/replacement-rules/spec-replacement-properties.generated.ts or ' +
          'docs/_generated/spec-replacement-candidates.md is stale — ' +
          'run `vp run gen:spec-replacement-properties` and commit.'
      );
    }
  } else {
    atomicWrite(OUT_SRC, src);
    atomicWrite(OUT_MD, md);
  }
  if (problems.length > 0) {
    // Write mode WARNS and exits 0, like the generators beside it in
    // `gen:all-matrices`: the schema-refresh job runs that chain, and its PR
    // must still open for the `--check` step and the evidence test to red.
    const verdict = check ? 'FAIL' : 'WARN';
    process.stderr.write(`spec-replacement-properties: ${verdict}\n  ${problems.join('\n  ')}\n`);
    if (check) process.exit(1);
    return;
  }
  process.stderr.write(
    `spec-replacement-properties: OK — ${candidates.length} candidates, ` +
      `${candidates.filter((c) => labelOf(c) === 'replace').length} replaced, ` +
      `${typesWithoutSchema.length} spec types without a registry schema skipped.\n`
  );
}

if (Boolean(process.argv[1]) && resolve(process.argv[1]!) === __filename) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`spec-replacement-properties: failed — ${(err as Error).message}\n`);
    process.exit(1);
  }
}
