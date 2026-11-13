import { withSharedDrainBudget } from '../../../deployment/drain-budget.js';
import {
  prepareCloudFormationStackRetirement,
  deleteRetiredCloudFormationStack,
  findReplacedCfnResources,
  SUPERSEDED_COPY_HINT,
  cfnFailureText,
  type ReplacedCfnResource,
  getCloudFormationResourceTree,
  NESTED_STACK_RESOURCE_TYPE,
  type CfnStackResourceTree,
} from '../retire-cfn-stack.js';
import { readDeployedParameters } from '../import-deployed-parameters.js';
import { namesAnyDeclaredParameter } from '../../../analyzer/parameter-dependence.js';
import { displaySafe, safeMsg } from '../../../utils/display-safe.js';
import { cdkdRemedy } from '../../../utils/pasteable-command.js';
import { logicalIdShown } from '../../../provisioning/composite-id.js';
import { nullPrototypeRecord } from '../../../utils/own-keys.js';
import type { StackState } from '../../../types/state.js';
import { refuseMalformedResourceEntriesForImportSave } from '../../../state/malformed-resources-bag.js';
import {
  confirmPrompt,
  importOne,
  printSummary,
  refuseLostReplacedRows,
  warnMigrationOrphans,
} from './import-one.js';
import { importNestedStackChildrenRecursive, synthesizeNestedStackArn } from './nested.js';
import { captureObservedForImportedResources } from './observed-capture.js';
import { writeRecordedMapping } from './overrides.js';
import { resolveImportedProperties } from './resolve-properties.js';
import {
  buildStackState,
  claimRegistryMarkerAfterImport,
  rebuiltLogicalIdsFrom,
  recordImportOnRollbackJournal,
} from './stack-state.js';
import type { ImportRow } from './types.js';
import type { ConsoleLogger } from '../../../utils/logger.js';
import type { LockManager } from '../../../state/lock-manager.js';
import type { S3StateBackend } from '../../../state/s3-state-backend.js';
import type { AssetRedirectMap } from '../../../assets/asset-redirect.js';
import type { LockRecoveryContext } from '../../../state/lock-contention-message.js';
import type { StackInfo } from '../../../synthesis/assembly-reader.js';
import type { AwsClients } from '../../../utils/aws-clients.js';
import type { ProviderRegistry } from '../../../provisioning/provider-registry.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import type { TemplateParser } from '../../../analyzer/template-parser.js';
import type { collectImportableResources } from './overrides.js';
import type { ImportOptions } from './types.js';

/**
 * The locals `importCommand` computed before it took the stack lock, handed
 * to {@link runLockedImport}. Every field is read under the same name it had
 * in `importCommand`.
 */
export interface LockedImportContext {
  options: ImportOptions;
  logger: ConsoleLogger;
  stateBucket: string;
  lockRecovery: LockRecoveryContext;
  stateBackend: S3StateBackend;
  lockManager: LockManager;
  stackInfo: StackInfo;
  targetRegion: string;
  regionClients: AwsClients;
  providerRegistry: ProviderRegistry;
  assetRedirect: AssetRedirectMap | undefined;
  stateTemplate: CloudFormationTemplate;
  overrides: Map<string, string>;
  migrationCfnStackName: string | undefined;
  template: CloudFormationTemplate;
  templateParser: TemplateParser;
  resources: ReturnType<typeof collectImportableResources>;
  templateLogicalIds: Set<string>;
  migrationTree: CfnStackResourceTree | undefined;
  accountIdForNestedSynth: string | undefined;
  selectiveMode: boolean;
  existingState: StackState | null;
  existingEtag: string | undefined;
  migrationPending: boolean;
  owner: string;
}

/**
 * The part of `importCommand` that runs while it holds the stack lock: the
 * per-resource dispatch, the summary, the confirmation, the CloudFormation
 * retirement steps, the observed-baseline capture and the state write.
 * `importCommand` calls it inside the `try` whose `finally` releases the
 * lock, so every `return` and `throw` here still passes through that
 * release. `migrationTree` is the one local this body reassigns; no caller
 * code reads it afterwards.
 */
