/**
 * CloudFormation template structure
 */
export interface CloudFormationTemplate {
  AWSTemplateFormatVersion?: string;
  Description?: string;
  Parameters?: Record<string, TemplateParameter>;
  Resources: Record<string, TemplateResource>;
  Outputs?: Record<string, TemplateOutput>;
  Conditions?: Record<string, unknown>;
  Mappings?: Record<string, unknown>;
  /**
   * Top-level `Transform` declaration. CloudFormation macros (`Transform:
   * 'AWS::Serverless-2016-10-31'`, `Transform: ['AWS::LanguageExtensions',
   * 'CustomMacro']`, etc.). cdkd detects this at synthesis time and runs a
   * CFn round-trip via `src/synthesis/macro-expander.ts` to obtain the
   * post-expansion template before passing it to the analyzer / provisioner
   * pipeline — see `docs/design/463-cfn-macros.md`. The post-expansion
   * template has this field stripped (CFn does not surface it in the
   * Processed-stage GetTemplate response when every transform expanded).
   */
  Transform?: unknown;
  Rules?: Record<string, unknown>;
}

/**
 * CloudFormation template parameter
 */
export interface TemplateParameter {
  Type: string;
  Default?: unknown;
  Description?: string;
  AllowedValues?: unknown[];
  AllowedPattern?: string;
  ConstraintDescription?: string;
  /**
   * CFn's "this value is sensitive" declaration — masked in every place
   * CloudFormation echoes the value. cdkd honors it by redacting the value
   * in `--verbose` debug logs (issue #1329).
   */
  NoEcho?: boolean;
}

/**
 * CloudFormation template resource
 */
export interface TemplateResource {
  Type: string;
  Properties?: Record<string, unknown>;
  DependsOn?: string | readonly string[];
  Condition?: string;
  Metadata?: Record<string, unknown>;
  CreationPolicy?: Record<string, unknown>;
  UpdatePolicy?: Record<string, unknown>;
  DeletionPolicy?: 'Delete' | 'Retain' | 'Snapshot';
  UpdateReplacePolicy?: 'Delete' | 'Retain' | 'Snapshot';
}

/**
 * CloudFormation template output
 */
export interface TemplateOutput {
  Value: unknown;
  Description?: string;
  /**
   * Name of a template `Conditions` entry gating this output. CFn only
   * creates the output when the condition evaluates true; the deploy
   * engine's `resolveOutputs` mirrors that by skipping condition-false
   * outputs (issue #1028).
   */
  Condition?: string;
  Export?: {
    Name: string;
  };
}

/**
 * The properties a provider ACTUALLY delivered to AWS, when they differ from
 * the desired bag it was handed (issue #1591).
 *
 * The deploy engine persists the DESIRED properties into cdkd state. That is
 * right almost always — but a provider that deliberately NARROWS the bag makes
 * the record describe something AWS never holds, and `readCurrentState` can
 * only ever return what AWS does hold, so the difference becomes PERMANENT
 * phantom drift: `cdkd drift` reports it on every run and `drift --revert`
 * "fixes" it by calling `update()` again, which re-narrows and re-reports.
 * That is the #1552 junk-state class, and it is the provider — not the
 * engine — that knows what was dropped.
 *
 * Returning this field lets the provider hand back the bag it actually sent,
 * which the engine records INSTEAD of the desired one. Absent (the normal
 * case) means "record the desired properties", so no provider needs to change.
 *
 * Two things this is NOT:
 *
 * - It is not a place to report AWS-side defaults or computed values. Those
 *   belong in `observedProperties` (captured by a real read-back); putting
 *   them here would make the DESIRED baseline drift away from the template and
 *   silently disable the #1160 absent-field removal derivation, which reads
 *   the previous side.
 * - It is not a licence to drop a value the provider merely failed to send.
 *   Narrowing must already be a deliberate, ANNOUNCED decision (a warn arm),
 *   or recording it hides the loss instead of surfacing it.
 */
