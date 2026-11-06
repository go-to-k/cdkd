import {
  GetGraphqlApiCommand,
  TagResourceCommand,
  UntagResourceCommand,
} from '@aws-sdk/client-appsync';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import type { DeleteContext } from '../../region-check.js';
import { planTagDiff, tagPlanWarning } from '../../tag-list.js';
import type { ResourceDeleteResult } from '../../../types/resource.js';
import { maskerOrIdentity, type MaskerFn } from '../../masked-retry-logger.js';
import { isAuxiliaryFailure } from '../../auxiliary-failure.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../../deployment/retryable-errors.js';
import type { AppSyncProvider } from '../appsync-provider.js';
import { displayAppSyncPhysicalId } from './shared.js';

/**
 * Apply a Tags diff to a GraphqlApi via TagResource / UntagResource.
 *
 * Tags are keyed by the GraphqlApi ARN — recover it from
 * `GetGraphqlApi`. Failure to recover the ARN is a hard error (the API
 * itself just changed) rather than a silent drop, so the user knows
 * the tag diff was not applied. Both sides are read through `planTagDiff`
 * (go-to-k/cdkd#3994): an unreadable record untags nothing.
 */
export async function applyTagDiff(
  this: AppSyncProvider,
  apiId: string,
  resourceType: string,
  logicalId: string,
  oldTagsRaw: unknown,
  newTagsRaw: unknown,
  mask: MaskerFn = maskerOrIdentity(undefined)
): Promise<void> {
  const plan = planTagDiff(oldTagsRaw, newTagsRaw);
  const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
  if (tagWarning !== undefined) {
    this.logger.warn(tagWarning);
  }
  if (plan.set.size === 0 && plan.remove.length === 0) return;

  let arn = this.arnCache.get(apiId);
  if (!arn) {
    try {
      const resp = await this.getClient().send(new GetGraphqlApiCommand({ apiId }));
      arn = resp.graphqlApi?.arn;
    } catch (error) {
      throw this.wrapUpdateError(error, resourceType, logicalId, apiId, 'GraphqlApi', mask);
    }
    if (!arn) {
      throw new ProvisioningError(
        `Could not resolve ARN for AppSync GraphqlApi ${apiId} to apply tags diff`,
        resourceType,
        logicalId,
        apiId
      );
    }
    this.arnCache.set(apiId, arn);
  }

  const tagKeysToRemove = plan.remove;
  const tagsToAdd = Object.fromEntries(plan.set);

  if (tagKeysToRemove.length > 0) {
    try {
      await this.getClient().send(
        new UntagResourceCommand({
          resourceArn: arn,
          tagKeys: tagKeysToRemove,
        })
      );
    } catch (error) {
      throw this.wrapUpdateError(error, resourceType, logicalId, apiId, 'GraphqlApi (untag)', mask);
    }
  }
  if (Object.keys(tagsToAdd).length > 0) {
    try {
      await this.getClient().send(
        new TagResourceCommand({
          resourceArn: arn,
          tags: tagsToAdd,
        })
      );
    } catch (error) {
      throw this.wrapUpdateError(error, resourceType, logicalId, apiId, 'GraphqlApi (tag)', mask);
    }
  }
}

export function wrapUpdateError(
  this: AppSyncProvider,
  error: unknown,
  resourceType: string,
  logicalId: string,
  physicalId: string,
  subType: string,
  // AWS can quote a child's secret-derived name back (go-to-k/cdkd#4275);
  // absent means unmasked.
  mask: MaskerFn = maskerOrIdentity(undefined),
  // A post-create step's failure (go-to-k/cdkd#2319): no "already exists"
  // restatement, which would read as this resource's collision.
  auxiliary = false
): ProvisioningError {
  const cause = error instanceof Error ? error : undefined;
  const build = (text: string): ProvisioningError =>
    new ProvisioningError(
      `Failed to update AppSync ${subType} ${logicalId}: ${text}`,
      resourceType,
      logicalId,
      physicalId,
      cause
    );
  const failure = describeAwsFailure(error);
  if (error instanceof Error && failure.redacted) {
    return this.withheldAwsFailure(mask, failure.detail, failure.summary, build, auxiliary);
  }
  // A cdkd-authored or transport error, or a non-`Error` throw, keeps its
  // text masked, stamped exactly when the mask changed it, so the retry
  // classifiers read the unmasked cause (go-to-k/cdkd#2302).
  return wrapMaskedAwsError(mask, error, build);
}

