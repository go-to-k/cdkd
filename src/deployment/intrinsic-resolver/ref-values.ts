import { displayIdent } from '../../utils/display-safe.js';
import { SECRET_MASK, carriesSecretMask } from '../secret-redaction.js';
import { isDynamicReferenceString } from '../secret-redaction/rules.js';
import { parseWebACLArn } from '../../provisioning/providers/wafv2-arn.js';
import {
  COMPOSITE_ID_SEPARATOR,
  canonicalizeRoute53QueryName,
  segmentAfterAnchor,
} from '../../provisioning/composite-id.js';

/**
 * Special symbol to represent AWS::NoValue
 *
 * When a property resolves to this symbol, it should be removed from the object.
 * This is used for conditional property omission in CloudFormation templates.
 */
export const AWS_NO_VALUE = Symbol('AWS::NoValue');

/**
 * Resource types whose CloudFormation `Ref` returns the segment AFTER the LAST
 * pipe in cdkd's compound physical id (rather than the whole physical id).
 *
 * Membership is decided by the ID SHAPE, not by the routing layer, and the Set
 * carries BOTH kinds:
 *
 *  - **Cloud-Control-provisioned** (the original and still the majority) —
 *    either the type has no SDK provider, or the #614 silent-drop routing sent
 *    an SDK-backed type through CC (e.g. an ApiGateway Stage carrying
 *    `MethodSettings`, which the SDK provider does not wire — issue #963). CC's
 *    primaryIdentifier is compound (`<parentId>|<ref>`, or `<a>|<b>|<ref>` for
 *    triple-segment AppConfig children) while CFn's `Ref` returns only the
 *    trailing `<ref>`. For SDK-provisioned instances of these types the stored
 *    id has no pipe, so the extraction is a no-op.
 *  - **SDK-provisioned, provider-built compound** — the SDK provider ITSELF
 *    packs the segments because its CRUD calls need all of them while
 *    `ResourceProvider`'s read-side methods receive a single string. Here the
 *    extraction is load-bearing on the ORDINARY deploy path and there is no
 *    pipe-free variant to fall through. `AWS::S3Tables::Namespace` /
 *    `::Table` (whose per-routing split is spelled out at their entry) are
 *    these. `AWS::Glue::Table` was too (issue #1667) until its table name was
 *    allowed to contain `|` (issue #1672); it now takes
 *    {@link glueTableRefFromPhysicalId}.
 *
 * The per-type map:
 *   - AWS::ApiGateway::Model            `<restApiId>|<modelName>`     -> model name
 *   - AWS::ApiGateway::RequestValidator `<restApiId>|<validatorId>`   -> validator id
 *   - AWS::ApiGateway::Stage            `<restApiId>|<stageName>`     -> stage name
 *   - AWS::ApiGateway::Resource         `<restApiId>|<resourceId>`    -> resource id
 *   - AWS::ApiGateway::Authorizer       `<restApiId>|<authorizerId>`  -> authorizer id
 *   - AWS::ApiGatewayV2::Stage          `<apiId>|<stageName>`         -> stage name
 *   - AWS::ApiGatewayV2::Route          `<apiId>|<routeId>`           -> route id
 *   - AWS::ApiGatewayV2::Integration    `<apiId>|<integrationId>`     -> integration id
 *   - AWS::ApiGatewayV2::Model          `<apiId>|<modelId>`           -> model id
 *   - AWS::ApiGatewayV2::Deployment     `<apiId>|<deploymentId>`      -> deployment id
 *   - AWS::ApiGatewayV2::RouteResponse       `<apiId>|<routeId>|<respId>` -> route response id
 *   - AWS::ApiGatewayV2::IntegrationResponse `<apiId>|<intId>|<respId>`   -> integration response id
 *   - AWS::Cognito::UserPoolClient           `<userPoolId>|<clientId>`       -> client id
 *   - AWS::Cognito::UserPoolResourceServer   `<userPoolId>|<identifier>`     -> resource-server identifier
 *   - AWS::Cognito::UserPoolGroup            `<userPoolId>|<groupName>`      -> group name
 *   - AWS::Cognito::UserPoolIdentityProvider `<userPoolId>|<providerName>`   -> provider name
 *   - AWS::Cognito::UserPoolDomain           `<userPoolId>|<domain>`         -> domain
 *   - AWS::Cognito::UserPoolUser             `<userPoolId>|<username>`       -> username
 *   - AWS::AppConfig::Environment            `<appId>|<envId>`               -> environment id
 *   - AWS::AppConfig::ConfigurationProfile   `<appId>|<profileId>`           -> profile id
 *   - AWS::AppConfig::HostedConfigurationVersion `<appId>|<profileId>|<ver>` -> version number
 *   - AWS::AppConfig::Deployment             `<appId>|<envId>|<deployNum>`   -> deployment number
 *
 * The extraction takes the segment after the LAST pipe (see
 * {@link IntrinsicFunctionResolver.resolveRefValue}) so it is correct for both
 * 2-segment (`<parent>|<ref>`) and 3-segment AppConfig compounds; for the
 * 2-segment types it is identical to after-first-pipe. AppConfig::Application
 * and ::DeploymentStrategy are NOT here — their Ref is a simple, pipe-free id.
 *
 * MAINTENANCE — when you add a type here, AUDIT THE WHOLE SERVICE FAMILY, not
 * just the one type a bug surfaced. CC compound-id types cluster by service (the
 * Cognito UserPool family alone needed 5 entries; AppConfig needed 4) because a
 * service's child resources share the `<parentId>|<childKey>` id convention. For
 * each sibling child type:
 *   1. `aws cloudformation describe-type --type RESOURCE --type-name AWS::<Svc>::<T>`
 *      -> `Schema.primaryIdentifier` confirms it is compound + the segment order.
 *   2. Read the type's AWS-docs "Return values / Ref" — add it ONLY if `Ref`
 *      returns the trailing `<child>` segment.
 *   3. EXCLUDE types whose `Ref` returns a synthetic / prefixed string rather
 *      than a bare id segment — e.g. Cognito::UserPoolRiskConfigurationAttachment
 *      / ::UserPoolUICustomizationAttachment return
 *      `<TypeName>-<UserPoolId>-<ClientId>`, NOT the after-pipe segment;
 *      ApiGateway::Method is in this category too (its documented `Ref` is a
 *      CFn-generated synthetic id like `mysta-metho-01234b567890example`, not
 *      reconstructible from the `<apiId>|<resourceId>|<verb>` physical id).
 *      Also EXCLUDE types whose AWS-docs page documents NO `Ref` return value
 *      at all (ApiGateway::DocumentationVersion, Lambda::Permission) — with no
 *      contract to honor, the raw physical id is the least-surprising value.
 *      The 2026-07-03 cross-family audit of every SDK-registered compound-id
 *      type also excluded EC2::Route ("the ID of the route") /
 *      EC2::VPCGatewayAttachment ("the ID of the VPC gateway attachment") /
 *      Lambda::EventInvokeConfig ("a unique identifier") — all synthetic CFn
 *      ids with no bare-segment contract and no consuming API — and
 *      confirmed WAFv2::WebACL's `Ref` IS the pipe-joined compound (see the
 *      special case in {@link cfnRefValueFromPhysicalId}).
 *   4. Types whose primaryIdentifier puts the `Ref` component FIRST
 *      (`[<refId>, <parentId>]` — e.g. ApiGateway::Deployment /
 *      ::DocumentationPart) belong in
 *      {@link REF_RETURNS_SEGMENT_BEFORE_FIRST_PIPE} instead of this Set: the
 *      after-last-pipe extraction would return the PARENT id for them.
 *   5. Pin each addition with a unit test in intrinsic-functions.test.ts.
 *
 * AUDIT RECORD (2026-08-12, issue #1667) — every type in the composite-id table
 * of `docs/state-management.md` was re-checked against its docs-verified `Ref`,
 * plus the two types that table lists as ACCEPTING a composite without
 * producing one. `AWS::Glue::Table` was the one this Set could fix and was
 * added here; it has since moved to {@link glueTableRefFromPhysicalId} (issue
 * #1672), because its table name may contain `|`. The types deliberately NOT in either Set, with the reason:
 *   - correct to exclude, `Ref` is a synthetic / AWS-generated id no segment
 *     reconstructs: ApiGateway::Method, EC2::NetworkAclEntry ("the ID of the
 *     network ACL entry"), EC2::Route, EC2::VPCGatewayAttachment,
 *     Lambda::EventInvokeConfig;
 *   - correct to exclude, the docs page documents NO `Ref` return value at all:
 *     EC2::SecurityGroupIngress (and its Egress sibling, same id shape), and
 *     Lambda::Permission — cdkd stores the bare statement id, but state written
 *     by the older Cloud Control path can hold `<functionArn>|<statementId>`,
 *     and with no documented contract the raw id is the least-surprising value
 *     (the same call the maintenance note above already records for it);
 *   - already correct, no change needed: EC2::EIP (before-first-pipe),
 *     S3Tables::Namespace / ::Table (added by the 2026-07-03 close-out audit),
 *     ECS::Service (before-first-pipe; stores the bare ARN on the SDK path);
 *   - was KNOWN WRONG and not fixable by a Set entry; FIXED by issue #1681,
 *     each with a mechanism of its own rather than an entry here:
 *     AppSync::ApiKey / ::DataSource / ::Resolver (`Ref` returns the resource
 *     ARN, which is no segment of the compound id — recovered from the
 *     provider-recorded ARN attribute via {@link REF_RETURNS_ARN_FROM_STATE})
 *     and Route53::RecordSet (`Ref` returns "the name of the record" — the
 *     MIDDLE segment of `<hostedZoneId>|<name>|<type>`, which neither
 *     after-LAST-pipe nor before-FIRST-pipe yields, so it takes
 *     {@link REF_RETURNS_SEGMENT_AT_INDEX}).
 */
