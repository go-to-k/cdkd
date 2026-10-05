import { type DeployEngine, InterruptedError } from '../deploy-engine.js';
import {
  ATOMIC_FINAL_SNAPSHOT_TYPES,
  PRE_DELETE_SNAPSHOT_TYPES,
  buildFinalSnapshotIdentifier,
  ccRoutedFinalSnapshotError,
  createPreDeleteFinalSnapshot,
  replacementDeletePolicy,
  unsupportedFinalSnapshotError,
} from '../../provisioning/final-snapshot.js';
import type { ProvisionedBy } from '../../provisioning/provider-registry.js';
import { explicitNamePropertyFor } from '../../provisioning/resource-name.js';
import type {
  CreateContext,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceProvider,
} from '../../types/resource.js';
import type { ResourceState } from '../../types/state.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { green } from '../../utils/colors.js';
import { displayAwsMessage, displaySafe, safeMsg } from '../../utils/display-safe.js';
import { CdkdError } from '../../utils/error-handler.js';
import { deleteSkipReason, deleteSkippedMessage } from '../delete-outcome.js';
import { reportDeleteGuards } from '../delete-guard-scope.js';
import {
  type ReplacementNameChange,
  probeErrorMeansNameHeld,
  probeFoundSameId,
  replacementCreateAdoptsName,
  replacementMovesEventBus,
  replacementNameProbe,
  replacementOrderIsCaseSensitive,
  renderReplacementNameChange,
  replacementRequestsDifferentName,
  maskRewrittenSentName,
  replacementSentNameMoves,
} from '../replacement-name-holder.js';
import { withCurrentResourceSecrets } from '../resource-secrets-scope.js';
import { withRetry } from '../retry.js';
import {
  isNameCollisionErrorFrom,
  isRecreateRetryableError,
  markNonRetryable,
} from '../retryable-errors.js';
import {
  type RecordedSecretValues,
  SECRET_MASK,
  createSecretMasker,
  maskSecretsInText,
} from '../secret-redaction.js';

declare module '../deploy-engine.js' {
  interface DeployEngine {
    /** @internal */
    replacementDeleteContext: OmitThisParameter<typeof replacementDeleteContext>;
    /** @internal */
    prepareFinalSnapshotForDelete: OmitThisParameter<typeof prepareFinalSnapshotForDelete>;
    /** @internal */
    replaceDeleteFirstAndRecreate: OmitThisParameter<typeof replaceDeleteFirstAndRecreate>;
    /** @internal */
    typeChangeNameQuestion: OmitThisParameter<typeof typeChangeNameQuestion>;
    /** @internal */
    checkedReplacementNameChange: OmitThisParameter<typeof checkedReplacementNameChange>;
    /** @internal */
    createFirstThenDeleteOld: OmitThisParameter<typeof createFirstThenDeleteOld>;
    /** @internal */
    deleteReplacedAfterCreate: OmitThisParameter<typeof deleteReplacedAfterCreate>;
  }
}

/**
 * What a replacement's delete of the OLD resource tells the provider
 * (issue #4029): the governing `UpdateReplacePolicy`, and the
 * `--skip-final-snapshot` opt-out. `CloudControlProvider.delete` reads both
 * to keep an RDS cluster or instance off the registry handler, which would
 * otherwise take an untagged snapshot of its own.
 */
export function replacementDeleteContext(
  this: DeployEngine,
  updateReplacePolicy: string | undefined
): {
  deletionPolicy: string;
  skipFinalSnapshot?: true;
} {
  return {
    deletionPolicy: replacementDeletePolicy(updateReplacePolicy),
    ...(this.options.skipFinalSnapshot === true && { skipFinalSnapshot: true as const }),
  };
}

