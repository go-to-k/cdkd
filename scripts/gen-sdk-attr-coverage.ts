/**
 * Codegen + CI critic: SDK-provider ARN/URL attribute-coverage matrix.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * Output / cross-resource `Fn::GetAtt` resolution reads the cached
 * `resource.attributes[<CFnAttrName>]` in
 * `IntrinsicFunctionResolver.constructAttribute` — and `constructAttribute`
 * NEVER calls a provider's `getAttribute()`. So an SDK provider whose
 * `create()` / `update()` records a read-only value under a convenient alias
 * instead of its exact CFn `readOnlyProperties` name produces a silent wrong
 * value at deploy time. For a read-only attribute ending in `Arn` / `Url` the
 * resolver's shape guard (`guardedPhysicalIdFallback`) HARD-FAILS the deploy
 * (the physical id is not ARN/URL-shaped) — this is exactly the #1179 incident
 * (`AWS::BedrockAgentCore::Runtime` stored the ARN as `Arn`, not
 * `AgentRuntimeArn`, so a `CfnOutput` on the runtime ARN broke every deploy).
 *
 * The CC-API enrichment-coverage matrix (`gen-enrichment-coverage.ts`) does NOT
 * catch this: it only audits the Cloud Control provider's
 * `enrichResourceAttributes` switch, and classifies SDK-backed types as
 * `sdk-fallback-gap` (informational), giving false comfort that "the SDK
 * provider handles it" without verifying the SDK provider's create/update
 * attribute-key names.
 *
 * WHY ONLY `Arn` / `Url` SUFFIXES
 * -------------------------------
 * The resolver resolves a `Fn::GetAtt` through three layers, in order:
 *   1. cached `resource.attributes[<name>]` (written by the SDK provider's
 *      create/update),
 *   2. `constructAttribute`'s per-type handlers (build the value from the
 *      physical id + account + region, etc.),
 *   3. `guardedPhysicalIdFallback` — returns the physical id, EXCEPT it
 *      HARD-THROWS for a `*Arn` name whose fallback is not `arn:`-shaped or a
 *      `*Url` name whose fallback is not `http(s)://`-shaped.
 * So a read-only `*Arn` / `*Url` attribute that is NEITHER cached by the
 * provider NOR handled by `constructAttribute` is a guaranteed deploy break the
 * moment it is `Fn::GetAtt`'d. Non-ARN/URL read-only attributes degrade to a
 * warn-and-return of the physical id (a silent wrong value, not a crash) and,
 * critically, are legitimately left uncached by many providers (resolved live
 * via `getAttribute` for `cdkd orphan`, or never referenced) — flagging every
 * one would be almost all false positives. So this critic scopes to the
 * deploy-BREAKING `Arn` / `Url` class only; broader wrong-key detection stays a
 * manual-review concern.
 *
 * RESOLVABLE = CACHED-BY-PROVIDER **OR** COVERED-BY-constructAttribute
 * -------------------------------------------------------------------
 * A type is only a gap when BOTH miss. `constructAttribute` coverage is
 * detected leniently at the TYPE level: if the `constructAttribute` method body
 * mentions the type's `AWS::X::Y` literal at all, we assume it may build the
 * ARN there (a per-type handler). This is the false-positive-safe direction: a
 * type with a `constructAttribute` branch is never flagged even if the branch
 * happens not to cover that exact ARN (a residual false NEGATIVE we accept),
 * while a type COMPLETELY ABSENT from both the provider's cached keys and
 * `constructAttribute` — the #1179 shape — is flagged.
 *
 * OFFLINE-ONLY (NO AWS)
 * ---------------------
 * Reads:
 *   - tests/fixtures/cfn-schemas/*.json — per-type `readOnlyProperties` +
 *     `primaryIdentifier` (refreshed by `node scripts/refresh-cfn-schemas.mjs`).
 *   - src/provisioning/providers/*.ts — each SDK provider's `handledProperties`
 *     (which types it serves) + the attribute-object keys its create/update
 *     records, parsed via the TypeScript Compiler API.
 *   - src/deployment/intrinsic-function-resolver.ts — the set of types the
 *     `constructAttribute` method references.
 *
 * Writes: docs/_generated/sdk-attr-coverage.{json,md}.
 *
 * CLASSIFICATION (per SDK-backed type with a cached schema)
 * ---------------------------------------------------------
 *   - no-arn-attr    — the type has no `Arn`/`Url` read-only attribute (minus
 *                      primaryIdentifier) to worry about.
 *   - covered        — every `Arn`/`Url` read-only attribute is cached by the
 *                      provider OR the type is handled by `constructAttribute`
 *                      OR allow-listed.
 *   - gap            — an `Arn`/`Url` read-only attribute that is neither cached
 *                      nor constructAttribute-covered nor allow-listed. The
 *                      `--check` critic hard-fails on any of these.
 *
 * Usage:
 *   node --experimental-strip-types scripts/gen-sdk-attr-coverage.ts          # write the matrix
 *   node --experimental-strip-types scripts/gen-sdk-attr-coverage.ts --check  # fail on a latent gap
 *
 * CI runs the writer then `git diff --quiet` on the output AND the `--check`
 * critic, mirroring the gen-enrichment-coverage / gen-property-coverage guards.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// `typescript-v6` is an npm alias of typescript@6 — see the note in
// gen-property-coverage.ts (TS7 no longer ships the stable JS compiler API).
import ts from 'typescript-v6';
// Same-directory `.ts` import: Node 24 native type-stripping resolves imports
// literally when run via `node scripts/gen-sdk-attr-coverage.ts`.
import { parseProviderSource } from './gen-property-coverage.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const FIXTURE_DIR = resolve(repoRoot, 'tests/fixtures/cfn-schemas');
const PROVIDERS_DIR = resolve(repoRoot, 'src/provisioning/providers');
const RESOLVER_FILE = resolve(repoRoot, 'src/deployment/intrinsic-function-resolver.ts');
const OUT_JSON = resolve(repoRoot, 'docs/_generated/sdk-attr-coverage.json');
const OUT_MD = resolve(repoRoot, 'docs/_generated/sdk-attr-coverage.md');

/**
 * Allow-list of (type -> read-only `Arn`/`Url` attributes) that are NOT a gap
 * even though they are neither cached by the provider nor referenced in
 * `constructAttribute`. Each entry carries a one-line rationale.
 */
