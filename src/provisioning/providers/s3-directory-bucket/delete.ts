import {
  DeleteBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { LISTING_ENCODING_TYPE, decodeListingKey } from '../../../utils/s3-listing-keys.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { S3_AUTO_DELETE_OBJECTS_TAG, hasCdkAutoDeleteTag } from '../../data-delete-intent.js';
import { renderDisableCommand } from '../../replacement-protection-advice.js';
import { maskerOrIdentity, type MaskerFn } from '../../masked-retry-logger.js';
import { markNotGone } from '../../not-gone.js';
import { displayIdent, displaySafe } from '../../../utils/display-safe.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import type { S3DirectoryBucketProvider } from '../s3-directory-bucket-provider.js';

/**
 * What `delete()` throws for a non-empty bucket with no auto-empty opt-in
 * (issue [#1344](https://github.com/go-to-k/cdkd/issues/1344)), with the bucket
 * name rendered safely (issue
 * [#3270](https://github.com/go-to-k/cdkd/issues/3270)).
 *
 * `bucketName` on the delete path is the STATE-borne physical id, which for
 * this type is the TEMPLATE-chosen name, and this message is THROWN from
 * `delete()` — so it reaches the operator's terminal AND the durable
 * `deployments/*.jsonl` store. It used to interpolate the name BARE into
 * `aws s3 rm s3://<name> --recursive`, so a name carrying `;`, a backtick,
 * `$(...)` or a newline APPENDED a command to a recursive delete when pasted.
 *
 * The command goes through the shared `renderDisableCommand`
 * (`displaySafe(asciiOnly)`, then `shellQuote`, then SUPPRESS the whole command
 * when sanitizing CHANGED the value, since a command naming the sanitized name
 * would empty a DIFFERENT bucket). Three things are specific to this site:
 *
 *  - **The quoted unit is the ASSEMBLED `s3://<name>` argument**, not the name:
 *    `aws s3 rm` has no `--bucket <name>` form, and quoting only the name would
 *    put a quote in the middle of a word. `shellQuote` leaves `:` and `/` bare,
 *    so a clean name renders exactly as before.
 *  - **The NAME is compared against its own sanitized form HERE, before the
 *    shared renderer sees it.** The renderer's changed-by-sanitizing test runs
 *    over the assembled argument, where the `s3://` prefix shields a LEADING
 *    space of the name from the sanitizer's trim — so without this check a
 *    padded name would be shown in a command while the prose beside it named
 *    the trimmed one.
 *  - **A name containing `/` is suppressed here**, which the shared renderer
 *    cannot know to do: `s3://a/b` addresses the prefix `b` in bucket `a`, a
 *    DIFFERENT bucket, and both characters pass sanitizing and quoting
 *    unchanged. An empty name is suppressed for the same reason (`s3://` names
 *    no bucket at all).
 *  - **The caller's `DeleteContext.maskSecrets` decides whether the name may
 *    be shown at all** (issue [#2007](https://github.com/go-to-k/cdkd/issues/2007)):
 *    a name the masker changes is secret-derived, so the prose shows it masked
 *    and NO command is printed for it, since `aws s3 rm s3://***` names no
 *    bucket. Every cdkd delete site passes one (`cdkd destroy` its printing bag
 *    of secret-derived names); absent leaves the name as is.
 *
 * The PROSE name goes through `displayIdent`, because this message is
 * persisted: a control byte or a newline in it would otherwise forge lines in
 * the events store even with the command suppressed. A clean name is a plain
 * identifier, which `displayIdent` renders unchanged.
 *
 * The caller marks the refusal NON-RETRYABLE: it is a deterministic verdict,
 * and `delete()` wraps it in a message carrying the LOGICAL id, which the
 * destroy runner and the deploy engine's replacement delete classify as
 * "already deleted" by SUBSTRING (`NotFoundException` there, a bare `NotFound`
 * here). A logical id containing the needle would otherwise have its non-empty
 * bucket read as gone; both classifiers skip a marked error.
 */
function notEmptyRefusalMessage(bucketName: string, maskSecrets: MaskerFn | undefined): string {
  const mask = maskerOrIdentity(maskSecrets);
  const secretDerived = mask(bucketName) !== bucketName;
  const nameable =
    bucketName !== '' &&
    !bucketName.includes('/') &&
    displaySafe(bucketName, { asciiOnly: true }) === bucketName;
  // Decided on the bare NAME, where the masker's whole-value arm reaches a
  // secret below its substring floor; the renderer only sees `s3://<name>`.
  const command =
    nameable && !secretDerived
      ? renderDisableCommand({
          before: 'aws s3 rm',
          identifier: `s3://${bucketName}`,
          after: '--recursive',
        })
      : '';
  const remedy = command
    ? `Delete all objects first (e.g. ${command}) and destroy again.`
    : secretDerived
      ? 'Delete all objects first, via the console, and destroy again: the bucket name is ' +
        'derived from a secret, so cdkd does not print it.'
      : 'Delete all objects first, via the console, and destroy again: the bucket name cdkd ' +
        'recorded cannot be reproduced safely on a command line, so any command shown here could ' +
        'act on a different bucket or run part of the name as shell.';
  // The name masked as a VALUE first, so a secret below the masker's
  // substring floor is caught too, then the whole message.
  return mask(
    `bucket ${displayIdent(mask(bucketName))} is not empty. Matching CloudFormation, cdkd does not ` +
      `delete a non-empty directory bucket without an explicit opt-in. ${remedy}`
  );
}

/**
 * Delete an S3 Express Directory Bucket
 *
 * CloudFormation-parity data guard (issue #1344, sibling of #1340): a
 * non-empty directory bucket is only auto-emptied when the user opted in —
 * the `aws-cdk:auto-delete-objects` tag on the bucket (a first-class
 * template `Tags` entry now that `Tags` is a handled property, issue #609)
 * or the deploy engine's `--force-stateful-recreation` consent on a
 * replacement delete (`DeleteContext.forceDataDelete`). Otherwise the
 * not-empty error surfaces exactly like CloudFormation's DELETE_FAILED
 * (live-A/B-verified 2026-08-03: CFn fails a non-empty DirectoryBucket
 * delete with "The bucket you tried to delete is not empty", 409).
 *
 * Directory buckets do not support versioning, so the opted-in auto-empty
 * only needs to delete current objects.
 */
export async function deleteImpl(
  this: S3DirectoryBucketProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  // go-to-k/cdkd#2007: the physical id is the bucket name, which can be
  // secret-derived.
  const mask = maskerOrIdentity(context?.maskSecrets);
  this.logger.debug(mask(`Deleting S3 Express Directory Bucket ${logicalId}: ${mask(physicalId)}`));
  // go-to-k/cdkd#2613: the empty-and-delete goes through the shared S3
  // client, so a client in another region than the state record would aim
  // it at a region this record was not written through. Refuse before any
  // call, not only on NoSuchBucket; the client's region is resolved only when
  // there is one to compare with.
  assertRegionMatch(
    context?.expectedRegion ? await this.s3Client.config.region() : undefined,
    context?.expectedRegion,
    resourceType,
    logicalId,
    physicalId,
    'pre-delete'
  );

  const allowAutoEmpty =
    context?.forceDataDelete === true ||
    hasCdkAutoDeleteTag(properties, S3_AUTO_DELETE_OBJECTS_TAG);

  try {
    await this.deleteBucketWithEmptyRetry(
      logicalId,
      physicalId,
      allowAutoEmpty,
      context?.maskSecrets
    );
  } catch (error) {
    // Bucket not found = already deleted (idempotent)
    if (
      error instanceof Error &&
      (error.name === 'NoSuchBucket' || error.name === 'BucketNotFound')
    ) {
      const clientRegion = await this.s3Client.config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(mask(`Bucket ${mask(physicalId)} does not exist, skipping deletion`));
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      mask,
      error,
      (text) =>
        new ProvisioningError(
          mask(`Failed to delete S3 Express Directory Bucket ${logicalId}: ${text}`),
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
    // The wrap names an AWS failure by its CLASS, and the delete classifiers
    // read `NotFoundException` in a message as "already deleted": only the
    // typed not-found above means this resource is gone (go-to-k/cdkd#2319).
    throw error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
  }
}

/**
 * Delete the bucket, absorbing the write race on an opted-in auto-empty:
 * an object written between the empty pass and the delete makes AWS reject
 * the delete as not-empty, so re-empty and retry (bounded) — the same
 * bounded loop as the standard-bucket sibling, ported per issue #609's
 * "Tags becomes a handled property" note (the tag opt-in is mainstream
 * now, so the ~zero-opt-in rationale for skipping the loop in PR #1347 no
 * longer holds). Without the opt-in, the first not-empty error surfaces
 * as the CloudFormation-parity guard (issue #1344).
 */
export async function deleteBucketWithEmptyRetry(
  this: S3DirectoryBucketProvider,
  logicalId: string,
  bucketName: string,
  allowAutoEmpty: boolean,
  maskSecrets: MaskerFn | undefined
): Promise<void> {
  const mask = maskerOrIdentity(maskSecrets);
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await this.s3Client.send(new DeleteBucketCommand({ Bucket: bucketName }));
      this.logger.debug(`Successfully deleted S3 Express Directory Bucket ${logicalId}`);
      return;
    } catch (error) {
      // `.detail`, never `.summary`: the substring test below is what keeps this
      // degradation alive, and it matches AWS's OWN wording. Byte-identical to
      // the ternary it replaced, minus that ternary's throw.
      const msg = describeAwsFailure(error).detail;
      if (msg.includes('not empty') || msg.includes('BucketNotEmpty')) {
        if (!allowAutoEmpty) {
          throw markNonRetryable(new Error(notEmptyRefusalMessage(bucketName, maskSecrets)));
        }
        this.logger.info(
          mask(
            `Directory bucket ${mask(bucketName)} not empty (attempt ${attempt}/${maxAttempts}), emptying (auto-delete opt-in present)...`
          )
        );
        await this.emptyBucket(bucketName, mask);
        continue;
      }
      throw error;
    }
  }
  // Final attempt after emptying
  await this.s3Client.send(new DeleteBucketCommand({ Bucket: bucketName }));
  this.logger.debug(`Successfully deleted S3 Express Directory Bucket ${logicalId}`);
}

/**
 * Empty all objects from a directory bucket.
 * Lists and deletes objects in batches of 1000.
 */
export async function emptyBucket(
  this: S3DirectoryBucketProvider,
  bucketName: string,
  mask: MaskerFn
): Promise<void> {
  let continuationToken: string | undefined;

  do {
    const listResponse = await this.s3Client.send(
      new ListObjectsV2Command({
        // go-to-k/cdkd#3313: a CR in a key becomes an LF without this.
        EncodingType: LISTING_ENCODING_TYPE,
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
            // go-to-k/cdkd#3313: decoded — these Keys are deleted.
            Objects: objects.map((obj) => ({ Key: decodeListingKey(obj.Key) })),
            Quiet: true,
          },
        })
      );
      this.logger.debug(mask(`Deleted ${objects.length} objects from bucket ${mask(bucketName)}`));
    }

    continuationToken = listResponse.IsTruncated ? listResponse.NextContinuationToken : undefined;
  } while (continuationToken);
}
