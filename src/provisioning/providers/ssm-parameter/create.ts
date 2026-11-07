import { PutParameterCommand, type ParameterType } from '@aws-sdk/client-ssm';
import { displaySafe } from '../../../utils/display-safe.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { generatedNameFor } from '../../resource-name.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import type { ResourceCreateResult, CreateContext } from '../../../types/resource.js';
import { SSMParameterProvider, ssmPoliciesParameter } from '../ssm-parameter-provider.js';

/**
 * Create an SSM parameter
 */
export async function create(
  this: SSMParameterProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  // Issue #2176: ONE masked sink per operation, rather than a `mask(...)` at
  // each interpolation. `properties['Name']` reaches several message sites
  // here, and a line added later is masked by construction instead of by
  // remembering.
  // Absent context means identity, which is the back-compatible default the
  // contract mandates -- `create()` is also reached from the import path,
  // from `cdkd drift --revert`, and from tests.
  const mask = maskerOrIdentity(context?.maskSecrets);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const ssmTags = SSMParameterProvider.desiredSsmTags(properties['Tags'], resourceType, logicalId);
  const debug = (message: string): void => this.logger.debug(mask(message));
  debug(`Creating SSM parameter ${displaySafe(logicalId)}`);

  const name =
    (properties['Name'] as string | undefined) ||
    generatedNameFor('AWS::SSM::Parameter', logicalId);
  const type = (properties['Type'] as string | undefined) || 'String';
  const value = properties['Value'] as string | undefined;

  if (!value) {
    throw new ProvisioningError(
      `Value is required for SSM parameter ${displaySafe(logicalId)}`,
      resourceType,
      logicalId
    );
  }

  try {
    const putParams: import('@aws-sdk/client-ssm').PutParameterCommandInput = {
      Name: name,
      Type: type as ParameterType,
      Value: value,
      Description: properties['Description'] as string | undefined,
      Overwrite: false,
    };
    if (properties['AllowedPattern']) {
      putParams.AllowedPattern = properties['AllowedPattern'] as string;
    }
    if (properties['Tier']) {
      putParams.Tier = properties['Tier'] as import('@aws-sdk/client-ssm').ParameterTier;
    }
    const policies = ssmPoliciesParameter(properties['Policies']);
    if (policies !== undefined) putParams.Policies = policies;
    if (properties['DataType']) {
      putParams.DataType = properties['DataType'] as string;
    }

    // go-to-k/cdkd#4971: the tags ride on `PutParameter` itself, as
    // CloudFormation sends them, so an SCP requiring `aws:RequestTag/...` on
    // `ssm:PutParameter` sees them. `AWS::SSM::Parameter.Tags` is a key->value
    // MAP (not the {Key,Value}[] list most CFn resources use); `ssmTags` was
    // normalized from either form, and checked, before any call. A tagged
    // `PutParameter` needs `ssm:AddTagsToResource` (measured), the permission
    // the follow-up `AddTagsToResource` already needed. AWS refuses `Tags`
    // with `Overwrite: true` ("tags and overwrite can't be used together",
    // measured); this create sends `Overwrite: false`, which it accepts, and
    // `update()` keeps tagging through `AddTagsToResource`.
    if (ssmTags.length > 0) putParams.Tags = ssmTags;

    await (await this.getCreateClient()).send(new PutParameterCommand(putParams));

    debug(
      `Successfully created SSM parameter ${displaySafe(logicalId)}: ${displaySafe(mask(name))}`
    );

    // Nothing after `PutParameter` can fail the create (issue #1824): a
    // failure building the ARN must not fail -- or clean up -- a parameter
    // that was created over a missing attribute. `buildParameterArn` never
    // throws (enforced in its own body, not assumed here).
    const arn = await this.buildParameterArn(name, mask);

    return {
      physicalId: name,
      attributes: {
        Type: type as ParameterType,
        Value: value,
        // Spread CONDITIONALLY rather than writing `undefined`: a
        // present-but-undefined key survives `structuredClone` into the state
        // record, so every `Object.keys` consumer sees a key carrying nothing.
        ...(arn !== undefined && { Arn: arn }),
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    // Issue #2176: `PutParameter` quotes the offending `Name` / `Value` back
    // on an `AllowedPattern` rejection, and this message reaches the durable
    // `deployments/*.jsonl`. An AWS-authored failure is therefore named by
    // its class only (go-to-k/cdkd#2319); its text reaches only the masked
    // `debug` line, where `maskSecretsInText`'s SUBSTRING arm and its
    // `MIN_NEEDLE_LENGTH` (4) floor apply -- a 1-3 character secret is NOT
    // covered there. A cdkd-authored message is masked RAW, before
    // interpolation, so the engine is not the only boundary. The `cause`
    // stays unmasked and the wrap is stamped (`wrapCaughtError`).
    throw this.wrapCaughtError(
      mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create SSM parameter ${displaySafe(logicalId)}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}
