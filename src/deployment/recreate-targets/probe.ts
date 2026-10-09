import {
  ListObjectVersionsCommand,
  NoSuchBucket,
  NotFound,
  type S3Client,
} from '@aws-sdk/client-s3';
import {
  DescribeLogStreamsCommand,
  ResourceNotFoundException as LogsResourceNotFoundException,
  type CloudWatchLogsClient,
} from '@aws-sdk/client-cloudwatch-logs';
import { type StatefulReason } from '../../provisioning/stateful-types.js';
import { assertRegionMatch } from '../../provisioning/region-check.js';
import { getLogger } from '../../utils/logger.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import type { Logger } from '../../types/config.js';
import { withRetry } from '../retry.js';
import { isThrottlingError } from '../retryable-errors.js';
import { type RecreateTarget, type RecreateTargetsValidation } from './validate.js';
import { foldRegion } from './render.js';

/**
 * Clients the plan-time stateful probes need, one per conditionally
 * stateful type. Bundled rather than passed positionally so a third
 * conditional type cannot be added by widening a parameter list nobody
 * updates at the call sites.
 */
export interface StatefulProbeClients {
  /** `AWS::S3::Bucket` object probe (issue [#648]). */
  s3: S3Client;
  /** `AWS::Logs::LogGroup` log-stream probe (issue [#2558]). */
  cloudWatchLogs: CloudWatchLogsClient;
  /**
   * Sleep seam for the probes' throttle retry (issue [#2566]), threaded
   * straight through to {@link withRetry}. Production leaves it unset and
   * gets the real timer; a unit test injects a no-op so asserting the retry
   * costs no wall-clock. It lives on the CLIENTS bag rather than in a fourth
   * parameter because it is the same kind of thing as the clients — an
   * injected dependency of the probe, not a behaviour knob a user chooses.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * `StackState.region` — the region the recorded resources are expected to
   * live in. Not a client, but it belongs to the same bag for the same reason
   * `DeleteContext` carries it: the ONLY consumer is the `not-found`-means-gone
   * inference below, and `region-check.ts` exists precisely to stop that
   * inference being drawn from a client pointing somewhere else. Optional, and
   * an absent value preserves the pre-check behaviour, matching
   * `DeleteContext.expectedRegion`'s own back-compat contract — where ABSENT
   * includes a blank string, since the value is folded before the guard reads
   * it and a whitespace-only region can match nothing.
   *
   * DEFENCE IN DEPTH, stated precisely rather than implied: today's single
   * caller passes the PERSISTED `state.region` of the record it fetched under
   * the same `stackRegion` key the client is built for, so the two agree and
   * the refuse arm is not reached FROM THERE. It used to be reachable — a
   * record written by hand or by another tool could carry a different region,
   * and that was the case the arm was described as existing for — but since
   * issue [#3328](https://github.com/go-to-k/cdkd/issues/3328)
   * `S3StateBackend.getState` normalizes a region-scoped record's `region` to
   * its KEY's region, so a divergent body can no longer reach this parameter
   * through `deploy.ts`. What keeps the arm is the second half, which was
   * already stated and is now the whole of it: this function is EXPORTED and
   * the next caller need not derive its region the same way — so the arm
   * guards the not-found-means-gone inference, not one record shape.
   *
   * The case this field can no longer EXPRESS — a record whose body named
   * another region — is reported separately, by
   * {@link StatefulProbeClients.expectedRegionDiverged}, and that split is
   * deliberate: the divergent value is record-body content and the refusal arm
   * below renders its comparand.
   *
   * ONE live path reaches the ABSENT case rather than merely the hand-written
   * one, and it is recorded here rather than left for a reader to derive: a
   * LEGACY pre-v2 state record carries no `region` field at all
   * (`s3-state-backend.ts`'s legacy fallback returns a v1 blob whose key layout
   * was not region-scoped), so `deploy.ts` passes `undefined` and the guard is
   * INERT for that record. Inert, not unsound: the client this probe uses and
   * the client the recreate's DELETE will use are the same stack-region
   * clients, so a not-found seen here is a not-found in the region the deploy
   * is about to act in. The check buys nothing there because there is no
   * second region for it to disagree with — not because the inference got
   * weaker.
   */
  expectedRegion?: string | undefined;

