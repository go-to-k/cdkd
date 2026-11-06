import {
  GlueClient,
  GetTagsCommand,
  CreateWorkflowCommand,
  UpdateWorkflowCommand,
  DeleteWorkflowCommand,
  GetWorkflowCommand,
  EntityNotFoundException,
} from '@aws-sdk/client-glue';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import type { MaskerFn } from '../../masked-retry-logger.js';
import { normalizeAwsTagsToCfn } from '../../import-helpers.js';
import {
  type CreateContext,
  type ResourceCreateResult,
  type ResourceUpdateResult,
  type ResourceImportInput,
  type ResourceImportResult,
  type UpdateContext,
  type ResourceNotFound,
  RESOURCE_NOT_FOUND,
} from '../../../types/resource.js';
import { ambientClientDefaults } from '../../../utils/ambient-client-defaults.js';
import { markNotGone } from '../../not-gone.js';
import { derivePartitionAndUrlSuffix } from '../../../utils/aws-partition.js';
import type { GlueWorkflowProvider } from '../glue-provider.js';
import {
  wrapGlueError,
  newGlueClients,
  glueOperationSinks,
  secretNamePairs,
  previousNamePairs,
} from './names.js';
import { desiredGlueTags, coerceNumber, applyGlueTagDiff } from './shared.js';

/** {@link GlueProvider}'s `wrapMaskedError` (issue #4244). */
export function workflowWrapMaskedError(
  this: GlueWorkflowProvider,
  mask: MaskerFn,
  error: unknown,
  build: (maskedText: string) => ProvisioningError
): ProvisioningError {
  return wrapGlueError(mask, (message) => this.logger.debug(message), error, build);
}

export function workflowGetClient(this: GlueWorkflowProvider): GlueClient {
  if (!this.client) {
    ({ client: this.client, createClient: this.createClient } = newGlueClients(
      this.providerRegion
    ));
  }
  return this.client;
}

/** The main create's client (issue #4639); see {@link newGlueClients}. */
export function workflowGetCreateClient(this: GlueWorkflowProvider): GlueClient {
  this.getClient();
  return this.createClient as GlueClient;
}

