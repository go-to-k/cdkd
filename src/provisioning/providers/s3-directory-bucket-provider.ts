import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  HeadBucketCommand,
  ListDirectoryBucketsCommand,
  GetBucketTaggingCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { EC2Client, DescribeAvailabilityZonesCommand } from '@aws-sdk/client-ec2';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceName } from '../resource-name.js';
import { matchesCdkPath, resolveExplicitPhysicalId } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * SDK Provider for AWS::S3Express::DirectoryBucket
 *
 * Uses S3 SDK directly for S3 Express Directory Bucket operations.
 * Directory buckets use the S3 Express One Zone storage class with
 * single-AZ data redundancy.
 */
export class S3DirectoryBucketProvider implements ResourceProvider {
  private s3Client: S3Client;
  private stsClient: STSClient;
  private logger = getLogger().child('S3DirectoryBucketProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::S3Express::DirectoryBucket', new Set(['DataRedundancy', 'LocationName', 'BucketName'])],
  ]);

  private ec2Client: EC2Client | undefined;
  private readonly providerRegion = process.env['AWS_REGION'];

  constructor() {
    const awsClients = getAwsClients();
    this.s3Client = awsClients.s3;
    this.stsClient = awsClients.sts;
  }

  private getEc2Client(): EC2Client {
    if (!this.ec2Client) {
      this.ec2Client = new EC2Client(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.ec2Client;
  }

  /**
   * Convert AZ name (us-east-1a) to AZ ID (use1-az1) via EC2 DescribeAvailabilityZones
   */
  private async getAzId(azName: string): Promise<string> {
    try {
      const response = await this.getEc2Client().send(
        new DescribeAvailabilityZonesCommand({
          ZoneNames: [azName],
        })
      );
      const azId = response.AvailabilityZones?.[0]?.ZoneId;
      if (azId) {
        this.logger.debug(`Resolved AZ name ${azName} → AZ ID ${azId}`);
        return azId;
      }
    } catch (error) {
      this.logger.debug(
        `Failed to resolve AZ ID for ${azName}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    // Fallback: return the AZ name as-is
    return azName;
  }

  /**
   * Get the region from the S3 client config
   */
  private async getRegion(): Promise<string> {
    const region = await this.s3Client.config.region();
    return region || 'us-east-1';
  }

  /**
   * Get the AWS account ID via STS
   */
  private async getAccountId(): Promise<string> {
    const identity = await this.stsClient.send(new GetCallerIdentityCommand({}));
    return identity.Account!;
  }

  /**
   * Build attributes for a directory bucket
   */
  private async buildAttributes(bucketName: string): Promise<Record<string, unknown>> {
    const region = await this.getRegion();
    const accountId = await this.getAccountId();
    return {
      Arn: `arn:aws:s3express:${region}:${accountId}:bucket/${bucketName}`,
    };
  }

  /**
   * Create an S3 Express Directory Bucket
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating S3 Express Directory Bucket ${logicalId}`);

    const dataRedundancy = (properties['DataRedundancy'] as string) || 'SingleAvailabilityZone';
    // CFn LocationName: "us-east-1a--x-s3" → extract AZ name: "us-east-1a"
    const cfnLocationName = properties['LocationName'] as string | undefined;
    const azName = cfnLocationName?.replace(/--x-s3$/, '') || 'us-east-1a';

    // S3 CreateBucket API requires AZ ID (use1-az1), not AZ name (us-east-1a)
    const azId = await this.getAzId(azName);

    // Generate bucket name if not specified
    // Directory bucket names must follow: {name}--{az-id}--x-s3
    let bucketName = properties['BucketName'] as string | undefined;
    if (!bucketName) {
      const baseName = generateResourceName(logicalId, {
        maxLength: 64,
        lowercase: true,
      });
      bucketName = `${baseName}--${azId}--x-s3`;
    }

    try {
      await this.s3Client.send(
        new CreateBucketCommand({
          Bucket: bucketName,
          CreateBucketConfiguration: {
            Bucket: {
              Type: 'Directory',
              DataRedundancy: dataRedundancy as 'SingleAvailabilityZone',
            },
            Location: {
              Name: azId,
              Type: 'AvailabilityZone',
            },
          },
        })
      );
      this.logger.debug(`Created S3 Express Directory Bucket: ${bucketName}`);

      const attributes = await this.buildAttributes(bucketName);

      return {
        physicalId: bucketName,
        attributes,
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create S3 Express Directory Bucket ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        bucketName,
        cause
      );
    }
  }

  /**
   * Update an S3 Express Directory Bucket
   *
   * Most properties are immutable, so this is a no-op.
   */
  update(
    logicalId: string,
    physicalId: string,
    _resourceType: string,
    _properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(
      `Update for S3 Express Directory Bucket ${logicalId} is a no-op (immutable properties)`
    );
    return Promise.resolve({
      physicalId,
      wasReplaced: false,
    });
  }

  /**
   * Delete an S3 Express Directory Bucket
   *
   * Must empty the bucket before deletion. Directory buckets do not support
   * versioning, so only current objects need to be deleted.
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting S3 Express Directory Bucket ${logicalId}: ${physicalId}`);

    try {
      // Empty the bucket first
      await this.emptyBucket(physicalId);

      // Delete the bucket
      await this.s3Client.send(
        new DeleteBucketCommand({
          Bucket: physicalId,
        })
      );
      this.logger.debug(`Successfully deleted S3 Express Directory Bucket ${logicalId}`);
    } catch (error) {
      // Bucket not found = already deleted (idempotent)
      if (
        error instanceof Error &&
        (error.name === 'NoSuchBucket' || error.name === 'BucketNotFound')
      ) {
        const clientRegion = await this.s3Client.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Bucket ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete S3 Express Directory Bucket ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Empty all objects from a directory bucket.
   * Lists and deletes objects in batches of 1000.
   */
  private async emptyBucket(bucketName: string): Promise<void> {
    let continuationToken: string | undefined;

    do {
      const listResponse = await this.s3Client.send(
        new ListObjectsV2Command({
          Bucket: bucketName,
          MaxKeys: 1000,
          ContinuationToken: continuationToken,
        })
      );

      const objects = listResponse.Contents;
      if (objects && objects.length > 0) {
        await this.s3Client.send(
          new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: {
              Objects: objects.map((obj) => ({ Key: obj.Key })),
              Quiet: true,
            },
          })
        );
        this.logger.debug(`Deleted ${objects.length} objects from bucket ${bucketName}`);
      }

      continuationToken = listResponse.IsTruncated ? listResponse.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  /**
   * Read the AWS-current S3 Express Directory Bucket configuration in
   * CFn-property shape.
   *
   * Issues `HeadBucket` to verify existence and surfaces `BucketName`
   * (the physicalId). `DataRedundancy` and `LocationName` are not exposed
   * by any cheap S3 Express API — the only way to inspect them is by
   * parsing the bucket name's `--<az-id>--x-s3` suffix, which is best
   * effort. We surface them when they are recoverable from the bucket
   * name to give the comparator a chance to detect mismatches.
   *
   * `--<az-id>--x-s3` suffix parsing: directory bucket names follow the
   * format `<base>--<az-id>--x-s3`, e.g.
   * `my-bucket--use1-az1--x-s3`. We don't reverse the AZ-ID -> AZ-name
   * mapping here (that would require a per-call EC2 `DescribeAvailabilityZones`
   * round-trip); state's `LocationName` is `us-east-1a--x-s3`-style,
   * while the bucket name carries the AZ-ID `use1-az1`. Cross-region
   * mapping is too expensive for v1 — we omit `LocationName` from the
   * snapshot and rely on the comparator's "key absent in state never
   * drifts" rule to no-op against state.
   *
   * Returns `undefined` when the bucket is gone (`HeadBucket` returns
   * `NotFound` / `NoSuchBucket`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    try {
      await this.s3Client.send(new HeadBucketCommand({ Bucket: physicalId }));
    } catch (err) {
      const e = err as { name?: string };
      if (e.name === 'NotFound' || e.name === 'NoSuchBucket' || e.name === 'BucketNotFound') {
        return undefined;
      }
      throw err;
    }

    const result: Record<string, unknown> = {
      BucketName: physicalId,
    };

    // Best-effort: directory bucket names always carry `--x-s3`. Default
    // redundancy is `SingleAvailabilityZone` for every directory bucket
    // today (it's the only DataRedundancy AWS supports for S3 Express),
    // so surfacing it here ensures the comparator does not flag drift
    // when state holds the same value.
    if (physicalId.endsWith('--x-s3')) {
      result['DataRedundancy'] = 'SingleAvailabilityZone';
    }

    return result;
  }

  /**
   * Adopt an existing S3 Express Directory Bucket into cdkd state.
   *
   * Lookup order:
   *  1. `--resource <id>=<name>` override or `Properties.BucketName` →
   *     verify via `HeadBucket`.
   *  2. `ListDirectoryBuckets` paginator + `GetBucketTagging` (TagSet:
   *     Tag[]) and match `aws:cdk:path`. `GetBucketTagging` may surface
   *     `NoSuchTagSet` / `AccessDenied` per-bucket — those are skipped
   *     rather than fatal.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'BucketName');
    if (explicit) {
      try {
        await this.s3Client.send(new HeadBucketCommand({ Bucket: explicit }));
        return { physicalId: explicit, attributes: {} };
      } catch (err) {
        const e = err as { name?: string };
        if (e.name === 'NotFound' || e.name === 'NoSuchBucket') return null;
        throw err;
      }
    }

    if (!input.cdkPath) return null;

    let token: string | undefined;
    do {
      const list = await this.s3Client.send(
        new ListDirectoryBucketsCommand({ ...(token && { ContinuationToken: token }) })
      );
      for (const b of list.Buckets ?? []) {
        if (!b.Name) continue;
        try {
          const tagging = await this.s3Client.send(new GetBucketTaggingCommand({ Bucket: b.Name }));
          if (matchesCdkPath(tagging.TagSet, input.cdkPath)) {
            return { physicalId: b.Name, attributes: {} };
          }
        } catch (err) {
          const e = err as { name?: string };
          if (e.name === 'NoSuchTagSet' || e.name === 'AccessDenied') continue;
          throw err;
        }
      }
      token = list.ContinuationToken;
    } while (token);
    return null;
  }
}