/**
 * The `Snapshot`-policy gate every engine delete site runs BEFORE its
 * delete (issues #1352 / #1353 / #1354). Given the resource's effective
 * policy for THIS delete (`DeletionPolicy` on the destroy / removal paths,
 * `UpdateReplacePolicy` on the replacement paths):
 *
 *   - not `Snapshot` (or `--skip-final-snapshot`) → no-op.
 *   - atomic type, SDK-routed → returns the generated identifier for the
 *     provider's atomic final-snapshot delete parameter.
 *   - atomic type, cc-api-routed → refuses (Cloud Control has no
 *     final-snapshot parameter; `CloudControlProvider.delete` also
 *     fail-closes on the context field as defense-in-depth).
 *   - `PRE_DELETE_SNAPSHOT_TYPES` (EC2 Volume / Redshift Cluster /
 *     ElastiCache ReplicationGroup) → creates the snapshot and waits for
 *     it here, then returns undefined (the subsequent delete is plain).
 *   - anything else Snapshot-tagged → refuses.
 */
export async function prepareFinalSnapshotForDelete(
  this: DeployEngine,
  logicalId: string,
  resourceType: string,
  currentResource: { physicalId: string; provisionedBy?: 'sdk' | 'cc-api' | undefined },
  policy: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined
): Promise<string | undefined> {
  if (policy !== 'Snapshot' || this.options.skipFinalSnapshot === true) return undefined;
  if (ATOMIC_FINAL_SNAPSHOT_TYPES.has(resourceType) && currentResource.provisionedBy !== 'cc-api') {
    return buildFinalSnapshotIdentifier(currentResource.physicalId, resourceType);
  }
  if (ATOMIC_FINAL_SNAPSHOT_TYPES.has(resourceType)) {
    throw ccRoutedFinalSnapshotError(logicalId, resourceType, '--skip-final-snapshot');
  }
  if (PRE_DELETE_SNAPSHOT_TYPES.has(resourceType)) {
    // Region-pinned clients: `getAwsClients()` is a process-global that a
    // concurrent stack's deploy can repoint at ANOTHER region
    // (`--stack-concurrency > 1` + multi-region apps); a wrong-region
    // snapshot call 404s as a NotFound, which would be read as "source
    // gone" and skip the snapshot. Prefer the engine-scoped clients
    // threaded via options.
    await createPreDeleteFinalSnapshot(
      resourceType,
      currentResource.physicalId,
      logicalId,
      this.options.finalSnapshotClients ?? getAwsClients(),
      this.logger
    );
    return undefined;
  }
  throw unsupportedFinalSnapshotError(logicalId, resourceType, '--skip-final-snapshot');
}

/**
 * `--replace` delete-first fallback for a property-driven replacement of a
 * custom-named resource: delete the old name holder, then re-create it
 * under the same name. Shared by the create-first collision catch (issue
 * #960 follow-up) and the name-idempotent same-id guard (issue #1238) so
 * the two --replace escape hatches cannot drift apart.
 */
