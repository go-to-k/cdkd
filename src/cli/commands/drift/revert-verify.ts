/**
 * `cdkd drift --revert`: the post-revert verification (go-to-k/cdkd#7025 step 6).
 *
 * A revert counts a resource `reverted` once `provider.update` returns. A
 * service can accept the call without applying a value it was sent (#6777: a
 * Lambda event source mapping takes `DestinationConfig: {}` and keeps its
 * `OnFailure` destination), and the run then reports success while AWS still
 * differs. This pass re-runs the SAME detection `cdkd drift` runs on every
 * stack that had a reverted resource and fails each resource whose re-read
 * still differs on a path its revert sent.
 *
 * Read-only: the re-detection reads state and AWS and writes neither. It runs
 * on `drift --revert` alone, after the stack's lock is released.
 */
import type { ConsoleLogger } from '../../../utils/logger.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { type StackDriftReport, matchOutcome, type DriftOutcome } from './outcome.js';
import { displayDriftPath, reportPath } from './report.js';
import type { ResourceProvider } from '../../../types/resource.js';
import { calculateResourceDrift } from '../../../analyzer/drift-calculator.js';
import { canonicalizeIpProtocols } from '../../../analyzer/drift-protocol-normalize.js';
import { verbatimEchoDriftKeys } from '../../../analyzer/drift-verbatim-paths.js';

/** One resource a revert pass counted `reverted`, with the paths it sent. */
export interface RevertedResource {
  stackName: string;
  region: string;
  logicalId: string;
  resourceType: string;
  /** The drifted `changes[].path` values this resource's revert targeted. */
  paths: readonly string[];
  /**
   * Of the paths a re-read reports, the ones where AWS does not hold what the
   * revert SENT (see {@link sentDiffPaths}). Bound to the bag the update was
   * handed, which holds resolved secrets: it is compared, never printed.
   */
  differsFromSent: (live: Record<string, unknown>) => readonly string[];
}

/**
 * The paths under `paths`' top-level keys where `live` (a re-read) does not
 * hold what `sent` (the bag handed to `provider.update`) holds, through the
 * comparator drift uses: tag lists and id lists ordered, the provider's
 * unordered paths sorted, its unreadable paths skipped, IP protocol spellings
 * and its own canonicalizer applied to both sides.
 *
 * Why the SENT bag and not state (go-to-k/cdkd#7025): a revert on a
 * template-only baseline keeps the AWS-authored values the template never
 * declared (an untemplated tag beside the reverted ones), so state still
 * differs from AWS after a revert that AWS applied exactly as sent.
 */
export function sentDiffPaths(
  sent: Record<string, unknown>,
  live: Record<string, unknown>,
  paths: readonly string[],
  provider: Pick<
    ResourceProvider,
    'canonicalizeDriftProperties' | 'getDriftUnorderedPaths' | 'getDriftUnknownPaths'
  >,
  resourceType: string,
  recordedProperties: Record<string, unknown>
): string[] {
  const keys = new Set(paths.map((p) => p.split('.', 1)[0] ?? ''));
  const sentTargets: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(sent, key)) sentTargets[key] = sent[key];
  }
  const protocols = canonicalizeIpProtocols(sentTargets, live, resourceType);
  const canonical = provider.canonicalizeDriftProperties
    ? {
        baseline: provider.canonicalizeDriftProperties(resourceType, protocols.baseline),
        aws: provider.canonicalizeDriftProperties(resourceType, protocols.aws),
      }
    : protocols;
  return calculateResourceDrift(canonical.baseline, canonical.aws, {
    ignorePaths: provider.getDriftUnknownPaths?.(resourceType, recordedProperties) ?? [],
    unionWalkObjects: true,
    unorderedPaths: provider.getDriftUnorderedPaths?.(resourceType) ?? [],
    unionWalkPaths: verbatimEchoDriftKeys(resourceType),
    resourceType,
  })
    .map((change) => change.path)
    .filter((path) => paths.some((target) => overlaps(path, target)));
}

/** Re-runs drift detection for one stack; supplied by the command. */
export type RevertRedetect = (stackName: string, region: string) => Promise<StackDriftReport>;

/**
 * The waits before the second and third re-read. A read right after an update
 * can still return the old value on an eventually consistent API, so a path
 * that still differs is re-read twice more (~13 s in all) before it fails.
 */
export const REVERT_VERIFY_RETRY_DELAYS_MS: readonly number[] = [5_000, 8_000];

/** What {@link verifyRevertedStack} found for one stack. */
export interface RevertVerifyResult {
  /** Resources whose re-read still differs on a path their revert sent. */
  notApplied: number;
  /** Resources whose re-read could not be compared. */
  unverified: number;
}

