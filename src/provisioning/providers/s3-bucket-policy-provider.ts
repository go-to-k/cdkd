import {
  S3Client,
  PutBucketPolicyCommand,
  DeleteBucketPolicyCommand,
  GetBucketPolicyCommand,
  NoSuchBucket,
} from '@aws-sdk/client-s3';
import { GetCloudFrontOriginAccessIdentityCommand } from '@aws-sdk/client-cloudfront';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';

/**
 * Matches a CloudFront Origin Access Identity (OAI) principal ARN, e.g.
 * `arn:aws:iam::cloudfront:user/CloudFront Origin Access Identity E1UREC9EUJDVG5`.
 * The capture group is the OAI id, which resolves to the OAI's S3 canonical
 * user id via `GetCloudFrontOriginAccessIdentity`.
 */
const OAI_USER_ARN_RE =
  /^arn:aws[a-z-]*:iam::cloudfront:user\/CloudFront Origin Access Identity ([A-Z0-9]+)$/;

/**
 * Matches a bare IAM principal unique id (e.g. `AIDAIBJOSOJSBZ753XCAW`). S3
 * returns an OAI grant's principal in this transient form immediately after
 * `PutBucketPolicy` (before it settles to the friendly cloudfront-user ARN).
 * It carries no recoverable link back to the OAI, so it can only be
 * canonicalized by matching against the template's `{ CanonicalUser }` form.
 */
const IAM_UNIQUE_ID_RE = /^A[A-Z0-9]{15,}$/;

/**
 * Process-lifetime cache of OAI id -> S3 canonical user id (or `null` when the
 * lookup failed / the OAI is gone), so a `cdkd drift` run with many OAI-granting
 * bucket policies issues at most one `GetCloudFrontOriginAccessIdentity` per OAI.
 */
const oaiCanonicalUserIdCache = new Map<string, string | null>();

/** Test-only: reset the OAI canonical-user-id cache between unit tests. */
export function clearOaiCanonicalUserIdCacheForTest(): void {
  oaiCanonicalUserIdCache.clear();
}

/**
 * Build an `oaiId -> S3CanonicalUserId` map from the same-stack sibling
 * `AWS::CloudFront::CloudFrontOriginAccessIdentity` resources in the read
 * context. The OAI's `S3CanonicalUserId` is a readOnly attribute cdkd already
 * resolved at deploy time (the bucket-policy grant `Fn::GetAtt`s it), so this
 * lets the bucket-policy drift read reconcile the OAI principal forms with zero
 * extra AWS calls (and no `cloudfront:GetCloudFrontOriginAccessIdentity` IAM
 * grant) whenever the OAI lives in the same stack. The OAI resource's
 * `physicalId` IS the OAI id embedded in the cloudfront-user ARN.
 */
function buildSiblingOaiCanonicalMap(context?: ReadCurrentStateContext): Map<string, string> {
  const map = new Map<string, string>();
  for (const sib of Object.values(context?.siblings ?? {})) {
    if (sib.resourceType !== 'AWS::CloudFront::CloudFrontOriginAccessIdentity') continue;
    const canonical = sib.attributes?.['S3CanonicalUserId'];
    if (sib.physicalId && typeof canonical === 'string') {
      map.set(sib.physicalId, canonical);
    }
  }
  return map;
}

/**
 * Pull the `Statement` array out of a parsed policy document, tolerating both
 * the single-object and array shapes (and a non-object input). Returns the live
 * statement objects so callers can mutate their `Principal` in place.
 */
function extractStatements(policyDoc: unknown): Record<string, unknown>[] {
  if (!policyDoc || typeof policyDoc !== 'object') return [];
  const stmt = (policyDoc as Record<string, unknown>)['Statement'];
  const arr = Array.isArray(stmt) ? stmt : stmt ? [stmt] : [];
  return arr.filter(
    (s): s is Record<string, unknown> => !!s && typeof s === 'object' && !Array.isArray(s)
  );
}

/**
 * Find the `CanonicalUser` principal of the template statement that matches a
 * given AWS-side statement by Effect / Action / Resource, used to canonicalize
 * the unresolvable transient `{ AWS: <IAM-unique-id> }` OAI form. Returns
 * `undefined` when no single matching template statement carries one.
 */
