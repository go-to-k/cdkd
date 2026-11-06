import type { ApiGatewayProvider } from '../apigateway-provider.js';
import {
  APIGatewayClient,
  TagResourceCommand,
  UntagResourceCommand,
} from '@aws-sdk/client-api-gateway';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { planTagDiff, tagPlanWarning } from '../../tag-list.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { derivePartitionAndUrlSuffix } from '../../../utils/aws-partition.js';
import type { DeleteContext } from '../../region-check.js';
import type {
  CreateContext,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
  UpdateContext,
} from '../../../types/resource.js';
import {
  createMaskedLogSinks,
  type MaskedLogSinks,
  type MaskerFn,
} from '../../masked-retry-logger.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../../deployment/retryable-errors.js';
import {
  pasteableAwsCommand,
  type PasteableAwsCommand,
} from '../../replacement-protection-advice.js';
import { isAuxiliaryFailure } from '../../auxiliary-failure.js';
import {
  redactedDeleteAddressFields,
  redactedDeleteAddressSkip,
} from '../../redacted-delete-address.js';
import { withRemovalDefaults } from '../../update-removal.js';
import { ambientClientDefaults } from '../../../utils/ambient-client-defaults.js';
import {
  API_GATEWAY_MAX_ATTEMPTS,
  withApiGatewayPacing,
} from '../../../utils/apigateway-pacing.js';
import { withoutServerErrorRetries } from '../ambiguous-create.js';
import { REST_API_ID_ADDRESSED_TYPES, stageSinks } from './shared.js';

/**
 * The client `CreateAuthorizer` and `CreateDeployment` go through: SDK
 * retries on, except a 5xx (`withoutServerErrorRetries`, issue #2080).
 * Separate so every other call keeps the full SDK retry, and built in the
 * shared client's REGION (read from it, as `config.region()` resolves it) so
 * the create cannot land in another region than the calls around it. The
 * PROMISE is cached, so two creates on a cold provider build one client; a
 * rejected region read is not cached, so the next create retries it.
 */
export function getCreateClient(this: ApiGatewayProvider): Promise<APIGatewayClient> {
  this.createClient ??= this.apiGatewayClient.config.region().then(
    (region) =>
      withoutServerErrorRetries(
        withApiGatewayPacing(
          new APIGatewayClient({
            ...ambientClientDefaults(),
            region,
            maxAttempts: API_GATEWAY_MAX_ATTEMPTS,
          })
        )
      ),
    (error: unknown) => {
      this.createClient = undefined;
      throw error;
    }
  );
  return this.createClient;
}

/**
 * ` --region <r>` for an orphan report's pasteable commands (issue #2080),
 * from the client the lookup listed through: without it a stack deployed
 * outside the operator's default region pastes a read against the wrong
 * region, and its NotFound reads as "no orphan". Empty when the region
 * cannot be read -- the report must never fail the create.
 */
export async function orphanCommandRegionArg(
  this: ApiGatewayProvider,
  aws: ReturnType<typeof pasteableAwsCommand>
): Promise<PasteableAwsCommand> {
  let region: string | undefined;
  try {
    region = await this.apiGatewayClient.config.region();
  } catch {
    region = undefined;
  }
  return region ? aws` --region ${region}` : aws``;
}

/**
 * The failure wrap every `create()` / `update()` / `delete()` catch throws.
 *
 * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
 * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
 * `deployments/{runId}.jsonl`, and an `AccessDeniedException` names the
 * caller's assumed-role ARN. AWS's own text goes to `debug` through the
 * masker, and the wrap is stamped `markRedactedCause`, so the retry
 * classifiers read the withheld text on the `cause` chain. An "already
 * exists" is restated ({@link relayedNameCollision}), except from a
 * post-create step (`markAuxiliaryFailure`: the Stage patch, the Method
 * wiring), where "it" would read as the resource just created.
 *
 * A cdkd-authored or transport error, or a non-`Error` throw, keeps its text
 * masked (issue #2177): AWS quotes a rejected request value back off the
 * RESOLVED `properties` bag, and masking the RAW text reaches the masker's
 * whole-value arm (`wrapMaskedAwsError`, issue #4259). A delete passes
 * its `DeleteContext.maskSecrets`, or the identity.
 *
 * `build` must thread `error` as `cause`, and runs twice, so it must stay a
 * side-effect-free constructor call. A method, so `gen-update-wrap-coverage`
 * sees the catch that throws it as a wrap.
 */
