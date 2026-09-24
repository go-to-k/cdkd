import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

/**
 * Shared pieces of the custom-resource-noecho-nested fixture: ONE inline
 * handler per stack that serves two custom resources, a `NoEcho` one and an
 * ordinary one.
 *
 * The value each resource returns is ASSEMBLED by the handler
 * (`<Prefix>-<Seed>`), never a whole property leaf of its own. That matters:
 * `DeployEngine.registerNoEchoAttributes` EXCLUDES a resource's own whole
 * string leaves from the mask-only needles (so an echoed `ServiceToken` is not
 * masked out of the record), and a value equal to a template leaf would be
 * excluded and persist in the clear for a reason that has nothing to do with
 * the cross-stack recovery under test. It also keeps the full token out of
 * every template, so `verify.sh`'s whole-blob greps can only match a value the
 * HANDLER produced.
 *
 * The response is the SIMPLE-HANDLER shape (no `Status`), the one cdkd
 * re-synthesizes an envelope for, as in `custom-resource-getatt-data`. It is
 * returned directly, so no cfn-response object is written to the state bucket.
 * The handler logs nothing about `Data`, so the plaintext does not reach
 * CloudWatch through the fixture itself.
 */
export function crHandler(scope: Construct, id: string, functionName: string): lambda.Function {
  return new lambda.Function(scope, id, {
    functionName,
    runtime: lambda.Runtime.NODEJS_20_X,
    handler: 'index.handler',
    timeout: cdk.Duration.seconds(30),
    code: lambda.Code.fromInline(`
exports.handler = async (event) => {
  const props = event.ResourceProperties || {};
  console.log('CR request:', event.RequestType, event.LogicalResourceId);
  if (event.RequestType === 'Delete') {
    return { Status: 'SUCCESS', PhysicalResourceId: event.PhysicalResourceId || 'cr-noecho-nested' };
  }
  const seed = props.Seed || 'noseed';
  // The physical id must NOT embed the value: a mask-only needle takes a leaf
  // only WHOLE, so a physical id containing the token would persist it, and
  // it stays stable across the phase-2 Seed change so that is an in-place
  // UPDATE rather than a replacement.
  const response = {
    PhysicalResourceId: 'cr-noecho-nested-' + event.LogicalResourceId,
    Data: { Value: props.Prefix + '-' + seed },
  };
  if (props.Sensitive === 'true') response.NoEcho = true;
  return response;
};
`),
  });
}

/**
 * A custom resource backed by {@link crHandler}. `noEcho` decides whether the
 * handler declares its `Data` sensitive; `Data.Value` is what consumers read.
 */
export function valueResource(
  scope: Construct,
  id: string,
  handler: lambda.IFunction,
  props: { prefix: string; seed: string; noEcho: boolean }
): cdk.CustomResource {
  return new cdk.CustomResource(scope, id, {
    serviceToken: handler.functionArn,
    properties: {
      Prefix: props.prefix,
      Seed: props.seed,
      Sensitive: props.noEcho ? 'true' : 'false',
    },
  });
}
