import { AsyncLocalStorage } from 'node:async_hooks';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { stringifyValue } from '../../utils/stringify.js';
import { canonicalizeRegion, derivePartitionAndUrlSuffix } from '../../utils/aws-partition.js';
import { displayIdent, UNRENDERABLE } from '../../utils/display-safe.js';
import { isInertUnquoted } from '../../utils/pasteable-command.js';
import { IntrinsicResolutionRefusalError } from '../../utils/error-handler.js';
import { drainDeadlines } from '../drain-budget.js';
import { markNonRetryable } from '../retryable-errors.js';
import { isListParameterType } from '../../utils/parameter-types.js';
import { type RetryLogger } from '../retry.js';
import {
  type StaleAttributeHealPhase,
  type StaleAttributeHealer,
} from '../stale-attribute-heal.js';
import {
  dynamicReferenceTokens,
  recordSecretExpression,
  forgetSecretExpression,
  isRecordedSecretExpression,
  clearRecordedSecretExpressions,
  clearRecoverableMaskedOutputs,
  carriesSecretMask,
  errorCauseChain,
  MIN_NEEDLE_LENGTH,
  SECRET_MASK,
  type DynamicReferenceSubstitution,
  type RecordedSecretValues,
} from '../secret-redaction.js';
import type { CloudFormationTemplate } from '../../types/resource.js';
import {
  type ResourceState,
  type StateImportEntry,
  type StateOutputReadEntry,
} from '../../types/state.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import type { ExportIndexStore } from '../../state/export-index-store.js';
import { parseWebACLArn } from '../../provisioning/providers/wafv2-provider.js';
import { COMPOSITE_ID_SEPARATOR, segmentAfterAnchor } from '../../provisioning/composite-id.js';
import { TemplateParser } from '../../analyzer/template-parser.js';
import {
  ambientCredentialConfig,
  credentialFingerprint,
  type CredentialConfig,
} from '../../utils/ambient-client-defaults.js';
import { injectiveKey } from '../../state/record-keys.js';

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
 * a minimum is what keeps this safe on a mis-arity'd id: cdkd's own
 * `parseRecordSetCompositeId` also demands exactly three parts, so a record
 * whose name contained a `|` is already rejected everywhere else, and returning
 * a confidently-wrong middle segment here would be worse than passing the raw
 * id through. Anything that does not match falls through to the raw physical id,
 * the same graceful degradation the `stateLookup` recoveries use.
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
          if (carriesSecretMask(value)) {
            // THE OPT-IN, and it is the whole safety argument of this arm.
            // A caller that passed no `onMaskedValue` gets `main`'s behaviour
            // byte for byte: the mask is RETURNED, four readers recognise it,
            // and this function has changed nothing for them.
            if (onMaskedValue === undefined) {
              if (options?.preferCleanValue !== true) return value;
              deferredMask ??= value;
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

/**
 * The same context with the `producerRegions` EVIDENCE removed (issue #2134
 * review rounds 1 and 2).
 *
 * That field means "the CONSUMER stack reads from these regions", and it is
 * only meaningful where the origin of a reference is genuinely UNKNOWN. Hand it
 * to a resolution whose origin is already established and it re-judges a
 * reference cdkd has just proven, verdicting `ambiguous`.
 *
 * ROUND 1 stripped it by RESOLVER IDENTITY -- "is this a different instance?"
 * -- and round 2 measured that that is the wrong question. When the producer
 * lives in the CONSUMER's own region `resolverForProducerRegion` returns `this`,
 * so the identity test passed the evidence straight through and a name-form
 * reference read out of that producer was refused. The LOCAL producer failed
 * while the CROSS-REGION one succeeded, which is backwards, and after the
 * round-1 re-raise it aborted the whole stack's scrub rather than logging a
 * debug line.
 *
 * The right question is whether the ORIGIN IS KNOWN, so each caller answers it
 * for itself and this helper only performs the strip. Returned BY IDENTITY when
 * there is no evidence to remove, so the ordinary path allocates nothing.
 */
export function withoutProducerRegions(
  context: ResolverContext | undefined
): ResolverContext | undefined {
  if (context?.producerRegions === undefined) return context;
  const { producerRegions: _stripped, ...rest } = context;
  return rest;
}

/**
 * A resolved string beside its LOG TWIN (issue
 * [#3100](https://github.com/go-to-k/cdkd/issues/3100)): the same string with
 * every span a recorded secret was WRITTEN into replaced by
 * {@link SECRET_MASK}. `resolveJoin` / `resolveSub` build it alongside the
 * value and log the twin, never the value.
 *
 * It exists because the NEEDLE mask (`maskNeedlesForLog`) masks a 1-3
 * character secret only as the WHOLE text (`MIN_NEEDLE_LENGTH`), so
 * `port:` + a two-character secret printed in the clear. The floor is right for
 * a needle — a short needle would rewrite unrelated text in every line — and
 * what the needle lacks is POSITION, which only the writer holds. The twin is
 * therefore built at the writes, and the needle mask still runs over it for
 * everything a write did not see.
 */
export interface LogTwin {
  readonly result: string;
  readonly twin: string;
}

/**
 * A dynamic-reference pass over one string: its {@link LogTwin}, every token
 * it REPLACED with the verdict that replacement took, and whether it replaced
 * every token it met (issue [#3156](https://github.com/go-to-k/cdkd/issues/3156)).
 * `resolveJoin` / `resolveSub` assemble these into the object's
 * `IntrinsicLeafResolution`.
 */
export interface DynamicReferencePass extends LogTwin {
  readonly substitutions: readonly DynamicReferenceSubstitution[];
  readonly complete: boolean;
}

/**
 * Masked log twins registered this pass, per pass bag (issue #3100;
 * `rememberLogTwin` / `logTwinOfProduct`). Nothing that RESOLVES a value reads
 * it. One persistence decision does: `resolveBase64` registers its encoding
 * mask-only when the input's position mask fires (issue #3119), which a nested
 * child also reaches through the inherited-bag lookup (issue #3114).
 *
 * MODULE scope, not instance scope: a region-pinned sibling resolver
 * (`resolverForProducerRegion`) resolves on behalf of the consumer with the
 * consumer's bag, so an instance-local registry left the sibling's twin where
 * the consumer's `Fn::Join` / `Fn::Sub` never looked. The key is still the
 * pass's own bag object, so scope does not widen to unrelated passes: a pass
 * reaches only the entries under its own bag and under the bag it was handed
 * as `inheritedSecrets` (a nested-stack child reading its parent's, issue
 * #3114), and the entries die with the bag.
 */
export const LOG_TWINS_BY_PASS = new WeakMap<RecordedSecretValues, Map<string, string>>();

/**
 * Does `value` carry a CloudFormation dynamic reference anywhere inside it?
 *
 * Used as the identity fast path of {@link
 * IntrinsicFunctionResolver.reresolveCrossStackValue}: a cross-stack value that
 * carries none is returned untouched, so every ordinary import keeps its
 * pre-#1934 behaviour with no walk, no AWS call and no allocation.
 *
 * The walk descends arrays and objects because `state.outputs` is typed
 * `Record<string, unknown>` and deliberately NOT coerced to string — a
 * list-valued `Fn::GetAtt` persists a JSON array — so a secret-bearing output
 * is not always a bare string.
 *
 * EXPORTED for `cdkd scrub` (issue
 * [#2133](https://github.com/go-to-k/cdkd/issues/2133)), which asks the inverse
 * question of the same value: a cross-stack read that comes back carrying NO
 * dynamic reference is one scrub could not turn into a needle, because a needle
 * is only ever recorded by resolving a `{{resolve:...}}` expression.
 */
export function carriesDynamicReference(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('{{resolve:');
  if (Array.isArray(value)) return value.some(carriesDynamicReference);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(carriesDynamicReference);
  }
  return false;
}

/** The nested-stack resource type, whose `Outputs.<Name>` attributes are re-resolved (issue #2055). */
export const NESTED_STACK_RESOURCE_TYPE = 'AWS::CloudFormation::Stack';
/** Prefix `NestedStackProvider` records a child stack output under. */
export const NESTED_STACK_OUTPUT_ATTRIBUTE_PREFIX = 'Outputs.';
/**
 * `arn:cdkd-local:<childRegion>:<accountId>:nested-stack/<parent>/<logicalId>` —
 * the synthesized physicalId `NestedStackProvider.synthesizeArn` records on the
 * parent's `AWS::CloudFormation::Stack` row.
 */
export const NESTED_STACK_LOCAL_ARN = /^arn:cdkd-local:([a-z0-9-]+):[^:]*:nested-stack\//i;

/**
 * The CHILD stack's region, read off the parent row's synthesized physicalId
 * (issue [#2055](https://github.com/go-to-k/cdkd/issues/2055)).
 *
 * WHY THE ARN AND NOT A STATE READ. The child's own record carries `region`,
 * but its state KEY is `cdkd/<parent>~<logicalId>/<region>/state.json` — the
 * region is part of the key, so reading the record to learn the region is
 * circular. The synthesized physicalId is the SAME provider's durable record of
 * the region it deployed the child into, it sits on the resource row the
 * resolver already holds, and reading it costs no I/O on a path that is
 * otherwise hot.
 *
 * Returns `undefined` for anything that is not that shape (a hand-edited state
 * file, a record written before this provider existed), which the caller reads
 * as "use this resolver's own region".
 */
export function nestedStackChildRegionFromLocalArn(
  physicalId: string | undefined
): string | undefined {
  if (typeof physicalId !== 'string') return undefined;
  return NESTED_STACK_LOCAL_ARN.exec(physicalId)?.[1];
}

/**
 * The array position a RESOLVED `Fn::Select` index names, or `undefined` when
 * it names none (issue #3574): a non-negative safe integer, or its canonical
 * decimal string (CloudFormation accepts `"1"`, and a `Ref` to a parameter the
 * resolver did not coerce is still a string). No `Number()` on anything else:
 * it trims whitespace and maps `""` / `null` / `[]` to `0`. No leading zero
 * either, so `String(position)` IS the resolved text and masks like it — the
 * same shape `import.ts`'s `isStaticSelectIndex` vouches for.
 */
export function selectIndexPosition(value: unknown): number | undefined {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)
        ? Number(value)
        : undefined;
  return n !== undefined && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/**
 * One entry in {@link ResolverContext.abandonedResolutions} — one UNIT of a
 * resolution this pass could not complete, recorded instead of abandoning every
 * later unit beside it (issues
 * [#3181](https://github.com/go-to-k/cdkd/issues/3181) /
 * [#3218](https://github.com/go-to-k/cdkd/issues/3218)).
 *
 * Two units, because the defect had two spellings and closing one leaves the
 * other live. A `token` is one `{{resolve:...}}` reference inside a string leaf
 * (#3181); a `key` is one entry of an object property bag or of an `Fn::Sub`
 * variable map (#3218), whose failure needs no dynamic reference at all — the
 * issue's own repro fails on a `Ref` — and therefore never reaches the token
 * loop.
 *
 * STRUCTURED, for the reason its sibling below records at length: a consumer
 * forced to recover structure out of a human string couples to a spelling, and
 * both prior attempts at that coupling shipped a defect.
 */
export interface AbandonedResolution {
  /** Which walk abandoned this unit. */
  readonly unit: 'token' | 'key';
  /**
   * For `'token'`, the reference as the log twin would PRINT it — never the raw
   * one: `resolveSub` / `resolveJoin` re-enter with an ASSEMBLED string, so
   * `fullMatch` can carry a plaintext the caller holds no needle for (issue
   * #2827). For `'key'`, the property / variable name, which is template
   * structure rather than a value.
   */
  readonly subject: string;
  /**
   * The thrown message, MASKED at push. An SSM `ValidationException` echoes the
   * `Name` it was given — which for an assembled reference IS a plaintext.
   * `sendWithThrottleRetry` already rethrows it masked by position
   * (go-to-k/cdkd#3171); the push-time mask stays as the layer for every other
   * throw. Render THIS, never {@link error}.
   *
   * The two units are masked to different DEPTHS, and the difference is stated
   * rather than smoothed over. A `'token'` entry additionally maps each raw
   * reference segment through the twin-derived `nameLogText` first, which has
   * no length floor, so a SUB-FLOOR plaintext is cleaned. A `'key'` entry has
   * no such source — the key is template structure, and the failure under it
   * is a `Ref`/`Fn::GetAtt` rather than a fetch that echoes a secret name — so
   * it gets the `MIN_NEEDLE_LENGTH`-floored needle mask alone. No reachable
   * path was found where that matters (a nested token failure RECOVERS rather
   * than throwing up to the key), but the asymmetry is real.
   */
  readonly message: string;
  /**
   * Whatever was thrown, for CLASSIFICATION only. Never render it: unlike
   * {@link message} it is not guaranteed masked (an SDK rejection from a lookup
   * arrives as a masked clone since go-to-k/cdkd#3171, other throws do not),
   * and it is kept so a consumer can test its class rather than its wording.
   */
  readonly error: unknown;
  /**
   * Did THIS unit's own input carry a `{{resolve:...}}` reference at all?
   *
   * Recorded as a BOOLEAN, computed at push time from the raw input, so the
   * entry can be judged per unit without carrying a value that could be a
   * plaintext. A consumer that judged the enclosing property instead gets the
   * wrong answer in both directions: go-to-k/cdkd#3218's abandoned key is a
   * bare `{"Ref": ...}` carrying no reference — nothing about it is
   * unverifiable — while a sibling entry in the same bag may be a genuinely
   * unfetched reference that must still gate the exit code.
   */
  readonly carriedDynamicReference: boolean;
  /**
   * Did this unit's own input carry a reference that could be FETCHED — i.e.
   * one that is not still awaiting an `Fn::Sub` placeholder? Separates "nobody
   * could have resolved this" from "this one was resolvable and was not
   * resolved", which is the line between reporting and gating.
   */
  readonly carriedFetchableReference: boolean;
}

/**
 * The prefix every dynamic-reference diagnostic this resolver spells carries.
 *
 * Exported because `cdkd scrub` applies the SAME partition on its side and must
 * not keep a second spelling of it (issue #1936's rule, one layer up): a bare
 * marker tail is reachable from text this resolver did not write — `Parameter X
 * is required but no value was provided` comes out of `resolveParameters` — so
 * the prefix is what makes the match an assertion about OWNERSHIP.
 */
export const DYNAMIC_REFERENCE_PREFIX = 'Dynamic reference: ';

/**
 * Does `source` carry a `{{resolve:...}}` reference that could actually be
 * FETCHED — one not still awaiting an `Fn::Sub` placeholder?
 *
 * Moved here from `cdkd scrub` (issue go-to-k/cdkd#3181), which still imports
 * it, because the resolver needs the same question answered per abandoned UNIT
 * and issue #1936 forbids a second spelling of the token pattern.
 *
 * The distinction it draws is between "nobody could have resolved this" and
 * "this one was resolvable and was not resolved" — the line between merely
 * REPORTING an abandonment and letting it gate an exit code.
 */
export function carriesFetchableDynamicReference(source: unknown): boolean {
  if (typeof source === 'string') {
    // `dynamicReferenceTokens`, never a local regex: a scan that disagreed with
    // the resolver about where a token ENDS would disagree about which argument
    // the `${` test is applied to. (Fenced by
    // `secret-redaction-dynamic-reference-pattern.test.ts`.)
    return dynamicReferenceTokens(source).some((token) => !token.includes('${'));
  }
  if (Array.isArray(source)) return source.some(carriesFetchableDynamicReference);
  if (source !== null && typeof source === 'object') {
    return Object.values(source as Record<string, unknown>).some(carriesFetchableDynamicReference);
  }
  return false;
}

/**
 * The NAMELESS spellings, which REFUSE rather than fail to fetch.
 *
 * `{{resolve:secretsmanager:}}` with an empty argument is a structurally broken
 * template, and no substitution produces one — an unresolved `Fn::Sub` keeps its
 * literal `${...}`. `cdkd scrub` has refused on these since
 * [#2692](https://github.com/go-to-k/cdkd/issues/2692), so the per-unit
 * recovery must not quietly downgrade one to a skipped token.
 */
export const NAMELESS_DYNAMIC_REFERENCE_MARKERS = [
  'PARAMETER_NAME is required',
  'SECRET_ID is required',
] as const;

/**
 * `err` is a refusal this resolver took ON PURPOSE rather than a step that
 * failed, so the per-unit recovery must re-raise it and abort the walk.
 *
 * The partition is the one `cdkd scrub` already applies on its side
 * (go-to-k/cdkd#3178), drawn by OWNERSHIP rather than vocabulary: every refusal
 * here is one THIS repo decides and spells, which is what makes matching it
 * sound in a way that matching AWS's error text never is. Everything else — any
 * SDK rejection, any shape this cannot classify — is treated as a failed step
 * and RECORDED. That asymmetry is deliberate: the residual is a unit reported
 * as unresolved, never a refusal silently skipped.
 *
 * The two halves of the message test open the partition in DIFFERENT
 * directions, and their EVIDENCE differs — stated separately rather than
 * asserted together, because only one of them is demonstrated.
 *
 * {@link DYNAMIC_REFERENCE_PREFIX} is REACHABLE and tested: a secret id is
 * template-assembled, so AWS's rejection echoes the name it was handed, and a
 * parameter named after a marker puts the bare tail inside a message this repo
 * did not write. Matching the tail alone reads that as a refusal and disarms
 * recovery for the leaf — restoring exactly the loss #3181 removes.
 *
 * The CAUSE walk is defence in depth, and NO reachable wrapping of one of these
 * throws was found from inside either walk's `try` (the in-repo precedent for
 * the shape is `role-arn.ts`). It is kept because the two failure directions
 * are not symmetric: an unrecognised refusal is recorded and walked past, which
 * is the one residual this partition promises cannot happen, while the cost of
 * the walk is a bounded chain read. Do not cite it as fenced — it is not.
 */
export function isNamelessDynamicReferenceError(err: unknown): boolean {
  // The MESSAGE arm of the partition, exported because `cdkd scrub` asks the
  // same question on its side and issue #1936 forbids a second spelling of one
  // predicate. The constants moved here under go-to-k/cdkd#3181; the
  // conjunction over them was left behind, spelled byte-identically in both
  // files, which is the same drift one level up.
  //
  // Both halves are load-bearing. The prefix is what makes the match an
  // assertion about OWNERSHIP — a bare marker tail is reachable from text this
  // repo did not write (`resolveParameters` raises `Parameter <name> is
  // required but no value was provided`). The cause walk catches a refusal
  // wrapped on its way out.
  if (!(err instanceof Error)) return false;
  return errorCauseChain(err).some(
    (link) =>
      link.message.includes(DYNAMIC_REFERENCE_PREFIX) &&
      NAMELESS_DYNAMIC_REFERENCE_MARKERS.some((m) => link.message.includes(m))
  );
}

export function isDeliberateResolutionRefusal(err: unknown): boolean {
  // Covers `CrossAccountSecretRefusalError` and
  // `DynamicReferenceRegionAmbiguousError`, which extend it — all three re-set
  // their prototype, so `instanceof` survives the subclassing. Tested over the
  // CAUSE chain for the same reason the message arm is.
  if (!(err instanceof Error)) return false;
  if (errorCauseChain(err).some((link) => link instanceof IntrinsicResolutionRefusalError)) {
    return true;
  }
  return isNamelessDynamicReferenceError(err);
}

/**
 * One entry in {@link ResolverContext.redactedAttributeReads} — a read the
 * resolver served out of a REDACTED persisted record.
 *
 * STRUCTURED RATHER THAN A JOINED STRING, and that is the fix for a defect
 * CLASS rather than for one consumer (issue
 * [#2847](https://github.com/go-to-k/cdkd/issues/2847) review rounds 3 and 4).
 * The bag used to hold only `display`, and `DeployEngine` recovered the
 * structure back out of it with two regexes — one deciding the remedy text,
 * one deciding whether an Outputs read is refused. Re-parsing a
 * human-readable string produced a blocker twice, by two different mechanisms:
 * first a SPELLING coupling (a producer rename silently disarms the consumer),
 * then a CHARSET one (`/^Ref ([A-Za-z0-9]+) .../` cannot match a hyphenated
 * logical id, which cdkd accepts because it validates no logical-id charset
 * and never hands the template to CloudFormation — so the Outputs guard
 * silently published a raw physical id for `{"Ref": "My-Table"}`).
 *
 * With the structure carried in the data, a consumer asks a FIELD. Neither a
 * rename nor a character outside some regex's class can disarm one, and the
 * rendering is free to change without a consumer noticing.
 *
 * `display` is the only member a user ever sees; the other two are for
 * routing. `display` may be MASKED — AND SANITIZED, since go-to-k/cdkd#3426:
 * both the attribute name and the cross-stack origin go through
 * `displayMasked` on the way in, which strips control characters and runs
 * `displaySafe` as well as masking, since the deploy engine joins these into a
 * throw at DEFAULT verbosity. That is why dedup keys on `display`: it is what
 * the message would repeat.
 *
 * ONE CONSEQUENCE, stated because the dedup test at
 * {@link IntrinsicFunctionResolver.pushRedactedAttributeRead} keys its fourth
 * conjunct on this field: two reads whose names differ ONLY by control
 * characters or padding now produce the same `display` and COLLAPSE, so
 * `refuseRedactedAttributeReads` shows one row where it used to show two. Same
 * accepted trade as the masked-key collapse in `maskValueLeaves` — the loss is
 * a row COUNT in a diagnostic and never a disclosure, and the direction is
 * safe: the surviving row carries the sanitized spelling either way.
 */
export interface RedactedAttributeRead {
  /**
   * WHICH resolution branch served the mask. `ref-state-key` is the only kind
   * whose fall-through emits a value NO downstream reader recognises (the raw
   * physical id), which is why `resolveOutputs` refuses on it alone — see the
   * scoping argument at `DeployEngine`'s `refuseMaskedOutputReads`.
   */
  readonly kind: 'ref-state-key' | 'attribute' | 'cross-stack';
  /**
   * The logical id whose STATE RECORD holds the mask — the target a
   * `cdkd import --resource <id>=... --force` would repair. NOT the resource
   * being provisioned. Absent for `cross-stack`, whose record lives in another
   * stack's state and which no re-import here can reach.
   */
  readonly logicalId?: string;
  /**
   * The state key (`ref-state-key`) or attribute name (`attribute`) the read
   * named. Informational — no consumer routes on it today; it is here so the
   * `display` rendering stays derivable from the entry.
   */
  readonly key?: string;
  /** The user-facing rendering, built where the structure is still known. */
  readonly display: string;
}

/**
 * Resolver context for intrinsic functions
 */
export interface ResolverContext {
  /** Template being processed */
  template: CloudFormationTemplate;
  /** Current resource states (for Ref/GetAtt) */
  resources: Record<string, ResourceState>;
  /** Parameter values (for Ref to parameters) */
  parameters?: Record<string, unknown>;
  /** Evaluated condition values (for Fn::If) */
  conditions?: Record<string, boolean>;
  /** State backend for cross-stack references (Fn::ImportValue) */
  stateBackend?: S3StateBackend;
  /** Current stack name (for Fn::ImportValue to avoid self-reference) */
  stackName?: string;
  /**
   * Persistent exports index for fast `Fn::ImportValue` resolution. When
   * supplied, the resolver tries an O(1) index lookup before falling back
   * to the per-stack state.json scan. Optional for backwards compat; the
   * scan-only path is still correct.
   */
  exportIndex?: ExportIndexStore;
  /**
   * Bag for the resolver to push every successful `Fn::ImportValue`
   * resolution into. The deploy engine reads this after resource
   * provisioning and persists it to the consumer's `state.imports`
   * field (schema v4) so destroy-time strong-reference checks can
   * refuse to delete a producer with active consumers.
   *
   * `Fn::GetStackOutput` does NOT push entries here by design — it
   * is a weak reference and uses the sibling `recordedOutputReads`
   * bag instead (schema v8, issue #668).
   */
  recordedImports?: StateImportEntry[];
  /**
   * Bag for the resolver to push every successful `Fn::GetStackOutput`
   * resolution into (schema v8+, issue #668). The deploy engine reads
   * this after resource provisioning and persists it to the consumer's
   * `state.outputReads` field so `findDownstreamConsumers` can name
   * the downstream stacks affected by a producer's recreate.
   *
   * Sibling of `recordedImports` for the weak-reference
   * `Fn::GetStackOutput` intrinsic. Cross-account `RoleArn`-based
   * reads do NOT push entries here in v8 (deferred to a future
   * schema bump alongside a `sourceAccountId` field).
   */
  recordedOutputReads?: StateOutputReadEntry[];
  /**
   * Bag for the resolver to push every resolved SECRET dynamic reference into,
   * keyed by the resolved plaintext VALUE with the original `{{resolve:...}}`
   * expression as the payload (GHSA fix). The deploy engine reads this after
   * resolution to (a) redact the plaintext out of the bag it PERSISTS to state
   * — replacing each secret value with its unresolved expression, CloudFormation
   * semantics — and (b) mask the value out of log / error output. What counts
   * as a secret is decided by TYPE, not by the reference's SPELLING (issue
   * #1901): every `secretsmanager` reference, plus a plain `{{resolve:ssm:...}}`
   * one whose parameter turns out to be a `SecureString` — that form resolves
   * with `WithDecryption`, so for that type it yields a real secret. An `ssm`
   * reference to a `String` / `StringList` parameter IS public config and is
   * deliberately NOT recorded, so state keeps storing it resolved.
   * See `src/deployment/secret-redaction.ts`.
   */
  recordedSecretValues?: RecordedSecretValues;
  /**
   * Secret pairs a PARENT stack already resolved on a nested CHILD's behalf,
   * for the child resolver to RECORD from rather than to substitute with
   * (issues [#1903](https://github.com/go-to-k/cdkd/issues/1903) /
   * [#2087](https://github.com/go-to-k/cdkd/issues/2087)).
   *
   * Set only by a nested-stack child `DeployEngine`, from
   * `DeployEngineOptions.inheritedSecrets`. The parent resolves the child's
   * `Parameters` block, so the value reaching the child is already PLAINTEXT
   * and the child's own template spells the consumption as
   * `{Ref: <ParamName>}` — an intrinsic OBJECT, never a `{{resolve:` string.
   * Nothing in the child's own resolution can therefore record the
   * `plaintext -> expression` pair that the deploy engine's state-save choke
   * point redacts with, and the child's `state.json` persisted the decrypted
   * secret.
   *
   * READ-ONLY and NEVER substituted: `resolveRef` still returns the real
   * parameter value — that is what reaches AWS — and only copies the matching
   * pair into `recordedSecretValues`, i.e. into the map belonging to the
   * resource whose resolution actually consumed the parameter. Recording at
   * RESOLUTION time rather than pre-seeding every context is what keeps the
   * per-resource scoping every reader of `perResourceSecrets` assumes; the
   * earlier pre-seed handed the same bag to every child resource, so an
   * unrelated literal merely CONTAINING the plaintext (`my-production-bucket`
   * against a secret `production`) was spliced into the expression and the
   * stack acquired a perpetual UPDATE (issue #2087).
   *
   * A reader MUST NOT enumerate or log its KEYS — they are secret plaintext.
   */
  inheritedSecrets?: RecordedSecretValues;
  /**
   * A PRINT-ONLY corpus of LOG-ONLY needles (go-to-k/cdkd#4043): read by the
   * render mask of this resolver's own lines ({@link maskSecretsRaw}) and by
   * nothing that detects, records into {@link recordedSecretValues} or
   * decides. `cdkd diff`'s Outputs pass resolves into bags of its own, whose
   * log-only needles decide which export aliases are refused, so the
   * `NoEcho` values it holds up front reach its lines through here instead.
   * An `Fn::Base64` whose input this corpus masks records its encoding into
   * THIS bag, as a log-only needle, so the encoding prints masked too.
   */
  printingSecrets?: RecordedSecretValues;
  /**
   * Logical ids whose provider declared THIS RUN's `attributes` sensitive —
   * a Lambda-backed custom resource whose handler answered `NoEcho: true`
   * (issue [#2274](https://github.com/go-to-k/cdkd/issues/2274)).
   *
   * Set by the deploy engine from the create / update results it has already
   * collected this run, so by the time a DEPENDENT resolves, the producer's
   * entry is present (each resource is provisioned before anything that depends
   * on it, which is what the DAG guarantees).
   *
   * READ-ONLY and never substituted, exactly like {@link inheritedSecrets}:
   * `resolveGetAtt` still returns the REAL attribute value — that is what
   * reaches AWS, and CloudFormation delivers it to a dependent in the clear —
   * and only records the resolved string leaves as MASK-ONLY needles in
   * {@link recordedSecretValues}, i.e. in the bag belonging to the resource
   * whose resolution actually consumed the attribute. Recording at RESOLUTION
   * time rather than pre-seeding every context is what keeps the per-resource
   * scoping every reader of `perResourceSecrets` assumes — the same rule issue
   * #2087 forced on the inherited-secrets channel.
   *
   * `true` declares the WHOLE attributes bag sensitive (a custom resource's
   * `NoEcho` response); a SET names the sensitive members only (a nested
   * stack's `Outputs.<Key>` entries, where the rest of the child's outputs are
   * ordinary and masking them would degrade unrelated parent resources).
   */
  noEchoAttributeResources?: ReadonlyMap<string, true | ReadonlySet<string>>;
  /**
   * Bag the resolver pushes `<logicalId>.<attributeName>` into whenever it
   * serves a PERSISTED attribute that is nothing but {@link SECRET_MASK}
   * (issue #2274).
   *
   * This is the cross-DEPLOY half of the `NoEcho` story, and it exists because
   * the redaction is not free. Once a `NoEcho` custom resource's `Data` has
   * been masked into `state.json`, a LATER deploy that does NOT re-invoke the
   * handler (the resource is `NO_CHANGE`, so CloudFormation semantics say the
   * handler does not run) reads `***` back out of state — and a dependent
   * resolving `Fn::GetAtt` against it would otherwise PUSH that literal to AWS.
   * `state.ts` carries no durable per-attribute `NoEcho` flag to recover from
   * (issue [#2449](https://github.com/go-to-k/cdkd/issues/2449)), so the mask
   * itself is the signal.
   *
   * The resolver RECORDS; it never throws for this, and the difference decides
   * whether a stack stays deployable. A throw inside the diff would be caught
   * by `resolveBestEffort`, which keeps the raw intrinsic — so the desired side
   * would stop matching the `***` in state, the resource would look CHANGED on
   * every run, and the provisioning pass would then fail it. Recording instead
   * leaves the diff comparing `***` against `***`, i.e. a clean NO_CHANGE, so a
   * stack nobody has edited keeps deploying and only a dependent that ACTUALLY
   * has to be written is refused.
   *
   * **PRESENCE OF THE BAG IS THE OPT-IN, so it belongs ONLY on a context whose
   * reads something will READ** (issue #2847 round-4 review). An earlier
   * revision of this note said the deploy engine puts it on EVERY context, the
   * diff one included, on the argument that an unread array costs nothing. That
   * stopped being true the moment `resolveRefValue` began consulting the bag to
   * decide whether {@link refStateLookupFromResource} may SKIP a masked leaf:
   * on the diff context the skip fired with no reader behind it, so `{Ref: X}`
   * resolved to the raw physical id and was compared against the `'***'` in
   * state — a pre-existing #2274 stack that reported NO_CHANGE and deployed
   * clean now reported a spurious UPDATE and then hard-failed at the
   * provisioning refusal. Fail-closed, so never an exposure, but a regression
   * for existing users and a divergence from standalone `cdkd diff` (bagless,
   * still NO_CHANGE). `DeployEngine.buildResolverContext` therefore takes the
   * bag from its CALLER, and only the two provisioning sites pass one.
   */
  redactedAttributeReads?: RedactedAttributeRead[];

  /**
   * Units this pass could not resolve, recorded instead of abandoning every
   * later unit beside them (issues #3181 / #3218).
   *
   * OPT-IN, exactly like the bag above and for the same reason: the recovery
   * changes what a partially-resolved value looks like, so a caller asks for it
   * on the line where it builds its context rather than inheriting it
   * ambiently. Passing no bag keeps the pre-#3181 behaviour, where the first
   * failing token aborts every later token in the leaf and the first failing
   * key aborts every later key in the bag.
   *
   * **What a CONSUMER owes, and it is not optional: a non-empty bag MUST fail
   * the operation.** Recovery leaves each abandoned unit's input in place, so
   * `resolveValue`'s return can still carry a literal `{{resolve:...}}` token
   * or an unresolved `{"Ref": ...}` — and for a caller that SENDS its resolved
   * value to AWS that is the issue-#2482 shape, where the credential WAS the
   * template text and the deploy exited 0. The two consumers today are
   * `cdkd scrub`, which discards the resolved value and only wants the needles
   * recorded along the way, and this resolver's own tests.
   *
   * What a PUSHER owes: `subject` and `message` must already be LOG text —
   * an assembled reference can put a plaintext in the raw token, and an SDK
   * rejection echoes the name it was given.
   */
  abandonedResolutions?: AbandonedResolution[];
  /**
   * Internal hook used while evaluating the template `Conditions` section.
   * A CFn Condition can reference ANOTHER named condition via
   * `{Condition: OtherName}` inside `Fn::And` / `Fn::Or` / `Fn::Not`
   * (issue #840). When set, the `{Condition: X}` case in `resolveValue`
   * delegates to this resolver, which lazily evaluates condition `X`
   * (recursing into its own `{Condition: ...}` references) and memoizes
   * the result so declaration order in the `Conditions` block does not
   * matter and cycles are rejected. Not set when resolving normal
   * resource properties — a `{Condition: X}` reference outside the
   * `Conditions` section is invalid CFn and falls through to the
   * already-evaluated `conditions` map (or the not-found path).
   */
  conditionResolver?: (conditionName: string) => Promise<boolean>;
  /**
   * Set by BEST-EFFORT callers (the diff calculator's
   * `resolveBestEffort`, which catches resolution failures and keeps the
   * raw intrinsic) where a `Ref` to a resource that is not in state yet is
   * the EXPECTED case — the classic CDK logical-id-churn dance (an
   * `AWS::ApiGateway::Deployment` hash rotation, a `fn.currentVersion`
   * Lambda Version) makes the new template reference a resource this same
   * deploy will CREATE. When true, the resolver's "Ref not found" log is
   * demoted from warn to debug so a routine diff is not noisy (issue
   * #1017); the throw itself is unchanged. Deploy-time resolution leaves
   * this unset, keeping the warn as a genuine error signal.
   */
  bestEffort?: boolean;
  /**
   * When true, SECRET `{{resolve:...}}` dynamic references are left UNRESOLVED
   * (the expression string is returned verbatim). Set by the diff / no-op
   * comparison paths (GHSA fix): cdkd now persists the unresolved expression to
   * state (CloudFormation semantics — the substitution keeps the secret value
   * out of the persisted bag wherever the redaction can certify the position).
   * That is a redaction pass, not a guarantee about `state.json`: positions it
   * cannot certify keep what they were handed, ON THE DEPLOY PATH TOO — an
   * unchanged resource's `drainObservedCaptures` baseline reaches the persist
   * choke point with an empty secrets map (go-to-k/cdkd#2012,
   * go-to-k/cdkd#2852) — and other commands widen it further
   * (go-to-k/cdkd#2846, go-to-k/cdkd#2847). So a
   * comparison must keep the desired side as its
   * expression too, otherwise a resolved-plaintext-vs-stored-expression compare
   * reports a spurious change on every run and `cdkd diff` would also fetch and
   * print the value. A changed EXPRESSION still shows as a diff; a rotated
   * secret behind an unchanged expression is a no-op, exactly as under
   * CloudFormation.
   *
   * NO secret VALUE is fetched under this flag, but it is not the same as "no
   * AWS call" (issue #1901). A `secretsmanager` reference is secret by its
   * spelling, so it is skipped outright with no call. A plain `ssm` one is
   * secret only when its parameter is a `SecureString`, which is knowable only
   * from `GetParameter` — so a not-yet-classified `ssm` reference DOES cost one
   * call here, made with `WithDecryption: false` so a `SecureString` comes back
   * as ciphertext (never substituted, cached or persisted) and a `String` /
   * `StringList` resolves exactly as it must. The verdict is memoized per
   * expression, so each reference pays that call at most once per process.
   */
  skipDynamicReferences?: boolean;

  /**
   * The FOREIGN-region evidence for the secret-region classification issue
   * [#2134](https://github.com/go-to-k/cdkd/issues/2134) performs inside
   * {@link IntrinsicFunctionResolver.resolveDynamicReferences} -- the producer
   * regions this stack is on record as reading from, i.e.
   * `producerRegionsFromState(state)` over `state.imports[].sourceRegion` plus
   * `state.outputReads[].sourceRegion`.
   *
   * **Opt-in, and its ABSENCE is meaningful rather than a default.** Supplying
   * it arms the `ambiguous` REFUSAL: a name-form secret reference in a stack
   * that reads across a region boundary cannot be attributed to a region, so
   * the resolver declines rather than fetching a possibly-different secret.
   * Omitting it leaves every name-form reference `local`, which is the
   * pre-#2134 behaviour exactly.
   *
   * **`cdkd deploy` deliberately does NOT supply it, and that is a decision
   * rather than an omission.** The classifier's refusal is per-STACK, not
   * per-reference -- the evidence cannot say WHICH reference crossed the
   * boundary -- so arming it on deploy would refuse the ordinary CDK
   * `secretValueFromJson` shape (a plain name-form reference) in any stack
   * that also happens to hold one cross-region import, and templates that
   * deploy today would stop deploying.
   *
   * **`cdkd scrub` is the ONLY supplier**, and the precision matters because an
   * earlier draft of this paragraph named `cdkd drift` and the rollback replay
   * as well. They do NOT supply it: each classifies per token in its own
   * `*Resolvers` wrapper BEFORE calling the resolver, so a reference they route
   * arrives already attributed and never reaches the arm below. Scrub supplies
   * it because a wrong-region answer there is a silent MISS -- the stack
   * reported clean over surviving plaintext -- and failing closed is the point.
   *
   * A supplier must also make the refusal SURVIVE its own error handling.
   * Scrub wraps each resolution pass in a best-effort `catch`, so it re-raises
   * {@link DynamicReferenceRegionAmbiguousError} explicitly; swallowed, the
   * refusal produces exactly the silent success it exists to prevent (issue
   * #2134 review). Any future supplier owes the same.
   *
   * The other half of #2134 needs no evidence at all and is therefore always
   * armed, deploy included: a reference naming a full ARN says its own region,
   * so it is routed to a resolver pinned there rather than fetched against
   * this stack's endpoint.
   */
  producerRegions?: readonly string[];

  /**
   * Re-reads a state record's attributes from AWS when `Fn::GetAtt` is about to
   * take the physical-id fallback for it (issue
   * [#1852](https://github.com/go-to-k/cdkd/issues/1852)) — a record written
   * before its provider recorded the attribute is never re-recorded by a
   * no-change deploy, so without this the fallback's refusal is permanent.
   *
   * OPT-IN by presence, like the bags above. Only a caller that can ROUTE a
   * record to its provider supplies it: `DeployEngine` does, on every context
   * it builds, and persists what the read returns; `cdkd diff` supplies a
   * `readOnly` one (`read-only-attribute-healer.ts`) that persists nothing. A
   * context without one keeps the pre-#1852 behaviour exactly — no AWS call is
   * ever issued on its behalf. The supplier owns single-flight, memoization and
   * any persistence; the resolver only asks, and only on a MISS.
   */
  attributeHealer?: StaleAttributeHealer;

  /**
   * INTERNAL to `resolveGetAtt`'s heal wrapper, which sets it on a DERIVED
   * context for one resolution. Never set by a caller.
   */
  staleAttributeHeal?: StaleAttributeHealPhase;
}

/**
 * CloudFormation Intrinsic Function Resolver
 *
 * Resolves CloudFormation intrinsic functions in template values before
 * sending them to Cloud Control API or SDK providers.
 *
 * Supported functions:
 * - Ref (resources and parameters)
 * - Fn::GetAtt
 * - Fn::Join
 * - Fn::Sub
 * - Fn::Select
 * - Fn::Split
 * - Fn::If (Conditions)
 * - Fn::Equals
 * - Fn::And (logical AND)
 * - Fn::Or (logical OR)
 * - Fn::Not (logical NOT)
 * - Fn::ImportValue (cross-stack references)
 * - Fn::GetStackOutput (cross-stack/cross-region output reference)
 * - Fn::FindInMap (mapping lookups)
 * - Fn::Base64 (base64 encoding)
 * - Fn::GetAZs (availability zone listing)
 * - Fn::Cidr (CIDR address block calculation)
 */
/**
 * AWS Account information cache
 */
export interface AwsAccountInfo {
  accountId: string;
  region: string;
  partition: string;
  /**
   * `true` when STS could not be reached and `accountId` is the hardcoded
   * `123456789012` fallback rather than this caller's real account (issue
   * #1728 review; the fallback itself is issue #1730).
   *
   * Purely ADDITIVE and absent on the success path, so every existing consumer
   * is unaffected. It exists because the fabricated id is INDISTINGUISHABLE
   * from a real one downstream: an ARN built from it carries no wildcard, so
   * `isPlaceholderArn` cannot catch it, and a consumer receives a
   * confidently-wrong value. A caller that PERSISTS an ARN into state must
   * consult this and refuse — see `AppSyncProvider.childImportAttributes`.
   */
  fabricated?: boolean;
}

/**
 * The genuinely region-independent half of {@link AwsAccountInfo} — the ONLY
 * part that may be cached across callers (issue #1746).
 *
 * `region` is the CALLER's, and `partition` is a function of it, so caching a
 * whole `AwsAccountInfo` pinned the FIRST caller's region on every later
 * no-override call. That was benign-ish while `partition` was hardcoded to
 * `'aws'`; issue #1730 made the partition DERIVE from the region, so the stale
 * region started dragging a stale partition with it — a first call from a
 * `cn-north-1`-scoped resolver cached `{region: 'cn-north-1', partition:
 * 'aws-cn'}` and a later no-override call from a us-east-1 context read
 * `aws-cn`. Caching the ACCOUNT alone and deriving region + partition per call
 * removes the failure mode rather than papering over it.
 */
export interface CachedAccountIdentity {
  accountId: string;
  fabricated?: boolean;
}

/**
 * The real (non-fabricated) account identity, per CREDENTIAL IDENTITY: keyed by
 * {@link credentialFingerprint} of the active `AwsClients`' credential
 * configuration (issue [#3660](https://github.com/go-to-k/cdkd/issues/3660)).
 *
 * Process-wide, and a CLI run has one identity, so for the CLI this holds one
 * entry. A LIBRARY caller can install `AwsClients` for account A, deploy, then
 * install account B's in the same process (or run both in per-stack scopes);
 * keyed by nothing, B's `AWS::AccountId` and every ARN built from it resolved
 * as A's. The fabricated window and the in-flight slot below share the key.
 */
export const cachedAccountIdentities = new Map<string, CachedAccountIdentity>();

/**
 * Availability-zone names per (credential identity, region): keyed by
 * `injectiveKey(credentialFingerprint, region)` (issue
 * [#3660](https://github.com/go-to-k/cdkd/issues/3660)). The zone list is an
 * ACCOUNT's answer — an opt-in or restricted zone is visible to one account and
 * not another — so a region-only key served one identity's list to the next.
 */
export const cachedAvailabilityZones = new Map<string, string[]>();

/**
 * One resolved dynamic reference, as remembered by
 * {@link IntrinsicFunctionResolver.cachedDynamicReferences}.
 *
 * `secret` is the verdict the resolution that PRODUCED this value reached —
 * `true` for every `secretsmanager` spelling and for an `ssm` parameter whose
 * `GetParameter` response classified it as a `SecureString`. It is carried HERE
 * rather than re-derived from the process-global verdict store on every hit
 * because the two now have different lifetimes (issue #1933): another stack's
 * resolver — plausibly in another region, where the same parameter NAME is a
 * plain `String` — RETRACTS the store's memo when its own lookup comes back
 * public, and this instance's later resources would then stop redacting a value
 * that is genuinely secret for THEM. The entry answers for the region and the
 * stack that resolved it, which is the whole point of the instance scope.
 */
export interface CachedDynamicReference {
  value: string;
  secret: boolean;
}

/** What {@link IntrinsicFunctionResolver.namedRequestMasks} returns (go-to-k/cdkd#3171). */
export interface NamedRequestMasks {
  /** A masked clone of `error` and its whole cause chain; classification survives. */
  error: (error: unknown) => unknown;
  /** A caught SDK message, masked for interpolation into a line or a throw. */
  text: (message: string) => string;
  /** The `withRetry` logger for the same request. */
  retryLogger: RetryLogger;
}

/**
 * The `{{resolve:...}}` expressions this process has PROVEN resolve to a
 * SECRET, reached through `secret-redaction.ts`'s `recordedSecretExpressions`
 * store. Process-global, and cleared by `resetAccountInfoCache` so a test (or a
 * later phase) cannot inherit a verdict it just asked to forget.
 *
 * NOTE this store is deliberately WIDER-lived than the resolved VALUES it was
 * once paired with: those moved onto the resolver instance (issue #1933), while
 * a verdict is a statement about a reference's TYPE, which the redaction path
 * must be able to read with no resolver in hand. The asymmetry is safe in the
 * one direction that matters — a verdict inherited across regions can only make
 * a reference be treated AS a secret (persisted as its expression, never as
 * plaintext), and the reverse case re-asks AWS because the fresh response is
 * authoritative and the value cache no longer answers for another region.
 *
 * `ssm` is the kind that NEEDS the memory (issue #1901). A plain `ssm`
 * reference is not a secret by SPELLING the way `secretsmanager` is — whether
 * it resolves to public config or to a decrypted secret depends on the
 * parameter's `Type`, which is only knowable from the `GetParameter` response.
 * So secret-ness is discovered on the first resolution and remembered, keyed by
 * the full `{{resolve:...}}` expression. Two consumers need it AFTER the lookup
 * that populated it: the cache-hit arm (which must re-record the value as a
 * secret for the current resolution pass) and the diff / no-op path (which must
 * leave a SecureString reference unresolved without paying a lookup at all once
 * the type is known). A reference NOT in the set is only "not known to be
 * secure" — never "proven public" — so every arm that would leak still asks AWS
 * for the type first. Only the TYPE is remembered, never the decrypted value:
 * on the diff path the lookup is made with `WithDecryption: false`, so the
 * plaintext is never fetched at all there.
 *
 * A `secretsmanager` reference is recorded TOO, and that is issue
 * [#1916](https://github.com/go-to-k/cdkd/issues/1916). It needed no memory
 * while the only question asked of the set was "is this expression secret?",
 * which its spelling settles — but the set is ALSO the candidate list the
 * redaction path matches an INTRINSIC source leaf against
 * ({@link secret-redaction.redactSecretsForState}), and a list holding only the
 * ssm half cannot name the losing member of a collapsed
 * secretsmanager/secretsmanager pair. Recording every kind is what makes the
 * set mean what its name says. It changes no verdict here: every arm that reads
 * it for secret-ness already answers `true` on a `secretsmanager` spelling
 * before consulting it.
 *
 * The store lives in `secret-redaction.ts` rather than here (issue
 * [#1910](https://github.com/go-to-k/cdkd/issues/1910)) because the redaction
 * path is the other consumer: one set in the LEAF module means the redactor can
 * answer with no caller threading it, and the resolver reaches it along an
 * import edge it already has — the reverse would close a cycle.
 */
export const recordedSecretExpressions = {
  has: (expression: string): boolean => isRecordedSecretExpression(expression),
  add: (expression: string): void => recordSecretExpression(expression),
  delete: (expression: string): void => forgetSecretExpression(expression),
  clear: (): void => clearRecordedSecretExpressions(),
};

/**
 * Cache for EC2 instance attributes that require a live DescribeInstances
 * lookup (PrivateIp / PublicIp / PrivateDnsName / PublicDnsName /
 * AvailabilityZone). Keyed by `${physicalId}#${attributeName}`. The IP /
 * DNS attributes are not derivable from the instance id, so they are read
 * back from AWS once per (instance, attribute) and memoized for the PROCESS
 * lifetime — one `cdkd deploy` per CLI process, so "the deploy" in practice;
 * nothing in `src/` calls `resetAccountInfoCache`, tests do. Only a VALUE is cached — a settled instance's address, or the
 * known-empty `''` a settled instance reports for a public member it has
 * none of — never a refusal: a `pending` instance is re-described on the
 * next resolution, when it may have settled (issue #3096).
 */
export const cachedEc2InstanceAttributes: Record<string, string> = Object.create(null) as Record<
  string,
  string
>;

/**
 * The three sibling caches of {@link cachedEc2InstanceAttributes} (issues
 * #3096 / #3097), each holding a value the resolver read LIVE because the
 * state record omitted it — `definedAttributes` drops a member the provider
 * could not read back (issue #3077), so the `Fn::GetAtt` falls out of the
 * flat lookup and into `constructAttribute`'s per-type arm. Keyed by physical
 * id: the read is region-pinned (`clientsForRegion(this.explicitRegion)`),
 * so the key names one resource in that region, and the value — a default
 * security group id, a distribution hostname, a security group's VPC —
 * never changes; like the instance cache, a refusal caches nothing. Same
 * process lifetime, cleared together with it by {@link resetAccountInfoCache}.
 * The RDS `DBProxy` / `DBProxyEndpoint` `VpcId` arms have no cache because
 * they have no live read: `AwsClients` exposes no RDS client and this file
 * imports none, so those two arms refuse outright (see
 * `refuseUnservedAttribute`'s callers).
 *
 * All four are NULL-PROTOTYPE objects (#3096 delta review, measured): the
 * key is a state-record physical id, and on a plain `{}` a record holding
 * `constructor` / `__proto__` / `hasOwnProperty` read a FUNCTION out of
 * `Object.prototype` as the cached value — served with zero AWS calls, ahead
 * of every shape guard below. `Object.create(null)` has nothing to read; the
 * `delete`-based clears in `resetAccountInfoCache` keep the prototype.
 */
export const cachedVpcDefaultSecurityGroups: Record<string, string> = Object.create(null) as Record<
  string,
  string
>;
export const cachedCloudFrontDomainNames: Record<string, string> = Object.create(null) as Record<
  string,
  string
>;
export const cachedSecurityGroupVpcIds: Record<string, string> = Object.create(null) as Record<
  string,
  string
>;

/**
 * The region this call answers for: the caller's override, else the ambient one.
 *
 * Kept as one helper so the cached and the freshly-resolved paths cannot pick
 * different defaults (issue #1746).
 *
 * FOLDED here, at the source, rather than at each consumer (issue
 * [#1882](https://github.com/go-to-k/cdkd/issues/1882)). This is the value
 * `AWS::Region` returns, the value every `Fn::Sub` in a USER template
 * interpolates, and the `region-name` filter `resolveGetAZs` sends to EC2 when
 * the template names no region — three consumers with three different
 * case-sensitivities, which is why folding at the read beats folding at each of
 * them.
 *
 * #1882 held this raw pending a live CloudFormation A/B, on the reasoning that
 * `AWS::Region` is CFn's own passthrough and a user may legitimately read it
 * back. The A/B was run on 2026-08-25 and removes the premise rather than
 * answering it: a non-canonical region never reaches CloudFormation at all,
 * because SigV4's credential scope is compared case-sensitively by the service.
 * Measured against this repo's vendored SDK, every spelling but the canonical
 * one is refused before the request is served:
 *
 * ```text
 * STSClient({region:'us-east-1'}).send(GetCallerIdentity) -> OK
 * STSClient({region:'US-EAST-1'}).send(GetCallerIdentity) -> SignatureDoesNotMatch
 * STSClient({region:'Us-East-1'}).send(GetCallerIdentity) -> SignatureDoesNotMatch
 * CloudFormationClient({region:'US-EAST-1'}).send(ListStacks) -> SignatureDoesNotMatch
 *     "Credential should be scoped to a valid region."
 * ```
 *
 * Two routes a raw region could take are therefore closed BEFORE this function:
 * `--region` / `AWS_REGION` are folded at the CLI boundary (`foldRegionOption`,
 * issue #2065), and a CDK app declaring `env: { region: 'US-EAST-1' }` fails at
 * `app.synth()` — `EnvironmentUtils.parse` is case-sensitive, measured on
 * aws-cdk-lib 2.244.0.
 *
 * What is NOT closed, and is the reason this fold is more than tidiness: a Cloud
 * Assembly that reaches cdkd with a raw region in its `environment` string.
 * cdkd's own `parseEnvironment` (`src/types/assembly.ts`) accepts any region
 * text, so a hand-authored assembly, a non-CDK toolchain, or a `cdk.out` left
 * behind by a synth that threw AFTER writing the manifest all reach
 * `stackInfo.region` unfolded, and `deploy.ts` passes it on as the resolver's
 * region. That deploy SUCCEEDS — `AwsClients`' constructor folds the region its
 * clients sign with, so SigV4 never sees the raw spelling — and every
 * `${AWS::Region}` a user's `Fn::Sub` interpolates inherits it, producing
 * `arn:aws:s3:US-EAST-1:...`, which no IAM policy matches, and persisting it,
 * while every ARN cdkd itself constructs beside it is canonical (issue #1850).
 * Folding here removes that self-contradiction.
 *
 * UPGRADE CONSEQUENCE, stated because #1850's own entry states it for its fold:
 * a stack deployed that way keeps the raw spelling in its recorded properties,
 * so the next diff of a property interpolating `${AWS::Region}` sees a change,
 * and where the property is create-only that classifies as a REPLACEMENT.
 * Deliberate — the recorded value is unusable, so converging it is the point.
 * State KEYS are unaffected: they are built from `stackRegion`, which this does
 * not touch.
 *
 * The consumer-side `canonicalizeRegion` calls this subsumes are deliberately
 * LEFT in place. Only `s3-endpoints.ts`'s is still reachable from a caller that
 * does not come through here; the rest are now genuinely redundant and are kept
 * as defense in depth, since double-folding is a no-op and a future caller may
 * reach them another way.
 */
export function effectiveAccountInfoRegion(overrideRegion?: string): string {
  return canonicalizeRegion(overrideRegion || process.env['AWS_REGION']) || 'us-east-1';
}

/**
 * Build the caller's full answer from the cached account identity (issue #1746).
 *
 * `partition` is a FUNCTION of `region`, so it is derived HERE — per call —
 * rather than carried alongside the account. This is what makes the cache safe
 * to share between callers with different regions: an `arn:aws:...:cn-north-1`
 * (or the inverse `arn:aws-cn:...:us-east-1`) is structurally valid, so nothing
 * downstream could catch it.
 */
export function accountInfoFor(
  identity: CachedAccountIdentity,
  overrideRegion?: string
): AwsAccountInfo {
  const region = effectiveAccountInfoRegion(overrideRegion);
  return {
    accountId: identity.accountId,
    region,
    partition: derivePartitionAndUrlSuffix(region).partition,
    ...(identity.fabricated ? { fabricated: true } : {}),
  };
}

/**
 * How long a FABRICATED answer is reused before STS is retried (issue #1730,
 * PR review). Deliberately not the success path's forever-cache — the whole
 * point is that a transient blip must not poison the run — but not zero either:
 * `getAccountInfo` is on the path of EVERY `Fn::GetAtt` and every
 * `AWS::AccountId` / `AWS::Partition` / `AWS::StackId` pseudo-parameter, so an
 * uncached failure re-issues `GetCallerIdentity` (with the SDK's own 3-attempt
 * retry + backoff) dozens of times per stack and prints one warning each. This
 * window collapses a burst into one call while still letting a later phase of
 * the same deploy heal.
 */
export const FABRICATED_ACCOUNT_INFO_TTL_MS = 10_000;

/**
 * Retries after the first attempt for a dynamic-reference lookup, THROTTLE-shaped
 * failures only (issue #1933 review). Everything else — a missing parameter, a
 * denied secret — is a real answer and is thrown to the caller unchanged.
 *
 * It matters more since the cache became per-resolver AND stopped memoizing a
 * value whose ssm `Type` was unclassifiable: both raise the call COUNT for the
 * same template (one lookup per resolver rather than per process; one per
 * occurrence for the anomalous type), and a bare `send` turned the resulting
 * throttle into an aborted deploy. At the default backoff (1s -> 2s -> 4s -> 8s)
 * this adds at most ~15s of sleep, against re-running the whole deploy.
 */
export const MAX_DYNAMIC_REFERENCE_THROTTLE_RETRIES = 4;

/**
 * How many producer output KEYS an `Fn::GetStackOutput` not-found error may
 * enumerate (issue #2133 review). See {@link
 * IntrinsicFunctionResolver.describeAvailableOutputs} for why the list is
 * bounded at all; the value is "enough to fix a typo, few enough that one error
 * cannot dump a producer's whole key space".
 */
export const MAX_LISTED_AVAILABLE_OUTPUTS = 10;

/**
 * Test seam: overriding `sleep` lets unit tests drive the backoff schedule
 * without real waits (mirrors `describeTypeRetryDelays`).
 */
export const dynamicReferenceRetryDelays: { sleep?: (ms: number) => Promise<void> } = {};

/**
 * How long {@link allSettledKeepingFirstRejection} waits for the remaining
 * parts AFTER a rejection is in hand. Double the largest FIXED wait in this
 * file (the `Fn::GetAtt` `Ipv6CidrBlocks` poll's sleep budget, 15 attempts
 * x 2 s), which makes it a hang guard rather than a schedule — not a
 * guarantee that healthy work fits inside it; see the function's own note.
 *
 * It is the budget for one CALL of {@link IntrinsicFunctionResolver.resolve}
 * and everything nested under it: nested drains share the REMAINING wait, so
 * a template's nesting depth cannot multiply it. It is NOT a bound on a caller
 * that resolves in a LOOP -- each iteration opens its own budget unless the
 * caller wraps the loop in {@link withSharedDrainBudget}, which the outputs
 * pass does and `evaluateConditions` deliberately does not (its aggregate is
 * `#conditions x` this, before any resource is provisioned but with the
 * deploy lock already held).
 */
export const DRAIN_AFTER_REJECTION_MS = 60_000;

/** Sentinel for "the cap expired", distinguishable from any resolved value. */
export const CAP_EXPIRED = Symbol('drain-cap-expired');

/**
 * Test seam: overriding `ms` lets a unit test drive the cap without a real
 * minute of waiting (mirrors {@link dynamicReferenceRetryDelays}).
 */
export const concurrentDrainCap: { ms?: number } = {};

/**
 * The budgets whose drain has already reported abandoned inputs (issue
 * [#2814](https://github.com/go-to-k/cdkd/issues/2814)). A `WeakSet` so a
 * budget's entry dies with the budget, as the budget itself does with the
 * async context that opened it.
 */
export const abandonReported = new WeakSet<object>();

/**
 * The order in which drains CAPTURED rejections, across every drain in the
 * process (issue [#2805](https://github.com/go-to-k/cdkd/issues/2805)). A
 * counter, not `Date.now()`: two rejections in one millisecond still order.
 */
export let rejectionClock = 0;

/**
 * The capture orders a drain's NESTED drains threw their picks with, keyed by
 * the thrown error. Each drain starts its parts inside its own map's scope,
 * so a drain nested in one of them writes into its PARENT's map and nobody
 * else's. The parent then compares that failure by when it happened rather
 * than by when the inner drain let it go. Per parent, not one map per error:
 * a memoized error object can be in flight in two resolutions at once, and a
 * single record would let one resolution's drain overwrite the other's before
 * its parent read it, or hand one drain a capture that never happened in its
 * own parts. A `WeakMap` so an entry dies with its error. A primitive
 * rejection (`throw undefined`) has no key and is ordered by arrival, as
 * every rejection was before #2805.
 */
export const nestedCaptureOrders = new AsyncLocalStorage<WeakMap<object, number>>();

/**
 * `Promise.all`'s RESULT and its choice of error, with `Promise.allSettled`'s
 * TIMING: every promise started here has settled before this returns, and
 * before it throws unless the cap below expires first (issue
 * [#2563](https://github.com/go-to-k/cdkd/issues/2563)).
 *
 * Why the resolver needs that. Resolving a secret dynamic reference RECORDS
 * `plaintext -> expression` into `context.recordedSecretValues` just before
 * its promise settles, and that map is what every masking and redaction site
 * downstream uses as its needle set. Under a bare `Promise.all` a rejecting
 * part surfaces IMMEDIATELY, so a caller's `catch` / `finally` can run while a
 * sibling part is still in flight: `DeployEngine`'s `Export.Name` block copies
 * its private map into the pass map in exactly such a `finally`, and the
 * sibling's recording then lands in the private map after the copy and reaches
 * nothing. Draining here fixes it for every caller at once, which a
 * consumer-side drain cannot — `cdkd scrub`'s shared-map view (issue
 * [#2531](https://github.com/go-to-k/cdkd/issues/2531)) lets a late write land
 * whenever it happens but still cannot make it land before the next consumer
 * runs.
 *
 * THE ERROR IS SELECTED BY TIME, NOT BY INPUT ORDER, which is what `Promise.all`
 * does and what a naive `Promise.allSettled` + "first rejected entry" would
 * silently change: with two parts rejecting out of input order, the entry scan
 * reports the LATER one. Each promise gets its own `catch`, so the callbacks
 * fire in rejection order and each one is ranked as it arrives: by arrival,
 * or by the capture order a nested drain recorded for it (below).
 *
 * Every input is `catch`-ed, so nothing here can raise an unhandled rejection
 * while the drain waits.
 *
 * THE WAIT IS CAPPED ONCE A REJECTION IS IN HAND. The drain exists to let a
 * sibling finish RECORDING, and that is worth a wait — but `resolveOutputs`
 * runs at `deploy-engine.ts`'s worst moment: after every resource has been
 * created in AWS, before the final `saveState`, with the S3 lock held and its
 * heartbeat pushing `expiresAt` forward. An unbounded wait there costs a deploy
 * its state and its lock, and on a FIRST deploy (`currentEtag` undefined, so
 * the incremental saves were no-ops) every created resource becomes invisible
 * to cdkd. Nothing else bounds it: `withRetry` caps ATTEMPTS not duration, no
 * `requestTimeout` is configured, and `withResourceDeadline` wraps
 * `provisionResourceBody` — which does bound the resource path, property
 * resolution included, but not the outputs pass. So once a rejection is
 * recorded the remaining settles race {@link DRAIN_AFTER_REJECTION_MS}, and the
 * recorded rejection is thrown when it expires.
 *
 * The cap is a HANG GUARD, and it does not claim to be more. It is sized
 * against the largest fixed wait in the resolver — the `Fn::GetAtt`
 * `Ipv6CidrBlocks` poll's sleep budget, 15 attempts x 2 s, about 30 s — but
 * that budget is a floor, not a ceiling: the poll also awaits 15 AWS calls,
 * and one part can drive several lookups in sequence through object
 * properties or `Fn::Sub` variables. Two healthy shapes measured on review
 * already exceed 60 s — three sequential `Ipv6CidrBlocks` polls in one part
 * is 3 x (15 x 2 s) = 90 s with no hang and no throttling, and five throttled
 * dynamic references is 5 x (1+2+4+8 s) = 75 s at
 * `MAX_DYNAMIC_REFERENCE_THROTTLE_RETRIES` = 4. Healthy work CAN therefore
 * outlast the cap, and when it does its recording lands after the rejection
 * was released, which is the window this whole function exists to close.
 * Nothing here cancels that sibling — it keeps running and can record
 * arbitrarily later — so what the cap bounds is the WAIT, not the lateness.
 * That is the trade taken deliberately: a bounded wait with a late record
 * still possible beyond it, against an unbounded hold on a deploy's state
 * save.
 *
 * AND A DRAIN CAN GET NO GRACE AT ALL. The budget is shared REMAINING wait,
 * so a drain that arms once it is spent gets
 * `Math.max(0, remaining - openWindow)` = 0 and releases its rejection on the
 * next macrotask. That applies to any drain NOT ALREADY ARMED when a rejection
 * reaches it: the ordinary case is an inner drain that spends the full budget
 * and throws, whose every not-yet-armed ancestor then arms against an
 * exhausted remaining-wait budget. What it does NOT mean is that a fast sibling is exposed: a
 * sibling still pending at that moment has itself been running at least the
 * budget. What it means is that the sibling's own RECORDING gets no wait --
 * a lookup begun late inside a long-running part is fast in itself and still
 * lands after the rejection was released. That reasoning covers the NESTED
 * ancestor case; a caller that wraps a LOOP widens it, because a later
 * iteration starts FRESH siblings against a budget an earlier one already
 * spent and those need not be long-running at all. So the exposure does not
 * require the "healthy work slower than 60 s" shape the sizing paragraph
 * describes; that shape is the cheapest way to reach it with no nesting and
 * no wrapped loop, not the floor.
 *
 * WHAT HAPPENS TO A PART THE CAP STOPS WAITING FOR (issue
 * [#2814](https://github.com/go-to-k/cdkd/issues/2814)). It keeps running, and
 * its recording still lands in the context's map whenever it arrives -- the
 * cap costs it ORDER, not the write. So the answer sits with the READERS: one
 * that runs after the recording arrives must see it, which `DeployEngine`'s
 * outputs pass arranges for its `Export.Name` block (a map that writes each
 * recording through to the pass map at once, where a local copied in a
 * `finally` used to drop it) and for the persisted outputs, the exports index
 * and the deploy summary (each redacting against the pass map as it stands
 * at the moment it is written). A reader that took its
 * copy BEFORE the recording arrived -- a failure message already printed, a
 * state save already sent -- cannot be helped without waiting, and the wait
 * is what the cap bounds. Cancelling the
 * part would not close that either: a cancelled part never records, so its
 * plaintext would be missing for EVERY reader rather than for the early ones.
 * What this helper adds is the report: releasing a rejection with inputs
 * still running calls `onAbandoned` with how many, at most once per budget,
 * and the resolver turns that into a warning.
 *
 * THE EARLIEST-IN-TIME RULE HOLDS ACROSS NESTED DRAINS, not only per
 * invocation (issue [#2805](https://github.com/go-to-k/cdkd/issues/2805)).
 * For a join whose parts are `[listWithAnEarlyFailure, laterFailure]`, the
 * inner list's drain holds its own rejection while its slow sibling finishes,
 * so the outer join RECEIVES the later failure first. Picking by arrival would
 * report that shallower one, and it is not only cosmetic: the retry
 * classifiers read the message (`retryClassificationText` feeds
 * `isRetryableTransientError`, whose `RETRYABLE_ERROR_MESSAGE_PATTERNS` is a
 * substring table), so swapping which failure surfaces can swap a transient
 * verdict for a terminal one. So each rejection carries the order it was
 * CAPTURED in: a drain throws its pick with that order recorded in its
 * parent's {@link nestedCaptureOrders} map, and the parent keeps the smallest.
 * CAPTURED means the moment the first drain above a failure saw it, not the
 * moment its lookup failed: two failures inside one turn are ordered by how
 * many async layers each crossed to reach a drain, which is scheduling rather
 * than time, and the case file pins only failures a turn apart. The helper
 * STARTS the parts (`start`) so it can run them inside its own map's scope:
 * that is how a nested drain finds the one drain it throws to, and any other
 * drain receiving the same error object orders it by arrival. Where the
 * answer still differs from `Promise.all`'s: a drain the cap releases reports
 * the earliest it has RECEIVED, and an inner failure still held below it is
 * not among them; a layer that WRAPS an error between two drains drops the
 * order, and the wrapper is ordered by arrival.
 */
export async function allSettledKeepingFirstRejection<T>(
  start: () => readonly Promise<T>[],
  onAbandoned: (pending: number) => void
): Promise<T[]> {
  let rejection: { readonly error: unknown; readonly at: number } | undefined;
  // Where this drain's nested drains record their picks' capture orders, and
  // where this drain records its own, for its parent (issue #2805).
  const nestedOrders = new WeakMap<object, number>();
  const parentOrders = nestedCaptureOrders.getStore();
  const promises = nestedCaptureOrders.run(nestedOrders, start);
  // Unreachable through today's entry points: both public methods that reach
  // a drain open a store (`resolve`, `evaluateConditions`). A case in the
  // drain test reds when a public member reaches a drain without opening one
  // -- but only along the shape it walks, which is a `this.<identifier>(...)`
  // chain from THIS helper's call sites, over methods and callable fields. It
  // is a SYNTACTIC regression check and not a proof, on two axes: it asks
  // whether the member opens a budget somewhere in its body rather than
  // whether the resolution runs inside it, and an aliased receiver, a
  // `.bind`, an element-access call or a closure returned from a getter each
  // walk past it. That case enumerates them, measured. Kept as a fallback
  // because the alternative -- throwing -- would turn a fence miss into a
  // failed deploy, and a caller that somehow reached here should get the OLD
  // per-invocation bound rather than none. Never exercised by the suite:
  // instrumented across all of it, zero drains took it.
  const shared = drainDeadlines.getStore();
  // Armed by the FIRST rejection, so the cap measures the wait that a failure
  // caused rather than the resolution's own runtime: a slow but successful
  // pass is not on a clock.
  let armCap: (() => void) | undefined;
  // How many inputs have settled, so a release by the cap can say how many it
  // stopped waiting for (issue #2814).
  let settled = 0;
  const guarded = promises.map((promise) =>
    promise.then(
      (value) => {
        settled += 1;
        return value;
      },
      (error: unknown) => {
        settled += 1;
        // A primitive reads `undefined` from a `WeakMap`, so it needs no guard
        // here; the WRITE below does, since `set` throws on one.
        const recorded = nestedOrders.get(error as object);
        const at = recorded ?? (rejectionClock += 1);
        if (rejection === undefined) {
          rejection = { error, at };
          armCap?.();
        } else if (at < rejection.at) {
          rejection = { error, at };
        }
        // The value is never read: the throw below happens first whenever any
        // input rejected, and this cast keeps the settled-values type honest
        // for the caller rather than widening it to `T | undefined`.
        return undefined as unknown as T;
      }
    )
  );
  let capTimer: ReturnType<typeof setTimeout> | undefined;
  // Whether this drain took a share of the budget, so the `finally` knows to
  // release it. Not `capTimer !== undefined`: a drain with no store arms a
  // timer and charges nothing.
  let charged = false;
  const capped = new Promise<typeof CAP_EXPIRED>((resolve) => {
    armCap = () => {
      // A REMAINING budget, not a deadline. An absolute `at` spends the
      // budget by WALL CLOCK: ordinary resolution time between two drains
      // burns it although nothing drained, so in a wrapped loop an output
      // that failed with a 5 ms sibling could leave a later one with zero
      // grace after 60 s of clean AWS work. What the cap is supposed to
      // bound is total drain WAIT.
      const budget = concurrentDrainCap.ms ?? DRAIN_AFTER_REJECTION_MS;
      let wait = budget;
      if (shared !== undefined) {
        shared.remaining ??= budget;
        // `remaining` is only charged when the last waiter leaves, so a drain
        // arming while another is ALREADY waiting must subtract the part of
        // the open window that has run -- otherwise two staggered drains each
        // arm against the full remainder and keep extending the bound (drain
        // A at t=0 and B at t=80 of a 100 ms budget released at 100 and 180).
        const openWindow = shared.since === undefined ? 0 : Date.now() - shared.since;
        wait = Math.max(0, shared.remaining - openWindow);
        // Only the OUTERMOST waiting drain charges the budget. Nested drains
        // wait CONCURRENTLY -- an outer drain's wait contains its inner
        // one's -- so charging each would spend the budget once per level
        // and re-create the depth x cap shape one layer down.
        if (shared.waiting === 0) shared.since = Date.now();
        shared.waiting += 1;
        charged = true;
      }
      capTimer = setTimeout(() => resolve(CAP_EXPIRED), wait);
      // NOT `unref`'d, deliberately. The `finally` below clears the timer on
      // every exit from the race, so it is live only while something is
      // awaiting it — and an unref'd timer lets Node empty the loop and exit
      // 0 mid-deploy when the hung sibling holds nothing itself, which is
      // strictly worse than the hang this cap replaced. The unit suite
      // structurally cannot catch that: vitest's own loop holds the process
      // open regardless.
    };
  });
  try {
    const outcome = await Promise.race([Promise.all(guarded), capped]);
    // A bare re-throw of an error some OTHER site constructed, and the reason it
    // is safe is a CALLER's, not this line's.
    //
    // `allSettledKeepingFirstRejection` is a MODULE-SCOPE helper with no
    // `ResolverContext` parameter, so no secret bag is in scope here and masking
    // is not an option at all — which is the whole argument. What it is NOT: it
    // is not true that this runs "before any per-pass secret bag exists" (the
    // two call sites are mid-pass, which is what issue #2797 was about), and it
    // is not true that every error arriving here was built at a site the resolver's
    // coverage checker governs. The drained promises are `resolveValue`, which
    // reaches the dynamic-reference lookups. Since go-to-k/cdkd#3171
    // `sendWithThrottleRetry` rethrows an AWS rejection as a clone masked by
    // the request's names (an AccessDenied naming an `Fn::Sub`-assembled
    // SecretId included), so what arrives here from that route is already
    // masked. The downstream boundary masks stay as the layer for every other
    // error: `DeployEngine.handleOutputResolutionFailure` and the `cdkd import`
    // boundary (issues #2728 / #2803).
    if (rejection !== undefined) {
      // Inputs still running here means the CAP won the race: report them,
      // once per budget (issue #2814), so a failure that releases several
      // nested drains, or a wrapped loop whose later iterations find the
      // budget spent, warns once rather than once per drain. Counted now, not
      // when the timer fired: an input can settle in the turn between.
      const pending = promises.length - settled;
      if (pending > 0) {
        // Reported once per BUDGET. A drain with no store -- the fallback
        // above, which no public entry point reaches -- has no budget to key,
        // so it reports on its own rather than joining a set nothing could
        // ever look it up in again.
        if (shared === undefined) onAbandoned(pending);
        else if (!abandonReported.has(shared)) {
          abandonReported.add(shared);
          onAbandoned(pending);
        }
      }
      const { error, at } = rejection;
      if (parentOrders !== undefined && typeof error === 'object' && error !== null) {
        // The SMALLEST: two sibling drains can throw one memoized error object
        // in the same turn, before the parent has read either record.
        const earlier = parentOrders.get(error);
        parentOrders.set(error, earlier === undefined ? at : Math.min(earlier, at));
      }
      throw error;
    }
    // Narrowed rather than cast: winning the race without a rejection is
    // unreachable today, since only a rejection arms the cap — and an edit
    // that armed it elsewhere would otherwise hand a Symbol to the caller's
    // `resolvedValues.join(...)` with the compiler's blessing. Removing this
    // guard reds no TEST, and cannot: what it buys is a compile error, caught
    // by `vp run typecheck` over the src tree (`vp test`'s inline typecheck covers
    // test files only). That is the fence, not a missing case.
    if (outcome === CAP_EXPIRED) {
      // `markNonRetryable` even though this arm is documented unreachable:
      // if it ever fires, the retry classifiers read the message, and this
      // file's other deterministic refusals are marked the same way.
      throw markNonRetryable(new Error('drain cap expired with no rejection recorded'));
    }
    return outcome;
  } finally {
    if (capTimer !== undefined) clearTimeout(capTimer);
    if (charged && shared !== undefined) {
      shared.waiting -= 1;
      if (shared.waiting === 0 && shared.since !== undefined) {
        // Charge the wall clock spent while ANY drain under this budget was
        // waiting, which for overlapping waits is exactly the total drain
        // wait. Clean work between drains costs nothing.
        shared.remaining = Math.max(0, (shared.remaining ?? 0) - (Date.now() - shared.since));
        shared.since = undefined;
      }
    }
  }
}

/**
 * The key for the resolver's per-region SDK client caches ({@link
 * IntrinsicFunctionResolver}'s `cfnClients`, `regionScopedClients` and
 * `serviceDiscoveryClients`): the region PLUS the credential fingerprint of the
 * configuration the cached client was built from (issue
 * [#3588](https://github.com/go-to-k/cdkd/issues/3588)). Encoded through
 * {@link injectiveKey}, so no region or profile spelling can forge another
 * pair's key.
 */
export function clientCacheKey(region: string, credentialConfig: CredentialConfig): string {
  return injectiveKey(region, credentialFingerprint(credentialConfig));
}

/**
 * Is `region` safe to build an AWS SDK client from?
 *
 * This is a SECURITY gate, not an AWS region registry, and the distinction
 * decides how strict it is. The SDK turns a region into a hostname by
 * substitution — `https://ssm.{region}.amazonaws.com` — so a value carrying a
 * host delimiter escapes the label and re-points the endpoint: the measured
 * case is `evil.example.com#`, which yields
 * `https://ssm.evil.example.com/#.amazonaws.com` and sends a SigV4-SIGNED
 * request (access key id + signature) to an attacker-controlled host.
 *
 * The reachable input is `Fn::GetAZs`, whose argument is TEMPLATE-DERIVED and
 * can arrive through an `Fn::ImportValue` or a parameter — i.e. it is not
 * necessarily written by whoever runs the deploy. Before issue #1957 that value
 * only fed the `region-name` FILTER of a `DescribeAvailabilityZones` call and
 * never built a client, so binding lookups to a region is exactly what made it
 * reachable; the gate ships with the binding.
 *
 * So the predicate is CHARSET-based rather than shape-based: lowercase
 * alphanumerics and hyphens only, which cannot express `.`, `/`, `:`, `@`, `?`
 * or `#` and therefore cannot leave the hostname label. It deliberately does
 * NOT try to enumerate real regions — AWS keeps adding them
 * (`ap-southeast-7`, `il-central-1`, `mx-central-1`, `eusc-de-east-1`), and a
 * pattern tight enough to reject `----` would also reject the next one. A
 * region-shaped-but-nonexistent value is not a security problem: it resolves to
 * a hostname that does not exist and the SDK fails loudly.
 *
 * Note the sibling pattern in `src/cli/commands/state-file-keys.ts` is NOT
 * reusable here, and the reason is structural rather than a gap in its
 * coverage: it is SHAPE-based because its job is the opposite one — telling a
 * region segment apart from a stack name sitting in the same key position —
 * so it must enumerate the shape this predicate refuses to. (Its prefix was
 * exactly `^[a-z]{2}` until issue #2001, which is what made it reject the
 * European Sovereign Cloud partition's four-letter `eusc-de-east-1`; it now
 * takes `{2,4}`, and is still the wrong tool here.)
 *
 * Callers must {@link canonicalizeRegion} first — `US-EAST-1` is a documented
 * input and is lowercase-canonical, not invalid.
 */
export function isClientSafeRegion(region: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,30}$/.test(region);
}

