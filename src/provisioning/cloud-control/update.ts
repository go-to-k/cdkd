import type { CloudControlProvider } from '../cloud-control-provider.js';
import { UpdateResourceCommand, type ProgressEvent } from '@aws-sdk/client-cloudcontrol';
import { isDeepStrictEqual } from 'node:util';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { canonicalizeRegion } from '../../utils/aws-partition.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { markNonRetryable, markRedactedCause } from '../../deployment/retryable-errors.js';
import { describeAwsFailure, verbosePointerTail } from '../../utils/aws-failure-text.js';
import { rebuildClientForBucketRegion } from '../../utils/bucket-region-client.js';
import { awsClientDefaults } from '../../utils/aws-client-defaults.js';
import { quietS3Logger } from '../../utils/sdk-call-log.js';
import { displaySafe } from '../../utils/display-safe.js';
import { withGuardDutyDetectorReadBackOps } from '../guardduty-detector-patch.js';
import {
  apiGatewayV2DefinitionObject,
  isApiGatewayV2Import,
  splitApiGatewayV2ImportPatch,
  type ApiGatewayV2Reimport,
} from '../apigwv2-body-import-patch.js';
import { unchangedBehindSecretReference } from '../secret-reference-immutable.js';
import { maskDeep, maskerOrIdentity } from '../masked-retry-logger.js';
import {
  getTopLevelKeysHoldingUnreadableCreateOnly,
  getTopLevelWriteOnlyProperties,
} from '../write-only-properties.js';
import { getTopLevelDeployAttributeNames } from '../read-only-properties.js';
import { getCreateOnlyPropertyPaths } from '../create-only-properties.js';
import {
  nestedCreateOnlyGaps,
  withCarriedCreateOnlyMembers,
  writesTopLevelObject,
} from '../cc-nested-create-only-patch.js';
import type { ResourceUpdateResult, UpdateContext } from '../../types/resource.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { s3ClientDefaults } from '../../utils/s3-client-defaults.js';
import { stringifyJsonProperties, stripNullValues, s3RedirectRegion } from './shared.js';
import { IdScrubLog, inIdLogScope, holdsSecretDerivedLeaf } from './id-log.js';

/**
 * Update a resource using Cloud Control API
 */
export async function update(
  this: CloudControlProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  // Every line this update prints that can name the identifier, and the
  // error leaving it, go through `idLog` (go-to-k/cdkd#3869): the opening
  // line here, and the read-back / enrichment lines below, which
  // interpolate the id and values built from it (an ARN).
  const mask = maskerOrIdentity(context?.maskSecrets);
  const idLog = new IdScrubLog(
    this.logger,
    mask,
    holdsSecretDerivedLeaf(properties, mask) || holdsSecretDerivedLeaf(previousProperties, mask)
  );
  idLog.addId(physicalId);
  return inIdLogScope(idLog, () =>
    this.updateInIdLogScope(
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context,
      idLog
    )
  );
}

