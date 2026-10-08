import {
  commandHole,
  pasteableCommand,
  physicalIdShownBesideCommand,
  plainOrDescribed,
  quotedOrDescribed,
  withheldTargetClause,
} from '../../utils/pasteable-command.js';
import {
  SHORT_NAME_MAX_CODE_POINTS,
  hasAddressablePhysicalId,
} from '../../state/malformed-resources-bag.js';
import type { DeploymentEventError } from '../../types/deployment-events.js';
import { extractDeploymentEventError } from '../../types/deployment-events.js';
import type { ResourceState } from '../../types/state.js';
import type { CreateContext, ResourceDeleteResult } from '../../types/resource.js';
import { type MaskerFn } from '../../provisioning/masked-retry-logger.js';
import {
  ATOMIC_FINAL_SNAPSHOT_TYPES,
  buildFinalSnapshotIdentifier,
} from '../../provisioning/final-snapshot.js';
import {
  IDENT_MAX_CODE_POINTS,
  displayAwsMessage,
  displayIdent,
  displaySafe,
  plainIdentOr,
  safeMsg,
} from '../../utils/display-safe.js';
import { logicalIdShown, resourceTypeShown } from '../../provisioning/composite-id.js';
import { createSecretMasker, SECRET_MASK, type RecordedSecretValues } from '../secret-redaction.js';
import {
  deleteIndeterminateGuards,
  deleteSkipReason,
  deleteSkippedMessage,
} from '../delete-outcome.js';
import {
  type CompletedOperation,
  type RollbackExecutorContext,
  type RollbackReplayResult,
} from './types.js';
import type { ForeignHolding } from './journaled-orphans.js';

/**
 * Issue [#1762](https://github.com/go-to-k/cdkd/issues/1762): turn a
 * `{ outcome: 'skipped' }` delete into a thrown error at every rollback delete
 * arm.
 *
 * A skip means the resource was NOT deleted, so the rollback op did not
 * happen. Throwing routes it into the per-op accounting each arm already has —
 * `result.failures++` plus a `ROLLBACK_RESOURCE_FAILED` event and a kept
 * journal segment for the shared catch, or the local warn + `result.warnings++`
 * at the one arm whose delete is already best-effort. Both are correct and
 * neither needs a second code path; what is NOT correct is the pre-#1762
 * behavior, where every arm read a skip as a successful revert, dropped the
 * state record, and popped the segment.
 *
 * Issue [#2422](https://github.com/go-to-k/cdkd/issues/2422): it is also where
 * every rollback delete arm persists the result's indeterminate guards, as a
 * `RESOURCE_GUARD_INDETERMINATE` event with `operation: 'DELETE'` (the event
 * describes the guard, and the run's verb is already on `RUN_STARTED`).
 * Recorded BEFORE the skip check, so a guard on a delete that then skipped is
 * not lost to the throw. `guardScope` is required so that a new arm cannot
 * call this helper and drop the guard.
 */
export function throwIfDeleteSkipped(
  result: void | ResourceDeleteResult,
  logicalId: string,
  physicalId: string,
  duringClause: string,
  guardScope: RollbackDeleteGuardScope
): void {
  recordRollbackDeleteGuards(result, logicalId, physicalId, guardScope);
  const reason = deleteSkipReason(result);
  if (reason === undefined) return;
  throw new Error(deleteSkippedMessage(logicalId, physicalId, reason, duringClause));
}

/** What a rollback delete arm hands {@link throwIfDeleteSkipped} to record a guard row. */
export interface RollbackDeleteGuardScope {
  ctx: Pick<RollbackExecutorContext, 'recordEvent'>;
  stackName: string;
  /** The type the delete ran as. */
  resourceType: string;
  /** The routing layer the delete was dispatched to. */
  provisionedBy: 'sdk' | 'cc-api' | undefined;
  /**
   * The op's masker. `cdkd rollback` forwards events to the store unmasked,
   * and a replay re-resolves secrets to plaintext, so the arm masks.
   */
  mask: MaskerFn;
}

/**
 * Persist each indeterminate guard a rollback delete reported, with the
 * destroy runner's payload. `reason` names the physical id, and both go
 * through the op's masker: a resolved secret can name a resource.
 */
function recordRollbackDeleteGuards(
  result: void | ResourceDeleteResult,
  logicalId: string,
  physicalId: string,
  scope: RollbackDeleteGuardScope
): void {
  for (const guard of deleteIndeterminateGuards(result)) {
    scope.ctx.recordEvent?.({
      eventType: 'RESOURCE_GUARD_INDETERMINATE',
      stackName: scope.stackName,
      operation: 'DELETE',
      logicalId,
      resourceType: scope.resourceType,
      ...(scope.provisionedBy && { provisionedBy: scope.provisionedBy }),
      ...(physicalId && { physicalId: scope.mask(physicalId) }),
      guard: guard.guard,
      reason: scope.mask(guard.reason),
    });
  }
}

/** The `--skip-final-snapshot` flag name cited by every final-snapshot refusal (`names.ts`). */
export const SKIP_FINAL_SNAPSHOT_FLAG = '--skip-final-snapshot';

