import type { LambdaFunctionProvider } from '../lambda-function-provider.js';
import { GetFunctionCommand, ResourceNotFoundException } from '@aws-sdk/client-lambda';
import { resolveExplicitPhysicalId } from '../../import-helpers.js';
import type {
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
  ResourceIdentityVerdict,
} from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import { isFunctionName, functionIdentityToken } from './shared.js';
import { functionAttributes } from './attributes.js';

/**
 * go-to-k/cdkd#4606: whether the function a failed CREATE journaled is the
 * one the record under the same logical id holds (a fix-forward that created
 * a new function there under another name).
 *
 * Both ids must be function NAMES (the physical id this provider records);
 * an ARN or anything else is `'unknown'`, and so are two names differing
 * only in case, which this check does not rely on Lambda to tell apart.
 * Equal names are `'same'` without a read: whatever function holds the name
 * now is the record's, and deleting by that name would delete it. A function
 * name is unique per account and region and a function cannot be renamed.
 * After the region check the record's function must read back (else
 * `'unknown'`); the journaled one is `'same'` when it reads back under the
 * record's `FunctionArn`, `'different'` under another, and `'different'`
 * when AWS reports it gone: the record's function answers to its own,
 * other, name. Any other read failure throws, which the caller reads as
 * `'unknown'`.
 */
export async function isSameResource(
  this: LambdaFunctionProvider,
  journaledPhysicalId: string,
  record: { physicalId: string },
  resourceType: string,
  context: { expectedRegion: string }
): Promise<ResourceIdentityVerdict> {
  if (resourceType !== 'AWS::Lambda::Function') return 'unknown';
  if (!isFunctionName(journaledPhysicalId) || !isFunctionName(record.physicalId)) {
    return 'unknown';
  }
  if (journaledPhysicalId === record.physicalId) return 'same';
  if (journaledPhysicalId.toLowerCase() === record.physicalId.toLowerCase()) return 'unknown';
  const clientRegion = await this.lambdaClient.config.region();
  if (clientRegion !== context.expectedRegion) return 'unknown';
  const recordFn = await this.readFunctionIfExists(record.physicalId);
  if (recordFn === undefined) return 'unknown';
  const journaledFn = await this.readFunctionIfExists(journaledPhysicalId);
  if (journaledFn === undefined) return 'different';
  // Unreachable as 'same' while the names differ beyond case (each ARN
  // carries its own name); kept so the verdict rests on AWS's answer.
  return journaledFn.arn === recordFn.arn ? 'same' : 'different';
}

/**
 * go-to-k/cdkd#4655 / #4606: the function's `<FunctionArn>@<LastModified
 * epoch ms>` ({@link functionIdentityToken}). A function re-created under
 * the name answers with another `LastModified`, so the settle keeps it
 * rather than deleting it as the failed CREATE's orphan. A failed CREATE's
 * own token comes from its CreateFunction response, on the failure's mark
 * (`markCreatedBeforeFailure`); this is the live read.
 *
 * `undefined` for another type, an id that is not a function name, a client
 * in another region than `expectedRegion`, or a response without both
 * fields. `RESOURCE_NOT_FOUND` only on `ResourceNotFoundException`; any
 * other failure, and a response naming another function, throws.
 */
export async function resourceIdentity(
  this: LambdaFunctionProvider,
  physicalId: string,
  resourceType: string,
  context: { expectedRegion: string }
): Promise<string | ResourceNotFound | undefined> {
  if (resourceType !== 'AWS::Lambda::Function' || !isFunctionName(physicalId)) {
    return undefined;
  }
  const clientRegion = await this.lambdaClient.config.region();
  if (clientRegion !== context.expectedRegion) return undefined;
  const live = await this.readFunctionIfExists(physicalId);
  if (live === undefined) return RESOURCE_NOT_FOUND;
  return functionIdentityToken(live.arn, live.lastModified);
}

/**
 * The function's ARN and `LastModified` in the shared client's region, or
 * `undefined` when `GetFunction` answers `ResourceNotFoundException`. Any
 * other failure, a response naming another function, and one naming no
 * `FunctionArn` throw: "could not read" never reads as "gone".
 */
export async function readFunctionIfExists(
  this: LambdaFunctionProvider,
  functionName: string
): Promise<{ arn: string; lastModified: string | undefined } | undefined> {
  let response;
  try {
    response = await this.lambdaClient.send(new GetFunctionCommand({ FunctionName: functionName }));
  } catch (error) {
    if (error instanceof ResourceNotFoundException) return undefined;
    throw error;
  }
  if (response.Configuration?.FunctionName !== functionName) {
    throw new Error('GetFunction answered for another function than the one asked for');
  }
  const arn = response.Configuration.FunctionArn;
  if (typeof arn !== 'string' || arn === '') {
    throw new Error('GetFunction returned no FunctionArn');
  }
  return { arn, lastModified: response.Configuration.LastModified };
}

/**
 * Resolve a single `Fn::GetAtt` attribute for an existing Lambda function.
 *
 * CloudFormation's `AWS::Lambda::Function` exposes `Arn`,
 * `SnapStartResponse.ApplyOn`, and `SnapStartResponse.OptimizationStatus`
 * as documented at
 * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-lambda-function.html#aws-resource-lambda-function-return-values.
 *
 * All three live in the same `GetFunction` response (`Configuration.FunctionArn`
 * and `Configuration.SnapStart.{ApplyOn,OptimizationStatus}`), so a single API
 * call covers every supported attr. Used by `cdkd orphan` to live-fetch
 * attribute values that need to be substituted into sibling references.
 */
export async function getAttribute(
  this: LambdaFunctionProvider,
  physicalId: string,
  _resourceType: string,
  attributeName: string
): Promise<unknown> {
  if (
    attributeName !== 'Arn' &&
    attributeName !== 'SnapStartResponse.ApplyOn' &&
    attributeName !== 'SnapStartResponse.OptimizationStatus'
  ) {
    return undefined;
  }
  try {
    const resp = await this.lambdaClient.send(new GetFunctionCommand({ FunctionName: physicalId }));
    switch (attributeName) {
      case 'Arn':
        return resp.Configuration?.FunctionArn;
      case 'SnapStartResponse.ApplyOn':
        return resp.Configuration?.SnapStart?.ApplyOn;
      case 'SnapStartResponse.OptimizationStatus':
        return resp.Configuration?.SnapStart?.OptimizationStatus;
      default:
        return undefined;
    }
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return undefined;
    throw err;
  }
}

/**
 * Adopt an existing Lambda function into cdkd state.
 *
 * Lookup order:
 *  1. `--resource` override or `Properties.FunctionName` → use directly,
 *     verify via `GetFunction`.
 */
export async function importImpl(
  this: LambdaFunctionProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const explicit = resolveExplicitPhysicalId(input, 'FunctionName');
  if (explicit) {
    try {
      const resp = await this.lambdaClient.send(new GetFunctionCommand({ FunctionName: explicit }));
      // The same attribute set create / update record (go-to-k/cdkd#6242).
      return { physicalId: explicit, attributes: functionAttributes(resp.Configuration) };
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return null;
      throw err;
    }
  }

  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
  // that tag never exists on a real resource and the walk could not match
  // (issue #1134). Auto-mode import resolves ids from CloudFormation's
  // DescribeStackResources or the template's physical-name property; a
  // function reaching here needs an explicit `--resource` override.
  return null;
}
