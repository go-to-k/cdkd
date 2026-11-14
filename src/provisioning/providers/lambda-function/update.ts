import type { LambdaFunctionProvider } from '../lambda-function-provider.js';
import { describeAwsFailure, safeStringify } from '../../../utils/aws-failure-text.js';
import {
  UpdateFunctionConfigurationCommand,
  UpdateFunctionCodeCommand,
  GetFunctionCommand,
  DeleteFunctionConcurrencyCommand,
  PutFunctionConcurrencyCommand,
  PutFunctionRecursionConfigCommand,
  PutFunctionCodeSigningConfigCommand,
  PublishVersionCommand,
  type CapacityProviderConfig,
  type FunctionScalingConfig,
  DeleteFunctionCodeSigningConfigCommand,
  TagResourceCommand,
  UntagResourceCommand,
  ResourceNotFoundException,
  waitUntilFunctionUpdatedV2,
  type UpdateFunctionConfigurationCommandInput,
  type UpdateFunctionCodeCommandInput,
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
} from '@aws-sdk/client-lambda';
import { planTagDiff, tagPlanWarning, refuseMalformedDesiredTags } from '../../tag-list.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import type { ResourceUpdateResult, UpdateContext } from '../../../types/resource.js';
import { functionAttributes } from './attributes.js';
import { maskDeep, type MaskedLogSinks, type MaskerFn } from '../../masked-retry-logger.js';
import { withRemovalDefaults } from '../../update-removal.js';
import {
  lambdaOperationSinks,
  LATEST_PUBLISHED,
  capacityProviderConfigForUpdate,
  refuseManagedInstancesPropertiesWithoutCapacityProvider,
  refuseImageFunctionUnsupported,
} from './shared.js';

/**
 * Update a Lambda function
 */
