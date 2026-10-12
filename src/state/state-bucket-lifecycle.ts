import {
  GetBucketLifecycleConfigurationCommand,
  ListObjectsV2Command,
  PutBucketLifecycleConfigurationCommand,
  type LifecycleRule,
  type S3Client,
  type TransitionDefaultMinimumObjectSize,
} from '@aws-sdk/client-s3';
import { describeAwsFailure } from '../utils/aws-failure-text.js';
import { expectedOwnerParam } from '../utils/expected-bucket-owner.js';
import { LISTING_ENCODING_TYPE, decodeListingKey } from '../utils/s3-listing-keys.js';
import { displaySafe } from '../utils/display-safe.js';
import { UNRENDERABLE } from './lock-contention-message.js';
import { CUSTOM_RESOURCE_RESPONSE_PREFIX } from './state-prefix.js';

/**
 * The lifecycle rule ID cdkd owns on the state bucket (issue #2353).
 *
 * The ID is the idempotency key: a configuration that already carries a rule
 * with this ID is left exactly as it is — whatever its body, so a user who
 * edited cdkd's rule keeps their edit — and no PUT is sent.
 */
export const CUSTOM_RESOURCE_RESPONSE_LIFECYCLE_RULE_ID =
  'cdkd-custom-resource-responses-expiration';

/**
 * Days after which a custom-resource response's current version becomes
 * noncurrent, and again after which a noncurrent version is deleted. One day
 * is the S3 lifecycle floor. S3 rounds each step up to the next midnight UTC,
 * so a body can survive up to about four days on a versioned bucket, and no
 * live poll (at most the 1h async timeout, signed URL valid for 2h) can lose
 * its object to this rule.
 */
export const CUSTOM_RESOURCE_RESPONSE_EXPIRATION_DAYS = 1;

/**
 * What {@link applyCustomResourceResponseExpiration} did.
 *
 * - `present`: the rule was already there; nothing was written.
 * - `added`: the rule was merged into the existing configuration and written.
 * - `failed`: an S3 call failed and the bucket was left untouched; `reason`
 *   says why (already display-safe), and `accessDenied` whether it was a
 *   permission refusal. Never thrown: a missing
 *   `s3:GetLifecycleConfiguration` / `s3:PutLifecycleConfiguration` permission
 *   must not fail a deploy.
 * - `refused`: the rule would expire objects that are not responses, so it was
 *   not added; `reason` names them (already display-safe).
 */
export type CustomResourceResponseExpirationOutcome =
  | { readonly status: 'present' }
  | { readonly status: 'added' }
  | { readonly status: 'failed'; readonly reason: string; readonly accessDenied: boolean }
  | { readonly status: 'refused'; readonly reason: string };

/**
 * What the rule matches: every response key is `cdkd-<epoch ms>-<suffix>.json`
 * directly under the response prefix (`prepareInvocation` / `getResponseKey`
 * in `custom-resource-provider.ts`), and an epoch in milliseconds starts with
 * `1` from 2001 to 2286. Narrower than the prefix itself, so a state stored
 * there by `--state-prefix custom-resource-responses` is out of reach unless
 * its stack name starts with `cdkd-1`. The ID check below never rewrites
 * a rule once written, so this filter is what every bucket keeps.
 */
export const CUSTOM_RESOURCE_RESPONSE_LIFECYCLE_PREFIX = `${CUSTOM_RESOURCE_RESPONSE_PREFIX}/cdkd-1`;

/**
 * The rule cdkd adds. `legacyPrefix` writes the rule-level `Prefix` form,
 * because S3 refuses a configuration that mixes it with the `Filter` form.
 */