/**
 * The {@link CreateContext} every reverse-replacement re-create passes
 * (issue #1463). Both arms of that path — the create-first attempt and the
 * delete-new-first retry — revive the OLD resource from
 * `previousState.properties`, i.e. from a cdkd STATE record rather than the
 * template, so a provider pre-flight refusal has no template-side remedy and
 * must downgrade to a warning. Declared once so the two arms cannot drift.
 *
 * These are the only create call sites that can DECLARE a replay. The deploy
 * engine's five sites (CREATE, the property-driven replacement, the
 * `--recreate-via-*` destroy-then-create, the `--replace` delete-first
 * fallback, and the update-failure replacement) are all driven by freshly
 * resolved TEMPLATE properties, so they never set THIS FLAG and the refusal
 * stands where the user can edit the input. They DO pass a context — since
 * issue #1932 every create site REACHED FROM THE ENGINE carries a
 * `maskSecrets` capability — so the invariant is "no `replayingState`", not
 * "no context object". (A provider that re-creates inside its own `update()`
 * passes none, or one carrying only the masker; see `CreateContext`.)
 *
 * The remaining call sites are the providers that re-create inside their own
 * `update()` (`this.create(...)` in ACM certificate / IAM managed policy / IAM
 * role / Lambda permission / SNS subscription). Those are NOT template-driven
 * — this executor's `revert` arm calls `provider.update(...)` with
 * `previousState.properties`, so they forward a STATE record on a replay — and
 * they still pass no `replayingState` (IAM role / IAM managed policy / Lambda
 * permission forward only the masker, issue #2177; the rest pass no `CreateContext` at all), so
 * a create-side pre-flight refusal would still fire there. The constraint that
 * follows is on providers, not on this constant: a provider with a create-side
 * pre-flight refusal must not re-create inside `update()`. See `CreateContext`
 * in `src/types/resource.ts`.
 *
 * What issue [#3141](https://github.com/go-to-k/cdkd/issues/3141) changed is
 * that the INFORMATION now exists on that path — `UpdateContext` carries its
 * own `replayingState`, set by both revert arms (`replay-revert.ts` and the
 * failed-operations replay in `rollback-executor.ts`) — so such a provider
 * could build a `CreateContext` from it instead of relying on the constraint.
 * None does today: none of the five sites forwards `replayingState`. Read
 * that as a route that opened, not as a constraint that lifted.
 */
const REPLAYING_STATE_CREATE_CONTEXT: CreateContext = { replayingState: true };

/**
 * The rollback arms' {@link CreateContext}, with this op's secret masker bound
 * in (issue #1932 item 3).
 *
 * The rollback path needs this MORE than the forward deploy does, not less:
 * {@link resolveReplayProps} deliberately re-resolves every redacted
 * `{{resolve:...}}` expression back to plaintext before handing the bag to a
 * provider, so a replayed bag is guaranteed to carry the concrete secret
 * whenever the resource has one. Leaving the masker off here would have left
 * the contract applied at one caller and absent at the one whose bag is
 * provably plaintext.
 *
 * Spreads the shared constant rather than mutating it: `maskSecrets` is
 * per-op, and a module-level object is shared by every op in the run.
 *
 * Called AFTER `resolveReplayProps` has filled `secrets` at every call site, so
 * the masker sees this op's re-resolved values. `createSecretMasker` reads the
 * bag by reference on every call and so does not depend on that ordering, but
 * the ordering is what makes it correct here without relying on that.
 */
export function replayingStateCreateContext(secrets: RecordedSecretValues): CreateContext {
  return { ...REPLAYING_STATE_CREATE_CONTEXT, maskSecrets: createSecretMasker(secrets) };
}

/**
 * The {@link DeploymentEventError} a failed replay records, with this op's
 * re-resolved secrets masked out of its message (issue
 * [#2031](https://github.com/go-to-k/cdkd/issues/2031) acceptance item 2).
 *
 * `extractDeploymentEventError` copies `err.message` VERBATIM, and the events
 * store is a DURABLE sink — `deployments/{runId}.jsonl` in S3 outlives the
 * terminal the `logger.warn` beside it scrolls past, and `cdkd events` replays
 * it later. The standalone `cdkd rollback` command's `recordEvent`
 * (`src/cli/commands/rollback.ts`) masks only under a bound printing bag
 * (`maskEventTextWithBoundBags`, its failed-op replay), never with the
 * replay's re-resolved secrets, so without this the plaintext the terminal
 * line masks is persisted one statement later.
 *
 * The in-process caller (`DeployEngine.rollbackExecutorContext`) routes through
 * `maskSecretsInEvent`, but that masks with the DEPLOY's `perResourceSecrets`
 * for the resource — a different bag from the one this replay re-resolved from
 * the JOURNAL, which can name a different secret version or a reference the
 * deploy never resolved. Masking here is what makes both callers equal, and
 * double-masking is a no-op (the mask is not a key of either bag).
 *
 * `name` / `awsErrorCode` / `requestId` are deliberately left alone: they are
 * AWS-authored identifiers, not message text, and #2038 traced all three as
 * non-sensitive.
 */
export function maskedRollbackEventError(error: unknown, mask: MaskerFn): DeploymentEventError {
  const extracted = extractDeploymentEventError(error);
  // One of the replay's own refusals (#4099 review): the two collision
  // refusals are masked at CONSTRUCTION bar their re-run and `--orphan`
  // commands, which must reach the reader intact; the unroutable refusal
  // carries no physical id or name at all (logical id, types, fixed prose).
  // `ownLines` tells `cdkd events` that every line break in this message is
  // cdkd's own, so it may print them as lines (go-to-k/cdkd#4265); any other
  // message is folded there, since a provider's newline could forge a
  // `To orphan it:` row (M7 of the go-to-k/cdkd#3764 review).
  if (isOwnRemedyError(error)) return { ...extracted, ownLines: true };
  // The op's masker (issue #4037), not the bag alone: an arm that resolved no
  // secret still masks a secret-derived physical id. Identity when nothing
  // changed, so an event with nothing to mask keeps its extracted object.
  const message = mask(extracted.message);
  return message === extracted.message ? extracted : { ...extracted, message };
}

/**
 * An op the replay DECLINED, left exactly as the failed deploy left it
 * (go-to-k/cdkd#3338). Counts it in `warnings` and `skipped`, and records the
 * durable `ROLLBACK_RESOURCE_SKIPPED` event: the warn line the arm prints is
 * the only other trace, and a rollback runs during an already-failing deploy
 * whose log is the least likely thing the user still has.
 *
 * `reason` is RAW prose (it is persisted, and `cdkd events` sanitizes on the
 * way out — see {@link safe}), run through the op's `mask`. No `physicalId`:
 * the arms disagree on whether the id they hold names a live resource, and an
 * id here would point a cleanup pass at it.
 */
