import {
  S3Client,
  PutBucketPolicyCommand,
  DeleteBucketPolicyCommand,
  GetBucketPolicyCommand,
  NoSuchBucket,
} from '@aws-sdk/client-s3';
import { GetCloudFrontOriginAccessIdentityCommand } from '@aws-sdk/client-cloudfront';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { safeMsg } from '../../utils/display-safe.js';
import { getCurrentStackName } from '../resource-name/stack-scope.js';
import { getStackRecords } from '../../deployment/stack-records-scope.js';
import { getLogger } from '../../utils/logger.js';
import {
  sendsNoPolicy,
  sentPolicyDocument,
  serializeResourcePolicy,
} from '../emulator-secure-transport.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import {
  isAmbiguousOutcomeError,
  markNonRetryable,
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import {
  getPriorAttempts,
  markRefusedBeforeApplying,
} from '../../deployment/prior-attempt-scope.js';
import { policyContentKey } from '../policy-document-content.js';
import { isS3BucketName, ownPolicyHolder } from '../s3-bucket-policy-helpers.js';
import { OWN_WRITE_REREAD_DELAYS_MS } from '../settle-after-own-write.js';
import { settleBucketPolicyRead } from './s3-bucket-policy-own-write.js';
import {
  IAM_UNIQUE_ID_RE,
  OAI_USER_ARN_RE,
  buildSiblingOaiCanonicalMap,
  extractStatements,
  findTemplateCanonicalUser,
} from './s3-bucket-policy-oai.js';
import { markNotGone } from '../not-gone.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { logicalIdShown } from '../composite-id.js';
import {
  isPlainImportValue,
  refusalTypeShown,
  isPlainImportJson,
  importRemedyCommand,
  remedyLogicalId,
  VALUE_NOT_SHOWN,
} from '../import-helpers.js';
import { cdkdRemedy, commandHole, proseQuoted } from '../../utils/pasteable-command.js';

/**
 * Process-lifetime cache of OAI id -> S3 canonical user id (or `null` when the
 * lookup failed / the OAI is gone), so a `cdkd drift` run with many OAI-granting
 * bucket policies issues at most one `GetCloudFrontOriginAccessIdentity` per OAI.
 */
const oaiCanonicalUserIdCache = new Map<string, string | null>();

/**
 * How often, and how far apart, a create re-reads a bucket policy before
 * refusing it as another owner's (go-to-k/cdkd#6109): S3 may still return a
 * policy a delete removed seconds ago.
 */
const POLICY_RECHECKS = 3;
const POLICY_RECHECK_DELAY_MS = 5_000;

/** What a create's look at the bucket found (go-to-k/cdkd#6109). */
type ExistingBucketPolicy =
  | { kind: 'absent' }
  | { kind: 'present'; policy: string }
  | { kind: 'unreadable'; error: unknown };

/** Test-only: reset the OAI canonical-user-id cache between unit tests. */
export function clearOaiCanonicalUserIdCacheForTest(): void {
  oaiCanonicalUserIdCache.clear();
}

import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  CreateContext,
  UpdateContext,
  ResourceImportInput,
  ResourceImportResult,
  ReadCurrentStateContext,
  ResourceNotFound,
} from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';

/**
 * AWS S3 Bucket Policy Provider
 *
 * Implements resource provisioning for AWS::S3::BucketPolicy using the S3 SDK.
 * This is required because S3 Bucket Policy is not supported by Cloud Control API.
 */
export class S3BucketPolicyProvider implements ResourceProvider {
  private s3Client: S3Client;
  private logger = getLogger().child('S3BucketPolicyProvider');
  /** Re-read schedule of the post-write baseline capture; tests set it to zeros. */
  protected ownWriteRereadDelaysMs: readonly number[] = OWN_WRITE_REREAD_DELAYS_MS;
  /** The wait between policy re-reads; replaced by tests. */
  sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
    properties: Record<string, unknown>,
    context?: CreateContext
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

