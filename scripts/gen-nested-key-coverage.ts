/**
 * Codegen + CI critic: nested CFn->SDK key-divergence coverage matrix.
 *
 * THE GAP THIS CLOSES (issue #1373)
 * ---------------------------------
 * The AWS SDK v3 serializer silently drops unknown keys, so any SDK provider
 * that forwards a nested CFn config blob converts key spellings by hand — and
 * every key the conversion misses is a WRITE-SIDE SILENT DROP that no existing
 * check catches. The pre-flight `property-coverage` check compares TOP-LEVEL
 * property names only, so a handled blob like `DistributionConfig` passes
 * while its interior diverges.
 *
 * The class has recurred at least 4 times, each found by a live failure or a
 * live template read rather than by tooling:
 *   - ECS nested-object casing (#1165 / #1167)
 *   - API Gateway v2 (#1160 family)
 *   - CloudWatch AnomalyDetector `MetricTimeZone` -> `MetricTimezone` (#1304)
 *   - CloudFront Distribution, FIVE keys (#1370 / PR #1372), two of which sat
 *     in an already-"fixed" provider invisible to review
 * This critic makes the key-spelling bucket of the class non-regressing.
 *
 * HOW THE ANALYSIS WORKS
 * ----------------------
 * For each declared TARGET (a provider that forwards nested CFn config):
 *   1. CFn side: the schema fixture's `nestedProperties` capture
 *      (tests/fixtures/cfn-schemas/*.json, refreshed by
 *      `node scripts/refresh-cfn-schemas.mjs`) lists every nested property
 *      name reachable beneath each top-level property. Only the provider's
 *      OWN `handledProperties` top-levels are audited — unhandled top-levels
 *      are already rejected pre-flight by `property-coverage`.
 *   2. SDK side: every property name declared in the SDK client's model
 *      typings (`node_modules/@aws-sdk/client-<svc>/dist-types/models/`),
 *      parsed via the TypeScript Compiler API.
 *   3. Provider side: every string literal in the provider source (AST-level,
 *      so comments do not count). A key the provider names explicitly is
 *      evidence it converts / special-cases that key somewhere.
 *
 * A CFn nested key is a FLAGGED divergence when its spelling (after the
 * target's declared key style — `exact` for PascalCase SDK models like
 * CloudFront / CloudWatch / API GW v2, `lower-first` for camelCase models
 * like ECS) matches NO SDK member AND the provider source never names it.
 * Two flagged buckets, both CI-blocking:
 *   - case-divergence — a case-insensitive SDK match exists (`AcmCertificateArn`
 *     vs `ACMCertificateArn`). The highest-signal bucket: it would have caught
 *     all five CloudFront keys' class plus `MetricTimeZone`.
 *   - no-sdk-member  — no SDK member matches at all (`IPV6Enabled`, whose SDK
 *     member is `IsIPV6Enabled`).
 * An allow-list records deliberate pass-throughs with a one-line rationale.
 *
 * WHAT V1 DOES NOT DO
 * -------------------
 * Shape-level divergences (bare array vs `{Quantity, Items}` wrappers,
 * sibling-vs-nested placement like CloudFront's `CachedMethods`) share a
 * spelling with a real SDK member and therefore classify `same-spelling`
 * here. Mechanizing shape audits is recorded as follow-up in issue #1373.
 * The "provider names the key" test is also deliberately loose — a literal
 * mentioned for an unrelated reason counts as handled (false-negative
 * direction; the matrix keeps every verdict visible for review).
 *
 * OFFLINE-ONLY (NO AWS)
 * ---------------------
 * Reads fixtures + provider sources + installed SDK typings. Writes
 * `docs/_generated/nested-key-coverage.{json,md}`.
 *
 * Usage:
 *   node --experimental-strip-types scripts/gen-nested-key-coverage.ts          # write the matrix
 *   node --experimental-strip-types scripts/gen-nested-key-coverage.ts --check  # fail on a divergence
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// `typescript-v6` is an npm alias of typescript@6 — TS7 no longer ships the
// stable JS compiler API (see the note in gen-property-coverage.ts).
import ts from 'typescript-v6';
// Same-directory `.ts` import: Node 24 native type-stripping resolves imports
// literally when run via `node scripts/gen-nested-key-coverage.ts`.
import { parseProviderSource } from './gen-property-coverage.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const FIXTURE_DIR = resolve(repoRoot, 'tests/fixtures/cfn-schemas');
const PROVIDERS_DIR = resolve(repoRoot, 'src/provisioning/providers');
const OUT_JSON = resolve(repoRoot, 'docs/_generated/nested-key-coverage.json');
const OUT_MD = resolve(repoRoot, 'docs/_generated/nested-key-coverage.md');

/**
 * Parser-regression floor for the SDK side: a client model parse that
 * collapses below this member count fails LOUDLY in both write and check mode
 * instead of producing a vacuously green matrix (per the repo's checker rules
 * — a checker must not be able to pass because its input parser broke). Every
 * audited SDK client model declares hundreds of members, so this floor is far
 * below any legitimate value. The CFn-side floor is per-target
 * ({@link NestedKeyTarget.minNestedKeys}) because legitimate counts range
 * from 119 (CloudFront `DistributionConfig`) down to 0 (API GW v2
 * `Integration`, whose handled top-levels are scalars and free-form maps).
 */
