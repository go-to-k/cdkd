import type { PipesPipeProvider } from '../pipes-provider.js';
import {
  UpdatePipeCommand,
  TagResourceCommand,
  UntagResourceCommand,
  NotFoundException,
  type DescribePipeCommandOutput,
  type PipeEnrichmentParameters,
  type UpdatePipeCommandInput,
} from '@aws-sdk/client-pipes';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import { assertRegionMatch } from '../../region-check.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { withRemovalDefaults } from '../../update-removal.js';
import { planTagDiff, tagMapAsList, tagPlanWarning } from '../../tag-list.js';
import { unchangedBehindSecretReference } from '../../secret-reference-immutable.js';
import type { ResourceUpdateResult, UpdateContext } from '../../../types/resource.js';
import { desiredTagMap, toSdkTargetParameters, toUpdateSourceParameters } from './shared.js';

export async function update(
  this: PipesPipeProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  const mask = maskerOrIdentity(context?.maskSecrets);
  assertRegionMatch(
    await this.getClient().config.region(),
    context?.expectedRegion,
    resourceType,
    logicalId,
    physicalId,
    'pre-update'
  );
  // Name and Source are create-only: the diff replaces the pipe before this
  // is called. Refuse rather than send an UpdatePipe that would act on the
  // old pipe while the record claims the new values. A secret-derived value
  // is recorded as its `{{resolve:...}}` reference and handed here resolved,
  // which is no change (go-to-k/cdkd#4275): the Name is checked against the
  // physical id, which is the pipe's name.
  for (const key of ['Name', 'Source'] as const) {
    const desiredValue = properties[key];
    const recordedValue = previousProperties[key];
    if (
      desiredValue !== undefined &&
      recordedValue !== undefined &&
      desiredValue !== recordedValue &&
      !(await unchangedBehindSecretReference({
        resourceType,
        key,
        desired: desiredValue,
        previous: recordedValue,
        ...(key === 'Name' ? { physicalName: physicalId } : {}),
        maskSecrets: context?.maskSecrets,
      }))
    ) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        `${key} is create-only; re-run with \`cdkd deploy --replace\` to recreate the pipe ` +
          `(--replace is a boolean flag and takes no resource id; it applies to every ` +
          `resource in the run whose in-place update is refused)`
      );
    }
  }
  const desired = withRemovalDefaults(
    this.removalDefaults,
    resourceType,
    properties,
    previousProperties,
    context
  );
  const desiredTags = desiredTagMap(desired['Tags'], logicalId, physicalId);
  this.logger.debug(mask(`Updating Pipe ${logicalId}: ${physicalId}`));

  let settled: DescribePipeCommandOutput | undefined;
  try {
    if (this.pipeFieldsChanged(desired, previousProperties)) {
      const input: UpdatePipeCommandInput = {
        Name: physicalId,
        RoleArn: desired['RoleArn'] as string,
        Target: desired['Target'] as string,
        ...(desired['Description'] !== undefined && {
          Description: desired['Description'] as string,
        }),
        ...(desired['DesiredState'] !== undefined && {
          DesiredState: desired['DesiredState'] as 'RUNNING' | 'STOPPED',
        }),
        ...(desired['Enrichment'] !== undefined && {
          Enrichment: desired['Enrichment'] as string,
        }),
        ...(desired['EnrichmentParameters'] !== undefined && {
          EnrichmentParameters: desired['EnrichmentParameters'] as PipeEnrichmentParameters,
        }),
        ...(desired['TargetParameters'] !== undefined && {
          TargetParameters: toSdkTargetParameters(desired['TargetParameters']),
        }),
        ...(desired['LogConfiguration'] !== undefined && {
          LogConfiguration: this.logConfigurationOf(desired['LogConfiguration']),
        }),
        ...(desired['KmsKeyIdentifier'] !== undefined && {
          KmsKeyIdentifier: desired['KmsKeyIdentifier'] as string,
        }),
      };
      const sourceParameters = toUpdateSourceParameters(
        desired['SourceParameters'],
        previousProperties['SourceParameters']
      );
      if (sourceParameters !== undefined) input.SourceParameters = sourceParameters;
      // Every key the call changes, before it: the settle wait that follows
      // can fail with the change accepted.
      for (const key of this.changedPipeFields(desired, previousProperties)) {
        context?.markUnsettled?.(key);
      }
      const accepted = await this.getClient().send(new UpdatePipeCommand(input));
      settled = await this.waitForSettled(
        physicalId,
        logicalId,
        resourceType,
        'update',
        mask,
        accepted.LastModifiedTime
      );
    }

    const recordedPlan = planTagDiff(
      tagMapAsList(previousProperties['Tags']),
      tagMapAsList(desiredTags)
    );
    // go-to-k/cdkd#5487: unsettled Tags re-send every template tag (AWS may
    // lack the ones a failed update did not reach) and remove only the
    // recorded ones the template dropped.
    const plan =
      context?.unsettledProperties?.has('Tags') === true
        ? { ...recordedPlan, set: planTagDiff([], tagMapAsList(desiredTags)).set }
        : recordedPlan;
    const warning = tagPlanWarning(plan, resourceType, logicalId);
    if (warning) this.logger.warn(warning);
    if (plan.set.size > 0 || plan.remove.length > 0) {
      context?.markUnsettled?.('Tags');
      settled ??= await this.describe(physicalId);
      const arn = settled.Arn;
      if (!arn) {
        throw new Error('DescribePipe returned no Arn, which tagging needs');
      }
      if (plan.remove.length > 0) {
        await this.getClient().send(
          new UntagResourceCommand({ resourceArn: arn, tagKeys: plan.remove })
        );
      }
      if (plan.set.size > 0) {
        await this.getClient().send(
          new TagResourceCommand({ resourceArn: arn, tags: Object.fromEntries(plan.set) })
        );
      }
    }
    settled ??= await this.describe(physicalId);
  } catch (error) {
    if (error instanceof ProvisioningError) throw error;
    if (error instanceof NotFoundException) {
      assertRegionMatch(
        await this.getClient().config.region(),
        context?.expectedRegion,
        resourceType,
        logicalId,
        physicalId
      );
    }
    const cause = error instanceof Error ? error : undefined;
    // AWS echoes resolved inputs into its text: masked like the settle
    // reason (`waitForSettled`).
    throw this.wrapCaughtError(
      mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update Pipe ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
  return { physicalId, wasReplaced: false, attributes: this.attributesOf(settled) };
}
