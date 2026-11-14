import type { LambdaFunctionProvider } from '../lambda-function-provider.js';
import {
  describeAwsFailure,
  safeStringify,
  type AwsFailureText,
} from '../../../utils/aws-failure-text.js';
import {
  CreateFunctionCommand,
  DeleteFunctionCommand,
  PutFunctionConcurrencyCommand,
  PutFunctionRecursionConfigCommand,
  PutRuntimeManagementConfigCommand,
  PutFunctionScalingConfigCommand,
  GetFunctionConfigurationCommand,
  type CapacityProviderConfig,
  type FunctionScalingConfig,
  waitUntilFunctionActiveV2,
  type CreateFunctionCommandInput,
  type Runtime,
  type Architecture,
  type TracingConfig,
  type EphemeralStorage,
  type DeadLetterConfig,
  type FileSystemConfig,
  type ImageConfig,
  type SnapStart,
  type LoggingConfig,
  type RecursiveLoop,
  type DurableConfig,
  type TenancyConfig,
  type UpdateRuntimeOn,
} from '@aws-sdk/client-lambda';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markRedactedCause } from '../../../deployment/retryable-errors.js';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import { generatedNameFor } from '../../resource-name.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource, retractCreatedResource } from '../../created-resource-sink.js';
import type { CreateContext, ResourceCreateResult } from '../../../types/resource.js';
import { functionAttributes } from './attributes.js';
import type { MaskedLogSinks } from '../../masked-retry-logger.js';
import {
  functionIdentityToken,
  lambdaOperationSinks,
  withholdWaiterPayload,
  LAMBDA_CLEANUP_DELETE_MAX_ATTEMPTS,
  LATEST_PUBLISHED,
  refuseManagedInstancesPropertiesWithoutCapacityProvider,
  refuseImageFunctionUnsupported,
} from './shared.js';

/**
 * Create a Lambda function
 */
