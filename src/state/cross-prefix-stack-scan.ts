/**
 * One stack name under two state prefixes of one bucket (go-to-k/cdkd#4705).
 *
 * A stack name is unique per account and region, as in CloudFormation: a
 * cdkd-generated physical name derives from the stack name and logical id
 * only, so two deployments of one stack name in one account and region ask AWS
 * for the same names. Where a create hands back an existing resource (an SQS
 * queue, a log group, ...) both records then claim it, and a failed deploy's
 * rollback, a destroy, or a deploy that deletes or replaces of either one
 * deletes it. That configuration is unsupported; this module detects the share
 * of it cdkd can see -- the SAME bucket holding the stack under another prefix
 * -- so `deploy` (a stack's first deploy under its prefix, and any deploy whose
 * plan deletes or replaces), `destroy` / `state destroy` and `rollback` refuse.
 *
 * What it reads: one `ListObjectsV2` with `Delimiter: '/'` for the bucket's
 * top-level prefixes. Each listed segment `p` stands for two prefixes cdkd can
 * have written under it, `p` and `p/` (a `--state-prefix team-a/` keys records
 * as `team-a//<stack>/...`). Under each candidate the region-scoped record, the
 * legacy region-less record and the rollback journal are read in parallel,
 * strictly (`S3StateBackend.recordUnderPrefix`), through a pool of
 * {@link PROBE_CONCURRENCY} workers that stops taking new candidates once one
 * holds the stack. A hit blocks only if it can own a resource
 * ({@link recordCanOwnResources}); the empty record a failed first deploy
 * leaves is named in a note instead.
 *
 * What it cannot see, and the docs say so: another BUCKET, and a prefix with a
 * `/` before its end (only the first segment is listed).
 *
 * The scan never rejects: every failure is a result, so a caller that started
 * it early and never awaits it leaves no unhandled rejection.
 */

import { displayIdent, displaySafe, displayStackName, safeMsg } from '../utils/display-safe.js';
import { pasteableCommand } from '../utils/pasteable-command.js';
import { CdkdError } from '../utils/error-handler.js';
import { getLogger } from '../utils/logger.js';
import { recoveryCommandFlags, type LockRecoveryContext } from './lock-contention-message.js';

/** The calls the scan makes, so it can be tested without S3. */
export interface CrossPrefixScanTarget {
  /** The prefix this backend reads and writes under. */
  readonly prefix: string;
  /** Does this prefix hold a state record OR a rollback journal for the stack? */
  ownRecordExists(stackName: string, region: string): Promise<boolean>;
  /** The bucket's top-level key segments, without their trailing `/`. */
  listTopLevelPrefixes(): Promise<string[]>;
  /**
   * What `prefix` holds for the stack in `region`: `absent` (nothing),
   * `empty` (a record or journal that can own no AWS resource -- see
   * {@link recordCanOwnResources}), or `holder`. Throws when it cannot tell.
   */
  recordUnderPrefix(prefix: string, stackName: string, region: string): Promise<RecordUnderPrefix>;
}

/** What another prefix holds for the stack: see {@link CrossPrefixScanTarget.recordUnderPrefix}. */
export type RecordUnderPrefix = 'absent' | 'empty' | 'holder';

/**
 * Can a record, with its rollback journal, own an AWS resource? A failed FIRST
 * deploy leaves a record with no `resources` and no `orphans` and, at most, a
 * journal whose segments hold no completed operation (only `failedOperations`):
 * nothing there can be destroyed or rolled back, so it must not block another
 * prefix. Anything else -- including a container that is not the shape cdkd
 * writes, which proves nothing -- counts as a holder.
 */
