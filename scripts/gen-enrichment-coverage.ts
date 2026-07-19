/**
 * Codegen + CI critic: CC-API enrichment-coverage completeness matrix.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * `CloudControlProvider.enrichResourceAttributes` (a hand-maintained switch in
 * `src/provisioning/cloud-control-provider.ts`) overlays computed `Fn::GetAtt`
 * attributes onto the flat-key attribute shape cdkd's intrinsic resolver
 * expects, for resources that route through the Cloud Control API. A CC-routed
 * type with a computed `readOnly` attribute that is NOT enriched silently falls
 * through the resolver's `constructAttribute` to the physicalId — the bug class
 * fixed in #844 / #864 / #865 / #866. Nothing prevented that gap from regrowing
 * when a new CC-routed type (or a new readOnly attribute on an existing type)
 * landed. This generator classifies every CC-routable type whose CFn schema is
 * cached, and a `--check` mode fails CI when a type lands in the latent-gap
 * bucket without an explicit allow-list entry + rationale.
 *
 * WHICH TYPES ARE "CC-ROUTABLE"
 * -----------------------------
 * Two ways a type reaches the CC-API path (and thus `enrichResourceAttributes`):
 *   1. It has NO SDK provider — every operation routes through Cloud Control
 *      (pure Tier 2, e.g. `AWS::ElastiCache::ReplicationGroup`).
 *   2. It HAS an SDK provider but its template sets a silent-drop top-level
 *      property — the #614 routing rule then sends the ENTIRE resource through
 *      Cloud Control, bypassing the SDK provider's `create()` and the typed
 *      attribute writes it would have done (e.g. `AWS::RDS::DBInstance`,
 *      `AWS::S3::Bucket`). For these the SDK-provider attributes never get set,
 *      so enrichment is the ONLY thing that populates the computed `Fn::GetAtt`
 *      attributes on the CC path.
 *
 * So enrichment is relevant to any type with a computed readOnly attribute that
 * CAN route through CC-API — which is every type with a cached CFn schema (the
 * fixtures are refreshed for every registered SDK-provider type, and those are
 * exactly the #614-routable Tier 1 types; the cached set is the offline-
 * classifiable universe).
 *
 * OFFLINE-ONLY (NO AWS)
 * ---------------------
 * Reads:
 *   - tests/fixtures/cfn-schemas/*.json  — per-type `readOnlyProperties` (the
 *     GetAtt-able computed attributes), refreshed by
 *     `node scripts/refresh-cfn-schemas.mjs`.
 *   - src/provisioning/cloud-control-provider.ts — the `enrichResourceAttributes`
 *     switch, parsed via the TypeScript Compiler API (like
 *     scripts/gen-property-coverage.ts) to extract, per `case` label, the set of
 *     attribute keys the case assigns (`enriched['Attr'] = ...`).
 *
 * Writes: docs/_generated/enrichment-coverage.{json,md}.
 *
 * CLASSIFICATION (per CC-routable type with a cached schema)
 * ----------------------------------------------------------
 * For each `readOnly` property:
 *   - enriched           — the switch case for the type assigns that attribute
 *                          (matched against the flat-key prefix too: a case that
 *                          writes `Endpoint.Address` enriches the `Endpoint`
 *                          readOnly prop).
 *   - allow-listed       — explicitly carved out with a rationale in
 *                          ENRICHMENT_ALLOW_LIST (the prop is the primary
 *                          identifier == physicalId, or otherwise not-a-bug).
 *   - gap                — a computed readOnly attribute that is neither
 *                          enriched nor allow-listed.
 *
 * SEVERITY OF A GAP DEPENDS ON THE TIER
 * -------------------------------------
 * The cached fixtures cover only types that have an SDK provider (the refresh
 * script fetches the registered Tier 1 set). For those, the SDK provider's
 * `create()` populates the typed attributes on the PRIMARY path; enrichment is
 * only the #614 silent-drop FALLBACK. So a gap on an SDK-backed type is
 * `sdk-fallback-gap` (informational — only the rare CC-fallback path is
 * exposed, and only when the template trips silent-drop routing). A gap on a
 * type with NO SDK provider (pure Tier 2) is `unenriched-computed` — the REAL
 * bug class (#844 / #864 / #865 / #866), because the CC-API path is the ONLY
 * path and the computed attribute would always fall through to the physicalId.
 * The `--check` critic hard-fails ONLY on `unenriched-computed` (pure-CC) gaps;
 * `sdk-fallback-gap` types are reported in the matrix but do not block CI.
 *
 * Because no pure-CC type has a cached schema yet, the critic currently passes
 * with 0 hard gaps — by design. It becomes load-bearing the moment a pure-CC
 * type's schema is cached (e.g. ElastiCache::ReplicationGroup, Redshift::
 * Cluster, OpenSearchService::Domain — the very types the recent enrichment
 * PRs added cases for): a NEW pure-CC readOnly attribute then fails the build
 * unless it is enriched or allow-listed.
 *
 * A type whose every readOnly prop is enriched / allow-listed is `enriched`;
 * a type with no readOnly props at all is `no-computed-attr`.
 *
 * Usage:
 *   node --experimental-strip-types scripts/gen-enrichment-coverage.ts          # write the matrix
 *   node --experimental-strip-types scripts/gen-enrichment-coverage.ts --check  # fail on a latent gap
 *
 * CI runs the writer then `git diff --quiet` on the output AND the `--check`
 * critic (see ci.yml) — a stale matrix OR a new un-allow-listed gap fails the
 * build, mirroring the gen-property-coverage / gen-unsupported-types guards.
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const FIXTURE_DIR = resolve(repoRoot, 'tests/fixtures/cfn-schemas');
const CC_PROVIDER_FILE = resolve(repoRoot, 'src/provisioning/cloud-control-provider.ts');
const OUT_JSON = resolve(repoRoot, 'docs/_generated/enrichment-coverage.json');
const OUT_MD = resolve(repoRoot, 'docs/_generated/enrichment-coverage.md');
const PROVIDER_COVERAGE_JSON = resolve(repoRoot, 'docs/_generated/provider-coverage.json');

/**
 * Load the set of types that have an SDK provider (Tier 1) from the cached
 * provider-coverage audit. A type in this set populates its attributes on the
 * primary SDK path, so a missing enrichment is only the #614 CC-fallback gap.
 */
