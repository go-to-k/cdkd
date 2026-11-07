import type { NestedStackProvider } from '../nested-stack-provider.js';
import { plainOrDescribed } from '../../../utils/pasteable-command.js';
import type {
  ResourceCreateResult,
  ResourceUpdateResult,
  CreateContext,
  UpdateContext,
} from '../../../types/resource.js';
import { getCurrentProducerRegions } from '../../../deployment/producer-regions-scope.js';
import {
  getNestedRevertRun,
  revertNestedChildFromJournal,
} from '../../../deployment/nested-child-journal.js';
import type { NestedStackProviderContext } from '../../nested-stack-context.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { clearCreatedBeforeFailure, markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import {
  displayIdent,
  displaySafe,
  displayStackName,
  safeMsg,
} from '../../../utils/display-safe.js';
import { recordWithPendingChildDeletes } from './shared.js';

export async function create(
  this: NestedStackProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  const ctx = this.requireContext();
  this.requireDeployContext(ctx, 'create');

  const childTemplatePath = ctx.nestedTemplates![logicalId];
  if (!childTemplatePath) {
    throw markNonRetryable(
      new Error(
        `Nested template file not found for AWS::CloudFormation::Stack ${displayIdent(logicalId)} ` +
          `under parent ${displayStackName(ctx.parentStackName)}. Verify the synth output emits ` +
          `Metadata['aws:asset:path'] on this resource (CDK 2.x cdk.NestedStack does so by default).`
      )
    );
  }
  this.refuseMalformedNestedTemplateTree(ctx, logicalId, childTemplatePath);

  const { template: childTemplate, grandchildTemplates } = this.readChildTemplate(
    childTemplatePath,
    ctx.assetRedirect
  );
  const childStackName = this.deriveChildStackName(ctx.parentStackName, logicalId);
  const childRegion = ctx.parentRegion;
  const childParameters = this.extractParameters(properties);

  const resourceCount = Object.keys(childTemplate.Resources ?? {}).length;
  this.logger.info(
    `Deploying nested stack ${displaySafe(childStackName)} (logicalId=${displaySafe(logicalId)}, ${resourceCount} resource(s))`
  );

  let pendingChildDeletes: Awaited<ReturnType<NestedStackProvider['runChildDeploy']>>;
  try {
    pendingChildDeletes = await this.runChildDeploy(
      ctx,
      logicalId,
      childStackName,
      childRegion,
      childTemplate,
      childParameters,
      grandchildTemplates
    );
  } catch (error) {
    // go-to-k/cdkd#4583: the child's journal already holds its rows' marks;
    // read again here, a grandchild stack sharing this row's logical id
    // would be journaled as THIS row's resource.
    clearCreatedBeforeFailure(error);
    throw error;
  }

  // The CHILD's region, not the parent's — identical today (see
  // `childRegion` above) but the two are named apart because the resolver
  // READS this segment back as the producer region when it re-resolves a
  // redacted child output (issue #2055).
  const physicalId = this.synthesizeArn(ctx.accountId, childRegion, ctx.parentStackName, logicalId);
  try {
    const childOutputs = await this.readChildOutputsAsAttributes(ctx, childStackName, childRegion);
    const pendingRecord =
      context?.replayingState === true
        ? undefined
        : recordWithPendingChildDeletes(properties, pendingChildDeletes);

    return {
      physicalId,
      attributes: childOutputs.attributes,
      // Issue #2274: names the recovered outputs so the deploy engine
      // re-registers them as mask-only needles for this record and for every
      // parent resource that resolves one.
      ...(childOutputs.noEchoAttributeNames.length > 0 && {
        noEchoAttributeNames: childOutputs.noEchoAttributeNames,
      }),
      // go-to-k/cdkd#3869: always set (possibly empty), so the engine
      // rewrites the row's field from this read.
      secretNamedAttributeNames: childOutputs.secretNamedAttributeNames,
      ...(pendingRecord && { effectiveProperties: pendingRecord }),
    };
  } catch (error) {
    // go-to-k/cdkd#4583: the child stack is deployed (its own state holds
    // its resources) and this row would hold nothing, so name it for the
    // failed-CREATE journal. `delete()` addresses the child by the parent
    // stack name and logical id; the id is the one a success records.
    markCreatedBeforeFailure(error, logicalId, resourceType, physicalId);
    throw error;
  }
}