export async function update(
  this: LambdaFunctionProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  // Before each call that changes the function: a failure from there on
  // (the update waiter, a later call) leaves the key unsettled.
  const markUnsettled = (key: string): void => context?.markUnsettled?.(key);
  properties = withRemovalDefaults(
    this.removalDefaults,
    resourceType,
    properties,
    previousProperties,
    context
  );
  // Issues #2178 / #2177: every update() line and refusal goes through this
  // one sink set. `properties` arrives RESOLVED, and a provider's own logger
  // reaches no engine mask. Absent means unmasked. The recorded name is
  // secret-derived when this deploy's bag holds it, or when the PREVIOUS
  // `FunctionName` was a secret (state keeps its `{{resolve:` reference, or
  // `***`, so a rotated name's plaintext is in no bag of this deploy). There
  // is no desired `FunctionName` pair: it could only mark `physicalId`, and
  // these two pairs already catch every redacted state record (a name still
  // in this deploy's bag, or one recorded from a previous secret).
  const log = lambdaOperationSinks(
    this.logger,
    context?.maskSecrets,
    [
      [physicalId, physicalId],
      [previousProperties['FunctionName'], physicalId],
    ],
    properties
  );

  // Typed as the capability so `audit:provider-secret-mask` sees the
  // `maskDeep` below reach a masker (a `log.mask` property read off a
  // non-`this` receiver is not one it accepts).
  const operationMask: MaskerFn = log.mask;

  log.debug(`Updating Lambda function ${logicalId}: ${log.value(physicalId)}`);
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);

  refuseImageFunctionUnsupported(logicalId, resourceType, properties, physicalId);
  refuseManagedInstancesPropertiesWithoutCapacityProvider(
    logicalId,
    resourceType,
    properties,
    { replayingState: context?.replayingState, physicalId },
    log.warn
  );
  try {
    // Whether this function is Managed Instances is AWS's to say, not the
    // record's: an `import` record or an older binary's holds a block the SDK
    // route never sent, and `previousProperties` on `rollback --revert-failed`
    // is the failed attempt's. Read only when a side names the block.
    const desiredCapacity = properties['CapacityProviderConfig'] as
      | CapacityProviderConfig
      | undefined;
    const recordedCapacity = previousProperties['CapacityProviderConfig'];
    const liveManaged =
      desiredCapacity !== undefined || recordedCapacity !== undefined
        ? (await this.lambdaClient.send(new GetFunctionCommand({ FunctionName: physicalId })))
            .Configuration?.CapacityProviderConfig !== undefined
        : false;
    // An absent UpdateFunctionConfiguration member means "no change", so this
    // removal would otherwise report success and change nothing. CloudFormation
    // fails it the same way (go-to-k/cdkd#5637). Unconditional on a replay
    // too: the block is live, and AWS has no call that removes it.
    if (liveManaged && desiredCapacity === undefined) {
      throw markNonRetryable(
        new ProvisioningError(
          `Lambda function ${logicalId} cannot lose its CapacityProviderConfig: AWS does not ` +
            `support removing it from a function. Keep the property, or replace the function ` +
            `under a new logical id.`,
          resourceType,
          logicalId,
          physicalId
        )
      );
    }
    // The record says Managed Instances and AWS says plain: the block was
    // never sent, and AWS refuses adding it ("isn't supported for Lambda
    // Default functions"), so the rest of this update goes as for a plain
    // function. With no block on record this is a real addition, which reaches
    // AWS and gets that refusal, as on CloudFormation.
    const capacityNeverApplied =
      !liveManaged && desiredCapacity !== undefined && recordedCapacity !== undefined;
    if (capacityNeverApplied) {
      log.warn(
        `Lambda function ${logicalId} is not a Managed Instances function on AWS, so its ` +
          `CapacityProviderConfig and FunctionScalingConfig are not applied. Replace the ` +
          `function to apply them.`
      );
    }

    // Check for configuration changes
    const configFields = [
      'Role',
      'Handler',
      'Runtime',
      'Timeout',
      'MemorySize',
      'Description',
      'Environment',
      'Layers',
      'TracingConfig',
      'EphemeralStorage',
      'VpcConfig',
      'DeadLetterConfig',
      'KmsKeyArn',
      'FileSystemConfigs',
      'ImageConfig',
      'SnapStart',
      'LoggingConfig',
      'DurableConfig',
      'CapacityProviderConfig',
    ];

    const changedConfigFields: string[] = [];
    for (const field of configFields) {
      if (field === 'CapacityProviderConfig' && capacityNeverApplied) continue;
      if (JSON.stringify(properties[field]) !== JSON.stringify(previousProperties[field])) {
        changedConfigFields.push(field);
      }
    }
    const hasConfigChanges = changedConfigFields.length > 0;

    if (hasConfigChanges) {
      const configParams: UpdateFunctionConfigurationCommandInput = {
        FunctionName: physicalId,
        Role: properties['Role'] as string | undefined,
        Handler: properties['Handler'] as string | undefined,
        Runtime: properties['Runtime'] as Runtime | undefined,
        // Every optional field below is cleared-on-removal through
        // `removalDefaults` (issue #1160): UpdateFunctionConfiguration treats
        // an ABSENT field as "no change", so a template that drops a
        // previously-set field must send an explicit reset value or AWS
        // silently keeps the old one — while CFn resets it to the
        // property's default. The caller (or `withRemovalDefaults` above,
        // on a direct call) has already put that value in `properties`.
        // VpcConfig is the exception: buildVpcConfigForUpdate. (Role/Handler/
        // Runtime are required by CFn for their package type, so removal is
        // not a valid template transition and they pass through directly.)
        Timeout: properties['Timeout'] as number | undefined,
        MemorySize: properties['MemorySize'] as number | undefined,
        Description: properties['Description'] as string | undefined,
        // The new side is normalized: `Environment: {}` (present, no
        // Variables key) must become `{Variables: {}}` — live-verified
        // 2026-07-22 that the API keeps the old env vars for a
        // Variables-less Environment, while the template's declarative
        // meaning is "no env vars" (issue #1158).
        Environment: this.normalizeEnvironmentForUpdate(
          properties['Environment'] as { Variables?: Record<string, string> } | undefined
        ),
        Layers: properties['Layers'] as string[] | undefined,
        TracingConfig: properties['TracingConfig'] as TracingConfig | undefined,
        EphemeralStorage: properties['EphemeralStorage'] as EphemeralStorage | undefined,
        VpcConfig: this.buildVpcConfigForUpdate(
          properties['VpcConfig'],
          previousProperties['VpcConfig']
        ),
        DeadLetterConfig: properties['DeadLetterConfig'] as DeadLetterConfig | undefined,
        // CFn names this `KmsKeyArn`; the Lambda SDK input field is `KMSKeyArn`.
        KMSKeyArn: properties['KmsKeyArn'] as string | undefined,
        FileSystemConfigs: properties['FileSystemConfigs'] as FileSystemConfig[] | undefined,
        // Kept-but-partial (a sub-field dropped from a still-present
        // ImageConfig) is WHOLE-OBJECT REPLACE, so passing the new block
        // through verbatim IS CloudFormation parity and no sub-field
        // normalization belongs here (issue #1225, live A/B 2026-08-11 on a
        // container Lambda in us-east-1):
        //   - SDK: UpdateFunctionConfiguration with
        //     `ImageConfig: {EntryPoint}` after a create carrying
        //     {EntryPoint, Command, WorkingDirectory} left ONLY EntryPoint
        //     live — the two unspecified sub-fields were cleared, not merged.
        //   - CFn: dropping `Command` + `WorkingDirectory` from a kept
        //     `ImageConfig` block reached the same end state.
        //   - The `{}` removal value is verified too: the SDK call with
        //     `ImageConfig: {}` and a CFn template dropping the whole block
        //     both leave `ImageConfigResponse` absent.
        ImageConfig: properties['ImageConfig'] as ImageConfig | undefined,
        SnapStart: properties['SnapStart'] as SnapStart | undefined,
        LoggingConfig: properties['LoggingConfig'] as LoggingConfig | undefined,
        // DELIBERATELY NOT in `removalDefaults` — the only property in this
        // block for which the reset-to-default idiom does not apply. Live
        // probe (us-east-1, 2026-08-11) established both halves:
        //   - ADD (previous absent -> desired present) is REJECTED by AWS
        //     ("You cannot add a durable configuration to a function that
        //     was originally created with no durable configuration").
        //   - REMOVE (previous present -> desired absent) cannot be
        //     expressed: omitting the member KEEPS the live value, and
        //     there is no documented reset payload — an empty object is
        //     rejected for the required `ExecutionTimeout`.
        // So a presence TOGGLE in either direction is routed to replacement
        // by `replacement-rules.ts`, and this pass-through only ever carries
        // a block that is present on BOTH sides (a genuine in-place edit,
        // which the API accepts and applies).
        DurableConfig: properties['DurableConfig'] as DurableConfig | undefined,
        CapacityProviderConfig: capacityProviderConfigForUpdate(
          capacityNeverApplied ? undefined : desiredCapacity
        ),
      };

      for (const field of changedConfigFields) markUnsettled(field);
      await this.lambdaClient.send(new UpdateFunctionConfigurationCommand(configParams));
      log.debug(`Updated configuration for Lambda function ${log.value(physicalId)}`);
      // Wait for the configuration update to fully apply before any
      // follow-up call. UpdateFunctionConfiguration is async; an
      // immediate UpdateFunctionCode (or any downstream Invoke) against
      // the in-flight update fails with "The operation cannot be
      // performed at this time. The function is currently in the
      // following state: Pending" / "...InProgress".
      await this.waitForFunctionUpdated(logicalId, resourceType, physicalId, log);
    }

    // CodeSigningConfigArn DETACH must precede the code update below.
    // `UpdateFunctionCode` is validated against the config that is attached
    // AT THE TIME OF THE CALL, so a template that drops an enforcing
    // code-signing config AND ships an unsigned artifact in the same change
    // would fail with `CodeVerificationFailedException` if the detach ran
    // after the code update. The ATTACH arm deliberately stays below the
    // code update for the mirror-image reason: enforcement should only be
    // turned on once the newly-signed artifact is in place.
    const newCodeSigningConfigArn = properties['CodeSigningConfigArn'] as string | undefined;
    const prevCodeSigningConfigArn = previousProperties['CodeSigningConfigArn'] as
      | string
      | undefined;
    const codeSigningChanged = newCodeSigningConfigArn !== prevCodeSigningConfigArn;
    if (codeSigningChanged && newCodeSigningConfigArn === undefined) {
      markUnsettled('CodeSigningConfigArn');
      await this.lambdaClient.send(
        new DeleteFunctionCodeSigningConfigCommand({ FunctionName: physicalId })
      );
      log.debug(
        `Detached CodeSigningConfigArn from Lambda function ${log.value(physicalId)} (template removed the property)`
      );
    }

    // Update function code if changed. Architectures rides on
    // UpdateFunctionCode (NOT UpdateFunctionConfiguration — the Lambda API
    // ties the instruction set to a code deployment), so an x86_64 <->
    // arm64 switch must ALSO fire this branch even when the code itself is
    // byte-identical; it was previously silently dropped (deploy reported
    // success while AWS kept the old architecture, and the next diff saw no
    // change since state recorded the new value). CFn applies it in place
    // ("Update requires: No interruption") by re-sending the code with the
    // new Architectures.
    const newCode = properties['Code'] as Record<string, unknown> | undefined;
    const oldCode = previousProperties['Code'] as Record<string, unknown> | undefined;
    // Normalize BOTH comparison sides: an absent property means the Lambda
    // default (['x86_64']), so an explicit-x86_64 <-> absent template edit
    // is NOT a real change and must not fire a needless code redeploy.
    const normalizeArchitectures = (v: unknown): Architecture[] =>
      Array.isArray(v) && v.length > 0 ? (v as Architecture[]) : (['x86_64'] as Architecture[]);
    const architecturesChanged =
      JSON.stringify(normalizeArchitectures(properties['Architectures'])) !==
      JSON.stringify(normalizeArchitectures(previousProperties['Architectures']));

    if (newCode && (architecturesChanged || JSON.stringify(newCode) !== JSON.stringify(oldCode))) {
      const builtCode = this.buildCode(newCode, properties['Runtime'] as string | undefined);
      const codeParams: UpdateFunctionCodeCommandInput = {
        FunctionName: physicalId,
        S3Bucket: builtCode.S3Bucket,
        S3Key: builtCode.S3Key,
        S3ObjectVersion: builtCode.S3ObjectVersion,
        S3ObjectStorageMode: builtCode.S3ObjectStorageMode,
        SourceKMSKeyArn: builtCode.SourceKMSKeyArn,
        ZipFile: builtCode.ZipFile,
        ImageUri: builtCode.ImageUri,
        // A removed Architectures property reverts to the Lambda default
        // (x86_64) — matches CFn's absent-property default semantics.
        Architectures: architecturesChanged
          ? normalizeArchitectures(properties['Architectures'])
          : undefined,
      };

      markUnsettled('Code');
      if (architecturesChanged) markUnsettled('Architectures');
      await this.lambdaClient.send(new UpdateFunctionCodeCommand(codeParams));
      log.debug(`Updated code for Lambda function ${log.value(physicalId)}`);
      // Same reason as above: UpdateFunctionCode is async too, and
      // downstream resources / a subsequent deploy must not race the
      // in-flight code swap.
      await this.waitForFunctionUpdated(logicalId, resourceType, physicalId, log);
    }

    // RecursiveLoop is set via a SEPARATE `PutFunctionRecursionConfig`
    // API (not part of UpdateFunctionConfiguration). On change, issue
    // the post-update control-plane call. The transient
    // "concurrent update operation" retry is already covered by
    // `src/deployment/retryable-errors.ts` (added by PR #711).
    const newRecursiveLoop = properties['RecursiveLoop'] as RecursiveLoop | undefined;
    const prevRecursiveLoop = previousProperties['RecursiveLoop'] as RecursiveLoop | undefined;
    if (newRecursiveLoop !== undefined && newRecursiveLoop !== prevRecursiveLoop) {
      markUnsettled('RecursiveLoop');
      await this.lambdaClient.send(
        new PutFunctionRecursionConfigCommand({
          FunctionName: physicalId,
          RecursiveLoop: newRecursiveLoop,
        })
      );
      log.debug(
        `Updated RecursiveLoop for Lambda function ${log.value(physicalId)} to '${log.value(newRecursiveLoop)}'`
      );
    }

    // ReservedConcurrentExecutions: set via a SEPARATE
    // `PutFunctionConcurrency` API (or cleared via
    // `DeleteFunctionConcurrency` — UpdateFunctionConfiguration does NOT
    // accept this field). On change, issue the matching call. Removal
    // (`prev: number, next: undefined`) maps to DeleteFunctionConcurrency
    // so a user dropping the property from their template actually
    // un-throttles the function instead of silently leaving the old
    // reserved value pinned. 0 is a meaningful value (zero concurrency
    // = full throttle), so the gates use `!== undefined` / `!==` strict
    // compare.
    const newReservedConcurrentExecutions = properties['ReservedConcurrentExecutions'] as
      | number
      | undefined;
    const prevReservedConcurrentExecutions = previousProperties['ReservedConcurrentExecutions'] as
      | number
      | undefined;
    if (newReservedConcurrentExecutions !== prevReservedConcurrentExecutions) {
      markUnsettled('ReservedConcurrentExecutions');
      if (newReservedConcurrentExecutions === undefined) {
        await this.lambdaClient.send(
          new DeleteFunctionConcurrencyCommand({ FunctionName: physicalId })
        );
        log.debug(
          `Cleared ReservedConcurrentExecutions for Lambda function ${log.value(physicalId)} (template removed the property)`
        );
      } else {
        await this.lambdaClient.send(
          new PutFunctionConcurrencyCommand({
            FunctionName: physicalId,
            ReservedConcurrentExecutions: newReservedConcurrentExecutions,
          })
        );
        log.debug(
          `Updated ReservedConcurrentExecutions for Lambda function ${log.value(physicalId)} to ${log.value(newReservedConcurrentExecutions)}`
        );
      }
    }

    // CodeSigningConfigArn ATTACH / CHANGE. Set via a SEPARATE
    // `PutFunctionCodeSigningConfig` API (UpdateFunctionConfiguration does
    // NOT accept this field). The DETACH half runs earlier, before the code
    // update — see the comment there for why the two arms are split. Removal
    // mapping to a real Delete call is the #1160 absent-field-removal class,
    // which for a SECURITY control is the direction that matters.
    if (codeSigningChanged && newCodeSigningConfigArn !== undefined) {
      markUnsettled('CodeSigningConfigArn');
      await this.lambdaClient.send(
        new PutFunctionCodeSigningConfigCommand({
          FunctionName: physicalId,
          CodeSigningConfigArn: newCodeSigningConfigArn,
        })
      );
      log.debug(
        `Updated CodeSigningConfigArn for Lambda function ${log.value(physicalId)} to ${log.value(newCodeSigningConfigArn)}`
      );
    }

    // RuntimeManagementConfig: set via a SEPARATE
    // `PutRuntimeManagementConfig` API. There is no delete counterpart, so
    // REMOVAL is expressed by re-sending the AWS default (`UpdateRuntimeOn:
    // 'Auto'`), which is what CFn resets the property to — the same
    // reset-to-default idiom `removalDefaults` applies to the
    // UpdateFunctionConfiguration fields above. `RuntimeVersionArn` is only
    // meaningful under `Manual` and is dropped by the reset.
    const newRuntimeManagementConfig = properties['RuntimeManagementConfig'] as
      | Record<string, unknown>
      | undefined;
    const prevRuntimeManagementConfig = previousProperties['RuntimeManagementConfig'] as
      | Record<string, unknown>
      | undefined;
    // Compared member-by-member, NOT via JSON.stringify: the block has
    // exactly two members and a stringify compare is key-ORDER sensitive, so
    // a template that merely reorders them would issue a redundant Put.
    const runtimeManagementChanged =
      newRuntimeManagementConfig?.['UpdateRuntimeOn'] !==
        prevRuntimeManagementConfig?.['UpdateRuntimeOn'] ||
      newRuntimeManagementConfig?.['RuntimeVersionArn'] !==
        prevRuntimeManagementConfig?.['RuntimeVersionArn'];
    if (runtimeManagementChanged) {
      markUnsettled('RuntimeManagementConfig');
      await this.putRuntimeManagementConfig(
        physicalId,
        newRuntimeManagementConfig ?? { UpdateRuntimeOn: 'Auto' }
      );
      log.debug(
        `Updated RuntimeManagementConfig for Lambda function ${log.value(physicalId)} to ${JSON.stringify(
          maskDeep(newRuntimeManagementConfig ?? { UpdateRuntimeOn: 'Auto' }, operationMask)
        )}`
      );
    }

    // Lambda Managed Instances, last: a publish captures everything above.
    // CloudFormation publishes on every update of such a function unless
    // `PublishToLatestPublished` is false, and a publish that captures no
    // change is a no-op (measured, go-to-k/cdkd#5637). The scaling call goes
    // to the published version with or without a publish.
    if (liveManaged && desiredCapacity !== undefined) {
      const target = { logicalId, resourceType, functionName: physicalId };
      const newScaling = properties['FunctionScalingConfig'] as FunctionScalingConfig | undefined;
      const prevScaling = previousProperties['FunctionScalingConfig'] as
        | FunctionScalingConfig
        | undefined;
      // Member by member: a stringify compare is key-ORDER sensitive.
      const applyScaling =
        newScaling?.MinExecutionEnvironments !== prevScaling?.MinExecutionEnvironments ||
        newScaling?.MaxExecutionEnvironments !== prevScaling?.MaxExecutionEnvironments ||
        context?.unsettledProperties?.has('FunctionScalingConfig') === true;
      if (properties['PublishToLatestPublished'] !== false) {
        await this.waitForLatestPublishedSettled(target, log, 'before');
        await this.lambdaClient.send(
          new PublishVersionCommand({
            FunctionName: physicalId,
            Description: properties['Description'] as string | undefined,
            PublishTo: 'LATEST_PUBLISHED',
          })
        );
        // A version left `Failed` refuses the scaling call below (measured,
        // go-to-k/cdkd#5637), so it stops here, with its reason code.
        await this.waitForLatestPublishedSettled(target, log, 'after');
        log.debug(`Published ${LATEST_PUBLISHED} of ${log.value(physicalId)}`);
      }
      if (applyScaling) {
        markUnsettled('FunctionScalingConfig');
        await this.putFunctionScalingConfig(target, log, newScaling);
        log.debug(`Updated FunctionScalingConfig of ${log.value(physicalId)}`);
      }
    }

    // Get updated function info for attributes (also gives us the ARN
    // we need for tag mutations).
    const getResponse = await this.lambdaClient.send(
      new GetFunctionCommand({ FunctionName: physicalId })
    );
    const functionArn = getResponse.Configuration?.FunctionArn;

    // Update tags if changed. Lambda's TagResource takes a map shape
    // (Tags: { key: value }); UntagResource takes a key list. cdkd
    // state holds Tags in CFn shape ([{ Key, Value }]).
    await this.applyTagDiff(
      functionArn,
      physicalId,
      resourceType,
      logicalId,
      previousProperties['Tags'],
      properties['Tags'],
      log,
      {
        forceUpsert: context?.unsettledProperties?.has('Tags') === true,
        beforeWrite: () => markUnsettled('Tags'),
      }
    );

    return {
      physicalId,
      wasReplaced: false,
      attributes: functionAttributes(getResponse.Configuration),
    };
  } catch (error) {
    if (error instanceof ProvisioningError) {
      throw error;
    }
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update Lambda function ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause ?? new Error(safeStringify(error))
        )
    );
  }
}