    const mask = context?.maskSecrets ?? ((t: string) => t);
    // Serialize policy document
    const policyDoc = serializeResourcePolicy(policyDocument, resourceType, logicalId);

    // go-to-k/cdkd#6109: PutBucketPolicy REPLACES whatever policy the bucket
    // holds, so a create without this look is an upsert that silently drops
    // statements another owner attached (a vended-log delivery service's
    // grant, a hand-written Deny). CloudFormation refuses the same create.
    let existing: ExistingBucketPolicy;
    try {
      existing = await this.probeExistingPolicy(bucketName);
    } catch (error) {
      throw this.wrapOperationError(
        'create',
        logicalId,
        resourceType,
        bucketName,
        error,
        context?.maskSecrets
      );
    }
    // The window between this read and the Put cannot be closed: S3 has no
    // conditional PutBucketPolicy, so a policy attached in between is still
    // replaced.
    // A create that puts nothing (below) still claims the policy slot, so it
    // is refused the same; an own earlier attempt compares the templated one.
    await this.decideOnExistingPolicy(
      logicalId,
      resourceType,
      bucketName,
      policyDoc ??
        (typeof policyDocument === 'string' ? policyDocument : JSON.stringify(policyDocument)),
      existing,
      context?.replayingState === true,
      mask
    );
    if (policyDoc === undefined) {
      // --aws-emulator with nothing left but the TLS Deny (go-to-k/cdkd#6636):
      // the bucket keeps no policy, so one the check above let this create
      // replace (a rollback replay, an own earlier attempt) is removed.
      if (existing.kind === 'present') {
        try {
          await this.s3Client.send(new DeleteBucketPolicyCommand({ Bucket: bucketName }));
        } catch (error) {
          if ((error as { name?: string }).name !== 'NoSuchBucketPolicy') {
            throw this.wrapOperationError(
              'create',
              logicalId,
              resourceType,
              bucketName,
              error,
              context?.maskSecrets
            );
          }
        }
      }
      return { physicalId: bucketName, attributes: {} };
    }