export async function update(
  this: NestedStackProvider,
  logicalId: string,
  physicalId: string,
  _resourceType: string,
  properties: Record<string, unknown>,
  _previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  const ctx = this.requireContext();

  // Issue #3754: a ROLLBACK revert of this row. The desired bag is the
  // row's previous state record, but the child's previous state is not in
  // it — and re-deploying `ctx.nestedTemplates[logicalId]`, the CURRENT
  // synth, over the child's just-saved state diffs NO_CHANGE, so the revert
  // reported the row restored while the child kept the failed deploy's
  // configuration. Replay the child's own journal for the run being rolled
  // back instead. Ahead of `requireDeployContext`: this path reads no
  // template, so standalone `cdkd rollback` (a destroy-mode context) can
  // take it too.
  if (context?.replayingState === true) {
    return this.revertFromChildJournal(ctx, logicalId, physicalId);
  }

  this.requireDeployContext(ctx, 'update');

  const childTemplatePath = ctx.nestedTemplates![logicalId];
  if (!childTemplatePath) {
    throw markNonRetryable(
      new Error(
        `Nested template file not found for AWS::CloudFormation::Stack ${displayIdent(logicalId)} on update.`
      )
    );
  }
  this.refuseMalformedNestedTemplateTree(ctx, logicalId, childTemplatePath);

  const { template: childTemplate, grandchildTemplates } = this.readChildTemplate(
    childTemplatePath,
    ctx.assetRedirect
  );
  const childStackName = this.deriveChildStackName(ctx.parentStackName, logicalId);
  const childRegion = ctx.parentRegion;
  const childParameters = this.extractParameters(properties);

  const resourceCount = Object.keys(childTemplate.Resources ?? {}).length;
  this.logger.info(
    `Updating nested stack ${displaySafe(childStackName)} (logicalId=${displaySafe(logicalId)}, ${resourceCount} resource(s))`
  );

  // The child's own DeployEngine handles CREATE / UPDATE / DELETE per
  // resource based on its diff against the child's state — so calling
  // `deploy()` here naturally covers add / remove / mutate inside the
  // child. The parent's physicalId (synthesized ARN) is stable as long
  // as the parent stack name + nested logical id don't change.
  const pendingChildDeletes = await this.runChildDeploy(
    ctx,
    logicalId,
    childStackName,
    childRegion,
    childTemplate,
    childParameters,
    grandchildTemplates
  );
  const pendingRecord = recordWithPendingChildDeletes(properties, pendingChildDeletes);

  const updatedOutputs = await this.readChildOutputsAsAttributes(ctx, childStackName, childRegion);

  return {
    physicalId,
    wasReplaced: false,
    attributes: updatedOutputs.attributes,
    // Issue #2274 — see `create()`.
    ...(updatedOutputs.noEchoAttributeNames.length > 0 && {
      noEchoAttributeNames: updatedOutputs.noEchoAttributeNames,
    }),
    // go-to-k/cdkd#3869 — see `create()`.
    secretNamedAttributeNames: updatedOutputs.secretNamedAttributeNames,
    ...(pendingRecord && { effectiveProperties: pendingRecord }),
  };
}

/**
 * The rollback arm of {@link update} (issue #3754): replay the child's
 * journal segments for the parent run being rolled back. The run comes from
 * {@link getNestedRevertRun}, bound by both rollback drivers; its ABSENCE is
 * refused rather than guessed, because selecting segments without it could
 * replay another run's changes over a live child.
 *
 * Returns no `attributes`: the rollback executor restores this row's
 * previous record wholesale, previous `Outputs.<Key>` included. When the
 * child replay skipped an op, the result is `partial`: the executor then
 * reports the row as restored with a remainder instead of cleanly (the
 * drivers count the skips as warnings through the run scope).
 */
export async function revertFromChildJournal(
  this: NestedStackProvider,
  ctx: NestedStackProviderContext,
  logicalId: string,
  physicalId: string
): Promise<ResourceUpdateResult> {
  const childStackName = this.deriveChildStackName(ctx.parentStackName, logicalId);
  const run = getNestedRevertRun();
  if (!run) {
    throw markNonRetryable(
      new Error(
        `Cannot revert nested stack ${displayStackName(childStackName)}: the revert was requested ` +
          `outside a rollback run, so there is no deploy run to select its journal segments by. ` +
          `The child was NOT reverted.`
      )
    );
  }
  this.logger.info(
    safeMsg`Reverting nested stack ${displaySafe(childStackName)} (logicalId=${displaySafe(logicalId)}) from its rollback journal`
  );
  const { warnings } = await revertNestedChildFromJournal({
    ctx,
    logicalId,
    childStackName,
    region: ctx.parentRegion,
    run,
    logger: this.logger,
    // go-to-k/cdkd#4174: the reverting replay's producer regions, bound by
    // the rollback executor. None bound reads as incomplete in the child.
    inheritedProducerRegions: getCurrentProducerRegions()?.(),
  });
  if (warnings > 0) {
    return {
      physicalId,
      wasReplaced: false,
      outcome: 'partial',
      // `plainOrDescribed`, not `displaySafe`: a skip or partial reason is
      // shown beside a flag or a `cdkd` command, and the child name holds a
      // state.json logical id, whose words would otherwise be the command a
      // pasted clause runs (go-to-k/cdkd#4265).
      reason: `nested stack ${plainOrDescribed(childStackName, 'stack name')} skipped ${warnings} operation(s) of its revert`,
    };
  }
  return { physicalId, wasReplaced: false };
}
