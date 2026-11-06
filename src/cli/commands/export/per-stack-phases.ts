import { releaseRegistryMarkerQuietly } from '../registry-release.js';
import { recordRetainedForReadoption } from '../../../deployment/retained-readoption.js';
import { pasteableCommand } from '../../../utils/pasteable-command.js';
import { displayAwsMessage } from '../../../utils/display-safe.js';
import { accountArgs } from '../../../state/malformed-resources-bag.js';
import {
  DescribeStacksCommand,
  type ResourceToImport,
  type Parameter,
} from '@aws-sdk/client-cloudformation';
import { getLogger } from '../../../utils/logger.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { S3StateBackend } from '../../../state/s3-state-backend.js';
import { uploadCfnTemplate } from '../../upload-cfn-template.js';
import { NESTED_STACK_RESOURCE_TYPE } from '../retire-cfn-stack.js';
import { type StackState } from '../../../types/state.js';
import { type TemplateFormat } from '../../yaml-cfn.js';
import {
  executeUpdateChangeSet,
  fetchCfnStackTemplate,
  flipStackToUpdateComplete,
  submitImportChangeSet,
} from './changeset.js';
import {
  adoptionPreparingLabel,
  orphanCommandFor,
  plainOrNotShown,
  preDeletedLine,
  quotedOrNotShown,
  quotedRegion,
  recordValueOrNotShown,
  rowIdent,
  safeDetail,
  spacedAccountClause,
} from './render.js';
import { type NestedStackRow, flattenCdkdStateTreeLeafFirst } from './stack-tree.js';
import {
  type ImportPlanEntry,
  type Phase2CreateEntry,
  type RecreateBeforePhase2Entry,
} from './plan-types.js';
import { PRE_DELETE_HANDLERS, preDeleteManualCommands } from './pre-delete.js';
import {
  applyImportOverlayForPhase2,
  filterTemplateForImport,
  getResourceFromTemplate,
  injectDeletionPolicyForImport,
  injectRetainAndRewriteTemplateUrl,
} from './template-overlay.js';
import type {
  ImportedStackRecord,
  PerStackImportLoopResult,
  RunPerStackImportLoopDeps,
  runPerStackImportLoop,
} from './per-stack-loop.js';

/**
 * Remove an exported stack's cdkd record, then (go-to-k/cdkd#4705) write its
 * empty `retained.json` -- the tombstone that ends an older cdkd's history
 * license, so a later `cdkd deploy` under this prefix never takes back a
 * resource CloudFormation now owns (review m1) -- then release its registry
 * marker when it is a top-level stack, so "a marker exists" keeps meaning "a
 * record exists under its prefix". The tombstone and the release are
 * non-fatal (warnings); the record's delete throws as before.
 */
export async function removeExportedStackRecord(
  stateBackend: Pick<
    S3StateBackend,
    | 'deleteState'
    | 'releaseRegistryMarker'
    | 'loadRetainedRecord'
    | 'saveRetainedResources'
    | 'ensureRetainedTombstone'
  >,
  stackName: string,
  region: string,
  logger: { warn(message: string): void; debug(message: string): void }
): Promise<void> {
  await stateBackend.deleteState(stackName, region);
  await recordRetainedForReadoption(stateBackend, stackName, region, [], logger);
  await releaseRegistryMarkerQuietly(stateBackend, stackName, region, logger);
}

/**
 * One cdkd stack's plan within a {@link runPerStackImportLoop} run, built in
 * its pre-flight and consumed by {@link runPerStackImportPhases}.
 */
export interface PerStackPlan {
  cdkdName: string;
  cfnName: string;
  region: string;
  template: Record<string, unknown>;
  templateFormat: TemplateFormat;
  state: StackState;
  phase1Imports: ImportPlanEntry[];
  phase2Creates: Phase2CreateEntry[];
  recreateBeforePhase2: RecreateBeforePhase2Entry[];
  nestedStackRows: NestedStackRow[];
}

/**
 * What {@link runPerStackImportPhases} reads from the enclosing
 * {@link runPerStackImportLoop} call: its arguments and the locals its
 * pre-flight built.
 */