export const MIN_SDK_MEMBERS_PER_CLIENT = 50;

/**
 * How a target's CFn nested key spelling maps onto its SDK model spelling
 * when the two agree:
 *   - exact       — the SDK model uses CFn-style PascalCase (CloudFront,
 *                   CloudWatch, API Gateway v2): an unconverted key must match
 *                   an SDK member verbatim.
 *   - lower-first — the SDK model is camelCase (ECS): providers convert
 *                   PascalCase->camelCase per key, so the "same spelling"
 *                   test lowercases the first character before matching.
 */
export type KeyStyle = 'exact' | 'lower-first';

export interface NestedKeyTarget {
  /** CFn resource type whose nested keys are audited. */
  readonly resourceType: string;
  /** Provider source file (basename under src/provisioning/providers/). */
  readonly providerFile: string;
  /** SDK client package whose model typings define the wire member names. */
  readonly sdkClientPackage: string;
  readonly keyStyle: KeyStyle;
  /**
   * CFn-side parser-regression floor: the MINIMUM nested-key count this
   * target is known to yield. A yield below it means the fixture capture or
   * the provider's `handledProperties` parse regressed — fail loudly rather
   * than report a vacuously clean target. Set from the observed count at
   * introduction, rounded down generously (schemas only grow).
   */
  readonly minNestedKeys: number;
}

/**
 * The audited targets: SDK providers that forward nested CFn config blobs.
 *
 * Start-set per issue #1373 — the four provider families where this bug class
 * has actually fired. When a new provider forwards a nested blob, add it here
 * (the first run then IS the audit of that provider).
 */