export function wrapMaskedError(
  this: ApiGatewayProvider,
  mask: MaskerFn,
  error: unknown,
  build: (maskedText: string) => ProvisioningError
): ProvisioningError {
  const failure = describeAwsFailure(error);
  if (!(error instanceof Error)) return build(mask(failure.detail));
  if (!failure.redacted) return wrapMaskedAwsError(mask, error, build);
  this.logger.debug(mask(build(mask(failure.detail)).message));
  const relay = isAuxiliaryFailure(error) ? '' : relayedNameCollision(failure.detail);
  return markRedactedCause(build(`${mask(failure.summary)}${relay}`));
}

/**
 * Create a resource.
 *
 * Each `create()` / `update()` builds ONE masked sink set from its own
 * context (issue #2177, `.claude/rules/provider-masking.md`) and routes every
 * log line and wrapped AWS error text through it; every bag value a cdkd
 * line interpolates is also masked RAW (`log.value`), so a secret below the
 * masker's substring floor is caught too. Absent context means identity.
 */
export async function create(
  this: ApiGatewayProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  const log = createMaskedLogSinks(this.logger, context?.maskSecrets);
  switch (resourceType) {
    case 'AWS::ApiGateway::Account':
      return this.createAccount(logicalId, resourceType, properties, log);
    case 'AWS::ApiGateway::Authorizer':
      return this.createAuthorizer(logicalId, resourceType, properties, log);
    case 'AWS::ApiGateway::Resource':
      return this.createResource(logicalId, resourceType, properties, log);
    case 'AWS::ApiGateway::Deployment':
      return this.createDeployment(logicalId, resourceType, properties, log);
    case 'AWS::ApiGateway::Stage':
      return this.createStage(
        logicalId,
        resourceType,
        properties,
        // `withDerivedNameMasks` drops a non-string name at runtime.
        stageSinks(this.logger, context, [
          [properties['StageName'], properties['StageName'] as string | undefined],
        ])
      );
    case 'AWS::ApiGateway::Method':
      return this.createMethod(logicalId, resourceType, properties, log, context);
    default:
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId
      );
  }
}

/**
 * Update a resource. `context` is read for its masker (issue #2177; see
 * `create()`) and, on the Account arm, for `removedProperties` via
 * `withRemovalDefaults` (issue #1160).
 */
export async function update(
  this: ApiGatewayProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  const log = createMaskedLogSinks(this.logger, context?.maskSecrets);
  switch (resourceType) {
    case 'AWS::ApiGateway::Account':
      properties = withRemovalDefaults(
        this.removalDefaults,
        resourceType,
        properties,
        previousProperties,
        context
      );
      return this.updateAccount(logicalId, physicalId, resourceType, properties, log);
    case 'AWS::ApiGateway::Authorizer':
      return this.updateAuthorizer(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        log
      );
    case 'AWS::ApiGateway::Resource':
      return this.updateResource(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        log
      );
    case 'AWS::ApiGateway::Deployment':
      return this.updateDeployment(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        log
      );
    case 'AWS::ApiGateway::Stage':
      // The recorded name is the physical id. Either side's `StageName`
      // being secret-derived makes it a needle. The desired side covers the
      // threaded callers (a rotated secret resolves to a NEW plaintext the
      // masker knows, and the needle then removes the OLD one). The previous
      // side is a backstop for a caller whose masker does not know the
      // desired name while state recorded the name as a `{{resolve:`
      // reference or `***`; it can only over-mask.
      return this.updateStage(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        stageSinks(this.logger, context, [
          [properties['StageName'], physicalId],
          [previousProperties['StageName'], physicalId],
        ])
      );
    case 'AWS::ApiGateway::Method':
      return this.updateMethod(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        log,
        context?.desiredFromAwsReadback === true
      );
    default:
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId,
        physicalId
      );
  }
}

/**
 * Delete a resource
 */
export async function deleteImpl(
  this: ApiGatewayProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void | ResourceDeleteResult> {
  // go-to-k/cdkd#3952: these four address the child through the recorded
  // RestApiId, and an unknown id answers NotFoundException, which their
  // catches read as "already deleted" -- a redacted id would DROP the record.
  if (REST_API_ID_ADDRESSED_TYPES.has(resourceType)) {
    const skip = redactedDeleteAddressSkip(
      this.logger,
      logicalId,
      resourceType,
      redactedDeleteAddressFields({ RestApiId: properties?.['RestApiId'] })
    );
    if (skip) return skip;
  }
  switch (resourceType) {
    case 'AWS::ApiGateway::Account':
      return this.deleteAccount(logicalId, physicalId, resourceType, context);
    case 'AWS::ApiGateway::Authorizer':
      return this.deleteAuthorizer(logicalId, physicalId, resourceType, properties, context);
    case 'AWS::ApiGateway::Resource':
      return this.deleteResource(logicalId, physicalId, resourceType, properties, context);
    case 'AWS::ApiGateway::Deployment':
      return this.deleteDeployment(logicalId, physicalId, resourceType, properties, context);
    case 'AWS::ApiGateway::Stage':
      return this.deleteStage(logicalId, physicalId, resourceType, properties, context);
    case 'AWS::ApiGateway::Method':
      return this.deleteMethod(logicalId, physicalId, resourceType, context);
    default:
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId,
        physicalId
      );
  }
}

