import { logicalIdShown, resourceTypeShown } from '../../../provisioning/composite-id.js';
import {
  pasteableCommand,
  plainOrDescribed,
  withheldTargetClause,
} from '../../../utils/pasteable-command.js';
import { getLogger } from '../../../utils/logger.js';
import { refusesFinalSnapshot } from '../../../provisioning/final-snapshot.js';
import {
  displacedOpClause,
  displacedPhysicalIdShown,
  type DisplacedOp,
} from '../../../deployment/nested-child-journal.js';
import { confirmOrRefuse } from '../confirm-prompt.js';
import {
  isJournaledOrphan,
  isReplacementOrphan,
  replacementNeverSwapped,
  resolveReplacementOldType,
  type FailedOperation,
  type RollbackPlanItem,
  type FailedOpPlanItem,
} from '../../../deployment/rollback-executor.js';
import { type ImportedResourceMark } from '../../../types/rollback-journal.js';
import {
  displayIdent,
  displaySafe,
  isPasteableIdent,
  ROLE_ARN_MAX_CODE_POINTS,
  STACK_REF_MAX_CODE_POINTS,
} from '../../../utils/display-safe.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';

/**
 * The `Re-run with: cdkd rollback` line that a warning and two refusals here
 * end in. The name can come from a journal S3 key, and it sits beside a
 * labelled line, so it is named only when it is a plain identifier, and a hole
 * is explained (go-to-k/cdkd#3773).
 */
export function rerunRollback(stackName: string): string {
  const rerun = pasteableCommand('cdkd rollback', [
    { value: stackName, hole: 'stack', opts: { plainIdent: true } },
  ]);
  return (
    withheldTargetClause(rerun, 'stack', 'cdkd rollback', "This stack's name") +
    `\nRe-run with: ${rerun.command}`
  );
}

/**
 * go-to-k/cdkd#6247: the tail of a failed rollback when a custom resource's
 * handler failed in AWS Emulator's own Lambda runtime, which `cdkd rollback`
 * uses because it never reads the CDK app. That runtime fails CDK's own
 * provider functions every time, so {@link rerunRollback}'s `Re-run with:`
 * would loop; the way out is a deploy forward from the app, which runs the
 * handlers locally. `--no-local-custom-resources` would not help either: it
 * sends them to the same runtime.
 */
export function deployForwardForEmulatorCustomResources(
  stackName: string,
  logicalIds: readonly string[]
): string {
  const deploy = pasteableCommand('cdkd deploy', [
    { value: stackName, hole: 'stack', opts: { plainIdent: true } },
  ]);
  const named = logicalIds.map((id) => plainOrDescribed(id, 'logical id')).join(', ');
  return (
    ` Custom resource(s) ${named} failed in AWS Emulator's own Lambda runtime, which cdkd ` +
    `rollback uses because it never reads the CDK app, so a re-run fails the same way. Deploy ` +
    `forward instead, from the app's directory with the version you want to keep (Docker ` +
    `running), which runs the handlers locally.` +
    withheldTargetClause(deploy, 'stack', 'cdkd deploy', "This stack's name") +
    `\nDeploy forward with: ${deploy.command}`
  );
}

/**
 * The error text of a state-backend or lock call, for a warning printed in the
 * run that ends in {@link rerunRollback}'s labelled line. The backend's message
 * names the stack and region, both taken from a journal S3 key, and it
 * RE-SPELLS them (quoted, folded, cut), so a substitution on the raw value
 * cannot find them. When either is not a plain identifier the text is withheld
 * whole: its padding could otherwise wrap on screen into a counterfeit
 * `Re-run with:` row above the real one (go-to-k/cdkd#3760).
 */
export function backendErrorText(error: unknown, stackName: string, region: string): string {
  if (!isPasteableIdent(stackName) || !isPasteableIdent(region)) {
    return 'its error text names a stack or region that is not a plain identifier, so it is not shown';
  }
  return displaySafe(describeAwsFailure(error).detail);
}