export interface AllowListEntry {
  readonly attributes: readonly string[];
  readonly rationale: string;
}

export const SDK_ATTR_ALLOW_LIST: ReadonlyMap<string, AllowListEntry> = new Map<
  string,
  AllowListEntry
>([
  [
    'AWS::SNS::Subscription',
    {
      // NOT-A-BUG: SNSSubscriptionProvider.create returns the subscription ARN
      // AS the physicalId, so `Fn::GetAtt [Subscription, Arn]` resolves through
      // guardedPhysicalIdFallback to that physicalId — which IS `arn:`-shaped,
      // so the guard passes and returns the correct ARN. No caching needed.
      attributes: ['Arn'],
      rationale: 'Arn == physicalId (create returns the subscription ARN as the physical id); guard fallback resolves it',
    },
  ],
  [
    'AWS::Lambda::EventSourceMapping',
    {
      // KNOWN GAP tracked in #1190: the provider caches only { Id } and the
      // physicalId is the ESM UUID (not ARN-shaped), so this hard-fails. The
      // fix (cache EventSourceMappingArn in create/update) ships separately with
      // its own real-AWS integ; remove this entry when #1190 lands.
      attributes: ['EventSourceMappingArn'],
      rationale: 'KNOWN GAP tracked in #1190 (cache EventSourceMappingArn in create/update); fix ships separately with an ESM integ',
    },
  ],
]);