/**
 * Get resource attributes (for Fn::GetAtt resolution)
 */
export async function getAttribute(
  this: ApiGatewayProvider,
  physicalId: string,
  resourceType: string,
  attributeName: string
): Promise<unknown> {
  switch (resourceType) {
    case 'AWS::ApiGateway::Account':
      // Account has no useful GetAtt attributes
      return undefined;
    case 'AWS::ApiGateway::Authorizer':
      return this.getAuthorizerAttribute(physicalId, attributeName);
    case 'AWS::ApiGateway::Resource':
      return this.getResourceAttribute(physicalId, resourceType, attributeName);
    case 'AWS::ApiGateway::Deployment':
      return this.getDeploymentAttribute(physicalId, attributeName);
    case 'AWS::ApiGateway::Stage':
      return this.getStageAttribute(physicalId, attributeName);
    case 'AWS::ApiGateway::Method':
      return this.getMethodAttribute(physicalId, attributeName);
    default:
      return undefined;
  }
}

/**
 * Build the ARN for an API Gateway Stage, used for tag mutations.
 *
 * Format:
 * `arn:{partition}:apigateway:{region}::/restapis/{restApiId}/stages/{stageName}`.
 * The double colon (`::`) is intentional: API Gateway tagging uses an
 * account-id-less ARN.
 *
 * The partition is derived from the region through the same closed mapping
 * `${AWS::Partition}` uses (issue #1815) rather than hardcoded to `aws`.
 * Unlike the pure attribute builders this one is passed straight to
 * `TagResource` / `UntagResource` as `resourceArn`, so in `aws-cn` /
 * `aws-us-gov` a commercial literal does not just record a wrong string —
 * it aims the tag mutation at an ARN that names no stage.
 */
export async function buildStageArn(
  this: ApiGatewayProvider,
  restApiId: string,
  stageName: string
): Promise<string | undefined> {
  try {
    const region = await this.apiGatewayClient.config.region();
    const { partition } = derivePartitionAndUrlSuffix(region);
    return `arn:${partition}:apigateway:${region}::/restapis/${restApiId}/stages/${stageName}`;
  } catch {
    return undefined;
  }
}

/**
 * Apply a diff between old and new CFn-shape Tags arrays via API Gateway's
 * `TagResource` / `UntagResource` APIs. API Gateway's `TagResource` takes
 * lowercase camelCase fields plus a tag-map (`{ resourceArn, tags: {key: value} }`);
 * `UntagResource` takes `{ resourceArn, tagKeys: [...] }`. Both sides are
 * read through `planTagDiff` (go-to-k/cdkd#3994): an unreadable record
 * untags nothing.
 *
 * `log` is the calling update's masked sink (issue #2177): the stage ARN
 * embeds the stage name, which can be secret-derived. `displayArn` is the
 * ARN the lines print, its RestApiId segment masked RAW by the caller;
 * `resourceArn` is what AWS receives.
 */
export async function applyTagDiff(
  this: ApiGatewayProvider,
  resourceArn: string,
  resourceType: string,
  logicalId: string,
  oldTagsRaw: unknown,
  newTagsRaw: unknown,
  log: MaskedLogSinks,
  displayArn: string
): Promise<void> {
  const plan = planTagDiff(oldTagsRaw, newTagsRaw);
  const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
  if (tagWarning !== undefined) {
    log.warn(tagWarning);
  }
  const tagsToAdd: Record<string, string> = Object.fromEntries(plan.set);
  const tagsToRemove = plan.remove;

  if (tagsToRemove.length > 0) {
    await this.apiGatewayClient.send(
      new UntagResourceCommand({ resourceArn, tagKeys: tagsToRemove })
    );
    log.debug(`Removed ${tagsToRemove.length} tag(s) from API Gateway resource ${displayArn}`);
  }
  if (Object.keys(tagsToAdd).length > 0) {
    await this.apiGatewayClient.send(new TagResourceCommand({ resourceArn, tags: tagsToAdd }));
    log.debug(
      `Added/updated ${Object.keys(tagsToAdd).length} tag(s) on API Gateway resource ${displayArn}`
    );
  }
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(this: ApiGatewayProvider, ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
