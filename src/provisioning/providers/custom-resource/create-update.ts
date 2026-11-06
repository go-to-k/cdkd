import type { CustomResourceProvider } from '../custom-resource-provider.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { S3Client } from '@aws-sdk/client-s3';
import { displayIdent } from '../../../utils/display-safe.js';
import { getAccountInfo } from '../../../deployment/intrinsic-function-resolver.js';
import { rebuildClientForBucketRegion } from '../../../utils/bucket-region-client.js';
import { AccountIdUnavailableError, ProvisioningError } from '../../../utils/error-handler.js';
import type { InterruptWatch } from '../../interrupt-watch.js';
import { markRedactedCause } from '../../../deployment/retryable-errors.js';
import type {
  ResourceCreateResult,
  ResourceUpdateResult,
  CreateContext,
  UpdateContext,
} from '../../../types/resource.js';
import { maskerOrIdentity, type MaskerFn } from '../../masked-retry-logger.js';
import { markAuxiliaryFailure } from '../../auxiliary-failure.js';
import {
  crUnresolvedTokenUpdateRemedy,
  CR_UNRESOLVED_TOKEN_CREATE_REMEDY,
} from './delete-skip-reasons.js';
import { DELETE_ACCOUNT_LOOKUP_RETRY_DELAYS_MS } from './retry-policy.js';
import { syntheticStackId, respondedPhysicalId } from './response-body.js';

/**
 * Self-reported minimum per-resource timeout.
 *
 * Custom Resource async invocations (CDK Provider framework with
 * `isCompleteHandler`) poll for up to `asyncResponseTimeoutMs`
 * (default 1 hour, matching CDK's `totalTimeout` default). The deploy
 * engine's global `--resource-timeout` default is 30 minutes, which
 * would abort a perfectly healthy CR mid-poll. By self-reporting the
 * polling cap, the engine lifts the deadline to `max(self-report,
 * global)` for CR resources only; a user-supplied per-type override
 * (`--resource-timeout AWS::CloudFormation::CustomResource=5m`) still
 * wins for explicit escape-hatching.
 */
export function getMinResourceTimeoutMs(this: CustomResourceProvider): number {
  return this.asyncResponseTimeoutMs;
}

/**
 * Set the S3 bucket for custom resource responses.
 * Called by ProviderRegistry when the state bucket is configured.
 *
 * There is deliberately NO region parameter (issue #1202): the bucket's
 * ACTUAL region is resolved lazily via `ensureResponseClient()` before
 * the first S3 operation (issue #1195), starting from the shared
 * `AwsClients.s3` client so `--profile` / static credentials carry into
 * both the `GetBucketLocation` probe and the rebuilt client. The former
 * deploy-region hint parameter built a default-credential-chain client
 * (dropping `--profile`) and added nothing — the probe resolves the
 * bucket's real region regardless of the starting client's region.
 */
export function setResponseBucket(this: CustomResourceProvider, bucket: string): void {
  this.responseBucket = bucket;
  this.responseClientGeneration++;
  this.responseClientResolved = false;
  this.responseClientResolveInFlight = null;
}

/**
 * Swap `this.s3Client`, destroying the previous client when the
 * provider owned it (never the shared `AwsClients.s3` instance).
 * The optional call tolerates test doubles without a `destroy`.
 */
export function replaceS3Client(this: CustomResourceProvider, replacement: S3Client): void {
  if (this.ownsS3Client) {
    (this.s3Client as { destroy?: () => void }).destroy?.();
  }
  this.s3Client = replacement;
  this.ownsS3Client = true;
}

/**
 * Resolve the response bucket's actual region and, if it differs from the
 * current S3 client's configured region, swap in a region-corrected client
 * before any response-bucket S3 operation (placeholder `PutObject`,
 * pre-signed `ResponseURL` signing, response polling, cleanup).
 *
 * The response bucket is cdkd's state bucket, which can live in a
 * different region from the deploy region (`cdkd deploy --region` /
 * `AWS_REGION` against the account-scoped region-free default bucket).
 * A pre-signed URL's host is region-specific, so signing with the deploy
 * region against a foreign-region bucket makes S3 return a
 * 301 PermanentRedirect (issue #1195). Mirrors the lazy
 * `ensureClientForBucket()` correction the state backend (#60), the
 * LockManager (#803), and the ExportIndexStore (#819) already do via the
 * shared `rebuildClientForBucketRegion` helper (#827).
 *
 * `tolerateNonStandardClient` keeps test doubles (a bare `{ send }`
 * object from a mocked `getAwsClients`) on the no-rebuild path, and
 * `resolveBucketRegion` never throws (probe failures degrade to
 * "no rebuild"), so this can only improve the client's region.
 */
