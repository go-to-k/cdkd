import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import type { getLogger } from '../../../utils/logger.js';
import type { S3StateBackend } from '../../../state/s3-state-backend.js';
import type { LockManager } from '../../../state/lock-manager.js';
import type { LockRecoveryContext } from '../../../state/lock-contention-message.js';
import type {
  IntrinsicFunctionResolver,
  ResolverContext,
} from '../../../deployment/intrinsic-function-resolver.js';
import {
  maskSecretsInError,
  carryLogOnlyValues,
  hasMaskableValues,
  maskSecretsInText,
  MIN_NEEDLE_LENGTH,
  inheritNestedStackParameterAssociations,
  type RecordedSecretValues,
} from '../../../deployment/secret-redaction.js';
import { noEchoParameterNamesOf } from '../../../deployment/deploy-engine/noecho.js';
// Issue #2109: the region split is #2057's, imported rather than re-spelled —
// one answer to "which region must answer for this `{{resolve:...}}`
// expression", shared by the rollback replay and by `cdkd scrub`.
import { producerRegionsFromState } from '../../../deployment/rollback-executor.js';
// An export NAME is a template-controlled RESOLVED value and an index read's
// error message interpolates a bucket / key, so both reach the terminal only
// through the same control-byte strip `export-index-store.ts` uses for the
// name it logs.
import { displayIdent, displayStackName, safeMsg } from '../../../utils/display-safe.js';
import type { StackState } from '../../../types/state.js';
import type { TemplateOutput, TemplateResource } from '../../../types/resource.js';
import type { StackInfo } from '../../../synthesis/assembly-reader.js';
import {
  noEchoParameterValueSeed,
  collectDeclaredOutputNames,
  secretSafeKeyDisplay,
} from '../../../deployment/outputs-export-alias.js';
import {
  STATE_RESOURCES_MALFORMED,
  hasReadableOutputs,
  hasReadableResources,
  malformedOutputsRefusalMessage,
  hasReadableOrphans,
  malformedOrphansRefusalMessage,
  malformedOrphansWarning,
  malformedOutputsWarning,
  malformedResourcesWarning,
  malformedResourceEntriesWarning,
  malformedScrubResourceEntriesRefusalMessage,
  malformedStateRefusalMessage,
  malformedOrphanRecordsRefusalMessage,
  malformedOrphanRecordsWarning,
  repairMalformedOrphanRecordsForReadOnly,
  repairMalformedOrphansForReadOnly,
  unreadableOrphanRecords,
  unreadableResourceEntries,
  repairMalformedOutputsForReadOnly,
  repairMalformedResourceEntriesForReadOnly,
  repairMalformedResourcesForReadOnly,
} from '../../../state/malformed-resources-bag.js';
import { stateSecretNameNeedles } from '../../../deployment/secret-name-needles.js';
import { poisonRenderedSpellingsCollidingIn } from '../../../deployment/intrinsic-resolver/parameter-secrets.js';
import { ScrubRefusalError } from './errors.js';
import { SCRUBBED_STATE_OBJECT_DESCRIPTION, stateHistoryKeys } from './save-state.js';
import type { NestedChildScrubInput, NestedChildScrubTarget } from './nested.js';
import { allRecordedSecrets, type ConsumerRecord } from './outputs.js';
import { ScrubResolvers } from './cross-region.js';
import { memoizeCrossStackStateReads } from './cross-stack-refusals.js';
import type { CrossStackPrePassFindings } from './cross-stack-findings.js';
import { makeCrossStackPrePass, bindDefaultedParametersOneByOne } from './cross-stack-pre-pass.js';
import { type ScrubStackResult, exportNameDisplayOver } from './stack-result.js';
import { scrubStackResolvePass } from './stack-resolve.js';
import { scrubStackRewritePass } from './stack-rewrite.js';
import { copiesOfParentRow } from './noecho.js';

/**
 * Scrub one stack's state. Re-resolves the template's per-resource properties to
 * learn the resolved secret VALUES, then replaces those values in the state
 * record with their `{{resolve:...}}` expressions. Returns counts. It mutates no
 * AWS RESOURCE, but it does write S3: the state object itself, and the stack
 * lock it acquires for the read-modify-write unless `dryRun` (issue #2667 added
 * a third write, the cross-stack exports index, in `repairExportIndexForStack` —
 * a separate step outside this function). This comment is no longer the
 * "performs no AWS mutation" it used to say (go-to-k/cdkd#2878): that was FALSE
 * about the lock even before #2667, and it wrapped across a line break, which
 * is why a line-oriented grep for the claim did not return it.
 *
 * The stack OUTPUTS bag is scrubbed too, in two passes: today's declared
 * outputs are redacted BY POSITION against the template, and a stored key
 * today's template cannot account for is repaired by VALUE MATCH alone — see
 * {@link redactUnaccountedOutputs} for why the two are separate and what each
 * deliberately declines to do.
 */
