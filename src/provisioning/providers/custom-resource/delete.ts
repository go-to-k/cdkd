import type { CustomResourceProvider } from '../custom-resource-provider.js';
import { cdkdRemedy, proseQuoted } from '../../../utils/pasteable-command.js';
import { GetFunctionCommand } from '@aws-sdk/client-lambda';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import type { DeleteContext } from '../../region-check.js';
import { stateOrphanRecordRemedy } from '../../state-orphan-remedy.js';
import type { ResourceDeleteResult } from '../../../types/resource.js';
import type { MaskerFn } from '../../masked-retry-logger.js';
import { getCurrentResourceSecrets } from '../../../deployment/resource-secrets-scope.js';
import {
  carriesResolvedSecret,
  findResolvedSecretPaths,
} from '../../custom-resource-secure-references.js';
import {
  carriesSecretMask,
  dynamicReferenceTokens,
  SECRET_MASK,
} from '../../../deployment/secret-redaction.js';
import { applyNoEchoDeleteValues } from '../../../deployment/noecho-delete-reresolution.js';
import {
  deletePathMasker,
  CR_NO_PROPERTIES_SKIP_REASON,
  CR_NO_SERVICE_TOKEN_SKIP_REASON,
  CR_MASKED_SERVICE_TOKEN_SKIP_REASON,
  CR_NOECHO_PROPERTIES_SKIP_REASON,
  CR_MASKED_PROPERTIES_SKIP_REASON,
  NOECHO_RERESOLUTION_BOUND,
  noEchoPropertiesRemedy,
  CR_REFERENCE_SERVICE_TOKEN_SKIP_REASON,
  CR_DELETE_INVOKE_FAILED_SKIP_REASON,
  CR_DELETE_HANDLER_FAILED_SKIP_REASON,
  CR_BACKING_LAMBDA_GONE_SKIP_REASON,
  DEPLOY_SKIP_CAVEAT,
  handlerSkipRemedy,
  unresolvedTokenDeleteRemedy,
  unaddressableServiceTokenRemedy,
} from './delete-skip-reasons.js';
import { asSentence } from './lambda-payload.js';
import { SNS_SERVICE_TOKEN_ARN_RE } from './retry-policy.js';

/**
 * Delete a custom resource by invoking its Lambda handler
 */
