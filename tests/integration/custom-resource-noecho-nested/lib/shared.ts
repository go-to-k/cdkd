import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  // IdFromSeed (go-to-k/cdkd#3722): a resource whose physical id DOES move
  // with its Seed, so an Update answers with a new PhysicalResourceId and a
  // Ref reader has to follow it. Never set on a NoEcho resource.
  const response = {
    PhysicalResourceId:
      props.IdFromSeed === 'true'
        ? 'cr-noecho-nested-id-' + seed
        : 'cr-noecho-nested-' + event.LogicalResourceId,
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
  props: { prefix: string; seed: string; noEcho: boolean; idFromSeed?: boolean; nonce?: string }
): cdk.CustomResource {
  return new cdk.CustomResource(scope, id, {
    serviceToken: handler.functionArn,
    properties: {
      Prefix: props.prefix,
      Seed: props.seed,
      Sensitive: props.noEcho ? 'true' : 'false',
      ...(props.idFromSeed === true && { IdFromSeed: 'true' }),
      // The handler ignores it: flipping it re-runs the handler, which then
      // returns the SAME value (verify.sh phase 7, go-to-k/cdkd#3729).
      ...(props.nonce !== undefined && { Nonce: props.nonce }),
    },
  });
}

/**
 * The nonce the two NoEcho CRs with a create-only layer reader carry. Phase 7
 * (`CDKD_TEST_UPDATE=...,nonce`) flips it, so their handlers re-run and return
 * the same token.
 */
export function noEchoNonce(): string {
  const modes = (process.env['CDKD_TEST_UPDATE'] ?? '').split(',');
  return modes.includes('nonce') ? 'n1' : 'n0';
}

/**
 * A layer version whose `Description`, a CREATE-ONLY property, holds a NoEcho
 * value as a WHOLE leaf (go-to-k/cdkd#3729). The record stores `***`, so when
 * the CR re-runs cdkd cannot tell from state whether the value moved. It reads
 * the layer back from AWS, and replaces it only when AWS holds a different
 * description. A layer version is immutable on AWS, so the replacement shows
 * as a new version ARN.
 *
 * Not a NAME property on purpose: a NoEcho value used as a name becomes the
 * physical id, which is never masked, and the whole-blob greps would fail on
 * that documented bound rather than on this feature.
 */
export function noEchoLayer(
  scope: Construct,
  id: string,
  layerVersionName: string,
  description: string
): lambda.LayerVersion {
  const layer = new lambda.LayerVersion(scope, id, {
    layerVersionName,
    code: lambda.Code.fromAsset(path.join(__dirname, '..', 'layer')),
    description,
  });
  (layer.node.defaultChild as cdk.CfnResource).overrideLogicalId(id);
  return layer;
}