/** Test seam for {@link FABRICATED_ACCOUNT_INFO_TTL_MS} expiry. */
export const accountInfoClock = { now: (): number => Date.now() };

/** The bounded fabricated-answer window, per credential identity (see {@link cachedAccountIdentities}). */
export const fabricatedAccountIdentities = new Map<
  string,
  { identity: CachedAccountIdentity; expiresAt: number }
>();

/**
 * The single in-flight lookup PER CREDENTIAL IDENTITY, so N concurrent callers
 * of one identity share ONE round trip, and a second identity never joins the
 * first's (issue #3660).
 *
 * The TTL above collapses SEQUENTIAL callers; this collapses PARALLEL ones
 * (PR review). `cdkd deploy --concurrency 10` resolves ten resources' intrinsics
 * at once, so without it an STS outage costs ten `GetCallerIdentity` calls —
 * each with the SDK's own 3-attempt retry — and ten identical warnings per
 * window. Cleared in a `finally` so a failure cannot wedge it.
 */
export const accountInfoInFlight = new Map<string, Promise<CachedAccountIdentity>>();

/**
 * Bumped by {@link resetAccountInfoCache}, so a lookup that was already in
 * flight cannot write the cache it was asked to forget.
 *
 * Without it the reset only cleared the SETTLED caches: an in-flight resolve
 * would land afterwards and re-populate `cachedAccountIdentities`, so the next
 * caller read the pre-reset account. That is the `*Once`-leak shape one layer
 * down — a later test silently inheriting an earlier one's answer — and the
 * reset's own comment already claimed to forget it.
 */
