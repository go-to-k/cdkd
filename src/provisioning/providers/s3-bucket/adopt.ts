/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import { cdkdRemedy, pasteableCommand } from '../../../utils/pasteable-command.js';
import {
  type Bucket,
  GetBucketLocationCommand,
  ListBucketsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  type BucketRegionProbe,
  OWN_LEFTOVER_IDENTITY_TIMEOUT_MS,
  type UnverifiedIdentityCause,
  bucketLocationToRegion,
  carriesBucketRegionHeader,
  holdOwnLeftoverBucket,
  isNoSuchBucketError,
  probeFailedCause,
  regionFromErrorHeader,
  tokenDate,
} from './create-identity.js';
import type { DeleteContext } from '../../region-check.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import type { ResourceNotFound } from '../../../types/resource.js';
import { S3BucketProvider } from '../s3-bucket-provider.js';
import { canonicalizeRegion } from '../../../utils/aws-partition.js';
import { clientDefaultsFor } from '../../../utils/ambient-client-defaults.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { displaySafe, safeMsg } from '../../../utils/display-safe.js';
import { markNameCollision, markNonRetryable } from '../../../deployment/retryable-errors.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import {
  s3BucketArn,
  s3BucketDomainName,
  s3BucketDualStackDomainName,
  s3BucketRegionalDomainName,
  s3BucketWebsiteUrl,
} from '../../../utils/s3-endpoints.js';
import { s3ClientDefaults } from '../../../utils/s3-client-defaults.js';
import { stateOrphanRecordRemedy } from '../../state-orphan-remedy.js';
import { withoutServerErrorRetries } from '../ambiguous-create.js';

/**
 * The client `CreateBucket` goes through: SDK retries on, except a 5xx
 * (`withoutServerErrorRetries`, issue #4639). Every other call keeps the
 * shared client and its full SDK retry. Built in the shared client's REGION
 * (read from it, as `config.region()` resolves it), so the create cannot land
 * in another region than the calls around it, and with the credentials of
 * the SAME `AwsClients` that client came from, read at construction, so a
 * later `setAwsClients` switch cannot give the create another identity. The
 * PROMISE is cached, so two creates on a cold provider build one client; a
 * rejected region read is not cached, so the next create retries it.
 *
 * `CreateBucket` carries no idempotency token. The SDK's own replay of a 5xx
 * whose request had succeeded answered `BucketAlreadyOwnedByYou` (or, in
 * us-east-1, 200) INSIDE one send, where nothing could tell it from a bucket
 * that was already there. Refused here, the 5xx arms
 * {@link createBucketLatch} and reaches the deploy engine's retry.
 */
export function getCreateClient(this: S3BucketProvider): Promise<S3Client> {
  const holder = this.createClientHolder;
  holder.client ??= this.s3Client.config.region().then(
    (region) =>
      withoutServerErrorRetries(
        new S3Client({
          ...clientDefaultsFor(this.credentialConfig),
          ...s3ClientDefaults(),
          region,
        })
      ),
    (error: unknown) => {
      holder.client = undefined;
      throw error;
    }
  );
  return holder.client;
}

/**
 * Refuse to go on with a create whose bucket it cannot attribute (issue
 * #4639): an earlier attempt of THIS create ended ambiguous (a 5xx or a lost
 * response), and the name is now taken or may be. Three callers: the
 * `BucketAlreadyOwnedByYou` arm (a bucket this account owns, in this
 * region); and the us-east-1 pre-send arm, either over a bucket the
 * pre-flight located in us-east-1 -- which `CreateBucket` was never asked
 * about, so it may be ANOTHER account's -- or over a pre-flight that could
 * not answer, where the bucket may not exist at all. The earlier attempt may
 * have created it, or a concurrent actor (this account or another) may hold
 * the name, and a name is not attribution (`docs/provider-rules.md`, "Adopt
 * only on EXACT attribution"). Adopting would apply this stack's
 * configuration to a bucket that may not be ours and, if a later call
 * failed, leave a bucket this run created with no created-before-failure
 * mark; deleting it could destroy someone else's.
 *
 * The refusal therefore names the bucket and LEADS with read commands
 * (`list-buckets` shows whether this account owns it at all), then a delete
 * conditional on the bucket being this account's empty orphan, then the
 * way to keep it: for a generated name a re-run (a fresh deploy takes the
 * cold path, which adopts an owned bucket and fails on another account's),
 * for an explicit one `cdkd import`, since the cold path refuses an explicit
 * name a bucket already holds (go-to-k/cdkd#4684). `markNonRetryable` because the engine's
 * next attempt would see the same bucket with no window and adopt it -- the
 * outcome this refuses. Avoids the
 * literal `does not exist`, which reads as transient
 * (`retryable-errors/patterns.ts`).
 */