/**
 * The failure wrap every `create()` / `delete()` catch (and the `*S3Location`
 * fetch) throws.
 *
 * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
 * pointer (go-to-k/cdkd#2319), as in {@link withheldAwsFailure}. A
 * cdkd-authored or transport error, or a non-`Error` throw, keeps its text
 * masked by `mask`, stamped exactly when the mask changed it, as
 * {@link wrapUpdateError} does: the deploy engine masks a thrown message only
 * with the needles it holds, and an ApiKey id is not one (go-to-k/cdkd#5860).
 * Every delete checks {@link isNotFoundError} before it wraps, and stamps a
 * wrap naming another `NotFound` class `markNotGone`: the class itself would
 * otherwise read as "already deleted".
 *
 * `build` must thread `error` as `cause`, and runs twice, so it must stay a
 * side-effect-free constructor call.
 */
export function wrapCaughtError(
  this: AppSyncProvider,
  mask: MaskerFn,
  error: unknown,
  build: (text: string) => ProvisioningError
): ProvisioningError {
  const failure = describeAwsFailure(error);
  if (!(error instanceof Error) || !failure.redacted) return wrapMaskedAwsError(mask, error, build);
  return this.withheldAwsFailure(
    mask,
    failure.detail,
    failure.summary,
    build,
    isAuxiliaryFailure(error)
  );
}

/**
 * The wrap for an AWS-authored failure (go-to-k/cdkd#2319): a thrown message
 * is persisted to `deployments/{runId}.jsonl`, and an
 * `AccessDeniedException` names the caller's account and assumed-role ARN,
 * so the message carries only the error class and the `--verbose` pointer.
 * AWS's own text goes to `debug` through `mask`, and the wrap is stamped
 * `markRedactedCause`, so the retry classifiers read the withheld text on
 * the `cause` chain. An "already exists" is restated
 * ({@link relayedNameCollision}) so a create-first replacement still
 * recognises a name collision, except from a post-create step's failure
 * (`auxiliary`, {@link markAuxiliaryFailure}), where "it" would read as this
 * resource.
 */
export function withheldAwsFailure(
  this: AppSyncProvider,
  mask: MaskerFn,
  detail: string,
  summary: string,
  build: (text: string) => ProvisioningError,
  auxiliary = false
): ProvisioningError {
  this.logger.debug(mask(build(mask(detail)).message));
  const relay = auxiliary ? '' : relayedNameCollision(detail);
  return markRedactedCause(build(`${mask(summary)}${relay}`));
}

export async function deleteImpl(
  this: AppSyncProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void | ResourceDeleteResult> {
  switch (resourceType) {
    case 'AWS::AppSync::GraphQLApi':
      return this.deleteGraphQLApi(logicalId, physicalId, resourceType, context);
    case 'AWS::AppSync::GraphQLSchema':
      // Schema is deleted with the API, no-op
      this.logger.debug(`Schema ${logicalId} is deleted with its API, skipping`);
      return;
    case 'AWS::AppSync::DataSource':
      return this.deleteDataSource(logicalId, physicalId, resourceType, context);
    case 'AWS::AppSync::Resolver':
      return this.deleteResolver(logicalId, physicalId, resourceType, context);
    case 'AWS::AppSync::ApiKey':
      return this.deleteApiKey(logicalId, physicalId, resourceType, context);
    default:
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId,
        physicalId
      );
  }
}

export function getAttribute(
  this: AppSyncProvider,
  physicalId: string,
  resourceType: string,
  attributeName: string
): Promise<unknown> {
  this.logger.debug(
    `getAttribute for ${resourceType} ${displayAppSyncPhysicalId(resourceType, physicalId)}: ${attributeName}`
  );
  return Promise.resolve(undefined);
}

/**
 * Per-type drift-unknown paths for AppSync resources.
 *
 * `AWS::AppSync::GraphQLSchema.DefinitionS3Location` is a write-only
 * input — at create time AppSync downloads the S3 object and stores
 * the SDL body internally; `GetIntrospectionSchema` returns only the
 * SDL bytes, never the original S3 URL. State templates that pin
 * `DefinitionS3Location` would otherwise fire false drift on every
 * run since `readCurrentState` returns `Definition` (the canonical
 * SDL) instead. This is the same pattern as Lambda `Code` /
 * SecretsManager `SecretString` (write-only via S3 / unrecoverable
 * via the read API).
 */
export function getDriftUnknownPaths(this: AppSyncProvider, resourceType: string): string[] {
  if (resourceType === 'AWS::AppSync::GraphQLSchema') {
    return ['DefinitionS3Location'];
  }
  // Same rationale as `DefinitionS3Location` above: at create time AppSync
  // receives the RESOLVED body (cdkd fetches the S3 object and passes it as
  // `code` / `requestMappingTemplate` / `responseMappingTemplate`), and
  // `GetResolver` returns only that body — never the original S3 URL. A
  // state template pinning any of the three would otherwise fire false
  // drift on every run.
  if (resourceType === 'AWS::AppSync::Resolver') {
    return [
      'CodeS3Location',
      'RequestMappingTemplateS3Location',
      'ResponseMappingTemplateS3Location',
    ];
  }
  return [];
}
