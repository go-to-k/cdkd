import {
  S3Client,
  PutBucketPolicyCommand,
  DeleteBucketPolicyCommand,
  GetBucketPolicyCommand,
  NoSuchBucket,
} from '@aws-sdk/client-s3';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * AWS S3 Bucket Policy Provider
 *
 * Implements resource provisioning for AWS::S3::BucketPolicy using the S3 SDK.
 * This is required because S3 Bucket Policy is not supported by Cloud Control API.
 */
export class S3BucketPolicyProvider implements ResourceProvider {
  private s3Client: S3Client;
  private logger = getLogger().child('S3BucketPolicyProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::S3::BucketPolicy', new Set(['Bucket', 'PolicyDocument'])],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.s3Client = awsClients.s3;
  }

  /**
   * Create an S3 bucket policy
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating S3 bucket policy ${logicalId}`);

    const bucketName = properties['Bucket'] as string | undefined;
    const policyDocument = properties['PolicyDocument'];

    if (!bucketName) {
      throw new ProvisioningError(
        `Bucket is required for S3 bucket policy ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    if (!policyDocument) {
      throw new ProvisioningError(
        `PolicyDocument is required for S3 bucket policy ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      // Serialize policy document
      const policyDoc =
        typeof policyDocument === 'string' ? policyDocument : JSON.stringify(policyDocument);

      await this.s3Client.send(
        new PutBucketPolicyCommand({
          Bucket: bucketName,
          Policy: policyDoc,
        })
      );

      this.logger.debug(`Successfully created S3 bucket policy ${logicalId}`);

      // Physical ID is the bucket name
      return {
        physicalId: bucketName,
        attributes: {},
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create S3 bucket policy ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        bucketName,
        cause
      );
    }
  }

  /**
   * Update an S3 bucket policy
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating S3 bucket policy ${logicalId}: ${physicalId}`);

    const bucketName = properties['Bucket'] as string | undefined;
    const policyDocument = properties['PolicyDocument'];

    if (!bucketName) {
      throw new ProvisioningError(
        `Bucket is required for S3 bucket policy ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    if (!policyDocument) {
      throw new ProvisioningError(
        `PolicyDocument is required for S3 bucket policy ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    try {
      // Serialize policy document
      const policyDoc =
        typeof policyDocument === 'string' ? policyDocument : JSON.stringify(policyDocument);

      await this.s3Client.send(
        new PutBucketPolicyCommand({
          Bucket: bucketName,
          Policy: policyDoc,
        })
      );

      this.logger.debug(`Successfully updated S3 bucket policy ${logicalId}`);

      return {
        physicalId: bucketName,
        wasReplaced: false,
        attributes: {},
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update S3 bucket policy ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete an S3 bucket policy
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting S3 bucket policy ${logicalId}: ${physicalId}`);

    try {
      try {
        await this.s3Client.send(
          new DeleteBucketPolicyCommand({
            Bucket: physicalId,
          })
        );
        this.logger.debug(`Successfully deleted S3 bucket policy ${logicalId}`);
      } catch (error) {
        if (error instanceof NoSuchBucket) {
          const clientRegion = await this.s3Client.config.region();
          assertRegionMatch(
            clientRegion,
            context?.expectedRegion,
            resourceType,
            logicalId,
            physicalId
          );
          this.logger.debug(`Bucket ${physicalId} does not exist, skipping policy deletion`);
          return;
        }
        // If the policy doesn't exist, that's OK too
        if (
          error instanceof Error &&
          (error.name === 'NoSuchBucketPolicy' || error.message.includes('does not have'))
        ) {
          const clientRegion = await this.s3Client.config.region();
          assertRegionMatch(
            clientRegion,
            context?.expectedRegion,
            resourceType,
            logicalId,
            physicalId
          );
          this.logger.debug(`Bucket policy for ${physicalId} does not exist, skipping`);
          return;
        }
        throw error;
      }
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete S3 bucket policy ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Read the AWS-current S3 bucket policy in CFn-property shape.
   *
   * Issues `GetBucketPolicy` against the bucket (physicalId === bucket
   * name) and surfaces:
   *   - `Bucket` — derived directly from `physicalId`.
   *   - `PolicyDocument` — JSON-parsed back to the object form cdkd state
   *     typically holds.
   *
   * Returns `undefined` when the bucket is gone (`NoSuchBucket`) or when
   * no policy is currently attached (`NoSuchBucketPolicy`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    let policyJson: string | undefined;
    try {
      const resp = await this.s3Client.send(new GetBucketPolicyCommand({ Bucket: physicalId }));
      policyJson = resp.Policy;
    } catch (err) {
      if (err instanceof NoSuchBucket) return undefined;
      // S3 throws `NoSuchBucketPolicy` (a 404) when no policy is attached.
      const e = err as { name?: string };
      if (e.name === 'NoSuchBucketPolicy') return undefined;
      throw err;
    }
    if (!policyJson) return undefined;

    const result: Record<string, unknown> = {
      Bucket: physicalId,
    };
    try {
      result['PolicyDocument'] = JSON.parse(policyJson) as unknown;
    } catch {
      result['PolicyDocument'] = policyJson;
    }
    return result;
  }

  /**
   * Adopt an existing S3 bucket policy into cdkd state.
   *
   * The operational identifier for an `S3::BucketPolicy` is the **bucket
   * name** — every AWS SDK call (`PutBucketPolicy` / `GetBucketPolicy` /
   * `DeleteBucketPolicy`) takes the bucket name via the `Bucket`
   * parameter, and cdkd's `create()` records `properties.Bucket` as the
   * resource's `physicalId` so subsequent `update()` / `delete()` /
   * `readCurrentState()` calls hit the right bucket. A `BucketPolicy`
   * has no standalone identity, no taggable ARN, and no `aws:cdk:path`
   * lookup — only the bucket itself is taggable.
   *
   * Resolution order (closes [#356](https://github.com/go-to-k/cdkd/issues/356)):
   *
   * 1. **`knownPhysicalId` if it matches an S3 bucket name shape.**
   *    Preserves the `cdkd import --resource <logicalId>=<bucketName>`
   *    path that has always worked.
   * 2. **`properties.Bucket` if it is a literal bucket name.** Closes
   *    the `--migrate-from-cloudformation` case: AWS CloudFormation's
   *    `DescribeStackResources` returns the CFn-generated policy NAME
   *    for `AWS::S3::BucketPolicy` (e.g.
   *    `MyStack-MyBucketPolicy-XXXXXXXXXX`), which is NOT a valid S3
   *    bucket name. The first time cdkd touches the imported state with
   *    that name, `readCurrentState` → `GetBucketPolicy` rejects it.
   * 3. **Hard error** when neither path resolves a bucket name. This
   *    covers (a) `--migrate-from-cloudformation` against a CFn stack
   *    whose template carries `Bucket: {Ref: <MyBucket>}` (the typical
   *    CDK shape) when the referenced bucket is NOT in the importable
   *    set (or hasn't been imported yet in the current run), and (b)
   *    explicit `--resource <logicalId>=<non-bucket-name>` typos.
   *    Pointing the user at `--resource <logicalId>=<bucketName>` is
   *    the recovery path that always works.
   *
   * Intrinsic-valued `Bucket` (e.g. `{Ref: <MyBucket>}`) falls into
   * branch 3 here even when the referenced sibling has been imported in
   * the same run — `import()` is called BEFORE
   * `resolveImportedProperties` runs the synth template's Properties
   * through the intrinsic resolver, so the raw intrinsic object is what
   * we see. The recovery message names `--resource` as the explicit
   * escape hatch.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    // 1. knownPhysicalId is a valid S3 bucket name — use it as-is
    //    (existing `--resource <logicalId>=<bucketName>` path).
    if (input.knownPhysicalId && isS3BucketName(input.knownPhysicalId)) {
      return { physicalId: input.knownPhysicalId, attributes: {} };
    }

    // 2. Properties.Bucket is a literal bucket name — use it
    //    (`--migrate-from-cloudformation` happy path when the template
    //    carries a literal Bucket entry, plus the no-knownPhysicalId
    //    auto path when properties is the only signal).
    const bucket = input.properties['Bucket'];
    if (typeof bucket === 'string' && isS3BucketName(bucket)) {
      return { physicalId: bucket, attributes: {} };
    }

    // 3. No bucket name recoverable — hard error rather than null.
    //    Returning null would silently mark the resource as
    //    `skipped-not-found` in the import summary and bake the unusable
    //    CFn-generated name into cdkd state for any caller passing
    //    `knownPhysicalId`. Naming the explicit override is the
    //    load-bearing recovery hint.
    const knownNote = input.knownPhysicalId
      ? ` Got knownPhysicalId='${input.knownPhysicalId}' (not a valid S3 bucket name; CloudFormation returns the policy resource NAME for AWS::S3::BucketPolicy, which is not the operational identifier).`
      : '';
    const bucketNote =
      bucket !== undefined
        ? ` Properties.Bucket=${JSON.stringify(bucket)} did not resolve to a literal bucket name (intrinsic-valued entries like {Ref: <Bucket>} are not resolved at import time).`
        : ' Properties.Bucket is missing.';
    throw new Error(
      `Cannot determine bucket name for ${input.resourceType} '${input.logicalId}'.${knownNote}${bucketNote} ` +
        `Re-run with --resource ${input.logicalId}=<bucketName> ` +
        `(e.g. my-bucket-12345) to point cdkd at the bucket this policy is attached to.`
    );
  }
}

/**
 * Recognize an S3 bucket name. AWS rules
 * (https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html):
 *   - 3-63 characters
 *   - lowercase letters, digits, hyphens, and dots
 *   - must start and end with a letter or digit
 *   - no consecutive dots
 *   - no `xn--` prefix (reserved for IDN bucket names)
 *
 * A practical pattern that excludes the obvious CFn-generated names like
 * `MyStack-MyBucketPolicy-XXXXXXXXXX` (which contain uppercase letters
 * and exceed 63 chars in common cases) while accepting every normal CDK
 * auto-generated and user-declared bucket name.
 */
function isS3BucketName(value: string): boolean {
  if (value.length < 3 || value.length > 63) return false;
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value)) return false;
  if (value.includes('..')) return false;
  if (value.startsWith('xn--')) return false;
  return true;
}