export function recordRollbackSkip(
  scope: {
    ctx: Pick<RollbackExecutorContext, 'recordEvent'>;
    stackName: string;
    result: Pick<RollbackReplayResult, 'warnings' | 'skipped'>;
    mask: MaskerFn;
  },
  op: Pick<CompletedOperation, 'logicalId' | 'resourceType' | 'changeType' | 'provisionedBy'>,
  reason: string
): void {
  scope.result.warnings++;
  scope.result.skipped++;
  scope.ctx.recordEvent?.({
    eventType: 'ROLLBACK_RESOURCE_SKIPPED',
    stackName: scope.stackName,
    operation: op.changeType,
    logicalId: op.logicalId,
    resourceType: op.resourceType,
    ...(op.provisionedBy && { provisionedBy: op.provisionedBy }),
    reason: scope.mask(reason),
  });
}

/**
 * Can a replay arm NOT address this resource in AWS by `physicalId`
 * (go-to-k/cdkd#4628)? The deploy's verdict (go-to-k/cdkd#3211), for the ids
 * the rollback replays against: a provider handed an absent, blank or
 * non-string id fails, or answers `*NotFound`, which a delete reads as
 * already deleted.
 *
 * A nested-stack row is exempt, keyed on the RECORD's type as `cdkd deploy`
 * keys it: that provider finds its child by name and never addresses AWS by
 * the id. The op must be one too, since the op's type picks the provider; and
 * neither the record nor the route the arm takes may be Cloud Control, which
 * addresses AWS by the id. No record, no exemption.
 */
export function rollbackCannotAddress(
  record: Pick<ResourceState, 'resourceType' | 'provisionedBy'> | undefined,
  opResourceType: string,
  route: 'sdk' | 'cc-api' | undefined,
  physicalId: unknown
): boolean {
  const byName =
    record?.resourceType === 'AWS::CloudFormation::Stack' &&
    opResourceType === 'AWS::CloudFormation::Stack' &&
    record.provisionedBy !== 'cc-api' &&
    route !== 'cc-api';
  return !byName && !hasAddressablePhysicalId({ physicalId });
}

/**
 * The id a replacement rollback names its retained NEW copy by
 * (go-to-k/cdkd#4628): the record's when usable, else the journaled op's, else
 * none. An unaddressable record reaches the `Retain` branches, which re-point
 * state and pop the segment, so the op's id is then the copy's only trace.
 */
export function retainedSurvivorId(
  record: { physicalId?: unknown },
  op: { physicalId?: unknown }
): string | undefined {
  if (hasAddressablePhysicalId(record)) return record.physicalId as string;
  if (hasAddressablePhysicalId(op)) return op.physicalId as string;
  return undefined;
}

/** The `ROLLBACK_RESOURCE_SKIPPED` reason of {@link skipUnaddressableReplay}. */
export const UNADDRESSABLE_SKIP_CAUSE =
  "Its recorded 'physicalId' is not a non-empty string, so cdkd cannot address the resource " +
  'in AWS and sent nothing for it; the rollback left it and its state record exactly as they are.';

/** The reason when only the rollback journal records the resource. */
export const UNADDRESSABLE_JOURNAL_SKIP_CAUSE =
  "Its rollback-journal entry's 'physicalId' is not a non-empty string and no state record " +
  'holds the resource, so cdkd cannot address it in AWS and sent nothing for it; if it was ' +
  'created in AWS, delete it manually.';

/**
 * Decline an op {@link rollbackCannotAddress} answered `true` for: warned and
 * recorded as a skip (exit 2), no provider call, state untouched. A skip, as
 * this replay already declines an op it cannot address (`replayDelete`'s
 * missing id, `skip-failed-unknown`) and as `cdkd deploy` skips such a DELETE.
 * The id is never printed: it identifies nothing. `source` says where the id
 * came from: a state record the user can repair, or a journal entry alone
 * (a failed CREATE no record holds), which the skip removes, so the remedy is
 * a manual check, as on `skip-failed-unknown`.
 */
export function skipUnaddressableReplay(
  scope: Parameters<typeof recordRollbackSkip>[0],
  logger: Pick<RollbackExecutorContext['logger'], 'warn'>,
  op: Parameters<typeof recordRollbackSkip>[1],
  what: string,
  source: 'record' | 'journal' = 'record'
): void {
  // Described when not plain: the line names `cdkd` commands
  // (go-to-k/cdkd#4214).
  if (source === 'journal') {
    logger.warn(
      safeMsg`  Rollback: Cannot ${what} ${shownLogicalId(op.logicalId)} (${refusalResourceType(op.resourceType)}) ` +
        `\u2014 its rollback journal entry has no non-empty string 'physicalId' and no state ` +
        `record holds it, so cdkd cannot address it in AWS and sent nothing for it. If it was ` +
        `created in AWS, delete it manually.`
    );
    recordRollbackSkip(scope, op, UNADDRESSABLE_JOURNAL_SKIP_CAUSE);
    return;
  }
  logger.warn(
    safeMsg`  Rollback: Cannot ${what} ${shownLogicalId(op.logicalId)} (${refusalResourceType(op.resourceType)}) ` +
      `\u2014 its state record has no non-empty string 'physicalId', so cdkd cannot address it in ` +
      `AWS and sent nothing for it. The resource and its state record are left exactly as they ` +
      `are. Repair the record's 'physicalId' (inspect it with \`cdkd state show\`), then ` +
      `re-converge it with \`cdkd deploy\`.`
  );
  recordRollbackSkip(scope, op, UNADDRESSABLE_SKIP_CAUSE);
}