export interface EffectivePropertiesResult {
  /**
   * The properties actually delivered. Recorded verbatim in place of the
   * desired bag, so it must be a COMPLETE replacement, not a patch.
   */
  effectiveProperties?: Record<string, unknown>;
}

/**
 * Resource creation result
 */
export interface ResourceCreateResult extends EffectivePropertiesResult {
  /** Physical resource ID */
  physicalId: string;
  /** Resource attributes for Fn::GetAtt resolution */
  attributes?: Record<string, unknown>;
}

/**
 * Resource update result
 */
export interface ResourceUpdateResult extends EffectivePropertiesResult {
  /** Physical resource ID (may be different if resource was replaced) */
  physicalId: string;
  /** Whether the resource was replaced (new physical ID) */
  wasReplaced: boolean;
  /** Updated resource attributes */
  attributes?: Record<string, unknown>;
}

/**
 * Input passed to a provider's `import` method.
 *
 * Carries everything a provider needs to find an existing AWS resource that
 * corresponds to a logicalId in the user's CDK template:
 * - the logicalId itself (sometimes embedded in physical names),
 * - the resource's CDK path (`aws:cdk:path` tag) for tag-based lookup,
 * - the parent stack name and AWS region,
 * - the template properties (often contain explicit names like `BucketName`
 *   that bypass the tag lookup entirely).
 */
export interface ResourceImportInput {
  /** Logical ID from the CDK template (e.g., `MyBucket`). */
  logicalId: string;

  /** CloudFormation resource type (e.g., `AWS::S3::Bucket`). */
  resourceType: string;

  /** Physical CloudFormation stack name (used for naming-pattern fallback). */
  stackName: string;

  /** AWS region the resource lives in. */
  region: string;

  /** Properties from the template (resolved as far as possible). */
  properties: Record<string, unknown>;

  /**
   * Caller-supplied physical id, e.g. via `--resource MyBucket=my-bucket` or
   * `--resource-mapping`. When set, the provider should treat it as ground
   * truth: verify the resource exists and fetch attributes, but do NOT
   * search. When `undefined`, the provider performs its own lookup
   * (tag-based, name-based, etc.).
   */
  knownPhysicalId?: string;
}

/**
 * Result returned by a provider's `import` method.
 *
 * `null` from the provider means "no matching resource found in AWS" — the
 * caller (state-import command) marks it as skipped, not as a failure, since
 * the user's template might reference resources that have not been deployed.
 */
export interface ResourceImportResult {
  /** Physical resource ID. */
  physicalId: string;
  /** Resource attributes for `Fn::GetAtt` resolution (same shape as `create` returns). */
  attributes?: Record<string, unknown>;
}

/**
 * Context passed to a provider's `create` method (issue #1463).
 *
 * The sibling of {@link DeleteContext}: optional, so a provider that does not
 * care about it needs no change, and absent means "assume the historical
 * behavior". Unlike `DeleteContext` — which lives in
 * `src/provisioning/region-check.ts` because its `expectedRegion` feeds that
 * module's `assertRegionMatch` helper — this type has no region-checking role,
 * so it is defined here next to the `ResourceProvider` interface that consumes
 * it.
 *
 * It exists for ONE question a provider's `create()` could not previously
 * answer: is this call provisioning from the user's TEMPLATE, or replaying a
 * historical cdkd STATE record?
 */
