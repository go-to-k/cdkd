import * as zlib from 'node:zlib';
import {
  LambdaClient,
  CreateFunctionCommand,
  UpdateFunctionConfigurationCommand,
  UpdateFunctionCodeCommand,
  DeleteFunctionCommand,
  GetFunctionCommand,
  GetFunctionRecursionConfigCommand,
  PutFunctionRecursionConfigCommand,
  ListFunctionsCommand,
  ListTagsCommand,
  TagResourceCommand,
  UntagResourceCommand,
  ResourceNotFoundException,
  waitUntilFunctionUpdatedV2,
  type FunctionCode,
  type CreateFunctionCommandInput,
  type UpdateFunctionConfigurationCommandInput,
  type UpdateFunctionCodeCommandInput,
  type Runtime,
  type Architecture,
  type TracingConfig,
  type EphemeralStorage,
  type VpcConfig,
  type DeadLetterConfig,
  type FileSystemConfig,
  type ImageConfig,
  type SnapStart,
  type LoggingConfig,
  type RecursiveLoop,
} from '@aws-sdk/client-lambda';
import {
  CDK_PATH_TAG,
  normalizeAwsTagsToCfn,
  resolveExplicitPhysicalId,
} from '../import-helpers.js';
import {
  EC2Client,
  DescribeNetworkInterfacesCommand,
  DeleteNetworkInterfaceCommand,
} from '@aws-sdk/client-ec2';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { generateResourceName } from '../resource-name.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * Pick the inline-code filename for a Lambda runtime.
 *
 * CloudFormation's `Code.ZipFile` auto-zips inline code into a file named
 * `index.<ext>` where the extension matches the runtime (`index.js` for
 * `nodejs*`, `index.py` for `python*`). The Lambda SDK's `ZipFile` parameter
 * accepts a binary zip but does no equivalent runtime-aware naming, so we
 * have to mirror the CFn behavior here. Defaults to `index.js` since `nodejs`
 * is the only `Code.fromInline`-supported runtime alongside `python` and is
 * the more common case in CDK apps.
 */
export function inlineCodeFileNameForRuntime(runtime: string | undefined): string {
  if (runtime?.startsWith('python')) return 'index.py';
  return 'index.js';
}

/**
 * AWS Lambda Function Provider
 *
 * Implements resource provisioning for AWS::Lambda::Function using the Lambda SDK.
 * WHY: Lambda CreateFunction is synchronous - the CC API adds unnecessary polling
 * overhead (1s->2s->4s->8s) for an operation that completes immediately.
 * This SDK provider eliminates that polling and returns instantly.
 */