/**
 * `<stack> (<region>)` for the lines of a run that can end in
 * {@link rerunRollback}'s labelled `Re-run with:` row: the plan header, the
 * confirmation prompt and both completion lines (go-to-k/cdkd#3760, option 1).
 * Each value is named only when `isPasteableIdent` admits it and described
 * otherwise. `safeStack` kept interior spaces, so a padded journal-key name
 * could wrap on screen into a counterfeit `Re-run with:` row a few rows from
 * the real one, and the real one WITHHOLDS exactly such a name, so the
 * operator fills its hole from these lines. The completion line prints in the
 * same run as a failed-persist warning's `Re-run with:` row. A stack name and
 * region cdkd writes are always plain, so only a planted key is described.
 */
export function stackRegionShown(stackName: string, region: string): string {
  return `${plainOrDescribed(stackName, 'stack name')} (${plainOrDescribed(region, 'region')})`;
}

/** Whether {@link stackRegionShown} names both values. */
export function stackRegionIsPlain(stackName: string, region: string): boolean {
  return isPasteableIdent(stackName) && isPasteableIdent(region);
}

/** Printed under a nested-child plan line whose child name was described. */
export const NESTED_NAME_DESCRIBED_NOTE =
  "(The nested stack's name is not a plain identifier, so it is described, not named; " +
  "list the records as stored with 'cdkd state list --long'.)";

/** Printed under the plan header when {@link stackRegionShown} described a value. */
export const STACK_REGION_DESCRIBED_NOTE =
  '  (The stack name or region is not a plain identifier, so it is described, not named; ' +
  "list the records as stored with 'cdkd state list --long'.)";

/**
 * The `DeletionPolicy Snapshot — ...` note a planned Snapshot delete carries
 * (issue #1366). Consults the SAME mechanism matrix the replay will run, so
 * the preview cannot promise a final snapshot for a shape the executor is
 * about to REFUSE (a cc-api-routed atomic type, or a type with no snapshot
 * mechanism at all). `skipFinalSnapshot` is threaded in because the
 * classifier is pure and cannot see CLI flags — under the opt-out every shape
 * plain-deletes, refusals included, so the flag is checked first.
 */
export function snapshotNote(
  resourceType: string,
  effectiveProvisionedBy: 'sdk' | 'cc-api' | undefined,
  skipFinalSnapshot: boolean
): string {
  if (skipFinalSnapshot) {
    return 'DeletionPolicy Snapshot — NO final snapshot (--skip-final-snapshot)';
  }
  if (refusesFinalSnapshot(resourceType, effectiveProvisionedBy)) {
    // go-to-k/cdkd#6047: the replay reads a Cloud Control-routed DB instance
    // live and deletes a read replica or cluster member without a snapshot,
    // as CloudFormation does; this pure preview cannot read it, so it names
    // both outcomes.
    if (resourceType === 'AWS::RDS::DBInstance') {
      return (
        'DeletionPolicy Snapshot — cdkd cannot snapshot this resource; the rollback will ' +
        'REFUSE it unless AWS reports a read replica or cluster member, deleted without one ' +
        'as in CloudFormation (re-run with --skip-final-snapshot to delete without one)'
      );
    }
    return (
      'DeletionPolicy Snapshot — cdkd cannot snapshot this resource; the rollback will ' +
      'REFUSE it (re-run with --skip-final-snapshot to delete without one)'
    );
  }
  return 'DeletionPolicy Snapshot — final snapshot, then delete';
}

/**
 * One spelling of "this value came from an S3 key or a rollback-journal record,
 * and is about to be interpolated into a message a terminal will render"
 * (issue #3064).
 *
 * `rollback-journal.json` is a sibling of `state.json` in the same bucket, so
 * anyone with `s3:PutObject` writes it, and cdkd's output is line-oriented --
 * an injected newline invents a line that reads like a real one. Here that is
 * worse than a forged diagnostic: the plan preview below is what the user
 * CONFIRMS against, so a planted journal could forge the plan rows themselves.
 *
 * `displayIdent`, because every value it guards has a known charset: a
 * logical id, a CFn resource type, a change type, a run id, a segment reason,
 * a stack name, an AWS region. The ASCII allowlist, a length cap, and -- since
 * issue #3092 -- a visible boundary: an all-ASCII id such as
 * `X (AWS::RDS::DBInstance) -- already reverted` survives the allowlist and
 * plants this preview's own annotation wording inside a real row, so a value
 * that is not a plain identifier renders JSON-quoted. Call it for those;
 * `grep safe(` answers the scope and this comment does not.
 *
 * The caller writes NO quotes around the result, here or around
 * {@link safeStack}'s (go-to-k/cdkd#3950): the JSON boundary is the value's
 * own, and a hand-written `'...'` is exactly what a `'`-carrying name closes,
 * leaving the rest of a pasted sentence as bare shell.
 *
 * NOT for a value that is about to be USED rather than shown -- the preview
 * indexes `previewState` by the RAW `op.logicalId`, and sanitising a lookup
 * key silently mismatches the record it is meant to find.
 *
 * NOT for free-form error text either. An SDK or provider message legitimately
 * carries non-ASCII (a resource name, AWS's own wording), so a site that renders
 * one calls `displaySafe()` directly and takes the DENYLIST -- the same class
 * `formatError` picks for a `cause`, and for the same reason. `grep displaySafe(`
 * answers how many; a count written here was wrong on its first revision.
 *
 * Scope is answered by grepping BOTH `safe(` and `safeStack(` -- the latter is
 * not matched by the former, and a sentence naming only one understates the
 * population.
 */
