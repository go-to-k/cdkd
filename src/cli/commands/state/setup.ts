import { plainOrDescribed } from '../../../utils/pasteable-command.js';
import { Option } from 'commander';
import { warnIfDeprecatedRegion, parseStackRegion } from '../../options.js';
import { getLogger } from '../../../utils/logger.js';
import { S3StateBackend, type StackStateRef } from '../../../state/s3-state-backend.js';
import { LockManager } from '../../../state/lock-manager.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { formatLockOperation, formatLockOwner } from '../../../state/lock-contention-message.js';
import { type LockRecoveryContext } from '../../../state/lock-contention-message.js';
import { ExportIndexStore } from '../../../state/export-index-store.js';
import { setAwsClients, AwsClients } from '../../../utils/aws-clients.js';
import { applyRoleArnIfSet } from '../../../utils/role-arn.js';
import {
  exportInferredRegionForSdk,
  foldRegionOption,
  legacyStateBucketFallbackRegion,
  reconcileExportIndexRegion,
  resolveEffectiveRegion,
  stackRegionResolver,
  withOtherIndexRemoval,
} from '../../region-options.js';
import { resolveStateBucketWithDefault } from '../../config-loader.js';
import { describedStackRef } from './refs.js';

/** What {@link setupStateBackend} hands back. */
export type StateSetup = Awaited<ReturnType<typeof setupStateBackend>>;

/**
 * Shared bootstrap for every `state` subcommand: build the AWS clients,
 * resolve the bucket name, verify the bucket exists, and hand back the
 * S3 state backend / lock manager.
 *
 * `verifyBucketExists` runs early so users without a bootstrapped bucket
 * get a helpful "run cdkd bootstrap" message instead of a generic
 * NoSuchBucket from a downstream list/get call.
 *
 * The returned `dispose` function MUST be called in a `finally` block.
 */
export async function setupStateBackend(options: {
  stateBucket?: string;
  statePrefix: string;
  region?: string;
  profile?: string;
  roleArn?: string;
}): Promise<{
  stateBackend: S3StateBackend;
  lockManager: LockManager;
  awsClients: AwsClients;
  region: string;
  /**
   * The state-key region for a stack whose region nothing else pins (a
   * region-less legacy record): `region`, held on state the old `us-east-1`
   * default wrote when `region` was inferred (go-to-k/cdkd#2100).
   */
  regionFor: (stackName: string) => Promise<string>;
  bucket: string;
  prefix: string;
  exportIndexStore: ExportIndexStore;
  dispose: () => void;
}> {
  // PR 5: --region is deprecated on every state subcommand. Warn here so
  // the four subcommands inherit the warning via this shared bootstrap.
  warnIfDeprecatedRegion(options);

  // Resolve --role-arn / CDKD_ROLE_ARN before any AWS call.
  // Issue #2065 - fold `--region` ONCE, at the boundary, so no raw spelling
  // reaches an SDK client, an ARN segment or a state key. Rationale (and why
  // this is per-command rather than per-consumer) in `src/cli/region-options.ts`.
  foldRegionOption(options);
  await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });

  // go-to-k/cdkd#2100: the profile's region when none is named, not a
  // `us-east-1` literal (`resolveEffectiveRegion`).
  const effectiveRegion = await resolveEffectiveRegion(options);
  exportInferredRegionForSdk(effectiveRegion);
  // go-to-k/cdkd#2100: the resolved region, explicitly. A region-less bag
  // follows the SDK's chain, which never reads AWS_DEFAULT_REGION, so it would
  // disagree with a region inferred from it.
  const awsClients = new AwsClients({
    region: effectiveRegion.region,
    ...(options.profile && { profile: options.profile }),
  });
  setAwsClients(awsClients);

  const region = effectiveRegion.region;
  const bucket = await resolveStateBucketWithDefault(
    options.stateBucket,
    region,
    legacyStateBucketFallbackRegion(effectiveRegion)
  );
  const prefix = options.statePrefix;
  const stateConfig = { bucket, prefix };
  // Pass region/profile so the backend can rebuild its S3 client if the
  // bucket lives in a region different from the CLI's profile region.
  const stateBackend = new S3StateBackend(awsClients.s3, stateConfig, {
    region,
    ...(options.profile && { profile: options.profile }),
  });
  const lockManager = new LockManager(awsClients.s3, stateConfig);

  // verifyBucketExists() triggers ensureClientForBucket() which resolves the
  // bucket region via GetBucketLocation. Every state subcommand that follows
  // sees a fully-ready backend.
  await stateBackend.verifyBucketExists();

  const runIndexRegion = await reconcileExportIndexRegion({
    effective: effectiveRegion,
    probe: stateBackend,
    statePrefix: prefix,
    logger: getLogger(),
  });
  const newIndexStore = (indexRegion: string): ExportIndexStore =>
    new ExportIndexStore(
      awsClients.s3,
      stateConfig.bucket,
      stateConfig.prefix,
      indexRegion,
      stateBackend,
      { profile: options.profile }
    );
  // go-to-k/cdkd#2100: a destroyed stack's entries — a nested child's too, and
  // under `cdkd rollback` as well — also leave the OTHER candidate index file.
  const exportIndexStore = withOtherIndexRemoval(newIndexStore(runIndexRegion), {
    effective: effectiveRegion,
    runIndexRegion,
    statePrefix: prefix,
    probe: stateBackend,
    createStore: newIndexStore,
    logger: getLogger(),
  });

  return {
    stateBackend,
    lockManager,
    awsClients,
    region,
    regionFor: stackRegionResolver({
      effective: effectiveRegion,
      probe: stateBackend,
      logger: getLogger(),
    }),
    bucket,
    prefix,
    exportIndexStore,
    // The backend may have REPLACED its client with a bucket-region one, which
    // `awsClients.destroy()` does not reach (go-to-k/cdkd#4705 review R4-2).
    dispose: () => {
      awsClients.destroy();
      stateBackend.destroyClient();
    },
  };
}

