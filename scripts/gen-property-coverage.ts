/**
 * Codegen: ship per-Tier-1-type property coverage into the runtime.
 *
 * Reads:
 *   - tests/fixtures/cfn-schemas/*.json — per-type CFn schema (refreshed by
 *     `node scripts/refresh-cfn-schemas.mjs`; carries `properties` +
 *     `readOnlyProperties` for each Tier 1 type).
 *   - src/provisioning/providers/*.ts — parses each SDK provider's
 *     `handledProperties = new Map<...>([...])` and (optional)
 *     `unhandledByDesign = new Map<...>([...])` declarations via the
 *     TypeScript Compiler API. Bootstrap-free (no dist/, no src/ runtime
 *     load) so the codegen can run on a fresh checkout without prior
 *     build.
 *
 * Writes: src/provisioning/property-coverage.generated.ts
 *
 * The pre-flight check (`ProviderRegistry.validateResourceProperties`)
 * consults the generated module to reject deploys whose templates use
 * top-level properties cdkd would silently drop on write. v0 stance:
 * silent drop is a bug; the user must explicitly opt in via
 * `--allow-unsupported-properties <Type:Prop>,...` to accept the drop.
 *
 * Tier 2 (CC API) types are NOT in the output — CC forwards the full
 * property map to AWS, so there is no write-side silent drop at cdkd.
 *
 * Why a generated TS module and not a runtime JSON read: package.json
 * `files` ships only `dist/`, so tests/fixtures/*.json is not in the
 * npm package. A generated .ts under src/ compiles into dist/ and is
 * importable at runtime.
 *
 * Usage:
 *   node --experimental-strip-types scripts/gen-property-coverage.ts
 *
 * CI runs this task then `git diff --quiet` on the output (see ci.yml),
 * so a stale module (provider declaration or fixture changed but module
 * not regenerated) fails the build — mirroring gen-unsupported-types.
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// `typescript-v6` is an npm alias of typescript@6: TypeScript 7's package no
// longer ships the stable JS compiler API (createSourceFile / forEachChild
// live only under `typescript/unstable/*`), so syntactic parsing stays on the
// v6 library while the toolchain `tsc` is v7.
import ts from 'typescript-v6';
// NOTE: same-directory import uses `.ts` (not `.js`) — Node 24 native type
// stripping resolves imports literally when the script runs directly via
// `node scripts/gen-property-coverage.ts`; see the matching note in
// audit-provider-coverage.ts.
import { parseRegisteredTypes } from './audit-provider-coverage.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const FIXTURE_DIR = resolve(repoRoot, 'tests/fixtures/cfn-schemas');
const PROVIDERS_DIR = resolve(repoRoot, 'src/provisioning/providers');
const REGISTER_PROVIDERS_FILE = resolve(repoRoot, 'src/provisioning/register-providers.ts');
const OUT_FILE = resolve(
  repoRoot,
  'src/provisioning/property-coverage.generated.ts'
);

interface SchemaFixture {
  resourceType: string;
  generatedAt: string;
  properties: string[];
  readOnlyProperties: string[];
  createOnlyProperties?: string[];
}

const sanitizeFixtureName = (type: string) => type.replace(/::/g, '-');

function loadFixture(resourceType: string): SchemaFixture | null {
  const path = join(FIXTURE_DIR, `${sanitizeFixtureName(resourceType)}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as SchemaFixture;
}

/**
 * Parse one provider .ts file and extract its `handledProperties` and
 * `unhandledByDesign` Map literal declarations.
 *
 * Both declarations live on the provider class as instance fields:
 *
 *   handledProperties = new Map<string, ReadonlySet<string>>([
 *     ['AWS::Lambda::Function', new Set(['FunctionName', ...])],
 *     ...
 *   ]);
 *
 *   unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
 *     ['AWS::ApiGatewayV2::Api', new Map([
 *       ['Body', 'OpenAPI/Swagger inline spec; ...'],
 *       ...
 *     ])],
 *   ]);
 */
export interface ParsedProvider {
  handled: Map<string, Set<string>>;
  byDesign: Map<string, Map<string, string>>;
}

