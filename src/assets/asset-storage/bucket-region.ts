import { S3Client, GetBucketLocationCommand } from '@aws-sdk/client-s3';
import { getLogger } from '../../utils/logger.js';
import { CdkdError } from '../../utils/error-handler.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { canonicalizeRegion } from '../../utils/aws-partition.js';
import { pasteableCommand } from '../../utils/pasteable-command.js';
import { plainIdentOr } from '../../utils/display-safe.js';
import { quotedIfPlain, isPlainName, bucketNameSubject } from './marker.js';

/**
 * Read a bucket's home region off an S3 error's response headers.
 *
 * S3 answers a cross-region request with `x-amz-bucket-region` on BOTH shapes
 * this module can meet, measured against real S3 on 2026-08-26 (issue
 * [#2240](https://github.com/go-to-k/cdkd/issues/2240)):
 *
 * - the `301` a `HeadBucket` returns for a bucket in another region, whose
 *   empty HEAD body the SDK turns into a synthetic `name: 'Unknown'` /
 *   `message: 'UnknownError'` (see `normalizeAwsError`), and
 * - the `409 BucketAlreadyOwnedByYou` a `CreateBucket` returns for a bucket
 *   this account owns elsewhere.
 *
 * The SDK lowercases header keys; the scan is case-insensitive anyway so a
 * test double spelling it canonically is still read.
 */
function readBucketRegionHeader(error: unknown): string | undefined {
  const headers = (error as { $response?: { headers?: Record<string, string> } } | undefined)
    ?.$response?.headers;
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'x-amz-bucket-region' && value) return value;
  }
  return undefined;
}

/**
 * Fold a `GetBucketLocation` `LocationConstraint` to a region name.
 *
 * The API answers with an EMPTY constraint for `us-east-1` and the legacy `EU`
 * alias for `eu-west-1`; every other region comes back verbatim.
 */
function bucketLocationToRegion(constraint: string | null | undefined): string {
  if (!constraint) return 'us-east-1';
  if (constraint === 'EU') return 'eu-west-1';
  return constraint;
}

/**
 * Does this error mean "the bucket lives in another region"?
 *
 * Derived from the AWS SDK's own predicate, and deliberately WIDER -- not a
 * mirror of it. `@aws-sdk/middleware-sdk-s3`'s `regionRedirectMiddleware` fires
 * when `x-amz-bucket-region` is present AND the status is `301`, OR `400` with
 * either `IllegalLocationConstraintException` or a `HeadBucket` command. This
 * drops that inner conjunct and accepts ANY header-carrying `400`, because the
 * conjunct exists to decide whether the SDK should silently RETRY against
 * another region, while the only thing done here is REFUSE -- and a `400` that
 * carries a bucket region is a cross-region answer whatever raised it. The
 * widening is safe in the other direction too: a same-region `400` folds to
 * `actual === want` and falls through to a throw either way --
 * `normalizeAwsError` at the two `ensureAssetStorage` / `bootstrap-destroy`
 * sites, and the raw error at `verifyAssetStorageExists`, whose non-redirect
 * arm rethrows verbatim. It is never an adoption and never a skipped
 * teardown.
 *
 * A status-`301`-only test would MISS the `400` spelling entirely, on which the
 * guard silently would not fire.
 */
export function isCrossRegionRedirect(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } } | undefined)?.$metadata
    ?.httpStatusCode;
  // A `301` counts on its OWN. An earlier revision required the header on both
  // arms, which REGRESSED the header-less `301`: it stopped reaching the guard
  // (whose `GetBucketLocation` fallback resolves exactly that case) and fell
  // back to the "please report it" wording this change exists to remove. The
  // header is needed only to WIDEN to `400`, where it is what separates a
  // region redirect from an ordinary client error.
  if (status === 301) return true;
  return status === 400 && readBucketRegionHeader(error) !== undefined;
}