export async function ensureResponseClient(this: CustomResourceProvider): Promise<void> {
  if (this.responseClientResolved || !this.responseBucket) return;
  if (this.responseClientResolveInFlight) return this.responseClientResolveInFlight;

  const bucket = this.responseBucket;
  const generation = this.responseClientGeneration;
  this.responseClientResolveInFlight = (async (): Promise<void> => {
    try {
      const replacement = await rebuildClientForBucketRegion(this.s3Client, bucket, {
        reuseClientCredentials: true,
        tolerateNonStandardClient: true,
        onRebuild: ({ bucketRegion, currentRegion }) => {
          // The THIRD render of `this.responseBucket` in this file (issue
          // [#2635] review). The other two are sanitized, and the argument
          // in `generatePresignedResponseUrl`'s comment applies here
          // verbatim -- sanitizing two of three is the widening-by-hand
          // shape `src/utils/display-safe.ts` exists to stop. `bucketRegion`
          // and `currentRegion` both come off the WIRE.  `bucketRegion` is
          // the result of `resolveBucketRegion`
          // (`src/utils/aws-region-resolver.ts`), which
          // `bucket-region-client.ts` calls at its line ~165;
          // `currentRegion` is read there at ~146 off the client's own
          // `config.region()`, typed `unknown` precisely because a test
          // double can return anything. So they are the same
          // class as an AWS error message. All three take the `asciiOnly`
          // allowlist: a bucket name and a region name both have a known
          // ASCII charset.
          //
          // `displayIdent` is that allowlist plus the `UNRENDERABLE` floor,
          // and adds a boundary of its own, so no quotes are written around
          // any of them (go-to-k/cdkd#3617). The floor matters: a value with
          // nothing renderable left, or `undefined`, must not read as an
          // empty region -- and for `currentRegion` that would be a
          // REGRESSION, since the raw `String(currentRegion)` this replaced
          // rendered `undefined` visibly.
          this.logger.debug(
            `Custom resource response bucket ` +
              `${displayIdent(bucket)} is in ${displayIdent(bucketRegion)} (client was ` +
              `${displayIdent(currentRegion)}); building a ` +
              `region-corrected S3 client for response operations.`
          );
        },
      });
      if (generation !== this.responseClientGeneration) {
        // A setResponseBucket re-arm superseded this probe while it was
        // in flight — its result targets the OLD bucket; committing it
        // would pin the wrong client AND suppress the new bucket's
        // resolution. Discard it (the next operation re-probes).
        (replacement as { destroy?: () => void } | null)?.destroy?.();
        return;
      }
      if (replacement) {
        this.replaceS3Client(replacement);
      }
      this.responseClientResolved = true;
    } finally {
      if (generation === this.responseClientGeneration) {
        this.responseClientResolveInFlight = null;
      }
    }
  })();

  return this.responseClientResolveInFlight;
}

/**
 * Resolve {@link syntheticStackId} against this deploy's REAL account /
 * region / partition (issue #1866).
 *
 * REJECTS when STS cannot name the account and `AWS_ACCOUNT_ID` is unset
 * (issue [#1730](https://github.com/go-to-k/cdkd/issues/1730)): `StackId` is
 * a REQUIRED member of the request payload and has no honest stand-in, so the
 * create / update / delete fails BEFORE the handler is invoked rather than
 * handing it a `StackId` naming no account. A DELETE first asks again on
 * {@link DELETE_ACCOUNT_LOOKUP_RETRY_DELAYS_MS}, since a Delete that is never
 * sent can orphan what the handler manages. It is resolved ONCE per `create`
 * / `update` / `delete` rather than per invocation attempt: the value does not
 * vary between attempts, and the request builder the retry loop re-runs is
 * synchronous.
 */
