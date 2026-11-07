import type {
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceImportInput,
  ResourceImportResult,
  ResourceUpdateResult,
} from './results.js';
import type { CreateContext, UpdateContext } from './contexts.js';
import type {
  ReadCurrentStateContext,
  ResourceIdentityVerdict,
  ResourceNotFound,
} from './read-state.js';

/**
 * Context passed to a provider's `delete` method.
 *
 * Re-exported from `src/provisioning/region-check.ts` so that callers
 * implementing the provider interface only need to import from
 * `src/types/resource.ts`.
 */
export type { DeleteContext } from '../../provisioning/region-check.js';
import type { DeleteContext } from '../../provisioning/region-check.js';

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
   * A property listed here is still an `sdkUnwired` row in the generated
   * coverage map, with this rationale, so a template declaring it still
   * auto-routes the resource to Cloud Control on a type that has a CC route
   * (a type with none, e.g. `disableCcApiFallback`, refuses it pre-flight;
   * `--prefer-sdk-route` keeps it on the SDK route). What the entry changes is the
   * backfill campaign: only rows with the default rationale get a per-type
   * issue.
   */
  unhandledByDesign?: ReadonlyMap<string, ReadonlyMap<string, string>>;

  /**
   * Issue #1160: per resource type, the value to send for a top-level property
   * REMOVED from the template, where the update API keeps an absent field's
   * live value (merge semantics) and CloudFormation resets it to its default.
   * The value is CFn-shaped and must be what CloudFormation / AWS treats as
   * the default. The update CALLER injects it into the bag passed to
   * `update()` only; state records the template as-is. Only a CONSTANT that
   * `update()` forwards verbatim belongs here — a coerced, aliased, nested or
   * conditional clear stays a `clearOnUpdateRemoval` site in the provider.
   */
  removalDefaults?: ReadonlyMap<string, ReadonlyMap<string, unknown>>;

  /**
   * Issue #1160: per resource type, the properties whose REMOVAL `update()`
   * already handles itself (a local clear, a diff, a full-replace call, or a
   * removal that is not a valid template transition, such as a required or
   * create-only one). An entry here is the opt-in to the caller's warning,
   * so it must list EVERY such property of the type: any removed property in
   * neither this set nor {@link removalDefaults} is named as left at its
   * current AWS value. A type with no entry is never warned about.
   */
  removalHandledInUpdate?: ReadonlyMap<string, ReadonlySet<string>>;

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
   * go-to-k/cdkd#5131: wait, bounded, until a resource this provider just
   * deleted no longer holds its name, for a type whose `delete()` returns
   * while AWS still holds it (a DynamoDB table stays `DELETING`). Called ONLY
   * by a replacement that deleted the resource itself and re-creates it under
   * the same name -- never by a destroy or an ordinary deploy, which pay no
   * wait. Never throws: an exhausted or interrupted wait returns, and the
   * re-create then fails (or is interrupted) as it would have.
   */
  waitForNameReleased?(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context: { isInterrupted: () => boolean; maskSecrets?: (text: string) => string }
  ): Promise<void>;

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
   * If not implemented (or the type has no registered SDK provider), the engine
   * applies `applyDefaultNameForFallback` instead, which fills a
   * `FALLBACK_NAME_RULES` name and returns any other bag unchanged.
   *
   * On an UPDATE the deploy engine takes a name back out of the returned bag
   * when it is a `FALLBACK_NAME_RULES` name the template leaves falsy, restoring
   * the template's own value where it has one
   * (`withoutGeneratedFallbackName`, issue #3174): the recorded bag never holds
   * a generated name, so sending one would patch the name. A hook's name for
   * such a type therefore reaches Cloud Control on a create only.
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
   * @param context Create-time context (optional, for back-compat). It
   *   carries `replayingState`, set by the rollback executor's
   *   reverse-replacement arm when `properties` come from a historical cdkd
   *   STATE record instead of the template — a provider PRE-FLIGHT REFUSAL
   *   must downgrade to a warning in that case, because the user has no
   *   template-side remedy (issue #1463). See `CreateContext` in
   *   this file for the full contract, and `docs/provider-rules.md#pre-flight-refusal-when-a-provider-may-reject-what-cloudformation-forwards`
   *   for when a refusal is allowed at all. It ALSO carries `maskSecrets` (see
   *   {@link SecretMaskingContext}) — a provider that interpolates a resolved
   *   property value into a log line MUST run the message through it.
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
   * @param context Where the DESIRED bag came from — see {@link UpdateContext}
   *   — plus `maskSecrets` (see {@link SecretMaskingContext}), which a provider
   *   that interpolates a resolved property value into a log line MUST run the
   *   message through. The update path carries the same resolved bag as
   *   `create()`, so the requirement is identical on both.
   * @returns Updated physical ID and attributes
   */
  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
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
   *   Also `maskSecrets` (see {@link SecretMaskingContext}), which a provider
   *   applies to any line naming a bag value or the physical id.
   * @returns Nothing (back-compat: means the resource was deleted), or a
   *   {@link ResourceDeleteResult} when the provider needs to say it did NOT
   *   address the resource. A warn-and-continue arm that issues no AWS call
   *   MUST report `{ outcome: 'skipped', reason }` — returning `void` from
   *   such an arm is what issue
   *   [#1752](https://github.com/go-to-k/cdkd/issues/1752) fixed: the destroy
   *   summary counted it as deleted while the AWS resource stayed alive.
   */
  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult>;

  /**
   * Get resource attributes (for Fn::GetAtt resolution)
   * @param physicalId Physical resource ID
   * @param resourceType CloudFormation resource type
   * @param attributeName Attribute name
   * @param logicalId Template logical id of the resource. A provider that
   *   raises a `ProvisioningError` passes THIS in the error's logical-id slot,
   *   never `physicalId` (go-to-k/cdkd#4222)
   * @returns Attribute value
   */
  getAttribute?(
    physicalId: string,
    resourceType: string,
    attributeName: string,
    logicalId: string
  ): Promise<unknown>;

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
   * Returns {@link RESOURCE_NOT_FOUND} when AWS reports the resource does not
   * exist, which `cdkd drift` reports as `deleted` (go-to-k/cdkd#4283) — never
   * `undefined` for that case.
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
   *          {@link RESOURCE_NOT_FOUND} when the resource is gone, or
   *          `undefined` when not implemented
   */
  readCurrentState?(
    physicalId: string,
    logicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: ReadCurrentStateContext
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined>;

  /**
   * go-to-k/cdkd#5380: of `names` (a record's `unsettledProperties`), the ones
   * AWS is STILL changing — an asynchronous transition an earlier `update()`
   * started and that has not ended (a Firehose stream reading ENABLING /
   * DISABLING). The deploy refuses to diff such a name (a moving value), its
   * post-update proof keeps it, and `cdkd drift --accept` / `--revert` keep it
   * on the record. Called only for a record that names some, so an ordinary
   * run makes no extra call. A failed or stuck transition (`*_FAILED`, an
   * arrested resize) counts as in transition. A provider that marks a key with
   * `UpdateContext.markUnsettled` and whose `readCurrentState` reads an
   * in-progress state as a value implements it; absent = none in transition.
   */
  /**
   * go-to-k/cdkd#5487: the live values of `names` (a record's unsettled
   * properties) in the template's shape, for the engine's convergence step
   * (`src/deployment/unsettled-convergence.ts`) and its post-update proof. A
   * provider implements it when `readCurrentState` would report a value other
   * than the one its update compares (Kinesis: the OPEN shard count) or would
   * swallow a failed read of an unsettled key (Lambda's separately-read
   * settings). It must THROW, not omit the key, when a read fails. Absent:
   * `readCurrentState` is used.
   */
  readUnsettled?(
    physicalId: string,
    logicalId: string,
    resourceType: string,
    names: ReadonlySet<string>,
    recordedProperties?: Record<string, unknown>,
    /**
     * The bag the update sends, so a read can project the live value onto what
     * the record or the template names (a GlobalTable's replicas): the
     * convergence must never remove or reset what neither names.
     */
    desiredProperties?: Record<string, unknown>,
    /**
     * go-to-k/cdkd#5498: the record's attempted names per member path: a live
     * item named here (exactly, not redacted) that neither the record nor the
     * template declares goes on the previous side, so it is removed.
     */
    attemptedItems?: ReadonlyMap<string, ReadonlySet<string>>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined>;

  /**
   * Canonicalize a bag for the proof after a successful `update()`
   * (`unsettledAfterUpdate`), applied to both sides of each unsettled name, so
   * it runs on a SINGLE-KEY bag. Separate from
   * {@link canonicalizeDriftProperties} on purpose: that one may strip a member
   * drift cannot compare, which here would prove a value settled unread.
   * Absent: the values are compared as they are.
   */
  canonicalizeUnsettledProperties?(
    resourceType: string,
    properties: Record<string, unknown>
  ): Record<string, unknown>;

  unsettledInTransition?(
    physicalId: string,
    logicalId: string,
    resourceType: string,
    names: ReadonlySet<string>,
    /** The record's `properties`, for a read needing a parent id (an EMR group's `JobFlowId`). */
    recordedProperties?: Record<string, unknown>,
    /**
     * The bag the update sent, present only on the proof after a successful
     * `update()`: a provider whose resource reads as moving because of that
     * update can leave the verdict to the value comparison.
     */
    desiredProperties?: Record<string, unknown>
  ): Promise<ReadonlySet<string>>;

  /**
   * go-to-k/cdkd#4606: whether `journaledPhysicalId` — the resource a failed
   * CREATE proved it made (a journaled `physicalIdRecoveredFromError` entry)
   * — is the same live AWS resource as the one `record` holds under the same
   * logical id. A successful deploy deletes that journaled resource when, and
   * only when, this answers `'different'` (the fix-forward that created a new
   * resource under the logical id), and so do `cdkd rollback` and `cdkd
   * destroy` replaying an entry that deploy kept (go-to-k/cdkd#4754).
   *
   * A `'different'` must rest on AWS evidence, not on two id strings
   * differing: providers record ids in different forms and an idempotent
   * create can return the same resource under another spelling. At the least,
   * a live read must confirm the record's resource exists, and the type's id
   * namespace must make two distinct ids name two distinct resources (a
   * unique name per account and region that cannot be renamed, an immutable
   * unique id). Answer `'unknown'` whenever the read cannot prove
   * either way (an error, a region the client is not in, an id form the
   * provider does not recognise, the record's resource not found), and
   * `'different'` for a journaled id AWS reports gone only when the record's
   * resource was read and the type's namespace makes it impossible for the
   * gone id to name it. Absent (most providers) means `'unknown'`, which keeps
   * the journaled resource and warns about it.
   */
  isSameResource?(
    journaledPhysicalId: string,
    record: { physicalId: string; provisionedBy?: 'sdk' | 'cc-api' | undefined },
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<ResourceIdentityVerdict>;

  /**
   * go-to-k/cdkd#4655: a token naming THIS live resource and no later one
   * created under the same physical id. A failed CREATE journals it beside a
   * proven orphan's name-keyed physical id, and a successful deploy deletes
   * that orphan only when the token read then is equal: a user may delete the
   * orphan by hand and let something else reuse the name in between.
   *
   * Build it from an immutable AWS-generated id where the type has one (an
   * RDS `DbClusterResourceId`), else from the ARN plus the creation time,
   * since a name-built ARN alone repeats when the name is reused. Return
   * {@link RESOURCE_NOT_FOUND} only on AWS's not-found answer, and `undefined`
   * whenever the read cannot name the resource: an id form the provider does
   * not recognise, a client in another region than `expectedRegion`, a
   * response without the fields. Errors may throw; callers treat a throw as
   * `undefined`. Absent (most providers) means no token: the settle keeps a
   * name-keyed orphan and warns about it instead of deleting it.
   */
  resourceIdentity?(
    physicalId: string,
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<string | ResourceNotFound | undefined>;

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
   * Appending `[]` makes an entry LEAF-ONLY — the path alone, nothing beneath
   * it (issue [#1783](https://github.com/go-to-k/cdkd/issues/1783)). That form
   * exists because this walk DESCENDS INTO ARRAY ELEMENTS, giving each element
   * its parent's path, so a subtree entry for an object list also claims every
   * array nested inside its elements: `AWS::DynamoDB::Table`'s
   * `GlobalSecondaryIndexes` is an unordered set keyed by `IndexName`, but each
   * element's `KeySchema` is order-SIGNIFICANT (HASH before RANGE) and sorting
   * it would HIDE a real key change. Declare `'GlobalSecondaryIndexes[]'` for
   * that shape. The marker is understood by {@link getDriftUnknownPaths} too,
   * so the two lists keep one spelling.
   *
   * @param resourceType e.g. `AWS::FSx::FileSystem`
   * @returns paths whose array (of plain strings or of objects) is unordered;
   *          defaults to empty when not implemented
   */
  getDriftUnorderedPaths?(resourceType: string): string[];

  /**
   * Canonicalize a drift comparison bag — applied by `cdkd drift` to BOTH
   * sides (issue [#1784](https://github.com/go-to-k/cdkd/issues/1784)).
   *
   * This is the escape hatch for a difference an IGNORE-PATH structurally
   * cannot express: a member of an ARRAY ELEMENT. `calculateResourceDrift`
   * compares arrays wholesale via `deepEqual` and never descends into
   * elements, so `isIgnoredPath` is never asked about a path that crosses one
   * — the only expressible suppression is the WHOLE array, which for e.g.
   * `GlobalSecondaryIndexes` would mean never detecting an out-of-band index
   * add / remove / capacity change again. Stripping the AWS-managed member
   * from BOTH sides converges an OLD `observedProperties` record and a NEW
   * readback with no ignore-path and no lost detection.
   *
   * That symmetry is the whole point and the reason there is deliberately no
   * `side` parameter: one-sided normalization is the mistake
   * `src/analyzer/drift-normalize.ts`'s header already records — it
   * manufactures drift on the `properties`-fallback baseline (a resource
   * deployed before observed-capture, whose baseline is the user's raw
   * template). The same pure function must see both bags.
   *
   * Reach for it only when the residual is a per-array-element member. A
   * TOP-LEVEL key that a readback stopped emitting is
   * {@link getDriftUnknownPaths}' job (the #1760 shape), and a difference that
   * is only about ORDER is {@link getDriftUnorderedPaths}'.
   *
   * MUST be pure, synchronous, free of AWS calls, and NON-MUTATING — the bag
   * it receives is the state record / the provider's own readback. Return the
   * input by IDENTITY when nothing applies (the common case), so an unaffected
   * resource pays nothing.
   *
   * **It is not only a comparison filter — `--accept` PERSISTS its output.**
   * `cdkd drift --revert` diffs against the raw, uncanonicalized AWS bag, but
   * `--accept` writes each reported change's `awsValue`, and those come from
   * the canonicalized bags. So on a path that still drifts after
   * canonicalization (a real change alongside a stripped member), `--accept`
   * freezes the STRIPPED shape into `observedProperties`. For the intended use
   * — dropping a member the readback no longer reports — that is the right
   * direction, but do not strip anything you would be unwilling to see removed
   * from the state record.
   *
   * Same CC-API-fallback caveat as {@link getDriftUnknownPaths} and
   * {@link getDriftUnorderedPaths}: when the type has no `readCurrentState`,
   * the AWS side comes from the Cloud Control fallback while THIS method is
   * still the registry provider's, so the bag may not be the shape the
   * provider's own readback would produce. Shape-guard before descending
   * rather than assume — an `Array.isArray` / `typeof` test on the value you
   * intend to rewrite is the whole guard.
   *
   * @param resourceType e.g. `AWS::DynamoDB::Table`
   * @param properties one comparison side (baseline or AWS-current)
   * @returns the canonicalized bag, or the input unchanged
   */
  canonicalizeDriftProperties?(
    resourceType: string,
    properties: Record<string, unknown>
  ): Record<string, unknown>;

  /**
   * Canonicalize the two drift comparison bags TOGETHER, for a rule that must
   * read one side to decide what the other means (issue
   * [#3573](https://github.com/go-to-k/cdkd/issues/3573)). `cdkd drift` calls
   * it once per resource, after {@link canonicalizeDriftProperties}.
   *
   * It exists for a READBACK SHAPE CHANGE: when a provider's `readCurrentState`
   * starts emitting something it used to omit, every `observedProperties`
   * record written before the change lacks it, and the first drift after
   * upgrading reports it. The per-side hook cannot absorb that without hiding
   * the same difference on a record written after the change, so the rule is
   * keyed on the BASELINE's shape: "the baseline is the legacy shape" selects
   * the absorption, and a current-shape baseline is compared in full.
   *
   * Nothing here rewrites state: the next deploy's capture replaces a legacy
   * baseline with the current shape. `--accept` persists its output, exactly
   * as {@link canonicalizeDriftProperties}' does, and `drift --revert` also
   * passes its DESIRED bag (the recorded baseline) through it against the raw
   * readback and sends the returned baseline. So complete a legacy baseline
   * from the readback rather than drop from the readback: a member missing
   * from the desired side is a REMOVAL to `update()`. The exception is a
   * member whose absence the provider's `update()` provably never treats as a
   * removal (`AWS::DynamoDB::Table` `WarmThroughput`, issue #3777; an ELBv2
   * attribute key absent from the readback too, issue #4144; see
   * docs/provider-rules.md).
   *
   * MUST be NON-MUTATING, and return BOTH inputs by identity when nothing
   * applies. Async so a provider can resolve the same client region its own
   * `readCurrentState` used. It issues no AWS call, except a READ-ONLY lookup
   * that decides what an AWS value means and whose failure completes
   * NOTHING, leaving the difference visible: the GlobalTable provider's KMS
   * `DescribeKey` for a replica key on the AWS managed key (issue #5790).
   *
   * @param resourceType e.g. `AWS::DynamoDB::GlobalTable`
   * @param baseline the drift baseline (`observedProperties`, else `properties`)
   * @param aws the AWS-current readback
   * @param properties the resource's recorded `properties` (the template
   *   intent), the same bag `getDriftUnknownPaths` and `readCurrentState`
   *   receive, for a rule keyed on what the template declared. May be `{}`.
   * @returns the two canonicalized bags
   */
  canonicalizeDriftPair?(
    resourceType: string,
    baseline: Record<string, unknown>,
    aws: Record<string, unknown>,
    properties?: Record<string, unknown>
  ): Promise<{ baseline: Record<string, unknown>; aws: Record<string, unknown> }>;

  /**
   * Top-level keys whose ABSENCE from an `observedProperties` baseline records
   * the property's DEFAULT state, because `readCurrentState` omits the key
   * while the property is at its default (go-to-k/cdkd#5399: a GlobalTable on
   * the AWS owned key reads back with no `SSESpecification`). The comparator
   * otherwise walks only the baseline's top-level keys, so a move away from
   * the default was invisible there, and `drift --revert` kept the live value.
   *
   * For each key returned, `cdkd drift` compares the key even when the
   * baseline lacks it, and `drift --revert` sends it ABSENT, so `update()`
   * takes the removal path it takes for a template that removed the property.
   * Return a key only when that removal path resets it to the default, as
   * CloudFormation does, and only when `properties` (the template intent)
   * agrees the property is at its default: a baseline that disagrees with the
   * template it was captured under is not trusted to clear what the template
   * declares. Not consulted for a record without `observedProperties`.
   *
   * Pure and synchronous: no AWS call.
   *
   * @param properties the resource's recorded `properties`. May be `{}`.
   * @returns top-level property names only; a dotted path is ignored (with a
   *   debug line) by the caller.
   */
  getDriftAbsentMeansDefaultKeys?(
    resourceType: string,
    properties: Record<string, unknown>
  ): readonly string[];

  /**
   * Name the drift positions a secret-bearing template position MOVES to when
   * {@link canonicalizeDriftProperties} / {@link canonicalizeDriftPair} (or the
   * readback itself) puts its value somewhere else (go-to-k/cdkd#5332). Step
   * Functions folds each `DefinitionSubstitutions` value into the `Definition`
   * leaves that reference it, so a secret proven at
   * `DefinitionSubstitutions.<name>` is compared, and printed, at
   * `Definition.States.<S>.<...>`. `cdkd drift` adds every returned path to its
   * MASKING set, so a change at (or under, or above) one is masked whatever the
   * value's length — the value scan alone has a needle-length floor.
   *
   * Masking only: the paths never feed the exact-leaf rule that drops a change
   * whose AWS side is absent. Return a coarser ancestor when the exact leaf
   * cannot be computed (over-masking is the safe direction). MUST be pure,
   * synchronous and free of AWS calls.
   *
   * @param resourceType e.g. `AWS::StepFunctions::StateMachine`
   * @param properties the resource's recorded `properties` (template intent)
   * @param secretPaths the dotted paths `cdkd drift` holds as secret-bearing
   * @returns extra dotted paths to mask (empty when nothing moved)
   */
  getDriftSecretPathAliases?(
    resourceType: string,
    properties: Record<string, unknown>,
    secretPaths: ReadonlySet<string>
  ): string[];

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

  /**
   * go-to-k/cdkd#4705: the name `create()` sends for `logicalId` of
   * `resourceType` when the template supplies NONE (a cdkd-generated name),
   * evaluated in the caller's stack-name scope exactly as `create()` evaluates
   * it; `undefined` when the template supplies a name, or the type takes none.
   * Implemented by the name-adopting SDK types only
   * (`NAME_ADOPTING_SDK_CREATE_TYPES`), whose create hands back or overwrites
   * an existing resource of that name instead of failing.
   */
  generatedCreateName?(
    resourceType: string,
    logicalId: string,
    properties: Record<string, unknown>
  ): string | undefined;

  /**
   * go-to-k/cdkd#4705: which of `names` (each the generated name of one
   * planned create of `resourceType`) a resource holds right now, as name →
   * that resource's physical id in `import()`'s format. An EXACT read by
   * name: a batch read by name where the service has one, else one read per
   * name -- never a listing, which is eventually consistent and can omit a
   * resource just created. A resource being deleted reads as absent (its
   * create waits out the deletion itself). Throws when it cannot tell; a 403
   * throws as one. `properties` gives each name's create properties (by
   * name), for a type whose lookup depends on one (an EventBridge rule's
   * bus). Without it, the guard reads each name through `import()`.
   */
  lookupNames?(
    resourceType: string,
    names: readonly string[],
    context: {
      region: string;
      stackName: string;
      propertiesByName: ReadonlyMap<string, Record<string, unknown>>;
    }
  ): Promise<Map<string, string>>;

  /**
   * go-to-k/cdkd#4705: `true` when the lookup of this create's name needs a
   * property the plan does not know yet (an intrinsic still unresolved, such
   * as an EventBridge rule's `EventBusName`): the guard then looks it up at
   * the create, with the resolved properties, rather than guess.
   */
  lookupNeedsResolvedProperties?(
    resourceType: string,
    properties: Record<string, unknown>
  ): boolean;

  /**
   * go-to-k/cdkd#4705: when the resource `physicalId` (a holder `lookupNames`
   * or `import()` found) was created, epoch ms, or `undefined` when the type
   * does not say. A kept resource licenses only a holder created no later
   * than it was kept. Throws when it cannot read it (a 403 as one).
   */
  holderCreatedAt?(resourceType: string, physicalId: string): Promise<number | undefined>;
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