export interface PerStackImportPhasesContext {
  logger: ReturnType<typeof getLogger>;
  args: Parameters<typeof runPerStackImportLoop>[0];
  deps: RunPerStackImportLoopDeps;
  rootStackName: string;
  leafFirst: ReturnType<typeof flattenCdkdStateTreeLeafFirst>;
  cfnStackNameOf: (cdkdName: string) => string;
  perStackPlans: PerStackPlan[];
  paramsByCdkdName: Map<string, Parameter[]>;
  sessionIntrinsicSkipped: Map<string, string[]>;
  cfnArnByCdkdName: Map<string, string>;
  uploadCleanups: Array<() => Promise<void>>;
  importedStacks: ImportedStackRecord[];
  nestedResumeTail: (i: number, failed: 'phase1' | 'imported' | 'adopted' | 'phase2') => string;
}

/**
 * The main per-stack IMPORT loop of {@link runPerStackImportLoop}: each
 * stack's phase-1 IMPORT, nested-child adoption and phase 2, then the
 * success-path summary. It runs once every non-root child lock is held, inside
 * the caller's `try` whose `finally` drains `uploadCleanups`; every path
 * returns or throws, so the caller returns its result as-is.
 */
export async function runPerStackImportPhases(
  ctx: PerStackImportPhasesContext
): Promise<PerStackImportLoopResult> {
  const {
    logger,
    args,
    deps,
    rootStackName,
    leafFirst,
    cfnStackNameOf,
    perStackPlans,
    paramsByCdkdName,
    sessionIntrinsicSkipped,
    cfnArnByCdkdName,
    uploadCleanups,
    importedStacks,
    nestedResumeTail,
  } = ctx;
  for (let i = 0; i < perStackPlans.length; i++) {
    const plan = perStackPlans[i]!;
    logger.info(
      `[${i + 1}/${perStackPlans.length}] Importing cdkd stack ${quotedOrNotShown(plan.cdkdName)} → ` +
        `CFn stack ${quotedOrNotShown(plan.cfnName)} (${plan.phase1Imports.length} leaf, ` +
        `${plan.nestedStackRows.length} nested-child adoption)`
    );

    // Per-stack Parameters were resolved up front by the root-first
    // pre-pass above (the root maps to the user-supplied values; each
    // child's intrinsic-valued Parameters were resolved against its
    // parent's state, with any unresolvable ones already warned about).
    const stackParameters = paramsByCdkdName.get(plan.cdkdName) ?? [];

    // A step between this stack's Phase 1A and its phase 2 that has no
    // failure message of its own: its CloudFormation stack exists by then,
    // so a bare SDK error would leave a refused re-run with no recovery
    // (go-to-k/cdkd#3988). `stage` is how far the stack got.
    const afterImport = async <T>(
      what: string,
      stage: 'imported' | 'adopted',
      step: () => Promise<T>
    ): Promise<T> => {
      try {
        return await step();
      } catch (err) {
        throw new Error(
          `${what} failed for cdkd stack ${quotedOrNotShown(plan.cdkdName)} (CFn name ` +
            `${quotedOrNotShown(plan.cfnName)}), after its Phase 1A IMPORT succeeded. ` +
            `Cause: ${displayAwsMessage(describeAwsFailure(err).detail)}\n` +
            nestedResumeTail(i, stage),
          { cause: err instanceof Error ? err : undefined }
        );
      }
    };

    // ---- Phase 1A: leaves-only CREATE-via-IMPORT ----
    // Why 2 phases for non-leaf parents (vs. one combined CREATE-via-IMPORT
    // that includes the nested-stack adoption): AWS's "Nest an existing
    // stack" pattern (the only AWS-supported way to adopt an existing
    // standalone child CFn stack as a nested member of a parent) requires
    // both the parent AND the child to ALREADY EXIST as standalone CFn
    // stacks before the adoption changeset runs. A CREATE-via-IMPORT that
    // both creates the parent AND adopts a child fails at changeset-create
    // time with "Stack <child-arn> is not in an importable status, current
    // stack status is IMPORT_COMPLETE" — the AWS-side validator rejects
    // adopting a fresh-IMPORTed child during parent creation. See
    // [AWS docs: Nesting an existing stack](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/resource-import-nested-stacks.html)
    // — the procedure explicitly assumes "existing standalone stack" for
    // both. So we always submit the parent in 2 phases: Phase 1A creates
    // the parent as a standalone stack containing its leaf resources
    // only; Phase 1B then UPDATE-IMPORTs the now-existing parent to
    // adopt the nested children.
    const phase1ATemplate = filterTemplateForImport(plan.template, plan.phase1Imports);
    const phase1AResources: ResourceToImport[] = plan.phase1Imports.map((entry) => ({
      ResourceType: entry.resourceType,
      LogicalResourceId: entry.logicalId,
      ResourceIdentifier: entry.resourceIdentifier,
    }));
    const injectedDeletion = injectDeletionPolicyForImport(phase1ATemplate);
    if (injectedDeletion > 0) {
      logger.info(
        `  Injected DeletionPolicy: Delete on ${injectedDeletion} resource(s) in ` +
          `${quotedOrNotShown(plan.cdkdName)} (required by CFn IMPORT; matches CDK/CFn default).`
      );
    }

    try {
      await submitImportChangeSet(
        deps.cfnClient,
        plan.cfnName,
        phase1ATemplate,
        phase1AResources,
        stackParameters,
        plan.templateFormat,
        deps.uploadOpts
      );
    } catch (err) {
      throw new Error(
        `Phase 1A IMPORT changeset failed for cdkd stack ${quotedOrNotShown(plan.cdkdName)} (CFn name ` +
          `${quotedOrNotShown(plan.cfnName)}). ` +
          // Bounded and folded: the waiter's bare rethrow and a
          // DescribeChangeSet failure carry AWS's text, which can quote a
          // recorded value back (go-to-k/cdkd#3910).
          `Cause: ${displayAwsMessage(describeAwsFailure(err).detail)}\n` +
          nestedResumeTail(i, 'phase1'),
        { cause: err instanceof Error ? err : undefined }
      );
    }

    // Capture the just-created CFn stack's ARN for the next parent
    // iteration's `ResourceIdentifier.StackId` reference AND for
    // Phase 1B below (UPDATE-IMPORT against this same stack).
    const cfnArn = await afterImport('Reading its CloudFormation stack', 'imported', async () => {
      const desc = await deps.cfnClient.send(
        new DescribeStacksCommand({ StackName: plan.cfnName })
      );
      const arn = desc.Stacks?.[0]?.StackId;
      if (!arn) {
        throw new Error(
          `DescribeStacks returned no StackId immediately after the Phase 1A IMPORT — AWS ` +
            `may be in an unexpected state.`
        );
      }
      return arn;
    });
    cfnArnByCdkdName.set(plan.cdkdName, cfnArn);
    importedStacks.push({
      cdkdStackName: plan.cdkdName,
      cfnStackName: plan.cfnName,
      cfnStackArn: cfnArn,
    });
    logger.info(
      `  ✓ Phase 1A: CFn stack ${quotedOrNotShown(plan.cfnName)} created via IMPORT ` +
        `(${plan.phase1Imports.length} leaf resource(s)).`
    );

    // Flip the stack's status from IMPORT_COMPLETE to UPDATE_COMPLETE
    // via a no-op tag-only UpdateStack — unless this stack is the
    // root (which is never adopted as a nested member by any other
    // stack). See `flipStackToUpdateComplete` for the rationale (AWS
    // rejects IMPORT_COMPLETE as a non-importable status when
    // adopting a stack as a nested member of a parent).
    if (plan.cdkdName !== rootStackName) {
      logger.info(
        `  Flipping ${quotedOrNotShown(plan.cfnName)} to UPDATE_COMPLETE so it can be adopted as a ` +
          `nested member by its parent's Phase 1B...`
      );
      await afterImport(
        'The no-op tag update moving its CloudFormation stack out of IMPORT_COMPLETE',
        'imported',
        () => flipStackToUpdateComplete(deps.cfnClient, plan.cfnName, stackParameters)
      );
    }

    // ---- Phase 1B: UPDATE-via-IMPORT to adopt nested children ----
    // Skipped for leaf stacks (no nested-stack rows). For non-leaf
    // parents, submit a second IMPORT changeset against the now-existing
    // parent that adds the AWS::CloudFormation::Stack rows to the
    // template AND lists them in ResourcesToImport[] with
    // ResourceIdentifier: { StackId: <child-arn> } — the AWS-docs
    // "Nest an existing stack" pattern. Same changeset type as Phase
    // 1A (IMPORT); AWS infers UPDATE-IMPORT from the existing stack.
    //
    // `rewrittenNestedRows` is captured here (vs. inside the
    // `if`-block) so phase 2's UPDATE template can splice the
    // Retain-bearing nested-stack rows back in without re-fetching
    // each child's template via GetTemplate a second time. Empty
    // for leaf stacks.
    const rewrittenNestedRows = new Map<string, Record<string, unknown>>();
    if (plan.nestedStackRows.length > 0) {
      // Start from the filtered template (leaves only) and add the
      // nested-stack rows back with DeletionPolicy: Retain + rewritten
      // TemplateURL pointing at the child's AWS-side template (fetched
      // via GetTemplate(Processed)).
      const phase1BTemplate = filterTemplateForImport(plan.template, plan.phase1Imports, false);
      injectDeletionPolicyForImport(phase1BTemplate);
      const phase1BResources: ResourceToImport[] = [];

      for (const row of plan.nestedStackRows) {
        const childArn = cfnArnByCdkdName.get(row.childStackName);
        if (!childArn) {
          // Defensive cdkd-bug guard, intentionally untested.
          // `flattenCdkdStateTreeLeafFirst` guarantees every nested child is
          // IMPORTed (and recorded in `cfnArnByCdkdName`) before its
          // parent's Phase 1B runs, and `buildImportPlan` derives
          // `row.childStackName` from the same `state.resources` nested
          // entries the tree walk reads. The leaf-first ordering itself is
          // covered by the 3-level-tree test (Grandchild → Middle → Root
          // CreateChangeSet order) in export-nested-loop.test.ts.
          //
          // The two invariants CAN now diverge without a refactor, so this
          // no longer claims to be unreachable: since issue
          // go-to-k/cdkd#3172 `walkCdkdStateStackTree` returns a childless
          // node for a record whose `resources` is not a readable map, so a
          // parent with an unreadable bag contributes no `nestedStackRows`
          // while `buildImportPlan` reads the same bag. It stays unreachable
          // in PRACTICE because `cdkd export` refuses such a record earlier:
          // `refuseMalformedResourcesForExport` runs on every tree node before the
          // pre-flight plans any of them (issue #3188). So the guard is
          // defence in depth against that refusal moving, not against a
          // hypothetical future edit.
          throw new Error(
            `runPerStackImportLoop: nested-stack child ${quotedOrNotShown(row.childStackName)} has no ` +
              `recorded CFn ARN when processing parent ${quotedOrNotShown(plan.cdkdName)}. Leaf-first ` +
              `iteration order should have IMPORTed the child first — this is a cdkd bug.`
          );
        }
        const childCfnName = cfnStackNameOf(row.childStackName);

        // Fetch the just-IMPORTed child's current template (AWS-side
        // canonicalized) and upload it to the cdkd state bucket so the
        // parent's nested-stack row's `TemplateURL` points at the
        // template AWS actually has on file for the child stack — the
        // AWS-docs "Nest an existing stack" template-match requirement.
        const preparing = adoptionPreparingLabel(row.logicalId);
        const childTemplateBody = await afterImport(preparing, 'imported', () =>
          fetchCfnStackTemplate(deps.cfnClient, childCfnName)
        );
        const uploaded = await afterImport(preparing, 'imported', () =>
          uploadCfnTemplate({
            bucket: deps.uploadOpts.stateBucket,
            body: childTemplateBody,
            stackName: `${plan.cdkdName}__nested__${row.logicalId}`,
            // GetTemplate(Processed) always returns JSON regardless of
            // the original synth format; the codec accepts either.
            format: 'json',
            ...(deps.uploadOpts.s3ClientOpts && { s3ClientOpts: deps.uploadOpts.s3ClientOpts }),
          })
        );
        uploadCleanups.push(uploaded.cleanup);

        // Fetch the child stack's CURRENT tags — the parent's
        // nested-stack row's `Properties.Tags` must match these per
        // AWS's "Nested stack import validation" (otherwise the
        // changeset fails at execute time with "Tags of resource
        // [<id>] defined in the template don't match..."). The
        // child's tags include the temporary `cdkd:nested-export-flip`
        // tag added by `flipStackToUpdateComplete`; forwarding them
        // verbatim ensures the parent template's row matches the
        // AWS-side reality at adoption time.
        const childTagsDesc = await afterImport(preparing, 'imported', () =>
          deps.cfnClient.send(new DescribeStacksCommand({ StackName: childCfnName }))
        );
        const childActualTags = childTagsDesc.Stacks?.[0]?.Tags ?? [];

        const originalRow = getResourceFromTemplate(plan.template, row.logicalId);
        if (!originalRow) {
          // Defensive cdkd-bug guard, intentionally untested: unreachable
          // via the normal flow. `row.logicalId` comes from
          // `buildImportPlan(plan.template)`, which produced this
          // nested-stack row by iterating `plan.template.Resources` — so a
          // re-read of the same template object is guaranteed to find it.
          // A miss can only arise if `plan.template` is mutated between
          // plan-build and this read, which the orchestrator never does.
          throw new Error(
            `runPerStackImportLoop: parent template for ${quotedOrNotShown(plan.cdkdName)} has no ` +
              `resource ${quotedOrNotShown(row.logicalId)}. State and template are out of sync.`
          );
        }
        const rewrittenRow = injectRetainAndRewriteTemplateUrl(
          originalRow,
          uploaded.url,
          childActualTags
        );
        (phase1BTemplate['Resources'] as Record<string, unknown>)[row.logicalId] = rewrittenRow;
        rewrittenNestedRows.set(row.logicalId, rewrittenRow);

        phase1BResources.push({
          ResourceType: NESTED_STACK_RESOURCE_TYPE,
          LogicalResourceId: row.logicalId,
          ResourceIdentifier: { StackId: childArn },
        });
      }

      try {
        // Phase 1B's outer template is serialized in the user's synth
        // format (`plan.templateFormat` — may be YAML when the user passed
        // `--template foo.yaml`), while each nested-child `TemplateURL` it
        // references points at a JSON body (GetTemplate(Processed) always
        // returns JSON, uploaded with `format: 'json'` above). AWS detects
        // each URL's format independently of the outer template's, so the
        // mixed YAML-parent / JSON-child shape is intentional and safe.
        await submitImportChangeSet(
          deps.cfnClient,
          plan.cfnName,
          phase1BTemplate,
          phase1BResources,
          stackParameters,
          plan.templateFormat,
          deps.uploadOpts
        );
      } catch (err) {
        // Phase 1A already succeeded — the parent CFn stack exists with
        // its leaf resources. Phase 1B (nested adoption) failed. The
        // stacks before it are CFn stacks too, standalone or already
        // adopted by their own parents. cdkd state is preserved across
        // the tree so the user can recover.
        // Each name through `quotedOrNotShown`, not the raw `safeSegment`
        // spelling (go-to-k/cdkd#4205 review): a planted cdkd name such as
        // `Root~A; touch OWNED; #` ran here once text pasted above the
        // message flipped the quote parity.
        const importedSummary =
          importedStacks.length > 0
            ? importedStacks
                .map(
                  (s) =>
                    `${quotedOrNotShown(s.cdkdStackName)} → ${quotedOrNotShown(s.cfnStackName)}`
                )
                .join(', ')
            : '(none)';
        throw new Error(
          `Phase 1B (nested-child adoption) IMPORT changeset failed for parent ` +
            `${quotedOrNotShown(plan.cdkdName)} (CFn name ${quotedOrNotShown(plan.cfnName)}). The parent CFn stack ` +
            `exists with its ${plan.phase1Imports.length} leaf resource(s); ` +
            `${plan.nestedStackRows.length} nested-child adoption(s) did NOT complete. ` +
            `Stacks IMPORTed so far (each a CFn stack): ${importedSummary}. ` +
            `cdkd state for every stack in the tree is preserved. To recover, fix the ` +
            `underlying cause (typically a template-match validation error per AWS-docs ` +
            `"Nested stack import validation"), then re-attempt the parent-side nested ` +
            `adoption by hand via the AWS console or CLI, per the AWS docs "Nest an existing ` +
            `stack" procedure. Do NOT run cdkd destroy on the tree: that would tear down the ` +
            `live AWS resources. ` +
            // Bounded and folded, as at Phase 1A (go-to-k/cdkd#3910).
            `Cause: ${displayAwsMessage(describeAwsFailure(err).detail)}\n` +
            // Which records to clean up, and when, go through the same gated,
            // region-bearing tail as the other nested failures — never a
            // bare `cdkd state orphan <stack>`, which drops that name's
            // record in EVERY region (go-to-k/cdkd#3967).
            nestedResumeTail(i, 'imported'),
          { cause: err instanceof Error ? err : undefined }
        );
      }
      logger.info(
        `  ✓ Phase 1B: parent ${quotedOrNotShown(plan.cfnName)} adopted ${plan.nestedStackRows.length} ` +
          `nested child(ren) via UPDATE-IMPORT.`
      );

      // Phase 1B's UPDATE-IMPORT leaves the parent in IMPORT_COMPLETE
      // again. Flip back to UPDATE_COMPLETE if this parent will itself
      // be adopted by its OWN parent in a later iteration (i.e. it's
      // not the root). For the root, the migration is over after
      // Phase 1B — no further flip needed.
      if (plan.cdkdName !== rootStackName) {
        logger.info(
          `  Flipping ${quotedOrNotShown(plan.cfnName)} back to UPDATE_COMPLETE so its own parent's ` +
            `Phase 1B can adopt it...`
        );
        await afterImport(
          'The no-op tag update moving its CloudFormation stack back out of IMPORT_COMPLETE ' +
            'after its nested-child adoption',
          'adopted',
          () => flipStackToUpdateComplete(deps.cfnClient, plan.cfnName, stackParameters)
        );
      }
    }

    // ---- Per-stack pre-delete + phase 2 UPDATE ----
    if (plan.recreateBeforePhase2.length > 0) {
      for (const entry of plan.recreateBeforePhase2) {
        const handler = PRE_DELETE_HANDLERS[entry.resourceType];
        if (!handler) {
          throw new Error(
            `No pre-delete handler registered for ${plainOrNotShown(entry.resourceType)} ` +
              `(${plainOrNotShown(entry.logicalId)}) in stack ${quotedOrNotShown(plan.cdkdName)}. This is a cdkd bug — the ` +
              `resource is in IMPORT_UNSUPPORTED_RECREATABLE_TYPES but lacks a ` +
              `PRE_DELETE_HANDLERS entry.\n` +
              // Its CloudFormation stack exists by now, so even a cdkd bug
              // gives the recovery (go-to-k/cdkd#3988). An earlier entry may
              // already be deleted; the by-hand deletes allow for that.
              nestedResumeTail(i, 'adopted')
          );
        }
        logger.info(
          `  Pre-deleting AWS resource for ${rowIdent(entry.logicalId)} ` +
            `(${rowIdent(entry.resourceType)}) ` +
            `so CFn can re-CREATE in phase 2...`
        );
        try {
          await handler(entry);
        } catch (err) {
          // The single-stack path's wrapper, for the nested path
          // (go-to-k/cdkd#3910): AWS's text can quote a recorded policy name
          // or principal name back, and nothing above this renders it.
          const msg = describeAwsFailure(err).detail;
          const importedSummary = importedStacks
            .map(
              (s) => `${quotedOrNotShown(s.cdkdStackName)} → ${quotedOrNotShown(s.cfnStackName)}`
            )
            .join(', ');
          throw new Error(
            `Phase 1 (IMPORT) succeeded for cdkd stack ${quotedOrNotShown(plan.cdkdName)} (CFn ` +
              `name ${quotedOrNotShown(plan.cfnName)}); pre-delete of ${plainOrNotShown(entry.logicalId)} ` +
              `(${plainOrNotShown(entry.resourceType)}, physicalId: ` +
              `${recordValueOrNotShown(entry.physicalId)}) failed: ${displayAwsMessage(msg)}\n\n` +
              `Stacks IMPORTed so far (each CFn-managed): ${importedSummary}. cdkd state ` +
              `for every stack in the tree is preserved. This stack's IMPORT-unsupported ` +
              `resources may still exist in AWS unmanaged. To recover: fix the failure ` +
              `cause, delete the remaining pre-delete resources of this stack by hand:\n` +
              preDeleteManualCommands(plan.recreateBeforePhase2)
                .map((line) => `  ${line}\n`)
                .join('') +
              `then run the phase-2 UPDATE for ${quotedOrNotShown(plan.cfnName)} by hand with ` +
              `its full synth template. ` +
              nestedResumeTail(i, 'phase2'),
            { cause: err instanceof Error ? err : undefined }
          );
        }
        logger.info(`    ${preDeletedLine(entry.physicalId)}`);
      }
    }

    const stackPhase2Count = plan.phase2Creates.length + plan.recreateBeforePhase2.length;
    if (stackPhase2Count > 0) {
      // Phase-2 template must include the nested-stack rows we
      // injected (so CFn does not try to remove them) AND must apply
      // the same conditional `ResourceIdentifier` overlay as phase-1
      // to avoid silent REPLACEMENT of any immutable Name property.
      // Start from `applyImportOverlayForPhase2`'s output (which
      // operates against the full template) and re-inject the
      // Retain-bearing nested-stack rows we constructed during
      // phase-1 — same `Properties.TemplateURL` rewrite so CFn
      // continues to see the AWS-canonicalized child template.
      const phase2Template = applyImportOverlayForPhase2(plan.template, plan.phase1Imports);
      for (const row of plan.nestedStackRows) {
        const overlaidResources = phase2Template['Resources'] as Record<string, unknown>;
        const rewrittenRow = rewrittenNestedRows.get(row.logicalId);
        if (rewrittenRow !== undefined) {
          overlaidResources[row.logicalId] = rewrittenRow;
        }
      }
      try {
        await executeUpdateChangeSet(
          deps.cfnClient,
          plan.cfnName,
          phase2Template,
          stackParameters,
          plan.templateFormat,
          deps.uploadOpts
        );
      } catch (err) {
        // `executeUpdateChangeSet` rethrows the waiter's and
        // ExecuteChangeSet's errors bare, so this is the one place that
        // renders them on the nested path (go-to-k/cdkd#3910).
        throw new Error(
          `Phase 2 (UPDATE) failed for cdkd stack ${quotedOrNotShown(plan.cdkdName)} (CFn name ` +
            `${quotedOrNotShown(plan.cfnName)}): ` +
            `${displayAwsMessage(describeAwsFailure(err).detail)}. Its ` +
            `phase-1 IMPORT succeeded and cdkd state is preserved; fix the cause and run the ` +
            `phase-2 UPDATE by hand with its full synth template. ` +
            nestedResumeTail(i, 'phase2'),
          { cause: err instanceof Error ? err : undefined }
        );
      }
      logger.info(
        `  ✓ Phase 2: stack ${quotedOrNotShown(plan.cfnName)} updated ` +
          `(${plan.phase2Creates.length} non-importable CREATE, ` +
          `${plan.recreateBeforePhase2.length} re-CREATE).`
      );
    }
  }

  // ---- All stacks IMPORTed: delete cdkd state leaf-first ----
  // At this point every stack in the tree is CFn-managed. State
  // deletion is best-effort: a transient S3 error on the Nth call
  // would leave the first N-1 states deleted while the rest persist,
  // and re-running `cdkd export` would then hit `assertCfnStackAbsent`
  // for the already-migrated stacks with no hint of partial state.
  // Collect failures and re-throw with a summary so the user can
  // either re-run state deletion manually (via `cdkd state orphan
  // <stack>` per remaining record) or accept the orphan state until
  // their next manual cleanup. AWS-side state is unchanged either
  // way — every stack is CFn-managed, the migration succeeded.
  const stateDeletionFailures: Array<{ stackName: string; region: string; reason: string }> = [];
  for (const node of leafFirst) {
    try {
      await removeExportedStackRecord(deps.stateBackend, node.stackName, node.region, logger);
      // Same record-derived pair as the warn below, and the same rule: a
      // planted newline in a logical id forges a line here too.
      logger.info(
        `cdkd state for ${quotedOrNotShown(node.stackName)} (${quotedRegion(node.region)}) removed.`
      );
    } catch (err) {
      stateDeletionFailures.push({
        stackName: node.stackName,
        region: node.region,
        reason: describeAwsFailure(err).detail,
      });
      const orphan = orphanCommandFor(node.stackName, node.region, args.lockRecovery);
      logger.warn(
        `Failed to delete cdkd state for ${quotedOrNotShown(node.stackName)} ` +
          `(${quotedRegion(node.region)}): ` +
          // `safeDetail`, not `quotedOrNotShown`: an SDK message is
          // FREE-FORM text, which `display-safe.ts` says takes
          // `displaySafe` directly (the identifier helper's contract is a
          // record field or a key segment).
          `${safeDetail(err)}. ` +
          `The stack IS CFn-managed; clean up its state record.${orphan.note}\n` +
          `Clean up with: ${orphan.command}`
      );
    }
  }
  if (stateDeletionFailures.length > 0) {
    // The per-failure warnings already named each affected stack;
    // throw a summary so the orchestrator's caller can surface a
    // non-zero exit code (the migration succeeded AWS-side but
    // partial state remains under cdkd).
    const lines = stateDeletionFailures
      .map(
        (f) =>
          // The SAME record-derived values the warn above sanitizes, in a
          // MULTI-LINE block: a planted newline forges extra `  - cdkd/...`
          // rows naming a healthy stack, and the sentence below tells the
          // operator to orphan every record listed (review round 4).
          // The whole key through `quotedOrNotShown` (go-to-k/cdkd#4205
          // review): raw `safeSegment` segments ran a planted name when
          // the row was pasted.
          `  - ${quotedOrNotShown(`cdkd/${f.stackName}/${f.region}/state.json`)}: ` +
          `${safeDetail(f.reason)}`
      )
      .join('\n');
    throw new Error(
      `${stateDeletionFailures.length} cdkd state record(s) could not be deleted after a ` +
        `successful per-stack IMPORT loop. Every stack in the tree IS CFn-managed (the ` +
        `migration succeeded AWS-side); orphan state remains under:\n${lines}\n` +
        // The FULL template: omitting `--stack-region` drops the record for
        // that name in EVERY region, which is wider than this list
        // describes and is the widening `orphanCommandFor` refuses to emit.
        `Recover with the command below, once per record.` +
        // The run's account flags (go-to-k/cdkd#4648), so each pasted drop
        // removes the record in the bucket this export read.
        spacedAccountClause(args.lockRecovery, 'the command below prints') +
        `\nRecover with: ${
          pasteableCommand('cdkd state orphan', [
            { hole: 'stack' },
            { flag: '--stack-region', hole: 'region' },
            ...accountArgs(args.lockRecovery),
          ]).command
        }`
    );
  }

  // Aggregate summary of intrinsic-valued Parameters that could NOT be
  // resolved across the tree (cdkd resolves `Ref` / `Fn::GetAtt` against
  // the parent's state up front; this lists only the residue the
  // resolver could not handle). The per-stack warns above scroll past
  // under `--yes`; re-print a single consolidated line at the end so the
  // user has one place to confirm every affected child's template carries
  // the needed Parameter Default values (CFn rejects the IMPORT otherwise).
  if (sessionIntrinsicSkipped.size > 0) {
    const detail = [...sessionIntrinsicSkipped.entries()]
      // Template-derived Parameter names and a record-derived stack name,
      // each through `quotedOrNotShown` (go-to-k/cdkd#3371).
      .map(
        ([cdkdName, params]) =>
          `${quotedOrNotShown(cdkdName)} (${params.map((n) => quotedOrNotShown(n)).join(', ')})`
      )
      .join('; ');
    logger.warn(
      `${sessionIntrinsicSkipped.size} stack(s) had intrinsic-valued Parameter(s) that cdkd ` +
        `could not resolve at IMPORT time: ${detail}. Verify each child template's Parameter ` +
        `Default values cover these before the first 'cdk deploy'.`
    );
  }

  return { outcome: 'success', importedStacks };
}
