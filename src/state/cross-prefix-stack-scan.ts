/**
 * One stack name under two state prefixes of one bucket (go-to-k/cdkd#4705).
 *
 * A stack name is unique per account and region, as in CloudFormation: a
 * cdkd-generated physical name derives from the stack name and logical id
 * only, so two deployments of one stack name in one account and region ask AWS
 * for the same names. Where a create hands back an existing resource (an SQS
 * queue, a log group, ...) both records then claim it, and a failed deploy's
 * rollback or a destroy of either deletes it. That configuration is
 * unsupported; this module detects the share of it cdkd can see cheaply — the
 * SAME bucket holding the stack under another prefix — so `deploy` (on a
 * stack's first deploy under this prefix), `destroy` / `state destroy` and
 * `rollback` (whose replay deletes what a failed deploy created, which for a
 * pair can be the other deployment's resource) refuse it.
 *
 * What it reads: one `ListObjectsV2` with `Delimiter: '/'` for the bucket's
 * top-level prefixes, then the stack's `state.json` (region-scoped key, plus
 * the legacy region-less key `stateExists` still honours) under each, in
 * parallel. Only a HIT is read further -- the record and its rollback journal --
 * and blocks only if it can own a resource (`recordCanOwnResources`): the empty
 * record a failed first deploy leaves is named in a note, never refused. What it cannot see, and the docs say so: another BUCKET, and a
 * prefix that itself contains `/` (only a single top-level segment is
 * listed).
 *
 * The scan never rejects: every failure is a result, so a caller that started
 * it early and never awaits it leaves no unhandled rejection.
 */

import { displayIdent, displaySafe, displayStackName } from '../utils/display-safe.js';
import { pasteableCommand } from '../utils/pasteable-command.js';
import { CdkdError } from '../utils/error-handler.js';

/** The calls the scan makes, so it can be tested without S3. */
export interface CrossPrefixScanTarget {
  /** The prefix this backend reads and writes under. */
  readonly prefix: string;
  /** Does this prefix hold a state record OR a rollback journal for the stack? */
  ownRecordExists(stackName: string, region: string): Promise<boolean>;
  /** The bucket's top-level key prefixes, without their trailing `/`. */
  listTopLevelPrefixes(): Promise<string[]>;
  /**
   * What `prefix` holds for the stack in `region`: `absent` (no record),
   * `empty` (a record that can own no AWS resource -- see
   * {@link recordCanOwnResources}), or `holder`.
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
   * No other top-level prefix holds the stack in this region. `stale` names
   * prefixes whose record for it can own no resource (a failed first deploy).
   */
  | { kind: 'clear'; stale?: string[] }
  /** These other prefixes hold the stack in this region. */
  | { kind: 'found'; prefixes: string[]; stale?: string[] }
  /** S3 refused a List or a Head with 403. */
  | { kind: 'denied'; error: unknown }
  /** Any other failure. */
  | { kind: 'failed'; error: unknown };

/** How many HEAD probes run at once. */
const PROBE_CONCURRENCY = 16;

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
 * Look for the stack under every OTHER top-level prefix of the bucket.
 *
 * `checkOwnRecord` (deploy): first ask whether this prefix already holds the
 * stack, and stop with `own-record` when it does, so only a first deploy lists
 * the bucket. Destroy passes `false`: it holds the record it is destroying.
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
    const others = (await target.listTopLevelPrefixes()).filter((p) => p !== target.prefix);
    const found: string[] = [];
    const stale: string[] = [];
    for (let i = 0; i < others.length; i += PROBE_CONCURRENCY) {
      const batch = others.slice(i, i + PROBE_CONCURRENCY);
      const hits = await Promise.all(
        batch.map((p) => target.recordUnderPrefix(p, stackName, region))
      );
      batch.forEach((p, j) => {
        if (hits[j] === 'holder') found.push(p);
        else if (hits[j] === 'empty') stale.push(p);
      });
    }
    const extra = stale.length > 0 ? { stale } : {};
    return found.length > 0
      ? { kind: 'found', prefixes: found, ...extra }
      : { kind: 'clear', ...extra };
  } catch (error) {
    return isAccessDenied(error) ? { kind: 'denied', error } : { kind: 'failed', error };
  }
}

/**
 * The same target with ONE bucket listing shared by every scan through it, for
 * a deploy of several stacks. Started on the first scan that needs it.
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

/** The sentence both refusals share; the integ fixture greps it. */
export const UNSUPPORTED_SENTENCE =
  'A stack name is unique per account and region, as in CloudFormation: deploying one stack ' +
  'name under two state prefixes is unsupported, because both deployments use the same ' +
  'cdkd-generated resource names, and a failed deploy or a destroy of either one deletes ' +
  "resources the other's record also names.";

/** What a refusal or warning is about. */
export interface CrossPrefixSubject {
  stackName: string;
  region: string;
  bucket: string;
}

function subjectText(s: CrossPrefixSubject): string {
  return `${displayStackName(s.stackName)} (${displayIdent(s.region)})`;
}

function prefixesText(prefixes: readonly string[]): string {
  return prefixes.map((p) => displayIdent(p)).join(', ');
}

/** `cdkd state <verb> <stack> --stack-region <r> --state-prefix <p>`. */
function stateCommand(verb: 'destroy' | 'orphan', s: CrossPrefixSubject, prefix: string): string {
  return pasteableCommand(`cdkd state ${verb}`, [
    { value: s.stackName, hole: 'stack' },
    { flag: '--stack-region', value: s.region, hole: 'region' },
    { flag: '--state-prefix', value: prefix, hole: 'prefix' },
  ]).command;
}