export async function resolveSyntheticStackId(
  this: CustomResourceProvider,
  logicalId: string,
  operation: string,
  watch: InterruptWatch
): Promise<string> {
  const retryDelays = operation === 'Delete' ? DELETE_ACCOUNT_LOOKUP_RETRY_DELAYS_MS : [];
  for (let attempt = 0; ; attempt++) {
    try {
      return syntheticStackId(logicalId, await getAccountInfo(this.configuredRegion));
    } catch (error) {
      const delayMs = retryDelays[attempt];
      if (!(error instanceof AccountIdUnavailableError) || delayMs === undefined) throw error;
      this.logger.warn(
        `Custom resource ${logicalId}: the Delete request cannot be sent until the account is ` +
          `known: ${error.message} Asking again in ${delayMs / 1000}s ` +
          `(attempt ${attempt + 1}/${retryDelays.length + 1}).`
      );
      await this.sleepInterruptibly(delayMs, watch);
    }
  }
}

/**
 * The `create()` / `update()` failure wrap. A method, so
 * `gen-update-wrap-coverage` sees the catch that throws it as a wrap.
 *
 * An AWS-authored failure (an `Invoke`, `Publish` or response-placeholder
 * `PutObject` rejection) reaches `build` as its CLASS plus the `--verbose`
 * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
 * `deployments/{runId}.jsonl`, and an `AccessDeniedException` names the
 * caller's assumed-role ARN. AWS's own text goes to `debug`, masked, since
 * it can quote a rejected request value. A cdkd-authored error (the
 * handler's FAILED reason, a readiness-waiter failure, a timeout) keeps its
 * text. A non-`Error` throw is withheld the same way. The caught error stays
 * the `cause` (the persisted `awsErrorCode` / `requestId` come from it) and
 * the wrap is `markRedactedCause`d, so any chain-reading classifier still
 * sees AWS's wording. The IAM-propagation retry does not depend on either:
 * it runs inside `invokeCustomResourceWithRetry` (`isTransientAuthzThrow`)
 * on the raw error, before this wrap, and `disableOuterRetry` keeps the
 * outer `withRetry` from ever classifying the wrap.
 * No "already exists" restatement: every AWS call here acts on something
 * other than the custom resource (`markAuxiliaryFailure`, #3826), so none
 * can be this resource's name collision.
 */
export function wrapCaughtError(
  this: CustomResourceProvider,
  mask: MaskerFn | undefined,
  error: unknown,
  build: (text: string) => ProvisioningError
): ProvisioningError {
  const failure = describeAwsFailure(error);
  if (!failure.redacted) return build(failure.detail);
  this.logger.debug(maskerOrIdentity(mask)(build(failure.detail).message));
  // A non-`Error` throw has no chain for the stamp to name.
  const wrapped = build(failure.summary);
  return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
}

/**
 * Create a custom resource by invoking its Lambda handler
 */