export let accountInfoGeneration = 0;

/**
 * Get AWS account information from STS, for the ACTIVE credential identity.
 *
 * `identityKey` is read FIRST and synchronously, and `resolveAccountIdentity`
 * reads `getAwsClients().sts` before its first `await`, so the key and the
 * client that answers come from ONE reading of the active clients (issue
 * #3660). Never log the key.
 */
export async function getAccountInfo(overrideRegion?: string): Promise<AwsAccountInfo> {
  const identityKey = credentialFingerprint(ambientCredentialConfig());
  const cached = cachedAccountIdentities.get(identityKey);
  if (cached) return accountInfoFor(cached, overrideRegion);

  // A fabricated answer inside its TTL is reused (see the constant above) —
  // WITHOUT promoting it to `cachedAccountIdentities`, so it still expires.
  const fabricated = fabricatedAccountIdentities.get(identityKey);
  if (fabricated && accountInfoClock.now() < fabricated.expiresAt) {
    return accountInfoFor(fabricated.identity, overrideRegion);
  }

  const pending = accountInfoInFlight.get(identityKey);
  if (pending) return accountInfoFor(await pending, overrideRegion);

  // NOTE the lookup is region-AGNOSTIC — it resolves the ACCOUNT, and every
  // caller's region is applied by `accountInfoFor` afterwards — so sharing one
  // in-flight promise across callers with different `overrideRegion`s is safe.
  // Since issue #1746 that is structural rather than a property to preserve:
  // `resolveAccountIdentity` takes no region at all.
  const inFlight = resolveAccountIdentity(identityKey);
  accountInfoInFlight.set(identityKey, inFlight);
  try {
    return accountInfoFor(await inFlight, overrideRegion);
  } finally {
    // Only clear the slot we still OWN. `resetAccountInfoCache` clears it too, so
    // a reset mid-flight lets a later caller install its own promise — an
    // unconditional clear here would drop THAT one and cost a redundant
    // `GetCallerIdentity`.
    if (accountInfoInFlight.get(identityKey) === inFlight) accountInfoInFlight.delete(identityKey);
  }
}