export function loadSdkBackedTypes(
  coverageJsonPath: string = PROVIDER_COVERAGE_JSON
): Set<string> {
  if (!existsSync(coverageJsonPath)) return new Set<string>();
  const parsed = JSON.parse(readFileSync(coverageJsonPath, 'utf8')) as { tier1?: string[] };
  return new Set(parsed.tier1 ?? []);
}

/**
 * Seed allow-list of CC-routable types / attributes that are NOT a gap even
 * though they appear in `readOnlyProperties` without a matching enrichment
 * case. Each entry carries a one-line rationale (mirrors the
 * `unhandledByDesign` carve-out pattern). The `--check` critic treats a
 * readOnly prop as allow-listed when its name is listed for the type here.
 *
 * The canonical not-a-bug shape is "the readOnly attribute IS the resource's
 * primary identifier, which equals the CC-API physicalId and resolves
 * correctly through the resolver's constructAttribute fallback" — for those
 * the physicalId fallback is the RIGHT answer, so no enrichment is needed.
 */
export interface AllowListEntry {
  /** readOnly attribute names that are not-a-gap for this type. */
  readonly attributes: readonly string[];
  /** One-line rationale, surfaced in the generated matrix. */
  readonly rationale: string;
}

export const ENRICHMENT_ALLOW_LIST: ReadonlyMap<string, AllowListEntry> = new Map<
  string,
  AllowListEntry
>([
  [
    'AWS::MSK::Cluster',
    {
      // The audit's original "MSK BootstrapBrokers" gap prediction was a
      // mis-read: BootstrapBrokers is not even a GetAtt, and the cluster Arn
      // IS the primaryIdentifier == physicalId, so the constructAttribute
      // fallback resolves it correctly. See 00-INDEX.md "MSK = NOT-A-BUG".
      attributes: ['Arn'],
      rationale: 'Arn is the primaryIdentifier == physicalId; resolves via constructAttribute',
    },
  ],
  [
    'AWS::Elasticsearch::Domain',
    {
      // Tier-3 NON_PROVISIONABLE: cdkd rejects it at pre-flight, so it never
      // reaches enrichResourceAttributes. (The modern type is
      // AWS::OpenSearchService::Domain, which IS enriched.)
      attributes: ['Arn', 'DomainArn', 'DomainEndpoint', 'Id'],
      rationale: 'Tier-3 non-provisionable; rejected at pre-flight, never reaches CC enrichment',
    },
  ],
]);

