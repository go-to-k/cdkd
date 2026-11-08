/**
 * The module-level helpers, constants and record shapes of `S3StateBackend`,
 * shared by `src/state/s3-state-backend.ts` and its companions in this directory.
 *
 * Moved verbatim out of `src/state/s3-state-backend.ts` (go-to-k/cdkd#5835), which
 * re-exports every name it exported before.
 */
import { NoSuchKey } from '@aws-sdk/client-s3';
import type { RollbackJournalSegment } from '../../types/rollback-journal.js';
import { displaySafe } from '../../utils/display-safe.js';
import { UNRENDERABLE } from '../lock-contention-message.js';

/**
 * An error's text for a state message: the ASCII allowlist, and
 * `UNRENDERABLE` for nothing left. S3's error text ECHOES the key, which embeds
 * the stack name, so a message that guarded the name would otherwise let the
 * same bytes back in through its last interpolation (issue #3027).
 */
export function errorDetail(error: unknown): string {
  return (
    displaySafe(error instanceof Error ? error.message : error, { asciiOnly: true }) || UNRENDERABLE
  );
}

/**
 * `text` without one final period, for a clause that a message continues
 * with a sentence of its own (`<clause>. The state record was left ...`).
 */
export function withoutFinalPeriod(text: string): string {
  return text.endsWith('.') ? text.slice(0, -1) : text;
}

/**
 * Identifier of a state record. The legacy layout (`version: 1`) didn't have
 * region in the S3 key, so reads from the legacy key carry `region:
 * undefined`.
 */
export interface StackStateRef {
  stackName: string;
  /** Region of the state. `undefined` ONLY for legacy `version: 1` records. */
  region?: string;
}

/**
 * The `version: 1` legacy state key under the `cdkd/` prefix. Two layers
 * deep — split off into a constant so call sites can clearly distinguish
 * "two-segment legacy key" from "three-segment new key".
 */
/**
 * `{stack}/state.json` — one segment plus the file, i.e. the v1 region-less
 * layout. Exported because `state-file-keys.ts` classifies the same layouts
 * from the other side and the two must not drift (issue #2001).
 */
export const LEGACY_KEY_DEPTH = 2;

/** The `version: 2` region-prefixed key. */
export const NEW_KEY_DEPTH = 3;

/**
 * Options used to reconstruct the S3Client if the bucket lives in a region
 * different from the one the initial client was built for.
 *
 * Mirrors `AwsClientConfig` from `aws-clients.ts` but kept local so
 * the state backend doesn't depend on the CLI-side AwsClients wrapper.
 */
export interface S3ClientOptions {
  region?: string;
  profile?: string;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
}

/**
 * Options for `S3StateBackend.verifyBucketExists`.
 */
export interface VerifyBucketExistsOptions {
  /**
   * Set when the caller ALREADY proved the bucket exists moments earlier with
   * the same credentials — today only the default-state-bucket resolution in
   * `config-loader.ts`, which `HeadBucket`s both candidate names to choose
   * between them (see `stateBucketExistenceConfirmed`). Skips the duplicate
   * `HeadBucket` round trip on the deploy preflight's critical path (issue
   * [#1283](https://github.com/go-to-k/cdkd/issues/1283)).
   *
   * The region resolution / client rebuild is NOT skipped — only the HEAD.
   *
   * Never set it for an explicitly-specified bucket (`--state-bucket` /
   * `CDKD_STATE_BUCKET` / `cdk.json`): those are taken verbatim, were never
   * probed, and must keep failing fast here before asset uploads / Docker
   * builds run against a missing bucket.
   */
  existenceAlreadyProbed?: boolean;
}

/**
 * What the legacy `{prefix}/{stackName}/state.json` key holds, as four
 * distinct answers rather than the single `undefined` that collapsed them
 * (issue #2550).
 *
 * The collapse is what made the destroy bug hard to fix safely: `absent`,
 * `no-region` and `unreadable` all read as "no region", so a caller could not
 * tell "there is no record" from "there is a record that names no region"
 * from "I could not look". The delete sweep needs the middle one to mean YES
 * and `stateExists` needs the other two to mean NO.
 *
 * `absent` is the NoSuchKey answer specifically. Without `s3:ListBucket` S3
 * reports a missing object as AccessDenied instead, which lands in
 * `unreadable` — harmless, since both consumers answer the same way to both,
 * but it is why `absent` must not be read as "definitely nothing there".
 */
export type LegacyStateProbe =
  | { kind: 'absent' }
  | { kind: 'no-region' }
  | { kind: 'region'; region: string }
  | { kind: 'unreadable'; reason: string };

/**
 * Does a legacy record classified by {@link LegacyStateProbe} belong to an
 * operation targeting `region`?
 *
 * Free function, and shared by both consumers on purpose: the delete sweep
 * needs the probe's KIND as well as this verdict (to warn when a record may
 * have been left behind), and duplicating the mapping at that call site is
 * how the two would drift apart again.
 */
export function legacyProbeBelongsTo(probe: LegacyStateProbe, region: string): boolean {
  switch (probe.kind) {
    case 'region':
      return probe.region === region;
    case 'no-region':
      // `tryGetLegacy` hands this record to ANY region, so the sweep must
      // accept it from any region too — issue #2550.
      return true;
    case 'absent':
    case 'unreadable':
      // A read that failed says nothing about who owns the record, and must
      // never authorise a delete.
      return false;
  }
}

