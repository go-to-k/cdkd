import { S3Client } from '@aws-sdk/client-s3';
import { ECRClient } from '@aws-sdk/client-ecr';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { getLogger } from '../../../utils/logger.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { CdkdError } from '../../../utils/error-handler.js';
import { setAwsClients, AwsClients } from '../../../utils/aws-clients.js';
import { applyRoleArnIfSet } from '../../../utils/role-arn.js';
import {
  namedCliRegion,
  rawCliRegion,
  reconcileMarkerRegionWithLegacyDefault,
  regionNeedsReconciliation,
  resolveEffectiveRegion,
} from '../../region-options.js';
import { getDefaultStateBucketName } from '../../config-loader.js';
import {
  getBootstrapMarkerKey,
  parseBootstrapMarker,
  readBootstrapMarkerBody,
} from '../../../assets/asset-storage.js';
import { S3StateBackend } from '../../../state/s3-state-backend.js';
import { CUSTOM_RESOURCE_RESPONSE_OBJECT_DESCRIPTION } from '../../../state/s3-noncurrent-version-purge.js';
import {
  listAllLockKeys,
  describeStateKey,
  STATE_KEY_MAX_CODE_POINTS,
  LOCK_FILE_SUFFIX,
  DEFAULT_STATE_PREFIX,
  CUSTOM_RESOURCE_RESPONSE_PREFIX,
} from '../state-file-keys.js';
import { displayIdent } from '../../../utils/display-safe.js';
import { awsClientDefaults } from '../../../utils/aws-client-defaults.js';
import { s3ClientDefaults } from '../../../utils/s3-client-defaults.js';
import { scanReferencedAssets } from './scan.js';
import {
  listS3Candidates,
  listResponsePlaceholderCandidates,
  listEcrCandidates,
  formatBytes,
  formatAge,
  promptGcConfirm,
  deleteS3Candidates,
  deleteEcrCandidates,
  type S3Candidate,
  type EcrCandidate,
} from './candidates.js';

export interface GcOptions {
  stateBucket?: string;
  region?: string;
  profile?: string;
  roleArn?: string;
  /** Age guard in milliseconds (parsed from `--older-than`, default 30d). */
  olderThan: number;
  /** Print the reclaim plan and exit without prompting or deleting. */
  dryRun: boolean;
  /** `-y` / `--yes` — skip the interactive confirmation. */
  yes: boolean;
  verbose: boolean;
}

/**
 * `cdkd gc` implementation. See `gc.ts`'s module JSDoc for the safety posture.
 */
