/**
 * Codegen + CI critic: nested CFn->SDK SHAPE-divergence coverage matrix.
 *
 * THE GAP THIS CLOSES (issues #1373 / #1378)
 * ------------------------------------------
 * The AWS SDK v3 serializer silently drops unknown keys, so any SDK provider
 * that forwards a nested CFn config blob has to re-shape it by hand — and
 * every member the re-shaping misses is a WRITE-SIDE SILENT DROP. The
 * pre-flight `property-coverage` check compares TOP-LEVEL property names only,
 * so a handled blob like `DistributionConfig` passes while its interior
 * diverges.
 *
 * WHAT IS LEFT HERE, AND WHAT MOVED (issue #3723)
 * -----------------------------------------------
 * This script used to run three passes. The KEY pass (a nested CFn key with no
 * same-spelled SDK member) and the WRITE pass (a same-spelled SDK member a
 * fresh-object mapper never writes) were RETIRED by #3723: the sdk-wire unit
 * harness (`tests/unit/provisioning/sdk-wire-*.ts`) drives each provider with
 * varied values and traces which SDK member every value lands in, which
 * catches a dropped, misspelled or misplaced member at the wire instead of
 * inferring it from source text. What remains is the SHAPE pass, over the
 * fixtures' `definitionShapes` capture (per-definition member -> terminal type
 * kind). It audits two classes, both CI-blocking when neither provider-named
 * nor allow-listed:
 *   - array-vs-wrapper          — CFn declares a bare array where every
 *     same-spelled SDK member is a `{Quantity, Items}` wrapper reference (the
 *     CloudFront idiom): a NEW array member AWS adds to DistributionConfig
 *     flags until the provider wraps it.
 *   - definition-member-missing — a CFn definition's member that same-spells
 *     an SDK member SOMEWHERE but is missing from the SDK interface a request
 *     carries for that definition (renamed or relocated — `CachedMethods`
 *     sibling-vs-nested, `GeoRestriction.Locations`, the legacy `S3Origin`).
 *     The schema-refresh workflow partitions this bucket against the published
 *     SDK typings (`scripts/diagnose-schema-refresh.mjs`).
 * Provider evidence is the DOT-SEGMENT-EXPANDED literal set of the provider
 * source (the `'ForwardedValues.Headers'` path idiom names both segments),
 * excluding the reverse map's body ({@link REVERSE_MAP_FUNCTION_PREFIXES}).
 * CFn definitions with no matching SDK interface are skipped and surfaced as a
 * visible count. An allow-list records deliberate pass-throughs with a
 * one-line rationale.
 *
 * WHY THE WRITE-SIDE WALK SURVIVES (PR #4324)
 * -------------------------------------------
 * A literal rescues a `definition-member-missing` only as evidence that the
 * provider CONVERTS the member. When an instance of the definition is handed
 * WHOLE to a generic key converter, the converter forwards the member verbatim
 * into an interface that lacks it, and a same-spelled literal elsewhere in the
 * file proves nothing (`ecs-provider.ts` hands `VpcLatticeConfigurations` to
 * `pascalToCamelCaseKeys`). Telling those cases apart needs to know which
 * nested PATHS are delivered whole, so {@link collectWriteEvidence} and its
 * WHOLE-BLOB HAND-OFF walk stay:
 *   SEED      — a value read off the DESIRED property bag
 *               ({@link HANDOFF_BAG_PARAM_NAMES}, declaration-scoped taint).
 *   PROPAGATE — the seed handed WHOLE to a callee, through `?:` / `??` / `||`
 *               arms, `const` bindings, spread-only literals, and `this.f(…)` /
 *               free-function / SIBLING-MODULE calls (`pascalToCamelCaseKeys`
 *               lives in `agentcore-case-convert.ts`).
 *   DELIVERY  — the callee RETURNS the blob rather than measuring it, and the
 *               value is WRITTEN ({@link feedsOnlyComparison} refuses a diff).
 * A callee is GENERIC only when it names no member anywhere in its body or in
 * any callee it can reach ({@link namesOwnMember}); a SPREAD-AND-PATCH
 * forwarder (`const result = { ...config }` plus `delete result[cfnKey]`)
 * registers a hand-off bounded by its exclusions. The credit is a PATH-PREFIX
 * test ({@link isHandoffCovered}), and {@link wholeDeliveredPathsFor} turns it
 * into the shape pass's `wholeDelivery` input. The audited paths come from
 * the fixtures' `nestedPropertyPaths` capture under the provider's own
 * `handledProperties` top-levels, mapped onto the provider's write paths by the
 * target's key style and its {@link NestedKeyTarget.segmentRenames}.
 *
 * KNOWN BOUNDS OF THE WRITE-SIDE WALK
 * -----------------------------------
 * The walk's outputs now feed the shape pass's `wholeDelivery` and the
 * {@link NestedKeyTarget.segmentRenames} staleness fence, so read each bound's
 * DIRECTION accordingly: a path wrongly recorded as delivered whole WITHDRAWS
 * a literal's rescue (a louder shape verdict), while a hand-off the walk misses
 * leaves the literal rescuing, the PR #4324 miss.
 *
 * (1) A DUPLICATE NAME AT THE SAME PATH is unioned across write SITES: two
 *     `environment: { … }` literals in different methods both contribute to the
 *     one `environment` scope. Hand-off points are unioned the same way
 *     (`ApiGatewayV2Provider` forwards `DefaultRouteSettings` whole at both
 *     create and update).
 * (2) A LITERAL REACHED ONLY BY INDIRECTION STILL OPENS A ROOT SCOPE. Root
 *     suppression is LEXICAL: a literal that reaches the write through a
 *     helper's `return` or a `const` binding has no object-literal ancestor, so
 *     its members are ALSO recorded at depth 1 (`mapSource`'s returned literal
 *     yields both `source.type` and a bare `type` root).
 * (3) VALUE RESOLUTION IS BEST-EFFORT AND BARE-NAME. Same-file callables and
 *     property initializers are indexed by NAME, so `this.mapSource(…)` and a
 *     free `mapSource(…)` resolve to the same declaration (a
 *     `receiver.mapSource(…)` on some OTHER object deliberately does not).
 *     Identifier bindings are searched in the nearest function scope, descended
 *     FULLY, then OUTWARD without descending into sibling functions; a hop the
 *     walk cannot follow yields NO literals.
 * (4) [RESOLVED by issue #1520] the reverse-map exclusion was prefix-only; see
 *     {@link REVERSE_MAP_FUNCTION_PREFIXES}.
 * (5) THE GENERICITY TEST IS "NAMES NO MEMBER", NOT "PRESERVES EVERY KEY". A
 *     FILTERING (`if (DROP.has(k)) continue; out[k] = v`), RENAME-MAP
 *     (`out[MAP[k] ?? k] = v`) or PICK (`for (const k of KEEP) out[k] = blob[k]`)
 *     converter names nothing and is credited as a generic hand-off.
 *     `glue-provider.ts`'s `renameRecordKeys` is the rename-map shape. Closing
 *     it needs the walk to model the converter's KEY SET.
 * (6) THE PARENT CHAIN IS MATCHED CASE-INSENSITIVELY, THE TERMINAL MEMBER IS
 *     NOT ({@link normalizeWritePath}); a genuine RENAME needs
 *     {@link NestedKeyTarget.segmentRenames}. The hand-off wildcard is
 *     registered under the WRITE path and ALSO under the SEED's own CFn key as a
 *     SIBLING path, because the two disagree (`placementStrategy` for CFn's
 *     `PlacementStrategies`).
 * (7) CROSS-MODULE RESOLUTION IS SAME-DIRECTORY ONLY (`./agentcore-case-convert.js`);
 *     a package import, a parent-directory path, a namespace import and a
 *     re-export are unresolvable.
 * (8) THE BUILDER RECOGNIZER (issue #1474) IS SEED-LITERAL-ONLY AND
 *     FLOW-INSENSITIVE: it refuses a non-literal initializer, a binding
 *     REASSIGNED as a whole, a computed key and `Object.defineProperty` onto a
 *     builder, and it never orders assignments against the delivery.
 * (9) THE SPREAD RECOGNIZER (issue #1475) EXCLUDES DELETES, NOT OVERWRITES:
 *     `result['Logging'] = reshape(result['Logging'])` stays credited through
 *     the spread, while `delete result[k]` excludes `k`
 *     ({@link ProviderWriteEvidence.handoffExclusions}) and an unresolvable
 *     delete key refuses the whole registration. The exclusion is FIRST-SEGMENT
 *     wholesale, the delete scan is BINDING-ROOTED (not alias-aware, never
 *     crossing a call edge), and the spread delivers the seed's keys VERBATIM.
 *
 * WHAT THE CRITIC DOES NOT DO
 * ---------------------------
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
 *   node --experimental-strip-types scripts/gen-nested-key-coverage.ts --help   # usage
 *
 * Any unrecognized flag (and any positional argument) is REJECTED with usage on
 * stderr and exit 1, the same guard `refresh-cfn-schemas.mjs` carries: without
 * it a typo like `--chekc` falls through to the WRITER path, rewriting the
 * committed matrix and exiting 0.
 *
 * `--providers-dir=<path>` is a TEST SEAM (issue #1448): it points the provider
 * walk at a scratch COPY of `src/provisioning/providers`, so the unit tests can
 * inject a regression into REAL provider source and assert the shipped exit
 * code — the repo's checker rule that a CI-blocking fence must be proven to
 * fire against real code, not only against synthetic fixtures.
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
import { escapeCell } from './markdown-table.ts';

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
  /** CFn resource type whose nested shapes are audited. */
  readonly resourceType: string;
  /** Provider source file (basename under src/provisioning/providers/). */
  readonly providerFile: string;
  /** SDK client package whose model typings define the wire member names. */
  readonly sdkClientPackage: string;
  readonly keyStyle: KeyStyle;
  /**
   * CFn-side parser-regression floor: the MINIMUM nested-key PATH count this
   * target is known to yield (the fixture's `nestedPropertyPaths` under the
   * provider's `handledProperties` top-levels — the paths
   * {@link wholeDeliveredPathsFor} judges). A yield below it means the fixture
   * capture or the provider's `handledProperties` parse regressed — fail
   * loudly rather than report a vacuously clean target. Set from the observed
   * count, rounded down generously (schemas only grow).
   */
  readonly minNestedKeys: number;
  /**
   * Parser-regression floor for the write SCOPE index (issue #1448), which
   * {@link findStaleSegmentRenames} reads: a collapsed scope index resolves no
   * un-renamed chain, so every rename would look used and the staleness fence
   * would go quiet. Declared by every target carrying
   * {@link segmentRenames} (a hygiene test pins that), from its measured
   * non-empty scope count rounded down generously.
   */
  readonly minWriteScopes?: number;
  /**
   * Parser-regression floor for the WHOLE-BLOB HAND-OFF walk (issue #1445):
   * the minimum number of BLOB-CARRYING hand-off points the provider is known
   * to yield — points that expand to at least one SDK member
   * ({@link countExpandingHandoffPoints}). Counting RAW points instead is
   * vacuous; the measured reason is on that function.
   *
   * Declared by EVERY target whose {@link wholeDeliveredPathsFor} result is
   * non-empty — the targets whose shape verdicts the walk can change (a
   * hygiene test derives that set from the real tree, so it stays a
   * measurement). A target the walk never delivers anything for has nothing
   * this floor protects.
   *
   * Usually 1 against a larger measurement: the points are typically one per
   * audited blob top-level, so a floor AT the measurement turns a legitimate
   * provider change (the provider stops forwarding one blob and starts naming
   * its members) into "parser regression?", while the collapse this floor
   * exists for yields 0.
   */
  readonly minHandoffPoints?: number;
  /**
   * CFn-segment -> SDK-member renames for the INTERMEDIATE segments of an
   * audited path (issue #1464 review), used to map a CFn path onto the write
   * path a hand-off is recorded at.
   *
   * The parent chain is otherwise matched case-insensitively, which covers the
   * `EFSVolumeConfiguration` -> `efsVolumeConfiguration` family but not a
   * genuine RENAME (CFn `ProxyConfiguration.ProxyConfigurationProperties` is
   * the SDK's `ProxyConfiguration.properties`). A value may be DOTTED — an
   * SDK-only wrapper level the CFn shape flattens (`LoggingConfiguration` ->
   * `BucketLoggingStatus.LoggingEnabled`) — and a key may be SCOPED by the
   * segment's immediate CFn parent (`'S3Key.Rules': 'FilterRules'`, issue
   * #1540), matched on the ORIGINAL CFn spellings and winning over a bare-name
   * entry, so one rename can never leak onto a same-named segment elsewhere.
   *
   * Applies to NON-TERMINAL segments only.
   *
   * STALENESS-FENCED like {@link NESTED_KEY_ALLOW_LIST}: an entry that stops
   * doing work fails `--check` in BOTH modes and must be removed.
   * {@link findStaleSegmentRenames} reports an entry whose UN-RENAMED chain
   * resolves in the write index (the SDK or the provider renamed the member
   * back), or whose CFn segment no longer appears in any audited path (AWS
   * dropped the property).
   */
  readonly segmentRenames?: Readonly<Record<string, string>>;
}

/**
 * The hand-off floor shared by the five `apigatewayv2-provider.ts` targets
 * (issue #1445): the walk is per FILE, so a per-target value would be five
 * spellings of one measurement. Measured: 3 BLOB-CARRYING hand-off points
 * (`CorsConfiguration` / `DefaultRouteSettings` / `JwtConfiguration`, the
 * provider forwards all three verbatim off the property bag); the floor is 1
 * for the reason on {@link NestedKeyTarget.minHandoffPoints}.
 */
const API_GATEWAY_V2_FLOORS = {
  minHandoffPoints: 1,
} as const;

/**
 * Every Glue provider class lives in the single `glue-provider.ts`, so the
 * seven `AWS::Glue::*` targets share one file and client.
 *
 * KNOWN BOUND on all seven: sharing one `providerFile` also shares the
 * file-global literal pool, so a `provider-handled` shape verdict on ANY of
 * the seven can rest on a literal belonging to a DIFFERENT resource type's
 * class in the same file.
 */
const GLUE_TARGET = {
  providerFile: 'glue-provider.ts',
  sdkClientPackage: '@aws-sdk/client-glue',
  keyStyle: 'exact',
} as const;

/**
 * `ECSProvider.convertProxyConfiguration` maps the CFn key
 * `ProxyConfigurationProperties` onto the SDK's `properties` (a
 * `KeyValuePair[]`). Declared on `AWS::ECS::TaskDefinition` ONLY, even though
 * `AWS::ECS::Service` shares the provider file: `ProxyConfiguration` is a
 * TaskDefinition property, so a Service copy would have no audited path to act
 * on and {@link findStaleSegmentRenames} would (correctly) report it.
 */
const ECS_TASK_DEFINITION_SEGMENT_RENAMES = {
  ProxyConfigurationProperties: 'properties',
} as const;

/**
 * The S3 structural renames (issue #1520), each a CFn segment whose SDK
 * counterpart the per-level case fold cannot absorb:
 *
 *   - A CFn segment the SDK RENAMES, including an SDK-only WRAPPER level the
 *     CFn shape flattens (dotted value): CFn `LoggingConfiguration` is the
 *     SDK's `BucketLoggingStatus.LoggingEnabled` (PutBucketLogging);
 *     `WebsiteConfiguration.RoutingRules.RedirectRule` is `Redirect` and
 *     `.RoutingRuleCondition` is `Condition` (PutBucketWebsite).
 *   - An SDK-only wrapper around a CFn LIST: CFn
 *     `BucketEncryption.ServerSideEncryptionConfiguration` (a list) is the
 *     SDK's `ServerSideEncryptionConfiguration.Rules` (PutBucketEncryption) —
 *     expressed as two chained single-segment renames.
 *   - A per-item PUT API whose SDK top-level is SINGULAR where CFn's is
 *     plural: `AnalyticsConfigurations` -> `AnalyticsConfiguration`
 *     (PutBucketAnalyticsConfiguration), same for Inventory / Metrics /
 *     IntelligentTiering.
 */
const S3_BUCKET_SEGMENT_RENAMES = {
  LoggingConfiguration: 'BucketLoggingStatus.LoggingEnabled',
  RedirectRule: 'Redirect',
  RoutingRuleCondition: 'Condition',
  BucketEncryption: 'ServerSideEncryptionConfiguration',
  ServerSideEncryptionConfiguration: 'Rules',
  ServerSideEncryptionByDefault: 'ApplyServerSideEncryptionByDefault',
  AnalyticsConfigurations: 'AnalyticsConfiguration',
  InventoryConfigurations: 'InventoryConfiguration',
  MetricsConfigurations: 'MetricsConfiguration',
  IntelligentTieringConfigurations: 'IntelligentTieringConfiguration',
  // --- issue #1540: SCOPED entries ('Parent.Segment', matched on the ORIGINAL
  // CFn spellings) for segments whose bare name would leak onto an unrelated
  // family. ---
  // Notification: CFn `LambdaConfigurations` is the SDK's
  // `LambdaFunctionConfigurations` (bare — the name is unique to
  // notification); `Filter.S3Key` is `Key` (bare, unique); the `Rules` list
  // under S3Key is the SDK's `FilterRules` — scoped, because bare `Rules`
  // would corrupt `LifecycleConfiguration.Rules` and
  // `ReplicationConfiguration.Rules`.
  LambdaConfigurations: 'LambdaFunctionConfigurations',
  S3Key: 'Key',
  'S3Key.Rules': 'FilterRules',
  // Lifecycle: the legacy SINGULAR forms the CFn schema still accepts are
  // written through the plural SDK members (`mergeLegacySingular`). Scoped so
  // the entries can never leak beyond the lifecycle rule.
  'Rules.Transition': 'Transitions',
  'Rules.NoncurrentVersionTransition': 'NoncurrentVersionTransitions',
  // Per-item config families + lifecycle rules: CFn `TagFilters` at the
  // config/rule level is the SDK's `Tags` under `Filter.And` (the provider
  // forwards the array verbatim there — a whole-blob hand-off). Scoped per
  // family; replication's tag filter lives under an explicit CFn `Filter`
  // and resolves without an entry.
  'AnalyticsConfigurations.TagFilters': 'Filter.And.Tags',
  'IntelligentTieringConfigurations.TagFilters': 'Filter.And.Tags',
  'MetricsConfigurations.TagFilters': 'Filter.And.Tags',
  'Rules.TagFilters': 'Filter.And.Tags',
  // Analytics / Inventory destinations: CFn flattens the SDK's
  // `S3BucketDestination` wrapper level. Scoped because bare `Destination`
  // would corrupt `ReplicationConfiguration.Rules.Destination`.
  'DataExport.Destination': 'Destination.S3BucketDestination',
  'InventoryConfigurations.Destination': 'Destination.S3BucketDestination',
} as const;

/**
 * The audited targets: SDK providers that forward nested CFn config blobs.
 * When a new provider forwards a nested blob, add it here (the first run then
 * IS the shape audit of that provider).
 */
