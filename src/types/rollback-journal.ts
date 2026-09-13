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
 *   destroy / state destroy; a CLEAN automatic rollback settles it to a
 *   failed-only segment instead — issue #1208).
 * - Carries resolved properties, the same sensitivity class as `state.json`
 *   itself (documented in state-management.md).
 *
 * No optimistic-locking / ETag protocol: every writer holds the stack lock
 * (the deploy engine through the catch block; the rollback command for its
 * whole replay).
 */

import type { CompletedOperation, FailedOperation } from '../deployment/rollback-executor.js';
import { displaySafe, UNRENDERABLE } from '../utils/display-safe.js';

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
  | 'auto-rollback-started' // written before an automatic in-process rollback
  // issue #1208: the automatic rollback replayed CLEANLY, so the completed
  // ops are already reverted — only the failed in-flight op(s) are retained
  // (`operations: []` + `failedOperations`) so `cdkd rollback --revert-failed`
  // still works in the default deploy flow. The next successful deploy
  // deletes the journal, bounding how long this segment lingers. ADDITIVE
  // value, no journalVersion bump (reason is informational on read).
  | 'auto-rollback-clean';

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
    // The MESSAGE is sanitized; the `stackName` PROPERTY stays raw, because a
    // property is a value a caller may key on and a message is only ever
    // shown (issue #3064). `foundVersion` is already narrowed to a number by
    // the parser's guard above this throw.
    super(
      `Rollback journal for '${safeJournalText(stackName)}' has journalVersion ${foundVersion}, ` +
        `but this cdkd only understands up to ${ROLLBACK_JOURNAL_VERSION}. ` +
        `Upgrade cdkd to roll this stack back.`
    );
    this.name = 'UnknownRollbackJournalVersionError';
    this.foundVersion = foundVersion;
    this.stackName = stackName;
  }
}

/**
 * One spelling of "this value came from an S3 key or a rollback-journal record,
 * and is about to be interpolated into a message a terminal will render"
 * (issue #3064). Call it for a stack name, a parse detail, or a journal field.
 * `grep safeJournalText` answers the scope; this comment does not.
 */
function safeJournalText(value: unknown): string {
  return displaySafe(value, { asciiOnly: true }) || UNRENDERABLE;
}

/**
 * Parse + validate a journal body. Throws
 * {@link UnknownRollbackJournalVersionError} on a newer version, and a plain
 * Error on a structurally-invalid body.
 */
export function parseRollbackJournal(bodyString: string, stackName: string): RollbackJournal {
  // The ASCII allowlist, and the same reasoning `S3StateBackend.parseStateBody`
  // records for its twin (issue #3003): `rollback-journal.json` is a sibling of
  // `state.json` in the same bucket, so anyone with `s3:PutObject` writes it,
  // and every value below is either an S3 key segment or a field of that
  // unchecked cast. A stack name has a known charset, so the allowlist is a
  // no-op on every legitimate input while removing the invisibles a denylist
  // leaves behind (issue #3064).
  const shownStack = safeJournalText(stackName);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyString);
  } catch (err) {
    // V8's `SyntaxError` QUOTES the offending input, so this detail carries
    // bytes of the journal body itself. cdkd's output is line-oriented, so an
    // unsanitized newline here invents a line that reads like a real one --
    // and `formatError` prints a non-`CdkdError`'s `message` RAW, so nothing
    // downstream would have caught it.
    //
    // No empty-detail fallback, and that is measured rather than assumed: the
    // only thing that reaches here is a V8 `SyntaxError`, whose wording is
    // ASCII prose (`Unexpected token ...`, `Expected property name ...`) that
    // survives the allowlist even when the quoted input sanitises away
    // entirely. A `detail ? ... : ...` ternary here had a dead arm and a test
    // that could not reach it.
    const detail = safeJournalText(err instanceof Error ? err.message : String(err));
    throw new Error(`Rollback journal for '${shownStack}' is not valid JSON: ${detail}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Rollback journal for '${shownStack}' is malformed (not an object).`);
  }
  const j = parsed as Partial<RollbackJournal>;
  if (typeof j.journalVersion !== 'number' || j.journalVersion < 1) {
    // `String(v)` FIRST, then sanitize -- `displaySafe` maps `null` and
    // `undefined` to the empty string, so sanitizing first would print `null`
    // as nothing. That order covers ONLY those two values; a version that is
    // entirely invisible characters also sanitizes to nothing, and for that the
    // predicate's `UNRENDERABLE` fallback is what keeps the slot from reading
    // as absent. Same order and same reason as `parseStateBody`'s version arm.
    const shown = safeJournalText(String(j.journalVersion));
    throw new Error(
      `Rollback journal for '${shownStack}' has an invalid 'journalVersion' (${shown}).`
    );
  }
  if (j.journalVersion > ROLLBACK_JOURNAL_VERSION) {
    throw new UnknownRollbackJournalVersionError(j.journalVersion, stackName);
  }
  if (!Array.isArray(j.segments)) {
    throw new Error(`Rollback journal for '${shownStack}' is missing a 'segments' array.`);
  }
  return {
    journalVersion: j.journalVersion,
    stackName: j.stackName ?? stackName,
    region: j.region ?? '',
    segments: j.segments,
  };
}