export async function workflowCreate(
  this: GlueWorkflowProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  // Issue #2177: ONE masked sink per operation, every bag value masked RAW.
  const log = glueOperationSinks(
    this.logger,
    context?.maskSecrets,
    secretNamePairs([properties['Name']])
  );
  const { value: v } = log;
  log.debug(`Creating Glue Workflow ${logicalId}`);

  const name = properties['Name'] as string | undefined;
  if (!name) {
    throw new ProvisioningError(
      `Name is required for Glue Workflow ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  // Glue Workflow Tags may arrive as a CFn tag map OR a `{Key,Value}[]` list;
  // a malformed one is refused before any call (go-to-k/cdkd#4073). The key
  // is elided when there are no tags.
  const tags = desiredGlueTags(properties['Tags'], resourceType, logicalId);

  try {
    await this.getCreateClient().send(
      new CreateWorkflowCommand({
        Name: name,
        ...(properties['Description'] !== undefined && {
          Description: properties['Description'] as string,
        }),
        ...(properties['DefaultRunProperties'] !== undefined && {
          DefaultRunProperties: properties['DefaultRunProperties'] as Record<string, string>,
        }),
        ...(properties['MaxConcurrentRuns'] !== undefined && {
          MaxConcurrentRuns: coerceNumber(properties['MaxConcurrentRuns']) as number,
        }),
        ...(tags && { Tags: tags }),
      })
    );

    log.debug(`Successfully created Glue Workflow ${logicalId}: ${v(name)}`);
    return { physicalId: name, attributes: {} };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create Glue Workflow ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}

export async function workflowUpdate(
  this: GlueWorkflowProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  // Issue #2177 -- the recorded name is a needle too after a rotated secret.
  const log = glueOperationSinks(
    this.logger,
    context?.maskSecrets,
    previousNamePairs(physicalId, [previousProperties?.['Name']])
  );
  const { value: v } = log;
  log.debug(`Updating Glue Workflow ${logicalId}: ${v(physicalId)}`);
  // go-to-k/cdkd#4073: a malformed desired Tags is refused before any call.
  desiredGlueTags(properties['Tags'], resourceType, logicalId, physicalId);

  try {
    // A full replace: a field left out here is CLEARED on AWS, which is how a
    // property removed from the template is reset, as CloudFormation does
    // (issue #1160). Never fill an absent field from `previousProperties`.
    await this.getClient().send(
      new UpdateWorkflowCommand({
        Name: physicalId,
        ...(properties['Description'] !== undefined && {
          Description: properties['Description'] as string,
        }),
        ...(properties['DefaultRunProperties'] !== undefined && {
          DefaultRunProperties: properties['DefaultRunProperties'] as Record<string, string>,
        }),
        ...(properties['MaxConcurrentRuns'] !== undefined && {
          MaxConcurrentRuns: coerceNumber(properties['MaxConcurrentRuns']) as number,
        }),
      })
    );

    // `UpdateWorkflow` does not carry tags: reconcile them out of band. Tags
    // used to be dropped here, so a template or `drift --revert` tag change
    // never reached AWS (go-to-k/cdkd#4073).
    await applyGlueTagDiff(
      this.getClient(),
      () => this.buildWorkflowArn(physicalId),
      previousProperties['Tags'],
      properties['Tags'],
      resourceType,
      logicalId,
      log.warn
    );

    log.debug(`Successfully updated Glue Workflow ${logicalId}`);
    return { physicalId, wasReplaced: false };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update Glue Workflow ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

export async function workflowDelete(
  this: GlueWorkflowProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting Glue Workflow ${logicalId}: ${physicalId}`);
  // go-to-k/cdkd#2613: the physical id is a NAME, so a client in another
  // region than the state record would delete a same-named
  // workflow cdkd does not manage. Refuse before any call, not only
  // on NotFound; the client's region is resolved only when there is one
  // to compare with.
  assertRegionMatch(
    context?.expectedRegion ? await this.getClient().config.region() : undefined,
    context?.expectedRegion,
    resourceType,
    logicalId,
    physicalId,
    'pre-delete'
  );

  try {
    await this.getClient().send(new DeleteWorkflowCommand({ Name: physicalId }));
    this.logger.debug(`Successfully deleted Glue Workflow ${logicalId}`);
  } catch (error) {
    if (error instanceof EntityNotFoundException) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`Glue Workflow ${physicalId} does not exist, skipping deletion`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapMaskedError(
      context?.maskSecrets ?? ((text: string) => text),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete Glue Workflow ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
    // The wrap names an AWS failure by its CLASS, and the delete classifiers
    // read `NotFoundException` in a message as "already deleted": only the
    // typed not-found above means this resource is gone (go-to-k/cdkd#2319).
    throw error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
  }
}

// eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
export async function workflowGetAttribute(
  this: GlueWorkflowProvider,
  physicalId: string,
  _resourceType: string,
  attributeName: string
): Promise<unknown> {
  if (attributeName === 'Id' || attributeName === 'Ref' || attributeName === 'Name') {
    return physicalId;
  }
  return undefined;
}

/**
 * Read AWS-current Workflow shape via `GetWorkflow`. Surfaces every
 * user-controllable top-level CFn key with always-emit placeholders
 * (PR #145):
 *  - `Description` → `?? ''`
 *  - `DefaultRunProperties` → `?? {}`
 *  - `MaxConcurrentRuns` → omitted when AWS reports `undefined` (no
 *    AWS-side default to anchor a placeholder against; cdkd state may
 *    legitimately leave this unset)
 *  - `Tags` → `?? []` (filtered against `aws:cdk:path` and the rest of
 *    the `aws:`-prefixed reserved space)
 */
export async function workflowReadCurrentState(
  this: GlueWorkflowProvider,
  physicalId: string,
  _logicalId: string,
  _resourceType: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let workflow;
  try {
    const resp = await this.getClient().send(
      new GetWorkflowCommand({ Name: physicalId, IncludeGraph: false })
    );
    workflow = resp.Workflow;
  } catch (err) {
    if (err instanceof EntityNotFoundException) return RESOURCE_NOT_FOUND;
    throw err;
  }
  if (!workflow) return undefined;

  const result: Record<string, unknown> = {
    Name: workflow.Name ?? physicalId,
    Description: workflow.Description ?? '',
    DefaultRunProperties: workflow.DefaultRunProperties ?? {},
  };

  if (workflow.MaxConcurrentRuns !== undefined) {
    result['MaxConcurrentRuns'] = workflow.MaxConcurrentRuns;
  }

  // Tags via separate GetTags(ResourceArn) call.
  const arn = await this.buildWorkflowArn(physicalId);
  let tags: Array<{ Key: string; Value: string }> = [];
  try {
    const tagResp = await this.getClient().send(new GetTagsCommand({ ResourceArn: arn }));
    tags = normalizeAwsTagsToCfn(tagResp.Tags);
  } catch (err) {
    // Best-effort — `GetTags` failure should not abort the drift read.
    this.logger.debug(
      `GetTags failed for Glue Workflow ${physicalId}: ${describeAwsFailure(err).detail}`
    );
  }
  result['Tags'] = tags;

  return result;
}

export async function workflowImport(
  this: GlueWorkflowProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const explicitName = input.knownPhysicalId ?? (input.properties['Name'] as string | undefined);

  if (explicitName) {
    try {
      await this.getClient().send(new GetWorkflowCommand({ Name: explicitName }));
      return { physicalId: explicitName, attributes: {} };
    } catch (err) {
      if (err instanceof EntityNotFoundException) return null;
      throw err;
    }
  }

  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
  // that tag never exists on a real resource and the walk could not match
  // (issue #1134). Auto-mode import resolves ids from CloudFormation's
  // `DescribeStackResources` or the template's physical-name property; a
  // workflow reaching here needs an explicit `--resource` override.
  return null;
}

/**
 * The workflow ARN `GetTags` needs. The partition is derived from the
 * client's region (issue #1815): the literal `arn:aws:` is structurally valid
 * everywhere, so in `aws-cn` / `aws-us-gov` nothing rejected it — `GetTags`
 * was simply aimed at an ARN naming no workflow, and the best-effort catch
 * below reads a failure there as EMPTY tags. A commercial region still derives to `aws`,
 * so commercial output is unchanged byte for byte.
 */
export async function buildWorkflowArn(
  this: GlueWorkflowProvider,
  workflowName: string
): Promise<string> {
  const region = await this.getRegion();
  const account = await this.getAccountId();
  const { partition } = derivePartitionAndUrlSuffix(region);
  return `arn:${partition}:glue:${region}:${account}:workflow/${workflowName}`;
}

export async function getRegion(this: GlueWorkflowProvider): Promise<string> {
  const region = await this.getClient().config.region();
  return region || this.providerRegion || 'us-east-1';
}

export async function getAccountId(this: GlueWorkflowProvider): Promise<string> {
  if (this.cachedAccountId) return this.cachedAccountId;
  if (!this.stsClient) {
    this.stsClient = new STSClient({
      ...ambientClientDefaults(),
      ...(this.providerRegion ? { region: this.providerRegion } : {}),
    });
  }
  const identity = await this.stsClient.send(new GetCallerIdentityCommand({}));
  if (!identity.Account) {
    throw new Error('Failed to resolve AWS account id from STS');
  }
  this.cachedAccountId = identity.Account;
  return this.cachedAccountId;
}

export const workflowMethods = { buildWorkflowArn, getRegion, getAccountId };
