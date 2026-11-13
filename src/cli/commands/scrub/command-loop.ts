import {
  findNestedTemplateTreeDefect,
  renderNestedTemplateTreeDefect,
} from '../../../utils/nested-template-cycle.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { cdkdRemedy } from '../../../utils/pasteable-command.js';
import type { getLogger } from '../../../utils/logger.js';
import type { S3StateBackend } from '../../../state/s3-state-backend.js';
import type { LockManager } from '../../../state/lock-manager.js';
import type { LockRecoveryContext } from '../../../state/lock-contention-message.js';
import { ExportIndexStore } from '../../../state/export-index-store.js';
import type { AwsClients } from '../../../utils/aws-clients.js';
import { stackRegionResolver } from '../../region-options.js';
import type { EffectiveRegion } from '../../region-options.js';
// An export NAME is a template-controlled RESOLVED value and an index read's
// error message interpolates a bucket / key, so both reach the terminal only
// through the same control-byte strip `export-index-store.ts` uses for the
// name it logs.
import {
  displayIdent,
  displaySafe,
  displayStackName,
  safeMsg,
} from '../../../utils/display-safe.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import type { StackInfo } from '../../../synthesis/assembly-reader.js';
import { producerRecordKey } from '../../../state/malformed-resources-bag.js';
import {
  ScrubIndexInvariantError,
  renderStateKeyForLine,
  ScrubRefusalError,
  describeFailure,
} from './errors.js';
import type { ScrubOptions } from './command.js';
import { repairExportIndexForStack } from './export-index.js';
import { SCRUB_CLEAN_SCOPE_NOTE } from './save-state.js';
import {
  type NestedChildScrubTarget,
  type ScrubWorkItem,
  nestedChildWorkItem,
  repairParentOutputAttributes,
  unreachedNestedRecords,
} from './nested.js';
import { reportScrubOutcome } from './command-report.js';
import { type ConsumerRecord, readConsumerRecords } from './outputs.js';
import { scrubStack } from './stack.js';

/**
 * The locals of {@link scrubCommand} that {@link runScrubTargets} reads, once
 * the app is synthesized and the targets are chosen and ordered.
 */
interface ScrubTargetsInput {
  options: ScrubOptions;
  logger: ReturnType<typeof getLogger>;
  effectiveRegion: EffectiveRegion;
  region: string;
  stateBucket: string;
  allStacks: StackInfo[];
  targetStacks: StackInfo[];
  refusalRecovery: LockRecoveryContext;
  stateS3: AwsClients;
  stateBackend: S3StateBackend;
  lockManager: LockManager;
}

/**
 * {@link scrubCommand}'s per-stack loop, moved verbatim (go-to-k/cdkd#5835):
 * the run's counters, the work list, and one {@link scrubStack} per item, then
 * {@link reportScrubOutcome} over what the loop counted.
 */