export interface CreateContext {
  /**
   * `true` when the properties handed to `create()` come from a cdkd STATE
   * record rather than from the synthesized template — today that is the
   * rollback executor's REVERSE-REPLACEMENT arm, which revives the OLD
   * physical resource from `previousState.properties` (issue #1199).
   *
   * **What a provider MAY conclude from it.** That the user has no
   * template-side remedy for whatever the properties contain. A state record
   * was written by some earlier cdkd build against some earlier AWS API, and
   * the only way a user could edit it is by hand-editing `state.json`. So a
   * PRE-FLIGHT REFUSAL (see `docs/provider-development.md` §1a) must downgrade
   * to a WARNING here: refusing would leave the old resource unrestorable with
   * no action the user can take. This is the create-side twin of the
   * refuse-on-template / warn-on-replay asymmetry `update()` already has — the
   * update path is a replay path unconditionally, whereas `create()` is one
   * only when this flag is set.
   *
   * **What a provider MUST NOT conclude from it.** Nothing about the
   * properties' CONTENT: they are neither more nor less trustworthy than
   * template properties, are NOT pre-resolved differently, and carry no
   * guarantee of being a superset or subset of what the template would say.
   * It is also not a "best effort" or "dry run" signal — the create must still
   * either produce a real resource or throw. Validation that protects the AWS
   * call itself (a required field is missing, a physical id is malformed)
   * stays a hard error: warning past it would just move the failure later.
   * And it says nothing about WHY the rollback is happening, so it must not be
   * used to relax data-safety guards.
   *
   * Absent / `false` = an ordinary template-path create (`cdkd deploy`, the
   * replacement create, the `--replace` / `--recreate-via-*` re-creates), where
   * a refusal IS the right behavior because the user can edit the template.
   *
   * **Constraint this places on providers.** A provider that re-creates inside
   * its own `update()` (`this.create(logicalId, resourceType, properties)` —
   * ACM certificate, IAM managed policy, IAM role, Lambda permission, SNS
   * subscription today) CANNOT receive a context: `update()` has no context
   * parameter to thread, and during a rollback replay the `properties` it
   * forwards ARE a state record. So a provider with a create-side pre-flight
   * refusal MUST NOT re-create inside `update()` — the refusal would fire on a
   * replay with no way to detect it. None of the five listed above has such a
   * refusal (they validate required fields only, which stays a hard error by
   * the rule above).
   *
   * `EC2Provider` DOES have both since issue #1566, via the private
   * `createRoute` rather than `this.create`, and shows the shape that satisfies
   * the constraint: the refusal sits behind a CALLBACK parameter which
   * `updateRoute` passes UNCONDITIONALLY, so the re-create can never fire it.
   * Note the callback covers only that one guard — `createRoute`'s
   * required-field check is still a hard error on the post-delete path — so the
   * safe pattern is "downgrade the refusal", never "assume `update()` is
   * throw-free". See `.claude/rules/providers.md` for the full write-up.
   */
  replayingState?: boolean;
}

/**
 * Context passed to a provider's `delete` method.
 *
 * Re-exported from `src/provisioning/region-check.ts` so that callers
 * implementing the provider interface only need to import from
 * `src/types/resource.ts`.
 */
export type { DeleteContext } from '../provisioning/region-check.js';
import type { DeleteContext } from '../provisioning/region-check.js';

/**
 * Cross-resource context passed to `ResourceProvider.readCurrentState`
 * for providers that need to inspect sibling resources in the same
 * stack to decide what counts as drift.
 *
 * Issue #323: `IAMRoleProvider` / `IAMUserGroupProvider`'s
 * `readCurrentState` call `iam:ListRolePolicies` / `ListUserPolicies` /
 * `ListGroupPolicies` to surface inline policies. CDK's pattern for
 * `iam.Policy({ roles: [r] })` (or `users` / `groups`) calls
 * `iam:PutRolePolicy` under the hood, so those policies show up in the
 * `List*Policies` output — but they are managed by the sibling
 * `AWS::IAM::Policy` resource, not the role/user/group itself. Without
 * filtering them out, every Role/User/Group whose CDK code uses
 * `addToPolicy` / `grantRead` / `ContainerImage.fromEcrRepository`
 * fires false drift on every `cdkd drift` run.
 *
 * The context carries the same-stack siblings (excluding the resource
 * being read) so the IAM providers can match `ListRolePolicies` output
 * against `AWS::IAM::Policy.Properties.PolicyName` + the policy's
 * `Roles` / `Users` / `Groups` list.
 *
 * Most providers ignore the context — only IAM cross-attachment cases
 * require it.
 */