export function refuseAmbiguousCreateAdopt(
  this: S3BucketProvider,
  logicalId: string,
  resourceType: string,
  bucketName: string,
  region: string,
  via: { cause: Error } | { preflight: 'region' | 'indeterminate' },
  explicitName: boolean
): never {
  const aws = pasteableAwsCommand(this.shownMask);
  const regionArg = region ? aws` --region ${region}` : aws``;
  // `list-buckets` lists only buckets THIS account owns, which
  // `GetBucketLocation` cannot tell; its `CreationDate` is a HINT at who made
  // the bucket, not proof (S3 documents that some bucket changes, such as a
  // policy edit, update it).
  const owned = aws`aws s3api list-buckets --prefix ${bucketName}`.render();
  // Versions, not just current objects: a versioned bucket holding only
  // non-current versions or delete markers is not empty.
  const versions =
    aws`aws s3api list-object-versions --bucket ${bucketName} --max-items 10${regionArg}`.render();
  const deletion = aws`aws s3api delete-bucket --bucket ${bucketName}${regionArg}`.render();
  const presence =
    'preflight' in via && via.preflight === 'indeterminate'
      ? 'a bucket of that name may exist (cdkd could not read its location)'
      : 'the bucket now exists';
  throw markNonRetryable(
    new ProvisioningError(
      `Refusing to adopt S3 bucket ${this.shown(bucketName)} for ${displaySafe(logicalId)} ` +
        `(${resourceType}): an earlier attempt of this create ended without a definite ` +
        `answer (a server error or a lost response) after it may have created the bucket, ` +
        `and ${presence}, so cdkd cannot tell whether this deploy or someone else ` +
        `created it. Check whether this account owns it: ${owned} (it lists only this ` +
        `account's buckets; its CreationDate is a hint, not proof, since some bucket changes ` +
        `update it), and whether it holds any object or object version: ${versions}. If it ` +
        `is listed there, its CreationDate matches the failed attempt, it is empty, and ` +
        `nobody else on your team uses this name, it is this deploy's orphan: delete it ` +
        `with ${deletion} (S3 refuses with BucketNotEmpty if anything is left in it) and ` +
        `re-run the deploy. ` +
        (explicitName
          ? `If it is a bucket you mean this stack to own, adopt it with \`${cdkdRemedy('cdkd import')}\` and ` +
            `re-run: its BucketName is set explicitly, so a re-run alone refuses it.`
          : `If it is a bucket you mean this stack to own, re-run the deploy to adopt it.`),
      resourceType,
      logicalId,
      bucketName,
      'cause' in via ? via.cause : undefined
    )
  );
}

/**
 * Refuse a create whose EXPLICIT `BucketName` a bucket already holds
 * (go-to-k/cdkd#4684): S3 answered `BucketAlreadyOwnedByYou`, or, in
 * us-east-1, the pre-flight found the bucket, where `CreateBucket` would
 * answer 200 OK and reset its ACLs. Either way this create did not make it,
 * and a name is not attribution (`docs/provider-rules.md`, "Adopt only on
 * EXACT attribution"): the bucket may be a hand-made one or another stack's,
 * and adopting it would reconfigure it and hand it to this stack's
 * `cdkd destroy`. CloudFormation fails the same create. A generated name
 * keeps adopting: it is derived from the stack and logical id, so its holder
 * is presumed this stack's own (go-to-k/cdkd#4345).
 *
 * The deploy engine asks the same question before a plain create
 * (go-to-k/cdkd#4180) and before a replacement onto a new name
 * (go-to-k/cdkd#3937); this catches the creates neither asks for (a
 * replacement keeping its name, a rollback's re-create of a replaced
 * bucket) and a bucket made between that lookup and `CreateBucket`.
 *
 * Marked a NAME COLLISION (`markNameCollision`): the create-first
 * replacement and the rollback's reverse replacement read that verdict, and
 * each acts on it only once the state records prove which resource holds
 * the name (`replacementOldHoldsSentName`, `reverseReplacementNewHoldsName`).
 * Deliberately NOT `markNonRetryable`, and worded "already exists": a
 * delete-first re-create (`--replace`, `--recreate-via-*`, a rollback's
 * delete-new-first) retries exactly that text to ride out a name released
 * late after its own `DeleteBucket`, where a stale pre-flight can still see
 * the bucket. Retrying a refusal adopts nothing; every other caller's
 * default classifier never retries a collision. Avoids the literal
 * `does not exist`, which reads as transient.
 */