export async function updateInIdLogScope(
  this: CloudControlProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined,
  idLog: IdScrubLog
): Promise<ResourceUpdateResult> {
  idLog.debug(`Updating resource ${logicalId} (${resourceType}), physical ID: ${physicalId}`);

  // Issue #2301 item 1. Ahead of EVERY call this method makes -- including
  // the `DescribeType` behind `getTopLevelWriteOnlyProperties` -- because a
  // refusal here should cost nothing and reach AWS with nothing.
  //
  // `context` is new on this method: `ResourceProvider.update` has taken an
  // `UpdateContext` since issue #1732, but this provider never declared the
  // parameter and the interface carried no region field until now. The
  // consequence of the gap is a misapplied configuration rather than the
  // delete path's unrecoverable destruction, which is why issue #2283 took
  // delete first -- not because this path was safe.
  await this.assertRecordedRegionAgainstClient(
    'pre-update',
    context?.expectedRegion,
    resourceType,
    logicalId,
    physicalId
  );

  try {
    // Strip null/undefined values and stringify JSON properties before generating patch
    // `stripNullValues` builds a fresh object, so the #4275 loop below may
    // rewrite keys of it without touching the caller's bag.
    const cleanPreviousProperties = stringifyJsonProperties(
      resourceType,
      stripNullValues(previousProperties) as Record<string, unknown>
    );
    const cleanProperties = stringifyJsonProperties(
      resourceType,
      stripNullValues(properties) as Record<string, unknown>
    );

    // go-to-k/cdkd#4275: state keeps a secret-derived leaf as its
    // `{{resolve:...}}` expression while `properties` holds the resolved
    // value, so an unchanged reference differs on every update. On a key
    // the engine replaces on any change (a create-only path), the engine
    // already decided this is no change, and an op there asks Cloud Control
    // to update what it cannot (after a rotation, to a value the resource
    // does not have): take the desired value as the previous one.
    for (const key of Object.keys(cleanPreviousProperties)) {
      if (!Object.prototype.hasOwnProperty.call(cleanProperties, key)) continue;
      const previous = cleanPreviousProperties[key];
      const desired = cleanProperties[key];
      if (previous === desired) continue;
      if (
        await unchangedBehindSecretReference({
          resourceType,
          key,
          desired,
          previous,
          maskSecrets: context?.maskSecrets,
        })
      ) {
        cleanPreviousProperties[key] = desired;
      }
    }

    // Generate JSON Patch document
    let patch = this.patchGenerator.generatePatch(cleanPreviousProperties, cleanProperties);

    if (patch.length === 0) {
      // No changes detected
      this.logger.debug(`No property changes detected for ${logicalId}, skipping update`);
      return {
        physicalId,
        wasReplaced: false,
        sentNothing: true,
      };
    }

    // Issue #809: Cloud Control applies the patch read-modify-write, and
    // the type's read handler cannot return write-only properties — so any
    // write-only property absent from the patch document silently vanishes
    // from the desired state on every UPDATE (e.g. AWS::ECS::Service loses
    // VolumeConfigurations and the update hard-fails). Mirror
    // terraform-provider-awscc: strip every write-only property from the
    // PREVIOUS side so the patch generator naturally emits `add` ops for
    // all write-only properties present in the desired properties. Only
    // write-only properties are force-included — blanket-upserting ALL
    // desired properties would risk false replacement signals on
    // createOnlyProperties whose read-back form differs from the stored
    // form. The DescribeType lookup is cached per type and degrades to the
    // minimal patch (with a warning) when the API is unavailable.
    //
    // go-to-k/cdkd#4416: a write-only key whose value holds a create-only
    // path overlapping a write-only one (Cognito ManagedLoginBranding
    // `ClientId`, a Kinesis-source Pipe's `SourceParameters`, CodePipeline
    // CustomActionType `Settings`) is NOT re-added while UNCHANGED: Cloud
    // Control refuses any patch bringing such a value into the model it
    // read, unchanged or not. A CHANGED one is still re-added -- Cloud
    // Control refuses that too (no patch can express it), and the `add`
    // gets its refusal naming the create-only path (go-to-k/cdkd#4423).
    // See `create()`: started alongside the update, awaited at its end.
    const attributeNamesLookup = getTopLevelDeployAttributeNames(resourceType);
    const writeOnlyProperties = await getTopLevelWriteOnlyProperties(resourceType);
    if (writeOnlyProperties.size > 0) {
      const keptOnPreviousSide = getTopLevelKeysHoldingUnreadableCreateOnly(
        resourceType,
        cleanProperties
      );
      const previousWithoutWriteOnly = { ...cleanPreviousProperties };
      for (const propertyName of writeOnlyProperties) {
        if (
          keptOnPreviousSide.has(propertyName) &&
          isDeepStrictEqual(cleanPreviousProperties[propertyName], cleanProperties[propertyName])
        ) {
          continue;
        }
        delete previousWithoutWriteOnly[propertyName];
      }
      patch = this.patchGenerator.generatePatch(previousWithoutWriteOnly, cleanProperties);
      if (patch.length === 0) {
        // The only "changes" were write-only properties REMOVED from the
        // desired properties — Cloud Control cannot remove what its read
        // handler never returns, so there is nothing to send.
        this.logger.debug(
          `Only removed write-only properties detected for ${logicalId}, skipping update`
        );
        return {
          physicalId,
          wasReplaced: false,
          sentNothing: true,
        };
      }
    }

    // go-to-k/cdkd#4910: a GuardDuty detector's read model carries keys
    // UpdateDetector refuses beside the declared ones; see the helper.
    patch = withGuardDutyDetectorReadBackOps(
      resourceType,
      patch,
      cleanProperties,
      context?.desiredFromAwsReadback === true ? { previous: cleanPreviousProperties } : undefined
    );

    // go-to-k/cdkd#6294: a whole-object op drops the AWS-defaulted nested
    // create-only members Cloud Control reads; see the helper. The schema
    // lookup is cached (the diff already ran it) and runs only when an op
    // writes an object; the read only when a gap exists.
    if (writesTopLevelObject(patch)) {
      const gaps = nestedCreateOnlyGaps(patch, await getCreateOnlyPropertyPaths(resourceType));
      if (gaps.length > 0) {
        const liveModel = await this.readCcResourceModel(resourceType, physicalId, idLog);
        if (liveModel !== undefined) {
          patch = withCarriedCreateOnlyMembers(patch, gaps, liveModel);
        }
      }
    }

    // go-to-k/cdkd#5260: no Cloud Control patch can change an imported
    // HTTP API's definition; it goes through `ReimportApi`, and Cloud
    // Control gets the rest. See the helper.
    let reimported = false;
    if (isApiGatewayV2Import(resourceType, cleanProperties)) {
      const split = splitApiGatewayV2ImportPatch(patch, cleanPreviousProperties, cleanProperties);
      patch = split.rest;
      if (split.reimport !== undefined) {
        await this.reimportApiGatewayV2(logicalId, physicalId, resourceType, split.reimport);
        reimported = true;
      } else if (patch.length === 0) {
        // Only the write-only re-add touched the import keys: nothing changed.
        this.logger.debug(`No property changes detected for ${logicalId}, skipping update`);
        return { physicalId, wasReplaced: false, sentNothing: true };
      }
    }

    // Log the patch OPERATIONS + PATHS only, never the values (GHSA fix): a
    // patch value can be a resolved secret (a Cloud-Control-routed
    // `{{resolve:secretsmanager:...}}` property, e.g. Cognito
    // `ProviderDetails.client_secret`), and paths are enough to debug patch
    // generation. A path names property KEYS, never a value, but it still goes
    // through the caller's masker BEFORE the stringify, so the line stays
    // masked if it ever renders more (#5894). The full document still goes to
    // AWS below.
    this.logger.debug(
      `Generated ${patch.length} patch operations for ${logicalId}: ${JSON.stringify(
        maskDeep(
          patch.map((op) => {
            const anyOp = op as { op?: unknown; path?: unknown };
            return { op: anyOp.op, path: anyOp.path };
          }),
          maskerOrIdentity(context?.maskSecrets)
        )
      )}`
    );

    // A reimport that left Cloud Control nothing to apply skips it; the
    // attribute read-back below still runs.
    let progressEvent: ProgressEvent | undefined;
    if (!(reimported && patch.length === 0)) {
      // Start resource update
      const updateResponse = await this.cloudControlClient.send(
        new UpdateResourceCommand({
          TypeName: resourceType,
          Identifier: physicalId,
          PatchDocument: JSON.stringify(patch),
        })
      );

      if (!updateResponse.ProgressEvent?.RequestToken) {
        throw new ProvisioningError(
          `Failed to update resource ${logicalId}: No request token received`,
          resourceType,
          logicalId,
          physicalId
        );
      }

      this.logger.debug(
        `Update request submitted for ${logicalId}, token: ${updateResponse.ProgressEvent.RequestToken}`
      );

      // Wait for update to complete
      progressEvent = await this.waitForOperation(
        updateResponse.ProgressEvent.RequestToken,
        logicalId,
        'UPDATE',
        resourceType
      );
    }

    this.logger.debug(`Updated resource ${logicalId}`);

    // Parse resource properties to extract attributes
    // Resource replacement for immutable property changes is detected and handled
    // by DeployEngine (immutable property detection + CREATE→DELETE flow) before
    // reaching this update method, so wasReplaced is always false here.
    const result: ResourceUpdateResult = {
      physicalId,
      wasReplaced: false,
    };

    if (progressEvent?.ResourceModel) {
      result.attributes = this.parseResourceModel(progressEvent.ResourceModel, idLog);
    }

    // Generic sparse-model read-back (issue #1105). Also covers UPDATE
    // staleness: a ProgressEvent that omits attributes present at CREATE
    // would otherwise leave stale values in state — the read-back refreshes
    // them from the AWS-current model.
    result.attributes = await this.mergeSparseModelReadback(
      resourceType,
      physicalId,
      result.attributes || {},
      idLog
    );

    // See `create()`: only the MODEL keys are narrowed (issue #2925).
    const modelKeys = Object.keys(result.attributes);

    // Enrich attributes with computed values for specific resource types
    result.attributes = await this.enrichResourceAttributes(
      resourceType,
      physicalId,
      result.attributes,
      idLog
    );

    result.attributes = await this.maskDeployedNonAttributeKeys(
      result.attributes,
      modelKeys,
      resourceType,
      physicalId,
      attributeNamesLookup,
      properties,
      maskerOrIdentity(context?.maskSecrets),
      idLog
    );

    return result;
  } catch (error) {
    this.handleError(error, 'UPDATE', resourceType, logicalId, physicalId);
  }
}