    try {
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
      // A Put that got no definite answer may have attached this policy. An
      // engine retry of this dispatch then finds it, and may only proceed
      // because this dispatch recorded the doubt (decideOnExistingPolicy).
      if (isAmbiguousOutcomeError(error)) getPriorAttempts(logicalId)?.notePossiblyLanded();
      throw this.wrapOperationError(
        'create',
        logicalId,
        resourceType,
        bucketName,
        error,
        context?.maskSecrets
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
    _previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating S3 bucket policy ${logicalId}: ${physicalId}`);
    // go-to-k/cdkd#2613: the policy is put on a bucket NAME, and a client in another region
    // than the state record is not the one this record was written through. Ahead of the
    // required-property checks so the refusal names the region, not a symptom. Refuse before
    // any call; the client's region is resolved only when there is one to compare with.
    assertRegionMatch(
      context?.expectedRegion ? await this.s3Client.config.region() : undefined,
      context?.expectedRegion,
      resourceType,
      logicalId,
      physicalId,
      'pre-update'
    );

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
      const policyDoc = serializeResourcePolicy(policyDocument, resourceType, logicalId);

      // --aws-emulator with nothing left but the TLS Deny: remove the policy
      // the previous document put rather than put an empty one.
      if (policyDoc === undefined) {
        try {
          await this.s3Client.send(new DeleteBucketPolicyCommand({ Bucket: bucketName }));
        } catch (error) {
          // Already none (a create that put nothing): the state asked for.
          if ((error as { name?: string }).name !== 'NoSuchBucketPolicy') throw error;
        }
      } else {
        await this.s3Client.send(
          new PutBucketPolicyCommand({
            Bucket: bucketName,
            Policy: policyDoc,
          })
        );
      }

      this.logger.debug(`Successfully updated S3 bucket policy ${logicalId}`);

      return {
        physicalId: bucketName,
        wasReplaced: false,
        attributes: {},
      };
    } catch (error) {
      throw this.wrapOperationError(
        'update',
        logicalId,
        resourceType,
        physicalId,
        error,
        context?.maskSecrets
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
      throw this.wrapOperationError(
        'delete',
        logicalId,
        resourceType,
        physicalId,
        error,
        context?.maskSecrets
      );
    }
  }

  /**
   * What the bucket already holds before a create (go-to-k/cdkd#6109).
   *
   * `NoSuchBucketPolicy` is `absent`. So is `NoSuchBucket`: the Put that
   * follows reports it exactly as it did before this look existed. An
   * `AccessDenied` is `unreadable`, never `absent` — a least-privilege role may
   * hold `s3:PutBucketPolicy` without `s3:GetBucketPolicy`, and the caller
   * decides what that means. Any other failure is thrown, so a throttle or a
   * wrong-region redirect fails the create as the Put would have.
   */
  private async probeExistingPolicy(bucketName: string): Promise<ExistingBucketPolicy> {
    try {
      const resp = await this.s3Client.send(new GetBucketPolicyCommand({ Bucket: bucketName }));
      return resp.Policy ? { kind: 'present', policy: resp.Policy } : { kind: 'absent' };
    } catch (error) {
      // By NAME, which also covers the SDK's `NoSuchBucket` class (its
      // instances carry that name).
      const name =
        error !== null && typeof error === 'object'
          ? (error as { name?: unknown }).name
          : undefined;
      if (name === 'NoSuchBucketPolicy' || name === 'NoSuchBucket') return { kind: 'absent' };
      if (name === 'AccessDenied') return { kind: 'unreadable', error };
      throw error;
    }
  }

  /**
   * Refuse a create onto a bucket that already holds a policy, as
   * CloudFormation does ("The bucket policy already exists on bucket ...",
   * go-to-k/cdkd#6109). Returns to let the Put go ahead:
   *
   * - no policy is attached;
   * - the policy could not be read (`AccessDenied`): warned, and the Put goes
   *   ahead as it always did — refusing would break every deploy by a role
   *   without `s3:GetBucketPolicy`, with no way around it;
   * - a rollback replay (`replayingState`) restores a policy this deploy
   *   removed: its bag is a state record, so it is warned and put back;
   * - the policy is this stack's own leftover, by content equal to what this
   *   logical id sent: an earlier Put of THIS dispatch that got no definite
   *   answer (`notePossiblyLanded`) compared with the policy being created, or
   *   a bag the stack's rollback journal keeps for an earlier deploy's failed
   *   or interrupted attempt ({@link getPriorAttempts}, the
   *   `SecurityGroupIngress` rule of go-to-k/cdkd#4355). Content equality is
   *   what makes it safe: the Put then drops no statement but this stack's.
   *
   * Another record of THIS stack holding the bucket's policy (a construct
   * moved or renamed: the new logical id is created before the old one is
   * deleted) is refused with its own advice, since deleting or importing the
   * policy would leave the bucket with none once the old id's delete runs.
   * Anything else is another owner's policy, and overwriting it would drop
   * its statements. The refusals carry no AWS text (there is none), so the
   * name-collision classifiers never read them as a collision.
   */
  private async decideOnExistingPolicy(
    logicalId: string,
    resourceType: string,
    bucketName: string,
    policyDoc: string,
    existing: ExistingBucketPolicy,
    replayingState: boolean,
    mask: (text: string) => string
  ): Promise<void> {
    if (existing.kind === 'absent') return;
    const bucketShown = mask(bucketName);
    if (existing.kind === 'unreadable') {
      const failure = describeAwsFailure(existing.error);
      this.logger.debug(
        safeMsg`S3 bucket policy ${logicalId}: GetBucketPolicy on ${bucketShown} failed: ${mask(failure.detail)}`
      );
      this.logger.warn(
        safeMsg`S3 bucket policy ${logicalId}: could not read the policy bucket ${bucketShown} already holds (${mask(failure.summary)}), so cdkd cannot tell whether this create replaces a policy it does not own; creating it anyway. Grant s3:GetBucketPolicy to the deploying principal to enable this check.`
      );
      return;
    }
    if (replayingState) {
      this.logger.warn(
        safeMsg`S3 bucket policy ${logicalId}: the rollback replay restores the recorded policy on bucket ${bucketShown}, replacing the policy attached there since.`
      );
      return;
    }
    const lookup = getPriorAttempts(logicalId);
    const ownAttemptMayHaveLanded = lookup?.possiblyLanded() === true;
    const refuse = (text: string): never => {
      const refusal = markNonRetryable(
        new ProvisioningError(
          mask(
            `Failed to create S3 bucket policy ${logicalId}: The bucket policy already exists on ` +
              `bucket ${bucketShown}. ${text}` +
              (ownAttemptMayHaveLanded
                ? ' An earlier attempt of this create got no definite answer from AWS, but the ' +
                  'policy the bucket holds differs from the one it sent.'
                : '')
          ),
          resourceType,
          logicalId,
          bucketName
        )
      );
      // Nothing was applied, so the journal must not keep this attempt's bag
      // as evidence; unless an earlier Put of this dispatch may have landed.
      throw ownAttemptMayHaveLanded ? refusal : markRefusedBeforeApplying(refusal);
    };

    const holderId = ownPolicyHolder(logicalId, bucketName);
    const holder = holderId === undefined ? undefined : logicalIdShown(holderId);
    if (holder !== undefined) {
      refuse(
        `This stack's ${holder} already holds the policy on that bucket: a BucketPolicy ` +
          `construct moved or renamed gets a new logical id, which is created before the old ` +
          `one is deleted. Nothing was sent. ` +
          // `cdkd refactor` works on a top-level stack only, like `cdkd import`.
          (getCurrentStackName()?.includes('~') === true
            ? 'Deploy'
            : `Move the record with ${proseQuoted(cdkdRemedy('cdkd refactor'))}, or deploy`) +
          ` the removal of ${holder} first. Do not delete or import the existing policy: the ` +
          `removal of ${holder} would then delete it, leaving the bucket with no policy.`
      );
    }