/**
 * Clean up Lambda-managed ENIs for the given function: list, then attempt
 * DeleteNetworkInterface on each. Repeat until no matching ENIs remain
 * or the configured timeout elapses.
 *
 * Why direct delete (not just wait): an `available` ENI still counts as a
 * Subnet / SecurityGroup dependency, so DeleteSubnet / DeleteSecurityGroup
 * fail until the ENI itself is gone. AWS's eventual cleanup of unused
 * Lambda hyperplane ENIs can take well over an hour, which is far longer
 * than any reasonable destroy budget. Calling DeleteNetworkInterface
 * ourselves (best-effort) clears `available` ENIs in seconds.
 *
 * In-use ENIs (e.g. immediately after the pre-delete VPC detach) cannot
 * be deleted yet — we swallow that error and retry on the next iteration
 * once they transition to `available`.
 *
 * Lambda VPC ENI Descriptions follow the pattern
 *   "AWS Lambda VPC ENI-<functionName>"
 * (and historically "AWS Lambda VPC ENI-<functionName>-<uuid>"). We
 * narrow the query with a `requester-id` filter and then match the
 * function name as a hyphen-bounded token to avoid false positives like
 * "myfn" matching for function "fn".
 *
 * Polling: starts at eniWaitInitialDelayMs (10s), exponential backoff up
 * to eniWaitMaxDelayMs (10s), bounded by eniWaitTimeoutMs (10min).
 * Timeout is a soft warning — downstream Subnet/SG deletion has its own
 * retries.
 */