/**
 * go-to-k/cdkd#4705: ask `ctx.createdResourceHolder` (the automatic rollback
 * only) before deleting a resource the failed deploy created. `true` when
 * another record holds it, or the check could not answer: the resource is
 * kept, warned about naming who holds it, and recorded as a skip (the journal
 * keeps it). A thrown check is an unreadable answer (fail closed).
 */
export async function keptForAnotherHolder(
  scope: Parameters<typeof recordRollbackSkip>[0] & {
    ctx: Pick<RollbackExecutorContext, 'createdResourceHolder' | 'createdResourceRetryCommand'>;
  },
  logger: Pick<RollbackExecutorContext['logger'], 'warn'>,
  op: Parameters<typeof recordRollbackSkip>[1],
  physicalId: string
): Promise<boolean> {
  const ask = scope.ctx.createdResourceHolder;
  if (ask === undefined) return false;
  let holding: ForeignHolding;
  try {
    holding = await ask(op.resourceType, physicalId);
  } catch {
    holding = { kind: 'unreadable', what: "the other stacks' state records (the check failed)" };
  }
  if (holding === undefined) return false;
  const why =
    holding.kind === 'held'
      ? `${holding.by} holds it`
      : `${holding.what}, so it is not known whether another deployment owns it`;
  const retry =
    holding.kind === 'unreadable' && holding.retryable === true
      ? scope.ctx.createdResourceRetryCommand
      : undefined;
  logger.warn(
    safeMsg`  Rollback: Keeping created resource ${shownLogicalId(op.logicalId)} (${refusalResourceType(op.resourceType)}) ` +
      safeMsg`\u2014 ${why}. The failed deploy may have adopted a resource that existed under its name, so the rollback does not delete it; the rollback journal keeps it.` +
      (retry === undefined ? '' : safeMsg` Once S3 can be read, finish the rollback with: ${retry}`)
  );
  recordRollbackSkip(
    scope,
    op,
    'Another state record holds this resource, or it could not be checked, so the rollback did not delete it.'
  );
  return true;
}

/**
 * Which provisioning layer a delete must be judged against: the CURRENT
 * state record wins (it is what state says AWS holds right now), with the
 * journaled op's routing as the legacy-state fallback. Shared by both
 * Snapshot paths below so the cc-api test cannot drift between them.
 */
export function effectiveProvisionedBy(
  record: Pick<ResourceState, 'provisionedBy'> | undefined,
  fallbackProvisionedBy?: 'sdk' | 'cc-api'
): 'sdk' | 'cc-api' | undefined {
  return record?.provisionedBy ?? fallbackProvisionedBy;
}

/**
 * One spelling of "this value came from a rollback-journal record, and is
 * about to be interpolated into a message a terminal will render" (issue
 * #3092). The journal is a sibling of `state.json` in the same bucket,
 * writable by anyone with `s3:PutObject` and validated no more than an
 * unchecked cast; cdkd's output is line-oriented, so an injected newline
 * invents a line that reads like a real one. This executor runs under the
 * standalone `cdkd rollback` AND under the deploy engine's automatic
 * rollback, so its lines print on every failed deploy.
 *
 * `displayIdent`: the ASCII allowlist with `UNRENDERABLE` for a value that
 * sanitizes to nothing, a length cap, and a visible boundary (a JSON-quoted
 * rendering) for a value that is not a plain identifier -- the all-ASCII
 * `X (AWS::RDS::DBInstance) -- already reverted` the allowlist lets through.
 * A logical id, a CFn resource type and a change type all have known
 * charsets. Call it for those; `grep safe(` answers the scope.
 *
 * NOT for a value that is USED rather than shown -- the ids passed to a
 * provider call, the keys into `stateResources`, the `msg` a classifier reads.
 * NOT for the `reason` / `survivorReason` strings handed to `ctx.recordEvent`:
 * those are PERSISTED into `deployments/*.jsonl` raw and `cdkd events`
 * sanitizes them on the way out, so sanitizing here would put a display
 * transform on a stored value and double it at render (the go-to-k/cdkd#2170
 * direction). NOT for free-form error text either: an SDK message legitimately
 * carries non-ASCII, so a site rendering one calls `displaySafe()` directly and
 * takes the DENYLIST, as `formatError` does for a `cause`.
 */
export function safe(value: unknown): string {
  return displayIdent(value);
}

/**
 * The three refusal OBJECTS the replay creates that end on
 * {@link orphanRemedy}'s labelled LINE, registered at their throw sites by
 * {@link ownRemedyError}.
 *
 * Keyed on IDENTITY, not on an error code (M7 of the go-to-k/cdkd#3764
 * review): `NAMED_REPLACEMENT_COLLISION` is not private to the replay —
 * `deploy-engine.ts` throws it too, with the raw logical id, resource type and
 * AWS text in the message, and a provider call that re-enters the deploy
 * engine can deliver that error to the replay's per-op catch with its code
 * intact. The review measured it through a nested-stack UPDATE revert; since
 * go-to-k/cdkd#3829 that revert replays the child's journal instead, but the
 * key must not depend on which routes exist today. A code-keyed trust
 * preserved that message's newlines and printed a forged `To orphan it:` row.
 * A `WeakSet` holds no error alive and cannot be satisfied by any object this
 * module did not register.
 */
const OWN_REMEDY_ERRORS = new WeakSet<Error>();

/** Is this one of the refusals {@link ownRemedyError} registered? */
function isOwnRemedyError(error: unknown): boolean {
  return error instanceof Error && OWN_REMEDY_ERRORS.has(error);
}

/**
 * The per-op failure text through the op's masker, except for one of this
 * module's own refusals, which {@link maskedRollbackEventError} explains: a
 * short id needle would otherwise cut into their pasteable commands.
 */
export function maskedFailureText(prefix: string, error: unknown, mask: MaskerFn): string {
  const text = rollbackFailureText(error);
  return prefix + (isOwnRemedyError(error) ? text : mask(text));
}

/** Register an error {@link rollbackFailureText} may render per line. */
export function ownRemedyError<E extends Error>(error: E): E {
  OWN_REMEDY_ERRORS.add(error);
  return error;
}