/**
 * Send an imported `AWS::ApiGatewayV2::Api`'s definition change through
 * `ReimportApi` (go-to-k/cdkd#5260; see `splitApiGatewayV2ImportPatch` for
 * why Cloud Control cannot). The client targets the Cloud Control client's
 * region, refused when that region cannot be resolved, as the SDK delete
 * delegates are.
 *
 * A `BodyS3Location` definition is read from S3 first, since `ReimportApi`
 * takes the definition's text only (go-to-k/cdkd#5264; see
 * {@link readApiGatewayV2DefinitionObject}).
 */
export async function reimportApiGatewayV2(
  this: CloudControlProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  reimport: ApiGatewayV2Reimport
): Promise<void> {
  // Which definition API Gateway would take is not established, so a
  // template naming both is refused rather than one silently ignored.
  if (reimport.fromS3 && reimport.body !== undefined) {
    throw markNonRetryable(
      new ProvisioningError(
        `Cannot update ${logicalId} (${resourceType}): it declares both Body and ` +
          `BodyS3Location. Declare the OpenAPI definition in one of them.`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  }
  let region: string | undefined;
  try {
    region = canonicalizeRegion((await this.cloudControlClient.config.region())?.trim());
  } catch {
    region = undefined;
  }
  if (region === undefined || region === '') {
    throw markNonRetryable(
      new ProvisioningError(
        `Refusing to update ${logicalId} (${resourceType}, ${physicalId}): cdkd could not ` +
          `resolve the Cloud Control client's region, so it cannot show ReimportApi would ` +
          `reach this API. Re-run with --region set to the stack's region.`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  }
  // After the region refusal, so an unresolvable region never costs an S3 read.
  const body = reimport.fromS3
    ? await this.readApiGatewayV2DefinitionObject(
        logicalId,
        physicalId,
        resourceType,
        reimport.bodyS3Location
      )
    : reimport.body;
  const { ApiGatewayV2Client, ReimportApiCommand } = await import('@aws-sdk/client-apigatewayv2');
  const client = new ApiGatewayV2Client({ ...ambientClientDefaults(), region });
  try {
    await client.send(
      new ReimportApiCommand({
        ApiId: physicalId,
        Body: body,
        ...(reimport.basePath !== undefined ? { Basepath: reimport.basePath } : {}),
        ...(reimport.failOnWarnings !== undefined
          ? { FailOnWarnings: reimport.failOnWarnings }
          : {}),
      })
    );
  } finally {
    client.destroy();
  }
  this.logger.debug(`Reimported the OpenAPI definition of ${logicalId}`);
}

/**
 * The text of the OpenAPI definition a `BodyS3Location` names
 * (go-to-k/cdkd#5264), read with the deploy identity (the one that drives
 * the Cloud Control operations of this update). The read targets the
 * bucket's own region (`rebuildClientForBucketRegion`). That probe can
 * miss (a bucket in another account, or no `s3:GetBucketLocation`) and
 * fall back to the client's region, so a 301 `PermanentRedirect` is
 * followed ONCE to the region S3 names; a second failure is refused. A
 * pinned `Version` is read as that version. `Etag` is only recorded: the
 * CloudFormation reference calls it "the Etag of the S3 object" and states
 * no check, so cdkd sends no `IfMatch`; a changed `Etag` still triggers the
 * reimport, as any changed property does.
 *
 * No `ExpectedBucketOwner`, deliberately: a template-named definition
 * bucket may be another account's, as CloudFormation allows (cdkd-assets
 * mode, which writes, refuses a foreign owner).
 *
 * A refused read names the AWS failure by its class, never AWS's text,
 * which on an `AccessDenied` quotes the caller (go-to-k/cdkd#2319); the
 * SDK error stays as the `cause`. An `AccessDenied` names the grant the
 * deploy identity needs.
 */
export async function readApiGatewayV2DefinitionObject(
  this: CloudControlProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  location: unknown
): Promise<string> {
  const object = apiGatewayV2DefinitionObject(location);
  if (object === undefined) {
    throw markNonRetryable(
      new ProvisioningError(
        `Cannot update ${logicalId} (${resourceType}): its BodyS3Location is not an object ` +
          `with string Bucket and Key (and optional string Version / Etag), so cdkd cannot ` +
          `read the OpenAPI definition to reimport.`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  }
  const shown = `s3://${displaySafe(object.bucket)}/${displaySafe(object.key)}`;
  const shared = getAwsClients().s3;
  const owned: S3Client[] = [];
  const read = async (s3: S3Client): Promise<string> => {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: object.bucket,
        Key: object.key,
        ...(object.version !== undefined ? { VersionId: object.version } : {}),
      })
    );
    const text = await response.Body?.transformToString();
    if (text === undefined) {
      throw markNonRetryable(
        new ProvisioningError(
          `Cannot update ${logicalId} (${resourceType}): S3 returned no body for its ` +
            `OpenAPI definition ${shown}.`,
          resourceType,
          logicalId,
          physicalId
        )
      );
    }
    return text;
  };
  let redirected = false;
  try {
    // Inside the `try`, so a rejection of the client's own region lookup
    // is wrapped and labelled like any other failed read.
    const rebuilt = await rebuildClientForBucketRegion(shared, object.bucket, {
      reuseClientCredentials: true,
      tolerateNonStandardClient: true,
    });
    if (rebuilt) owned.push(rebuilt);
    const first = rebuilt ?? shared;
    try {
      return await read(first);
    } catch (error) {
      const redirectRegion = s3RedirectRegion(error);
      if (redirectRegion === undefined) throw error;
      redirected = true;
      const regional = new S3Client({
        ...awsClientDefaults(),
        ...s3ClientDefaults(),
        region: redirectRegion,
        // The same credential provider as the client that was redirected.
        credentials: first.config?.credentials,
        logger: quietS3Logger(),
      });
      owned.push(regional);
      return await read(regional);
    }
  } catch (error) {
    if (error instanceof ProvisioningError) throw error;
    // AWS's own text, for `--verbose` only: it can quote the caller.
    this.logger.debug(
      `Reading the OpenAPI definition ${shown} of ${logicalId} failed: ` +
        displaySafe(describeAwsFailure(error).detail)
    );
    const name = (error as { name?: unknown } | null | undefined)?.name;
    const errorClass = typeof name === 'string' && name !== '' ? displaySafe(name) : 'Error';
    const status = (error as { $metadata?: { httpStatusCode?: unknown } } | null | undefined)
      ?.$metadata?.httpStatusCode;
    // Settled answers (the grant, the object, the region) are not retried;
    // a throttle, 5xx or dropped connection is, as any other update failure
    // is. The message withholds AWS's text, so the retry classifiers read
    // the cause chain (`markRedactedCause`).
    let next: string | undefined;
    if (errorClass === 'AccessDenied' || status === 403) {
      next =
        ` The deploy identity needs s3:GetObject on it` +
        (object.version !== undefined ? ' (and s3:GetObjectVersion for the pinned Version)' : '') +
        ', and kms:Decrypt on its key if the object is SSE-KMS encrypted.';
    } else if (
      errorClass === 'NoSuchKey' ||
      errorClass === 'NoSuchBucket' ||
      errorClass === 'NoSuchVersion'
    ) {
      next = ' Upload the definition there, or point BodyS3Location at the right object.';
    } else if (errorClass === 'PermanentRedirect' || status === 301) {
      // A 301 that named no region, or a second one after the redirect was
      // followed. Any other failure of the followed read (a throttle, a 5xx)
      // takes the ordinary retry below.
      next =
        (redirected ? ` S3 redirected the read twice.` : ` S3 named no region to redirect to.`) +
        ` cdkd could not reach the bucket's region: grant the deploy identity ` +
        `s3:GetBucketLocation on the bucket, or keep the definition in a bucket of this region.`;
    }
    const wrapped = new ProvisioningError(
      `Cannot update ${logicalId} (${resourceType}): reading its OpenAPI definition ` +
        `${shown} failed with ${errorClass}.${next ?? ''}${verbosePointerTail()}`,
      resourceType,
      logicalId,
      physicalId,
      error instanceof Error ? error : undefined
    );
    throw next !== undefined ? markNonRetryable(wrapped) : markRedactedCause(wrapped);
  } finally {
    for (const client of owned) client.destroy();
  }
}