export async function runScrubTargets({
  options,
  logger,
  effectiveRegion,
  region,
  stateBucket,
  allStacks,
  targetStacks,
  refusalRecovery,
  stateS3,
  stateBackend,
  lockManager,
}: ScrubTargetsInput): Promise<void> {
  let totalStacksScrubbed = 0;
  // State records (`producerRecordKey`: name and region) already counted in
  // `totalStacksScrubbed`: a parent whose row attributes are repaired after a
  // child's scrub (go-to-k/cdkd#3961) may have been counted for its own
  // records already, and two Stages sharing a name in two regions are two
  // records (#5176).
  const rewrittenStacks = new Set<string>();
  // Parent-row `Outputs.<Name>` attributes holding a recorded plaintext no
  // child output accounts for (go-to-k/cdkd#3961): a finding, never clean.
  let totalParentAttributesUnmatched = 0;
  // Counted SEPARATELY from the stacks actually rewritten. A key-holding-
  // plaintext finding is a finding the command cannot remedy (issue #1919), and
  // folding it into the scrubbed count made the summary claim a remediation it
  // had not performed — the same invariant the export-name warning enforces:
  // a message must never assert what it did not do.
  let totalStacksWithUnscrubbableKeys = 0;
  // Stacks carrying a cross-stack read cdkd DECLINED to perform by design
  // (issue #2133 review) — today the cross-account `Fn::GetStackOutput` of a
  // redacted value. Counted like `totalStacksWithUnscrubbableKeys` and for the
  // same reason: it is a real finding no re-run can clear, so the summary must
  // not read as clean and `--fail` must not exit 0, but the stack itself was
  // still scrubbed for everything else and must not be refused outright.
  let totalStacksWithUnverifiableReads = 0;
  let totalStacksWithUnverifiableLeaves = 0;
  // Stacks holding a cross-stack read name whose secret ROTATED away
  // (go-to-k/cdkd#3382). Counted like `totalStacksWithUnverifiableReads`: a
  // finding no scrub re-run clears, so neither the summary nor `--fail` may
  // read as clean over it.
  let totalStacksWithUnrepairedReadNames = 0;
  // Output keys the template no longer declares (go-to-k/cdkd#4120): those
  // dropped, the stacks where another stack still reads one (kept, a finding),
  // and the stacks where the other records could not be read (nothing dropped,
  // exit 2).
  let totalOutputKeysDropped = 0;
  let totalStacksWithReadOutputKeys = 0;
  const droppedReadersUnverifiedStacks: string[] = [];
  /**
   * Stacks this `--dry-run` proceeded over with an UNREADABLE resources map
   * (issue go-to-k/cdkd#3018). Tracked exactly like `indexUnreadable`: an
   * audit this run could not perform is a FINDING, never a clean result.
   */
  const malformedRecords: string[] = [];
  /**
   * The same, for the `outputs` bag (issue go-to-k/cdkd#3192). A SECOND list
   * rather than a shared one: the two containers carry different consequences
   * and {@link malformedRecordsAuditedError} names which was unreadable, so
   * merging them would print a sentence about resources over a record whose
   * resource map was fine.
   */
  const malformedOutputRecords: string[] = [];
  /**
   * Stacks whose `orphans` CONTAINER could not be read (go-to-k/cdkd#3379).
   * Its own list for the reason `malformedOutputRecords` is its own: the
   * audited error names the container that is broken.
   */
  const malformedOrphanRecords: string[] = [];
  /**
   * Stacks whose scrub met a PRODUCER record with an unreadable `outputs` map
   * (go-to-k/cdkd#3192 review round 5).
   *
   * Its own list rather than a counter because the refusal NAMES the stacks,
   * and its own list rather than a share of `malformedOutputRecords` because
   * those name records THIS run was scrubbing while these name records it only
   * READ — different remedy, different sentence.
   */
  const damagedProducerStacks: string[] = [];
  // Stacks this run could not scrub at all, one entry per stack (issue #2109
  // review). A refusal is per-REFERENCE evidence but is raised for the whole
  // STACK, and without a boundary here one refused stack in a `--all` run
  // abandoned every stack after it — silently, since the ones before it had
  // already been written. The rollback replay's twin refusal does not behave
  // that way: it is per-op and the remaining ops still run.
  //
  // The run still ends NON-ZERO (see the throw after the summary), so the
  // "never report success over a document it did not scrub" property is kept —
  // it is only the BLAST RADIUS of one refusal that narrows.
  const failures: Array<{ stackName: string }> = [];
  // ONE state listing per run, shared by every stack's nested-record check
  // (go-to-k/cdkd#2252): a `--all` run over N stacks would otherwise list the
  // whole bucket N times. A failed listing is not memoized.
  // A PREBUILT assembly can name a top-level stack `A~B`; that one is a stack of
  // this app, never an unreached nested record of `A`.
  const appStackNames = new Set(allStacks.map((s) => s.stackName));
  let stateRefs: Promise<Array<{ stackName: string; region?: string }>> | undefined;
  const listStateRefs = (): Promise<Array<{ stackName: string; region?: string }>> => {
    stateRefs ??= stateBackend.listStacks().catch((err: unknown) => {
      stateRefs = undefined;
      throw err;
    });
    return stateRefs;
  };

  // Every record's cross-stack reads, loaded at most once per run and only when
  // some stack has an output key to drop (go-to-k/cdkd#4120). A FAILED load is
  // memoized too: the run already ends with exit 2 for it, and re-reading the
  // whole bucket once per later stack would multiply the cost of a failure
  // that a re-run, not a retry here, is what clears.
  let consumerRecords: Promise<ConsumerRecord[]> | undefined;
  const loadConsumerRecords = (): Promise<ConsumerRecord[]> => {
    consumerRecords ??= readConsumerRecords(stateBackend, region);
    return consumerRecords;
  };

  // EXPORTS INDEX (issue #2667). One store and one `exports.json` per REGION:
  // the key is `{prefix}/_index/{region}/exports.json`
  // (`src/state/export-index-store.ts`) while scrub is per-stack-region, so a
  // `--all` run spanning regions has one object per region to read and write.
  // Constructed lazily so a run that touches one region issues one GET.
  const exportIndexStores = new Map<string, ExportIndexStore>();
  const exportIndexFor = (indexRegion: string): ExportIndexStore => {
    const existing = exportIndexStores.get(indexRegion);
    if (existing) return existing;
    const store = new ExportIndexStore(
      stateS3.s3,
      stateBucket,
      options.statePrefix,
      indexRegion,
      stateBackend,
      { profile: options.profile }
    );
    exportIndexStores.set(indexRegion, store);
    return store;
  };
  // Per region, the entry names some stack's pass decided about. The coverage
  // report subtracts this from the region's index rather than re-deriving
  // ownership, so an entry is counted UNEXAMINED unless a pass really reached
  // it — a stack whose scrub threw contributes none.
  const examinedIndexNames = new Map<string, Set<string>>();
  let totalIndexEntriesConverged = 0;
  // Records `--purge-history` purged without rewriting them (go-to-k/cdkd#2624).
  // A SET, read minus `rewrittenStacks` at summary time: a parent whose own
  // pass was clean can still be rewritten later by its child's row repair.
  const historyPurgedStacks = new Set<string>();
  let totalIndexEntriesAbsent = 0;
  // The subset of those whose value still holds a recorded plaintext
  // (go-to-k/cdkd#4120): a FINDING, unlike the rest.
  let totalIndexEntriesAbsentWithSecret = 0;
  // The name is stored ALREADY RENDERED by the owning stack's masker: the
  // failure message is built after the per-stack loop, where the secrets bag
  // that decided the rendering is out of scope.
  const indexUnwritten: Array<{ region: string; shown: string }> = [];
  const indexUnreadable: Array<{ region: string; reason: string }> = [];
  // Regions whose index this run went to write, attempted or not succeeded
  // alike: their superseded versions are purged once, after every stack's pass
  // (go-to-k/cdkd#2624). Never populated under `--dry-run`, which issues no
  // `patchEntry`.
  const indexRegionsWritten = new Set<string>();

  // The WORK LIST: the targets, with each stack's nested children spliced in
  // directly after it once its own scrub returns (go-to-k/cdkd#2252), so a
  // child is always visited with the parent bag it needs in hand and every
  // later step of this loop treats it as one more stack.
  // An env-agnostic stack takes the run's region, held on state the old
  // us-east-1 default wrote (go-to-k/cdkd#2100) so scrub rewrites the record
  // that exists rather than finding none.
  const regionForStack = stackRegionResolver({
    effective: effectiveRegion,
    probe: stateBackend,
    logger,
    siblings: allStacks.filter((s) => !s.region).map((s) => s.stackName),
  });
  // Keyed by stack OBJECT: two stacks sharing a name in two regions each keep
  // their own (#5176).
  const stackRegions = new Map(
    await Promise.all(
      targetStacks.map(
        async (stack) => [stack, await regionForStack(stack.stackName, stack.region)] as const
      )
    )
  );
  const work: ScrubWorkItem[] = targetStacks.map((stack) => ({
    stackName: stack.stackName,
    region: stackRegions.get(stack) ?? region,
    load: () => {
      // The tree is checked BEFORE the parent is scrubbed, as `cdkd deploy`
      // checks it before deploying (issue go-to-k/cdkd#3449): a cyclic or
      // escaping tree is a hand-modified assembly, and refusing up front keeps
      // the stack from being half-visited.
      const defect = stack.nestedTemplates
        ? findNestedTemplateTreeDefect(stack.nestedTemplates)
        : undefined;
      if (defect) {
        throw new ScrubRefusalError(
          renderNestedTemplateTreeDefect(
            defect,
            stack.stackName,
            'scrub it or any stack nested under it; no state was written'
          ),
          'SCRUB_NESTED_TEMPLATE_TREE_MALFORMED'
        );
      }
      return { stack };
    },
  }));
  for (let workIndex = 0; workIndex < work.length; workIndex++) {
    const item = work[workIndex]!;
    const stackName = item.stackName;
    const shownStack = displayStackName(stackName);
    const stackRegion = item.region;
    let scrubbed: Awaited<ReturnType<typeof scrubStack>>;
    let scrubbedStack: StackInfo;
    try {
      const { stack, nestedChild } = item.load();
      scrubbedStack = stack;
      scrubbed = await scrubStack(stack, stackRegion, stateBackend, lockManager, {
        dryRun: options.dryRun ?? false,
        purgeHistory: options.purgeHistory ?? false,
        roleArn: options.roleArn,
        logger,
        // Every stack of the APP, not just this run's targets: the producer of
        // an import may be one the user did not name (issue #2133 review).
        appStacks: allStacks,
        ...(nestedChild && { nestedChild }),
        readConsumerRecords: loadConsumerRecords,
        refusalRecovery,
      });
    } catch (err) {
      // EVERY error, not only a `CdkdError` refusal. A stack whose state could
      // not be read, or whose lock is held, is in the same position as a
      // refused one: nothing was written for it (or, for
      // `SCRUB_LEGACY_STATE_KEY_SURVIVES`, the write left its plaintext at the
      // legacy key), the remaining stacks are independent, and the run must not
      // exit 0. `scrubStack` releases its own
      // lock in a `finally`, so nothing is left held.
      //
      // The CAUSE CHAIN, not just `err.message` (issue #2109 review). This is
      // the only place a per-stack failure is rendered — the aggregate error
      // names stacks and stops there — so keeping the top message alone drops
      // the actionable half of a provider / AWS failure whose generic wrapper
      // says nothing ("the call failed" over an `AccessDenied` naming the role).
      // Safe to print because `scrubStack` masks every error that escapes it
      // against everything it recorded; this loop holds no secrets map and
      // could not mask anything itself.
      failures.push({ stackName });
      logger.error(`Scrub of ${shownStack} failed: ${describeFailure(err)}`);
      // Verbose-only, mirroring `handleError`: the trace is what locates a
      // failure that is a cdkd bug rather than an AWS refusal, and `scrubStack`
      // masked it along with the messages.
      if (err instanceof Error && err.stack) logger.debug('Stack trace:', err.stack);
      // The nested records UNDER a stack that failed are not visited either,
      // so each existing one is NAMED as a refusal rather than left out of a
      // run that is already non-zero (review of go-to-k/cdkd#3958). Best
      // effort: an unreadable listing adds nothing to a failure already raised.
      try {
        work.splice(
          workIndex + 1,
          0,
          ...unreachedNestedRecords(
            (await listStateRefs()).filter((ref) => !appStackNames.has(ref.stackName)),
            stackName,
            stackRegion,
            [],
            `the scrub of ${shownStack}, which deploys it, failed, so its inputs are unknown`,
            // A LIVE child in the ordinary case (a throttle, a held lock): the
            // remedy is the parent's, never a delete.
            `Fix the failure reported for ${shownStack} and re-run ${cdkdRemedy('cdkd scrub')}.`
          ).map((child) =>
            nestedChildWorkItem(
              // A refusal target reads nothing off its parent's StackInfo.
              {
                stackName,
                displayName: stackName,
                artifactId: stackName,
                template: {} as CloudFormationTemplate,
                dependencyNames: [],
              },
              stackRegion,
              child
            )
          )
        );
      } catch {
        // Already non-zero; the listing failure itself is reported on the
        // arm that needs it.
      }
      continue;
    }
    // Next in line: this stack's nested children, before any sibling target.
    // Only on the arm where the scrub RETURNED — a parent that threw handed
    // down no bag, and its failure already keeps the run non-zero.
    //
    // PLUS every `<stack>~...` record in this region no row reaches: a parent
    // record removed out of band (`cdkd state orphan <parent>` deletes only the
    // parent's key) or a row both the template and the record dropped. Those
    // are records scrub cannot learn needles for, so each is a refusal target
    // rather than a silent clean -- otherwise `--dry-run --fail` would pass
    // over them while the docs say the gate covers nested stacks.
    let unreached: NestedChildScrubTarget[];
    try {
      unreached = unreachedNestedRecords(
        (await listStateRefs()).filter((ref) => !appStackNames.has(ref.stackName)),
        stackName,
        stackRegion,
        scrubbed.nestedChildren,
        scrubbed.noRecord
          ? `${shownStack} has no state record, so no row records the parameters it was ` +
              `deployed with`
          : `no nested-stack row in ${shownStack}'s template or state record reaches it, so ` +
              `scrub has no template to learn its secrets from`,
        `Inspect it with ${cdkdRemedy('cdkd state show')}; if it is left over, remove it with ` +
          `${cdkdRemedy('cdkd state destroy')} (resources) or ${cdkdRemedy('cdkd state orphan')} (record only).`
      );
    } catch (err) {
      failures.push({ stackName: `${stackName}~*` });
      logger.error(
        safeMsg`Scrub of the nested stacks under ${shownStack} failed: their state records could not be listed, so any record no template row reaches was not examined: ${describeFailure(err)}`
      );
      unreached = [];
    }
    work.splice(
      workIndex + 1,
      0,
      ...[...scrubbed.nestedChildren, ...unreached].map((child) =>
        nestedChildWorkItem(scrubbedStack, stackRegion, child)
      )
    );
    // THE INDEX STEP (issue #2667), and its position is the decision: it runs
    // only on the arm where `scrubStack` RETURNED, which is the arm on which
    // its `saveState` either succeeded or was not needed. A stack that threw
    // took the `continue` above and reaches no `patchEntry`.
    //
    // It runs whatever `recordsChanged` says. A record already holding the
    // expression with an entry that does not is the shape a re-run after a
    // failed index write leaves behind, and gating on `recordsChanged > 0`
    // would make that re-run a no-op.
    let indexConverged = 0;
    let indexAbsentWithSecret = 0;
    try {
      const store = exportIndexFor(stackRegion);
      const repair = await repairExportIndexForStack(
        store,
        stackName,
        stackRegion,
        scrubbed.outputs,
        {
          dryRun: options.dryRun ?? false,
          onWriteAttempt: () => indexRegionsWritten.add(stackRegion),
        }
      );
      const seen = examinedIndexNames.get(stackRegion) ?? new Set<string>();
      for (const name of repair.examined) seen.add(name);
      examinedIndexNames.set(stackRegion, seen);
      // EVERY name below goes through the stack's own masker before it
      // reaches a message. `displaySafe` sanitises for a terminal; it does not
      // mask a secret, and an export name is an outputs-bag KEY — the one
      // position this command already knows can hold plaintext it cannot
      // rewrite (issue #1919). `--dry-run --fail` prints these lines on every
      // run of the documented CI gate, into CI logs, so a raw name here would
      // disclose on a schedule.
      // An ABSENT entry's name is an export name by definition, and the key
      // that could have vouched for it is gone — typically dropped by an
      // earlier run, whose own line withheld it (go-to-k/cdkd#4120). So a name
      // carrying a character an Output logical id cannot is WITHHELD on every
      // run, the rule `cdkd diff`'s `withholdsAliasName` applies, rather than
      // masked only by this run's corpus. Not gated on this run recording a
      // secret: a stack whose template has since dropped its last secret
      // reference records none, yet its absent entry is still the one an
      // earlier run's drop created (#4167 review). The stack and region
      // still print.
      const absentNamed = (exportName: string, entryValue: unknown): string =>
        /[^A-Za-z0-9]/.test(exportName)
          ? '(name withheld: an export name, which may carry a secret)'
          : named(exportName, entryValue);
      const named = (exportName: string, alsoMask?: unknown): string =>
        renderStateKeyForLine(
          scrubbed.exportNameDisplay(exportName, alsoMask),
          'it may carry a secret'
        );
      const unwrittenNames = new Set(repair.unwritten);
      // A converge entry's name may embed the value the entry still holds
      // (an export named after a masked output's plaintext), so every line
      // naming it masks that value too (go-to-k/cdkd#4043 Phase C).
      const entryValueOf = new Map(
        repair.findings.map((finding) => [finding.exportName, finding.entryValue] as const)
      );
      for (const exportName of repair.unwritten) {
        indexUnwritten.push({
          region: stackRegion,
          shown: named(exportName, entryValueOf.get(exportName)),
        });
      }
      for (const finding of repair.findings) {
        if (finding.kind === 'converge') {
          // COUNTED FOR THE CLEAN-LINE GATE regardless of whether the write
          // landed: either way this stack has a reported divergence, and the
          // per-stack "No plaintext secrets found" line must not print beside
          // one. This is the count of FINDINGS, not of writes.
          indexConverged++;
          // The past-tense line is for entries the write LANDED on. An entry
          // whose `patchEntry` returned `false` is in `repair.unwritten` and
          // is about to be named by `SCRUB_EXPORT_INDEX_INCOMPLETE`, so
          // logging `Converged X` for it would have the command assert a
          // repair it did not perform and then error that it did not perform
          // it — in the run whose whole subject is a false success report
          // (issue #2667 review). `--dry-run` never writes, so its line stays
          // conditional-tense for every finding.
          if (!options.dryRun && unwrittenNames.has(finding.exportName)) {
            logger.warn(
              `Exports index entry ${named(finding.exportName, finding.entryValue)} (${displayIdent(stackRegion)}) differs from ` +
                `${shownStack}'s state.outputs and could NOT be written — it keeps the ` +
                `value it holds.`
            );
          } else {
            // THE SUMMARY COUNT, incremented HERE and not beside
            // `indexConverged` above (issue #2667 review). The summary line it
            // feeds asserts a PutObject happened -- "converged to the
            // producer's state.outputs value, and ... the index's earlier
            // versions were purged" -- so counting an entry the write
            // refused made the run claim a write it did not perform, at higher
            // prominence than the warn beside it and directly before the error
            // saying the entry is unwritten. That is the same defect the
            // line-level fix above removes, surviving one level up.
            //
            // Under `--dry-run` nothing is written and `unwrittenNames` is
            // empty, so this counts every converge finding and the summary
            // stays in the conditional tense. It is the only counter in this
            // command with this shape: `totalStacksScrubbed` is gated on
            // `recordsChanged`, which is computed after `saveState` returned;
            // the other four count FINDINGS, where nothing is written by
            // design and the messages say so.
            totalIndexEntriesConverged++;
            logger.info(
              `${options.dryRun ? 'Would converge' : 'Converged'} exports index entry ` +
                `${named(finding.exportName, finding.entryValue)} (${displayIdent(stackRegion)}) to ${shownStack}'s ` +
                `state.outputs value.`
            );
          }
        } else {
          totalIndexEntriesAbsent++;
          // An entry whose name this record no longer holds but whose VALUE
          // still holds a plaintext this run recorded (go-to-k/cdkd#4120): no
          // write can converge it, so it is a FINDING — the stack is not
          // reported clean and `--fail` exits 1 — rather than coverage.
          if (scrubbed.holdsRecordedPlaintext(finding.entryValue)) {
            indexAbsentWithSecret++;
            totalIndexEntriesAbsentWithSecret++;
            logger.warn(
              safeMsg`Exports index entry ${absentNamed(finding.exportName, finding.entryValue)} (${displayIdent(stackRegion)}) ` +
                `still holds a secret this run recorded, in plaintext, and scrub cannot rewrite ` +
                safeMsg`it: ${shownStack}'s state.outputs has no key of that name to converge it to. ` +
                safeMsg`Redeploy ${shownStack} to rewrite the index, and ROTATE the secret.`
            );
            continue;
          }
          logger.warn(
            `Exports index entry ${absentNamed(finding.exportName, finding.entryValue)} (${displayIdent(stackRegion)}) is ` +
              `published by ${shownStack}, whose state.outputs ${options.dryRun ? '(as a real run would leave it) ' : ''}` +
              `has no key of that name — nothing ${options.dryRun ? 'would be' : 'was'} written for it and ` +
              `it keeps the value it holds. Redeploy ` +
              `${shownStack} to rewrite the index from its own outputs.`
          );
        }
      }
    } catch (err) {
      // A cdkd INVARIANT is not an S3 read failure. This catch attributes
      // everything to "the index could not be read", which would send an
      // operator to their bucket policy over a bug in this code, so the
      // invariant class is rethrown as the per-stack failure it is.
      if (err instanceof ScrubIndexInvariantError) throw err;
      // A read that failed is an audit this run did not perform. Recorded and
      // raised after the summary rather than swallowed: reporting the state
      // records clean while the index was never opened is the shape this issue
      // is about.
      // ONCE PER REGION. `loadPersisted` memoizes no failure, so every stack in
      // a region re-reads and fails identically; without this, five stacks in
      // one region print five identical errors and the failure message reads
      // `5 region(s) ... (us-east-1: X; us-east-1: X; ...)`, which misstates
      // how many regions are affected.
      if (!indexUnreadable.some((u) => u.region === stackRegion)) {
        const reason = displaySafe(describeAwsFailure(err).detail);
        indexUnreadable.push({ region: stackRegion, reason });
        logger.error(
          `Exports index for ${displayIdent(stackRegion)} could not be read (first seen while scrubbing ${shownStack}): ${reason}`
        );
      }
    }
    // THE PARENT ROW (go-to-k/cdkd#3961). A child output sourced from the
    // CHILD's own `{{resolve:...}}` was copied into the parent row's
    // `Outputs.<Name>` attribute by `buildOutputsAttributes`; the parent was
    // scrubbed first, with no needle for it. Repaired here, now that this
    // child's needles exist, and before the verdict below so a finding counts.
    if (item.parentRow) {
      try {
        const repaired = await repairParentOutputAttributes(
          item.parentRow,
          stackRegion,
          stateBackend,
          lockManager,
          scrubbed,
          options.dryRun ?? false,
          logger
        );
        const parentName = item.parentRow.stackName;
        const row = `${displayStackName(parentName)} (row ${displayIdent(item.parentRow.logicalId)})`;
        if (repaired.changed > 0) {
          const parentKey = producerRecordKey(parentName, stackRegion);
          if (!rewrittenStacks.has(parentKey)) totalStacksScrubbed++;
          rewrittenStacks.add(parentKey);
          logger.info(
            safeMsg`${options.dryRun ? 'Would scrub' : 'Scrubbed'} ${repaired.changed} nested-stack output attribute(s) in ${row}, from ${shownStack}'s outputs`
          );
        }
        if (repaired.unmatched.length > 0) {
          // A FINDING like an unverifiable read: a recorded plaintext is still
          // there and no child output accounts for it exactly, so nothing was
          // written and the run is not reported clean.
          totalParentAttributesUnmatched += repaired.unmatched.length;
          logger.warn(
            safeMsg`${repaired.unmatched.length} nested-stack output attribute(s) in ${row} (${repaired.unmatched.map((n) => displayIdent(n)).join(', ')}) hold a plaintext this run recorded but are not exactly any of ${shownStack}'s outputs, so scrub did NOT rewrite them. Deploying ${shownStack} rewrites them from its outputs.`
          );
        }
      } catch (err) {
        // Labelled apart from the parent's own scrub, which DID run, and once
        // per parent however many of its children fail here.
        const label = `${item.parentRow.stackName} (nested-stack output attributes)`;
        if (!failures.some((f) => f.stackName === label)) failures.push({ stackName: label });
        logger.error(
          safeMsg`Scrub of ${displayStackName(item.parentRow.stackName)}'s nested-stack output attributes for ${shownStack} failed: ${describeFailure(err)}`
        );
      }
    }
    // The verdict keys on records-that-CHANGED (state actually held plaintext),
    // NOT on secrets-found: a resource whose reference is already stored as its
    // `{{resolve:...}}` expression resolves the same secret again but needs no
    // rewrite. Only a state record still holding the plaintext counts.
    const recordKey = producerRecordKey(stackName, stackRegion);
    if (scrubbed.historyPurged) historyPurgedStacks.add(recordKey);
    if (scrubbed.recordsChanged > 0) {
      if (!rewrittenStacks.has(recordKey)) totalStacksScrubbed++;
      rewrittenStacks.add(recordKey);
      logger.info(
        // `resource record(s)` is LOOSE -- this count has included outputs and
        // orphans for some time and now includes cross-stack read entries too
        // (go-to-k/cdkd#3337), none of which are resources. It is deliberately
        // NOT renamed: three integ fixtures hard-fail `grep -qF` on this exact
        // literal (`dynamic-ref-cross-region`, `cross-stack-secret-import` x2)
        // and in each it is the phase's own discriminator, while NO unit test
        // asserts either wording -- so a rename is invisible to CI and surfaces
        // only on a real-AWS run. `.claude/rules/testing.md`'s rule about a
        // fixture that greps cdkd's own output applies here, and the cosmetic
        // gain does not pay for breaking three phase assertions. Rename it with
        // those fixtures, their re-run, and this doc's example output together.
        `${options.dryRun ? 'Would scrub' : 'Scrubbed'} ${scrubbed.recordsChanged} resource record(s) ` +
          `in ${shownStack}`
      );
    } else if (
      scrubbed.secretBearingKeys === 0 &&
      scrubbed.unverifiableReads === 0 &&
      scrubbed.unverifiableLeaves === 0 &&
      scrubbed.unrepairedReadNames === 0 &&
      (scrubbed.keptReadOutputKeys ?? 0) === 0 &&
      (scrubbed.keptAliasOutputKeys ?? 0) === 0 &&
      !scrubbed.droppedOutputReadersUnverified &&
      indexAbsentWithSecret === 0 &&
      indexConverged === 0
    ) {
      // A CONVERGE finding gates this line for the same reason the two below
      // it do (issue #2667): the pass above just reported an entry whose value
      // differs from this stack's scrubbed `state.outputs`, and the sentence
      // printed beside it reads as covering that. An ABSENT finding does NOT
      // gate it — that one is a coverage report about a name, and its own warn
      // says what was written for it, which is nothing.
      //
      // BOTH findings gate this line (issue #2133 review). An unverifiable read
      // is a cross-stack reference cdkd declined to perform, so scrub does not
      // know what that leaf carries — printing "No plaintext secrets found"
      // over it is the same unearned clean claim the `secretBearingKeys` gate
      // already prevents for a key holding plaintext. The warning below still
      // fires either way; this only stops the two lines contradicting each
      // other.
      // A stack with nested children is not done yet: its row attributes that
      // mirror a child's outputs are checked after that child (go-to-k/cdkd#3961),
      // so the line says which records it covers rather than contradicting a
      // repair line printed a moment later.
      logger.info(
        // The SAME test `nestedChildWorkItem` uses to give a child its
        // `parentRow`, so the wording cannot drift from when the repair runs.
        scrubbed.nestedChildren.some((child) => Boolean(child.input))
          ? `No plaintext secrets found in ${shownStack}'s own records${SCRUB_CLEAN_SCOPE_NOTE}; its nested-stack ` +
              `output attributes are checked after each nested stack`
          : `No plaintext secrets found in ${shownStack}${SCRUB_CLEAN_SCOPE_NOTE}`
      );
    }
    // Either shape of `resources` damage lands in ONE list, for the reason the
    // orphan pair below shares one (go-to-k/cdkd#3202): the verdict is one —
    // this stack's resource map could not be fully read, exit 2, repair the
    // record — and the WARNINGS above already distinguish the map from a row.
    if (scrubbed.malformedResources || scrubbed.malformedResourceRows) {
      malformedRecords.push(stackName);
    }
    if (scrubbed.malformedOutputs) {
      malformedOutputRecords.push(stackName);
    }
    // Either shape of orphan damage lands in ONE list, because the verdict is
    // one: this stack's orphan evidence could not be read, exit 2, repair the
    // record (go-to-k/cdkd#3500). The WARNINGS above already distinguish the
    // container from the rows, which is where the remedy differs.
    if (scrubbed.malformedOrphans || scrubbed.malformedOrphanRows) {
      malformedOrphanRecords.push(stackName);
    }
    if (scrubbed.unverifiableLeaves > 0) {
      totalStacksWithUnverifiableLeaves++;
      logger.warn(
        `${scrubbed.unverifiableLeaves} scan(s) in ${shownStack} were ` +
          `ABANDONED mid-value because a {{resolve:...}} reference could not be resolved (see the ` +
          `warnings above). The resolver stops at the first failing token, so a real secret ` +
          `after it in the same value recorded no needle — this stack is not reported clean. ` +
          `The count is per abandoned SCAN, not per secret: one record can contribute more ` +
          `than once (an output whose Export.Name and Value both abandon), and one ` +
          `abandoned scan can hide several unexamined leaves.`
      );
    }
    if (scrubbed.unverifiableProducerRecords > 0) {
      damagedProducerStacks.push(stackName);
    }
    if (scrubbed.unverifiableReads > 0) {
      totalStacksWithUnverifiableReads++;
      logger.warn(
        // "cdkd declines them by design" is no longer true of every member of
        // this count (review of go-to-k/cdkd#3206 round 5): a producer whose
        // `outputs` map cannot be READ also lands here, and that one IS
        // repairable — repair the record and re-run. The sentence therefore
        // points at the per-read warnings for the reason rather than asserting
        // one, since asserting the by-design reason over a repairable finding
        // tells the operator there is nothing to do.
        `${scrubbed.unverifiableReads} cross-stack read(s) in ${shownStack} could NOT be ` +
          `verified (see the warnings above for which, and why) — so this stack is not ` +
          `reported clean.`
      );
    }
    if (scrubbed.unrepairedReadNames > 0) {
      totalStacksWithUnrepairedReadNames++;
      logger.warn(
        safeMsg`${scrubbed.unrepairedReadNames} cross-stack read name(s) in ${shownStack} hold a ` +
          `plaintext scrub could NOT repair (see the warnings above) — so this stack is not ` +
          `reported clean.`
      );
    }
    totalOutputKeysDropped += scrubbed.droppedOutputKeys ?? 0;
    if ((scrubbed.keptReadOutputKeys ?? 0) > 0 || (scrubbed.keptAliasOutputKeys ?? 0) > 0) {
      totalStacksWithReadOutputKeys++;
    }
    if (scrubbed.droppedOutputReadersUnverified) droppedReadersUnverifiedStacks.push(stackName);
    if (scrubbed.secretBearingKeys > 0) {
      // A leak this command cannot remedy still counts as a FINDING — the CI
      // gate below must not call a state clean while `state.json` holds
      // plaintext in an output KEY (issue #1919) — but never as a scrub. No
      // state is written for it: the remedy is a template change, named in the
      // warning already logged. Reported outside the if/else above because a
      // stack can both hold scrubbable records AND carry such a key.
      totalStacksWithUnscrubbableKeys++;
      logger.warn(
        `${scrubbed.secretBearingKeys} output KEY(s) in ${shownStack} hold plaintext and CANNOT be scrubbed — ` +
          `rename the Export.Name and redeploy (see the warning above).`
      );
    }
  }

  await reportScrubOutcome({
    options,
    logger,
    stateBackend,
    totalStacksScrubbed,
    rewrittenStacks,
    totalParentAttributesUnmatched,
    totalStacksWithUnscrubbableKeys,
    totalStacksWithUnverifiableReads,
    totalStacksWithUnverifiableLeaves,
    totalStacksWithUnrepairedReadNames,
    totalOutputKeysDropped,
    totalStacksWithReadOutputKeys,
    droppedReadersUnverifiedStacks,
    malformedRecords,
    malformedOutputRecords,
    malformedOrphanRecords,
    damagedProducerStacks,
    failures,
    exportIndexStores,
    examinedIndexNames,
    totalIndexEntriesConverged,
    historyPurgedStacks,
    totalIndexEntriesAbsent,
    totalIndexEntriesAbsentWithSecret,
    indexUnwritten,
    indexUnreadable,
    indexRegionsWritten,
    work,
  });
}
