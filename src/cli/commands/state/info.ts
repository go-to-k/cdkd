import { Command } from 'commander';
import {
  GetBucketLocationCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
import { commonOptions, stateOptions } from '../../options.js';
import { getLogger, reserveStdoutForPayload } from '../../../utils/logger.js';
import { cdkdRemedy } from '../../../utils/pasteable-command.js';
import { withErrorHandling } from '../../../utils/error-handler.js';
import { S3StateBackend } from '../../../state/s3-state-backend.js';
import {
  displayIdent,
  safeMsg,
  stringifyJsonPayload,
  STACK_REF_MAX_CODE_POINTS,
} from '../../../utils/display-safe.js';
import { LISTING_ENCODING_TYPE, decodeListingKey } from '../../../utils/s3-listing-keys.js';
import { setAwsClients, AwsClients } from '../../../utils/aws-clients.js';
import { applyRoleArnIfSet } from '../../../utils/role-arn.js';
import {
  exportInferredRegionForSdk,
  foldRegionOption,
  legacyStateBucketFallbackRegion,
  resolveEffectiveRegion,
} from '../../region-options.js';
import {
  resolveStateBucketWithDefaultAndSource,
  type StateBucketSource,
} from '../../config-loader.js';
import { BOOTSTRAP_MARKER_PREFIX, parseBootstrapMarker } from '../../../assets/asset-storage.js';
import type { StackState } from '../../../types/state.js';
import { expectedOwnerParam } from '../../../utils/expected-bucket-owner.js';
import { rebuildClientForBucketRegion } from '../../../utils/bucket-region-client.js';

/**
 * Human-readable label for a {@link StateBucketSource}.
 *
 * Mirrors the `Source` column documented in `docs/plans/07-state-bucket-display.md`.
 */
function formatBucketSource(source: StateBucketSource): string {
  switch (source) {
    case 'cli-flag':
      return '--state-bucket flag';
    case 'env':
      return 'CDKD_STATE_BUCKET env';
    case 'cdk.json':
      return 'cdk.json (context.cdkd.stateBucket)';
    case 'default':
      return 'default (account ID from STS)';
    case 'default-legacy':
      return 'default (legacy region-suffixed name; cdkd state migrate recommended)';
  }
}

/**
 * Detect the bucket's actual region via S3 `GetBucketLocation`.
 *
 * Returns `undefined` when the call fails — the command should still succeed
 * and just report `unknown` rather than crash on a permission issue or a
 * not-yet-bootstrapped bucket. (Bucket existence is verified separately
 * via {@link setupStateBackend}, so getting here implies the bucket is
 * reachable; `GetBucketLocation` failing is most often a permissions gap.)
 *
 * Takes the (region-corrected) S3 client directly — see the issue #1054 note
 * in {@link stateInfoCommand}. Before that fix this call was made with the
 * ambient-region client, so a cross-region state bucket silently degraded to
 * `undefined` ("Region: unknown") here; with the corrected client it now
 * succeeds and reports the bucket's actual region.
 */
async function detectBucketRegion(s3: S3Client, bucket: string): Promise<string | undefined> {
  try {
    const resp = await s3.send(
      new GetBucketLocationCommand({
        Bucket: bucket,
        ...(await expectedOwnerParam(s3)),
      })
    );
    // S3 returns `null`/empty for us-east-1 (historical quirk).
    const constraint: string | undefined = resp.LocationConstraint;
    if (!constraint) return 'us-east-1';
    // EU is the legacy alias for eu-west-1.
    if (constraint === 'EU') return 'eu-west-1';
    return constraint;
  } catch {
    return undefined;
  }
}

/**
 * Walk the state-bucket prefix and collect every state.json key, regardless of
 * which layout produced it.
 *
 * Two layouts are supported here so the command keeps working both before and
 * after PR 1 (region segment) lands:
 * - Legacy: `<prefix>/<stackName>/state.json`
 * - New:    `<prefix>/<stackName>/<region>/state.json`
 *
 * Returns the full set of state-file keys; the count is the unique-stacks
 * tally we want for the `Stacks:` line.
 */
async function listStateFileKeys(s3: S3Client, bucket: string, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  const searchPrefix = `${prefix}/`;
  do {
    const resp = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: searchPrefix,
        // go-to-k/cdkd#3313: without this the XML round-trip turns a CARRIAGE
        // RETURN in a key into a LINE FEED, and the key collected here is the
        // one every later `getState` / `GetObject` addresses.
        EncodingType: LISTING_ENCODING_TYPE,
        ...(continuationToken && { ContinuationToken: continuationToken }),
      })
    );
    for (const obj of resp.Contents ?? []) {
      const key = decodeListingKey(obj.Key);
      if (typeof key === 'string' && key.endsWith('/state.json')) {
        keys.push(key);
      }
    }
    continuationToken = resp.NextContinuationToken;
  } while (continuationToken);
  return keys;
}