export async function resolveAccountIdentity(identityKey: string): Promise<CachedAccountIdentity> {
  const generation = accountInfoGeneration;
  const stillCurrent = (): boolean => generation === accountInfoGeneration;
  const logger = getLogger().child('IntrinsicFunctionResolver');
  // Read before the first `await`: the same reading `identityKey` was taken from.
  const awsClients = getAwsClients();
  const stsClient = awsClients.sts;

  try {
    const response = await stsClient.send(new GetCallerIdentityCommand({}));
    const accountId = response.Account || '123456789012';

    // A SUCCESSFUL call that carries no `Account` lands on the same hardcoded
    // id as the failure arm below, so it has to be flagged the same way (review
    // finding) — reachable against an emulated / non-AWS STS endpoint. Flagging
    // only the catch arm would leave the identical fabricated value unmarked on
    // the path that looks like it worked.
    const resolved: CachedAccountIdentity = {
      accountId,
      ...(response.Account ? {} : { fabricated: true }),
    };
    // Only a NON-fabricated answer is cached for the process (issue #1730,
    // mirroring `write-only-properties.ts`'s "only SUCCESSFUL lookups are
    // cached"): a fabricated id poisons every later caller in the run, and the
    // ARN-building consumers refuse on `fabricated`, so caching one turns a
    // single bad STS answer into a whole deploy that records no ARNs. A
    // fabricated one gets the short TTL above instead of nothing, so the retry
    // is bounded rather than per-call.
    if (!stillCurrent()) {
      // A reset landed while this lookup was in flight — return the answer to
      // our own caller but do NOT re-populate the cache it cleared.
    } else if (resolved.fabricated) {
      fabricatedAccountIdentities.set(identityKey, {
        identity: resolved,
        expiresAt: accountInfoClock.now() + FABRICATED_ACCOUNT_INFO_TTL_MS,
      });
    } else {
      cachedAccountIdentities.set(identityKey, resolved);
      fabricatedAccountIdentities.delete(identityKey);
    }
    // not-in-class(accountId): an AWS ACCOUNT ID from STS, never a resolved template value.
    logger.debug(`Retrieved AWS account info: ${accountId}`);
    return resolved;
  } catch (error) {
    // not-in-class(error instanceof Error ? error.message : String(error)): an STS GetCallerIdentity rejection -- `new GetCallerIdentityCommand({})` carries no parameters at all, so its message cannot echo a template value, and this helper is module scope with no ResolverContext to mask against.
    logger.warn(
      `Failed to get AWS account info from STS: ${error instanceof Error ? error.message : String(error)}, using defaults`
    );
    // Fallback to environment variables or defaults
    const fallback: CachedAccountIdentity = {
      accountId: process.env['AWS_ACCOUNT_ID'] || '123456789012',
      // Only when the id is the HARDCODED fallback. An `AWS_ACCOUNT_ID` the
      // operator supplied is a real answer to "which account", so flagging it
      // would make callers refuse a value that is fine.
      ...(process.env['AWS_ACCOUNT_ID'] ? {} : { fabricated: true }),
    };
    // A transient STS blip must not poison the rest of the run — see the
    // caching note on the success path. An operator-supplied `AWS_ACCOUNT_ID`
    // IS a real answer and is cached as one; a fabricated id gets the bounded
    // TTL so the retry does not fire on every single caller.
    if (!stillCurrent()) {
      // See the success arm: a reset invalidated this lookup's right to cache.
      return fallback;
    }
    if (fallback.fabricated) {
      // Guarded on the SAME identity's real answer so a late failure arm cannot
      // install a fabricated window over a real answer a concurrent call already
      // cached (PR review). Benign either way — the cached branch is read first —
      // but the invariant should be enforced rather than accidental.
      if (!cachedAccountIdentities.has(identityKey)) {
        fabricatedAccountIdentities.set(identityKey, {
          identity: fallback,
          expiresAt: accountInfoClock.now() + FABRICATED_ACCOUNT_INFO_TTL_MS,
        });
      }
    } else {
      cachedAccountIdentities.set(identityKey, fallback);
      fabricatedAccountIdentities.delete(identityKey);
    }
    return fallback;
  }
}