export async function replaceDeleteFirstAndRecreate(
  this: DeployEngine,
  logicalId: string,
  /** The TEMPLATE's type — what the re-create routes on. */
  resourceType: string,
  /**
   * The STATE RECORD's type — what the old resource's delete and final
   * snapshot route on (issue #2668). Equal to `resourceType` unless the
   * resource's `Type` changed.
   */
  oldResourceType: string,
  currentResource: ResourceState,
  oldDeleteProvider: ResourceProvider,
  replaceProvider: ResourceProvider,
  replaceProps: Record<string, unknown>,
  // Issue #1932 item 3. A PARAMETER rather than a field read inside the
  // method: this helper is shared by both --replace escape hatches, and both
  // call it from the UPDATE case where the resolution pass's own bag is in
  // scope. Reading `perResourceSecrets` here instead would work today but
  // would bind the masker to a map looked up by logical id rather than to
  // the bag the caller actually resolved with, which is a different (and
  // silently wrong under concurrency) thing.
  //
  // Issue #2038 review: it is the BAG, not the finished `CreateContext`, for
  // exactly that reason. The retry logger and the two wrap messages below
  // need the same bag the masker is built from, and re-deriving it from
  // `perResourceSecrets` inside this method would have made the file state
  // the rule above and then break it three lines on. The `CreateContext` is
  // built here from this argument, so the provider call is unchanged.
  secrets: RecordedSecretValues,
  updateReplacePolicy: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined,
  /** The layer `oldDeleteProvider` was routed to, for a guard row (issue #2422). */
  oldDeleteProvisionedBy: 'sdk' | 'cc-api' | undefined
): Promise<Awaited<ReturnType<ResourceProvider['create']>>> {
  const createContext: CreateContext = { maskSecrets: createSecretMasker(secrets) };
  // `UpdateReplacePolicy: Snapshot` (issue #1354): snapshot the OLD
  // resource before the replacement delete, exactly like the destroy
  // paths honor `DeletionPolicy: Snapshot`. Deliberately OUTSIDE the
  // delete's try: a snapshot failure/refusal here must surface with its
  // own typed FINAL_SNAPSHOT_* error, not be rewrapped as "Failed to
  // delete old resource ..." for a delete that was never attempted.
  const finalSnapshotIdentifier = await this.prepareFinalSnapshotForDelete(
    logicalId,
    oldResourceType,
    currentResource,
    updateReplacePolicy
  );
  let deleteResult: void | ResourceDeleteResult;
  try {
    deleteResult = await oldDeleteProvider.delete(
      logicalId,
      currentResource.physicalId,
      oldResourceType,
      currentResource.properties,
      {
        expectedRegion: this.stackRegion,
        // Replacement delete: `--force-stateful-recreation` is the user's
        // explicit data-loss consent, so thread it to the provider's data
        // guard (issue #1340).
        forceDataDelete: this.options.forceStatefulRecreation === true,
        ...(finalSnapshotIdentifier !== undefined && { finalSnapshotIdentifier }),
        ...this.replacementDeleteContext(updateReplacePolicy),
        recordedAttributes: currentResource.attributes,
      }
    );
  } catch (deleteError) {
    // Mirror the recreate-flagged path's wrapping: the delete is
    // load-bearing here (without it the re-create collides again).
    //
    // Issue #2038: masked at CONSTRUCTION, not only where it is logged. This
    // message lands in `provisionResource`'s `error` line, in the durable
    // `RESOURCE_FAILED` event, and in the `ProvisioningError` cause — all
    // three of which mask it again, so double-masking is a no-op. Masking
    // here means the plaintext never exists inside a thrown `Error` at all,
    // so a future reader of the `cause` chain cannot re-open the hole. The
    // delete's own payload is the STATE record, which is redacted; the wrap
    // is masked because a provider re-creating from `replaceProps` can echo
    // the resolved value back through this catch.
    //
    // MEASURED UNFENCEABLE, deliberately kept: removing this mask (and the
    // twin on the re-create wrap below) leaves the whole unit suite green,
    // because every reader downstream masks independently. It is
    // defense-in-depth against a future change to one of those readers, not
    // a fence — do not record it in a PR body as a tested behavior.
    throw new Error(
      maskSecretsInText(
        `Failed to delete old resource ${logicalId} (${currentResource.physicalId}) ` +
          `during the --replace delete-first fallback: ` +
          `${deleteError instanceof Error ? deleteError.message : String(deleteError)}`,
        secrets
      )
    );
  }
  // Issue #1762: a skip here FAILS the resource, unlike the template-DELETE
  // branch. The old resource is still alive and the whole point of this
  // path is that the re-create needs its name released — proceeding would
  // either collide or, for a type with no name conflict, leave two live
  // resources with state describing one. Checked outside the catch above so
  // the wrapping never sees it (a return value, not a throw).
  // Issue #2422: before the skip check below, which throws.
  reportDeleteGuards(deleteResult, {
    physicalId: currentResource.physicalId,
    resourceType: oldResourceType,
    provisionedBy: oldDeleteProvisionedBy,
  });
  const replaceSkipReason = deleteSkipReason(deleteResult);
  if (replaceSkipReason !== undefined) {
    throw new Error(
      deleteSkippedMessage(
        logicalId,
        currentResource.physicalId,
        replaceSkipReason,
        'during the --replace delete-first fallback'
      )
    );
  }
  this.logger.info(`  ${green('✓')} Old resource deleted`);
  this.logger.info(`  Re-creating ${logicalId}...`);
  try {
    // Some providers return from delete() before the name is
    // actually released (async deletes: Step Functions, Kinesis,
    // Pipes DELETING state). "already exists" is deliberately
    // NOT in the transient-retry patterns, so give the re-create
    // its own bounded collision retry instead of failing fast
    // with the old resource already gone. SQS additionally
    // enforces a ~60s same-name re-creation cooldown after the
    // delete (QueueDeletedRecently, issue #1206) — the schedule
    // (2s/4s/8s then capped at 10s over 8 retries ≈ 64s total
    // sleep) covers the full cooldown window even when the inner
    // generic retry's budget is exhausted first.
    return await withRetry(
      () =>
        this.withRetry(
          // Issue #1903, same scope as the ordinary CREATE path: bind the
          // resolved-secrets bag around every provider create, so no
          // replacement route can silently skip the nested-stack seed.
          () =>
            withCurrentResourceSecrets(secrets, () =>
              replaceProvider.create(logicalId, resourceType, replaceProps, createContext)
            ),
          logicalId,
          undefined,
          undefined,
          replaceProvider
        ),
      logicalId,
      {
        maxRetries: 8,
        initialDelayMs: 2_000,
        maxDelayMs: 10_000,
        // Issue #2038: `replaceProps` is RESOLVED, so mask the AWS message
        // this retry echoes. Bound to the CALLER's bag (the `secrets`
        // parameter above), not looked up by logical id -- see
        // {@link maskingRetryLoggerFor}.
        logger: this.maskingRetryLoggerFor(secrets),
        isInterrupted: () => this.interrupted,
        onInterrupted: () => new InterruptedError(this.interruptCause ?? 'user'),
        isRetryable: isRecreateRetryableError,
      }
    );
  } catch (recreateError) {
    // The old resource is ALREADY deleted at this point — say so,
    // because state still records it and the next deploy's UPDATE
    // would otherwise chase a resource that no longer exists.
    //
    // Issue #2038: masked at construction, same reason as the delete wrap
    // above — and more acutely, since THIS one wraps a create that was
    // handed the RESOLVED `replaceProps`.
    //
    // Issue #2616 swept this site alongside its twin in the
    // UPDATE-not-supported fallback, and the mask-asymmetry note on that
    // twin covers this site in substance: the `cause` is chained UNMASKED
    // because `provisionResource`'s catch masks the whole chain further up
    // the stack. NOT "one frame up" as the twin's note says — that wording
    // is exact only there; this throw sits in
    // `replaceDeleteFirstAndRecreate`, called from `updateByReplacement`,
    // which `provisionResource` invokes through `withResourceDeadline`. The
    // `cause` is what keeps the AWS
    // rejection behind the sentence readable — `extractDeploymentEventError`
    // walks the chain for `$metadata` / `Code`, so an unchained wrap sends a
    // `RESOURCE_FAILED` event with no `awsErrorCode` at all. Nothing between
    // here and the DAG executor re-classifies the throw (the retry loop is
    // the `withRetry` above, already exhausted), so chaining cannot revive a
    // retry off the cause's text.
    throw new Error(
      maskSecretsInText(
        `Failed to re-create ${logicalId} after the --replace delete-first fallback ` +
          `already deleted the old resource (${currentResource.physicalId}): ` +
          `${recreateError instanceof Error ? recreateError.message : String(recreateError)}. ` +
          `Re-run the deploy to create it fresh.`,
        secrets
      ),
      { cause: recreateError instanceof Error ? recreateError : undefined }
    );
  }
}