interface SchemaFixture {
  resourceType: string;
  generatedAt: string;
  properties: string[];
  readOnlyProperties: string[];
  createOnlyProperties?: string[];
  /**
   * Primary-identifier property names (added to the fixture shape by the
   * extended scripts/refresh-cfn-schemas.mjs). A readOnly attribute that IS the
   * primaryIdentifier == physicalId is auto-classified not-a-gap (the resolver's
   * physicalId fallback resolves it). Absent on fixtures generated before the
   * refresh-script extension — those fall back to the hand-written allow-list.
   */
  primaryIdentifier?: string[];
}

const sanitizeFixtureName = (type: string): string => type.replace(/::/g, '-');

/**
 * Load every cached CFn schema fixture (one per CC-routable type). Skips the
 * `_todo-backfill.json` placeholder and any file without a `resourceType`.
 */
export function loadAllFixtures(fixtureDir: string = FIXTURE_DIR): SchemaFixture[] {
  if (!existsSync(fixtureDir)) return [];
  const out: SchemaFixture[] = [];
  for (const file of readdirSync(fixtureDir)) {
    if (!file.endsWith('.json')) continue;
    if (file.startsWith('_')) continue; // _todo-backfill.json etc.
    const parsed = JSON.parse(readFileSync(join(fixtureDir, file), 'utf8')) as Partial<SchemaFixture>;
    if (typeof parsed.resourceType !== 'string') continue;
    out.push({
      resourceType: parsed.resourceType,
      generatedAt: parsed.generatedAt ?? '',
      properties: Array.isArray(parsed.properties) ? parsed.properties : [],
      readOnlyProperties: Array.isArray(parsed.readOnlyProperties)
        ? parsed.readOnlyProperties
        : [],
      createOnlyProperties: Array.isArray(parsed.createOnlyProperties)
        ? parsed.createOnlyProperties
        : undefined,
      primaryIdentifier: Array.isArray(parsed.primaryIdentifier)
        ? parsed.primaryIdentifier
        : undefined,
    });
  }
  return out.sort((a, b) => a.resourceType.localeCompare(b.resourceType));
}

/**
 * Parse the `enrichResourceAttributes` switch in cloud-control-provider.ts and
 * return, per `case '<Type>':` label, the set of attribute keys the case body
 * assigns via `enriched['<Attr>'] = ...`. The TS Compiler API walk is robust to
 * the assorted case-body shapes (plain assignment, inside try/catch, inside if).
 *
 * A `case` whose body contains NO `enriched[...]` assignment (only `break`)
 * yields an empty set — surfaced so the matrix shows the case exists but
 * enriches nothing (a likely bug, treated as no-enrichment).
 */
export function parseEnrichmentSwitch(
  source: string,
  fileName = 'cloud-control-provider.ts'
): Map<string, Set<string>> {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ true,
    ts.ScriptKind.TS
  );

  const byType = new Map<string, Set<string>>();

  // Find the enrichResourceAttributes method, then its switch statement.
  let enrichBody: ts.Node | undefined;
  const findMethod = (node: ts.Node): void => {
    if (
      ts.isMethodDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'enrichResourceAttributes'
    ) {
      enrichBody = node.body;
    }
    if (!enrichBody) ts.forEachChild(node, findMethod);
  };
  findMethod(sf);
  if (!enrichBody) return byType;

  // Locate the switch inside the method body.
  let switchStmt: ts.SwitchStatement | undefined;
  const findSwitch = (node: ts.Node): void => {
    if (ts.isSwitchStatement(node) && !switchStmt) switchStmt = node;
    if (!switchStmt) ts.forEachChild(node, findSwitch);
  };
  findSwitch(enrichBody);
  if (!switchStmt) return byType;

  // Collect every `enriched['Attr'] = ...` assignment key inside a node.
  const collectAssignedKeys = (node: ts.Node, out: Set<string>): void => {
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'enriched'
    ) {
      const arg = node.argumentExpression;
      if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
        out.add(arg.text);
      }
    }
    ts.forEachChild(node, (c) => collectAssignedKeys(c, out));
  };

  // Fall-through cases (`case 'A': case 'B': <body>`) share one body — the
  // earlier clause has no statements. Accumulate labels until a clause with a
  // body is reached, then assign that body's keys to every accumulated label.
  let pendingLabels: string[] = [];
  for (const clause of switchStmt.caseBlock.clauses) {
    if (ts.isDefaultClause(clause)) {
      pendingLabels = [];
      continue;
    }
    const label = clause.expression;
    const labelText =
      ts.isStringLiteral(label) || ts.isNoSubstitutionTemplateLiteral(label)
        ? label.text
        : undefined;
    if (labelText) pendingLabels.push(labelText);
    if (clause.statements.length === 0) continue; // fall-through to next clause

    const keys = new Set<string>();
    for (const stmt of clause.statements) collectAssignedKeys(stmt, keys);
    for (const t of pendingLabels) {
      const existing = byType.get(t) ?? new Set<string>();
      for (const k of keys) existing.add(k);
      byType.set(t, existing);
    }
    pendingLabels = [];
  }

  return byType;
}