export function refuseExplicitNameHeld(
  this: S3BucketProvider,
  logicalId: string,
  resourceType: string,
  bucketName: string,
  via: { cause: Error } | { preflightRegion: string } | { listed: true }
): never {
  const evidence =
    'cause' in via
      ? `S3 answered BucketAlreadyOwnedByYou: a bucket of that name already exists, and ` +
        `this account owns it`
      : 'listed' in via
        ? `a bucket of that name already exists in this account's bucket list (a us-east-1 ` +
          `CreateBucket would answer 200 OK over it and reset its access control lists), so ` +
          `CreateBucket was not sent`
        : `a bucket of that name already exists in ${via.preflightRegion}, where ` +
          `CreateBucket answers 200 OK over a bucket you own and resets its access control ` +
          `lists, so it was not sent`;
  const refusal = markNameCollision(
    new ProvisioningError(
      `Refusing to adopt S3 bucket ${this.shown(bucketName)} for ${displaySafe(logicalId)} ` +
        `(${resourceType}): its BucketName is set explicitly and ${evidence}. S3 does not ` +
        `say who made it, so cdkd cannot tell it from one made outside this stack, and ` +
        `CloudFormation fails the same create. Nothing was applied to it. Choose a bucket ` +
        `name no other bucket holds. If no record of this stack holds that bucket and it is ` +
        `yours (left by an interrupted deploy, or kept by DeletionPolicy: Retain), delete ` +
        `it, or adopt it with \`${cdkdRemedy('cdkd import')}\`, and re-run; confirm it is yours first, since ` +
        `adopting a bucket hands it to this stack's \`cdkd destroy\`.`,
      resourceType,
      logicalId,
      bucketName,
      'cause' in via ? via.cause : undefined
    )
  );
  throw refusal;
}

/**
 * Does THIS account own a bucket named `bucketName`? The us-east-1
 * pre-flight's fallback when `GetBucketLocation` could not answer for an
 * explicit name (go-to-k/cdkd#4684): the legacy 200 adopts only a bucket the
 * caller owns, so the account's own bucket list is the oracle.
 * `ListBuckets` filters by PREFIX, so the match is exact and every page is
 * read. A failure is reported by error CLASS, AWS's text going to debug (it
 * names the caller's account, role and session).
 */
export async function ownsBucketNamed(
  this: S3BucketProvider,
  bucketName: string
): Promise<{ owned: boolean } | { unknown: string }> {
  const listed = await this.listOwnedBucket(bucketName);
  return 'unknown' in listed ? listed : { owned: listed.bucket !== undefined };
}

/**
 * go-to-k/cdkd#4758: {@link resourceIdentity} within
 * {@link OWN_LEFTOVER_IDENTITY_TIMEOUT_MS}, `undefined` past it: the read
 * sits in front of the error that carries the created-before-failure mark,
 * the orphan's only record, and of the retry's create.
 */
export async function boundedIdentity(
  this: S3BucketProvider,
  bucketName: string,
  resourceType: string,
  region: string
): Promise<string | ResourceNotFound | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      this.resourceIdentity(bucketName, resourceType, { expectedRegion: region }),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), OWN_LEFTOVER_IDENTITY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * go-to-k/cdkd#4758: record the bucket this failed attempt leaves behind,
 * by its identity token. Best-effort: no token, no record, and the retry
 * refuses as before. Never throws.
 */
export async function holdOwnLeftover(
  this: S3BucketProvider,
  logicalId: string,
  resourceType: string,
  bucketName: string
): Promise<void> {
  try {
    const region = canonicalizeRegion(await this.getRegion());
    const identity = await this.boundedIdentity(bucketName, resourceType, region);
    if (typeof identity === 'string') {
      holdOwnLeftoverBucket(logicalId, identity);
      this.logger.debug(
        safeMsg`Recorded the bucket ${this.shown(bucketName)} this failed create of ${displaySafe(logicalId)} leaves (created ${tokenDate(identity)}), for its retry`
      );
    } else {
      this.logger.debug(
        safeMsg`No identity for the bucket ${this.shown(bucketName)} this failed create of ${displaySafe(logicalId)} leaves; a retry will refuse it`
      );
    }
  } catch {
    // No record: the retry refuses, as without one.
  }
}

/**
 * go-to-k/cdkd#4758: is the bucket holding `bucketName` the one an earlier
 * attempt of this create left behind? Only when its identity now (name,
 * region, `CreationDate`) is the token that attempt recorded: another name,
 * a bucket deleted and re-created under the name, or one in another region
 * is not. Any read that cannot answer is "no".
 */
export async function isOwnLeftoverBucket(
  this: S3BucketProvider,
  leftover: string | undefined,
  bucketName: string,
  resourceType: string,
  region: string
): Promise<boolean> {
  if (leftover === undefined) {
    this.logger.debug(
      safeMsg`Not this create's own bucket: no earlier attempt recorded ${this.shown(bucketName)}`
    );
    return false;
  }
  try {
    const identity = await this.boundedIdentity(bucketName, resourceType, region);
    if (typeof identity === 'string' && identity === leftover) return true;
    this.logger.debug(
      safeMsg`Not this create's own bucket: ${this.shown(bucketName)} reads ` +
        safeMsg`${typeof identity === 'string' ? `created ${tokenDate(identity)}` : 'no identity'}, ` +
        safeMsg`the earlier attempt recorded created ${tokenDate(leftover)}`
    );
    return false;
  } catch {
    return false;
  }
}