/**
 * Block until the function's LastUpdateStatus === 'Successful'.
 *
 * Used after UpdateFunctionConfiguration / UpdateFunctionCode. Wraps the
 * SDK's `waitUntilFunctionUpdatedV2` (acceptors: SUCCESS=Successful,
 * FAILURE=Failed, RETRY=InProgress). Errors are surfaced as
 * `ProvisioningError` so the deploy engine's per-resource error
 * handling treats them identically to an Update API failure.
 *
 * NOTE: post-CreateFunction `State=Active` wait was deliberately moved
 * out of this provider in favor of an on-demand wait inside
 * `CustomResourceProvider.sendRequest` (the only deploy-time consumer
 * that breaks against a Pending Lambda). Blocking the entire deploy
 * DAG behind every Lambda's Active transition more than doubled
 * deploy time on benchmark stacks; the on-demand wait scoped to the
 * one resource type that actually needs it preserves the bug fix
 * without paying the whole-stack tax.
 */
/**
 * Apply a diff between old and new CFn-shape Tags arrays via Lambda's
 * `TagResource` / `UntagResource` APIs. Without this, `cdkd deploy`
 * and `cdkd drift --revert` silently no-op tag changes — the
 * `UpdateFunctionConfiguration` command does NOT accept a Tags
 * parameter (Lambda treats tags as a separate API surface). Both sides
 * are read through `planTagDiff` (go-to-k/cdkd#3994): an unreadable
 * record untags nothing.
 */
