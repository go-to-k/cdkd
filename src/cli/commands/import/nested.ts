import { readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { withSharedDrainBudget } from '../../../deployment/drain-budget.js';
import { getLogger } from '../../../utils/logger.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import {
  describeJsonParseFailure,
  parseFailureDebugDetail,
  utf8ByteLength,
} from '../../../utils/json-parse-failure.js';
import { S3StateBackend } from '../../../state/s3-state-backend.js';
import { LockManager } from '../../../state/lock-manager.js';
import {
  buildLockContentionMessage,
  type LockRecoveryContext,
} from '../../../state/lock-contention-message.js';
import { ProviderRegistry } from '../../../provisioning/provider-registry.js';
import { TemplateParser } from '../../../analyzer/template-parser.js';
import {
  rewriteTemplateAssetReferences,
  type AssetRedirectMap,
} from '../../../assets/asset-redirect.js';
import {
  type ReplacedCfnResource,
  NESTED_STACK_RESOURCE_TYPE,
  type CfnStackResourceTree,
} from '../retire-cfn-stack.js';
import { readDeployedParameters } from '../import-deployed-parameters.js';
import { namesAnyDeclaredParameter } from '../../../analyzer/parameter-dependence.js';
import { displayIdent, displaySafe, safeMsg } from '../../../utils/display-safe.js';
import {
  displayAssemblyPath,
  renderAssemblyPathEscape,
  resolveAssemblyPath,
} from '../../../utils/assembly-path.js';
import { nullPrototypeRecord } from '../../../utils/own-keys.js';
import type { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import { stackInstanceIdCarriedFrom } from '../../../types/state.js';
import { stackInstanceIdOf } from '../../../state/stack-instance-id.js';
import { importOne, refuseLostReplacedRows, warnMigrationOrphans } from './import-one.js';
import { captureObservedForImportedResources } from './observed-capture.js';
import { collectImportableResources, mergeCfnDerivedOverrides } from './overrides.js';
import { resolveImportedProperties } from './resolve-properties.js';
import {
  buildStackState,
  rebuiltLogicalIdsFrom,
  recordImportOnRollbackJournal,
} from './stack-state.js';
import type { ImportRow } from './types.js';

/**
 * Synthesize the cdkd-local ARN that `NestedStackProvider.create` would write
 * for a nested-stack resource (design [docs/design/459-nested-stacks.md](../../../docs/design/459-nested-stacks.md)
 * §3, issue [#464](https://github.com/go-to-k/cdkd/issues/464) §6). Partition
 * `cdkd-local` is load-bearing — any consumer that misuses this value as a
 * real AWS ARN fails loudly with "Invalid ARN partition: cdkd-local" rather
 * than silently using a non-ARN string. The format MUST match
 * `NestedStackProvider.synthesizeArn` so an import-then-deploy cycle does
 * not surface phantom property changes on the nested-stack row.
 *
 * THE REGION SEGMENT IS READ BACK, so it must be the CHILD's region and must
 * not be collapsed with the parent's (issue
 * [#2055](https://github.com/go-to-k/cdkd/issues/2055)).
 * `nestedStackChildRegionFromLocalArn` in
 * [src/deployment/intrinsic-resolver/context.ts](../../deployment/intrinsic-resolver/context.ts)
 * parses this segment to learn which region to resolve a child's persisted
 * `{{resolve:...}}` output in — a secret NAME is regional, so resolving it in
 * the wrong region can answer with a DIFFERENT secret. Reading the child's own
 * state record instead is not an option: the region is part of that record's S3
 * key, so the lookup would be circular. That reader's doc block carries the
 * full rationale; this note exists because the value is produced HERE and the
 * next edit to the import walk would otherwise have nothing in front of it.
 *
 * Both call sites already pass a child-scoped value — the top-level walk passes
 * `targetRegion` (the stack being imported) and the recursive nested walk
 * passes `childRegion` — and parent and child region are necessarily equal
 * until cross-region nested stacks ship. The parameter is named `childRegion`
 * anyway, matching `NestedStackProvider.synthesizeArn`, so the requirement is
 * visible at the signature rather than only in prose.
 */
export function synthesizeNestedStackArn(
  childRegion: string,
  accountId: string,
  parentStackName: string,
  logicalId: string
): string {
  return `arn:cdkd-local:${childRegion}:${accountId}:nested-stack/${parentStackName}/${logicalId}`;
}

/**
 * Validate the parent template ↔ AWS CFn tree shape consistency before any
 * destructive walk begins. Three failure modes are surfaced up front so
 * the user gets one clear error instead of a partial-success state file
 * graveyard:
 *
 *   1. Synth template has `AWS::CloudFormation::Stack` row at logical id X
 *      but AWS tree has no child at X — likely the user added a new
 *      nested child to the CDK code without running `cdk deploy` first.
 *   2. AWS tree has child at logical id Y but synth template has no
 *      matching row — the user removed a nested child from the CDK code
 *      but the live CFn stack still has it (or AWS removed it
 *      mid-flight).
 *   3. Synth's `nestedTemplates` index is missing a path for some nested
 *      row — usually means CDK 2.x didn't emit `Metadata['aws:asset:path']`
 *      on the row (older CDK versions, or a hand-edited template). Without
 *      the local template file we can't enumerate the child's resources
 *      for the per-child state write.
 *
 * Mirrors the upstream `cdk import` mismatch UX — "import refuses on a
 * shape mismatch, fix the shape and re-run."
 */
export function validateNestedStackShape(
  template: CloudFormationTemplate,
  tree: CfnStackResourceTree,
  parentStackName: string,
  nestedTemplates: Record<string, string>
): void {
  const templateNestedIds = new Set<string>();
  for (const [logicalId, resource] of Object.entries(template.Resources)) {
    if (resource.Type === NESTED_STACK_RESOURCE_TYPE) {
      templateNestedIds.add(logicalId);
    }
  }
  const treeNestedIds = new Set<string>(tree.nested.keys());

  const inTemplateMissingFromAws: string[] = [];
  for (const id of templateNestedIds) {
    if (!treeNestedIds.has(id)) inTemplateMissingFromAws.push(id);
  }
  const inAwsMissingFromTemplate: string[] = [];
  for (const id of treeNestedIds) {
    if (!templateNestedIds.has(id)) inAwsMissingFromTemplate.push(id);
  }
  const inTemplateMissingNestedTemplatePath: string[] = [];
  for (const id of templateNestedIds) {
    if (!nestedTemplates[id]) inTemplateMissingNestedTemplatePath.push(id);
  }

  const problems: string[] = [];
  if (inTemplateMissingFromAws.length > 0) {
    problems.push(
      `template has nested-stack row(s) not present in CloudFormation: ` +
        `[${inTemplateMissingFromAws.join(', ')}] — run \`cdk deploy\` first ` +
        `so the AWS-side stack matches the synth template`
    );
  }
  if (inAwsMissingFromTemplate.length > 0) {
    problems.push(
      `CloudFormation has nested-child stack(s) not present in the synth template: ` +
        `[${inAwsMissingFromTemplate.join(', ')}] — the CDK code was edited ` +
        `to remove these children, but the live CFn stack still has them. ` +
        `Run \`cdk deploy\` to apply the removal, or revert the CDK edit`
    );
  }
  if (inTemplateMissingNestedTemplatePath.length > 0) {
    problems.push(
      `synth cloud assembly is missing nested-template asset paths for row(s) ` +
        `[${inTemplateMissingNestedTemplatePath.join(', ')}] — verify CDK 2.x ` +
        `\`cdk.NestedStack\` emits Metadata['aws:asset:path'] (default behavior)`
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `cdkd import --migrate-from-cloudformation: parent stack '${parentStackName}' ` +
        `template ↔ CloudFormation shape mismatch:\n  - ${problems.join('\n  - ')}`
    );
  }
}

/**
 * After the root parent stack's cdkd state is written, walk the
 * `migrationTree.nested` map and adopt every nested child into its own
 * v6-keyed state file (`cdkd/<parent>~<childLogicalId>/<region>/state.json`).
 * Recurses into grandchildren via the same walker.
 *
 * Per child:
 *   1. Acquire the child's lock. Order across the full tree is
 *      **parent-first acquire, leaves-first release** (each level's
 *      `finally` releases its child lock before sibling iteration
 *      continues, and the root lock is the outermost — held by
 *      `importCommand`'s `try` / `finally`). This is the conventional
 *      hierarchical lock pattern: parent-first acquire prevents a
 *      second cdkd import from racing past the root lock; leaves-first
 *      release on success/failure means a mid-walk error never strands
 *      a child lock past its scope. Design §3.3 wording ("leaves first,
 *      parent last") is preserved as the RELEASE order; the acquire
 *      order is parent-first to keep the lock graph deadlock-free.
 *   2. Read the child template body from the synth cloud assembly via
 *      `parentNestedTemplates[<childLogicalId>]` (populated by
 *      AssemblyReader at synth time — see {@link AssemblyReader.parseStack}).
 *   3. Enumerate the child's importable resources (same filter as the
 *      root's `collectImportableResources` — drop `AWS::CDK::Metadata`,
 *      short-circuit `AWS::CloudFormation::Stack` rows to synth ARNs).
 *   4. For each child resource: dispatch through `importOne` with the
 *      child's `(logicalId → physicalId)` overrides from `childTree.resources`.
 *   5. Build the child's `StackState` with `parentStack` / `parentLogicalId`
 *      / `parentRegion` populated per state schema v6.
 *   6. Save state via `stateBackend.saveState('<parent>~<childLogicalId>', ...)`.
 *   7. Recurse into grandchildren.
 *
 * Lock release happens in REVERSE acquisition order in the outer
 * `finally` of each child — leaves-first acquire / parent-last release on
 * success, AND parent-last release on failure. Per memory rule
 * `feedback_destructive_state_test_coverage.md`, the lock-release order
 * is verified by unit test.
 */
export async function importNestedStackChildrenRecursive(args: {
  parentStackName: string;
  parentRegion: string;
  /** AssemblyReader-built `childLogicalId → local template file path` index for the parent's direct children. */
  parentNestedTemplates: Record<string, string>;
  parentTree: CfnStackResourceTree;
  /** Nested-stack logical ids from the root down to the PARENT; `[]` at the root. */
  nestedPath: string[];
  /**
   * Rows the Retain update replaced inside nested children (issue #4873). A
   * child refuses, before its own save and before `DeleteStack`, when one of
   * ITS rows did not import by the new id.
   */
  replaced: ReplacedCfnResource[];
  stateBackend: S3StateBackend;
  lockManager: LockManager;
  providerRegistry: ProviderRegistry;
  templateParser: TemplateParser;
  lockOwner: string;
  accountId: string;
  logger: ReturnType<typeof getLogger>;
  /**
   * Threaded down the recursion so a CHILD's contention message names the same
   * bucket / profile the parent resolved. `cdkd force-unlock` re-resolves both
   * from the ambient profile otherwise, and a nested child never has a state
   * record to fall back on (issue #2170).
   */
  lockRecovery: LockRecoveryContext;
  /**
   * Issue #1002 PR 2 — §6 mapping table when the region is in cdkd-assets
   * mode. Each child template read below gets the §7 rewrite (nested
   * templates bypass the top-level rewrite in `importCommand`). Per issue
   * #1652 a snapshot is taken BEFORE that rewrite and is what feeds the
   * child's state write, so `state.properties` keeps the pre-rewrite values.
   */
  assetRedirect?: AssetRedirectMap | undefined;
  /**
   * Reads each child's DEPLOYED parameter values (issue #2854). A nested
   * child's own `DescribeStacks` answer IS what its parent supplied, so the
   * parent's `Stack.Properties.Parameters` needs no plumbing of its own.
   */
  cfnClient: CloudFormationClient;
}): Promise<void> {
  const {
    parentStackName,
    parentRegion,
    parentNestedTemplates,
    parentTree,
    stateBackend,
    lockManager,
    providerRegistry,
    templateParser,
    lockOwner,
    accountId,
    logger,
    assetRedirect,
  } = args;

  for (const [childLogicalId, childTreeNode] of parentTree.nested) {
    const childStackName = `${parentStackName}~${childLogicalId}`;
    const childRegion = parentRegion;
    const childTemplatePath = parentNestedTemplates[childLogicalId];
    if (!childTemplatePath) {
      throw new Error(
        `cdkd import --migrate-from-cloudformation: missing nested-template ` +
          `path for '${childLogicalId}' under parent '${parentStackName}' — ` +
          `validateNestedStackShape should have rejected this; please file a bug.`
      );
    }

    logger.info(
      `Adopting nested stack '${childLogicalId}' as cdkd stack '${childStackName}' ` +
        `(${childRegion})...`
    );

    const childTemplate = readNestedChildTemplate(childTemplatePath, childLogicalId);
    // Issue #1652 — same PRE-rewrite state snapshot as the root walk: the
    // child's `state.properties` must carry the CDK-bootstrap asset values
    // AWS holds, so the next `cdkd deploy` produces the corrective UPDATE
    // instead of a `NO_CHANGE` that leaves the live child resources pointing
    // at the CDK bootstrap bucket forever.
    let childStateTemplate = childTemplate;
    if (assetRedirect) {
      childStateTemplate = structuredClone(childTemplate);
      const childRewritten = rewriteTemplateAssetReferences(childTemplate, assetRedirect);
      if (childRewritten > 0) {
        // Announced per CHILD, not only at the root. Under
        // `--migrate-from-cloudformation` the assets can live entirely in
        // nested children, in which case the root's count is 0 and no notice
        // would be printed at all — while the child states carry pre-rewrite
        // values and the next deploy shows UPDATEs the user was never warned
        // about.
        logger.info(
          `Note: ${childRewritten} asset reference(s) in nested stack ${childStackName} are ` +
            `recorded in state at their pre-rewrite (CDK bootstrap) values, so the next ` +
            `'cdkd deploy' repoints any resource that still holds them to cdkd asset storage.`
        );
      }
    }

    // Check the boolean (issue #2161): a bare `acquireLock` returns `false`
    // for a live foreign lock, which the discarded return treated as acquired,
    // so a nested-child import ran under contention and released the other
    // owner's lock via the `try` below. See the top-level import site above.
    const childAcquired = await lockManager.acquireLock(
      childStackName,
      childRegion,
      lockOwner,
      'import'
    );
    if (!childAcquired) {
      throw new Error(
        await buildLockContentionMessage({
          lockManager,
          stackName: childStackName,
          region: childRegion,
          subject: 'nested stack',
          recovery: args.lockRecovery,
        })
      );
    }
    try {
      // Compose the child's import overrides from the child tree's flat
      // resource map, through the same shared filter as the root walk
      // (issue #1131). The "already overridden" filter is inert here — the
      // child map starts empty, since `--resource` overrides are root-scoped.
      const childResources = collectImportableResources(childTemplate);
      const childTemplateLogicalIds = new Set(childResources.map((r) => r.logicalId));
      const childOverrides = new Map<string, string>();
      mergeCfnDerivedOverrides({
        cfnMapping: childTreeNode.resources,
        template: childTemplate,
        templateLogicalIds: childTemplateLogicalIds,
        overrides: childOverrides,
      });

      // Dispatch + collect rows (same shape as the root's dispatch loop).
      const rows: ImportRow[] = [];
      for (const { logicalId, resource } of childResources) {
        if (resource.Type === NESTED_STACK_RESOURCE_TYPE && childTreeNode.nested.has(logicalId)) {
          rows.push({
            logicalId,
            resourceType: resource.Type,
            outcome: 'imported',
            physicalId: synthesizeNestedStackArn(childRegion, accountId, childStackName, logicalId),
          });
          continue;
        }
        const outcome = await importOne({
          logicalId,
          resource,
          stackName: childStackName,
          region: childRegion,
          providerRegistry,
          override: childOverrides.get(logicalId),
          overrides: childOverrides,
        });
        rows.push(outcome);
      }

      // Issue #4873: a row the Retain update replaced in THIS child must have
      // imported by its new id. Checked before this child's save, so the
      // parent (already saved) and earlier siblings keep their records while
      // this child and the DeleteStack do not happen.
      const childPath = [...args.nestedPath, childLogicalId];
      const childImported = new Set(
        rows.filter((r) => r.outcome === 'imported').map((r) => r.logicalId)
      );
      refuseLostReplacedRows(
        args.replaced
          .filter(
            (r) =>
              r.nestedPath.length === childPath.length &&
              r.nestedPath.every((p, i) => p === childPath[i]) &&
              childTemplateLogicalIds.has(r.logicalId) &&
              !childImported.has(r.logicalId)
          )
          .map((r) => r.logicalId),
        safeMsg`cdkd state for nested stack ${displaySafe(childStackName)} was not written ` +
          `(the parent's and earlier nested stacks' were), and the CloudFormation stack ` +
          `was not deleted; the re-run needs --force.`
      );
      warnMigrationOrphans(logger, childResources.length, childImported.size, childStackName);

      // Build child state (auto / whole-stack mode — no pre-existing
      // selective merge for a fresh nested child). Populate the v6
      // parent-link fields so `NestedStackProvider.delete`'s child-state
      // lookup at destroy time, `cdkd state list` / `state show` rendering,
      // and any future cross-stack consumer scan can navigate the tree.
      const childStackState = buildStackState(
        childStackName,
        childRegion,
        rows,
        templateParser,
        childStateTemplate,
        null,
        false
      );
      childStackState.parentStack = parentStackName;
      childStackState.parentLogicalId = childLogicalId;
      childStackState.parentRegion = parentRegion;
      // State schema v13 (go-to-k/cdkd#5064): the child is built from nothing,
      // but it may have a record already (a re-import), whose lifetime id --
      // or legacy absence -- it keeps. Otherwise the child's first state write
      // takes its own id, as its first deploy would. Under the child's lock.
      const childPrior = await stateBackend.getState(childStackName, childRegion);
      const childStackInstanceId = childPrior
        ? stackInstanceIdOf(childPrior.state, displaySafe(childStackName))
        : await stateBackend.stackInstanceIdForFirstWrite(childStackName, childRegion, {
            writeAhead: false,
          });
      if (childPrior) {
        // The id checked above, with the lifetime's retired name generations
        // and the superseded resources still to delete (#5111): a rebuild
        // from nothing would drop them, leaving live resources unrecorded.
        Object.assign(childStackState, stackInstanceIdCarriedFrom(childPrior.state));
      } else if (childStackInstanceId !== undefined) {
        childStackState.stackInstanceId = childStackInstanceId;
      }

      // Resolve intrinsics in child Properties (same reason as root —
      // sub-resource provider deletes read resolved props), populate
      // observedProperties baseline, then save. Re-uses the same
      // helpers as the root so behavior stays in sync.
      // One budget for this child's resolve loop too; see the root call.
      // Issue #2854: addressed by the child stack's ARN from the resource tree
      // (the API-accepted identifier), DISPLAYED by its cdkd name.
      const childDeployedParameters = namesAnyDeclaredParameter(childStateTemplate)
        ? await readDeployedParameters(
            childTreeNode.stackName,
            args.cfnClient,
            logger,
            displaySafe(childStackName)
          )
        : undefined;
      const childUnsafeObservedBaselineLogicalIds = await withSharedDrainBudget(() =>
        resolveImportedProperties(
          childStackState,
          childStateTemplate,
          childRegion,
          stateBackend,
          logger,
          childDeployedParameters
        )
      );
      await captureObservedForImportedResources(
        childStackState,
        providerRegistry,
        logger,
        childUnsafeObservedBaselineLogicalIds,
        // Issue #2944, same derivation as the top-level call site. A nested
        // child is built fresh on every recursive walk rather than merged, so
        // in practice every row is rebuilt — passing the set anyway keeps the
        // two call sites the same shape, so a future change to the child walk
        // cannot quietly acquire the preserved-record hazard.
        rebuiltLogicalIdsFrom(rows, childTemplate)
      );

      await recordImportOnRollbackJournal(
        stateBackend,
        childStackName,
        childRegion,
        rows.filter((r) => r.outcome === 'imported').map((r) => r.logicalId),
        childStackState.resources,
        logger
      );
      await stateBackend.saveState(childStackName, childRegion, childStackState);
      logger.info(
        `✓ Nested stack state written: ${childStackName} (${childRegion}) — ` +
          `${rows.filter((r) => r.outcome === 'imported').length} resource(s) imported.`
      );

      // Recurse into grandchildren. The recursive call acquires their
      // own locks; this child's lock stays held until its `finally`
      // releases it AFTER its descendants' locks are released (matches
      // the "leaves first, parent last" lock contract — descendants
      // release first, then this level, then the root in `importCommand`'s
      // outer `finally`).
      if (childTreeNode.nested.size > 0) {
        await importNestedStackChildrenRecursive({
          lockRecovery: args.lockRecovery,
          parentStackName: childStackName,
          parentRegion: childRegion,
          // Grandchild template paths live alongside the child template
          // file via `Metadata['aws:asset:path']` — index them with the
          // same logic AssemblyReader uses at the parent level. Read off the
          // PRE-rewrite snapshot: the asset rewrite walks every string,
          // `aws:asset:path` included, so a path segment spelling a bootstrap
          // bucket would otherwise lead here to a different file than the one
          // `NestedStackProvider` deploys (it indexes before rewriting, as
          // `cdkd diff` does since go-to-k/cdkd#3450).
          parentNestedTemplates: indexGrandchildTemplatePaths(
            childStateTemplate,
            childTemplatePath
          ),
          parentTree: childTreeNode,
          nestedPath: [...args.nestedPath, childLogicalId],
          replaced: args.replaced,
          stateBackend,
          lockManager,
          providerRegistry,
          templateParser,
          lockOwner,
          accountId,
          logger,
          assetRedirect,
          cfnClient: args.cfnClient,
        });
      }
    } finally {
      await lockManager.releaseLock(childStackName, childRegion).catch((err) => {
        logger.warn(
          `Failed to release lock for nested stack '${childStackName}' (${childRegion}): ` +
            `${describeAwsFailure(err).detail}`
        );
      });
    }
  }
}

/**
 * Read a nested child's template body from the synth cloud assembly's
 * sibling file (the path AssemblyReader populates from
 * `Metadata['aws:asset:path']`). Wraps the I/O + JSON parse failures with
 * an actionable error that names the offending child logical id.
 */
function readNestedChildTemplate(
  templatePath: string,
  childLogicalId: string
): CloudFormationTemplate {
  // Sync fs reads — import is a rare, single-threaded operation and the
  // per-child template is bounded by the 1 MB CFn TemplateURL limit, so
  // the latency is comparable to a few network round-trips. Matching the
  // pattern `NestedStackProvider.readChildTemplate` uses for the same
  // reason.
  let raw: string;
  try {
    raw = readFileSync(templatePath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Failed to read nested-stack template for '${childLogicalId}' at ` +
        `${templatePath}: ${describeAwsFailure(err).detail}`
    );
  }
  try {
    return JSON.parse(raw) as CloudFormationTemplate;
  } catch (err) {
    // V8's `SyntaxError` quotes a window of the template, which can hold a
    // plaintext value, so the message names only the failure's offset and
    // size (issue #5254); V8's text goes to `debug` only.
    getLogger().debug(
      safeMsg`Nested-stack template for '${childLogicalId}' failed to parse: ${parseFailureDebugDetail(err)}`
    );
    throw new Error(
      `Failed to parse nested-stack template for '${childLogicalId}' at ` +
        `${templatePath}: ${describeJsonParseFailure(err, utf8ByteLength(raw))}`
    );
  }
}

/**
 * Index a child template's `AWS::CloudFormation::Stack` rows by their
 * `aws:asset:path` Metadata, mirroring what {@link AssemblyReader.parseStack}
 * does for the root parent. Grandchild template files are sibling .nested
 * files of the child template file in the same cdk.out subdirectory.
 *
 * Refuses absolute paths for the same reason `NestedStackProvider.indexGrandchildTemplates`
 * does: an absolute path indicates the synth output was hand-modified or
 * generated by a non-CDK toolchain — `path.join(dir, '/abs/foo')` would
 * silently bypass our `dir` resolution and point outside cdk.out.
 *
 * Also refuses a path that RESOLVES outside `dir`, which the absolute check
 * cannot see — `path.join` folds `..`
 * ([#3489](https://github.com/go-to-k/cdkd/issues/3489)). Exported for unit
 * testing.
 */
export function indexGrandchildTemplatePaths(
  childTemplate: CloudFormationTemplate,
  childTemplatePath: string
): Record<string, string> {
  const dir = nodePath.dirname(childTemplatePath);
  // Null-prototype, like every other nested-template index (issue
  // go-to-k/cdkd#3480): a logical id is a template key, so a `{}` literal drops
  // a row named `__proto__` through the inherited setter and answers a
  // never-indexed `toString` / `valueOf` with a prototype member.
  const result = nullPrototypeRecord<string>();
  for (const [grandLogicalId, resource] of Object.entries(childTemplate.Resources)) {
    if (resource.Type !== NESTED_STACK_RESOURCE_TYPE) continue;
    const meta = resource.Metadata as Record<string, unknown> | undefined;
    const assetPath = meta?.['aws:asset:path'];
    if (typeof assetPath !== 'string' || assetPath.length === 0) continue;
    if (nodePath.isAbsolute(assetPath)) {
      throw new Error(
        `cdkd import --migrate-from-cloudformation: grandchild nested-stack ` +
          `${displayIdent(grandLogicalId)} has ` +
          `Metadata['aws:asset:path']=${displayAssemblyPath(assetPath)} ` +
          `which is absolute. CDK emits relative asset paths for nested templates.`
      );
    }
    // The containment check the tripwire above is NOT (issue
    // go-to-k/cdkd#3489): `path.join` folds `..`, so a row of
    // `../../etc/passwd` resolved out of `dir` and was read and imported into
    // cdkd state. Both refusals stay, worded apart.
    const resolved = resolveAssemblyPath(dir, assetPath);
    if (!resolved.contained) {
      throw new Error(
        `cdkd import --migrate-from-cloudformation: grandchild nested-stack ` +
          `${displayIdent(grandLogicalId)} has ` +
          `Metadata['aws:asset:path']=${displayAssemblyPath(assetPath)} which ` +
          `${renderAssemblyPathEscape(resolved, dir)}`
      );
    }
    result[grandLogicalId] = resolved.path;
  }
  return result;
}