export function safe(value: unknown): string {
  return displayIdent(value);
}

/**
 * `safe()` for a cdkd STATE-RECORD STACK NAME specifically, which is the one
 * value class in this file whose legitimate grammar runs past `displayIdent`'s
 * 255-code-point default (issue #3164).
 *
 * A stack name here is not a CloudFormation stack name: `deriveChildStackName`
 * appends `~<logicalId>` per nesting level, and with CDK's ~60-character
 * generated nested-stack logical ids a legitimate child passes 255 around the
 * fourth level. Cutting one is a byte change on a LEGITIMATE value, and this
 * file is the worst place for it -- when this helper was written, three of its
 * renders were `re-run 'cdkd rollback <stack>'` COPY-PASTE hints and one was
 * the confirmation prompt, so a cut name handed an operator an unrunnable
 * command mid-incident. Those hints now go through `rerunRollback`'s gate
 * (go-to-k/cdkd#3436) and the prompt through `stackRegionShown`
 * (go-to-k/cdkd#3760).
 *
 * It is a NAMED helper rather than a `maxCodePoints` argument repeated per
 * site, because a per-site spelling of exactly this rule is what issue #3164
 * exists to stop: the first cut of that fix widened ONE of this file's
 * stack-name renders and left the rest cut. Every value that is NOT a stack name --
 * a region (at most 25 characters), a logical id, a resource type, a change
 * type -- keeps `safe()` and its tighter default.
 */
export function safeStack(value: unknown): string {
  return displayIdent(value, { maxCodePoints: STACK_REF_MAX_CODE_POINTS });
}

/**
 * `safe()` for an IAM ROLE ARN, the SECOND value class in this file whose
 * legitimate grammar runs past `displayIdent`'s 255-code-point default (issue
 * go-to-k/cdkd#3397 review).
 *
 * An AWS-legal role ARN reaches 613 code points — a 512-character path plus a
 * 64-character name — so `safe()` cut the one ARN this file renders at 255 and
 * appended `[cut: N more characters withheld]` INSIDE
 * `pass --role-arn to match`, the sentence whose only job is to say which role
 * to pass back. That is verbatim the failure `ROLE_ARN_MAX_CODE_POINTS`'s own
 * doc exists to prevent, and the display fence could not see it: it checks that
 * a sanitizer was CALLED, never which cap the call passed.
 *
 * A NAMED helper rather than a `maxCodePoints` argument at the site, for the
 * reason {@link safeStack} records about itself — a per-site spelling of
 * exactly this rule is what issue #3164 exists to stop, and a first cut of this
 * fix wrote one before the reference-count fence in
 * `tests/unit/cli/commands/rollback.test.ts` refused it. That refusal is the
 * fence working: it forces the question "which helper does this value belong
 * in" to be answered in code rather than in a diff.
 */
export function safeRoleArn(value: unknown): string {
  return displayIdent(value, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS });
}

/**
 * Human label for a planned rollback action (plan preview). `skipFinalSnapshot`
 * is threaded in because the classifier is pure (it cannot see CLI flags) and
 * the Snapshot label would otherwise promise a final snapshot the run is about
 * to skip — a data-loss-relevant lie in the one preview the user reads.
 */
