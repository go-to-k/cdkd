import { canonicalizeRegion } from '../utils/aws-partition.js';

/**
 * ONE region-normalization point for the CLI's command handlers.
 *
 * Issue [#1795](https://github.com/go-to-k/cdkd/issues/1795) folded `--region`
 * at the boundary of the four `cdkd local *` commands, for a reason that was
 * never specific to them: AWS SDK endpoint resolution, SigV4's credential
 * scope, this repo's own `PARTITION_TABLE` prefix walk and every ARN segment
 * built from the value are ALL case-sensitive, so a raw spelling is wrong at
 * each of them. Issue
 * [#2065](https://github.com/go-to-k/cdkd/issues/2065) measured what that costs
 * the commands the fix skipped — `cdkd deploy --region US-EAST-1` dies at the
 * state-bucket preflight before it does anything:
 *
 * ```text
 * FAIL S3  ListObjectsV2  region=US-EAST-1  AuthorizationHeaderMalformed:
 *          the region 'US-EAST-1' is wrong; expecting 'us-east-1'
 * ```
 *
 * The fold lives here rather than at each consumer because a command reads
 * `options.region` in many places — `applyRoleArnIfSet`, the
 * `process.env.AWS_REGION` copy, several `new AwsClients({ region })` spreads —
 * and folding per consumer is the shape that has needed a follow-up every time
 * a new consumer was added. Double-folding is a no-op, which is what makes a
 * second fold further down (`derivePartitionAndUrlSuffix`, `AwsClients`) safe
 * rather than redundant.
 */

/**
 * Fold `--region` to its canonical spelling in place, at the handler's entry.
 *
 * Call this BEFORE the first consumer of `options.region` — in practice before
 * `applyRoleArnIfSet`, which is the first AWS-touching call in most handlers.
 *
 * A handler that ALSO needs the user's exact spelling must capture it first.
 * The one consumer with that need is the bootstrap-marker read, whose second
 * probe exists precisely to find a key an unfolded `cdkd bootstrap` wrote
 * (see `readBootstrapMarkerBody` in `src/assets/asset-storage.ts`); the
 * `--stack-region` fold in `local-invoke.ts` keeps a `rawStackRegion` for the
 * same class of reason.
 */
export function foldRegionOption(options: { region?: string | undefined }): void {
  if (options.region !== undefined) {
    options.region = canonicalizeRegion(options.region);
  }
  // The ENV spellings need the same fold, and folding only the flag would have
  // left the WORSE half of issue #2065 in place. A handler that builds
  // `new AwsClients({})` with no region - the shape every one of them takes
  // when `--region` is absent - hands region resolution to the AWS SDK's own
  // chain, which reads these two variables DIRECTLY. No amount of folding at
  // cdkd's read sites reaches that read. Measured on this repo's own build:
  //
  // ```text
  // $ AWS_REGION=US-EAST-1 node dist/cli.js state info --state-bucket cdkd-state-<acct>
  // StateError: ... S3 error during HeadBucket on '...' (HTTP 400)
  // ```
  //
  // Overwriting them is in-character rather than a new liberty: `deploy.ts` and
  // `destroy.ts` already assign `--region` into both, and `applyRoleArnIfSet`
  // exports credentials the same way. The value written differs from the one
  // read only in case, and only in the direction AWS itself demands.
  //
  // `AWS_DEFAULT_REGION` is folded for cdkd's OWN readers, not for the SDK's:
  // measured against this repo's vendored SDK, `@smithy/config-resolver`'s
  // `NODE_REGION_CONFIG_OPTIONS` reads `AWS_REGION` only, so
  // `AWS_DEFAULT_REGION=eu-west-9` alone resolves the PROFILE region rather
  // than `eu-west-9`. cdkd reads it in its own right at
  // `src/synthesis/synthesizer.ts` and `src/local/ecr-puller.ts`, and
  // `deploy.ts` / `destroy.ts` write it, which is what this fold is for. An
  // earlier revision of this comment claimed the SDK reads it; it does not.
  for (const key of ['AWS_REGION', 'AWS_DEFAULT_REGION'] as const) {
    const value = process.env[key];
    if (value) process.env[key] = canonicalizeRegion(value);
  }
}

/**
 * The region the user NAMED — `--region` first, then `AWS_REGION` — canonical,
 * or `undefined` when they named NEITHER.
 *
 * `undefined` is a distinct answer from any region string, and the distinction
 * is the whole point of this helper. Issue
 * [#2029](https://github.com/go-to-k/cdkd/issues/2029): materializing a
 * `|| 'us-east-1'` literal collapses "the user named no region" into "the user
 * named us-east-1", and the literal then wins over the profile region the AWS
 * SDK's own chain would have resolved from `~/.aws/config`. For `cdkd gc` that
 * meant evaluating — and deleting in — a region the user never mentioned, with
 * no error, because `us-east-1` is a perfectly valid region.
 *
 * So a caller that builds an SDK client spreads this CONDITIONALLY
 * (`...(named !== undefined && { region: named })`) and lets an absent region
 * stay absent. A caller that needs a region as a VALUE — a state key, a bucket
 * name, a marker key — must resolve one rather than pin a literal, and must
 * resolve the SAME one its clients use or the two silently disagree.
 *
 * Deliberately reads `AWS_REGION` only, not `AWS_DEFAULT_REGION`: that is the
 * precedence every one of these handlers already had, and widening it is a
 * behavior change with no defect behind it.
 */
export function namedCliRegion(optionRegion?: string): string | undefined {
  return canonicalizeRegion(optionRegion || process.env['AWS_REGION']) || undefined;
}

/**
 * The user's EXACT `--region` / `AWS_REGION` spelling, unfolded.
 *
 * Only the bootstrap-marker read wants this — it probes the canonical key
 * first and this spelling second, so that a marker written by a pre-fold
 * `cdkd bootstrap` is still found. Every other consumer wants
 * {@link namedCliRegion}.
 */
export function rawCliRegion(optionRegion?: string): string | undefined {
  return optionRegion || process.env['AWS_REGION'] || undefined;
}