export async function gcCommand(options: GcOptions): Promise<void> {
  const logger = getLogger();

  if (options.verbose) {
    logger.setLevel('debug');
  }

  logger.info('Starting cdkd gc...');
  logger.debug('Options:', options);

  // Resolve --role-arn / CDKD_ROLE_ARN before any AWS call.
  // `namedCliRegion`, not `canonicalizeRegion(options.region)`: this command
  // deliberately skips `foldRegionOption` (so `rawCliRegion` below still sees
  // the user's exact spelling for the marker's second probe), which left the
  // ENV half unfolded here - `AWS_REGION=US-EAST-1 cdkd gc --role-arn ...`
  // passed `undefined`, so `applyRoleArnIfSet` built `new STSClient({})` and
  // the SDK read the raw env itself (`SignatureDoesNotMatch`). Folding the
  // named region covers both halves without disturbing the raw capture.
  await applyRoleArnIfSet({
    roleArn: options.roleArn,
    region: namedCliRegion(options.region),
  });

  // Issue #1995. `region` picks BOTH the AWS clients' endpoints and the
  // bootstrap marker KEY, and the two want different treatment of case:
  //
  // - The CLIENTS need it CANONICAL. SDK endpoint resolution is case-sensitive
  //   (measured in `derivePartitionAndUrlSuffix`'s note: `CN-NORTH-1` resolves
  //   to the COMMERCIAL suffix), so an upper-cased `--region` builds clients
  //   pointing at the wrong partition.
  // - The marker KEY needs BOTH spellings probed. `cdkd bootstrap` derives its
  //   own region verbatim (issue #1820), so `AWS_REGION=US-EAST-1 cdkd
  //   bootstrap` really wrote `cdkd-bootstrap/US-EAST-1.json`. Folding the read
  //   and stopping would MISS that marker where the pre-fold read HIT it, and
  //   gc would report the region as not opted in. The probe below therefore
  //   tries the canonical key first and the raw spelling second — the same
  //   shape `loadBootstrapContainerRepo` uses (`src/cli/commands/
  //   local-state-loader.ts`), and what makes this read independent of when
  //   #1820 aligns the write side.
  //
  // The failure direction here is the SAFE one either way — a missed marker
  // deletes nothing, it just reports "not opted in" for a region that has
  // assets — which is why this is a usability fix rather than a data one.
  // Issue #2029. The region gc operates on now consults the AWS profile, and
  // the region its CLIENTS target is the same value by construction - the two
  // used to be resolved separately and could disagree, so gc could read one
  // region's marker and delete against another region's endpoints.
  //
  // The sequencing is forced by a dependency: the reconciliation has to ask
  // "does a marker already exist under the old default?", which needs the state
  // backend, which needs the bucket name, which needs the account id. So the
  // account lookup runs against a bag built from the UNRECONCILED region. That
  // is safe and not a shortcut: STS is region-agnostic for
  // `GetCallerIdentity`, and the state backend re-resolves the state bucket's
  // own region itself (`rebuildClientForBucketRegion`) because the bucket is
  // account-scoped. Only the ECR / asset-S3 clients are genuinely
  // region-specific, and they are built AFTER the reconciliation.
  const effective = await resolveEffectiveRegion(options);

  const accountClients = new AwsClients({
    region: effective.region,
    ...(options.profile && { profile: options.profile }),
  });

  // Account id is needed for the default bucket name AND for the
  // ExpectedBucketOwner pin on every S3 call, so always resolve it.
  const identity = await accountClients.sts.send(new GetCallerIdentityCommand({}));
  const accountId = identity.Account!;
  const bucketName = options.stateBucket ?? getDefaultStateBucketName(accountId);

  // State-bucket reads (marker, state scan, lock scan) go through the
  // state backend, which resolves the bucket's ACTUAL region itself — the
  // state bucket is account-scoped and may live in a different region
  // than --region. The asset bucket / ECR repo clients keep using --region.
  const markerS3Client = new S3Client({
    ...awsClientDefaults({ profile: options.profile }),
    ...s3ClientDefaults(),
    region: effective.region,
    ...(options.profile && { profile: options.profile }),
  });
  const stateBackend = new S3StateBackend(
    markerS3Client,
    { bucket: bucketName, prefix: DEFAULT_STATE_PREFIX },
    { region: effective.region, ...(options.profile && { profile: options.profile }) }
  );

  // Hold an existing us-east-1 opt-in rather than silently reporting the region
  // as not opted in. `cdkd bootstrap` writes this key through the SAME resolver
  // and the SAME reconciliation, so the read and write sides cannot drift.
  // `stateBackend` is gc's REAL backend (it is account-scoped and re-resolves
  // the state bucket's own region), so no throwaway probe is needed here — but
  // the guard still matters: it skips two S3 round trips for a NAMED region.
  const region = regionNeedsReconciliation(effective)
    ? await reconcileMarkerRegionWithLegacyDefault({
        effective,
        probe: stateBackend,
        markerKeyFor: getBootstrapMarkerKey,
        logger,
      })
    : effective.region;
  // The RAW spelling, for the marker's second probe only (see the probe below).
  const rawRegion = rawCliRegion(options.region) ?? region;

  const awsClients =
    region === effective.region
      ? accountClients
      : new AwsClients({ region, ...(options.profile && { profile: options.profile }) });
  if (awsClients !== accountClients) accountClients.destroy();
  setAwsClients(awsClients);

  const ecrClient = new ECRClient({
    ...awsClientDefaults({ profile: options.profile }),
    region,
    ...(options.profile && { profile: options.profile }),
  });

  try {
    // 1. Read the region's bootstrap marker — the source of truth for the
    //    asset bucket / repo names (never recompute the naming convention;
    //    custom-name compatibility, issue #1011). No marker → the region is not
    //    opted in to cdkd ASSET storage, which since issue #2052 no longer ends
    //    the run: the state-bucket placeholder sweep below is independent of it.
    //    CDK bootstrap storage is deliberately out of scope — `cdk gc` owns it.
    //
    //    A marker that EXISTS but fails to PARSE still hard-errors, so it also
    //    blocks the sweep — asymmetric with a MISSING one, and deliberately so:
    //    a corrupt marker means gc cannot trust what it knows about this region,
    //    and the remedy the parse error prints is one command.
    const markerKey = getBootstrapMarkerKey(region);
    const rawMarkerKey = getBootstrapMarkerKey(rawRegion);
    let markerBody: string | null;
    // Which key the body actually came from — `parseBootstrapMarker` names it
    // in its error messages, so a malformed marker must point at the file that
    // really was read.
    let resolvedMarkerKey = markerKey;
    try {
      // Issue #2021 folded the canonical-then-raw probe (issue #1995) into
      // `readBootstrapMarkerBody`. THIS caller's policy is unchanged: the
      // helper does not catch, so `NoSuchBucket` is still translated into the
      // never-bootstrapped message below and every other failure still
      // hard-errors out of the command with nothing collected.
      const read = await readBootstrapMarkerBody(stateBackend, rawRegion);
      markerBody = read.body;
      resolvedMarkerKey = read.resolvedKey;
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchBucket') {
        logger.info(
          `State bucket '${bucketName}' does not exist — this account was never ` +
            `bootstrapped; nothing to garbage-collect.`
        );
        return;
      }
      throw error;
    }
    // NOTE a marker that EXISTS at the canonical key but fails to parse still
    // hard-errors below, and now masks a valid marker at the raw key (pre-#1995
    // only the raw key was ever read for an upper-cased region). That is the
    // safe direction and deliberately not smoothed over: gc deletes nothing on
    // a throw, and silently falling through to another key after finding a
    // CORRUPT one would hide the corruption while gc acted on second-choice
    // names. The remedy is the one the parse error already prints.
    // 2. Lock guard: ANY stack lock in the bucket aborts — a deploy in
    //    flight may have published assets whose state write has not landed
    //    yet, and gc would see them as unreferenced. Simple and safe for v1.
    //
    //    Issue #2052 moved this AHEAD of the marker's "not opted in" return.
    //    The custom-resource-response sweep below reads the STATE bucket, which
    //    exists independently of whether this region opted in to cdkd ASSET
    //    storage, so returning first would make the sweep unreachable for an
    //    account that has placeholders and no asset marker. The guard now also
    //    covers that case, which is the safe direction: gc refuses rather than
    //    acting while a deploy is in flight.
    const lockKeys = await listAllLockKeys(stateBackend);
    if (lockKeys.length > 0) {
      const listing = lockKeys
        // Both halves are sanitised: `describeStateKey` renders the split, and
        // the raw KEY beside it is an S3 key with the same provenance — leaving
        // it bare would have made the first half inert, since the same planted
        // control characters reach the same terminal line either way
        // (go-to-k/cdkd#3179 C).
        .map(
          (k) =>
            `  - ${describeStateKey(k, LOCK_FILE_SUFFIX, DEFAULT_STATE_PREFIX)}  [${displayIdent(k, { maxCodePoints: STATE_KEY_MAX_CODE_POINTS })}]`
        )
        .join('\n');
      throw new CdkdError(
        `Refusing to gc while ${lockKeys.length} stack(s) hold an active lock ` +
          `(a deploy in flight may have published assets whose state write has not ` +
          `landed yet):\n${listing}\n` +
          `Wait for the operation(s) to finish — or clear a stale lock with ` +
          `'cdkd force-unlock <stack>' — then re-run 'cdkd gc'.`,
        'GC_LOCKED'
      );
    }

    // 3. Abandoned custom-resource response placeholders in the STATE bucket
    //    (issue #2052). Collected here, before the asset-marker gate, because
    //    they are not asset storage and their existence does not depend on it.
    const cutoffMs = Date.now() - options.olderThan;
    const responseCandidates = await listResponsePlaceholderCandidates(
      stateBackend,
      cutoffMs,
      logger
    );

    if (markerBody === null) {
      const probed = rawMarkerKey === markerKey ? markerKey : `${markerKey}, ${rawMarkerKey}`;
      if (responseCandidates.length === 0) {
        logger.info(
          `No bootstrap marker for region '${region}' (${probed}) — the region is not ` +
            `opted in to cdkd asset storage; nothing to garbage-collect. ` +
            `(CDK bootstrap storage is 'cdk gc' territory.)`
        );
        return;
      }
      // There ARE placeholders to collect even though this region has no asset
      // storage. Say both things: a bare "nothing to garbage-collect" would be
      // false, and a bare reclaim plan would hide why no assets are listed.
      logger.info(
        `No bootstrap marker for region '${region}' (${probed}) — the region is not ` +
          `opted in to cdkd asset storage, so no assets are in scope. ` +
          `(CDK bootstrap storage is 'cdk gc' territory.) Continuing with the ` +
          `state bucket's abandoned custom-resource response placeholders.`
      );
    }
    const marker = markerBody === null ? null : parseBootstrapMarker(markerBody, resolvedMarkerKey);

    // 4. Reference collection + asset candidates, age-guarded by --older-than.
    //    Skipped entirely with no marker: there is no asset bucket to scan, and
    //    `scanReferencedAssets` needs the marker to know what a reference to one
    //    even looks like.
    let s3Candidates: S3Candidate[] = [];
    let ecrCandidates: EcrCandidate[] = [];
    if (marker !== null) {
      const refs = await scanReferencedAssets(stateBackend, marker, logger, {
        profile: options.profile,
        stateBucket: bucketName,
      });
      s3Candidates = await listS3Candidates(
        awsClients.s3,
        marker.assetBucket,
        accountId,
        refs,
        cutoffMs,
        logger
      );
      ecrCandidates = await listEcrCandidates(
        ecrClient,
        marker.containerRepo,
        refs,
        cutoffMs,
        logger
      );
    }

    // 5. Nothing to do → info + exit 0, no prompt.
    // `marker !== null` is not a redundant guard: reaching here with a null
    // marker means the placeholder sweep found something (the marker-null arm
    // above returns otherwise), so this branch is unreachable in that case and
    // the message below could not be written truthfully anyway.
    if (
      marker !== null &&
      s3Candidates.length === 0 &&
      ecrCandidates.length === 0 &&
      responseCandidates.length === 0
    ) {
      logger.info(
        `Nothing to garbage-collect in region '${region}': every object in ` +
          `${marker.assetBucket} / image in ${marker.containerRepo} is either ` +
          `referenced by a deployed stack or newer than the --older-than cutoff, ` +
          `and no abandoned custom-resource response placeholder is older than it either.`
      );
      return;
    }

    // 6. Reclaim plan + totals.
    const s3Bytes = s3Candidates.reduce((sum, c) => sum + c.size, 0);
    const ecrBytes = ecrCandidates.reduce((sum, c) => sum + c.size, 0);
    const responseBytes = responseCandidates.reduce((sum, c) => sum + c.size, 0);
    // Named from the marker when there is one. The asset arms are empty without
    // it, so these are only ever interpolated under a marker — spelled as a
    // narrowing rather than a `?? ''` fallback, which would quietly print
    // `s3:///key` if the invariant ever broke.
    const assetBucket = marker !== null ? marker.assetBucket : '';
    const containerRepo = marker !== null ? marker.containerRepo : '';
    const planLines: string[] = [
      ...s3Candidates.map(
        (c) => `s3://${assetBucket}/${c.key} (${formatBytes(c.size)}, ${formatAge(c.lastModified)})`
      ),
      ...ecrCandidates.map(
        (c) =>
          `${containerRepo}${c.tags.length > 0 ? `:${c.tags.join(',')}` : ''}` +
          `@${c.digest} (${formatBytes(c.size)}, ${formatAge(c.pushedAt)})`
      ),
      ...responseCandidates.map(
        (c) =>
          `s3://${bucketName}/${c.key} (${formatBytes(c.size)}, ${formatAge(c.lastModified)}) ` +
          `[abandoned custom-resource response]`
      ),
    ];
    const totals =
      `Total: ${s3Candidates.length} S3 object(s) (${formatBytes(s3Bytes)}) + ` +
      `${ecrCandidates.length} ECR image(s) (${formatBytes(ecrBytes)}) + ` +
      `${responseCandidates.length} custom-resource response placeholder(s) ` +
      `(${formatBytes(responseBytes)}) = ` +
      `${formatBytes(s3Bytes + ecrBytes + responseBytes)} reclaimable`;

    if (options.dryRun) {
      logger.info('');
      logger.info(`Dry run — the following would be deleted in ${region}:`);
      for (const line of planLines) {
        logger.info(`  - ${line}`);
      }
      logger.info(totals);
      logger.info('Dry run: nothing deleted. Re-run without --dry-run to delete.');
      return;
    }

    // 7. Confirmation (default: interactive y/N; `--yes` skips; non-TTY
    //    without `--yes` hard-errors inside the prompt helper).
    const confirmed = await promptGcConfirm({
      planLines: [...planLines, totals],
      yes: options.yes,
      region,
    });
    if (!confirmed) {
      logger.info('gc cancelled — nothing deleted.');
      return;
    }

    // 8. Delete. Both asset arms are gated on a non-empty candidate list, which
    //    is only reachable with a marker (they stay empty without one), so the
    //    marker narrowing here restates a fact rather than adding a condition.
    if (marker !== null && s3Candidates.length > 0) {
      await deleteS3Candidates(awsClients.s3, marker.assetBucket, accountId, s3Candidates);
      logger.info(
        `✓ Deleted ${s3Candidates.length} object(s) (${formatBytes(s3Bytes)}) from ` +
          `${marker.assetBucket}`
      );
    }
    if (marker !== null && ecrCandidates.length > 0) {
      await deleteEcrCandidates(ecrClient, marker.containerRepo, ecrCandidates);
      logger.info(
        `✓ Deleted ${ecrCandidates.length} image(s) (${formatBytes(ecrBytes)}) from ` +
          `${marker.containerRepo}`
      );
    }
    if (responseCandidates.length > 0) {
      // Issue #2052. Deleted through the state backend, not `awsClients.s3`:
      // the placeholders live in the STATE bucket, which is account-scoped and
      // may sit in a different region than `--region`. The backend re-resolves
      // that region itself; the asset client does not.
      // Wrapped so a placeholder delete failure carries the same
      // `GC_DELETE_FAILED` identity as both asset arms — `deleteRawObjects`
      // raises a bare `StateError`, and one failure mode with two error
      // identities is one a caller has to special-case.
      //
      // The wrapper carries NO count. It only ever knew the ATTEMPTED one,
      // while the message it wraps reports the ACTUAL failures, so an earlier
      // spelling read `Failed to delete 5000 ... placeholder(s) ...: Failed to
      // delete 1 object(s) ...` — a partial failure describing itself as total.
      // Both asset arms report the FAILURE count; this one defers to the inner
      // message for it rather than contradicting it.
      // Issue #2340: the state bucket is VERSIONED (bootstrap enables it), so
      // the DeleteObjects below only writes delete markers and every body
      // stays readable by VersionId. A response object's body is the handler's
      // full cfn-response, `Data` included, so collecting the abandoned ones
      // without the purge leaves exactly what the sweep exists to remove.
      //
      // The purge runs in a `finally`, and that placement is deliberate.
      // `deleteRawObjects` throws on ANY per-key failure, so a PARTIAL delete
      // — 4999 keys gone, one `AccessDenied` — used to skip the purge
      // entirely and leave 4999 readable bodies behind with no version
      // warning at all.
      //
      // A `finally` that can REJECT would replace the exception in flight, so
      // a failing purge would discard the `GC_DELETE_FAILED` identity of a
      // failing delete and surface itself instead. `purgeNoncurrentVersions`
      // already catches everything, but relying on that makes a REMOTE
      // wrapper load-bearing for THIS site's error identity — an invariant
      // nothing here states and a future edit there could silently break. The
      // `.catch()` keeps it local: whatever the backend does, the error the
      // caller sees is the delete's. It is not a substitute for the backend's
      // own handling, which is what produces the operator-facing warning.
      //
      // It purges the WHOLE candidate list rather than only the keys that were
      // deleted, because `deleteRawObjects` does not report which succeeded.
      // That is safe: the `IsLatest` filter inside the purge leaves the
      // current version of a key whose delete failed completely intact, so the
      // worst case is that its history goes while the object itself stays.
      //
      // `listPrefix` makes it ONE PAGINATED WALK of the shared prefix instead
      // of one walk per candidate. That is a trade, not a strict win: on a
      // busy account the shared prefix holds other stacks' in-flight objects
      // too, so the walk can cost more requests than a handful of per-key
      // lookups would. It pays off for the thousands-of-keys case this sweep
      // is built for. Either way membership of the candidate key set, not the
      // prefix, is what bounds the delete.
      try {
        await stateBackend.deleteRawObjects(responseCandidates.map((c) => c.key));
      } catch (deleteError) {
        throw new CdkdError(
          `Failed to delete abandoned custom-resource response placeholder(s) ` +
            `from ${bucketName}: ` +
            `${describeAwsFailure(deleteError).detail}`,
          'GC_DELETE_FAILED'
        );
      } finally {
        await stateBackend
          .purgeNoncurrentVersions(
            responseCandidates.map((c) => c.key),
            {
              listPrefix: `${CUSTOM_RESOURCE_RESPONSE_PREFIX}/`,
              // The SHARED constant the provider's own cleanup uses: the two
              // paths delete the SAME object, so a reader must not be able to
              // tell which one warned (#2346). One binding cannot drift.
              objectDescription: CUSTOM_RESOURCE_RESPONSE_OBJECT_DESCRIPTION,
            }
          )
          // See above: a rejecting `finally` would mask GC_DELETE_FAILED.
          // It LOGS rather than swallowing. Today the backend method catches
          // and warns with no rethrow, so nothing reaches here — but the guard
          // exists precisely for the case where that regresses, and a silent
          // guard would then drop a security-relevant failure with no trace,
          // which is the trade this same change rejected for the truncated
          // -listing branch three lines of reasoning away.
          .catch((purgeError) =>
            logger.warn(
              `Could not purge noncurrent versions of the collected custom-resource ` +
                `response placeholder(s) in ${bucketName}; their previous versions survive ` +
                `and remain readable via GetObject with a VersionId. Underlying error: ` +
                `${describeAwsFailure(purgeError).detail}`
            )
          );
      }
      logger.info(
        `✓ Deleted ${responseCandidates.length} abandoned custom-resource response ` +
          `placeholder(s) (${formatBytes(responseBytes)}) from ${bucketName}`
      );
    }
    logger.info(`\n✓ gc completed: ${formatBytes(s3Bytes + ecrBytes + responseBytes)} reclaimed`);
  } finally {
    ecrClient.destroy();
    // If the backend rebuilt its client for the state bucket's region it
    // already destroyed this one; a second destroy is a safe no-op.
    markerS3Client.destroy();
    awsClients.destroy();
  }
}