export type Bucket =
  | 'enriched'
  | 'no-computed-attr'
  /** Gap on a pure-CC type (no SDK provider) — the real bug class; `--check` fails. */
  | 'unenriched-computed'
  /** Gap on an SDK-backed type — informational; only the #614 CC-fallback path is exposed. */
  | 'sdk-fallback-gap';

export interface AttributeClassification {
  readonly name: string;
  /** enriched | allow-listed | gap */
  readonly status: 'enriched' | 'allow-listed' | 'gap';
  /** allow-list rationale (only for allow-listed). */
  readonly rationale?: string;
}

export interface TypeClassification {
  readonly resourceType: string;
  readonly bucket: Bucket;
  /** True when cdkd has an SDK provider for this type (a #614-fallback type). */
  readonly sdkBacked: boolean;
  /** All readOnly (computed, GetAtt-able) attribute names from the CFn schema. */
  readonly readOnlyProperties: readonly string[];
  /** The attribute keys the enrichment switch case assigns (flat-keys included). */
  readonly enrichedKeys: readonly string[];
  readonly attributes: readonly AttributeClassification[];
  /** Subset of readOnlyProperties classified as a latent gap. */
  readonly gaps: readonly string[];
}

/**
 * Classify one type's readOnly props against its enrichment-case keys + the
 * allow-list. The matching rule for "enriched": the readOnly prop name is
 * assigned directly, OR a flat-key whose dotted prefix equals the prop is
 * assigned (so a case writing `Endpoint.Address` enriches the `Endpoint`
 * readOnly prop, which the resolver walks via nested-path resolution).
 */
const PRIMARY_IDENTIFIER_RATIONALE =
  'primaryIdentifier == physicalId; resolves via the resolver physicalId fallback';

export function classifyType(
  resourceType: string,
  readOnlyProperties: readonly string[],
  enrichedKeys: ReadonlySet<string>,
  sdkBacked: boolean,
  primaryIdentifier: readonly string[] = [],
  allowList: ReadonlyMap<string, AllowListEntry> = ENRICHMENT_ALLOW_LIST
): TypeClassification {
  const allow = allowList.get(resourceType);
  const allowedAttrs = new Set(allow?.attributes ?? []);
  const primaryIds = new Set(primaryIdentifier);

  // Top-level prefixes of every enriched flat-key (e.g. 'Endpoint' from
  // 'Endpoint.Address') PLUS the full key, so both exact and nested matches hit.
  const enrichedTopLevel = new Set<string>();
  for (const key of enrichedKeys) {
    enrichedTopLevel.add(key);
    const dot = key.indexOf('.');
    if (dot > 0) enrichedTopLevel.add(key.slice(0, dot));
  }

  const attributes: AttributeClassification[] = [];
  const gaps: string[] = [];
  for (const prop of [...readOnlyProperties].sort((a, b) => a.localeCompare(b))) {
    if (enrichedTopLevel.has(prop)) {
      attributes.push({ name: prop, status: 'enriched' });
    } else if (primaryIds.has(prop)) {
      // The resolver resolves a GetAtt against the primaryIdentifier via the
      // physicalId fallback, so this is not-a-gap with no hand-written entry.
      attributes.push({
        name: prop,
        status: 'allow-listed',
        rationale: PRIMARY_IDENTIFIER_RATIONALE,
      });
    } else if (allowedAttrs.has(prop)) {
      attributes.push({ name: prop, status: 'allow-listed', rationale: allow?.rationale });
    } else {
      attributes.push({ name: prop, status: 'gap' });
      gaps.push(prop);
    }
  }

  let bucket: Bucket;
  if (readOnlyProperties.length === 0) {
    bucket = 'no-computed-attr';
  } else if (gaps.length > 0) {
    // A gap on an SDK-backed type is only exposed on the #614 CC-fallback path
    // (the SDK provider populates the attr on the primary path); a gap on a
    // pure-CC type is the real bug class the critic blocks on.
    bucket = sdkBacked ? 'sdk-fallback-gap' : 'unenriched-computed';
  } else {
    bucket = 'enriched';
  }

  return {
    resourceType,
    bucket,
    sdkBacked,
    readOnlyProperties: [...readOnlyProperties].sort((a, b) => a.localeCompare(b)),
    enrichedKeys: [...enrichedKeys].sort((a, b) => a.localeCompare(b)),
    attributes,
    gaps: gaps.sort((a, b) => a.localeCompare(b)),
  };
}