export function buildCustomResourceResponseLifecycleRule(legacyPrefix: boolean): LifecycleRule {
  const prefix = CUSTOM_RESOURCE_RESPONSE_LIFECYCLE_PREFIX;
  return {
    ID: CUSTOM_RESOURCE_RESPONSE_LIFECYCLE_RULE_ID,
    Status: 'Enabled',
    ...(legacyPrefix ? { Prefix: prefix } : { Filter: { Prefix: prefix } }),
    Expiration: { Days: CUSTOM_RESOURCE_RESPONSE_EXPIRATION_DAYS },
    NoncurrentVersionExpiration: { NoncurrentDays: CUSTOM_RESOURCE_RESPONSE_EXPIRATION_DAYS },
  };
}

/**
 * Ensure the state bucket's lifecycle configuration expires custom-resource
 * responses (issue #2353).
 *
 * A custom-resource handler PUTs its whole response document, `Data`
 * included, to an object under that prefix. cdkd deletes it once read, but a
 * run killed before that cleanup leaves it live until `cdkd gc` runs; this
 * rule bounds that residue to days without touching the wire contract.
 *
 * `PutBucketLifecycleConfiguration` REPLACES the whole configuration, so this
 * is a read-merge-write and never a blind PUT:
 *
 * - GET first. `NoSuchLifecycleConfiguration` is "no rules yet"; any other GET
 *   failure stops here WITHOUT writing, because a configuration that could not
 *   be read cannot be merged — writing would delete the user's rules.
 * - A rule with {@link CUSTOM_RESOURCE_RESPONSE_LIFECYCLE_RULE_ID} already
 *   present means done: no PUT.
 * - Before adding it, one listing (paged) checks that nothing but responses
 *   lives under {@link CUSTOM_RESOURCE_RESPONSE_LIFECYCLE_PREFIX}; a stack
 *   state stored there is `refused`, since the rule would expire that state.
 * - GET again right before the PUT and merge onto THAT read (or stop as
 *   `present`), so the paged listing does not widen the window in which a
 *   concurrent edit of the configuration is lost.
 * - Otherwise every existing rule is written back unchanged, cdkd's rule is
 *   appended, and `TransitionDefaultMinimumObjectSize` is passed through (left
 *   out, the PUT would reset it to the S3 default).
 *
 * A user rule whose filter overlaps the prefix is kept as is. In the `Filter`
 * form S3 accepts overlapping rules and applies the earliest expiration, so
 * cdkd's one-day rule can only shorten the life of cdkd's own response
 * objects. In the legacy rule-level `Prefix` form S3 rejects overlapping
 * prefixes for the same action; that PUT fails, which is reported as
 * `failed` with the bucket untouched.
 *
 * Two limits of a read-merge-write through the typed SDK: S3 offers no
 * conditional write for this configuration, so a change another writer makes
 * between the second GET and the PUT is lost; and a lifecycle element newer than the
 * pinned `@aws-sdk/client-s3` is dropped on the way through. Both apply only
 * to the one run that adds the rule.
 */
