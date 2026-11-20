import { randomUUID } from 'node:crypto';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { safeMsg } from '../../utils/display-safe.js';
import { safeStringify } from '../../utils/aws-failure-text.js';
import { markNonRetryable } from '../../deployment/retryable-errors/marks.js';
import { classifyHandleUrl, WaitConditionSignalStore } from '../wait-condition-signal-store.js';
import { isLegacyHandleId, LEGACY_HANDLE_ID_PREFIX } from '../wait-condition-handle-id.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  UpdateContext,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/** Warn when a handle URL stops working sooner than the longest wait condition (12 h). */
const SHORT_URL_LIFETIME_MS = 12 * 60 * 60 * 1000;

/**
 * AWS::CloudFormation::WaitConditionHandle Provider (go-to-k/cdkd#6694).
 *
 * In CloudFormation this resource's physical id is a pre-signed S3 URL that
 * `cfn-signal` posts to. cdkd issues the same kind of URL against its own
 * state bucket (`WaitConditionSignalStore`), so user data that signals the
 * handle succeeds, and `AWS::CloudFormation::WaitCondition`
 * (`WaitConditionProvider`) waits on what arrives there. A handle nothing
 * waits on — e.g. `cdk-multi-region-stack`'s empty-stack placeholder (#1020)
 * — is just an unused URL.
 *
 * A handle recorded before #6694 keeps its non-URL placeholder id
 * (`cdkd-wait-condition-handle-<logicalId>-<uuid>`): the type has no
 * properties, so no deploy re-creates it, and the wait condition provider
 * refuses it with the remedy.
 */
export class WaitConditionHandleProvider implements ResourceProvider {
  private logger = getLogger().child('WaitConditionHandleProvider');

  // The type's only CFn schema property (`Id`) is read-only; nothing to
  // handle. The explicit empty array literal (not a bare `new Set()`) keeps
  // the declaration parseable by scripts/gen-property-coverage.ts.
  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::CloudFormation::WaitConditionHandle', new Set<string>([])],
  ]);

  private readonly signals: WaitConditionSignalStore;

  constructor(signals: WaitConditionSignalStore = new WaitConditionSignalStore()) {
    this.signals = signals;
  }

  /** Issue the handle's signal URL; `Ref` on the handle resolves to it. */
  async create(
    logicalId: string,
    resourceType: string,
    _properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    let issued: Awaited<ReturnType<WaitConditionSignalStore['issueSignalUrl']>>;
    try {
      issued = await this.signals.issueSignalUrl(logicalId);
    } catch (error) {
      throw markNonRetryable(
        new ProvisioningError(
          `Failed to issue the signal URL for WaitConditionHandle ${logicalId}: ${
            error instanceof Error ? error.message : safeStringify(error)
          }`,
          resourceType,
          logicalId,
          undefined,
          error instanceof Error ? error : undefined
        )
      );
    }
    // The key only: the URL is a bearer credential.
    this.logger.debug(
      safeMsg`Issued WaitConditionHandle ${logicalId} signal URL for ${issued.key}`
    );
    if (issued.expiresAt.getTime() - Date.now() < SHORT_URL_LIFETIME_MS) {
      this.logger.warn(
        safeMsg`WaitConditionHandle ${logicalId}: its signal URL is signed with temporary credentials and stops accepting signals at ${issued.expiresAt.toISOString()}. Deploy with longer-lived credentials if anything signals it later than that.`
      );
    }
    return { physicalId: issued.url, attributes: {} };
  }

  /**
   * The type has no properties, so there is nothing to update — keep the
   * existing physical id (and its URL). The one exception (go-to-k/cdkd#6704):
   * a placeholder id an earlier cdkd recorded, which the diff routes here when
   * something references the handle, is replaced by a signal URL. Nothing
   * exists behind the placeholder, so there is nothing to retire.
   *
   * go-to-k/cdkd#2613: `context` is accepted but no region guard runs: the
   * handle addresses the state bucket, not a resource in the deploy region.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>,
    _context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    if (isLegacyHandleId(physicalId)) {
      const created = await this.create(logicalId, resourceType, properties);
      this.logger.info(
        safeMsg`WaitConditionHandle ${logicalId}: issued a signal URL in place of its placeholder id`
      );
      return { physicalId: created.physicalId, wasReplaced: true, attributes: {} };
    }
    this.logger.debug(`No-op update for WaitConditionHandle ${logicalId}`);
    return { physicalId, wasReplaced: false, attributes: {} };
  }

  /**
   * Remove the signals this handle received. A legacy placeholder or a URL
   * cdkd did not issue (CloudFormation's, after an import) has nothing of
   * cdkd's behind it.
   */
  async delete(logicalId: string, physicalId: string, _resourceType: string): Promise<void> {
    let bucket: string;
    try {
      bucket = this.signals.requireBucket();
    } catch {
      this.logger.debug(
        `No state bucket configured; nothing to remove for WaitConditionHandle ${logicalId}`
      );
      return;
    }
    const verdict = classifyHandleUrl(physicalId, bucket);
    if (verdict.kind !== 'ours') {
      this.logger.debug(`No cdkd signal object behind WaitConditionHandle ${logicalId}`);
      return;
    }
    await this.signals.deleteSignals(verdict.key);
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
    attributeName: string,
    logicalId: string
  ): Promise<unknown> {
    throw new ProvisioningError(
      `AWS::CloudFormation::WaitConditionHandle has no Fn::GetAtt attributes (requested: ${attributeName})`,
      resourceType,
      logicalId,
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
      input.knownPhysicalId ?? `${LEGACY_HANDLE_ID_PREFIX}${input.logicalId}-${randomUUID()}`;
    return { physicalId, attributes: {} };
  }
}