/**
 * Refuse an asset bucket this account owns that lives in a DIFFERENT region
 * (issue [#2240](https://github.com/go-to-k/cdkd/issues/2240)).
 *
 * `BucketAlreadyOwnedByYou` and a cross-region HeadBucket redirect are both
 * ACCOUNT-global ownership signals while a bucket is REGIONAL, so neither one
 * means "the bucket is in this region". The DEFAULT asset-bucket name embeds
 * the region (`getCdkdAssetBucketName`), which is why this looked structurally
 * unreachable — but that is only the default. `cdkd bootstrap --asset-bucket
 * <name>` takes a caller-chosen, region-free name, so bootstrapping two
 * regions under one custom name reaches every site below.
 *
 * Why REFUSE rather than follow the redirect: `bootstrap.ts` deliberately
 * re-points the STATE bucket at its own region via
 * `rebuildClientForBucketRegion`, because one state bucket serves the whole
 * account. Asset storage is the opposite — per-region by design, with the
 * marker, the publish path and the template rewrite all assuming the bucket
 * sits in the deploy region. Adopting a foreign-region bucket would publish
 * this region's assets into another region and apply this region's bucket
 * configuration (encryption, public-access block, deny-external-account
 * policy) there.
 *
 * Deliberately NOT `resolveBucketRegion` from `utils/aws-region-resolver.ts`:
 * that helper never throws and returns its `fallbackRegion` on a failed probe,
 * which would turn this fail-CLOSED guard into a fail-OPEN one. Both arms here
 * end in a refusal, including the one where the region cannot be determined.
 */
