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
 * as `team-a//<stack>/...`; the twins are probed in a second pass, only when no
 * `p` held the stack). Each candidate costs one listing of `<p>/<stack>/`;
 * only a hit reads the region-scoped record, the legacy region-less record and
 * the rollback journal, in parallel and strictly
 * (`S3StateBackend.recordUnderPrefix`), through a pool of
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

import { displayIdent, displaySafe, displayStackName } from '../utils/display-safe.js';
import { pasteableCommand } from '../utils/pasteable-command.js';
import { CdkdError } from '../utils/error-handler.js';
import { recoveryCommandFlags, type LockRecoveryContext } from './lock-contention-message.js';

/** The calls the scan makes, so it can be tested without S3. */
export interface CrossPrefixScanTarget {
  /** The prefix this backend reads and writes under. */
  readonly prefix: string;
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
 * Can a record, with its rollback journal, own an AWS resource? It can when it
 * lists `resources` or rollback-`orphans`, or when a journal segment holds a
 * completed operation (`operations`, which a rollback reverts) or a failed one
 * carrying a `physicalId` (a failed CREATE's proven orphan, which a destroy, a
 * rollback, or the stack's next successful deploy deletes). A failed FIRST
 * deploy that made nothing leaves none of these -- an empty record and, at
 * most, failed operations with no physical id -- so it blocks nothing.
 * Anything not shaped as cdkd writes it proves nothing and counts as a holder.
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
  return segments.some((seg: unknown) => {
    if (seg === null || typeof seg !== 'object' || Array.isArray(seg)) return true;
    const ops = (seg as { operations?: unknown }).operations;
    if (ops !== undefined && (!Array.isArray(ops) || ops.length > 0)) return true;
    const failed = (seg as { failedOperations?: unknown }).failedOperations;
    if (failed === undefined) return false;
    if (!Array.isArray(failed)) return true;
    return failed.some(
      (op: unknown) =>
        op === null ||
        typeof op !== 'object' ||
        (op as { physicalId?: unknown }).physicalId !== undefined
    );
  });
}

/** What the scan found. */
export type CrossPrefixScanResult =
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
  | {
      kind: 'denied';
      error: unknown;
      /** `'registry'`: S3 refused the stack's registry marker (`stack-registry.ts`). */
      stage: 'list' | 'probe' | 'registry';
      stale?: string[];
    }
  /** Any other failure (a {@link CrossPrefixReadError} names the object). */
  | { kind: 'failed'; error: unknown; stale?: string[] }
  /**
   * The registry assigns the stack to `prefix`, which records nothing for it
   * yet but holds its lock: a first deploy there may be running.
   */
  | { kind: 'in-progress'; prefix: string };

/**
 * A read under another prefix that failed, naming the object it was reading so
 * a refusal can point at it. Its message carries the KEY and the error CLASS
 * only: a parse error's own message quotes a fragment of the body, which is
 * another prefix's record.
 */
export class CrossPrefixReadError extends Error {
  readonly key: string;
  override readonly cause: unknown;
  constructor(key: string, cause: unknown) {
    super(
      `reading ${displayIdent(key, { maxCodePoints: 1024 })} failed (${errorName(cause, 'an unknown error')})`
    );
    this.name = 'CrossPrefixReadError';
    this.key = key;
    this.cause = cause;
  }
}

/**
 * How many candidate prefixes are probed at once. A probe is one listing, plus
 * three parallel reads only on a hit. The scan runs on its own S3 client
 * (`S3StateBackend.clientForScan`), whose sockets the deploy's own calls never
 * wait behind, so it can use that client's whole 50-socket pool.
 */
export const PROBE_CONCURRENCY = 50;

/**
 * An S3-compatible endpoint that does not implement a request feature (a
 * conditional write or delete): 501 / `NotImplemented`.
 */
export function isNotImplemented(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
    ?.httpStatusCode;
  return name === 'NotImplemented' || status === 501;
}

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
 * minus this backend's own: each segment `p` itself, then its trailing-slash
 * twin `p/` (a `--state-prefix team-a/` keys records as `team-a//<stack>/...`).
 * The scan probes both lists in ONE pass.
 */
export function candidatePrefixPasses(
  segments: readonly string[],
  own: string
): [string[], string[]] {
  const seen = new Set<string>([own]);
  const pass = (names: readonly string[]): string[] => {
    const out: string[] = [];
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
    return out;
  };
  const first = pass(segments);
  const second = pass(segments.map((p) => `${p}/`));
  return [first, second];
}

/**
 * Look for the stack under every OTHER prefix of the bucket (the registry's
 * fallback, `stack-registry.ts`).
 *
 * The verdict, over every probe: any holder refuses (`found`), whatever else
 * failed; then any failure other than a 403 (`failed`); then any 403
 * (`denied`); else `clear`. A holder stops new probes from starting.
 */
export async function scanOtherPrefixesForStack(
  target: CrossPrefixScanTarget,
  stackName: string,
  region: string
): Promise<CrossPrefixScanResult> {
  let segments: string[];
  try {
    segments = await target.listTopLevelPrefixes();
  } catch (error) {
    return isAccessDenied(error)
      ? { kind: 'denied', error, stage: 'list' }
      : { kind: 'failed', error };
  }
  const found: string[] = [];
  const stale: string[] = [];
  let denied: unknown;
  let failed: unknown;
  const probeAll = async (candidates: readonly string[]): Promise<void> => {
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
  };
  const [segmentsThemselves, twins] = candidatePrefixPasses(segments, target.prefix);
  await probeAll([...segmentsThemselves, ...twins]);
  const extra = stale.length > 0 ? { stale } : {};
  if (found.length > 0) return { kind: 'found', prefixes: found, ...extra };
  if (failed !== undefined) return { kind: 'failed', error: failed, ...extra };
  if (denied !== undefined) return { kind: 'denied', error: denied, stage: 'probe', ...extra };
  return { kind: 'clear', ...extra };
}

/** {@link withSharedListing}'s target, which also prioritizes the scans through it. */
export interface SharedScanTarget extends CrossPrefixScanTarget {
  /**
   * Set the priority of the scan of `stackName` in `region`. `'prestart'`
   * gives a scan that has none the next place in pre-start order (`destroy
   * --all` pre-starts its stacks in the order it destroys them); `'now'` puts
   * it ahead of every pre-started scan, for a caller that is waiting on it
   * this moment (and promotes a pre-started one).
   */
  rank(stackName: string, region: string, when: 'prestart' | 'now'): void;
}

/**
 * The same target with ONE bucket listing shared by every scan through it, and
 * ONE run-wide cap of {@link PROBE_CONCURRENCY} probes in flight across all of
 * them, for a command that scans several stacks at once (`deploy --all`,
 * `destroy --all`). The listing starts on the first scan that needs it.
 *
 * The rank is a PRIORITY, not a barrier: a freed slot goes to the
 * best-ranked WAITING probe (first come among equals), and a probe takes a
 * free slot unless a better-ranked one waits. A scan whose request never
 * settles holds only its own slots; every other scan keeps going.
 */
export function withSharedListing(target: CrossPrefixScanTarget): SharedScanTarget {
  let listing: Promise<string[]> | undefined;
  let inFlight = 0;
  let seq = 0;
  let prestarted = 0;
  const keyOf = (stackName: string, region: string): string => JSON.stringify([stackName, region]);
  // Lower is sooner: -1 for a scan a caller waits on now, then pre-start
  // order. A scan nobody ranked goes last.
  const ranks = new Map<string, number>();
  const rankOf = (stackName: string, region: string): number =>
    ranks.get(keyOf(stackName, region)) ?? Number.MAX_SAFE_INTEGER;
  // The waiting probes, a binary min-heap on (rank, seq): admitting the best
  // one, and asking whether a better one waits, cost O(log n) and O(1).
  type Waiter = { key: string; rank: number; seq: number; resolve: () => void };
  const heap: Waiter[] = [];
  const before = (a: Waiter, b: Waiter): boolean =>
    a.rank < b.rank || (a.rank === b.rank && a.seq < b.seq);
  const swap = (i: number, j: number): void => {
    const t = heap[i]!;
    heap[i] = heap[j]!;
    heap[j] = t;
  };
  const siftUp = (i: number): void => {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!before(heap[i]!, heap[parent]!)) return;
      swap(i, parent);
      i = parent;
    }
  };
  const siftDown = (i: number): void => {
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let best = i;
      if (l < heap.length && before(heap[l]!, heap[best]!)) best = l;
      if (r < heap.length && before(heap[r]!, heap[best]!)) best = r;
      if (best === i) return;
      swap(i, best);
      i = best;
    }
  };
  const popBest = (): Waiter => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      siftDown(0);
    }
    return top;
  };
  const admitBest = (): void => {
    while (inFlight < PROBE_CONCURRENCY && heap.length > 0) {
      inFlight++;
      popBest().resolve();
    }
  };
  const acquire = async (stackName: string, region: string): Promise<void> => {
    const rank = rankOf(stackName, region);
    if (inFlight < PROBE_CONCURRENCY && (heap.length === 0 || heap[0]!.rank >= rank)) {
      inFlight++;
      return;
    }
    const key = keyOf(stackName, region);
    await new Promise<void>((resolve) => {
      heap.push({ key, rank, seq: seq++, resolve });
      siftUp(heap.length - 1);
    });
  };
  const release = (): void => {
    inFlight--;
    admitBest();
  };
  return {
    prefix: target.prefix,
    rank: (stackName, region, when) => {
      const key = keyOf(stackName, region);
      if (when === 'prestart') {
        if (!ranks.has(key)) ranks.set(key, prestarted++);
        return;
      }
      if (ranks.get(key) === -1) return;
      ranks.set(key, -1);
      // A promotion is rare: re-rank this scan's waiting probes and re-heapify.
      let moved = false;
      for (const w of heap) {
        if (w.key === key) {
          w.rank = -1;
          moved = true;
        }
      }
      if (moved) for (let i = (heap.length >> 1) - 1; i >= 0; i--) siftDown(i);
    },
    listTopLevelPrefixes: () => (listing ??= target.listTopLevelPrefixes()),
    recordUnderPrefix: async (prefix, stackName, region) => {
      await acquire(stackName, region);
      try {
        return await target.recordUnderPrefix(prefix, stackName, region);
      } finally {
        release();
      }
    },
  };
}

