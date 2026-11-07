import { WAFV2Client } from '@aws-sdk/client-wafv2';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import type { MaskerFn } from '../masked-retry-logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type { DeleteContext } from '../region-check.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  UpdateContext,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
  ResourceNotFound,
} from '../../types/resource.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { withoutServerErrorRetries } from './ambiguous-create.js';
import { create } from './wafv2/create.js';
import { update, applyTagDiff } from './wafv2/update.js';
import { deleteImpl } from './wafv2/delete.js';
import { readCurrentState, importImpl } from './wafv2/read-state.js';

/**
 * AWS WAFv2 WebACL Provider
 *
 * Implements resource provisioning for AWS::WAFv2::WebACL using the WAFv2 SDK.
 * WHY: WAFv2 CreateWebACL is synchronous - the CC API adds unnecessary polling
 * overhead for an operation that completes immediately.
 * This SDK provider eliminates that polling and returns instantly.
 */
export class WAFv2WebACLProvider implements ResourceProvider {
  private wafv2Client?: WAFV2Client;
  private createClient?: WAFV2Client;
  private readonly providerRegion = ambientRegion();
  logger: ConsoleLogger = getLogger().child('WAFv2WebACLProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::WAFv2::WebACL',
      new Set([
        'Name',
        'Scope',
        'Tags',
        'DefaultAction',
        'Description',
        'Rules',
        'VisibilityConfig',
        'CustomResponseBodies',
        'CaptchaConfig',
        'ChallengeConfig',
        'TokenDomains',
        'AssociationConfig',
        'DataProtectionConfig',
        'OnSourceDDoSProtectionConfig',
        'ApplicationConfig',
        'MonetizationConfig',
      ]),
    ],
  ]);

  getClient(): WAFV2Client {
    if (!this.wafv2Client) {
      // Built together with the create client, so both capture the identity
      // active at this ONE call (issue #4639).
      this.wafv2Client = new WAFV2Client({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
      this.createClient = withoutServerErrorRetries(
        new WAFV2Client({
          ...ambientClientDefaults(),
          ...(this.providerRegion ? { region: this.providerRegion } : {}),
        })
      );
    }
    return this.wafv2Client;
  }

  /**
   * The client `CreateWebACL` goes through: SDK retries on, except a 5xx
   * (`withoutServerErrorRetries`, issue #4639). Separate so every other call
   * keeps the full SDK retry.
   *
   * `CreateWebACL` carries no idempotency token and a web ACL name is unique
   * per scope and region, so the SDK's own replay of a 5xx whose request had
   * succeeded collides with the web ACL the first send made, and that
   * `WAFDuplicateItemException` surfaced from the engine's FIRST attempt as a
   * name somebody else holds. Refused here, the 5xx reaches the deploy
   * engine's retry, which marks the create as possibly replayed (`withRetry`,
   * #3978). Nothing is adopted on that collision: a name is not attribution
   * (`docs/provider-rules.md`, "Adopt only on EXACT attribution").
   */
  getCreateClient(): WAFV2Client {
    this.getClient();
    return this.createClient as WAFV2Client;
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

  /**
   * The failure wrap the create, update and delete catches throw.
   *
   * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
   * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
   * `deployments/{runId}.jsonl`, and an `AccessDenied` names the caller's
   * assumed-role ARN. AWS's own text goes to `debug` through `mask`, and the
   * wrap is stamped `markRedactedCause`, so the retry classifiers read the
   * withheld text on the `cause` chain. An "already exists" is restated
   * ({@link relayedNameCollision}) so a create-first replacement still
   * recognises the collision. A non-`Error` throw is withheld the same way,
   * unstamped: it has no chain.
   *
   * A cdkd-authored or transport error keeps its text, masked, stamped exactly
   * when the mask changed it (`wrapMaskedAwsError`, issue #4244). The delete
   * tests its typed not-found before it wraps.
   *
   * `build` must thread `error` as `cause`, and runs twice, so it must stay a
   * side-effect-free constructor call.
   */
  wrapCaughtError(
    mask: MaskerFn,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    const failure = describeAwsFailure(error);
    if (!failure.redacted) return wrapMaskedAwsError(mask, error, build);
    this.logger.debug(mask(build(mask(failure.detail)).message));
    const wrapped = build(`${mask(failure.summary)}${relayedNameCollision(failure.detail)}`);
    return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
  }

  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, properties, context);
  }

  applyTagDiff(
    arn: string,
    resourceType: string,
    logicalId: string,
    oldTagsRaw: unknown,
    newTagsRaw: unknown
  ): Promise<void> {
    return applyTagDiff.call(this, arn, resourceType, logicalId, oldTagsRaw, newTagsRaw);
  }

  readCurrentState(
    physicalId: string,
    logicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, logicalId, resourceType, properties);
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }
}
