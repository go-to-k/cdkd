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
 * THE SHAPE PASS (issue #1378)
 * ----------------------------
 * Shape-level divergences share a spelling with a real SDK member, so the
 * key pass cannot see them. A second pass over the fixtures'
 * `definitionShapes` capture (per-definition member -> terminal type kind)
 * audits two such classes, both CI-blocking when neither provider-named nor
 * allow-listed:
 *   - array-vs-wrapper          — CFn declares a bare array where every
 *     same-spelled SDK member is a `{Quantity, Items}` wrapper reference
 *     (the CloudFront idiom). Mechanizes the previously hand-maintained
 *     QUANTITY_ITEM_FIELDS class: a NEW array member AWS adds to
 *     DistributionConfig now flags until the provider wraps it.
 *   - definition-member-missing — a CFn definition's member that same-spells
 *     an SDK member SOMEWHERE but is missing from the same-named SDK
 *     interface (renamed or relocated — `CachedMethods` sibling-vs-nested,
 *     `GeoRestriction.Locations`, the legacy `S3Origin`).
 * Provider evidence for shapes is the DOT-SEGMENT-EXPANDED literal set (the
 * `'ForwardedValues.Headers'` path idiom names both segments); the key pass
 * keeps the strict, unexpanded set. Members with no same-spelled SDK member
 * anywhere stay the key pass's domain — the passes never double-report a
 * key-reachability finding as a shape finding. CFn definitions with no
 * same-named SDK interface are skipped and surfaced as a visible count.
 *
 * WHAT THE CRITIC STILL DOES NOT DO
 * ---------------------------------
 * The "provider names the key" test is deliberately loose — a literal
 * mentioned for an unrelated reason counts as handled (false-negative
 * direction; the matrix keeps every verdict visible for review). Scalar
 * type-kind mismatches (string-vs-number) are not audited — providers
 * coerce per key and the SDK serializer tolerates most of them.
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
 * `UPDATE_WRAP_ALLOW_LIST`. Entries are scoped per (type, key) — an entry
 * for one key can never silence a divergence on a DIFFERENT key of the same
 * type. DELIBERATE cross-pass sharing (issue #1378): one entry silences the
 * key pass AND both shape passes for that key — every audited failure mode
 * of a key the maintainer has judged pass-through-safe (legacy members,
 * dedicated side-channel handling) is the same decision, and a per-pass key
 * would triple the entries for no reviewable difference.
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
  [
    allowKey('AWS::CloudFront::Distribution', 'S3Origin'),
    {
      rationale:
        'Legacy pre-2012 single-origin form (LegacyS3Origin definition), sibling of ' +
        'CustomOrigin; superseded by Origins[]. Invisible to the KEY pass because the ' +
        'StreamingDistribution API still has a same-spelled S3Origin member — the ' +
        'definition pass (issue #1378) is what catches it.',
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

/**
 * SHAPE-pass buckets (issue #1378). Only non-trivial verdicts become entries;
 * shape-clean pairs are counted in the summary, not listed.
 *   - provider-handled           — the provider names the key (dot-segment
 *                                  expanded literals), so the re-shaping is
 *                                  assumed done somewhere.
 *   - allow-listed               — deliberate pass-through with a rationale.
 *   - array-vs-wrapper           — CFn declares a bare array; every same-named
 *                                  SDK member is a `{Quantity, Items}` wrapper
 *                                  reference. Unconverted, the SDK serializer
 *                                  drops the bare array. BLOCKS CI.
 *   - definition-member-missing  — the CFn definition's member same-spells an
 *                                  SDK member SOMEWHERE, but the same-named SDK
 *                                  interface lacks it (renamed or relocated —
 *                                  the CloudFront `CachedMethods`
 *                                  sibling-vs-nested class). BLOCKS CI.
 *   - ambiguous                  — CFn shape is 'mixed' or the SDK side has
 *                                  conflicting kinds; visible, non-blocking.
 */
export type ShapeBucket =
  | 'provider-handled'
  | 'allow-listed'
  | 'array-vs-wrapper'
  | 'definition-member-missing'
  | 'ambiguous';

export interface NestedShapeClassification {
  readonly resourceType: string;
  readonly nestedKey: string;
  /** The CFn definition the verdict came from ('#top' = top-level block). */
  readonly definition: string;
  readonly pass: 'wrapper' | 'definition';
  readonly bucket: ShapeBucket;
  /** Human-oriented detail (e.g. the wrapper interface name). */
  readonly sdkDetail?: string;
  readonly rationale?: string;
}

export interface TargetReport {
  readonly resourceType: string;
  readonly providerFile: string;
  readonly sdkClientPackage: string;
  readonly keyStyle: KeyStyle;
  readonly nestedKeyCount: number;
  readonly entries: readonly NestedKeyClassification[];
  /** Shape-pass verdicts (only non-trivial ones — see {@link ShapeBucket}). */
  readonly shapeEntries: readonly NestedShapeClassification[];
  /** CFn array members whose same-named SDK member is a bare array (clean). */
  readonly shapeCleanCount: number;
  /** CFn definitions with no same-named SDK interface (skipped, visible). */
  readonly unmatchedDefinitions: readonly string[];
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
    readonly shapeClean: number;
    readonly shapeHandled: number;
    readonly shapeAllowListed: number;
    readonly arrayVsWrapper: number;
    readonly definitionMemberMissing: number;
    readonly shapeAmbiguous: number;
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

/** The declared type kind of one SDK interface member. */
export interface SdkMemberType {
  readonly kind: 'array' | 'ref' | 'scalar';
  /** For kind 'ref': the referenced type name. */
  readonly refName?: string;
}

/**
 * Collect every INTERFACE in the SDK client's model typings with its members'
 * declared type kinds. `X | undefined` unions are unwrapped; `Y[]` and
 * `Array<Y>` classify 'array'; a bare type reference classifies 'ref' with
 * the referenced name; everything else 'scalar'.
 *
 * Consumed by the shape pass: a member whose type is a reference to an
 * interface that itself declares a `Quantity` member is a `{Quantity, Items}`
 * WRAPPER — the CloudFront idiom where the CFn template carries a bare array.
 */
export function collectSdkInterfaces(modelsDir: string): Map<string, Map<string, SdkMemberType>> {
  const interfaces = new Map<string, Map<string, SdkMemberType>>();

  const classifyType = (typeNode: ts.TypeNode | undefined): SdkMemberType => {
    if (!typeNode) return { kind: 'scalar' };
    let node: ts.TypeNode = typeNode;
    if (ts.isUnionTypeNode(node)) {
      const nonNullish = node.types.filter(
        (t) =>
          !(ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword) &&
          t.kind !== ts.SyntaxKind.UndefinedKeyword
      );
      if (nonNullish.length !== 1) return { kind: 'scalar' };
      node = nonNullish[0]!;
    }
    if (ts.isArrayTypeNode(node)) return { kind: 'array' };
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      if (node.typeName.text === 'Array') return { kind: 'array' };
      return { kind: 'ref', refName: node.typeName.text };
    }
    return { kind: 'scalar' };
  };

  for (const file of readdirSync(modelsDir).sort()) {
    if (!file.endsWith('.d.ts')) continue;
    const source = readFileSync(join(modelsDir, file), 'utf8');
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node)) {
        const members =
          interfaces.get(node.name.text) ?? new Map<string, SdkMemberType>();
        for (const member of node.members) {
          if (
            ts.isPropertySignature(member) &&
            (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
          ) {
            members.set(member.name.text, classifyType(member.type));
          }
        }
        interfaces.set(node.name.text, members);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return interfaces;
}

/**
 * Interface names that are `{Quantity, Items}` wrappers: they declare a
 * `Quantity` member. (`Items` alone is not required — `TrustedSigners` /
 * `TrustedKeyGroups` wrappers make `Items` optional but always carry
 * `Quantity`.)
 */
export function wrapperInterfaceNames(
  interfaces: ReadonlyMap<string, ReadonlyMap<string, SdkMemberType>>
): Set<string> {
  const wrappers = new Set<string>();
  for (const [name, members] of interfaces) {
    if (members.has('Quantity')) wrappers.add(name);
  }
  return wrappers;
}

/**
 * Expand dotted literals into their segments: a provider that names a nested
 * conversion path as `'ForwardedValues.Headers'` (the CloudFront
 * `applyQuantityAtPath` idiom) has named BOTH keys for shape-handling
 * purposes. Kept SEPARATE from the key pass's literal set — the key pass
 * stays strict (a dotted path is not evidence of a key RENAME).
 */
export function expandLiteralSegments(literals: ReadonlySet<string>): Set<string> {
  const out = new Set(literals);
  // Only key-path-SHAPED literals expand (`Parent.Child` with PascalCase
  // segments — CFn property names are PascalCase) — an error message or a
  // filename like `'index.html'` must not credit its dot-segments as
  // handling evidence.
  const keyPath = /^[A-Z][A-Za-z0-9]*(\.[A-Z][A-Za-z0-9]*)+$/;
  for (const lit of literals) {
    if (keyPath.test(lit)) {
      for (const segment of lit.split('.')) {
        out.add(segment);
      }
    }
  }
  return out;
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

export interface ShapePassResult {
  readonly entries: NestedShapeClassification[];
  readonly cleanCount: number;
  readonly unmatchedDefinitions: string[];
}

/**
 * SHAPE pass (issue #1378): audits divergences the key-spelling pass is blind
 * to because the spelling exists SOMEWHERE in the SDK model.
 *
 * Two sub-passes over the fixture's `definitionShapes` capture:
 *   - WRAPPER: a CFn member declared `array` whose same-spelled SDK members
 *     are all `{Quantity, Items}` wrapper references (none is a bare array) —
 *     the provider must wrap it or the serializer drops it.
 *   - DEFINITION: for each CFn definition with a same-named SDK interface,
 *     a member that same-spells an SDK member globally but is MISSING from
 *     that interface (renamed or relocated — `CachedMethods`). Members with
 *     no same-spelled SDK member anywhere are the KEY pass's domain and are
 *     skipped here, so the two passes never double-report.
 *
 * Deliberately scoped to definitions REACHABLE from the provider's handled
 * top-levels? No — the whole definitionShapes map is audited: definitions are
 * shared sub-shapes and reachability pruning would re-derive the nested walk
 * for marginal gain; an unreachable definition's divergence is at worst a
 * false positive to allow-list, and none exists in the current targets.
 */
export function classifyTargetShapes(
  target: NestedKeyTarget,
  definitionShapes: Readonly<Record<string, Record<string, string>>>,
  sdkInterfaces: ReadonlyMap<string, ReadonlyMap<string, SdkMemberType>>,
  providerLiterals: ReadonlySet<string>,
  allowList: ReadonlyMap<string, AllowListEntry> = NESTED_KEY_ALLOW_LIST
): ShapePassResult {
  const wrappers = wrapperInterfaceNames(sdkInterfaces);
  const shapeLiterals = expandLiteralSegments(providerLiterals);

  // Global SDK member index: styled name -> every declared kind.
  const globalKinds = new Map<string, SdkMemberType[]>();
  for (const members of sdkInterfaces.values()) {
    for (const [name, type] of members) {
      const list = globalKinds.get(name) ?? [];
      list.push(type);
      globalKinds.set(name, list);
    }
  }

  const styled = (key: string): string =>
    target.keyStyle === 'lower-first' ? lowerFirst(key) : key;

  const entries: NestedShapeClassification[] = [];
  let cleanCount = 0;
  const unmatchedDefinitions: string[] = [];
  // The wrapper verdict is per KEY (deduped across definitions, like the key
  // pass); the definition verdict is per (definition, key).
  const wrapperSeen = new Set<string>();

  const resolveAudited = (
    key: string,
    definition: string,
    pass: 'wrapper' | 'definition',
    blockingBucket: ShapeBucket,
    sdkDetail: string | undefined
  ): void => {
    const allowed = allowList.get(allowKey(target.resourceType, key));
    let bucket: ShapeBucket;
    let rationale: string | undefined;
    if (shapeLiterals.has(key)) {
      bucket = 'provider-handled';
    } else if (allowed) {
      bucket = 'allow-listed';
      rationale = allowed.rationale;
    } else {
      bucket = blockingBucket;
    }
    entries.push({
      resourceType: target.resourceType,
      nestedKey: key,
      definition,
      pass,
      bucket,
      ...(sdkDetail !== undefined ? { sdkDetail } : {}),
      ...(rationale !== undefined ? { rationale } : {}),
    });
  };

  for (const [defName, members] of Object.entries(definitionShapes)) {
    const sdkIface = defName === '#top' ? undefined : sdkInterfaces.get(defName);
    if (defName !== '#top' && !sdkIface) unmatchedDefinitions.push(defName);

    for (const [key, shape] of Object.entries(members)) {
      const kinds = globalKinds.get(styled(key));

      // A 'mixed' CFn shape (conflicting oneOf arms, array-form `type`)
      // cannot be shape-judged — surface it as ambiguous (visible,
      // non-blocking) rather than silently skipping.
      if (shape === 'mixed' && kinds && !wrapperSeen.has(key)) {
        wrapperSeen.add(key);
        entries.push({
          resourceType: target.resourceType,
          nestedKey: key,
          definition: defName,
          pass: 'wrapper',
          bucket: shapeLiterals.has(key) ? 'provider-handled' : 'ambiguous',
        });
      }

      // WRAPPER sub-pass (per key, deduped).
      if (shape === 'array' && kinds && !wrapperSeen.has(key)) {
        wrapperSeen.add(key);
        // Deliberately ANY-array (response shapes included), not
        // request-interface-scoped: the false-negative direction, matching
        // the key pass's superset philosophy.
        if (kinds.some((k) => k.kind === 'array')) {
          cleanCount++;
        } else {
          const wrapperRef = kinds.find(
            (k) => k.kind === 'ref' && k.refName !== undefined && wrappers.has(k.refName)
          );
          if (wrapperRef) {
            resolveAudited(
              key,
              defName,
              'wrapper',
              'array-vs-wrapper',
              `SDK wraps it as \`${wrapperRef.refName}\` ({ Quantity, Items })`
            );
          } else {
            // Array on the CFn side, neither array nor wrapper on the SDK
            // side — cannot be auto-judged. A provider that names the key is
            // credited (CloudFront `Tags` — SDK `{ Items }`, no Quantity —
            // handled by the dedicated tag path); otherwise visible as
            // ambiguous, never blocking.
            entries.push({
              resourceType: target.resourceType,
              nestedKey: key,
              definition: defName,
              pass: 'wrapper',
              bucket: shapeLiterals.has(key) ? 'provider-handled' : 'ambiguous',
            });
          }
        }
      }

      // DEFINITION sub-pass (per definition + key).
      if (sdkIface && kinds && !sdkIface.has(styled(key))) {
        resolveAudited(
          key,
          defName,
          'definition',
          'definition-member-missing',
          `SDK interface \`${defName}\` has no \`${styled(key)}\` member`
        );
      }
    }
  }

  return { entries, cleanCount, unmatchedDefinitions: unmatchedDefinitions.sort() };
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
  const allShapes = sorted.flatMap((t) => t.shapeEntries);
  const count = (b: Bucket): number => all.filter((e) => e.bucket === b).length;
  const countShape = (b: ShapeBucket): number =>
    allShapes.filter((e) => e.bucket === b).length;
  return {
    summary: {
      targetCount: sorted.length,
      nestedKeyCount: all.length,
      sameSpelling: count('same-spelling'),
      providerHandled: count('provider-handled'),
      allowListed: count('allow-listed'),
      caseDivergence: count('case-divergence'),
      noSdkMember: count('no-sdk-member'),
      shapeClean: sorted.reduce((n, t) => n + t.shapeCleanCount, 0),
      shapeHandled: countShape('provider-handled'),
      shapeAllowListed: countShape('allow-listed'),
      arrayVsWrapper: countShape('array-vs-wrapper'),
      definitionMemberMissing: countShape('definition-member-missing'),
      shapeAmbiguous: countShape('ambiguous'),
    },
    targets: sorted,
  };
}

/** A blocking finding from either pass, normalized for reporting. */
export interface Divergence {
  readonly resourceType: string;
  readonly nestedKey: string;
  readonly bucket: Bucket | ShapeBucket;
  readonly detail?: string;
}

export function findDivergences(report: NestedKeyCoverageReport): readonly Divergence[] {
  const keyDivergences: Divergence[] = report.targets
    .flatMap((t) => t.entries)
    .filter((e) => e.bucket === 'case-divergence' || e.bucket === 'no-sdk-member')
    .map((e) => ({
      resourceType: e.resourceType,
      nestedKey: e.nestedKey,
      bucket: e.bucket,
      ...(e.sdkNearMiss !== undefined ? { detail: `SDK has \`${e.sdkNearMiss}\`` } : {}),
    }));
  const shapeDivergences: Divergence[] = report.targets
    .flatMap((t) => t.shapeEntries)
    .filter((e) => e.bucket === 'array-vs-wrapper' || e.bucket === 'definition-member-missing')
    .map((e) => ({
      resourceType: e.resourceType,
      nestedKey: e.nestedKey,
      bucket: e.bucket,
      ...(e.sdkDetail !== undefined ? { detail: e.sdkDetail } : {}),
    }));
  return [...keyDivergences, ...shapeDivergences];
}

/** Allow-list entries that no longer match any audited key — must be pruned. */
export function findStaleAllowListEntries(
  report: NestedKeyCoverageReport,
  allowList: ReadonlyMap<string, AllowListEntry> = NESTED_KEY_ALLOW_LIST
): string[] {
  const used = new Set([
    ...report.targets
      .flatMap((t) => t.entries)
      .filter((e) => e.bucket === 'allow-listed')
      .map((e) => allowKey(e.resourceType, e.nestedKey)),
    ...report.targets
      .flatMap((t) => t.shapeEntries)
      .filter((e) => e.bucket === 'allow-listed')
      .map((e) => allowKey(e.resourceType, e.nestedKey)),
  ]);
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
  lines.push(`- Shape pass — bare-array pairs clean: **${report.summary.shapeClean}**`);
  lines.push(`- Shape pass — explicitly handled in provider: **${report.summary.shapeHandled}**`);
  lines.push(
    `- Shape pass — allow-listed (does NOT block CI): **${report.summary.shapeAllowListed}**`
  );
  lines.push(`- **Array-vs-wrapper divergences (blocks CI): ${report.summary.arrayVsWrapper}**`);
  lines.push(
    `- **Definition-member-missing divergences (blocks CI): ${report.summary.definitionMemberMissing}**`
  );
  lines.push(`- Shape pass — ambiguous (visible, non-blocking): **${report.summary.shapeAmbiguous}**`);
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
    lines.push('| Resource type | CFn nested key | Bucket | SDK detail |');
    lines.push('| --- | --- | --- | --- |');
    for (const d of divergences) {
      lines.push(
        `| \`${d.resourceType}\` | \`${d.nestedKey}\` | ${d.bucket} | ${d.detail ?? '—'} |`
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

  const allowListed = [
    ...report.targets.flatMap((t) => t.entries).filter((e) => e.bucket === 'allow-listed'),
    ...report.targets.flatMap((t) => t.shapeEntries).filter((e) => e.bucket === 'allow-listed'),
  ];
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

  const shapeHandled = report.targets
    .flatMap((t) => t.shapeEntries)
    .filter((e) => e.bucket === 'provider-handled');
  if (shapeHandled.length > 0) {
    lines.push('## Shape pass — provider-handled re-shapings');
    lines.push('');
    lines.push(
      'CFn members whose SHAPE diverges from the same-spelled SDK member ' +
        '(bare array vs `{Quantity, Items}` wrapper, or missing from the ' +
        'same-named SDK interface) that the provider explicitly names. A ' +
        'provider rename that orphans one of these is visible in the diff.'
    );
    lines.push('');
    lines.push('| Resource type | CFn definition | Member | Pass | SDK detail |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const e of shapeHandled) {
      lines.push(
        `| \`${e.resourceType}\` | \`${e.definition}\` | \`${e.nestedKey}\` | ${e.pass} | ${
          e.sdkDetail ?? '—'
        } |`
      );
    }
    lines.push('');
  }

  const ambiguous = report.targets
    .flatMap((t) => t.shapeEntries)
    .filter((e) => e.bucket === 'ambiguous');
  if (ambiguous.length > 0) {
    lines.push('## Shape pass — ambiguous (non-blocking)');
    lines.push('');
    lines.push('| Resource type | CFn definition | Member |');
    lines.push('| --- | --- | --- |');
    for (const e of ambiguous) {
      lines.push(`| \`${e.resourceType}\` | \`${e.definition}\` | \`${e.nestedKey}\` |`);
    }
    lines.push('');
  }

  lines.push('## Audited targets');
  lines.push('');
  lines.push(
    '| Resource type | Provider | SDK client | Key style | Nested keys | Unmatched definitions |'
  );
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const t of report.targets) {
    lines.push(
      `| \`${t.resourceType}\` | \`${t.providerFile}\` | \`${t.sdkClientPackage}\` | ` +
        `${t.keyStyle} | ${t.nestedKeyCount} | ${t.unmatchedDefinitions.length} |`
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

export function loadReport(
  targetList: readonly NestedKeyTarget[] = NESTED_KEY_TARGETS
): NestedKeyCoverageReport {
  const sdkMembersByPackage = new Map<string, Set<string>>();
  const sdkInterfacesByPackage = new Map<string, Map<string, Map<string, SdkMemberType>>>();
  const literalsByFile = new Map<string, Set<string>>();
  const handledByFile = new Map<string, Map<string, Set<string>>>();

  const targets: TargetReport[] = [];
  for (const target of targetList) {
    const fixturePath = join(FIXTURE_DIR, fixtureFilename(target.resourceType));
    if (!existsSync(fixturePath)) {
      throw new Error(
        `missing CFn schema fixture for ${target.resourceType} — run ` +
          `\`node scripts/refresh-cfn-schemas.mjs ${target.resourceType}\``
      );
    }
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      nestedProperties?: Record<string, string[]>;
      definitionShapes?: Record<string, Record<string, string>>;
    };
    // The refresher omits `nestedProperties` entirely for a type with zero
    // nested names, so absence is only an error when the target expects a
    // non-zero yield — for a `minNestedKeys: 0` target it just means
    // "nothing to audit".
    if (!fixture.nestedProperties && target.minNestedKeys > 0) {
      throw new Error(
        `fixture for ${target.resourceType} has no nestedProperties capture — re-run ` +
          `\`node scripts/refresh-cfn-schemas.mjs ${target.resourceType}\` (the field was ` +
          'added by issue #1373)'
      );
    }
    if (!fixture.definitionShapes) {
      throw new Error(
        `fixture for ${target.resourceType} has no definitionShapes capture — re-run ` +
          `\`node scripts/refresh-cfn-schemas.mjs ${target.resourceType}\` (the field was ` +
          'added by issue #1378)'
      );
    }

    let sdkMembers = sdkMembersByPackage.get(target.sdkClientPackage);
    let sdkInterfaces = sdkInterfacesByPackage.get(target.sdkClientPackage);
    if (!sdkMembers || !sdkInterfaces) {
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
      sdkInterfaces = collectSdkInterfaces(modelsDir);
      // The interface parse shares the member floor: interfaces carry the
      // same PropertySignatures, so a collapse below the floor is the same
      // parser regression.
      const interfaceMemberCount = [...sdkInterfaces.values()].reduce((n, m) => n + m.size, 0);
      if (interfaceMemberCount < MIN_SDK_MEMBERS_PER_CLIENT) {
        throw new Error(
          `SDK interface parse for ${target.sdkClientPackage} collapsed to ` +
            `${interfaceMemberCount} members (< ${MIN_SDK_MEMBERS_PER_CLIENT}) — parser regression?`
        );
      }
      sdkMembersByPackage.set(target.sdkClientPackage, sdkMembers);
      sdkInterfacesByPackage.set(target.sdkClientPackage, sdkInterfaces);
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

    const shapeResult = classifyTargetShapes(
      target,
      fixture.definitionShapes,
      sdkInterfaces,
      literals
    );

    targets.push({
      resourceType: target.resourceType,
      providerFile: target.providerFile,
      sdkClientPackage: target.sdkClientPackage,
      keyStyle: target.keyStyle,
      nestedKeyCount: nestedKeys.length,
      entries: classifyTarget(target, nestedKeys, sdkMembers, literals),
      shapeEntries: shapeResult.entries,
      shapeCleanCount: shapeResult.cleanCount,
      unmatchedDefinitions: shapeResult.unmatchedDefinitions,
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
        const detail = d.detail ? ` (${d.detail})` : '';
        process.stderr.write(`  ${d.resourceType}: ${d.nestedKey} [${d.bucket}]${detail}\n`);
      }
      process.exit(1);
    }
    process.stderr.write(
      `nested-key-coverage: OK — ${report.summary.nestedKeyCount} nested keys across ` +
        `${report.summary.targetCount} targets, 0 divergences ` +
        `(${report.summary.sameSpelling} same-spelling, ` +
        `${report.summary.providerHandled} provider-handled` +
        (report.summary.allowListed > 0 ? `, ${report.summary.allowListed} allow-listed` : '') +
        `); shape pass 0 divergences (${report.summary.shapeClean} clean, ` +
        `${report.summary.shapeHandled} provider-handled` +
        (report.summary.shapeAllowListed > 0
          ? `, ${report.summary.shapeAllowListed} allow-listed`
          : '') +
        (report.summary.shapeAmbiguous > 0
          ? `, ${report.summary.shapeAmbiguous} ambiguous`
          : '') +
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
      `${report.summary.noSdkMember} no-sdk-member key(s), ` +
      `${report.summary.arrayVsWrapper} array-vs-wrapper, ` +
      `${report.summary.definitionMemberMissing} definition-member-missing.\n`
  );
}

if (isMainModule()) {
  try {
    main();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`nested-key-coverage: failed — ${message}\n`);
    process.exit(1);
  }
}