export const NESTED_KEY_TARGETS: readonly NestedKeyTarget[] = [
  {
    // `convertToSdkFormat` is a SPREAD-AND-PATCH forwarder
    // (`const result = { ...config }` bounded by `delete result[cfnKey]`) and
    // the `{Quantity, Items}` wrapper family the shape pass exists for.
    resourceType: 'AWS::CloudFront::Distribution',
    providerFile: 'cloudfront-distribution-provider.ts',
    sdkClientPackage: '@aws-sdk/client-cloudfront',
    keyStyle: 'exact',
    minNestedKeys: 155,
    minHandoffPoints: 1,
  },
  {
    resourceType: 'AWS::CloudWatch::AnomalyDetector',
    providerFile: 'cloudwatch-anomaly-detector-provider.ts',
    sdkClientPackage: '@aws-sdk/client-cloudwatch',
    keyStyle: 'exact',
    minNestedKeys: 27,
    // Measured 4 points (one per forwarded blob top-level); 1 per the field docs.
    minHandoffPoints: 1,
  },
  {
    resourceType: 'AWS::ApiGatewayV2::Api',
    providerFile: 'apigatewayv2-provider.ts',
    sdkClientPackage: '@aws-sdk/client-apigatewayv2',
    keyStyle: 'exact',
    minNestedKeys: 5,
    ...API_GATEWAY_V2_FLOORS,
  },
  {
    resourceType: 'AWS::ApiGatewayV2::Stage',
    providerFile: 'apigatewayv2-provider.ts',
    sdkClientPackage: '@aws-sdk/client-apigatewayv2',
    keyStyle: 'exact',
    minNestedKeys: 4,
    ...API_GATEWAY_V2_FLOORS,
  },
  {
    resourceType: 'AWS::ApiGatewayV2::Integration',
    providerFile: 'apigatewayv2-provider.ts',
    sdkClientPackage: '@aws-sdk/client-apigatewayv2',
    keyStyle: 'exact',
    // 3, not the measured 4: the hygiene band requires STRICT headroom so that
    // AWS dropping one schema property reports the missing path instead of
    // aborting as a fixture-capture regression.
    minNestedKeys: 3,
    ...API_GATEWAY_V2_FLOORS,
  },
  {
    resourceType: 'AWS::ApiGatewayV2::Route',
    providerFile: 'apigatewayv2-provider.ts',
    sdkClientPackage: '@aws-sdk/client-apigatewayv2',
    keyStyle: 'exact',
    minNestedKeys: 0,
    ...API_GATEWAY_V2_FLOORS,
  },
  {
    resourceType: 'AWS::ApiGatewayV2::Authorizer',
    providerFile: 'apigatewayv2-provider.ts',
    sdkClientPackage: '@aws-sdk/client-apigatewayv2',
    keyStyle: 'exact',
    minNestedKeys: 2,
    ...API_GATEWAY_V2_FLOORS,
  },
  {
    resourceType: 'AWS::AppSync::GraphQLApi',
    providerFile: 'appsync-provider.ts',
    sdkClientPackage: '@aws-sdk/client-appsync',
    keyStyle: 'lower-first',
    minNestedKeys: 28,
  },
  {
    resourceType: 'AWS::AppSync::DataSource',
    providerFile: 'appsync-provider.ts',
    sdkClientPackage: '@aws-sdk/client-appsync',
    keyStyle: 'lower-first',
    minNestedKeys: 24,
  },
  {
    resourceType: 'AWS::AppSync::Resolver',
    providerFile: 'appsync-provider.ts',
    sdkClientPackage: '@aws-sdk/client-appsync',
    keyStyle: 'lower-first',
    minNestedKeys: 8,
  },
  {
    // The two ECS targets share `ecs-provider.ts`, whose generic
    // `pascalToCamelCaseKeys` hand-offs (the LinuxParameters family,
    // `VpcLatticeConfigurations`) are what the PR #4324 refinement reads.
    // Measured 26 expanding hand-off points.
    resourceType: 'AWS::ECS::Service',
    providerFile: 'ecs-provider.ts',
    sdkClientPackage: '@aws-sdk/client-ecs',
    keyStyle: 'lower-first',
    minNestedKeys: 110,
    minHandoffPoints: 24,
  },
  {
    resourceType: 'AWS::ECS::TaskDefinition',
    providerFile: 'ecs-provider.ts',
    sdkClientPackage: '@aws-sdk/client-ecs',
    keyStyle: 'lower-first',
    minNestedKeys: 125,
    // Measured 53 non-empty write scopes on `ecs-provider.ts`.
    minWriteScopes: 50,
    minHandoffPoints: 24,
    segmentRenames: ECS_TASK_DEFINITION_SEGMENT_RENAMES,
  },
  {
    resourceType: 'AWS::CodeBuild::Project',
    providerFile: 'codebuild-provider.ts',
    sdkClientPackage: '@aws-sdk/client-codebuild',
    keyStyle: 'lower-first',
    minNestedKeys: 88,
  },
  {
    // A dozen nested config blobs (lifecycle, CORS, replication,
    // notifications, encryption, inventory, analytics, metrics,
    // intelligent-tiering, object-lock, website routing). CFn's lifecycle
    // `Rule` matches no SDK interface (`@aws-sdk/client-s3` spells it
    // `LifecycleRule`), so that blob sits in `unmatchedDefinitions`.
    resourceType: 'AWS::S3::Bucket',
    providerFile: 's3-bucket-provider.ts',
    sdkClientPackage: '@aws-sdk/client-s3',
    keyStyle: 'exact',
    minNestedKeys: 170,
    // Measured 156 non-empty write scopes at #1540.
    minWriteScopes: 110,
    minHandoffPoints: 1,
    segmentRenames: S3_BUCKET_SEGMENT_RENAMES,
  },
  {
    // Every forwarded blob is a verbatim cast (`params.X = properties['X'] as
    // <SdkType>`).
    resourceType: 'AWS::Lambda::EventSourceMapping',
    providerFile: 'lambda-eventsource-provider.ts',
    sdkClientPackage: '@aws-sdk/client-lambda',
    keyStyle: 'exact',
    minNestedKeys: 30,
    minHandoffPoints: 1,
  },
  {
    resourceType: 'AWS::Lambda::WebFunctionRevision',
    providerFile: 'lambda-web-function-revision-provider.ts',
    sdkClientPackage: '@aws-sdk/client-lambda-web',
    keyStyle: 'lower-first',
    minNestedKeys: 14,
  },
  {
    resourceType: 'AWS::Lambda::NetworkConnector',
    providerFile: 'lambda-network-connector-provider.ts',
    sdkClientPackage: '@aws-sdk/client-lambda-core',
    keyStyle: 'exact',
    minNestedKeys: 5,
  },
  {
    resourceType: 'AWS::Lambda::WebFunctionEndpoint',
    providerFile: 'lambda-web-function-endpoint-provider.ts',
    sdkClientPackage: '@aws-sdk/client-lambda-web',
    keyStyle: 'lower-first',
    minNestedKeys: 3,
  },
  {
    // `client-eventbridge`, `client-scheduler` and `client-pipes` are
    // PascalCase models with camelCase ISLANDS (the ECS-target
    // `awsvpcConfiguration` family, #1381). `keyStyle: 'exact'` is the honest
    // declaration for a PascalCase model.
    resourceType: 'AWS::Events::Rule',
    providerFile: 'eventbridge-rule-provider.ts',
    sdkClientPackage: '@aws-sdk/client-eventbridge',
    keyStyle: 'exact',
    minNestedKeys: 60,
    minHandoffPoints: 1,
  },
  {
    resourceType: 'AWS::Scheduler::Schedule',
    providerFile: 'scheduler-schedule-provider.ts',
    sdkClientPackage: '@aws-sdk/client-scheduler',
    keyStyle: 'exact',
    minNestedKeys: 38,
    minHandoffPoints: 1,
  },
  {
    resourceType: 'AWS::Pipes::Pipe',
    providerFile: 'pipes-provider.ts',
    sdkClientPackage: '@aws-sdk/client-pipes',
    keyStyle: 'exact',
    minNestedKeys: 180,
    minHandoffPoints: 1,
  },
  {
    // `client-glue` is PascalCase everywhere EXCEPT
    // `DynamoDBTarget.{scanAll,scanRate}`; the shape pass reports
    // `DynamoDBTarget has no ScanAll member`, rescued to `provider-handled` by
    // `CFN_TO_SDK_DYNAMODB_TARGET_KEYS`.
    ...GLUE_TARGET,
    resourceType: 'AWS::Glue::Crawler',
    minNestedKeys: 36,
    minHandoffPoints: 1,
  },
  {
    ...GLUE_TARGET,
    resourceType: 'AWS::Glue::Table',
    minNestedKeys: 70,
    minHandoffPoints: 1,
  },
  {
    ...GLUE_TARGET,
    resourceType: 'AWS::Glue::Connection',
    minNestedKeys: 29,
    minHandoffPoints: 1,
  },
  {
    ...GLUE_TARGET,
    resourceType: 'AWS::Glue::Trigger',
    minNestedKeys: 12,
    minHandoffPoints: 1,
  },
  {
    ...GLUE_TARGET,
    resourceType: 'AWS::Glue::Database',
    minNestedKeys: 12,
  },
  {
    ...GLUE_TARGET,
    resourceType: 'AWS::Glue::SecurityConfiguration',
    minNestedKeys: 7,
  },
  {
    ...GLUE_TARGET,
    resourceType: 'AWS::Glue::Job',
    minNestedKeys: 5,
    minHandoffPoints: 1,
  },
  // `AWS::Glue::Workflow` is deliberately LEFT OUT: its schema has no nested
  // property at all (scalars plus the free-form string maps
  // `DefaultRunProperties` / `Tags`), so its fixture carries no
  // `definitionShapes` member to audit and the target would be a vacuously
  // clean row. Register it if AWS ever gives the type a structured property.
];

export interface AllowListEntry {
  readonly rationale: string;
}

/** Allow-list key: `ResourceType#Member`. */
export const allowKey = (resourceType: string, nestedKey: string): string =>
  `${resourceType}#${nestedKey}`;

/**
 * Deliberate pass-throughs the shape pass must not fail on. Each entry is a
 * reviewable decision with a one-line rationale, same shape as
 * `UPDATE_WRAP_ALLOW_LIST`, scoped per (type, definition member) — an entry
 * for one member can never silence a divergence on a DIFFERENT member of the
 * same type. One entry silences both shape sub-passes for that member.
 */
export const NESTED_KEY_ALLOW_LIST: ReadonlyMap<string, AllowListEntry> = new Map<
  string,
  AllowListEntry
>([
  [
    allowKey('AWS::CloudFront::Distribution', 'S3Origin'),
    {
      rationale:
        'Legacy pre-2012 single-origin form (LegacyS3Origin definition), sibling of ' +
        'CustomOrigin; superseded by Origins[] and absent from the modern ' +
        'CreateDistribution/UpdateDistribution API. The StreamingDistribution API still ' +
        'has a same-spelled S3Origin member, which is why the definition pass (issue ' +
        '#1378) reports it.',
    },
  ],
  // The three S3 Metadata-Tables members below are the unreachable-definition
  // false positive `classifyTargetShapes` documents: the shape pass audits the
  // whole `definitionShapes` map rather than pruning to definitions reachable
  // from the provider's handled top-levels. All three live only under
  // `MetadataConfiguration` / `MetadataTableConfiguration`, which
  // `S3BucketProvider` does NOT declare in `handledProperties`, so a template
  // using them is pre-flight-rejected and auto-routed through Cloud Control,
  // which forwards the property map whole. Remove these entries if the provider
  // ever implements those top-levels.
  [
    allowKey('AWS::S3::Bucket', 'TableName'),
    {
      rationale:
        'Member of the JournalTableConfiguration / InventoryTableConfiguration definitions, ' +
        'reachable only from the MetadataConfiguration / MetadataTableConfiguration ' +
        'top-levels the provider declares as silent-drop (Cloud-Control-routed), so no ' +
        'SDK forwarding path exists to drop it (issue #1430).',
    },
  ],
  [
    allowKey('AWS::S3::Bucket', 'TableArn'),
    {
      rationale:
        'Member of the S3TablesDestination / JournalTableConfiguration / ' +
        'InventoryTableConfiguration definitions, reachable only from the ' +
        'MetadataConfiguration / MetadataTableConfiguration top-levels the provider ' +
        'declares as silent-drop (Cloud-Control-routed), so no SDK forwarding path ' +
        'exists to drop it (issue #1430).',
    },
  ],
  [
    allowKey('AWS::S3::Bucket', 'TableNamespace'),
    {
      rationale:
        'Member of the S3TablesDestination definition, reachable only from the ' +
        'MetadataTableConfiguration top-level the provider declares as silent-drop ' +
        '(Cloud-Control-routed), so no SDK forwarding path exists to drop it ' +
        '(issue #1430).',
    },
  ],
]);

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
  /** For allow-listed: the allow-list key that matched. */
  readonly allowMatchKey?: string;
}

export interface TargetReport {
  readonly resourceType: string;
  readonly providerFile: string;
  readonly sdkClientPackage: string;
  readonly keyStyle: KeyStyle;
  /** Nested CFn key paths under the provider's handled top-levels. */
  readonly nestedKeyCount: number;
  /**
   * The audited paths delivered WHOLE by a generic hand-off
   * ({@link wholeDeliveredPathsFor}) — the shape pass's `wholeDelivery` input,
   * listed so a change in what the hand-off walk recognizes shows in the diff.
   */
  readonly wholeDeliveredPaths: readonly string[];
  /** Shape-pass verdicts (only non-trivial ones — see {@link ShapeBucket}). */
  readonly shapeEntries: readonly NestedShapeClassification[];
  /** CFn array members whose same-named SDK member is a bare array (clean). */
  readonly shapeCleanCount: number;
  /** CFn definitions with no same-named SDK interface (skipped, visible). */
  readonly unmatchedDefinitions: readonly string[];
  /**
   * {@link NestedKeyTarget.segmentRenames} entries that DID work on this run.
   * Consumed by {@link findStaleSegmentRenames} — an entry that never did work
   * must be removed, the same discipline the allow-list carries.
   */
  readonly usedSegmentRenames: readonly string[];
}

export interface NestedKeyCoverageReport {
  readonly summary: {
    readonly targetCount: number;
    readonly nestedKeyCount: number;
    readonly wholeDeliveredPathCount: number;
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
  /**
   * The referenced type name — for kind 'ref' the member's own type, and for
   * kind 'array' the ELEMENT type when it is a bare reference (`Tmpfs[]` ->
   * `Tmpfs`, `Array<Device>` -> `Device`).
   *
   * The array case was added by issue #1445: {@link reachableSdkMemberNames}
   * walks this graph to enumerate the members beneath a blob handed WHOLE to a
   * generic converter, and `LinuxParameters.tmpfs` / `.devices` are arrays — a
   * ref-only graph would stop at the array edge and leave `ContainerPath` /
   * `MountOptions` / `HostPath` uncredited. The shape pass is unaffected: every
   * one of its `refName` tests is guarded by `kind === 'ref'`.
   */
  readonly refName?: string;
  /**
   * The VALUE type of a map-shaped member (`Record<string, Y>` /
   * `Map<string, Y>` -> `Y`), when it is a bare reference.
   *
   * `refName` cannot carry it: for these the member's own type name is the
   * useless `Record` / `Map`, and overwriting it with the value type would
   * make the shape pass's `kind === 'ref'` tests read a wrapper's name for a
   * member that is not one. Separate field, so every existing consumer is
   * unchanged and only {@link inputReachableInterfaces} — which asks what a
   * REQUEST can carry — follows the edge. Without it a shape reachable ONLY
   * as a map value looked unreachable, and a definition of that name fell to
   * the twin branch, which is the one place an unrelated interface can be
   * bound (issue [#2843](https://github.com/go-to-k/cdkd/pull/2843) review).
   */
  readonly valueRefName?: string;
}

/**
 * Collect every INTERFACE in the SDK client's model typings with its members'
 * declared type kinds. `X | undefined` unions are unwrapped; `Y[]` and
 * `Array<Y>` classify 'array' (carrying the element's reference name when it
 * has one); a bare type reference classifies 'ref' with the referenced name;
 * everything else 'scalar'.
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
    if (ts.isArrayTypeNode(node)) {
      const element = node.elementType;
      return ts.isTypeReferenceNode(element) && ts.isIdentifier(element.typeName)
        ? { kind: 'array', refName: element.typeName.text }
        : { kind: 'array' };
    }
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      if (node.typeName.text === 'Array') {
        const element = node.typeArguments?.[0];
        return element !== undefined &&
          ts.isTypeReferenceNode(element) &&
          ts.isIdentifier(element.typeName)
          ? { kind: 'array', refName: element.typeName.text }
          : { kind: 'array' };
      }
      // `Record<string, Y>` / `Map<string, Y>`: keep the member's own type name
      // in `refName` (what the shape pass reads) and carry the VALUE type
      // separately, so the reachability walk can follow it. AWS models a
      // map-valued member this way, and a shape reachable only through one
      // would otherwise never be input-reachable.
      if (node.typeName.text === 'Record' || node.typeName.text === 'Map') {
        const value = node.typeArguments?.[1];
        return value !== undefined && ts.isTypeReferenceNode(value) && ts.isIdentifier(value.typeName)
          ? { kind: 'ref', refName: node.typeName.text, valueRefName: value.typeName.text }
          : { kind: 'ref', refName: node.typeName.text };
      }
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
 * How AWS SDK v3 names an operation's INPUT shape.
 *
 * Kept in step with `scripts/offline-property-evidence.ts`'s list of the same
 * name, which reached this set the hard way: leaving the QUERY-protocol
 * spellings (`Type`, `Message`) out made whole services — rds, neptune,
 * auto-scaling, docdb, elasticache — unreachable from any input root.
 */
const INPUT_ROOT_SUFFIXES = ['Request', 'Input', 'CommandInput', 'Type', 'Message'] as const;

/**
 * Every interface REACHABLE from an operation input, by walking member type
 * references out of the input roots.
 *
 * The WRITE direction is what this critic judges — "does the template key reach
 * AWS" — so the interface a CFn definition is compared against has to be one a
 * request can carry. Reachability rather than a name suffix, because most
 * definitions are NESTED inside a request rather than being one.
 *
 * Array edges are followed as well as plain references: {@link SdkMemberType}
 * carries the element type for `T[]` / `Array<T>`, and a list-valued member is
 * how most nested shapes hang off a request. MAP-VALUE edges too
 * ({@link SdkMemberType.valueRefName}) — a member typed `Record<string, Y>`
 * carries `Y` on the wire exactly as a list-valued one carries its element,
 * and a walk that stops at the map declares `Y` unreachable, which pushes a
 * definition of that name onto the twin branch below.
 */
export function inputReachableInterfaces(
  interfaces: ReadonlyMap<string, ReadonlyMap<string, SdkMemberType>>
): Set<string> {
  const queue = [...interfaces.keys()].filter((n) =>
    INPUT_ROOT_SUFFIXES.some((s) => n.endsWith(s))
  );
  const reachable = new Set<string>();
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (reachable.has(name)) continue;
    reachable.add(name);
    for (const type of interfaces.get(name)?.values() ?? []) {
      if (type.refName !== undefined && !reachable.has(type.refName)) queue.push(type.refName);
      if (type.valueRefName !== undefined && !reachable.has(type.valueRefName)) {
        queue.push(type.valueRefName);
      }
    }
  }
  return reachable;
}

/** The SDK interface a CFn definition is judged against, and how it was found. */
export interface ResolvedDefinition {
  readonly name: string;
  readonly members: ReadonlyMap<string, SdkMemberType>;
  /**
   * `exact` when the definition's own name resolved AND is input-reachable;
   * `exact-unreachable` when the exact name was the only candidate but nothing
   * reaches it from an operation input; otherwise the suffix used.
   *
   * The two exact arms are told apart deliberately: they are the SAME name and
   * members but not the same claim — one says a request can carry this shape,
   * the other that no request provably can — and a single value would leave a
   * later consumer branching on `via` unable to see the difference.
   */
  readonly via: 'exact' | 'exact-unreachable' | (typeof INPUT_ROOT_SUFFIXES)[number];
}

/**
 * Resolve a CFn definition name to the SDK interface the WRITE path would carry.
 *
 * The exact name wins whenever it is input-reachable — every currently-green
 * verdict resolves that way and none moves. The fallback exists because CFn and
 * the SDK are independent namespaces: several services name the request shape
 * `<X>Input` and the RESPONSE shape `<X>`, so an exact-name match lands on the
 * shape a request can never carry, and every member that exists only on the
 * request twin reports `definition-member-missing` about a key the provider
 * delivers perfectly well.
 *
 * That is not hypothetical and not stable over time — AWS RENAMED the
 * `AWS::Glue::Connection` definitions from `AuthenticationConfigurationInput` to
 * `AuthenticationConfiguration` in a schema refresh, which is what turned four
 * previously-clean keys into blocking divergences whose documented remedy is a
 * `NESTED_KEY_ALLOW_LIST` entry: a standing promise cdkd never sends the value,
 * recorded about a value it does send (issue
 * [#2821](https://github.com/go-to-k/cdkd/issues/2821)).
 *
 * Measured across every target after that refresh, with the resolution as it
 * ships: 357 definitions, 6 whose exact match is not input-reachable, 5 of
 * which have a qualifying twin. The other one (`AWS::Glue::Crawler`'s
 * `Schedule`) has no twin and keeps resolving exactly — an unreachable
 * interface is still the best available answer, and refusing to resolve at all
 * would turn it into an `unmatchedDefinitions` entry instead.
 *
 * Suffixes are tried in {@link INPUT_ROOT_SUFFIXES} order, so `Request` beats
 * `Input` when a service somehow declares both; the order is the shared list's,
 * not a preference of this function.
 */
export function resolveDefinitionInterface(
  defName: string,
  interfaces: ReadonlyMap<string, ReadonlyMap<string, SdkMemberType>>,
  /** From {@link inputReachableInterfaces}. Consulted for the EXACT name only. */
  inputReachable: ReadonlySet<string>
): ResolvedDefinition | undefined {
  const exact = interfaces.get(defName);
  if (exact !== undefined && inputReachable.has(defName)) {
    return { name: defName, members: exact, via: 'exact' };
  }
  // Gated on the exact name EXISTING. Without it, a definition that matches no
  // interface at all — 53 of the 357 across the current targets, which today
  // report as `unmatchedDefinitions` — could be silently rebound to an
  // unrelated `<X>Type` or `<X>Message` shape, since those suffixes are in the
  // list for the query protocol. Measured over the refreshed fixtures the
  // no-exact-but-twin-exists case is EMPTY, so the gate is behaviour-identical
  // today and exists to keep it that way.
  //
  // No `inputReachable` test on the twin, and that is not an omission: its name
  // ENDS in a root suffix, so `inputReachableInterfaces` seeds it as a root and
  // it is reachable by construction. A guard there read as defence and was
  // unfalsifiable — no fixture can make it fire (measured: the mutation that
  // deleted it survived every case written for it).
  //
  // The twin must also LOOK LIKE the same shape, evidenced by member overlap:
  // `Type` and `Message` are in the list for the query protocol, so a
  // definition named `Filter` would otherwise bind to an unrelated `FilterType`
  // on the strength of the name alone, and a false CLEAN there is silent (a
  // request shape carries many members, so the audited key is likely present in
  // it by accident). The bar is HALF the exact shape's members; measured over
  // every target, the five real pairs sit at 100 / 100 / 83 / 100 / 100 percent,
  // and the one shape with no twin is unaffected. Failing the bar falls back
  // to the exact match, whose divergences BLOCK CI — the loud direction, and the
  // right one, since the hazard being closed is a silent wrong binding.
  //
  // An EMPTY exact shape is REFUSED, and deliberately rather than by accident of
  // the arithmetic: `shared * 2 >= 0` is vacuously true there, so `shared > 0` is
  // the only decider and can never hold. With no members to compare there is no
  // relatedness evidence at all, and binding on the NAME alone is precisely what
  // this gate exists to stop. No definition REACHES this gate in that shape
  // today — `AWS::S3::Bucket`'s `EventBridgeConfiguration` does resolve to a
  // member-less interface, but it is input-reachable, so it returns at the
  // `exact` arm above and never gets here. The distinction is worth keeping:
  // "no such shape exists" is measurably false.
  if (exact !== undefined) {
    for (const suffix of INPUT_ROOT_SUFFIXES) {
      const twin = interfaces.get(defName + suffix);
      if (twin === undefined) continue;
      let shared = 0;
      for (const member of exact.keys()) if (twin.has(member)) shared++;
      if (shared > 0 && shared * 2 >= exact.size) {
        return { name: defName + suffix, members: twin, via: suffix };
      }
    }
  }
  // No input-reachable candidate. The exact match, reachable or not, is still
  // the closest thing to an answer — dropping it here would report the
  // definition as UNMATCHED, which says something different and louder.
  return exact === undefined
    ? undefined
    : { name: defName, members: exact, via: 'exact-unreachable' };
}