export function recordCanOwnResources(
  record: { resources?: unknown; orphans?: unknown },
  journal: { segments?: unknown } | null
): boolean {
  const resources = record.resources;
  if (resources === null || typeof resources !== 'object' || Array.isArray(resources)) return true;
  if (Object.keys(resources).length > 0) return true;
  // Read unvalidated, and every unreadable shape answers `holder` (the
  // malformed-container guards of `malformed-resources-bag.ts` are for records
  // a command goes on to act on; this one is only classified).
  const orphans = record.orphans;
  if (orphans !== undefined && (!Array.isArray(orphans) || orphans.length > 0)) return true;
  if (journal === null) return false;
  const segments = journal.segments;
  if (!Array.isArray(segments)) return true;
  return segments.some((seg) => {
    const ops = (seg as { operations?: unknown } | null)?.operations;
    return ops !== undefined && (!Array.isArray(ops) || ops.length > 0);
  });
}

/** What the scan found. */
export type CrossPrefixScanResult =
  /** This prefix already holds the stack: not a first deploy, nothing scanned. */
  | { kind: 'own-record' }
  /**
   * No other prefix holds the stack in this region. `stale` names prefixes
   * whose record for it can own no resource (a failed first deploy).
   */
  | { kind: 'clear'; stale?: string[] }
  /** These other prefixes hold the stack in this region. */
  | { kind: 'found'; prefixes: string[]; stale?: string[] }
  /**
   * S3 answered 403: to the bucket LISTING (`stage: 'list'`, e.g. an IAM
   * policy scoped to one prefix), or to a read under a listed prefix.
   */
  | { kind: 'denied'; error: unknown; stage: 'list' | 'probe'; stale?: string[] }
  /** Any other failure. */
  | { kind: 'failed'; error: unknown; stale?: string[] };

/**
 * How many candidate prefixes are probed at once. Each probe sends three reads
 * in parallel, so at most 30 are in flight: inside the 50-socket cap of the
 * shared HTTP agent (`src/utils/proxy-routing-agent.ts`), with headroom for the
 * deploy's own calls.
 */
export const PROBE_CONCURRENCY = 10;

/**
 * A 403 from S3: AccessDenied on a List or a Get, a bare 403 on a Head --
 * also when a state read wrapped it (a bounded walk of `cause`).
 */
export function isAccessDenied(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth++) {
    const name = (current as { name?: unknown }).name;
    if (name === 'AccessDenied' || name === 'Forbidden' || name === 'AllAccessDisabled')
      return true;
    const status = (current as { $metadata?: { httpStatusCode?: unknown } }).$metadata
      ?.httpStatusCode;
    if (status === 403) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The prefixes another deployment can have written under the listed segments,
 * minus this backend's own: each segment `p` stands for `p` and `p/`.
 */
export function candidatePrefixes(segments: readonly string[], own: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([own]);
  for (const segment of segments) {
    for (const candidate of [segment, `${segment}/`]) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      out.push(candidate);
    }
  }
  return out;
}

/**
 * Look for the stack under every OTHER prefix of the bucket.
 *
 * `checkOwnRecord` (a first-deploy check): first ask whether this prefix
 * already holds the stack, and stop with `own-record` when it does. Destroy,
 * rollback and the destructive-plan check pass `false`: they act on the record
 * they hold.
 *
 * The verdict, over every probe: any holder refuses (`found`), whatever else
 * failed; then any failure other than a 403 (`failed`); then any 403
 * (`denied`); else `clear`. A holder stops new probes from starting.
 */
export async function scanOtherPrefixesForStack(
  target: CrossPrefixScanTarget,
  stackName: string,
  region: string,
  opts: { checkOwnRecord: boolean }
): Promise<CrossPrefixScanResult> {
  try {
    if (opts.checkOwnRecord && (await target.ownRecordExists(stackName, region))) {
      return { kind: 'own-record' };
    }
  } catch (error) {
    return isAccessDenied(error)
      ? { kind: 'denied', error, stage: 'probe' }
      : { kind: 'failed', error };
  }
  let segments: string[];
  try {
    segments = await target.listTopLevelPrefixes();
  } catch (error) {
    return isAccessDenied(error)
      ? { kind: 'denied', error, stage: 'list' }
      : { kind: 'failed', error };
  }
  const candidates = candidatePrefixes(segments, target.prefix);
  const found: string[] = [];
  const stale: string[] = [];
  let denied: unknown;
  let failed: unknown;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (found.length === 0 && next < candidates.length) {
      const prefix = candidates[next++]!;
      try {
        const held = await target.recordUnderPrefix(prefix, stackName, region);
        if (held === 'holder') found.push(prefix);
        else if (held === 'empty') stale.push(prefix);
      } catch (error) {
        if (isAccessDenied(error)) denied ??= error;
        else failed ??= error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PROBE_CONCURRENCY, candidates.length) }, () => worker())
  );
  const extra = stale.length > 0 ? { stale } : {};
  if (found.length > 0) return { kind: 'found', prefixes: found, ...extra };
  if (failed !== undefined) return { kind: 'failed', error: failed, ...extra };
  if (denied !== undefined) return { kind: 'denied', error: denied, stage: 'probe', ...extra };
  return { kind: 'clear', ...extra };
}

