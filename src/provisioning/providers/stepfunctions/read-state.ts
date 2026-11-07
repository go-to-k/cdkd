import type { StepFunctionsProvider } from '../stepfunctions-provider.js';
import {
  DescribeStateMachineCommand,
  ListTagsForResourceCommand,
  StateMachineDoesNotExist,
  type EncryptionConfiguration,
  type LoggingConfiguration,
  type TracingConfiguration,
} from '@aws-sdk/client-sfn';
import { definedAttributes } from '../../attribute-map.js';
import { normalizeAwsTagsToCfn } from '../../import-helpers.js';
import type {
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
} from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import { stateMachineRevisionId } from './shared.js';

/**
 * Read the AWS-current Step Functions state machine config in CFn-property
 * shape.
 *
 * Issues a single `DescribeStateMachine` and surfaces:
 *   - `StateMachineName` (`name`)
 *   - `RoleArn` (`roleArn`)
 *   - `StateMachineType` (`type`)
 *   - `LoggingConfiguration` / `TracingConfiguration` / `EncryptionConfiguration`
 *     (re-mapped to CFn PascalCase)
 *   - `Definition` (parsed from JSON; cdkd state may hold either the
 *     stringified `DefinitionString` or the object `Definition`, so we
 *     surface as the object form — the comparator handles either side).
 *
 * `DefinitionSubstitutions` is omitted because they are applied by cdkd on
 * create and update and not surfaced by `DescribeStateMachine` (the response
 * carries the already-substituted definition).
 *
 * `Tags` is surfaced via a follow-up `ListTagsForResource(arn)` call.
 * CDK's `aws:*` auto-tags are filtered out; the result key is omitted
 * entirely when AWS reports no user tags.
 *
 * Returns `RESOURCE_NOT_FOUND` when the state machine is gone (`StateMachineDoesNotExist`).
 */
export async function readCurrentState(
  this: StepFunctionsProvider,
  physicalId: string,
  _logicalId: string,
  _resourceType: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let resp: {
    name?: string;
    roleArn?: string;
    type?: string;
    definition?: string;
    loggingConfiguration?: LoggingConfiguration;
    tracingConfiguration?: TracingConfiguration;
    encryptionConfiguration?: EncryptionConfiguration;
  };
  try {
    resp = (await this.getClient().send(
      new DescribeStateMachineCommand({ stateMachineArn: physicalId })
    )) as unknown as typeof resp;
  } catch (err) {
    if (err instanceof StateMachineDoesNotExist) return RESOURCE_NOT_FOUND;
    throw err;
  }

  const result: Record<string, unknown> = {};
  if (resp.name !== undefined) result['StateMachineName'] = resp.name;
  if (resp.roleArn !== undefined) result['RoleArn'] = resp.roleArn;
  if (resp.type !== undefined) result['StateMachineType'] = resp.type;
  if (resp.definition !== undefined) {
    try {
      result['Definition'] = JSON.parse(resp.definition) as unknown;
    } catch {
      result['Definition'] = resp.definition;
    }
  }
  {
    const lc: Record<string, unknown> = {};
    if (resp.loggingConfiguration?.level !== undefined) {
      lc['Level'] = resp.loggingConfiguration.level;
    }
    if (resp.loggingConfiguration?.includeExecutionData !== undefined) {
      lc['IncludeExecutionData'] = resp.loggingConfiguration.includeExecutionData;
    }
    if (resp.loggingConfiguration?.destinations) {
      lc['Destinations'] = resp.loggingConfiguration.destinations.map((d) => {
        const inner: Record<string, unknown> = {};
        if (d.cloudWatchLogsLogGroup?.logGroupArn) {
          inner['CloudWatchLogsLogGroup'] = {
            LogGroupArn: d.cloudWatchLogsLogGroup.logGroupArn,
          };
        }
        return inner;
      });
    }
    result['LoggingConfiguration'] = lc;
  }
  result['TracingConfiguration'] = { Enabled: resp.tracingConfiguration?.enabled ?? false };
  {
    const ec: Record<string, unknown> = {};
    if (resp.encryptionConfiguration?.type !== undefined) {
      ec['Type'] = resp.encryptionConfiguration.type;
    }
    if (resp.encryptionConfiguration?.kmsKeyId !== undefined) {
      ec['KmsKeyId'] = resp.encryptionConfiguration.kmsKeyId;
    }
    if (resp.encryptionConfiguration?.kmsDataKeyReusePeriodSeconds !== undefined) {
      ec['KmsDataKeyReusePeriodSeconds'] =
        resp.encryptionConfiguration.kmsDataKeyReusePeriodSeconds;
    }
    result['EncryptionConfiguration'] = ec;
  }

  // Tags via ListTagsForResource (state machine ARN is the physicalId).
  try {
    const tagsResp = await this.getClient().send(
      new ListTagsForResourceCommand({ resourceArn: physicalId })
    );
    const tags = normalizeAwsTagsToCfn(tagsResp.tags);
    result['Tags'] = tags;
  } catch (err) {
    if (!(err instanceof StateMachineDoesNotExist)) throw err;
  }

  return result;
}

export async function importImpl(
  this: StepFunctionsProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  if (input.knownPhysicalId) {
    try {
      const resp = await this.getClient().send(
        new DescribeStateMachineCommand({ stateMachineArn: input.knownPhysicalId })
      );
      // go-to-k/cdkd#4705: a machine being deleted holds nothing to take
      // over (a create of its name waits the deletion out itself).
      if (resp.status === 'DELETING') return null;
      // Issue #3627: the map `create()` / `update()` record; the resolver
      // served the ARN for `Name` and `StateMachineRevisionId`.
      return {
        physicalId: input.knownPhysicalId,
        attributes: definedAttributes({
          Arn: input.knownPhysicalId,
          Name: resp.name,
          StateMachineRevisionId: stateMachineRevisionId(resp),
        }),
      };
    } catch (err) {
      if (err instanceof StateMachineDoesNotExist) return null;
      throw err;
    }
  }

  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
  // that tag never exists on a real resource and the walk could not match
  // (issue #1134). Auto-mode import resolves ids from CloudFormation's
  // DescribeStackResources or the template's physical-name property; a state
  // machine reaching here needs an explicit `--resource <id>=<arn>` override.
  return null;
}