export async function create(
  this: LambdaFunctionProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  const functionName =
    (properties['FunctionName'] as string | undefined) ||
    generatedNameFor('AWS::Lambda::Function', logicalId);
  // Issue #2177: every create() line and refusal goes through this one sink
  // set. A provider's own logger reaches no engine mask.
  const log = lambdaOperationSinks(
    this.logger,
    context?.maskSecrets,
    [[properties['FunctionName'], functionName]],
    properties
  );

  log.debug(`Creating Lambda function ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

  const code = properties['Code'] as Record<string, unknown> | undefined;
  const role = properties['Role'] as string | undefined;

  if (!code) {
    throw new ProvisioningError(
      `Code is required for Lambda function ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  if (!role) {
    throw new ProvisioningError(
      `Role is required for Lambda function ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  refuseImageFunctionUnsupported(logicalId, resourceType, properties);
  refuseManagedInstancesPropertiesWithoutCapacityProvider(
    logicalId,
    resourceType,
    properties,
    { replayingState: context?.replayingState },
    log.warn
  );

  // Set once CreateFunction returns: every failure after it is an auxiliary
  // call's and must not classify as this function's name collision (#3826).
  let functionCreated = false;
  // go-to-k/cdkd#4583: the created function's name, and whether a post-create
  // call's atomicity cleanup deleted it, for the failed-CREATE journal mark.
  let createdFunctionName: string | undefined;
  // go-to-k/cdkd#4606: the identity CreateFunction's response names, carried
  // on the mark so the journal needs no read of a function whose failure
  // may fail that read too.
  let createdFunctionIdentity: string | undefined;
  const postCreateCleanup = { deleted: false };
  try {
    // Build tags map from CDK tag format [{Key, Value}]
    const tags: Record<string, string> | undefined = properties['Tags']
      ? Object.fromEntries(desiredTags.map((tag) => [tag.Key, tag.Value]))
      : undefined;

    const capacityProviderConfig = properties['CapacityProviderConfig'] as
      | CapacityProviderConfig
      | undefined;
    const createParams: CreateFunctionCommandInput = {
      FunctionName: functionName,
      Role: role,
      Code: this.buildCode(code, properties['Runtime'] as string | undefined),
      Handler: properties['Handler'] as string | undefined,
      Runtime: properties['Runtime'] as Runtime | undefined,
      Timeout: properties['Timeout'] as number | undefined,
      MemorySize: properties['MemorySize'] as number | undefined,
      Description: properties['Description'] as string | undefined,
      Environment: properties['Environment'] as { Variables?: Record<string, string> } | undefined,
      Layers: properties['Layers'] as string[] | undefined,
      Architectures: properties['Architectures'] as Architecture[] | undefined,
      PackageType: properties['PackageType'] as 'Zip' | 'Image' | undefined,
      TracingConfig: properties['TracingConfig'] as TracingConfig | undefined,
      EphemeralStorage: properties['EphemeralStorage'] as EphemeralStorage | undefined,
      VpcConfig: this.buildVpcConfig(properties['VpcConfig']),
      DeadLetterConfig: properties['DeadLetterConfig'] as DeadLetterConfig | undefined,
      // CFn names this `KmsKeyArn`; the Lambda SDK input field is `KMSKeyArn`.
      KMSKeyArn: properties['KmsKeyArn'] as string | undefined,
      FileSystemConfigs: properties['FileSystemConfigs'] as FileSystemConfig[] | undefined,
      ImageConfig: properties['ImageConfig'] as ImageConfig | undefined,
      SnapStart: properties['SnapStart'] as SnapStart | undefined,
      LoggingConfig: properties['LoggingConfig'] as LoggingConfig | undefined,
      // Durable-execution retention / timeout. CREATE-ONLY IN PRACTICE
      // even though UpdateFunctionConfiguration declares the member:
      // AWS rejects adding one to a function created without it
      // ("You cannot add a durable configuration to a function that was
      // originally created with no durable configuration" —
      // InvalidParameterValueException, live-probed us-east-1 2026-08-11),
      // and omitting it on update KEEPS the live value rather than
      // resetting it. Both transitions are therefore routed to REPLACEMENT
      // by the conditional rule in `replacement-rules.ts`; a change with
      // the block present on both sides IS applied in place.
      DurableConfig: properties['DurableConfig'] as DurableConfig | undefined,
      // Tenant isolation mode. Create-only per the CFn registry schema
      // (`createOnlyProperties`) AND per the SDK — the member exists on
      // CreateFunctionRequest and NOT on UpdateFunctionConfigurationRequest.
      TenancyConfig: properties['TenancyConfig'] as TenancyConfig | undefined,
      // Code-signing enforcement. Settable on create; on update it moves to
      // the separate Put/DeleteFunctionCodeSigningConfig control-plane pair
      // (there is no member on UpdateFunctionConfiguration).
      CodeSigningConfigArn: properties['CodeSigningConfigArn'] as string | undefined,
      Tags: tags,
      ...(capacityProviderConfig !== undefined && {
        CapacityProviderConfig: capacityProviderConfig,
        // A Managed Instances function runs only from a published version,
        // so its create always publishes, whatever
        // `PublishToLatestPublished` says: CloudFormation sends these two
        // with the flag false too, and a create with `PublishTo` alone
        // publishes nothing (CloudTrail + live, us-east-1, go-to-k/cdkd#5637).
        Publish: true,
        PublishTo: 'LATEST_PUBLISHED' as const,
      }),
    };

    const createClient = await this.createClient.get();
    const response = await createClient.send(new CreateFunctionCommand(createParams));
    functionCreated = true;
    createdFunctionName = response.FunctionName || functionName;
    createdFunctionIdentity = functionIdentityToken(response.FunctionArn, response.LastModified);
    // go-to-k/cdkd#5511: reported before any post-create wait.
    reportCreatedResource(logicalId, resourceType, createdFunctionName, createdFunctionIdentity);

    // A Managed Instances function is not done at CreateFunction: the
    // version it publishes launches the capacity (minutes), and that version
    // refuses PutFunctionScalingConfig until it settles, so this create waits
    // in every mode, as the same function does on CloudFormation. It is not
    // the only Lambda create that waits: RuntimeManagementConfig below does.
    // The later Puts and this publish may move `LastModified`, so the token
    // is dropped as for RuntimeManagementConfig below (go-to-k/cdkd#4606).
    if (capacityProviderConfig !== undefined) {
      createdFunctionIdentity = undefined;
      reportCreatedResource(logicalId, resourceType, createdFunctionName);
      const target = { logicalId, resourceType, functionName };
      await this.applyPostCreateConfig(
        () => this.waitForLatestPublishedSettled(target, log, 'after'),
        {
          apiName: 'GetFunctionConfiguration',
          propertyName: 'CapacityProviderConfig',
          logicalId,
          resourceType,
          functionName,
          log,
          cleanup: postCreateCleanup,
          awaitGone: capacityProviderConfig !== undefined,
        }
      );
      const functionScalingConfig = properties['FunctionScalingConfig'] as
        | FunctionScalingConfig
        | undefined;
      if (functionScalingConfig !== undefined) {
        await this.applyPostCreateConfig(
          () => this.putFunctionScalingConfig(target, log, functionScalingConfig),
          {
            apiName: 'PutFunctionScalingConfig',
            propertyName: 'FunctionScalingConfig',
            logicalId,
            resourceType,
            functionName,
            log,
            cleanup: postCreateCleanup,
            awaitGone: capacityProviderConfig !== undefined,
          }
        );
      }
    }

    // RecursiveLoop is a post-create control-plane prop: AWS sets it via
    // a SEPARATE `PutFunctionRecursionConfig` API, NOT on `CreateFunction`.
    // Wire it after a successful function create. If this call fails, the
    // function exists on AWS without the user-requested config — clean up
    // by deleting the function (atomicity) so the next deploy retry sees
    // a fresh slate instead of an orphan that already exists.
    //
    // VPC-attached Lambda caveat: the cleanup uses a bare `DeleteFunction`
    // (not the provider's own `delete()`), so hyperplane ENIs are NOT
    // pre-detached / awaited. For a VPC-attached function whose Put
    // fails, the next deploy retry's downstream Subnet/SG creation can
    // race the asynchronous ENI release (5-30min in practice) until AWS
    // finishes the detach. The "concurrent update operation" substring
    // is preserved in the wrapped error message so the outer
    // `withRetry` classifier still retries cleanly; non-transient Put
    // failures surface to the user as the named ProvisioningError below.
    const recursiveLoop = properties['RecursiveLoop'] as RecursiveLoop | undefined;
    if (recursiveLoop !== undefined) {
      await this.applyPostCreateConfig(
        () =>
          this.lambdaClient.send(
            new PutFunctionRecursionConfigCommand({
              FunctionName: functionName,
              RecursiveLoop: recursiveLoop,
            })
          ),
        {
          apiName: 'PutFunctionRecursionConfig',
          propertyName: 'RecursiveLoop',
          logicalId,
          resourceType,
          functionName,
          log,
          cleanup: postCreateCleanup,
          awaitGone: capacityProviderConfig !== undefined,
        }
      );
    }

    // ReservedConcurrentExecutions: post-create control-plane prop set
    // via a SEPARATE `PutFunctionConcurrency` API (NOT on CreateFunction).
    // Same atomicity contract as RecursiveLoop above: on failure delete
    // the just-created function so the next deploy retry sees a fresh
    // slate. The VPC ENI caveat applies identically (see the RecursiveLoop
    // comment for the full detail). A value of 0 is meaningful — it
    // throttles the function to zero concurrency — so the gate uses
    // `!== undefined`, NOT a truthy check.
    const reservedConcurrentExecutions = properties['ReservedConcurrentExecutions'] as
      | number
      | undefined;
    if (reservedConcurrentExecutions !== undefined) {
      await this.applyPostCreateConfig(
        () =>
          this.lambdaClient.send(
            new PutFunctionConcurrencyCommand({
              FunctionName: functionName,
              ReservedConcurrentExecutions: reservedConcurrentExecutions,
            })
          ),
        {
          apiName: 'PutFunctionConcurrency',
          propertyName: 'ReservedConcurrentExecutions',
          logicalId,
          resourceType,
          functionName,
          log,
          cleanup: postCreateCleanup,
          awaitGone: capacityProviderConfig !== undefined,
        }
      );
    }

    // RuntimeManagementConfig: a third post-create control-plane prop, set
    // via `PutRuntimeManagementConfig` (NOT on CreateFunction — the SDK
    // declares no member for it on any create/update request shape). Same
    // atomicity contract as the two above.
    const runtimeManagementConfig = properties['RuntimeManagementConfig'] as
      | Record<string, unknown>
      | undefined;
    if (runtimeManagementConfig !== undefined) {
      await this.applyPostCreateConfig(
        async () => {
          // UNLIKE its two siblings, this API REJECTS a function that is
          // still settling: `CreateFunction` returns while the function is
          // `Pending`, and `PutRuntimeManagementConfig` answers "The
          // operation cannot be performed at this time. The resource ... is
          // currently in the following state: 'Pending'" (caught by the
          // lambda-config-field-removal integ, 2026-08-11 — the unit tests
          // mock the call and cannot see it). PutFunctionRecursionConfig and
          // PutFunctionConcurrency both accept a Pending function, which is
          // why neither needed this.
          //
          // The wait is deliberately INSIDE this `if`, not hoisted after
          // CreateFunction: the provider's documented design is to NOT block
          // the deploy DAG on every Lambda's Active transition (5-10 min for
          // VPC-attached functions — see the comment further down). Scoping
          // it to the opt-in property keeps that property's cost on the
          // templates that ask for it and leaves every other Lambda's deploy
          // time unchanged.
          //
          // A Managed Instances function has settled above, and this waiter
          // could never succeed on it: its `$LATEST` stops at
          // `ActiveNonInvocable` (measured, go-to-k/cdkd#5637).
          if (capacityProviderConfig === undefined) {
            await waitUntilFunctionActiveV2(
              {
                client: this.lambdaClient,
                maxWaitTime: this.functionUpdateMaxWaitSeconds,
                minDelay: 1,
                maxDelay: 5,
              },
              { FunctionName: functionName }
            );
          }
          // go-to-k/cdkd#5511: re-reported by name alone BEFORE the call,
          // since a deadline can drop its outcome after it has moved the
          // token (below).
          reportCreatedResource(logicalId, resourceType, createdFunctionName!);
          await this.putRuntimeManagementConfig(functionName, runtimeManagementConfig);
          // go-to-k/cdkd#4606: a successful PutRuntimeManagementConfig
          // moves `LastModified` (measured by the lambda-fix-forward-orphan
          // fixture), so CreateFunction's token no longer names the live
          // function. Dropped, so a failure after this point marks the name
          // alone and the engine journals a live `resourceIdentity` read.
          createdFunctionIdentity = undefined;
        },
        {
          apiName: 'PutRuntimeManagementConfig',
          propertyName: 'RuntimeManagementConfig',
          logicalId,
          resourceType,
          functionName,
          log,
          cleanup: postCreateCleanup,
          awaitGone: capacityProviderConfig !== undefined,
        }
      );
    }

    // Apart from the two waits above, a create does NOT wait for State=Active. CreateFunction
    // returns synchronously while the function is still in `Pending`,
    // but the deploy-time consumers that actually break against a
    // Pending function are a synchronous Lambda Invoke (Custom Resources)
    // and an ELBv2 TargetGroup registering the function as a `lambda`
    // target (go-to-k/cdkd#5002).
    // Other downstream resources — EventSourceMapping, AddPermission,
    // FunctionUrlConfig — accept the function in Pending state and
    // either succeed immediately or auto-progress once the function
    // transitions. Blocking the entire deploy DAG behind every Lambda's
    // Active transition (which can take 5–10 minutes for VPC-attached
    // functions) more than doubled deploy time in benchmark stacks.
    //
    // The Active wait now lives in `CustomResourceProvider.sendRequest`,
    // gated to the only path that needs it (`waitUntilFunctionActiveV2`
    // immediately before the synchronous Invoke). See PR #121 for the
    // bug report this addresses and the follow-up that moved the wait.
    // The TargetGroup's wait lives in `ELBv2Provider.waitForLambdaTargetsActive`.
    log.debug(`Successfully created Lambda function ${logicalId}: ${log.value(functionName)}`);

    return {
      physicalId: response.FunctionName || functionName,
      attributes: functionAttributes(response),
    };
  } catch (error) {
    if (functionCreated) markAuxiliaryFailure(error, logicalId);
    // The cause stays unmasked: a withheld or masked message is stamped so
    // the retry classifiers read the chain (`wrapMaskedError`).
    // A non-Error throw still gets a cause, so a stamp has a chain to read.
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapMaskedError(
      log,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create Lambda function ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          functionName,
          cause ?? new Error(safeStringify(error))
        )
    );
    // go-to-k/cdkd#4583: the function is live with no state record unless a
    // post-create call's atomicity cleanup deleted it. With its identity
    // (go-to-k/cdkd#4606), which a later settle compares before deleting it
    // by name.
    if (createdFunctionName !== undefined && !postCreateCleanup.deleted) {
      markCreatedBeforeFailure(
        thrown,
        logicalId,
        resourceType,
        createdFunctionName,
        createdFunctionIdentity
      );
    } else if (createdFunctionName !== undefined) {
      // The atomicity cleanup deleted the function: nothing is left to journal.
      retractCreatedResource(logicalId, resourceType, createdFunctionName);
    }
    throw thrown;
  }
}

/**
 * Run a post-create control-plane call under the create path's atomicity
 * contract: on failure, DELETE the just-created function so the next deploy
 * retry sees a fresh slate instead of an orphan that already exists.
 *
 * Extracted from the (previously duplicated) `RecursiveLoop` /
 * `ReservedConcurrentExecutions` blocks when `RuntimeManagementConfig`
 * became the third caller — the wording of all three log lines and of the
 * thrown error is preserved verbatim, parameterized only by the API name
 * and the CFn property name.
 *
 * VPC-attached Lambda caveat (unchanged): the cleanup uses a bare
 * `DeleteFunction`, not the provider's own `delete()`, so hyperplane ENIs
 * are NOT pre-detached / awaited. For a VPC-attached function whose call
 * fails, the next deploy retry's downstream Subnet/SG creation can race the
 * asynchronous ENI release until AWS finishes the detach. The "concurrent
 * update operation" substring is preserved in the wrapped error message so
 * the outer `withRetry` classifier still retries cleanly.
 */
export async function applyPostCreateConfig(
  this: LambdaFunctionProvider,
  send: () => Promise<unknown>,
  ctx: {
    apiName: string;
    propertyName: string;
    logicalId: string;
    resourceType: string;
    functionName: string;
    /** The create operation's sinks (issue #2177): every line below goes through them. */
    log: MaskedLogSinks;
    /** Set `deleted` once the atomicity cleanup's DeleteFunction succeeded (#4583). */
    cleanup: { deleted: boolean };
    /** A Managed Instances function: the cleanup waits until it is gone. */
    awaitGone: boolean;
  }
): Promise<void> {
  const { log } = ctx;
  try {
    await send();
  } catch (error) {
    // The refusal thrown at the end of this handler is persisted to
    // `deployments/{runId}.jsonl` (`extractDeploymentEventError`), and so is
    // not the warn-only site it reads as. An AWS-authored failure is named
    // there, and in the warn, by its CLASS plus the `--verbose` pointer
    // (go-to-k/cdkd#2319): an `AccessDeniedException` names the caller's
    // assumed-role ARN. AWS's own text goes to `debug` under the same head.
    // The refusal is stamped `markRedactedCause`, so the retry classifiers
    // read the withheld `concurrent update operation` wording on the `cause`
    // chain. No "already exists" is restated: the function is in hand, so it
    // would be an auxiliary object's, not this function's (#3826).
    //
    // Masked before it joins any line (issue #2177): AWS quotes request
    // values back, and the warn below reaches no engine sink at all.
    //
    // The Active wait below can fail with the waiter's whole GetFunction
    // payload as its message: that is withheld, not relayed
    // (`describeLambdaWaiterFailure`).
    const failure = describeAwsFailure(error);
    const rawMessage = failure.detail;
    const withheld = failure.redacted ? undefined : withholdWaiterPayload(error, log.mask);
    const message = failure.redacted
      ? log.mask(failure.summary)
      : (withheld?.masked ?? log.mask(rawMessage));
    const warnHead = `${ctx.apiName} failed for ${ctx.logicalId}: `;
    if (failure.redacted) this.logger.debug(log.mask(`${warnHead}${rawMessage}`));
    // Masked once, over the finished line, like the cleanup line below: it
    // is built from the UNMASKED described text.
    this.logger.warn(
      log.mask(
        `${warnHead}${failure.redacted ? failure.summary : (withheld?.described ?? rawMessage)} — deleting partially-created function to maintain atomicity`
      )
    );
    // The cleanup delete is RETRIED on a still-settling function. When the
    // failure above was an Active-wait TIMEOUT, the function is by
    // definition still `Pending`, and `DeleteFunction` answers
    // `ResourceConflictException` for a Pending function — so a
    // single-shot cleanup would fail and genuinely orphan it. (The
    // non-timeout arms self-heal without this: the Pending message is in
    // `retryable-errors.ts`, so the deploy engine's outer `withRetry`
    // re-creates. A waiter-timeout message is NOT in that table, which is
    // exactly the case that reaches here and must clean up after itself.)
    let cleanupFailure: AwsFailureText | undefined;
    for (let attempt = 0; attempt < LAMBDA_CLEANUP_DELETE_MAX_ATTEMPTS; attempt++) {
      try {
        await this.lambdaClient.send(new DeleteFunctionCommand({ FunctionName: ctx.functionName }));
        cleanupFailure = undefined;
        break;
      } catch (deleteError) {
        // `.detail`, never `.summary`: the classifier three lines down
        // matches AWS's OWN wording. `.summary` is `${name || 'Error'}. ...`,
        // so `/ResourceConflict/i` would still match on a
        // `ResourceConflictException` -- but the `currently in the following
        // state` alternative would be blinded, and AWS sends that wording for
        // a function still updating. Losing it breaks on the first attempt
        // and leaves an ORPHANED function, not merely a worse message.
        cleanupFailure = describeAwsFailure(deleteError);
        const deleteMessage = cleanupFailure.detail;
        // Only a state conflict is worth waiting out; anything else
        // (auth, already-deleted) will not change on a retry.
        if (!/currently in the following state|ResourceConflict/i.test(deleteMessage)) break;
        if (attempt < LAMBDA_CLEANUP_DELETE_MAX_ATTEMPTS - 1) {
          await new Promise((resolve) =>
            setTimeout(resolve, this.cleanupDeleteRetryDelayMs * (attempt + 1))
          );
        }
      }
    }
    if (cleanupFailure === undefined) {
      ctx.cleanup.deleted = true;
      // A retried create of this name, or the rollback of a capacity provider
      // this deploy made, would otherwise meet the `Deleting` function.
      if (ctx.awaitGone) {
        // The create's own failure is the one to report.
        await this.waitForFunctionGone(ctx, log).catch((goneError: unknown) => {
          log.warn(describeAwsFailure(goneError).summary);
        });
      }
    }
    if (cleanupFailure !== undefined) {
      // `error` has no sink of its own: the finished line goes through the
      // same masker. The classifier above read the RAW text. An AWS-authored
      // failure is named by its class here (a denied `DeleteFunction` names
      // the caller), and AWS's text goes to `debug` under the same head.
      const cleanupHead = `Cleanup DeleteFunction failed for ${ctx.logicalId} after ${ctx.apiName} failure — function may be orphaned: `;
      if (cleanupFailure.redacted) {
        this.logger.debug(log.mask(`${cleanupHead}${cleanupFailure.detail}`));
      }
      this.logger.error(
        log.mask(
          `${cleanupHead}${cleanupFailure.redacted ? cleanupFailure.summary : cleanupFailure.detail}`
        )
      );
    }
    const cause = error instanceof Error ? error : undefined;
    const refusal = new ProvisioningError(
      `Failed to set ${ctx.propertyName} on Lambda function ${ctx.logicalId} (function was deleted to maintain atomicity): ${message}`,
      ctx.resourceType,
      ctx.logicalId,
      ctx.functionName,
      cause ?? new Error(rawMessage)
    );
    // The retry wording this message keeps on purpose (see create()) must
    // still classify when the mask cut it, or when it was withheld: read the
    // cause chain instead.
    throw failure.redacted || message !== rawMessage ? markRedactedCause(refusal) : refusal;
  }
}