export async function scrubStack(
  stack: StackInfo,
  region: string,
  stateBackend: S3StateBackend,
  lockManager: LockManager,
  opts: {
    dryRun: boolean;
    /**
     * `--purge-history` (go-to-k/cdkd#2624): purge the noncurrent versions of
     * this record even when the run does not rewrite it. A rewrite purges
     * regardless. Ignored under `dryRun`.
     */
    purgeHistory?: boolean | undefined;
    roleArn?: string | undefined;
    logger: ReturnType<typeof getLogger>;
    /**
     * Every stack of the synthesized app, NOT only this run's targets (issue
     * #2133 review). Used for ONE question: when a cross-stack read comes back
     * carrying no dynamic reference, does the PRODUCER's template declare that
     * export from a `{{resolve:...}}` expression — i.e. is the plaintext scrub
     * just received a secret whose expression the producer's own state has not
     * been scrubbed down to yet? See `producerPublishesSecretExpression`.
     * Optional so a caller that has no assembly in hand keeps the pre-#2133
     * outcome (no refusal) rather than failing.
     */
    appStacks?: readonly StackInfo[] | undefined;
    /**
     * Set when `stack` is a NESTED CHILD (go-to-k/cdkd#2252): what its parent's
     * scrub derived for it. `input` threads the parent's parameters and bag
     * into this stack's resolution; `refusal` means none could be derived, and
     * is raised once the record is known to exist.
     */
    nestedChild?: NestedChildScrubTarget | undefined;
    /**
     * Every state record's cross-stack reads, memoized by `scrubCommand` for
     * the whole run. Read only when this record has output keys to DROP
     * (go-to-k/cdkd#4120), to find another stack still reading one. Defaults
     * to a fresh {@link readConsumerRecords}.
     */
    readConsumerRecords?: (() => Promise<ConsumerRecord[]>) | undefined;
    /**
     * The run's account flags (go-to-k/cdkd#4159), carried on the pasteable
     * commands of this record's malformed-container refusals and warnings.
     */
    refusalRecovery?: LockRecoveryContext | undefined;
  }
): Promise<ScrubStackResult> {
  const { logger } = opts;
  const shownStack = displayStackName(stack.stackName);
  const nestedInput = opts.nestedChild?.input;
  // `hasMaskableValues`, not `size` (go-to-k/cdkd#1998): a parent bag holding
  // only LOG-ONLY needles still masks this child's lines and is carried into
  // the bag of the child resource consuming the parameter. The association
  // copy in `newBag` finds nothing to copy in such a bag.
  const inheritedSecrets =
    nestedInput && hasMaskableValues(nestedInput.inheritedSecrets)
      ? nestedInput.inheritedSecrets
      : undefined;
  /**
   * A FRESH per-context bag, carrying the parent's per-parameter position
   * associations on a nested child — what the deploy's `buildResolverContext`
   * does for every context it builds (issue #2291). They decide WHICH
   * expression a `{Ref: <Param>}` leaf is positioned onto, never WHETHER a leaf
   * is rewritten.
   */
  const newBag = (): Map<string, string> => {
    const bag = new Map<string, string>();
    if (inheritedSecrets) inheritNestedStackParameterAssociations(bag, inheritedSecrets);
    return bag;
  };
  // A child scrub could not derive needles for is REFUSED when it has a record,
  // and skipped when it has none. Decided before the lock, and without one:
  // this arm writes nothing either way. (A child that CAN be scrubbed takes
  // its lock below like any stack, even when it turns out to have no record —
  // the same acquire-and-release a never-deployed top-level stack gets.)
  const refusal = opts.nestedChild?.refusal;
  if (refusal !== undefined) {
    const existing = await stateBackend.getState(stack.stackName, region);
    if (existing) throw new ScrubRefusalError(refusal, 'SCRUB_NESTED_CHILD_UNRESOLVABLE');
    logger.debug(safeMsg`No state for ${shownStack} (${displayIdent(region)}) — skipping`);
    return {
      recordsChanged: 0,
      secretsFound: 0,
      secretBearingKeys: 0,
      unverifiableReads: 0,
      unverifiableProducerRecords: 0,
      unverifiableLeaves: 0,
      unrepairedReadNames: 0,
      exportNameDisplay: (name) => secretSafeKeyDisplay(name, new Map()),
      resolveRecordedExpressions: (value) => value,
      holdsRecordedPlaintext: () => false,
      nestedChildren: [],
      noRecord: true,
    };
  }
  const acquired = !opts.dryRun;
  if (acquired) {
    await lockManager.acquireLockWithRetry(stack.stackName, region, undefined, 'scrub');
  }
  // PER-RESOURCE secrets (keyed by logicalId) + a separate outputs map, so a
  // whole-secret value from one resource cannot rewrite another's literal —
  // the cross-resource collision the `SecretsRunState.perResourceSecrets` doc (`deploy-engine/masking.ts`)
  // describes.
  //
  // Declared OUTSIDE the try so the catch below can mask against whatever was
  // recorded before the throw. Both are filled in place, so hoisting them
  // changes nothing about how the body reads them.
  const perResourceSecrets = new Map<string, Map<string, string>>();
  const outputSecrets = newBag();
  /**
   * Needles derived from each rollback-orphan record's OWN recorded bag
   * (issue go-to-k/cdkd#2943) — per-record for the same reason
   * `perResourceSecrets` is per-resource: one record's secret must not rewrite
   * another's coinciding literal.
   *
   * Keyed by the row's INDEX in `orphans`, never by its `logicalId`
   * (go-to-k/cdkd#3500 security review). Two rows sharing an id are a MALFORMED
   * record — no cdkd writer produces one, since `orphansAfterRollback` keeps one
   * row per id — and both arms of this command meet it before this map is read:
   * a real run refuses the record and `--dry-run` drops every such row
   * (go-to-k/cdkd#3643). The index keying stays as defense in depth, because it
   * is still the only identity that cannot collide: on an id key the second row's
   * empty map REPLACED the first row's filled one. Both halves broke: the first
   * row's needles left the union that the rewrite and the error boundary read, and
   * its own lookup returned the OTHER row's map, so where two rows resolve one
   * plaintext through different expressions the wrong expression was written. The
   * index is the only identity the collecting loop and the rewrite can agree on,
   * since both walk `state.orphans` in order and neither reorders it.
   */
  const orphanSecrets = new Map<string, Map<string, string>>();
  // Filled by the cross-stack pre-pass; read by the return sites below. Hoisted
  // beside the secret maps for the same reason they are: the value is needed
  // after a throw could have happened.
  const prePassFindings: CrossStackPrePassFindings = {
    unverifiable: [],
    damagedProducerRecords: [],
    performedReads: { imports: [], outputReads: [] },
  };
  // `--purge-history` (go-to-k/cdkd#2624) on a record this run EXAMINED and
  // did not rewrite: a rewrite purges through `saveScrubbedState` already.
  // Called on the two RETURN paths only, never from a refusal: a record scrub
  // refused may be the evidence a refusal exists to keep, and its history is
  // the only copy of what it held. Under the lock, which a real run holds.
  const purgeExaminedHistory = async (
    migrationPending: boolean | undefined
  ): Promise<{ historyPurged?: true }> => {
    if (opts.dryRun || !opts.purgeHistory) return {};
    await stateBackend.purgeNoncurrentVersions(
      stateHistoryKeys(stateBackend, stack.stackName, region, migrationPending),
      { objectDescription: SCRUBBED_STATE_OBJECT_DESCRIPTION }
    );
    return { historyPurged: true };
  };
  try {
    const loaded = await stateBackend.getState(stack.stackName, region);
    if (!loaded) {
      logger.debug(`No state for ${shownStack} (${displayIdent(region)}) — skipping`);
      return {
        recordsChanged: 0,
        secretsFound: 0,
        secretBearingKeys: 0,
        unverifiableReads: 0,
        unverifiableProducerRecords: 0,
        unverifiableLeaves: 0,
        unrepairedReadNames: 0,
        // No record, so nothing was resolved and the bag is empty — every name
        // tests as 'safe'. Bound to the same map the other two sites use so
        // the shape cannot drift.
        exportNameDisplay: exportNameDisplayOver(outputSecrets),
        resolveRecordedExpressions: (value) => value,
        holdsRecordedPlaintext: () => false,
        nestedChildren: [],
        noRecord: true,
      };
    }
    const state = loaded.state;
    // `cdkd scrub` SAVES state whenever anything changed -- an OUTPUTS change
    // alone satisfies that gate -- so a record whose resource map cannot be
    // read is refused rather than repaired: saving would replace the evidence
    // with a well-formed empty bag and lose it permanently (go-to-k/cdkd#3018).
    //
    // `--dry-run` is the exception, and it is decidable rather than a
    // judgement: the write gate is `recordsChanged > 0 && !opts.dryRun`, so
    // under it this command provably cannot persist anything. Refusing there
    // would remove the one diagnostic that lists surviving plaintext in a
    // broken record -- the audit a user reaches for precisely because the
    // record is broken.
    let malformedResources: true | undefined;
    if (opts.dryRun) {
      if (repairMalformedResourcesForReadOnly(state)) {
        malformedResources = true;
        logger.warn(malformedResourcesWarning(stack.stackName, region, opts.refusalRecovery));
      }
    } else if (!hasReadableResources(state)) {
      // scrub's own class, NOT `refuseMalformedState`: exit 1 is spoken for
      // here ("--fail found plaintext"), and a CI gate reading the code alone
      // must be able to tell that from "scrub refused to look".
      throw new ScrubRefusalError(
        malformedStateRefusalMessage(stack.stackName, region, opts.refusalRecovery),
        STATE_RESOURCES_MALFORMED
      );
    }
    // The ROWS of a readable map (go-to-k/cdkd#3202), decided the same way and
    // BELOW the bag branch: an unreadable bag has no rows to name, and both
    // helpers return `[]` for one. The rewrite below reads `record.properties`
    // on a row today's template still declares and copies one it no longer
    // declares into the saved map AS IT STANDS — so a real run over a `null`
    // row either dies on a bare `TypeError` under the lock or persists the row
    // it could not read. REFUSE on a real run, through scrub's own class for
    // the exit-code reason the bag branch gives; under `--dry-run` DROP the
    // rows, warn, and carry the finding out so the run cannot end clean.
    let malformedResourceRows: true | undefined;
    if (opts.dryRun) {
      const droppedRows = repairMalformedResourceEntriesForReadOnly(state);
      if (droppedRows.length > 0) {
        malformedResourceRows = true;
        logger.warn(
          malformedResourceEntriesWarning(
            stack.stackName,
            region,
            droppedRows,
            opts.refusalRecovery
          )
        );
      }
    } else {
      const unreadableRows = unreadableResourceEntries(state);
      if (unreadableRows.length > 0) {
        throw new ScrubRefusalError(
          malformedScrubResourceEntriesRefusalMessage(
            stack.stackName,
            region,
            unreadableRows,
            opts.refusalRecovery
          ),
          STATE_RESOURCES_MALFORMED
        );
      }
    }
    // The `outputs` bag, decided the same way and reported separately
    // (go-to-k/cdkd#3192). A SECOND branch rather than a widened condition
    // above: a record can be malformed in either container alone, and the text
    // a user sees has to name the one that is broken — the `resources` refusal
    // tells them not to run `cdkd deploy` for a reason that does not hold when
    // the resource map is intact.
    //
    // A real run REFUSES because this command REBUILDS the bag before saving
    // it. `redactUnaccountedOutputs` walks `Object.entries(stored)` and, on a
    // hit, spreads the positioned bag — so `outputs: 'abcdef'` becomes
    // `{"0":"a",…}`; `outputsChanged` (a JSON compare) then reports a change,
    // which is all the `recordsChanged > 0 && !opts.dryRun` write gate needs.
    // The damaged record would be laundered into a well-formed one, and the
    // next deploy would republish the fabricated keys into the shared exports
    // index.
    //
    // `--dry-run` repairs instead, for the reason the resources branch gives
    // (it provably cannot persist, and the audit is what the user came for) —
    // and the finding is carried out so `--dry-run --fail` cannot report a
    // stack clean whose outputs it never examined. AT THE LOAD: the
    // secret-bearing-key scan, both redaction passes and the save are all
    // below.
    let malformedOutputs: true | undefined;
    if (opts.dryRun) {
      if (repairMalformedOutputsForReadOnly(state)) {
        malformedOutputs = true;
        logger.warn(malformedOutputsWarning(stack.stackName, region, opts.refusalRecovery));
      }
    } else if (!hasReadableOutputs(state)) {
      throw new ScrubRefusalError(
        malformedOutputsRefusalMessage(stack.stackName, region, opts.refusalRecovery),
        STATE_RESOURCES_MALFORMED
      );
    }

    // The `orphans` CONTAINER, decided the same way again (go-to-k/cdkd#3379).
    // A real run REFUSES: this command's write gate is `recordsChanged > 0`,
    // which a RESOURCES or OUTPUTS change alone satisfies, and the save writes
    // the whole record — so an unconditional repair here would persist
    // `orphans: []` over the damaged container whenever some other field
    // changed, erasing the record's evidence that resources are still live in
    // AWS. `--dry-run` repairs and reports instead, for the reason the two
    // branches above give.
    let malformedOrphans: true | undefined;
    let malformedOrphanRows: true | undefined;
    if (opts.dryRun) {
      if (repairMalformedOrphansForReadOnly(state)) {
        malformedOrphans = true;
        logger.warn(malformedOrphansWarning(stack.stackName, region, opts.refusalRecovery));
      }
      // The ROWS of a readable list, dropped and reported on the same arm
      // (go-to-k/cdkd#3500). A SEPARATE finding from the container one because a
      // run can meet either alone and the remedies differ — a non-list field has
      // to be rewritten, a torn row repaired inside an otherwise good list. What
      // distinguishes them for the operator is the WARNING above; the
      // audited-record refusal takes one list of stack names either way.
      const droppedRows = repairMalformedOrphanRecordsForReadOnly(state);
      if (droppedRows.length > 0) {
        malformedOrphanRows = true;
        logger.warn(
          malformedOrphanRecordsWarning(
            stack.stackName,
            region,
            droppedRows,
            true,
            opts.refusalRecovery
          )
        );
      }
    } else if (!hasReadableOrphans(state)) {
      throw new ScrubRefusalError(
        malformedOrphansRefusalMessage(stack.stackName, region, opts.refusalRecovery),
        STATE_RESOURCES_MALFORMED
      );
    } else {
      // A real run REFUSES the rows for the reason it refuses the container: the
      // rewrite below reads `record.state` per row, and its save writes the
      // whole record.
      const unreadableRows = unreadableOrphanRecords(state);
      if (unreadableRows.length > 0) {
        throw new ScrubRefusalError(
          malformedOrphanRecordsRefusalMessage(
            stack.stackName,
            region,
            unreadableRows,
            opts.refusalRecovery
          ),
          STATE_RESOURCES_MALFORMED
        );
      }
    }

    // Re-resolve each resource's TEMPLATE properties to collect the resolved
    // secret plaintext -> expression map (into the two maps hoisted above). The
    // resolved output is discarded; only the recorded secrets matter.
    const perResourceTemplateProps = new Map<string, Record<string, unknown>>();
    const outputsTemplateSource: Record<string, unknown> = {};
    // Issue #2109: the stack's own resolver plus one pinned sibling per FOREIGN
    // region a reference NAMES. `producerRegionsFromState` is the same
    // per-stack evidence the rollback replay uses (#2057) — every region this
    // stack read a cross-stack value out of, from `state.imports` (the strong
    // `Fn::ImportValue` edge) and `state.outputReads` (the weak
    // `Fn::GetStackOutput` one).
    const resolvers = new ScrubResolvers(region);
    const resolver = resolvers.primary;
    const producerRegions = producerRegionsFromState(state);
    let parameters: Record<string, unknown> = {};
    let conditions: Record<string, boolean> = {};
    try {
      parameters = await resolver.resolveParameters(
        stack.template,
        nestedInput?.parameters,
        inheritedSecrets && { inheritedSecrets }
      );
      // Issue #4731: the deploy's own withdrawal (`deploy-flow.ts`), before any
      // resource resolves, or scrub writes spellings the next deploy diffs
      // against.
      poisonRenderedSpellingsCollidingIn(stack.template, parameters, inheritedSecrets);
    } catch (err) {
      // A NESTED CHILD refuses instead (go-to-k/cdkd#2252). A top-level stack
      // takes no `--parameters` here, so a `Default`-less parameter failing is
      // the ordinary case and each `Ref` to it is judged per leaf below; a
      // child's parameters come from its parent, so a failure here means the
      // values the child was deployed with cannot be reproduced (a declared
      // `Type` that would coerce an inherited secret, for one), and every
      // `Ref` to them would record no needle. MASKED against the inherited
      // bag, the only one that can hold a plaintext at this point.
      if (opts.nestedChild) {
        const reason = maskSecretsInText(
          describeAwsFailure(err).detail,
          inheritedSecrets ?? outputSecrets
        );
        throw new ScrubRefusalError(
          `Nested stack ${shownStack}: its Parameters could not be resolved against its own ` +
            `template (${reason}), so its secrets cannot be identified. Its record was NOT ` +
            `examined and may still hold plaintext.`,
          'SCRUB_NESTED_CHILD_UNRESOLVABLE'
        );
      }
      // MASKED for UNIFORMITY, not for a live leak (issue #2803). This throw IS
      // reachable, unlike the condition catch below — but `resolveParameters`
      // is called here with no context at all, so it threads no
      // `recordedSecretValues` and can record nothing; `outputSecrets` is
      // provably empty at this point and `maskSecretsInText` returns the text
      // unchanged on an empty map. Kept so that adding a context argument later
      // does not also require remembering this line.
      logger.debug(
        `Parameter resolution skipped for ${shownStack}: ${maskSecretsInText(describeAwsFailure(err).detail, outputSecrets)}`
      );
      // Issue #2166: the whole-bag call fails on the FIRST `Default`-less
      // parameter, which left every DEFAULTED sibling unbound too, so a
      // `{{resolve:...}}` assembled from one was kept unresolved and recorded
      // no needle. Bind each parameter that CAN be bound on its own; a
      // `Default`-less one stays unbound and is judged per leaf, as before.
      parameters = await bindDefaultedParametersOneByOne(
        resolver,
        stack.template,
        shownStack,
        logger
      );
    }
    // Issue #2133: the ONE resolve context every resolution in this function
    // uses, spelled once. The three inline copies it replaces were identical but
    // for their secrets map, and all three were missing `stateBackend` — so
    // `Fn::ImportValue` and `Fn::GetStackOutput` threw for want of a dependency
    // in EVERY context scrub builds, the plaintext behind a cross-stack read
    // never became a needle, and the command reported success over state that
    // may still hold it. One factory is the fix for the CLASS rather than for
    // the three instances: a fourth context cannot be written without the
    // wiring, which is how the first three came to lack it.
    //
    // `exportIndex` is deliberately NOT supplied. It is a PERFORMANCE hint — the
    // resolver falls back to the per-stack `state.json` scan, which is the
    // pre-index behavior — and supplying it would let `resolveImportValue`'s
    // scan arm PATCH the index as a side effect of RESOLUTION, at a point in
    // the run nothing chose, and under `--dry-run` too.
    //
    // Since issue #2667 the command is no longer "no AWS mutation":
    // `repairExportIndexForStack` issues `patchEntry` as its own step after
    // `scrubStack` returns (see its doc comment for the dry-run and locking
    // properties). That is a CHOSEN write with its own condition, and the
    // withholding here is what keeps it the only one — this comment used to say
    // the command performs no AWS mutation at all, which that fix falsified
    // while leaving this rationale standing, far from the doc comment in this
    // same file that describes the new write.
    //
    // NOT quite "equally correct", which an earlier revision claimed (issue
    // #2133 review). The scan walks `listStacks()` — every stack in EVERY
    // region — and takes the FIRST record whose `state.outputs` carries the
    // export name, while the index is keyed by export name alone. Two regions
    // publishing the same export name can therefore make scrub resolve a
    // DIFFERENT producer than the deploy did, and a wrong producer means a
    // wrong needle: at best a miss, at worst the coinciding-literal rewrite
    // issue #2109 is about. Not fixed here because the ordering lives in
    // `resolveImportValue`'s scan and a deterministic tie-break is a resolver
    // change (a lane owns that file), and because supplying the index is the
    // one alternative and it costs the no-AWS-mutation property above. In
    // practice a duplicate export name across regions is already an ambiguity
    // the deploy shares.
    //
    // `recordedSecretValues` is optional because SOME callers of this helper
    // pass none. `evaluateConditions` is NOT one of them: it is handed
    // `outputSecrets` below, deliberately, so the condition pass has a needle
    // map to mask against — and it DOES record into it, since the resolver
    // writes every resolved secret into whatever bag it is given. (An earlier
    // wording here said the conditions pass "records no secrets today", which
    // contradicted the call twelve lines below and is corrected with issue
    // #2748. Since that issue, `evaluateConditions` invents a PRIVATE bag when
    // its caller brings none; this caller brings one, so it keeps this one and
    // a condition's secret is a redaction needle over `state.outputs` here.)
    //
    // The backend handed to the RESOLVER is a memoizing VIEW, not the real one
    // (issue #2133 review). `resolveImportValue` has no lookup cache: every
    // reference costs `listStacks()` plus up to N `getState()`, and the
    // pre-pass and the main resolution each perform the read — so a template
    // with k imports paid 2k scans. The view collapses them to one scan and one
    // `getState` per (stack, region) for the whole of this function. It caches
    // OTHER stacks' reads only in the sense that it caches every read the
    // resolver makes; this stack's own state load and its `saveState` go
    // through the REAL backend above and below, untouched. Sharing is safe
    // because scrub mutates no other stack's state while this runs.
    //
    // Note this is a read cache, NOT a needle cache: the resolve itself still
    // runs per reference, so each resource's own `recordedSecretValues` gets
    // its own needles. Caching the RESOLVE instead would give the second
    // consumer of one import no needle at all.
    const resolverStateBackend = memoizeCrossStackStateReads(stateBackend);
    // go-to-k/cdkd#3869: one print-only sink for the stack's reads of a
    // resource NAMED from a secret, so the resolver's lines mask the name
    // while each resource's own bag, which positions what is persisted, is
    // untouched.
    const secretNameSink: RecordedSecretValues = new Map();
    const secretNameNeedles = stateSecretNameNeedles(state.resources);
    const resolverContext = (recordedSecretValues?: RecordedSecretValues): ResolverContext => ({
      template: stack.template,
      resources: state.resources,
      secretNameNeedles,
      secretNameSink,
      ...(Object.keys(parameters).length > 0 && { parameters }),
      ...(Object.keys(conditions).length > 0 && { conditions }),
      stackName: stack.stackName,
      stateBackend: resolverStateBackend,
      ...(recordedSecretValues && { recordedSecretValues }),
      // Issue #2134: the evidence that arms the resolver's own region
      // classification, which is what finally covers an ASSEMBLED reference.
      // The pre-pass above (`pinCrossRegionSecrets`) can only classify a
      // reference that is already whole in the raw template leaf; a reference
      // built by `Fn::Sub` / `Fn::Join` / `Ref` does not exist until the
      // resolver assembles it, and the resolver is where it is now judged.
      //
      // Passed UNFILTERED (`producerRegions`, not `foreignProducerRegions`):
      // `classifyReplaySecretRegion` drops the consumer's own region itself,
      // and handing it the pre-filtered list would work only by coincidence of
      // the two filters agreeing. Scrub supplies it because a wrong-region
      // answer here is a silent MISS -- the stack reported clean over
      // plaintext it still holds -- so failing closed is the point.
      producerRegions,
      bestEffort: true,
      // A NESTED CHILD's parent bag (go-to-k/cdkd#2252) — the channel
      // the deploy's `buildResolverContext` opens for a child engine. The
      // resolver copies a pair into THIS context's `recordedSecretValues` only
      // where a `{Ref: <Param>}` resolves to a value carrying its plaintext, so
      // the needle lands in the bag of the resource that consumed the
      // parameter and nowhere else (issue #2087).
      ...(inheritedSecrets && { inheritedSecrets }),
      // go-to-k/cdkd#4819: the physical ids the parent row read, ungated, as
      // `NestedStackProvider` hands a child engine.
      ...(nestedInput && copiesOfParentRow(nestedInput.inheritedSecrets)),
    });
    const resolveCrossStackReads = makeCrossStackPrePass({
      stackName: stack.stackName,
      resolver,
      producerTemplates: new Map(
        (opts.appStacks ?? []).map((s) => [s.stackName, s.template] as const)
      ),
      findings: prePassFindings,
      logger,
    });
    // NO cross-stack pre-pass over the CONDITIONS, and that is a decision
    // rather than the omission it looks like (issue
    // [#2133](https://github.com/go-to-k/cdkd/issues/2133) review). This call
    // PRODUCES `conditions`, which the pre-pass itself consumes to decide which
    // `Fn::If` branch is live — so a refusing pass here would have to run
    // before scrub knows which references the deploy actually read, i.e. it
    // could refuse the whole stack over a branch that was never taken, the
    // exact hazard the selected-branch mirror exists to prevent. A condition
    // also carries no secret INTO state: it evaluates to a boolean, and its
    // operands are compared rather than persisted.
    //
    // The residual is real and named here rather than hidden: a cross-stack
    // read inside a condition that cannot be performed degrades that condition
    // to `false` (`bestEffort`), which then selects the FALSE branch of every
    // `Fn::If` in BOTH passes below — so a needle living in the TRUE branch is
    // silently not recorded. Bounded by the fact that scrub's branch selection
    // is at least self-consistent, and that the condition resolves normally now
    // that this context carries a `stateBackend` at all; what it cannot promise
    // is agreeing with what the DEPLOY selected. Making that loud means
    // deciding what an unevaluatable condition should do to a whole scrub,
    // which is a different question from this issue's.
    try {
      // Pass `outputSecrets` so the condition pass has a needle map to mask
      // AGAINST. A condition can resolve a cross-stack read now that this
      // context carries a `stateBackend` (issue #2133), and a masker with an
      // empty map is a no-op that reads as safe in a diff. `outputSecrets` is
      // the run-scoped map, registered before anything that can throw.
      // Fresh recording bags: the deploy records a cross-stack read made while
      // evaluating a condition, so such a read must count as REPRODUCING a
      // stored entry, or an ordinary import read only there is flagged on
      // every run (go-to-k/cdkd#3382). `canRefuse: false` — the pre-pass never
      // walks conditions, so none of these is a read a stored entry is flagged
      // against.
      const conditionContext: ResolverContext = {
        ...resolverContext(outputSecrets),
        recordedImports: [],
        recordedOutputReads: [],
      };
      try {
        conditions = await resolver.evaluateConditions(conditionContext);
      } finally {
        for (const entry of conditionContext.recordedImports ?? []) {
          prePassFindings.performedReads.imports.push({ entry, canRefuse: false });
        }
        for (const entry of conditionContext.recordedOutputReads ?? []) {
          prePassFindings.performedReads.outputReads.push({ entry, canRefuse: false });
        }
      }
    } catch (err) {
      // MASKED (issue #2803), and UNREACHABLE for a resolver error today —
      // measured, not assumed. `evaluateConditions` wraps every
      // `evaluateByName` call in its own `try`, masks the error there (issue
      // #2748) and downgrades that condition to `false`; a detected cycle
      // takes the same path, and there is no throw before the loop. So this
      // catch cannot receive what the mask is for. Kept because the bag CAN be
      // non-empty by then — `outputSecrets` is threaded in and the resolver
      // writes through it — so the day any failure escapes that loop, the
      // needle set is already in hand rather than one more site to remember.
      // The four sibling catches in this function mask for a reachable reason;
      // this one is uniformity.
      logger.debug(
        `Condition evaluation skipped for ${shownStack}: ${maskSecretsInText(describeAwsFailure(err).detail, outputSecrets)}`
      );
    }

    const templateResources = stack.template.Resources ?? {};
    const templateOutputs = stack.template.Outputs ?? {};
    const declaredOutputNames = collectDeclaredOutputNames(templateOutputs);
    const accountedOutputKeys = new Set<string>(declaredOutputNames);
    const ambiguousKeys = new Set<string>();
    const collisions: Array<[outputKey: string, exportName: string]> = [];
    // Every `NoEcho` value this run binds, the seed of the deploy's
    // export-name verdict (go-to-k/cdkd#4043): a name it refuses is never
    // published, so its absence accounts for nothing.
    // A conditional row parameter stays a possible live alias: the deploy's
    // branch may not have read the `NoEcho` source.
    const conditionalNameParameters = new Set(nestedInput?.noEchoConditionalParameters ?? []);
    const noEchoNameParameters = new Set([
      ...noEchoParameterNamesOf(stack.template),
      ...(nestedInput?.noEchoParameters ?? []).filter(
        (name) => !conditionalNameParameters.has(name)
      ),
    ]);
    const declaredAliasOf = new Map<string, string>();
    const noEchoNameSeed = noEchoParameterValueSeed(
      stack.template.Parameters,
      parameters,
      inheritedSecrets
    );
    const {
      unverifiableLeaves,
      emitAbandonedScanNotes,
      outputsSourceUntrusted,
      everyExportAliasReproduced,
      nestedRowParameters,
    } = await scrubStackResolvePass({
      stack,
      region,
      logger,
      newBag,
      perResourceSecrets,
      outputSecrets,
      orphanSecrets,
      state,
      perResourceTemplateProps,
      outputsTemplateSource,
      resolvers,
      resolver,
      producerRegions,
      conditions,
      resolverContext,
      resolveCrossStackReads,
      templateResources,
      templateOutputs,
      declaredOutputNames,
      accountedOutputKeys,
      ambiguousKeys,
      collisions,
      noEchoNameParameters,
      declaredAliasOf,
      noEchoNameSeed,
    });

    return await scrubStackRewritePass({
      stack,
      region,
      stateBackend,
      opts,
      logger,
      shownStack,
      nestedInput,
      perResourceSecrets,
      outputSecrets,
      orphanSecrets,
      prePassFindings,
      unverifiableLeaves,
      emitAbandonedScanNotes,
      purgeExaminedHistory,
      loaded,
      state,
      malformedResources,
      malformedResourceRows,
      malformedOutputs,
      malformedOrphans,
      malformedOrphanRows,
      perResourceTemplateProps,
      outputsTemplateSource,
      conditions,
      templateResources,
      accountedOutputKeys,
      collisions,
      outputsSourceUntrusted,
      everyExportAliasReproduced,
      declaredAliasOf,
      nestedRowParameters,
    });
  } catch (err) {
    // THE MASKING BOUNDARY for everything that ESCAPES this function (issue
    // #2109 review). Every log site inside masks the string it interpolates,
    // and that is not sufficient on its own: an error thrown out of here is
    // rendered as an OBJECT by `formatError` (`Caused by: <cause.message>`) and
    // by `src/cli/index.ts`'s top-level `console.error`, which walks the whole
    // `cause` chain and every link's `stack` through `util.inspect` — the
    // reader that `maskSecretsInError`'s own doc says a per-site mask cannot
    // close. It also makes the `--all` loop's cause-chain rendering safe: that
    // caller has no secrets map of its own and cannot mask what it prints.
    //
    // The union is the same one the widened outputs pass uses, so the needle
    // FLOOR (`MIN_NEEDLE_LENGTH`) is applied here too — a secret too short to
    // be a safe needle is not masked, exactly as it is not redacted. Returns
    // the original error by identity when nothing matched, so the ordinary
    // "no state for this stack" failure keeps its identity.
    //
    // A NESTED CHILD also masks against its PARENT's bag (go-to-k/cdkd#2252):
    // an inherited plaintext enters this function as a parameter VALUE, and it
    // joins a recorded bag only once a `{Ref}` to it resolves, so an error
    // raised before then could carry one no bag above holds. Same floor, and
    // added only where a recorded needle does not already claim the value.
    const boundaryNeedles = allRecordedSecrets(outputSecrets, perResourceSecrets, orphanSecrets);
    for (const [value, expression] of inheritedSecrets ?? []) {
      if (value.length >= MIN_NEEDLE_LENGTH && !boundaryNeedles.has(value)) {
        boundaryNeedles.set(value, expression);
      }
    }
    // The parent's LOG-ONLY needles too (go-to-k/cdkd#1998), which the copy
    // above cannot see.
    if (inheritedSecrets) carryLogOnlyValues(inheritedSecrets, boundaryNeedles);
    throw maskSecretsInError(err, boundaryNeedles);
  } finally {
    if (acquired) {
      await lockManager.releaseLock(stack.stackName, region).catch((err) => {
        logger.warn(`Failed to release lock for ${shownStack}: ${describeAwsFailure(err).detail}`);
      });
    }
  }
}