export interface ReadCurrentStateContext {
  /**
   * All resources in the same stack EXCEPT the one being read.
   * Keyed by logicalId. `resourceType`, `physicalId`, `properties`, and
   * `attributes` come from cdkd state (`ResourceState`); `properties` may
   * carry intrinsics unresolved for resources written by older binaries —
   * providers that consume this should match by literal values only.
   * `attributes` carries the deploy-time-resolved `Fn::GetAtt` values (e.g.
   * a CloudFront OAI's `S3CanonicalUserId`), so a provider can reconcile a
   * sibling's computed identity without an extra AWS call.
   */
  siblings?: Record<
    string,
    {
      resourceType: string;
      physicalId?: string;
      properties: Record<string, unknown>;
      attributes?: Record<string, unknown>;
    }
  >;
}

/**
 * Resource provider interface
 */
export interface ResourceProvider {
  /**
   * Map of resource type → set of CloudFormation property names handled in create/update.
   * When defined for a resource type, if a template contains properties NOT in the set
   * and the resource type is supported by Cloud Control API, the deploy engine will fall
   * back to CC API for create/update operations to ensure all properties are applied.
   *
   * If undefined or the resource type is not in the map, the provider is assumed to
   * handle ALL properties (no safety net).
   * DELETE always uses the SDK provider regardless of this setting.
   */
  handledProperties?: ReadonlyMap<string, ReadonlySet<string>>;

  /**
   * Map of resource type → map of CFn property name → one-line rationale for
   * why this provider intentionally does NOT wire the property through to the
   * SDK call.
   *
   * Consumed by the development-time coverage check
   * (`tests/unit/provisioning/property-coverage.test.ts`) — every CFn schema
   * property that does not appear in `handledProperties` must EITHER appear
   * here (with a rationale) OR in the per-type backfill TODO fixture, or the
   * test fails. This is the structural prevention layer for the "provider
   * silently dropped property X" bug class.
   *
   * Rationales are free text but should be greppable. Common shapes:
   * - "create-only — AWS rejects on update"
   * - "AWS-managed read-only attribute"
   * - "deprecated — superseded by Y"
   * - "tags handled via per-resource Tag API, not the create input"
   * - "covered by separate AWS::Foo::Bar resource type"
   *
   * Properties listed here do NOT trigger the deploy engine's CC API fallback
   * (this field is a development-time annotation, not runtime behavior).
   */
  unhandledByDesign?: ReadonlyMap<string, ReadonlyMap<string, string>>;

  /**
   * If true, the provider refuses CC API fallback for create/update.
   * When unhandled properties are detected, the deploy engine will throw an error
   * instead of falling back to CC API.
   *
   * Use this for providers that exist because CC API has known issues with this
   * resource type (e.g., bugs, incorrect behavior, missing features).
   */
  disableCcApiFallback?: boolean;

  /**
   * If true, the deploy engine MUST NOT wrap the provider's `create` /
   * `update` / `delete` calls in its outer transient-error retry loop
   * (`withRetry` from `src/deployment/retry.ts`).
   *
   * The retry loop generates fresh state for each attempt — for the
   * Custom Resource provider, that means a new pre-signed S3 URL and a
   * new RequestId. The first attempt's Lambda response then lands at
   * an S3 key that nobody polls, hanging the deploy until the polling
   * timeout. Providers that prepare per-call invariant state in a way
   * that an outer retry would invalidate must opt out via this flag and
   * implement their own retry strategy internally.
   *
   * When unset, the deploy engine retries transient SDK errors (IAM
   * propagation, HTTP 429/503, etc.) as it always has.
   */
  disableOuterRetry?: boolean;