/**
 * Is a STORED `''` for this attribute a value the resource can never have —
 * so the flat lookup must read it as ABSENT and let the live arm run?
 *
 * Exactly one attribute qualifies today (issue #3097 review): an
 * `AWS::EC2::SecurityGroup`'s `VpcId`. Every security group lives in a VPC
 * (EC2-Classic retired 2022-08-15), so `''` can only be the pre-#3097
 * provider's copy of a template that declared no `VpcId` — and that record is
 * rewritten only by an `update()`, which a no-change deploy never issues, so
 * without this carve-out the stored `''` shadows the live arm for the life of
 * the record. The record itself stays `''` until the next update; only the
 * RESOLUTION changes.
 *
 * Deliberately NOT a general "`''` means absent" rule: #3077 records a settled
 * EC2 instance's missing public address as the KNOWN empty `''`
 * (CloudFormation's own answer), and that one must keep being served from
 * state rather than sent back to `DescribeInstances` on every resolution.
 * A new entry here needs the same argument — that `''` is IMPOSSIBLE for the
 * attribute, not merely unlikely.
 */
export function isImpossibleEmptyStoredAttribute(
  resourceType: string,
  attributeName: string,
  storedValue: unknown
): boolean {
  return (
    storedValue === '' && resourceType === 'AWS::EC2::SecurityGroup' && attributeName === 'VpcId'
  );
}