export async function applyTagDiff(
  this: LambdaFunctionProvider,
  functionArn: string | undefined,
  functionName: string,
  resourceType: string,
  logicalId: string,
  oldTagsRaw: unknown,
  newTagsRaw: unknown,
  log: MaskedLogSinks,
  unsettled: { forceUpsert: boolean; beforeWrite: () => void } = {
    forceUpsert: false,
    beforeWrite: () => undefined,
  }
): Promise<void> {
  if (!functionArn) return;

  const plan = planTagDiff(oldTagsRaw, newTagsRaw);
  const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
  if (tagWarning !== undefined) {
    log.warn(tagWarning);
  }
  // go-to-k/cdkd#5487: unsettled Tags re-send every template tag (AWS may
  // lack the ones the failed update did not reach) and remove only the
  // recorded ones the template dropped.
  const tagsToAdd = Object.fromEntries(
    unsettled.forceUpsert ? planTagDiff(undefined, newTagsRaw).set : plan.set
  );
  const tagsToRemove = plan.remove;
  if (tagsToRemove.length > 0 || Object.keys(tagsToAdd).length > 0) unsettled.beforeWrite();

  if (tagsToRemove.length > 0) {
    await this.lambdaClient.send(
      new UntagResourceCommand({ Resource: functionArn, TagKeys: tagsToRemove })
    );
    // The function NAME through `value`, not the ARN: the ARN embeds the
    // name, and a secret name below the substring needle floor would print
    // inside it.
    log.debug(
      `Removed ${tagsToRemove.length} tag(s) from Lambda function ${log.value(functionName)}`
    );
  }
  if (Object.keys(tagsToAdd).length > 0) {
    await this.lambdaClient.send(
      new TagResourceCommand({ Resource: functionArn, Tags: tagsToAdd })
    );
    log.debug(
      `Added/updated ${Object.keys(tagsToAdd).length} tag(s) on Lambda function ${log.value(functionName)}`
    );
  }
}