export async function create(
  this: CustomResourceProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating custom resource ${logicalId} (${resourceType})`);

  const serviceToken = properties['ServiceToken'];

  if (!serviceToken) {
    throw new ProvisioningError(
      `ServiceToken is required for custom resource ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  if (typeof serviceToken !== 'string') {
    throw new ProvisioningError(
      `Custom Resource ${logicalId}: ServiceToken is not a resolved string ARN (got ${typeof serviceToken}). ` +
        CR_UNRESOLVED_TOKEN_CREATE_REMEDY,
      resourceType,
      logicalId
    );
  }

  this.refuseResolvedSecret(logicalId, resourceType, properties);

  try {
    const cfnResponse = await this.invokeCustomResourceWithRetry(
      serviceToken,
      logicalId,
      'Create',
      (invocation) => ({
        RequestType: 'Create',
        RequestId: invocation.requestId,
        ResponseURL: invocation.responseURL,
        ResourceType: resourceType,
        LogicalResourceId: logicalId,
        StackId: invocation.stackId,
        ResourceProperties: this.stringifyProperties(properties),
      }),
      // Issue #2178: the handler's response can echo the RESOLVED
      // `ResourceProperties` back, so the payload refusal masks before it
      // stringifies. Absent means unmasked.
      maskerOrIdentity(context?.maskSecrets),
      { properties }
    );

    if (cfnResponse.Status === 'FAILED') {
      throw new Error(
        `Custom resource handler returned FAILED: ${cfnResponse.Reason || 'Unknown reason'}`
      );
    }

    // go-to-k/cdkd#3211: an id cdkd could not address later (blank,
    // whitespace-only or not a string) is read as ABSENT, the fallback an
    // empty one always took. Recorded, it would refuse every later update
    // and skip every delete of this resource.
    const physicalId: string = respondedPhysicalId(cfnResponse) ?? logicalId;
    const attributes: Record<string, unknown> = cfnResponse.Data || {};

    this.logger.debug(`Successfully created custom resource ${logicalId}: ${physicalId}`);

    // Issue #2274: relay the handler's own `NoEcho` declaration to the deploy
    // engine, which turns it into MASK-ONLY redaction needles so the
    // generated value never reaches `state.json`. NOT masked here: the
    // attributes returned from this method are what `Fn::GetAtt` resolves
    // to, and CloudFormation delivers that value to a dependent resource in
    // the CLEAR (measured on the issue thread against real CFn). Masking at
    // capture would store the literal mask as the dependent's real property.
    return {
      physicalId,
      attributes,
      ...(cfnResponse.NoEcho === true && { noEchoAttributes: true }),
    };
  } catch (error) {
    // Every AWS call here acts on something other than the custom resource
    // (the handler function, the response object, the SNS topic): none can
    // be this resource's name collision (#3826).
    markAuxiliaryFailure(error, logicalId);
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create custom resource ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}

/**
 * Update a custom resource by invoking its Lambda handler
 */
export async function update(
  this: CustomResourceProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  this.logger.debug(`Updating custom resource ${logicalId}: ${physicalId} (${resourceType})`);

  const serviceToken = properties['ServiceToken'];

  if (!serviceToken) {
    throw new ProvisioningError(
      `ServiceToken is required for custom resource ${logicalId}`,
      resourceType,
      logicalId,
      physicalId
    );
  }

  if (typeof serviceToken !== 'string') {
    throw new ProvisioningError(
      `Custom Resource ${logicalId}: ServiceToken is not a resolved string ARN (got ${typeof serviceToken}). ` +
        crUnresolvedTokenUpdateRemedy(),
      resourceType,
      logicalId,
      physicalId
    );
  }

  this.refuseResolvedSecret(logicalId, resourceType, properties, physicalId, previousProperties);

  try {
    const cfnResponse = await this.invokeCustomResourceWithRetry(
      serviceToken,
      logicalId,
      'Update',
      (invocation) => ({
        RequestType: 'Update',
        RequestId: invocation.requestId,
        ResponseURL: invocation.responseURL,
        ResourceType: resourceType,
        LogicalResourceId: logicalId,
        PhysicalResourceId: physicalId,
        StackId: invocation.stackId,
        ResourceProperties: this.stringifyProperties(properties),
        OldResourceProperties: this.stringifyProperties(previousProperties),
      }),
      // Issue #2178: see `create()` — same payload refusal, same bag.
      maskerOrIdentity(context?.maskSecrets),
      { properties, previousProperties }
    );

    if (cfnResponse.Status === 'FAILED') {
      throw new Error(
        `Custom resource handler returned FAILED: ${cfnResponse.Reason || 'Unknown reason'}`
      );
    }

    // go-to-k/cdkd#3211: see `create()`. An unaddressable id keeps the
    // current one rather than reading as a REPLACEMENT.
    const newPhysicalId: string = respondedPhysicalId(cfnResponse) ?? physicalId;
    const wasReplaced: boolean = newPhysicalId !== physicalId;
    const attributes: Record<string, unknown> = cfnResponse.Data || {};

    this.logger.debug(
      `Successfully updated custom resource ${logicalId}: ${newPhysicalId}${wasReplaced ? ' (replaced)' : ''}`
    );

    // Issue #2274: see `create()` — same relay, same reason for not masking
    // here. `NoEcho` is per RESPONSE, so a handler that sets it on Create and
    // omits it on Update genuinely declares this response public; that is the
    // handler's contract to keep, and cdkd reports what it was told.
    return {
      physicalId: newPhysicalId,
      wasReplaced,
      attributes,
      ...(cfnResponse.NoEcho === true && { noEchoAttributes: true }),
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update custom resource ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}