    // go-to-k/cdkd#6109: S3's bucket configuration is eventually consistent,
    // so a policy a delete just removed (a delete-then-create recreate, an
    // operator's delete right before a re-deploy) can still be read. Look
    // again, briefly, before calling it another owner's. A re-read that fails
    // refuses on what the first read found.
    let livePolicy = existing.policy;
    for (let recheck = 0; ; recheck++) {
      if (
        await this.isOwnLeftover(
          logicalId,
          bucketName,
          policyDoc,
          livePolicy,
          ownAttemptMayHaveLanded,
          lookup,
          bucketShown,
          mask
        )
      ) {
        return;
      }
      if (recheck >= POLICY_RECHECKS) break;
      await this.sleep(POLICY_RECHECK_DELAY_MS);
      let again: ExistingBucketPolicy;
      try {
        again = await this.probeExistingPolicy(bucketName);
      } catch (error) {
        this.logger.debug(
          safeMsg`S3 bucket policy ${logicalId}: re-reading the policy on ${bucketShown} failed: ${mask(describeAwsFailure(error).detail)}`
        );
        break;
      }
      if (again.kind === 'absent') return;
      if (again.kind === 'unreadable') break;
      livePolicy = again.policy;
    }

    const bucketArg =
      bucketShown === bucketName && isS3BucketName(bucketName) ? bucketName : '<bucketName>';
    const stackName = getCurrentStackName();
    // A nested-stack child (`<parent>~<child>`) is no `cdkd import` target.
    const importArm =
      stackName !== undefined && stackName.includes('~')
        ? ''
        : `, or merge its statements into this resource's PolicyDocument and adopt it into the ` +
          `stack with ${proseQuoted(importRemedyCommand(stackName, `${remedyLogicalId(logicalId)}=${bucketArg}`))}`;
    refuse(
      `cdkd does not overwrite it: PutBucketPolicy replaces the whole policy, so the ` +
        `statements its owner attached (a log-delivery service's grant, for example) would be ` +
        `dropped, and CloudFormation refuses this create the same way. Nothing was sent. Either ` +
        `remove the existing policy if nothing relies on it ('aws s3api delete-bucket-policy ` +
        `--bucket ${bucketArg}')${importArm}, then re-deploy.`
    );
  }

  /**
   * Whether `livePolicy` is this logical id's own earlier write
   * (go-to-k/cdkd#6109), by content: equal to the policy being created after
   * a Put of THIS dispatch got no definite answer, or equal to a bag the
   * stack's rollback journal keeps for an earlier failed or interrupted
   * attempt on the same bucket. An unreadable journal is no evidence.
   */
  private async isOwnLeftover(
    logicalId: string,
    bucketName: string,
    policyDoc: string,
    livePolicy: string,
    ownAttemptMayHaveLanded: boolean,
    lookup: ReturnType<typeof getPriorAttempts>,
    bucketShown: string,
    mask: (text: string) => string
  ): Promise<boolean> {
    if (
      ownAttemptMayHaveLanded &&
      (await this.livePolicyKey(livePolicy, policyDoc)) === policyContentKey(policyDoc)
    ) {
      this.logger.debug(
        safeMsg`S3 bucket policy ${logicalId}: an earlier attempt of this create attached the policy; re-sending it`
      );
      return true;
    }
    if (lookup === undefined) return false;
    let attempts: ReadonlyArray<Record<string, unknown>>;
    try {
      attempts = await lookup.attempts();
    } catch (error) {
      this.logger.debug(
        safeMsg`S3 bucket policy ${logicalId}: rollback journal read failed: ${mask(describeAwsFailure(error).detail)}`
      );
      return false;
    }
    for (const bag of attempts) {
      const attempted = sentPolicyDocument(bag['PolicyDocument']);
      if (bag['Bucket'] !== bucketName || attempted == null) continue;
      if ((await this.livePolicyKey(livePolicy, attempted)) === policyContentKey(attempted)) {
        this.logger.info(
          safeMsg`S3 bucket policy ${logicalId}: the policy on bucket ${bucketShown} is the one this stack's rollback journal shows an earlier deploy of it attempted; replacing it`
        );
        return true;
      }
    }
    return false;
  }

  /**
   * {@link policyContentKey} of the policy S3 returned, compared against
   * `reference` (a document cdkd sent). S3 rewrites a CloudFront OAI grant's
   * `{ CanonicalUser }` principal into the OAI's user ARN, or transiently a
   * bare IAM unique id, so those are folded back to the `{ CanonicalUser }`
   * form first, the way {@link readCurrentState} does, with the same-stack
   * OAI records as siblings.
   */
  private async livePolicyKey(livePolicy: string, reference: unknown): Promise<string> {
    let live: unknown;
    let ref: unknown = reference;
    try {
      live = JSON.parse(livePolicy) as unknown;
      if (typeof ref === 'string') ref = JSON.parse(ref) as unknown;
    } catch {
      return policyContentKey(livePolicy);
    }
    const siblings: NonNullable<ReadCurrentStateContext['siblings']> = {};
    for (const [id, record] of getStackRecords()?.live() ?? []) {
      siblings[id] = {
        resourceType: record.resourceType,
        physicalId: record.physicalId,
        properties: {},
        ...(record.attributes !== undefined && { attributes: record.attributes }),
      };
    }
    // Right after cdkd's own write attempt, so the transient form is expected.
    await this.normalizeOaiPrincipals(live, { PolicyDocument: ref }, { siblings }, true);
    return policyContentKey(live);
  }

  /**
   * Wrap what `create` / `update` / `delete` caught into the error they throw
   * (go-to-k/cdkd#2319, the S3 bucket provider's twin from go-to-k/cdkd#2302).
   *
   * A thrown message is persisted to `deployments/{runId}.jsonl`, and S3 words
   * an `AccessDenied` on `PutBucketPolicy` / `DeleteBucketPolicy` as `User:
   * arn:aws:sts::<account>:assumed-role/<role>/<session> is not authorized
   * ...`. So an AWS-authored failure is reduced to its class plus the
   * `--verbose` pointer, masked (the class is AWS-authored text too), and
   * AWS's own text goes to `logger.debug` through the operation's masker, where
   * it still separates a missing grant from a bucket-policy `Deny`. An
   * "already exists" is restated ({@link relayedNameCollision}). The wrap is
   * stamped `markRedactedCause`, so the retry classifiers read the withheld
   * text on the `cause` chain; a non-`Error` throw is withheld the same way,
   * unstamped (it has no chain). A cdkd-authored or transport error keeps its
   * text, masked, stamped exactly when the mask changed it
   * (`wrapMaskedAwsError`, issue #4244). `describeAwsFailure` also cannot throw
   * on a value `String()` cannot convert (go-to-k/cdkd#3341).
   *
   * The not-found arms in `delete` match by error class or name before the
   * wrap, and a delete wrap naming any other `NotFound` class is stamped
   * `markNotGone`, which the destroy loop's "already deleted" match refuses.
   */
  private wrapOperationError(
    operation: 'create' | 'update' | 'delete',
    logicalId: string,
    resourceType: string,
    physicalId: string,
    error: unknown,
    maskSecrets: ((text: string) => string) | undefined
  ): ProvisioningError {
    const mask = maskSecrets ?? ((t: string) => t);
    const cause = error instanceof Error ? error : undefined;
    const build = (text: string): ProvisioningError =>
      new ProvisioningError(
        `Failed to ${operation} S3 bucket policy ${logicalId}: ${text}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    const failure = describeAwsFailure(error);
    if (!failure.redacted) return wrapMaskedAwsError(mask, error, build);
    this.logger.debug(mask(build(mask(failure.detail)).message));
    const wrapped = build(`${mask(failure.summary)}${relayedNameCollision(failure.detail)}`);
    const stamped = cause !== undefined ? markRedactedCause(wrapped) : wrapped;
    return operation === 'delete' && cause !== undefined && cause.name.includes('NotFound')
      ? markNotGone(stamped)
      : stamped;
  }

  /**
   * Read the AWS-current S3 bucket policy in CFn-property shape: `Bucket` (the
   * physical id) and `PolicyDocument` (`GetBucketPolicy`, JSON-parsed).
   *
   * Returns `RESOURCE_NOT_FOUND` when the bucket is gone (`NoSuchBucket`) or when
   * no policy is currently attached (`NoSuchBucketPolicy`). The capture right
   * after cdkd's own write settles it (`settleBucketPolicyRead`, go-to-k/cdkd#6609).
   */
  async readCurrentState(
    physicalId: string,
    logicalId: string,
    _resourceType: string,
    properties?: Record<string, unknown>,
    context?: ReadCurrentStateContext
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    const read = () => this.readPolicyOnce(physicalId, properties, context);
    const delaysMs = this.ownWriteRereadDelaysMs;
    const options = { logicalId, properties, context, delaysMs, logger: this.logger };
    return settleBucketPolicyRead(await read(), read, options);
  }

  /** One read of {@link readCurrentState}, the answer taken as AWS gives it. */
  private async readPolicyOnce(
    physicalId: string,
    properties: Record<string, unknown> | undefined,
    context: ReadCurrentStateContext | undefined
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    let policyJson: string | undefined;
    try {
      const resp = await this.s3Client.send(new GetBucketPolicyCommand({ Bucket: physicalId }));
      policyJson = resp.Policy;
    } catch (err) {
      if (err instanceof NoSuchBucket) return RESOURCE_NOT_FOUND;
      // S3 throws `NoSuchBucketPolicy` (a 404) when no policy is attached.
      const e = err as { name?: string };
      if (e.name === 'NoSuchBucketPolicy') {
        // --aws-emulator set no policy (go-to-k/cdkd#6636): none is the
        // declared state, not a deleted record.
        if (properties !== undefined && sendsNoPolicy(properties['PolicyDocument'])) {
          return { ...properties };
        }
        return RESOURCE_NOT_FOUND;
      }
      throw err;
    }
    if (!policyJson) return undefined;

    const result: Record<string, unknown> = { Bucket: physicalId };
    let policyDoc: unknown;
    try {
      policyDoc = JSON.parse(policyJson) as unknown;
    } catch {
      result['PolicyDocument'] = policyJson;
      return result;
    }

    // Issue #872: every recognizable CloudFront OAI grant principal back to the
    // template's canonical user id form (the three unstable forms are below).
    // A bare unique id is read as the OAI's transient form only right after
    // cdkd's own write (go-to-k/cdkd#6854); anywhere else it is compared as is.
    await this.normalizeOaiPrincipals(
      policyDoc,
      properties,
      context,
      context?.afterOwnWrite === true
    );
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
   *     back to `GetCloudFrontOriginAccessIdentity` for a non-sibling OAI. A
   *     different OAI resolves to a different canonical id, so it still drifts.
   *   - `{ AWS: <bare-IAM-unique-id> }` -> the transient post-PutBucketPolicy
   *     rendering, which carries no recoverable link to the OAI. Canonicalize
   *     it only by matching the corresponding template statement (same Effect /
   *     Action / Resource) carrying a `{ CanonicalUser }` principal, and only
   *     when `afterOwnWrite` says the read follows cdkd's own write. S3 also
   *     renders a DELETED IAM user's grant as its bare `AIDA…` id, and keeps
   *     it (measured us-east-1, 2026-11-23, go-to-k/cdkd#6854), so on any
   *     other read (drift, `state refresh-observed`, import) the id is
   *     compared as is: adopting the template form there reported a grant to
   *     a deleted user as the template's OAI grant.
   * Statements whose principal is not a single-string `AWS` OAI form (e.g. a
   * wildcard, a service principal, a normal role ARN, or an `AWS` ARRAY of
   * principals) are left untouched — skipping is safe (it can only leave a
   * residual false positive, never hide real drift). CDK's single-OAI grant
   * emits the single-string form.
   */
  private async normalizeOaiPrincipals(
    policyDoc: unknown,
    templateProps: Record<string, unknown> | undefined,
    context: ReadCurrentStateContext | undefined,
    afterOwnWrite: boolean
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

      if (afterOwnWrite && IAM_UNIQUE_ID_RE.test(awsPrincipal)) {
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
          describeAwsFailure(err).detail
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
    //
    //    This line carries a `--resource` remedy, so the logical id, the
    //    supplied id and the template's Bucket value are each shown only when
    //    plain and described otherwise, and the fragment holes a logical id
    //    that is not plain (go-to-k/cdkd#4226): printed raw or inside cdkd's
    //    own quotes, a `;`, `$( )` or `'` in one of them ran when the line was
    //    pasted.
    const knownNote = input.knownPhysicalId
      ? ` Got knownPhysicalId=${isPlainImportValue(input.knownPhysicalId) ? `'${input.knownPhysicalId}'` : VALUE_NOT_SHOWN} (not a valid S3 bucket name; CloudFormation returns the policy resource NAME for AWS::S3::BucketPolicy, which is not the operational identifier).`
      : '';
    const bucketNote =
      bucket !== undefined
        ? ` Properties.Bucket${isPlainImportJson(bucket) ? `=${JSON.stringify(bucket)}` : ` ${VALUE_NOT_SHOWN}`} did not resolve to a literal bucket name (intrinsic-valued entries like {Ref: '<Bucket>'} are not resolved at import time).`
        : ' Properties.Bucket is missing.';
    throw new Error(
      `Cannot determine bucket name for ${refusalTypeShown(input.resourceType)} ${logicalIdShown(input.logicalId)}.${knownNote}${bucketNote} ` +
        `Re-run with --resource ${remedyLogicalId(input.logicalId)}=${commandHole('bucketName')} ` +
        `(e.g. my-bucket-12345) to point cdkd at the bucket this policy is attached to.`
    );
  }
}