/**
 * Send the CFn `RuntimeManagementConfig` block to `PutRuntimeManagementConfig`.
 *
 * CFn spells the block `{ UpdateRuntimeOn, RuntimeVersionArn }` and the SDK
 * request carries the same two members flat on the request (plus the
 * function name), so this is a straight lift rather than a re-shape.
 * `UpdateRuntimeOn` is required by the API; a template that omits it is
 * refused by AWS with its own validation error, which is the behavior we
 * want to surface rather than paper over with a cdkd-invented default.
 */
export async function putRuntimeManagementConfig(
  this: LambdaFunctionProvider,
  functionName: string,
  config: Record<string, unknown>
): Promise<void> {
  await this.lambdaClient.send(
    new PutRuntimeManagementConfigCommand({
      FunctionName: functionName,
      UpdateRuntimeOn: config['UpdateRuntimeOn'] as UpdateRuntimeOn,
      RuntimeVersionArn: config['RuntimeVersionArn'] as string | undefined,
    })
  );
}

/**
 * Poll `$LATEST.PUBLISHED` until nothing is in progress on it.
 *
 * Not `waitUntilFunctionActiveV2`: unqualified, that reads `$LATEST`, which
 * on a Managed Instances function never leaves `ActiveNonInvocable`. Until
 * this settles, `PublishVersion` and `PutFunctionScalingConfig` answer
 * `ResourceConflictException` (measured us-east-1, go-to-k/cdkd#5637: about
 * 95s after a publish, 30s after a Put, minutes after the first publish).
 *
 * `Failed` fails only the wait that follows cdkd's own call (`after`). Before
 * a call it is the leftover of an earlier attempt, and whether that call is
 * refused is AWS's to say. AWS's reason is a status
 * reason, so the message carries its code and the `--verbose` pointer
 * (go-to-k/cdkd#2319). The wait is capped by the enclosing resource deadline:
 * past it nobody is listening, and a later call would land unobserved.
 */