/**
 * Is `path` the same position as `target`, or inside / around it? A revert
 * sends the subtree at each drifted path, so a re-read difference at, under or
 * above one of them is a difference the revert should have removed.
 */
function overlaps(path: string, target: string): boolean {
  return path === target || path.startsWith(`${target}.`) || target.startsWith(`${path}.`);
}

/** Why a re-read outcome cannot confirm the revert, or `undefined` when it can. */
function unverifiableReason(outcome: DriftOutcome | undefined): string | undefined {
  if (outcome === undefined) return 'the re-read did not report it';
  return matchOutcome<string | undefined>(outcome, {
    drifted: () => undefined,
    clean: () => undefined,
    notCompared: (o) => `the re-read could not compare it (${o.notComparedCause})`,
    unsupported: () => 'no provider could read it back',
    skipped: () => 'the re-read skipped it',
    deleted: () => 'AWS reports it deleted',
  });
}

/**
 * Re-detect `stackName` and check each of `reverted` against the re-read,
 * re-reading after each of `delays` while a targeted path still differs.
 * Logs one line per resource that is not converged (error) or could not be
 * checked (warning); a resource whose re-read is clean on its targeted paths
 * logs nothing, since the revert already printed it.
 */
export async function verifyRevertedStack(
  stackName: string,
  region: string,
  reverted: readonly RevertedResource[],
  redetect: RevertRedetect,
  logger: ConsoleLogger,
  delays: readonly number[] = REVERT_VERIFY_RETRY_DELAYS_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<RevertVerifyResult> {
  let pending = [...reverted];
  // The last re-read's answer per still-differing resource: the printable
  // paths, masked through that re-read outcome's printing bag.
  let stillDiffering = new Map<RevertedResource, string[]>();
  let unverified = 0;
  for (let attempt = 0; attempt <= delays.length && pending.length > 0; attempt++) {
    if (attempt > 0) await sleep(delays[attempt - 1]!);
    // The re-read is the detection the run already printed, so its own
    // per-resource lines (a read refused, a property not compared) would
    // print again on each attempt. They are held back below `error` unless
    // the run is `--verbose`; what the re-read means for each resource is the
    // line this function logs, after the level is restored.
    const level = logger.getLevel();
    if (level !== 'debug') logger.setLevel('error');
    let fresh: StackDriftReport | undefined;
    let failure: unknown;
    try {
      fresh = await redetect(stackName, region);
    } catch (err) {
      failure = err;
    } finally {
      logger.setLevel(level);
    }
    if (fresh === undefined) {
      // Not retried: the wait is for an eventually consistent READ VALUE, and
      // a re-read that throws (a refused state record, a stack read failure)
      // is reported per resource instead of hiding behind the waits. A single
      // resource's read failure does not throw; detection reports it as not
      // compared, which lands in the warning arm below.
      for (const r of pending) {
        logger.warn(
          safeMsg`  ? ${stackName}/${r.logicalId} (${r.resourceType}): reverted, but cdkd could not verify it: the re-read failed (${describeAwsFailure(failure).detail}).`
        );
      }
      return { notApplied: 0, unverified: unverified + pending.length };
    }
    const byId = new Map(fresh.outcomes.map((o) => [o.logicalId, o]));
    const next: RevertedResource[] = [];
    stillDiffering = new Map();
    for (const r of pending) {
      const outcome = byId.get(r.logicalId);
      const reason = unverifiableReason(outcome);
      if (reason !== undefined) {
        unverified++;
        logger.warn(
          safeMsg`  ? ${stackName}/${r.logicalId} (${r.resourceType}): reverted, but cdkd could not verify it: ${reason}.`
        );
        continue;
      }
      if (outcome?.kind !== 'drifted') continue;
      // Two answers must agree before a path fails: the re-detection still
      // reports it against state, AND AWS does not hold what was sent there.
      // Only the first's paths print: they are redacted as the outcome is
      // built, where the raw bags the second compares are not.
      const notAsSent = r.differsFromSent(outcome.awsProperties);
      const differing = outcome.changes
        .map((c) => c.path)
        .filter((p) => r.paths.some((target) => overlaps(p, target)))
        .filter((p) => notAsSent.some((q) => overlaps(p, q)));
      if (differing.length === 0) continue;
      next.push(r);
      stillDiffering.set(
        r,
        differing.map((p) => reportPath(displayDriftPath(outcome, p)))
      );
    }
    pending = next;
  }
  for (const r of pending) {
    const paths = (stillDiffering.get(r) ?? []).join(', ');
    logger.error(
      safeMsg`  ✗ ${stackName}/${r.logicalId} (${r.resourceType}): not applied by AWS — AWS accepted the update without applying the reverted value; a re-read still differs from cdkd state at ${paths}.`
    );
  }
  return { notApplied: pending.length, unverified };
}