export const REF_RETURNS_SEGMENT_AFTER_PIPE = new Set<string>([
  'AWS::ApiGateway::Model',
  'AWS::ApiGateway::RequestValidator',
  'AWS::ApiGateway::Stage',
  'AWS::ApiGateway::Resource',
  'AWS::ApiGateway::Authorizer',
  'AWS::ApiGatewayV2::Stage',
  'AWS::ApiGatewayV2::Route',
  'AWS::ApiGatewayV2::Integration',
  'AWS::ApiGatewayV2::Model',
  'AWS::ApiGatewayV2::Deployment',
  'AWS::ApiGatewayV2::RouteResponse',
  'AWS::ApiGatewayV2::IntegrationResponse',
  'AWS::Cognito::UserPoolClient',
  'AWS::Cognito::UserPoolResourceServer',
  'AWS::Cognito::UserPoolGroup',
  'AWS::Cognito::UserPoolIdentityProvider',
  'AWS::Cognito::UserPoolDomain',
  'AWS::Cognito::UserPoolUser',
  'AWS::AppConfig::Environment',
  'AWS::AppConfig::ConfigurationProfile',
  'AWS::AppConfig::HostedConfigurationVersion',
  'AWS::AppConfig::Deployment',
  // S3Tables children (cross-family close-out audit, 2026-07-03): their SDK
  // provider ITSELF stores the compound (`<tableBucketARN>|<namespace>` /
  // `<tableBucketARN>|<namespace>|<tableName>`), so unlike the ApiGateway
  // family the extraction is load-bearing on the SDK path for BOTH types. On
  // the CC path it is load-bearing for Namespace only (compound
  // primaryIdentifier `[TableBucketARN, Namespace]`); Table's CC
  // primaryIdentifier is the bare single-segment TableARN, so a #614-routed
  // Table stores a pipe-free ARN and the after-pipe extraction no-ops. That
  // pipe-free ARN ends in a UUID (not the table name CFn `Ref` returns) and is
  // NOT reconstructible from the physical id alone — so the CC-routed table
  // name is recovered from the stored `TableName` property via the
  // `stateLookup` seam in `cfnRefValueFromPhysicalId` (issue #974), which fires
  // ONLY when the physical id has no pipe (i.e. the CC path) and leaves the SDK
  // compound path untouched. The TableBucketARN contains no pipes, so
  // after-LAST-pipe is safe on the SDK path. Docs: Namespace `Ref` returns the
  // namespace name; Table `Ref` returns the table name.
  'AWS::S3Tables::Namespace',
  'AWS::S3Tables::Table',
  // AWS::Glue::Table is NOT here, though its id is `<databaseName>|<tableName>`
  // and its `Ref` is the table name: a table name may itself contain `|`, so
  // after-LAST-pipe would return only its tail. It takes
  // {@link glueTableRefFromPhysicalId} instead (issue #1672).
]);