/**
 * This account's own `ListBuckets` entry for exactly `bucketName`, or
 * `bucket: undefined` when the list (every page) does not hold it.
 * `unknown` (the error CLASS; AWS's text goes to debug) when the list
 * cannot be read through.
 */
export async function listOwnedBucket(
  this: S3BucketProvider,
  bucketName: string
): Promise<{ bucket: Bucket | undefined } | { unknown: string }> {
  try {
    let token: string | undefined;
    for (let page = 0; page < 100; page++) {
      const out = await this.s3Client.send(
        new ListBucketsCommand({
          Prefix: bucketName,
          MaxBuckets: 1000,
          ...(token !== undefined ? { ContinuationToken: token } : {}),
        })
      );
      const found = (out.Buckets ?? []).find((b) => b.Name === bucketName);
      if (found !== undefined) return { bucket: found };
      token = out.ContinuationToken || undefined;
      if (token === undefined) return { bucket: undefined };
    }
    return { unknown: 'PaginationLimit' };
  } catch (error) {
    // No bucket name: the identity read reaches here outside any operation's
    // masker (the success settle), and a name can be secret-derived. AWS's
    // text names no bucket either (`s3:ListAllMyBuckets` is account-wide).
    this.logger.debug(
      safeMsg`ListBuckets failed while reading this account's bucket list: ` +
        safeMsg`${describeAwsFailure(error).detail}`
    );
    return { unknown: error instanceof Error ? error.name : typeof error };
  }
}

/**
 * Get the region from the S3 client config.
 *
 * The `|| 'us-east-1'` fallback is MEASURED DEAD today, and is left in place
 * deliberately rather than changed here (a provider behaviour change wants
 * its own PR). It is dead because `config.region()` REJECTS rather than
 * resolving a falsy value when nothing on the chain supplies a region: with
 * `AWS_REGION` / `AWS_DEFAULT_REGION` / `AWS_PROFILE` unset and both config
 * files pointed at `/dev/null`, `new S3Client({}).config.region()` gives
 * `Error: Region is missing`. The `await` in the body therefore throws and
 * this line is never reached. Which SDK layer raises it is deliberately NOT
 * asserted here: the message above was executed, an attribution would not
 * have been.
 *
 * Why it is worth a comment rather than silence: if a refactor ever CAUGHT
 * that rejection and let a falsy region through, this line would place the
 * bucket in `us-east-1` silently -- which is precisely the outcome the gate
 * below is fenced against. Two cases in
 * `s3-bucket-provider-location-constraint-case.test.ts` pin the contract (a
 * falsy resolution means us-east-1, never the empty string) by mocking
 * `config.region()`, which is the only way the fallback is expressible.
 */
export async function getRegion(this: S3BucketProvider): Promise<string> {
  const region = await this.s3Client.config.region();
  return region || 'us-east-1';
}

/**
 * Build attributes for an S3 bucket.
 *
 * Covers every CloudFormation `Fn::GetAtt` return value for
 * `AWS::S3::Bucket`. All fields are derivable from `bucketName` + region —
 * no extra AWS API call is needed. See:
 * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-s3-bucket.html#aws-properties-s3-bucket-return-values
 */
export async function buildAttributes(
  this: S3BucketProvider,
  bucketName: string
): Promise<Record<string, unknown>> {
  const region = await this.getRegion();
  return {
    Arn: s3BucketArn(bucketName, region),
    DomainName: s3BucketDomainName(bucketName, region),
    DualStackDomainName: s3BucketDualStackDomainName(bucketName, region),
    RegionalDomainName: s3BucketRegionalDomainName(bucketName, region),
    WebsiteURL: s3BucketWebsiteUrl(bucketName, region),
  };
}

/**
 * Resolve a single `Fn::GetAtt` attribute for an existing bucket.
 *
 * Used by `cdkd orphan` to live-fetch attribute values that need to be
 * substituted into sibling references. All S3 Bucket attributes are
 * derivable from bucket name + region, so this avoids the round trip and
 * reuses the same templating as `buildAttributes`.
 */
export async function getAttribute(
  this: S3BucketProvider,
  physicalId: string,
  _resourceType: string,
  attributeName: string
): Promise<unknown> {
  if (attributeName.startsWith('MetadataConfiguration.')) {
    return (await this.readMetadataAttributes(physicalId))[attributeName];
  }
  const attrs = await this.buildAttributes(physicalId);
  return attrs[attributeName];
}