export async function deleteImpl(
  this: CustomResourceProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void | ResourceDeleteResult> {
  // Custom resources delegate deletion to a user-provided Lambda handler.
  // The Lambda invocation itself does not surface a `*NotFound` for the
  // managed resource, so the region-mismatch check has no signal to act on
  // here; the underlying Lambda's region is determined by its ARN, which is
  // already encoded in the ServiceToken regardless of the cdkd client's
  // region. The context is read only for `stackDestroy`: the backing-Lambda-
  // gone outcome, and the remedy four skip warnings below name, depend on it.
  this.logger.debug(`Deleting custom resource ${logicalId}: ${physicalId} (${resourceType})`);

  // Issue #1770: the two arms below are SKIPS, not deletes. A custom
  // resource's teardown lives entirely in the user's handler, and the only
  // way to reach it is `ServiceToken`. Without it the handler never sees a
  // `Delete` request, so whatever the resource manages (records in a
  // third-party API, objects in another account, a DNS entry) is untouched.
  // The backing-Lambda-is-gone pre-check further down is a skip too on a
  // stack destroy (go-to-k/cdkd#2115): a handler that can never run again
  // proves nothing about what it manages.
  //
  // "LEFT IN PLACE" is unconditional for these two, unlike the
  // Lambda-permission / IAM-policy arms which qualify it: what survives is
  // whatever the user's handler provisioned OUTSIDE this stack (a record in a
  // third-party API, an object in another account), and no other delete in
  // this destroy can undo that. Deleting the backing Lambda does not either —
  // it only makes the teardown permanently unreachable.
  if (!properties) {
    this.logger.warn(
      `No properties available for custom resource ${logicalId}, skipping deletion — the ` +
        `handler is never invoked, so anything this custom resource manages is LEFT IN ` +
        `PLACE. Restore the record's properties in state.json and re-run, or tear the ` +
        `resource down by hand. ${DEPLOY_SKIP_CAVEAT}`
    );
    return { outcome: 'skipped', reason: CR_NO_PROPERTIES_SKIP_REASON };
  }

  const serviceToken = properties['ServiceToken'];

  if (!serviceToken) {
    this.logger.warn(
      `No ServiceToken found for custom resource ${logicalId}, skipping deletion — there is ` +
        `no handler to send the Delete request to, so anything this custom resource manages ` +
        `is LEFT IN PLACE. Restore ServiceToken in state.json and re-run, or tear the ` +
        `resource down by hand. ${DEPLOY_SKIP_CAVEAT}`
    );
    return { outcome: 'skipped', reason: CR_NO_SERVICE_TOKEN_SKIP_REASON };
  }

  if (typeof serviceToken !== 'string') {
    throw new ProvisioningError(
      `Custom Resource ${logicalId}: ServiceToken is not a resolved string ARN (got ${typeof serviceToken}). ` +
        `This usually indicates state was written by a pre-fix cdkd import; ` +
        unresolvedTokenDeleteRemedy(context, logicalId),
      resourceType,
      logicalId,
      physicalId
    );
  }

  // go-to-k/cdkd#3938: a SKIP, for the same reason as the no-ServiceToken arm
  // above — what names the handler is not in the record. The mask must never
  // reach Lambda: it names no function, so the issue-#804 pre-check and the
  // invoke fail with an AWS error that says nothing about the mask, and a
  // `ResourceNotFoundException` there would be reported as "backing Lambda
  // gone", naming the wrong cause and the wrong repair. Re-deploying does not repair
  // the record while the NoEcho attribute still carries that value: the
  // same needle masks the same leaf again.
  if (carriesSecretMask(serviceToken)) {
    this.logger.warn(
      safeMsg`ServiceToken for custom resource ${logicalId} is recorded in state as the redaction ` +
        safeMsg`mask '${SECRET_MASK}' (a NoEcho value this resource reads equals, or is contained ` +
        `in, its ServiceToken), so cdkd cannot address the handler; skipping deletion — ` +
        `anything this custom resource manages is LEFT IN PLACE. Re-deploying does not repair ` +
        `the record while that attribute still carries the value. ` +
        // go-to-k/cdkd#4596: the `cdkd state orphan` remedy only on a stack destroy.
        safeMsg`${unaddressableServiceTokenRemedy(context, logicalId)}`
    );
    return { outcome: 'skipped', reason: CR_MASKED_SERVICE_TOKEN_SKIP_REASON };
  }

  // go-to-k/cdkd#3960: the other redaction channel. A secret reference is
  // persisted as its `{{resolve:...}}` EXPRESSION, which names no function
  // either — it fails `GetFunction`'s name validation exactly as the mask
  // does, which on #3938's pre-fix run left the issue-#804 pre-check
  // inconclusive and the readiness waiter polling for its full 10 minutes
  // before the invoke failed. ANY token, not only a whole-leaf one: an ARN
  // assembled around a reference cannot be addressed either. The
  // expression itself is template text, but it is still not interpolated —
  // the logical id names the record well enough.
  if (dynamicReferenceTokens(serviceToken).length > 0) {
    this.logger.warn(
      safeMsg`ServiceToken for custom resource ${logicalId} is recorded in state as a ` +
        `'{{resolve:...}}' dynamic reference, which cdkd does not resolve on delete, so it ` +
        `cannot address the handler; skipping deletion — anything this custom resource ` +
        `manages is LEFT IN PLACE. CloudFormation does not support secure (secretsmanager / ` +
        `ssm-secure) dynamic references in custom resources, and cdkd now refuses such a ` +
        `template at deploy time. ` +
        safeMsg`${unaddressableServiceTokenRemedy(context, logicalId)}`
    );
    return { outcome: 'skipped', reason: CR_REFERENCE_SERVICE_TOKEN_SKIP_REASON };
  }

  // go-to-k/cdkd#4043: the handler would receive `***` where a `NoEcho`
  // parameter value stood. Below the ServiceToken arms (an unaddressable
  // handler is the more basic cause) and above any AWS call. A caller that
  // holds the template re-resolved those coordinates (go-to-k/cdkd#4682):
  // the payload carries today's values, the record keeps the mask.
  const reresolved = context?.noEchoDeleteValues;
  const { payload, unresolved } = applyNoEchoDeleteValues(
    properties,
    context?.recordedNoEchoLeaves,
    reresolved
  );
  if (unresolved.length > 0) {
    const maskedNoEchoPaths = unresolved.map((coordinate) => coordinate.join('.'));
    this.logger.warn(
      safeMsg`Custom resource ${logicalId} is recorded in state with ${maskedNoEchoPaths.join(', ')} ` +
        `holding the '***' mask of a NoEcho value (a NoEcho parameter, or an attribute declared ` +
        `NoEcho), which cdkd does not keep, so its handler would receive the mask in ` +
        `ResourceProperties; skipping deletion — the handler is not invoked, so anything this ` +
        `custom resource manages is LEFT IN PLACE. ${NOECHO_RERESOLUTION_BOUND} ` +
        safeMsg`${noEchoPropertiesRemedy(context, logicalId)}`
    );
    return { outcome: 'skipped', reason: CR_NOECHO_PROPERTIES_SKIP_REASON };
  }
  // go-to-k/cdkd#4682 (the issue's second decision): a mask NO coordinate
  // names (one embedded through `Fn::Join`, a pre-v11 record, an import or
  // scrub record) is not re-resolvable either, and sending it is the same
  // hazard: a tolerant handler answers SUCCESS on `***` and the record is
  // dropped over whatever it manages.
  if (carriesSecretMask(payload)) {
    this.logger.warn(
      safeMsg`Custom resource ${logicalId} is recorded in state with a property holding the ` +
        `'***' redaction mask, which no NoEcho coordinate of the record names, so cdkd cannot ` +
        `re-resolve it and its handler would receive the mask in ResourceProperties; skipping ` +
        `deletion — the handler is not invoked, so anything this custom resource manages is ` +
        safeMsg`LEFT IN PLACE. For a record 'cdkd import' or 'cdkd scrub' wrote, a ${proseQuoted(cdkdRemedy('cdkd deploy'))} of the ` +
        safeMsg`app first records which positions hold a NoEcho value, after which ${proseQuoted(cdkdRemedy('cdkd destroy'))} ` +
        `sends the delete. ` +
        safeMsg`${noEchoPropertiesRemedy(context, logicalId)}`
    );
    return { outcome: 'skipped', reason: CR_MASKED_PROPERTIES_SKIP_REASON };
  }
  // The re-resolved values' masker, for every message below that can carry
  // a payload value (the handler's reason, its log, an invoke error).
  const deleteMask: MaskerFn | undefined = deletePathMasker(
    context?.maskSecrets,
    payload === properties ? undefined : reresolved?.maskSecrets
  );
  const show = (text: string): string => (deleteMask === undefined ? text : deleteMask(text));

  // Fail-fast for re-run idempotency (issue #804): after an interrupted /
  // partially-failed destroy, the preserved state can still list a Custom
  // Resource whose backing Lambda was ALSO deleted in the first run. The
  // delete handler can never run again in that case — but without this
  // pre-check, `waitForBackingLambdaReady`'s SDK waiters classify
  // `ResourceNotFoundException` as RETRY (no error acceptor) and poll
  // GetFunction for the full 10-minute `maxWaitTime` before the lenient
  // catch below swallows the timeout. One GetFunction up front turns that
  // stall into an instant answer. Delete-only: create / update against a
  // missing function must keep failing loudly through the normal invoke path.
  //
  // On a STACK DESTROY the answer is a SKIP (go-to-k/cdkd#2115); on a
  // deploy-engine delete it stays a loud warn-and-drop. See
  // {@link CR_BACKING_LAMBDA_GONE_SKIP_REASON} for why the phases differ.
  if (!this.isSnsServiceToken(serviceToken) && (await this.isBackingLambdaGone(serviceToken))) {
    if (context?.stackDestroy === true) {
      // No DEPLOY_SKIP_CAVEAT: this arm is reached only from a destroy.
      this.logger.warn(
        safeMsg`Backing Lambda for custom resource ${logicalId} no longer exists (${serviceToken}), so ` +
          `its Delete handler cannot be invoked and cdkd cannot confirm the resource was ` +
          `deleted; skipping deletion — anything this custom resource manages may still be ` +
          `LIVE. cdkd is KEEPING the state record and the run exits non-zero, as CloudFormation ` +
          `leaves such a stack DELETE_FAILED. A re-run skips it again unless a function with ` +
          `that exact ARN exists again (e.g. a shared provider stack destroyed before this one, ` +
          `then redeployed). Otherwise confirm by hand that whatever it manages is gone (or tear ` +
          `it down), then drop the record with ` +
          safeMsg`${stateOrphanRecordRemedy(context, logicalId)}.`
      );
      return { outcome: 'skipped', reason: CR_BACKING_LAMBDA_GONE_SKIP_REASON };
    }
    this.logger.warn(
      safeMsg`Backing Lambda for custom resource ${logicalId} no longer exists (${serviceToken}); ` +
        `treating the custom resource as already deleted and DROPPING its state record, as ` +
        `CloudFormation ignores a delete failure in an update's cleanup phase. The handler ` +
        `can never run again, so if its teardown was never PROVEN, whatever it manages may ` +
        `still be LIVE and is now untracked by cdkd. Check for leftovers by hand.`
    );
    return;
  }

  try {
    const cfnResponse = await this.invokeCustomResourceWithRetry(
      serviceToken,
      logicalId,
      'Delete',
      (invocation) => ({
        RequestType: 'Delete',
        RequestId: invocation.requestId,
        ResponseURL: invocation.responseURL,
        ResourceType: resourceType,
        LogicalResourceId: logicalId,
        PhysicalResourceId: physicalId,
        StackId: invocation.stackId,
        ResourceProperties: this.stringifyProperties(payload),
      }),
      // See deletePathMasker (go-to-k/cdkd#2007, go-to-k/cdkd#4682).
      deleteMask
    );

    // Issue #2054: the handler RAN and said it did not delete. This arm used
    // to warn and fall through to `return undefined`, which `deleteSkipReason`
    // reads as DELETED — so the record was dropped, the row printed as
    // deleted and the destroy exited 0 over a resource the handler had
    // explicitly refused to remove. Same silent-orphan class as the catch
    // below (issue #2033) and the two guard arms above (issue #1752),
    // reached through the RESPONSE rather than a throw. See
    // {@link CR_DELETE_HANDLER_FAILED_SKIP_REASON} for why this is
    // unconditional (no already-gone classifier) and for the compatibility
    // break it carries.
    if (cfnResponse.Status === 'FAILED') {
      this.logger.warn(
        show(
          `Custom resource delete handler returned FAILED for ${logicalId}: ` +
            `${cfnResponse.Reason || 'Unknown reason'}. The handler reported that it did NOT ` +
            `delete, so anything this custom resource manages is LEFT IN PLACE${handlerSkipRemedy(context, logicalId)}`
        )
      );
      return { outcome: 'skipped', reason: CR_DELETE_HANDLER_FAILED_SKIP_REASON };
    }
    this.logger.debug(`Successfully deleted custom resource ${logicalId}`);
  } catch (error) {
    // Issue #2033: lenient, but NOT silent. This catch used to swallow the
    // error and fall through to `return undefined`, which `deleteSkipReason`
    // reads as DELETED — so `cdkd destroy` printed `✓ … deleted`, dropped the
    // state record and exited 0 over a handler that never received a
    // `Delete`. A permanent `lambda:InvokeFunction` denial therefore silently
    // ORPHANED everything that handler manages, with the id needed to reach
    // it deleted in the same breath.
    //
    // It is the same silent-orphan class the two guard arms above already
    // report as `'skipped'` (issue #1752); the only difference is that this
    // one is reached through a throw. Continuing to warn-and-continue is
    // still right — a destroy must not abort on one custom resource — but the
    // OUTCOME has to say the resource is unproven, so the runner keeps the
    // record, counts it apart and exits 2.
    //
    // The AWS message goes in the WARNING, never in the `reason`: a reason is
    // rendered into the `Error` the deploy-side replacement sites throw, and
    // their catch classifies "already deleted" by substring, so an AWS text
    // carrying `does not exist` would put the record right back in the bin.
    //
    // The class at warn, AWS's sentence at debug (go-to-k/cdkd#2319): a
    // denied `Invoke` names the caller's assumed-role ARN, which the masker
    // does not cover.
    const failure = describeAwsFailure(error);
    this.logger.warn(
      show(
        `Failed to delete custom resource ${logicalId}, but continuing: ${asSentence(failure.summary)} ` +
          `The Delete handler did not complete, so anything this custom resource manages may still ` +
          `be LIVE${handlerSkipRemedy(context, logicalId)}`
      )
    );
    if (failure.redacted) {
      this.logger.debug(
        show(`Custom resource ${logicalId} delete failure detail: ${failure.detail}`)
      );
    }
    return { outcome: 'skipped', reason: CR_DELETE_INVOKE_FAILED_SKIP_REASON };
  }
}

/**
 * Refuse to send a handler an event carrying a secret's PLAINTEXT
 * (go-to-k/cdkd#4009). CloudFormation does not support secure dynamic
 * references in custom resources; the template pre-flight
 * (`custom-resource-secure-references.ts`, #3976) refuses the spellings it
 * can see, and this catches the rest at the only point that sees the resolved
 * value: a plain `ssm` reference to a SecureString, a nested child reading a
 * parent parameter resolved from a secret, and a rollback replay re-resolving
 * a recorded reference. The test is the bag the caller bound for THIS
 * resource (`carriesResolvedSecret`), so a transformed secret -- base64, a
 * fragment -- is refused too; the paths only NAME where it sits. On an update
 * both sides count: `previousProperties` is sent as `OldResourceProperties`,
 * and `cdkd rollback --revert-failed` re-resolves a failed op's attempted
 * properties into exactly that side.
 *
 * Not downgraded on a replay (`replayingState`), deliberately: this is a
 * disclosure guard, not a template pre-flight, and the downgrade would send
 * the plaintext to the handler -- which `provider-replay-and-refusals.md`
 * does not license ("no relaxing of data-safety guards"). A refused replay
 * leaves that resource's rollback op failed and recoverable; a leaked secret
 * is not. Marked non-retryable: nothing a retry does changes the bag.
 *
 * The message names property PATHS only, never a value.
 */
export function refuseResolvedSecret(
  this: CustomResourceProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  physicalId?: string,
  previousProperties?: Record<string, unknown>
): void {
  const secrets = getCurrentResourceSecrets();
  if (!carriesResolvedSecret(secrets)) return;
  const paths = [
    ...findResolvedSecretPaths(properties, secrets),
    ...findResolvedSecretPaths(previousProperties, secrets).map(
      (path) => `OldResourceProperties.${path}`
    ),
  ];
  const where =
    paths.length > 0
      ? paths.join(', ')
      : 'a property (in a form cdkd cannot point to, e.g. base64-encoded or a fragment)';
  throw markNonRetryable(
    new ProvisioningError(
      `Custom resource ${logicalId}: ${where} resolved to the value of a secret ` +
        `(a Secrets Manager secret, or an SSM SecureString parameter -- including one read ` +
        `through a plain {{resolve:ssm:...}} reference or a nested stack parameter). ` +
        `CloudFormation does not support secure dynamic references in custom resources, so ` +
        `cdkd does not send the secret's value to the handler. Pass the secret's name or ARN ` +
        `instead and have the handler read it.`,
      resourceType,
      logicalId,
      physicalId
    )
  );
}

/**
 * Check if a ServiceToken is an SNS topic ARN.
 *
 * This is the SNS-vs-Lambda routing decision for the whole provider — it
 * gates `sendRequest` (publish to SNS + poll S3 vs synchronous Invoke), the
 * delete path's backing-Lambda pre-check, and `recycleBackingFunctionExecEnv`.
 * A hardcoded `arn:aws:` prefix therefore did not merely record a wrong
 * string outside the commercial partition: an `arn:aws-cn:sns:` /
 * `arn:aws-us-gov:sns:` ServiceToken was classified Lambda-backed and every
 * one of those paths took the wrong branch (issue #1815). See
 * {@link SNS_SERVICE_TOKEN_ARN_RE} for why the partition is read off the ARN.
 */
export function isSnsServiceToken(this: CustomResourceProvider, serviceToken: string): boolean {
  return SNS_SERVICE_TOKEN_ARN_RE.test(serviceToken);
}

/**
 * Single GetFunction probe used by the delete path's fail-fast pre-check
 * (issue #804). Returns true ONLY on a definitive
 * `ResourceNotFoundException` — the one signal that proves the backing
 * Lambda is gone and the delete handler can never run. Any other failure
 * (throttle, IAM denial, network) is inconclusive: fall through to the
 * normal invoke path, which has its own error handling and the lenient
 * delete catch.
 */
export async function isBackingLambdaGone(
  this: CustomResourceProvider,
  serviceToken: string
): Promise<boolean> {
  try {
    await this.lambdaClient.send(new GetFunctionCommand({ FunctionName: serviceToken }));
    return false;
  } catch (error) {
    if ((error as { name?: string }).name === 'ResourceNotFoundException') {
      return true;
    }
    this.logger.debug(
      `GetFunction pre-check for ${serviceToken} failed inconclusively (${
        describeAwsFailure(error).detail
      }); proceeding with the normal delete invoke`
    );
    return false;
  }
}