/**
 * Sibling of {@link REF_RETURNS_SEGMENT_AFTER_PIPE} for compound-id types
 * whose CC primaryIdentifier puts the `Ref` component FIRST
 * (`[<refId>, <parentId>]` — segment order REVERSED vs the after-pipe family),
 * so CFn's `Ref` value is the segment BEFORE the FIRST pipe (issue #963
 * family audit; both confirmed against the AWS-docs "Return values / Ref"
 * section). Examples — the Set below is the complete list, each entry with its
 * own reason:
 *   - AWS::ApiGateway::Deployment       `<deploymentId>|<restApiId>` -> deployment id
 *   - AWS::ApiGateway::DocumentationPart `<docPartId>|<restApiId>`    -> documentation part id
 *   - AWS::ApiGatewayV2::Authorizer      `<authorizerId>|<apiId>`     -> authorizer id
 *   - AWS::ApiGatewayV2::ApiMapping      `<apiMappingId>|<domainName>` -> api mapping id
 *
 * Deployment matters in practice: every CDK-generated template wires the
 * Stage's `DeploymentId` as `{ Ref: <Deployment> }`, so a CC-routed
 * Deployment would otherwise hand the Stage a compound id AWS rejects; the V2
 * Authorizer matters the same way (a Route's `AuthorizerId` is
 * `{ Ref: <Authorizer> }` in every CDK HTTP-API-with-authorizer template).
 * Same maintenance rules as the after-pipe Set (docs-verified Ref semantics +
 * a pinning unit test per entry).
 *
 * WARNING — the V1 and V2 families are CROSS-WIRED, do not pattern-match one
 * from the other: V1 Authorizer is `[RestApiId, AuthorizerId]` (after-pipe)
 * while V2 Authorizer is `[AuthorizerId, ApiId]` (before-first-pipe), and V1
 * Deployment is `[DeploymentId, RestApiId]` (before-first-pipe) while V2
 * Deployment is `[ApiId, DeploymentId]` (after-pipe). Always re-check the
 * type's own `describe-type` primaryIdentifier.
 */
export const REF_RETURNS_SEGMENT_BEFORE_FIRST_PIPE = new Set<string>([
  // EIP physicalId is `PublicIp|AllocationId`; CloudFormation's `Ref` returns the
  // public IP (the segment before the first pipe). GetAtt AllocationId / PublicIp
  // are served separately by EC2Provider.getAttribute.
  'AWS::EC2::EIP',
  'AWS::ApiGateway::Deployment',
  'AWS::ApiGateway::DocumentationPart',
  'AWS::ApiGatewayV2::Authorizer',
  'AWS::ApiGatewayV2::ApiMapping',
  // Cross-family close-out audit (2026-07-03): CC primaryIdentifier is
  // `[ServiceArn, Cluster]` and the docs-verified `Ref` is the service ARN —
  // the FIRST segment. The SDK provider stores the bare ARN (pipe-free, so
  // the extraction is a no-op there); only a #614-routed instance stores the
  // compound. Neither an ECS service ARN nor a cluster name can contain `|`.
  'AWS::ECS::Service',
  // No SDK provider registers it, so it is always Cloud-Control-routed and
  // stored as `<Id>|<VpcId>` (CC primaryIdentifier `[Id, VpcId]`, live
  // `DescribeType`, us-east-1, 2026-09-25); the docs-verified `Ref` is the
  // association id — the FIRST segment (issue #3700). No cdkd writer records
  // a bare `vpc-cidr-assoc-…` (see the `cdkd export` splitter's comment); one
  // in a hand-edited record is pipe-free and passes through unchanged.
  'AWS::EC2::VPCCidrBlock',
]);

/**
 * SDK-provisioned types whose provider stores the resource ARN as the physical
 * id (their delete / update paths need the ARN), while CloudFormation's `Ref`
 * returns the CFn physical resource id — which for these types is NOT the ARN:
 *   - `AWS::Events::Rule` → the rule name (`arn:…:rule/<name>`), or
 *     `<busName>|<ruleName>` for a custom-bus rule
 *     (`arn:…:rule/<busName>/<ruleName>`) — the physical id CloudFormation
 *     reports for such rules. The ARN stays reachable via `Fn::GetAtt Arn`.
 *   - `AWS::CloudTrail::Trail` → the trail name (`arn:…:trail/<name>`).
 * Value: the ARN resource-type marker after which the CFn `Ref` value starts.
 */
export const REF_RETURNS_NAME_FROM_ARN = new Map<string, string>([
  ['AWS::Events::Rule', ':rule/'],
  ['AWS::CloudTrail::Trail', ':trail/'],
]);

/**
 * Third sibling of the two `REF_RETURNS_SEGMENT_*_PIPE` Sets, for a compound id
 * whose `Ref` segment is neither the first nor the last (issue #1681).
 *
 * `AWS::Route53::RecordSet` is the only entry: `Route53Provider` stores
 * `<hostedZoneId>|<name>|<type>` while CloudFormation's `Ref` returns "the name
 * of the record" (docs-verified 2026-08-12) — the MIDDLE segment. Neither
 * existing Set can express that (after-LAST-pipe yields the record TYPE `A`,
 * before-FIRST-pipe yields the hosted zone id), which is why the type was filed
 * rather than added to one of them.
 *
 * Value: `arity` is the EXACT segment count the extraction is valid for and
 * `index` the 0-based segment to return. Requiring the exact arity rather than
 * a minimum keeps a mis-arity'd id from yielding a confidently-wrong segment.
 * A record name may itself contain `|` (issue #3890), which makes the id
 * longer than three segments; {@link recordSetRefFromPhysicalId} places that
 * name on the recorded `Name` / `Type`, and only an id it cannot anchor falls
 * through to the raw physical id.
 *
 * Same maintenance rules as the two Sets: docs-verified `Ref` semantics per
 * type, a whole-service-family audit before adding one, and a pinning unit test
 * asserting the RESOLVED value (not merely map membership).
 */
export const REF_RETURNS_SEGMENT_AT_INDEX = new Map<string, { arity: number; index: number }>([
  ['AWS::Route53::RecordSet', { arity: 3, index: 1 }],
]);

/**
 * Compound-id types whose CFn `Ref` is the resource ARN, recovered from an ARN
 * ATTRIBUTE the provider recorded at create time (issue #1681).
 *
 * The three `AWS::AppSync::*` child types pack a compound physical id
 * (`<apiId>|<name>`, `<apiId>|<typeName>|<fieldName>`, `<apiId>|<apiKeyId>`)
 * while CloudFormation's `Ref` returns the resource ARN (all three
 * docs-verified 2026-08-12). The ARN is not a SEGMENT of the id, so no
 * `REF_RETURNS_SEGMENT_*` mechanism can produce it — it has to be recovered,
 * and the same `stateLookup` seam the S3Tables / Backup / CodeCommit cases use
 * is preferred over string-building an ARN here: `AppSyncProvider` records the
 * real ARN (from the create response where AWS reports one, else reconstructed
 * from the deploy's own partition / region / account), so the resolver does not
 * have to re-derive account context it may not share with the provider.
 *
 * Value: the attribute keys to try, in order.
 *
 * Degradation is deliberate and matches the sibling recoveries: when the
 * attribute is absent the raw compound id is returned rather than a fabricated
 * ARN. Since issue #1728 an IMPORTED child records the same attribute set
 * `create()` does (`AppSyncProvider.childImportAttributes`), so the miss is no
 * longer the normal case for an adopted resource — it is now reached by a
 * record written before #1681/#1728, or by an import whose ARN build failed and
 * warned.
 */