export async function applyCustomResourceResponseExpiration(
  s3: S3Client,
  bucket: string,
  opts: { expectedBucketOwner?: string } = {}
): Promise<CustomResourceResponseExpirationOutcome> {
  const owner = opts.expectedBucketOwner ? { ExpectedBucketOwner: opts.expectedBucketOwner } : {};
  const first = await readLifecycle(s3, bucket, owner);
  if ('failed' in first) return first.failed;
  if (first.rules.some((rule) => rule.ID === CUSTOM_RESOURCE_RESPONSE_LIFECYCLE_RULE_ID)) {
    return { status: 'present' };
  }

  // A stack deployed with `--state-prefix custom-resource-responses` keeps its
  // state under this prefix, and the rule would expire it when the stack name
  // starts with `cdkd-1`. Response keys contain no further `/`, so any common
  // prefix one level down is somebody's state (or lock: written first).
  let collision: string | undefined;
  try {
    collision = await findStateUnderResponsePrefix(s3, bucket, owner);
  } catch (error) {
    return failedOutcome('ListObjectsV2', error);
  }
  if (collision !== undefined) {
    return {
      status: 'refused',
      reason:
        `${CUSTOM_RESOURCE_RESPONSE_PREFIX}/${displaySafe(collision) || UNRENDERABLE} holds ` +
        `objects other than custom-resource responses (a stack deployed with ` +
        `--state-prefix ${CUSTOM_RESOURCE_RESPONSE_PREFIX}), and the rule would expire them`,
    };
  }

  // Read AGAIN right before the PUT and merge onto THAT: the listing above can
  // take several pages, and a rule another writer added meanwhile would
  // otherwise be overwritten by a merge of the first read.
  const latest = await readLifecycle(s3, bucket, owner);
  if ('failed' in latest) return latest.failed;
  if (latest.rules.some((rule) => rule.ID === CUSTOM_RESOURCE_RESPONSE_LIFECYCLE_RULE_ID)) {
    return { status: 'present' };
  }
  const existing = latest.rules;
  const minimumObjectSize = latest.minimumObjectSize;

  const legacyPrefix = existing.some((rule) => rule.Prefix !== undefined);
  try {
    await s3.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: bucket,
        ...owner,
        LifecycleConfiguration: {
          Rules: [...existing, buildCustomResourceResponseLifecycleRule(legacyPrefix)],
        },
        ...(minimumObjectSize !== undefined && {
          TransitionDefaultMinimumObjectSize: minimumObjectSize,
        }),
      })
    );
  } catch (error) {
    return failedOutcome('PutBucketLifecycleConfiguration', error);
  }
  return { status: 'added' };
}

/**
 * GET the configuration: its rules (none on `NoSuchLifecycleConfiguration`),
 * or the `failed` outcome for any other error.
 */
async function readLifecycle(
  s3: S3Client,
  bucket: string,
  owner: { ExpectedBucketOwner?: string }
): Promise<
  | {
      rules: LifecycleRule[];
      minimumObjectSize: TransitionDefaultMinimumObjectSize | undefined;
    }
  | { failed: CustomResourceResponseExpirationOutcome }
> {
  try {
    const current = await s3.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: bucket, ...owner })
    );
    return {
      rules: current.Rules ?? [],
      minimumObjectSize: current.TransitionDefaultMinimumObjectSize,
    };
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name === 'NoSuchLifecycleConfiguration') {
      return { rules: [], minimumObjectSize: undefined };
    }
    return { failed: failedOutcome('GetBucketLifecycleConfiguration', error) };
  }
}

/** True when S3 refused the call for want of permission. */
function isAccessDenied(error: unknown): boolean {
  const e = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
  return e?.name === 'AccessDenied' || e?.$metadata?.httpStatusCode === 403;
}

function failedOutcome(
  operation: string,
  error: unknown
): { readonly status: 'failed'; readonly reason: string; readonly accessDenied: boolean } {
  return {
    status: 'failed',
    reason: failureReason(operation, error),
    accessDenied: isAccessDenied(error),
  };
}

/**
 * The first "directory" the rule's filter would match, relative to the
 * response prefix, or `undefined`.
 * Pages through, because a listing is ordered by key and abandoned placeholder
 * keys (`cdkd-<digits>-...`) can fill a page ahead of a `cdkd-Stack/` prefix.
 */
async function findStateUnderResponsePrefix(
  s3: S3Client,
  bucket: string,
  owner: { ExpectedBucketOwner?: string }
): Promise<string | undefined> {
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ...owner,
        Prefix: CUSTOM_RESOURCE_RESPONSE_LIFECYCLE_PREFIX,
        Delimiter: '/',
        EncodingType: LISTING_ENCODING_TYPE,
        ...(token !== undefined && { ContinuationToken: token }),
      })
    );
    const first = decodeListingKey(page.CommonPrefixes?.find((p) => p.Prefix)?.Prefix);
    if (first !== undefined) return first.slice(CUSTOM_RESOURCE_RESPONSE_PREFIX.length + 1);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token !== undefined);
  return undefined;
}

function failureReason(operation: string, error: unknown): string {
  return `${operation} failed: ${displaySafe(describeAwsFailure(error).detail) || UNRENDERABLE}`;
}

