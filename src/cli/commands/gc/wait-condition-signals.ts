/**
 * `cdkd gc`'s arm for orphaned wait condition signal objects
 * (go-to-k/cdkd#6699).
 *
 * An `AWS::CloudFormation::WaitConditionHandle` is a pre-signed PUT URL for one
 * key under `wait-condition-signals/` in the STATE bucket
 * (`src/provisioning/wait-condition-signal-store.ts`). Only the handle's own
 * `delete()` removes that key, so it is left behind for good when the handle's
 * record goes away without that delete: a deploy interrupted between the
 * handle's create and its state write, `cdkd state orphan` / `cdkd orphan` /
 * a rollback `--orphan` arm, or a failed best-effort delete. The prefix has no
 * lifecycle rule (the URL must stay writable while the handle exists).
 *
 * ## What is collected
 *
 * A key is a candidate only when ALL of these hold:
 *
 *  1. it is EXACTLY a minted signal key (`isSignalKey`: the prefix, an
 *     alphanumeric logical id, a UUID, `.json`). The prefix is shared with
 *     nothing cdkd writes today, but `--state-prefix` is free-form, so a stack
 *     deployed with `--state-prefix wait-condition-signals` would put its
 *     `state.json` here; the shape filter keeps that out of reach, exactly as
 *     the response-placeholder sweep's does;
 *  2. its `LastModified` is strictly older than the `--older-than` cutoff;
 *  3. NO handle in ANY state record references it ({@link collectSignalReferences}).
 *
 * ## Why the cutoff plus the lock guard is sufficient against a concurrent deploy
 *
 * The same two guards as the placeholder sweep, closing different windows:
 * gc refuses outright while any stack holds a lock, and every deploy that can
 * create a handle holds one for its whole duration. For a deploy that STARTS
 * after the lock scan, the cutoff covers it: a handle's create only SIGNS a URL
 * for a fresh `<logicalId>-<uuid>` key (it writes no object), so a key exists
 * only once someone PUTs a signal to that URL, and the URL lives at most 12
 * hours (`SIGNAL_URL_EXPIRES_IN_SECONDS`). A key whose current version is older
 * than the cutoff (default 30d) therefore belongs to a handle created more than
 * the cutoff ago, whose record any in-flight deploy wrote long before this run,
 * and a new handle can never mint an existing key. The objects are listed
 * BEFORE the state files are read, so a record written during the read is a
 * record of a key too young to be listed.
 *
 * The one move the cutoff does not cover is a record that leaves one state
 * file for another while the scan reads them. Every such move holds a lock, so
 * the locks are listed again after the scan, and gc refuses if any appeared.
 *
 * ## Rollback journals and retained records
 *
 * Rollback journals are not read, and gc reads them nowhere else: a journal's
 * records are of resources that are in state, in `orphans`, or already deleted
 * (whose key the handle's delete removed). A journal replay that re-creates a
 * handle signs a NEW key rather than reusing one. `retained.json` (a destroy's
 * kept resources, which outlive their record by design) IS read: a handle
 * kept with `DeletionPolicy: Retain` is the user's to delete, not gc's.
 */

import type { S3StateBackend } from '../../../state/s3-state-backend.js';
import { WAIT_CONDITION_SIGNAL_PREFIX } from '../../../state/state-prefix.js';
import {
  classifyHandleUrl,
  isSignalKey,
} from '../../../provisioning/wait-condition-signal-store.js';
import { CdkdError } from '../../../utils/error-handler.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { displayIdent, safeMsg } from '../../../utils/display-safe.js';
import { STATE_KEY_MAX_CODE_POINTS } from '../state-file-keys.js';

export const WAIT_CONDITION_HANDLE_TYPE = 'AWS::CloudFormation::WaitConditionHandle';

/** How many keys are removed at once; each removal is several S3 calls. */
export const SIGNAL_DELETE_CONCURRENCY = 8;

/** One orphaned signal object in the STATE bucket. */
export interface WaitConditionSignalCandidate {
  key: string;
  size: number;
  lastModified: Date;
}

/**
 * The listing prefix, refused unless it is one plain segment plus `/`. An
 * empty or `/`-only value would list the whole bucket, and a multi-segment one
 * is not the producer's layout. The shape filter would still keep state files
 * out, but a guard that only holds because a second guard does is one edit
 * from a whole-bucket delete.
 */
export function signalSweepPrefix(prefix: string = WAIT_CONDITION_SIGNAL_PREFIX): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(prefix)) {
    throw new CdkdError(
      `Refusing to sweep wait condition signal objects under ${JSON.stringify(prefix)}: ` +
        `the prefix must be a single non-empty segment.`,
      'GC_SIGNAL_PREFIX_REFUSED'
    );
  }
  return `${prefix}/`;
}

/**
 * Keys under the prefix that are minted-shaped and older than the cutoff:
 * steps 1 and 2 of the module rule. Step 3 needs the state scan, which the
 * caller runs only when this returns something or the asset arm needs it.
 */
export async function listAgedSignalObjects(
  stateBackend: Pick<S3StateBackend, 'listRawObjects'>,
  cutoffMs: number,
  logger: { debug: (message: string) => void },
  prefix: string = signalSweepPrefix()
): Promise<WaitConditionSignalCandidate[]> {
  const objects = await stateBackend.listRawObjects(prefix);
  const aged: WaitConditionSignalCandidate[] = [];
  for (const obj of objects) {
    const shown = displayIdent(obj.key, { maxCodePoints: STATE_KEY_MAX_CODE_POINTS });
    if (!obj.key.startsWith(prefix) || !isSignalKey(obj.key)) {
      logger.debug(safeMsg`gc: keeping ${shown} — not a cdkd wait condition signal key`);
      continue;
    }
    if (obj.lastModified.getTime() >= cutoffMs) {
      logger.debug(safeMsg`gc: keeping ${shown} — newer than the --older-than cutoff`);
      continue;
    }
    aged.push(obj);
  }
  return aged;
}