export async function waitForFunctionUpdated(
  this: LambdaFunctionProvider,
  logicalId: string,
  resourceType: string,
  functionName: string,
  log: MaskedLogSinks
): Promise<void> {
  try {
    await waitUntilFunctionUpdatedV2(
      // Explicit cadence per the repo-wide waiter rule (#1291 item 5). The
      // Lambda V2 waiters' own default is already dense (1s first poll);
      // pinning it here keeps that a recorded decision instead of an SDK
      // default we happen to inherit.
      {
        client: this.lambdaClient,
        maxWaitTime: this.functionUpdateMaxWaitSeconds,
        minDelay: 1,
        maxDelay: 5,
      },
      { FunctionName: functionName }
    );
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log,
      error,
      (text) =>
        new ProvisioningError(
          `Lambda function ${logicalId} update did not complete: ${text}`,
          resourceType,
          logicalId,
          functionName,
          cause ?? new Error(safeStringify(error))
        )
    );
  }
}

/**
 * Poll GetFunction until LastUpdateStatus is no longer `InProgress`.
 *
 * After UpdateFunctionConfiguration the Lambda service processes the
 * change (including VPC detach + hyperplane ENI release) asynchronously.
 * Returning early — i.e. calling DeleteFunction while the update is still
 * `InProgress` — aborts the detach, leaving ENIs attached and blocking
 * downstream Subnet / SG deletion.
 *
 * Bounded by eniWaitTimeoutMs (10min) and treated as a soft warning on
 * timeout: the subsequent ENI cleanup loop and downstream retries cover
 * the residual edge case.
 *
 * NOTE: deliberately separate from `waitForFunctionUpdated` (which uses
 * the SDK's `waitUntilFunctionUpdatedV2` and throws on FAILURE). The
 * pre-delete path needs a more lenient acceptor: if a prior update
 * failed, we still want to proceed with DeleteFunction rather than
 * abort, because the function is going away anyway.
 */