export const REF_RETURNS_ARN_FROM_STATE = new Map<string, readonly string[]>([
  ['AWS::AppSync::ApiKey', ['Arn']],
  ['AWS::AppSync::DataSource', ['DataSourceArn']],
  ['AWS::AppSync::Resolver', ['ResolverArn']],
]);

/**
 * Is `value`, recorded under `attributeName` of a `resourceType` record, a
 * pre-#1681 PLACEHOLDER ARN — a value that is present but knowably unusable?
 *
 * The one predicate behind `rejectPlaceholderArnAttribute`'s refusal and the
 * #1852 heal's "this recorded value may be overwritten" exception
 * (`mergeHealedAttributes`), so the two cannot disagree about which records are
 * stale. Scoped to the {@link REF_RETURNS_ARN_FROM_STATE} types AND their
 * declared ARN attribute names — see that refusal's note for why no wider.
 */
export function isStalePlaceholderArnAttribute(
  resourceType: string,
  attributeName: string,
  value: unknown
): boolean {
  const arnAttributeKeys = REF_RETURNS_ARN_FROM_STATE.get(resourceType);
  if (!arnAttributeKeys?.includes(attributeName)) return false;
  return typeof value === 'string' && isPlaceholderArn(value);
}

/**
 * Optional state-backed lookup so {@link cfnRefValueFromPhysicalId} can recover
 * a `Ref` value that is NOT reconstructible from the physical id alone (see the
 * `AWS::S3Tables::Table` CC-routed case). Both call sites pass the resource's
 * stored `properties` then `attributes` map, so a template property recorded at
 * create time (`TableName`) or an enriched attribute is reachable. Returns the
 * stringified value for the first key present, or `undefined` when none match.
 */
export type RefStateLookup = (
  keys: readonly string[],
  options?: RefStateLookupOptions
) => string | undefined;

/** Per-call options for a {@link RefStateLookup}. */
export interface RefStateLookupOptions {
  /**
   * For a caller with NO redaction bag: keep scanning past a masked leaf and
   * return a clean value from a later bag when one exists, the mask only when
   * none does. Without it such a caller gets the first mask it meets, even
   * beside a clean `attributes` value. Only {@link glueTableRefFromPhysicalId}
   * passes it, for the `DatabaseName` anchor `cdkd import` records in both
   * bags (issue #3892). A caller WITH a bag already skips masks; unchanged.
   */
  readonly preferCleanValue?: boolean;
  /**
   * Treat a value carrying a `{{resolve:...}}` dynamic reference as REDACTED,
   * exactly like {@link SECRET_MASK}: a caller with a bag gets it reported, a
   * caller without one gets {@link SECRET_MASK} back. `redactSecretsForState`
   * records such a template value as its EXPRESSION, which is neither a mask
   * nor the value AWS holds. Only {@link recordSetRefFromPhysicalId} passes
   * it, for the `Name` / `Type` anchors (issue #3890).
   */
  readonly dynamicReferenceIsRedacted?: boolean;
}

/**
 * Build a {@link RefStateLookup} from a resource's stored state maps, checking
 * `properties` first (the template value CFn `Ref` mirrors) then `attributes`.
 * Only non-empty string values qualify — an intrinsic-shaped or empty value is
 * skipped so the caller falls back to the raw physical id rather than emitting
 * a broken `[object Object]` / `''`.
 *
 * A leaf carrying {@link SECRET_MASK} is handled specially, and that handling
 * is a SECURITY property rather than a shape one (issue
 * [#2847](https://github.com/go-to-k/cdkd/issues/2847)). Both bags this reads
 * can hold the mask: `attributes` because `CloudControlProvider.import` masks
 * every model key it cannot certify is a read-only attribute, and `properties`
 * because the mask-only channel (issue #2274) writes it there too.
 * `SECRET_MASK` is a non-empty string, so the lookup HITS and
 * `cfnRefValueFromPhysicalId` returns `'***'` as the resource's `Ref` value —
 * which `resolveRefValue` hands back verbatim and a green deploy substitutes
 * into the consumer's property and sends to AWS. That is the #1498 / #1501
 * corrupted-write class, reached through the ONE attribute reader that is not
 * an `Fn::GetAtt`.
 *
 * ## The skip is OPT-IN, and that is the load-bearing design decision
 *
 * `onMaskedValue` is not a notification bolted onto a global behaviour change;
 * it is the SWITCH. With no callback this function returns the mask exactly as
 * it did before issue #2847 — same value, same callers, nothing to audit. Only
 * a caller that passes one gets the skip, and by passing one it declares it
 * will ACT on the report.
 *
 * IT WAS UNCONDITIONAL FOR THREE REVIEW ROUNDS, and each round found a fresh
 * caller broken by it, because skipping a mask is only an improvement for a
 * caller that has somewhere to put the refusal. For everyone else it REMOVES a
 * guarded sentinel and substitutes an unguarded wrong value: the fall-through
 * emits the raw physical id — for `AWS::S3Tables::Table` an ARN ending in a
 * UUID rather than the table name CFn `Ref` returns — which
 * `refuseMaskedReplayBaseline`, `cdkd export`'s blocker, `cdkd drift`'s mask
 * handling and the deploy-time refusal all pass, where every one of them
 * REJECTS `'***'` loudly. The rounds found it in `cdkd orphan`, then in
 * `resolveOutputs`, then in `cdkd import`; the pattern was the design, not the
 * call sites, so the design changed rather than the sites.
 *
 * A caller therefore chooses between exactly two things, and doing NOTHING is
 * the safe default rather than a hole:
 *
 * 1. **Pass no callback** — pre-#2847 behaviour, the mask travels, downstream
 *    readers catch it. Every caller that has not opted in is in this bucket by
 *    construction, so there is no per-caller audit to keep current.
 * 2. **Pass one and act on it** — skip the mask and refuse. `resolveRefValue`
 *    → `noteRefStateMask` → `ResolverContext.redactedAttributeReads`, read by
 *    `DeployEngine.refuseRedactedAttributeReads` on the CREATE / UPDATE arms
 *    and by `resolveOutputs`' own per-output check;
 *    `src/analyzer/orphan-rewriter.ts` has no resolver context and reports the
 *    site as `unresolvable` instead (under `--force` it warns and substitutes
 *    `SECRET_MASK`, i.e. it opts back into bucket 1's VALUE deliberately).
 *
 * BUCKET 1 IS NOT "the harmless callers", and one of them was mis-described as
 * display-only before the opt-in existed: `cdkd export`'s
 * `resolveChildImportParameters` builds a bagless context whose result becomes
 * a `Parameter[]` on `CreateChangeSet --change-set-type IMPORT` — a re-apply to
 * a live system. It is safe for bucket 1's ORDINARY reason rather than a
 * special one: bagless, so it ships `'***'`, which CloudFormation rejects
 * loudly, exactly as it did before issue #2847. Whether it should REFUSE
 * instead is a separate choice nobody has made. That is the shape of the
 * argument every bucket-1 caller gets: not "this value goes nowhere" but "the
 * mask still reaches a reader that recognises it".
 *
 * The resolver passes a callback from ONE site — `resolveRefValue` — and it
 * passes one only when `context.redactedAttributeReads` EXISTS. Testing the
 * bag at the call site rather than inside `noteRefStateMask` is the whole
 * point: the note returning early still leaves the SKIP done, so a bagless
 * context took the fall-through with nowhere to record the refusal. That is
 * how `cdkd import` came to PERSIST a raw physical id into
 * `resource.properties` — from where `cdkd export` writes it into the imported
 * template and `cdkd drift --revert` sends it to AWS. `cdkd diff` and
 * `cdkd scrub` are bagless too and simply resolve as they did before.
 *
 * `onMaskedValue` fires only when the WHOLE lookup came up empty, not at the
 * masked leaf. The scan spans two bags and several alias keys, so a masked
 * `properties.TableName` beside a live `attributes.TableName` is an ordinary,
 * fully resolvable record — `cdkd import`'s own shape — and notifying there
 * would fail a deploy that has the value it needs. The distinction is "cdkd
 * could not answer, and the reason was a redaction", which is the only case
 * that must refuse. An ABSENT key keeps degrading to the physical id exactly as
 * before: the recovery branches document that graceful fall-through for a
 * pre-#1045 / pre-#1681 record, and nothing about that case changed.
 */