/**
 * Read one of the discovered state.json keys and pluck its schema version.
 * Returns `'unknown'` when no state files exist or parsing fails — we don't
 * want a cosmetic command to crash on an unexpected payload.
 */
async function readSchemaVersion(
  s3: S3Client,
  bucket: string,
  keys: string[]
): Promise<number | 'unknown'> {
  if (keys.length === 0) return 'unknown';
  try {
    const resp = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: keys[0]!,
        ...(await expectedOwnerParam(s3)),
      })
    );
    if (!resp.Body) return 'unknown';
    const body = await resp.Body.transformToString();
    const parsed = JSON.parse(body) as Partial<StackState>;
    return typeof parsed.version === 'number' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * One region's cdkd asset storage entry as surfaced by `state info` —
 * derived from the bootstrap marker at `cdkd-bootstrap/{region}.json`
 * (issue #1002).
 */
interface AssetStorageInfo {
  region: string;
  assetBucket: string;
  containerRepo: string;
  createdAt: string;
}

/**
 * List every region's bootstrap marker under `cdkd-bootstrap/` in the state
 * bucket. A malformed marker PAYLOAD is skipped with a warning — `state info`
 * is a cosmetic command and should not crash on an unexpected body (deploy
 * hard-errors on the same marker instead).
 *
 * A malformed KEY is the one exception, and the distinction is deliberate
 * (go-to-k/cdkd#3313): `decodeListingKey` throws on a value that is not valid
 * URL encoding, and that call sits outside the per-marker `try`, so it aborts
 * the command rather than skipping the entry. A key cdkd cannot decode is one
 * it cannot address, and continuing would mean reporting on a marker while
 * unable to say which object it came from. Unreachable against S3, whose own
 * encoding is well-formed by construction; it is a refusal for the case where
 * that assumption stops holding.
 */
async function listAssetStorageMarkers(s3: S3Client, bucket: string): Promise<AssetStorageInfo[]> {
  const logger = getLogger();
  const entries: AssetStorageInfo[] = [];
  let continuationToken: string | undefined;
  const keys: string[] = [];
  do {
    const resp = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: BOOTSTRAP_MARKER_PREFIX,
        // go-to-k/cdkd#3313. This key is both SLICED into a region name and
        // handed back to `GetObject` below, so a raw one names the wrong region
        // and reads the wrong object.
        EncodingType: LISTING_ENCODING_TYPE,
        ...(continuationToken && { ContinuationToken: continuationToken }),
      })
    );
    for (const obj of resp.Contents ?? []) {
      // Decoded BEFORE the prefix re-check, or the guard tests a different
      // string from the one that gets used.
      const markerKey = decodeListingKey(obj.Key);
      // Defensive startsWith re-check on top of the ListObjectsV2 Prefix —
      // a key outside the marker prefix must never be parsed as a marker.
      if (
        typeof markerKey === 'string' &&
        markerKey.startsWith(BOOTSTRAP_MARKER_PREFIX) &&
        markerKey.endsWith('.json')
      ) {
        keys.push(markerKey);
      }
    }
    continuationToken = resp.NextContinuationToken;
  } while (continuationToken);

  for (const key of keys) {
    const region = key.slice(BOOTSTRAP_MARKER_PREFIX.length, -'.json'.length);
    try {
      const resp = await s3.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ...(await expectedOwnerParam(s3)),
        })
      );
      const body = (await resp.Body?.transformToString()) ?? '';
      const marker = parseBootstrapMarker(body, key);
      entries.push({
        region,
        assetBucket: marker.assetBucket,
        containerRepo: marker.containerRepo,
        createdAt: marker.createdAt,
      });
    } catch (error) {
      // The key through `displayIdent`'s boundary rather than inside cdkd's own
      // `'...'`: it is an S3 key anyone with `s3:PutObject` on the bucket
      // chooses (go-to-k/cdkd#3179, go-to-k/cdkd#3950). An S3 key is at most
      // 1024 bytes, under the stack-ref cap, so a legitimate one is never cut.
      logger.warn(
        safeMsg`Skipping malformed/unreadable bootstrap marker ` +
          safeMsg`${displayIdent(key, { maxCodePoints: STACK_REF_MAX_CODE_POINTS })}: ${(error as Error).message}`
      );
    }
  }
  return entries.sort((a, b) => a.region.localeCompare(b.region));
}

