import { Command, Option } from 'commander';
import { releaseRegistryMarkerQuietly } from './registry-release.js';
import { applyCrossPrefixScan } from '../../state/cross-prefix-stack-scan.js';
import { CrossPrefixGuard } from '../../state/stack-registry.js';
import { logicalIdShown, resourceTypeShown } from '../../provisioning/composite-id.js';
import { isIamRoleArn } from '../../utils/role-arn.js';
import {
  pasteableCommand,
  plainOrDescribed,
  quotedOrDescribed,
  withheldTargetClause,
} from '../../utils/pasteable-command.js';
import {
  commonOptions,
  stateOptions,
  deprecatedRegionOption,
  skipFinalSnapshotOption,
  warnIfDeprecatedRegion,
  parseStackRegion,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { AwsClients, setAwsClients } from '../../utils/aws-clients.js';
import { forwardSigtermToSigint } from '../../utils/interrupt-signals.js';
import { CdkdError, PartialFailureError, withErrorHandling } from '../../utils/error-handler.js';
import { markNonRetryable } from '../../deployment/retryable-errors.js';
import { ProviderRegistry } from '../../provisioning/provider-registry.js';
import {
  loadProviderClasses,
  registerAllProviders,
} from '../../provisioning/register-providers.js';
import { refusesFinalSnapshot } from '../../provisioning/final-snapshot.js';
import { withNestedStackContext } from '../../provisioning/nested-stack-context.js';
import {
  NESTED_PENDING_PARENT_REASON,
  dropSettledNestedJournals,
  nestedChildStackName,
  displacedOpClause,
  displacedPhysicalIdShown,
  recordDisplacedSkips,
  type DisplacedOp,
  revertedNestedRowIds,
  withNestedRevertRun,
  type NestedRevertRun,
} from '../../deployment/nested-child-journal.js';
import { withSkipPrefix, withStackName } from '../../provisioning/resource-name.js';
import { resolveSkipPrefix } from '../config-loader.js';
import { confirmOrRefuse } from './confirm-prompt.js';
import { dropFailedJournalEntry, refuseDropFailedConflicts } from './rollback-drop-failed.js';
import { setupStateBackend, resolveSingleRegion } from './state.js';
import { startRunRecorder } from './deployment-events-run.js';
import { withPrintingSecrets } from '../../deployment/resource-secrets-scope.js';
import {
  completedReplayEntries,
  journaledOrphanPrintingBag,
  maskEventTextWithBoundBags,
} from '../../deployment/secret-name-needles.js';
import {
  replayRollback,
  replayFailedOperations,
  planRollback,
  planFailedOps,
  recheckFailedPlan,
  recordUnderIdIsNotOwn,
  demoteSupersededOrphans,
  isJournaledOrphan,
  isReplacementOrphan,
  replacementNeverSwapped,
  producerRegionsFromState,
  resolveReplacementOldType,
  type FailedOperation,
  type RollbackExecutorContext,
  type RollbackPlanItem,
  type FailedOpPlanItem,
} from '../../deployment/rollback-executor.js';
import { RollbackInlinePolicyWriters } from '../../deployment/inline-policy-claims.js';
import {
  dropFailedHint,
  makeForeignHolderScan,
} from '../../deployment/rollback-executor/journaled-orphans.js';
import { removeProtectionTypeList } from '../../provisioning/remove-protection-types.js';
import {
  STATE_SCHEMA_VERSION_CURRENT,
  describeRegionValueKind,
  isReadableBag,
  type ResourceState,
  type StackState,
  orphansAfterRollback,
  type StackOrphanRecord,
  type LockInfo,
} from '../../types/state.js';
import { splitImportedOps, type ImportedResourceMark } from '../../types/rollback-journal.js';
import type { S3StateBackend, StackStateRef } from '../../state/s3-state-backend.js';
import { isLockInfoExpired } from '../../state/lock-manager.js';
import {
  displayIdent,
  displaySafe,
  isPasteableIdent,
  ROLE_ARN_MAX_CODE_POINTS,
  STACK_REF_MAX_CODE_POINTS,
  safeMsg,
} from '../../utils/display-safe.js';
import {
  refuseMalformedOrphanRecords,
  refuseMalformedOrphans,
  refuseMalformedState,
  STATE_REGION_DIVERGED,
} from '../../state/malformed-resources-bag.js';
import { producerRecordKey } from '../../state/record-keys.js';
import {
  ledgerForStack,
  withCreateTokenLedger,
} from '../../provisioning/providers/create-token-ledger.js';

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
  return displaySafe(error instanceof Error ? error.message : String(error));
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
function stackRegionShown(stackName: string, region: string): string {
  return `${plainOrDescribed(stackName, 'stack name')} (${plainOrDescribed(region, 'region')})`;
}

/** Whether {@link stackRegionShown} names both values. */
function stackRegionIsPlain(stackName: string, region: string): boolean {
  return isPasteableIdent(stackName) && isPasteableIdent(region);
}

/** Printed under a nested-child plan line whose child name was described. */
const NESTED_NAME_DESCRIBED_NOTE =
  "(The nested stack's name is not a plain identifier, so it is described, not named; " +
  "list the records as stored with 'cdkd state list --long'.)";

/** Printed under the plan header when {@link stackRegionShown} described a value. */
const STACK_REGION_DESCRIBED_NOTE =
  '  (The stack name or region is not a plain identifier, so it is described, not named; ' +
  "list the records as stored with 'cdkd state list --long'.)";

interface RollbackOptions {
  force?: boolean;
  yes?: boolean;
  orphan?: string[];
  revertFailed?: boolean;
  /** go-to-k/cdkd#4633: drop this logical id's journaled failed-CREATE orphan entry. */
  dropFailed?: string;
  skipFinalSnapshot?: boolean;
  /**
   * go-to-k/cdkd#4678: turn protection off before this stack's rollback
   * deletes a resource the failed deploy left (a completed CREATE's, or a
   * failed CREATE's once proven), as `cdkd destroy --remove-protection` does;
   * a nested stack's revert carries it into that child (go-to-k/cdkd#4703).
   */
  removeProtection?: boolean;
  stackRegion?: string;
  stateBucket?: string;
  statePrefix: string;
  region?: string;
  profile?: string;
  roleArn?: string;
  verbose: boolean;
}

/**
 * `--stack-region <region>` — disambiguate when the same stackName has state
 * in multiple regions (same pattern + messages as the `state` subcommands).
 */
function stackRegionOption(): Option {
  return new Option(
    '--stack-region <region>',
    'Region of the target stack when the same name has state in multiple regions'
  ).argParser(parseStackRegion);
}

/**
 * Discover every stack that currently has a rollback journal. One raw key
 * listing under the prefix (journals live at
 * `{prefix}/{stackName}/{region}/rollback-journal.json`), parsed back to
 * `(stackName, region)` refs.
 */
async function findJournalCandidates(
  backend: Awaited<ReturnType<typeof setupStateBackend>>['stateBackend'],
  prefix: string
): Promise<StackStateRef[]> {
  const keys = await backend.listRawKeys(`${prefix}/`);
  const refs: StackStateRef[] = [];
  const suffix = '/rollback-journal.json';
  const seen = new Set<string>();
  for (const key of keys) {
    if (!key.endsWith(suffix)) continue;
    const rest = key.slice(prefix.length + 1, key.length - suffix.length);
    const segments = rest.split('/');
    // {stackName}/{region}
    if (segments.length !== 2) continue;
    const [stackName, region] = segments;
    if (!stackName || !region) continue;
    // {@link producerRecordKey}, not a separator (go-to-k/cdkd#3323). Both
    // halves are S3 key segments, exactly as in `listStacks`' dedupe.
    const dedupe = producerRecordKey(stackName, region);
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    refs.push({ stackName, region });
  }
  return refs;
}

/**
 * The `DeletionPolicy Snapshot — ...` note a planned Snapshot delete carries
 * (issue #1366). Consults the SAME mechanism matrix the replay will run, so
 * the preview cannot promise a final snapshot for a shape the executor is
 * about to REFUSE (a cc-api-routed atomic type, or a type with no snapshot
 * mechanism at all). `skipFinalSnapshot` is threaded in because the
 * classifier is pure and cannot see CLI flags — under the opt-out every shape
 * plain-deletes, refusals included, so the flag is checked first.
 */
function snapshotNote(
  resourceType: string,
  effectiveProvisionedBy: 'sdk' | 'cc-api' | undefined,
  skipFinalSnapshot: boolean
): string {
  if (skipFinalSnapshot) {
    return 'DeletionPolicy Snapshot — NO final snapshot (--skip-final-snapshot)';
  }
  if (refusesFinalSnapshot(resourceType, effectiveProvisionedBy)) {
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
function safe(value: unknown): string {
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
function safeStack(value: unknown): string {
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
function safeRoleArn(value: unknown): string {
  return displayIdent(value, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS });
}

/**
 * Refuse a rollback over a record whose body `region` disagreed with the key it
 * was read from, while it still lists resources (go-to-k/cdkd#3370) — the
 * rollback half of `refuseDivergentRecordRegionForDestroy` (go-to-k/cdkd#3328).
 *
 * The replay acts in the KEY's region (`RollbackExecutorContext.region`) and
 * reads a `*NotFound` delete as "already gone", exactly as the destroy does: if
 * the record's own region is the honest half, a rolled-back CREATE's delete
 * comes back not-found, the replay drops the row and saves, and the resource is
 * left live in the other region with nothing naming it.
 *
 * ONE refusal for the whole command rather than one per replay arm, because the
 * trigger already partitions the arms exactly. Every arm that calls AWS — the
 * CREATE delete, the in-place `revert`, BOTH reverse-replacement arms (whose
 * re-CREATE writes as well as deletes), and `--revert-failed`'s delete and
 * forced update — requires a CURRENT state row for the op's logical id
 * (`classifyRollbackOp` / `classifyFailedOp`), except the delete of a proven
 * failed-CREATE orphan (go-to-k/cdkd#1710), which has no row, is replayed with
 * or without `--revert-failed` (go-to-k/cdkd#4584), and is counted in
 * `provenOrphans`; a completed DELETE is `unrecoverable-delete` and
 * calls nothing. So a record listing no resources, under a journal with no
 * proven orphan to delete, can replay nothing against AWS, and is let through
 * for the reason the destroy gives: it is the recovery path, not the hazard.
 * Anything else can reach an arm that calls AWS, so every arm is refused.
 *
 * Its own message rather than the destroy's builder, whose opening, consequence
 * and remedy all speak about a DESTROY. This one offers no command at all — the
 * remedy is a repair — so it needs none of that builder's exact-rendering gate,
 * and it names the stack the way every other message in this file does. The
 * body's value is withheld and its KIND printed, the rule `getState`'s warn
 * takes: a region a record supplies is the misdirection channel.
 */
function refuseDivergentRecordRegionForRollback(
  state: StackState,
  stackName: string,
  keyRegion: string,
  divergentBodyRegion: unknown,
  provenOrphans: number
): void {
  if (divergentBodyRegion === undefined) return;
  // FAIL CLOSED on a bag this cannot count, as the destroy sibling does.
  // Unreachable from the call site (`refuseMalformedState` refused such a bag
  // first), and kept so a reorder cannot read "unknown" as "zero".
  const resourceCount = isReadableBag(state.resources)
    ? Object.keys(state.resources).length
    : undefined;
  if (resourceCount === 0 && provenOrphans === 0) return;
  const lists =
    resourceCount === undefined
      ? 'its resources map cannot be read'
      : resourceCount > 0
        ? `it still lists ${resourceCount} resource${resourceCount === 1 ? '' : 's'}`
        : `its journal holds ${provenOrphans} failed create${provenOrphans === 1 ? '' : 's'} ` +
          `whose resource the rollback would delete`;
  throw markNonRetryable(
    new CdkdError(
      // The stack and region are NAMED only when plain, described otherwise:
      // this block ends in a `--verbose` remedy, and a block that displays an
      // untrusted value carries no pasteable command (go-to-k/cdkd#3950's S1
      // rule; under zsh a `$( )` name runs when the sentence is pasted).
      `cdkd will not roll back ${plainOrDescribed(stackName, 'stack name')} ` +
        `(${plainOrDescribed(keyRegion, 'region')}): the state record ` +
        `read from that region's key carries a 'region' of its own ` +
        `(${describeRegionValueKind(divergentBodyRegion)}) that is not the key's, and ${lists} — ` +
        `so cdkd cannot tell which region they are in. cdkd stamps the key's region into every ` +
        `record it writes, so this record was not written by cdkd. The replay would issue every ` +
        `delete and revert against the key's region; if the record's own region is the honest ` +
        `half, each delete comes back not-found, which the replay reads as ALREADY DELETED — it ` +
        `would report the resource rolled back, drop it from the record, and leave it standing ` +
        `in the other region. Nothing was changed. Re-run with --verbose to see what the ` +
        `record's region field holds, repair that field to match the key it is stored under, ` +
        `and run the rollback again.`,
      STATE_REGION_DIVERGED
    )
  );
}

/**
 * Why the retry SAVE declined to write over a record that was rewritten mid-run
 * with a divergent body region (go-to-k/cdkd#3370) — rendered in that save's
 * warn and again in the run's partial-failure exit. Names no stack — both are
 * about the current run's stack already — and
 * prints the value's KIND only, for the reason
 * {@link refuseDivergentRecordRegionForRollback} gives.
 */
function divergedDuringRollbackMessage(divergentBodyRegion: unknown): string {
  return (
    `the state record was rewritten during this rollback, and the rewrite carries a 'region' ` +
    `of its own (${describeRegionValueKind(divergentBodyRegion)}) that is not the region of its ` +
    `key, so cdkd did not write over it`
  );
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
function replacementTypes(op: RollbackPlanItem['op']): string {
  const routing = resolveReplacementOldType(op);
  return routing.ok && routing.oldType !== op.resourceType
    ? `from ${safe(op.resourceType)} to ${safe(routing.oldType)}`
    : safe(op.resourceType);
}

function actionLabel(item: RollbackPlanItem, skipFinalSnapshot: boolean): string {
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
function importedOpLabel(op: { logicalId: string; resourceType: string }): string {
  return (
    `  - skip     ${logicalIdShown(op.logicalId)} (${resourceTypeShown(op.resourceType)}) ` +
    `— adopted by cdkd import after this deploy, left as it is`
  );
}

function displacedOpLabel(
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
function failedOpsToReplay(ops: FailedOperation[], revertFailed: boolean): FailedOperation[] {
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
function failedActionLabel(item: FailedOpPlanItem, skipFinalSnapshot: boolean): string {
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

export async function rollbackCommand(
  stackArg: string | undefined,
  options: RollbackOptions
): Promise<void> {
  // Awaited first, so provider construction below stays synchronous once the
  // stack client scope / globals are set (see `loadProviderClasses`).
  const providerClasses = await loadProviderClasses();
  const logger = getLogger();
  if (options.verbose) {
    logger.setLevel('debug');
    process.env['CDKD_NO_LIVE'] = '1';
  }
  warnIfDeprecatedRegion(options);
  // go-to-k/cdkd#4633: before any AWS call, so a bad combination costs nothing.
  if (options.dropFailed !== undefined) refuseDropFailedConflicts(options);

  const setup = await setupStateBackend(options);
  const skipConfirmation = options.force === true || options.yes === true;
  // Stack-region-pinned client set installed as the process-global for the
  // replay (see the note at its construction below); the original set is
  // restored and this one disposed in the outer finally.
  let stackAwsClients: AwsClients | undefined;

  try {
    // 1. Resolve the target stack + region.
    let ref: StackStateRef;
    if (stackArg) {
      const refs = await setup.stateBackend.listStacks();
      ref = resolveSingleRegion(stackArg, refs, options.stackRegion);
    } else {
      const candidates = await findJournalCandidates(setup.stateBackend, setup.prefix);
      const inRegion = options.stackRegion
        ? candidates.filter((c) => c.region === options.stackRegion)
        : candidates;
      // A nested child's journal is its PARENT's to replay (issue #3754): a
      // parent's `cdkd rollback` reverts the child row from it. So a child
      // (`<parent>~<id>`) whose parent is itself a candidate in the same region
      // is not a separate choice to offer.
      const scoped = inRegion.filter((c) => {
        const cut = c.stackName.lastIndexOf('~');
        if (cut <= 0) return true;
        const parent = c.stackName.slice(0, cut);
        return !inRegion.some((p) => p.stackName === parent && p.region === c.region);
      });
      if (scoped.length === 0) {
        logger.info(
          'Nothing to roll back — no stack has a rollback journal. ' +
            "Run 'cdkd deploy' to (re)deploy, or 'cdkd destroy' to clean up."
        );
        return;
      }
      if (scoped.length > 1) {
        // These rows are what the user picks a `cdkd rollback <stack>` argument
        // from, beside a quoted command template. Both values come from journal
        // S3 keys, so each is named only when it is a plain identifier: padding
        // that wraps on screen could otherwise spell a counterfeit labelled row
        // (go-to-k/cdkd#3760). A real stack name and region always are.
        const list = scoped
          .map(
            (c) =>
              `  - ${plainOrDescribed(c.stackName, 'stack name')} ` +
              `(${plainOrDescribed(c.region ?? '', 'region')})`
          )
          .join('\n');
        // A described row cannot be told apart from another, so say where the
        // records are listed as stored.
        const described = scoped.some(
          (c) => !isPasteableIdent(c.stackName) || !isPasteableIdent(c.region ?? '')
        )
          ? `A row whose stack name or region is not a plain identifier is described, not named; ` +
            `list the records as stored with 'cdkd state list --long'.\n`
          : '';
        throw new Error(
          `Multiple stacks have a rollback journal. Pick one:\n${list}\n` +
            described +
            `Re-run 'cdkd rollback <stack>' (add --stack-region if the same name spans regions).`
        );
      }
      ref = scoped[0]!;
    }
    const stackName = ref.stackName;
    const region = ref.region ?? setup.region;

    // go-to-k/cdkd#4633: journal only — no providers, no AWS clients, no replay.
    if (options.dropFailed !== undefined) {
      await dropFailedJournalEntry({
        stateBackend: setup.stateBackend,
        lockManager: setup.lockManager,
        stackName,
        region,
        logicalId: options.dropFailed,
        skipConfirmation,
        logger,
      });
      return;
    }

    // go-to-k/cdkd#4705: the replay deletes what the failed deploy created, and
    // for a stack the bucket also records under another state prefix that can
    // be the other deployment's resource (a create handed it back). Started
    // here, awaited under the lock before the plan, the prompt and any replay.
    // Never rejects.
    const crossPrefixScan = new CrossPrefixGuard(setup.stateBackend).full(stackName, region);

    // Region-pinned clients for the whole replay: the pre-delete final
    // snapshots a `DeletionPolicy: Snapshot` rolled-back CREATE takes (issue
    // #1358) AND the provider deletes those snapshots precede. Both must run
    // against the TARGET STACK's region, which `--stack-region` can point
    // away from the CLI's --region / AWS_REGION: a wrong-region snapshot call
    // 404s as a NotFound, which reads as "source gone" and would silently
    // skip the snapshot, and a wrong-region delete trips `assertRegionMatch`.
    // Pinning only the snapshot would be worse than not pinning it at all —
    // it would take a real, billable snapshot and then fail the delete.
    //
    // Built UNCONDITIONALLY rather than under a `region !== setup.region`
    // guard: `setup.region` falls back to the literal 'us-east-1' when
    // neither --region nor AWS_REGION is set, while `setup.awsClients`
    // resolves through the SDK chain (AWS_DEFAULT_REGION, profile config), so
    // the two can disagree while the labels match. `setAwsClients` mirrors
    // what `destroy-runner.ts` does for a cross-region destroy; the original
    // set is restored in the outer finally.
    stackAwsClients = new AwsClients({
      region,
      ...(options.profile && { profile: options.profile }),
    });
    setAwsClients(stackAwsClients);
    const finalSnapshotClients = stackAwsClients;

    // 2. Register providers (exactly like deploy / destroy).
    const providerRegistry = new ProviderRegistry();
    registerAllProviders(providerRegistry, providerClasses);
    providerRegistry.setCustomResourceResponseBucket(setup.bucket);

    // Interrupt handling, registered BEFORE the lock acquisition below
    // (issue #1348) so a signal landing during the acquisition's S3
    // round-trip flips the flag — the replay loop then stops before its
    // first operation and the `finally` releases the lock — instead of
    // killing the process with the just-written lock stranded.
    let interrupted = false;
    // Set when the retry save declined to write over a record rewritten mid-run
    // with a divergent body region (go-to-k/cdkd#3370). The segment in flight
    // FINISHES — deliberately NOT routed through `isInterrupted`, which the
    // executor also hands to in-arm retries, so a stop there can abort a
    // delete-new-first reverse-replacement between its delete and its re-create
    // and leave neither resource. Those ops act in the region the START-of-run
    // record agreed with, so finishing is safe. What the flag stops is the
    // pop — which also keeps the initial-deploy `deleteState` from removing
    // the very record this declined to overwrite, since that needs an empty
    // journal — and every older segment; the run then exits partial.
    let declinedDivergentRewrite = false;
    let declinedDivergentReason = '';
    const sigintHandler = () => {
      process.stderr.write('\nInterrupted — stopping rollback after the current operation...\n');
      interrupted = true;
    };
    process.on('SIGINT', sigintHandler);
    // CI cancellation delivers SIGTERM, not Ctrl-C (issue #1342) — route it
    // through the same graceful stop-after-current-operation path.
    const unforwardSigterm = forwardSigtermToSigint();

    // 3. Acquire the stack lock for the whole replay.
    try {
      await setup.lockManager.acquireLockWithRetry(stackName, region, undefined, 'rollback');
    } catch (error) {
      // The try/finally that owns the listener cleanup starts below — clean
      // up here so an acquire failure does not leak the handlers. No lock is
      // held on this path (`acquireLockWithRetry` throws only after the lock
      // was NOT taken), so there is nothing to release first; the pair is
      // ordered to match the teardown below rather than to contradict it.
      process.removeListener('SIGINT', sigintHandler);
      unforwardSigterm();
      throw error;
    }

    try {
      // 4. Load state + journal (write order guarantees state exists first).
      // A newer-version journal throws UnknownRollbackJournalVersionError from
      // loadRollbackJournal → parseRollbackJournal; it propagates as a hard
      // error telling the user to upgrade cdkd.
      const stateData = await setup.stateBackend.getState(stackName, region);
      let journal = await setup.stateBackend.loadRollbackJournal(stackName, region);
      // Issue #3754: `nested-pending-parent` records, judged BEFORE the plan and
      // the prompt, and written only after the confirmation (below).
      const orphanedPending = journal
        ? await judgeNestedPendingRecords(setup, stackName, region, journal.segments)
        : 0;
      if (journal && orphanedPending > 0) {
        // Replayed from the in-memory journal; the S3 copy loses the same
        // segments once the user confirms, before any pop.
        journal = {
          ...journal,
          segments: journal.segments.filter((s) => s.reason !== NESTED_PENDING_PARENT_REASON),
        };
      }
      if (!journal || (journal.segments.length === 0 && orphanedPending === 0)) {
        throw new Error(
          // Named only when plain, described otherwise: the block carries the
          // `cdkd deploy` / `cdkd destroy` remedy (go-to-k/cdkd#3950's S1 rule).
          `Nothing to roll back for ${plainOrDescribed(stackName, 'stack name')} ` +
            `(${plainOrDescribed(region, 'region')}). ` +
            "Run 'cdkd deploy' to (re)deploy, or 'cdkd destroy' to clean up."
        );
      }
      applyCrossPrefixScan(
        await crossPrefixScan,
        {
          stackName,
          region,
          bucket: setup.bucket,
          recovery: { profile: options.profile, stateBucket: setup.bucket },
        },
        'rollback',
        (message) => logger.warn(message),
        (message) => logger.info(message)
      );
      if (!stateData) {
        throw new Error(
          `Rollback journal exists for ${safeStack(stackName)} (${safe(region)}) but its state.json is missing ` +
            // Rendered SEGMENT BY SEGMENT, not as one pre-joined string: this
            // key is the operator's only route to the record the sentence says
            // is corrupted, and joining first put the whole path under the
            // 255-code-point identifier default -- cutting it mid-path for
            // exactly the deep nested-stack names this file widens the cap for.
            `(keys: ${safe(setup.prefix)}/${safeStack(stackName)}/${safe(region)}/state.json ` +
            `and .../rollback-journal.json). ` +
            `State appears corrupted — inspect the bucket manually.`
        );
      }
      // go-to-k/cdkd#1710: before the plan and every replay, so a proven
      // failed-CREATE orphan later activity may own is skipped with a warning,
      // never deleted. A non-array `orphans` is refused below
      // (`refuseMalformedOrphans`) before anything acts on this verdict.
      demoteSupersededOrphans(
        journal.segments,
        Array.isArray(stateData.state.orphans) ? stateData.state.orphans : []
      );
      // Issue #3754: a nested child whose OWN deploy failed in a segment's run
      // left its completed ops in its journal, and only `--revert-failed`
      // replays that failed row. Without it the parent's older segments would
      // revert the child past those ops first, and a later rollback of the
      // child would then restore the failed run's values over the older ones.
      // Refused up front, before any replay, so the order cannot invert.
      if (!options.revertFailed) {
        for (const segment of journal.segments) {
          // go-to-k/cdkd#4523: an imported failed row is never replayed, so
          // it is not one this refusal's `--revert-failed` advice reaches.
          const failedRows = splitImportedOps(segment.failedOperations ?? [], segment).replay;
          for (const logicalId of revertedNestedRowIds(failedRows)) {
            const child = nestedChildStackName(stackName, logicalId);
            const childJournal = await setup.stateBackend
              .loadRollbackJournal(child, region)
              .catch(() => null);
            const unreverted = (childJournal?.segments ?? []).some(
              (s) =>
                s.runId === segment.runId &&
                s.reason !== NESTED_PENDING_PARENT_REASON &&
                splitImportedOps(s.operations, s).replay.length > 0
            );
            if (unreverted) {
              throw new Error(
                // Named only when plain, described otherwise: the child's name
                // carries the journal's logical id, and this line names
                // `--revert-failed` (go-to-k/cdkd#4214, go-to-k/cdkd#3950's S1
                // rule).
                `Nested stack ${plainOrDescribed(child, 'nested stack name')} failed during a deploy this journal records, and its ` +
                  `own journal still holds that deploy's completed operations. Re-run with ` +
                  `--revert-failed so they are reverted in order with the parent's.`
              );
            }
          }
        }
      }
      const baseState = stateData.state;
      // `cdkd rollback` replays journal segments and SAVES after each one, and
      // a spread of a null bag yields `{}` silently -- so without this the
      // command would replace an unreadable resource map with a well-formed
      // empty one, in the command a user reaches for when state is ALREADY
      // suspect (go-to-k/cdkd#3018).
      // `refusalRecovery` qualifies each refusal's pasteable commands with this
      // run's account flags, so they read the bucket this run read
      // (go-to-k/cdkd#3909).
      const refusalRecovery = {
        profile: options.profile,
        stateBucket: setup.bucket,
        statePrefix: options.statePrefix,
      };
      refuseMalformedState(baseState, stackName, region, refusalRecovery);
      // The `orphans` CONTAINER, ahead of every replay and of
      // `orphansAfterRollback` (go-to-k/cdkd#3379): that helper walks the
      // container with `for...of`, so a string comes back as a list of its
      // characters and this command SAVES it — a damaged container rewritten
      // into a differently damaged one, silently.
      refuseMalformedOrphans(baseState, stackName, region, refusalRecovery);
      // The ROWS (go-to-k/cdkd#3500). This command is where the collapse is
      // observable: `orphansAfterRollback` keys on `entry.logicalId`, so rows
      // MISSING one all write the SAME `undefined` entry and the record saved
      // below keeps one of them. Two distinct numeric ids do not collide; two
      // rows SHARING a string id do, and are refused here too (go-to-k/cdkd#3643).
      refuseMalformedOrphanRecords(baseState, stackName, region, refusalRecovery);
      // A record whose body `region` disagreed with the key it was read from
      // (go-to-k/cdkd#3370) — BELOW `refuseMalformedState`, which proves the
      // bag this counts can be read, and ABOVE the plan preview, the prompt and
      // every replay arm, so the refusal covers all of them at once.
      refuseDivergentRecordRegionForRollback(
        baseState,
        stackName,
        region,
        stateData.divergentBodyRegion,
        // go-to-k/cdkd#4584: a plain rollback deletes them too.
        journal.segments
          .flatMap((seg) => seg.failedOperations ?? [])
          .filter((op) => op.physicalIdRecoveredFromError === true).length
      );
      const stateResources: Record<string, ResourceState> = { ...baseState.resources };
      // Resources THIS command's replays leave in AWS under
      // `DeletionPolicy: Retain` (issue #2934). Declared beside
      // `stateResources` and NOT inside `saveState`, because both replay call
      // sites push into it and `saveState` runs repeatedly as they proceed —
      // it is read inside the state literal rather than captured, so each save
      // persists the set as it stands at that moment.
      const mintedOrphans: StackOrphanRecord[] = [];
      const orphanLogicalIds = new Set(options.orphan ?? []);

      // Informational role-arn note (issue #1183): the newest segment recorded
      // a role, but --role-arn was not passed this run.
      // Absent when the journal held only orphaned nested records (issue #3754).
      const newestSegment = journal.segments[journal.segments.length - 1];
      if (newestSegment?.roleArn && !options.roleArn) {
        // `safe()`'s 255-code-point default is the WRONG cap for an ARN, and
        // this is the one site in this file holding one (issue
        // go-to-k/cdkd#3397 review). An AWS-legal role ARN reaches ~613 --
        // a 512-character path plus a 64-character name -- so the default cut
        // it at 255 and appended `[cut: N more characters withheld]` INSIDE the
        // sentence whose only job is to say which role to pass back, which is
        // verbatim the failure `ROLE_ARN_MAX_CODE_POINTS` exists to prevent.
        // Not caught by the display fence: it checks that a sanitizer was
        // CALLED, never which cap the call passed.
        // Named only when `safeRoleArn` is the identity on it, described
        // otherwise: the journal value sits beside `--role-arn`, the flag the
        // note asks the operator to pass it to (go-to-k/cdkd#4214).
        // `isIamRoleArn` too: `PLAIN_IDENT` admits a `--flag=` or `~user`
        // shape, which is not a role ARN (review of #4270).
        const roleArnIsPlain =
          isIamRoleArn(newestSegment.roleArn) &&
          safeRoleArn(newestSegment.roleArn) === newestSegment.roleArn;
        logger.info(
          (roleArnIsPlain
            ? `Note: the failed deploy ran with --role-arn ${safeRoleArn(newestSegment.roleArn)}; `
            : `Note: the failed deploy ran with --role-arn and a role ARN that is not a plain ` +
              `identifier (read it from the rollback journal); `) +
            `this rollback is running with ambient credentials (pass --role-arn to match).`
        );
      }

      // Issue #4018: each segment is replayed under the prefix flag its deploy
      // ran with, so a re-create asks AWS for the name that deploy (and its
      // in-process rollback) would. A segment an older cdkd wrote carries no
      // flag: fall back to the deploy's own resolution minus the CLI flag
      // (env, the cdk.json in the current directory, the default), resolved
      // once and only when needed, and say so BEFORE the confirmation.
      let fallbackSkipPrefix: boolean | undefined;
      const legacySkipPrefix = (): boolean =>
        (fallbackSkipPrefix ??= resolveSkipPrefix({ quiet: true }));
      const legacySegments = journal.segments.filter((s) => s.skipPrefix === undefined).length;
      if (legacySegments > 0) {
        logger.warn(
          safeMsg`${legacySegments} of ${journal.segments.length} rollback journal segment(s) ` +
            'were recorded by a cdkd that did not record the user-supplied-name prefix ' +
            'setting; replaying them with the stack-name prefix ' +
            (legacySkipPrefix() ? 'SKIPPED' : 'KEPT') +
            ' on user-supplied physical names (CDKD_PREFIX_USER_SUPPLIED_NAMES / ' +
            'context.cdkd.prefixUserSuppliedNames in ./cdk.json / the default). If the failed ' +
            'deploy ran with --prefix-user-supplied-names, re-run with ' +
            'CDKD_PREFIX_USER_SUPPLIED_NAMES=true instead.'
        );
      }
      // go-to-k/cdkd#4438: the stack's create-token ledger, so the replay's
      // re-creates send the stack's tokens and a Retain it honours rotates them.
      const createTokenLedger = ledgerForStack(setup.stateBackend, stackName, region);
      /** The async scope a segment replays in: its stack name and its prefix flag. */
      const inSegmentScope = <T>(
        segment: { skipPrefix?: boolean },
        fn: () => Promise<T>
      ): Promise<T> =>
        withSkipPrefix(segment.skipPrefix ?? legacySkipPrefix(), () =>
          withStackName(stackName, () => withCreateTokenLedger(createTokenLedger, fn))
        );

      // 5. Plan — newest-first, one block per segment.
      logger.info(`\nRollback plan for ${stackRegionShown(stackName, region)}:`);
      if (!stackRegionIsPlain(stackName, region)) logger.info(STACK_REGION_DESCRIBED_NOTE);
      if (orphanedPending > 0) {
        logger.info(
          safeMsg`\n  Discard ${orphanedPending} record(s) of nested deploys whose parent run no longer ` +
            `has a journal to replay them (nothing else would ever replay them).`
        );
      }
      // Plan preview walks a COPY of state so it does not disturb replay.
      const planStateView: Record<string, ResourceState> = { ...stateResources };
      for (let s = journal.segments.length - 1; s >= 0; s--) {
        const segment = journal.segments[s]!;
        logger.info(
          `\n  Segment ${s + 1}/${journal.segments.length} (${safe(segment.reason)}${segment.runId ? `, run ${safe(segment.runId)}` : ''}):`
        );
        // go-to-k/cdkd#4523: ops of a logical id `cdkd import` adopted after
        // this segment was recorded are left alone, failed ones included.
        const failedOps = splitImportedOps(segment.failedOperations ?? [], segment);
        // An id named by `--orphan` is never set aside: the flag is honoured.
        const completedOps = splitImportedOps(segment.operations, segment, orphanLogicalIds);
        for (const op of [...failedOps.imported, ...completedOps.imported]) {
          logger.info(importedOpLabel(op));
        }
        for (const op of [...failedOps.displaced, ...completedOps.displaced]) {
          logger.info(displacedOpLabel(op, segment));
        }
        // #1198: the segment's FAILED in-flight op(s) come first (they are
        // the newest work of the failed deploy).
        // go-to-k/cdkd#4584: without `--revert-failed` only the proven
        // failed-CREATE orphans are acted on — the journal is their only
        // record — and every other failed op is left as-is.
        const failedToReplay = failedOpsToReplay(failedOps.replay, options.revertFailed === true);
        if (failedOps.replay.length > 0) {
          if (failedToReplay.length > 0) {
            // go-to-k/cdkd#4754: the replay re-checks a kept fix-forward
            // orphan before skipping it, so the plan the user confirms does
            // too, in the scope its replay runs in; the replay then keeps
            // whatever this preview could not prove.
            const failedPlan = await inSegmentScope(segment, () =>
              recheckFailedPlan(planFailedOps(failedToReplay, planStateView), planStateView, {
                providerRegistry,
                region,
                logger,
              })
            );
            for (const item of failedPlan) {
              logger.info(failedActionLabel(item, options.skipFinalSnapshot === true));
              // A failed nested row's revert replays its child's journal too.
              if (revertedNestedRowIds([item.op]).length > 0) {
                for (const line of await previewNestedChildRevert(
                  setup.stateBackend,
                  nestedChildStackName(stackName, item.op.logicalId),
                  region,
                  segment.runId,
                  options.skipFinalSnapshot === true
                )) {
                  logger.info(line);
                }
              }
            }
            applyFailedPlanToPreview(failedPlan, planStateView, options.skipFinalSnapshot === true);
          }
          for (const fop of failedOps.replay.filter((op) => !failedToReplay.includes(op))) {
            // Each journal value is named only when plain, described
            // otherwise: the line names `--revert-failed` (go-to-k/cdkd#4214).
            logger.info(
              `  - (left as-is) ${logicalIdShown(fop.logicalId)} (${resourceTypeShown(fop.resourceType)}) ` +
                `— its ${plainOrDescribed(fop.changeType, 'change type')} ` +
                `FAILED mid-deploy; pass --revert-failed to attempt reverting it`
            );
          }
        }
        const plan = planRollback(completedOps.replay, planStateView, orphanLogicalIds);
        for (const item of plan) {
          logger.info(actionLabel(item, options.skipFinalSnapshot === true));
          // Issue #3754: a nested row's revert replays its CHILD's journal, so
          // what that replay deletes or re-creates is part of what the user
          // confirms below.
          if (revertedNestedRowIds([item.op]).length > 0) {
            for (const line of await previewNestedChildRevert(
              setup.stateBackend,
              nestedChildStackName(stackName, item.op.logicalId),
              region,
              segment.runId,
              options.skipFinalSnapshot === true
            )) {
              logger.info(line);
            }
          }
        }
        // Apply the segment's effect to the preview so an earlier segment's
        // plan reflects the later segment's already-unwound state.
        applyPlanToPreview(plan, planStateView, options.skipFinalSnapshot === true);
      }
      logger.info('');

      if (!skipConfirmation) {
        // go-to-k/cdkd#4678: name the side effect, as destroy's prompt does.
        const ok = await confirm(
          `Roll back ${stackRegionShown(stackName, region)}` +
            (options.removeProtection === true
              ? ', TURNING DELETION PROTECTION OFF on the resources it deletes from this stack and the nested stacks it reverts?'
              : '?')
        );
        if (!ok) {
          logger.info('Rollback cancelled');
          return;
        }
      }

      // Issue #3754: the orphaned nested records go now — after the
      // confirmation, before the first pop, so the positional pops below act on
      // the journal the plan showed.
      if (orphanedPending > 0) {
        const discarded = await setup.stateBackend.dropRollbackJournalSegments(
          stackName,
          region,
          (s) => s.reason === NESTED_PENDING_PARENT_REASON
        );
        logger.info(
          safeMsg`Discarded ${discarded} record(s) of nested deploys whose parent run no longer has a ` +
            `journal to replay them.`
        );
      }

      // 6. Events recorder for this rollback run.
      const eventRecorder = startRunRecorder({
        backend: setup.stateBackend,
        stackName,
        region,
        command: 'rollback',
      })!;

      const ctx: RollbackExecutorContext = {
        providerRegistry,
        region,
        logger: logger.child('rollback'),
        // go-to-k/cdkd#3869: masked by the printing bags bound where the event
        // is recorded (a failed-op replay's), as its log lines are.
        recordEvent: (e) => eventRecorder.record(maskEventTextWithBoundBags(e)),
        finalSnapshotClients,
        skipFinalSnapshot: options.skipFinalSnapshot === true,
        // go-to-k/cdkd#4678: only on an explicit flag.
        ...(options.removeProtection === true && { removeProtection: true }),
        // go-to-k/cdkd#4696: a journaled orphan another stack's record holds
        // now is not deleted, nor stripped of protection. Lazy: read only
        // when such an orphan reaches its delete.
        foreignHolder: makeForeignHolderScan(setup.stateBackend)({ stackName, region }),
        // Issue #2057: the producer regions this stack read across. A replayed
        // `{{resolve:...}}` expression that a cross-region read put in this
        // record carries no region of its own, so without this the replay
        // re-resolves it HERE and writes a same-named foreign secret to a live
        // resource. Derived from the state this command already loaded — see
        // `producerRegionsFromState`.
        importedProducerRegions: producerRegionsFromState(baseState),
        // go-to-k/cdkd#4174: a nested child rolled back on its own has no
        // parent to hand down the regions its parent reads from, and a
        // parent-supplied value is recorded region-less, so its evidence is
        // incomplete. The key is `<parent>~<id>` (CDK bars `~` in a stack
        // name), whatever the record's own `parentStack` says.
        ...((stackName.includes('~') || baseState.parentStack !== undefined) && {
          producerRegionsIncomplete: true,
        }),
      };

      // 7. Serialized incremental state save after every mutating op.
      //
      // Best-effort by design: the AWS revert already succeeded by the time
      // this runs, so a state-save failure must NOT be counted as a rollback
      // failure (which would block the segment pop and mislabel a clean revert
      // as a per-op failure). It also must not desync `currentEtag`: on a
      // conflict we re-read the fresh ETag and retry once (mirrors the deploy
      // engine's post-rollback save) so a single transient blip cannot cascade
      // every remaining op into a 412. `afterOp` therefore never throws.
      let currentEtag = stateData.etag;
      const saveState = async (): Promise<void> => {
        // Once a save declined a divergent rewrite, no later op's save may land
        // on that record either. Not left to the stale ETag alone: an explicit
        // skip does not depend on the backend refusing the conditional write.
        if (declinedDivergentRewrite) return;
        // `skippedOutputs` (issue #2740) is dropped rather than spread through,
        // as `cdkd import`, `cdkd drift --accept` and the orphan rewrite drop
        // it. Like `import`, this writer can ADD an attribute key: the
        // replacement / re-adopt arm rebuilds a record with
        // `attributes: createResult.attributes ?? {}`
        // (`rollback-executor/replay-reverse-replacement.ts`), the two UPDATE
        // arms take the attributes `update()` returned
        // (`recordAfterRollbackUpdate`, go-to-k/cdkd#4434), and either can
        // return a fuller set than the record the old state held — the same "a provider now builds
        // an attribute an output reads" shape the module doc lists as a blind
        // spot. Every resource then reports NO_CHANGE against the reverted
        // template, so the diff's change map cannot un-bind and the digest is
        // unmoved; carried, the record would preview a key as absent while the
        // next deploy publishes it.
        const { skippedOutputs: _droppedByRollback, ...carriedState } = baseState;
        const next = (): StackState => ({
          ...carriedState,
          version: STATE_SCHEMA_VERSION_CURRENT,
          region,
          resources: { ...stateResources },
          ...orphansAfterRollback(baseState, mintedOrphans),
          lastModified: Date.now(),
        });
        try {
          currentEtag = await setup.stateBackend.saveState(stackName, region, next(), {
            ...(currentEtag !== undefined && { expectedEtag: currentEtag }),
          });
        } catch {
          try {
            const fresh = await setup.stateBackend.getState(stackName, region);
            // The record was rewritten under this run (the first save's
            // conditional write lost), and the rewrite carries a body region
            // that is not the key's (go-to-k/cdkd#3370). Saving `next()` over
            // it would stamp the KEY's region in — deciding the very question
            // the start-of-run refusal declines to decide. Leave it: the flag
            // keeps the journal segment and the record and exits partial once
            // this segment's replay returns; the throw lands in the warn below.
            if (fresh?.divergentBodyRegion !== undefined) {
              declinedDivergentRewrite = true;
              declinedDivergentReason = divergedDuringRollbackMessage(fresh.divergentBodyRegion);
              throw new Error(declinedDivergentReason);
            }
            currentEtag = await setup.stateBackend.saveState(stackName, region, next(), {
              ...(fresh?.etag !== undefined && { expectedEtag: fresh.etag }),
            });
          } catch (retryError) {
            // The decline gets its own text: the generic "re-run to reconcile"
            // below would send the operator straight into the start-of-run
            // refusal, which holds until the record's region field is repaired.
            if (declinedDivergentRewrite) {
              logger.warn(
                `Did not persist state after a rollback operation: ${declinedDivergentReason}. ` +
                  `The resource was reverted in AWS. Repair the record's region field to match ` +
                  `the key it is stored under, then run the rollback again to reconcile state.`
              );
              return;
            }
            logger.warn(
              `Failed to persist state after a rollback operation: ${backendErrorText(retryError, stackName, region)}. ` +
                `The resource was reverted in AWS; re-run the rollback to reconcile state.` +
                // `displayIdent` (what `safeStack` applies) bounds a JSON string,
                // not a shell word, so the name went on a trailing labelled line
                // behind the shared gate instead (go-to-k/cdkd#3436).
                rerunRollback(stackName)
            );
          }
        }
      };

      // 8. Replay segments strictly newest-first; pop each after a clean run.
      const oldestInitialDeploy = journal.segments[0]?.initialDeploy === true;
      let totalFailures = 0;
      let totalWarnings = 0;
      // go-to-k/cdkd#4633: proven orphans whose delete failed, for the
      // `--drop-failed` pointer on the exit below.
      const failedOrphanIds: string[] = [];
      // go-to-k/cdkd#4225: ONE record of completed writes across every replay
      // below, all over `stateResources`, so a revert keeps an inline policy
      // name an earlier replay (a failed op, an earlier segment) put back.
      const inlinePolicyWriters = new RollbackInlinePolicyWriters();
      // go-to-k/cdkd#3869: ONE printing bag over every segment's failed ops,
      // as `cdkd destroy`'s batch is, judged before any replay changes
      // `stateResources`: an orphan in one segment can name a resource an
      // entry of another segment holds. A failed op left as-is only over-masks.
      const failedOpsPrinting = journaledOrphanPrintingBag(
        journal.segments.flatMap((s) => s.failedOperations ?? []),
        stateResources
      );
      try {
        while (journal.segments.length > 0) {
          if (interrupted) break;
          const segment = journal.segments[journal.segments.length - 1]!;
          // go-to-k/cdkd#4523: the plan above listed these as left alone; the
          // replay below never sees them. A DISPLACED op (another resource the
          // import replaced under the id) is a warning: nothing reverts it.
          const completedSplit = splitImportedOps(segment.operations, segment, orphanLogicalIds);
          const completedOps = completedSplit.replay;
          // A displaced FAILED op counts whether or not `--revert-failed` is
          // passed: the plan lists it either way, and nothing ever reverts it,
          // so a run that then pops the segment must still say so (exit 2).
          const displaced = [
            ...completedSplit.displaced,
            ...splitImportedOps(segment.failedOperations ?? [], segment).displaced,
          ];
          for (const op of displaced) logger.warn(displacedOpLabel(op, segment).trim());
          recordDisplacedSkips(ctx.recordEvent, stackName, displaced);
          // Issue #3754: what the nested-stack rows' child replays reported
          // (completed rows, skipped ops), read once the segment has replayed.
          let nestedRun: NestedRevertRun | undefined;
          const result = await withNestedStackContext(
            {
              stateBackend: setup.stateBackend,
              lockManager: setup.lockManager,
              providerRegistry,
              parentStackName: stackName,
              parentRegion: region,
              accountId: 'unknown',
              awsClients: setup.awsClients,
              stateBucket: setup.bucket,
              exportIndexStore: setup.exportIndexStore,
              destroyOptions: {
                ...(options.profile && { profile: options.profile }),
                statePrefix: options.statePrefix,
                // A nested child's revert (issue #3754) replays its own
                // journal through this context, so the opt-out must reach it.
                ...(options.skipFinalSnapshot === true && { skipFinalSnapshot: true }),
                // go-to-k/cdkd#4703: and `--remove-protection`, only when
                // passed; the child replay pairs it with a child-scoped
                // foreign-holder scan.
                ...(options.removeProtection === true && { removeProtection: true }),
              },
            },
            // Issue #3754: a nested-stack row in this segment is reverted by
            // replaying its child's journal segments for the SAME run.
            () =>
              withNestedRevertRun(segment.runId, (run) => {
                nestedRun = run;
                return inSegmentScope(segment, async () => {
                  // #1198: revert the segment's FAILED in-flight op(s) first
                  // (opt-in). Their revert is independent of the completed-op
                  // replay (one op per resource per deploy), so a failed-op
                  // revert failure still lets the completed ops replay — the
                  // summed failure count keeps the segment from popping.
                  let failedOpFailures = 0;
                  let failedOpWarnings = 0;
                  // go-to-k/cdkd#4523: an imported id's failed op is left alone
                  // too, and stays in the journal (below).
                  const failedOps = splitImportedOps(segment.failedOperations ?? [], segment);
                  // go-to-k/cdkd#4584: a plain rollback replays the proven
                  // orphans alone; the rest are kept by the strip below while
                  // the segment stays, and leave with it once it pops.
                  const failedToReplay = failedOpsToReplay(
                    failedOps.replay,
                    options.revertFailed === true
                  );
                  if (failedToReplay.length > 0) {
                    // go-to-k/cdkd#3869: the failed ops replay under a PRINTING
                    // bag judged from their journal entries, as `cdkd
                    // destroy`'s orphans do: a provider's delete lines and the
                    // events mask a name derived from a secret, and one an
                    // orphan READ from a record.
                    // Nested inside the batch bag: this segment's ops judged
                    // against the state as it stands NOW, so a name a newer
                    // segment's completed-op revert restored is caught too.
                    const failedResult = await withPrintingSecrets(failedOpsPrinting, () =>
                      withPrintingSecrets(
                        journaledOrphanPrintingBag(failedToReplay, stateResources),
                        () =>
                          replayFailedOperations(failedToReplay, stateResources, stackName, ctx, {
                            afterOp: saveState,
                            isInterrupted: () => interrupted,
                            // Failed-only segment: replayRollback below returns
                            // early without the STARTED/FINISHED envelope, so the
                            // failed-op replay owns it (events symmetry). For a
                            // MIXED segment the failed-op ROLLBACK_RESOURCE_*
                            // events land just before replayRollback's
                            // ROLLBACK_STARTED — accepted cosmetic ordering (the
                            // events stream is informational; the reader derives
                            // nothing from envelope position).
                            // The REPLAYED list, not `segment.operations`: an
                            // all-imported segment hands replayRollback nothing,
                            // and it then emits no envelope (cosmetic ordering
                            // only, unpinned on purpose).
                            emitEnvelope: completedOps.length === 0,
                            // Same reason as the sibling replay below: `afterOp`
                            // saves per op, so a record appended only after this
                            // returns is absent from every intermediate save
                            // (issue #2934).
                            onOrphan: (record) => mintedOrphans.push(record),
                            inlinePolicyWriters,
                          })
                      )
                    );
                    failedOpFailures = failedResult.failures;
                    failedOpWarnings = failedResult.warnings;
                    // Read only on the failures exit, never the interrupt one,
                    // so an op an interrupt left unreached is never named.
                    for (const op of failedResult.remainingFailedOps) {
                      if (isJournaledOrphan(op) && op.physicalIdRecoveredFromError === true) {
                        failedOrphanIds.push(op.logicalId);
                      }
                    }

                    // Idempotency: persist ONLY the still-pending failed ops
                    // (per-op strip). A handled op must never be re-issued on a
                    // re-run — replaying `attemptedProperties` as the previous
                    // diff side against an already-reverted resource would
                    // generate a patch undoing changes that no longer exist
                    // (fails on patch-based providers). Runs on the interrupt /
                    // failure paths too so partial progress is never lost.
                    // Best-effort: on a strip failure the re-run merely
                    // re-attempts the revert.
                    const remaining = [
                      ...failedOps.imported,
                      ...failedOps.displaced,
                      ...failedOps.replay.filter((op) => !failedToReplay.includes(op)),
                      ...failedResult.remainingFailedOps,
                    ];
                    // NOT after a declined divergent rewrite (go-to-k/cdkd#3370):
                    // the handled ops' state rows were never saved, so stripping
                    // them would leave the record describing work the journal no
                    // longer carries. Kept, the re-run after the region repair
                    // replays them against the unsaved rows and reconciles (a
                    // failed-CREATE delete reads not-found as done).
                    if (
                      !declinedDivergentRewrite &&
                      remaining.length !== (segment.failedOperations ?? []).length
                    ) {
                      try {
                        await setup.stateBackend.setRollbackJournalFailedOperations(
                          stackName,
                          region,
                          remaining
                        );
                        if (remaining.length === 0) delete segment.failedOperations;
                        else segment.failedOperations = remaining;
                      } catch (stripError) {
                        logger.warn(
                          safeMsg`Failed to strip replayed failed-ops from the journal: ${backendErrorText(stripError, stackName, region)}`
                        );
                      }
                    }
                    if (failedResult.interrupted) {
                      return {
                        failures: failedOpFailures,
                        warnings: failedOpWarnings,
                        interrupted: true,
                      };
                    }
                  }
                  // go-to-k/cdkd#3869: the completed ops revert under a PRINTING
                  // bag judged from their journal entries and the records they
                  // replaced, against the state as it stands now: a provider's
                  // delete of a resource the failed deploy created, named from
                  // a secret, prints its name otherwise.
                  const replayResult = await withPrintingSecrets(
                    journaledOrphanPrintingBag(
                      completedReplayEntries(completedOps),
                      stateResources
                    ),
                    () =>
                      replayRollback(completedOps, stateResources, stackName, ctx, {
                        orphanLogicalIds,
                        afterOp: saveState,
                        isInterrupted: () => interrupted,
                        // Pushed from INSIDE the replay, not after it returns: the
                        // `afterOp` above saves per op, so a record appended only
                        // on return would be missing from every intermediate save
                        // — and a crash there loses it for good (issue #2934).
                        onOrphan: (record) => mintedOrphans.push(record),
                        inlinePolicyWriters,
                      })
                  );
                  return {
                    failures: replayResult.failures + failedOpFailures,
                    warnings: replayResult.warnings + failedOpWarnings,
                    interrupted: replayResult.interrupted,
                  };
                });
              })
          );
          totalFailures += result.failures;
          // A nested row whose child replay skipped ops reports `partial`,
          // which the executor counts as restored; count the skips here.
          totalWarnings += result.warnings + (nestedRun?.warnings ?? 0) + displaced.length;
          // Before the pop, and before the interrupt check so a Ctrl-C landing
          // in the same segment does not relabel this stop.
          if (declinedDivergentRewrite) break;
          if (result.interrupted) {
            interrupted = true;
            break;
          }
          if (result.failures > 0) {
            // A per-op failure keeps this (and older) segment(s) for a re-run.
            break;
          }
          // Segment fully replayed — pop it (persists the shortened journal).
          await setup.stateBackend.popRollbackJournalSegment(stackName, region);
          journal.segments.pop();
          // The nested children whose replay this segment COMPLETED are
          // settled with it (issue #3754): drop their pending segments for the
          // same run. Best-effort, and after the pop so a failed pop re-runs the
          // rows against segments that are still there.
          await dropSettledNestedJournals({
            stateBackend: setup.stateBackend,
            lockManager: setup.lockManager,
            parentStackName: stackName,
            region,
            settled: nestedRun?.settled ?? new Map(),
            runId: segment.runId,
            logger,
          });
        }
      } finally {
        await eventRecorder.finalize(
          totalFailures > 0 || interrupted || declinedDivergentRewrite ? 'FAILED' : 'SUCCEEDED'
        );
      }

      // 9. Terminal state: an initial-deploy rollback that emptied state
      // deletes state.json so `cdkd list` shows no ghost stack.
      //
      // ...UNLESS this rollback left something in AWS (issue #2934). A
      // `DeletionPolicy: Retain` resource survives the rollback, and the record
      // of it is the ONLY thing that lets the next deploy re-adopt it rather
      // than collide with the deterministic name it still holds. Deleting
      // state.json here would take that record with it — in exactly the
      // first-deploy-fails flow the record exists for, since that flow is
      // precisely where `resources` ends up empty.
      //
      // A stack with records is not a ghost: cdkd has left something in the
      // account and can still say what. The automatic rollback never deletes
      // state at all, so this also removes a disagreement between the two
      // paths — though only in the orphan case; with no records this command
      // still deletes and the automatic one still does not.
      const survivingOrphans = orphansAfterRollback(baseState, mintedOrphans).orphans ?? [];
      if (
        journal.segments.length === 0 &&
        oldestInitialDeploy &&
        Object.keys(stateResources).length === 0 &&
        survivingOrphans.length === 0
      ) {
        await setup.stateBackend.deleteState(stackName, region);
        // go-to-k/cdkd#4705: the record is gone, so its registry marker goes
        // too (record first, then marker; non-fatal).
        await releaseRegistryMarkerQuietly(setup.stateBackend, stackName, region, logger);
        logger.info(
          `State for ${stackRegionShown(stackName, region)} removed (stack fully rolled back).`
        );
      }

      // 10. Exit codes.
      if (declinedDivergentRewrite) {
        throw new PartialFailureError(
          `Rollback stopped: ${declinedDivergentReason}.` +
            (totalFailures > 0 ? ` ${totalFailures} operation(s) also failed.` : '') +
            ` Journal preserved (this segment, any older ones, and their failed operations) — ` +
            `re-run the rollback once the record's region field matches its key.`
        );
      }
      if (interrupted) {
        throw new PartialFailureError(
          `Rollback interrupted. Journal preserved — re-run the rollback to finish.` +
            rerunRollback(stackName)
        );
      }
      if (totalFailures > 0) {
        throw new PartialFailureError(
          `Rollback completed with ${totalFailures} failed operation(s). Journal preserved — ` +
            `re-run the rollback to retry.` +
            dropFailedHint(stackName, region, failedOrphanIds) +
            rerunRollback(stackName)
        );
      }
      if (totalWarnings > 0) {
        throw new PartialFailureError(
          `Rollback completed with ${totalWarnings} skipped/unrecoverable operation(s) (see warnings above).`
        );
      }
      logger.info(`\nRollback of ${stackRegionShown(stackName, region)} complete.`);
    } finally {
      // Release FIRST, unregister LAST (issue #2118). While the release
      // round-trip is in flight the lock is still held, so the handlers must
      // stay armed: with them gone the process has ZERO SIGINT listeners and a
      // Ctrl-C landing there takes Node's default terminate, the release never
      // completes, and the lock sits for its full 30-minute TTL — blocking the
      // next `cdkd rollback` / `deploy` / `destroy` on that stack. Same rule
      // `destroy-runner.ts` states for its strong-ref refusal path, and the
      // mirror of issue #1348 at the other end of the lock's life.
      //
      // The unregistration lives in its own `finally` as defence in depth: the
      // `.catch` below covers a REJECTION, not a synchronous throw. Nothing in
      // `LockManager` can throw synchronously today (`releaseLock` is `async`,
      // so even a client-construction failure surfaces as a rejection), so this
      // guards a shape rather than a live leak — worth keeping because the leak
      // it would prevent is per-command and permanent.
      //
      // The order WITHIN the pair is consistency, not mechanism, and is called
      // out because an earlier draft of this comment claimed otherwise. The two
      // calls are adjacent and synchronous, so no signal can be delivered
      // between them; and `unforwardSigterm()` first would NOT empty the
      // listener set, because `sigintHandler` is still registered at that point.
      // Removing this command's own handler last simply keeps the whole block
      // reading in one direction — the real requirement is the release above.
      try {
        await setup.lockManager.releaseLock(stackName, region).catch((err) => {
          logger.warn(
            `Failed to release lock for ${quotedOrDescribed(stackName, 'stack name')} (${plainOrDescribed(region, 'region')}): ${backendErrorText(err, stackName, region)}`
          );
        });
      } finally {
        process.removeListener('SIGINT', sigintHandler);
        unforwardSigterm();
      }
    }
  } finally {
    // Restore the process-global client set BEFORE disposing ours, so a
    // later consumer in the same process never reaches a destroyed client.
    if (stackAwsClients) {
      setAwsClients(setup.awsClients);
      stackAwsClients.destroy();
    }
    setup.dispose();
  }
}

/**
 * Judge a nested child's `nested-pending-parent` records (issue #3754) before
 * anything is shown or written. Returns how many are ORPHANS to discard after
 * the confirmation; THROWS when one may still be needed.
 *
 * - A record whose run the direct parent's journal still holds is LIVE: only a
 *   rollback of the top-level stack may replay it, so the command refuses.
 * - The parent's journal being UNREADABLE (a throttle, a newer journal version,
 *   a malformed body) is not "no journal": the record cannot be judged, so the
 *   command refuses rather than discard one the parent will need.
 * - An in-flight top-level deploy writes its journal only when it fails, so its
 *   run is invisible while it runs; a LIVE lock on the top-level stack refuses
 *   too. (Its child deploys and reverts take this child's lock, which this
 *   command holds, so no new record can land while it runs.)
 * - Everything else — including a record with no run id, which no parent run
 *   can select — is an orphan: its parent run settled without dropping it,
 *   crashed before writing a journal, or the drop failed.
 */
async function judgeNestedPendingRecords(
  setup: {
    stateBackend: Pick<S3StateBackend, 'loadRollbackJournal'>;
    lockManager: { getLockInfo(stack: string, region: string): Promise<LockInfo | null> };
  },
  stackName: string,
  region: string,
  segments: ReadonlyArray<{ reason: string; runId?: string }>
): Promise<number> {
  const pending = segments.filter((s) => s.reason === NESTED_PENDING_PARENT_REASON);
  if (pending.length === 0) return 0;
  const lastCut = stackName.lastIndexOf('~');
  const parent = lastCut > 0 ? stackName.slice(0, lastCut) : undefined;
  const topLevel = stackName.split('~')[0]!;
  const refuse = (detail: string): never => {
    throw new Error(
      `The rollback journal of nested stack ${safeStack(stackName)} (${safe(region)}) holds the ` +
        `record of a nested deploy that ${detail} Roll back the top-level stack ` +
        `${safeStack(topLevel)} instead, or re-deploy it, which clears the record.`
    );
  };
  if (parent === undefined) return pending.length;

  let parentJournal: { segments: ReadonlyArray<{ runId?: string }> } | null;
  try {
    parentJournal = await setup.stateBackend.loadRollbackJournal(parent, region);
  } catch (error) {
    return refuse(
      `cannot be judged: the journal of its parent ${safeStack(parent)} could not be read ` +
        `(${backendErrorText(error, parent, region)}), so the record may still be needed.`
    );
  }
  const parentRuns = new Set(
    (parentJournal?.segments ?? []).flatMap((s) => (s.runId !== undefined ? [s.runId] : []))
  );
  if (pending.some((s) => s.runId !== undefined && parentRuns.has(s.runId))) {
    refuse(`its parent has not settled, which only a rollback of the top-level stack may replay.`);
  }

  let lock: LockInfo | null;
  try {
    lock = await setup.lockManager.getLockInfo(topLevel, region);
  } catch (error) {
    return refuse(
      `cannot be judged: the lock of the top-level stack could not be read ` +
        `(${backendErrorText(error, topLevel, region)}).`
    );
  }
  if (lock && !isLockInfoExpired(lock)) {
    refuse(
      `may belong to a deploy still running: the top-level stack is locked. Retry once it is ` +
        `free.`
    );
  }
  return pending.length;
}

/**
 * The plan lines for a nested row's revert (issue #3754): the child's journal
 * segments for `runId`, planned against the child's state, indented under the
 * row. Read-only and best-effort — a preview that cannot be built says so
 * rather than failing the command; the revert itself refuses what it cannot
 * do.
 */
async function previewNestedChildRevert(
  backend: Pick<S3StateBackend, 'getState' | 'loadRollbackJournal'>,
  childStackName: string,
  region: string,
  runId: string | undefined,
  skipFinalSnapshot: boolean
): Promise<string[]> {
  // Named only when plain, described otherwise, for the reason
  // `stackRegionShown` gives: this line is part of the run that can end in a
  // `Re-run with:` row (go-to-k/cdkd#3760). A described child carries the
  // same `cdkd state list --long` pointer the header does, since the parent's
  // name can be plain while the child's journal-sourced logical id is not.
  const plain = isPasteableIdent(childStackName);
  const shown = plain
    ? `nested stack ${childStackName}`
    : 'a nested stack whose name is not a plain identifier';
  const withPointer = (lines: string[]): string[] =>
    plain ? lines : [...lines, `        ${NESTED_NAME_DESCRIBED_NOTE}`];
  if (runId === undefined) {
    return withPointer([
      `      (${shown}: this segment carries no deploy run id — its revert will FAIL ` +
        `and the segment is kept)`,
    ]);
  }
  try {
    const [childState, journal] = await Promise.all([
      backend.getState(childStackName, region),
      backend.loadRollbackJournal(childStackName, region),
    ]);
    const segments = (journal?.segments ?? []).filter((s) => s.runId === runId);
    if (!childState || segments.length === 0) {
      return withPointer([
        `      (${shown}: no journal record for this run — its revert will FAIL ` +
          `and the segment is kept)`,
      ]);
    }
    const view: Record<string, ResourceState> = { ...childState.state.resources };
    const lines = [`      ${shown} replays its own journal:`];
    for (let s = segments.length - 1; s >= 0; s--) {
      // go-to-k/cdkd#4523: the child replay leaves an imported id's ops alone.
      const childOps = splitImportedOps(segments[s]!.operations, segments[s]!);
      for (const op of childOps.imported) lines.push(`    ${importedOpLabel(op)}`);
      for (const op of childOps.displaced) lines.push(`    ${displacedOpLabel(op, segments[s]!)}`);
      const childPlan = planRollback(childOps.replay, view, new Set<string>());
      for (const item of childPlan) lines.push(`    ${actionLabel(item, skipFinalSnapshot)}`);
      applyPlanToPreview(childPlan, view, skipFinalSnapshot);
    }
    if (lines.length === 1) lines.push('        (nothing to undo)');
    return withPointer(lines);
  } catch (error) {
    // `backendErrorText`, not `safe()`: the backend's message re-spells the
    // child's name, padding included, so a padded name is withheld whole
    // (go-to-k/cdkd#3760).
    return withPointer([
      `      (${shown}: could not preview its revert: ` +
        `${backendErrorText(error, childStackName, region)})`,
    ]);
  }
}

/**
 * Will the replay REFUSE this planned Snapshot delete instead of performing
 * it (issue #1368)? The preview must not unwind a record for an op that
 * never runs — the same question {@link snapshotNote} answers for the label,
 * asked with the same predicate and the same route, so the label and the
 * previewed state cannot disagree.
 */
function planItemWillBeRefused(
  resourceType: string,
  effectiveProvisionedBy: 'sdk' | 'cc-api' | undefined,
  skipFinalSnapshot: boolean
): boolean {
  // Under the opt-out nothing is refused — every shape plain-deletes.
  if (skipFinalSnapshot) return false;
  return refusesFinalSnapshot(resourceType, effectiveProvisionedBy);
}

/**
 * Apply a planned segment's effect to the plan-preview state so the NEXT
 * (older) segment's plan is classified against already-unwound state.
 * Mirrors what `replayRollback` mutates, without touching AWS.
 */
function applyPlanToPreview(
  plan: RollbackPlanItem[],
  previewState: Record<string, ResourceState>,
  skipFinalSnapshot: boolean
): void {
  for (const item of plan) {
    const { op, action } = item;
    switch (action) {
      case 'delete-with-final-snapshot':
        // A refused Snapshot delete leaves the resource AND its record in
        // place (issue #1368). Keeping the record is not cosmetic: an older
        // segment's item for the same logical id is classified against it,
        // and its route is stamped from it — drop it and that item silently
        // falls back to the journaled route, the #1366 defect one layer up.
        if (
          planItemWillBeRefused(op.resourceType, item.effectiveProvisionedBy, skipFinalSnapshot)
        ) {
          break;
        }
        if (op.changeType === 'CREATE') delete previewState[op.logicalId];
        break;
      case 'delete':
      case 'orphan-retain':
      case 'orphan-flag':
        if (op.changeType === 'CREATE') delete previewState[op.logicalId];
        break;
      case 'revert':
      case 'reverse-replacement':
      case 'reverse-replacement-readopt':
        if (op.previousState) previewState[op.logicalId] = op.previousState;
        break;
      default:
        break;
    }
  }
}

/**
 * Apply a planned FAILED-op revert's effect to the plan-preview state
 * (issue #1198). Mirrors `replayFailedOperations` without touching AWS.
 */
function applyFailedPlanToPreview(
  plan: FailedOpPlanItem[],
  previewState: Record<string, ResourceState>,
  skipFinalSnapshot: boolean
): void {
  for (const item of plan) {
    const { op, action } = item;
    switch (action) {
      case 'delete-failed-create-with-final-snapshot':
        // Same refusal carve-out as the completed-op path (issue #1368).
        if (
          planItemWillBeRefused(op.resourceType, item.effectiveProvisionedBy, skipFinalSnapshot)
        ) {
          break;
        }
        // go-to-k/cdkd#4754: nor one proven another resource than the op's.
        if (!recordUnderIdIsNotOwn(op, previewState)) delete previewState[op.logicalId];
        break;
      case 'delete-failed-create':
      // Retain-orphan drops the record too (issue #1362) — the resource
      // stops being cdkd-managed either way. Not a replacement orphan's
      // (go-to-k/cdkd#4604): the record under its id is the replaced resource.
      case 'orphan-failed-create-retain':
        if (!recordUnderIdIsNotOwn(op, previewState)) delete previewState[op.logicalId];
        break;
      case 'revert-failed-update':
        if (op.previousState) previewState[op.logicalId] = op.previousState;
        break;
      default:
        break;
    }
  }
}

export function createRollbackCommand(): Command {
  const cmd = new Command('rollback')
    .description(
      'Revert a stack to its pre-deploy state after a failed --no-rollback / interrupted deploy ' +
        'or a partially-failed automatic rollback (state-driven, no synth needed).'
    )
    .argument('[stack]', 'Stack name to roll back (defaults to the single journaled stack)')
    .addOption(new Option('--force', 'Skip the confirmation prompt').default(false))
    .addOption(
      new Option(
        '--orphan <logicalId>',
        'Skip the given resource during replay (repeatable). Mirrors cdk rollback --orphan.'
      ).argParser((value: string, previous: string[] | undefined) => [...(previous ?? []), value])
    )
    .addOption(
      new Option(
        '--revert-failed',
        'Also attempt to revert the resource whose operation FAILED mid-deploy. Off by ' +
          'default: the remote state of the failed resource is unknown, so force-applying ' +
          'its previous state is opt-in.'
      ).default(false)
    )
    .addOption(
      new Option(
        '--drop-failed <logicalId>',
        'Remove ONE journaled failed CREATE (a resource cdkd proved it made, journaled as its only ' +
          'record) from the rollback journal, after checking that resource by hand. Replays nothing ' +
          'and deletes nothing in AWS; every other entry is kept.'
      )
    )
    .addOption(skipFinalSnapshotOption)
    .addOption(
      new Option(
        '--remove-protection',
        "Turn deletion protection off before this stack's rollback deletes a resource the " +
          'failed deploy left: one its state records from a completed CREATE, or one a failed ' +
          'CREATE left behind (a journaled orphan, or under --revert-failed the failed CREATE ' +
          'itself) when cdkd can prove it is that resource and no other stack holds it. A nested ' +
          "stack it deletes cascades the flag to that child's resources, and a nested stack it " +
          "reverts carries it into that child's revert. Covers " +
          `${removeProtectionTypeList()}.`
      ).default(false)
    )
    .addOption(stackRegionOption())
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  cdkd rollback MyStack',
        '  cdkd rollback                       # single journaled stack',
        '  cdkd rollback MyStack --force',
        '  cdkd rollback MyStack --orphan MyBucket --orphan MyTable',
        '  cdkd rollback MyStack --revert-failed   # also revert the failed in-flight resource',
        '  cdkd rollback MyStack --skip-final-snapshot  # DeletionPolicy Snapshot → delete without the snapshot',
        '  cdkd rollback MyStack --remove-protection   # also delete protected resources the failed deploy left',
        '  cdkd rollback MyStack --stack-region us-west-2',
        '  cdkd rollback MyStack --drop-failed MyQueuePolicy  # forget one undeletable failed CREATE',
        '',
        'Exit codes: 0 = clean, 2 = partial (journal kept for re-run), 1 = hard error.',
      ].join('\n')
    )
    .action(withErrorHandling(rollbackCommand));

  [...commonOptions, ...stateOptions].forEach((opt) => cmd.addOption(opt));
  cmd.addOption(deprecatedRegionOption);
  return cmd;
}