interface SchemaFixture {
  resourceType: string;
  readOnlyProperties: string[];
  primaryIdentifier?: string[];
}

const sanitizeFixtureName = (type: string): string => type.replace(/::/g, '-');

/** Load every cached CFn schema fixture. Skips `_`-prefixed placeholders. */
export function loadAllFixtures(fixtureDir: string = FIXTURE_DIR): SchemaFixture[] {
  if (!existsSync(fixtureDir)) return [];
  const out: SchemaFixture[] = [];
  for (const file of readdirSync(fixtureDir)) {
    if (!file.endsWith('.json') || file.startsWith('_')) continue;
    const parsed = JSON.parse(readFileSync(join(fixtureDir, file), 'utf8')) as Partial<SchemaFixture>;
    if (typeof parsed.resourceType !== 'string') continue;
    out.push({
      resourceType: parsed.resourceType,
      readOnlyProperties: Array.isArray(parsed.readOnlyProperties) ? parsed.readOnlyProperties : [],
      primaryIdentifier: Array.isArray(parsed.primaryIdentifier) ? parsed.primaryIdentifier : undefined,
    });
  }
  return out.sort((a, b) => a.resourceType.localeCompare(b.resourceType));
}

/**
 * Collect the set of string keys an SDK provider records into a resource's
 * `attributes` map: every object-literal property name (incl. shorthand
 * `{ Arn }`) plus every element-access assignment key (`obj['Key'] = ...`) in
 * the file. Scoped to the whole file rather than just create/update because a
 * provider may build attributes via a `buildAttributes()` helper (issue #1179).
 * Over-collection is harmless: the classifier only intersects this set with a
 * type's `Arn`/`Url` read-only names, and camelCase SDK-input keys / property
 * names never collide with a PascalCase CFn `*Arn` name.
 *
 * A `case 'AgentRuntimeArn':` label in `getAttribute` is NOT collected (it is a
 * comparison expression, not an object key or an assignment LHS) — which is
 * exactly why a provider that handles the ARN in `getAttribute` but forgets it
 * in create/update is still flagged.
 *
 * KNOWN false-negative (accepted): a provider FILE that serves two types
 * sharing the SAME PascalCase ARN attribute name (e.g. `appsync-provider.ts`
 * serves both `AWS::AppSync::ApiKey.Arn` and `AWS::AppSync::GraphQLApi.Arn`)
 * pools keys at the file level, so caching the ARN for ONE type marks BOTH
 * `cached`. Dropping the ARN caching for one but not the other would stay green.
 * The #1179 deploy-BREAKING shape — a type totally absent from both the file's
 * cached keys AND `constructAttribute` — is still caught, which is the point;
 * per-type key scoping (parsing create/update's `switch (resourceType)` arms)
 * is a future tightening if the same-name-across-types case ever regresses.
 */