/**
 * Shape of `cdkd state info --json` output. Documented as a stable contract
 * in the plan; downstream tooling may parse it.
 */
interface StateInfoJson {
  bucket: string;
  region: string | null;
  regionSource: 'flag' | 'auto-detected' | 'unknown';
  bucketSource: StateBucketSource;
  schemaVersion: number | 'unknown';
  stackCount: number;
  /**
   * Regions opted into cdkd-owned asset storage via `cdkd bootstrap`
   * (issue #1002). Empty array = every region publishes assets to the CDK
   * bootstrap destinations (legacy mode).
   */
  assetStorage: AssetStorageInfo[];
}

/**
 * `cdkd state info` command implementation.
 *
 * Prints the state-bucket information that used to appear as a banner on
 * every command. Removed from default output (PR 7) because the bucket name
 * leaks the AWS account id into screenshots and CI logs; surface it
 * explicitly here when the user actually wants to know.
 *
 * Output shows: bucket name, region (auto-detected via `GetBucketLocation`),
 * the source that resolved the bucket (cli flag / env / cdk.json / default),
 * the state schema version (read from the first state file, or `unknown`
 * when the bucket is empty), and the total stack count (counts state files
 * at both `<prefix>/<stackName>/state.json` and
 * `<prefix>/<stackName>/<region>/state.json` so the result is correct
 * before and after PR 1's region-aware layout lands).
 *
 * `--json` emits the {@link StateInfoJson} shape for tooling.
 */
