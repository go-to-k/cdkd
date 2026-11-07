import { RDSClient } from '@aws-sdk/client-rds';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { type DeleteContext } from '../region-check.js';
import type {
  CreateContext,
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  UpdateContext,
  ResourceNotFound,
} from '../../types/resource.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { maskerOrIdentity, type MaskerFn } from '../masked-retry-logger.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import { markNotGone } from '../not-gone.js';
import { injectiveKeyPrefix } from '../../state/record-keys.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { withoutServerErrorRetries } from './ambiguous-create.js';
import { create } from './rds-dbproxy/create.js';
import {
  update,
  waitForAvailableAfterModify,
  warnOnRetainedRemovals,
  removedRetained,
  applyTagDiff,
} from './rds-dbproxy/update.js';
import { deleteImpl } from './rds-dbproxy/delete.js';
import {
  getAttribute,
  importImpl,
  readCurrentState,
  buildImportResult,
} from './rds-dbproxy/read-state.js';

/**
 * AWS RDS DBProxy Provider
 *
 * Implements resource provisioning for `AWS::RDS::DBProxy`.
 *
 * **Why a dedicated SDK provider** (per `feedback_dedicated_provider_over_special_case.md`):
 * keeps the AWS::RDS::DBProxy family (DBProxy + DBProxyTargetGroup) on one
 * codebase. Pre-PR DBProxy went through CC API, which worked for create
 * and delete but the sibling DBProxyTargetGroup type was broken — moving
 * the parent type to a dedicated provider ensures the whole family is
 * consistent and lets us evolve both surfaces together (e.g. shared
 * `DescribeDBProxies` calls in future enrichment, common error handling).
 *
 * **Lifecycle**:
 * - `create`: `CreateDBProxyCommand`, then poll `DescribeDBProxies` until
 *   `DBProxyStatus === 'available'`. Returns physicalId=DBProxyName plus
 *   `Endpoint` / `DBProxyArn` / `VpcId` in attributes.
 * - `update`: `ModifyDBProxyCommand` for the mutable fields (Auth /
 *   DefaultAuthScheme / DebugLogging / IdleClientTimeout / RequireTLS /
 *   RoleArn / SecurityGroups), then poll `DescribeDBProxies` until the proxy
 *   is `available` again; a removed field is left at its live value and
 *   warned about (`RETAINED_ON_REMOVAL`), except an `Auth` removal AWS would
 *   refuse, which is refused before any call (`authRemovalRefused`). Tags
 *   handled via separate `AddTagsToResource` / `RemoveTagsFromResource` diff.
 *   EngineFamily, VpcSubnetIds, EndpointNetworkType and
 *   TargetConnectionNetworkType are immutable on AWS (create-only in the CFn
 *   schema, no `ModifyDBProxy` member; go-to-k/cdkd#2762); a diff in those
 *   surfaces as `ResourceReplacement` from the deploy engine, not handled here.
 * - `delete`: `DeleteDBProxyCommand`, then poll for `DBProxyNotFoundFault`
 *   to confirm full removal (AWS keeps the proxy in `deleting` state for
 *   ~30-60s after the delete returns). `DBProxyNotFoundFault` at any
 *   point is treated as idempotent success (region-match-gated).
 * - `getAttribute`: `DescribeDBProxies` for `Endpoint` / `DBProxyArn` /
 *   `VpcId`, cached per `(physicalId, attribute)`.
 * - `import`: explicit `--resource` override or the template's
 *   `DBProxyName` property (issue #1134 removed the unreachable
 *   `aws:cdk:path` tag walk).
 *
 * **physicalId** = DBProxyName (matches CFn `primaryIdentifier`).
 */