export interface EnrichmentCoverageReport {
  readonly schemaVersion: 1;
  readonly summary: {
    readonly classifiedCount: number;
    readonly enriched: number;
    readonly noComputedAttr: number;
    /** Pure-CC latent gaps — the real bug class; `--check` fails on any. */
    readonly unenrichedGap: number;
    /** SDK-backed types with a gap only on the #614 CC-fallback path (informational). */
    readonly sdkFallbackGap: number;
    readonly allowListedTypes: number;
  };
  readonly types: readonly TypeClassification[];
  /** Types that route through the enrichment switch but have no cached schema. */
  readonly enrichedWithoutCachedSchema: readonly string[];
}

/**
 * Build the full report from the cached fixtures + the parsed enrichment switch.
 * Pure (no fs writes) so unit tests can drive it with synthetic inputs.
 */
export function buildReport(
  fixtures: readonly SchemaFixture[],
  enrichmentByType: ReadonlyMap<string, Set<string>>,
  sdkBackedTypes: ReadonlySet<string>,
  allowList: ReadonlyMap<string, AllowListEntry> = ENRICHMENT_ALLOW_LIST
): EnrichmentCoverageReport {
  const fixtureTypes = new Set(fixtures.map((f) => f.resourceType));
  const types = fixtures.map((f) =>
    classifyType(
      f.resourceType,
      f.readOnlyProperties,
      enrichmentByType.get(f.resourceType) ?? new Set<string>(),
      sdkBackedTypes.has(f.resourceType),
      f.primaryIdentifier ?? [],
      allowList
    )
  );

  // Switch cases that enrich a type we have no cached schema for — informational
  // (we can't verify their readOnly coverage offline; they need a fixture).
  const enrichedWithoutCachedSchema = [...enrichmentByType.keys()]
    .filter((t) => !fixtureTypes.has(t))
    .sort((a, b) => a.localeCompare(b));

  return {
    schemaVersion: 1,
    summary: {
      classifiedCount: types.length,
      enriched: types.filter((t) => t.bucket === 'enriched').length,
      noComputedAttr: types.filter((t) => t.bucket === 'no-computed-attr').length,
      unenrichedGap: types.filter((t) => t.bucket === 'unenriched-computed').length,
      sdkFallbackGap: types.filter((t) => t.bucket === 'sdk-fallback-gap').length,
      allowListedTypes: types.filter((t) =>
        t.attributes.some((a) => a.status === 'allow-listed')
      ).length,
    },
    types,
    enrichedWithoutCachedSchema,
  };
}