export const NESTED_KEY_TARGETS: readonly NestedKeyTarget[] = [
  {
    resourceType: 'AWS::CloudFront::Distribution',
    providerFile: 'cloudfront-distribution-provider.ts',
    sdkClientPackage: '@aws-sdk/client-cloudfront',
    keyStyle: 'exact',
    minNestedKeys: 100,
  },
  {
    resourceType: 'AWS::CloudWatch::AnomalyDetector',
    providerFile: 'cloudwatch-anomaly-detector-provider.ts',
    sdkClientPackage: '@aws-sdk/client-cloudwatch',
    keyStyle: 'exact',
    minNestedKeys: 5,
  },
  {
    resourceType: 'AWS::ApiGatewayV2::Api',
    providerFile: 'apigatewayv2-provider.ts',
    sdkClientPackage: '@aws-sdk/client-apigatewayv2',
    keyStyle: 'exact',
    minNestedKeys: 5,
  },
  {
    resourceType: 'AWS::ApiGatewayV2::Stage',
    providerFile: 'apigatewayv2-provider.ts',
    sdkClientPackage: '@aws-sdk/client-apigatewayv2',
    keyStyle: 'exact',
    minNestedKeys: 5,
  },
  {
    resourceType: 'AWS::ApiGatewayV2::Integration',
    providerFile: 'apigatewayv2-provider.ts',
    sdkClientPackage: '@aws-sdk/client-apigatewayv2',
    keyStyle: 'exact',
    minNestedKeys: 0,
  },
  {
    resourceType: 'AWS::ApiGatewayV2::Route',
    providerFile: 'apigatewayv2-provider.ts',
    sdkClientPackage: '@aws-sdk/client-apigatewayv2',
    keyStyle: 'exact',
    minNestedKeys: 0,
  },
  {
    resourceType: 'AWS::ApiGatewayV2::Authorizer',
    providerFile: 'apigatewayv2-provider.ts',
    sdkClientPackage: '@aws-sdk/client-apigatewayv2',
    keyStyle: 'exact',
    minNestedKeys: 0,
  },
  {
    resourceType: 'AWS::ECS::Service',
    providerFile: 'ecs-provider.ts',
    sdkClientPackage: '@aws-sdk/client-ecs',
    keyStyle: 'lower-first',
    minNestedKeys: 30,
  },
  {
    resourceType: 'AWS::ECS::TaskDefinition',
    providerFile: 'ecs-provider.ts',
    sdkClientPackage: '@aws-sdk/client-ecs',
    keyStyle: 'lower-first',
    minNestedKeys: 50,
  },
];

export interface AllowListEntry {
  readonly rationale: string;
}

/** Allow-list key: `ResourceType#NestedKey` via {@link allowKey}. */
export const allowKey = (resourceType: string, nestedKey: string): string =>
  `${resourceType}#${nestedKey}`;

/**
 * Deliberate pass-throughs the critic must not fail on. Each entry is a
 * reviewable decision with a one-line rationale, same shape as
 * `UPDATE_WRAP_ALLOW_LIST`. Keep entries scoped per (type, key) so an entry
 * for one key can never silence a NEW divergence elsewhere on the same type.
 */
export const NESTED_KEY_ALLOW_LIST: ReadonlyMap<string, AllowListEntry> = new Map<
  string,
  AllowListEntry
>([
  [
    allowKey('AWS::CloudFront::Distribution', 'CNAMEs'),
    {
      rationale:
        'Legacy pre-2012 DistributionConfig member (alias of Aliases); the modern ' +
        'CreateDistribution/UpdateDistribution API has no equivalent member and CDK ' +
        'never synthesizes it.',
    },
  ],
  [
    allowKey('AWS::CloudFront::Distribution', 'CustomOrigin'),
    {
      rationale:
        'Legacy pre-2012 single-origin form (LegacyCustomOrigin definition); superseded ' +
        'by Origins[] and absent from the modern API. CDK never synthesizes it.',
    },
  ],
  [
    allowKey('AWS::CloudFront::Distribution', 'DNSName'),
    {
      rationale:
        'Member of the legacy CustomOrigin / S3Origin blocks only (LegacyCustomOrigin / ' +
        'LegacyS3Origin definitions); unreachable from a modern template.',
    },
  ],
]);

export type Bucket =
  | 'same-spelling'
  | 'provider-handled'
  | 'allow-listed'
  | 'case-divergence'
  | 'no-sdk-member';

export interface NestedKeyClassification {
  readonly resourceType: string;
  readonly nestedKey: string;
  readonly bucket: Bucket;
  /** For case-divergence: the SDK member the key case-insensitively matches. */
  readonly sdkNearMiss?: string;
  readonly rationale?: string;
}

export interface TargetReport {
  readonly resourceType: string;
  readonly providerFile: string;
  readonly sdkClientPackage: string;
  readonly keyStyle: KeyStyle;
  readonly nestedKeyCount: number;
  readonly entries: readonly NestedKeyClassification[];
}

export interface NestedKeyCoverageReport {
  readonly summary: {
    readonly targetCount: number;
    readonly nestedKeyCount: number;
    readonly sameSpelling: number;
    readonly providerHandled: number;
    readonly allowListed: number;
    readonly caseDivergence: number;
    readonly noSdkMember: number;
  };
  readonly targets: readonly TargetReport[];
}