/**
 * Expand dotted literals into their segments: a provider that names a nested
 * conversion path as `'ForwardedValues.Headers'` (the CloudFront
 * `applyQuantityAtPath` idiom) has named BOTH keys for shape-handling
 * purposes.
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
 * Function-name PREFIXES whose bodies every evidence collector in this file
 * skips: the SDK->CFn REVERSE map (issue #1432, widened to the literal set by
 * #1448).
 *
 * `readCurrentState` reads the SDK member and writes the CFn spelling. For an
 * `exact` target the two spellings are identical, so its
 * `result['CorsConfiguration'] = ...` would register as a forward write, and a
 * CFn key mentioned only by the reverse map is evidence the provider can READ
 * it back, not that the forward mapper converts it. Excluding the body keeps
 * the evidence direction-scoped.
 *
 * PREFIX rather than exact match, because the reverse map is routinely split
 * per sub-resource: `apigateway-provider.ts` declares
 * `readCurrentStateAuthorizer` / `...Resource` / `...Deployment` / `...Stage` /
 * `...Account` / `...Method`, none of which an exact-name set would catch.
 *
 * A prefix must be followed by a WORD BOUNDARY (end of name, or an uppercase
 * letter), so `readCurrentStatelessThing` is not swallowed by the `read`
 * prefix. Issue #1520 widened the prefix from `readCurrentState` to `read`
 * (the `readEncryption` / `readLifecycle` / `readApi` … builder-idiom reverse
 * helpers) and added the `*ToCfn` SUFFIX entry (`volumesToCfn` /
 * `containerDefinitionsToCfn` / `sdkNotifFilterToCfn`); a suffix entry
 * requires a non-empty stem.
 */
export const REVERSE_MAP_FUNCTION_PREFIXES: readonly string[] = ['read', '*ToCfn'];

/**
 * Does `name` match one of `matchers`? A `*Suffix` entry matches a name that
 * ENDS with `Suffix` on a non-empty stem; any other entry is a prefix that
 * must sit at a word boundary (the whole name, or followed by an uppercase
 * letter).
 */
const matchesFunctionPrefix = (name: string, matchers: readonly string[]): boolean =>
  matchers.some((p) =>
    p.startsWith('*')
      ? name.length > p.length - 1 && name.endsWith(p.slice(1))
      : name === p || (name.startsWith(p) && /[A-Z]/.test(name.charAt(p.length)))
  );

/** The declared name of a function-ish node, when it is a plain identifier. */
const declaredFunctionName = (node: ts.Node): string | undefined => {
  if (
    ts.isMethodDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return node.name !== undefined && ts.isIdentifier(node.name) ? node.name.text : undefined;
  }
  return undefined;
};

/**
 * Collect every string literal in the provider source, AST-level (so a key
 * named only in a comment does NOT count as handled). Covers conversion-map
 * keys (`AcmCertificateArn: 'ACMCertificateArn'` — the property NAME is an
 * identifier, but the paired SDK spelling and every element-access site are
 * literals), element accesses (`config['OriginSSLProtocols']`), and
 * conversion-list entries (`['Origins', 'CacheBehaviors']`).
 *
 * Bodies of {@link REVERSE_MAP_FUNCTION_PREFIXES} are skipped, for the reason
 * documented there.
 */
export function collectStringLiterals(
  sourceText: string,
  fileName = 'provider.ts',
  excludedFunctionPrefixes: readonly string[] = REVERSE_MAP_FUNCTION_PREFIXES
): Set<string> {
  const sf = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS
  );
  const literals = new Set<string>();
  const visit = (node: ts.Node, excluded: boolean): void => {
    let inExcluded = excluded;
    if (!inExcluded) {
      const name = declaredFunctionName(node);
      if (name !== undefined && matchesFunctionPrefix(name, excludedFunctionPrefixes)) {
        inExcluded = true;
      }
    }
    if (!inExcluded) {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        literals.add(node.text);
      }
      // Object-literal property NAMES are identifiers, not literals — but a
      // conversion map keyed by CFn spelling (`AcmCertificateArn: '...'`) is
      // exactly the "provider names this key" evidence we want.
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
        literals.add(node.name.text);
      }
    }
    ts.forEachChild(node, (child) => visit(child, inExcluded));
  };
  visit(sf, false);
  return literals;
}

/**
 * Peel `(x)` / `x as T` / `x satisfies T` / `x!` / `await x` off a value
 * expression.
 *
 * `await` matters in the UNDER-credit direction: an un-peeled
 * `source: await this.mapSource(x)` resolves to zero literals, so nothing
 * under that top-level would be recorded. No provider awaits a mapper today;
 * the peel is here so the first one that does is still seen.
 */
function unwrapExpression(node: ts.Node): ts.Node {
  let current = node;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) current = current.expression;
    else if (ts.isAsExpression(current)) current = current.expression;
    else if (ts.isSatisfiesExpression(current)) current = current.expression;
    else if (ts.isNonNullExpression(current)) current = current.expression;
    else if (ts.isAwaitExpression(current)) current = current.expression;
    else return current;
  }
}

/** Climb OUT of the same wrappers, so a node's real consumer is visible. */
function climbOutOfWrappers(node: ts.Node): ts.Node {
  let current = node;
  while (
    current.parent !== undefined &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent) ||
      ts.isNonNullExpression(current.parent))
  ) {
    current = current.parent;
  }
  return current;
}

const COMPARISON_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

/**
 * Callees that only INSPECT or SERIALIZE their argument, so passing a value to
 * one decides nothing — what the RESULT feeds does.
 */
const isPureInspectionCallee = (callee: ts.Expression): boolean => {
  if (ts.isIdentifier(callee)) return ['String', 'Number', 'Boolean'].includes(callee.text);
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return false;
  const target = `${callee.expression.text}.${callee.name.text}`;
  return [
    'JSON.stringify',
    'Object.keys',
    'Object.entries',
    'Object.values',
    'Array.isArray',
  ].includes(target);
};

/**
 * DIFF IS NOT DELIVERY (issue #1448).
 *
 * Does this value flow ONLY into a comparison / measurement — never into a
 * request, an escaping variable, or a non-inspecting call argument? An object
 * literal built purely to be serialized and compared
 * (`JSON.stringify({ batchReportMode: x }) !== JSON.stringify(prev)`, the
 * change-detection idiom of a diff-heavy `update()`) names its members without
 * DELIVERING any of them, so crediting it as a write (or as a hand-off) would
 * be a false clear. Deliberately fail-closed: bare truthiness, `!`, `typeof`
 * and `.length` all count as inert.
 */
export function feedsOnlyComparison(value: ts.Node): boolean {
  const top = climbOutOfWrappers(value);
  const parent = top.parent;
  if (parent === undefined) return false;
  if (ts.isTypeOfExpression(parent)) return feedsOnlyComparison(parent);
  if (ts.isPropertyAccessExpression(parent) && parent.name.text === 'length') {
    return feedsOnlyComparison(parent);
  }
  if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) {
    return true;
  }
  if (
    ts.isCallExpression(parent) &&
    parent.arguments.some((a) => a === top) &&
    isPureInspectionCallee(parent.expression)
  ) {
    return feedsOnlyComparison(parent);
  }
  if (ts.isBinaryExpression(parent)) {
    return COMPARISON_OPERATORS.has(parent.operatorToken.kind);
  }
  if (ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) {
    return parent.expression === top;
  }
  if (ts.isConditionalExpression(parent)) return parent.condition === top;
  return false;
}

/**
 * {@link feedsOnlyComparison}, applied to the OUTERMOST literal a value sits
 * inside. `JSON.stringify({ outer: { inner: 1 } })` compared against a previous
 * render is comparison-only for `inner` too, even though `inner`'s own parent
 * chain stops at a PropertyAssignment — without the climb the nested half of a
 * diff literal would still be credited.
 */
export function isComparisonOnlyLiteral(node: ts.Node): boolean {
  let current: ts.Node = node;
  for (;;) {
    const parent = climbOutOfWrappers(current).parent;
    if (
      parent !== undefined &&
      (ts.isPropertyAssignment(parent) ||
        ts.isShorthandPropertyAssignment(parent) ||
        ts.isSpreadAssignment(parent) ||
        ts.isSpreadElement(parent) ||
        ts.isObjectLiteralExpression(parent) ||
        ts.isArrayLiteralExpression(parent))
    ) {
      current = parent;
      continue;
    }
    return feedsOnlyComparison(current);
  }
}

/**
 * PATH-SCOPED write evidence for one provider file (issue #1448).
 *
 * - `scopes` — written member name -> every member name written
 *   ANYWHERE BENEATH the value that name is written with. `buildBatchConfig`
 *   maps to the seven members of the literal `buildBatchConfig` is assigned,
 *   so `BuildBatchConfig.ServiceRole` is checked against THAT set rather than
 *   against the file-global one that the unrelated top-level `serviceRole:`
 *   write also lands in. Keyed by NAME and flattened to any depth, with the
 *   bounds that implies — see the module header's KNOWN BOUNDS section.
 */