  /**
   * The record this probe is deciding for named a region OTHER than the S3 key
   * it was read from, so cdkd cannot attribute a not-found to any region
   * (issue [#3328](https://github.com/go-to-k/cdkd/issues/3328), review round
   * 2). Forces the same fail-closed outcome the mismatch arm reaches.
   *
   * A BOOLEAN, not the region: the mismatch arm renders its comparand in a
   * default-verbosity warn, and the divergent value is body content anyone
   * able to write one state key chooses — routing it there would put an
   * attacker-chosen string into a line telling the operator to "fix the region
   * mismatch", which is the misdirection channel #3328 exists to close.
   *
   * It exists because {@link StatefulProbeClients.expectedRegion} can no longer
   * carry the case: `getState` now normalizes a record's `region` to its key's,
   * so that comparand and the client region agree by construction and the
   * mismatch arm is unreachable from `deploy.ts`. Before the normalization a
   * divergent body WAS the mismatch and the arm fired; this keeps that outcome
   * rather than silently dropping a data guard.
   */
  expectedRegionDiverged?: boolean;
}

/**
 * Async emptiness probes for the two conditionally stateful types
 * (issues [#648] / [#2558]).
 *
 * For every target whose sync {@link StatefulReason} is `null` — which for
 * these two types means DEFER, not "not stateful" (see
 * `isStatefulRecreateTargetSync` (`validate.ts`)) — issues one single-page listing and
 * promotes the reason when the resource is not provably empty:
 *
 *   - `AWS::S3::Bucket` → `ListObjectVersions(MaxKeys=1)` against the
 *     bucket's recorded physical id, promoting to `'has-objects'` when the
 *     bucket has at least one current object, prior version, OR
 *     delete-marker. `ListObjectVersions` rather than `ListObjectsV2` so the
 *     probe mirrors the s3-bucket-provider's `emptyBucket` view: a versioned
 *     bucket whose current keys have all been soft-deleted (so
 *     `ListObjectsV2.KeyCount === 0`) still holds prior versions +
 *     delete-markers that the destroy + recreate cycle would lose. Using the
 *     same listing API as the provider ensures the probe and the destroy path
 *     agree on "empty".
 *   - `AWS::Logs::LogGroup` → `DescribeLogStreams(limit=1)` against the log
 *     group's recorded name. Only ONE response shape leaves the target
 *     un-promoted: a PRESENT, zero-length `logStreams` with no `nextToken`.
 *     A page with a stream, an ABSENT `logStreams` (the SDK types it
 *     optional), and a zero-length page carrying a continuation token all
 *     promote to `'has-log-events'` — the last two are non-answers, and an
 *     unprovable emptiness must not read as empty. **Stream presence, not
 *     `storedBytes`,** and the choice is load-bearing in both directions:
 *       * Every log event belongs to a log stream, so ZERO streams is a
 *         structural proof that the group holds no events — the only kind of
 *         "empty" this guard may act on.
 *       * `LogStream.storedBytes` cannot be used at all: the SDK still
 *         declares the field, and the AWS API reference says "As of June 17,
 *         2019, this parameter is no longer supported for log streams, and is
 *         always reported as zero" (quoted verbatim in
 *         `@aws-sdk/client-cloudwatch-logs`'s own `LogStream.storedBytes`
 *         JSDoc, which also marks it `@deprecated`). A probe reading it would
 *         report EVERY log group empty.
 *       * The same SDK note says the log GROUP's own `storedBytes` is "not
 *         affected", so that field is not ruled out the way the stream's is —
 *         but cdkd does not read it either, and the ground is not a claim
 *         about how fresh it is (this repo has measured nothing about that).
 *         Stream presence needs no size semantics at all: zero streams is a
 *         STRUCTURAL proof, and it over-blocks rather than under-blocks (a
 *         group holding only empty streams counts as non-empty), which is the
 *         side this guard must err on.
 *
 * **Probe failures fail CLOSED for the log group, OPEN for the bucket**, and
 * the divergence is deliberate rather than an oversight. The bucket's
 * soft-fail is pre-existing shipped behaviour (issue [#648]) documented on
 * `docs/_contents/cli-deploy-safety.md`; the log group's arm is new with issue [#2558],
 * whose whole subject is that an unprovable emptiness must not read as empty.
 * So a failed `DescribeLogStreams` (permission denied, throttling) warns AND
 * promotes to `'has-log-events'`: the user gets a refusal naming the remedies,
 * not a silent recreate. The ONE carve-out is a typed
 * `ResourceNotFoundException`, which is an ANSWER rather than a failure to get
 * one — a log group AWS says does not exist provably holds no events.
 *
 * Returns a NEW array of targets; the input is not mutated. Targets of other
 * types, and targets whose sync reason is already non-null, are passed through
 * unchanged — including a `'has-retention'` log group, whose verdict the bag
 * already settled and no probe may weaken.
 */