export class LambdaFunctionProvider implements ResourceProvider {
  private lambdaClient: LambdaClient;
  private ec2Client: EC2Client;
  private logger = getLogger().child('LambdaFunctionProvider');
  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Lambda::Function',
      new Set([
        'FunctionName',
        'Code',
        'Role',
        'Tags',
        'Handler',
        'Runtime',
        'Timeout',
        'MemorySize',
        'Description',
        'Environment',
        'Layers',
        'Architectures',
        'PackageType',
        'TracingConfig',
        'EphemeralStorage',
        'VpcConfig',
        'DeadLetterConfig',
        'KmsKeyArn',
        'FileSystemConfigs',
        'ImageConfig',
        'SnapStart',
        'LoggingConfig',
        'RecursiveLoop',
      ]),
    ],
  ]);

  // ENI detach polling configuration (overridable for tests).
  // Lambda VPC ENI detach is async and can take 20-40 minutes in the worst case;
  // we poll up to 10 minutes and then warn-and-continue, since downstream Subnet/SG
  // deletion has its own retry logic that handles a small remaining window.
  // Budget for waiting on UpdateFunctionConfiguration to fully apply
  // (LastUpdateStatus -> Successful) after pre-delete VPC detach.
  private readonly eniWaitTimeoutMs: number = 10 * 60 * 1000;
  private readonly eniWaitInitialDelayMs: number = 10_000;
  private readonly eniWaitMaxDelayMs: number = 30_000;

  // Budget for the post-Update wait that blocks until LastUpdateStatus
  // === 'Successful'. Required to prevent the SECOND in-flight call (e.g.
  // UpdateFunctionCode immediately after UpdateFunctionConfiguration)
  // from racing the first with "function is currently in the following
  // state: InProgress". Update typically settles in seconds; the 10-min
  // cap is generous slack for layer-update / VPC-detach edge cases.
  // Seconds (the SDK waiter contract is seconds, not ms).
  //
  // The post-CreateFunction `State=Active` wait used to live here too
  // (PR #121) but doubled deploy time on benchmark stacks because every
  // Lambda paid the cost regardless of whether anything synchronously
  // invoked it. The Active wait now lives in `CustomResourceProvider`
  // (the only deploy-time consumer that breaks against Pending).
  private readonly functionUpdateMaxWaitSeconds: number = 10 * 60;

  // delstack-style ENI cleanup tunables.
  // - initial sleep: gives AWS time to publish post-detach ENI state via
  //   DescribeNetworkInterfaces (right after the update, the API can return
  //   an empty list even though ENIs still exist).
  // - per-ENI retry budget: an in-use ENI cannot be deleted until AWS
  //   finishes the asynchronous detach. AWS's hyperplane ENI release is
  //   eventually-consistent and can take 5-30 minutes in practice — the
  //   budget here must cover that worst case so downstream Subnet/SG
  //   deletes don't race ahead and fail with "has dependencies".
  // - retry interval: polling cadence inside the per-ENI loop.
  private readonly eniInitialSleepMs: number = 10_000;
  private readonly eniDeleteRetryBudgetMs: number = 30 * 60 * 1000;
  private readonly eniDeleteRetryIntervalMs: number = 15_000;

  constructor() {
    const awsClients = getAwsClients();
    this.lambdaClient = awsClients.lambda;
    this.ec2Client = awsClients.ec2;
  }

  /**
   * Create a Lambda function
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Lambda function ${logicalId}`);

    const functionName =
      (properties['FunctionName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 64 });
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

    try {
      // Build tags map from CDK tag format [{Key, Value}]
      let tags: Record<string, string> | undefined;
      if (properties['Tags']) {
        const tagList = properties['Tags'] as Array<{ Key: string; Value: string }>;
        tags = {};
        for (const tag of tagList) {
          tags[tag.Key] = tag.Value;
        }
      }

      const createParams: CreateFunctionCommandInput = {
        FunctionName: functionName,
        Role: role,
        Code: this.buildCode(code, properties['Runtime'] as string | undefined),
        Handler: properties['Handler'] as string | undefined,
        Runtime: properties['Runtime'] as Runtime | undefined,
        Timeout: properties['Timeout'] as number | undefined,
        MemorySize: properties['MemorySize'] as number | undefined,
        Description: properties['Description'] as string | undefined,
        Environment: properties['Environment'] as
          | { Variables?: Record<string, string> }
          | undefined,
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
        Tags: tags,
      };

      const response = await this.lambdaClient.send(new CreateFunctionCommand(createParams));

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
        try {
          await this.lambdaClient.send(
            new PutFunctionRecursionConfigCommand({
              FunctionName: functionName,
              RecursiveLoop: recursiveLoop,
            })
          );
        } catch (rlError) {
          this.logger.warn(
            `PutFunctionRecursionConfig failed for ${logicalId}: ${rlError instanceof Error ? rlError.message : String(rlError)} — deleting partially-created function to maintain atomicity`
          );
          try {
            await this.lambdaClient.send(new DeleteFunctionCommand({ FunctionName: functionName }));
          } catch (deleteError) {
            this.logger.error(
              `Cleanup DeleteFunction failed for ${logicalId} after PutFunctionRecursionConfig failure — function may be orphaned: ${deleteError instanceof Error ? deleteError.message : String(deleteError)}`
            );
          }
          throw new ProvisioningError(
            `Failed to set RecursiveLoop on Lambda function ${logicalId} (function was deleted to maintain atomicity): ${rlError instanceof Error ? rlError.message : String(rlError)}`,
            resourceType,
            logicalId,
            functionName,
            rlError instanceof Error ? rlError : undefined
          );
        }
      }

      // We deliberately do NOT wait for State=Active here. CreateFunction
      // returns synchronously while the function is still in `Pending`,
      // but the only deploy-time consumer that actually breaks against a
      // Pending function is a synchronous Lambda Invoke (Custom Resources).
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
      this.logger.debug(`Successfully created Lambda function ${logicalId}: ${functionName}`);

      return {
        physicalId: response.FunctionName || functionName,
        attributes: {
          Arn: response.FunctionArn,
          FunctionName: response.FunctionName,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Lambda function ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        functionName,
        cause
      );
    }
  }

  /**
   * Update a Lambda function
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Lambda function ${logicalId}: ${physicalId}`);

    try {
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
      ];

      let hasConfigChanges = false;
      for (const field of configFields) {
        if (JSON.stringify(properties[field]) !== JSON.stringify(previousProperties[field])) {
          hasConfigChanges = true;
          break;
        }
      }

      if (hasConfigChanges) {
        const configParams: UpdateFunctionConfigurationCommandInput = {
          FunctionName: physicalId,
          Role: properties['Role'] as string | undefined,
          Handler: properties['Handler'] as string | undefined,
          Runtime: properties['Runtime'] as Runtime | undefined,
          Timeout: properties['Timeout'] as number | undefined,
          MemorySize: properties['MemorySize'] as number | undefined,
          Description: properties['Description'] as string | undefined,
          Environment: properties['Environment'] as
            | { Variables?: Record<string, string> }
            | undefined,
          Layers: properties['Layers'] as string[] | undefined,
          TracingConfig: properties['TracingConfig'] as TracingConfig | undefined,
          EphemeralStorage: properties['EphemeralStorage'] as EphemeralStorage | undefined,
          VpcConfig: this.buildVpcConfigForUpdate(
            properties['VpcConfig'],
            previousProperties['VpcConfig']
          ),
          // Each of these five is cleared-on-removal (see clearOnUpdateRemoval):
          // UpdateFunctionConfiguration treats an ABSENT field as "no change",
          // so a template that drops a previously-set field must send an
          // explicit reset value or AWS silently keeps the old one. Same
          // hazard VpcConfig handles via buildVpcConfigForUpdate.
          DeadLetterConfig: this.clearOnUpdateRemoval(
            properties['DeadLetterConfig'] as DeadLetterConfig | undefined,
            previousProperties['DeadLetterConfig'] as DeadLetterConfig | undefined,
            // Empty TargetArn detaches the DLQ.
            { TargetArn: '' }
          ),
          // CFn names this `KmsKeyArn`; the Lambda SDK input field is `KMSKeyArn`.
          // Empty string resets to the AWS-managed default key.
          KMSKeyArn: this.clearOnUpdateRemoval(
            properties['KmsKeyArn'] as string | undefined,
            previousProperties['KmsKeyArn'] as string | undefined,
            ''
          ),
          // Empty list removes all EFS mounts.
          FileSystemConfigs: this.clearOnUpdateRemoval(
            properties['FileSystemConfigs'] as FileSystemConfig[] | undefined,
            previousProperties['FileSystemConfigs'] as FileSystemConfig[] | undefined,
            []
          ),
          // Empty object resets container image overrides to the image defaults.
          ImageConfig: this.clearOnUpdateRemoval(
            properties['ImageConfig'] as ImageConfig | undefined,
            previousProperties['ImageConfig'] as ImageConfig | undefined,
            {}
          ),
          // ApplyOn: 'None' disables SnapStart.
          SnapStart: this.clearOnUpdateRemoval(
            properties['SnapStart'] as SnapStart | undefined,
            previousProperties['SnapStart'] as SnapStart | undefined,
            { ApplyOn: 'None' }
          ),
          // LogFormat: 'Text' resets to the CFn default (Text format clears
          // the JSON-only ApplicationLogLevel / SystemLogLevel filters).
          LoggingConfig: this.clearOnUpdateRemoval(
            properties['LoggingConfig'] as LoggingConfig | undefined,
            previousProperties['LoggingConfig'] as LoggingConfig | undefined,
            { LogFormat: 'Text' }
          ),
        };

        await this.lambdaClient.send(new UpdateFunctionConfigurationCommand(configParams));
        this.logger.debug(`Updated configuration for Lambda function ${physicalId}`);
        // Wait for the configuration update to fully apply before any
        // follow-up call. UpdateFunctionConfiguration is async; an
        // immediate UpdateFunctionCode (or any downstream Invoke) against
        // the in-flight update fails with "The operation cannot be
        // performed at this time. The function is currently in the
        // following state: Pending" / "...InProgress".
        await this.waitForFunctionUpdated(logicalId, resourceType, physicalId);
      }

      // Update function code if changed
      const newCode = properties['Code'] as Record<string, unknown> | undefined;
      const oldCode = previousProperties['Code'] as Record<string, unknown> | undefined;

      if (newCode && JSON.stringify(newCode) !== JSON.stringify(oldCode)) {
        const builtCode = this.buildCode(newCode, properties['Runtime'] as string | undefined);
        const codeParams: UpdateFunctionCodeCommandInput = {
          FunctionName: physicalId,
          S3Bucket: builtCode.S3Bucket,
          S3Key: builtCode.S3Key,
          S3ObjectVersion: builtCode.S3ObjectVersion,
          ZipFile: builtCode.ZipFile,
          ImageUri: builtCode.ImageUri,
        };

        await this.lambdaClient.send(new UpdateFunctionCodeCommand(codeParams));
        this.logger.debug(`Updated code for Lambda function ${physicalId}`);
        // Same reason as above: UpdateFunctionCode is async too, and
        // downstream resources / a subsequent deploy must not race the
        // in-flight code swap.
        await this.waitForFunctionUpdated(logicalId, resourceType, physicalId);
      }

      // RecursiveLoop is set via a SEPARATE `PutFunctionRecursionConfig`
      // API (not part of UpdateFunctionConfiguration). On change, issue
      // the post-update control-plane call. The transient
      // "concurrent update operation" retry is already covered by
      // `src/deployment/retryable-errors.ts` (added by PR #711).
      const newRecursiveLoop = properties['RecursiveLoop'] as RecursiveLoop | undefined;
      const prevRecursiveLoop = previousProperties['RecursiveLoop'] as RecursiveLoop | undefined;
      if (newRecursiveLoop !== undefined && newRecursiveLoop !== prevRecursiveLoop) {
        await this.lambdaClient.send(
          new PutFunctionRecursionConfigCommand({
            FunctionName: physicalId,
            RecursiveLoop: newRecursiveLoop,
          })
        );
        this.logger.debug(
          `Updated RecursiveLoop for Lambda function ${physicalId} to '${newRecursiveLoop}'`
        );
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
        previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
        properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
      );

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Arn: functionArn,
          FunctionName: getResponse.Configuration?.FunctionName,
        },
      };
    } catch (error) {
      if (error instanceof ProvisioningError) {
        throw error;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update Lambda function ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete a Lambda function
   *
   * For VPC-enabled Lambda functions, AWS detaches the hyperplane ENIs
   * asynchronously after DeleteFunction returns. If we let downstream
   * resource deletion (Subnet / SecurityGroup) proceed immediately, those
   * deletions fail with "has dependencies" / "has a dependent object".
   *
   * To smooth this out, when properties carry a VpcConfig with subnets or
   * security groups, we poll DescribeNetworkInterfaces for the function's
   * managed ENIs and only return once they are gone (or the timeout elapses).
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Lambda function ${logicalId}: ${physicalId}`);

    const hasVpcConfig = this.hasVpcConfig(properties?.['VpcConfig']);

    // For VPC-attached functions, detach the VPC config BEFORE deletion.
    // DeleteFunction does not synchronously release Lambda hyperplane ENIs;
    // AWS reclaims them eventually, often well past any reasonable wait
    // window. UpdateFunctionConfiguration with empty SubnetIds / SecurityGroupIds
    // triggers an explicit ENI release that completes in seconds-to-minutes,
    // letting downstream Subnet / SecurityGroup deletes proceed.
    if (hasVpcConfig) {
      try {
        await this.lambdaClient.send(
          new UpdateFunctionConfigurationCommand({
            FunctionName: physicalId,
            VpcConfig: { SubnetIds: [], SecurityGroupIds: [] },
          })
        );
        this.logger.debug(`Detached VPC config from Lambda ${physicalId} before deletion`);
      } catch (error) {
        if (error instanceof ResourceNotFoundException) {
          const clientRegion = await this.lambdaClient.config.region();
          assertRegionMatch(
            clientRegion,
            context?.expectedRegion,
            resourceType,
            logicalId,
            physicalId
          );
          // Function is already gone — nothing more to do, including ENI wait
          // (AWS owns the cleanup at this point).
          return;
        }
        // Best-effort: don't fail the entire delete if pre-detach errors.
        // The post-DeleteFunction ENI wait below remains as a safety net.
        this.logger.warn(
          `Pre-delete VPC detach failed for ${physicalId}: ${
            error instanceof Error ? error.message : String(error)
          } — continuing with delete`
        );
      }

      // Wait for the UpdateFunctionConfiguration to fully apply before
      // calling DeleteFunction. Lambda processes the VPC detach
      // asynchronously: LastUpdateStatus transitions InProgress -> Successful,
      // and the hyperplane ENIs only flip from `in-use` to `available` once
      // that completes. Calling DeleteFunction while LastUpdateStatus is
      // still `InProgress` aborts the detach mid-flight, leaving ENIs
      // attached and blocking downstream Subnet / SG deletion.
      await this.waitForLambdaUpdateCompleted(physicalId);
    }

    try {
      await this.lambdaClient.send(new DeleteFunctionCommand({ FunctionName: physicalId }));
      this.logger.debug(`Successfully deleted Lambda function ${logicalId}`);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        const clientRegion = await this.lambdaClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Lambda function ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Lambda function ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }

    if (hasVpcConfig) {
      await this.cleanupLambdaEnis(physicalId);
    }
  }

  /**
   * Build Lambda VpcConfig parameter from CDK properties.
   *
   * Returns undefined when VpcConfig is unset, so the SDK leaves the function
   * outside any VPC. Returns an empty config (no subnets, no SGs) when caller
   * explicitly clears it on update — that detaches the function from its VPC.
   */
  private buildVpcConfig(raw: unknown): VpcConfig | undefined {
    if (raw === undefined || raw === null) {
      return undefined;
    }
    if (typeof raw !== 'object') {
      return undefined;
    }
    const vpc = raw as Record<string, unknown>;
    const result: VpcConfig = {};
    if (Array.isArray(vpc['SubnetIds'])) {
      result.SubnetIds = vpc['SubnetIds'] as string[];
    }
    if (Array.isArray(vpc['SecurityGroupIds'])) {
      result.SecurityGroupIds = vpc['SecurityGroupIds'] as string[];
    }
    if (typeof vpc['Ipv6AllowedForDualStack'] === 'boolean') {
      result.Ipv6AllowedForDualStack = vpc['Ipv6AllowedForDualStack'];
    }
    return result;
  }

  /**
   * Build VpcConfig for an update call, accounting for VPC detach.
   *
   * UpdateFunctionConfiguration treats an absent VpcConfig as "no change",
   * so omitting it cannot move a function out of its existing VPC. To
   * detach we must explicitly send empty SubnetIds / SecurityGroupIds.
   */
  private buildVpcConfigForUpdate(newRaw: unknown, previousRaw: unknown): VpcConfig | undefined {
    const next = this.buildVpcConfig(newRaw);
    if (next) {
      return next;
    }
    if (this.hasVpcConfig(previousRaw)) {
      return { SubnetIds: [], SecurityGroupIds: [] };
    }
    return undefined;
  }

  /**
   * Build an UpdateFunctionConfiguration field value that clears on removal.
   *
   * `UpdateFunctionConfiguration` treats an absent field as "no change", so
   * passing `undefined` for a field the user just dropped from the template
   * leaves the old value live on AWS — the update reports success while the
   * field silently persists. For fields that support an explicit reset value
   * (DeadLetterConfig `{TargetArn:''}`, KMSKeyArn `''`, FileSystemConfigs `[]`,
   * ImageConfig `{}`, SnapStart `{ApplyOn:'None'}`) we send that reset when the
   * field was present before and is now absent. Mirrors `buildVpcConfigForUpdate`.
   */
  private clearOnUpdateRemoval<T>(
    newValue: T | undefined,
    previousValue: T | undefined,
    clearValue: T
  ): T | undefined {
    if (newValue !== undefined) return newValue;
    if (previousValue !== undefined) return clearValue;
    return undefined;
  }

  /**
   * Determine whether the function actually attaches to a VPC, i.e. has at
   * least one Subnet ID. A bare VpcConfig with empty arrays does not create
   * any ENIs, so we skip the wait in that case.
   */
  private hasVpcConfig(raw: unknown): boolean {
    if (raw === undefined || raw === null || typeof raw !== 'object') {
      return false;
    }
    const vpc = raw as Record<string, unknown>;
    const subnets = vpc['SubnetIds'];
    return Array.isArray(subnets) && subnets.length > 0;
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
   * to eniWaitMaxDelayMs (30s), bounded by eniWaitTimeoutMs (10min).
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
   * parameter (Lambda treats tags as a separate API surface).
   */
  private async applyTagDiff(
    functionArn: string | undefined,
    oldTagsRaw: Array<{ Key?: string; Value?: string }> | undefined,
    newTagsRaw: Array<{ Key?: string; Value?: string }> | undefined
  ): Promise<void> {
    if (!functionArn) return;

    const toMap = (
      tags: Array<{ Key?: string; Value?: string }> | undefined
    ): Map<string, string> => {
      const m = new Map<string, string>();
      for (const t of tags ?? []) {
        if (t.Key !== undefined && t.Value !== undefined) m.set(t.Key, t.Value);
      }
      return m;
    };

    const oldMap = toMap(oldTagsRaw);
    const newMap = toMap(newTagsRaw);

    const tagsToAdd: Record<string, string> = {};
    for (const [k, v] of newMap) {
      if (oldMap.get(k) !== v) tagsToAdd[k] = v;
    }
    const tagsToRemove: string[] = [];
    for (const k of oldMap.keys()) {
      if (!newMap.has(k)) tagsToRemove.push(k);
    }

    if (tagsToRemove.length > 0) {
      await this.lambdaClient.send(
        new UntagResourceCommand({ Resource: functionArn, TagKeys: tagsToRemove })
      );
      this.logger.debug(
        `Removed ${tagsToRemove.length} tag(s) from Lambda function ${functionArn}`
      );
    }
    if (Object.keys(tagsToAdd).length > 0) {
      await this.lambdaClient.send(
        new TagResourceCommand({ Resource: functionArn, Tags: tagsToAdd })
      );
      this.logger.debug(
        `Added/updated ${Object.keys(tagsToAdd).length} tag(s) on Lambda function ${functionArn}`
      );
    }
  }

  private async waitForFunctionUpdated(
    logicalId: string,
    resourceType: string,
    functionName: string
  ): Promise<void> {
    try {
      await waitUntilFunctionUpdatedV2(
        { client: this.lambdaClient, maxWaitTime: this.functionUpdateMaxWaitSeconds },
        { FunctionName: functionName }
      );
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Lambda function ${logicalId} update did not complete: ${
          error instanceof Error ? error.message : String(error)
        }`,
        resourceType,
        logicalId,
        functionName,
        cause
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
  private async waitForLambdaUpdateCompleted(functionName: string): Promise<void> {
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
            error instanceof Error ? error.message : String(error)
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

  private async cleanupLambdaEnis(functionName: string): Promise<void> {
    this.logger.debug(`Cleaning up Lambda VPC ENIs for function ${functionName}`);

    // Mirror delstack's ENI cleanup pattern: an unconditional initial sleep
    // gives AWS time to register the post-detach ENI state in the API plane
    // (DescribeNetworkInterfaces can transiently return an empty list right
    // after UpdateFunctionConfiguration, even though ENIs still exist), then
    // delete each matched ENI in parallel with a per-ENI retry budget.
    await this.sleep(this.eniInitialSleepMs);

    let enis: { id: string; status: string }[] = [];
    try {
      enis = await this.listLambdaEnis(functionName);
    } catch (error) {
      this.logger.warn(
        `DescribeNetworkInterfaces failed for ${functionName}: ${
          error instanceof Error ? error.message : String(error)
        } — downstream Subnet/SG deletion will fall back to its own ENI cleanup`
      );
      return;
    }

    if (enis.length === 0) {
      this.logger.debug(`No Lambda ENIs found for ${functionName} after initial sleep`);
      return;
    }

    // Per-ENI parallel delete with retry. An in-use ENI cannot be deleted
    // until AWS finishes the asynchronous detach triggered by the prior
    // UpdateFunctionConfiguration; budget gives that detach time to land.
    await Promise.all(enis.map((eni) => this.deleteEniWithRetry(eni.id, functionName)));
  }

  private async deleteEniWithRetry(eniId: string, functionName: string): Promise<void> {
    const start = Date.now();
    for (;;) {
      try {
        await this.ec2Client.send(new DeleteNetworkInterfaceCommand({ NetworkInterfaceId: eniId }));
        this.logger.debug(`Deleted Lambda ENI ${eniId} for ${functionName}`);
        return;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('InvalidNetworkInterfaceID.NotFound') || msg.includes('does not exist')) {
          // Already gone — treat as success.
          return;
        }
        const elapsed = Date.now() - start;
        if (elapsed >= this.eniDeleteRetryBudgetMs) {
          this.logger.warn(
            `Gave up deleting ENI ${eniId} for ${functionName} after ${elapsed}ms: ${msg} — ` +
              `downstream Subnet/SG deletion will retry`
          );
          return;
        }
        await this.sleep(this.eniDeleteRetryIntervalMs);
      }
    }
  }

  /**
   * List Lambda-managed ENIs for the given function, paginating through
   * DescribeNetworkInterfaces and filtering on Description.
   *
   * We filter directly on `description=AWS Lambda VPC ENI-*` (the EC2 API
   * supports `*` wildcards on this filter — same approach as delstack). An
   * earlier attempt narrowed with `requester-id=*:awslambda_*`, but real
   * Lambda hyperplane ENIs carry a RequesterId of the form
   * `AROAXXX...:<account-id>` (no literal "awslambda" substring), so that
   * filter matched nothing and the cleanup loop quietly listed zero ENIs.
   */
  private async listLambdaEnis(functionName: string): Promise<{ id: string; status: string }[]> {
    const enis: { id: string; status: string }[] = [];
    const descriptionPrefix = 'AWS Lambda VPC ENI-';
    let nextToken: string | undefined;
    do {
      const resp = await this.ec2Client.send(
        new DescribeNetworkInterfacesCommand({
          Filters: [{ Name: 'description', Values: [`${descriptionPrefix}*`] }],
          NextToken: nextToken,
        })
      );

      for (const ni of resp.NetworkInterfaces ?? []) {
        const desc = ni.Description ?? '';
        if (!ni.NetworkInterfaceId || !desc.startsWith(descriptionPrefix)) {
          continue;
        }
        // The portion after `AWS Lambda VPC ENI-` is the function-name token
        // AWS uses on the ENI. It usually omits the CDK auto-generated 8-char
        // suffix at the end of the physical function name, so match by
        // checking that physicalId starts with `<token>-` (allowing the
        // suffix) or equals it exactly. This is hyphen-bounded so a function
        // named `fn` does NOT match an ENI whose token is `myfn`.
        const token = desc.slice(descriptionPrefix.length);
        if (functionName === token || functionName.startsWith(`${token}-`)) {
          enis.push({ id: ni.NetworkInterfaceId, status: ni.Status ?? 'unknown' });
        }
      }
      nextToken = resp.NextToken;
    } while (nextToken);
    return enis;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Build Lambda Code parameter from CDK properties
   */
  private buildCode(code: Record<string, unknown>, runtime: string | undefined): FunctionCode {
    const result: FunctionCode = {};

    if (code['S3Bucket']) {
      result.S3Bucket = code['S3Bucket'] as string;
    }
    if (code['S3Key']) {
      result.S3Key = code['S3Key'] as string;
    }
    if (code['S3ObjectVersion']) {
      result.S3ObjectVersion = code['S3ObjectVersion'] as string;
    }
    if (code['ZipFile']) {
      // Lambda SDK expects a zip binary, not raw text.
      // CloudFormation's ZipFile property auto-zips inline code, but SDK does not.
      // Create a minimal zip with the code as index.* file.
      result.ZipFile = this.createZipFromInlineCode(code['ZipFile'] as string, runtime);
    }
    if (code['ImageUri']) {
      result.ImageUri = code['ImageUri'] as string;
    }

    return result;
  }

  /**
   * Create a zip file from inline code text.
   *
   * CloudFormation's ZipFile property automatically wraps inline code in a zip,
   * but the Lambda SDK expects actual zip binary. This creates a minimal zip
   * containing the code as index.* (extension derived from runtime — nodejs
   * runtimes use index.js, python runtimes use index.py; see CFn ZipFile docs).
   */
  private createZipFromInlineCode(code: string, runtime: string | undefined): Uint8Array {
    const fileData = Buffer.from(code, 'utf-8');
    const crc32 = this.crc32(fileData);
    const compressedData = zlib.deflateRawSync(fileData);

    const fileName = Buffer.from(inlineCodeFileNameForRuntime(runtime));
    const now = new Date();
    const modTime =
      ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
    const modDate =
      (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

    // Local file header
    const localHeader = Buffer.alloc(30 + fileName.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(8, 8); // compression: deflate
    localHeader.writeUInt16LE(modTime, 10);
    localHeader.writeUInt16LE(modDate, 12);
    localHeader.writeUInt32LE(crc32, 14);
    localHeader.writeUInt32LE(compressedData.length, 18);
    localHeader.writeUInt32LE(fileData.length, 22);
    localHeader.writeUInt16LE(fileName.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length
    fileName.copy(localHeader, 30);

    // Central directory
    const centralDir = Buffer.alloc(46 + fileName.length);
    centralDir.writeUInt32LE(0x02014b50, 0);
    centralDir.writeUInt16LE(20, 4);
    centralDir.writeUInt16LE(20, 6);
    centralDir.writeUInt16LE(0, 8);
    centralDir.writeUInt16LE(8, 10);
    centralDir.writeUInt16LE(modTime, 12);
    centralDir.writeUInt16LE(modDate, 14);
    centralDir.writeUInt32LE(crc32, 16);
    centralDir.writeUInt32LE(compressedData.length, 20);
    centralDir.writeUInt32LE(fileData.length, 24);
    centralDir.writeUInt16LE(fileName.length, 28);
    centralDir.writeUInt32LE(0, 42); // offset to local header
    fileName.copy(centralDir, 46);

    // End of central directory
    const endRecord = Buffer.alloc(22);
    const cdOffset = localHeader.length + compressedData.length;
    const cdSize = centralDir.length;
    endRecord.writeUInt32LE(0x06054b50, 0);
    endRecord.writeUInt16LE(1, 8); // entries on disk
    endRecord.writeUInt16LE(1, 10); // total entries
    endRecord.writeUInt32LE(cdSize, 12);
    endRecord.writeUInt32LE(cdOffset, 16);

    return Buffer.concat([localHeader, compressedData, centralDir, endRecord]);
  }

  private crc32(data: Buffer): number {
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  /**
   * Resolve a single `Fn::GetAtt` attribute for an existing Lambda function.
   *
   * CloudFormation's `AWS::Lambda::Function` exposes `Arn`,
   * `SnapStartResponse.ApplyOn`, and `SnapStartResponse.OptimizationStatus`
   * as documented at
   * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-lambda-function.html#aws-resource-lambda-function-return-values.
   *
   * All three live in the same `GetFunction` response (`Configuration.FunctionArn`
   * and `Configuration.SnapStart.{ApplyOn,OptimizationStatus}`), so a single API
   * call covers every supported attr. Used by `cdkd orphan` to live-fetch
   * attribute values that need to be substituted into sibling references.
   */
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (
      attributeName !== 'Arn' &&
      attributeName !== 'SnapStartResponse.ApplyOn' &&
      attributeName !== 'SnapStartResponse.OptimizationStatus'
    ) {
      return undefined;
    }
    try {
      const resp = await this.lambdaClient.send(
        new GetFunctionCommand({ FunctionName: physicalId })
      );
      switch (attributeName) {
        case 'Arn':
          return resp.Configuration?.FunctionArn;
        case 'SnapStartResponse.ApplyOn':
          return resp.Configuration?.SnapStart?.ApplyOn;
        case 'SnapStartResponse.OptimizationStatus':
          return resp.Configuration?.SnapStart?.OptimizationStatus;
        default:
          return undefined;
      }
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }
  }

  /**
   * Read the AWS-current Lambda function configuration in CFn-property shape.
   *
   * Issues a single `GetFunction` and surfaces the same property keys
   * `create()` accepts (`Runtime`, `Handler`, `Role`, `Timeout`, `MemorySize`,
   * `Description`, `Environment`, `Layers`, `Architectures`, `PackageType`,
   * `TracingConfig`, `EphemeralStorage`, `VpcConfig`, `DeadLetterConfig`,
   * `KmsKeyArn`, `FileSystemConfigs`, `ImageConfig`, `SnapStart`,
   * `LoggingConfig`, plus the physical `FunctionName`). The drift comparator
   * only descends into keys
   * present in
   * cdkd state, so AWS-managed fields (timestamps, FunctionArn, RevisionId,
   * etc.) are filtered at compare time — we still avoid serializing them on
   * the wire.
   *
   * `Code.S3Bucket` / `Code.S3Key` / `Code.S3ObjectVersion` / `Code.ZipFile`
   * are not surfaced: `GetFunction` returns a pre-signed S3 URL for the
   * deployed code, not the asset hash cdkd state holds, so they could
   * never match. Those keys are declared via `getDriftUnknownPaths` so
   * the drift comparator skips them. `Code.ImageUri` IS surfaced for
   * container Lambdas (`PackageType: 'Image'`) — AWS returns it on the
   * `GetFunction.Code.ImageUri` field, so a console-side image swap is
   * detectable as drift.
   *
   * `Tags` is surfaced from the `Tags` map on the same `GetFunction`
   * response. CDK's auto-injected `aws:cdk:*` tags (which AWS happily
   * returns) are filtered out by `normalizeAwsTagsToCfn` so they don't
   * fire false-positive drift against state. The result key is omitted
   * entirely when AWS reports no user tags, matching `create()`'s
   * behavior of only sending `Tags` when the user explicitly passes
   * them.
   *
   * Returns `undefined` when the function is gone (`ResourceNotFoundException`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const resp = await this.lambdaClient.send(
        new GetFunctionCommand({ FunctionName: physicalId })
      );
      const cfg = resp.Configuration;
      if (!cfg) return undefined;

      const result: Record<string, unknown> = {};

      if (cfg.FunctionName !== undefined) result['FunctionName'] = cfg.FunctionName;
      if (cfg.Runtime !== undefined) result['Runtime'] = cfg.Runtime;
      if (cfg.Handler !== undefined) result['Handler'] = cfg.Handler;
      if (cfg.Role !== undefined) result['Role'] = cfg.Role;
      if (cfg.Timeout !== undefined) result['Timeout'] = cfg.Timeout;
      if (cfg.MemorySize !== undefined) result['MemorySize'] = cfg.MemorySize;
      result['Description'] = cfg.Description ?? '';
      result['Environment'] = { Variables: cfg.Environment?.Variables ?? {} };
      // GetFunction returns Layers as [{Arn, CodeSize, ...}]; CFn shape
      // is a flat string[] of ARNs.
      result['Layers'] = (cfg.Layers ?? []).map((l) => l.Arn).filter((arn): arn is string => !!arn);
      result['Architectures'] = cfg.Architectures ? [...cfg.Architectures] : [];
      if (cfg.PackageType !== undefined) result['PackageType'] = cfg.PackageType;
      // Code.ImageUri is surfaced for container Lambdas only. AWS returns
      // `Code.ImageUri` on `GetFunction.Code.ImageUri` for Image-package
      // functions; ZIP-package functions return a pre-signed S3 URL on
      // `Code.Location` which is NOT the asset key cdkd state carries
      // (the ZIP-side sub-paths stay declared via getDriftUnknownPaths).
      // The Code subtree is only emitted when AWS reports an ImageUri so
      // ZIP-package functions don't get a misleading `Code: {}` placeholder.
      if (resp.Code?.ImageUri !== undefined) {
        result['Code'] = { ImageUri: resp.Code.ImageUri };
      }
      result['TracingConfig'] = { Mode: cfg.TracingConfig?.Mode ?? 'PassThrough' };
      if (cfg.EphemeralStorage?.Size !== undefined) {
        result['EphemeralStorage'] = { Size: cfg.EphemeralStorage.Size };
      }
      // Always emit VpcConfig so a console-side VPC attach is detected even
      // when the function was deployed without VpcConfig (Lambda's
      // GetFunction returns VpcConfig with empty arrays for non-VPC
      // functions; that empty shape becomes our placeholder).
      // AWS's GetFunction sometimes returns Ipv6AllowedForDualStack=undefined
      // and sometimes false (the default) for the same non-VPC function —
      // observed empirically after UpdateFunctionConfiguration. Emit it
      // unconditionally with `?? false` so the comparator sees a stable
      // shape and doesn't fire false-positive drift on every other
      // refresh.
      result['VpcConfig'] = {
        SubnetIds: cfg.VpcConfig?.SubnetIds ? [...cfg.VpcConfig.SubnetIds] : [],
        SecurityGroupIds: cfg.VpcConfig?.SecurityGroupIds
          ? [...cfg.VpcConfig.SecurityGroupIds]
          : [],
        Ipv6AllowedForDualStack: cfg.VpcConfig?.Ipv6AllowedForDualStack ?? false,
      };

      // The following fields are emitted ONLY when AWS reports a value (unlike
      // the always-emit placeholders above). AWS echoes back exactly what
      // create()/update() sent, so emit-when-present cannot drop a
      // user-templated value, and the drift comparator's state-keys-only
      // top-level walk ignores any key not present in state — so emitting an
      // AWS-default value the user never templated (e.g. SnapStart.ApplyOn=None)
      // never fires false-positive drift. Emitting them unconditionally would
      // instead break the "AWS minimum response" key-set regression test
      // (lambda-function-provider-readcurrentstate.test.ts).
      if (cfg.DeadLetterConfig?.TargetArn !== undefined) {
        result['DeadLetterConfig'] = { TargetArn: cfg.DeadLetterConfig.TargetArn };
      }
      // CFn names this `KmsKeyArn`; GetFunction returns it as `KMSKeyArn`.
      if (cfg.KMSKeyArn !== undefined) {
        result['KmsKeyArn'] = cfg.KMSKeyArn;
      }
      if (cfg.FileSystemConfigs !== undefined && cfg.FileSystemConfigs.length > 0) {
        result['FileSystemConfigs'] = cfg.FileSystemConfigs.map((f) => ({
          Arn: f.Arn,
          LocalMountPath: f.LocalMountPath,
        }));
      }
      // Container Lambdas: GetFunction nests ImageConfig under ImageConfigResponse.
      const imageConfig = cfg.ImageConfigResponse?.ImageConfig;
      if (imageConfig !== undefined) {
        const ic: Record<string, unknown> = {};
        if (imageConfig.EntryPoint !== undefined) ic['EntryPoint'] = [...imageConfig.EntryPoint];
        if (imageConfig.Command !== undefined) ic['Command'] = [...imageConfig.Command];
        if (imageConfig.WorkingDirectory !== undefined)
          ic['WorkingDirectory'] = imageConfig.WorkingDirectory;
        if (Object.keys(ic).length > 0) result['ImageConfig'] = ic;
      }
      if (cfg.SnapStart?.ApplyOn !== undefined) {
        // CFn SnapStart is { ApplyOn } only; OptimizationStatus is AWS-managed.
        result['SnapStart'] = { ApplyOn: cfg.SnapStart.ApplyOn };
      }
      // AWS always returns LoggingConfig (even for the Text-format default), so
      // this is effectively emit-always on real AWS — but the comparator's
      // state-keys-only walk ignores it unless the user templated LoggingConfig.
      // Emit only the user-controllable sub-fields (LogGroup is templatable too);
      // ApplicationLogLevel / SystemLogLevel only apply to JSON format and AWS
      // omits them under Text, so they stay emit-when-present.
      if (cfg.LoggingConfig?.LogFormat !== undefined) {
        const lc: Record<string, unknown> = { LogFormat: cfg.LoggingConfig.LogFormat };
        if (cfg.LoggingConfig.ApplicationLogLevel !== undefined)
          lc['ApplicationLogLevel'] = cfg.LoggingConfig.ApplicationLogLevel;
        if (cfg.LoggingConfig.SystemLogLevel !== undefined)
          lc['SystemLogLevel'] = cfg.LoggingConfig.SystemLogLevel;
        if (cfg.LoggingConfig.LogGroup !== undefined) lc['LogGroup'] = cfg.LoggingConfig.LogGroup;
        result['LoggingConfig'] = lc;
      }

      // Tags: GetFunction returns a map keyed by tag name. Filter
      // CDK / aws:* auto-tags, re-shape to CFn's `[{Key, Value}]`, and
      // omit the key entirely when AWS reports no user tags (matches
      // `create()`'s behavior of only sending Tags when the template
      // carries them).
      const tags = normalizeAwsTagsToCfn(resp.Tags);
      result['Tags'] = tags;

      // RecursiveLoop lives on a SEPARATE control-plane API
      // (GetFunctionRecursionConfig), not on GetFunction. Issue the
      // extra call and emit-when-present (AWS returns the default
      // 'Terminate' if the function never had the prop set; the drift
      // comparator's state-keys-only walk ignores the field unless
      // state carries it, so the always-emit shape from AWS does not
      // produce false-positive drift on functions that never used
      // RecursiveLoop).
      try {
        const rlResp = await this.lambdaClient.send(
          new GetFunctionRecursionConfigCommand({ FunctionName: physicalId })
        );
        if (rlResp.RecursiveLoop !== undefined) {
          result['RecursiveLoop'] = rlResp.RecursiveLoop;
        }
      } catch (rlErr) {
        // Non-fatal: tolerate transient access failures on the
        // secondary read so the primary read still produces a usable
        // snapshot. The drift report just omits RecursiveLoop on the
        // (rare) failure.
        if (!(rlErr instanceof ResourceNotFoundException)) {
          this.logger.debug(
            `GetFunctionRecursionConfig failed for ${physicalId}: ${rlErr instanceof Error ? rlErr.message : String(rlErr)}`
          );
        }
      }

      return result;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }
  }

  /**
   * Lambda ZIP-package `Code` sub-paths AWS does not return on read.
   *
   * `GetFunction` returns a pre-signed S3 URL for ZIP-deployed code
   * (`Code.Location`), not the original `S3Bucket` / `S3Key` cdkd state
   * holds. `ZipFile` is inline source that AWS never echoes back. These
   * three fields are write-only via the GetFunction API (Category 1).
   *
   * `Code.ImageUri` IS recoverable — `GetFunction.Code.ImageUri` returns
   * the templated image URI for container Lambdas — so it is surfaced by
   * `readCurrentState` and NOT declared drift-unknown. `Code.SourceKMSKeyArn`
   * is also write-only on the FunctionCodeLocation read shape.
   *
   * Pre-PR this method returned the whole `['Code']` subtree as
   * drift-unknown, which also hid `Code.ImageUri` drift on container
   * Lambdas. Narrowing the skip-list re-enables that detection.
   */
  getDriftUnknownPaths(): string[] {
    return [
      'Code.S3Bucket',
      'Code.S3Key',
      'Code.S3ObjectVersion',
      'Code.ZipFile',
      'Code.SourceKMSKeyArn',
    ];
  }

  /**
   * Adopt an existing Lambda function into cdkd state.
   *
   * Lookup order:
   *  1. `--resource` override or `Properties.FunctionName` → use directly,
   *     verify via `GetFunction`.
   *  2. `ListFunctions` + `ListTags`, match `aws:cdk:path` tag.
   *
   * Lambda's `ListTags` returns a `Tags` map keyed by tag name (unlike
   * EC2/S3 which return an array of `{Key, Value}`), so we read it directly
   * instead of going through the shared `matchesCdkPath` helper.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'FunctionName');
    if (explicit) {
      try {
        await this.lambdaClient.send(new GetFunctionCommand({ FunctionName: explicit }));
        return { physicalId: explicit, attributes: {} };
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return null;
        throw err;
      }
    }

    if (!input.cdkPath) return null;

    let marker: string | undefined;
    do {
      const list = await this.lambdaClient.send(
        new ListFunctionsCommand({ ...(marker && { Marker: marker }) })
      );
      for (const fn of list.Functions ?? []) {
        if (!fn.FunctionArn || !fn.FunctionName) continue;
        try {
          const tagsResp = await this.lambdaClient.send(
            new ListTagsCommand({ Resource: fn.FunctionArn })
          );
          if (tagsResp.Tags?.[CDK_PATH_TAG] === input.cdkPath) {
            return { physicalId: fn.FunctionName, attributes: {} };
          }
        } catch (err) {
          if (err instanceof ResourceNotFoundException) continue;
          throw err;
        }
      }
      marker = list.NextMarker;
    } while (marker);
    return null;
  }
}