export async function assertAssetBucketRegion(
  s3Client: Pick<S3Client, 'send'>,
  bucketName: string,
  expectedRegion: string,
  accountId: string,
  cause: Error
): Promise<void> {
  const want = canonicalizeRegion(expectedRegion);
  // The PROSE names a region only when it is a plain identifier (go-to-k/cdkd#4205):
  // the region can come from a stack's `env.region`, and a raw value in a
  // sentence runs when pasted, with no quote parity needed.
  const wantShown = plainIdentOr(want, 'this deploy region');
  // The command rides a trailing labelled line, never the sentence: pasting a
  // prose span WITH its quotes is what let an interpolated value run
  // (go-to-k/cdkd#3436). The `<name>` hole is quoted for the same reason — bare,
  // it reads stdin from a file `name` and truncates the next word.
  const bootstrapUnique = pasteableCommand('cdkd bootstrap', [
    { flag: '--region', value: want, hole: 'region' },
    { flag: '--asset-bucket', hole: 'name' },
  ]);
  const remedy =
    `Either bootstrap ${wantShown} with an asset-bucket name unique to it, or run this ` +
    `against the bucket's own region.` +
    `\nBootstrap with: ${bootstrapUnique.command}`;

  let actual: string;
  const fromHeader = readBucketRegionHeader(cause);
  if (fromHeader) {
    actual = canonicalizeRegion(fromHeader);
  } else {
    try {
      const location = await s3Client.send(
        new GetBucketLocationCommand({ Bucket: bucketName, ExpectedBucketOwner: accountId })
      );
      actual = canonicalizeRegion(bucketLocationToRegion(location.LocationConstraint));
    } catch (probeError) {
      // The probe runs on a client scoped to the DEPLOY region, so for the very
      // bucket under test it can itself answer a cross-region redirect -- which
      // carries the region we were looking for. Read it rather than degrading to
      // "could not determine".
      const fromProbe = readBucketRegionHeader(probeError);
      if (fromProbe) {
        actual = canonicalizeRegion(fromProbe);
      } else {
        // Thread the ORIGINATING error as the cause: it is the one that says why
        // we are here at all. The probe failure goes in the message instead, so
        // neither is lost.
        //
        // Split BEFORE the throw (issue #2302). This message is not a terminal
        // line: it flows through `extractDeploymentEventError` into the
        // persisted `deployments/{runId}.jsonl` store, which outlives the run.
        // The headline population for a failing probe is a principal without
        // `s3:GetBucketLocation` or a bucket policy that `Deny`s it, and S3
        // words that `AccessDenied` as `User:
        // arn:aws:sts::<account>:assumed-role/<role>/<session> is not
        // authorized to perform: ...` -- so interpolating it wrote the caller's
        // account id, role name and session name into that durable store.
        //
        // The debug line is NOT optional decoration: AWS's text is what
        // separates a missing IAM grant from a bucket-policy `Deny`, and that
        // distinction is the operator's next action. `cause` cannot carry it
        // here -- it is deliberately the ORIGINATING error, not the probe's.
        const failure = describeAwsFailure(probeError);
        // Gated on `redacted`, matching `S3BucketProvider.wrapOperationError`
        // and the field's own doc: when nothing was withheld, `detail` IS the
        // text already in the throw, so the line would only repeat it.
        if (failure.redacted) {
          getLogger().debug(
            `GetBucketLocation failed for asset bucket ${quotedIfPlain(bucketName, 'with a name that is not a plain identifier')} while confirming it ` +
              `belongs to ${wantShown}: ${failure.detail}`
          );
        }
        // Deliberately NOT stamped with `markRedactedCause`, unlike
        // `S3BucketProvider.wrapOperationError` (issue #2302). The stamp tells
        // a retry classifier to read the `.cause` chain INSTEAD of this
        // message, which is only useful when the chain actually carries what
        // the message withheld -- and here it cannot: `cause` is deliberately
        // the ORIGINATING error, and `probeError`, whose text `failure.detail`
        // holds, is not in the chain at all. Stamping anyway would not recover
        // one withheld word; it would only feed the ORIGINATING error's message
        // to classification, which is precisely the un-audited widening the
        // opt-in design exists to refuse (see `retryClassificationText`).
        //
        // Nothing is lost by omitting it. No caller of `ensureAssetStorage`
        // runs inside any of the three message classifiers, and AWS's own text
        // is already reachable at `debug` above.
        throw new CdkdError(
          `${isPlainName(bucketName) ? `Asset bucket '${bucketName}'` : 'An asset bucket whose name is not a plain identifier'} is claimed by an existing bucket, but cdkd ` +
            `could not determine which region that bucket is in, so it cannot confirm ` +
            `it belongs to ${wantShown}. Refusing to adopt it. ` +
            `(region probe failed: ${failure.summary}) ` +
            `${remedy}`,
          'ASSET_STORAGE_FOREIGN_REGION_BUCKET',
          cause
        );
      }
    }
  }

  if (actual === want) return;
  // Defence in depth: `actual` is S3's own redirect header, not a planted
  // value, so no test drives a hostile one here (go-to-k/cdkd#4205 review).
  const actualShown = plainIdentOr(actual, 'another region');

  throw new CdkdError(
    // NOT "owned by this account": a cross-region redirect is emitted by the
    // routing layer BEFORE `ExpectedBucketOwner` is evaluated, so on the 301 /
    // 400 path ownership was never established (only the 409
    // `BucketAlreadyOwnedByYou` proves it). Saying otherwise would tell a user
    // cdkd owns a bucket somebody else may hold.
    `${bucketNameSubject(bucketName)} resolves to a bucket in ${actualShown}, ` +
      `while this operation targets ${wantShown}. S3 bucket names are globally unique, and ` +
      `both 'BucketAlreadyOwnedByYou' and a cross-region redirect report ACCOUNT ` +
      `ownership rather than the bucket's region, so cdkd cannot treat it as ` +
      `${wantShown}'s asset bucket. cdkd asset storage is per-region by design: adopting ` +
      `it would publish ${wantShown}'s assets into ${actualShown} and apply ${wantShown}'s bucket ` +
      `configuration there. ${remedy}`,
    'ASSET_STORAGE_FOREIGN_REGION_BUCKET',
    cause
  );
}