export function refStateLookupFromResource(
  resource: {
    properties?: Record<string, unknown>;
    attributes?: Record<string, unknown>;
  },
  onMaskedValue?: (key: string) => void
): RefStateLookup {
  return (keys, options) => {
    // Only for a caller with no bag that asked for it: the first mask seen,
    // returned if no clean value follows.
    let deferredMask: string | undefined;
    // THE KEY AND ITS NOTIFIER ARE RECORDED TOGETHER, so the invariant is
    // type-level rather than a comment: a skipped mask exists only where there
    // is a callback to report it to. An earlier revision kept a bare
    // `maskedKey` and ended with `onMaskedValue?.(maskedKey)`, whose optional
    // call is UNREACHABLE — the arm below returns when the callback is absent
    // — and so read as though the two could disagree.
    let masked: { readonly key: string; readonly notify: (key: string) => void } | undefined;
    for (const source of [resource.properties, resource.attributes]) {
      if (!source) continue;
      for (const key of keys) {
        // allow-template-keyed-bag-read: `keys` is the fixed list cdkd passes to a
        // `RefStateLookup`, not template text.
        const value = source[key];
        if (typeof value === 'string' && value.length > 0) {
          const dynamicReference =
            options?.dynamicReferenceIsRedacted === true && isDynamicReferenceString(value);
          if (carriesSecretMask(value) || dynamicReference) {
            // THE OPT-IN, and it is the whole safety argument of this arm.
            // A caller that passed no `onMaskedValue` gets `main`'s behaviour
            // byte for byte: the mask is RETURNED, four readers recognise it,
            // and this function has changed nothing for them.
            if (onMaskedValue === undefined) {
              const served = dynamicReference ? SECRET_MASK : value;
              if (options?.preferCleanValue !== true) return served;
              deferredMask ??= served;
              continue;
            }
            masked ??= { key, notify: onMaskedValue };
            continue;
          }
          return value;
        }
      }
    }
    if (deferredMask !== undefined) return deferredMask;
    if (masked !== undefined) masked.notify(masked.key);
    return undefined;
  };
}

/**
 * The `Ref` value of an `AWS::Glue::Table` — its table name — from cdkd's
 * `<databaseName>|<tableName>` physical id, or `undefined` for a pipe-free id
 * (which the caller passes through unchanged).
 *
 * EITHER name may contain `|` (a table name since issue #1672, a database name
 * since #3892; AWS accepts both and CloudFormation manages such tables), so
 * neither after-LAST-pipe nor a bare split can find it: `mydb|a|b` is table
 * `a|b`, `x|y|t` in database `x|y` is table `t`. The id is read the way
 * `GlueProvider`'s decode sites read it (`decodeTableId`), so a `{Ref}` names
 * the table they address:
 *
 * 1. With more than one `|`, anchor on the `DatabaseName` recorded in state
 *    (`properties`, then `attributes`) — the table name is everything after
 *    `<DatabaseName>|`. Every current writer records it: `createTable` in
 *    `properties`, resolved; `importTable` also in `attributes`, for a record
 *    whose `properties` keep an unresolved intrinsic.
 * 2. Otherwise everything after the FIRST `|`. For a two-segment id that is
 *    exact, and a two-segment id never consults state, so an ordinary table's
 *    `Ref` reads nothing but its id, as it always has. For a longer id it is a
 *    guess, reached only by a record no current writer produces (an older
 *    binary's import or replay, or a hand edit) — where the decode sites SKIP
 *    the same record loudly, so the stack is already flagged.
 *
 * A MASKED `DatabaseName` in step 1 is handled as for every state-recovered
 * `Ref`: with database names allowed to carry `|`, the step 2 fallback can no
 * longer be trusted for a longer id. A caller with a redaction bag gets a
 * redacted read reported (the deploy or output refuses); a caller without one
 * gets the MASK itself back, which its downstream readers recognise — never
 * the guess, which they would not.
 *
 * The lookup returns the first string `DatabaseName` it meets (`properties`,
 * then `attributes`), so an anchor that does not prefix the id ends the search
 * there; the decode sites try each bag instead. A `DatabaseName` that does not
 * prefix the id is recorded by `cdkd import`'s two-segment composite reading
 * (`a|b` beside a template `DatabaseName` of `x`); such an id has one `|`, so
 * step 1 never runs for it and both readers take `b`.
 */