/** `AWS::CloudFront::Distribution` -> `AWS-CloudFront-Distribution.json`. */
const fixtureFilename = (type: string): string => type.replace(/::/g, '-') + '.json';

export const lowerFirst = (s: string): string =>
  s.length === 0 ? s : s[0]!.toLowerCase() + s.slice(1);

/**
 * Collect every property name declared in the SDK client's model typings.
 *
 * The set is deliberately a SUPERSET of the request shapes the provider
 * actually sends (response/summary shapes included): a CFn key matching ANY
 * SDK member spelling is treated as reachable. That is the false-NEGATIVE
 * direction — this critic exists to catch keys with no matching spelling
 * anywhere, which is exactly the silent-drop signature.
 */
export function collectSdkMemberNames(modelsDir: string): Set<string> {
  const names = new Set<string>();
  for (const file of readdirSync(modelsDir).sort()) {
    if (!file.endsWith('.d.ts')) continue;
    const source = readFileSync(join(modelsDir, file), 'utf8');
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isPropertySignature(node)) {
        if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) {
          names.add(node.name.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return names;
}

/**
 * Collect every string literal in the provider source, AST-level (so a key
 * named only in a comment does NOT count as handled). Covers conversion-map
 * keys (`AcmCertificateArn: 'ACMCertificateArn'` — the property NAME is an
 * identifier, but the paired SDK spelling and every element-access site are
 * literals), element accesses (`config['OriginSSLProtocols']`), and
 * conversion-list entries (`['Origins', 'CacheBehaviors']`).
 */
export function collectStringLiterals(sourceText: string, fileName = 'provider.ts'): Set<string> {
  const sf = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS
  );
  const literals = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      literals.add(node.text);
    }
    // Object-literal property NAMES are identifiers, not literals — but a
    // conversion map keyed by CFn spelling (`AcmCertificateArn: '...'`) is
    // exactly the "provider names this key" evidence we want.
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
      literals.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return literals;
}

/**
 * Classify one target's nested keys. Pure + exported for unit tests.
 */
export function classifyTarget(
  target: NestedKeyTarget,
  nestedKeys: readonly string[],
  sdkMembers: ReadonlySet<string>,
  providerLiterals: ReadonlySet<string>,
  allowList: ReadonlyMap<string, AllowListEntry> = NESTED_KEY_ALLOW_LIST
): NestedKeyClassification[] {
  const sdkLower = new Map<string, string>();
  for (const m of sdkMembers) {
    if (!sdkLower.has(m.toLowerCase())) sdkLower.set(m.toLowerCase(), m);
  }
  const out: NestedKeyClassification[] = [];
  for (const key of [...new Set(nestedKeys)].sort()) {
    const expected = target.keyStyle === 'lower-first' ? lowerFirst(key) : key;
    let bucket: Bucket;
    let sdkNearMiss: string | undefined;
    let rationale: string | undefined;
    if (sdkMembers.has(expected)) {
      bucket = 'same-spelling';
    } else if (providerLiterals.has(key)) {
      bucket = 'provider-handled';
    } else {
      const near = sdkLower.get(key.toLowerCase());
      const allowed = allowList.get(allowKey(target.resourceType, key));
      if (allowed) {
        bucket = 'allow-listed';
        rationale = allowed.rationale;
        sdkNearMiss = near;
      } else if (near !== undefined) {
        bucket = 'case-divergence';
        sdkNearMiss = near;
      } else {
        bucket = 'no-sdk-member';
      }
    }
    out.push({
      resourceType: target.resourceType,
      nestedKey: key,
      bucket,
      ...(sdkNearMiss !== undefined ? { sdkNearMiss } : {}),
      ...(rationale !== undefined ? { rationale } : {}),
    });
  }
  return out;
}

/**
 * The nested CFn keys audited for a target: the union of the fixture's
 * `nestedProperties` entries for the top-level properties THIS PROVIDER
 * handles on the type. Unhandled top-levels are pre-flight-rejected by
 * `property-coverage`, so their interiors are unreachable through this
 * provider by construction.
 */