export interface ProviderWriteEvidence {
  /**
   * WRITE PATH -> the member names written DIRECTLY beneath it (issue #1464).
   *
   * The key is a dotted chain of written member names in the provider's own
   * (SDK) spelling, so `environment` and `environment.environmentVariables` are
   * different scopes carrying different `type` members. Through #1448 the key
   * was a bare NAME and the value was the flattened transitive closure beneath
   * it, which is precisely why a member could vouch for its same-named cousin
   * one level down.
   *
   * Only a NON-NESTED write opens a root scope: a literal that is lexically
   * inside another object literal is recorded at its parent's path and nowhere
   * else, so `logsConfig: { cloudWatchLogs: { … } }` no longer creates a
   * top-level-looking `cloudWatchLogs` scope.
   */
  readonly scopes: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * WRITE PATHS delivered WHOLE (issue #1445, re-keyed by #1464): the value
   * written at this path is a sub-blob handed to a GENERIC key converter (or
   * forwarded verbatim), so everything AT OR BENEATH the path reaches AWS with
   * no per-member write to find.
   *
   * A path-prefix test is what credits the interior — `containerDefinitions.
   * linuxParameters` covers `containerDefinitions.linuxParameters.capabilities.
   * add` — and it replaces the #1445 fold through the SDK model's reference
   * graph. That fold existed only because a flat scope could not express
   * "beneath"; it also carried the bare-name union bound (an `Items` hand-off
   * reaching 217 CloudFront members), which the prefix test does not have.
   * {@link reachableSdkMemberNames} survives for the parser-regression floor
   * alone ({@link countExpandingHandoffPoints}).
   */
  readonly handoffScopes: ReadonlySet<string>;
  /**
   * Per-hand-off EXCLUSIONS for a SPREAD-AND-PATCH forwarder (issue #1475): a
   * {@link handoffScopes} entry registered from `const result = { ...config }`
   * — a literal spreading a bag-derived SEED inside an otherwise member-naming
   * function — delivers every seed member verbatim EXCEPT the keys the
   * function subsequently `delete`s off the binding. The value is the
   * lowercased first-segment names the wildcard must NOT vouch for; a scope
   * with no entry here (or an empty set) is an ordinary full hand-off.
   *
   * Optional so hand-built evidence objects in tests stay valid; absent means
   * "no exclusions anywhere".
   */
  readonly handoffExclusions?: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Is a path delivered by a WHOLE-BLOB HAND-OFF? Two distinct questions, and they
 * are answered with DIFFERENT strictness on purpose (issue #1464 review):
 *
 *  - ANCESTOR DELIVERY — some prefix of `parentPath` was handed off whole, so
 *    the terminal is delivered by the converter and has no written spelling to
 *    compare at all. The chain is matched case-INSENSITIVELY, the same
 *    relaxation the scope lookup uses and for the same reason
 *    ({@link normalizeWritePath}).
 *  - SELF DELIVERY — the path ITSELF is the hand-off. Here the last segment IS
 *    a written member name, so it is compared VERBATIM: a wildcard spelled
 *    `…CORSRules.ID` must not vouch for an audited `….Id`.
 *
 * The `.` guard on the ancestor test is load-bearing: a plain `startsWith`
 * would let a hand-off of `Cache` vouch for `CacheBehaviors.*`.
 */
export const isHandoffCovered = (
  handoffScopes: ReadonlySet<string>,
  parentPath: string,
  terminal?: string,
  // SPREAD-AND-PATCH exclusions (issue #1475): when the matched scope carries
  // an exclusion set, the FIRST segment beyond the scope decides — a deleted
  // key (and everything beneath it) is not delivered by the spread. A segment
  // the walk cannot determine (no terminal supplied) fails CLOSED.
  exclusions?: ReadonlyMap<string, ReadonlySet<string>>
): boolean => {
  const needle = normalizeWritePath(parentPath);
  for (const scope of handoffScopes) {
    const folded = normalizeWritePath(scope);
    if (needle.length > 0 && (needle === folded || needle.startsWith(`${folded}.`))) {
      const excluded = exclusions?.get(scope);
      if (excluded === undefined || excluded.size === 0) return true;
      const firstBeyond =
        needle === folded
          ? terminal?.toLowerCase()
          : needle.slice(folded.length + 1).split('.')[0]!;
      if (firstBeyond !== undefined && !excluded.has(firstBeyond)) return true;
      continue;
    }
    if (terminal === undefined) continue;
    const cut = scope.lastIndexOf('.');
    const scopeParent = cut === -1 ? '' : scope.slice(0, cut);
    const scopeTerminal = cut === -1 ? scope : scope.slice(cut + 1);
    if (scopeTerminal === terminal && normalizeWritePath(scopeParent) === needle) return true;
  }
  return false;
};

/**
 * The case-folded form a write PATH SEGMENT is matched by.
 *
 * The TERMINAL member is always compared EXACTLY — an exact spelling is the
 * only thing that proves delivery. The
 * PARENT CHAIN is matched case-insensitively, because an intermediate segment's
 * CFn->SDK spelling is routinely NOT the mechanical first-letter flip and the
 * critic has no per-segment style to apply. Measured on
 * `ecs-provider.ts` when the full-depth match first ran (issue #1464): CFn
 * `EFSVolumeConfiguration` is SDK `efsVolumeConfiguration` (not
 * `eFSVolumeConfiguration`), `FSxWindowsFileServerVolumeConfiguration` is
 * `fsxWindowsFileServerVolumeConfiguration`, and `S3FilesVolumeConfiguration`
 * is `s3filesVolumeConfiguration` — all three carrying an explicit provider
 * comment saying so. A case-SENSITIVE parent match reported 16 members those
 * helpers demonstrably DO write, i.e. exactly the allow-list-bait the issue
 * forbids.
 *
 * The fold is applied SEGMENT BY
 * SEGMENT while descending the write index ({@link wholeDeliveredPathsFor}), never as a
 * global lowercase union of the whole index — so `a.Name`'s members are matched
 * against `a`'s own children, and the 80 unrelated `name` / `Name` pairs a
 * whole-file fold merges on `ecs-provider.ts` stay apart. And a spelling
 * difference that is NOT a case difference is out of scope by construction: for
 * that there is {@link NestedKeyTarget.segmentRenames}.
 */
export const normalizeWritePath = (path: string): string => path.toLowerCase();

/**
 * Parameter names that hold the DESIRED-state CFn property bag — the origin
 * every WHOLE-BLOB HAND-OFF has to trace back to (issue #1445). The bag
 * reaches a private helper by call edge, but seeding by NAME keeps the entry
 * points observable.
 *
 * `previousProperties` is deliberately absent: a blob
 * read off the PREVIOUS bag participates in change detection and proves nothing
 * about delivery. And without the taint root at all, `DistributionConfig:
 * config` on `CloudFrontDistributionProvider`'s disable-then-delete path — a
 * whole config read straight off `GetDistributionConfig` and sent back —
 * measured as a hand-off and cleared 108 of CloudFront's 110 findings. That is
 * the rubber stamp this critic must not become.
 */
export const HANDOFF_BAG_PARAM_NAMES: ReadonlySet<string> = new Set([
  'properties',
  'props',
  'newProperties',
  'currentProperties',
  'desiredProperties',
  'resourceProperties',
]);

/**
 * `undefined` / `null` written as an expression — the arm of a
 * `blob ? convert(blob) : undefined` guard that carries no blob and must not
 * disqualify the other arm from being a whole-blob hand-off (issue #1445).
 */
const isNullishExpression = (node: ts.Node): boolean => {
  const e = unwrapExpression(node);
  return (
    e.kind === ts.SyntaxKind.NullKeyword ||
    e.kind === ts.SyntaxKind.UndefinedKeyword ||
    (ts.isIdentifier(e) && e.text === 'undefined')
  );
};

/** Array methods whose callback's RETURN value is the delivered element. */
const CALLBACK_RETURNING_METHODS: ReadonlySet<string> = new Set(['map', 'flatMap', 'reduce']);

/**
 * Array methods that deliver an element (or a subset) of the RECEIVER, so the
 * literals to resolve are the receiver's, not the callback's. `filter` / `find`
 * were briefly in {@link CALLBACK_RETURNING_METHODS}, which is wrong twice
 * over: their callback returns a PREDICATE (so nothing resolves), and the value
 * actually delivered comes from the array being filtered.
 */
const RECEIVER_PRESERVING_METHODS: ReadonlySet<string> = new Set([
  'filter',
  'find',
  'slice',
  'sort',
  'toSorted',
  'reverse',
  'toReversed',
  'at',
]);

/**
 * Array methods that deliver elements of the receiver AND of every argument.
 * Resolving only the receiver would UNDER-credit `base.concat([{ extra: 1 }])`.
 */
const RECEIVER_AND_ARGUMENT_METHODS: ReadonlySet<string> = new Set(['concat']);

/**
 * Array methods whose callback's FIRST parameter is an element of the receiver.
 * Used by the hand-off walk's taint pass (issue #1445): the `def` of
 * `defs.map((def) => …)` is bag data exactly when `defs` is.
 */
const ARRAY_ELEMENT_CALLBACK_METHODS: ReadonlySet<string> = new Set([
  'map',
  'flatMap',
  'filter',
  'find',
  'forEach',
  'some',
  'every',
]);

/**
 * Collect PATH-SCOPED write evidence, AST-level.
 *
 * A write is an object-literal property name (`batchReportMode: value`), a
 * shorthand property (`{ batchReportMode }`), an assignment target
 * (`sdk.batchReportMode = ...` / `sdk['batchReportMode'] = ...` — including the
 * compound forms `??=` / `||=` / `+=`, which are still writes), or an
 * `Object.defineProperty(sdk, 'batchReportMode', { ... })` call. A READ
 * (`desc.batchReportMode` in a non-assignment position) deliberately does NOT
 * count — that asymmetry is what scopes the evidence to the CFn->SDK mapping
 * direction rather than the reverse map.
 *
 * For each write, the VALUE expression is resolved to the object literals it
 * can evaluate to, and the walk DESCENDS: the literal's direct members land in
 * that write's PATH, and each of those members' own values is recorded one
 * segment deeper (issue #1464). `environment` therefore scopes to
 * `{ type, computeType, image, environmentVariables, … }` and
 * `environment.environmentVariables` to `{ name, value, type }` — two different
 * `type` facts, where #1448 flattened both into one. Resolution reaches
 * same-file `this.method(...)` and free-function calls, `const`/`let` bindings, `?:` /
 * `??` / `||` arms, array elements and `.map(cb)` callbacks — because
 * CodeBuild's `source: this.mapSource(source)` and `buildBatchConfig` (a `let`
 * bound to a literal, delivered as a shorthand property) are both that shape.
 *
 * Bodies of {@link REVERSE_MAP_FUNCTION_PREFIXES} are skipped
 * entirely, and a literal that {@link feedsOnlyComparison} contributes nothing.
 *
 * A write whose value is a BUILDER (issue #1474) — a local binding seeded with
 * an object literal and populated afterwards by `out.Foo = …` /
 * `out['Foo'] = …` assignments — has its assigned members credited at the same
 * path a literal's own members get, via {@link resolveBuilders} and
 * {@link walkBuilderAt}. The identity of the binding is what bounds the credit;
 * see the module header's bound (8).
 *
 * A write whose value is a WHOLE-BLOB HAND-OFF into a generic key converter
 * (issue #1445) has no per-member literal to walk, so it is recorded separately
 * as a hand-off PATH — see {@link ProviderWriteEvidence.handoffScopes} and
 * {@link isWholeBlobHandoff}. `resolveImportSource` lets the hand-off walk
 * follow a converter imported from a SIBLING module (`pascalToCamelCaseKeys`
 * lives in `agentcore-case-convert.ts`, not in any provider): without it the
 * only real generic converter in the tree is unresolvable, and an unresolvable
 * callee is deliberately NOT credited.
 */
export function collectWriteEvidence(
  sourceText: string,
  fileName = 'provider.ts',
  excludedFunctionPrefixes: readonly string[] = REVERSE_MAP_FUNCTION_PREFIXES,
  resolveImportSource?: (specifier: string) => string | undefined
): ProviderWriteEvidence {
  const sf = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS
  );
  const scopes = new Map<string, Set<string>>();
  const handoffScopes = new Set<string>();
  const handoffExclusions = new Map<string, Set<string>>();

  /**
   * The written name of an object-literal property. An Identifier IS the name
   * here (`{ batchReportMode: … }`), and a computed name (`{ [k]: … }`) is a
   * `ComputedPropertyName`, which yields nothing.
   */
  const propertyName = (node: ts.Node): string | undefined =>
    ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      ? node.text
      : undefined;
  /**
   * The written name of an element access. Deliberately STRICTER than
   * {@link propertyName}: in `sdk[k] = v` the argument is an Identifier naming
   * a VARIABLE, not a member, so crediting it would let a local called `type`
   * or `name` vouch for an SDK member of that name. Only a literal key counts.
   */
  const elementAccessName = (node: ts.Node): string | undefined =>
    ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
  /**
   * A DESTRUCTURING ASSIGNMENT target (`({ batchReportMode } = desc)`) parses
   * as an object literal on the `left` of an `=`, so its members look like
   * property assignments while being READS off the right-hand side — the same
   * false-credit class as the element-access variable key above. (The
   * DECLARATION form, `const { x } = desc`, is an `ObjectBindingPattern` and
   * never reaches this branch.)
   */
  const isDestructuringTarget = (node: ts.Node): boolean => {
    // Walk to the OUTERMOST pattern node: a destructuring target nests
    // (`({ outer: { batchReportMode } } = desc)`), can sit inside an array
    // pattern (`[{ batchReportMode }] = arr`), and can carry a default
    // (`({ batchReportMode = 1 } = desc)`, whose member is a BinaryExpression
    // the walk passes straight through). A depth-1 check misses all three.
    let current: ts.Node | undefined = node.parent;
    let root: ts.Node | undefined;
    while (
      current !== undefined &&
      (ts.isObjectLiteralExpression(current) ||
        ts.isArrayLiteralExpression(current) ||
        ts.isPropertyAssignment(current) ||
        ts.isShorthandPropertyAssignment(current) ||
        ts.isSpreadAssignment(current) ||
        ts.isSpreadElement(current))
    ) {
      if (ts.isObjectLiteralExpression(current) || ts.isArrayLiteralExpression(current)) {
        root = current;
      }
      current = current.parent;
    }
    if (root === undefined || current === undefined) return false;
    // `= ` assignment, or the binding position of a `for (… of …)` loop.
    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      current.left === root
    ) {
      return true;
    }
    return ts.isForOfStatement(current) && current.initializer === root;
  };

  const isExcludedName = (n: string): boolean =>
    matchesFunctionPrefix(n, excludedFunctionPrefixes);

  // ---- Same-file callable index, so `source: this.mapSource(source)` can be
  // followed into `mapSource`'s returned literal. Excluded (reverse-map)
  // functions are left OUT of the index: a same-named helper on the read side
  // must never vouch for the write side.
  const callables = new Map<string, ts.Node[]>();
  /** Non-function property / variable initializers, for `this.blob` hops. */
  const initializers = new Map<string, ts.Node[]>();
  const indexCallable = (name: string, fn: ts.Node): void => {
    if (isExcludedName(name)) return;
    const list = callables.get(name) ?? [];
    list.push(fn);
    callables.set(name, list);
  };
  const indexInitializer = (name: string, init: ts.Node): void => {
    if (isExcludedName(name)) return;
    const list = initializers.get(name) ?? [];
    list.push(init);
    initializers.set(name, list);
  };
  const indexVisit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      indexCallable(node.name.text, node);
    } else if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      indexCallable(node.name.text, node);
    } else if (
      (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const init = unwrapExpression(node.initializer);
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        indexCallable(node.name.text, init);
      } else if (ts.isPropertyDeclaration(node)) {
        indexInitializer(node.name.text, init);
      }
    }
    ts.forEachChild(node, indexVisit);
  };
  indexVisit(sf);

  /**
   * Callables the WHOLE-BLOB HAND-OFF walk may descend into (issue #1445):
   * every same-file callable, PLUS free functions imported by name from a
   * SIBLING module. The two indexes are kept apart on purpose — widening the
   * general {@link resolveLiterals} index to imported modules would change the
   * scope sets of every target, which is a different change
   * with a different blast radius. The hand-off walk only ever ASKS whether a
   * callee names members of its own, so importing that answer is safe.
   */
  const handoffCallables = new Map<string, ts.Node[]>(
    [...callables].map(([name, fns]) => [name, [...fns]])
  );
  if (resolveImportSource !== undefined) {
    for (const stmt of sf.statements) {
      if (!ts.isImportDeclaration(stmt) || stmt.importClause?.isTypeOnly === true) continue;
      if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      const bindings = stmt.importClause?.namedBindings;
      if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
      const importedSource = resolveImportSource(stmt.moduleSpecifier.text);
      if (importedSource === undefined) continue;
      const importedSf = ts.createSourceFile(
        stmt.moduleSpecifier.text,
        importedSource,
        ts.ScriptTarget.ESNext,
        true,
        ts.ScriptKind.TS
      );
      const exported = new Map<string, ts.Node>();
      for (const s of importedSf.statements) {
        if (ts.isFunctionDeclaration(s) && s.name !== undefined) {
          exported.set(s.name.text, s);
        } else if (ts.isVariableStatement(s)) {
          for (const d of s.declarationList.declarations) {
            if (!ts.isIdentifier(d.name) || d.initializer === undefined) continue;
            const init = unwrapExpression(d.initializer);
            if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
              exported.set(d.name.text, init);
            }
          }
        }
      }
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue;
        const fn = exported.get((element.propertyName ?? element.name).text);
        if (fn === undefined) continue;
        const local = element.name.text;
        if (isExcludedName(local)) continue;
        const list = handoffCallables.get(local) ?? [];
        list.push(fn);
        handoffCallables.set(local, list);
      }
    }
  }

  /**
   * Is `name` a PARAMETER of `scope`? A parameter shadows every outer binding,
   * so the outward climb must not start — otherwise a parameter named `cfg`
   * resolves to an unrelated method's `const cfg = { … }`.
   */
  const isBoundAsParameter = (scope: ts.Node, name: string): boolean => {
    if (!ts.isFunctionLike(scope)) return false;
    return scope.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === name);
  };

  /** The nearest enclosing function body / source file — the binding scope. */
  const enclosingScope = (node: ts.Node): ts.Node => {
    for (let n: ts.Node | undefined = node.parent; n !== undefined; n = n.parent) {
      if (ts.isFunctionLike(n) || ts.isSourceFile(n)) return n;
    }
    return sf;
  };

  /** Every expression a function can RETURN (concise arrow body included). */
  const returnedExpressions = (fn: ts.Node): ts.Expression[] => {
    const body = (fn as ts.SignatureDeclaration & { body?: ts.Node }).body;
    if (body === undefined) return [];
    if (!ts.isBlock(body)) return [body as ts.Expression];
    const out: ts.Expression[] = [];
    const visit = (n: ts.Node): void => {
      // Do not descend into a NESTED function — its returns are its own.
      if (n !== body && ts.isFunctionLike(n)) return;
      if (ts.isReturnStatement(n) && n.expression !== undefined) out.push(n.expression);
      ts.forEachChild(n, visit);
    };
    visit(body);
    return out;
  };

  /**
   * The object literals a value expression can evaluate to. `seen` guards the
   * cycles a `const a = b; const b = a;` pair (or a recursive helper) would
   * otherwise spin on.
   */
  const resolveLiterals = (
    expr: ts.Node,
    seen: Set<ts.Node>
  ): ts.ObjectLiteralExpression[] => {
    const e = unwrapExpression(expr);
    if (seen.has(e)) return [];
    seen.add(e);
    if (ts.isObjectLiteralExpression(e)) return [e];
    if (ts.isConditionalExpression(e)) {
      return [...resolveLiterals(e.whenTrue, seen), ...resolveLiterals(e.whenFalse, seen)];
    }
    if (ts.isBinaryExpression(e)) {
      const k = e.operatorToken.kind;
      if (
        k === ts.SyntaxKind.QuestionQuestionToken ||
        k === ts.SyntaxKind.BarBarToken ||
        k === ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        return [...resolveLiterals(e.left, seen), ...resolveLiterals(e.right, seen)];
      }
      return [];
    }
    if (ts.isArrayLiteralExpression(e)) {
      return e.elements.flatMap((el) => resolveLiterals(el, seen));
    }
    if (ts.isSpreadElement(e)) return resolveLiterals(e.expression, seen);
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
      return returnedExpressions(e).flatMap((r) => resolveLiterals(r, seen));
    }
    if (ts.isCallExpression(e)) {
      const callee = unwrapExpression(e.expression);
      if (ts.isPropertyAccessExpression(callee)) {
        // `xs.map((x) => ({ … }))` delivers the CALLBACK's literal.
        if (CALLBACK_RETURNING_METHODS.has(callee.name.text)) {
          return e.arguments.flatMap((a) => resolveLiterals(a, seen));
        }
        // `xs.filter(p)` delivers an element of the RECEIVER.
        if (RECEIVER_PRESERVING_METHODS.has(callee.name.text)) {
          return resolveLiterals(callee.expression, seen);
        }
        // `xs.concat(ys)` delivers elements of BOTH.
        if (RECEIVER_AND_ARGUMENT_METHODS.has(callee.name.text)) {
          return [
            ...resolveLiterals(callee.expression, seen),
            ...e.arguments.flatMap((a) => resolveLiterals(a, seen)),
          ];
        }
      }
      // Same-file callable, resolved by NAME. Restricted to `this.helper(…)`
      // and a bare `helper(…)`: an earlier revision resolved ANY
      // `receiver.helper(…)`, so an unrelated `client.mapSource(x)` would have
      // been credited with the provider's own `mapSource` literal.
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee) && callee.expression.kind === ts.SyntaxKind.ThisKeyword
          ? callee.name.text
          : undefined;
      if (name === undefined) return [];
      return (callables.get(name) ?? []).flatMap((fn) =>
        returnedExpressions(fn).flatMap((r) => resolveLiterals(r, seen))
      );
    }
    // `this.someBlob` / `Helpers.DEFAULTS` — a property or module constant
    // holding a literal. Same bare-name index as the callable resolution.
    if (ts.isPropertyAccessExpression(e)) {
      return (initializers.get(e.name.text) ?? []).flatMap((init) =>
        resolveLiterals(init, seen)
      );
    }
    if (ts.isIdentifier(e)) {
      // Nearest enclosing function first, then outward — an outer-scope
      // `const DEFAULTS = { … }` used inside a method is a real shape, and not
      // finding it under-credits the write.
      //
      // Two limits keep the climb from reaching into unrelated code. A name
      // bound as a PARAMETER of the nearest scope shadows everything outside
      // it, so the climb never starts. And an OUTER scope is searched WITHOUT
      // descending into its nested functions, so a `const cfg = { … }` in a
      // sibling method cannot resolve another method's `cfg`; only bindings
      // lexically visible from here do. The nearest scope itself IS descended
      // fully, because `let buildBatchConfig` assigned inside an `if` block is
      // the real shape this walk exists for — which also means two disjoint
      // `if` branches binding the same name are unioned (false-NEGATIVE
      // direction; see the module header's KNOWN BOUNDS section).
      const nearest = enclosingScope(e);
      if (isBoundAsParameter(nearest, e.text)) return [];
      for (let scope: ts.Node | undefined = nearest; scope; ) {
        const descendIntoFunctions = scope === nearest;
        const out: ts.ObjectLiteralExpression[] = [];
        const visit = (n: ts.Node): void => {
          if (!descendIntoFunctions && n !== scope && ts.isFunctionLike(n)) return;
          if (
            ts.isVariableDeclaration(n) &&
            ts.isIdentifier(n.name) &&
            n.name.text === e.text &&
            n.initializer !== undefined
          ) {
            out.push(...resolveLiterals(n.initializer, seen));
          } else if (
            ts.isBinaryExpression(n) &&
            isWriteAssignment(n.operatorToken.kind) &&
            ts.isIdentifier(n.left) &&
            n.left.text === e.text
          ) {
            out.push(...resolveLiterals(n.right, seen));
          }
          ts.forEachChild(n, visit);
        };
        visit(scope);
        if (out.length > 0) return out;
        scope = ts.isSourceFile(scope) ? undefined : enclosingScope(scope);
      }
      return [];
    }
    return [];
  };

  /**
   * The name of a callee the hand-off walk can resolve — a bare `helper(…)` or
   * a `this.helper(…)`, never a `receiver.helper(…)` on some other object (the
   * same restriction {@link resolveLiterals} carries, and for the same reason:
   * borrowing an unrelated object's same-named method is a false credit).
   */
  const resolvableCalleeName = (call: ts.CallExpression): string | undefined => {
    const callee = unwrapExpression(call.expression);
    if (ts.isIdentifier(callee)) return callee.text;
    return ts.isPropertyAccessExpression(callee) &&
      callee.expression.kind === ts.SyntaxKind.ThisKeyword
      ? callee.name.text
      : undefined;
  };

  /**
   * {@link propertyName}, plus the COMPUTED-but-literal form `{ ['Foo']: v }`.
   * Used only by {@link namesOwnMember}, where missing it would let a converter
   * name members through a spelling the write collector ignores; the write set
   * itself deliberately stays on the stricter {@link propertyName}.
   */
  const memberNameOfPropertyName = (node: ts.Node): string | undefined => {
    if (ts.isComputedPropertyName(node)) return elementAccessName(node.expression);
    return propertyName(node);
  };

  /** Memo for the ORDER-INDEPENDENT half of {@link isGenericConverter}. */
  const namesMemberCache = new Map<ts.Node, boolean>();

  // ---- PROPERTY-BAG TAINT, the ROOT of the whole-blob hand-off walk (#1445).
  // Declaration-scoped, never bare-name: `cloudfront-distribution-provider.ts`
  // binds the template's config AND the AWS-returned one to identifiers that
  // share the name `config` in different methods, so a name-keyed taint set
  // would credit the delete path's `GetDistributionConfig` echo.

  /**
   * A scope boundary for a `const` / `let` binding. FUNCTION scope is not
   * enough: `const` is BLOCK-scoped, and treating a whole function as one
   * namespace is what let two same-named builders in different `if` arms
   * collapse onto one declaration (issue #1474 review).
   */
  const isBindingScope = (n: ts.Node): boolean =>
    ts.isSourceFile(n) ||
    ts.isBlock(n) ||
    ts.isModuleBlock(n) ||
    ts.isCaseBlock(n) ||
    ts.isForStatement(n) ||
    ts.isForInStatement(n) ||
    ts.isForOfStatement(n) ||
    ts.isCatchClause(n) ||
    ts.isFunctionLike(n);

  /**
   * A variable of this name declared DIRECTLY in `scope` — never one owned by
   * a nested block or function, which has its own namespace.
   */
  const declaredDirectlyIn = (scope: ts.Node, name: string): ts.VariableDeclaration | undefined => {
    let found: ts.VariableDeclaration | undefined;
    const visit = (n: ts.Node): void => {
      if (found !== undefined) return;
      if (isBindingScope(n)) return;
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) {
        found = n;
        return;
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(scope, visit);
    return found;
  };

  /**
   * The declaration a plain identifier resolves to, searched lexically OUTWARD
   * from the reference through its enclosing BINDING scopes.
   *
   * Through #1474 this searched the nearest FUNCTION scope and descended fully
   * into nested functions, taking the first textual match — which meant the
   * bare-name weakness of known bound (3) reached inside a single function in
   * two measurable ways (found by the #1474 review, neither live in the tree
   * but both one edit away):
   *   - two `const cfg = {}` builders in different `if` arms collapsed onto the
   *     first declaration, so their member sets MERGED and each vouched for the
   *     other's blob — the false-CREDIT direction;
   *   - a `const cfg` inside a nested arrow declared textually FIRST captured
   *     the enclosing function's own `cfg`, inverting both verdicts (the outer
   *     member falsely missed, the inner one falsely credited).
   * Walking outward block by block is the accurate lexical model and closes
   * both; the shapes are pinned by tests. It cannot under-resolve a valid
   * `const` / `let` either, since a reference outside the declaring block is a
   * compile error — the only thing the old full descent additionally reached
   * was a `var`, which no provider in the tree uses.
   */
  function declarationOf(id: ts.Identifier): ts.Node | undefined {
    for (let scope: ts.Node | undefined = id.parent; scope !== undefined; scope = scope.parent) {
      if (!isBindingScope(scope)) continue;
      const declared = declaredDirectlyIn(scope, id.text);
      if (declared !== undefined) return declared;
      if (ts.isFunctionLike(scope)) {
        const parameter = scope.parameters.find(
          (p) => ts.isIdentifier(p.name) && p.name.text === id.text
        );
        if (parameter !== undefined) return parameter;
      }
    }
    return undefined;
  }

  const tainted = new Set<ts.Node>();

  /** Does this expression carry data that came out of the property bag? */
  function isBagDerived(expr: ts.Node, seen: Set<ts.Node>): boolean {
    const e = unwrapExpression(expr);
    if (seen.has(e)) return false;
    seen.add(e);
    if (ts.isIdentifier(e)) {
      const declaration = declarationOf(e);
      return declaration !== undefined && tainted.has(declaration);
    }
    if (ts.isElementAccessExpression(e) || ts.isPropertyAccessExpression(e)) {
      return isBagDerived(e.expression, seen);
    }
    if (ts.isConditionalExpression(e)) {
      return isBagDerived(e.whenTrue, seen) || isBagDerived(e.whenFalse, seen);
    }
    if (ts.isBinaryExpression(e)) {
      return isBagDerived(e.left, seen) || isBagDerived(e.right, seen);
    }
    if (ts.isObjectLiteralExpression(e)) {
      return e.properties.some(
        (p) => ts.isSpreadAssignment(p) && isBagDerived(p.expression, seen)
      );
    }
    if (ts.isArrayLiteralExpression(e)) {
      return e.elements.some((el) => isBagDerived(el, seen));
    }
    if (ts.isSpreadElement(e)) return isBagDerived(e.expression, seen);
    if (ts.isCallExpression(e)) {
      const callee = unwrapExpression(e.expression);
      if (ts.isPropertyAccessExpression(callee) && isBagDerived(callee.expression, seen)) {
        return true; // `bag.map(...)` / `bag.filter(...)` — still bag data.
      }
      const name = resolvableCalleeName(e);
      if (name === undefined) return false;
      return (handoffCallables.get(name) ?? []).some((fn) =>
        returnedExpressions(fn).some((r) => isBagDerived(r, seen))
      );
    }
    return false;
  }

  /**
   * Taint the property-bag parameters, then propagate to fixpoint: a binding
   * initialized (or assigned) from bag data, a callee parameter handed bag data
   * at a resolvable call site, an array-callback parameter iterating bag
   * data, and a `for (const x of bag)` loop variable (issue #1540 — the
   * statement-form twin of the callback hop). Three iterations settle the
   * real tree; the loop is bounded anyway.
   */
  const seedTaint = (): void => {
    const collectRoots = (n: ts.Node): void => {
      if (
        ts.isParameter(n) &&
        ts.isIdentifier(n.name) &&
        HANDOFF_BAG_PARAM_NAMES.has(n.name.text)
      ) {
        tainted.add(n);
      }
      ts.forEachChild(n, collectRoots);
    };
    collectRoots(sf);

    const taintParameter = (fn: ts.Node, index: number): boolean => {
      const params = (fn as ts.SignatureDeclaration).parameters;
      const parameter = params?.[index];
      if (parameter === undefined || tainted.has(parameter)) return false;
      tainted.add(parameter);
      return true;
    };

    for (let pass = 0; pass < 8; pass++) {
      let changed = false;
      const propagate = (n: ts.Node): void => {
        if (
          ts.isVariableDeclaration(n) &&
          n.initializer !== undefined &&
          !tainted.has(n) &&
          isBagDerived(n.initializer, new Set())
        ) {
          tainted.add(n);
          changed = true;
        } else if (
          ts.isBinaryExpression(n) &&
          n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(n.left) &&
          isBagDerived(n.right, new Set())
        ) {
          const declaration = declarationOf(n.left);
          if (declaration !== undefined && !tainted.has(declaration)) {
            tainted.add(declaration);
            changed = true;
          }
        } else if (
          ts.isForOfStatement(n) &&
          ts.isVariableDeclarationList(n.initializer) &&
          isBagDerived(n.expression, new Set())
        ) {
          // `for (const config of configs)` — the element of a bag-derived
          // array is bag data, the statement-form twin of the `.map((element)
          // => …)` callback hop below (issue #1540). Without it every
          // per-item S3 config loop (`applyMetricsConfigurations` etc.) broke
          // the taint chain at the loop variable, so a verbatim
          // `Tags: tagFilters` forward inside the loop never registered as a
          // whole-blob hand-off.
          for (const d of n.initializer.declarations) {
            if (!tainted.has(d)) {
              tainted.add(d);
              changed = true;
            }
          }
        } else if (ts.isCallExpression(n)) {
          const callee = unwrapExpression(n.expression);
          // `bag.map((element) => …)` taints the callback's element parameter.
          if (
            ts.isPropertyAccessExpression(callee) &&
            ARRAY_ELEMENT_CALLBACK_METHODS.has(callee.name.text) &&
            isBagDerived(callee.expression, new Set())
          ) {
            for (const argument of n.arguments) {
              const fn = unwrapExpression(argument);
              if (
                (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
                taintParameter(fn, 0)
              ) {
                changed = true;
              }
            }
          }
          const name = ts.isIdentifier(callee)
            ? callee.text
            : ts.isPropertyAccessExpression(callee) &&
                callee.expression.kind === ts.SyntaxKind.ThisKeyword
              ? callee.name.text
              : undefined;
          if (name !== undefined) {
            const fns = handoffCallables.get(name) ?? [];
            n.arguments.forEach((argument, index) => {
              if (!isBagDerived(argument, new Set())) return;
              for (const fn of fns) {
                if (taintParameter(fn, index)) changed = true;
              }
            });
          }
        }
        ts.forEachChild(n, propagate);
      };
      propagate(sf);
      if (!changed) break;
    }
  };
  seedTaint();

  /**
   * Does this function NAME a member — anywhere in its body, OR inside any
   * callee it can reach? A generic key converter is mechanical: every key it
   * emits came from the input, so it writes only through COMPUTED names
   * (`result[camelKey] = …`). One fixed member name (an object-literal
   * property including a computed-but-literal `{ ['Foo']: v }`, a shorthand, or
   * an `o.Foo = …` / `o['Foo'] = …` assignment) means per-member re-shaping,
   * which is exactly what has to keep proving itself write by write.
   *
   * TRANSITIVE, not body-local, and that is load-bearing rather than tidy. A
   * body-local test accepts the DELEGATING GUARD —
   *
   *     private convertLog(cfg?: Record<string, unknown>) {
   *       if (!cfg) return cfg;          // <- an existential delivery test passes HERE
   *       return this.buildLog(cfg);     // <- while the real work names members
   *     }
   *
   * — because `convertLog` itself names nothing and one of its returns is the
   * parameter outright. That is a false hand-off credit, so the
   * check descends into `buildLog`. (The delivery test cannot be tightened to
   * `.every` instead: `pascalToCamelCaseKeys` returns `result`, a binding to an
   * empty literal, so requiring EVERY return to deliver rejects the one real
   * generic converter in the tree.)
   *
   * Deliberately fail-CLOSED and deliberately crude in the other direction too:
   * `{ ...blob, Extra: 1 }` still delivers `blob` whole, but naming `Extra`
   * disqualifies the function. The cost of that is a target that keeps flagging
   * (visible); the cost of the opposite is a silent clear.
   *
   * What it does NOT catch is a converter that names nothing AND still drops or
   * renames keys — a filtering `if (DROP.has(key)) continue`, a rename-map
   * `out[MAP[key] ?? key] = v`, a `pick(blob, KEEP)`. See known bound (5) in the
   * module header: no such shape is a hand-off callee in the tree today, and the
   * honest statement is "names no member", NOT "can only emit keys it read".
   */
  function namesOwnMember(fn: ts.Node, seenFns: Set<ts.Node> = new Set()): boolean {
    if (seenFns.has(fn)) return false; // recursion: judged by its other paths
    seenFns.add(fn);
    const body = (fn as ts.SignatureDeclaration & { body?: ts.Node }).body;
    if (body === undefined) return false;
    let found = false;
    const visit = (n: ts.Node): void => {
      if (found) return;
      if (ts.isPropertyAssignment(n) && memberNameOfPropertyName(n.name) !== undefined) {
        found = true;
      } else if (ts.isShorthandPropertyAssignment(n)) found = true;
      else if (ts.isBinaryExpression(n) && isWriteAssignment(n.operatorToken.kind)) {
        if (ts.isPropertyAccessExpression(n.left)) found = true;
        else if (
          ts.isElementAccessExpression(n.left) &&
          elementAccessName(n.left.argumentExpression) !== undefined
        ) {
          found = true;
        }
      } else if (ts.isCallExpression(n)) {
        const name = resolvableCalleeName(n);
        if (
          name !== undefined &&
          (handoffCallables.get(name) ?? []).some((callee) => namesOwnMember(callee, seenFns))
        ) {
          found = true;
        }
      }
      if (!found) ts.forEachChild(n, visit);
    };
    visit(body);
    return found;
  }

  const genericConverterCache = new Map<ts.Node, boolean>();
  /**
   * Is this function a GENERIC KEY CONVERTER — a mechanical whole-object
   * transform that (a) names no member of its own or of anything it calls, and
   * (b) actually RETURNS its input blob (possibly through another generic
   * converter), rather than only measuring or comparing it?
   *
   * `pascalToCamelCaseKeys` passes on both counts: it writes only
   * `result[camelKey]`, and its guard arm `return value` returns the parameter
   * outright. `ECSProvider.convertLinuxParameters` passes because its single
   * return is `pascalToCamelCaseKeys(config)` — and, under the transitive (a),
   * only because that callee names nothing either. `convertContainerDefinitions`
   * (45 named members) and `CloudFrontDistributionProvider.convertToSdkFormat`
   * (a spread-and-patch that names 30+) both fail (a) directly; a converter that
   * delegates the naming to a helper fails it transitively.
   */
  function isGenericConverter(fn: ts.Node, seen: Set<ts.Node>): boolean {
    const cached = genericConverterCache.get(fn);
    if (cached !== undefined) return cached;
    if (seen.has(fn)) return true; // a recursive converter: judged by its other arms
    seen.add(fn);
    const params = (fn as ts.SignatureDeclaration).parameters;
    // (a) is cached on its own: it depends only on the function and the callable
    // index, so unlike the composite verdict it is order-INDEPENDENT.
    let names = namesMemberCache.get(fn);
    if (names === undefined) {
      names = params === undefined || params.length === 0 || namesOwnMember(fn);
      namesMemberCache.set(fn, names);
    }
    if (names) {
      genericConverterCache.set(fn, false);
      return false;
    }
    // (b) is NOT cached: `deliversWholeBlob` consults the caller-shared `seen`
    // cycle guard, so a `false` here can be an artifact of the traversal order
    // rather than a property of `fn`. Caching it would make the verdict
    // order-dependent; recomputing is cheap because (a) already rejected the
    // large converters.
    const verdict = returnedExpressions(fn).some((r) => deliversWholeBlob(r, seen));
    if (verdict) genericConverterCache.set(fn, true);
    return verdict;
  }

  /**
   * Does this expression deliver a WHOLE BLOB — a value read off the property
   * bag (or a converter's own parameter) that reaches the write with no member
   * of it named along the way?
   *
   * SEED     — a BAG-DERIVED element / property access (`def['LinuxParameters']`),
   *            an identifier bound to one, or a bag-tainted PARAMETER (which is
   *            what makes a converter body's `config` a seed rather than an
   *            unresolvable identifier). Bag-derivation is the load-bearing half:
   *            without it a whole config read back off `GetDistributionConfig`
   *            and re-sent looks identical to a template forward.
   * PROPAGATE— `?:` / `??` / `||` / `&&` arms, a spread-only object literal,
   *            and a call handing the seed WHOLE to a same-file or
   *            sibling-module callee that {@link isGenericConverter} accepts.
   * DELIVERY — the caller records this only where a WRITE takes the value, so
   *            reaching here already means the value is written somewhere; a
   *            value that only feeds a comparison is refused by the caller's
   *            {@link feedsOnlyComparison} guard.
   *
   * Every unhandled shape returns false. An UNRESOLVABLE callee is therefore
   * not credited, and that under-credit is why `resolveImportSource` exists at
   * all.
   */
  function deliversWholeBlob(expr: ts.Node, seen: Set<ts.Node>, seedKeys?: Set<string>): boolean {
    const e = unwrapExpression(expr);
    if (seen.has(e)) return false;
    seen.add(e);
    if (ts.isElementAccessExpression(e) || ts.isPropertyAccessExpression(e)) {
      if (!isBagDerived(e, new Set())) return false;
      // A member whose SUBTREE the function deletes into is not delivered
      // whole (issue #1475 review): `delete config['VC']['Id']` mutates the
      // very object `config['VC']` then forwards. Deletes on the root binding
      // are recorded by FIRST segment, so the accessed member's name showing
      // up there refuses the forward — loud, since no literal remains to
      // register a bounded credit for an opaque access.
      let rootExpr: ts.Node = e;
      let firstSegment: string | undefined;
      while (ts.isElementAccessExpression(rootExpr) || ts.isPropertyAccessExpression(rootExpr)) {
        firstSegment = ts.isPropertyAccessExpression(rootExpr)
          ? rootExpr.name.text
          : elementAccessName(unwrapExpression(rootExpr.argumentExpression));
        rootExpr = unwrapExpression(rootExpr.expression);
      }
      if (ts.isIdentifier(rootExpr)) {
        const rootDeclaration = declarationOf(rootExpr);
        if (
          rootDeclaration !== undefined &&
          (ts.isVariableDeclaration(rootDeclaration) || ts.isParameter(rootDeclaration))
        ) {
          const rootDeletes = deleteExclusionsOf(rootDeclaration);
          if (rootDeletes === undefined) return false;
          if (rootDeletes.size > 0) {
            if (firstSegment === undefined) return false;
            if (rootDeletes.has(firstSegment.toLowerCase())) return false;
          }
        }
      }
      const key = ts.isElementAccessExpression(e)
        ? elementAccessName(e.argumentExpression)
        : e.name.text;
      if (key !== undefined) seedKeys?.add(key);
      return true;
    }
    if (ts.isIdentifier(e)) {
      // A binding — or a PARAMETER — the function `delete`s keys off does NOT
      // deliver the whole blob (issue #1475, its review for the parameter
      // half): refusing here hands the site to the BOUNDED spread
      // registration in `walkLiteralAt`, which carries the deleted keys as
      // exclusions. Without this, `const vc = { ...bag }; delete vc[k];`
      // registered a FULL hand-off (and `delete config['X']` before a
      // verbatim forward was invisible entirely) and the exclusion fence
      // never fired.
      const declaration = declarationOf(e);
      if (
        declaration !== undefined &&
        (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration))
      ) {
        const deletes = deleteExclusionsOf(declaration);
        if (deletes === undefined || deletes.size > 0) return false;
      }
      const nearest = enclosingScope(e);
      if (isBoundAsParameter(nearest, e.text)) return isBagDerived(e, new Set());
      const bindings = identifierBindings(e);
      return (
        bindings.length > 0 && bindings.every((b) => deliversWholeBlob(b, seen, seedKeys))
      );
    }
    if (ts.isConditionalExpression(e)) {
      const arms = [e.whenTrue, e.whenFalse].filter((a) => !isNullishExpression(a));
      return arms.length > 0 && arms.every((a) => deliversWholeBlob(a, seen, seedKeys));
    }
    if (ts.isBinaryExpression(e)) {
      const k = e.operatorToken.kind;
      if (k === ts.SyntaxKind.AmpersandAmpersandToken) {
        return deliversWholeBlob(e.right, seen, seedKeys);
      }
      if (k === ts.SyntaxKind.QuestionQuestionToken || k === ts.SyntaxKind.BarBarToken) {
        const arms = [e.left, e.right].filter((a) => !isNullishExpression(a));
        return arms.length > 0 && arms.every((a) => deliversWholeBlob(a, seen, seedKeys));
      }
      return false;
    }
    if (ts.isObjectLiteralExpression(e)) {
      // `{ ...blob }` — a spread-ONLY literal re-delivers every member.
      return (
        e.properties.length > 0 &&
        e.properties.every(
          (p) => ts.isSpreadAssignment(p) && deliversWholeBlob(p.expression, seen, seedKeys)
        )
      );
    }
    if (ts.isCallExpression(e)) {
      const name = resolvableCalleeName(e);
      if (name === undefined) return false;
      const fns = handoffCallables.get(name) ?? [];
      if (fns.length === 0) return false;
      return (
        fns.every((fn) => isGenericConverter(fn, seen)) &&
        e.arguments.some((a) => deliversWholeBlob(a, seen, seedKeys))
      );
    }
    return false;
  }

  /**
   * Every VALUE a plain identifier can hold. Mirrors {@link resolveLiterals}'s
   * identifier branch — nearest function scope descended fully, then outward
   * without entering sibling functions — with one deliberate difference: it
   * stops at the first scope carrying a BINDING, where `resolveLiterals` climbs
   * past a binding that yields no object literal. For a hand-off a binding to a
   * NON-literal (`const single = properties['X']`) is the interesting case, so
   * climbing past it would resolve the name against an unrelated outer one.
   */
  function identifierBindings(id: ts.Identifier): ts.Node[] {
    const nearest = enclosingScope(id);
    for (let scope: ts.Node | undefined = nearest; scope; ) {
      const descendIntoFunctions = scope === nearest;
      const out: ts.Node[] = [];
      const visit = (n: ts.Node): void => {
        if (!descendIntoFunctions && n !== scope && ts.isFunctionLike(n)) return;
        if (
          ts.isVariableDeclaration(n) &&
          ts.isIdentifier(n.name) &&
          n.name.text === id.text &&
          n.initializer !== undefined
        ) {
          out.push(n.initializer);
        } else if (
          ts.isBinaryExpression(n) &&
          isWriteAssignment(n.operatorToken.kind) &&
          ts.isIdentifier(n.left) &&
          n.left.text === id.text
        ) {
          out.push(n.right);
        }
        ts.forEachChild(n, visit);
      };
      visit(scope);
      if (out.length > 0) return out;
      scope = ts.isSourceFile(scope) ? undefined : enclosingScope(scope);
    }
    return [];
  }

  // ---- THE BUILDER IDIOM (issue #1474). A local binding seeded with a FRESH
  // object literal and then populated by property assignments is a per-member
  // write the literal walk cannot see: `resolveLiterals` resolves the
  // identifier to the (empty or partial) seed and stops, while the members are
  // written onto the binding afterwards. The three helpers below recognize the
  // shape; `walkBuilderAt` credits it at the SAME path the literal case gets.

  /**
   * The declaration `id` resolves to, when that declaration is a BUILDER SEED:
   * a variable initialized with an OBJECT LITERAL.
   *
   * The literal initializer is what makes the object's identity KNOWN — the
   * binding holds an object this file created, so an assignment onto the
   * binding is a write of a member this file delivers. Every other
   * initializer shape (`const out = makeThing()`, `let out;` assigned later,
   * a PARAMETER — which {@link declarationOf} can also return) is refused:
   * the object may be someone else's, and crediting members written onto it
   * would be crediting a write we cannot attribute. Under-crediting flags
   * correct code (loud); over-crediting silences a real drop (silent).
   *
   * A binding REASSIGNED as a whole (`let out = {}; out.Foo = 1;
   * out = opaque(props);`) is refused for the same reason and was NOT until
   * the #1474 review caught it: only the initializer was inspected, so the
   * seed's members were credited even though the value actually delivered is
   * the opaque one. That is the false-CREDIT direction, so the whole binding is
   * dropped rather than the walk trying to order the two.
   */
  const reassignedBindings = new Map<ts.VariableDeclaration, boolean>();
  const isWhollyReassigned = (declaration: ts.VariableDeclaration): boolean => {
    const cached = reassignedBindings.get(declaration);
    if (cached !== undefined) return cached;
    if (!ts.isIdentifier(declaration.name)) return false;
    const name = declaration.name.text;
    let found = false;
    const visit = (n: ts.Node): void => {
      if (found) return;
      if (
        ts.isBinaryExpression(n) &&
        isWriteAssignment(n.operatorToken.kind) &&
        ts.isIdentifier(n.left) &&
        n.left.text === name &&
        declarationOf(n.left) === declaration
      ) {
        found = true;
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(enclosingScope(declaration));
    reassignedBindings.set(declaration, found);
    return found;
  };

  const builderDeclarationOf = (id: ts.Identifier): ts.VariableDeclaration | undefined => {
    const declaration = declarationOf(id);
    if (declaration === undefined || !ts.isVariableDeclaration(declaration)) return undefined;
    if (declaration.initializer === undefined) return undefined;
    const seed = unwrapExpression(declaration.initializer);
    if (!ts.isObjectLiteralExpression(seed)) return undefined;
    return isWhollyReassigned(declaration) ? undefined : declaration;
  };

  /**
   * The member CHAIN an assignment target walks from a builder binding
   * (`out.Foo = v` -> `['Foo']`, `out['A'].B = v` -> `['A', 'B']`), or
   * `undefined` when the target is not rooted at `declaration`.
   *
   * The root test is DECLARATION IDENTITY, never the bare name: an unrelated
   * local also called `out` in a sibling method resolves to its OWN
   * declaration and contributes nothing here. That is the bare-name weakness
   * recorded as known bound (3) in the module header, deliberately not
   * inherited by this recognizer.
   *
   * A computed key that is not a literal (`out[k] = v`) yields nothing, the
   * same strictness {@link elementAccessName} applies everywhere else: `k`
   * names a VARIABLE, not a member.
   */
  const builderAssignmentChain = (
    lhs: ts.Node,
    declaration: ts.VariableDeclaration
  ): string[] | undefined => {
    const segments: string[] = [];
    let current: ts.Node = lhs;
    for (;;) {
      const e = unwrapExpression(current);
      if (ts.isPropertyAccessExpression(e)) {
        segments.unshift(e.name.text);
        current = e.expression;
        continue;
      }
      if (ts.isElementAccessExpression(e)) {
        const name = elementAccessName(unwrapExpression(e.argumentExpression));
        if (name === undefined) return undefined;
        segments.unshift(name);
        current = e.expression;
        continue;
      }
      if (!ts.isIdentifier(e) || segments.length === 0) return undefined;
      return declarationOf(e) === declaration ? segments : undefined;
    }
  };

  const builderMemberCache = new Map<
    ts.VariableDeclaration,
    Array<{ chain: string[]; value: ts.Node }>
  >();
  /**
   * Every member assigned onto a builder binding, searched in the binding's
   * OWN declaration scope and descended fully — an `if` arm, a loop body and a
   * callback are all legitimate places to populate a builder, and the identity
   * test above is what keeps the full descent safe.
   *
   * Bodies of {@link REVERSE_MAP_FUNCTION_PREFIXES} are skipped here too: a
   * reverse SDK->CFn helper nested inside the builder's scope must not vouch
   * for the forward direction, exactly as in the main walk.
   */
  const builderMembers = (
    declaration: ts.VariableDeclaration
  ): Array<{ chain: string[]; value: ts.Node }> => {
    const cached = builderMemberCache.get(declaration);
    if (cached !== undefined) return cached;
    const members: Array<{ chain: string[]; value: ts.Node }> = [];
    // Registered BEFORE the walk so a self-referential builder cannot re-enter.
    builderMemberCache.set(declaration, members);
    const visitScope = (n: ts.Node, excluded: boolean): void => {
      let inExcluded = excluded;
      if (!inExcluded) {
        const name = declaredFunctionName(n);
        if (name !== undefined && isExcludedName(name)) inExcluded = true;
      }
      if (!inExcluded && ts.isBinaryExpression(n) && isWriteAssignment(n.operatorToken.kind)) {
        const chain = builderAssignmentChain(n.left, declaration);
        if (chain !== undefined) members.push({ chain, value: n.right });
      }
      ts.forEachChild(n, (child) => visitScope(child, inExcluded));
    };
    visitScope(enclosingScope(declaration), false);
    return members;
  };

  /**
   * The BUILDERS a value expression can evaluate to — the builder twin of
   * {@link resolveLiterals}, following the same hops for the same reasons
   * (`?:` / `??` arms, array elements, `.map(cb)` callbacks, and a same-file
   * callee's returns, which is how `Configuration: buildPutParams(props)`
   * reaches a builder declared inside `buildPutParams`).
   *
   * Kept SEPARATE from {@link resolveLiterals} rather than folded into it: that
   * function's identifier branch resolves by BARE NAME across enclosing scopes,
   * and the builder credit must not inherit that looseness.
   *
   * An OBJECT LITERAL deliberately yields nothing here — `{ ...out }` is
   * handled by {@link walkLiteralAt}'s spread branch, which merges the
   * builder's members at the literal's own path, so a `return { ...out, Extra: 1 }`
   * credits both halves at one level.
   */
  const resolveBuilders = (expr: ts.Node, seen: Set<ts.Node>): ts.VariableDeclaration[] => {
    const e = unwrapExpression(expr);
    if (seen.has(e)) return [];
    seen.add(e);
    if (ts.isIdentifier(e)) {
      const declaration = builderDeclarationOf(e);
      if (declaration !== undefined) return [declaration];
      // Issue #1540: a builder can sit BEHIND a plain binding — `const rules =
      // cfg.Rules.map((r) => { const sdkRule = { … }; sdkRule.X = …; return
      // sdkRule; })` delivered as `Rules: rules`. The identifier itself is not
      // a builder (its initializer is no literal seed), but the value it HOLDS
      // may resolve to one, and {@link resolveLiterals} already makes exactly
      // this hop for the seed's members — so refusing it here split one value
      // into "seed credited, mutations lost" (measured on the real
      // `s3-bucket-provider.ts` lifecycle mapper: `LifecycleConfiguration.Rules`
      // carried only the seed's `ID`/`Status`/`Prefix`). The hop keeps the
      // recognizer's strictness: declaration IDENTITY via `declarationOf`
      // (never bare-name), and a wholly-reassigned binding stays refused for
      // the same false-CREDIT reason `builderDeclarationOf` refuses it.
      const plain = declarationOf(e);
      if (
        plain !== undefined &&
        ts.isVariableDeclaration(plain) &&
        plain.initializer !== undefined &&
        !isWhollyReassigned(plain)
      ) {
        return resolveBuilders(plain.initializer, seen);
      }
      return [];
    }
    if (ts.isConditionalExpression(e)) {
      return [...resolveBuilders(e.whenTrue, seen), ...resolveBuilders(e.whenFalse, seen)];
    }
    if (ts.isBinaryExpression(e)) {
      const k = e.operatorToken.kind;
      if (
        k === ts.SyntaxKind.QuestionQuestionToken ||
        k === ts.SyntaxKind.BarBarToken ||
        k === ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        return [...resolveBuilders(e.left, seen), ...resolveBuilders(e.right, seen)];
      }
      return [];
    }
    if (ts.isArrayLiteralExpression(e)) {
      return e.elements.flatMap((el) => resolveBuilders(el, seen));
    }
    if (ts.isSpreadElement(e)) return resolveBuilders(e.expression, seen);
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
      return returnedExpressions(e).flatMap((r) => resolveBuilders(r, seen));
    }
    if (ts.isCallExpression(e)) {
      const callee = unwrapExpression(e.expression);
      if (ts.isPropertyAccessExpression(callee)) {
        if (CALLBACK_RETURNING_METHODS.has(callee.name.text)) {
          return e.arguments.flatMap((a) => resolveBuilders(a, seen));
        }
        if (RECEIVER_PRESERVING_METHODS.has(callee.name.text)) {
          return resolveBuilders(callee.expression, seen);
        }
        if (RECEIVER_AND_ARGUMENT_METHODS.has(callee.name.text)) {
          return [
            ...resolveBuilders(callee.expression, seen),
            ...e.arguments.flatMap((a) => resolveBuilders(a, seen)),
          ];
        }
      }
      const name = resolvableCalleeName(e);
      if (name === undefined) return [];
      return (callables.get(name) ?? []).flatMap((fn) =>
        returnedExpressions(fn).flatMap((r) => resolveBuilders(r, seen))
      );
    }
    return [];
  };

  // ---- THE SPREAD-AND-PATCH FORWARDER (issue #1475). A literal that SPREADS
  // a bag-derived seed (`const result = { ...config }` where `config` carries
  // the taint root) delivers every seed member VERBATIM at the literal's write
  // path — inside an otherwise member-naming function, which is exactly what
  // the genericity test (correctly, by its own rule) rejects. The named
  // patches around the spread are already credited by the literal / builder
  // walks; what was missing is the wildcard for the members the patches never
  // touch. The wildcard is BOUNDED: a key the function subsequently `delete`s
  // off the binding is NOT delivered (a rename that writes the WRONG SDK key
  // would otherwise be vouched for by the spread it just removed the key
  // from), and a delete whose key set cannot be resolved refuses the whole
  // registration — fail CLOSED, the same direction every other refusal here
  // takes. See the module header's bound (9) for what is deliberately NOT
  // excluded (overwritten members, verbatim spelling).

  /**
   * The literal names a computed KEY expression can take, resolved through the
   * one shape the real tree uses: a `for (const k of TABLE)` /
   * `for (const [k, v] of Object.entries(TABLE))` /
   * `for (const k of Object.keys(TABLE))` loop over a LITERAL table. Returns
   * `undefined` when the key cannot be bounded — the caller fails CLOSED.
   */
  const literalObjectOf = (expr: ts.Node): ts.ObjectLiteralExpression | undefined => {
    const e = unwrapExpression(expr);
    if (ts.isObjectLiteralExpression(e)) return e;
    if (!ts.isIdentifier(e)) return undefined;
    const declaration = declarationOf(e);
    if (
      declaration === undefined ||
      !ts.isVariableDeclaration(declaration) ||
      declaration.initializer === undefined ||
      // A reassigned table no longer holds its initial literal — resolving it
      // anyway would under-exclude off stale keys (#1475 review).
      isWhollyReassigned(declaration)
    ) {
      return undefined;
    }
    const init = unwrapExpression(declaration.initializer);
    return ts.isObjectLiteralExpression(init) ? init : undefined;
  };
  const literalKeysOfObject = (lit: ts.ObjectLiteralExpression): string[] | undefined => {
    const keys: string[] = [];
    for (const p of lit.properties) {
      if (!ts.isPropertyAssignment(p)) return undefined;
      const name = propertyName(p.name);
      if (name === undefined) return undefined;
      keys.push(name);
    }
    return keys;
  };
  const literalValuesOfObject = (lit: ts.ObjectLiteralExpression): string[] | undefined => {
    const values: string[] = [];
    for (const p of lit.properties) {
      if (!ts.isPropertyAssignment(p)) return undefined;
      const v = unwrapExpression(p.initializer);
      if (!ts.isStringLiteral(v) && !ts.isNoSubstitutionTemplateLiteral(v)) return undefined;
      values.push(v.text);
    }
    return values;
  };
  const loopKeyNames = (
    declaration: ts.VariableDeclaration,
    elementIndex: number | undefined
  ): string[] | undefined => {
    const list = declaration.parent;
    if (list === undefined || !ts.isVariableDeclarationList(list)) return undefined;
    const forOf = list.parent;
    if (forOf === undefined || !ts.isForOfStatement(forOf)) return undefined;
    const iterated = unwrapExpression(forOf.expression);
    if (ts.isArrayLiteralExpression(iterated)) {
      if (elementIndex !== undefined) return undefined;
      const names: string[] = [];
      for (const el of iterated.elements) {
        const e = unwrapExpression(el);
        if (!ts.isStringLiteral(e) && !ts.isNoSubstitutionTemplateLiteral(e)) return undefined;
        names.push(e.text);
      }
      return names;
    }
    if (ts.isIdentifier(iterated)) {
      // `for (const k of TABLE)` where TABLE is a const string array. A
      // reassigned TABLE is refused for literalObjectOf's reason.
      if (elementIndex !== undefined) return undefined;
      const decl = declarationOf(iterated);
      if (
        decl === undefined ||
        !ts.isVariableDeclaration(decl) ||
        decl.initializer === undefined ||
        isWhollyReassigned(decl)
      ) {
        return undefined;
      }
      const init = unwrapExpression(decl.initializer);
      if (!ts.isArrayLiteralExpression(init)) return undefined;
      const names: string[] = [];
      for (const el of init.elements) {
        const e = unwrapExpression(el);
        if (!ts.isStringLiteral(e) && !ts.isNoSubstitutionTemplateLiteral(e)) return undefined;
        names.push(e.text);
      }
      return names;
    }
    if (!ts.isCallExpression(iterated)) return undefined;
    const callee = unwrapExpression(iterated.expression);
    if (
      !ts.isPropertyAccessExpression(callee) ||
      !ts.isIdentifier(callee.expression) ||
      callee.expression.text !== 'Object' ||
      iterated.arguments.length !== 1
    ) {
      return undefined;
    }
    const table = literalObjectOf(iterated.arguments[0]!);
    if (table === undefined) return undefined;
    if (callee.name.text === 'keys') {
      return elementIndex === undefined ? literalKeysOfObject(table) : undefined;
    }
    if (callee.name.text === 'entries') {
      if (elementIndex === 0) return literalKeysOfObject(table);
      if (elementIndex === 1) return literalValuesOfObject(table);
      return undefined;
    }
    return undefined;
  };
  const computedKeyNames = (expr: ts.Node): string[] | undefined => {
    const e = unwrapExpression(expr);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
    if (!ts.isIdentifier(e)) return undefined;
    // Resolve the identifier to a loop binding — plain (`const k of …`) or an
    // array-destructured element (`const [k, v] of Object.entries(…)`), which
    // `declarationOf` cannot see (it matches Identifier names only).
    for (let scope: ts.Node | undefined = e.parent; scope !== undefined; scope = scope.parent) {
      if (!isBindingScope(scope)) continue;
      let found: { declaration: ts.VariableDeclaration; elementIndex?: number } | undefined;
      const visit = (n: ts.Node): void => {
        if (found !== undefined) return;
        if (isBindingScope(n)) return;
        if (ts.isVariableDeclaration(n)) {
          if (ts.isIdentifier(n.name) && n.name.text === e.text) {
            found = { declaration: n };
            return;
          }
          if (ts.isArrayBindingPattern(n.name)) {
            n.name.elements.forEach((el, i) => {
              if (
                found === undefined &&
                ts.isBindingElement(el) &&
                ts.isIdentifier(el.name) &&
                el.name.text === e.text
              ) {
                found = { declaration: n, elementIndex: i };
              }
            });
            if (found !== undefined) return;
          }
        }
        ts.forEachChild(n, visit);
      };
      ts.forEachChild(scope, visit);
      if (found !== undefined) return loopKeyNames(found.declaration, found.elementIndex);
    }
    return undefined;
  };

  /**
   * The keys `delete` removes from `declaration`'s binding, LOWERCASED for the
   * exclusion compare, or `undefined` when any delete's key cannot be bounded
   * (fail CLOSED — the spread must not be credited at all). A delete through a
   * longer chain (`delete result['A']['B']`) excludes its FIRST segment
   * wholesale: over-excluding under-credits a delivered key, under-excluding
   * credits a dropped one. Deletes are collected across the WHOLE scope,
   * excluded (reverse-map) function bodies included — a delete anywhere
   * removes the key from the delivered object, so skipping any body would be
   * the fail-OPEN direction.
   */
  const deleteExclusionCache = new Map<
    ts.VariableDeclaration | ts.ParameterDeclaration,
    Set<string> | undefined
  >();
  const deleteExclusionsOf = (
    declaration: ts.VariableDeclaration | ts.ParameterDeclaration
  ): Set<string> | undefined => {
    if (deleteExclusionCache.has(declaration)) return deleteExclusionCache.get(declaration);
    const excluded = new Set<string>();
    let unresolvable = false;
    const visit = (n: ts.Node): void => {
      if (unresolvable) return;
      if (ts.isDeleteExpression(n)) {
        let current: ts.Node = unwrapExpression(n.expression);
        const accesses: Array<ts.PropertyAccessExpression | ts.ElementAccessExpression> = [];
        while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
          accesses.unshift(current);
          current = unwrapExpression(current.expression);
        }
        if (
          ts.isIdentifier(current) &&
          accesses.length > 0 &&
          declarationOf(current) === declaration
        ) {
          const first = accesses[0]!;
          const names = ts.isPropertyAccessExpression(first)
            ? [first.name.text]
            : computedKeyNames(first.argumentExpression);
          if (names === undefined) {
            unresolvable = true;
            return;
          }
          for (const name of names) excluded.add(name.toLowerCase());
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(enclosingScope(declaration));
    const result = unresolvable ? undefined : excluded;
    deleteExclusionCache.set(declaration, result);
    return result;
  };

  /**
   * The delete exclusions carried by a spread SOURCE, followed through the
   * binding chain (issue #1475 review): `{ ...a }` where
   * `const a = { ...config }; delete a['K'];` must carry `K`, and so must a
   * spread of a PARAMETER the function `delete`s off, an accessed member
   * whose root binding deletes into its subtree, and a call whose returned
   * binding was deleted from. Every unhandled shape returns `undefined` and
   * the caller refuses the registration — fail closed, since a chain the walk
   * cannot follow may be hiding a delete.
   */
  const spreadSourceExclusions = (expr: ts.Node, seen: Set<ts.Node>): Set<string> | undefined => {
    const e = unwrapExpression(expr);
    if (seen.has(e)) return undefined;
    seen.add(e);
    if (ts.isIdentifier(e)) {
      const declaration = declarationOf(e);
      if (declaration === undefined) return undefined;
      if (ts.isParameter(declaration)) return deleteExclusionsOf(declaration);
      if (!ts.isVariableDeclaration(declaration)) return undefined;
      if (isWhollyReassigned(declaration)) return undefined;
      const own = deleteExclusionsOf(declaration);
      if (own === undefined || declaration.initializer === undefined) return own;
      const chained = spreadSourceExclusions(declaration.initializer, seen);
      if (chained === undefined) return undefined;
      const out = new Set(own);
      for (const k of chained) out.add(k);
      return out;
    }
    if (ts.isObjectLiteralExpression(e)) {
      // A seed literal in the chain: only its BAG-DERIVED spreads carry
      // deletes onward; named members are overrides (bound 9).
      const out = new Set<string>();
      for (const p of e.properties) {
        if (!ts.isSpreadAssignment(p) || !isBagDerived(p.expression, new Set())) continue;
        const inner = spreadSourceExclusions(p.expression, seen);
        if (inner === undefined) return undefined;
        for (const k of inner) out.add(k);
      }
      return out;
    }
    if (ts.isElementAccessExpression(e) || ts.isPropertyAccessExpression(e)) {
      // `{ ...result['ViewerCertificate'] }` — deletes on the ROOT binding are
      // recorded by FIRST segment, so any delete under the accessed member
      // surfaces as that member's name; refuse then (what remains beneath it
      // cannot be bounded). A root with no deletes contributes nothing.
      let current: ts.Node = e;
      let firstSegment: string | undefined;
      while (ts.isElementAccessExpression(current) || ts.isPropertyAccessExpression(current)) {
        firstSegment = ts.isPropertyAccessExpression(current)
          ? current.name.text
          : elementAccessName(unwrapExpression(current.argumentExpression));
        current = unwrapExpression(current.expression);
      }
      if (!ts.isIdentifier(current)) return undefined;
      const root = declarationOf(current);
      if (root === undefined) return undefined;
      if (!ts.isParameter(root) && !ts.isVariableDeclaration(root)) return undefined;
      const rootDeletes = deleteExclusionsOf(root);
      if (rootDeletes === undefined) return undefined;
      if (rootDeletes.size === 0) return new Set<string>();
      if (firstSegment === undefined) return undefined;
      return rootDeletes.has(firstSegment.toLowerCase()) ? undefined : new Set<string>();
    }
    if (ts.isCallExpression(e)) {
      // Mirror {@link resolveLiterals}' call reach: `.map(cb)` delivers the
      // callbacks' returns, `.filter(...)` its receiver — the chain has to
      // follow the same hops or every registration those hops feed refuses.
      const callee = unwrapExpression(e.expression);
      if (ts.isPropertyAccessExpression(callee)) {
        if (CALLBACK_RETURNING_METHODS.has(callee.name.text)) {
          const out = new Set<string>();
          for (const a of e.arguments) {
            const fn = unwrapExpression(a);
            if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return undefined;
            for (const r of returnedExpressions(fn)) {
              const inner = spreadSourceExclusions(r, seen);
              if (inner === undefined) return undefined;
              for (const k of inner) out.add(k);
            }
          }
          return out;
        }
        if (RECEIVER_PRESERVING_METHODS.has(callee.name.text)) {
          return spreadSourceExclusions(callee.expression, seen);
        }
      }
      // `{ ...this.toSdk(x) }` — deletes on the callee's returned binding
      // travel with the returned value.
      const name = resolvableCalleeName(e);
      if (name === undefined) return undefined;
      const fns = handoffCallables.get(name) ?? [];
      if (fns.length === 0) return undefined;
      const out = new Set<string>();
      for (const fn of fns) {
        for (const r of returnedExpressions(fn)) {
          const inner = spreadSourceExclusions(r, seen);
          if (inner === undefined) return undefined;
          for (const k of inner) out.add(k);
        }
      }
      return out;
    }
    if (ts.isArrayLiteralExpression(e)) {
      const out = new Set<string>();
      for (const el of e.elements) {
        const inner = spreadSourceExclusions(el, seen);
        if (inner === undefined) return undefined;
        for (const k of inner) out.add(k);
      }
      return out;
    }
    if (ts.isSpreadElement(e)) return spreadSourceExclusions(e.expression, seen);
    if (ts.isConditionalExpression(e) || ts.isBinaryExpression(e)) {
      if (
        ts.isBinaryExpression(e) &&
        e.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken &&
        e.operatorToken.kind !== ts.SyntaxKind.BarBarToken &&
        e.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        return undefined;
      }
      const arms = (
        ts.isConditionalExpression(e) ? [e.whenTrue, e.whenFalse] : [e.left, e.right]
      ).filter((a) => !isNullishExpression(a));
      const out = new Set<string>();
      for (const arm of arms) {
        const inner = spreadSourceExclusions(arm, seen);
        if (inner === undefined) return undefined;
        for (const k of inner) out.add(k);
      }
      return out;
    }
    return undefined;
  };

  /**
   * Register the spread of a bag-derived seed as a BOUNDED hand-off at `path`
   * (issue #1475). Refusals, each fail-CLOSED: a non-bag seed (the taint root
   * — a config read back off AWS must not measure as a hand-off), a binding
   * REASSIGNED as a whole or seeded by LATE ASSIGNMENT (the delivered value
   * may not be the seed / its deletes are invisible from the literal), an
   * unresolvable `delete` key, and a spread SOURCE chain the walk cannot
   * follow ({@link spreadSourceExclusions}). Exclusions union across the
   * literal's bag spreads AND the holder binding's own deletes. Two
   * registrations at the same path union their coverage, so exclusion sets
   * INTERSECT; a FULL hand-off at the path supersedes every exclusion.
   */
  const registerSpreadHandoff = (
    path: string,
    lit: ts.ObjectLiteralExpression,
    chainSource?: ts.Node
  ): void => {
    let excluded: Set<string> | undefined;
    for (const p of lit.properties) {
      if (!ts.isSpreadAssignment(p)) continue;
      if (!isBagDerived(p.expression, new Set())) continue;
      const sourceExcluded = spreadSourceExclusions(p.expression, new Set());
      if (sourceExcluded === undefined) return;
      if (excluded === undefined) excluded = new Set<string>();
      for (const k of sourceExcluded) excluded.add(k);
    }
    if (excluded === undefined) return; // no bag-derived spread in this literal
    // Deletes on the RESOLUTION CHAIN between the write and this literal
    // (issue #1475 review): `const r = this.seed(cfg); delete r['K'];` and the
    // `?:`-arm seed both reach here with a holder that is not the deleted
    // binding — the chain walk is what sees those. An unfollowable chain
    // refuses, fail-closed.
    if (chainSource !== undefined && unwrapExpression(chainSource) !== lit) {
      const chainExcluded = spreadSourceExclusions(chainSource, new Set());
      if (chainExcluded === undefined) return;
      for (const k of chainExcluded) excluded.add(k);
    }
    const holder = climbOutOfWrappers(lit).parent;
    if (holder !== undefined && ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) {
      if (isWhollyReassigned(holder)) return;
      const holderDeletes = deleteExclusionsOf(holder);
      if (holderDeletes === undefined) return;
      for (const k of holderDeletes) excluded.add(k);
    } else if (
      holder !== undefined &&
      ts.isBinaryExpression(holder) &&
      isWriteAssignment(holder.operatorToken.kind)
    ) {
      // The literal seeds a binding by ASSIGNMENT (`let x; x = { ...bag }`),
      // which `isWhollyReassigned` classifies as a whole reassignment on the
      // declaration — refuse outright, same as the builder does. A delete on
      // that binding would otherwise be invisible from here (the holder is
      // the assignment, not the declaration), and refusing is the loud
      // direction.
      return;
    }
    const existing = handoffExclusions.get(path);
    if (handoffScopes.has(path) && existing === undefined) return; // full hand-off wins
    if (existing !== undefined) {
      const merged = new Set([...existing].filter((k) => excluded!.has(k)));
      if (merged.size === 0) handoffExclusions.delete(path);
      else handoffExclusions.set(path, merged);
    } else if (excluded.size > 0) {
      handoffExclusions.set(path, excluded);
    }
    handoffScopes.add(path);
  };

  /**
   * Is this expression a WHOLE-BLOB HAND-OFF worth recording (issue #1445)?
   * `feedsOnlyComparison` is re-applied here for the same reason the literal
   * walk applies it: a converted blob whose only consumer is a diff delivers
   * nothing.
   */
  function isWholeBlobHandoff(value: ts.Node): { seedKeys: Set<string> } | undefined {
    if (feedsOnlyComparison(value)) return undefined;
    const seedKeys = new Set<string>();
    return deliversWholeBlob(value, new Set(), seedKeys) ? { seedKeys } : undefined;
  }

  /**
   * The longest write path the recorder will build. CFn nested paths bottom out
   * at 7 segments on the deepest audited type (`AWS::ECS::Service`), so this is
   * far past any legitimate lookup; it exists because a self-referential value
   * (`const a = { b: a }`) would otherwise descend forever — `resolveLiterals`
   * guards cycles WITHIN one call, not across the recursive descent.
   */
  const MAX_WRITE_PATH_SEGMENTS = 12;

  const addScopeMember = (path: string, member: string): void => {
    const scope = scopes.get(path) ?? new Set<string>();
    scope.add(member);
    scopes.set(path, scope);
  };

  /** The path with its LAST segment replaced — used for the CFn-spelling alias. */
  const siblingPath = (path: string, segment: string): string => {
    const cut = path.lastIndexOf('.');
    return cut === -1 ? segment : `${path.slice(0, cut + 1)}${segment}`;
  };

  /**
   * Register the CFn-spelled ALIASES of a hand-off path.
   *
   * The write path's last segment is the SDK spelling; the audited path's is the
   * CFn one, and the two do not always agree — `ECSProvider` writes
   * `placementStrategy` for CFn's `PlacementStrategies`, so recording only the
   * write path leaves `PlacementStrategies.Type` / `.Field` uncovered on a
   * target that forwards the whole array. The SEED's own key IS the CFn
   * spelling, so it is registered as a sibling path too, in both the `exact` and
   * `lower-first` renderings (the collector does not know the target's style).
   */
  const registerSeedKeyHandoffs = (path: string, seedKeys: ReadonlySet<string>): void => {
    for (const key of seedKeys) {
      // Alias paths never carry a spread-exclusion entry and never clear one:
      // a stale entry at an alias path could only OVER-exclude (loud), and no
      // shape in the tree produces one (#1475 review nit, recorded).
      handoffScopes.add(siblingPath(path, key));
      handoffScopes.add(siblingPath(path, lowerFirst(key)));
    }
  };

  /**
   * Guard for the recursive descent: one (path, literal) pair is walked once.
   * Keyed by pair rather than by literal alone because the SAME literal legally
   * appears at two paths (a shared helper's return delivered to two members).
   *
   * The guard makes SPREAD-EXCLUSION precision traversal-order-dependent in
   * the LOUD direction only (#1475 review): the same seed literal reached at
   * one path via two chains with different deletes registers with the FIRST
   * chain's exclusions. A clean second site either rescues coverage through
   * its FULL hand-off in `recordAt` (a generic-converter seed) or, when it
   * cannot, leaves an over-exclusion that under-credits a delivered key — never
   * a false credit, since the kept registration always corresponds to a real
   * site whose chain was fully computed.
   */
  const walkedAtPath = new Set<string>();
  let literalIdSeq = 0;
  const literalIds = new WeakMap<ts.Node, number>();
  const literalId = (node: ts.Node): number => {
    let id = literalIds.get(node);
    if (id === undefined) {
      id = ++literalIdSeq;
      literalIds.set(node, id);
    }
    return id;
  };

  /**
   * Record one write AT A PATH, and descend into the value so every member
   * beneath it lands under ITS OWN path rather than being flattened into the
   * ancestor's scope (issue #1464). `environment.environmentVariables.type` and
   * `environment.type` are therefore separate facts, which is the whole point.
   *
   * Two write sites of the SAME path are still UNIONED, and deliberately: the
   * positive test asks whether ANY site delivers the member, so per-site sets
   * would change nothing. That residue is what is left of the #1448 bound (2) —
   * see the module header.
   */
  const recordAt = (path: string, name: string, value: ts.Node | undefined): void => {
    if (!scopes.has(path)) scopes.set(path, new Set<string>());
    if (value === undefined) return;
    if (path.split('.').length >= MAX_WRITE_PATH_SEGMENTS) return;
    // A write whose OWN value is the hand-off (`CorsConfiguration:
    // properties['CorsConfiguration']`) delivers everything at or beneath this
    // path, so the path itself becomes the wildcard.
    const handoff = isWholeBlobHandoff(value);
    if (handoff !== undefined) {
      handoffScopes.add(path);
      // A FULL hand-off (generic converter / verbatim forward) delivers every
      // member, so it supersedes any bounded SPREAD registration at the path.
      handoffExclusions.delete(path);
      registerSeedKeyHandoffs(path, handoff.seedKeys);
    }
    // The write VALUE is the spread recognizer's CHAIN SOURCE (issue #1475
    // review): a literal can reach this write through bindings whose deletes
    // the literal's own holder cannot see (`const r = this.seed(cfg);
    // delete r['K'];` — the seed literal's holder is the callee's return).
    for (const literal of resolveLiterals(value, new Set())) walkLiteralAt(path, literal, value);
    // The BUILDER twin (issue #1474): the value can also be a binding the file
    // populated by assignment after seeding it with a literal, in which case
    // the seed walked just above carries none of the members.
    for (const builder of resolveBuilders(value, new Set())) walkBuilderAt(path, builder);
  };

  /**
   * Every member ASSIGNED onto a builder binding is written at `path` — the
   * same crediting {@link walkLiteralAt} gives a literal's own members, at the
   * same path, so `Configuration: mapped` scopes exactly what
   * `Configuration: { … }` would have (issue #1474).
   *
   * A chain longer than one segment (`out.A.B = v`) opens the intermediate
   * scopes on the way down, so the credit lands at `path.A.B` rather than
   * being flattened onto `path` — the depth-scoping #1464 established.
   *
   * DELIVERY is the caller's question, not this function's: `recordAt` runs
   * only where a WRITE takes the value, and the write sites are already
   * filtered by {@link feedsOnlyComparison} / {@link isComparisonOnlyLiteral}.
   * A builder that is never handed to a write — or handed only to a diff — is
   * therefore never reached, which is the "not a rubber stamp" half of the
   * recognizer and is pinned by its own tests.
   */
  function walkBuilderAt(path: string, declaration: ts.VariableDeclaration): void {
    const guard = `${path}#builder${literalId(declaration)}`;
    if (walkedAtPath.has(guard)) return;
    walkedAtPath.add(guard);
    if (path.split('.').length >= MAX_WRITE_PATH_SEGMENTS) return;
    for (const { chain, value } of builderMembers(declaration)) {
      let parent = path;
      for (const segment of chain.slice(0, -1)) {
        addScopeMember(parent, segment);
        parent = `${parent}.${segment}`;
        if (!scopes.has(parent)) scopes.set(parent, new Set<string>());
      }
      const terminal = chain[chain.length - 1]!;
      addScopeMember(parent, terminal);
      recordAt(`${parent}.${terminal}`, terminal, value);
    }
  }

  /**
   * Every member of `lit` is written directly at `path`. `chainSource` is the
   * expression the literal was RESOLVED FROM (the write's value, or a spread's
   * own expression one level up) — the spread registration walks its binding
   * chain for deletes the literal's holder cannot see (issue #1475 review).
   */
  function walkLiteralAt(path: string, lit: ts.ObjectLiteralExpression, chainSource?: ts.Node): void {
    const guard = `${path}#${literalId(lit)}`;
    if (walkedAtPath.has(guard)) return;
    walkedAtPath.add(guard);
    if (isComparisonOnlyLiteral(lit)) return;
    registerSpreadHandoff(path, lit, chainSource);
    for (const p of lit.properties) {
      if (ts.isPropertyAssignment(p)) {
        const name = propertyName(p.name);
        if (name === undefined) continue;
        addScopeMember(path, name);
        recordAt(`${path}.${name}`, name, p.initializer);
      } else if (ts.isShorthandPropertyAssignment(p)) {
        addScopeMember(path, p.name.text);
        recordAt(`${path}.${p.name.text}`, p.name.text, p.name);
      } else if (ts.isSpreadAssignment(p)) {
        // A spread merges the source's members AT THIS LEVEL — including a
        // BUILDER's (`return { ...out, Extra: 1 }`), issue #1474.
        for (const child of resolveLiterals(p.expression, new Set())) {
          walkLiteralAt(path, child, p.expression);
        }
        for (const builder of resolveBuilders(p.expression, new Set())) {
          walkBuilderAt(path, builder);
        }
      }
    }
  }

  /** A write that opens a ROOT scope — see {@link isLexicallyNestedWrite}. */
  const record = (name: string, value: ts.Node | undefined): void => {
    recordAt(name, name, value);
  };

  /**
   * Is this write lexically INSIDE another object literal, so that its own path
   * is already recorded by the enclosing write's descent?
   *
   * Through #1448 every property assignment in the file opened a ROOT scope, so
   * a member that only ever appears nested (`logsConfig: { cloudWatchLogs: { … } }`)
   * still produced a top-level-looking `cloudWatchLogs` scope that a CFn
   * top-level of that spelling would then be checked against — the second half
   * of that release's known bound (2). Suppressing the nested root closes it:
   * the member IS recorded, at `logsConfig.cloudWatchLogs`, which is where the
   * audited path looks for it.
   *
   * Only the LEXICAL nesting is suppressed. A literal reached through a binding
   * or a helper's return still opens a root of its own (its properties have no
   * object-literal ancestor), and is ALSO recorded under the caller's path by
   * the descent — the residual, harmless direction.
   *
   * The ancestor walk is a WHITELIST of hops rather than "any enclosing object
   * literal", because suppression is only safe where {@link resolveLiterals}
   * can make the SAME hop in the other direction. It cannot cross an OPAQUE
   * call: `{ body: JSON.stringify({ batchReportMode: 1 }) }` has an enclosing
   * literal, but nothing resolves `JSON.stringify(…)`, so suppressing the inner
   * root would lose the write entirely.
   *
   * It CAN cross a callback of {@link CALLBACK_RETURNING_METHODS}, and must:
   * `defs.map((d) => ({ name: … }))` is the dominant shape in these providers,
   * `resolveLiterals` follows it, and leaving it out kept every such literal
   * opening stray depth-1 roots (measured on the synthetic probes: `name`,
   * `nested`, `nested.deep`, `type`) while the header claimed the bound closed.
   * A callback of any OTHER method (`forEach`, an unresolvable helper) is NOT
   * crossed, so its literals still root — the conservative direction.
   */
  const isCallbackReturningCall = (node: ts.Node): boolean =>
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(unwrapExpression(node.expression)) &&
    CALLBACK_RETURNING_METHODS.has(
      (unwrapExpression(node.expression) as ts.PropertyAccessExpression).name.text
    );

  const NESTING_PASSTHROUGH_KINDS = (n: ts.Node): boolean =>
    ts.isObjectLiteralExpression(n) ||
    ts.isPropertyAssignment(n) ||
    ts.isArrayLiteralExpression(n) ||
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isSatisfiesExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isSpreadAssignment(n) ||
    ts.isSpreadElement(n) ||
    ts.isConditionalExpression(n) ||
    ts.isReturnStatement(n) ||
    ts.isBlock(n) ||
    ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
      n.parent !== undefined &&
      isCallbackReturningCall(n.parent) &&
      (n.parent as ts.CallExpression).arguments.some((a) => unwrapExpression(a) === n)) ||
    isCallbackReturningCall(n) ||
    (ts.isBinaryExpression(n) &&
      (n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        n.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken));

  const isLexicallyNestedWrite = (node: ts.Node): boolean => {
    for (let n: ts.Node | undefined = node.parent?.parent; n !== undefined; n = n.parent) {
      if (ts.isObjectLiteralExpression(n)) return true;
      if (!NESTING_PASSTHROUGH_KINDS(n)) return false;
    }
    return false;
  };

  /**
   * `Object.defineProperty(sdk, 'batchReportMode', { value: … })` IS a write of
   * `batchReportMode` — but the DESCRIPTOR literal's own keys are not writes of
   * anything: crediting them would put `value` / `get` / `set` / `writable`
   * into the set, and `value` is a real CodeBuild member (`Value`). So the
   * descriptor literal is suppressed and only its `value:` payload is walked as
   * the named member's scope.
   */
  const suppressedLiterals = new Set<ts.Node>();
  const definePropertyWrite = (
    node: ts.CallExpression
  ): { name: string; value: ts.Node | undefined; descriptor: ts.Node | undefined } | undefined => {
    const callee = unwrapExpression(node.expression);
    if (
      !ts.isPropertyAccessExpression(callee) ||
      !ts.isIdentifier(callee.expression) ||
      callee.expression.text !== 'Object' ||
      callee.name.text !== 'defineProperty' ||
      node.arguments.length < 2
    ) {
      return undefined;
    }
    const name = elementAccessName(unwrapExpression(node.arguments[1]!));
    if (name === undefined) return undefined;
    const descriptor =
      node.arguments.length > 2 ? unwrapExpression(node.arguments[2]!) : undefined;
    let value: ts.Node | undefined;
    if (descriptor !== undefined && ts.isObjectLiteralExpression(descriptor)) {
      for (const p of descriptor.properties) {
        if (ts.isPropertyAssignment(p) && propertyName(p.name) === 'value') value = p.initializer;
      }
    }
    return { name, value, descriptor };
  };

  const visit = (node: ts.Node, excluded: boolean): void => {
    let inExcluded = excluded;
    if (!inExcluded) {
      const name = declaredFunctionName(node);
      if (name !== undefined && isExcludedName(name)) inExcluded = true;
    }
    if (!inExcluded) {
      if (ts.isPropertyAssignment(node)) {
        const name = propertyName(node.name);
        if (
          name !== undefined &&
          !isDestructuringTarget(node) &&
          !isLexicallyNestedWrite(node) &&
          !suppressedLiterals.has(node.parent) &&
          !isComparisonOnlyLiteral(node.parent)
        ) {
          record(name, node.initializer);
        }
      } else if (ts.isShorthandPropertyAssignment(node)) {
        if (
          !isDestructuringTarget(node) &&
          !isLexicallyNestedWrite(node) &&
          !suppressedLiterals.has(node.parent) &&
          !isComparisonOnlyLiteral(node.parent)
        ) {
          record(node.name.text, node.name);
        }
      } else if (ts.isBinaryExpression(node) && isWriteAssignment(node.operatorToken.kind)) {
        const lhs = node.left;
        if (ts.isPropertyAccessExpression(lhs)) {
          record(lhs.name.text, node.right);
        } else if (ts.isElementAccessExpression(lhs)) {
          const name = elementAccessName(lhs.argumentExpression);
          if (name !== undefined) record(name, node.right);
        }
      } else if (ts.isCallExpression(node)) {
        const defined = definePropertyWrite(node);
        if (defined !== undefined) {
          if (defined.descriptor !== undefined) suppressedLiterals.add(defined.descriptor);
          record(defined.name, defined.value);
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, inExcluded));
  };
  visit(sf, false);
  return { scopes, handoffScopes, handoffExclusions };
}

/**
 * Every SDK member name reachable BENEATH an SDK member, following the model's
 * own reference graph (issue #1445).
 *
 * Through #1445 this turned a hand-off POINT into a CREDIT SET, because the CFn
 * side could not answer "what lives beneath this?" — the fixture's
 * `nestedProperties` capture was FLATTENED per top-level, so it knew
 * `ContainerDefinitions.Add` existed but not that `Add` lives under
 * `LinuxParameters`. The `nestedPropertyPaths` capture (#1464) answers it
 * directly, and the credit is a path-prefix test, so this function is no longer
 * on the classification path.
 *
 * What it still does is back {@link countExpandingHandoffPoints}, the
 * parser-regression floor: "does this hand-off point carry a SUB-BLOB, or is it
 * an inert scalar forward?" is exactly a question about the SDK model.
 *
 * The starting member is looked up by BARE NAME across every interface in the
 * client model, so two unrelated interfaces declaring the same member name are
 * UNIONED. That over-counts in the floor's SAFE direction (a floor is a
 * lower bound on how much the walk still sees) and no longer affects any
 * verdict.
 */
export function reachableSdkMemberNames(
  memberName: string,
  interfaces: ReadonlyMap<string, ReadonlyMap<string, SdkMemberType>>
): Set<string> {
  const out = new Set<string>();
  const queue: string[] = [];
  for (const members of interfaces.values()) {
    const type = members.get(memberName);
    if (type?.refName !== undefined) queue.push(type.refName);
  }
  const visited = new Set<string>();
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);
    const members = interfaces.get(name);
    if (members === undefined) continue;
    for (const [member, type] of members) {
      out.add(member);
      if (type.refName !== undefined) queue.push(type.refName);
    }
  }
  return out;
}

/**
 * How many distinct hand-off POINTS — the terminal segments of
 * {@link ProviderWriteEvidence.handoffScopes} — actually EXPAND to at least one
 * SDK member.
 *
 * Since #1464 the credit itself is a PATH-PREFIX test that never consults the
 * SDK model, so this function exists purely as the parser-regression floor
 * behind {@link NestedKeyTarget.minHandoffPoints}: it answers "did the walk
 * still recognize a BLOB-carrying forward?", which is the failure mode the
 * floor exists for.
 *
 * The raw point count is the wrong fence and was measured to be vacuous: on
 * `apigatewayv2-provider.ts` the walk records 35 points, but 32 of them are
 * inert scalar forwards (`Name`, `ApiId`, `StageName`, …) whose SDK member is a
 * string. Only `CorsConfiguration` / `DefaultRouteSettings` / `JwtConfiguration`
 * carry a sub-blob, so a regression that broke exactly the blob recognition
 * would leave ~32 raw points standing and sail past a floor of 20 while the
 * walk recognized none of the blobs the floor exists to fence.
 */
export function countExpandingHandoffPoints(
  evidence: ProviderWriteEvidence,
  sdkInterfaces: ReadonlyMap<string, ReadonlyMap<string, SdkMemberType>>
): number {
  const points = new Set(
    [...evidence.handoffScopes].map((path) => path.slice(path.lastIndexOf('.') + 1))
  );
  let expanding = 0;
  for (const point of points) {
    if (reachableSdkMemberNames(point, sdkInterfaces).size > 0) expanding++;
  }
  return expanding;
}

/**
 * Assignment operators that WRITE their left-hand side. `sdk.x = v` is the
 * common form, but `??=` / `||=` / `&&=` / `+=` are writes too (issue #1448
 * comment item 1).
 * `FirstAssignment`..`LastAssignment` is the compiler's own token range for
 * exactly this set.
 */
function isWriteAssignment(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

/**
 * The audited nested PATHS delivered WHOLE by a generic hand-off — the shape
 * pass's `wholeDelivery` input (PR #4324). Pure + exported for unit tests.
 *
 * A path qualifies when its styled terminal is a real SDK member (a member the
 * SDK lacks at that spelling is not delivered by a verbatim forward at all) and
 * some ANCESTOR of it — never a scope that names the member itself, which is a
 * per-member write — is a {@link ProviderWriteEvidence.handoffScopes} entry
 * not excluded by a spread-and-patch `delete`. The parent chain is styled per
 * the target's key style, with {@link NestedKeyTarget.segmentRenames} applied
 * to intermediate segments and a dotted rename value flattened one write level
 * per part; the hand-off match itself is case-folded per segment
 * ({@link isHandoffCovered}).
 *
 * `usedSegmentRenames` is an OUT-param: the rename entries that did work on
 * this run, for {@link findStaleSegmentRenames}. An entry goes unused only when
 * the UN-RENAMED chain already resolves in the write index (the rename is
 * redundant); when neither chain resolves the entry is still the right bridge.
 */
export function wholeDeliveredPathsFor(
  target: NestedKeyTarget,
  nestedKeyPaths: readonly NestedKeyPath[],
  sdkMembers: ReadonlySet<string>,
  writeEvidence: ProviderWriteEvidence,
  usedSegmentRenames?: Set<string>
): Set<string> {
  const styled = (s: string): string => (target.keyStyle === 'lower-first' ? lowerFirst(s) : s);
  const renames = target.segmentRenames ?? {};

  // The write index as a TREE, so the case-fold is applied per LEVEL rather
  // than as a global lowercase union of every path in the file (measured: 80
  // `name`/`Name`-style collision groups on `ecs-provider.ts`).
  const childrenOf = new Map<string, string[]>();
  for (const [path, members] of writeEvidence.scopes) {
    const list = childrenOf.get(path) ?? [];
    for (const m of members) list.push(m);
    childrenOf.set(path, list);
  }
  const rootScopes = [...writeEvidence.scopes.keys()].filter((k) => !k.includes('.'));
  const matchesSegment = (candidate: string, wanted: string): boolean =>
    candidate === wanted || candidate.toLowerCase() === wanted.toLowerCase();
  const chainResolves = (chain: readonly string[]): boolean => {
    if (chain.length === 0) return true;
    let level = rootScopes.filter((r) => matchesSegment(r, chain[0]!));
    for (let i = 1; i < chain.length && level.length > 0; i++) {
      const next: string[] = [];
      for (const parent of level) {
        for (const child of childrenOf.get(parent) ?? []) {
          if (matchesSegment(child, chain[i]!)) next.push(`${parent}.${child}`);
        }
      }
      level = next;
    }
    return level.length > 0;
  };

  const out = new Set<string>();
  for (const { path, key, segments } of nestedKeyPaths) {
    // A key may be SCOPED by the segment's immediate CFn parent, winning over
    // a bare-name entry (issue #1540).
    const renameKeyAt = (i: number): string | undefined => {
      if (i > 0 && renames[`${segments[i - 1]}.${segments[i]}`] !== undefined) {
        return `${segments[i - 1]}.${segments[i]}`;
      }
      return renames[segments[i]!] !== undefined ? segments[i]! : undefined;
    };
    if (usedSegmentRenames !== undefined) {
      for (let i = 0; i < segments.length - 1; i++) {
        const renameKey = renameKeyAt(i);
        if (renameKey === undefined) continue;
        const plain = segments.slice(0, i + 1).map((seg) => styled(seg));
        if (!chainResolves(plain)) usedSegmentRenames.add(renameKey);
      }
    }
    const expected = styled(key);
    if (!sdkMembers.has(expected)) continue;
    const parentChain = segments.slice(0, -1).flatMap((seg, i) => {
      const renameKey = renameKeyAt(i);
      return (renameKey === undefined ? styled(seg) : renames[renameKey]!).split('.');
    });
    // Only an ANCESTOR (or the parent itself) handed off counts. Filtering the
    // scopes rather than omitting the terminal keeps a spread-and-patch
    // exclusion decidable: without a terminal it fails closed to "not whole".
    const ancestorScopes = new Set(
      [...writeEvidence.handoffScopes].filter((s) => s.split('.').length <= parentChain.length)
    );
    if (
      isHandoffCovered(
        ancestorScopes,
        parentChain.join('.'),
        expected,
        writeEvidence.handoffExclusions
      )
    ) {
      out.add(path);
    }
  }
  return out;
}

export interface ShapePassResult {
  readonly entries: NestedShapeClassification[];
  readonly cleanCount: number;
  readonly unmatchedDefinitions: string[];
}

/**
 * SHAPE pass (issue #1378): audits divergences whose spelling exists
 * SOMEWHERE in the SDK model, so a name comparison alone cannot see them.
 *
 * Two sub-passes over the fixture's `definitionShapes` capture:
 *   - WRAPPER: a CFn member declared `array` whose same-spelled SDK members
 *     are all `{Quantity, Items}` wrapper references (none is a bare array) —
 *     the provider must wrap it or the serializer drops it.
 *   - DEFINITION: for each CFn definition with a same-named SDK interface,
 *     a member that same-spells an SDK member globally but is MISSING from
 *     that interface (renamed or relocated — `CachedMethods`). Members with
 *     no same-spelled SDK member anywhere are skipped: no interface can be
 *     asked about them, and the sdk-wire harness judges where such a value
 *     lands.
 *
 * Deliberately scoped to definitions REACHABLE from the provider's handled
 * top-levels? No — the whole definitionShapes map is audited: definitions are
 * shared sub-shapes and reachability pruning would re-derive the nested walk
 * for marginal gain; an unreachable definition's divergence is at worst a
 * false positive to allow-list (the S3 Metadata-Tables entries in
 * {@link NESTED_KEY_ALLOW_LIST} are such cases).
 */
export function classifyTargetShapes(
  target: NestedKeyTarget,
  definitionShapes: Readonly<Record<string, Record<string, string>>>,
  sdkInterfaces: ReadonlyMap<string, ReadonlyMap<string, SdkMemberType>>,
  providerLiterals: ReadonlySet<string>,
  allowList: ReadonlyMap<string, AllowListEntry> = NESTED_KEY_ALLOW_LIST,
  /** {@link wholeDeliveredPathsFor}'s result, with the paths it judged. */
  wholeDelivery?: {
    readonly nestedKeys: readonly NestedKeyPath[];
    readonly paths: ReadonlySet<string>;
  }
): ShapePassResult {
  const wrappers = wrapperInterfaceNames(sdkInterfaces);
  const inputReachable = inputReachableInterfaces(sdkInterfaces);
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

  // A literal rescues a `definition-member-missing` only as evidence that the
  // provider CONVERTS the member, and it is withdrawn when both hold:
  //   - an instance of the definition is handed WHOLE to a generic converter
  //     (`wholeDelivery`, from {@link wholeDeliveredPathsFor}), which forwards the member verbatim
  //     into an SDK interface that lacks it; and
  //   - another CFn definition carries the key and its own SDK interface
  //     declares it, so that same-spelled member already explains the literal.
  // PR #4324: `ecs-provider.ts` hands `VpcLatticeConfigurations` to
  // `pascalToCamelCaseKeys` and names `AdvancedConfiguration` only for
  // `LoadBalancer`, which vouched for `VpcLatticeConfiguration.
  // AdvancedConfiguration` while the installed SDK's interface had no such
  // member. A converter that relocates the member (CloudFront's `CachedMethods`)
  // keeps its credit: nothing else explains its literal. Bound: a literal
  // explained by something other than a definition (a top-level property, a
  // read-back, a reverse map) still rescues — the file-global literal residue.
  const childrenByParent = new Map<string, Set<string>>();
  for (const { segments, key } of wholeDelivery?.nestedKeys ?? []) {
    const parent = segments.slice(0, -1).join('.');
    const children = childrenByParent.get(parent) ?? new Set<string>();
    children.add(key);
    childrenByParent.set(parent, children);
  }
  const memberNames = (definition: string): string[] =>
    Object.keys(definitionShapes[definition] ?? {});
  // A parent is an instance of the LARGEST definition whose members it carries,
  // so a two-member `{Key, Value}` shape never claims a bigger shape's parent.
  const isInstanceOf = (definition: string, children: ReadonlySet<string>): boolean => {
    const fits = (d: string): boolean => memberNames(d).every((m) => children.has(m));
    const size = memberNames(definition).length;
    return (
      fits(definition) &&
      !Object.keys(definitionShapes).some((d) => memberNames(d).length > size && fits(d))
    );
  };
  const deliveredWholeAt = (definition: string, key: string): boolean =>
    (wholeDelivery?.nestedKeys ?? []).some(({ path, key: k, segments }) => {
      const children = childrenByParent.get(segments.slice(0, -1).join('.'));
      return (
        k === key &&
        wholeDelivery!.paths.has(path) &&
        children !== undefined &&
        isInstanceOf(definition, children)
      );
    });
  // No self-exclusion needed: the audited definition's own interface lacks the key.
  const declaredVerbatimElsewhere = (key: string): boolean =>
    Object.entries(definitionShapes).some(
      ([other, members]) =>
        Object.hasOwn(members, key) &&
        (resolveDefinitionInterface(other, sdkInterfaces, inputReachable)?.members.has(
          styled(key)
        ) ??
          false)
    );
  const literalWithdrawn = (definition: string, key: string): boolean =>
    deliveredWholeAt(definition, key) && declaredVerbatimElsewhere(key);

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
    let allowMatchKey: string | undefined;
    if (
      shapeLiterals.has(key) &&
      !(pass === 'definition' && literalWithdrawn(definition, key))
    ) {
      bucket = 'provider-handled';
    } else if (allowed) {
      bucket = 'allow-listed';
      rationale = allowed.rationale;
      allowMatchKey = allowKey(target.resourceType, key);
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
      ...(allowMatchKey !== undefined ? { allowMatchKey } : {}),
    });
  };

  for (const [defName, members] of Object.entries(definitionShapes)) {
    // Resolved to the interface a REQUEST can carry, not to the same-spelled one
    // — see `resolveDefinitionInterface`. `resolved.name` is what the reported
    // detail must name, or a reader chases a member on an interface the check
    // never consulted.
    const resolved =
      defName === '#top'
        ? undefined
        : resolveDefinitionInterface(defName, sdkInterfaces, inputReachable);
    const sdkIface = resolved?.members;
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
        // request-interface-scoped: the false-negative direction.
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
          // Names the interface actually CONSULTED, which is not always the
          // definition's own spelling. A reader sent to `AuthenticationConfiguration`
          // when the check read `AuthenticationConfigurationInput` looks at the
          // wrong shape and reaches the opposite conclusion.
          `SDK interface \`${resolved!.name}\` has no \`${styled(key)}\` member`
        );
      }
    }
  }

  return { entries, cleanCount, unmatchedDefinitions: unmatchedDefinitions.sort() };
}