/**
 * The locals of {@link scrubStack} that {@link scrubStackResolvePass} reads.
 * Every container is `scrubStack`'s own object, filled IN PLACE by the pass,
 * so the masking boundary in `scrubStack`'s `catch` reads what it recorded.
 */
export interface ScrubStackResolveInput {
  stack: StackInfo;
  region: string;
  logger: ReturnType<typeof getLogger>;
  newBag: () => Map<string, string>;
  perResourceSecrets: Map<string, Map<string, string>>;
  outputSecrets: Map<string, string>;
  orphanSecrets: Map<string, Map<string, string>>;
  state: StackState;
  perResourceTemplateProps: Map<string, Record<string, unknown>>;
  outputsTemplateSource: Record<string, unknown>;
  resolvers: ScrubResolvers;
  resolver: IntrinsicFunctionResolver;
  producerRegions: string[];
  conditions: Record<string, boolean>;
  resolverContext: (recordedSecretValues?: RecordedSecretValues) => ResolverContext;
  resolveCrossStackReads: ReturnType<typeof makeCrossStackPrePass>;
  templateResources: Record<string, TemplateResource>;
  templateOutputs: Record<string, TemplateOutput>;
  declaredOutputNames: Set<string>;
  accountedOutputKeys: Set<string>;
  ambiguousKeys: Set<string>;
  collisions: Array<[outputKey: string, exportName: string]>;
  noEchoNameParameters: Set<string>;
  declaredAliasOf: Map<string, string>;
  noEchoNameSeed: RecordedSecretValues;
}

