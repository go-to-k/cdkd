/**
 * SDK Provider for AWS::BedrockAgentCore::Browser (adopt-only singleton).
 *
 * The CloudFormation registry schema declares this type as a READ-ONLY
 * resource "representing the default service-managed browser"
 * (`aws.browser.v1`): every schema property (`BrowserArn` / `BrowserId` /
 * `Name` / `Status`) is read-only, the only handlers are read/list, and the
 * `BrowserId` pattern is hard-locked to `^aws\.browser\.v1$`. The registry
 * marks it `NON_PROVISIONABLE`, so Cloud Control cannot deploy it and cdkd's
 * pre-flight used to reject it (issue #1038).
 *
 * cdkd therefore provisions it as an ADOPT operation, not a create:
 * - `create` verifies the AWS-managed default browser exists in the deploy
 *   region via `GetBrowser` and records its ARN as the physical id (the
 *   type's primaryIdentifier, matching CFn `Ref` semantics).
 * - `update` is a no-op (no writable properties exist).
 * - `delete` is a no-op — the default browser is AWS-owned and must never
 *   be deleted when a stack is destroyed.
 * - `getAttribute` serves the read-only attributes live from `GetBrowser`.
 *
 * Custom, user-created browsers are a DIFFERENT CFn type
 * (`AWS::BedrockAgentCore::BrowserCustom`, FULLY_MUTABLE) which Cloud
 * Control handles; the `CreateBrowser` / `DeleteBrowser` control-plane ops
 * belong to that type's lifecycle, not this one's.
 */
import {
  BedrockAgentCoreControlClient,
  GetBrowserCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/** The only valid browser id for this type per the CFn schema pattern. */
export const DEFAULT_BROWSER_ID = 'aws.browser.v1';

/**
 * AWS BedrockAgentCore default-Browser Provider (adopt-only).
 */
export class AgentCoreBrowserProvider implements ResourceProvider {
  private client: BedrockAgentCoreControlClient;
  private logger = getLogger().child('AgentCoreBrowserProvider');

  // Every CFn schema property on this type is read-only (AWS-managed), so
  // there is nothing to wire into create/update. The explicit empty array
  // literal (not a bare `new Set()`) keeps the declaration parseable by
  // scripts/gen-property-coverage.ts.
  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::BedrockAgentCore::Browser', new Set<string>([])],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.client = awsClients.bedrockAgentCoreControl;
  }

  /**
   * "Create" = adopt the AWS-managed default browser: verify it exists in
   * the deploy region and record its ARN (the CFn primaryIdentifier) as the
   * physical id. Nothing is created in AWS.
   */
  async create(
    logicalId: string,
    resourceType: string,
    _properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Adopting AWS-managed default browser for ${logicalId}`);

    try {
      const response = await this.client.send(
        new GetBrowserCommand({ browserId: DEFAULT_BROWSER_ID })
      );

      const browserArn = response.browserArn!;
      this.logger.debug(`Adopted default browser ${DEFAULT_BROWSER_ID} (${browserArn})`);

      return {
        physicalId: browserArn,
        attributes: {
          BrowserArn: browserArn,
          BrowserId: response.browserId ?? DEFAULT_BROWSER_ID,
          Name: response.name ?? '',
          Status: response.status ?? '',
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to adopt the AWS-managed default browser for ${logicalId}: ${error instanceof Error ? error.message : String(error)}. ` +
          `Bedrock AgentCore may not be available in this region.`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Every property on this type is read-only, so there is nothing to
   * update — keep the existing physical id.
   */
  async update(
    logicalId: string,
    physicalId: string,
    _resourceType: string,
    _properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`No-op update for default browser ${logicalId}`);
    return { physicalId, wasReplaced: false, attributes: {} };
  }

  /**
   * The default browser is AWS-owned; destroying a stack must never delete
   * it. Pure no-op.
   */
  async delete(logicalId: string, _physicalId: string, _resourceType: string): Promise<void> {
    this.logger.debug(`No-op delete for AWS-managed default browser ${logicalId}`);
  }

  /**
   * Get resource attribute (for Fn::GetAtt resolution). The CFn read-only
   * attribute set is BrowserArn / BrowserId / Name / Status.
   */
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName === 'BrowserArn') {
      return physicalId;
    }
    if (attributeName === 'BrowserId') {
      return DEFAULT_BROWSER_ID;
    }
    if (attributeName === 'Name' || attributeName === 'Status') {
      const response = await this.client.send(
        new GetBrowserCommand({ browserId: DEFAULT_BROWSER_ID })
      );
      return attributeName === 'Name' ? response.name : response.status;
    }

    throw new Error(`Unsupported attribute: ${attributeName} for AWS::BedrockAgentCore::Browser`);
  }

  /** No managed properties → nothing can drift. */
  async readCurrentState(): Promise<Record<string, unknown>> {
    return {};
  }

  /**
   * Import: the type is a singleton pointing at the AWS-managed default
   * browser, so auto-lookup is trivial — resolve it live via `GetBrowser`
   * (no `--resource` override needed; a supplied override is ignored in
   * favor of the live ARN, which is the only valid physical id).
   */
  async import(_input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const response = await this.client.send(
      new GetBrowserCommand({ browserId: DEFAULT_BROWSER_ID })
    );
    return {
      physicalId: response.browserArn!,
      attributes: {
        BrowserArn: response.browserArn!,
        BrowserId: response.browserId ?? DEFAULT_BROWSER_ID,
        Name: response.name ?? '',
        Status: response.status ?? '',
      },
    };
  }
}