/** The deploy refusal: the stack's first deploy under this prefix. */
export function deployUnderOtherPrefixMessage(
  s: CrossPrefixSubject,
  prefixes: readonly string[]
): string {
  const first = prefixes[0]!;
  return (
    `Refusing to deploy stack ${subjectText(s)}: it is already recorded under another state ` +
    `prefix of bucket ${displayIdent(s.bucket)} (${prefixesText(prefixes)}). ` +
    `${UNSUPPORTED_SENTENCE} Nothing was deployed. Either deploy it under that prefix ` +
    `(pass the same --state-prefix it was deployed with), give this stack another name, or, if ` +
    `the other deployment is no ` +
    `longer wanted, remove it first: \`${stateCommand('destroy', s, first)}\` deletes its ` +
    `resources and its record, \`${stateCommand('orphan', s, first)}\` drops only its record.`
  );
}

/** What each command calls itself, and what it did not do. */
export type CrossPrefixAction = 'deploy' | 'destroy' | 'rollback';
const VERB: Record<CrossPrefixAction, string> = {
  deploy: 'deploy',
  destroy: 'destroy',
  rollback: 'roll back',
};
const NOTHING: Record<CrossPrefixAction, string> = {
  deploy: 'Nothing was deployed.',
  destroy: 'Nothing was deleted.',
  rollback: 'Nothing was reverted or deleted.',
};

/**
 * The destroy / rollback refusal: the record being destroyed, or whose journal
 * is being replayed, has a twin under another prefix.
 */
export function destroyUnderOtherPrefixMessage(
  s: CrossPrefixSubject,
  prefixes: readonly string[],
  action: 'destroy' | 'rollback' = 'destroy'
): string {
  const first = prefixes[0]!;
  return (
    `Refusing to ${VERB[action]} stack ${subjectText(s)}: it is also recorded under another state ` +
    `prefix of bucket ${displayIdent(s.bucket)} (${prefixesText(prefixes)}). ` +
    `${UNSUPPORTED_SENTENCE} ${NOTHING[action]} Keep one record per stack name and region: ` +
    `once you have confirmed which record describes the deployment you want to keep, drop the ` +
    `other with \`cdkd state orphan\` (it removes only the record, never a resource), e.g. ` +
    `\`${stateCommand('orphan', s, first)}\`, then re-run.`
  );
}

/** The line for records that block nothing (a failed first deploy's leftover). */
export function staleRecordNotice(s: CrossPrefixSubject, prefixes: readonly string[]): string {
  return (
    `Note: bucket ${displayIdent(s.bucket)} also holds a record of stack ${subjectText(s)} ` +
    `under another state prefix (${prefixesText(prefixes)}) that owns no resource -- the ` +
    `leftover of a failed first deploy. It does not block this command; remove it with ` +
    `\`${stateCommand('orphan', s, prefixes[0]!)}\`.`
  );
}

/** The warning for a scan S3 refused with 403. */
export function crossPrefixDeniedWarning(s: CrossPrefixSubject, error: unknown): string {
  const name =
    error !== null &&
    typeof error === 'object' &&
    typeof (error as { name?: unknown }).name === 'string'
      ? displaySafe((error as { name: string }).name, { asciiOnly: true })
      : 'AccessDenied';
  return (
    `Could not check whether stack ${subjectText(s)} is also recorded under another state ` +
    `prefix of bucket ${displayIdent(s.bucket)}: S3 refused the listing or a read (${name}). ` +
    `Continuing. Deploying one stack name under two state prefixes in one account and region ` +
    `is unsupported.`
  );
}

/** The refusal for a scan that failed otherwise. */
export function crossPrefixFailedMessage(
  s: CrossPrefixSubject,
  action: CrossPrefixAction,
  error: unknown
): string {
  const name =
    error !== null &&
    typeof error === 'object' &&
    typeof (error as { name?: unknown }).name === 'string'
      ? displaySafe((error as { name: string }).name, { asciiOnly: true })
      : 'an unknown error';
  return (
    `Refusing to ${VERB[action]} stack ${subjectText(s)}: cdkd could not check whether it is also ` +
    `recorded under another state prefix of bucket ${displayIdent(s.bucket)} (${name}). ` +
    `${UNSUPPORTED_SENTENCE} ${NOTHING[action]} ` +
    `Re-run once the check can succeed.`
  );
}

/**
 * Act on a scan: refuse (`found`, `failed`), warn (`denied`), or do nothing.
 * Throws a {@link CdkdError} with {@link STACK_UNDER_OTHER_PREFIX}.
 */
export function applyCrossPrefixScan(
  result: CrossPrefixScanResult,
  s: CrossPrefixSubject,
  action: CrossPrefixAction,
  warn: (message: string) => void,
  info?: (message: string) => void
): void {
  switch (result.kind) {
    case 'own-record':
      return;
    case 'clear':
      if (result.stale !== undefined && result.stale.length > 0) {
        info?.(staleRecordNotice(s, result.stale));
      }
      return;
    case 'denied':
      warn(crossPrefixDeniedWarning(s, result.error));
      return;
    case 'found':
      if (result.stale !== undefined && result.stale.length > 0) {
        info?.(staleRecordNotice(s, result.stale));
      }
      throw new CdkdError(
        action === 'deploy'
          ? deployUnderOtherPrefixMessage(s, result.prefixes)
          : destroyUnderOtherPrefixMessage(s, result.prefixes, action),
        STACK_UNDER_OTHER_PREFIX
      );
    case 'failed':
      throw new CdkdError(
        crossPrefixFailedMessage(s, action, result.error),
        STACK_UNDER_OTHER_PREFIX,
        result.error instanceof Error ? result.error : undefined
      );
  }
}
