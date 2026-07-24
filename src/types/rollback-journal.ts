/**
 * Rollback journal (issue #1183).
 *
 * Persists the exact in-memory `CompletedOperation[]` of a failed /
 * interrupted / about-to-auto-rollback deploy so `cdkd rollback` can revert
 * it later, driving the SAME rollback executor the in-process path uses.
 *
 * Key: `s3://bucket/{prefix}/{stackName}/{region}/rollback-journal.json`, a
 * sibling of `state.json`. Deliberately NOT part of the state schema:
 *
 * - No `StackState.version` bump (no v9) — old binaries reading state are
 *   unaffected, and the `integ-schema-migration` gate is not triggered.
 * - Not under the `deployments/` prefix — that layer intentionally survives
 *   destroy (#808); the journal must not (it is deleted on deploy success /
 *   clean rollback / destroy / state destroy).
 * - Carries resolved properties, the same sensitivity class as `state.json`
 *   itself (documented in state-management.md).
 *
 * No optimistic-locking / ETag protocol: every writer holds the stack lock
 * (the deploy engine through the catch block; the rollback command for its
 * whole replay).
 */

import type { CompletedOperation, FailedOperation } from '../deployment/rollback-executor.js';

/**
 * Journal format version, INDEPENDENT of the state schema. An unknown value
 * on read is a hard error telling the user to upgrade cdkd (forward-compat
 * guard, mirrors state-schema handling).
 */
export const ROLLBACK_JOURNAL_VERSION = 1;

/** Why a segment was recorded (informational; drives no branching on read). */
export type RollbackSegmentReason =
  | 'no-rollback-failure' // deploy failed with --no-rollback (or output-resolution failed)
  | 'interrupted' // deploy interrupted by SIGINT
  | 'auto-rollback-started'; // written before an automatic in-process rollback

/**
 * One failed deploy attempt's worth of completed operations. Segments are
 * ordered oldest -> newest; `cdkd rollback` replays them newest-first (each
 * segment's ops are relative to the state that existed before that segment's
 * deploy, so newest-first sequential replay composes with no merge logic).
 */
export interface RollbackJournalSegment {
  /**
   * The `deployments` runId of the failed deploy, taken from the engine's
   * active `DeploymentEventsStore` recorder (may be absent under `--dry-run`
   * or when no recorder was wired).
   */
  runId?: string;
  /** Epoch ms when the segment was recorded. */
  timestamp: number;
  reason: RollbackSegmentReason;
  /**
   * True when the failed deploy was the FIRST deploy (loadState returned no
   * prior state / currentEtag undefined). Drives the terminal `state.json`
   * deletion in the command.
   */
  initialDeploy: boolean;
  /** Informational: the --role-arn the deploy ran with, if any. */
  roleArn?: string;
  /** The cdkd version that recorded the segment. */
  cdkdVersion?: string;
  /** `CompletedOperation[]`, serialized verbatim, in completion order. */
  operations: CompletedOperation[];
  /**
   * The operation(s) that FAILED mid-deploy (issue #1198) — usually one.
   * ADDITIVE field, no `journalVersion` bump: an older binary reading this
   * journal simply ignores it (its replay only consults `operations`).
   * Consumed only by `cdkd rollback --revert-failed`, which is opt-in
   * because the failed resource's remote state is unknown.
   */
  failedOperations?: FailedOperation[];
}

/** On-disk shape of `rollback-journal.json`. */
export interface RollbackJournal {
  journalVersion: number;
  stackName: string;
  region: string;
  segments: RollbackJournalSegment[];
}

/** Thrown when a journal's `journalVersion` is newer than this binary knows. */
export class UnknownRollbackJournalVersionError extends Error {
  readonly foundVersion: number;
  readonly stackName: string;
  constructor(foundVersion: number, stackName: string) {
    super(
      `Rollback journal for '${stackName}' has journalVersion ${foundVersion}, ` +
        `but this cdkd only understands up to ${ROLLBACK_JOURNAL_VERSION}. ` +
        `Upgrade cdkd to roll this stack back.`
    );
    this.name = 'UnknownRollbackJournalVersionError';
    this.foundVersion = foundVersion;
    this.stackName = stackName;
  }
}

/**
 * Parse + validate a journal body. Throws
 * {@link UnknownRollbackJournalVersionError} on a newer version, and a plain
 * Error on a structurally-invalid body.
 */
export function parseRollbackJournal(bodyString: string, stackName: string): RollbackJournal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyString);
  } catch (err) {
    throw new Error(
      `Rollback journal for '${stackName}' is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Rollback journal for '${stackName}' is malformed (not an object).`);
  }
  const j = parsed as Partial<RollbackJournal>;
  if (typeof j.journalVersion !== 'number' || j.journalVersion < 1) {
    throw new Error(
      `Rollback journal for '${stackName}' has an invalid 'journalVersion' (${String(j.journalVersion)}).`
    );
  }
  if (j.journalVersion > ROLLBACK_JOURNAL_VERSION) {
    throw new UnknownRollbackJournalVersionError(j.journalVersion, stackName);
  }
  if (!Array.isArray(j.segments)) {
    throw new Error(`Rollback journal for '${stackName}' is missing a 'segments' array.`);
  }
  return {
    journalVersion: j.journalVersion,
    stackName: j.stackName ?? stackName,
    region: j.region ?? '',
    segments: j.segments,
  };
}
