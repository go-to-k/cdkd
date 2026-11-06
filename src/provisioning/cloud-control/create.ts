import type { CloudControlProvider } from '../cloud-control-provider.js';
import { CreateResourceCommand } from '@aws-sdk/client-cloudcontrol';
import { ProvisioningError } from '../../utils/error-handler.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { displaySafe } from '../../utils/display-safe.js';
import { maskDeep, maskerOrIdentity, type MaskerFn } from '../masked-retry-logger.js';
import { getTopLevelDeployAttributeNames } from '../read-only-properties.js';
import { isWaitAbandonedError } from '../wait-abandoned.js';
import type { CreateContext, ResourceCreateResult } from '../../types/resource.js';
import {
  stringifyJsonProperties,
  stripNullValues,
  CloudControlOperationFailedError,
} from './shared.js';
import { isNotFoundMessage } from './poll-failure.js';
import {
  IdScrubLog,
  abandonedRequestTokens,
  inIdLogScope,
  identifierCarriedBy,
  holdsSecretDerivedLeaf,
} from './id-log.js';

/**
 * Create a resource using Cloud Control API.
 *
 * Runs under an {@link IdScrubLog} (go-to-k/cdkd#3869): the identifier is
 * not known until Cloud Control names it, so it is added once a progress
 * event or a thrown error carries it, and from then on every line, and the
 * error leaving this method, is scrubbed of it when the desired bag holds a
 * secret-derived value.
 */
export async function create(
  this: CloudControlProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  const mask = maskerOrIdentity(context?.maskSecrets);
  const idLog = new IdScrubLog(this.logger, mask, holdsSecretDerivedLeaf(properties, mask));
  return inIdLogScope(idLog, () =>
    this.createInIdLogScope(logicalId, resourceType, properties, idLog, mask)
  );
}