/**
 * Reset cached account info (useful for testing)
 */
export function resetAccountInfoCache(): void {
  cachedAccountIdentities.clear();
  // The bounded fabricated-answer window is part of the same cache and must
  // clear with it, or a test (or a later phase) would keep reading a fabricated
  // answer it just asked to forget.
  fabricatedAccountIdentities.clear();
  // Invalidate any lookup already in flight so its resolve cannot write the
  // caches this call just cleared.
  accountInfoGeneration += 1;
  // ...and so is the in-flight promise: a reset while a lookup is pending would
  // otherwise hand the next caller the identity this call asked to forget, and
  // the resolve arm would re-populate the cache AFTER the reset.
  accountInfoInFlight.clear();
  // Also reset AZ cache
  cachedAvailabilityZones.clear();
  // Resolved dynamic-reference VALUES are no longer cleared here: they live on
  // the resolver instance (issue #1933), so their lifetime already ends with
  // the stack / region context that chose the AWS clients behind the lookup.
  // The secret verdicts below are still process-global, hence still cleared
  // (issues #1901 / #1916) — keeping them would let a stale verdict decide
  // secret-ness for a reference this call just asked to forget.
  recordedSecretExpressions.clear();
  // Issue #2274's in-run recovery store shares this lifetime for the same
  // reason: it holds PLAINTEXT this process masked out of a producer's outputs,
  // and a test (or a later phase) that asks to forget the account's caches must
  // not keep serving a value from a run it just discarded.
  clearRecoverableMaskedOutputs();
  // The issue #2059 cross-stack associations are deliberately NOT cleared here,
  // and need no clearing at all: they are scoped to the resolution pass's own
  // `recordedSecretValues` bag through a `WeakMap`, so they die with it. A
  // module-level store cleared from here was the first shape, and is what let
  // one stack's expression be certified onto another stack's leaf.
  // Also reset the live-read attribute caches (EC2 instance, VPC default
  // security group, CloudFront domain name — issue #3096; security group VPC
  // — issue #3097).
  for (const key of Object.keys(cachedEc2InstanceAttributes)) {
    delete cachedEc2InstanceAttributes[key];
  }
  for (const key of Object.keys(cachedVpcDefaultSecurityGroups)) {
    delete cachedVpcDefaultSecurityGroups[key];
  }
  for (const key of Object.keys(cachedCloudFrontDomainNames)) {
    delete cachedCloudFrontDomainNames[key];
  }
  for (const key of Object.keys(cachedSecurityGroupVpcIds)) {
    delete cachedSecurityGroupVpcIds[key];
  }
}