/**
 * The name a Type-changed replacement asks for, as a change to probe
 * (go-to-k/cdkd#3937): across two types the "same" name is not one the old
 * resource holds in the new type's name space. `undefined` without an
 * explicit, plain name (a generated one is not compared).
 */
export function typeChangeNameQuestion(
  this: DeployEngine,
  resourceType: string,
  input: { desiredProperties: Record<string, unknown>; currentResource: ResourceState }
): ReplacementNameChange | undefined {
  const property = explicitNamePropertyFor(resourceType);
  if (property === undefined) return undefined;
  const desired = input.desiredProperties[property];
  if (typeof desired !== 'string' || desired === '' || desired === SECRET_MASK) return undefined;
  if (desired.includes('{{resolve:')) return undefined;
  return {
    property,
    desiredName: desired,
    heldName: undefined,
    heldProperty: undefined,
    physicalId: input.currentResource.physicalId,
  };
}

/**
 * The name a replacement moves to when it is KNOWN to differ from the one
 * the old resource holds ({@link replacementRequestsDifferentName}), checked
 * against AWS where the create would not refuse a taken name
 * (go-to-k/cdkd#3937, {@link replacementNameProbe}).
 *
 * - The probe finds ANOTHER resource under the name: refuses, with nothing
 *   created or deleted — the create would hand that resource back (or
 *   overwrite it) and the deploy would record it as its own.
 * - It finds the OLD resource: the difference was not real, so `undefined`
 *   and the caller keeps its pre-existing order.
 * - It cannot be asked, or fails: refuses, since a guess either way can
 *   adopt a stranger's resource.
 *
 * The answer also picks the ORDER of the fallback and `--recreate-via-*`
 * arms, so it compares names exactly unless the type's name space is known
 * to fold case (go-to-k/cdkd#3931, {@link replacementOrderIsCaseSensitive});
 * an EventBridge rule moving bus counts as a name change
 * ({@link replacementMovesEventBus}). A Type change onto a name-adopting
 * type always asks, and a holder found under the id the old resource of
 * ANOTHER type has is still refused: two namespaces, two resources.
 */
