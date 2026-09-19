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
 * The per-operation shape check (issue #3140). The journal is an unchecked
 * cast beyond `journalVersion` and `segments` being an array, and the
 * executor keys EVERY lookup on `op.logicalId` -- `stateResources[..]`,
 * `orphanLogicalIds.has(..)`, the events it records -- so a non-string id
 * planted in the bucket either coerces at each lookup (`123` finds the
 * record named `'123'`) or throws a raw `TypeError` at the first one (an
 * object whose `toString` is not callable, the issue #2947 shape). Refused
 * HERE, once, so no downstream reader has to remember; the executor keeps its
 * own `typeof` guard on the one pasted command as defense-in-depth, because
 * the deploy engine's in-process rollback reaches it without this parser.
 *
 * Only the fields a lookup or a route is keyed on: `logicalId` (non-empty
 * string), `resourceType` (string), `changeType` (string -- an unknown value
 * lands on the executor's UPDATE arm by design, pinned by a case there), and
 * `physicalId` when present (string). `previousState` and the rest stay as
 * they were; a bad value there fails the op it belongs to, not the parse.
 *
 * The refusal names the INDEX and the TYPE, never the value -- there is
 * nothing to sanitize, so nothing to get wrong.
 */
function refuseMalformedOperation(shownStack: string, where: string, op: unknown): void {
  const fail = (field: string, value: unknown, expected: string): never =>
    refuseMalformed(shownStack, `${where}.${field} must be ${expected} (got ${kind(value)}).`);
  if (typeof op !== 'object' || op === null || Array.isArray(op)) {
    refuseMalformed(shownStack, `${where} must be an object (got ${kind(op)}).`);
  }
  const o = op as Record<string, unknown>;
  if (typeof o['logicalId'] !== 'string' || o['logicalId'].length === 0) {
    fail('logicalId', o['logicalId'], 'a non-empty string');
  }
  if (typeof o['resourceType'] !== 'string') fail('resourceType', o['resourceType'], 'a string');
  if (typeof o['changeType'] !== 'string') fail('changeType', o['changeType'], 'a string');
  if (o['physicalId'] !== undefined && typeof o['physicalId'] !== 'string') {
    fail('physicalId', o['physicalId'], 'a string when present');
  }
  // The NESTED records (issue #3149), each TYPE-when-present rather than
  // required: `previousState` is forwarded verbatim from the state record
  // (`deploy-engine.ts`'s `currentState.resources[logicalId]`), which
  // `parseStateBody` deliberately does not validate, so requiring a field to
  // be PRESENT here would turn a state-side tolerance into a journal-side
  // refusal of a journal cdkd itself wrote.
  //
  // What IS refused is the shape no handling can make correct: a non-object
  // `previousState` loses the whole desired bag, and every arm coalesces
  // (`desiredProps ?? {}`), so the provider is handed an EMPTY desired bag
  // over a LIVE resource -- a patch provider then removes every property.
  // (Not `undefined`: issue #3149's body said so and the review measured the
  // `??`.) A non-object `properties` hands the provider a STRING where a bag
  // belongs, and `physicalId` / `resourceType` are rendered, compared AND
  // written back into `state.json`.
  //
  // The TYPE checks do refuse a journal cdkd itself wrote off a hand-edited
  // record (a state `physicalId: 7` is tolerated by `parseStateBody` and
  // refused here) -- that is the governing clause doing its job, not an
  // exception to it. Only PRESENCE is left to the state boundary: an absent
  // field reaches every arm without a type error, and whether the arm then
  // does the RIGHT thing is a separate defect -- for `properties` it is not
  // (`desiredProps ?? {}` hands the provider an empty desired bag), which is
  // issue #3149's sibling go-to-k/cdkd#3203 rather than a reason to refuse a
  // journal cdkd itself wrote.
  const prev: unknown = o['previousState'];
  if (prev !== undefined) {
    if (typeof prev !== 'object' || prev === null || Array.isArray(prev)) {
      fail('previousState', prev, 'an object when present');
    }
    const p = prev as Record<string, unknown>;
    if (p['physicalId'] !== undefined && typeof p['physicalId'] !== 'string') {
      fail('previousState.physicalId', p['physicalId'], 'a string when present');
    }
    if (p['resourceType'] !== undefined && typeof p['resourceType'] !== 'string') {
      fail('previousState.resourceType', p['resourceType'], 'a string when present');
    }
    if (
      p['properties'] !== undefined &&
      (typeof p['properties'] !== 'object' ||
        p['properties'] === null ||
        Array.isArray(p['properties']))
    ) {
      fail('previousState.properties', p['properties'], 'an object when present');
    }
  }
  // `properties` is the COMPLETED-op twin of `attemptedProperties` below:
  // `provider.delete(logicalId, physicalId, resourceType, op.properties, ..)`
  // on the rolled-back-CREATE arm reads it for the auto-delete tag, the
  // `EmptyOnDelete` gate and final-snapshot gating, in the same argument
  // position. Refusing one and not the other would be arbitrary.
  const own: unknown = o['properties'];
  if (own !== undefined && (typeof own !== 'object' || own === null || Array.isArray(own))) {
    fail('properties', own, 'an object when present');
  }
  const attempted: unknown = o['attemptedProperties'];
  if (
    attempted !== undefined &&
    (typeof attempted !== 'object' || attempted === null || Array.isArray(attempted))
  ) {
    fail('attemptedProperties', attempted, 'an object when present');
  }
  // `oldResourceRetained` is the one nested flag cdkd COMPUTES rather than
  // forwards (`retainedOldOnReplacement.has(..)`), so a non-boolean is a
  // planted value, never a tolerated one -- and it selects the readopt arm
  // through `??`, where a truthy `"no"` skips the re-create and re-points
  // state at the old physical id.
  if (o['oldResourceRetained'] !== undefined && typeof o['oldResourceRetained'] !== 'boolean') {
    fail('oldResourceRetained', o['oldResourceRetained'], 'a boolean when present');
  }
  // Issue #2668: this value picks the PROVIDER a replacement's re-create is
  // dispatched at, so a non-string is refused here rather than coerced there.
  if (o['previousResourceType'] !== undefined && typeof o['previousResourceType'] !== 'string') {
    fail('previousResourceType', o['previousResourceType'], 'a string when present');
  }
  // NOT refused, deliberately: `provisionedBy`. cdkd forwards whatever the
  // state record carried (`newResources[..]?.provisionedBy ?? previousState
  // ?.provisionedBy`), so refusing the enum would lock `cdkd rollback` out of
  // a journal cdkd itself wrote from a record `parseStateBody` tolerates.
  // An unrecognised value routes to the SDK provider -- `=== 'cc-api'` is the
  // only test any consumer makes -- and is then persisted and rendered
  // through `safeId` / `formatAttributeValue`. It IS written into state.json
  // by the rollback even when the planted journal put it there (the review
  // corrected an earlier claim that state.json "already held it"), which
  // changes no route and no ARN. Nothing throws and nothing is
  // mis-provisioned, so the discriminator is the one above: refuse what no
  // handling can make correct, tolerate what the state boundary tolerates.
}

/** The TYPE of a JSON-derived value, for a refusal that must not echo the value. */
function kind(v: unknown): string {
  return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
}

/**
 * The one spelling of a malformed-journal refusal. `detail` is built from
 * indices, field names and `kind()` words only -- never a journal value -- and
 * every refusal names the way out, as `UnknownRollbackJournalVersionError`
 * names `Upgrade cdkd`: the journal is a sibling of `state.json`, so removing
 * that one object discards it (`cdkd destroy` sweeps it as well), and no
 * other stack is affected because `cdkd rollback` never parses another
 * stack's journal. The same text reaches the deploy engine's `Failed to write
 * rollback journal` warning, since appending a segment parses the existing
 * journal first.
 */
function refuseMalformed(shownStack: string, detail: string): never {
  throw new Error(
    `Rollback journal for '${shownStack}' is malformed: ${detail} ` +
      `Remove the stack's rollback-journal.json (next to its state.json) to discard it.`
  );
}

/**
 * Parse + validate a journal body. Throws
 * {@link UnknownRollbackJournalVersionError} on a newer version, and a plain
 * Error on a structurally-invalid body -- including, since issue #3140, a
 * segment that is not an object, an `operations` that is not an array, and an
 * operation whose `logicalId` / `resourceType` / `changeType` / `physicalId`
 * is not the string the executor keys on (see `refuseMalformedOperation`).
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
    // NOT `String(v)` first. `String()` is not total on a JSON-derived value:
    // an object whose `toString` is not callable -- `{"toString": null}`,
    // which `JSON.parse` produces from a hand-edited journal -- makes it throw,
    // and the REFUSAL would then throw a raw `TypeError` instead (issue #2947).
    // `displaySafe` absorbs that. `null` AND `undefined` are mapped to their
    // words FIRST, because `displaySafe` renders both empty and the refusal
    // would then say `UNRENDERABLE` instead of the one precise word it has --
    // and unlike `parseStateBody`'s version arm, whose guard excludes
    // `undefined` before it renders, THIS guard lets a missing field through,
    // so the missing case has to be named here or it reads as unrenderable.
    // A version that is entirely invisibles still falls to `UNRENDERABLE`,
    // which is what keeps that slot from reading as absent. The
    // `String(v)`-first spelling this used to share with `parseStateBody` is
    // the one #3067 removed from it.
    const raw: unknown = j.journalVersion;
    const shown = safeJournalText(raw === null ? 'null' : raw === undefined ? 'undefined' : raw);
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
  j.segments.forEach((segment: unknown, s) => {
    if (typeof segment !== 'object' || segment === null || Array.isArray(segment)) {
      refuseMalformed(shownStack, `segments[${s}] must be an object (got ${kind(segment)}).`);
    }
    const seg = segment as Record<string, unknown>;
    if (!Array.isArray(seg['operations'])) {
      refuseMalformed(
        shownStack,
        `segments[${s}].operations must be an array (got ${kind(seg['operations'])}).`
      );
    }
    seg['operations'].forEach((op: unknown, i) =>
      refuseMalformedOperation(shownStack, `segments[${s}].operations[${i}]`, op)
    );
    if (seg['failedOperations'] !== undefined) {
      if (!Array.isArray(seg['failedOperations'])) {
        refuseMalformed(
          shownStack,
          `segments[${s}].failedOperations must be an array when present ` +
            `(got ${kind(seg['failedOperations'])}).`
        );
      }
      seg['failedOperations'].forEach((op: unknown, i) =>
        refuseMalformedOperation(shownStack, `segments[${s}].failedOperations[${i}]`, op)
      );
    }
  });
  return {
    journalVersion: j.journalVersion,
    stackName: j.stackName ?? stackName,
    region: j.region ?? '',
    segments: j.segments,
  };
}
