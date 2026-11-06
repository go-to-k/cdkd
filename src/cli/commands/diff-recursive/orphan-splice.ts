import type { CloudFormationTemplate } from '../../../types/resource.js';
import type { ResourceState, StackState } from '../../../types/state.js';
import {
  maskSecretsInText,
  type RecordedSecretValues,
} from '../../../deployment/secret-redaction.js';
import {
  type StateNamingSecrets,
  orphanRecordsPrintingBag,
  storedSecretNameNeedles,
} from '../../../deployment/secret-name-needles.js';
import {
  malformedOrphanRecordsWarning,
  malformedResourcePropertiesWarning,
  deployRefusesOrphanRowsReason,
  malformedOrphanRowsKeptWarning,
  isReadableOrphanRecord,
  previewableOrphanRecords,
  unpreviewableOrphanRecords,
  repairMalformedResourcePropertiesForReadOnly,
} from '../../../state/malformed-resources-bag.js';
import { logger } from './logger.js';
import type { ComputeStackDiffOptions } from './types.js';
import { deployRefusesPropertiesReason, deployRefusesDroppedOrphanRowsReason } from './refusals.js';

/**
 * {@link computeStackDiff}'s rollback-orphan adoption preview: splices the
 * records the deploy would adopt into a COPY of the state.
 */