/**
 * One command run's cross-prefix scans, memoized per stack AND region, through
 * one shared listing and one run-wide probe cap ({@link withSharedListing}).
 * A scan starts the first time {@link full} is asked for it -- lazily, so a
 * deploy that never needs one issues no listing and no probe. A caller that
 * starts scans ahead of need passes `'prestart'`, which queues them in call
 * order behind any scan a caller is waiting on (`'now'`, the default, which
 * also promotes a pre-started scan once someone waits on it). It never
 * rejects.
 */
export class CrossPrefixScanCache {
  readonly target: SharedScanTarget;
  private readonly scans = new Map<string, Promise<CrossPrefixScanResult>>();

  constructor(target: CrossPrefixScanTarget) {
    this.target = withSharedListing(target);
  }

  /** The scan of every other prefix for `stackName` in `region`. */
  full(
    stackName: string,
    region: string,
    when: 'prestart' | 'now' = 'now'
  ): Promise<CrossPrefixScanResult> {
    this.target.rank(stackName, region, when);
    const key = JSON.stringify([stackName, region]);
    let scan = this.scans.get(key);
    if (scan === undefined) {
      scan = scanOtherPrefixesForStack(this.target, stackName, region);
      this.scans.set(key, scan);
    }
    return scan;
  }
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
    `release each other record with \`cdkd state orphan\` (it removes only the record, never ` +
    `a resource; a destroy under one of them is refused while another still records the ` +
    `stack, and the check stops at the first ones it finds, so re-run it until none is ` +
    `named), e.g. \`${stateCommand('orphan', s, first)}\`, then the same with each other prefix.`
  );
}