export function nestedKeysForTarget(
  fixture: {
    nestedProperties?: Record<string, string[]>;
  },
  handledTopLevel: ReadonlySet<string>
): string[] {
  const nested = fixture.nestedProperties ?? {};
  const keys = new Set<string>();
  for (const [top, names] of Object.entries(nested)) {
    if (!handledTopLevel.has(top)) continue;
    for (const n of names) keys.add(n);
  }
  return [...keys].sort();
}

export function buildReport(targets: readonly TargetReport[]): NestedKeyCoverageReport {
  const sorted = [...targets].sort((a, b) => a.resourceType.localeCompare(b.resourceType));
  const all = sorted.flatMap((t) => t.entries);
  const count = (b: Bucket): number => all.filter((e) => e.bucket === b).length;
  return {
    summary: {
      targetCount: sorted.length,
      nestedKeyCount: all.length,
      sameSpelling: count('same-spelling'),
      providerHandled: count('provider-handled'),
      allowListed: count('allow-listed'),
      caseDivergence: count('case-divergence'),
      noSdkMember: count('no-sdk-member'),
    },
    targets: sorted,
  };
}

export function findDivergences(
  report: NestedKeyCoverageReport
): readonly NestedKeyClassification[] {
  return report.targets
    .flatMap((t) => t.entries)
    .filter((e) => e.bucket === 'case-divergence' || e.bucket === 'no-sdk-member');
}

/** Allow-list entries that no longer match any audited key — must be pruned. */
export function findStaleAllowListEntries(
  report: NestedKeyCoverageReport,
  allowList: ReadonlyMap<string, AllowListEntry> = NESTED_KEY_ALLOW_LIST
): string[] {
  const used = new Set(
    report.targets
      .flatMap((t) => t.entries)
      .filter((e) => e.bucket === 'allow-listed')
      .map((e) => allowKey(e.resourceType, e.nestedKey))
  );
  return [...allowList.keys()].filter((k) => !used.has(k)).sort();
}