/**
 * The account flags a read-only render's malformed-record warnings print on
 * their `cdkd state show` pointer: the run's `--profile` and the bucket and
 * prefix {@link setupStateBackend} resolved, so a pasted command reads the
 * record this run read (go-to-k/cdkd#4159).
 */
export function renderRecovery(
  options: { profile?: string | undefined },
  setup: { bucket: string; prefix: string }
): LockRecoveryContext {
  return { profile: options.profile, stateBucket: setup.bucket, statePrefix: setup.prefix };
}

/**
 * Stable sort for `StackStateRef[]` — alphabetical by stackName (ASCII order,
 * matches the legacy `state list` sort), then by region with `null`/legacy
 * entries last.
 */
export function sortRefs(refs: StackStateRef[]): StackStateRef[] {
  return refs.slice().sort((a, b) => {
    if (a.stackName < b.stackName) return -1;
    if (a.stackName > b.stackName) return 1;
    const ar = a.region ?? '￿';
    const br = b.region ?? '￿';
    if (ar < br) return -1;
    if (ar > br) return 1;
    return 0;
  });
}

/**
 * Reusable `--region <region>` option for state subcommands. Aliased at the
 * commander level via `stackRegion` so it doesn't collide with the global
 * `--region` (AWS profile region) defined in `commonOptions`.
 */
export function stackRegionOption(): Option {
  return new Option(
    '--stack-region <region>',
    'Region of the stack record to operate on. Required when the same stack name has state in multiple regions.'
  ).argParser(parseStackRegion);
}

/**
 * Warn before `cdkd state orphan` force-releases a lock that is still LIVE.
 *
 * `forceReleaseLock` is unconditional by design — a stuck lock must never make
 * a state record unremovable — but it deletes an in-flight `cdkd deploy`'s lock
 * just as readily as a stale one, and it did so silently (issue #2171). The
 * write it enables has already happened by the time anyone notices, so the
 * only useful thing is to name the owner at the moment of the release.
 *
 * Best-effort in both directions: an expired lock is not worth a line, and a
 * failed read must not block the removal the user asked for.
 *
 * (Issue #2171's own text called this command `cdkd state rm`; no such command
 * exists -- this file registers it as `orphan`.)
 */
export async function warnOnLiveForeignLock(
  lockManager: LockManager,
  stackName: string,
  region: string | undefined,
  logger: ReturnType<typeof getLogger>
): Promise<void> {
  try {
    const info = await lockManager.getLockInfo(stackName, region);
    // An UNREADABLE expiry WARNS rather than staying quiet: a missed warning
    // destroys a live lock silently, while a spurious one costs a line.
    // `NaN <= now` is false, so a truncated lock.json already reached here —
    // this makes that deliberate rather than accidental.
    if (!info) return;
    const expiryKnown = Number.isFinite(info.expiresAt);
    if (expiryKnown && info.expiresAt <= Date.now()) return;
    // `describedStackRef`, not `formatStackRefSafe`: this line prints cdkd's
    // own ` (region)` annotation beside two S3 key segments (go-to-k/cdkd#3179)
    // inside `state orphan`'s run, beside its `Destroy with:` rows, where a
    // padded value in quotes still wraps into a counterfeit row
    // (go-to-k/cdkd#3760).
    const where = region
      ? describedStackRef({ stackName, region })
      : `${plainOrDescribed(stackName, 'stack name')} (legacy lock key)`;
    // `owner` / `operation` go through the shared lock formatters, like every
    // lock render (go-to-k/cdkd#4115). Here that also matters because the
    // line prints beside `state orphan`'s labelled `Destroy with:` row, where a
    // padded owner would wrap into a counterfeit one (go-to-k/cdkd#3760).
    const owner = info.owner ? formatLockOwner(info.owner) : '';
    const operation = info.operation ? `, operation: ${formatLockOperation(info.operation)}` : '';
    logger.warn(
      safeMsg`Force-releasing a LIVE lock on ${where} ` +
        // Agrees with `lock-contention-message.ts`: an unusable owner withholds
        // the "still running" CERTIFICATION but not the expiry, when the lock
        // file carries a readable one.
        safeMsg`${owner ? `held by ${owner}${operation}` : 'held by an unnamed holder'}. ` +
        (owner && expiryKnown
          ? `That process is still running and will keep writing; its next state write `
          : expiryKnown
            ? `The lock has not expired, so a process may still be writing; its next state write `
            : `The lock records no readable expiry, so a process may still be writing; its next state write `) +
        `may recreate the record being removed here.`
    );
  } catch {
    // Best-effort: never block `state orphan` on a lock read.
  }
}