/** What each command calls itself, and what it did not do. */
export type CrossPrefixAction =
  | 'deploy'
  | 'destroy'
  | 'rollback'
  | 'deploy-destructive'
  | 'deploy-late-replace';
const VERB: Record<CrossPrefixAction, string> = {
  deploy: 'deploy',
  destroy: 'destroy',
  rollback: 'roll back',
  'deploy-destructive': 'deploy',
  'deploy-late-replace': 'replace a resource of',
};
const NOTHING: Record<CrossPrefixAction, string> = {
  deploy: 'No resource of this stack was created.',
  destroy: 'Nothing was deleted.',
  rollback: 'Nothing was reverted or deleted.',
  'deploy-destructive': 'No resource of this stack was changed.',
  'deploy-late-replace':
    'That resource is kept, so the new value is not applied; the rest of the deploy goes on.',
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
  prefixes: readonly string[],
  action: 'deploy-destructive' | 'deploy-late-replace' = 'deploy-destructive'
): string {
  const what =
    action === 'deploy-late-replace'
      ? `Refusing to replace a resource of stack ${subjectText(s)} (a replacement this deploy ` +
        `found only on reading the resource back)`
      : `Refusing to deploy stack ${subjectText(s)}: this deploy deletes or replaces resources`;
  return (
    `${what}, and ` +
    `the stack is also recorded under another state prefix of bucket ${displayIdent(s.bucket)} ` +
    `(${prefixesText(prefixes)}). ${UNSUPPORTED_SENTENCE} ${NOTHING[action]} ` +
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

/** The error's CLASS; for a {@link CrossPrefixReadError}, its cause's. */
function errorName(error: unknown, fallback: string): string {
  const subject = error instanceof CrossPrefixReadError ? error.cause : error;
  return subject !== null &&
    typeof subject === 'object' &&
    typeof (subject as { name?: unknown }).name === 'string'
    ? displaySafe((subject as { name: string }).name, { asciiOnly: true })
    : fallback;
}

function failedKeyText(error: unknown): string {
  return error instanceof CrossPrefixReadError
    ? ` reading s3 object ${displayIdent(error.key, { maxCodePoints: 1024 })}`
    : '';
}

/**
 * The warning for a check S3 refused with 403: on the bucket LISTING (an
 * identity whose policy covers only its own prefix) or on a read under a listed
 * prefix. Worded so no refusal's needle appears in it.
 */
export function crossPrefixDeniedWarning(
  s: CrossPrefixSubject,
  error: unknown,
  stage: 'list' | 'probe' | 'registry' = 'probe'
): string {
  if (stage === 'registry') {
    return (
      `Could not use the stack registry for stack ${subjectText(s)}: S3 refused` +
      `${failedKeyText(error)} (${errorName(error, 'AccessDenied')}), so the bucket's other ` +
      `state prefixes were scanned instead, which is slower. Grant s3:GetObject, s3:PutObject ` +
      `and s3:DeleteObject on ${displayIdent(s.bucket)}/_cdkd-registry/* to use it. Continuing.`
    );
  }
  const what =
    stage === 'list'
      ? `S3 refused to list bucket ${displayIdent(s.bucket)}`
      : `S3 refused a read under another state prefix of bucket ${displayIdent(s.bucket)}`;
  return (
    `Could not check the other state prefixes for stack ${subjectText(s)}: ${what} ` +
    `(${errorName(error, 'AccessDenied')}). Continuing. Deploying one stack name under two ` +
    `state prefixes in one account and region is unsupported.`
  );
}

/**
 * The refusal while the prefix the registry names records nothing yet but
 * holds the stack's lock: a deploy there may be in progress.
 */
export function inProgressUnderOtherPrefixMessage(
  s: CrossPrefixSubject,
  action: CrossPrefixAction,
  prefix: string
): string {
  const account = recoveryCommandFlags({
    profile: s.recovery?.profile,
    stateBucket: s.recovery?.stateBucket ?? s.bucket,
  });
  const unlock = pasteableCommand(
    'cdkd force-unlock',
    [
      { value: s.stackName, hole: 'stack' },
      { flag: '--stack-region', value: s.region, hole: 'region' },
      { flag: '--state-prefix', value: prefix, hole: 'prefix' },
    ],
    account.flags
  ).command;
  return (
    `Refusing to ${VERB[action]} stack ${subjectText(s)}: bucket ${displayIdent(s.bucket)} ` +
    `assigns it to state prefix ${displayIdent(prefix)}, which records nothing for it yet but ` +
    `holds its lock, so a deploy there may be in progress. ${UNSUPPORTED_SENTENCE} ` +
    `${NOTHING[action]} Re-run once that deploy has finished; if none is running, remove its ` +
    `lock with \`${unlock}\` and re-run.`
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
    `(${errorName(error, 'an unknown error')}${failedKeyText(error)}). ${UNSUPPORTED_SENTENCE} ` +
    `${NOTHING[action]} Re-run once the check can succeed.`
  );
}

/**
 * Act on a scan: refuse (`found`, `failed`), warn (a 403 on the listing or a
 * read), or do nothing. Stale records are named
 * through `info`. Throws a {@link CdkdError} with {@link STACK_UNDER_OTHER_PREFIX}.
 */
export function applyCrossPrefixScan(
  result: CrossPrefixScanResult,
  s: CrossPrefixSubject,
  action: CrossPrefixAction,
  warn: (message: string) => void,
  info?: (message: string) => void
): void {
  if (result.kind !== 'in-progress' && result.stale !== undefined && result.stale.length > 0) {
    info?.(staleRecordNotice(s, result.stale));
  }
  switch (result.kind) {
    case 'clear':
      return;
    case 'denied':
      // Every run, at the default level, whichever stage S3 refused (a
      // maintainer decision on go-to-k/cdkd#4705).
      warn(crossPrefixDeniedWarning(s, result.error, result.stage));
      return;
    case 'found': {
      const message =
        action === 'deploy'
          ? deployUnderOtherPrefixMessage(s, result.prefixes)
          : action === 'deploy-destructive' || action === 'deploy-late-replace'
            ? destructiveDeployUnderOtherPrefixMessage(s, result.prefixes, action)
            : destroyUnderOtherPrefixMessage(s, result.prefixes, action);
      throw new CdkdError(message, STACK_UNDER_OTHER_PREFIX);
    }
    case 'failed':
      // No `cause`: a parse error's message quotes another prefix's record.
      throw new CdkdError(
        crossPrefixFailedMessage(s, action, result.error),
        STACK_UNDER_OTHER_PREFIX
      );
    case 'in-progress':
      throw new CdkdError(
        inProgressUnderOtherPrefixMessage(s, action, result.prefix),
        STACK_UNDER_OTHER_PREFIX
      );
  }
}