async function stateInfoCommand(options: {
  json: boolean;
  stateBucket?: string;
  statePrefix: string;
  region?: string;
  profile?: string;
  roleArn?: string;
  verbose: boolean;
}): Promise<void> {
  const logger = getLogger();
  if (options.verbose) logger.setLevel('debug');

  // Issue #2280: claim stdout for the payload BEFORE anything can print on
  // it — ahead of `applyRoleArnIfSet` (its `Assumed role ...` INFO line
  // lives in `src/utils/role-arn.ts`) and of every state-bucket read below.
  if (options.json) {
    reserveStdoutForPayload();
  }

  // Resolve --role-arn / CDKD_ROLE_ARN before any AWS call.
  // Issue #2065 - fold `--region` ONCE, at the boundary, so no raw spelling
  // reaches an SDK client, an ARN segment or a state key. Rationale (and why
  // this is per-command rather than per-consumer) in `src/cli/region-options.ts`.
  foldRegionOption(options);
  await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });

  const awsClients = new AwsClients({
    ...(options.region && { region: options.region }),
    ...(options.profile && { profile: options.profile }),
  });
  setAwsClients(awsClients);

  // Set only when the state bucket lives in a different region than the
  // ambient client — destroyed in the outer `finally` (the original shared
  // `awsClients.s3` is never destroyed here; `awsClients.destroy()` owns it).
  let regionCorrectedS3: S3Client | null = null;

  try {
    // go-to-k/cdkd#2100: the profile's region when none is named, not a
    // `us-east-1` literal (`resolveEffectiveRegion`).
    const effectiveRegion = await resolveEffectiveRegion(options);
    exportInferredRegionForSdk(effectiveRegion);
    const region = effectiveRegion.region;
    const resolved = await resolveStateBucketWithDefaultAndSource(
      options.stateBucket,
      region,
      legacyStateBucketFallbackRegion(effectiveRegion)
    );
    const bucket = resolved.bucket;
    const prefix = options.statePrefix;

    const stateBackend = new S3StateBackend(awsClients.s3, { bucket, prefix });
    await stateBackend.verifyBucketExists();

    // Region-correct the S3 client before the raw bucket reads below (issue
    // #1054): the four helpers issue ListObjectsV2 / GetObject /
    // GetBucketLocation directly, and the ambient-region `awsClients.s3`
    // 301s with PermanentRedirect when the state bucket lives in another
    // region. Every other state-bucket consumer already rebuilds via
    // `rebuildClientForBucketRegion` (S3StateBackend / LockManager /
    // ExportIndexStore, issue #827) — this mirrors ExportIndexStore's option
    // choices: reuse the shared client's resolved credentials, do NOT
    // destroy the original (shared `AwsClients.s3`), and gracefully degrade
    // when the client is a non-standard test double. The helper returns
    // `null` when no rebuild is needed (bucket already in the client's
    // region), so the original client is kept in that case.
    regionCorrectedS3 = await rebuildClientForBucketRegion(awsClients.s3, bucket, {
      reuseClientCredentials: true,
      tolerateNonStandardClient: true,
      onRebuild: ({ bucketRegion, currentRegion }) => {
        logger.debug(
          safeMsg`State bucket '${bucket}' is in '${bucketRegion}' (state-info client was '${String(currentRegion)}'); building a region-corrected S3 client for info reads.`
        );
      },
    });
    const infoS3 = regionCorrectedS3 ?? awsClients.s3;

    const detectedRegion = await detectBucketRegion(infoS3, bucket);
    const stateFileKeys = await listStateFileKeys(infoS3, bucket, prefix);
    const schemaVersion = await readSchemaVersion(infoS3, bucket, stateFileKeys);
    const assetStorage = await listAssetStorageMarkers(infoS3, bucket);

    if (options.json) {
      const json: StateInfoJson = {
        bucket,
        region: detectedRegion ?? null,
        regionSource: detectedRegion ? 'auto-detected' : 'unknown',
        bucketSource: resolved.source,
        schemaVersion,
        stackCount: stateFileKeys.length,
        assetStorage,
      };
      process.stdout.write(`${stringifyJsonPayload(json)}\n`);
      return;
    }

    const lines: string[] = [];
    lines.push(`State bucket:    ${bucket}`);
    if (detectedRegion) {
      lines.push(`Region:          ${detectedRegion} (auto-detected via GetBucketLocation)`);
    } else {
      lines.push('Region:          unknown (GetBucketLocation failed or denied)');
    }
    lines.push(`Source:          ${formatBucketSource(resolved.source)}`);
    lines.push(`Schema version:  ${schemaVersion}`);
    lines.push(`Stacks:          ${stateFileKeys.length}`);
    if (assetStorage.length === 0) {
      lines.push(
        `Asset storage:   legacy (CDK bootstrap) — run ${cdkdRemedy('cdkd bootstrap')} to opt in`
      );
    } else {
      lines.push(`Asset storage:   cdkd-assets mode in ${assetStorage.length} region(s)`);
      // The region is sliced out of a bootstrap-marker KEY and the two names
      // come from that marker's BODY, all three chosen by whoever can write the
      // state bucket, and this text goes to stdout raw -- so each takes
      // `displayIdent`'s boundary: no row forgery, no spoofed `: a / b`
      // annotation (go-to-k/cdkd#3179). A bucket or repository name is a plain
      // identifier, so a legitimate row is byte-identical; the repository takes
      // the stack-ref cap because an ECR name runs to 256 characters.
      for (const entry of assetStorage) {
        lines.push(
          `  ${displayIdent(entry.region)}: ${displayIdent(entry.assetBucket)} / ${displayIdent(entry.containerRepo, { maxCodePoints: STACK_REF_MAX_CODE_POINTS })}`
        );
      }
    }
    process.stdout.write(`${lines.join('\n')}\n`);
  } finally {
    // Destroy only the region-corrected replacement (if any) — the original
    // `awsClients.s3` is shared and owned by `awsClients.destroy()`.
    regionCorrectedS3?.destroy();
    awsClients.destroy();
  }
}

/**
 * Create the `state info` subcommand.
 */
export function createStateInfoCommand(): Command {
  const cmd = new Command('info')
    .description(
      'Show cdkd state bucket info (bucket name, region, source, schema version, stack count)'
    )
    .option('--json', 'Output as JSON', false)
    .action(withErrorHandling(stateInfoCommand));

  [...commonOptions, ...stateOptions].forEach((opt) => cmd.addOption(opt));

  return cmd;
}