/**
 * The type(s) a reversed replacement touches (issue #2668): `from NEW to OLD`
 * when the replacement changed the resource's `Type` — the replay deletes the
 * first and re-creates the second — and the single type otherwise. Words, not
 * an arrow: pasted, ` -> ` is `-` plus a `>` redirect onto the type after it
 * (go-to-k/cdkd#4239).
 */
export function replacementTypes(op: RollbackPlanItem['op']): string {
  const routing = resolveReplacementOldType(op);
  return routing.ok && routing.oldType !== op.resourceType
    ? `from ${safe(op.resourceType)} to ${safe(routing.oldType)}`
    : safe(op.resourceType);
}

export function actionLabel(item: RollbackPlanItem, skipFinalSnapshot: boolean): string {
  const { op, action, replacement } = item;
  const rep = replacement ? ' [replacement occurred, best-effort revert]' : '';
  switch (action) {
    case 'delete':
      return `  - delete   ${safe(op.logicalId)} (${safe(op.resourceType)})${rep}`;
    case 'delete-with-final-snapshot':
      // Named only when plain, described otherwise: the note can name
      // `--skip-final-snapshot` (go-to-k/cdkd#4214).
      return (
        `  - delete   ${logicalIdShown(op.logicalId)} (${resourceTypeShown(op.resourceType)}) ` +
        `[${snapshotNote(op.resourceType, item.effectiveProvisionedBy, skipFinalSnapshot)}]`
      );
    case 'orphan-retain':
      return `  - orphan   ${safe(op.logicalId)} (${safe(op.resourceType)}) [DeletionPolicy Retain — left in AWS]`;
    case 'orphan-flag':
      return `  - orphan   ${safe(op.logicalId)} (${safe(op.resourceType)}) [--orphan]`;
    case 'revert':
      return `  - revert   ${safe(op.logicalId)} (${safe(op.resourceType)})${rep}`;
    case 'restore-policies':
      return `  - revert   ${safe(op.logicalId)} (${safe(op.resourceType)}) [DeletionPolicy / UpdateReplacePolicy only, in state; no AWS call]`;
    // Issue #2598: both labels used to promise "delete new" unconditionally,
    // and `UpdateReplacePolicy: Retain` on the new copy means the replay will
    // NOT delete it — a promise the run does not keep, in the one preview the
    // user confirms. Same reason `snapshotNote` above exists.
    case 'reverse-replacement':
      // The hedge is load-bearing, not padding: under Retain the replay
      // REFUSES this op if the re-create collides with a name the pinned new
      // resource still holds, and the plan cannot know whether it will --
      // that depends on whether the type has a user-supplied physical name.
      // Promising the unconditional happy path here would be the same #1366
      // defect this flag exists to close, one step further along.
      // go-to-k/cdkd#2631: likewise the re-create of an old resource whose
      // delete was not confirmed, which the replay first reads AWS for.
      if (op.oldResourceMaySurvive !== undefined) {
        return (
          `  - reverse-replace ${safe(op.logicalId)} (${replacementTypes(op)}) ` +
          `[the deploy did not confirm deleting the old resource: re-create it if AWS reports it ` +
          `gone, ` +
          (op.oldResourceMaySurvive === 'kept'
            ? `re-adopt it if AWS still has it (its delete was refused or never sent), `
            : `REFUSED if AWS still has it (its delete may still be running, or only partly ran), `) +
          `REFUSED if cdkd cannot tell; ` +
          (item.retainsNewResource
            ? `new one RETAINED (UpdateReplacePolicy: Retain) and left untracked]`
            : `delete new]`)
        );
      }
      return item.retainsNewResource
        ? `  - reverse-replace ${safe(op.logicalId)} (${replacementTypes(op)}) ` +
            `[re-create old resource; new one RETAINED (UpdateReplacePolicy: Retain) and left ` +
            `untracked — REFUSED instead if the re-create collides with the name the retained ` +
            `resource still holds]`
        : `  - reverse-replace ${safe(op.logicalId)} (${replacementTypes(op)}) [re-create old resource, delete new]`;
    case 'reverse-replacement-readopt':
      return item.retainsNewResource
        ? `  - reverse-replace ${safe(op.logicalId)} (${replacementTypes(op)}) ` +
            `[re-adopt retained old resource; new one RETAINED (UpdateReplacePolicy: Retain) and left untracked]`
        : `  - reverse-replace ${safe(op.logicalId)} (${replacementTypes(op)}) [delete new, re-adopt retained old resource]`;
    case 'unrecoverable-delete':
      return `  - (cannot restore) ${safe(op.logicalId)} (${safe(op.resourceType)}) — was DELETED, unrecoverable`;
    case 'skip-mismatch':
      return `  - skip     ${safe(op.logicalId)} (${safe(op.resourceType)}) — physical id changed, needs manual attention`;
    case 'skip-absent':
      return `  - skip     ${safe(op.logicalId)} (${safe(op.resourceType)}) — no longer in state`;
    case 'refuse-replacement-routing': {
      // Issue #2668: the replay FAILS this op (journal kept), so the preview
      // must not read as a skip the run will shrug off.
      const routing = resolveReplacementOldType(op);
      return (
        `  - (REFUSED) ${safe(op.logicalId)} (${safe(op.resourceType)}) — cannot reverse the ` +
        `replacement: ${routing.ok ? 'its old type could not be routed' : routing.reason}`
      );
    }
    case 'skip-already-done':
      return `  - skip     ${safe(op.logicalId)} (${safe(op.resourceType)}) — already reverted`;
  }
}