export async function previewOrphanSplice({
  currentState,
  options,
  effectiveTemplate,
  stackName,
  region,
  noEchoJudge,
  stateNames,
  setHealResources,
}: {
  currentState: StackState;
  options: ComputeStackDiffOptions;
  effectiveTemplate: CloudFormationTemplate;
  stackName: string;
  region: string;
  noEchoJudge: (resources: Readonly<Record<string, ResourceState>>) => StateNamingSecrets;
  stateNames: RecordedSecretValues;
  /** Points the healer at the spliced records. */
  setHealResources: (resources: Readonly<Record<string, ResourceState>>) => void;
}) {
  // Rollback-orphan adoption, in the deploy's position: after condition
  // pruning, before the diff. `DiffCalculator` decides CREATE by ABSENCE from
  // state, so splicing a verified record in is the whole mechanism — there is
  // no new change type on either side.
  //
  // COPIED, never mutated in place: `DeployEngine` writes through its own
  // `currentState` because it goes on to deploy from it, while this function's
  // doc promises it only reads.
  //
  // An earlier version of this comment cited `collectCcApiRoutes` and
  // `resolveChildStackParameters` as the REASON for copying. That had the
  // argument backwards — those two are exactly the consumers that need to see
  // the spliced records, and handing them the un-spliced state starved them.
  // They are served by `adoptedRecords` below, which the caller merges.
  let adoptedOrphans: string[] = [];
  let adoptedRecords: Record<string, ResourceState> = {};
  let blocking: string[] = [];
  // go-to-k/cdkd#3335's reasons from the splice below, kept apart from
  // `blocking` so the caller can apply the top-level gate to them.
  const deployRefusals: string[] = [];
  let stateForDiff = currentState;
  // Becomes the node's `unreadableOrphans`, beside the load's dropped rows, for
  // the reason `DiffTreeNode.unreadable` gives: a torn orphan record used to
  // ABORT this command, and a run that now warns and exits 0 under `--fail`
  // would read as clean over exactly the record that used to crash it.
  const unreadableOrphans: Array<string | null> = [];
  if (currentState.orphans?.length && options.previewOrphanAdoption) {
    // The ENTRY half of the second pass below, and unlike that one it must run
    // BEFORE the preview rather than after it. `planOrphanAdoption` destructures
    // each record and routes a provider by `state.resourceType`; the `catch`
    // that guards that call names the same field AGAIN, so a record whose
    // `state` is `null` — or a primitive record, whose `state` destructures to
    // `undefined` — throws a TypeError straight OUT of the catch, and a `null`
    // record throws at the destructure before any `try`. Either aborts
    // `cdkd diff` — go-to-k/cdkd#3018's class, on the command a
    // user runs to inspect a record they already suspect. Repairing after the
    // preview cannot help: the throw happens inside it.
    //
    // `orphans` is its own container and `parseStateBody` does not validate it,
    // so neither the load's bag repair nor its entry repair has ever seen these
    // records. A record whose `logicalId` is not a string is carried as `null`,
    // not as a stand-in string an entry key could also spell
    // (go-to-k/cdkd#3339).
    // The verdict comes from the module rather than a local re-spelling
    // (go-to-k/cdkd#3500). The local test asked only about `state`, so a row with
    // a healthy `state` and a non-string `logicalId` previewed as an adoption
    // here while every writer now refuses it.
    //
    // The PREVIEWABLE half, not the writers' full predicate: a row whose
    // `properties` map is torn stays, because `computeStackDiff` repairs and
    // names THAT below (only `properties` — the later pass does not touch
    // `attributes`). Dropping it here would retire a report `docs/cli-diff.md`
    // and `.claude/rules/state-malformed-properties.md` both describe.
    // Pushed one at a time, never spread: `push(...ids)` passes each element as an
    // ARGUMENT, so a record holding ~130k unusable rows aborts `cdkd diff` with a
    // bare `RangeError` naming no field, container or stack — on the command a
    // user runs BECAUSE the record is suspect (go-to-k/cdkd#3500 security review;
    // measured 100k OK, 130k over). The pre-image pushed per row and was immune.
    //
    // Rows SHARING a string `logicalId` are DROPPED here too, every one of them
    // (go-to-k/cdkd#3643) — both helpers below carry that list-level check, which
    // the per-row predicate cannot make. Dropped rather than kept-and-warned so
    // the preview never hands `planOrphanAdoption` two rows it would key onto one
    // adoption, and so `--fail` still predicts the deploy: a dropped row joins the
    // node's `unreadableOrphans`, which `--fail` counts, and the deploy refuses the
    // record over the same rows. Keeping them would preview one adoption for two
    // resources, which is the collapse the writers refuse.
    for (const id of unpreviewableOrphanRecords(currentState)) unreadableOrphans.push(id);
    const readableOrphans = previewableOrphanRecords(currentState);
    if (unreadableOrphans.length > 0) {
      // `false`: this command took the PREVIEWABLE predicate, so the diagnosis
      // must not name a torn map as a reason a row was dropped here.
      // The warning's own convention names a row with no id `''`, which it
      // renders as the `<unrenderable>` stand-in.
      logger.warn(
        malformedOrphanRecordsWarning(
          stackName,
          region,
          unreadableOrphans.map((id) => id ?? ''),
          false,
          options.refusalRecovery
        )
      );
      // Every row dropped here is one `refuseMalformedOrphanRecords` refuses
      // the deploy over — the previewable predicate is the NARROWER half of
      // that one — so it is a reason as well as an `unreadableOrphans` entry
      // (go-to-k/cdkd#3512). Disjoint from the kept-row reason below: that arm
      // walks `readableOrphans`, which excludes every row named here.
      deployRefusals.push(deployRefusesDroppedOrphanRowsReason(unreadableOrphans));
    }
    // Names the `tornAdopted` arm below reports, so the arm after it does not say
    // the same thing about the same row twice (see that arm for why).
    let reportedByTheAdoptedPropertiesArm: readonly string[] = [];
    const plan = await options.previewOrphanAdoption(
      { ...currentState, orphans: readableOrphans },
      effectiveTemplate,
      stackName,
      region
    );
    adoptedOrphans = Object.keys(plan.adopted);
    adoptedRecords = plan.adopted;
    // go-to-k/cdkd#3869: the refusal names a kept record's physical id, which
    // can be named from a secret. Masked at the source, so the rendered view
    // and `--json` print the same text the deploy's refusal does.
    const orphanNames = orphanRecordsPrintingBag(readableOrphans);
    blocking = plan.refusals.map((reason) => maskSecretsInText(reason, orphanNames));
    if (adoptedOrphans.length > 0) {
      stateForDiff = {
        ...currentState,
        resources: { ...currentState.resources, ...plan.adopted },
      };
      setHealResources(stateForDiff.resources);
      // A SECOND properties repair, because this splice is the one place a
      // record enters the diff that `loadStateOrEmpty` never walked
      // (go-to-k/cdkd#3191 review). `planOrphanAdoption` builds each adopted
      // entry from `state.orphans[].state` verbatim, and that container is
      // outside the resource bag the load repaired — so a torn
      // `orphans[].state.properties` reached `calculateDiff` unguarded and
      // ABORTED `cdkd diff` with the deploy's refusal, on the command a user
      // runs precisely to inspect a record they already suspect.
      //
      // Scoped INSIDE this branch on purpose: with no adoption there is
      // nothing here the load did not already see, and running it
      // unconditionally would walk every entry a second time to find nothing.
      // The mutation lands on `plan.adopted`'s own records, never on
      // `state.orphans`, so the stored evidence survives for `cdkd state show`.
      const tornAdopted = repairMalformedResourcePropertiesForReadOnly(stateForDiff);
      reportedByTheAdoptedPropertiesArm = tornAdopted;
      if (tornAdopted.length > 0) {
        logger.warn(
          malformedResourcePropertiesWarning(
            stackName,
            region,
            tornAdopted,
            options.refusalRecovery
          )
        );
        // The same deploy refusal the load's arm reports (go-to-k/cdkd#3335),
        // and it belongs here rather than beside the load because these
        // records never passed through it.
        //
        // Returned SEPARATELY from `blocking` rather than appended to it: this
        // function runs for every node, and the refusal is TOP-LEVEL only for
        // the reason `buildDiffTree` gives — appending here would exit 3 over a
        // nested child the deploy never diffs, which is the guarantee this
        // scope decision makes. `plan.refusals` is left where it is rather
        // than moved under the same gate — not because a refused adoption
        // reaches the deploy on an unchanged child (it does not; that child is
        // skipped there too), but because it predates this issue and narrowing
        // it is a change to go-to-k/cdkd#2943's contract, not to this one.
        deployRefusals.push(deployRefusesPropertiesReason(tornAdopted));
      }
      // Over the spliced records too, once their maps are repaired: an
      // adopted record's name can be what another record stores, and an
      // adopted record can store one.
      storedSecretNameNeedles(
        stateForDiff.resources,
        noEchoJudge(stateForDiff.resources),
        stateNames,
        currentState.outputs
      );
    }

    // The OTHER half of KEEPING a row the writers refuse (go-to-k/cdkd#3641,
    // maintainer item M1). The two predicates disagree on one class — a torn
    // `properties` or `attributes` map — and keeping such a row is right: the arm
    // above names a torn `properties` map on an ADOPTED record. What was missing
    // is the deploy's verdict: `cdkd deploy` refuses the whole record over that
    // same row, so a preview that keeps the row and says nothing lets
    // `cdkd diff --fail` exit 0 and the deploy the operator runs next refuse. The
    // shapes that were NOT already refused at deploy are a torn `attributes` map
    // and a torn `properties` map on a row the adoption did not take — an ADOPTED
    // torn-`properties` row reached the deploy's refusal through `calculateDiff`
    // before this lane (go-to-k/cdkd#3641 item o5), which is why the arm above
    // reports it and this one subtracts it.
    //
    // Which rows: the ones the preview KEPT that the writers' per-row predicate
    // rejects. That predicate alone is enough HERE, and only here, because its
    // one blind spot — rows sharing a `logicalId` (go-to-k/cdkd#3643) — was
    // dropped from `readableOrphans` above.
    //
    // MINUS what the arm above already reported, which is the half a first cut
    // got wrong: for an adopted torn-`properties` row that arm already says the
    // deploy refuses the record, so a second reason is the same sentence about the
    // same row and it broke go-to-k/cdkd#3335's count contract (measured: that
    // fence pins `countBlocking` at 1 for exactly this shape, and the duplicate
    // made it 2). What this arm is FOR is the two cases nothing else covers: a
    // torn `attributes` map, which no pass repairs or names, and a torn
    // `properties` map on a row the adoption did NOT take — the likelier case,
    // since the deploy refuses before it would adopt anything.
    //
    // The exclusion is BY NAME, and that is exact here: every row in
    // `readableOrphans` carries a string `logicalId` no other row carries, since
    // rows sharing one were dropped above (go-to-k/cdkd#3643).
    const alreadyReported = new Set(reportedByTheAdoptedPropertiesArm);
    const previewedRowsTheDeployRefuses = readableOrphans
      .filter((record) => !isReadableOrphanRecord(record))
      .map((record) => (record as { logicalId: string }).logicalId)
      .filter((logicalId) => !alreadyReported.has(logicalId));
    if (previewedRowsTheDeployRefuses.length > 0) {
      // The WARNING fires at every node THIS RUN REACHES with an adoption preview
      // — a plain run visits no child, and a state-only child being DELETED is
      // built without the preview — while the exit-3 reason is top-level only
      // (go-to-k/cdkd#3641 round 2). That split is go-to-k/cdkd#3335's and it is
      // right — the deploy skips an unchanged nested-stack row, so a reason there
      // would report a refusal over a deploy that succeeds — but it is only SAFE
      // because every other class still warns at every node. This one did not:
      // the row is KEPT, so the drop warning above never speaks for it, and a
      // changed nested child printed nothing while its own deploy refused.
      logger.warn(
        malformedOrphanRowsKeptWarning(
          stackName,
          region,
          previewedRowsTheDeployRefuses,
          options.refusalRecovery
        )
      );
      deployRefusals.push(deployRefusesOrphanRowsReason(previewedRowsTheDeployRefuses));
    }
  }
  return {
    adoptedOrphans,
    adoptedRecords,
    blocking,
    deployRefusals,
    stateForDiff,
    unreadableOrphans,
  };
}