/**
 * Does a constructed `Fn::GetAtt` answer embed the placeholder account id?
 *
 * The guard in `constructGuardedAttribute` used to test
 * `typeof value === 'string'` directly (issue #1746). Every account-bearing
 * branch of `constructAttribute` returns a string today — the only non-string
 * returns are the EC2 IPv6 CIDR LISTS, which carry no account — so that was
 * complete as written, but a future list-valued attribute embedding an account
 * would have slipped past silently with no test failing. Walking string arrays
 * (one level, which is the shape `constructAttribute` actually produces) closes
 * it now rather than at the moment someone adds one. A non-string, non-array
 * value is not account-bearing by construction and is left alone.
 *
 * EXPORTED for its own test: no `constructAttribute` branch returns an
 * account-bearing array today, so the array arm is unreachable through the
 * public resolver API and would ship unexercised otherwise.
 */
export function embedsAccountId(value: unknown, accountId: string): boolean {
  if (typeof value === 'string') return value.includes(accountId);
  if (Array.isArray(value)) {
    return value.some((entry) => typeof entry === 'string' && entry.includes(accountId));
  }
  return false;
}

/**
 * Collect every name referenced (Ref / Fn::Sub placeholder / other intrinsic
 * argument) by the sections cdkd actually evaluates: Resources, Outputs, and
 * Conditions. Deliberately excludes `Rules` (assertion-only, never evaluated
 * by cdkd — CloudFormation evaluates them pre-deployment, cdkd has no
 * equivalent gate) and `Metadata`. Used to avoid resolving template
 * parameters nothing consumes.
 */
export function collectReferencedParameterNames(template: CloudFormationTemplate): Set<string> {
  const parser = new TemplateParser();
  const referenced = new Set<string>();
  for (const section of [template.Resources, template.Outputs, template.Conditions]) {
    if (!section || typeof section !== 'object') continue;
    for (const name of parser.extractReferences(section)) {
      referenced.add(name);
    }
  }
  return referenced;
}

/**
 * CloudFormation Parameter definition
 */
export interface ParameterDefinition {
  Type: string;
  Default?: unknown;
  AllowedValues?: unknown[];
  AllowedPattern?: string;
  MinLength?: number;
  MaxLength?: number;
  MinValue?: number;
  MaxValue?: number;
  Description?: string;
  ConstraintDescription?: string;
  NoEcho?: boolean;
}

/**
 * Is `name` a template Parameter this caller has left UNBOUND — declared, with
 * no `Default`, and with no value supplied?
 * (issue [#2285](https://github.com/go-to-k/cdkd/issues/2285))
 *
 * ONE predicate, consulted VERBATIM by the two sites that ask this same
 * question, rather than two spellings that agree until they do not:
 *
 *  - {@link IntrinsicFunctionResolver.resolveParameters} raises
 *    `Parameter <name> is required ...` for exactly this population. It is the
 *    UPFRONT validation, and it runs on every path that binds parameters at
 *    all (`deploy-engine`'s step 2.5, `diff-recursive`, `scrub`, `import`), so
 *    a plain `cdkd deploy` never reaches the resolver with this population at
 *    all -- it has already failed.
 *  - {@link IntrinsicFunctionResolver.subPlaceholderNamesADeclaredTemplateEntity}
 *    answers for the callers that CATCH that error and resolve anyway.
 *    `cdkd import` is the live one -- EVERY mode of it, not only
 *    `--migrate-from-cloudformation`: `resolveImportedProperties` sits on
 *    `importCommand`'s unconditional flow, so auto / selective / hybrid all
 *    reach it. It logs the parameter-resolution failure, RETRIES over the
 *    template's `Default`-carrying parameters alone (issue
 *    [#2321](https://github.com/go-to-k/cdkd/issues/2321)), and resolves
 *    against that partial bag on a context that is NOT `bestEffort`. The
 *    retry binds every parameter it can, and a parameter with no `Default` is
 *    exactly what it cannot bind -- so this population still arrives here,
 *    and a `${Tier}` over such a parameter used to be written verbatim into
 *    the imported resource's persisted properties, and from there into the
 *    next deploy's desired bag, which is how the literal reaches AWS.
 *    (The fixtures spell that parameter `Stage`; this doc says `Tier` because
 *    `import.ts`'s own #2321 comments use `Stage` for the opposite role -- the
 *    parameter that DOES carry a `Default` -- and one name for both roles in
 *    one change is how a reader mis-reads which population is which.)
 *    Before #2321 that caller continued with an EMPTY bag instead; the note
 *    below turns on the difference, and on what survives it.
 *
 * A key PRESENT with an `undefined` value is not a binding: `resolveParameters`
 * falls through such a key to the `Default` check, so the predicate must too.
 * That single edge is the reason this is shared code and not a paraphrase.
 *
 * A `Default`-carrying parameter the caller never merged is DELIBERATELY not
 * in this population, and issue
 * [#2321](https://github.com/go-to-k/cdkd/issues/2321) NARROWED the population
 * that reaches here without emptying it. Both halves matter, and an earlier
 * revision of this paragraph shipped only the first, claiming the exclusion
 * "describes a population that no live path produces". That was FALSE, and the
 * counter-example is in the very change that prompted the rewrite.
 *
 * What #2321 fixed is `import`'s retry SUCCESS path. `resolveParameters`
 * merges every `Default` it sees on the path that succeeds; `import` is the
 * one caller that catches its throw on a non-`bestEffort` context, and it now
 * retries over exactly the `Default`-carrying parameters instead of continuing
 * with an empty bag, so a `Default`-carrying parameter reaching the refusing
 * site from THAT path arrives BOUND. (`diff-recursive` and `scrub` also catch,
 * but both set `bestEffort: true` and `rethrowStructuralSubFailure` returns on
 * that flag BEFORE consulting this predicate, so neither reaches the refusing
 * site at all; `deploy-engine` does not catch.)
 *
 * What SURVIVES is `import`'s retry FAILURE path, and it is a live producer,
 * not a hypothetical one. When the `Default`-only retry itself throws -- an
 * SSM-typed default whose `GetParameter` is rejected is the reachable case --
 * `resolveImportedProperties` falls back to an empty bag rather than aborting
 * an import that already succeeded against AWS, and `import.ts` omits the
 * `parameters` key entirely when the bag is empty, so the context arrives with
 * `parameters: undefined`. A `Default`-carrying parameter is then unbound at
 * the refusing site, and this exclusion is the ONLY thing standing between it
 * and a refusal.
 *
 * So the clause below is PRESENT-TENSE LOAD-BEARING, not a courtesy kept for
 * some future caller: that fallback path exists right now, and the clause is
 * what keeps a `Default`-carrying parameter off the refusing site on it.
 * What removing the clause would DO downstream is deliberately not asserted
 * here -- it was not probed, and the residual note below is what carries the
 * observable consequence. It is also what
 * {@link IntrinsicFunctionResolver.subPlaceholderNamesADeclaredTemplateEntity}
 * cross-references.
 *
 * The cost of that fallback is that the #2321 defect persists on it -- the
 * placeholder is kept and written verbatim -- which is a KNOWN residual rather
 * than an oversight; `import.ts` records it at the fallback, and
 * `tests/unit/cli/import.test.ts` pins it so the residual cannot widen
 * silently.
 */
export function isUnboundTemplateParameter(
  name: string,
  template: CloudFormationTemplate | undefined,
  boundParameters: Record<string, unknown> | undefined
): boolean {
  const declaredParameters = template?.Parameters;
  if (
    declaredParameters === undefined ||
    declaredParameters === null ||
    typeof declaredParameters !== 'object'
  ) {
    return false;
  }
  if (!Object.hasOwn(declaredParameters, name)) return false;
  const definition = declaredParameters[name] as ParameterDefinition | undefined;
  if (definition === undefined || definition === null || typeof definition !== 'object') {
    return false;
  }
  if ('Default' in definition) return false;
  if (boundParameters === undefined) return true;
  // `Object.hasOwn` to match the declared-side test above (issue #2767):
  // a bare `in` read a parameter named `constructor` as BOUND, suppressing
  // the #2285 refusal for exactly the shape it exists to catch.
  return !Object.hasOwn(boundParameters, name) || boundParameters[name] === undefined;
}