export async function waitForLambdaUpdateCompleted(
  this: LambdaFunctionProvider,
  functionName: string
): Promise<void> {
  const start = Date.now();
  let delay = this.eniWaitInitialDelayMs;

  for (;;) {
    let status: string | undefined;
    try {
      const resp = await this.lambdaClient.send(
        new GetFunctionCommand({ FunctionName: functionName })
      );
      status = resp.Configuration?.LastUpdateStatus;
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        // Function disappeared — caller will skip ENI cleanup too.
        return;
      }
      // Transient error — log and retry.
      this.logger.debug(
        `GetFunction failed while waiting for ${functionName} update: ${
          describeAwsFailure(error).detail
        }`
      );
    }

    if (status && status !== 'InProgress') {
      this.logger.debug(
        `Lambda ${functionName} update completed (LastUpdateStatus=${status}) after ${
          Date.now() - start
        }ms`
      );
      return;
    }

    const elapsed = Date.now() - start;
    if (elapsed >= this.eniWaitTimeoutMs) {
      this.logger.warn(
        `Timeout (${this.eniWaitTimeoutMs}ms) waiting for Lambda ${functionName} update to complete; proceeding with delete`
      );
      return;
    }

    const remaining = this.eniWaitTimeoutMs - elapsed;
    const sleepMs = Math.min(delay, remaining);
    await this.sleep(sleepMs);
    delay = Math.min(delay * 2, this.eniWaitMaxDelayMs);
  }
}