export function glueTableRefFromPhysicalId(
  physicalId: string,
  stateLookup?: RefStateLookup
): string | undefined {
  const firstPipe = physicalId.indexOf(COMPOSITE_ID_SEPARATOR);
  if (firstPipe < 0) return undefined;
  if (physicalId.includes(COMPOSITE_ID_SEPARATOR, firstPipe + 1) && stateLookup) {
    // `preferCleanValue`: an imported record can carry a masked property beside
    // a clean `attributes.DatabaseName` (issue #3892); the clean one anchors.
    const anchor = stateLookup(['DatabaseName'], { preferCleanValue: true });
    // A caller with no redaction bag gets the MASK back from the lookup (the
    // lookup's opt-in). Serve it rather than the first-`|` guess: the mask is
    // what `refuseMaskedReplayBaseline`, `cdkd export`'s blocker and drift
    // recognise, while a guess — wrong for a database name carrying `|` —
    // passes all of them.
    if (anchor !== undefined && carriesSecretMask(anchor)) return anchor;
    const tableName = segmentAfterAnchor(physicalId, anchor);
    if (tableName !== undefined) return tableName;
  }
  return physicalId.substring(firstPipe + 1);
}

/**
 * The `Ref` value of an `AWS::Route53::RecordSet` — its record name — from a
 * `<hostedZoneId>|<name>|<type>` physical id whose NAME contains `|` (issue
 * #3890), or `undefined` for every other id (which the caller resolves as
 * before: a three-part id through {@link REF_RETURNS_SEGMENT_AT_INDEX} without
 * reading state, anything else passed through raw).
 *
 * Route 53 accepts `|` in a record name, so the id is longer than three
 * segments. The hosted zone id (AWS-minted) and the type (an enum) never carry
 * one, so the name is everything between the first and the last `|` — but
 * only when the id ANCHORS on its record the way `Route53Provider`'s decode
 * sites require (`parseRecordSetCompositeId` + `compositeAgreesWithTemplate`):
 * the last segment equals the recorded `Type`, and the middle equals the
 * recorded `Name` (case- and trailing-dot-insensitive). An id that does not is
 * CloudFormation's own physicalId, the record name itself, which `cdkd import`
 * can keep verbatim (`importRecordSet`'s `adoptVerbatim`) — and passing that
 * through raw IS its `Ref`. The `Name` match is what tells the two apart: the
 * middle of a longer id is strictly shorter than the id.
 *
 * A MASKED anchor follows the Glue rule ({@link glueTableRefFromPhysicalId}):
 * a caller with a redaction bag gets the redacted read reported, one without
 * gets the mask back — never the raw id, which its readers would not catch.
 * An anchor recorded as a `{{resolve:...}}` expression is treated the same way.
 */
export function recordSetRefFromPhysicalId(
  physicalId: string,
  stateLookup?: RefStateLookup
): string | undefined {
  const firstPipe = physicalId.indexOf(COMPOSITE_ID_SEPARATOR);
  const lastPipe = physicalId.lastIndexOf(COMPOSITE_ID_SEPARATOR);
  if (firstPipe <= 0 || lastPipe === firstPipe) return undefined;
  const name = physicalId.slice(firstPipe + 1, lastPipe);
  // A three-part id never reads state: the segment map answers it.
  if (!name.includes(COMPOSITE_ID_SEPARATOR) || !stateLookup) return undefined;
  // `Type` first, and `Name` only once it agrees: an id whose type does not
  // match is the scalar whatever its `Name`, so a masked `Name` beside it is
  // never reported as a read this `Ref` needed.
  // A `{{resolve:...}}` anchor is redacted too: it never equals the id's
  // segment, and passing the raw id through would hand a consumer the
  // composite instead of the record name.
  const anchorOptions = { dynamicReferenceIsRedacted: true } as const;
  const recordedType = stateLookup(['Type'], anchorOptions);
  if (recordedType !== undefined && carriesSecretMask(recordedType)) return recordedType;
  if (recordedType === undefined || physicalId.slice(lastPipe + 1) !== recordedType) {
    return undefined;
  }
  const recordedName = stateLookup(['Name'], anchorOptions);
  if (recordedName !== undefined && carriesSecretMask(recordedName)) return recordedName;
  if (recordedName === undefined) return undefined;
  return canonicalizeRoute53QueryName(name) === canonicalizeRoute53QueryName(recordedName)
    ? name
    : undefined;
}

/**
 * Resolve the value CloudFormation's `Ref` returns for a resource, given its
 * type and cdkd-stored physical id. Pure function shared by the deploy-time
 * resolver ({@link IntrinsicFunctionResolver.resolveRefValue}) and the
 * `cdkd orphan` rewriter's `{Ref: <orphan>}` substitution, so both derive
 * identical CFn `Ref` semantics (after-pipe / before-first-pipe compound-id
 * extraction and name-from-ARN extraction included).
 *
 * `stateLookup` (optional) recovers a `Ref` value that the physical id cannot
 * yield — the `AWS::S3Tables::Table` CC-routed case, whose bare TableARN ends
 * in a UUID (not the table name CFn `Ref` returns), so the name is read from
 * the stored `TableName` property/attribute instead (issue #974) — and, since
 * issue #1681, the {@link REF_RETURNS_ARN_FROM_STATE} types, whose `Ref` is an
 * ARN that is no segment of their compound id — and, since issue #1672,
 * `AWS::Glue::Table`, whose recorded `DatabaseName` places a table name that
 * contains `|` ({@link glueTableRefFromPhysicalId}).
 */