/**
 * A caught rollback error's text for the per-op `Rollback failed for` line.
 *
 * Free-form text takes `displaySafe` on the WHOLE, which folds a newline into
 * a space: a newline in an AWS message is the line forgery that render exists
 * to remove (issue #3092). The exception is an error in
 * {@link OWN_REMEDY_ERRORS}, bounded by IDENTITY: only the replay's own
 * refusals registered through {@link ownRemedyError} qualify, and every value in them is sanitized at the
 * throw (described or `safe()` for identifiers, {@link collisionLine} for the
 * AWS text), so their line breaks are cdkd's own, and rendering them per LINE keeps the
 * `To orphan it:` remedy on a line of its own on the terminal (M1 of the
 * go-to-k/cdkd#3764 review). Each line is still sanitized. An error that
 * merely carries the same code — `deploy-engine.ts`'s collision refusal, or a
 * provider error — is flattened whole.
 */
function rollbackFailureText(error: unknown): string {
  if (error instanceof Error && OWN_REMEDY_ERRORS.has(error)) {
    return error.message
      .split('\n')
      .map((line) => displaySafe(line))
      .join('\n');
  }
  return displaySafe(error instanceof Error ? error.message : String(error));
}

/**
 * The AWS rejection text quoted in the collision refusal: sanitized, every
 * run of BLANK-RENDERING characters collapsed to one space, and capped (M8 and
 * M10 of the go-to-k/cdkd#3764 review). The refusal's labelled `To orphan it:`
 * line comes straight after this text, and `displaySafe` keeps runs of spaces
 * AND the invisible formatters (its header records them as a residual), so a
 * message padded with either could wrap on screen into a lookalike row
 * directly above the genuine one — the terminal-wrap route `plainIdent` closes
 * for a stack name. A blank-rendering character is matched by CATEGORY, not
 * by a list (the M10 follow-up measured a four-code-point list leaving about
 * forty blank columns): whitespace (`\s`), a default-ignorable code point
 * (`\p{Default_Ignorable_Code_Point}`: the zero-width and bidi marks,
 * U+2061-U+2064, U+061C, U+00AD, U+180E, U+034F, and the Hangul fillers
 * U+115F / U+1160 / U+3164 / U+FFA0, which render one column wide), a format
 * character (`\p{Cf}`, for the ones that are NOT default-ignorable, such as
 * the interlinear annotation anchors U+FFF9-U+FFFB), and U+2800, the braille
 * blank, which is in neither category. The class overlaps the one
 * `outputs-export-alias/secret-scan.ts` scans with, but is not the same. Collapsing
 * removes the padding; the cap is `displayAwsMessage`'s.
 */
function collisionText(msg: string): string {
  // The caller MASKS `msg` first: `maskSecretsInText` matches a secret's exact
  // spelling, so collapsing a whitespace run or cutting the text before it ran
  // would turn an echoed secret into a spelling the mask no longer finds.
  return displayAwsMessage(
    displaySafe(msg).replace(/[\s\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]{2,}/gu, ' ')
  );
}

/**
 * {@link collisionText} inside a JSON string boundary, for the refusals'
 * `Underlying collision:` line (go-to-k/cdkd#4214). That line carries no
 * command, but the provider's text can echo a payload logical id or name, and
 * printed bare a `$( )` or a `;` in it ran when the line was pasted. Inside
 * the boundary it is the classified display residual every `displayIdent`
 * render shares (go-to-k/cdkd#3950), and JSON escaping keeps an embedded `"`
 * from closing it.
 */
export function collisionLine(maskedMsg: string): string {
  return JSON.stringify(collisionText(maskedMsg));
}

/**
 * The one shape of `op.logicalId` this executor will print INSIDE a command it
 * invites the user to paste (`cdkd rollback --orphan <id>`): CloudFormation's
 * own logical-id charset and length. Stricter than "`safe()` is the identity
 * on it" on purpose -- `~user` and `=x` are plain identifiers the shell
 * expands before cdkd sees them (issue #3092 review). Not a display rule: a
 * legitimate id the executor merely SHOWS still goes through `safe()`.
 */
const PASTEABLE_LOGICAL_ID = /^[A-Za-z0-9]{1,255}$/;

/**
 * How the three reverse-replacement refusals NAME the op in their prose: the
 * logical id when {@link PASTEABLE_LOGICAL_ID} admits it, a description
 * otherwise. Their block also carries {@link orphanRemedy}'s command (and
 * prose naming `cdkd deploy` / `cdkd rollback`), and a block that displays an
 * untrusted value carries no pasteable command (go-to-k/cdkd#3950's S1 rule):
 * a `displayIdent`-bounded `$( )` id still runs when the sentence is pasted
 * into zsh, which the ` (<type>)` after it does not stop. The same predicate
 * as the command's, so an id is either on both or on neither.
 */
export function refusalLogicalId(logicalId: unknown): string {
  return typeof logicalId === 'string' && PASTEABLE_LOGICAL_ID.test(logicalId)
    ? logicalId
    : 'a resource whose logical id is not a plain CloudFormation logical id';
}

/**
 * How a message that also names a `cdkd` command or a `--flag` NAMES a logical
 * id, outside the three `--orphan` refusals ({@link refusalLogicalId}): itself
 * when `isPasteableIdent` admits it (`composite-id.ts`'s `logicalIdShown`,
 * which keeps a hyphenated cdkd id legible), a description otherwise
 * (go-to-k/cdkd#4214). `typeof` first, as {@link refusalLogicalId} does.
 */
export function shownLogicalId(logicalId: unknown): string {
  return typeof logicalId === 'string'
    ? logicalIdShown(logicalId)
    : 'a logical id that is not a plain identifier';
}