export async function createInIdLogScope(
  this: CloudControlProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  idLog: IdScrubLog,
  mask: MaskerFn
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating resource ${logicalId} (${resourceType})`);
  // Started NOW, resolved at the end: the schema lookup the narrowing needs
  // (issue #2925) runs alongside the create rather than after it. Never
  // rejects, so an early return or a throw below leaves nothing unhandled.
  const attributeNamesLookup = getTopLevelDeployAttributeNames(resourceType);

  try {
    // Start resource creation
    const cleanProperties = stripNullValues(properties) as Record<string, unknown>;
    const ccProperties = stringifyJsonProperties(resourceType, cleanProperties);
    const desiredState = JSON.stringify(ccProperties);
    // Log the top-level property KEYS only, never the values (GHSA fix, sibling
    // of the update-path patch-log masking): a CC-routed resource with no SDK
    // provider may carry a resolved `{{resolve:secretsmanager:...}}` value in
    // `ccProperties`, and the values are never needed to debug a CREATE. A key
    // cannot hold a resolved dynamic reference (CloudFormation resolves one only
    // in a value), but each still goes through the caller's masker BEFORE the
    // stringify, so the line stays masked if it ever renders more (#5894). The
    // full document still goes to AWS below.
    this.logger.debug(
      `DesiredState for ${logicalId}: keys=${JSON.stringify(maskDeep(Object.keys(ccProperties), mask))}`
    );
    const createResponse = await this.cloudControlClient.send(
      new CreateResourceCommand({
        TypeName: resourceType,
        DesiredState: desiredState,
      })
    );

    if (!createResponse.ProgressEvent?.RequestToken) {
      throw new ProvisioningError(
        `Failed to create resource ${logicalId}: No request token received`,
        resourceType,
        logicalId
      );
    }

    this.logger.debug(
      `Create request submitted for ${logicalId}, token: ${createResponse.ProgressEvent.RequestToken}`
    );

    // Wait for creation to complete
    const progressEvent = await this.waitForOperation(
      createResponse.ProgressEvent.RequestToken,
      logicalId,
      'CREATE',
      resourceType
    );

    if (!progressEvent.Identifier) {
      throw new ProvisioningError(
        `Failed to create resource ${logicalId}: No physical ID returned`,
        resourceType,
        logicalId
      );
    }

    idLog.addId(progressEvent.Identifier);
    this.logger.debug(`Created resource ${logicalId}, physical ID: ${progressEvent.Identifier}`);

    // Parse resource properties to extract attributes
    const result: ResourceCreateResult = {
      physicalId: progressEvent.Identifier,
    };

    if (progressEvent.ResourceModel) {
      result.attributes = this.parseResourceModel(progressEvent.ResourceModel);
    }

    // Generic sparse-model read-back (issue #1105) — BEFORE the per-type
    // enrichment switch so its `if (!enriched['X'])` gating composes.
    result.attributes = await this.mergeSparseModelReadback(
      resourceType,
      progressEvent.Identifier,
      result.attributes || {}
    );

    // Every key so far came from the Cloud Control model (the event's, or
    // the read-back that wins over it); the enrichment below adds computed
    // attributes. Only the MODEL keys are narrowed (issue #2925).
    const modelKeys = Object.keys(result.attributes);

    // Enrich attributes with computed values for specific resource types
    result.attributes = await this.enrichResourceAttributes(
      resourceType,
      progressEvent.Identifier,
      result.attributes
    );

    result.attributes = await this.maskDeployedNonAttributeKeys(
      result.attributes,
      modelKeys,
      resourceType,
      progressEvent.Identifier,
      attributeNamesLookup,
      properties,
      mask
    );

    return result;
  } catch (error) {
    // Before the remnant cleanup, whose lines name it: a FAILED event, a
    // cancellation or an abandoned wait can carry the identifier the
    // handler materialized, and the status text can quote it.
    idLog.addId(identifierCarriedBy(error));
    await this.cleanupFailedCreateRemnant(error, resourceType, logicalId, mask);
    this.handleError(error, 'CREATE', resourceType, logicalId);
  }
}

/**
 * Best-effort deletion of the physical resource a FAILED async CREATE left
 * behind.
 *
 * Some Cloud Control create handlers materialize the resource first and
 * stabilize it afterwards (e.g. `AWS::Synthetics::Canary` creates the canary
 * entity, then builds its backing Lambda). When stabilization fails — most
 * commonly the just-created-IAM-role propagation race cdkd's fast path is
 * prone to — the FAILED progress event carries the materialized resource's
 * `Identifier`, but the half-created remnant keeps occupying the name. The
 * deploy engine's outer `withRetry` then re-invokes `create()` (the
 * stabilization message matches the transient-error patterns) and every
 * retry fails with `AlreadyExists` instead of recovering, and the remnant is
 * ALSO invisible to rollback (the create never returned, so it is not in
 * state) — an orphan CloudFormation would have deleted on rollback.
 *
 * Deleting the remnant here restores both behaviors: the next retry starts
 * with a free name (and succeeds once AWS stabilizes), and a final failure
 * leaves nothing behind.
 *
 * Safety: never fires when the handler reported `ErrorCode: AlreadyExists`
 * — there the identifier names a resource that pre-dates this create (our
 * CreateCanary repro's SECOND attempt reported exactly that shape), and
 * deleting it would destroy a user's pre-existing resource. Handlers may
 * also stuff a speculative identifier into a FAILED event without having
 * materialized anything (observed on `AWS::CodeDeploy::DeploymentGroup`);
 * the delete then no-ops via the NotFound-idempotent path (structured
 * `ErrorCode: NotFound` or the canonical message substrings), and a
 * service-worded not-found the delete path cannot recognize (CodeDeploy's
 * "No Deployment Group found for name: ...") is downgraded here to an
 * already-gone info instead of the misleading "remove it manually" warning
 * (issue #1252). Real cleanup failures are warned, not thrown — the
 * original create error must surface.
 */
export async function cleanupFailedCreateRemnant(
  this: CloudControlProvider,
  error: unknown,
  resourceType: string,
  logicalId: string,
  // The create's masker, forwarded to the remnant's delete (go-to-k/cdkd#2007).
  mask: MaskerFn
): Promise<void> {
  if (!(error instanceof CloudControlOperationFailedError)) return;
  if (error.ccOperation !== 'CREATE' || !error.physicalId) return;
  if (error.ccErrorCode === 'AlreadyExists') return;
  // ResourceConflict means the identifier is undergoing ANOTHER in-flight
  // operation — the identifier may name a resource this request did not
  // materialize, so deleting it is not ours to do either.
  if (error.ccErrorCode === 'ResourceConflict') return;

  this.logger.info(
    `CREATE of ${logicalId} failed after materializing ${error.physicalId}; deleting the remnant so a retry can re-create it`
  );
  try {
    // Reuse the provider's own delete: it polls the async operation to
    // completion and already treats NotFound as idempotent success.
    const cleanupResult = await this.delete(logicalId, error.physicalId, resourceType, undefined, {
      maskSecrets: mask,
    });
    // Issue #1778 confirmed the ACCOUNTING half of "the result is
    // uninteresting here": this is a CREATE path, so nothing it returns
    // reaches the destroy runner's deleted/skipped counters, and the only
    // consumer of a failure is the warning below (the original create error
    // must surface either way). What is NOT uninteresting is the MESSAGE:
    // the debug line below asserts the remnant was removed, so a skip made
    // it say the opposite of what happened. A skip is also the one outcome
    // that means the name is still taken, which is exactly what the caller's
    // retry is about to trip over — so it takes the same warning a failed
    // cleanup takes.
    //
    // Reachability note: the delegating branch in `delete` (the only
    // producer of a skip on this provider today) is gated on
    // `context.removeProtection`, and this call passes a context carrying no
    // `removeProtection` (only the create's masker, go-to-k/cdkd#2007), so
    // the branch below is unreachable from here as the code stands. It is
    // kept because the reachability is a property of a DIFFERENT method's
    // internals, not of this call site, and the cost of being wrong about it
    // is a false "removed" line over an occupied name.
    if (cleanupResult?.outcome === 'skipped') {
      this.logger.warn(
        `Skipped deleting the remnant ${error.physicalId} left by the failed CREATE of ${logicalId} ` +
          `(a retry may fail with AlreadyExists until it is removed manually): ${displaySafe(cleanupResult.reason)}`
      );
      return;
    }
    this.logger.debug(`Removed failed-create remnant ${error.physicalId} for ${logicalId}`);
  } catch (cleanupError) {
    // Deliberately the RAW message, and deliberately NOT the guarded
    // `describePollFailure(...).display` that `disableCcProtection`'s twin
    // catch takes. Two points, both measured after a round-10 review
    // proposed converting this site as well:
    //
    //  - `describeAwsFailure(...).detail` is NOT that reduction: it is the
    //    `Error`'s message verbatim, and `String(value)` without the throw
    //    for anything else (go-to-k/cdkd#3361). Its non-`Error` arm is
    //    UNREACHABLE here today: `delete()` wraps everything inside its
    //    `handleError` try into a `ProvisioningError`, and of its four
    //    awaits outside that try, three (`asgProvider.delete`,
    //    `disableInstanceApiTermination`, `disableCcProtection`) are gated on
    //    `context?.removeProtection === true`, which this call never passes
    //    (its context carries only the create's masker, go-to-k/cdkd#2007),
    //    while the fourth, `ec2ClientInCcRegion` (issue #3455), throws only
    //    a cdkd-authored `ProvisioningError`. It is still the guarded form,
    //    as defence in depth: give this call a `removeProtection` context
    //    and a null-prototype rejection would otherwise make a bare
    //    `String()` throw out of this catch and replace the create failure.
    //  - reducing the text here would be a NO-OP today and a decision-changer
    //    the moment the wrapper stops being cdkd-authored. Measured: applying
    //    the conversion leaves the whole provisioning suite green, because
    //    every error leaving `this.delete()` is a cdkd-authored
    //    `ProvisioningError` carrying no `$fault` and no numeric
    //    `httpStatusCode`, so `describePollFailure` hands back the raw
    //    message anyway. The risk is real but LATENT: `message` feeds
    //    `isNotFoundMessage` five lines down, which matches service PROSE
    //    ("No Deployment Group found for name: ..."), so on any future path
    //    where an AWS-authored error reaches this catch the reduction would
    //    silently stop that classifier recognising the shapes it exists for.
    //    An earlier revision of this comment stated that as a live risk,
    //    which review measured false.
    const message = describeAwsFailure(cleanupError).detail;
    // Ahead of `isNotFoundMessage`, and NOT a duplicate of the four
    // already-deleted guards elsewhere — this one matches with a
    // case-INSENSITIVE regex, so it has a failure mode they do not. Since
    // issue go-to-k/cdkd#3236 the cleanup delete can abandon its own wait,
    // and that message interpolates the transport cause: a
    // `getaddrinfo ENOTFOUND cloudcontrolapi...` contains `NOTFOUND`, which
    // `/not\s*found/i` matches (measured). The arm would then log "was
    // already gone; nothing to clean up" and SUPPRESS the
    // "remove it manually / a retry may fail with AlreadyExists" warning —
    // over a remnant still occupying the name, which is the one thing the
    // caller's retry is about to trip over.
    if (isWaitAbandonedError(cleanupError)) {
      // The clause goes BEFORE the interpolated message, not after it: that
      // message ends with the abandonment's pasteable `aws cloudcontrol` line
      // and `displaySafe`'s default mode flattens its newline to a space, so
      // appending cdkd prose puts text after a command on one line — the rule
      // `buildResumeCommand` establishes, one level out.
      const line =
        `Could not confirm whether the remnant ${error.physicalId} left by the failed CREATE of ${logicalId} was removed ` +
        `(a retry may fail with AlreadyExists until it is removed manually): ${displaySafe(message)}`;
      // The resume command at its end is the remnant delete's only handle:
      // kept whole, not cut by a short id needle (go-to-k/cdkd#3869).
      const log = this.logger;
      if (log instanceof IdScrubLog) {
        log.warnKeepingResume(line, abandonedRequestTokens(cleanupError));
      } else {
        log.warn(line);
      }
      return;
    }
    // A not-found on the remnant delete means the remnant is ALREADY gone —
    // the failed CREATE never actually materialized it, or it vanished
    // before the delete landed. delete() absorbs the structured
    // `ErrorCode: NotFound` shape itself; this fallback catches handlers
    // that report a non-NotFound code with a service-worded message.
    if (isNotFoundMessage(message)) {
      this.logger.info(
        `The remnant ${error.physicalId} left by the failed CREATE of ${logicalId} was already gone (not found); nothing to clean up`
      );
      return;
    }
    // `displaySafe` for the same reason its siblings in this function carry
    // it: the message is an AWS failure, not cdkd-authored text, and
    // `ConsoleLogger.formatMessage` sanitizes EXTRA ARGS only. All THREE warn
    // arms in this function take the same treatment — sanitize the
    // interpolated value, and put cdkd's own clause before it rather than
    // after. An earlier revision did two of the three and miscounted them.
    //
    // Only THIS arm's call is load-bearing, and the asymmetry is measured
    // rather than assumed: deleting `displaySafe` from the ABANDONED arm or
    // the SKIPPED arm leaves the whole suite green, because the first
    // receives text `abandonWait` has already sanitized and the second
    // receives a provider-authored skip reason. This arm is the only one
    // interpolating a raw caught message, and it is the one the fence in
    // `cloud-control-wait-abandoned.test.ts` pins. The other two stay: what
    // arrives sanitized today is an upstream property, not one this function
    // controls.
    this.logger.warn(
      `Failed to delete the remnant ${error.physicalId} left by the failed CREATE of ${logicalId} ` +
        `(a retry may fail with AlreadyExists until it is removed manually): ${displaySafe(message)}`
    );
  }
}