/** What {@link scrubStackResolvePass} hands back to {@link scrubStack}. */
export interface ScrubStackResolveOutput {
  unverifiableLeaves: number;
  emitAbandonedScanNotes: () => void;
  outputsSourceUntrusted: boolean;
  everyExportAliasReproduced: boolean;
  nestedRowParameters: Map<string, { value: unknown; complete: boolean }>;
}

/**
 * The locals of {@link scrubStack} that {@link scrubStackRewritePass} reads,
 * final by then. Every container is `scrubStack`'s own object.
 */
export interface ScrubStackRewriteInput {
  stack: StackInfo;
  region: string;
  stateBackend: S3StateBackend;
  opts: Parameters<typeof scrubStack>[4];
  logger: ReturnType<typeof getLogger>;
  shownStack: string;
  nestedInput: NestedChildScrubInput | undefined;
  perResourceSecrets: Map<string, Map<string, string>>;
  outputSecrets: Map<string, string>;
  orphanSecrets: Map<string, Map<string, string>>;
  prePassFindings: CrossStackPrePassFindings;
  unverifiableLeaves: number;
  emitAbandonedScanNotes: () => void;
  purgeExaminedHistory: (
    migrationPending: boolean | undefined
  ) => Promise<{ historyPurged?: true }>;
  loaded: NonNullable<Awaited<ReturnType<S3StateBackend['getState']>>>;
  state: StackState;
  malformedResources: true | undefined;
  malformedResourceRows: true | undefined;
  malformedOutputs: true | undefined;
  malformedOrphans: true | undefined;
  malformedOrphanRows: true | undefined;
  perResourceTemplateProps: Map<string, Record<string, unknown>>;
  outputsTemplateSource: Record<string, unknown>;
  conditions: Record<string, boolean>;
  templateResources: Record<string, TemplateResource>;
  accountedOutputKeys: Set<string>;
  collisions: Array<[outputKey: string, exportName: string]>;
  outputsSourceUntrusted: boolean;
  everyExportAliasReproduced: boolean;
  declaredAliasOf: Map<string, string>;
  nestedRowParameters: Map<string, { value: unknown; complete: boolean }>;
}