/** Any minted signal key appearing anywhere in a string, decoded or not. */
const EMBEDDED_SIGNAL_KEY = new RegExp(
  `${WAIT_CONDITION_SIGNAL_PREFIX}/[A-Za-z0-9]{1,255}-` +
    `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.json`,
  'g'
);

/**
 * Add every key a handle's `physicalId` references. `classifyHandleUrl` against
 * the state bucket is the primary reading (what the handle's own delete uses).
 * Any minted-shaped key appearing ANYWHERE in the id is added as well: a URL
 * spelled in a form the classifier does not recognise (another endpoint shape)
 * still keeps its key. That can only over-keep, since a UUID-bearing key a
 * handle names is never another handle's.
 */
function addHandleReferences(physicalId: string, bucket: string, refs: Set<string>): void {
  const verdict = classifyHandleUrl(physicalId, bucket);
  if (verdict.kind === 'ours') refs.add(verdict.key);
  let decoded = physicalId;
  try {
    decoded = decodeURIComponent(physicalId);
  } catch {
    // Keep the raw spelling only.
  }
  for (const text of [physicalId, decoded]) {
    for (const match of text.matchAll(EMBEDDED_SIGNAL_KEY)) refs.add(match[0]);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Visit one resource record. A record that is not an object, or a handle whose
 * `physicalId` is not a string, cannot be read for its key: that is malformed.
 */
function visitResource(
  record: unknown,
  where: string,
  bucket: string,
  refs: Set<string>
): string | undefined {
  if (!isRecord(record)) return `${where} is not an object`;
  // A wait condition still in state whose handle record was orphaned keeps
  // its signals: its `Handle` (the URL) is a reference too. Keep-only.
  if (record['resourceType'] === 'AWS::CloudFormation::WaitCondition') {
    const props = record['properties'];
    const handle = isRecord(props) ? props['Handle'] : undefined;
    if (typeof handle === 'string') addHandleReferences(handle, bucket, refs);
    return undefined;
  }
  if (record['resourceType'] !== WAIT_CONDITION_HANDLE_TYPE) return undefined;
  const physicalId = record['physicalId'];
  if (typeof physicalId !== 'string') return `${where} is a handle with no string physicalId`;
  addHandleReferences(physicalId, bucket, refs);
  return undefined;
}

/**
 * Collect the signal keys one parsed `state.json` references, from `resources`,
 * `orphans[].state` and `supersededResources[].state` (a nested child's record
 * is a `state.json` of its own, listed like any other). Returns why the
 * document is malformed, or `undefined`: a container that cannot be walked may
 * hide a handle, so the caller aborts rather than guessing.
 */
export function collectSignalReferences(
  parsed: unknown,
  bucket: string,
  refs: Set<string>
): string | undefined {
  if (!isRecord(parsed)) return 'the document is not an object';
  const resources = parsed['resources'];
  if (!isRecord(resources)) return '`resources` is not an object';
  for (const [logicalId, record] of Object.entries(resources)) {
    const where = `resources entry ${displayIdent(logicalId, { maxCodePoints: STATE_KEY_MAX_CODE_POINTS })}`;
    const bad = visitResource(record, where, bucket, refs);
    if (bad !== undefined) return bad;
  }
  for (const field of ['orphans', 'supersededResources'] as const) {
    const list = parsed[field];
    if (list === undefined) continue;
    if (!Array.isArray(list)) return `\`${field}\` is not a list`;
    for (const [index, entry] of list.entries()) {
      const where = `${field}[${index}]`;
      if (!isRecord(entry)) return `${where} is not an object`;
      const bad = visitResource(entry['state'], `${where}.state`, bucket, refs);
      if (bad !== undefined) return bad;
    }
  }
  return undefined;
}

/** The same, for a `retained.json` body's `resources` list. */
export function collectRetainedSignalReferences(
  parsed: unknown,
  bucket: string,
  refs: Set<string>
): string | undefined {
  if (!isRecord(parsed) || !Array.isArray(parsed['resources'])) {
    return 'the document has no `resources` list';
  }
  for (const [index, entry] of parsed['resources'].entries()) {
    const bad = visitResource(entry, `resources[${index}]`, bucket, refs);
    if (bad !== undefined) return bad;
  }
  return undefined;
}

/**
 * Remove each candidate with all its versions and delete markers, at most
 * {@link SIGNAL_DELETE_CONCURRENCY} at a time. Every candidate is attempted;
 * the failures are then reported together as `GC_DELETE_FAILED`, with the
 * FAILURE count (not the attempted one), as the other arms do.
 */
export async function deleteWaitConditionSignalCandidates(
  candidates: readonly WaitConditionSignalCandidate[],
  remove: (key: string) => Promise<void>,
  bucket: string,
  concurrency: number = SIGNAL_DELETE_CONCURRENCY
): Promise<void> {
  const failures: string[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < candidates.length) {
      const candidate = candidates[next++]!;
      try {
        await remove(candidate.key);
      } catch (error) {
        failures.push(
          `${displayIdent(candidate.key, { maxCodePoints: STATE_KEY_MAX_CODE_POINTS })} ` +
            `(${describeAwsFailure(error).summary})`
        );
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), candidates.length) }, worker)
  );
  if (failures.length > 0) {
    throw new CdkdError(
      `Failed to delete ${failures.length} wait condition signal object(s) from ${bucket}: ` +
        failures.join('; '),
      'GC_DELETE_FAILED'
    );
  }
}
