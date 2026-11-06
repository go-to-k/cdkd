import type { StepFunctionsProvider } from '../stepfunctions-provider.js';
import {
  UpdateStateMachineCommand,
  DescribeStateMachineCommand,
  TagResourceCommand,
  UntagResourceCommand,
  type Tag,
} from '@aws-sdk/client-sfn';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { assertRegionMatch } from '../../region-check.js';
import { planTagDiff, tagPlanWarning, refuseMalformedDesiredTags } from '../../tag-list.js';
import type { ResourceUpdateResult, UpdateContext } from '../../../types/resource.js';
import {
  stateMachineRevisionId,
  mapEncryptionConfiguration,
  mapLoggingConfiguration,
  mapTracingConfiguration,
  disabledEncryptionConfigurationOnRemoval,
  disabledLoggingConfigurationOnRemoval,
  disabledTracingConfigurationOnRemoval,
} from './shared.js';

/**
 * Update a Step Functions state machine
 */
export async function update(
  this: StepFunctionsProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  this.logger.debug(`Updating Step Functions state machine ${logicalId}: ${physicalId}`);
  // go-to-k/cdkd#2613: a client in another region than the state record is not the one this
  // state machine was written through, so the update would not be addressed to the machine
  // the record names. Ahead of the definition build, whose `DefinitionS3Location` read goes
  // through the same region. Refuse before any call; the client's region is resolved only
  // when there is one to compare with.
  assertRegionMatch(
    context?.expectedRegion ? await this.getClient().config.region() : undefined,
    context?.expectedRegion,
    resourceType,
    logicalId,
    physicalId,
    'pre-update'
  );
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);

  try {
    const definitionString = await this.buildDefinitionString(properties);

    // Translate every CFn-PascalCase nested object to the SDK's
    // camelCase shape (see helpers below). All three mappers also fold
    // the Class 2 empty-placeholder case to `undefined` so `cdkd drift
    // --revert` round-trips through `update()` without AWS rejecting a
    // structurally incomplete payload (`encryptionConfiguration` requires
    // `type`; `loggingConfiguration` without `level` would silently
    // disable logging).
    //
    // BEFORE THIS FIX `properties['LoggingConfiguration']` (CFn PascalCase
    // from cdkd state) was cast straight to the SDK camelCase type — the
    // cast is a no-op at runtime, so AWS received the wrong shape and
    // silently ignored Level / IncludeExecutionData / Destinations, which
    // surfaced as `cdkd drift --revert` reporting `✓ reverted` while the
    // very next `cdkd drift` re-detected the same drift.
    //
    // REMOVAL-CLEAR (issue #978): `UpdateStateMachine` is patch-style — a
    // field omitted from the request keeps its current AWS value. So when a
    // config that WAS present in `previousProperties` is absent from the new
    // `properties`, mapping from `properties` alone yields `undefined`, the
    // field is omitted, and AWS silently keeps the old config (the removal is
    // never applied). For each of the three configs we detect the
    // prev-present / new-absent transition and send an explicit disable
    // sentinel instead of `undefined`, mirroring Lambda ESM's
    // `clearOnUpdateRemoval` / SQS's `SQS_ATTRIBUTE_REMOVAL_RESET`.
    const encryptionConfiguration =
      mapEncryptionConfiguration(properties['EncryptionConfiguration']) ??
      disabledEncryptionConfigurationOnRemoval(
        previousProperties['EncryptionConfiguration'],
        properties['EncryptionConfiguration']
      );
    const loggingConfiguration =
      mapLoggingConfiguration(properties['LoggingConfiguration']) ??
      disabledLoggingConfigurationOnRemoval(
        previousProperties['LoggingConfiguration'],
        properties['LoggingConfiguration']
      );
    const tracingConfiguration =
      mapTracingConfiguration(properties['TracingConfiguration']) ??
      disabledTracingConfigurationOnRemoval(
        previousProperties['TracingConfiguration'],
        properties['TracingConfiguration']
      );

    await this.getClient().send(
      new UpdateStateMachineCommand({
        stateMachineArn: physicalId,
        definition: definitionString,
        roleArn: properties['RoleArn'] as string | undefined,
        loggingConfiguration,
        tracingConfiguration,
        encryptionConfiguration,
      })
    );

    this.logger.debug(`Updated Step Functions state machine ${physicalId}`);

    // Apply tag diff. SFN uses lowercase camelCase shape:
    // TagResource({ resourceArn, tags: [{ key, value }] }),
    // UntagResource({ resourceArn, tagKeys: [...] }).
    await this.applyTagDiff(
      physicalId,
      resourceType,
      logicalId,
      previousProperties['Tags'],
      properties['Tags']
    );

    // Describe to get updated attributes
    const describeResponse = await this.getClient().send(
      new DescribeStateMachineCommand({ stateMachineArn: physicalId })
    );

    return {
      physicalId,
      wasReplaced: false,
      attributes: {
        Arn: physicalId,
        Name: describeResponse.name,
        StateMachineRevisionId: stateMachineRevisionId(describeResponse),
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update Step Functions state machine ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/**
 * Apply a diff between old and new CFn-shape Tags arrays via SFN's
 * `TagResource` / `UntagResource` APIs. SFN uses lowercase camelCase
 * (`{ key, value }`) for tags. Both sides are read through `planTagDiff`
 * (go-to-k/cdkd#3994): an unreadable record untags nothing.
 */
export async function applyTagDiff(
  this: StepFunctionsProvider,
  stateMachineArn: string,
  resourceType: string,
  logicalId: string,
  oldTagsRaw: unknown,
  newTagsRaw: unknown
): Promise<void> {
  const plan = planTagDiff(oldTagsRaw, newTagsRaw);
  const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
  if (tagWarning !== undefined) {
    this.logger.warn(tagWarning);
  }
  const tagsToAdd: Tag[] = [...plan.set].map(([k, v]) => ({ key: k, value: v }));
  const tagsToRemove = plan.remove;

  if (tagsToRemove.length > 0) {
    await this.getClient().send(
      new UntagResourceCommand({ resourceArn: stateMachineArn, tagKeys: tagsToRemove })
    );
    this.logger.debug(
      `Removed ${tagsToRemove.length} tag(s) from SFN state machine ${stateMachineArn}`
    );
  }
  if (tagsToAdd.length > 0) {
    await this.getClient().send(
      new TagResourceCommand({ resourceArn: stateMachineArn, tags: tagsToAdd })
    );
    this.logger.debug(
      `Added/updated ${tagsToAdd.length} tag(s) on SFN state machine ${stateMachineArn}`
    );
  }
}
