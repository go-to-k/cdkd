import * as zlib from 'node:zlib';
import {
  LambdaClient,
  CreateFunctionCommand,
  UpdateFunctionConfigurationCommand,
  UpdateFunctionCodeCommand,
  DeleteFunctionCommand,
  GetFunctionCommand,
  ListFunctionsCommand,
  ListTagsCommand,
  ResourceNotFoundException,
  waitUntilFunctionActiveV2,
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
} from '@aws-sdk/client-lambda';
import { CDK_PATH_TAG, resolveExplicitPhysicalId } from '../import-helpers.js';
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

  // Budget for the post-CreateFunction / post-Update wait that blocks until
  // Configuration.State === 'Active' and LastUpdateStatus === 'Successful'.
  // Must NOT be skipped by --no-wait: downstream resources (Custom Resource
  // Invokes, EventSourceMappings, etc.) cannot operate against a function
  // still in Pending / InProgress, so this is required for correctness, not
  // a "convenience wait" like CloudFront / RDS readiness.
  // Seconds (the SDK waiter contract is seconds, not ms).
  private readonly functionReadyMaxWaitSeconds: number = 10 * 60;

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
        Code: this.buildCode(code),
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
        Tags: tags,
      };

      const response = await this.lambdaClient.send(new CreateFunctionCommand(createParams));

      // CreateFunction returns synchronously while the function is still in
      // `Pending` state — the runtime image, VPC ENI attachment, and layer
      // initialization happen asynchronously. Returning here without waiting
      // breaks downstream resources that try to invoke the function as soon
      // as it's marked `created`: a Lambda-backed Custom Resource invoked
      // mid-Pending fails with "The function is currently in the following
      // state: Pending". CloudFormation sidesteps this by polling
      // GetFunction until State=Active before emitting CREATE_COMPLETE; we
      // mirror that contract via the SDK's built-in waiter.
      //
      // Intentionally NOT gated on CDKD_NO_WAIT: --no-wait skips
      // convenience waits for resources that don't block siblings (e.g.
      // CloudFront propagation), but a Pending Lambda DOES block siblings.
      await this.waitForFunctionActive(logicalId, resourceType, functionName);

      this.logger.debug(`Successfully created Lambda function ${logicalId}: ${functionName}`);

      return {
        physicalId: response.FunctionName || functionName,
        attributes: {
          Arn: response.FunctionArn,
          FunctionName: response.FunctionName,
        },
      };
    } catch (error) {
      if (error instanceof ProvisioningError) {
        throw error;
      }
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
        const builtCode = this.buildCode(newCode);
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

      // Get updated function info for attributes
      const getResponse = await this.lambdaClient.send(
        new GetFunctionCommand({ FunctionName: physicalId })
      );

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Arn: getResponse.Configuration?.FunctionArn,
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
   * Block until the function's State === 'Active'.
   *
   * Used after CreateFunction. Wraps the SDK's built-in
   * `waitUntilFunctionActiveV2` (acceptors: SUCCESS=Active, FAILURE=Failed,
   * RETRY=Pending). The waiter throws on FAILURE / TIMEOUT — both surface
   * as `ProvisioningError` with the function-name as physicalId so the
   * deploy engine's per-resource error handling treats them identically to
   * a CreateFunction failure.
   */
  private async waitForFunctionActive(
    logicalId: string,
    resourceType: string,
    functionName: string
  ): Promise<void> {
    try {
      await waitUntilFunctionActiveV2(
        { client: this.lambdaClient, maxWaitTime: this.functionReadyMaxWaitSeconds },
        { FunctionName: functionName }
      );
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Lambda function ${logicalId} did not reach Active state: ${
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
   * Block until the function's LastUpdateStatus === 'Successful'.
   *
   * Used after UpdateFunctionConfiguration / UpdateFunctionCode. Wraps the
   * SDK's `waitUntilFunctionUpdatedV2` (acceptors: SUCCESS=Successful,
   * FAILURE=Failed, RETRY=InProgress). Same error-wrapping contract as
   * `waitForFunctionActive`.
   */
  private async waitForFunctionUpdated(
    logicalId: string,
    resourceType: string,
    functionName: string
  ): Promise<void> {
    try {
      await waitUntilFunctionUpdatedV2(
        { client: this.lambdaClient, maxWaitTime: this.functionReadyMaxWaitSeconds },
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
  private buildCode(code: Record<string, unknown>): FunctionCode {
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
      result.ZipFile = this.createZipFromInlineCode(code['ZipFile'] as string);
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
   * containing the code as index.* (matching the Handler).
   */
  private createZipFromInlineCode(code: string): Uint8Array {
    const fileData = Buffer.from(code, 'utf-8');
    const crc32 = this.crc32(fileData);
    const compressedData = zlib.deflateRawSync(fileData);

    // Determine filename from handler or default to index.py
    const fileName = Buffer.from('index.py');
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