/** {@link shownLogicalId} for a journal `changeType`. */
export function shownChangeType(changeType: unknown): string {
  return typeof changeType === 'string'
    ? plainOrDescribed(changeType, 'change type')
    : 'a change type that is not a plain identifier';
}

/**
 * How the three reverse-replacement refusals, and the unroutable `reason`
 * their first line quotes, name a resource TYPE: itself when it is a plain
 * CloudFormation type name (`composite-id.ts`'s `resourceTypeShown` rule), a
 * description otherwise. The type is journal text, and the line it sits on
 * names `cdkd deploy` or `cdkd rollback` (go-to-k/cdkd#4214, the S1 rule of
 * {@link refusalLogicalId}). `typeof` first: the in-process caller reaches
 * this executor without the journal parser.
 */
export function refusalResourceType(resourceType: unknown): string {
  return typeof resourceType === 'string'
    ? resourceTypeShown(resourceType)
    : 'a resource type that is not a plain identifier';
}

/**
 * `'value'` when `plainIdentOr` admits it — every character literal inside a
 * single quote, and none of them a `'` — and a description otherwise, for a
 * template- or state-sourced value quoted in a refusal that names a `cdkd`
 * command (go-to-k/cdkd#4214). Wider than `quotedOrDescribed`, whose
 * `isPasteableIdent` refuses the `/` a secret name or the `.` path a property
 * legitimately carries: this value is SHOWN, never pasted as an argument.
 */
export function quotedPlainOr(value: unknown, what: string): string {
  // A property path carries `[<n>]` segments (`walk` builds `${path}[${i}]`),
  // which `PLAIN_IDENT` refuses: stripped before the test, since a `[` or `]`
  // is literal inside the single quotes (review of #4270).
  // The cap on the WHOLE value too: `plainIdentOr` caps only what is left
  // after the indexes are stripped (review of #4270).
  if (typeof value !== 'string' || Array.from(value).length > IDENT_MAX_CODE_POINTS) {
    return `a ${what} that is not a plain identifier`;
  }
  const unindexed = value.replace(/\[\d+\]/g, '');
  return unindexed !== '' && plainIdentOr(unindexed, '') === unindexed
    ? `'${value}'`
    : `a ${what} that is not a plain identifier`;
}

/** What {@link refusalPhysicalId} prints for a physical id it will not show. */
const DESCRIBED_PHYSICAL_ID = 'a physical id that is not a plain identifier';

/**
 * How the collision refusals name a physical id (already MASKED by the
 * caller): as `physicalIdShownBesideCommand` (`src/utils/pasteable-command.ts`)
 * decides, with its mask arm on, and {@link DESCRIBED_PHYSICAL_ID} when it
 * declines. That helper owns the rule (go-to-k/cdkd#4265): no leading `-`,
 * inert with its quotes stripped, `displayIdent`'s identity at the role-ARN
 * cap, and an id whose only non-plain characters are {@link SECRET_MASK} kept
 * in its JSON render (`"***"`). The id is state or journal text on a line that
 * names a `cdkd` command (go-to-k/cdkd#4214), where a JSON-quoted `$( )` id
 * runs when pasted into zsh.
 */
export function refusalPhysicalId(maskedPhysicalId: unknown): string {
  // The repo's one rule (`physicalIdShownBesideCommand`, shared with the
  // delete-skip sentence since go-to-k/cdkd#4265), with the mask arm on.
  return (
    physicalIdShownBesideCommand(maskedPhysicalId, { maskToken: SECRET_MASK }) ??
    DESCRIBED_PHYSICAL_ID
  );
}

/**
 * The pointer a collision refusal appends when it described a physical id,
 * so the operator can still find the resource it would name.
 */
export function describedPhysicalIdPointer(...shown: readonly string[]): string {
  return shown.includes(DESCRIBED_PHYSICAL_ID)
    ? ` A physical id is left out of the prose above: it is not a plain identifier — ` +
        // No apostrophe: a `'` here would pair with one inside a JSON-quoted
        // display on the diagnosis or collision line below and leave what
        // sits between them bare when the block is pasted.
        `read it from the rollback journal or from the state record of the stack.`
    : '';
}

/**
 * The `cdkd rollback --orphan` remedy the three reverse-replacement refusals
 * end on: a labelled LAST line of its own (`line`), and the sentence the prose
 * carries when the id on it is a hole (`clause`, empty otherwise).
 *
 * ONE predicate decides both halves — {@link PASTEABLE_LOGICAL_ID}, stricter
 * than `safe()` being the identity on the id: identity already refuses the
 * TRIM (an id differing from a legitimate one only by a leading invisible
 * renders identically to it), the boundary quoting, the cap and the
 * placeholder, but a plain `~user` or `=x` is identity under `safe()` and is
 * expanded by the user's shell before cdkd sees it. `typeof` first:
 * `RegExp.test` coerces, so a non-string `logicalId` would otherwise print
 * `--orphan undefined` / `123`. `parseRollbackJournal` refuses one since issue
 * #3140, but the deploy engine's in-process rollback reaches this executor
 * without that parser — defence in depth.
 *
 * Its OWN line, and the message's last, because the command used to run
 * straight into prose (`--orphan RealDB to leave...`, `--orphan RealDB: one
 * op failure...`), so an over-selection passed `to` as the stack argument —
 * the one shape `pasteable-command.ts`'s contract rules out (M1 of the
 * go-to-k/cdkd#3764 review). NO backtick wrapper, and the withheld
 * placeholder is QUOTED (go-to-k/cdkd#3436): pasted WITH its wrapper a
 * backtick span is command SUBSTITUTION, a worse wrapper than `'...'` and one
 * the source fence cannot see. The explanation of a hole goes in the PROSE,
 * before the line, so the line stays pasteable as a whole.
 *
 * Inside a nested child's revert (`nestedChildRevert`) there is NO line: no
 * `cdkd rollback --orphan` reaches that replay, so a printed one would send
 * the operator round the same refusal (go-to-k/cdkd#3845). `offered` tells the
 * caller whether its prose may point at "the command below".
 */