/**
 * The same target with ONE bucket listing shared by every scan through it, for
 * a command that scans several stacks. Started on the first scan that needs it.
 */
export function withSharedListing(target: CrossPrefixScanTarget): CrossPrefixScanTarget {
  let listing: Promise<string[]> | undefined;
  return {
    prefix: target.prefix,
    ownRecordExists: (stackName, region) => target.ownRecordExists(stackName, region),
    listTopLevelPrefixes: () => (listing ??= target.listTopLevelPrefixes()),
    recordUnderPrefix: (prefix, stackName, region) =>
      target.recordUnderPrefix(prefix, stackName, region),
  };
}

/** The refusal's error code. */
export const STACK_UNDER_OTHER_PREFIX = 'STACK_UNDER_OTHER_STATE_PREFIX';

/** The sentence every refusal shares. */
export const UNSUPPORTED_SENTENCE =
  'A stack name is unique per account and region, as in CloudFormation: deploying one stack ' +
  'name under two state prefixes is unsupported, because both deployments use the same ' +
  'cdkd-generated resource names, and a failed deploy, a destroy, or a deploy that deletes ' +
  "or replaces of either one deletes resources the other's record also names.";

/** What a refusal or warning is about. */
export interface CrossPrefixSubject {
  stackName: string;
  region: string;
  bucket: string;
  /**
   * The run's `--profile` and resolved bucket, carried onto every command a
   * message prints (go-to-k/cdkd#3909): a pasted `cdkd state orphan` must reach
   * the bucket this run read, not the default profile's.
   */
  recovery?: LockRecoveryContext | undefined;
}

function subjectText(s: CrossPrefixSubject): string {
  return `${displayStackName(s.stackName)} (${displayIdent(s.region)})`;
}

/** How many prefixes a message names before "and N more". */
const LISTED_PREFIXES = 5;