function parseProvider(filePath: string): ParsedProvider {
  return parseProviderSource(readFileSync(filePath, 'utf8'), filePath);
}

/**
 * Source-string variant of {@link parseProvider}. Exported for unit tests so
 * they can feed synthetic provider declarations without touching disk.
 */
export function parseProviderSource(sourceText: string, filePath = 'provider.ts'): ParsedProvider {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ true,
    ts.ScriptKind.TS
  );

  const handled = new Map<string, Set<string>>();
  const byDesign = new Map<string, Map<string, string>>();

  function visit(node: ts.Node): void {
    if (
      ts.isPropertyDeclaration(node) &&
      ts.isIdentifier(node.name)
    ) {
      const name = node.name.text;
      if (name === 'handledProperties' && node.initializer) {
        extractTypeToSetMap(node.initializer, handled);
      } else if (name === 'unhandledByDesign' && node.initializer) {
        extractTypeToRationaleMap(node.initializer, byDesign);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return { handled, byDesign };
}

/**
 * Extract `new Map<...>([['TYPE', new Set([STR, ...])], ...])` shape.
 */
function extractTypeToSetMap(
  expr: ts.Expression,
  out: Map<string, Set<string>>
): void {
  // Walk down through `new Map<...>([ ... ])` to the outer ArrayLiteral.
  const arr = unwrapMapConstructor(expr);
  if (!arr) return;
  for (const entry of arr.elements) {
    if (!ts.isArrayLiteralExpression(entry)) continue;
    if (entry.elements.length !== 2) continue;
    const typeNode = entry.elements[0];
    const setNode = entry.elements[1];
    const typeStr = stringLiteralValue(typeNode);
    if (!typeStr) continue;
    const innerElements = setConstructorElements(setNode);
    if (!innerElements) continue;
    const props = new Set<string>();
    for (const el of innerElements) {
      const s = stringLiteralValue(el);
      if (s !== null) props.add(s);
    }
    out.set(typeStr, props);
  }
}

/**
 * Extract `new Map<...>([['TYPE', new Map([['PROP', 'RATIONALE'], ...])], ...])` shape.
 */
function extractTypeToRationaleMap(
  expr: ts.Expression,
  out: Map<string, Map<string, string>>
): void {
  const arr = unwrapMapConstructor(expr);
  if (!arr) return;
  for (const entry of arr.elements) {
    if (!ts.isArrayLiteralExpression(entry)) continue;
    if (entry.elements.length !== 2) continue;
    const typeNode = entry.elements[0];
    const mapNode = entry.elements[1];
    const typeStr = stringLiteralValue(typeNode);
    if (!typeStr) continue;
    const innerArr = unwrapMapConstructor(mapNode);
    if (!innerArr) continue;
    const props = new Map<string, string>();
    for (const el of innerArr.elements) {
      if (!ts.isArrayLiteralExpression(el)) continue;
      if (el.elements.length !== 2) continue;
      const p = stringLiteralValue(el.elements[0]);
      const r = stringLiteralValue(el.elements[1]);
      if (p && r) props.set(p, r);
    }
    out.set(typeStr, props);
  }
}

function unwrapMapConstructor(
  expr: ts.Expression
): ts.ArrayLiteralExpression | null {
  if (!ts.isNewExpression(expr)) return null;
  if (!ts.isIdentifier(expr.expression)) return null;
  if (expr.expression.text !== 'Map') return null;
  const arg = expr.arguments?.[0];
  if (!arg || !ts.isArrayLiteralExpression(arg)) return null;
  return arg;
}

/**
 * Return the element expressions of a `new Set([...])` constructor call.
 *
 * An argless `new Set()` / `new Set<string>()` is a legitimate empty
 * declaration and returns `[]` — before issue #1034 it returned `null`,
 * which silently dropped a zero-property provider (e.g. the
 * WaitConditionHandle no-op provider) from the generated map. `null` is
 * reserved for expressions that are not a parseable Set constructor at
 * all (not a `new Set`, or a non-literal argument like a spread from a
 * variable) — those still skip the entry, and the registry cross-check
 * in {@link findMissingCoverageTypes} turns the skip into a hard error.
 */
function setConstructorElements(expr: ts.Expression): readonly ts.Expression[] | null {
  if (!ts.isNewExpression(expr)) return null;
  if (!ts.isIdentifier(expr.expression)) return null;
  if (expr.expression.text !== 'Set') return null;
  const arg = expr.arguments?.[0];
  if (arg === undefined) return [];
  if (!ts.isArrayLiteralExpression(arg)) return null;
  return arg.elements;
}

function stringLiteralValue(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

const renderHandled = (handled: string[]): string => {
  if (handled.length === 0) return 'new Set<string>()';
  return `new Set<string>([\n${handled
    .map((p) => `        '${p}',`)
    .join('\n')}\n      ])`;
};

const renderSilentDrop = (
  drops: Array<[string, string]>
): string => {
  if (drops.length === 0) return 'new Map<string, string>()';
  return `new Map<string, string>([\n${drops
    .map(([p, r]) => `        ['${p}', ${JSON.stringify(r)}],`)
    .join('\n')}\n      ])`;
};

/**
 * Registry-vs-output cross-check (issue #1034): every type registered in
 * `register-providers.ts` that HAS a CFn schema fixture on disk MUST end up
 * in the generated coverage map. A miss means the provider's
 * `handledProperties` declaration is absent or unparseable by this script
 * (the seen-live case: an argless `new Set<string>()` before
 * {@link setConstructorElements} learned to accept it) — previously a silent
 * one-type shrink of the output, now a hard error. Types without a fixture
 * are exempt (they cannot be judged here; other test guards cover them).
 *
 * Pure and exported for unit tests; the caller resolves the three sets.
 */
export function findMissingCoverageTypes(
  registeredTypes: ReadonlySet<string>,
  hasFixture: (resourceType: string) => boolean,
  outputTypes: ReadonlySet<string>
): string[] {
  return [...registeredTypes]
    .filter((t) => hasFixture(t) && !outputTypes.has(t))
    .sort((a, b) => a.localeCompare(b));
}

// Only types with both a fixture AND a handledProperties declaration land
// in the output. (A registered Tier 1 type without a fixture cannot be
// judged here; a fixture without a handled declaration would be a
// declaration bug — surface as an empty entry so the pre-flight rejects
// every prop as silent drop, matching the test layer's expectations.)
const NOT_IMPLEMENTED_RATIONALE = 'not yet implemented by cdkd';

interface PerTypeCoverage {
  handled: string[];
  silentDrop: Array<[prop: string, rationale: string]>;
}

function main(): void {
  // Walk every provider .ts file, merging their declarations into one combined map.
  const providerFiles = readdirSync(PROVIDERS_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .map((f) => join(PROVIDERS_DIR, f));

  const combinedHandled = new Map<string, Set<string>>();
  const combinedByDesign = new Map<string, Map<string, string>>();

  for (const path of providerFiles) {
    const parsed = parseProvider(path);
    for (const [type, props] of parsed.handled) {
      if (!combinedHandled.has(type)) combinedHandled.set(type, new Set());
      const target = combinedHandled.get(type)!;
      for (const p of props) target.add(p);
    }
    for (const [type, props] of parsed.byDesign) {
      if (!combinedByDesign.has(type)) combinedByDesign.set(type, new Map());
      const target = combinedByDesign.get(type)!;
      for (const [p, r] of props) target.set(p, r);
    }
  }

  const coverageByType = new Map<string, PerTypeCoverage>();
  let totalHandled = 0;
  let totalDrops = 0;

  const allTypes = new Set<string>(combinedHandled.keys());
  for (const type of allTypes) {
    const fixture = loadFixture(type);
    if (!fixture) continue; // No CFn schema fixture — skip (covered by other test guards).

    const handled = combinedHandled.get(type) ?? new Set<string>();
    const byDesign = combinedByDesign.get(type) ?? new Map<string, string>();
    const readOnly = new Set(fixture.readOnlyProperties);

    const silentDrop: Array<[string, string]> = [];
    for (const prop of [...fixture.properties].sort((a, b) => a.localeCompare(b))) {
      if (handled.has(prop)) continue;
      if (readOnly.has(prop)) continue;
      const rationale = byDesign.get(prop) ?? NOT_IMPLEMENTED_RATIONALE;
      silentDrop.push([prop, rationale]);
    }

    coverageByType.set(type, {
      handled: [...handled].sort((a, b) => a.localeCompare(b)),
      silentDrop,
    });
    totalHandled += handled.size;
    totalDrops += silentDrop.length;
  }

  // Fail loudly (before writing) when a registered type with a fixture is
  // missing from the output — see findMissingCoverageTypes.
  const registered = parseRegisteredTypes(readFileSync(REGISTER_PROVIDERS_FILE, 'utf8'));
  const missing = findMissingCoverageTypes(
    registered,
    (t) => loadFixture(t) !== null,
    new Set(coverageByType.keys())
  );
  if (missing.length > 0) {
    console.error(
      `[gen-property-coverage] ${missing.length} registered type(s) with a CFn schema ` +
        `fixture have no parsed handledProperties declaration — the provider's ` +
        `declaration is missing or in a shape this script cannot parse ` +
        `(expected \`new Map<...>([['AWS::X::Y', new Set([...])], ...])\`; ` +
        `an empty set may be argless \`new Set()\` or \`new Set([])\`):`
    );
    for (const t of missing) console.error(`  - ${t}`);
    process.exit(1);
  }

  const sortedEntries = [...coverageByType.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  );

  const body = sortedEntries
  .map(
    ([type, cov]) =>
      `  [
    '${type}',
    {
      handled: ${renderHandled(cov.handled)},
      silentDrop: ${renderSilentDrop(cov.silentDrop)},
    },
  ],`
  )
  .join('\n');

const content = `/**
 * AUTO-GENERATED by scripts/gen-property-coverage.ts — DO NOT EDIT BY HAND.
 * Source: tests/fixtures/cfn-schemas/*.json + each provider's
 * \`handledProperties\` / \`unhandledByDesign\` declarations (parsed via
 * the TypeScript Compiler API).
 * Regenerate: \`vp run gen:property-coverage\`.
 *
 * Per-Tier-1-type property coverage for the deploy-time pre-flight check
 * (\`ProviderRegistry.validateResourceProperties\`). The \`silentDrop\` set
 * lists top-level CFn schema properties whose SDK provider does not write
 * them to AWS — using these in a template silently drops the field at
 * deploy time. The pre-flight rejects them by default; the user can opt
 * in via \`--allow-unsupported-properties <Type:Prop>,...\` to accept the
 * drop and proceed.
 *
 * Tier 2 (Cloud Control) types are NOT in this map: CC forwards the full
 * property map to AWS, so there is no write-side silent drop at cdkd.
 */

export interface PropertyCoverage {
  /** Top-level CFn properties the SDK provider's create/update writes to AWS. */
  readonly handled: ReadonlySet<string>;
  /**
   * Top-level CFn properties cdkd would silently drop on write. Each entry
   * carries a one-line rationale (either the provider's \`unhandledByDesign\`
   * rationale or the default \`not yet implemented by cdkd\`).
   */
  readonly silentDrop: ReadonlyMap<string, string>;
}

export const PROPERTY_COVERAGE_BY_TYPE: ReadonlyMap<string, PropertyCoverage> = new Map<
  string,
  PropertyCoverage
>([
${body}
]);
`;

  // Atomic write: Ctrl-C between open and close would otherwise leave the
  // generated module truncated and break the next build's module load.
  const tmp = `${OUT_FILE}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, OUT_FILE);
  console.log(
    `Wrote property coverage for ${coverageByType.size} Tier 1 types ` +
      `(${totalHandled} handled, ${totalDrops} silent-drop) to ${OUT_FILE}.`
  );
}

const isMainModule = (): boolean => {
  if (!process.argv[1]) return false;
  return resolve(process.argv[1]) === __filename;
};

if (isMainModule()) {
  main();
}