export async function checkedReplacementNameChange(
  this: DeployEngine,
  input: {
    logicalId: string;
    resourceType: string;
    oldResourceType: string;
    stackName: string;
    currentResource: ResourceState;
    desiredProperties: Record<string, unknown>;
    createProvider: ResourceProvider;
    createdVia: ProvisionedBy | undefined;
    createProps: Record<string, unknown>;
    secrets: RecordedSecretValues;
  }
): Promise<ReplacementNameChange | undefined> {
  const { logicalId, resourceType, currentResource, secrets } = input;
  const question = {
    oldResourceType: input.oldResourceType,
    newResourceType: resourceType,
    desiredProperties: input.desiredProperties,
    recorded: currentResource.properties,
    observed: currentResource.observedProperties,
    physicalId: currentResource.physicalId,
  };
  // The #3808 comparison folds case, which is the safe direction for a
  // refusal. Here it decides whether deleting first frees the name, and
  // whether an adopting create is asked first, so a case-only rename is a
  // different name unless the type folds case.
  const adopts = replacementCreateAdoptsName(resourceType, input.createdVia);
  const typeChanged = input.oldResourceType !== resourceType;
  const change =
    replacementRequestsDifferentName(question) ??
    (adopts || replacementOrderIsCaseSensitive(resourceType)
      ? replacementRequestsDifferentName({ ...question, caseSensitive: true })
      : undefined) ??
    replacementMovesEventBus(question) ??
    replacementSentNameMoves({
      oldResourceType: input.oldResourceType,
      newResourceType: resourceType,
      createdVia: input.createdVia,
      desiredProperties: input.desiredProperties,
      physicalId: currentResource.physicalId,
      logicalId,
    }) ??
    (adopts && typeChanged ? this.typeChangeNameQuestion(resourceType, input) : undefined);
  if (change === undefined) return undefined;
  const probe = replacementNameProbe({
    resourceType,
    createdVia: input.createdVia,
    change,
    region: this.stackRegion,
  });
  if (probe === undefined) return change;
  // A secret-derived name a provider rewrites before sending (ELBv2) is
  // printed by AWS, and in the holder's ARN, in a spelling the recorded
  // secrets do not match: mask that spelling too.
  const maskName = maskRewrittenSentName(resourceType, input.createProps, logicalId, (text) =>
    maskSecretsInText(text, secrets)
  );
  const subject = `${displaySafe(logicalId)} (${displaySafe(resourceType)})`;
  const adoptsText =
    `its create API hands back or overwrites an existing resource of that name instead of ` +
    `refusing it`;
  if (probe === null) {
    throw markNonRetryable(
      new CdkdError(
        maskName(
          `${subject} requires replacement under a new name, and ${adoptsText}, but cdkd cannot ` +
            `check whether another resource already holds it. Nothing was created or deleted.`
        ),
        'NAMED_REPLACEMENT_COLLISION'
      )
    );
  }
  // Every SDK provider of a name-adopting type implements `import()`
  // (pinned in `replacement-name-holder.test.ts`). One without it is a test
  // double or a wrapper; refusing there would turn every mocked renamed
  // queue, topic, rule or alarm in the suite into a probe test.
  const lookup = input.createProvider.import?.bind(input.createProvider);
  if (lookup === undefined) return change;
  let found: Awaited<ReturnType<NonNullable<ResourceProvider['import']>>>;
  try {
    found = await this.withRetry(
      () =>
        lookup({
          logicalId,
          resourceType,
          stackName: input.stackName,
          region: this.stackRegion,
          properties: input.createProps,
          ...probe,
        }),
      logicalId,
      undefined,
      undefined,
      input.createProvider
    );
  } catch (probeError) {
    if (probeErrorMeansNameHeld(resourceType, probeError)) {
      throw markNonRetryable(
        new CdkdError(
          maskName(
            `${subject} requires replacement, and S3 answered 403 Forbidden for bucket ` +
              `${displaySafe(change.desiredName)}: another account owns that name, or a bucket ` +
              `of this account denies this identity \`s3:ListBucket\`, or the request's ` +
              `credentials were rejected. Nothing was created or deleted. Choose another name, ` +
              `or if the bucket is yours grant \`s3:ListBucket\` on it (or delete it) and ` +
              `re-run.`
          ),
          'NAMED_REPLACEMENT_COLLISION',
          probeError instanceof Error ? probeError : undefined
        )
      );
    }
    throw markNonRetryable(
      new CdkdError(
        maskName(
          `${subject} requires replacement under a new name, and ${adoptsText}, but cdkd could ` +
            `not check whether another resource already holds it: ` +
            `${displayAwsMessage(maskName(probeError instanceof Error ? probeError.message : String(probeError)))}. ` +
            `Nothing was created or deleted. Re-run the deploy once the check can succeed.`
        ),
        'NAMED_REPLACEMENT_COLLISION',
        probeError instanceof Error ? probeError : undefined
      )
    );
  }
  if (found === null) return change;
  if (
    !typeChanged &&
    probeFoundSameId(resourceType, found.physicalId, currentResource.physicalId)
  ) {
    return undefined;
  }
  throw markNonRetryable(
    new CdkdError(
      maskName(
        `${subject} requires replacement, and another existing resource ` +
          `(${displaySafe(found.physicalId)}) already holds the name it asks for. ` +
          `${renderReplacementNameChange(change, input.createProps)}. Since ${adoptsText}, creating the replacement ` +
          `would take that resource over and record it as this stack's. Nothing was ` +
          `created or deleted. Choose a name no other resource holds, or delete the ` +
          `resource holding it if it is yours.`
      ),
      'NAMED_REPLACEMENT_COLLISION'
    )
  );
}