  /**
   * Self-reported minimum wall-clock timeout (ms) the provider needs in
   * order to complete `create` / `update` / `delete` against AWS in the
   * worst case.
   *
   * When set, the deploy engine resolves the effective per-resource
   * timeout as:
   *   `perTypeCliOverride ?? max(getMinResourceTimeoutMs(), globalCliDefault)`
   *
   * This lets long-running providers (Custom Resources poll for up to
   * 1 hour, mirroring CDK's default `totalTimeout`) lift the timeout
   * for their resources without forcing every user to remember
   * `--resource-timeout 1h`. A user-supplied per-type override always
   * wins over the self-report (`--resource-timeout AWS::CloudFormation::CustomResource=5m`
   * is the explicit escape hatch).
   */
  getMinResourceTimeoutMs?(): number;
  /**
   * Optional: Pre-process properties before CC API fallback.
   * Called when the safety net falls back to CC API for create/update, allowing
   * the SDK provider to apply custom transformations (e.g., default name generation)
   * so that CC API receives the same defaults the SDK provider would have applied.
   *
   * If not implemented, properties are passed to CC API as-is.
   */
  preparePropertiesForFallback?(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Record<string, unknown>;

  /**
   * Create a new resource
   * @param logicalId Logical ID from template
   * @param resourceType CloudFormation resource type (e.g., "AWS::S3::Bucket")
   * @param properties Resource properties
   * @param context Create-time context (optional, for back-compat). Today it
   *   carries only `replayingState`, set by the rollback executor's
   *   reverse-replacement arm when `properties` come from a historical cdkd
   *   STATE record instead of the template — a provider PRE-FLIGHT REFUSAL
   *   must downgrade to a warning in that case, because the user has no
   *   template-side remedy (issue #1463). See `CreateContext` in
   *   this file for the full contract, and `docs/provider-development.md` §1a
   *   for when a refusal is allowed at all.
   * @returns Physical resource ID and attributes
   */
  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult>;

  /**
   * Update an existing resource
   * @param logicalId Logical ID from template
   * @param physicalId Current physical resource ID
   * @param resourceType CloudFormation resource type
   * @param properties Updated properties
   * @param previousProperties Previous properties (for comparison)
   * @returns Updated physical ID and attributes
   */
  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult>;

  /**
   * Delete a resource
   * @param logicalId Logical ID from template
   * @param physicalId Physical resource ID
   * @param resourceType CloudFormation resource type
   * @param properties Resource properties (optional, for providers that need them)
   * @param context Delete-time context (optional, for back-compat). Contains
   *   `expectedRegion` from the stack state so providers can refuse to treat
   *   `NotFound` as idempotent success when the AWS client's region does not
   *   match the region the resource was deployed to. See
   *   `src/provisioning/region-check.ts` for the shared verification helper.
   */
  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void>;

  /**
   * Get resource attributes (for Fn::GetAtt resolution)
   * @param physicalId Physical resource ID
   * @param resourceType CloudFormation resource type
   * @param attributeName Attribute name
   * @returns Attribute value
   */
  getAttribute?(physicalId: string, resourceType: string, attributeName: string): Promise<unknown>;

  /**
   * Read the **currently-deployed** properties of an existing resource as
   * seen by AWS, scoped to the property set this provider manages
   * (`handledProperties`-equivalent). The returned object is suitable for
   * direct comparison against the `properties` field in cdkd state.
   *
   * Used by `cdkd drift <stack>` to detect divergence between cdkd state and
   * AWS reality without going through CloudFormation. Implementations should
   * return only the keys cdkd actually manages — the `cdkd drift` comparator
   * already ignores keys not present in state, but returning a tighter set
   * keeps the wire payload smaller.
   *
   * Returns `undefined` when the provider does not yet implement drift
   * detection — the caller falls back to a "drift unknown" outcome for that
   * resource. This mirrors the optional `import` method: providers add
   * support incrementally without forcing a sweep across the whole tree.
   *
   * @param physicalId AWS physical id (e.g. bucket name, function arn)
   * @param logicalId  CloudFormation logical id (helps providers that need
   *                   to disambiguate)
   * @param resourceType  e.g. `AWS::S3::Bucket`
   * @param properties Optional state-recorded properties for this resource.
   *                   Sub-resource providers (whose Describe API needs a
   *                   parent identifier from `Properties` — `RestApiId`,
   *                   `FunctionName`, `Roles[]`, etc.) use this to issue
   *                   the right SDK call. Most providers ignore it
   *                   because the physicalId is self-sufficient.
   * @param context Optional cross-resource context for providers that
   *                   need to inspect sibling resources in the same
   *                   stack — see `ReadCurrentStateContext`. Used by
   *                   `IAMRoleProvider` and `IAMUserGroupProvider` to
   *                   exclude inline policies that are managed by a
   *                   separate `AWS::IAM::Policy` resource (attached
   *                   via `Roles: [role]` / `Users: [u]` / `Groups: [g]`).
   *                   Most providers ignore it.
   * @returns AWS-current properties scoped to the provider's managed set,
   *          or `undefined` when not implemented
   */
  readCurrentState?(
    physicalId: string,
    logicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: ReadCurrentStateContext
  ): Promise<Record<string, unknown> | undefined>;

  /**
   * State property paths this provider deliberately cannot (or chooses
   * not to) read back from AWS. The drift comparator skips these paths
   * before comparing, so they don't fire guaranteed false-positive
   * drift on every run.
   *
   * Example: Lambda's `Code: { S3Bucket, S3Key }` is set on create/update
   * but `GetFunction` only returns a pre-signed URL for the deployed
   * code, never the original asset key — so the provider declares
   * `['Code']` and the comparator treats that key as out-of-scope.
   *
   * Paths use dot-notation for nested keys (e.g. `'VpcConfig.SubnetIds'`).
   *
   * Some paths are unknown only for a SUBSET of a type's resources, decided
   * by the resource's own configuration — API Gateway V2 `TlsConfig` is
   * returned by `GetIntegration` for a private (VPC-Link) integration but
   * silently discarded by AWS for a public one (issue #1602). The optional
   * `properties` argument (the resource's state-recorded desired properties)
   * lets a provider make that call per resource; implementations MUST
   * tolerate it being absent OR EMPTY (callers other than `cdkd drift` may
   * not have a properties bag, and `drift.ts` passes `properties ?? {}`, so
   * `{}` means "nothing recorded" rather than "this key is absent") by
   * falling back to the type-level answer.
   *
   * @param resourceType e.g. `AWS::Lambda::Function`
   * @param properties the resource's state-recorded properties, when the
   *        caller has them (currently only `cdkd drift` passes this)
   * @returns paths to exclude from the drift comparison; defaults to
   *          empty when not implemented
   */
  getDriftUnknownPaths?(resourceType: string, properties?: Record<string, unknown>): string[];

  /**
   * Narrow a property bag the same way this provider narrows what it actually
   * SENDS (issue #1591).
   *
   * Applied by `cdkd deploy` AND `cdkd diff` to **both** comparison sides — the
   * resolved template properties and the state-recorded ones — so it receives a
   * STATE-BORNE bag as often as a template-borne one. It must therefore be
   * IDEMPOTENT (narrowing an already-narrowed bag returns it unchanged) and
   * safe on a historical record it did not produce.
   *
   * Implement it if — and only if — the provider returns
   * {@link EffectivePropertiesResult.effectiveProperties}: the two are halves
   * of one decision. `effectiveProperties` makes STATE describe what AWS holds;
   * this makes the comparison describe the same thing, so the narrowing does
   * not read back as a change the user made. With only the first half, the
   * template's extra keys resurface as a diff on every later deploy — and for a
   * create-only property that is a REPLACEMENT, turning a green no-op deploy
   * into a destroy-and-recreate (or an outright failure, where the provider
   * refuses that shape on the create path).
   *
   * MUST be pure, synchronous, and free of AWS calls — it runs inside the diff.
   * MUST agree with the provisioning-path narrowing key-for-key; share one
   * helper rather than re-deriving the rule, or state and template end up
   * narrowed differently.
   *
   * The diff WARNS whenever this actually changes the desired bag, so the
   * narrowing stays announced even though the provider is never called on that
   * path — do not rely on a provider-side warning to inform the user here.
   *
   * Return the input unchanged when nothing applies (the common case).
   */
  canonicalizeDesiredProperties?(
    resourceType: string,
    properties: Record<string, unknown>
  ): Record<string, unknown>;

  /**
   * State property paths holding an array that is semantically an UNORDERED
   * set — either of plain strings or of OBJECTS (issue
   * [#1620](https://github.com/go-to-k/cdkd/issues/1620)). The drift comparator
   * sorts the array at these paths on BOTH comparison sides before comparing,
   * so an AWS-side reorder does not surface as phantom drift on a resource
   * nobody touched. Object elements are ordered by a key-order-independent
   * canonical serialization, so the sort cannot itself depend on the key order
   * AWS happened to return.
   *
   * Neither shape is order-normalized by default (either can be
   * order-significant), unlike tag lists and AWS id / ARN arrays which the
   * shared normalizer canonicalizes heuristically for every type. This is the
   * per-provider opt-in for the cases that are genuinely unordered. Only a
   * HOMOGENEOUS array is sorted — a mixed or array-valued element list at a
   * declared path is left untouched.
   *
   * Examples: FSx's `WindowsConfiguration.Aliases` (DNS alias names) comes
   * back from `DescribeFileSystems` in an AWS-chosen order; ELBv2's
   * `TargetGroup.Targets` is an object array `DescribeTargetHealth` documents
   * no ordering guarantee for. Note FSx's
   * `...SelfManagedActiveDirectoryConfiguration.DnsIps` is deliberately NOT
   * declared — see the note on that provider's implementation.
   *
   * Declare it HERE rather than sorting inside the provider's `readCurrentState`
   * reverse-mapper: the normalizer runs on both sides, so it stays correct when
   * the baseline is the template `properties` fallback (a resource deployed
   * before observed-capture, whose baseline is the user's template order).
   * Sorting only the read side would manufacture drift on exactly that path.
   *
   * Paths use dot-notation for nested keys and match the same way as
   * {@link getDriftUnknownPaths}: exactly equal, or an entry followed by `.`.
   *
   * @param resourceType e.g. `AWS::FSx::FileSystem`
   * @returns paths whose array (of plain strings or of objects) is unordered;
   *          defaults to empty when not implemented
   */
  getDriftUnorderedPaths?(resourceType: string): string[];

  /**
   * Find an already-deployed AWS resource matching the given logicalId from
   * the CDK template, and return its physical id + attributes so the state
   * file can be reconstructed.
   *
   * Used by `cdkd state import` to recover state after disasters (lost state
   * file, manual deletion, drift between cdkd and AWS) and to adopt
   * AWS-resident resources into cdkd's management.
   *
   * Lookup strategy is provider-specific. Recommended order:
   *   1. If the template's `properties` carries an explicit name field
   *      (`BucketName`, `FunctionName`, `RoleName`, etc.), look up by name —
   *      it's exact and cheap.
   *   2. Otherwise, walk the service's `List*` API and match against the
   *      `aws:cdk:path` tag (every CDK-deployed resource carries one).
   *   3. Last resort: stack-name prefix matching on physical names. Risky;
   *      providers may choose to skip rather than guess.
   *
   * Return `null` if no matching resource is found — the caller treats this
   * as "skipped" (not an error). Throw on AWS errors so the caller can
   * surface them.
   *
   * Optional: providers without an `import` implementation are reported as
   * unsupported by `cdkd state import` and the corresponding logical IDs are
   * skipped with a warning.
   */
  import?(input: ResourceImportInput): Promise<ResourceImportResult | null>;
}

/**
 * Provider registry interface
 */
export interface ProviderRegistry {
  /**
   * Get provider for a resource type
   * @param resourceType CloudFormation resource type
   * @returns Resource provider
   */
  getProvider(resourceType: string): ResourceProvider;

  /**
   * Check if a resource type is supported
   * @param resourceType CloudFormation resource type
   * @returns Whether the resource type is supported
   */
  isSupported(resourceType: string): boolean;
}