/**
 * One audited unit: a FULL nested CFn key chain, rooted at the handled
 * top-level property (issues #1448 / #1464).
 *
 * Through #1448 the fixture only offered the FLATTENED per-top-level capture,
 * so `path` was a two-segment `Top.Member` even for a member living three
 * levels down — and `Environment.Type` and
 * `Environment.EnvironmentVariables.Type` were literally the same audited unit,
 * each vouching for the other. The `nestedPropertyPaths` capture (#1464) keeps
 * the chain, so `segments` is the real depth and the write side is scoped to
 * match.
 */
export interface NestedKeyPath {
  /** Handled top-level CFn property the key is reachable beneath. */
  readonly topLevelProperty: string;
  /** The nested key's own name — the LAST segment. */
  readonly key: string;
  /** `Top.A.B` — the audited unit, `segments` joined. */
  readonly path: string;
  /** The full chain, top-level first. Arrays are transparent (no `[]` marker). */
  readonly segments: readonly string[];
}

/**
 * The nested CFn key PATHS audited for a target: the fixture's
 * `nestedPropertyPaths` entries for the top-level properties THIS PROVIDER
 * handles on the type. Unhandled top-levels are pre-flight-rejected by
 * `property-coverage`, so their interiors are unreachable through this
 * provider by construction.
 *
 * Reads the PER-PATH capture (#1464); the flattened `nestedProperties` the
 * fixture also carries is not consulted here.
 */