/**
 * The create-first order for a replacement whose name is KNOWN to move off
 * the one the old resource holds (go-to-k/cdkd#3931): the `--recreate-via-*`
 * destroy-then-create and the UPDATE-not-supported fallback's DELETE →
 * CREATE delete first only to free a name the old resource holds, and here
 * it holds another. Deleting first freed nothing, so when another resource
 * held the new name the create collided with the managed resource already
 * gone. Now the old resource is deleted only once its replacement exists,
 * and a collision refuses with nothing deleted.
 *
 * The final-snapshot gate runs BEFORE the create, so its refusals still
 * change nothing; the delete after it is the property-driven cleanup's
 * ({@link deleteReplacedAfterCreate}).
 */
export async function createFirstThenDeleteOld(
  this: DeployEngine,
  input: {
    logicalId: string;
    resourceType: string;
    oldResourceType: string;
    currentResource: ResourceState;
    createProvider: ResourceProvider;
    createProps: Record<string, unknown>;
    deleteProvider: ResourceProvider;
    /** The layer `deleteProvider` was routed to, for a guard row (issue #2422). */
    deleteProvisionedBy: 'sdk' | 'cc-api' | undefined;
    deleteProperties: Record<string, unknown>;
    secrets: RecordedSecretValues;
    change: ReplacementNameChange;
    /** An equal physical id on the two halves names the SAME resource. */
    equalIdIsSameResource: boolean;
    snapshotPolicy: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined;
    deletePolicy: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined;
    /** What forced the replacement, for the refusals. */
    trigger: string;
    /** `UpdateReplacePolicy: Retain`: create only, the old resource stays. */
    retainOld?: boolean;
  }
): Promise<ResourceCreateResult> {
  const { logicalId, resourceType, currentResource, secrets } = input;
  const retainOld = input.retainOld === true;
  // Before the create, so a refusal changes nothing. A PRE_DELETE_SNAPSHOT
  // type would take its snapshot here, before the create window; none of
  // them has a name `replacementRequestsDifferentName` reads, so none
  // reaches this method.
  const finalSnapshotIdentifier = retainOld
    ? undefined
    : await this.prepareFinalSnapshotForDelete(
        logicalId,
        input.oldResourceType,
        currentResource,
        input.snapshotPolicy
      );
  this.logger.info(
    retainOld
      ? safeMsg`  ${logicalId}'s new name differs from the one the old resource holds — creating the new resource (the old one is retained)...`
      : safeMsg`  ${logicalId}'s new name differs from the one the old resource holds — creating the new resource before deleting the old one...`
  );
  // The rewritten spelling of a secret-derived name (ELBv2), under either
  // prefix flag, is in AWS's text, the physical ids and the rendered name
  // change, where the literal mask misses it.
  const maskName = maskRewrittenSentName(resourceType, input.createProps, logicalId, (text) =>
    maskSecretsInText(text, secrets)
  );
  let createResult: ResourceCreateResult;
  try {
    createResult = await this.withRetry(
      () =>
        withCurrentResourceSecrets(secrets, () =>
          input.createProvider.create(logicalId, resourceType, input.createProps, {
            maskSecrets: createSecretMasker(secrets),
          })
        ),
      logicalId,
      undefined,
      undefined,
      input.createProvider
    );
  } catch (createError) {
    // The old resource is untouched: a raw failure is the whole story.
    if (!isNameCollisionErrorFrom(createError, logicalId)) throw createError;
    const createMsg = displayAwsMessage(
      maskName(createError instanceof Error ? createError.message : String(createError))
    );
    // Marked: the message quotes the collision text, which the recreate
    // retry classifier would otherwise retry for minutes.
    throw markNonRetryable(
      new CdkdError(
        maskName(
          `${displaySafe(logicalId)} (${displaySafe(resourceType)}) requires replacement ` +
            `(${input.trigger}), and cdkd created the new resource first because its name ` +
            `differs, but the create collided: ${createMsg}. If the collision is on the ` +
            `requested name: ${renderReplacementNameChange(input.change, input.createProps)}. Nothing was deleted` +
            (retainOld ? ` (UpdateReplacePolicy: Retain keeps the old resource in place)` : '') +
            `. Choose a name no other resource holds, or delete the resource holding it if it ` +
            `is yours.`
        ),
        'NAMED_REPLACEMENT_COLLISION',
        createError instanceof Error ? createError : undefined
      )
    );
  }
  if (input.equalIdIsSameResource && createResult.physicalId === currentResource.physicalId) {
    // A name-idempotent create handed the old resource back, so it holds the
    // requested name after all and deleting it would delete the "new" one.
    throw markNonRetryable(
      new CdkdError(
        maskName(
          `${displaySafe(logicalId)} (${displaySafe(resourceType)}) requires replacement ` +
            `(${input.trigger}) under a new name, but the create returned the resource being ` +
            `replaced (${displaySafe(currentResource.physicalId)}) instead of a new one, so ` +
            `cdkd cannot tell which name it holds. Nothing was deleted. Delete that resource ` +
            `by hand if it is yours, then re-run the deploy.`
        ),
        'NAMED_REPLACEMENT_IDEMPOTENT_CREATE'
      )
    );
  }
  if (retainOld) return createResult;
  this.logger.info(safeMsg`  Deleting old ${logicalId} (${currentResource.physicalId})...`);
  await this.deleteReplacedAfterCreate(
    logicalId,
    input.oldResourceType,
    currentResource,
    input.deleteProvider,
    input.deleteProperties,
    finalSnapshotIdentifier,
    input.deletePolicy,
    secrets,
    input.deleteProvisionedBy
  );
  return createResult;
}