export function orphanRemedy(
  logicalId: unknown,
  ctx: Pick<RollbackExecutorContext, 'nestedChildRevert' | 'nestedChildStack' | 'region'>
): { readonly offered: boolean; readonly clause: string; readonly line: string } {
  if (ctx.nestedChildRevert === true) {
    // A described id still needs a way to find it, even with no command here.
    const idPointer =
      typeof logicalId === 'string' && PASTEABLE_LOGICAL_ID.test(logicalId)
        ? ''
        : ` The id is left out of the prose above: it is not a plain CloudFormation logical ` +
          `id — read it from cdkd events.`;
    return {
      offered: false,
      // No apostrophe (go-to-k/cdkd#4214): the collision refusals put a
      // JSON-quoted display on the lines below this one, and a `'` here pairs
      // with one inside it when the block is pasted, leaving a `$( )` bare.
      clause:
        ` This op is reverted inside the revert of a nested stack for the rollback of its ` +
        `parent, where cdkd rollback --orphan cannot reach it: resolve the cause and re-run the ` +
        `rollback of the top-level stack, or re-deploy the top-level stack.${idPointer}`,
      line: '',
    };
  }
  const pasteable = typeof logicalId === 'string' && PASTEABLE_LOGICAL_ID.test(logicalId);
  const idClause = pasteable
    ? ''
    : ` The id is left out of the prose above and of that command: it is not a plain ` +
      `CloudFormation logical id, so a pasted command could be reshaped by the shell or name a ` +
      `different resource — read it from cdkd events and fill the quoted hole.`;
  // A nested child's own rollback: only a rollback of the CHILD honours
  // `--orphan` for its ops, so the command names it (go-to-k/cdkd#3859). A
  // stack-less one resolves to the parent, which refuses (a failed UPDATE row,
  // the #3754 guard), replays the child without `--orphan` (`--revert-failed`),
  // or never replays it (a failed CREATE row).
  const target =
    ctx.nestedChildStack === undefined
      ? undefined
      : pasteableCommand('cdkd rollback', [
          { value: ctx.nestedChildStack, hole: 'stack', opts: { plainIdent: true } },
          {
            flag: '--stack-region',
            value: ctx.region,
            hole: 'region',
            opts: { plainIdent: true, maxCodePoints: SHORT_NAME_MAX_CODE_POINTS },
          },
        ]);
  const stackClause =
    target === undefined
      ? ''
      : // No apostrophe, for the reason the nested-revert clause above gives.
        ` This is the rollback of the nested stack itself, and only a rollback of the nested ` +
        `stack itself honours --orphan for this op, so the command names it.` +
        withheldTargetClause(target, 'stack', 'cdkd rollback', 'The name of the nested stack');
  // The stack-less fallback goes through the shared builder too, so it carries
  // the run's typed `--profile` / `--state-bucket` / `--state-prefix`
  // (go-to-k/cdkd#4177).
  const rollbackVerb = (target ?? pasteableCommand('cdkd rollback')).command;
  return {
    offered: true,
    clause: `${stackClause}${idClause}`,
    line: `\nTo orphan it: ${rollbackVerb} --orphan ${pasteable ? logicalId : commandHole('id')}`,
  };
}

/**
 * How a message in this replay names "re-run the rollback". In a nested child
 * engine's OWN rollback a stack-less `cdkd rollback` resolves to the parent,
 * which does not resume this op as the message means (go-to-k/cdkd#3859), so
 * there the phrase names the nested stack — as a DISPLAYED name, never as a
 * command: the one pasteable command a refusal carries is
 * {@link orphanRemedy}'s labelled line. `quotedOrDescribed`, not `safe()`: the
 * name sits beside that labelled line, so a padded one must not be printed.
 */
export function rerunRollbackPhrase(
  ctx: Pick<RollbackExecutorContext, 'nestedChildStack'>,
  topLevel: string
): string {
  return ctx.nestedChildStack === undefined
    ? topLevel
    : `the rollback of the nested stack ${quotedOrDescribed(ctx.nestedChildStack, 'nested stack name')} itself`;
}

/**
 * `UpdateReplacePolicy: Snapshot` on a rollback's delete-of-the-NEW-resource
 * (issue #1354): honor it where it costs nothing — an atomic-final-snapshot
 * type on the SDK route gets a generated identifier threaded into the delete
 * context. Every other Snapshot shape (pre-delete types, cc-api routing)
 * keeps the plain delete DELIBERATELY: the rollback executor's delete-new is
 * load-bearing for same-name re-creation (refusing it would strand the
 * revert half-done), and the new resource was created by the very deploy
 * being reverted. Recorded as a scope decision on issue #1354.
 *
 * NOT the same call as the rolled-back-CREATE path
 * ({@link prepareCreateRollbackFinalSnapshot}, issue #1358): there the
 * resource is being deleted under `DeletionPolicy` and a shape cdkd cannot
 * snapshot is REFUSED rather than plain-deleted, because the user is losing
 * a resource that existed before this op — nothing downstream depends on
 * that delete succeeding.
 */
export function rollbackFinalSnapshotId(
  resourceType: string,
  record: Pick<ResourceState, 'physicalId' | 'updateReplacePolicy' | 'provisionedBy'>,
  fallbackProvisionedBy?: 'sdk' | 'cc-api'
): string | undefined {
  if (record.updateReplacePolicy !== 'Snapshot') return undefined;
  if (!ATOMIC_FINAL_SNAPSHOT_TYPES.has(resourceType)) return undefined;
  if (effectiveProvisionedBy(record, fallbackProvisionedBy) === 'cc-api') return undefined;
  return buildFinalSnapshotIdentifier(record.physicalId, resourceType);
}