export async function probeStatefulRecreateTargetsAsync(
  targets: ReadonlyArray<RecreateTarget>,
  clients: StatefulProbeClients,
  logger: Logger = getLogger().child('recreate-targets')
): Promise<RecreateTarget[]> {
  const promoted: RecreateTarget[] = [];
  // Both probes retry a THROTTLE (issue [#2566]). A rate limit is the one
  // failure here that a retry can clear, and the two arms answer a throttle
  // differently by design -- the bucket falls through to its open failure
  // arm, the log group to a refusal -- so an unretried throttle silently
  // widens the S3 hole in one arm and refuses a deploy the user asked for in
  // the other. Deliberately NOT the shared transient table: every other error
  // here is either an answer (`ResourceNotFoundException`) or something a
  // second identical call will not change, and this runs on the pre-flight
  // path where a user is waiting.
  //
  // "Throttle" means what `isThrottlingError` means -- a throttling error
  // NAME or a 429/503 -- and not the shared table's `Rate exceeded` MESSAGE
  // backstop, which a custom `isRetryable` replaces rather than extends. Both
  // services this probes raise a canonical name (`SlowDown` / a 503 for S3,
  // `ThrottlingException` for CloudWatch Logs), so the narrower reading
  // covers them; a rate limit arriving with a generic name would not retry.
  //
  // 3 retries = 4 attempts, sleeping 0.5s + 1s + 2s = 3.5s at worst, per
  // target. `logger` is threaded so that wait is visible under `--verbose`
  // instead of reading as a hang.
  const probeRetryOptions = {
    maxRetries: 3,
    initialDelayMs: 500,
    logger,
    // `(classificationText, error)` — the ERROR is the second argument, and
    // reading the first would hand `isThrottlingError` a string with no
    // `.name` and classify every throttle as non-retryable. Same spelling the
    // other narrow throttle-only call sites use.
    isRetryable: (_message: string, error: unknown) => isThrottlingError(error),
    ...(clients.sleep && { sleep: clients.sleep }),
  };
  for (const target of targets) {
    if (target.statefulReason !== null) {
      promoted.push({ ...target });
      continue;
    }
    if (target.resourceType === 'AWS::S3::Bucket') {
      try {
        const result = await withRetry(
          () =>
            clients.s3.send(
              new ListObjectVersionsCommand({
                Bucket: target.physicalId,
                // No `EncodingType` (go-to-k/cdkd#3313): this is an emptiness PROBE —
                // it reads whether any entry came back, never a key.
                MaxKeys: 1,
              })
            ),
          target.logicalId,
          probeRetryOptions
        );
        // ONE of the log-group arm's two non-answers applies here; the other
        // does NOT, and issue [#2578] asked for both. The difference is how
        // each API encodes "none", which is a wire fact rather than a style:
        //
        //   - An ABSENT `Versions` / `DeleteMarkers` is NOT a non-answer.
        //     S3 OMITS an empty collection rather than sending an empty array
        //     — measured 2026-09-05, `us-east-1`, read-only
        //     `ListObjectVersions(MaxKeys=1)` through this same client: a
        //     bucket holding versions and no delete markers answered
        //     `Versions` present with one entry and `DeleteMarkers` absent
        //     from the response entirely. So an empty bucket omits BOTH, and
        //     requiring a PRESENT empty pair — the shape the log-group arm
        //     requires, correctly, because CloudWatch Logs sends `logStreams`
        //     present-and-empty — would make EVERY empty bucket read as not
        //     provably empty and turn this conditional arm into an
        //     unconditional refusal. Reading absence as zero is right here.
        //
        //   - A CONTINUATION marker with no entry in either array IS a
        //     non-answer, exactly as it is there: the listing is unfinished,
        //     so this page's emptiness is not the BUCKET's emptiness. That
        //     half was the real defect and is what this check adds.
        //
        // The fail-OPEN posture of the `catch` below is unchanged (issue
        // [#648], published in `docs/_contents/cli-deploy-safety.md`): this is about a
        // response that arrived, not about a probe that failed.
        const hasVersions = (result.Versions?.length ?? 0) > 0;
        const hasDeleteMarkers = (result.DeleteMarkers?.length ?? 0) > 0;
        // Truthiness, not `!== undefined`, so an empty-string marker reads as
        // ABSENT — the same reading the log-group twin's `!result.nextToken`
        // gives the same shape. Measured: a complete listing carries
        // `IsTruncated: false` and neither marker at all, so the two spellings
        // agree today; they disagree only on a `''` marker, where
        // `!== undefined` would refuse a genuinely empty bucket.
        const truncated =
          result.IsTruncated === true || !!result.NextKeyMarker || !!result.NextVersionIdMarker;
        if (hasVersions || hasDeleteMarkers) {
          promoted.push({ ...target, statefulReason: 'has-objects' });
        } else if (truncated) {
          // Warned rather than passed silently, as the log-group arm does:
          // the user is about to be refused, and the refusal alone would not
          // say that the API answered without answering.
          logger.warn(
            `--recreate-via-cc-api / --recreate-via-sdk-provider: S3 answered the emptiness probe ` +
              `for ${target.logicalId} (bucket ${target.physicalId}) without settling it (an empty ` +
              `page carrying a continuation marker); treating the bucket as NOT provably empty. ` +
              `Re-run to retry the probe, or — only if the bucket really is disposable — re-run ` +
              `with --force-stateful-recreation (that flag has NO per-resource granularity and ` +
              `clears the guard for every target in the run).`
          );
          promoted.push({ ...target, statefulReason: 'has-objects' });
        } else {
          promoted.push({ ...target });
        }
      } catch (e) {
        // A not-found is an ANSWER, not a failure to get one: AWS says the
        // bucket does not exist, so it provably holds nothing and the
        // recreate's delete can lose nothing. Passing it through silently
        // matches what the log-group arm already does with its own typed
        // `ResourceNotFoundException` — without this, issue [#2595]'s new row
        // would tell a user cdkd "does not know" about a bucket AWS just said
        // is gone, which is the over-warning that trains people to ignore the
        // line the issue added.
        //
        // Typed, never a message heuristic: a substring match on "not found"
        // would also swallow a permission error worded that way. Both classes
        // because the two verbs differ — `ListObjectVersions` raises
        // `NoSuchBucket`, while the SDK surfaces a bare 404 as `NotFound`.
        //
        // Deliberately NOT region-guarded, unlike the log-group twin: that arm
        // clears a stateful verdict on a not-found, so a wrong-region client
        // could turn a refusal into a pass. Here the verdict is already `null`
        // and stays `null` — the only thing this decides is whether the plan
        // prints an UNKNOWN row, so a wrong-region not-found costs a missing
        // warning, not a lost refusal.
        if (e instanceof NoSuchBucket || e instanceof NotFound) {
          promoted.push({ ...target });
          continue;
        }
        logger.warn(
          `--recreate-via-cc-api / --recreate-via-sdk-provider: live S3 probe failed for ${target.logicalId} ` +
            `(bucket ${target.physicalId}); leaving stateful guard at the sync ` +
            `result. If the bucket might be non-empty, re-run with ` +
            `--force-stateful-recreation. Underlying error: ` +
            `${describeAwsFailure(e).detail}`
        );
        // The verdict stays `null` — the fail-OPEN posture is unchanged — but
        // the target now CARRIES the fact that nothing was established, so
        // the confirm prompt can say so instead of rendering it identically
        // to a bucket measured empty (issue [#2595]).
        promoted.push({ ...target, probeUnresolved: true });
      }
      continue;
    }
    if (target.resourceType === 'AWS::Logs::LogGroup') {
      try {
        const result = await withRetry(
          () =>
            clients.cloudWatchLogs.send(
              new DescribeLogStreamsCommand({
                logGroupName: target.physicalId,
                limit: 1,
              })
            ),
          target.logicalId,
          probeRetryOptions
        );
        // Only ONE response shape proves the group empty: a PRESENT,
        // zero-length `logStreams` with no continuation token. The other two
        // shapes are non-answers, and reading either as "empty" is the same
        // mistake issue [#2558] exists to retire:
        //   - `logStreams` ABSENT. The SDK types the field optional
        //     (`DescribeLogStreamsResponse.logStreams?: LogStream[]`), so an
        //     omitted field is a legal response that says nothing about the
        //     group's contents. `?.length ?? 0` used to read it as zero.
        //   - a zero-length page carrying `nextToken`. A continuation token
        //     means the listing is not finished, so this page's emptiness is
        //     not the GROUP's emptiness.
        // Anything that is not the proof promotes to `'has-log-events'`, whose
        // rendered text — "not provably empty" — is exactly what happened.
        const streams = result.logStreams;
        const provablyEmpty = streams !== undefined && streams.length === 0 && !result.nextToken;
        if (provablyEmpty) {
          promoted.push({ ...target });
        } else if (streams !== undefined && streams.length > 0) {
          promoted.push({ ...target, statefulReason: 'has-log-events' });
        } else {
          // The non-answer shapes. Warned rather than passed silently: the
          // user is about to be refused, and the refusal alone would not say
          // that the API answered without answering.
          logger.warn(
            `--recreate-via-cc-api / --recreate-via-sdk-provider: CloudWatch Logs answered the ` +
              `emptiness probe for ${target.logicalId} (log group ${target.physicalId}) without ` +
              `settling it (${streams === undefined ? 'no logStreams field in the response' : 'an empty page carrying a continuation token'}); ` +
              `treating the log group as NOT provably empty. An unset or zero RetentionInDays is ` +
              `CloudWatch Logs' "never expire", so an unprovable emptiness must not read as empty. ` +
              `Re-run to retry the probe, or — only if the log group really is disposable — re-run ` +
              `with --force-stateful-recreation (that flag has NO per-resource granularity and ` +
              `clears the guard for every target in the run).`
          );
          promoted.push({ ...target, statefulReason: 'has-log-events' });
        }
      } catch (e) {
        if (e instanceof LogsResourceNotFoundException) {
          // The one error that is itself an ANSWER rather than a failure to
          // get one: AWS says the log group does not exist, so it provably
          // holds no events and the recreate's delete can lose nothing. Typed
          // check, not a message heuristic — the SDK exports the class and a
          // substring match on "does not exist" would also swallow a
          // permission error worded that way. Leaving the reason at `null`
          // matches what the S3 arm does for a missing bucket, where the
          // general soft-fail covers the same case.
          //
          // Guarded by the same `assertRegionMatch` helper the DELETE path
          // calls before trusting its own `ResourceNotFoundException`
          // (`LogsLogGroupProvider.delete`): `region-check.ts` exists so a
          // not-found is not read as "gone" when the client is simply pointing
          // at the wrong region. The HELPER is shared; the terms are not. Two
          // deliberate differences, both in this direction:
          //   - this site folds BOTH sides through `foldRegion` first (see
          //     below), where the delete path passes both raw — so
          //     `US-EAST-1` vs `us-east-1` matches here and refuses there;
          //   - the delete path THROWS on a mismatch; this one cannot — the
          //     probe's contract is that it never does — so a failed check
          //     falls back to the arm this whole branch is an exception to.
          let regionVerified = true;
          // The record's own region CONTRADICTED the key it was read from, so
          // cdkd does not know which region its resources are in and a
          // not-found cannot be attributed to either (issue
          // [#3328](https://github.com/go-to-k/cdkd/issues/3328), review round
          // 2). This is the same fail-closed outcome the mismatch arm below
          // reaches, and it exists because that arm can no longer reach it from
          // `deploy.ts`: `getState` now normalizes the record's `region` to the
          // key's, so `expectedRegion` and the client region agree by
          // construction and the compare always passes. Before that
          // normalization a divergent body WAS the mismatch, and this branch is
          // what kept the data guard on.
          //
          // It is a FLAG rather than the divergent value because the value is
          // record-body content: the mismatch arm's warn renders its comparand,
          // and routing a planted region through it would put an
          // attacker-chosen string into a default-verbosity line telling the
          // operator to "fix the region mismatch" — the misdirection channel
          // #3328 closes. So this arm names no region at all.
          if (clients.expectedRegionDiverged) {
            regionVerified = false;
            logger.warn(
              `--recreate-via-cc-api / --recreate-via-sdk-provider: CloudWatch Logs reported ` +
                `${target.logicalId} (log group ${target.physicalId}) missing, but this stack's ` +
                `state record names a region that is not the one its S3 key holds, so cdkd ` +
                `cannot attribute that not-found to any region — run 'cdkd state show' with ` +
                `--verbose to see what the record claims, and repair it. Re-run with ` +
                `--force-stateful-recreation if the log group really is disposable (that flag ` +
                `clears the data guard for every target in the run). Until then it is treated ` +
                `as NOT provably empty.`
            );
          }
          // FOLDED before the guard, as `CloudControlProvider` does: a
          // whitespace-only recorded region carries no information, so the
          // check must treat it as absent rather than compare against it.
          //
          // Skipped entirely on the divergence arm above: the two comparands
          // agree by construction there (the record's region IS the key's
          // after normalization), so the compare could only pass and would
          // spend a `config.region()` round trip to say nothing.
          const recordedRegion = clients.expectedRegionDiverged
            ? undefined
            : foldRegion(clients.expectedRegion);
          if (recordedRegion) {
            // Both sides trimmed and lower-cased through the local
            // `foldRegion`, the same pair `CloudControlProvider` applies before
            // its own region assert: a CDK manifest may spell the region
            // `US-EAST-1` while the SDK client resolves `us-east-1`, and
            // `assertRegionMatch` compares with `!==`. An un-folded compare
            // would refuse a genuinely absent log group and answer with the
            // one remedy that clears the data guard for every target in the
            // run. The CLIENT side of the fold is defensive — `AwsClients`
            // already lower-cases what it is handed (it does NOT trim) — and
            // only the recorded side has a live path to an unfolded value.
            let clientRegion: string | undefined;
            try {
              clientRegion = foldRegion(await clients.cloudWatchLogs.config.region());
              assertRegionMatch(
                clientRegion,
                recordedRegion,
                target.resourceType,
                target.logicalId,
                target.physicalId
              );
            } catch {
              // `assertRegionMatch` is used as a PREDICATE here, and its own
              // message is deliberately not relayed: it is written for the
              // DELETE path ("rerun the destroy with the correct region"),
              // which is not the command the user is running. The refusal is
              // re-worded for the deploy pre-flight instead, and it never
              // throws — the probe's contract — so a rejected `config.region()`
              // lands here too and is answered the same conservative way.
              regionVerified = false;
              // Two causes reach this catch and they need different remedies:
              // a genuine mismatch, and a client whose region never resolved at
              // all (a rejected `config.region()`, or a caller whose client has
              // no `config`). Telling the second one to "fix the region
              // mismatch" names a mismatch that was never established.
              // A TRUTHINESS test, not a null check: an empty-string region
              // is unresolved too, and falsiness is what
              // `assertRegionMatch`'s own unknown-region branch keys on.
              const cause = clientRegion
                ? `the client region (${clientRegion}) does not match the region cdkd state ` +
                  `records for it (${recordedRegion}) — a not-found from the wrong ` +
                  `region says nothing about the log group. Fix the region mismatch, or`
                : `the CloudWatch Logs client's own region could not be resolved, so the ` +
                  `not-found cannot be attributed to the region cdkd state records ` +
                  `(${recordedRegion}). Fix the client's region configuration, or`;
              logger.warn(
                `--recreate-via-cc-api / --recreate-via-sdk-provider: CloudWatch Logs reported ` +
                  `${target.logicalId} (log group ${target.physicalId}) missing, but ${cause} ` +
                  `re-run with --force-stateful-recreation if the log group really is disposable ` +
                  `(that flag clears the data guard for every target in the run). Until then it ` +
                  `is treated as NOT provably empty.`
              );
            }
          }
          if (regionVerified) {
            logger.debug(
              `--recreate-via-cc-api / --recreate-via-sdk-provider: log group ${target.physicalId} ` +
                `(${target.logicalId}) does not exist, so it holds no events — not stateful.`
            );
            promoted.push({ ...target });
            continue;
          }
          promoted.push({ ...target, statefulReason: 'has-log-events' });
          continue;
        }
        logger.warn(
          `--recreate-via-cc-api / --recreate-via-sdk-provider: live CloudWatch Logs probe failed for ` +
            `${target.logicalId} (log group ${target.physicalId}); treating the log group as ` +
            `NOT provably empty. An unset or zero RetentionInDays is CloudWatch Logs' ` +
            `"never expire", so an unprovable emptiness must not read as empty. Fixes, cheapest ` +
            `first: grant logs:DescribeLogStreams and re-run, or re-run as-is if this was ` +
            `transient (CloudWatch Logs throttles this API aggressively). Only if the log group ` +
            `really is disposable, re-run with --force-stateful-recreation — that flag has NO ` +
            `per-resource granularity and clears the guard for every target in the run. ` +
            `Underlying error: ${describeAwsFailure(e).detail}`
        );
        promoted.push({ ...target, statefulReason: 'has-log-events' });
      }
      continue;
    }
    promoted.push({ ...target });
  }
  return promoted;
}