/**
 * go-to-k/cdkd#4705 review H-1: how far this machine's clock may be from S3's
 * before a kept resource's time is re-written with S3's (LastModified has
 * one-second resolution).
 */
export const KEPT_AT_CLOCK_TOLERANCE_MS = 2_000;

export const ROLLBACK_JOURNAL_OBJECT_DESCRIPTION =
  'the rollback journal, whose `failedOperations[].attemptedProperties` records the properties of the failed write verbatim';

/** `objectDescription` for the write-ahead stack instance id (go-to-k/cdkd#5064). */
export const STACK_INSTANCE_OBJECT_DESCRIPTION =
  "the write-ahead stack instance id, from which a stack's generated resource names derive";

/** `objectDescription` for a stack's state record (go-to-k/cdkd#2346 sites 1-3). */
export const STATE_RECORD_OBJECT_DESCRIPTION =
  "the stack's state record, which carries every resource's recorded properties and attributes";

/**
 * Treat S3 NoSuchKey-equivalents uniformly. The SDK throws `NoSuchKey` from
 * `GetObject` and `{name: 'NoSuchKey'}` from low-level callsites; HeadObject
 * raises `{name: 'NotFound'}` instead.
 */
/**
 * A resource a destroy kept that a later create of the same stack, under the
 * same prefix, may take back by its cdkd-generated name (go-to-k/cdkd#4705).
 */
export interface RetainedResource {
  logicalId: string;
  resourceType: string;
  physicalId: string;
  /**
   * When this stack let the resource go (epoch ms): S3's clock, the write
   * that recorded it -- or, when that read-back failed, this machine's clock
   * at the write. A holder created after it is not the resource that was kept
   * (go-to-k/cdkd#4705 review D-2). cdkd always writes one; an entry without
   * one (only a hand edit makes one) is trusted by name alone.
   */
  keptAt?: number;
}

/** The entries of a `retained.json` body, or `undefined` when it is not one. */
export function parseRetainedResources(body: string): RetainedResource[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const doc = value as { retainedVersion?: unknown; resources?: unknown };
  if (doc.retainedVersion !== 1 || !Array.isArray(doc.resources)) return undefined;
  const out: RetainedResource[] = [];
  for (const entry of doc.resources) {
    const e = entry as Partial<RetainedResource> | null;
    if (
      typeof e?.logicalId === 'string' &&
      typeof e.resourceType === 'string' &&
      typeof e.physicalId === 'string' &&
      e.physicalId !== ''
    ) {
      out.push({
        logicalId: e.logicalId,
        resourceType: e.resourceType,
        physicalId: e.physicalId,
        ...(typeof e.keptAt === 'number' && Number.isFinite(e.keptAt) && { keptAt: e.keptAt }),
      });
    }
  }
  return out;
}

/** The bucket-root segment registry markers live under (go-to-k/cdkd#4705). */
export const REGISTRY_ROOT = '_cdkd-registry';

/**
 * The state prefix a registry marker body names, or `undefined` when it is
 * not `{ "prefix": <string> }` with a prefix cdkd could have written: at most
 * 1024 characters, no control character, no `<` or `>` (the placeholder
 * `parseStatePrefix` refuses). Validated before it is used as a key or shown.
 */
export function registryMarkerPrefix(body: string | undefined): string | undefined {
  if (body === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const prefix = (value as { prefix?: unknown }).prefix;
  if (typeof prefix !== 'string' || prefix.length > 1024) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f<>]/.test(prefix)) return undefined;
  return prefix;
}

/** S3's 409 ConditionalRequestConflict: a conflicting write is in flight. */
export function isConditionalConflict(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
    ?.httpStatusCode;
  return name === 'ConditionalRequestConflict' || (status === 409 && name !== 'PreconditionFailed');
}

/** A conditional write that lost: 412, or the 409 S3 answers for a concurrent one. */
export function isConditionFailure(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
    ?.httpStatusCode;
  return (
    name === 'PreconditionFailed' ||
    name === 'ConditionalRequestConflict' ||
    status === 412 ||
    status === 409
  );
}

export function isNoSuchKey(error: unknown): boolean {
  if (error instanceof NoSuchKey) return true;
  const name = (error as { name?: string } | null)?.name;
  return name === 'NoSuchKey';
}

/**
 * go-to-k/cdkd#4402: record, on `older` (the nearest older segment that stays),
 * the logical ids whose earlier failed attempts `removed` superseded — its
 * completed ops' ids and any it carried itself. A completed op supersedes the
 * earlier attempts of its id because it RECORDED the resource, whether or not
 * the removal follows its revert (a clean rollback's settle, `cdkd rollback`,
 * a settled nested segment) or not (an orphaned nested segment discarded);
 * without this, removing it — a reverted adoption above all — would let the
 * attempt it superseded count as evidence again (`priorAttemptsInJournal`).
 * No older segment: nothing to supersede.
 */
export function carrySupersededIds(
  removed: RollbackJournalSegment,
  older: RollbackJournalSegment | undefined
): void {
  if (older === undefined) return;
  addSupersededIds(older, [
    ...removed.operations.map((op) => op.logicalId),
    ...(removed.supersededLogicalIds ?? []),
  ]);
}

/** Union `ids` into `segment.supersededLogicalIds`; writes nothing for none. */
export function addSupersededIds(segment: RollbackJournalSegment, ids: readonly string[]): void {
  const merged = new Set([...(segment.supersededLogicalIds ?? []), ...ids]);
  if (merged.size > 0) segment.supersededLogicalIds = [...merged];
}