function renderMarkdown(report: NestedKeyCoverageReport): string {
  const lines: string[] = [];
  lines.push('# Nested CFn->SDK key-divergence coverage matrix');
  lines.push('');
  lines.push(
    '<!-- AUTO-GENERATED by scripts/gen-nested-key-coverage.ts — DO NOT EDIT BY HAND. -->'
  );
  lines.push('<!-- Regenerate: `vp run gen:nested-key-coverage`. -->');
  lines.push('');
  lines.push(
    'For every SDK provider that forwards a nested CFn config blob, diffs the ' +
      "blob's nested property names (from the CFn registry schema fixtures) " +
      "against the SDK client's model member names. A CFn key with no " +
      'same-spelling SDK member and no explicit mention in the provider source ' +
      'is a WRITE-SIDE SILENT DROP (the #1370 class): the SDK serializer drops ' +
      'unknown keys, so the templated value never reaches AWS.'
  );
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Audited targets: **${report.summary.targetCount}**`);
  lines.push(`- Nested CFn keys audited: **${report.summary.nestedKeyCount}**`);
  lines.push(`- Same spelling in SDK model: **${report.summary.sameSpelling}**`);
  lines.push(`- Explicitly handled in provider: **${report.summary.providerHandled}**`);
  lines.push(`- Allow-listed pass-throughs (does NOT block CI): **${report.summary.allowListed}**`);
  lines.push(`- **Case divergences (blocks CI): ${report.summary.caseDivergence}**`);
  lines.push(`- **No SDK member (blocks CI): ${report.summary.noSdkMember}**`);
  lines.push('');

  const divergences = findDivergences(report);
  if (divergences.length > 0) {
    lines.push('## Divergences — BLOCKS CI');
    lines.push('');
    lines.push(
      'Each key below is templated by CFn but reaches no SDK member: add the ' +
        "CFn->SDK conversion to the provider (naming the CFn spelling), or add a " +
        '`NESTED_KEY_ALLOW_LIST` entry with a rationale in ' +
        'scripts/gen-nested-key-coverage.ts.'
    );
    lines.push('');
    lines.push('| Resource type | CFn nested key | Bucket | SDK near-miss |');
    lines.push('| --- | --- | --- | --- |');
    for (const d of divergences) {
      lines.push(
        `| \`${d.resourceType}\` | \`${d.nestedKey}\` | ${d.bucket} | ${
          d.sdkNearMiss ? `\`${d.sdkNearMiss}\`` : '—'
        } |`
      );
    }
    lines.push('');
  } else {
    lines.push('## Divergences');
    lines.push('');
    lines.push(
      'None. Every audited nested CFn key either matches an SDK member spelling ' +
        'or is explicitly named by its provider.'
    );
    lines.push('');
  }

  const allowListed = report.targets.flatMap((t) => t.entries).filter((e) => e.bucket === 'allow-listed');
  if (allowListed.length > 0) {
    lines.push('## Allow-listed pass-throughs');
    lines.push('');
    lines.push('| Resource type | CFn nested key | Rationale |');
    lines.push('| --- | --- | --- |');
    for (const e of allowListed) {
      lines.push(`| \`${e.resourceType}\` | \`${e.nestedKey}\` | ${e.rationale ?? ''} |`);
    }
    lines.push('');
  }

  lines.push('## Per-provider handled keys');
  lines.push('');
  lines.push(
    'Keys with no same-spelling SDK member that the provider explicitly names ' +
      '(conversion maps / special-case handling). Listed so a rename in the ' +
      'provider that orphans one of these is visible in the diff.'
  );
  lines.push('');
  lines.push('| Resource type | CFn nested key |');
  lines.push('| --- | --- |');
  for (const t of report.targets) {
    for (const e of t.entries) {
      if (e.bucket === 'provider-handled') {
        lines.push(`| \`${e.resourceType}\` | \`${e.nestedKey}\` |`);
      }
    }
  }
  lines.push('');

  lines.push('## Audited targets');
  lines.push('');
  lines.push('| Resource type | Provider | SDK client | Key style | Nested keys |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const t of report.targets) {
    lines.push(
      `| \`${t.resourceType}\` | \`${t.providerFile}\` | \`${t.sdkClientPackage}\` | ` +
        `${t.keyStyle} | ${t.nestedKeyCount} |`
    );
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

export function loadReport(): NestedKeyCoverageReport {
  const sdkMembersByPackage = new Map<string, Set<string>>();
  const literalsByFile = new Map<string, Set<string>>();
  const handledByFile = new Map<string, Map<string, Set<string>>>();

  const targets: TargetReport[] = [];
  for (const target of NESTED_KEY_TARGETS) {
    const fixturePath = join(FIXTURE_DIR, fixtureFilename(target.resourceType));
    if (!existsSync(fixturePath)) {
      throw new Error(
        `missing CFn schema fixture for ${target.resourceType} — run ` +
          `\`node scripts/refresh-cfn-schemas.mjs ${target.resourceType}\``
      );
    }
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      nestedProperties?: Record<string, string[]>;
    };
    if (!fixture.nestedProperties) {
      throw new Error(
        `fixture for ${target.resourceType} has no nestedProperties capture — re-run ` +
          `\`node scripts/refresh-cfn-schemas.mjs ${target.resourceType}\` (the field was ` +
          'added by issue #1373)'
      );
    }

    let sdkMembers = sdkMembersByPackage.get(target.sdkClientPackage);
    if (!sdkMembers) {
      const modelsDir = resolve(
        repoRoot,
        'node_modules',
        target.sdkClientPackage,
        'dist-types/models'
      );
      if (!existsSync(modelsDir)) {
        throw new Error(`missing SDK model typings dir: ${modelsDir}`);
      }
      sdkMembers = collectSdkMemberNames(modelsDir);
      if (sdkMembers.size < MIN_SDK_MEMBERS_PER_CLIENT) {
        throw new Error(
          `SDK member parse for ${target.sdkClientPackage} collapsed to ` +
            `${sdkMembers.size} names (< ${MIN_SDK_MEMBERS_PER_CLIENT}) — parser regression?`
        );
      }
      sdkMembersByPackage.set(target.sdkClientPackage, sdkMembers);
    }

    const providerPath = join(PROVIDERS_DIR, target.providerFile);
    let literals = literalsByFile.get(target.providerFile);
    let handled = handledByFile.get(target.providerFile);
    if (!literals || !handled) {
      const source = readFileSync(providerPath, 'utf8');
      literals = collectStringLiterals(source, target.providerFile);
      handled = parseProviderSource(source, providerPath).handled;
      literalsByFile.set(target.providerFile, literals);
      handledByFile.set(target.providerFile, handled);
    }
    const handledTopLevel = handled.get(target.resourceType);
    if (!handledTopLevel || handledTopLevel.size === 0) {
      throw new Error(
        `${target.providerFile} declares no handledProperties for ${target.resourceType} — ` +
          'target table out of date?'
      );
    }

    const nestedKeys = nestedKeysForTarget(fixture, handledTopLevel);
    if (nestedKeys.length < target.minNestedKeys) {
      throw new Error(
        `${target.resourceType} yielded only ${nestedKeys.length} nested keys ` +
          `(< ${target.minNestedKeys}) — fixture capture or handledProperties regression?`
      );
    }

    targets.push({
      resourceType: target.resourceType,
      providerFile: target.providerFile,
      sdkClientPackage: target.sdkClientPackage,
      keyStyle: target.keyStyle,
      nestedKeyCount: nestedKeys.length,
      entries: classifyTarget(target, nestedKeys, sdkMembers, literals),
    });
  }
  return buildReport(targets);
}