/**
 * go-to-k/cdkd#4523: the plan lines for journal ops the replay leaves alone
 * because `cdkd import` adopted their logical id after the segment was
 * recorded (`splitImportedOps`). Completed and failed ops share them. An
 * ADOPTED op recorded the very resource the import put in state; a DISPLACED
 * one recorded another, which the import replaced in the record — it is
 * counted as a warning, since nothing reverts it.
 */
export function importedOpLabel(op: { logicalId: string; resourceType: string }): string {
  return (
    `  - skip     ${logicalIdShown(op.logicalId)} (${resourceTypeShown(op.resourceType)}) ` +
    `— adopted by cdkd import after this deploy, left as it is`
  );
}

export function displacedOpLabel(
  op: DisplacedOp,
  segment: { importedResources?: readonly ImportedResourceMark[] }
): string {
  // The resource to check is named: once the segment pops, this line is the
  // only place it is ever named (security review m4). It goes through the
  // replay's per-op masker, as every id the replay prints.
  return (
    `  - skip     ${logicalIdShown(op.logicalId)} (${resourceTypeShown(op.resourceType)}) ` +
    `— ${displacedOpClause(op, segment.importedResources ?? [], getLogger())}; ` +
    `not reverted, check that resource by hand`
  );
}

/**
 * The failed ops a segment's replay acts on: all of them under
 * `--revert-failed`, otherwise only the journaled proven failed-CREATE
 * orphans (go-to-k/cdkd#4584) — a plain rollback that popped the segment
 * without them would drop the only record of a live resource — and the failed
 * UPDATE of a replacement whose orphan is among them (go-to-k/cdkd#4604): it
 * settles with the orphan, and left alone in a kept segment a later
 * `--revert-failed` would force-revert the resource the replacement never
 * wrote to.
 */
export function failedOpsToReplay(
  ops: FailedOperation[],
  revertFailed: boolean
): FailedOperation[] {
  return revertFailed
    ? ops
    : ops.filter(
        (op) =>
          isJournaledOrphan(op) || (op.changeType === 'UPDATE' && replacementNeverSwapped(op, ops))
      );
}

/**
 * Human label for a planned FAILED-op revert (issue #1198, --revert-failed).
 * Takes `skipFinalSnapshot` for the same reason {@link actionLabel} does: the
 * classifier is pure, so without the flag the Snapshot label would promise a
 * final snapshot the run is about to skip (issue #1362).
 */