export async function waitForLatestPublishedSettled(
  this: LambdaFunctionProvider,
  target: { logicalId: string; resourceType: string; functionName: string },
  log: MaskedLogSinks,
  phase: 'before' | 'after'
): Promise<void> {
  const { logicalId, resourceType, functionName } = target;
  const budgetMs = Math.min(
    this.functionUpdateMaxWaitSeconds * 1000,
    enclosingDeadlineRemainingMs() - this.latestPublishedDeadlineMarginMs
  );
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const cfg = await this.lambdaClient.send(
      new GetFunctionConfigurationCommand({
        FunctionName: functionName,
        Qualifier: LATEST_PUBLISHED,
      })
    );
    if (phase === 'after' && (cfg.State === 'Failed' || cfg.LastUpdateStatus === 'Failed')) {
      throw this.wrapStatusReasonError(target, log, cfg);
    }
    const inProgress =
      cfg.State === 'Pending' ||
      cfg.State === 'Deactivating' ||
      cfg.LastUpdateStatus === 'InProgress';
    if (!inProgress) return;
    if (Date.now() >= deadline) {
      throw new ProvisioningError(
        `Lambda function ${logicalId}: ${LATEST_PUBLISHED} did not settle within ` +
          `${Math.max(0, Math.round(budgetMs / 1000))}s (State ${cfg.State}, ` +
          `LastUpdateStatus ${cfg.LastUpdateStatus})`,
        resourceType,
        logicalId,
        functionName
      );
    }
    await new Promise((resolve) => setTimeout(resolve, this.latestPublishedPollMs));
  }
}

/**
 * Apply `FunctionScalingConfig`, which CloudFormation applies to
 * `$LATEST.PUBLISHED`: no numbered version exists on either route. An empty
 * block resets the version to Lambda's default, as removing the property
 * does on CloudFormation (both measured, go-to-k/cdkd#5637). `AWS::Lambda::Version`
 * declares the same property for its own version, which this does not touch.
 */
export async function putFunctionScalingConfig(
  this: LambdaFunctionProvider,
  target: { logicalId: string; resourceType: string; functionName: string },
  log: MaskedLogSinks,
  config: FunctionScalingConfig | undefined
): Promise<void> {
  await this.waitForLatestPublishedSettled(target, log, 'before');
  await this.lambdaClient.send(
    new PutFunctionScalingConfigCommand({
      FunctionName: target.functionName,
      Qualifier: LATEST_PUBLISHED,
      FunctionScalingConfig: config ?? {},
    })
  );
  await this.waitForLatestPublishedSettled(target, log, 'after');
}