export function cfnRefValueFromPhysicalId(
  resourceType: string,
  physicalId: string,
  stateLookup?: RefStateLookup
): string {
  // AWS::S3Tables::Table diverges by ROUTING layer. The SDK provider stores the
  // compound `<tableBucketARN>|<namespace>|<tableName>` (the after-pipe
  // extraction below returns the table name). But a #614-routed Table (its SDK
  // handledProperties omit IcebergMetadata / Compaction / SnapshotManagement /
  // WithoutMetadata — IcebergMetadata is the everyday schema-bearing path) goes
  // through Cloud Control, whose primaryIdentifier is the bare single-segment
  // `TableARN` — pipe-free, and the ARN ends in a UUID, not the table name CFn
  // `Ref` returns. So when the physical id has no pipe, recover the name from
  // the stored `TableName` property (or the `Name` alias older fixtures use)
  // before falling through to the after-pipe extraction, which would no-op and
  // leak the ARN (issue #974). SDK-provisioned Tables keep the compound and
  // never take this branch.
  if (resourceType === 'AWS::S3Tables::Table' && !physicalId.includes('|') && stateLookup) {
    const tableName = stateLookup(['TableName', 'Name']);
    if (tableName) {
      return tableName;
    }
  }
  // AWS::Glue::Table: the table name, which may itself contain `|` (issue
  // #1672) — see the helper for why no generic Set can extract it.
  if (resourceType === 'AWS::Glue::Table') {
    const tableName = glueTableRefFromPhysicalId(physicalId, stateLookup);
    if (tableName !== undefined) {
      return tableName;
    }
  }
  // AWS::Backup::BackupSelection: CFn's `Ref` returns `BackupSelectionId` (the
  // bare SelectionId; docs-verified), but the Cloud Control primaryIdentifier
  // cdkd stores as the physical id is the compound `Id` = `<SelectionId>_<BackupPlanId>`
  // joined by an UNDERSCORE (not a pipe, so the REF_RETURNS_SEGMENT_*_PIPE
  // extractions do not apply). Rather than string-split on `_` (a fragile
  // assumption about the separator + segment order), recover the bare
  // SelectionId from the enriched `SelectionId` attribute the CC read-back
  // already populated (PR #992). Falls through to the raw physical id when the
  // attribute is absent — same graceful degradation as the S3Tables case
  // above (issue #995).
  if (resourceType === 'AWS::Backup::BackupSelection' && stateLookup) {
    const selectionId = stateLookup(['SelectionId']);
    if (selectionId) {
      return selectionId;
    }
  }
  // AWS::CodeCommit::Repository: CFn's `Ref` returns the repository ID (a
  // GUID, docs-verified), but every CodeCommit API is name-based (there is no
  // lookup-by-id API), so the SDK provider stores the repository NAME as the
  // physical id. The provider's `create()` / `import()` store the
  // `RepositoryId` attribute, recovered here via `stateLookup` for CFn `Ref`
  // parity. Falls through to the raw physical id (the name) when the
  // attribute is absent — same graceful degradation as the cases below
  // (issue #1045).
  if (resourceType === 'AWS::CodeCommit::Repository' && stateLookup) {
    const repositoryId = stateLookup(['RepositoryId']);
    if (repositoryId) {
      return repositoryId;
    }
  }
  // AWS::WAFv2::WebACL is the inverse of the usual divergence: CFn's `Ref` IS
  // the pipe-joined compound `name|id|scope` (docs-explicit, e.g.
  // `my-webacl-name|1234a1a-...|REGIONAL`), which matches the CC identifier —
  // but the SDK provider stores the ARN as the physical id (its CRUD paths
  // need it), so the SDK path must RECONSTRUCT the compound from the ARN
  // (cross-family close-out audit, 2026-07-03). A CC-provisioned instance
  // already stores the compound and passes through the final return.
  if (resourceType === 'AWS::WAFv2::WebACL' && physicalId.startsWith('arn:')) {
    const { id, name, scope } = parseWebACLArn(physicalId);
    // A short / foreign `arn:`-prefixed id parses to undefined segments —
    // pass the raw id through rather than emitting a literal "undefined"
    // (unreachable from cdkd's own state writers, which all store validated
    // WebACL ARNs, but cheap to guard).
    if (name && id) {
      return `${name}|${id}|${scope}`;
    }
    return physicalId;
  }
  const nameMarker = REF_RETURNS_NAME_FROM_ARN.get(resourceType);
  if (nameMarker && physicalId.startsWith('arn:')) {
    const markerIdx = physicalId.indexOf(nameMarker);
    if (markerIdx >= 0) {
      const segment = physicalId.substring(markerIdx + nameMarker.length);
      // Custom-bus Events::Rule ARNs carry `rule/<busName>/<ruleName>`;
      // CloudFormation's physical id for such rules is `<busName>|<ruleName>`
      // (verified against real CloudFormation, 2026-07-02). Rule names cannot
      // contain `/` but partner-bus NAMES can (`aws.partner/foo.com/...`), so
      // split on the LAST slash to keep the whole bus name intact (the
      // partner-bus form is inferred from that rule, not CFn-verified —
      // partner buses need a live SaaS integration to create).
      // NOTE: this split fires only when the segment contains `/`, which is
      // safe for types whose names forbid `/` (both current entries). A future
      // REF_RETURNS_NAME_FROM_ARN entry whose names may contain `/` needs a
      // per-entry flag instead of this shared split.
      const slashIdx = segment.lastIndexOf('/');
      if (slashIdx >= 0) {
        return `${segment.substring(0, slashIdx)}|${segment.substring(slashIdx + 1)}`;
      }
      return segment;
    }
  }
  if (REF_RETURNS_SEGMENT_AFTER_PIPE.has(resourceType)) {
    // Take the segment after the LAST pipe. For 2-segment compounds
    // (`<parent>|<ref>`) this equals after-first-pipe; for 3-segment AppConfig
    // children (`<a>|<b>|<ref>`) it correctly returns only the trailing id.
    const pipeIdx = physicalId.lastIndexOf('|');
    if (pipeIdx >= 0) {
      return physicalId.substring(pipeIdx + 1);
    }
  }
  if (REF_RETURNS_SEGMENT_BEFORE_FIRST_PIPE.has(resourceType)) {
    // Reversed-order compounds (`<ref>|<parent>`): take the segment before
    // the FIRST pipe. A pipe-free physical id (the SDK-provisioned case for
    // these types) falls through and returns unchanged.
    const pipeIdx = physicalId.indexOf('|');
    if (pipeIdx >= 0) {
      return physicalId.substring(0, pipeIdx);
    }
  }
  // AWS::Route53::RecordSet with a record name containing `|` (issue #3890) —
  // see the helper; a three-part id takes the segment map below.
  if (resourceType === 'AWS::Route53::RecordSet') {
    const recordName = recordSetRefFromPhysicalId(physicalId, stateLookup);
    if (recordName !== undefined) {
      return recordName;
    }
  }
  const segmentSpec = REF_RETURNS_SEGMENT_AT_INDEX.get(resourceType);
  if (segmentSpec) {
    // Interior-segment compounds (`AWS::Route53::RecordSet`'s
    // `<hostedZoneId>|<name>|<type>` -> the record name). Exact-arity only; see
    // the map's header for why a mis-arity'd id falls through instead.
    const parts = physicalId.split('|');
    if (parts.length === segmentSpec.arity) {
      // Falsy segment falls through rather than returning `''`. `Z1||A` has the
      // right ARITY but an empty name, and `parseRecordSetCompositeId` already
      // rejects an empty segment (treating such an id as the legacy scalar
      // shape) — so resolving `Ref` to the empty string would hand a consumer a
      // value cdkd itself refuses to decode. Also makes the `[index]` read safe
      // for a future entry whose `index` is out of range for its `arity`.
      const segment = parts[segmentSpec.index];
      if (segment) return segment;
    }
  }
  const arnAttributeKeys = REF_RETURNS_ARN_FROM_STATE.get(resourceType);
  if (arnAttributeKeys && stateLookup) {
    // The AppSync child types, whose `Ref` is an ARN no segment of the compound
    // id reconstructs. Falls through to the raw id when the attribute is absent
    // (an imported child), same as the recoveries above.
    const arn = stateLookup(arnAttributeKeys);
    // ...and when the recorded value is a PLACEHOLDER rather than an ARN. Every
    // record written before issue #1681 holds `arn:aws:appsync:*:*:...` —
    // literal `*` in the region and account positions — because the provider
    // string-built the attribute instead of taking AWS's own value. Handing
    // that to a consumer would be a REGRESSION introduced by this recovery: it
    // is no more usable than the compound id the recovery replaces, and it
    // LOOKS like a valid ARN, so it fails further from the cause. The state
    // heals itself on the resource's next update (the provider now returns the
    // corrected attributes), and until then the pre-#1681 behavior stands.
    if (arn && !isPlaceholderArn(arn)) {
      return arn;
    }
  }
  return physicalId;
}