export async function runLockedImport(ctx: LockedImportContext): Promise<void> {
  const {
    options,
    logger,
    stateBucket,
    lockRecovery,
    stateBackend,
    lockManager,
    stackInfo,
    targetRegion,
    regionClients,
    providerRegistry,
    assetRedirect,
    stateTemplate,
    overrides,
    migrationCfnStackName,
    template,
    templateParser,
    resources,
    templateLogicalIds,
    accountIdForNestedSynth,
    selectiveMode,
    existingState,
    existingEtag,
    migrationPending,
    owner,
  } = ctx;
  let { migrationTree } = ctx;

  // The dispatch over every template resource. A closure so the Retain
  // update below can re-run it when CloudFormation REPLACED a resource and
  // the ids it read are stale (issue #4873).
  const collectRows = async (): Promise<ImportRow[]> => {
    const collected: ImportRow[] = [];
    for (const { logicalId, resource } of resources) {
      // Selective mode: skip resources not in overrides up front. They
      // never hit the provider, so the summary correctly distinguishes
      // "out of scope" from "AWS not found".
      if (selectiveMode && !overrides.has(logicalId)) {
        collected.push({
          logicalId,
          resourceType: resource.Type,
          outcome: 'skipped-out-of-scope',
          reason: 'not in --resource / --resource-mapping (use --auto to include)',
        });
        continue;
      }

      // Nested-stack short-circuit (issue #464): adopt each
      // `AWS::CloudFormation::Stack` row with cdkd's synthesized
      // cdkd-local ARN. `NestedStackProvider` has no `import()` (the
      // child's state is written out-of-band below in
      // `importNestedStackChildren`), so without this short-circuit
      // every nested-stack row would surface as `skipped-no-impl` and
      // the parent's `Ref <NestedStack>` resolutions would later
      // mis-resolve at deploy time. Only fires when we have a
      // matching child in the AWS tree — outside the migration code
      // path the dispatch falls through to the existing
      // `skipped-no-impl` (provider has no `import()`).
      if (
        resource.Type === NESTED_STACK_RESOURCE_TYPE &&
        migrationTree &&
        migrationTree.nested.has(logicalId) &&
        accountIdForNestedSynth
      ) {
        collected.push({
          logicalId,
          resourceType: resource.Type,
          outcome: 'imported',
          physicalId: synthesizeNestedStackArn(
            targetRegion,
            accountIdForNestedSynth,
            stackInfo.stackName,
            logicalId
          ),
        });
        continue;
      }

      const outcome = await importOne({
        logicalId,
        resource,
        stackName: stackInfo.stackName,
        region: targetRegion,
        providerRegistry,
        override: overrides.get(logicalId),
        overrides,
      });
      collected.push(outcome);
    }
    return collected;
  };
  let rows = await collectRows();

  printSummary(rows);

  // Write the resolved logicalId→physicalId mapping out for re-use in
  // CI (mirrors upstream `cdk import --record-resource-mapping`).
  // Done BEFORE any early-return / confirmation: --dry-run, "no" at
  // the prompt, and zero-imports all still produce the file. Empty
  // mapping serializes as `{}` rather than being omitted, so callers
  // can detect "ran but nothing matched" vs "did not run". A write
  // failure here is logged but does NOT abort: the import already
  // happened in memory, and the record file is metadata.
  if (options.recordResourceMapping) {
    writeRecordedMapping(options.recordResourceMapping, rows);
  }

  // The state record this run would write, assembled HERE — once `rows`
  // is final and BEFORE the `--dry-run` return and the confirmation
  // prompt — rather than below them (go-to-k/cdkd#3202, maintainer round
  // 2, M4). `buildStackState` is a pure assembly, so building it early
  // costs nothing, and it is what lets the re-check below decide the same
  // way on a dry run and on the real run: the pre-flight above exempted
  // the LISTED rows from the unreadable-row refusal on the promise that
  // this assembly replaces them, and it replaces only a row whose import
  // SUCCEEDED, keeping the stored row for one that failed or was skipped.
  // Checked below the assembly and above everything that acts on it —
  // the dry-run verdict (which would otherwise say "re-run without
  // --dry-run" for a run that then refuses), the prompt (which would
  // otherwise ask "Write state?" for a record the run then refuses to
  // write), the property resolution (which reads every row) and the
  // save. Every unreadable row still present is a listed one the run
  // could not repair; an unlisted one was refused pre-flight, and a
  // whole-stack rebuild starts from `{}`.
  //
  // `stateTemplate` is the PRE-asset-rewrite snapshot in cdkd-assets mode
  // (issue #1652) and `template` itself otherwise — identical in every
  // respect except that its asset references still name CDK bootstrap
  // storage, which is what AWS holds for the resources being adopted.
  const assembleStackState = (): StackState => {
    const assembled = buildStackState(
      stackInfo.stackName,
      targetRegion,
      rows,
      templateParser,
      stateTemplate,
      existingState,
      selectiveMode
    );
    refuseMalformedResourceEntriesForImportSave(
      assembled,
      stackInfo.stackName,
      targetRegion,
      lockRecovery
    );
    return assembled;
  };
  let stackState = assembleStackState();

  if (options.dryRun) {
    logger.info('--dry-run: state will NOT be written. Re-run without --dry-run to apply.');
    return;
  }

  let importedRows = rows.filter((r) => r.outcome === 'imported');
  if (importedRows.length === 0) {
    logger.warn('No resources were successfully imported. State will not be written.');
    return;
  }

  if (!options.yes) {
    // In a selective merge, the resulting state holds the imported rows
    // PLUS the preserved unlisted entries from existing state. Reflect
    // that in the prompt so the user sees the full impact, not just
    // what's being added in this run.
    const importedCount = importedRows.length;
    const preservedCount =
      selectiveMode && existingState
        ? Object.keys(existingState.resources ?? {}).filter((id) => !overrides.has(id)).length
        : 0;
    const totalAfter = importedCount + preservedCount;
    const breakdown =
      preservedCount > 0 ? ` (${importedCount} new/overwritten + ${preservedCount} preserved)` : '';
    const ok = await confirmPrompt(
      `Write state for ${stackInfo.stackName} (${targetRegion}) ` +
        `with ${totalAfter} resource(s)${breakdown}?`
    );
    if (!ok) {
      logger.info('Import cancelled.');
      return;
    }
  }

  // Steps 1-3 of retiring the source CloudFormation stack run HERE, BEFORE
  // the state write (issue #4873). The Retain update is not always
  // metadata-only: CloudFormation can REPLACE a resource on it (an
  // auto-named `AWS::SSM::Document` is the observed case) and repoint the
  // stack at the new physical resource. State written from the ids read
  // before the update named the superseded copy, so `cdkd destroy` deleted
  // that and left the live one behind. Re-reading after the update and
  // building state from what CloudFormation now holds means this run's
  // state never names a superseded copy, and the injected
  // `UpdateReplacePolicy: Retain` keeps that copy, so no crash leaves any
  // state naming a resource the update deleted. Still
  // inside the lock-protected `try`, so a concurrent `cdkd deploy` cannot
  // race the CFn calls.
  let retireCfnStack = false;
  // Rows a replacing Retain update touched inside a nested child, keyed by
  // the child's path; the child walk below refuses when one is lost.
  let nestedReplaced: ReplacedCfnResource[] = [];
  if (migrationCfnStackName) {
    // Partial-import warning: some template resources didn't make it
    // into cdkd state (AWS-not-found, no provider, or out-of-scope).
    // After DeleteStack those resources keep existing in AWS but are
    // unmanaged by both CFn (Retain causes DeleteStack to skip them)
    // AND cdkd (never written to state). Surface that out loud so the
    // user can either re-import or accept the orphaning intentionally.
    // Re-issued below when a re-dispatch changes the count; each nested
    // child warns for its own rows.
    warnMigrationOrphans(logger, resources.length, importedRows.length);
    const preparation = await prepareCloudFormationStackRetirement({
      cfnStackName: migrationCfnStackName,
      cfnClient: regionClients.cloudFormation,
      yes: options.yes,
      // Reuse cdkd's state bucket as transient storage for the
      // Retain-injected template when it exceeds the 51,200-byte
      // inline UpdateStack limit. Forward `--profile` so the
      // upload identity matches the one that writes cdkd state.
      stateBucket,
      ...(options.profile && { s3ClientOpts: { profile: options.profile } }),
      // Pass the pre-built tree so the recursive Retain-injection
      // walk reuses our existing DescribeStackResources calls instead
      // of redoing them.
      //
      // The guard cannot currently be false: `migrationTree` is awaited
      // unconditionally under the same `if (migrationCfnStackName)` that
      // gates this block, so this is the site that makes
      // `retire-cfn-stack.ts`'s "import always supplies the tree" note
      // true. It is written conditionally anyway because the two
      // assignments are far apart and a future early-return between
      // them would reintroduce the undefined case silently.
      ...(migrationTree && { resourceTree: migrationTree }),
    });
    // A decline keeps the pre-update behaviour: the state the operator
    // already confirmed is written, and the stack is left alone.
    retireCfnStack = preparation.outcome === 'ready';
    if (preparation.outcome === 'ready' && preparation.templateUpdated && migrationTree) {
      let updatedTree: CfnStackResourceTree;
      try {
        updatedTree = await getCloudFormationResourceTree(
          migrationCfnStackName,
          regionClients.cloudFormation
        );
      } catch (err) {
        // The update COMPLETED, so a replacement may have happened, and a
        // re-run will not see one (no update runs then): say so here.
        throw new Error(
          safeMsg`--migrate-from-cloudformation: the Retain-policy update completed, but ` +
            safeMsg`re-reading the stack's resources failed: ${cfnFailureText(err)}. ` +
            `cdkd state was not written and the CloudFormation stack was not deleted. ` +
            SUPERSEDED_COPY_HINT
        );
      }
      // Only rows this import can adopt: a root row the template holds that
      // is not a nested-stack row (its id is cdkd's synthesized ARN anyway).
      // Nested-child rows go to their child walk.
      const replaced = findReplacedCfnResources(migrationTree, updatedTree).filter(
        (r) =>
          r.nestedPath.length > 0 ||
          (templateLogicalIds.has(r.logicalId) &&
            template.Resources[r.logicalId]?.Type !== NESTED_STACK_RESOURCE_TYPE)
      );
      // The nested-child state writes below read this tree, so they pick
      // up a child's replaced ids with no step of their own.
      migrationTree = updatedTree;
      nestedReplaced = replaced.filter((r) => r.nestedPath.length > 0);
      for (const r of replaced) {
        const where =
          r.nestedPath.length > 0
            ? safeMsg`nested stack ${r.nestedPath.map((p) => logicalIdShown(p)).join(' > ')}: `
            : '';
        // Only a CFn-derived id is repointed. One the operator pinned with
        // `--resource` to some OTHER value stays theirs.
        const pinned =
          r.nestedPath.length === 0 &&
          overrides.has(r.logicalId) &&
          overrides.get(r.logicalId) !== r.before;
        if (r.nestedPath.length === 0 && overrides.get(r.logicalId) === r.before) {
          overrides.set(r.logicalId, r.after);
        }
        logger.warn(
          safeMsg`CloudFormation replaced ${where}${logicalIdShown(r.logicalId)} while applying ` +
            safeMsg`the Retain policies: the stack now holds ${displaySafe(r.after)}` +
            (pinned
              ? safeMsg`; cdkd keeps the physical id you passed with --resource, so ${displaySafe(r.after)} ` +
                `(kept by DeletionPolicy=Retain) is managed by neither CloudFormation nor cdkd either. `
              : `, which cdkd adopts. `) +
            safeMsg`The replaced ${displaySafe(r.before)} is RETAINED and managed by neither ` +
            `CloudFormation nor cdkd; delete it yourself once you no longer need it.`
        );
      }
      if (replaced.some((r) => r.nestedPath.length === 0)) {
        // Re-run the WHOLE dispatch, not only the replaced rows: a
        // dependent resource's import pre-resolves `{Ref: <replaced>}`
        // through `overrides` (`substituteOverrideRefs`), so its row is
        // stale too.
        rows = await collectRows();
        printSummary(rows);
        stackState = assembleStackState();
        // A row the first dispatch adopted and this one lost (a new copy
        // not yet readable, say) would be orphaned by the DeleteStack below
        // with no warning, so refuse. Nothing is written.
        const adoptedBefore = importedRows.map((r) => r.logicalId);
        importedRows = rows.filter((r) => r.outcome === 'imported');
        const adoptedNow = new Set(importedRows.map((r) => r.logicalId));
        // Re-recorded BEFORE the refusal too: the first dispatch already
        // wrote the superseded ids, and a later `--resource-mapping` run
        // would pin them. A lost row drops out of the file.
        if (options.recordResourceMapping) {
          writeRecordedMapping(options.recordResourceMapping, rows);
        }
        refuseLostReplacedRows(
          adoptedBefore.filter((id) => !adoptedNow.has(id)),
          'cdkd state was not written and the CloudFormation stack was not deleted.'
        );
        if (importedRows.length !== adoptedBefore.length) {
          // More rows than the operator confirmed: say so rather than
          // writing a count nobody saw.
          logger.warn(
            safeMsg`--migrate-from-cloudformation: the re-import after the replacement adopts ` +
              safeMsg`${importedRows.length} resource(s); ${adoptedBefore.length} were confirmed.`
          );
          warnMigrationOrphans(logger, resources.length, importedRows.length);
        }
      }
    }
  }

  // `stackState` was assembled and re-checked above the `--dry-run` return
  // and the prompt (and again after a replacing Retain update); from here
  // on this run WRITES it.

  // Resolve CFn intrinsics (Ref / Fn::GetAtt / Fn::Sub / ...) in every
  // freshly-imported resource's `properties` against the assembled
  // state map, then overwrite `state.properties` with the resolved
  // shape. Closes issue #328: pre-fix, `buildStackState` wrote the
  // synth template's Properties verbatim, intrinsics and all, which
  // broke `cdkd destroy` for sub-resource types whose `delete()` reads
  // properties at delete time (e.g. `AWS::Lambda::Permission` whose
  // `FunctionName` is `{Fn::GetAtt: [...]}`). `cdkd deploy` does NOT
  // have this problem because the deploy engine runs the resolver
  // against each resource's Properties before calling `provider.create()`
  // and stores the resolved shape in state — this brings `cdkd import`
  // in line with the v3 schema's "resolved template intent" semantics.
  //
  // Per-resource try/catch: an intrinsic referencing a resource that
  // wasn't imported (custom resource, out-of-scope sibling) is logged
  // and left as-is rather than aborting the whole import. The
  // eventual destroy failure on the un-resolved props is narrower
  // than blowing up the entire adoption flow.
  // ONE drain budget for the whole resolve LOOP inside it (issue #2563),
  // for the same reason the deploy engine's outputs pass wraps: the lock
  // is held above and `saveState` is downstream, and each `resolve` in
  // there can now WAIT on a rejection.
  //
  // The source stack's deployed parameter values (issue #2854), read only
  // when something in the template NAMES a declared parameter. CDK declares
  // `BootstrapVersion` on every default-synthesized stack and nothing but
  // `Rules` names it, so keying on "declares any" would put
  // `DescribeStacks` on the IAM requirements of essentially every import.
  //
  // The stack asked about is the migration source, or — on EVERY other
  // import, selective mode included — the same-named CloudFormation stack,
  // whose absence is the ordinary cdkd-native case and means "no deployed
  // values exist" rather than a failure. Asked independently of auto
  // mode's resource-map lookup: that lookup degrades to `null` on a
  // permission error, and keying this on it would fail OPEN.
  const deployedParameters = !namesAnyDeclaredParameter(stateTemplate)
    ? undefined
    : migrationCfnStackName !== undefined
      ? await readDeployedParameters(
          migrationCfnStackName,
          regionClients.cloudFormation,
          logger,
          displaySafe(migrationCfnStackName)
        )
      : await readDeployedParameters(
          stackInfo.stackName,
          regionClients.cloudFormation,
          logger,
          displaySafe(stackInfo.stackName),
          { absentStackIsNoSource: true }
        );
  // go-to-k/cdkd#6170: an import creating the record over a first deploy
  // that wrote ahead and was cut short adopts what that deploy made, whose
  // names took `AWS::StackId`'s tail from the sibling's flag; resolve with it.
  // The id itself is taken below, from the same sibling.
  // Optional for the test doubles, as the deploy's prefetch is.
  if (existingState === null && typeof stateBackend.peekStackInstanceSibling === 'function') {
    const sibling = await stateBackend.peekStackInstanceSibling(stackInfo.stackName, targetRegion);
    if (sibling?.stackIdFromInstance === true) {
      stackState = {
        ...stackState,
        stackInstanceId: sibling.stackInstanceId,
        stackIdFromInstance: true,
      };
    }
  }
  const unsafeObservedBaselineLogicalIds = await withSharedDrainBudget(() =>
    resolveImportedProperties(
      stackState,
      stateTemplate,
      targetRegion,
      stateBackend,
      logger,
      deployedParameters
    )
  );

  // Populate observedProperties for the freshly-imported resources so
  // the very first `cdkd drift` run after import has a real baseline
  // (matching what `cdkd deploy` does after each create/update). Done
  // synchronously in parallel before saveState — import is a rare op
  // and the few extra seconds are amortized into the user's adoption
  // workflow. Errors are swallowed per-resource so a single
  // readCurrentState failure does not abort the whole import.
  await captureObservedForImportedResources(
    stackState,
    providerRegistry,
    logger,
    unsafeObservedBaselineLogicalIds,
    // Issue #2944: the rows this run REBUILT from the template. Derived
    // from the same `outcome === 'imported'` predicate `buildStackState`
    // uses to decide which records it overwrites, so the two cannot
    // disagree about which `properties` are this run's.
    rebuiltLogicalIdsFrom(rows, stateTemplate)
  );

  // Forward the etag for optimistic locking when state already exists,
  // and trigger legacy-key migration when the existing state was loaded
  // from the v1 layout. For the create-from-empty case, the absence of
  // `expectedEtag` is what tells saveState to use IfNoneMatch.
  const saveOptions: { expectedEtag?: string; migrateLegacy?: boolean } = {};
  if (existingEtag) {
    saveOptions.expectedEtag = existingEtag;
  }
  if (migrationPending) {
    saveOptions.migrateLegacy = true;
  }
  // State schema v13 (go-to-k/cdkd#5064): an import CREATING the record is
  // the stack's first state write, so it takes the stack's lifetime id --
  // the one a first deploy interrupted before its record wrote ahead (the
  // import adopts what that deploy made), or a fresh one. Under the lock;
  // an existing record's id (or absence) was carried by `buildStackState`.
  if (existingState === null) {
    stackState = {
      ...stackState,
      stackInstanceId: await stateBackend.stackInstanceIdForFirstWrite(
        stackInfo.stackName,
        targetRegion,
        { writeAhead: false }
      ),
    };
  }
  await recordImportOnRollbackJournal(
    stateBackend,
    stackInfo.stackName,
    targetRegion,
    importedRows.map((r) => r.logicalId),
    stackState.resources,
    logger
  );
  await stateBackend.saveState(stackInfo.stackName, targetRegion, stackState, saveOptions);
  logger.info(`✓ State written: ${stackInfo.stackName} (${targetRegion})`);
  // go-to-k/cdkd#4705: the stack now has a record here, so it claims its
  // stack registry marker (record first, then marker).
  await claimRegistryMarkerAfterImport(stateBackend, stackInfo.stackName, targetRegion, logger);
  // The diff carries the run's flags, `--aws-emulator` included (go-to-k/cdkd#6245).
  logger.info(
    safeMsg`  ${importedRows.length} resource(s) imported. ` +
      safeMsg`See how the imported state lines up with the template with: ${cdkdRemedy('cdkd diff')}`
  );

  // Recursive per-child state writes (issue #464). For every nested
  // `AWS::CloudFormation::Stack` resource at this level, recursively
  // adopt the child stack into its own v6-keyed state file under
  // `cdkd/<parent>~<childLogicalId>/<region>/state.json` with
  // `parentStack` / `parentLogicalId` / `parentRegion` populated.
  // Done AFTER the root state write so a failure in the recursive
  // walk leaves the user with a working root state record they can
  // re-run against (each child write is idempotent — the resource
  // map is rebuilt from CFn's per-child `DescribeStackResources`
  // response). Children's locks are acquired leaves-first and
  // released in reverse on both success and failure.
  if (migrationCfnStackName && migrationTree && accountIdForNestedSynth) {
    await importNestedStackChildrenRecursive({
      lockRecovery,
      parentStackName: stackInfo.stackName,
      parentRegion: targetRegion,
      // Null-prototype on the ABSENT arm too (issue go-to-k/cdkd#3480).
      parentNestedTemplates: stackInfo.nestedTemplates ?? nullPrototypeRecord<string>(),
      parentTree: migrationTree,
      nestedPath: [],
      replaced: nestedReplaced,
      stateBackend,
      lockManager,
      providerRegistry,
      templateParser,
      lockOwner: owner,
      accountId: accountIdForNestedSynth,
      logger,
      assetRedirect,
      cfnClient: regionClients.cloudFormation,
    });
  }

  // Step 4 of the retirement: delete the CloudFormation stack record now
  // that cdkd state — root and every nested child — is committed. Every
  // resource carries DeletionPolicy=Retain, so nothing in AWS is deleted.
  // A failure here leaves a working cdkd state record; the stack can be
  // deleted by hand or the command re-run.
  if (migrationCfnStackName && retireCfnStack) {
    await deleteRetiredCloudFormationStack(migrationCfnStackName, regionClients.cloudFormation);
  }
}
