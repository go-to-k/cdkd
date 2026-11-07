import {
  PutParameterCommand,
  AddTagsToResourceCommand,
  RemoveTagsFromResourceCommand,
  type ParameterType,
} from '@aws-sdk/client-ssm';
import { displaySafe } from '../../../utils/display-safe.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { planTagDiff, tagPlanWarning, tagMapAsList } from '../../tag-list.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import type { ResourceUpdateResult, UpdateContext } from '../../../types/resource.js';
import {
  SSMParameterProvider,
  SSM_CLEAR_POLICIES,
  ssmPoliciesParameter,
} from '../ssm-parameter-provider.js';

/**
 * Update an SSM parameter
 */
export async function update(
  this: SSMParameterProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  // Issue #2176 -- see `create()` for why this is one sink rather than a mask
  // per call site.
  const mask = maskerOrIdentity(context?.maskSecrets);
  const debug = (message: string): void => this.logger.debug(mask(message));
  debug(`Updating SSM parameter ${displaySafe(logicalId)}: ${displaySafe(mask(physicalId))}`);
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  SSMParameterProvider.desiredSsmTags(properties['Tags'], resourceType, logicalId, physicalId);

  const type = (properties['Type'] as string | undefined) || 'String';
  const value = properties['Value'] as string | undefined;

  if (!value) {
    throw new ProvisioningError(
      `Value is required for SSM parameter ${displaySafe(logicalId)}`,
      resourceType,
      logicalId,
      physicalId
    );
  }

  try {
    const putParams: import('@aws-sdk/client-ssm').PutParameterCommandInput = {
      Name: physicalId,
      Type: type as ParameterType,
      Value: value,
      Overwrite: true,
    };
    // `!== undefined` (not truthy) so empty Description / AllowedPattern
    // ('') from `readCurrentState`'s placeholders reaches `PutParameterCommand`
    // on the `cdkd drift --revert` round-trip. A truthy gate would silently
    // drop the empty string and leave the AWS-side value untouched — drift
    // would report `✓ reverted` but the next run re-detects the same drift.
    if (properties['Description'] !== undefined) {
      putParams.Description = properties['Description'] as string;
    }
    if (properties['AllowedPattern'] !== undefined) {
      putParams.AllowedPattern = properties['AllowedPattern'] as string;
    }
    if (properties['Tier'] !== undefined) {
      putParams.Tier = properties['Tier'] as import('@aws-sdk/client-ssm').ParameterTier;
    }
    const policies = ssmPoliciesParameter(properties['Policies']);
    if (policies !== undefined) {
      putParams.Policies = policies;
    } else if (
      context?.desiredFromAwsReadback === true &&
      !['[]', undefined].includes(ssmPoliciesParameter(previousProperties['Policies'])) &&
      context.declaredEmptyProperties?.has('Policies') === true
    ) {
      // go-to-k/cdkd#4884: PutParameter keeps a parameter's policies until it
      // is sent new ones or an empty one, so omitting `Policies` would leave
      // an out-of-band policy in place while `cdkd drift --revert` reports
      // success. The AWS-documented removal is the empty policy `[{}]`. A
      // deploy keeps omitting it: CloudFormation's update passes an absent
      // template `Policies` through as none, which keeps the policies.
      // Only when the TEMPLATE declares no policies too: `readCurrentState`
      // also writes the `[]` placeholder when DescribeParameters fails, so a
      // baseline captured that way must not delete a policy the template
      // declares.
      putParams.Policies = SSM_CLEAR_POLICIES;
    }
    if (properties['DataType'] !== undefined) {
      putParams.DataType = properties['DataType'] as string;
    }

    await this.ssmClient.send(new PutParameterCommand(putParams));

    // Update Tags if changed. AWS::SSM::Parameter.Tags is a key->value MAP;
    // both sides are normalized to the CFn list and diffed through
    // `planTagDiff` (go-to-k/cdkd#3994): only removed keys are untagged and
    // only new or changed tags are added, and a recorded Tags cdkd cannot
    // read untags nothing. `aws:` keys are reserved and never sent.
    const plan = planTagDiff(
      tagMapAsList(previousProperties['Tags']),
      tagMapAsList(properties['Tags'])
    );
    const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
    if (tagWarning !== undefined) {
      this.logger.warn(mask(tagWarning));
    }
    const tagsToRemove = plan.remove.filter((k) => !k.startsWith('aws:'));
    const tagsToAdd = SSMParameterProvider.userTags(
      [...plan.set].map(([Key, Value]) => ({ Key, Value }))
    );
    if (tagsToRemove.length > 0) {
      await this.ssmClient.send(
        new RemoveTagsFromResourceCommand({
          ResourceType: 'Parameter',
          ResourceId: physicalId,
          TagKeys: tagsToRemove,
        })
      );
    }
    if (tagsToAdd.length > 0) {
      await this.ssmClient.send(
        new AddTagsToResourceCommand({
          ResourceType: 'Parameter',
          ResourceId: physicalId,
          Tags: tagsToAdd,
        })
      );
    }
    if (tagsToRemove.length > 0 || tagsToAdd.length > 0) {
      debug(`Updated tags for SSM parameter ${displaySafe(mask(physicalId))}`);
    }

    debug(`Successfully updated SSM parameter ${displaySafe(logicalId)}`);

    // Re-report `Arn` here even though an in-place update cannot change it
    // (issue #1824): an update result's `attributes` REPLACE the state
    // record's rather than merging into it, so returning only Type / Value
    // would WIPE the ARN recorded at create time and re-break the `Fn::GetAtt`
    // the create-side fix repairs. Construction is what makes re-reporting it
    // cost no AWS call — see `buildParameterArn`'s source-decision note, which
    // also records why the DEGRADED case here still returns the partial map
    // (dropping `Arn`, a loud failure) rather than no attributes at all
    // (keeping a superseded `Value`, a silent wrong answer).
    const arn = await this.buildParameterArn(physicalId, mask);

    return {
      physicalId,
      wasReplaced: false,
      attributes: {
        Type: type as ParameterType,
        Value: value,
        ...(arn !== undefined && { Arn: arn }),
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    // Issue #2176 / go-to-k/cdkd#2319 -- class-only or masked, as in `create()`.
    throw this.wrapCaughtError(
      mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update SSM parameter ${displaySafe(logicalId)}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}