export function collectStoredAttributeKeys(source: string, fileName = 'provider.ts'): Set<string> {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const keys = new Set<string>();

  const stringKey = (node: ts.Node | undefined): string | null => {
    if (!node) return null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    return null;
  };

  const visit = (node: ts.Node): void => {
    // Object-literal keys: `{ AgentRuntimeArn: x }`, `{ 'Arn': x }`, `{ Arn }`.
    if (ts.isPropertyAssignment(node)) {
      if (ts.isIdentifier(node.name)) keys.add(node.name.text);
      else {
        const s = stringKey(node.name);
        if (s !== null) keys.add(s);
      }
    } else if (ts.isShorthandPropertyAssignment(node)) {
      keys.add(node.name.text);
    } else if (
      // Element-access assignment LHS: `attributes['AgentRuntimeVersion'] = x`.
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(node.left)
    ) {
      const s = stringKey(node.left.argumentExpression);
      if (s !== null) keys.add(s);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return keys;
}

/**
 * Collect the set of `AWS::X::Y` resource types referenced anywhere inside the
 * `constructAttribute` method of intrinsic-function-resolver.ts. A type with a
 * per-type handler there can build its own ARN, so it is not a gap even when
 * the provider does not cache it.
 */
export function collectConstructAttributeTypes(source: string, fileName = 'resolver.ts'): Set<string> {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const types = new Set<string>();

  let methodBody: ts.Node | undefined;
  const findMethod = (node: ts.Node): void => {
    if (
      ts.isMethodDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'constructAttribute'
    ) {
      methodBody = node.body;
    }
    if (!methodBody) ts.forEachChild(node, findMethod);
  };
  findMethod(sf);
  if (!methodBody) return types;

  const collect = (node: ts.Node): void => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      /^AWS::[A-Za-z0-9]+::[A-Za-z0-9]+$/.test(node.text)
    ) {
      types.add(node.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(methodBody);
  return types;
}

/** A read-only attribute whose absence would HARD-FAIL the resolver's guard. */
const isArnOrUrlAttr = (name: string): boolean => name.endsWith('Arn') || name.endsWith('Url');

export type Bucket = 'no-arn-attr' | 'covered' | 'gap';

export interface AttributeClassification {
  readonly name: string;
  readonly status: 'cached' | 'construct-attribute' | 'allow-listed' | 'gap';
  readonly rationale?: string;
}

export interface TypeClassification {
  readonly resourceType: string;
  readonly bucket: Bucket;
  readonly arnAttributes: readonly AttributeClassification[];
  readonly gaps: readonly string[];
}

/**
 * Classify one SDK-backed type's `Arn`/`Url` read-only attributes. Pure +
 * exported so unit tests can drive it with synthetic inputs.
 */
export function classifyType(
  resourceType: string,
  readOnlyProperties: readonly string[],
  primaryIdentifier: readonly string[],
  cachedKeys: ReadonlySet<string>,
  constructAttributeTypes: ReadonlySet<string>,
  allowList: ReadonlyMap<string, AllowListEntry> = SDK_ATTR_ALLOW_LIST
): TypeClassification {
  const primaryIds = new Set(primaryIdentifier);
  const allow = allowList.get(resourceType);
  const allowedAttrs = new Set(allow?.attributes ?? []);
  const constructCovered = constructAttributeTypes.has(resourceType);

  const arnProps = [...readOnlyProperties]
    .filter((p) => isArnOrUrlAttr(p) && !primaryIds.has(p))
    .sort((a, b) => a.localeCompare(b));

  const arnAttributes: AttributeClassification[] = [];
  const gaps: string[] = [];
  for (const prop of arnProps) {
    if (cachedKeys.has(prop)) {
      arnAttributes.push({ name: prop, status: 'cached' });
    } else if (constructCovered) {
      arnAttributes.push({ name: prop, status: 'construct-attribute' });
    } else if (allowedAttrs.has(prop)) {
      arnAttributes.push({ name: prop, status: 'allow-listed', rationale: allow?.rationale });
    } else {
      arnAttributes.push({ name: prop, status: 'gap' });
      gaps.push(prop);
    }
  }

  const bucket: Bucket =
    arnProps.length === 0 ? 'no-arn-attr' : gaps.length > 0 ? 'gap' : 'covered';

  return { resourceType, bucket, arnAttributes, gaps };
}

export interface SdkAttrCoverageReport {
  readonly schemaVersion: 1;
  readonly summary: {
    readonly classifiedCount: number;
    readonly covered: number;
    readonly noArnAttr: number;
    readonly gap: number;
  };
  readonly types: readonly TypeClassification[];
}

/**
 * Build the report. `sdkBackedTypes` are the types that have an SDK provider
 * (parsed from `handledProperties`); a type with a fixture but no SDK provider
 * is a pure-CC type and is out of scope here (the enrichment-coverage matrix
 * owns it). Pure (no fs writes) for unit testing.
 */
export function buildReport(
  fixtures: readonly SchemaFixture[],
  sdkBackedTypes: ReadonlySet<string>,
  cachedKeysByType: ReadonlyMap<string, ReadonlySet<string>>,
  constructAttributeTypes: ReadonlySet<string>,
  allowList: ReadonlyMap<string, AllowListEntry> = SDK_ATTR_ALLOW_LIST
): SdkAttrCoverageReport {
  const types = fixtures
    .filter((f) => sdkBackedTypes.has(f.resourceType))
    .map((f) =>
      classifyType(
        f.resourceType,
        f.readOnlyProperties,
        f.primaryIdentifier ?? [],
        cachedKeysByType.get(f.resourceType) ?? new Set<string>(),
        constructAttributeTypes,
        allowList
      )
    );

  return {
    schemaVersion: 1,
    summary: {
      classifiedCount: types.length,
      covered: types.filter((t) => t.bucket === 'covered').length,
      noArnAttr: types.filter((t) => t.bucket === 'no-arn-attr').length,
      gap: types.filter((t) => t.bucket === 'gap').length,
    },
    types,
  };
}

/** The `--check` gate: the types the critic hard-fails on. */
export function findGaps(report: SdkAttrCoverageReport): readonly TypeClassification[] {
  return report.types.filter((t) => t.bucket === 'gap');
}

function renderMarkdown(report: SdkAttrCoverageReport): string {
  const lines: string[] = [];
  lines.push('# SDK-provider ARN/URL attribute-coverage matrix');
  lines.push('');
  lines.push('<!-- AUTO-GENERATED by scripts/gen-sdk-attr-coverage.ts — DO NOT EDIT BY HAND. -->');
  lines.push('<!-- Regenerate: `vp run gen:sdk-attr-coverage`. -->');
  lines.push('');
  lines.push(
    'For every SDK-backed resource type (whose CFn schema is cached under ' +
      '`tests/fixtures/cfn-schemas/`), classifies each `Arn` / `Url` `readOnly` ' +
      "attribute by whether `Fn::GetAtt` can resolve it: `cached` (the SDK provider's " +
      'create/update records it under the CFn name), `construct-attribute` (the ' +
      "resolver's `constructAttribute` handles the type), or a `gap` (neither — the " +
      "resolver's shape guard HARD-FAILS the deploy, the #1179 class)."
  );
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- SDK-backed types classified: **${report.summary.classifiedCount}**`);
  lines.push(`- Covered (every Arn/Url readOnly resolvable): **${report.summary.covered}**`);
  lines.push(`- No Arn/Url readOnly attribute: **${report.summary.noArnAttr}**`);
  lines.push(`- **Latent gaps (blocks CI): ${report.summary.gap}**`);
  lines.push('');

  const gapTypes = report.types.filter((t) => t.bucket === 'gap');
  if (gapTypes.length > 0) {
    lines.push('## Latent gaps (UNRESOLVABLE Arn/Url readOnly) — BLOCKS CI');
    lines.push('');
    lines.push(
      'Cache the attribute under its exact CFn name in the provider create/update ' +
        '(via the returned `attributes` map), add a `constructAttribute` handler, OR ' +
        'add an `SDK_ATTR_ALLOW_LIST` entry with a rationale.'
    );
    lines.push('');
    lines.push('| Resource type | Unresolvable Arn/Url attributes |');
    lines.push('| --- | --- |');
    for (const t of gapTypes) {
      lines.push(`| \`${t.resourceType}\` | ${t.gaps.map((g) => `\`${g}\``).join(', ')} |`);
    }
    lines.push('');
  } else {
    lines.push('## Latent gaps');
    lines.push('');
    lines.push('None. Every `Arn`/`Url` read-only attribute on a cached SDK-backed type is cached or constructAttribute-resolvable.');
    lines.push('');
  }

  lines.push('## Full classification (types with an Arn/Url readOnly)');
  lines.push('');
  lines.push('| Resource type | Bucket | Arn/Url attributes (status) |');
  lines.push('| --- | --- | --- |');
  for (const t of report.types) {
    if (t.arnAttributes.length === 0) continue;
    const attrs = t.arnAttributes
      .map((a) => {
        const mark =
          a.status === 'cached'
            ? 'cached'
            : a.status === 'construct-attribute'
              ? 'ctor'
              : a.status === 'allow-listed'
                ? 'allow'
                : 'GAP';
        return `\`${a.name}\` (${mark})`;
      })
      .join(', ');
    lines.push(`| \`${t.resourceType}\` | ${t.bucket} | ${attrs} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

const isMainModule = (): boolean =>
  Boolean(process.argv[1]) && resolve(process.argv[1]!) === __filename;

function loadReport(): SdkAttrCoverageReport {
  const fixtures = loadAllFixtures();
  const sdkBackedTypes = new Set<string>();
  const cachedKeysByType = new Map<string, Set<string>>();

  for (const file of readdirSync(PROVIDERS_DIR)) {
    if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue;
    const src = readFileSync(join(PROVIDERS_DIR, file), 'utf8');
    const parsed = parseProviderSource(src, file);
    if (parsed.handled.size === 0) continue;
    const keys = collectStoredAttributeKeys(src, file);
    for (const type of parsed.handled.keys()) {
      sdkBackedTypes.add(type);
      const target = cachedKeysByType.get(type) ?? new Set<string>();
      for (const k of keys) target.add(k);
      cachedKeysByType.set(type, target);
    }
  }

  const constructAttributeTypes = collectConstructAttributeTypes(readFileSync(RESOLVER_FILE, 'utf8'));
  return buildReport(fixtures, sdkBackedTypes, cachedKeysByType, constructAttributeTypes);
}

function main(): void {
  const checkMode = process.argv.includes('--check');
  const report = loadReport();

  if (checkMode) {
    const gaps = findGaps(report);
    if (gaps.length > 0) {
      process.stderr.write(
        'sdk-attr-coverage: FAIL — SDK provider read-only Arn/Url attribute gap(s) detected.\n' +
          'Each attribute below is neither cached by the provider create/update (under its\n' +
          'exact CFn readOnlyProperties name) nor handled by constructAttribute, so\n' +
          'Fn::GetAtt would HARD-FAIL at deploy (the #1179 class). Record the attribute\n' +
          'under its CFn name in the provider (via the returned `attributes` map), add a\n' +
          'constructAttribute handler, OR add an SDK_ATTR_ALLOW_LIST entry with a\n' +
          'rationale in scripts/gen-sdk-attr-coverage.ts.\n\n'
      );
      for (const t of gaps) process.stderr.write(`  ${t.resourceType}: ${t.gaps.join(', ')}\n`);
      process.exit(1);
    }
    process.stderr.write(
      `sdk-attr-coverage: OK — ${report.summary.classifiedCount} SDK-backed types classified, ` +
        `0 gaps (${report.summary.covered} covered, ${report.summary.noArnAttr} no-arn-attr).\n`
    );
    return;
  }

  mkdirSync(dirname(OUT_JSON), { recursive: true });
  atomicWrite(OUT_JSON, JSON.stringify(report, null, 2) + '\n');
  atomicWrite(OUT_MD, renderMarkdown(report) + '\n');
  process.stderr.write(
    `sdk-attr-coverage: wrote sdk-attr-coverage.{json,md} — ${report.summary.classifiedCount} ` +
      `classified, ${report.summary.covered} covered, ${report.summary.noArnAttr} no-arn-attr, ` +
      `${report.summary.gap} gap(s).\n`
  );
}

if (isMainModule()) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`sdk-attr-coverage: failed — ${(err as Error).message}\n`);
    process.exit(1);
  }
}