function main(): void {
  const checkMode = process.argv.includes('--check');
  const report = loadReport();

  const stale = findStaleAllowListEntries(report);
  if (stale.length > 0) {
    process.stderr.write(
      'nested-key-coverage: FAIL — stale NESTED_KEY_ALLOW_LIST entr(ies) match no audited ' +
        'divergence. Remove them from scripts/gen-nested-key-coverage.ts:\n' +
        stale.map((k) => `  ${k}\n`).join('')
    );
    process.exit(1);
  }

  if (checkMode) {
    const divergences = findDivergences(report);
    if (divergences.length > 0) {
      process.stderr.write(
        'nested-key-coverage: FAIL — nested CFn->SDK key divergence(s) detected.\n' +
          'These template keys reach NO member of the SDK request shape, so the SDK\n' +
          'serializer silently drops them (the #1370 CloudFront / #1304 MetricTimeZone\n' +
          'class). Add the CFn->SDK conversion to the provider (naming the CFn\n' +
          'spelling), or add a NESTED_KEY_ALLOW_LIST entry with a rationale in\n' +
          'scripts/gen-nested-key-coverage.ts.\n\n'
      );
      for (const d of divergences) {
        const near = d.sdkNearMiss ? ` (SDK has \`${d.sdkNearMiss}\`)` : '';
        process.stderr.write(`  ${d.resourceType}: ${d.nestedKey} [${d.bucket}]${near}\n`);
      }
      process.exit(1);
    }
    process.stderr.write(
      `nested-key-coverage: OK — ${report.summary.nestedKeyCount} nested keys across ` +
        `${report.summary.targetCount} targets, 0 divergences ` +
        `(${report.summary.sameSpelling} same-spelling, ` +
        `${report.summary.providerHandled} provider-handled` +
        (report.summary.allowListed > 0 ? `, ${report.summary.allowListed} allow-listed` : '') +
        ').\n'
    );
    return;
  }

  mkdirSync(dirname(OUT_JSON), { recursive: true });
  atomicWrite(OUT_JSON, JSON.stringify(report, null, 2) + '\n');
  atomicWrite(OUT_MD, renderMarkdown(report) + '\n');
  process.stderr.write(
    `nested-key-coverage: wrote nested-key-coverage.{json,md} — ` +
      `${report.summary.nestedKeyCount} nested keys, ` +
      `${report.summary.caseDivergence} case divergence(s), ` +
      `${report.summary.noSdkMember} no-sdk-member key(s).\n`
  );
}

if (isMainModule()) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`nested-key-coverage: failed — ${(err as Error).message}\n`);
    process.exit(1);
  }
}