/**
 * The warning both callers print for a `failed` or `refused` outcome, so the
 * remedy is spelled once.
 */
export function customResourceResponseExpirationWarning(
  bucket: string,
  outcome:
    | { readonly status: 'refused'; readonly reason: string }
    | { readonly status: 'failed'; readonly reason: string; readonly accessDenied: boolean }
): string {
  // Name the permissions only for a permission refusal: an InvalidRequest (a
  // legacy `Prefix` rule overlapping cdkd's) or the 1000-rule limit is not
  // fixed by IAM. A 403 also covers an ExpectedBucketOwner mismatch, which
  // the owner check in the remedy names.
  const remedy =
    outcome.status === 'refused'
      ? `To add the rule, move that stack to a different --state-prefix.`
      : outcome.accessDenied
        ? `To add the rule, grant s3:GetLifecycleConfiguration, s3:PutLifecycleConfiguration ` +
          `and s3:ListBucket on the bucket, and check that this account owns it.`
        : `To add the rule, review the bucket's lifecycle configuration against the reason above.`;
  return (
    `Could not add the ${CUSTOM_RESOURCE_RESPONSE_EXPIRATION_DAYS}-day expiration lifecycle rule ` +
    `for ${CUSTOM_RESOURCE_RESPONSE_PREFIX}/ to state bucket ` +
    `${displaySafe(bucket, { asciiOnly: true }) || UNRENDERABLE} (${outcome.reason}). The bucket's ` +
    `lifecycle configuration was left unchanged. Custom-resource response objects left by an ` +
    `interrupted run stay until 'cdkd gc' removes them. ${remedy}`
  );
}

/**
 * Per-process memo for {@link ensureCustomResourceResponseExpirationOnce},
 * keyed by bucket name.
 */
const ensured = new Map<string, Promise<void>>();

/**
 * Apply the rule to an ALREADY-bootstrapped state bucket, at most once per
 * process per bucket.
 *
 * Called by `CustomResourceProvider` beside its first response-placeholder
 * write, so a deploy with no custom resources makes no call at all, and a
 * deploy with any pays one GET (plus a listing and one PUT the first time) for the
 * whole process, and the caller does not wait for it. The returned promise
 * never rejects; a failure is one warning through `warn`. Every call carries
 * `ExpectedBucketOwner` when the caller's account resolves, like every other
 * state-bucket call.
 */
export function ensureCustomResourceResponseExpirationOnce(
  s3: S3Client,
  bucket: string,
  log: { warn: (message: string) => void; debug: (message: string) => void }
): Promise<void> {
  const memo = ensured.get(bucket);
  if (memo) return memo;
  const run = (async (): Promise<void> => {
    try {
      const owner = await expectedOwnerParam(s3);
      const outcome = await applyCustomResourceResponseExpiration(s3, bucket, {
        ...(owner.ExpectedBucketOwner && { expectedBucketOwner: owner.ExpectedBucketOwner }),
      });
      if (outcome.status === 'failed' || outcome.status === 'refused') {
        log.warn(customResourceResponseExpirationWarning(bucket, outcome));
      } else if (outcome.status === 'added') {
        log.debug(
          `Added the ${CUSTOM_RESOURCE_RESPONSE_EXPIRATION_DAYS}-day expiration lifecycle rule ` +
            `for ${CUSTOM_RESOURCE_RESPONSE_PREFIX}/ to the state bucket.`
        );
      }
    } catch (error) {
      // The apply never throws; `expectedOwnerParam` is not documented as
      // never throwing. Either way this promise must not reject.
      log.warn(
        customResourceResponseExpirationWarning(bucket, failedOutcome('lifecycle check', error))
      );
    }
  })();
  ensured.set(bucket, run);
  return run;
}

/** Test-only: forget which buckets were ensured in this process. */
export function resetCustomResourceResponseExpirationMemo(): void {
  ensured.clear();
}
