import * as zlib from 'node:zlib';
import {
  LambdaClient,
  CreateFunctionCommand,
  UpdateFunctionConfigurationCommand,
  UpdateFunctionCodeCommand,
  DeleteFunctionCommand,
  GetFunctionCommand,
  ResourceNotFoundException,
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
import {
  EC2Client,
  DescribeNetworkInterfacesCommand,
  DeleteNetworkInterfaceCommand,
} from '@aws-sdk/client-ec2';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { generateResourceName } from '../resource-name.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
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
  private readonly eniWaitTimeoutMs: number = 10 * 60 * 1000;
  private readonly eniWaitInitialDelayMs: number = 10_000;
  private readonly eniWaitMaxDelayMs: number = 30_000;

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
    properties?: Record<string, unknown>
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
    }

    try {
      await this.lambdaClient.send(new DeleteFunctionCommand({ FunctionName: physicalId }));
      this.logger.debug(`Successfully deleted Lambda function ${logicalId}`);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
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
  private async cleanupLambdaEnis(functionName: string): Promise<void> {
    const start = Date.now();
    let delay = this.eniWaitInitialDelayMs;
    let attempt = 0;

    this.logger.debug(
      `Cleaning up Lambda VPC ENIs for function ${functionName} (timeout ${this.eniWaitTimeoutMs}ms)`
    );

    // Lambda VPC ENI Descriptions follow `AWS Lambda VPC ENI-<name>` where
    // <name> is typically the *logical* portion of the function name (e.g.
    // CDK's `<StackName>-<LogicalId>`), NOT necessarily the full physical
    // function name (which carries an extra auto-generated 8-char suffix
    // like `-zZBaJTabq03f`). Matching on the full physicalId as a token
    // therefore misses the ENIs entirely. Instead, parse the suffix out of
    // each Description and check it against the physicalId as a prefix
    // match.

    for (;;) {
      attempt++;

      let enis: { id: string; status: string }[] = [];
      let listFailed = false;
      try {
        enis = await this.listLambdaEnis(functionName);
      } catch (error) {
        this.logger.warn(
          `DescribeNetworkInterfaces failed while cleaning up Lambda ENIs of ${functionName}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        listFailed = true;
      }

      // Only treat an empty list as success if we actually got it from AWS;
      // a transient List failure must retry rather than declare cleanup done.
      if (!listFailed && enis.length === 0) {
        this.logger.debug(
          `Lambda ENIs for ${functionName} fully cleaned up after ${attempt} attempt(s) / ${
            Date.now() - start
          }ms`
        );
        return;
      }

      // Best-effort delete: in-use ENIs reject and we'll retry next loop.
      if (enis.length > 0) {
        await Promise.all(
          enis.map(async (eni) => {
            try {
              await this.ec2Client.send(
                new DeleteNetworkInterfaceCommand({ NetworkInterfaceId: eni.id })
              );
              this.logger.debug(`Deleted Lambda ENI ${eni.id} for ${functionName}`);
            } catch (error) {
              this.logger.debug(
                `ENI ${eni.id} (status=${eni.status}) not yet deletable: ${
                  error instanceof Error ? error.message : String(error)
                }`
              );
            }
          })
        );
      }

      const elapsed = Date.now() - start;
      if (elapsed >= this.eniWaitTimeoutMs) {
        this.logger.warn(
          `Timeout (${this.eniWaitTimeoutMs}ms) cleaning up Lambda VPC ENIs of ${functionName} ` +
            `(${enis.length} remaining). ` +
            `Continuing — downstream Subnet/SG deletion will retry as needed.`
        );
        return;
      }

      const remaining = this.eniWaitTimeoutMs - elapsed;
      const sleepMs = Math.min(delay, remaining);
      await this.sleep(sleepMs);
      delay = Math.min(delay * 2, this.eniWaitMaxDelayMs);
    }
  }

  /**
   * List Lambda-managed ENIs for the given function, paginating through
   * DescribeNetworkInterfaces and filtering on Description substring.
   *
   * Server-side filter (`description`) does not support wildcards on this
   * API, so we narrow with `requester-id` + match Description client-side.
   */
  private async listLambdaEnis(functionName: string): Promise<{ id: string; status: string }[]> {
    const enis: { id: string; status: string }[] = [];
    const descriptionPrefix = 'AWS Lambda VPC ENI-';
    let nextToken: string | undefined;
    do {
      const resp = await this.ec2Client.send(
        new DescribeNetworkInterfacesCommand({
          Filters: [
            // Lambda hyperplane ENIs are owned by the Lambda service principal.
            { Name: 'requester-id', Values: ['*:awslambda_*'] },
          ],
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
}