/**
 * Refuse to adopt an already-owned bucket that does not live in
 * `expectedRegion`.
 *
 * `CreateBucket` answers `BucketAlreadyOwnedByYou` on OWNERSHIP, which is
 * account-global, but a bucket is regional. So the error alone cannot
 * distinguish the case the short-circuit was written for -- a retry of a
 * create whose first attempt already succeeded, in THIS region -- from a
 * bucket of ours that lives somewhere else entirely.
 *
 * The region is taken from the `x-amz-bucket-region` header on the 409
 * ITSELF, so the common path costs no extra API call and needs no extra IAM
 * permission. Measured 2026-08-26 against a bucket in `us-west-2`: clients
 * pinned to `us-east-1`, `eu-west-1` and `ap-northeast-1` each got
 * `name: BucketAlreadyOwnedByYou`, HTTP 409, `x-amz-bucket-region:
 * us-west-2`. The header lives on `$response.headers`; `$metadata.httpHeaders`
 * was absent on all three, which is why both are read.
 *
 * `GetBucketLocation` is the fallback when the header is missing.
 * Deliberately NOT `HeadBucket`: `src/utils/aws-region-resolver.ts` already
 * records why, and this guard's first cut re-learned it the expensive way. A
 * cross-region `HeadBucket` 301s, and SDK v3's region-redirect middleware
 * mishandles the empty-body HEAD response, yielding a synthetic
 * `name: 'Unknown', message: 'UnknownError'`. The AWS CLI hides this by
 * following the redirect; the SDK client does not. Unit tests that mocked the
 * CLI's shape passed while the guard could not fire, and only a real-AWS integ
 * arm caught it.
 *
 * Deliberately NOT `resolveBucketRegion` from that module either, despite the
 * overlap: that helper NEVER THROWS and returns `fallbackRegion` on a failed
 * probe, so wiring it here would turn this fail-CLOSED guard into a
 * fail-OPEN one -- a probe failure would report the deploy's own region, the
 * comparison would match, and the foreign bucket would be adopted. Its cache
 * would also make a second call in one process skip the probe entirely.
 *
 * The refusal is `markNonRetryable` because it is deterministic and
 * user-actionable: without it `withRetry` re-runs the whole create for its
 * full budget before surfacing the same message, which reads as flaky AWS.
 * The wording avoids the phrase "does not exist" for the same reason -- it is
 * a literal member of `OTHER_TRANSIENT_ERROR_MESSAGE_PATTERNS`
 * (`retryable-errors/patterns.ts`), so a message containing it is classified transient
 * even when the throw is not.
 *
 * Issue [#2227](https://github.com/go-to-k/cdkd/issues/2227). Note the
 * mid-delete mechanism that issue was FILED for is not reachable: measured, a
 * `DeleteBucket` followed immediately by a `CreateBucket` of the same name
 * SUCCEEDS outright in `us-east-1` and `us-west-2` alike, so there is no
 * window in which this error can mean "being deleted". The cross-region adopt
 * is the reachable defect in these lines.
 */
export async function assertExistingBucketRegion(
  this: S3BucketProvider,
  logicalId: string,
  resourceType: string,
  bucketName: string,
  expectedRegion: string,
  createError: Error
): Promise<void> {
  const wantRegion = canonicalizeRegion(expectedRegion);
  const actualRegion = await this.resolveOwnedBucketRegion(bucketName, createError);

  if (actualRegion === wantRegion) return;

  this.refuseForeignRegionAdopt(
    logicalId,
    resourceType,
    bucketName,
    wantRegion,
    actualRegion,
    createError
  );
}

/**
 * The refusal {@link assertExistingBucketRegion} raises, as its own method so
 * the `us-east-1` pre-flight can raise the IDENTICAL one.
 *
 * Two callers reach the same conclusion by different evidence -- a 409's
 * `x-amz-bucket-region` on one side, a pre-flight `GetBucketLocation` on the
 * other -- and the user-facing consequence is the same in both, so the
 * wording, the `markNonRetryable` marker and the deliberate avoidance of the
 * literal `does not exist` are stated once rather than paraphrased.
 *
 * `never`-returning so a caller can `this.refuseForeignRegionAdopt(...)` as a
 * statement without the compiler losing that control flow ends there.
 */
export function refuseForeignRegionAdopt(
  this: S3BucketProvider,
  logicalId: string,
  resourceType: string,
  bucketName: string,
  wantRegion: string,
  actualRegion: string,
  cause?: Error
): never {
  throw markNonRetryable(
    new ProvisioningError(
      `Refusing to adopt existing S3 bucket ${this.shown(bucketName)} for ${displaySafe(logicalId)} ` +
        `(${resourceType}): it is owned by this account but lives in ${actualRegion}, ` +
        `while this stack deploys to ${wantRegion}. S3 bucket names are globally ` +
        `unique, so owning the name (which is what 'BucketAlreadyOwnedByYou' and a ` +
        `successful location lookup each report) never means the bucket is in this ` +
        `region. Adopting it would apply this stack's bucket configuration to a ` +
        `bucket in ${actualRegion}, and would record a physical id that denotes no ` +
        `bucket in ${wantRegion}. Either give this stack a bucket name unique to ` +
        `${wantRegion}, or deploy the stack to ${actualRegion}.`,
      resourceType,
      logicalId,
      bucketName,
      // Thread the AWS error rather than dropping it: `isMarkedNonRetryable`
      // walks the cause chain, the classifier reads it, and the
      // provider-error-cause critic fences every provider construction that
      // discards its caught error. The marker above still wins -- it is
      // consulted before any wording heuristic -- so carrying the AWS error
      // cannot make this deterministic refusal retryable again. Absent on the
      // pre-flight caller, which has no AWS error: the create had not been
      // attempted yet.
      cause
    )
  );
}