/**
 * The delete of a replaced resource once its replacement EXISTS. A failure
 * or a skip warns rather than fails the resource (issue #1762): the new
 * resource is created and about to be recorded, so the old one is untracked
 * either way, and failing here would roll back a replacement that
 * succeeded. Neither is recorded as a retention (issue #2631). The delete
 * error is masked with `secrets` BEFORE it is rendered: a provider can echo
 * a resolved value.
 */
export async function deleteReplacedAfterCreate(
  this: DeployEngine,
  logicalId: string,
  oldResourceType: string,
  currentResource: ResourceState,
  deleteProvider: ResourceProvider,
  deleteProperties: Record<string, unknown>,
  finalSnapshotIdentifier: string | undefined,
  updateReplacePolicy: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined,
  secrets: RecordedSecretValues,
  /** The layer `deleteProvider` was routed to, for a guard row (issue #2422). */
  deleteProvisionedBy: 'sdk' | 'cc-api' | undefined
): Promise<void> {
  // Initialized because the catch below can leave it unassigned.
  let deleteResult: void | ResourceDeleteResult = undefined;
  let deleteFailed = false;
  try {
    deleteResult = await deleteProvider.delete(
      logicalId,
      currentResource.physicalId,
      oldResourceType,
      deleteProperties,
      {
        expectedRegion: this.stackRegion,
        forceDataDelete: this.options.forceStatefulRecreation === true,
        ...(finalSnapshotIdentifier !== undefined && { finalSnapshotIdentifier }),
        ...this.replacementDeleteContext(updateReplacePolicy),
        // Issue #4157: the identity evidence of the record deleted.
        recordedAttributes: currentResource.attributes,
      }
    );
  } catch (deleteError) {
    const deleteMsg = maskSecretsInText(
      deleteError instanceof Error ? deleteError.message : String(deleteError),
      secrets
    );
    deleteFailed = true;
    // Always a warning, a not-found included: an "already gone" read off the
    // MESSAGE cannot be made safe (go-to-k/cdkd#3236) — a logical id like
    // `PageNotFound`, or a delete failing on a KMS key or role "not found"
    // while the old resource is alive, would silence the one line telling
    // the user an untracked resource may be left.
    this.logger.warn(
      safeMsg`  ⚠ Failed to delete old resource ${logicalId} (${currentResource.physicalId}): ${deleteMsg}`
    );
  }
  // Issue #2422.
  reportDeleteGuards(deleteResult, {
    physicalId: currentResource.physicalId,
    resourceType: oldResourceType,
    provisionedBy: deleteProvisionedBy,
  });
  const skipReason = deleteSkipReason(deleteResult);
  if (skipReason !== undefined) {
    this.logger.warn(
      `  ⚠ ${deleteSkippedMessage(
        logicalId,
        currentResource.physicalId,
        skipReason,
        'while cleaning up the replaced resource',
        // No command on this line, and the id is the only trace left of the
        // resource: show it, bounded, rather than describe it
        // (go-to-k/cdkd#4265).
        { commandFreeLine: true }
      )}. Delete it manually — it is no longer tracked in state.`
    );
  } else if (!deleteFailed) {
    this.logger.info(`  ${green('✓')} Old resource deleted`);
  }
}