/**
 * True for an ARN carrying a wildcard in its region or account position — the
 * shape cdkd's AppSync provider recorded before issue #1681. Matched
 * positionally (fields 3 and 4 of `arn:<partition>:<service>:<region>:<account>`)
 * rather than by substring, so a legitimate ARN whose RESOURCE segment contains
 * `*` (an IAM policy resource pattern, an S3 key prefix) is never rejected.
 */
export function isPlaceholderArn(arn: string): boolean {
  const fields = arn.split(':');
  return fields.length >= 5 && (fields[3] === '*' || fields[4] === '*');
}

/**
 * Intrinsic-function keys the resolver knows how to handle.
 *
 * A CloudFormation intrinsic is ALWAYS a single-key object — `{ "Ref": ... }`
 * or `{ "Fn::X": ... }`. When `resolveValue` encounters a single-key object
 * whose key is `Ref` or starts with `Fn::` but is NOT in this set, it throws
 * (rather than silently passing the broken value through to the provider).
 *
 * `Fn::Transform` (CloudFormation macros) is intentionally treated as handled:
 * it is expanded server-side at the SYNTHESIS layer (see
 * `src/synthesis/macro-expander.ts`, routed via `Synthesizer`) BEFORE the
 * resolver ever runs, so by resolution time it should already be gone. Listing
 * it here keeps a stray (already-expanded) occurrence from hard-erroring.
 */
export const HANDLED_INTRINSIC_KEYS = new Set<string>([
  'Ref',
  'Fn::GetAtt',
  'Fn::Join',
  'Fn::Sub',
  'Fn::Select',
  'Fn::Split',
  'Fn::If',
  'Fn::Equals',
  'Fn::And',
  'Fn::Or',
  'Fn::Not',
  'Fn::ImportValue',
  'Fn::GetStackOutput',
  'Fn::FindInMap',
  'Fn::Base64',
  'Fn::GetAZs',
  'Fn::Cidr',
  'Fn::Transform',
]);

/**
 * Detect an unresolved / unknown CloudFormation intrinsic function.
 *
 * A CloudFormation intrinsic is ALWAYS a single-key object whose key is `Ref`
 * or starts with `Fn::`. Requiring EXACTLY ONE key avoids false positives on a
 * real resource property that happens to be literally named `Ref` or
 * `Fn::Something` (those would be multi-key objects, or sit alongside sibling
 * keys), so only a genuine lone intrinsic node is flagged.
 *
 * @returns the unknown intrinsic key (e.g. `Fn::ToJsonString`) or `undefined`
 *   when the object is not an unknown single-key intrinsic.
 */
export function detectUnknownIntrinsicKey(obj: Record<string, unknown>): string | undefined {
  const keys = Object.keys(obj);
  if (keys.length !== 1) {
    return undefined;
  }
  const key = keys[0]!;
  if (key !== 'Ref' && !key.startsWith('Fn::')) {
    return undefined;
  }
  if (HANDLED_INTRINSIC_KEYS.has(key)) {
    return undefined;
  }
  return key;
}

/**
 * Build a clear, English error message for an unsupported intrinsic, including
 * a one-click pre-filled GitHub issue link so users can request support.
 */
export function buildUnknownIntrinsicError(key: string): Error {
  const title = `Support intrinsic ${key}`;
  const issueUrl =
    `https://github.com/go-to-k/cdkd/issues/new` +
    `?title=${encodeURIComponent(title)}&labels=intrinsic-support`;
  // `key` is the template's OWN object key -- arbitrary JSON, exactly like a
  // `Resources` key -- and this is a THROW the user sees at any verbosity, so
  // it takes `displayIdent` (go-to-k/cdkd#3435 review round 2). A free function
  // with no secrets bag, and an intrinsic name IS an identifier, so the
  // identifier renderer rather than the resolver's masking builder.
  //
  // A PLAIN key keeps the hand-written `"..."` it always had: every ordinary
  // `Fn::Length` / `Fn::ForEach` reaches this line, and a plain identifier
  // carries nothing a shell acts on inside double quotes. ANY OTHER key is
  // described, not shown (go-to-k/cdkd#3950): a `"` in it would close the hand
  // quote, a JSON-quoted `$( )` or backtick still runs when the sentence
  // naming `cdkd` is pasted, and the pre-filled issue link below already
  // carries the key percent-encoded.
  //
  // `issueUrl` needs none: it is a constant prefix plus `encodeURIComponent`,
  // which percent-encodes every control character, space, `$`, backtick, `;`,
  // `"`, `&` and `|`. It leaves `'`, `(`, `)`, `!`, `*` and `~` as they are,
  // and none of those can start a substitution without a `$` or a backtick. (Percent-encoding
  // is itself a mask-evading transform, so if `key` were ever in the SECRET
  // class this would be too -- it is not, being a structural operand.)
  // Whitespace FIRST: the round-trip alone admits a key ending in
  // `displayIdent`'s own cut marker (255 plain characters then
  // ` [cut: 35 more characters withheld]` renders as itself).
  const shown =
    !/\s/.test(key) && displayIdent(key) === key
      ? `"${key}"`
      : 'whose name is not a plain identifier';
  return new Error(
    `Unsupported CloudFormation intrinsic function ${shown}: ` +
      `cdkd does not support resolving it yet. ` +
      `Deploying this template would produce a broken value. ` +
      `Please request support by opening an issue: ${issueUrl}`
  );
}