/**
 * Does coercing to `type` risk destroying the plaintext cdkd redacts against?
 *
 * DERIVED from {@link coerceParameterTypedValue}, never enumerated beside it.
 * The previous shape was a hand-kept set naming `Number` / `List<Number>`,
 * whose doc cleared `CommaDelimitedList` as safe because it "produces an array
 * of strings (both of which the recording scan and the redactor handle)". That
 * holds only for a comma-FREE secret -- and the dominant Secrets Manager shape
 * is a JSON blob, which is nothing but commas, so `,`-splitting shreds the
 * plaintext into fragments matching neither arm of
 * {@link inheritedSecretsCarriedBy}. An audited allow-list was wrong about one
 * of its own three entries, which is why this is now measured, not listed.
 *
 * Probe the REAL coercion with a canary carrying the separators the arms use --
 * a comma and surrounding whitespace -- and call the type risky when the canary
 * does not survive as one string. A `Type` added to the switch is covered the
 * day it is added, with nothing to keep in sync.
 *
 * The DEPLOY path does better: `refuseCoercedInheritedSecret` measures the loss
 * on the ACTUAL value, so a comma-free secret in a `CommaDelimitedList` still
 * works. This coarser predicate is for `cdkd diff`, which holds no secrets bag
 * and therefore cannot measure.
 */
export const SECRET_IDENTITY_CANARY = 'a, b';

export function parameterTypeMayLoseSecretIdentity(type: string): boolean {
  return coerceParameterTypedValue(SECRET_IDENTITY_CANARY, type) !== SECRET_IDENTITY_CANARY;
}

/**
 * ONE definition of parameter-type coercion, at module scope so
 * {@link parameterTypeMayLoseSecretIdentity} probes the same code the resolver
 * runs rather than a copy of it.
 *
 * WHICH TYPES ARE LISTS is asked of the SHARED {@link isListParameterType}
 * rather than enumerated in the `switch` (issue #2347). The `switch` named only
 * `List<Number>` and `CommaDelimitedList`, so the nine `List<AWS::...>` types
 * CloudFormation defines -- `List<AWS::EC2::Subnet::Id>` and its siblings --
 * fell to `default` and a `Ref` to such a parameter resolved to the raw
 * comma-joined STRING, while `src/synthesis/macro-expander.ts` held the wider,
 * correct view of the very same question. Both sites now read one predicate.
 *
 * `List<Number>` keeps its own arm because it is the only list type whose
 * ELEMENTS are not strings; every other list type produces trimmed strings,
 * which is what CloudFormation says a `Ref` to one returns.
 */
export function coerceParameterTypedValue(value: string, type: string): unknown {
  switch (type) {
    case 'Number':
      return Number(value);
    case 'List<Number>':
      return value.split(',').map((v) => Number(v.trim()));
  }
  // `CommaDelimitedList` and the `List<...>` family. CloudFormation space-trims
  // each member of a comma-delimited value, so `.trim()` is the wire semantics,
  // not a convenience.
  if (isListParameterType(type)) {
    return value.split(',').map((v) => v.trim());
  }
  // `String`, the AWS-specific SCALAR types, the whole
  // `AWS::SSM::Parameter::Value<...>` family (whose value is a Parameter Store
  // KEY, not the resolved list), and any unrecognised spelling.
  return value;
}

/**
 * Bind a template-declared `Default` the way the USER-SUPPLIED path binds a
 * value (issue
 * [#2367](https://github.com/go-to-k/cdkd/issues/2367)).
 *
 * `resolveParameters` writes `parameters[name]` at three sites and only the
 * user-supplied one asked the coercion anything, so a parameter declared
 * `Type: CommaDelimitedList` with `Default: "a,b,c"` and no CLI override
 * reached every consumer as the raw string -- `Fn::Select` over it threw
 * `Fn::Select: list must be an array, got string`, and a bare `Ref` handed the
 * provider a comma-joined scalar where the resource schema declares a list.
 * The defect predates the #2347 widening: it hits `CommaDelimitedList` and
 * `List<Number>`, the two list types the `switch` has recognised all along.
 *
 * CloudFormation's own documentation is written in exactly these terms --
 * `parameters-section-structure.html`'s worked example declares
 * `VpcAzs: {Type: CommaDelimitedList, Default: "us-west-2a, us-west-2b,
 * us-west-2c"}` and then reads it with `Fn::Select`, which is the case that
 * threw.
 *
 * ONLY A STRING IS COERCED, and that is the whole of the rule. `Default` is
 * typed `unknown` because it is whatever the template parser produced, and the
 * shapes are not hypothetical -- measured 2026-08-29 on both parsers cdkd
 * feeds this from:
 *
 *  - `aws-cdk-lib`'s `CfnParameter._toCloudFormation` emits `Default:
 *    this.default` with no conversion, so `{type: 'Number', default: 42}`
 *    synthesizes the JSON NUMBER `42`, and `{type: 'CommaDelimitedList',
 *    default: ['a','b','c']}` synthesizes a JSON ARRAY;
 *  - `parseCfnTemplate` (`src/cli/yaml-cfn.ts`), on the `cdkd import
 *    --migrate-from-cloudformation` / `cdkd export` path, resolves `Default:
 *    42` to a number, `Default: "42"` to a string, a YAML sequence to an array
 *    and `Default: true` to a boolean.
 *
 * FOR THE SHAPES MEASURED ABOVE, a non-string default is already what the
 * declared type calls for -- `42` for a `Number`, `['a','b']` for a
 * `CommaDelimitedList` -- so coercing it could only damage it.
 * `String(['a,b','c'])` is `'a,b,c'`, which the split would then shred into
 * THREE elements, and `String(true)` would turn a boolean a consumer sees today
 * into text. Stringifying first is therefore not a harmless normalization, and
 * `coerceParameterTypedValue` takes a `string` precisely because parsing the
 * wire text is its whole job.
 *
 * THE CLAIM IS SCOPED TO THOSE SHAPES ON PURPOSE, because a mismatched pairing
 * is reachable and is NOT in it: YAML admits `Type: CommaDelimitedList` with
 * `Default: 42` or `Default: true`, and such a default is passed through as the
 * scalar it parsed to rather than becoming a one-element list. That is the
 * PRE-EXISTING behaviour, unchanged here and deliberately so -- a template
 * pairing a list type with a scalar default is malformed CloudFormation, and
 * inventing a coercion for it on a path that writes state is a bigger decision
 * than this fix.
 */
export function coerceParameterDefault(defaultValue: unknown, type: string): unknown {
  if (typeof defaultValue !== 'string') return defaultValue;
  return coerceParameterTypedValue(defaultValue, type);
}

/**
 * The inherited `plaintext -> expression` pairs that `value` CARRIES.
 *
 * ONE definition, shared by the RECORDING side
 * (`recordInheritedParameterSecrets`) and the REFUSAL side
 * (`refuseCoercedInheritedSecret`), because a refusal narrower than the
 * recording would let exactly the values it exists to catch through — and the
 * two drifting apart is how this class of bug reappears.
 *
 * TWO ARMS, mirroring the two `redactSecretsForState` performs, so the
 * recording side cannot be narrower than the redaction side:
 *
 * - WHOLE VALUE at any length — `{Ref: Param}` returning exactly the secret.
 * - SUBSTRING at or above {@link MIN_NEEDLE_LENGTH} — the parent built the
 *   parameter with an `Fn::Sub`, so the value is `postgres://u:<secret>@host`
 *   and only part of it is the secret. Short needles are excluded on this arm
 *   for the same reason the redactor excludes them: a 3-character secret
 *   matches half the alphabet's worth of ordinary identifiers.
 *
 * A LIST-TYPED parameter — any `List<...>` type or `CommaDelimitedList` — arrives as an
 * array, so the scan walks string elements too.
 */
export function inheritedSecretsCarriedBy(
  value: unknown,
  inherited: RecordedSecretValues
): Array<[string, string]> {
  const candidates: string[] = [];
  if (typeof value === 'string') {
    candidates.push(value);
  } else if (Array.isArray(value)) {
    for (const element of value) {
      if (typeof element === 'string') candidates.push(element);
    }
  }
  if (candidates.length === 0) return [];

  const carried: Array<[string, string]> = [];
  for (const [plaintext, expression] of inherited) {
    const hit = candidates.some(
      (candidate) =>
        candidate === plaintext ||
        (plaintext.length >= MIN_NEEDLE_LENGTH && candidate.includes(plaintext))
    );
    if (hit) carried.push([plaintext, expression]);
  }
  return carried;
}

/**
 * Render a parameter VALUE for a debug log line, honoring the definition's
 * `NoEcho` flag (issue #1329). `NoEcho: true` is the template author's
 * explicit "this value is sensitive" declaration — CloudFormation masks such
 * values everywhere it echoes them, so cdkd's `--verbose` output must not
 * print them either. Sibling of `stringifyAttributeForLog` (which redacts
 * `Fn::GetAtt` ATTRIBUTE values by name heuristic; here the author told us).
 */
export function stringifyParameterForLog(
  paramDef: ParameterDefinition | undefined,
  value: unknown
): string {
  if (paramDef?.NoEcho === true) return '<redacted>';
  return stringifyValue(value);
}

/**
 * `displayIdent` over text THIS file already sanitized, keeping its rule that
 * an ALTERED value takes a boundary (go-to-k/cdkd#3617). `displayIdent` tests
 * alteration against its own input, which here is already trimmed and blanked
 * -- so `ProdStack ` or `ProdStack<NBSP>` would print bare, byte-identical to
 * a genuine `ProdStack` (the #3164 spoof). Compared against the ORIGINAL, an
 * altered value is quoted even when what is left is plain.
 */
export function boundAltered(original: string, shown: string, maxCodePoints?: number): string {
  const bounded = displayIdent(shown, maxCodePoints === undefined ? undefined : { maxCodePoints });
  return shown !== original && !bounded.startsWith('"') && bounded !== UNRENDERABLE
    ? `${JSON.stringify(bounded.split(' [cut: ')[0])}${bounded.includes(' [cut: ') ? bounded.slice(bounded.indexOf(' [cut: ')) : ''}`
    : bounded;
}

/**
 * A render that may sit inside a quote of cdkd's own: the characters of
 * `displayIdent`'s plain identifier, plus `|` and `*` (a masked value prints
 * `***`) and `<` / `>` (a parameter type such as `List<Number>`). All are
 * literal inside either quote, and none is whitespace, so no pasted line,
 * sentence or clause can start or end inside the quoted render. Empty is
 * admitted, so an empty value still prints as `''`.
 */
export const QUOTABLE_RENDER = /^[A-Za-z0-9:_@./+=,~|*<>-]*$/;

/**
 * Whether a masked render may print BARE on a `--verbose` `Resolved …` line
 * (go-to-k/cdkd#4161): it is inert with its quotes stripped
 * (`isInertUnquoted`, the one measured predicate every pasted value is held
 * to, go-to-k/cdkd#4205) and is not a shell assignment word
 * ({@link LOG_ASSIGNMENT}). The mask `***` is the one exception to
 * `isInertUnquoted`: a `*` is a glob, but cdkd's own mask must stay readable,
 * and a glob as a clause's first word is go-to-k/cdkd#4249's class. Anything
 * else is DESCRIBED, never JSON-quoted (the go-to-k/cdkd#4229 decision): a
 * double quote still expands `$( )`, a backtick and `!`, and an unpaired `"`
 * above the selection turns every JSON boundary inside out. Empty is inert.
 */
export function isLogInert(text: string): boolean {
  return !LOG_ASSIGNMENT.test(text) && isInertUnquoted(text.split(SECRET_MASK).join('x'));
}

/**
 * Whether a JSON render may print as it is: it parses, and every key and
 * string leaf is {@link isLogInert}. Under an unpaired `"` above the line the
 * render's quotes flip and its strings come out bare, so each must be inert
 * on its own. Numbers, booleans and `null` are; the structure is not inert
 * (`[` / `]` glob and `{` / `}` brace-expand), but it runs nothing as an
 * argument, and a render as a clause's first word is go-to-k/cdkd#4249's.
 * A mask that ate a structural `"` (a secret spelled `abcd",`) fails the
 * parse and the render is described.
 */
export function isLogInertJson(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  const inert = (node: unknown): boolean => {
    if (typeof node === 'string') return isLogInert(node);
    if (Array.isArray(node)) return node.every(inert);
    if (node !== null && typeof node === 'object') {
      return Object.entries(node).every(([key, child]) => isLogInert(key) && inert(child));
    }
    return true;
  };
  return inert(parsed);
}

/**
 * A render that would be a shell ASSIGNMENT word where it starts a pasted
 * clause (`Resolved Fn::Join: HISTFILE=~/victim`): it runs nothing the paste
 * harness sees, yet an interactive bash then truncates `~/victim` at exit,
 * and `PATH=.` hijacks every later command (go-to-k/cdkd#4243 review). The
 * APPEND form counts too: `PATH+=:.` appends the working directory to the
 * search path (on an unset variable `X+=v` is `X=v`). `isInertUnquoted`
 * admits a mid-word `=`, which is right for a value a command NAMES and wrong
 * for one that can start a pasted clause, so {@link isLogInert} rejects the
 * shape on its own.
 */
export const LOG_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

/** Whether `stringifyValue` renders `value` as JSON (an array or object). */
export function isStructured(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

/**
 * The render inside `quote` when {@link QUOTABLE_RENDER} admits it, otherwise
 * `described` (go-to-k/cdkd#3950).
 *
 * The render is `displayMasked` / `displayLeaf` output, which keeps `'`, `"`,
 * `$`, `(`, a backtick and a space: inside cdkd's hand-written quote, a quote
 * in the value closed it, `$( )` runs inside double quotes anyway, and the
 * rest of a pasted sentence ran as shell. The test is on the RENDER, the text
 * that is printed, so the mask is kept: a masked `***` still prints quoted,
 * and nothing here reads the unmasked value.
 */
export function quotedRender(
  rendered: string,
  quote: "'" | '"',
  described = '(not shown: it is not a plain identifier)'
): string {
  return QUOTABLE_RENDER.test(rendered) ? `${quote}${rendered}${quote}` : described;
}