function prefixesText(prefixes: readonly string[]): string {
  const shown = prefixes
    .slice(0, LISTED_PREFIXES)
    .map((p) => displayIdent(p, { listMember: true }))
    .join(', ');
  const more = prefixes.length - LISTED_PREFIXES;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

/**
 * `cdkd state <verb> <stack> --stack-region <r> --state-prefix <p>`, with the
 * run's `--profile` and resolved `--state-bucket`.
 */
export function stateCommand(
  verb: 'destroy' | 'orphan',
  s: CrossPrefixSubject,
  prefix: string
): string {
  const account = recoveryCommandFlags({
    profile: s.recovery?.profile,
    stateBucket: s.recovery?.stateBucket ?? s.bucket,
  });
  return pasteableCommand(
    `cdkd state ${verb}`,
    [
      { value: s.stackName, hole: 'stack' },
      { flag: '--stack-region', value: s.region, hole: 'region' },
      { flag: '--state-prefix', value: prefix, hole: 'prefix' },
    ],
    account.flags
  ).command;
}

/** The remedy that releases the other record(s), honest about several. */
function releaseRemedy(
  s: CrossPrefixSubject,
  prefixes: readonly string[],
  destroyToo: boolean
): string {
  const first = prefixes[0]!;
  if (prefixes.length === 1 && destroyToo) {
    return (
      `\`${stateCommand('destroy', s, first)}\` deletes its resources and its record, ` +
      `\`${stateCommand('orphan', s, first)}\` drops only its record.`
    );
  }
  if (prefixes.length === 1) {
    return (
      `drop the other record with \`cdkd state orphan\` (it removes only the record, never a ` +
      `resource): \`${stateCommand('orphan', s, first)}\`.`
    );
  }
  return (
    `release each of the ${prefixes.length} other records with \`cdkd state orphan\` (it ` +
    `removes only the record, never a resource; a destroy under one of them is refused while ` +
    `another still records the stack), e.g. \`${stateCommand('orphan', s, first)}\`, then the ` +
    `same with each other prefix.`
  );
}

/** What each command calls itself, and what it did not do. */
export type CrossPrefixAction = 'deploy' | 'destroy' | 'rollback' | 'deploy-destructive';
const VERB: Record<CrossPrefixAction, string> = {
  deploy: 'deploy',
  destroy: 'destroy',
  rollback: 'roll back',
  'deploy-destructive': 'deploy',
};
const NOTHING: Record<CrossPrefixAction, string> = {
  deploy: 'No resource of this stack was created.',
  destroy: 'Nothing was deleted.',
  rollback: 'Nothing was reverted or deleted.',
  'deploy-destructive': 'No resource of this stack was changed.',
};

/** The deploy refusal: the stack's first deploy under this prefix. */
export function deployUnderOtherPrefixMessage(
  s: CrossPrefixSubject,
  prefixes: readonly string[]
): string {
  return (
    `Refusing to deploy stack ${subjectText(s)}: it is already recorded under another state ` +
    `prefix of bucket ${displayIdent(s.bucket)} (${prefixesText(prefixes)}). ` +
    `${UNSUPPORTED_SENTENCE} ${NOTHING.deploy} Either deploy it under that prefix ` +
    `(pass the same --state-prefix it was deployed with), give this stack another name, or, if ` +
    `the other deployment is no longer wanted, ${prefixes.length === 1 ? 'remove it first: ' : ''}` +
    releaseRemedy(s, prefixes, true)
  );
}

/**
 * The destroy / rollback refusal: the record being destroyed, or whose journal
 * is being replayed, has a twin under another prefix.
 */
export function destroyUnderOtherPrefixMessage(
  s: CrossPrefixSubject,
  prefixes: readonly string[],
  action: 'destroy' | 'rollback' = 'destroy'
): string {
  return (
    `Refusing to ${VERB[action]} stack ${subjectText(s)}: it is also recorded under another ` +
    `state prefix of bucket ${displayIdent(s.bucket)} (${prefixesText(prefixes)}). ` +
    `${UNSUPPORTED_SENTENCE} ${NOTHING[action]} Keep one record per stack name and region: ` +
    `once you have confirmed which record describes the deployment you want to keep, ` +
    `${releaseRemedy(s, prefixes, false)} Then re-run.`
  );
}

/**
 * The refusal of a deploy whose plan deletes or replaces, for a stack the
 * bucket also records under another prefix (a pair that predates the
 * first-deploy check).
 */
export function destructiveDeployUnderOtherPrefixMessage(
  s: CrossPrefixSubject,
  prefixes: readonly string[]
): string {
  return (
    `Refusing to deploy stack ${subjectText(s)}: this deploy deletes or replaces resources, and ` +
    `the stack is also recorded under another state prefix of bucket ${displayIdent(s.bucket)} ` +
    `(${prefixesText(prefixes)}). ${UNSUPPORTED_SENTENCE} ${NOTHING['deploy-destructive']} ` +
    `Keep one record per stack name and region: once you have confirmed which record describes ` +
    `the deployment you want to keep, ${releaseRemedy(s, prefixes, false)} Then re-run.`
  );
}

/** The line for records that block nothing (a failed first deploy's leftover). */
export function staleRecordNotice(s: CrossPrefixSubject, prefixes: readonly string[]): string {
  return (
    `Note: bucket ${displayIdent(s.bucket)} also holds a record of stack ${subjectText(s)} ` +
    `under another state prefix (${prefixesText(prefixes)}) that owns no resource -- the ` +
    `leftover of a failed first deploy. It does not block this command; remove it with ` +
    `\`${stateCommand('orphan', s, prefixes[0]!)}\`` +
    `${prefixes.length > 1 ? ', and the same with each other prefix' : ''}.`
  );
}

function errorName(error: unknown, fallback: string): string {
  return error !== null &&
    typeof error === 'object' &&
    typeof (error as { name?: unknown }).name === 'string'
    ? displaySafe((error as { name: string }).name, { asciiOnly: true })
    : fallback;
}

/** The warning for a read S3 refused with 403 under a prefix it let us list. */
export function crossPrefixDeniedWarning(s: CrossPrefixSubject, error: unknown): string {
  return (
    `Could not check whether stack ${subjectText(s)} is also recorded under another state ` +
    `prefix of bucket ${displayIdent(s.bucket)}: S3 refused a read (${errorName(error, 'AccessDenied')}). ` +
    `Continuing. Deploying one stack name under two state prefixes in one account and region ` +
    `is unsupported.`
  );
}

/** The one line, per process, for a bucket listing S3 refused. */
export function crossPrefixListDeniedNotice(s: CrossPrefixSubject): string {
  return (
    `This identity may not list bucket ${displayIdent(s.bucket)}, so cdkd does not check whether ` +
    `a stack is also recorded under another state prefix there. Deploying one stack name under ` +
    `two state prefixes in one account and region is unsupported.`
  );
}

/** The refusal for a scan that failed otherwise. */
export function crossPrefixFailedMessage(
  s: CrossPrefixSubject,
  action: CrossPrefixAction,
  error: unknown
): string {
  return (
    `Refusing to ${VERB[action]} stack ${subjectText(s)}: cdkd could not check whether the ` +
    `bucket ${displayIdent(s.bucket)} records it under another state prefix ` +
    `(${errorName(error, 'an unknown error')}). ${UNSUPPORTED_SENTENCE} ${NOTHING[action]} ` +
    `Re-run once the check can succeed.`
  );
}

let listDeniedNoticePrinted = false;

/** For tests: forget that the list-denied notice was printed. */
export function resetCrossPrefixNoticesForTest(): void {
  listDeniedNoticePrinted = false;
}

/**
 * Act on a scan: refuse (`found`, `failed`), warn (a 403 on a read), note once
 * per process (a 403 on the listing), or do nothing. Stale records are named
 * through `info`. Throws a {@link CdkdError} with {@link STACK_UNDER_OTHER_PREFIX}.
 */
export function applyCrossPrefixScan(
  result: CrossPrefixScanResult,
  s: CrossPrefixSubject,
  action: CrossPrefixAction,
  warn: (message: string) => void,
  info?: (message: string) => void
): void {
  if (result.kind !== 'own-record' && result.stale !== undefined && result.stale.length > 0) {
    info?.(staleRecordNotice(s, result.stale));
  }
  switch (result.kind) {
    case 'own-record':
    case 'clear':
      return;
    case 'denied':
      if (result.stage === 'list') {
        // A policy scoped to one prefix denies the listing on EVERY run, so
        // this is not a default-verbosity warning.
        getLogger().debug(
          safeMsg`Cross-prefix check skipped: listing bucket ${s.bucket} was denied (${errorName(result.error, 'AccessDenied')}).`
        );
        if (!listDeniedNoticePrinted) {
          listDeniedNoticePrinted = true;
          info?.(crossPrefixListDeniedNotice(s));
        }
        return;
      }
      warn(crossPrefixDeniedWarning(s, result.error));
      return;
    case 'found': {
      const message =
        action === 'deploy'
          ? deployUnderOtherPrefixMessage(s, result.prefixes)
          : action === 'deploy-destructive'
            ? destructiveDeployUnderOtherPrefixMessage(s, result.prefixes)
            : destroyUnderOtherPrefixMessage(s, result.prefixes, action);
      throw new CdkdError(message, STACK_UNDER_OTHER_PREFIX);
    }
    case 'failed':
      throw new CdkdError(
        crossPrefixFailedMessage(s, action, result.error),
        STACK_UNDER_OTHER_PREFIX,
        result.error instanceof Error ? result.error : undefined
      );
  }
}