function findTemplateCanonicalUser(
  awsStmt: Record<string, unknown>,
  templateStmts: Record<string, unknown>[]
): string | undefined {
  const key = (s: Record<string, unknown>): string =>
    JSON.stringify([s['Effect'], s['Action'], s['Resource']]);
  const want = key(awsStmt);
  const matches = templateStmts.filter((t) => key(t) === want);
  if (matches.length !== 1) return undefined;
  const principal = matches[0]!['Principal'];
  if (!principal || typeof principal !== 'object' || Array.isArray(principal)) return undefined;
  const canonical = (principal as Record<string, unknown>)['CanonicalUser'];
  return typeof canonical === 'string' ? canonical : undefined;
}
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  ReadCurrentStateContext,
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
    _resourceType: string,
    properties?: Record<string, unknown>,
    context?: ReadCurrentStateContext
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
    let policyDoc: unknown;
    try {
      policyDoc = JSON.parse(policyJson) as unknown;
    } catch {
      result['PolicyDocument'] = policyJson;
      return result;
    }

    // Canonicalize CloudFront OAI grant principals (issue #872). AWS returns an
    // OAI grant's principal in THREE unstable forms over a policy's lifetime —
    // the template's `{ CanonicalUser: <64-hex> }`, a transient
    // `{ AWS: <IAM-unique-id> }` right after PutBucketPolicy, and the settled
    // `{ AWS: arn:aws:iam::cloudfront:user/CloudFront Origin Access Identity <id> }`.
    // The drift comparator sees these as different and fires a guaranteed false
    // positive. Normalize every recognizable OAI principal back to the canonical
    // user id form (matching what the template carries + what cdkd state holds).
    await this.normalizeOaiPrincipals(policyDoc, properties, context);
    result['PolicyDocument'] = policyDoc;
    return result;
  }

  /**
   * Normalize CloudFront OAI grant principals in a (parsed) bucket policy to
   * the `{ CanonicalUser: <id> }` form, in place (issue #872):
   *   - `{ AWS: <oai-user-arn> }` -> map the OAI id in the ARN to its
   *     `S3CanonicalUserId`, preferring the sibling OAI resource's already-read
   *     state attributes (zero AWS call — the OAI's `S3CanonicalUserId` is a
   *     readOnly attribute cdkd already resolved at deploy time) and falling
   *     back to `GetCloudFrontOriginAccessIdentity` only when the OAI is not a
   *     same-stack sibling (e.g. an imported / external OAI). This is the SAFE
   *     path: a genuinely-different OAI resolves to a different canonical id, so
   *     real drift is still detected.
   *   - `{ AWS: <bare-IAM-unique-id> }` -> the transient post-PutBucketPolicy
   *     rendering, which carries no recoverable link to the OAI. Canonicalize
   *     it only by matching the corresponding template statement (same Effect /
   *     Action / Resource) carrying a `{ CanonicalUser }` principal. A user
   *     cannot author a bare IAM unique id as a bucket-policy principal, so
   *     adopting the template form here only fires for AWS's transient
   *     rendering — it cannot mask a real principal change.
   * Statements whose principal is not a single-string `AWS` OAI form are left
   * untouched.
   */
  private async normalizeOaiPrincipals(
    policyDoc: unknown,
    templateProps?: Record<string, unknown>,
    context?: ReadCurrentStateContext
  ): Promise<void> {
    const stmts = extractStatements(policyDoc);
    if (stmts.length === 0) return;
    const templateStmts = extractStatements(templateProps?.['PolicyDocument']);
    const siblingCanonicalById = buildSiblingOaiCanonicalMap(context);

    for (const stmt of stmts) {
      const principal = stmt['Principal'];
      if (!principal || typeof principal !== 'object' || Array.isArray(principal)) continue;
      const awsPrincipal = (principal as Record<string, unknown>)['AWS'];
      if (typeof awsPrincipal !== 'string') continue;

      const arnMatch = OAI_USER_ARN_RE.exec(awsPrincipal);
      if (arnMatch) {
        const oaiId = arnMatch[1]!;
        // Prefer the sibling OAI's already-read state attribute; only call AWS
        // when the OAI is not a same-stack sibling.
        const canonical =
          siblingCanonicalById.get(oaiId) ?? (await this.resolveOaiCanonicalUserId(oaiId));
        if (canonical) stmt['Principal'] = { CanonicalUser: canonical };
        continue;
      }

      if (IAM_UNIQUE_ID_RE.test(awsPrincipal)) {
        const tmplCanonical = findTemplateCanonicalUser(stmt, templateStmts);
        if (tmplCanonical) stmt['Principal'] = { CanonicalUser: tmplCanonical };
      }
    }
  }

  /**
   * Resolve a CloudFront OAI id to its S3 canonical user id via
   * `GetCloudFrontOriginAccessIdentity`, cached for the process lifetime. Used
   * only as a FALLBACK when the OAI is not a same-stack sibling (its
   * `S3CanonicalUserId` is otherwise read straight from sibling state — see
   * {@link buildSiblingOaiCanonicalMap}). Best-effort: returns `null` (and
   * caches it) on any failure so a missing OAI / missing permission leaves the
   * principal unchanged rather than failing the drift read.
   */
  private async resolveOaiCanonicalUserId(oaiId: string): Promise<string | null> {
    const cached = oaiCanonicalUserIdCache.get(oaiId);
    if (cached !== undefined) return cached;
    let canonical: string | null = null;
    try {
      const resp = await getAwsClients().cloudFront.send(
        new GetCloudFrontOriginAccessIdentityCommand({ Id: oaiId })
      );
      canonical = resp.CloudFrontOriginAccessIdentity?.S3CanonicalUserId ?? null;
    } catch (err) {
      this.logger.debug(
        `Could not resolve CloudFront OAI ${oaiId} canonical user id for bucket-policy drift normalization: ${
          err instanceof Error ? err.message : String(err)
        } — leaving the principal unchanged.`
      );
      canonical = null;
    }
    oaiCanonicalUserIdCache.set(oaiId, canonical);
    return canonical;
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
 *   - no `-s3alias` suffix (reserved for S3 Access Point aliases)
 *   - no `--ol-s3` suffix (reserved for S3 on Outposts)
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
  if (value.endsWith('-s3alias') || value.endsWith('--ol-s3')) return false;
  return true;
}