export class RDSDBProxyProvider implements ResourceProvider {
  private rdsClient?: RDSClient;
  private createClient?: RDSClient;
  private readonly providerRegion = ambientRegion();
  logger: ConsoleLogger = getLogger().child('RDSDBProxyProvider');
  readonly attributeCache = new Map<string, unknown>();

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::RDS::DBProxy',
      new Set([
        'DBProxyName',
        'EngineFamily',
        'Auth',
        'RoleArn',
        'VpcSubnetIds',
        'VpcSecurityGroupIds',
        'RequireTLS',
        'IdleClientTimeout',
        'DebugLogging',
        'DefaultAuthScheme',
        'EndpointNetworkType',
        'TargetConnectionNetworkType',
        'Tags',
      ]),
    ],
  ]);

  getClient(): RDSClient {
    if (!this.rdsClient) {
      // Built together with the create client, so both capture the identity
      // active at this ONE call (issue #4639).
      this.rdsClient = new RDSClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
      this.createClient = withoutServerErrorRetries(
        new RDSClient({
          ...ambientClientDefaults(),
          ...(this.providerRegion ? { region: this.providerRegion } : {}),
        })
      );
    }
    return this.rdsClient;
  }

  /**
   * The client `CreateDBProxy` goes through: SDK retries on, except a 5xx
   * (`withoutServerErrorRetries`, issue #4639). Separate so every other call
   * keeps the full SDK retry.
   *
   * `CreateDBProxy` carries no idempotency token and the proxy name is unique per
   * account and region, so the SDK's own replay of a 5xx whose request had
   * succeeded collides with what the first send made, and that "already
   * exists" surfaced from the engine's FIRST attempt as a name somebody else
   * holds. Refused here, the 5xx reaches the deploy engine's retry, which
   * marks the create as possibly replayed (`withRetry`, #3978). Nothing is
   * adopted on that collision: a name is not attribution
   * (`docs/provider-rules.md`, "Adopt only on EXACT attribution").
   */
  getCreateClient(): RDSClient {
    this.getClient();
    return this.createClient as RDSClient;
  }

  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return create.call(this, logicalId, resourceType, properties, context);
  }

  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return update.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }

  waitForAvailableAfterModify(
    physicalId: string,
    resourceType: string,
    logicalId: string,
    mask: (s: string) => string
  ): Promise<void> {
    return waitForAvailableAfterModify.call(this, physicalId, resourceType, logicalId, mask);
  }

  warnOnRetainedRemovals(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context: UpdateContext | undefined
  ): void {
    return warnOnRetainedRemovals.call(
      this,
      logicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }

  removedRetained(
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context: UpdateContext | undefined
  ): string[] {
    return removedRetained.call(this, properties, previousProperties, context);
  }

  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, _properties, context);
  }

  getAttribute(physicalId: string, _resourceType: string, attributeName: string): Promise<unknown> {
    return getAttribute.call(this, physicalId, _resourceType, attributeName);
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }

  readCurrentState(physicalId: string): Promise<Record<string, unknown> | ResourceNotFound> {
    return readCurrentState.call(this, physicalId);
  }

  applyTagDiff(
    physicalId: string,
    oldTags: unknown,
    newTags: unknown,
    resourceType: string,
    logicalId: string,
    maskSecrets?: MaskerFn
  ): Promise<void> {
    return applyTagDiff.call(
      this,
      physicalId,
      oldTags,
      newTags,
      resourceType,
      logicalId,
      maskSecrets
    );
  }

  buildImportResult(physicalId: string): Promise<ResourceImportResult> {
    return buildImportResult.call(this, physicalId);
  }

  invalidateAttributeCache(physicalId: string): void {
    // The prefix of the ENCODED key, not of the old separated one. This scan is
    // the reader go-to-k/cdkd#3496's first cut broke: the keys became
    // `["proxy-1","Endpoint"]` while this still tested `proxy-1:`, so it matched
    // NOTHING and every post-update `Fn::GetAtt` read the pre-update value. It
    // was silent — no test covered it and every gate stayed green.
    //
    // DERIVED from the encoder, never re-spelled here — re-spelling is exactly
    // what broke this scan. {@link injectiveKeyPrefix} carries why it is exact.
    const encodedPrefix = injectiveKeyPrefix(physicalId);
    for (const key of this.attributeCache.keys()) {
      if (key.startsWith(encodedPrefix)) this.attributeCache.delete(key);
    }
  }

  /**
   * The failure wrap this provider's create, update, delete and tag catches
   * throw.
   *
   * An AWS-authored failure reaches the message as its CLASS plus the
   * `--verbose` pointer (go-to-k/cdkd#2319): a thrown message is persisted to
   * `deployments/{runId}.jsonl`, and an RDS `AccessDenied` names the caller's
   * assumed-role ARN. AWS's own text goes to `debug` through the operation's
   * masker, and the wrap is stamped `markRedactedCause`, so the retry
   * classifiers read the withheld text on the `cause` chain. An "already
   * exists" is restated ({@link relayedNameCollision}); this provider marks
   * no post-create call auxiliary, so nothing gates it. A cdkd-authored or transport
   * error keeps its text, masked, stamped only when the mask changed it
   * (`wrapMaskedAwsError`, go-to-k/cdkd#4339); a non-`Error` throw is withheld
   * like an AWS one, unstamped (it has no chain). A delete catch tests
   * not-found by type before it wraps.
   */
  wrapCaughtError(
    error: unknown,
    op: string,
    resourceType: string,
    logicalId: string,
    physicalId: string | undefined,
    // AWS can quote a secret-derived name, the pre-rotation one included
    // (go-to-k/cdkd#4339). Absent means unmasked.
    mask: MaskerFn = maskerOrIdentity(undefined)
  ): ProvisioningError {
    const cause = error instanceof Error ? error : undefined;
    const build = (text: string): ProvisioningError =>
      new ProvisioningError(
        `${op} failed for ${logicalId}: ${text}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    const failure = describeAwsFailure(error);
    if (!failure.redacted) return wrapMaskedAwsError(mask, error, build);
    this.logger.debug(mask(build(mask(failure.detail)).message));
    const wrapped = build(`${mask(failure.summary)}${relayedNameCollision(failure.detail)}`);
    return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
  }

  /**
   * {@link wrapCaughtError} for a delete catch. The wrap names an AWS failure
   * by its CLASS, and the delete classifiers read `NotFound` in a message as
   * "already deleted": a class naming ANOTHER object's not-found (the typed
   * not-found of this resource returned before the wrap) is marked
   * `markNotGone`, so the record is kept (go-to-k/cdkd#2319).
   */
  wrapDeleteError(
    error: unknown,
    op: string,
    resourceType: string,
    logicalId: string,
    physicalId: string,
    mask: MaskerFn
  ): ProvisioningError {
    const thrown = this.wrapCaughtError(error, op, resourceType, logicalId, physicalId, mask);
    return error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
  }
}