/**
 * `UpdateReplacePolicy: Retain` on the resource a replacement CREATED — the
 * copy a rollback would otherwise destroy (issue
 * [#2598](https://github.com/go-to-k/cdkd/issues/2598)).
 *
 * Reads the CURRENT record, i.e. the one the replacing deploy wrote from the
 * template it was applying (`extractTemplateAttributes`), so the attribute
 * consulted is the one that was in force when the new copy was created. Its
 * `Snapshot` sibling, {@link rollbackFinalSnapshotId}, reads the same field of
 * the same record — `Retain` and `Snapshot` are alternative values of ONE
 * attribute, so the two can never both apply.
 *
 * **`UpdateReplacePolicy`, NOT `DeletionPolicy`, and that is measured, not
 * reasoned.** The repo refuses a CloudFormation-parity claim taken on
 * folklore, and the AWS documentation answers nothing here: every sentence on
 * both attribute pages, in the API reference and in the release notes
 * describes the OLD resource, never the new copy's fate during a rollback. A
 * live four-variant A/B (2026-09-05, us-east-1: a forced `AWS::SSM::Parameter`
 * replacement plus a deterministically failing sibling, rolled back) settled
 * it:
 *
 * | DeletionPolicy | UpdateReplacePolicy | new copy  | decisive event   |
 * | -------------- | ------------------- | --------- | ---------------- |
 * | (none)         | (none)              | DELETED   | `DELETE_COMPLETE` |
 * | Retain         | (none)              | DELETED   | `DELETE_COMPLETE` |
 * | (none)         | Retain              | SURVIVED  | `DELETE_SKIPPED`  |
 * | Retain         | Retain              | SURVIVED  | `DELETE_SKIPPED`  |
 *
 * Row 2 alone refutes "`DeletionPolicy` governs it"; row 3 alone refutes
 * "neither — always deleted". The old copy was restored intact in all four,
 * and both outcomes land in `UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS`.
 *
 * A retained new copy is ORPHANED OUT of the stack, not kept as a managed
 * resource — the A/B proved it by deleting the whole stack afterwards and
 * finding the retained parameter still alive. So every caller below leaves NO
 * state record naming the survivor: the two arms that can complete point state
 * at the old resource exactly as they already did, and the survivor becomes
 * untracked. That is the same disposition the deploy engine gives a
 * `Retain`-orphaned OLD resource, so the two directions agree.
 *
 * LIMIT OF THAT EVIDENCE, stated so a later reader does not over-read it: all
 * four variants carried the SAME policy in both template versions, so the A/B
 * pinned WHICH ATTRIBUTE wins and did NOT discriminate which template's copy
 * of it is read. This function reads the current record for the reasons above
 * (it is the one the new copy was created under, and it matches the
 * `Snapshot` sibling and both CREATE-rollback arms), not because the A/B
 * settled that question.
 */
export function rollbackRetainsNewResource(
  record: Pick<ResourceState, 'updateReplacePolicy'> | undefined
): boolean {
  return record?.updateReplacePolicy === 'Retain';
}

/**
 * The two sentences a `UpdateReplacePolicy: Retain` survivor needs: the `⚠`
 * terminal warning and the compact `reason` that rides on the durable
 * `ROLLBACK_RESOURCE_SUCCEEDED` event.
 *
 * ONE function because the two must not drift apart. Both replacement-rollback
 * retain arms produced these by hand, four near-identical copies, and the
 * failure mode a reviewer named is precise: the warn and the DURABLE record
 * disagreeing about which id survived. Deriving both from one set of inputs
 * makes that unrepresentable. The shapes stay deliberately different -- the
 * warn carries the cost/`cdkd destroy` guidance a human reads once, the reason
 * stays compact for a `--json` consumer -- so this is one input set, not one
 * string.
 *
 * `stateClause` is the only thing that differs between the two arms (the
 * readopt arm restores the old id; the create-first arm records a re-created
 * one), so it is a parameter rather than a branch in here.
 *
 * NOT used by the delete-failed survivor a few lines down: that one is an
 * orphan by OUTCOME rather than by policy, and says so.
 */
export function retainedSurvivorMessages(
  logicalId: string,
  resourceType: string,
  survivorPhysicalId: string,
  stateClause: string,
  /**
   * The op's masker (issue #4037), applied to the RAW id and clause before
   * either half renders them: `displaySafe` could change the spelling a
   * needle matches. Identity by default.
   */
  mask: MaskerFn = (text) => text
): { warn: string; reason: string } {
  const survivorId = mask(survivorPhysicalId);
  const clause = mask(stateClause);
  // The two halves have different READERS, so the same inputs take different
  // treatment (issue #3092). `warn` is a terminal line: its journal-sourced
  // `logicalId` / `resourceType` take `safe()`, and `survivorPhysicalId` /
  // `stateClause` -- a live physical id and prose the caller assembled around
  // another one -- take the denylist. `reason` is PERSISTED into
  // `deployments/*.jsonl` raw and `cdkd events` sanitizes it at render, so it
  // keeps every input verbatim; sanitizing it here would put a display
  // transform on a stored value. Callers therefore pass RAW values and this
  // function owns the split, rather than each caller remembering which half
  // wants which.
  return {
    warn:
      `  ⚠ ${safe(logicalId)} (${safe(resourceType)}) has UpdateReplacePolicy: Retain — the ` +
      `replacement's new physical resource (${displaySafe(survivorId)}) is RETAINED by this ` +
      `rollback and is no longer tracked by cdkd: it keeps running and incurring cost, ` +
      // No command on this line (go-to-k/cdkd#4214): it displays journal and
      // state values, and a displayed `$( )` value runs beside a pasted
      // command. Destroying the stack is named in words instead.
      `and destroying the stack will not remove it. Delete it yourself once you no longer ` +
      `need it. ${displaySafe(clause)}`,
    reason:
      `UpdateReplacePolicy: Retain kept the replacement's new ${resourceType} ` +
      `(${survivorId}); it is live, still billing, and no longer tracked by ` +
      `cdkd. ${clause}`,
  };
}
