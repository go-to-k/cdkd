import { randomUUID } from 'node:crypto';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * AWS::CloudFormation::WaitConditionHandle Provider (no-op placeholder).
 *
 * In CloudFormation this resource's physical id is a pre-signed S3 URL that
 * `cfn-signal` posts to, backed by CloudFormation's own internal signal
 * bucket. That URL cannot exist outside a CloudFormation deployment, so cdkd
 * provisions the handle as a pure no-op: no AWS API is called, and the
 * physical id is a synthesized opaque placeholder.
 *
 * This matches how the type is used in practice by CDK constructs — most
 * notably `cdk-multi-region-stack`, which emits a bare
 * `CfnWaitConditionHandle` only so a sibling stack never has zero resources
 * (CloudFormation rejects empty templates). Actual wait-condition signaling
 * (`AWS::CloudFormation::WaitCondition`, which blocks on signals sent to the
 * handle URL) remains unsupported — that semantic fundamentally requires
 * CloudFormation itself.
 */
export class WaitConditionHandleProvider implements ResourceProvider {
  private logger = getLogger().child('WaitConditionHandleProvider');

  // The type's only CFn schema property (`Id`) is read-only; nothing to
  // handle. The explicit empty array literal (not a bare `new Set()`) keeps
  // the declaration parseable by scripts/gen-property-coverage.ts.
  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::CloudFormation::WaitConditionHandle', new Set<string>([])],
  ]);

  /**
   * "Create" the handle: synthesize a unique placeholder physical id.
   * `Ref` on the handle resolves to this id. It is deliberately NOT
   * URL-shaped — a consumer that tries to `cfn-signal` it should fail
   * loudly rather than post to a URL that nothing polls.
   */
  async create(
    logicalId: string,
    _resourceType: string,
    _properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    const physicalId = `cdkd-wait-condition-handle-${logicalId}-${randomUUID()}`;
    this.logger.debug(`Created no-op WaitConditionHandle placeholder ${logicalId} (${physicalId})`);
    return { physicalId, attributes: {} };
  }

  /**
   * The type has no properties, so there is nothing to update — keep the
   * existing physical id.
   */
  async update(
    logicalId: string,
    physicalId: string,
    _resourceType: string,
    _properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`No-op update for WaitConditionHandle ${logicalId}`);
    return { physicalId, wasReplaced: false, attributes: {} };
  }

  /** Nothing was created in AWS, so there is nothing to delete. */
  async delete(logicalId: string, _physicalId: string, _resourceType: string): Promise<void> {
    this.logger.debug(`No-op delete for WaitConditionHandle ${logicalId}`);
  }

  /**
   * WaitConditionHandle is effectively `Ref`-only. Its CFn schema declares a
   * single read-only property `Id` (the primary identifier); the deploy
   * engine's resolver never calls this method for it (it resolves via the
   * physicalId fallback), so a direct call — e.g. `cdkd orphan`'s live
   * attribute fetch — fails loudly instead of fabricating a value.
   */
  async getAttribute(
    physicalId: string,
    resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    throw new ProvisioningError(
      `AWS::CloudFormation::WaitConditionHandle has no Fn::GetAtt attributes (requested: ${attributeName})`,
      resourceType,
      physicalId
    );
  }

  /** No managed properties → nothing can drift. */
  async readCurrentState(): Promise<Record<string, unknown>> {
    return {};
  }

  /**
   * Import: there is no AWS-queryable resource behind a handle, so accept a
   * caller-supplied physical id verbatim (for `--migrate-from-cloudformation`
   * this is CloudFormation's pre-signed-URL id from `DescribeStackResources`)
   * and synthesize a placeholder otherwise.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const physicalId =
      input.knownPhysicalId ?? `cdkd-wait-condition-handle-${input.logicalId}-${randomUUID()}`;
    return { physicalId, attributes: {} };
  }
}