/**
 * The region an already-owned bucket actually lives in, canonicalized.
 *
 * Header first (free), `GetBucketLocation` second. A `GetBucketLocation`
 * failure PROPAGATES rather than degrading to a guess: the caller is a
 * fail-closed guard, and a guessed region is exactly what would make it
 * adopt the wrong bucket.
 *
 * The header read here is deliberately NOT behind
 * {@link carriesBucketRegionHeader}, and that is licensed by the CALL SITE
 * rather than by the header being safer: the only error ever passed in is the
 * `BucketAlreadyOwnedByYou` 409 from `CreateBucket`, which is itself a
 * region-bearing shape (measured for issue #2227 -- a us-west-2 bucket
 * answered it with `x-amz-bucket-region: us-west-2` to clients in three
 * regions). The gate exists for {@link probeBucketRegion}, which catches the
 * WHOLE failure space of `GetBucketLocation` and so must sort the two kinds
 * apart. If this method ever takes an error from a second call site, it needs
 * the gate too.
 *
 * `awsError` is optional because the two PRE-FLIGHT callers (issues #2241 /
 * #2245) have no AWS error in hand — they ask the question BEFORE issuing
 * the call that would produce one, so only the `GetBucketLocation` half
 * applies. This is deliberately the same function rather than a second one
 * that "also reads GetBucketLocation": the `EU` and empty-`LocationConstraint`
 * folds and the `x-amz-bucket-region` header precedence are one predicate,
 * and a paraphrase of them is a divergence waiting to happen.
 */
export async function resolveOwnedBucketRegion(
  this: S3BucketProvider,
  bucketName: string,
  awsError?: Error
): Promise<string> {
  const fromHeader = awsError ? regionFromErrorHeader(awsError) : undefined;
  if (fromHeader) return fromHeader;

  const location = await this.s3Client.send(new GetBucketLocationCommand({ Bucket: bucketName }));
  return bucketLocationToRegion(location.LocationConstraint);
}

/**
 * Ask S3 where a bucket NAME lives, before doing anything to it.
 *
 * The non-throwing pre-flight form of {@link resolveOwnedBucketRegion},
 * used by the three sites that must confirm a bucket is the one they mean
 * before acting on it: the `us-east-1` create (issue
 * [#2241](https://github.com/go-to-k/cdkd/issues/2241)) and the update /
 * delete paths (issue [#2245](https://github.com/go-to-k/cdkd/issues/2245)).
 *
 * Why `GetBucketLocation` and not `HeadBucket`: recorded at length on
 * {@link S3BucketProvider.assertExistingBucketRegion} and in
 * `src/utils/aws-region-resolver.ts`. A cross-region `HeadBucket` 301s and
 * SDK v3's region-redirect middleware mishandles the empty-body HEAD into a
 * synthetic `name: 'Unknown'`, so it cannot answer this question at all;
 * `GetBucketLocation` is a GET with an XML body and is answered by ANY
 * regional endpoint in the same partition for a bucket in any region of
 * that partition (measured 2026-08-13, see that module).
 *
 * Deliberately NOT `resolveBucketRegion` from that module: it never throws
 * and returns the caller's own `fallbackRegion` on a failed probe, which
 * would report "same region" for every failure and silently authorize each
 * branch below. Distinguishing `absent` from `indeterminate` is precisely
 * what this wrapper adds over it.
 */
export async function probeBucketRegion(
  this: S3BucketProvider,
  bucketName: string
): Promise<BucketRegionProbe> {
  try {
    return { kind: 'region', region: await this.resolveOwnedBucketRegion(bucketName) };
  } catch (probeError) {
    if (isNoSuchBucketError(probeError)) return { kind: 'absent' };
    // A FAILED probe can still carry the answer -- but only from the two
    // shapes where the header describes the BUCKET, which
    // `carriesBucketRegionHeader` is the whole statement of. Reading it off
    // any failure defeats both guards downstream (see that function).
    //
    // Gated AFTER the absence check for the same reason the gate exists at
    // all: a 404 is answered by the endpoint that was ASKED, so "the name is
    // free" must win over a header describing where the question went.
    if (carriesBucketRegionHeader(probeError)) {
      const fromHeader = regionFromErrorHeader(probeError);
      if (fromHeader) return { kind: 'region', region: fromHeader };
    }
    return {
      kind: 'indeterminate',
      // Becomes `BucketRegionProbe.reason`, read by TWO callers rather than
      // logged here, so the `.summary` hazard is invisible at every end.
      // Both are `logger.debug` today; the persisted guard path reads the
      // sibling `errorName`. The count is load-bearing and is stated on the
      // type itself (`assertStateBucketRegion` plus the us-east-1 create
      // partial-cleanup arm): a previous fix that believed there was only one
      // left the second printing the identical string to the identical sink,
      // and an earlier revision of THIS comment re-introduced "one".
      reason: describeAwsFailure(probeError).detail,
      errorName: probeError instanceof Error ? probeError.name : typeof probeError,
    };
  }
}