export function failedActionLabel(item: FailedOpPlanItem, skipFinalSnapshot: boolean): string {
  const { op, action } = item;
  switch (action) {
    case 'revert-failed-update':
      return `  - revert   ${safe(op.logicalId)} (${safe(op.resourceType)}) [FAILED update — remote state unknown, force-applying previous properties]`;
    case 'delete-failed-create':
      // go-to-k/cdkd#1710: a proven orphan has no state record, so the journal
      // is the only source of what is deleted — name it (masked) at the prompt.
      return op.physicalIdRecoveredFromError === true
        ? `  - delete   ${logicalIdShown(op.logicalId)} (${resourceTypeShown(op.resourceType)}) [FAILED ` +
            // go-to-k/cdkd#4604: the record under this id is the replaced one.
            (isReplacementOrphan(op) ? "replacement's new resource" : 'create') +
            `, never recorded in state: ` +
            `${displacedPhysicalIdShown(op, getLogger()) ?? 'a physical id'}]`
        : `  - delete   ${safe(op.logicalId)} (${safe(op.resourceType)}) [FAILED create]`;
    case 'delete-failed-create-with-final-snapshot':
      // As `delete-with-final-snapshot` in `actionLabel` (go-to-k/cdkd#4214).
      return (
        `  - delete   ${logicalIdShown(op.logicalId)} (${resourceTypeShown(op.resourceType)}) [FAILED create, ` +
        `${snapshotNote(op.resourceType, item.effectiveProvisionedBy, skipFinalSnapshot)}]`
      );
    case 'orphan-failed-create-retain':
      return `  - orphan   ${safe(op.logicalId)} (${safe(op.resourceType)}) [FAILED create, DeletionPolicy Retain — left in AWS]`;
    case 'skip-failed-unknown':
      return `  - skip     ${safe(op.logicalId)} (${safe(op.resourceType)}) — failed CREATE recorded no physical id`;
    case 'skip-failed-noop':
      return `  - skip     ${safe(op.logicalId)} (${safe(op.resourceType)}) — failed ${safe(op.changeType)} left nothing to revert`;
    case 'skip-failed-replaced-deleted':
      // go-to-k/cdkd#4604: named (masked) like the skips around it.
      return (
        `  - skip     ${logicalIdShown(op.logicalId)} (${resourceTypeShown(op.resourceType)}) ` +
        `— failed replacement deleted the old resource ${displacedPhysicalIdShown(op, getLogger()) ?? 'a physical id'} ` +
        `before its create failed; nothing to revert, state still records it`
      );
    case 'skip-failed-superseded':
      // go-to-k/cdkd#1710: named (masked) like the mismatch below.
      return (
        `  - skip     ${logicalIdShown(op.logicalId)} (${resourceTypeShown(op.resourceType)}) ` +
        `— failed CREATE created ${displacedPhysicalIdShown(op, getLogger()) ?? 'a physical id'} before failing; ` +
        `a later deploy or rollback may own it now; not deleted, needs manual attention`
      );
    case 'skip-failed-mismatch':
      // go-to-k/cdkd#4552: named (masked) as `displacedOpLabel` names it —
      // once the segment pops, this line and the replay's warning are the
      // only places the recorded resource is ever named.
      return (
        `  - skip     ${logicalIdShown(op.logicalId)} (${resourceTypeShown(op.resourceType)}) ` +
        `— failed CREATE recorded ${displacedPhysicalIdShown(op, getLogger()) ?? 'a physical id'}, ` +
        `which is not the resource state tracks under this id; not reverted, needs manual attention`
      );
    case 'skip-failed-absent':
      return `  - skip     ${safe(op.logicalId)} (${safe(op.resourceType)}) — no previous state available`;
    case 'skip-failed-type-change':
      return (
        `  - skip     ${safe(op.logicalId)} (from ${safe(op.previousState?.resourceType)} to ` +
        `${safe(op.resourceType)}) — failed Type change is a replacement, no in-place revert exists`
      );
  }
}

/**
 * `cdkd rollback`'s confirmation prompt. Exported for unit testing — internal
 * to the rollback flow otherwise, whose only call site is inside the
 * `if (!skipConfirmation)` block below.
 *
 * The `(y/N): ` suffix is preserved verbatim from before issue #2275 folded
 * the non-interactive guard into `confirmOrRefuse`: it is user-visible output,
 * and only this site and `cdkd state orphan` ever spelled it that way.
 */
export async function confirm(question: string): Promise<boolean> {
  return confirmOrRefuse(question, {
    suffix: ' (y/N): ',
    refusal:
      'The cdkd rollback confirmation prompt cannot run in a non-interactive ' +
      'environment. Pass --force (or -y / --yes) to confirm the rollback, or run ' +
      'the command from a real terminal.',
  });
}