/**
 * Async re-validation of the stateful-guard slice of a
 * {@link RecreateTargetsValidation}, after promoting the deferred S3 bucket
 * and log group reasons via {@link probeStatefulRecreateTargetsAsync}.
 *
 * Skips the probe entirely when `forceStatefulRecreation: true` — the
 * sync validation already omits the blocked list in that case, and
 * skipping avoids an unnecessary AWS round-trip (plus permission-denied
 * warn-and-skip cycle on low-privilege CI roles).
 *
 * Returns a NEW validation; the input is not mutated. Non-stateful
 * categories (`unknownLogicalIds` / `missingFromState` /
 * `ambiguousIntent` / `blockedMultiRegionTargets`) are preserved verbatim.
 */
export async function probeAndRevalidateStateful(input: {
  validation: RecreateTargetsValidation;
  clients: StatefulProbeClients;
  forceStatefulRecreation: boolean;
}): Promise<RecreateTargetsValidation> {
  if (input.forceStatefulRecreation) return input.validation;
  const promoted = await probeStatefulRecreateTargetsAsync(input.validation.targets, input.clients);
  const blockedStatefulTargets = promoted.filter(
    (t): t is RecreateTarget & { statefulReason: Exclude<StatefulReason, null> } =>
      t.statefulReason !== null
  );
  return {
    ...input.validation,
    targets: promoted,
    blockedStatefulTargets,
  };
}