/**
 * Refuse to act on a bucket a STATE RECORD names that does not live in
 * `expectedRegion` (issue [#2245](https://github.com/go-to-k/cdkd/issues/2245)).
 *
 * {@link assertExistingBucketRegion} is on the CREATE path only, so it stops
 * NEW poisoning and does nothing about a record already written by a build
 * that predates it. Two paths then act on such a record, and neither noticed:
 * `update()` had no region check at all, and `delete()`'s
 * {@link assertRegionMatch} fires only from the `NoSuchBucket` branch — which
 * a cross-region `DeleteBucket` never reaches, because SDK v3's
 * region-redirect middleware FOLLOWS the 301 for body-bearing operations and
 * the delete simply succeeds against the other region's bucket.
 *
 * ## Why this probes instead of reading state
 *
 * The cheap check would be state-vs-client region, and it cannot answer this
 * question: in the poisoned record the region field is the STACK's region and
 * MATCHES, while the physical id denotes a bucket somewhere else. The bucket's
 * own location is knowable only from S3, so one `GetBucketLocation` per
 * bucket update / delete is the floor. It is a rounding error next to what
 * those paths already spend — an S3 update issues a dozen or more Put/Get
 * round trips, and a delete may enumerate and remove every object version.
 *
 * ## Refuse rather than heal
 *
 * On update, healing would mean rewriting the recorded physical id, i.e. a
 * state mutation whose blast radius (every `Fn::GetAtt` consumer, the next
 * diff, the next destroy) is larger than the misconfiguration it repairs.
 * On delete, refusing strands the destroy and needs a human — a foot-gun, and
 * a smaller one than deleting a live bucket in another region, which nothing
 * can undo. Both refusals are `markNonRetryable` for the same reason the
 * create-side one is: they are deterministic, so letting `withRetry` re-run
 * the operation for its full budget only delays the same message.
 *
 * ## What an unanswered probe does, and the IAM dependency that creates
 *
 * `absent` and `indeterminate` both PROCEED, a deliberate asymmetry with the
 * create-side guard. `absent` is the ordinary already-gone destroy, which the
 * existing `NoSuchBucket` path handles idempotently one call later.
 * `indeterminate` is the load-bearing one, and the honest description of it
 * is NOT that the affected population is unrelated to the defect — an
 * earlier revision of this comment said exactly that and it is false. It is
 * the SAME population, merely unprobeable: a principal without
 * `s3:GetBucketLocation` can hold a poisoned record just as easily as any
 * other, and for that principal this guard is INERT on every call,
 * permanently. So this change introduces a new IAM dependency — the guard is
 * only as good as `s3:GetBucketLocation` on the target bucket, which a bucket
 * POLICY can also `Deny`.
 *
 * Proceeding anyway is still the right trade, for a reason about escape
 * hatches rather than about who is affected. Failing closed would strand
 * every update and destroy for a least-privilege role with no way out except
 * widening IAM — cdkd offers no per-resource override to force one through —
 * while the reachable hazard needs a bucket that EXISTS and is owned by this
 * account, for which `GetBucketLocation` answers from any endpoint in the
 * partition (see {@link probeBucketRegion}). Three fixes that look better and
 * are worse, recorded so they are not retried: refusing on `indeterminate` is
 * the stranding above; refusing only on 403 cannot work, because a missing
 * IAM grant and a hostile `Deny` are the same wire response; and folding 403
 * into `absent` is the precise collapse {@link BucketRegionProbe}'s third
 * state exists to prevent.
 *
 * What proceeding obliges instead is that it is never SILENT on the
 * irreversible path — see {@link announceUnverifiedBucketIdentity}.
 */