export function nestedKeyPathsForTarget(
  fixture: {
    nestedPropertyPaths?: Record<string, string[]>;
  },
  handledTopLevel: ReadonlySet<string>
): NestedKeyPath[] {
  const nested = fixture.nestedPropertyPaths ?? {};
  const out = new Map<string, NestedKeyPath>();
  for (const [topLevelProperty, chains] of Object.entries(nested)) {
    if (!handledTopLevel.has(topLevelProperty)) continue;
    for (const chain of chains) {
      const segments = [topLevelProperty, ...chain.split('.')];
      const path = segments.join('.');
      const key = segments[segments.length - 1]!;
      if (!out.has(path)) out.set(path, { topLevelProperty, key, path, segments });
    }
  }
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function buildReport(targets: readonly TargetReport[]): NestedKeyCoverageReport {
  const sorted = [...targets].sort((a, b) => a.resourceType.localeCompare(b.resourceType));
  const allShapes = sorted.flatMap((t) => t.shapeEntries);
  const countShape = (b: ShapeBucket): number =>
    allShapes.filter((e) => e.bucket === b).length;
  return {
    summary: {
      targetCount: sorted.length,
      nestedKeyCount: sorted.reduce((n, t) => n + t.nestedKeyCount, 0),
      wholeDeliveredPathCount: sorted.reduce((n, t) => n + t.wholeDeliveredPaths.length, 0),
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

/** A blocking shape-pass finding, normalized for reporting. */
export interface Divergence {
  readonly resourceType: string;
  readonly nestedKey: string;
  readonly bucket: ShapeBucket;
  readonly detail?: string;
}

export function findDivergences(report: NestedKeyCoverageReport): readonly Divergence[] {
  return report.targets
    .flatMap((t) => t.shapeEntries)
    .filter((e) => e.bucket === 'array-vs-wrapper' || e.bucket === 'definition-member-missing')
    .map((e) => ({
      resourceType: e.resourceType,
      nestedKey: e.nestedKey,
      bucket: e.bucket,
      ...(e.sdkDetail !== undefined ? { detail: e.sdkDetail } : {}),
    }));
}

/**
 * Allow-list entries that no longer match any audited member — must be pruned.
 * Uses the MATCHED allow key recorded on each allow-listed verdict.
 */
export function findStaleAllowListEntries(
  report: NestedKeyCoverageReport,
  allowList: ReadonlyMap<string, AllowListEntry> = NESTED_KEY_ALLOW_LIST
): string[] {
  const used = new Set(
    report.targets
      .flatMap((t) => t.shapeEntries)
      .filter((e) => e.bucket === 'allow-listed')
      .map((e) => e.allowMatchKey ?? allowKey(e.resourceType, e.nestedKey))
  );
  return [...allowList.keys()].filter((k) => !used.has(k)).sort();
}

/**
 * {@link NestedKeyTarget.segmentRenames} entries that no longer do any work —
 * the staleness fence {@link NESTED_KEY_ALLOW_LIST} has, applied to the rename
 * map so it cannot rot into a set of inert exceptions.
 *
 * "Does work" is {@link wholeDeliveredPathsFor}'s own measurement, stated as a
 * NEGATION: an entry goes unused exactly when the UN-RENAMED chain resolves in
 * the write index, or when the CFn segment no longer appears in any audited
 * path at all. Both ways it can go dead are therefore caught — an SDK bump
 * that renames the member back, and an AWS schema change that drops the
 * property.
 */
export function findStaleSegmentRenames(
  report: NestedKeyCoverageReport,
  targetList: readonly NestedKeyTarget[] = NESTED_KEY_TARGETS
): string[] {
  const usedByType = new Map(report.targets.map((t) => [t.resourceType, new Set(t.usedSegmentRenames)]));
  const stale: string[] = [];
  for (const target of targetList) {
    const used = usedByType.get(target.resourceType);
    if (used === undefined) continue; // not in this report
    for (const segment of Object.keys(target.segmentRenames ?? {})) {
      if (!used.has(segment)) stale.push(`${target.resourceType}#${segment}`);
    }
  }
  return stale.sort();
}

function renderMarkdown(report: NestedKeyCoverageReport): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push('title: "Nested shape-divergence coverage matrix"');
  lines.push('unlisted: true');
  lines.push('---');
  lines.push('');
  lines.push('# Nested CFn->SDK shape-divergence coverage matrix');
  lines.push('');
  lines.push(
    '<!-- AUTO-GENERATED by scripts/gen-nested-key-coverage.ts — DO NOT EDIT BY HAND. -->'
  );
  lines.push('<!-- Regenerate: `vp run gen:nested-key-coverage`. -->');
  lines.push('');
  lines.push(
    'For every SDK provider that forwards a nested CFn config blob, compares the ' +
      "SHAPE of each CFn definition member (from the CFn registry schema fixtures) " +
      "against the SDK client's model: a bare CFn array the SDK models as a " +
      '`{Quantity, Items}` wrapper, or a member missing from the SDK interface a ' +
      'request carries for that definition, is a WRITE-SIDE SILENT DROP unless the ' +
      'provider re-shapes it. Key-spelling and write-presence drops are caught by the ' +
      'sdk-wire unit harness (`tests/unit/provisioning/sdk-wire-*.ts`) instead.'
  );
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Audited targets: **${report.summary.targetCount}**`);
  lines.push(`- Nested CFn key paths under handled top-levels: **${report.summary.nestedKeyCount}**`);
  lines.push(
    `- Paths delivered whole by a generic hand-off: **${report.summary.wholeDeliveredPathCount}**`
  );
  lines.push(`- Bare-array pairs clean: **${report.summary.shapeClean}**`);
  lines.push(`- Explicitly handled in provider: **${report.summary.shapeHandled}**`);
  lines.push(`- Allow-listed (does NOT block CI): **${report.summary.shapeAllowListed}**`);
  lines.push(`- **Array-vs-wrapper divergences (blocks CI): ${report.summary.arrayVsWrapper}**`);
  lines.push(
    `- **Definition-member-missing divergences (blocks CI): ${report.summary.definitionMemberMissing}**`
  );
  lines.push(`- Ambiguous (visible, non-blocking): **${report.summary.shapeAmbiguous}**`);
  lines.push('');

  const divergences = findDivergences(report);
  if (divergences.length > 0) {
    lines.push('## Divergences — BLOCKS CI');
    lines.push('');
    lines.push(
      'Each member below is templated by CFn but its shape does not reach AWS. ' +
        'Add the re-shaping to the provider (naming the CFn spelling), or add a ' +
        '`NESTED_KEY_ALLOW_LIST` entry with a rationale in ' +
        'scripts/gen-nested-key-coverage.ts.'
    );
    lines.push('');
    lines.push('| Resource type | CFn definition member | Bucket | SDK detail |');
    lines.push('| --- | --- | --- | --- |');
    for (const d of divergences) {
      lines.push(
        `| \`${d.resourceType}\` | \`${d.nestedKey}\` | ${d.bucket} | ${escapeCell(d.detail ?? '—')} |`
      );
    }
    lines.push('');
  } else {
    lines.push('## Divergences');
    lines.push('');
    lines.push(
      'None. Every audited shape divergence is explicitly re-shaped by its provider ' +
        'or allow-listed.'
    );
    lines.push('');
  }

  const allowListed = report.targets
    .flatMap((t) => t.shapeEntries)
    .filter((e) => e.bucket === 'allow-listed');
  if (allowListed.length > 0) {
    lines.push('## Allow-listed pass-throughs');
    lines.push('');
    lines.push('| Resource type | CFn definition | Member | Rationale |');
    lines.push('| --- | --- | --- | --- |');
    for (const e of allowListed) {
      lines.push(
        `| \`${e.resourceType}\` | \`${e.definition}\` | \`${e.nestedKey}\` | ${escapeCell(e.rationale ?? '')} |`
      );
    }
    lines.push('');
  }

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
        `| \`${e.resourceType}\` | \`${e.definition}\` | \`${e.nestedKey}\` | ${e.pass} | ${escapeCell(
          e.sdkDetail ?? '—'
        )} |`
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
    '| Resource type | Provider | SDK client | Key style | Nested key paths | Delivered whole | Unmatched definitions |'
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const t of report.targets) {
    lines.push(
      `| \`${t.resourceType}\` | \`${t.providerFile}\` | \`${t.sdkClientPackage}\` | ` +
        `${t.keyStyle} | ${t.nestedKeyCount} | ${t.wholeDeliveredPaths.length} | ` +
        `${t.unmatchedDefinitions.length} |`
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

/** Default SDK-model directory for a client package. Overridable in tests. */
export const defaultModelsDir = (sdkClientPackage: string): string =>
  resolve(repoRoot, 'node_modules', sdkClientPackage, 'dist-types/models');

export function loadReport(
  targetList: readonly NestedKeyTarget[] = NESTED_KEY_TARGETS,
  // Injection point so the two SDK-parse floors below are provable in the
  // RED direction (the repo's checker rules: a CI-blocking fence must be
  // shown to fire) — the member and interface parses are SEPARATE visitors
  // over the same files, so either can regress alone.
  resolveModelsDir: (sdkClientPackage: string) => string = defaultModelsDir,
  // Test seam (issue #1448): point the walk at a scratch COPY of the providers
  // tree so the SHIPPED `--check` exit path — and the hand-off / scope floors,
  // which nothing else can reach — are provable against REAL provider code
  // carrying an injected regression, with `src/` untouched.
  providersDir: string = PROVIDERS_DIR,
  // Test seam (issue #1464): point the FIXTURE walk at a scratch copy, so the
  // "this fixture was never re-captured" throw is provable in the RED
  // direction without hand-editing a committed fixture. Never exposed on the
  // CLI — a partially-captured fixture tree is an operator mistake, not a mode.
  fixtureDir: string = FIXTURE_DIR
): NestedKeyCoverageReport {
  const sdkMembersByPackage = new Map<string, Set<string>>();
  const sdkInterfacesByPackage = new Map<string, Map<string, Map<string, SdkMemberType>>>();
  const literalsByFile = new Map<string, Set<string>>();
  const writtenByFile = new Map<string, ProviderWriteEvidence>();
  const handledByFile = new Map<string, Map<string, Set<string>>>();

  /**
   * Source resolver for the WHOLE-BLOB HAND-OFF walk (issue #1445). Scoped to
   * SIBLING modules of the provider — `./agentcore-case-convert.js`, where the
   * tree's one real generic converter lives — and deliberately not to package
   * imports or parent directories: the walk only needs "does this callee name
   * members of its own?", and widening the resolver would pull the whole
   * `src/` graph into a per-file parse for no measured gain. Honors
   * `providersDir`, so a `--providers-dir=` scratch copy resolves its OWN
   * sibling and a regression injected there is seen.
   */
  const importSourceCache = new Map<string, string | undefined>();
  const resolveImportSource = (specifier: string): string | undefined => {
    if (!specifier.startsWith('./')) return undefined;
    const base = specifier.slice(2).replace(/\.js$/, '');
    if (base.length === 0 || base.includes('/')) return undefined;
    const path = join(providersDir, `${base}.ts`);
    if (!importSourceCache.has(path)) {
      importSourceCache.set(path, existsSync(path) ? readFileSync(path, 'utf8') : undefined);
    }
    return importSourceCache.get(path);
  };

  const targets: TargetReport[] = [];
  for (const target of targetList) {
    const fixturePath = join(fixtureDir, fixtureFilename(target.resourceType));
    if (!existsSync(fixturePath)) {
      throw new Error(
        `missing CFn schema fixture for ${target.resourceType} — run ` +
          `\`node scripts/refresh-cfn-schemas.mjs ${target.resourceType}\``
      );
    }
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      nestedPropertyPaths?: Record<string, string[]>;
      definitionShapes?: Record<string, Record<string, string>>;
    };
    // The refresher omits `nestedPropertyPaths` entirely for a type with zero
    // nested names, so absence is only an error when the target expects a
    // non-zero yield — for a `minNestedKeys: 0` target it just means
    // "nothing to audit".
    if (!fixture.nestedPropertyPaths && target.minNestedKeys > 0) {
      throw new Error(
        `fixture for ${target.resourceType} has no nestedPropertyPaths capture — re-run ` +
          `\`node scripts/refresh-cfn-schemas.mjs ${target.resourceType}\` (the field was ` +
          'added by issue #1464)'
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
      const modelsDir = resolveModelsDir(target.sdkClientPackage);
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

    const providerPath = join(providersDir, target.providerFile);
    let literals = literalsByFile.get(target.providerFile);
    let written = writtenByFile.get(target.providerFile);
    let handled = handledByFile.get(target.providerFile);
    if (!literals || !written || !handled) {
      const source = readFileSync(providerPath, 'utf8');
      literals = collectStringLiterals(source, target.providerFile);
      written = collectWriteEvidence(
        source,
        target.providerFile,
        REVERSE_MAP_FUNCTION_PREFIXES,
        resolveImportSource
      );
      handled = parseProviderSource(source, providerPath).handled;
      literalsByFile.set(target.providerFile, literals);
      writtenByFile.set(target.providerFile, written);
      handledByFile.set(target.providerFile, handled);
    }
    const handledTopLevel = handled.get(target.resourceType);
    if (!handledTopLevel || handledTopLevel.size === 0) {
      throw new Error(
        `${target.providerFile} declares no handledProperties for ${target.resourceType} — ` +
          'target table out of date?'
      );
    }

    // Write-side walk regression floors. A collapsed parse fails QUIET here,
    // not loud: a hand-off walk that finds nothing leaves every literal
    // rescuing (the PR #4324 miss reopened), and a scope index that resolves
    // nothing makes every segment rename look used. So each is fenced by a
    // floor, which names the real cause instead.
    if (target.minWriteScopes !== undefined) {
      const populatedScopes = [...written.scopes.values()].filter((s) => s.size > 0).length;
      if (populatedScopes < target.minWriteScopes) {
        throw new Error(
          `write-scope resolution for ${target.providerFile} collapsed to ` +
            `${populatedScopes} non-empty scopes (< ${target.minWriteScopes}) — ` +
            'parser regression?'
        );
      }
    }
    // Counts EXPANDING points only (see {@link countExpandingHandoffPoints} for
    // why the raw count is vacuous).
    if (target.minHandoffPoints !== undefined) {
      const points = countExpandingHandoffPoints(written, sdkInterfaces);
      if (points < target.minHandoffPoints) {
        throw new Error(
          `whole-blob hand-off walk for ${target.providerFile} collapsed to ` +
            `${points} blob-carrying hand-off point(s) (< ${target.minHandoffPoints}) — ` +
            'parser regression?'
        );
      }
    }

    const nestedKeys = nestedKeyPathsForTarget(fixture, handledTopLevel);
    if (nestedKeys.length < target.minNestedKeys) {
      throw new Error(
        `${target.resourceType} yielded only ${nestedKeys.length} nested keys ` +
          `(< ${target.minNestedKeys}) — fixture capture or handledProperties regression?`
      );
    }

    const usedSegmentRenames = new Set<string>();
    const wholeDeliveredPaths = wholeDeliveredPathsFor(
      target,
      nestedKeys,
      sdkMembers,
      written,
      usedSegmentRenames
    );

    const shapeResult = classifyTargetShapes(
      target,
      fixture.definitionShapes,
      sdkInterfaces,
      literals,
      NESTED_KEY_ALLOW_LIST,
      { nestedKeys, paths: wholeDeliveredPaths }
    );

    targets.push({
      resourceType: target.resourceType,
      providerFile: target.providerFile,
      sdkClientPackage: target.sdkClientPackage,
      keyStyle: target.keyStyle,
      nestedKeyCount: nestedKeys.length,
      wholeDeliveredPaths: [...wholeDeliveredPaths].sort(),
      shapeEntries: shapeResult.entries,
      shapeCleanCount: shapeResult.cleanCount,
      unmatchedDefinitions: shapeResult.unmatchedDefinitions,
      usedSegmentRenames: [...usedSegmentRenames].sort(),
    });
  }
  return buildReport(targets);
}

const USAGE =
  'Usage: node scripts/gen-nested-key-coverage.ts [--check] [--providers-dir=<path>]\n' +
  '  --check               fail on a divergence instead of writing the matrix\n' +
  '  --providers-dir=<p>   TEST SEAM: audit a scratch copy of the providers tree\n' +
  '                        (requires --check; the writer path must only ever\n' +
  '                        render docs/_generated from src/)\n';

function main(argv: readonly string[] = process.argv.slice(2)): void {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }
  // An unrecognized flag must NOT silently fall through to the WRITER path:
  // `--chekc` would rewrite the committed matrix and exit 0, and the SPACE form
  // `--providers-dir /tmp` would slip past the `--providers-dir=` prefix test
  // below. Same guard shape (and same reason) as `refresh-cfn-schemas.mjs`.
  const unknown = argv.filter(
    (a) => a.startsWith('-') && a !== '--check' && !a.startsWith('--providers-dir=')
  );
  if (unknown.length > 0) {
    process.stderr.write(`Unknown flag(s): ${unknown.join(', ')}\n${USAGE}`);
    process.exit(1);
  }
  // Nothing else is positional either — a bare argument is almost certainly a
  // mistyped flag or a path meant for `--providers-dir=`.
  const stray = argv.filter((a) => !a.startsWith('-'));
  if (stray.length > 0) {
    process.stderr.write(`Unexpected argument(s): ${stray.join(', ')}\n${USAGE}`);
    process.exit(1);
  }
  const checkMode = argv.includes('--check');
  // Test seam: point the provider walk at a scratch copy of the tree so the
  // shipped exit path can be exercised against a REAL provider file carrying an
  // injected regression, without ever mutating `src/` on disk (issue #1448).
  const dirFlag = argv.find((a) => a.startsWith('--providers-dir='));
  if (dirFlag !== undefined && !checkMode) {
    // The WRITER path would render the committed matrix from a scratch tree,
    // silently rewriting docs/_generated from code that is not `src/`.
    throw new Error('--providers-dir= is a --check-only test seam; refusing to write the matrix');
  }
  const report = loadReport(
    NESTED_KEY_TARGETS,
    defaultModelsDir,
    dirFlag ? resolve(dirFlag.slice('--providers-dir='.length)) : PROVIDERS_DIR
  );

  const stale = findStaleAllowListEntries(report);
  if (stale.length > 0) {
    process.stderr.write(
      'nested-key-coverage: FAIL — stale NESTED_KEY_ALLOW_LIST entr(ies) match no audited ' +
        'divergence. Remove them from scripts/gen-nested-key-coverage.ts:\n' +
        stale.map((k) => `  ${k}\n`).join('')
    );
    process.exit(1);
  }

  // Same discipline for the segment-rename map (issue #1464 review): an entry
  // that stopped doing work is an inert exception, and the only way to keep a
  // narrow escape hatch narrow is to make it fail when it is no longer needed.
  const staleRenames = findStaleSegmentRenames(report);
  if (staleRenames.length > 0) {
    process.stderr.write(
      'nested-key-coverage: FAIL — stale segmentRenames entr(ies) no longer resolve anything ' +
        'the un-renamed chain does not. Remove them from scripts/gen-nested-key-coverage.ts:\n' +
        staleRenames.map((k) => `  ${k}\n`).join('')
    );
    process.exit(1);
  }

  if (checkMode) {
    const divergences = findDivergences(report);
    if (divergences.length > 0) {
      process.stderr.write(
        'nested-key-coverage: FAIL — nested CFn->SDK shape divergence(s) detected.\n' +
          'These template members never reach AWS in the shape CFn declares: either a\n' +
          'bare CFn array the SDK models as a {Quantity, Items} wrapper (the CloudFront\n' +
          'idiom), or a member missing from the SDK interface a request carries for its\n' +
          'definition (the CachedMethods class). Add the re-shaping to the provider\n' +
          '(naming the CFn spelling), or add a NESTED_KEY_ALLOW_LIST entry with a\n' +
          'rationale in scripts/gen-nested-key-coverage.ts.\n\n'
      );
      for (const d of divergences) {
        const detail = d.detail ? ` (${d.detail})` : '';
        process.stderr.write(`  ${d.resourceType}: ${d.nestedKey} [${d.bucket}]${detail}\n`);
      }
      process.exit(1);
    }
    process.stderr.write(
      `nested-key-coverage: OK — shape pass 0 divergences across ` +
        `${report.summary.targetCount} targets (${report.summary.shapeClean} clean, ` +
        `${report.summary.shapeHandled} provider-handled` +
        (report.summary.shapeAllowListed > 0
          ? `, ${report.summary.shapeAllowListed} allow-listed`
          : '') +
        (report.summary.shapeAmbiguous > 0
          ? `, ${report.summary.shapeAmbiguous} ambiguous`
          : '') +
        `; ${report.summary.wholeDeliveredPathCount} of ${report.summary.nestedKeyCount} ` +
        'nested paths delivered whole).\n'
    );
    return;
  }

  mkdirSync(dirname(OUT_JSON), { recursive: true });
  atomicWrite(OUT_JSON, JSON.stringify(report, null, 2) + '\n');
  atomicWrite(OUT_MD, renderMarkdown(report) + '\n');
  process.stderr.write(
    `nested-key-coverage: wrote nested-key-coverage.{json,md} — ` +
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