function renderMarkdown(report: EnrichmentCoverageReport): string {
  const lines: string[] = [];
  lines.push('# CC-API enrichment-coverage matrix');
  lines.push('');
  lines.push('<!-- AUTO-GENERATED by scripts/gen-enrichment-coverage.ts — DO NOT EDIT BY HAND. -->');
  lines.push('<!-- Regenerate: `vp run gen:enrichment-coverage`. -->');
  lines.push('');
  lines.push(
    'Classifies every CC-routable resource type (whose CFn schema is cached under ' +
      '`tests/fixtures/cfn-schemas/`) by whether its computed `readOnly` `Fn::GetAtt` ' +
      'attributes are populated by `CloudControlProvider.enrichResourceAttributes`. ' +
      'A computed attribute that is NOT enriched silently falls through the intrinsic ' +
      'resolver to the physicalId (the bug class fixed in #844 / #864 / #865 / #866).'
  );
  lines.push('');
  lines.push(
    'Gap severity depends on the tier. A gap on an **SDK-backed** type ' +
      '(`sdk-fallback-gap`) is only exposed on the #614 silent-drop CC-fallback path — ' +
      'the SDK provider populates the attribute on the primary path — so it is ' +
      'informational and does NOT fail CI. A gap on a **pure-CC** type ' +
      '(`unenriched-computed`, no SDK provider) is the real bug class: the CC path is ' +
      'the only path, so the attribute would always fall through. The ' +
      '`audit:enrichment-coverage:check` critic hard-fails ONLY on `unenriched-computed`.'
  );
  lines.push('');
  lines.push(
    '> NOTE: every cached schema today is an SDK-backed (Tier 1) type — the fixture ' +
      'refresh only fetches registered providers — so the critic currently has 0 ' +
      'hard gaps by construction. It becomes load-bearing the moment a pure-CC ' +
      "type's schema is cached (e.g. `AWS::ElastiCache::ReplicationGroup`, " +
      '`AWS::Redshift::Cluster`, `AWS::OpenSearchService::Domain`).'
  );
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Classified types (cached schema): **${report.summary.classifiedCount}**`);
  lines.push(`- Fully enriched: **${report.summary.enriched}**`);
  lines.push(`- No computed attribute (Ref == physicalId is correct): **${report.summary.noComputedAttr}**`);
  lines.push(`- **Pure-CC latent gaps (unenriched-computed, blocks CI): ${report.summary.unenrichedGap}**`);
  lines.push(`- SDK-fallback gaps (informational, #614 path only): **${report.summary.sdkFallbackGap}**`);
  lines.push(`- Types with allow-listed (not-a-gap) attributes: **${report.summary.allowListedTypes}**`);
  lines.push('');

  const gapTypes = report.types.filter((t) => t.bucket === 'unenriched-computed');
  if (gapTypes.length > 0) {
    lines.push('## Pure-CC latent gaps (UNENRICHED-WITH-COMPUTED-ATTR) — BLOCKS CI');
    lines.push('');
    lines.push('These computed attributes on pure-CC types are neither enriched nor ' +
      'allow-listed. Add an enrichment case OR an `ENRICHMENT_ALLOW_LIST` entry with a rationale.');
    lines.push('');
    lines.push('| Resource type | Unenriched computed attributes |');
    lines.push('| --- | --- |');
    for (const t of gapTypes) {
      lines.push(`| \`${t.resourceType}\` | ${t.gaps.map((g) => `\`${g}\``).join(', ')} |`);
    }
    lines.push('');
  } else {
    lines.push('## Pure-CC latent gaps');
    lines.push('');
    lines.push('None. Every computed `readOnly` attribute on a cached pure-CC type ' +
      'is either enriched or explicitly allow-listed.');
    lines.push('');
  }

  const sdkGapTypes = report.types.filter((t) => t.bucket === 'sdk-fallback-gap');
  if (sdkGapTypes.length > 0) {
    lines.push('## SDK-fallback gaps (informational)');
    lines.push('');
    lines.push('SDK-backed types whose computed attribute is unenriched: only exposed on ' +
      'the #614 silent-drop CC-fallback path. Tracked so a future #614-hardening pass ' +
      'can prioritise; does not block CI.');
    lines.push('');
    lines.push('| Resource type | Unenriched computed attributes (CC-fallback only) |');
    lines.push('| --- | --- |');
    for (const t of sdkGapTypes) {
      lines.push(`| \`${t.resourceType}\` | ${t.gaps.map((g) => `\`${g}\``).join(', ')} |`);
    }
    lines.push('');
  }

  lines.push('## Full classification');
  lines.push('');
  lines.push('| Resource type | SDK | Bucket | readOnly attributes (status) |');
  lines.push('| --- | --- | --- | --- |');
  for (const t of report.types) {
    const attrs =
      t.attributes.length === 0
        ? '_(none)_'
        : t.attributes
            .map((a) => {
              const mark =
                a.status === 'enriched' ? 'OK' : a.status === 'allow-listed' ? 'allow' : 'GAP';
              return `\`${a.name}\` (${mark})`;
            })
            .join(', ');
    lines.push(`| \`${t.resourceType}\` | ${t.sdkBacked ? 'yes' : 'no'} | ${t.bucket} | ${attrs} |`);
  }
  lines.push('');

  if (report.enrichedWithoutCachedSchema.length > 0) {
    lines.push('## Enrichment cases without a cached schema');
    lines.push('');
    lines.push('These types have an `enrichResourceAttributes` case but no cached CFn ' +
      'schema, so their readOnly coverage cannot be verified offline. Refresh the ' +
      'fixture (`node scripts/refresh-cfn-schemas.mjs`) to bring them under the matrix.');
    lines.push('');
    for (const t of report.enrichedWithoutCachedSchema) {
      lines.push(`- \`${t}\``);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

const isMainModule = (): boolean => {
  if (!process.argv[1]) return false;
  return resolve(process.argv[1]) === __filename;
};

function loadReport(): EnrichmentCoverageReport {
  const fixtures = loadAllFixtures();
  const enrichmentByType = parseEnrichmentSwitch(readFileSync(CC_PROVIDER_FILE, 'utf8'));
  const sdkBacked = loadSdkBackedTypes();
  return buildReport(fixtures, enrichmentByType, sdkBacked);
}

/**
 * The `--check` critic's gate: the pure-CC latent gaps that must fail CI.
 * Extracted so a unit test can pin the exact bucket the critic keys off — a
 * regression that flipped this filter (or dropped the bucket) would otherwise
 * pass every classifier test while making the critic silently never fire.
 */
export function findLatentGaps(
  report: EnrichmentCoverageReport
): readonly TypeClassification[] {
  return report.types.filter((t) => t.bucket === 'unenriched-computed');
}

function main(): void {
  const checkMode = process.argv.includes('--check');
  const report = loadReport();

  if (checkMode) {
    const gapTypes = findLatentGaps(report);
    if (gapTypes.length > 0) {
      process.stderr.write(
        'enrichment-coverage: FAIL — pure-CC latent enrichment gap(s) detected.\n' +
          'Each computed readOnly attribute below is on a type with NO SDK provider,\n' +
          'so the CC-API path is the ONLY path and the attribute would always fall\n' +
          'through the intrinsic resolver to the physicalId. Add an\n' +
          'enrichResourceAttributes case\n' +
          "in src/provisioning/cloud-control-provider.ts, OR — if it's not-a-gap\n" +
          '(e.g. the attribute IS the primaryIdentifier == physicalId) — add an\n' +
          'ENRICHMENT_ALLOW_LIST entry with a rationale in\n' +
          'scripts/gen-enrichment-coverage.ts.\n\n'
      );
      for (const t of gapTypes) {
        process.stderr.write(`  ${t.resourceType}: ${t.gaps.join(', ')}\n`);
      }
      process.exit(1);
    }
    process.stderr.write(
      `enrichment-coverage: OK — ${report.summary.classifiedCount} CC-routable types ` +
        `classified, 0 latent gaps (${report.summary.allowListedTypes} with allow-listed attrs).\n`
    );
    return;
  }

  mkdirSync(dirname(OUT_JSON), { recursive: true });
  atomicWrite(OUT_JSON, JSON.stringify(report, null, 2) + '\n');
  atomicWrite(OUT_MD, renderMarkdown(report) + '\n');
  process.stderr.write(
    `enrichment-coverage: wrote enrichment-coverage.{json,md} — ` +
      `${report.summary.classifiedCount} classified, ${report.summary.enriched} enriched, ` +
      `${report.summary.noComputedAttr} no-computed-attr, ` +
      `${report.summary.unenrichedGap} latent gap(s), ` +
      `${report.enrichedWithoutCachedSchema.length} enrichment case(s) lacking a cached schema.\n`
  );
}

if (isMainModule()) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`enrichment-coverage: failed — ${(err as Error).message}\n`);
    process.exit(1);
  }
}