export async function assertStateBucketRegion(
  this: S3BucketProvider,
  operation: 'update' | 'delete',
  logicalId: string,
  resourceType: string,
  physicalId: string,
  expectedRegion: string,
  // The delete's context: its remedy names the whole-stack
  // `cdkd state orphan` only on a stack destroy (go-to-k/cdkd#4602).
  context?: DeleteContext
): Promise<void> {
  const wantRegion = canonicalizeRegion(expectedRegion);
  const probe = await this.probeBucketRegion(physicalId);

  if (probe.kind === 'absent') return;
  if (probe.kind === 'indeterminate') {
    // AWS's raw text goes to debug and nowhere else; the warn gets the class.
    this.logger.debug(
      `GetBucketLocation failed for S3 bucket ${this.shown(physicalId)} (${displaySafe(logicalId)}) before ` +
        `${operation}: ${probe.reason}`
    );
    this.announceUnverifiedBucketIdentity(
      operation,
      logicalId,
      physicalId,
      probeFailedCause(probe.errorName)
    );
    return;
  }
  if (probe.region === wantRegion) return;

  // The consequence AND the remedy are per-operation. An earlier revision
  // shared the remedy, and the shared wording was wrong for `delete` in the
  // way that matters most: cdkd's state is region-KEYED
  // (`cdkd/{stack}/{region}/state.json`), so "rerun this stack against
  // <the bucket's region>" sends the operator to a region holding no record
  // of this stack -- and if one did exist there, the advice would be to go
  // and destroy the very bucket this guard just refused to touch.
  const consequence =
    operation === 'update'
      ? `Applying this stack's bucket configuration would reconfigure a bucket in ` +
        `${probe.region} that this stack does not own the definition of.`
      : `Deleting it would destroy a bucket in ${probe.region} that this stack's ` +
        `region does not contain, and that deletion cannot be undone.`;
  const remedy =
    operation === 'update'
      ? `Confirm which bucket you mean, then either rerun this stack against ` +
        `${probe.region}, or — if the recorded id is stale — drop this bucket's record with ` +
        `${pasteableCommand('cdkd orphan', [{ literal: "'<StackPath>/<Path/To/Bucket>'" }]).command}, which removes only that record (and ` +
        `rewrites the references to it) without touching any AWS resource, then deploy again ` +
        `to create the bucket in this stack's region — first giving it a BucketName unique to ` +
        `that region if the template fixes this one, since S3 names are global.`
      : `Confirm which bucket you mean. If ${displaySafe(physicalId)} is genuinely yours to delete, ` +
        `delete it deliberately in ${probe.region}; if this record is simply stale, drop it ` +
        `without touching any AWS resource (<region> is this stack's region, not the ` +
        `bucket's) with ${stateOrphanRecordRemedy(context, logicalId)}.`;

  throw markNonRetryable(
    new ProvisioningError(
      `Refusing to ${operation} S3 bucket ${this.shown(physicalId)} for ${displaySafe(logicalId)} (${resourceType}): ` +
        `the bucket lives in ${probe.region}, while this stack's state is for ${wantRegion}. ` +
        `S3 bucket names are globally unique, so a state record can name a bucket in another ` +
        `region — records written before the create-path region guard can carry one. ` +
        `${consequence} ${remedy}`,
      resourceType,
      logicalId,
      physicalId
    )
  );
}

/**
 * Say out loud that the identity guard did not run.
 *
 * `delete` gets a WARN and `update` a debug, and the asymmetry is the whole
 * point rather than a stylistic choice. Both proceed, but only one of them
 * proceeds into something irreversible, and cdkd's default log level is
 * `info` -- so a debug line here meant that on the one path where the guard
 * failing open destroys data, the operator's output was byte-identical to a
 * normal destroy.
 *
 * That is not merely a misconfiguration story. `GetBucketLocation` is
 * DENIABLE on the target bucket by anyone holding `s3:PutBucketPolicy` on it,
 * and a `Deny` there is indistinguishable on the wire from a missing IAM
 * grant. A 403 leaves the probe `indeterminate` -- deliberately, since a 403
 * is answered by the endpoint that was asked and
 * {@link carriesBucketRegionHeader} therefore refuses to read its header as
 * the bucket's region -- so a poisoned record naming a bucket in another
 * region PROCEEDS: the auto-empty and `DeleteBucket` follow the SDK's 301 and
 * the bucket is gone. A throttled probe during a wide destroy reaches the
 * same place by accident, and a state record with no region at all never gets
 * a probe to begin with. None of the three can be refused -- see the caller's
 * note on why failing closed is the wrong trade -- so the remaining
 * obligation is that it never happens QUIETLY.
 *
 * Deliberately NOT retried on `isThrottlingError`. It would not touch the
 * hostile-`Deny` path at all (a 403 carries neither a throttling name nor a
 * retryable status), the provider has no injected sleep seam here so a
 * bounded retry either adds real wall-clock to every throttled destroy or
 * needs a new timer seam plus fixtures to control it, and with this warning
 * in place a throttled probe is now visible and re-runnable -- which was the
 * actual defect.
 */
export function announceUnverifiedBucketIdentity(
  this: S3BucketProvider,
  operation: 'update' | 'delete',
  logicalId: string,
  physicalId: string,
  cause: UnverifiedIdentityCause
): void {
  const message =
    `Could not confirm which bucket ${this.shown(physicalId)} for ${displaySafe(logicalId)} is before ${operation}: ` +
    `${cause.why}, so the cross-region guard did NOT run and cdkd is proceeding on the ` +
    `recorded physical id alone.`;

  if (operation === 'delete') {
    this.logger.warn(
      `${message} If this state record names a bucket in another region, this destroy will ` +
        `delete THAT bucket. ${cause.remedy}`
    );
    return;
  }
  this.logger.debug(`${message} Proceeding.`);
}
