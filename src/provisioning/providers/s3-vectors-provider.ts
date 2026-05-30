import {
  S3VectorsClient,
  CreateVectorBucketCommand,
  DeleteVectorBucketCommand,
  GetVectorBucketCommand,
  ListIndexesCommand,
  ListVectorBucketsCommand,
  ListTagsForResourceCommand,
  DeleteIndexCommand,
  type SseType,
} from '@aws-sdk/client-s3vectors';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { CDK_PATH_TAG, normalizeAwsTagsToCfn } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * SDK Provider for AWS S3 Vectors resources
 *
 * Supports:
 * - AWS::S3Vectors::VectorBucket
 *
 * S3 Vectors CreateVectorBucket is synchronous - the CC API adds unnecessary
 * polling overhead for operations that complete immediately.
 */
export class S3VectorsProvider implements ResourceProvider {
  private client: S3VectorsClient | undefined;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('S3VectorsProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::S3Vectors::VectorBucket',
      new Set(['VectorBucketName', 'EncryptionConfiguration', 'Tags']),
    ],
  ]);

  private getClient(): S3VectorsClient {
    if (!this.client) {
      this.client = new S3VectorsClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.client;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    switch (resourceType) {
      case 'AWS::S3Vectors::VectorBucket':
        return this.createVectorBucket(logicalId, resourceType, properties);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId
        );
    }
  }

  update(
    logicalId: string,
    _physicalId: string,
    resourceType: string,
    _properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    switch (resourceType) {
      case 'AWS::S3Vectors::VectorBucket':
        // VectorBucket does not support updates
        return Promise.resolve({ physicalId: _physicalId, wasReplaced: false });
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          _physicalId
        );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    switch (resourceType) {
      case 'AWS::S3Vectors::VectorBucket':
        return this.deleteVectorBucket(logicalId, physicalId, resourceType, context);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  // ─── AWS::S3Vectors::VectorBucket ─────────────────────────────────

  private async createVectorBucket(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating S3 VectorBucket ${logicalId}`);

    const vectorBucketName = properties['VectorBucketName'] as string | undefined;
    if (!vectorBucketName) {
      throw new ProvisioningError(
        `VectorBucketName is required for S3 VectorBucket ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const encryptionConfiguration = properties['EncryptionConfiguration'] as
      | Record<string, unknown>
      | undefined;

    // CFn shape: `Tags: [{ Key, Value }]`. SDK shape:
    // `tags?: Record<string, string>`. Convert + omit-when-absent (an
    // empty array would force a no-op CloudTrail event per Tag).
    const tagsArray = properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined;
    const tags =
      tagsArray && tagsArray.length > 0
        ? tagsArray.reduce<Record<string, string>>((acc, t) => {
            if (t.Key !== undefined && t.Value !== undefined) acc[t.Key] = t.Value;
            return acc;
          }, {})
        : undefined;

    try {
      const result = await this.getClient().send(
        new CreateVectorBucketCommand({
          vectorBucketName,
          encryptionConfiguration: encryptionConfiguration
            ? {
                sseType: encryptionConfiguration['SSEType'] as SseType | undefined,
                kmsKeyArn: encryptionConfiguration['KMSKeyArn'] as string | undefined,
              }
            : undefined,
          ...(tags && Object.keys(tags).length > 0 ? { tags } : {}),
        })
      );

      const vectorBucketArn = result.vectorBucketArn ?? '';

      this.logger.debug(`Successfully created S3 VectorBucket ${logicalId}: ${vectorBucketName}`);

      return {
        physicalId: vectorBucketName,
        attributes: {
          VectorBucketArn: vectorBucketArn,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create S3 VectorBucket ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async deleteVectorBucket(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting S3 VectorBucket ${logicalId}: ${physicalId}`);

    try {
      // Step 1: Delete all indexes in the vector bucket
      await this.emptyVectorBucket(logicalId, physicalId);

      // Step 2: Delete the vector bucket itself
      await this.getClient().send(
        new DeleteVectorBucketCommand({
          vectorBucketName: physicalId,
        })
      );
      this.logger.debug(`Successfully deleted S3 VectorBucket ${logicalId}`);
    } catch (error) {
      // Idempotency: treat not-found as success
      if (this.isNotFoundError(error)) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`S3 VectorBucket ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete S3 VectorBucket ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Empty a vector bucket by listing and deleting all indexes.
   * Paginates through all indexes using NextToken.
   */
  private async emptyVectorBucket(logicalId: string, vectorBucketName: string): Promise<void> {
    let nextToken: string | undefined;

    do {
      const listResult = await this.getClient().send(
        new ListIndexesCommand({
          vectorBucketName,
          nextToken,
        })
      );

      const indexes = listResult.indexes ?? [];
      for (const index of indexes) {
        if (index.indexName) {
          this.logger.debug(`Deleting index ${index.indexName} from VectorBucket ${logicalId}`);
          await this.getClient().send(
            new DeleteIndexCommand({
              vectorBucketName,
              indexName: index.indexName,
            })
          );
        }
      }

      nextToken = listResult.nextToken;
    } while (nextToken);
  }

  /**
   * Read the AWS-current S3 Vector Bucket configuration in CFn-property
   * shape.
   *
   * Issues `GetVectorBucket` for the bucket name (the physical id) and
   * surfaces `VectorBucketName` and `EncryptionConfiguration` (re-shaping
   * the camelCase SDK response back to PascalCase CFn property names —
   * `sseType` → `SSEType`, `kmsKeyArn` → `KMSKeyArn`).
   *
   * Returns `undefined` when the bucket is gone (`NotFoundException` /
   * `NoSuchVectorBucket`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    let resp;
    try {
      resp = await this.getClient().send(
        new GetVectorBucketCommand({ vectorBucketName: physicalId })
      );
    } catch (err) {
      if (this.isNotFoundError(err)) return undefined;
      throw err;
    }

    const result: Record<string, unknown> = {};
    const bucket = resp.vectorBucket;
    if (bucket?.vectorBucketName !== undefined) {
      result['VectorBucketName'] = bucket.vectorBucketName;
    } else {
      result['VectorBucketName'] = physicalId;
    }
    if (bucket?.encryptionConfiguration) {
      const enc: Record<string, unknown> = {};
      const sseType = bucket.encryptionConfiguration.sseType;
      if (sseType !== undefined) {
        enc['SSEType'] = sseType;
      }
      // Class 1 guard (docs/provider-development.md § 3b): KMSKeyArn is
      // KMS-only — only valid when SSEType === 'aws:kms'. AWS will not
      // return kmsKeyArn for AES256-encrypted buckets, but defend
      // against a future SDK that surfaces an account-default KMS key
      // ARN on AES256 responses (which would round-trip back via
      // `cdkd drift --revert` and AWS would reject as
      // "KMSKeyArn is only valid when SSEType is aws:kms").
      if (sseType === 'aws:kms' && bucket.encryptionConfiguration.kmsKeyArn !== undefined) {
        enc['KMSKeyArn'] = bucket.encryptionConfiguration.kmsKeyArn;
      }
      if (Object.keys(enc).length > 0) result['EncryptionConfiguration'] = enc;
    }
    // `Tags`: read back via `ListTagsForResource(resourceArn=vectorBucketArn)`
    // and convert SDK `Record<string, string>` → CFn `[{ Key, Value }]`.
    // The conversion goes through `normalizeAwsTagsToCfn` which strips
    // CDK's auto-injected `aws:cdk:path` (and any other `aws:`-prefixed
    // tag AWS reserves) — without that filter every CDK-deployed bucket
    // would fire false-positive drift on its first clean `cdkd drift` run
    // (state has only user tags; AWS-current carries the `aws:cdk:path`
    // overlay CDK adds for stack-resource resolution). When the bucket's
    // ARN is unexpectedly absent in the GetVectorBucket response (SDK
    // shape regression) the `Tags` field is intentionally omitted from
    // the readback result — the drift comparator's state-keys-only walk
    // then surfaces no false positive, while a `logger.debug` notes the
    // shape mismatch for operator investigation.
    if (bucket?.vectorBucketArn) {
      try {
        const tagsResp = await this.getClient().send(
          new ListTagsForResourceCommand({ resourceArn: bucket.vectorBucketArn })
        );
        result['Tags'] = normalizeAwsTagsToCfn(tagsResp.tags);
      } catch (err) {
        this.logger.debug(
          `S3Vectors ListTagsForResource(${bucket.vectorBucketArn}) failed: ${err instanceof Error ? err.message : String(err)}`
        );
        result['Tags'] = [];
      }
    } else {
      this.logger.debug(
        `S3Vectors GetVectorBucket(${physicalId}) returned no vectorBucketArn; skipping Tags readback`
      );
    }
    return result;
  }

  /**
   * Adopt an existing S3 Vector Bucket into cdkd state.
   *
   * Lookup order:
   *  1. `--resource <id>=<name>` override or `Properties.VectorBucketName`
   *     → verify via `GetVectorBucket`. The physical id is the bucket name.
   *  2. `ListVectorBuckets` paginator + `ListTagsForResource(resourceArn)`
   *     (tags map keyed by tag name) and match `aws:cdk:path`.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit =
      input.knownPhysicalId ??
      (typeof input.properties?.['VectorBucketName'] === 'string' &&
      input.properties['VectorBucketName'].length > 0
        ? input.properties['VectorBucketName']
        : undefined);

    if (explicit) {
      try {
        await this.getClient().send(new GetVectorBucketCommand({ vectorBucketName: explicit }));
        return { physicalId: explicit, attributes: {} };
      } catch (err) {
        if (this.isNotFoundError(err)) return null;
        throw err;
      }
    }

    if (!input.cdkPath) return null;

    let token: string | undefined;
    do {
      const list = await this.getClient().send(
        new ListVectorBucketsCommand({ ...(token && { nextToken: token }) })
      );
      for (const bucket of list.vectorBuckets ?? []) {
        if (!bucket.vectorBucketName || !bucket.vectorBucketArn) continue;
        try {
          const tagsResp = await this.getClient().send(
            new ListTagsForResourceCommand({ resourceArn: bucket.vectorBucketArn })
          );
          if (tagsResp.tags?.[CDK_PATH_TAG] === input.cdkPath) {
            return { physicalId: bucket.vectorBucketName, attributes: {} };
          }
        } catch (err) {
          if (this.isNotFoundError(err)) continue;
          throw err;
        }
      }
      token = list.nextToken;
    } while (token);
    return null;
  }

  private isNotFoundError(error: unknown): boolean {
    if (error instanceof Error) {
      const name = error.name;
      return (
        name === 'NotFoundException' ||
        name === 'ResourceNotFoundException' ||
        name === 'NoSuchVectorBucket' ||
        name === 'NoSuchBucket'
      );
    }
    return false;
  }
}
