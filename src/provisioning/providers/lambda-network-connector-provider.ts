import {
  LambdaCoreClient,
  CreateNetworkConnectorCommand,
  GetNetworkConnectorCommand,
  UpdateNetworkConnectorCommand,
  DeleteNetworkConnectorCommand,
  ResourceNotFoundException,
  type CreateNetworkConnectorRequest,
  type GetNetworkConnectorResponse,
  type NetworkProtocol,
  type ComputeResourceType,
} from '@aws-sdk/client-lambda-core';
import {
  LambdaClient,
  TagResourceCommand,
  UntagResourceCommand,
  ListTagsCommand,
  ResourceNotFoundException as LambdaResourceNotFoundException,
} from '@aws-sdk/client-lambda';
import { randomUUID } from 'node:crypto';
import { getLogger } from '../../utils/logger.js';
import { safeMsg } from '../../utils/display-safe.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { normalizeAwsTagsToCfn } from '../import-helpers.js';
import { logicalIdShown } from '../composite-id.js';
import { markCreatedBeforeFailure } from '../auxiliary-failure.js';
import { definedAttributes } from '../attribute-map.js';
import { generateResourceName } from '../resource-name.js';
import { planTagDiff, tagPlanWarning, refuseMalformedDesiredTags } from '../tag-list.js';
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
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import { isPlainRecord, sleep } from './lambda-web-function-arns.js';
import { acquireIdempotencyToken } from './idempotency-token.js';
import { markNonRetryable } from '../../deployment/retryable-errors.js';

/** One poll a second: the connector settles in minutes, and a quick read costs nothing. */
const POLL_INTERVAL_MS = 1000;
/** Twenty minutes: measured creates take about 4. */
const MAX_POLL_ATTEMPTS = 1200;

/**
 * AWS Lambda Network Connector Provider (go-to-k/cdkd#4928)
 *
 * Implements `AWS::Lambda::NetworkConnector` through the dedicated Lambda Core
 * service SDK (`@aws-sdk/client-lambda-core`). A connector is the VPC egress
 * path Lambda Web Functions and MicroVM images share.
 *
 * **Create waits for `ACTIVE` in every mode.** AWS refuses a web function
 * revision naming a connector still `PENDING`, so returning early would only
 * fail the next resource (docs/cli-deploy-waits.md). Measured: about 254 s
 * from the create call; the direct poll notices `ACTIVE` within a second,
 * where Cloud Control reported it about 3 s later and cdkd's backoff on that
 * report added more. The delete settles in about 3 s, against 12.6 s through
 * Cloud Control.
 *
 * **Physical id is the connector ARN** (`primaryIdentifier` =
 * `/properties/Arn`), the id Cloud Control records too.
 *
 * **The create is idempotent.** `CreateNetworkConnector` takes a
 * `ClientToken`, and a resend with the same token returns the same connector
 * (measured). The token is memoised per logical id for the deploy
 * (`acquireIdempotencyToken`), so neither the SDK's retries nor the engine's
 * re-run of a create whose response was lost makes a second one. A connector
 * `Name` is unique per account and region: a create that collides fails with
 * the service's conflict and nothing is adopted.
 *
 * **Tags go through Lambda's tagging API** (`TagResource` / `UntagResource` /
 * `ListTags` on the connector ARN), which is where the Cloud Control handler
 * sends them; Lambda Core has no tagging calls.
 */
export class LambdaNetworkConnectorProvider implements ResourceProvider {
  private client: LambdaCoreClient;
  private lambda: LambdaClient;
  private logger = getLogger().child('LambdaNetworkConnectorProvider');

  constructor() {
    const clients = getAwsClients();
    this.client = clients.lambdaCore;
    this.lambda = clients.lambda;
  }

  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::Lambda::NetworkConnector', new Set(['Name', 'Configuration', 'OperatorRole', 'Tags'])],
  ]);

  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::Lambda::NetworkConnector',
      new Map([
        ['Arn', 'AWS-managed read-only attribute (primaryIdentifier / physical id)'],
        ['State', 'AWS-managed read-only attribute'],
        ['LatestVersionArn', 'AWS-managed read-only attribute'],
        ['LatestVersion', 'AWS-managed read-only attribute'],
      ]),
    ],
  ]);

  getMinResourceTimeoutMs(): number {
    return MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS;
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(safeMsg`Creating Lambda network connector ${logicalId}`);
    const tagList = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);
    const name =
      typeof properties['Name'] === 'string' && properties['Name'] !== ''
        ? properties['Name']
        : generateResourceName(logicalId, { maxLength: 64 });
    const vpc = this.readVpcEgress(properties, logicalId, resourceType, undefined);
    // Memoised per logical id for the deploy, so the engine's own retry of a
    // create whose response was lost resends the SAME token and gets the same
    // connector back, instead of a new token that collides on the Name.
    const createToken = acquireIdempotencyToken({ scope: 'CreateNetworkConnector', logicalId });
    const input: CreateNetworkConnectorRequest = {
      Name: name,
      Configuration: {
        VpcEgressConfiguration: {
          SubnetIds: vpc.SubnetIds,
          SecurityGroupIds: vpc.SecurityGroupIds,
          NetworkProtocol: vpc.NetworkProtocol,
          AssociatedComputeResourceTypes: vpc.AssociatedComputeResourceTypes,
        },
      },
      ClientToken: createToken.value,
    };
    const operatorRole = this.readOperatorRole(
      properties,
      logicalId,
      resourceType,
      undefined,
      context
    );
    if (operatorRole !== undefined) input.OperatorRole = operatorRole;
    if (tagList.length > 0) input.Tags = Object.fromEntries(tagList.map((t) => [t.Key, t.Value]));

    let createdArn: string | undefined;
    try {
      const response = await this.client.send(new CreateNetworkConnectorCommand(input));
      createdArn = response.Arn;
      if (!createdArn) {
        throw new ProvisioningError(
          `CreateNetworkConnector succeeded but returned no ARN for ${logicalIdShown(logicalId)}`,
          resourceType,
          logicalId
        );
      }
      const settled = await this.waitForSettled(createdArn, logicalId, 'create');
      createToken.release();
      return { physicalId: createdArn, attributes: buildAttributes(settled) };
    } catch (error) {
      const thrown = this.wrapError('create', logicalId, resourceType, undefined, error);
      // A connector that ended in a terminal state is unusable, and a retry
      // would resend the same token and be handed it back, so the failure is
      // final for this deploy. It is NOT deleted here: a FAILED connector was
      // measured to sit in DELETING for over an hour, so the create would
      // block that long before failing anyway. It is marked for
      // --revert-failed below, as a Cloud Control create would leave it.
      if (error instanceof TerminalConnectorStateError) markNonRetryable(thrown);
      // The connector exists once CreateNetworkConnector returned its ARN;
      // name it for --revert-failed (go-to-k/cdkd#4583).
      if (createdArn) markCreatedBeforeFailure(thrown, logicalId, resourceType, createdArn);
      throw thrown;
    }
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    // `Name` is create-only (the committed create-only snapshot), so a change
    // is a replacement and never reaches here; UpdateNetworkConnector takes no
    // name either.
    // go-to-k/cdkd#2613: refuse a wrong-region client before any write.
    assertRegionMatch(
      context?.expectedRegion ? await this.client.config.region() : undefined,
      context?.expectedRegion,
      resourceType,
      logicalId,
      physicalId,
      'pre-update'
    );
    refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
    // Refused before any write: the block is the whole connector.
    const vpc = this.readVpcEgress(properties, logicalId, resourceType, physicalId);
    const updateRole = this.readOperatorRole(
      properties,
      logicalId,
      resourceType,
      physicalId,
      context
    );
    // UpdateNetworkConnector has no way to say "no role": an omitted
    // OperatorRole is simply not sent, so a template that drops it would deploy
    // "successfully" with the old role still attached. Refused on the template
    // path; a state-borne bag leaves the live role as it is.
    if (
      typeof previousProperties['OperatorRole'] === 'string' &&
      properties['OperatorRole'] === undefined &&
      context?.replayingState !== true &&
      context?.desiredFromAwsReadback !== true
    ) {
      throw new ProvisioningError(
        `OperatorRole cannot be removed in place for Lambda network connector ${logicalIdShown(logicalId)}: ` +
          'cdkd sends no role when the template declares none, so the current one would stay attached. ' +
          'Set it to another role, or replace the connector (change its Name).',
        resourceType,
        logicalId,
        physicalId
      );
    }
    try {
      const configChanged =
        JSON.stringify(properties['Configuration']) !==
          JSON.stringify(previousProperties['Configuration']) ||
        properties['OperatorRole'] !== previousProperties['OperatorRole'];
      // Tags first, before a configuration update puts the connector in
      // InProgress (the MicroVM image provider's order).
      await this.reconcileTags(
        physicalId,
        resourceType,
        logicalId,
        properties['Tags'],
        previousProperties['Tags']
      );
      if (configChanged) {
        await this.client.send(
          new UpdateNetworkConnectorCommand({
            Identifier: physicalId,
            Configuration: {
              VpcEgressConfiguration: {
                SubnetIds: vpc.SubnetIds,
                SecurityGroupIds: vpc.SecurityGroupIds,
                NetworkProtocol: vpc.NetworkProtocol,
                AssociatedComputeResourceTypes: vpc.AssociatedComputeResourceTypes,
              },
            },
            ...(updateRole !== undefined ? { OperatorRole: updateRole } : {}),
            ClientToken: randomUUID(),
          })
        );
      }
      const settled = configChanged
        ? await this.waitForSettled(physicalId, logicalId, 'update')
        : await this.client.send(new GetNetworkConnectorCommand({ Identifier: physicalId }));
      return { physicalId, wasReplaced: false, attributes: buildAttributes(settled) };
    } catch (error) {
      throw this.wrapError('update', logicalId, resourceType, physicalId, error);
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(safeMsg`Deleting Lambda network connector ${logicalId}`);
    try {
      try {
        await this.client.send(new DeleteNetworkConnectorCommand({ Identifier: physicalId }));
      } catch (error) {
        if (error instanceof ResourceNotFoundException) {
          assertRegionMatch(
            await this.client.config.region(),
            context?.expectedRegion,
            resourceType,
            logicalId,
            physicalId
          );
          this.logger.debug(
            safeMsg`Lambda network connector ${logicalId} does not exist, skipping deletion`
          );
          return;
        }
        throw error;
      }
      await this.waitForGone(physicalId, logicalId);
    } catch (error) {
      throw this.wrapError('delete', logicalId, resourceType, physicalId, error);
    }
  }

  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName === 'Arn') return physicalId;
    const resp = await this.client.send(new GetNetworkConnectorCommand({ Identifier: physicalId }));
    return buildAttributes(resp)[attributeName];
  }

  /**
   * Adopt an existing connector: the `--resource` override (an ARN or a name,
   * both of which `GetNetworkConnector` takes), else the template's `Name`.
   * A connector with a generated name is found only by override.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const props = input.properties ?? {};
    const identifier =
      input.knownPhysicalId ?? (typeof props['Name'] === 'string' ? props['Name'] : undefined);
    if (!identifier) return null;
    try {
      const resp = await this.client.send(
        new GetNetworkConnectorCommand({ Identifier: identifier })
      );
      if (!resp.Arn) return null;
      return { physicalId: resp.Arn, attributes: buildAttributes(resp) };
    } catch (error) {
      if (error instanceof ResourceNotFoundException) return null;
      throw error;
    }
  }

  /** Read the live connector for `cdkd drift`, in the CFn shape. */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    let resp: GetNetworkConnectorResponse;
    try {
      resp = await this.client.send(new GetNetworkConnectorCommand({ Identifier: physicalId }));
    } catch (error) {
      if (error instanceof ResourceNotFoundException) return RESOURCE_NOT_FOUND;
      throw error;
    }
    const result: Record<string, unknown> = {};
    if (resp.Name !== undefined) result['Name'] = resp.Name;
    if (resp.OperatorRole !== undefined) result['OperatorRole'] = resp.OperatorRole;
    const vpc =
      resp.Configuration && 'VpcEgressConfiguration' in resp.Configuration
        ? resp.Configuration.VpcEgressConfiguration
        : undefined;
    if (vpc) {
      const VpcEgressConfiguration: Record<string, unknown> = {};
      if (vpc.SubnetIds !== undefined) VpcEgressConfiguration['SubnetIds'] = [...vpc.SubnetIds];
      if (vpc.SecurityGroupIds !== undefined) {
        VpcEgressConfiguration['SecurityGroupIds'] = [...vpc.SecurityGroupIds];
      }
      if (vpc.NetworkProtocol !== undefined) {
        VpcEgressConfiguration['NetworkProtocol'] = vpc.NetworkProtocol;
      }
      if (vpc.AssociatedComputeResourceTypes !== undefined) {
        VpcEgressConfiguration['AssociatedComputeResourceTypes'] = [
          ...vpc.AssociatedComputeResourceTypes,
        ];
      }
      result['Configuration'] = { VpcEgressConfiguration };
    }
    let tags;
    try {
      tags = await this.lambda.send(new ListTagsCommand({ Resource: physicalId }));
    } catch (error) {
      // The connector vanished between the two reads.
      if (error instanceof LambdaResourceNotFoundException) return RESOURCE_NOT_FOUND;
      throw error;
    }
    result['Tags'] = normalizeAwsTagsToCfn(tags.Tags);
    return result;
  }

  /** The list members AWS may return in any order. */
  getDriftUnorderedPaths(): string[] {
    return [
      'Configuration.VpcEgressConfiguration.SubnetIds',
      'Configuration.VpcEgressConfiguration.SecurityGroupIds',
      'Configuration.VpcEgressConfiguration.AssociatedComputeResourceTypes',
    ];
  }

  // -- helpers -------------------------------------------------------------

  /**
   * `Configuration.VpcEgressConfiguration`'s members, validated. The block
   * is required by the schema, so a missing or malformed block is refused on
   * every path: it is the whole connector, and no default is safe.
   */
  private readVpcEgress(
    properties: Record<string, unknown>,
    logicalId: string,
    resourceType: string,
    physicalId: string | undefined
  ): VpcEgressParts {
    const fail = (message: string): never => {
      throw new ProvisioningError(
        `${message} for Lambda network connector ${logicalIdShown(logicalId)}`,
        resourceType,
        logicalId,
        physicalId
      );
    };
    const config = properties['Configuration'];
    const vpc = isPlainRecord(config) ? config['VpcEgressConfiguration'] : undefined;
    if (!isPlainRecord(vpc)) return fail('Configuration.VpcEgressConfiguration must be an object');
    const strings = (key: string): string[] | undefined => {
      const value = vpc[key];
      if (value === undefined) return undefined;
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        return fail(`Configuration.VpcEgressConfiguration.${key} must be a list of strings`);
      }
      return [...(value as string[])];
    };
    const subnetIds = strings('SubnetIds');
    const securityGroupIds = strings('SecurityGroupIds');
    const types = strings('AssociatedComputeResourceTypes');
    const protocol = vpc['NetworkProtocol'];
    if (protocol !== undefined && typeof protocol !== 'string') {
      fail('Configuration.VpcEgressConfiguration.NetworkProtocol must be a string');
    }
    return {
      SubnetIds: subnetIds,
      SecurityGroupIds: securityGroupIds,
      NetworkProtocol: typeof protocol === 'string' ? (protocol as NetworkProtocol) : undefined,
      AssociatedComputeResourceTypes: types as ComputeResourceType[] | undefined,
    };
  }

  /**
   * `OperatorRole`, or `undefined` when absent. A declared non-string is
   * refused on a template path (sending none would leave the connector without
   * the role the template names) and omitted with a warning on a state-borne bag.
   */
  private readOperatorRole(
    properties: Record<string, unknown>,
    logicalId: string,
    resourceType: string,
    physicalId: string | undefined,
    context?: CreateContext | UpdateContext
  ): string | undefined {
    const role = properties['OperatorRole'];
    if (role === undefined || typeof role === 'string') return role;
    const message = `OperatorRole must be a string for Lambda network connector ${logicalIdShown(logicalId)}`;
    const stateBorne =
      context?.replayingState === true ||
      (context !== undefined &&
        'desiredFromAwsReadback' in context &&
        context.desiredFromAwsReadback === true);
    if (stateBorne) {
      this.logger.warn(safeMsg`${message}; omitting it while applying a state-borne bag`);
      return undefined;
    }
    throw new ProvisioningError(message, resourceType, logicalId, physicalId);
  }

  private async reconcileTags(
    physicalId: string,
    resourceType: string,
    logicalId: string,
    newTags: unknown,
    oldTags: unknown
  ): Promise<void> {
    const plan = planTagDiff(oldTags, newTags);
    const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
    if (tagWarning !== undefined) this.logger.warn(tagWarning);
    if (plan.remove.length > 0) {
      await this.lambda.send(
        new UntagResourceCommand({ Resource: physicalId, TagKeys: plan.remove })
      );
    }
    const toAdd: Record<string, string> = Object.fromEntries(plan.set);
    if (Object.keys(toAdd).length > 0) {
      await this.lambda.send(new TagResourceCommand({ Resource: physicalId, Tags: toAdd }));
    }
  }

  /**
   * Poll until the connector is `ACTIVE` with no update in progress. `FAILED`
   * (create) or a `Failed` last update is terminal and names AWS's reason.
   */
  private async waitForSettled(
    arn: string,
    logicalId: string,
    operation: 'create' | 'update'
  ): Promise<GetNetworkConnectorResponse> {
    for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
      const resp = await this.client.send(new GetNetworkConnectorCommand({ Identifier: arn }));
      // None of these can turn ACTIVE again: fail now with AWS's reason rather
      // than at the 20-minute cap. DELETING / DELETE_FAILED mean the connector
      // was deleted out of band; INACTIVE is not ACTIVE either.
      if (
        resp.State === 'FAILED' ||
        resp.State === 'DELETING' ||
        resp.State === 'DELETE_FAILED' ||
        resp.State === 'INACTIVE'
      ) {
        throw new TerminalConnectorStateError(
          `Lambda network connector ${logicalIdShown(logicalId)} entered ${resp.State}: ` +
            `${resp.StateReason ?? resp.StateReasonCode ?? 'no reason given'}`
        );
      }
      if (operation === 'update' && resp.LastUpdateStatus === 'Failed') {
        throw new Error(
          `Lambda network connector ${logicalIdShown(logicalId)} update failed: ` +
            `${resp.LastUpdateStatusReason ?? resp.LastUpdateStatusReasonCode ?? 'no reason given'}`
        );
      }
      if (resp.State === 'ACTIVE' && resp.LastUpdateStatus !== 'InProgress') return resp;
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(
      `Lambda network connector ${logicalIdShown(logicalId)} did not finish ${operation} within ` +
        `${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s.`
    );
  }

  private async waitForGone(arn: string, logicalId: string): Promise<void> {
    for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
      let resp: GetNetworkConnectorResponse;
      try {
        resp = await this.client.send(new GetNetworkConnectorCommand({ Identifier: arn }));
      } catch (error) {
        if (error instanceof ResourceNotFoundException) return;
        throw error;
      }
      if (resp.State === 'DELETE_FAILED') {
        throw new Error(
          `Lambda network connector ${logicalIdShown(logicalId)} entered DELETE_FAILED: ` +
            `${resp.StateReason ?? resp.StateReasonCode ?? 'no reason given'}`
        );
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(
      `Lambda network connector ${logicalIdShown(logicalId)} was not fully deleted within ` +
        `${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s.`
    );
  }

  private wrapError(
    operation: string,
    logicalId: string,
    resourceType: string,
    physicalId: string | undefined,
    error: unknown
  ): ProvisioningError {
    if (error instanceof ProvisioningError) return error;
    const cause = error instanceof Error ? error : undefined;
    return new ProvisioningError(
      `Failed to ${operation} Lambda network connector ${logicalIdShown(logicalId)}: ${error instanceof Error ? error.message : String(error)}`,
      resourceType,
      logicalId,
      physicalId,
      cause
    );
  }
}

/** A wait ended in a state the connector cannot leave for ACTIVE. */
class TerminalConnectorStateError extends Error {}

/** The validated members of `Configuration.VpcEgressConfiguration`; absent stays `undefined`. */
interface VpcEgressParts {
  SubnetIds: string[] | undefined;
  SecurityGroupIds: string[] | undefined;
  NetworkProtocol: NetworkProtocol | undefined;
  AssociatedComputeResourceTypes: ComputeResourceType[] | undefined;
}

function buildAttributes(resp: GetNetworkConnectorResponse): Record<string, unknown> {
  return definedAttributes({
    Arn: resp.Arn,
    State: resp.State,
    LatestVersionArn: resp.LatestVersionArn,
    // Measured: GetNetworkConnector returns LatestVersionArn but no
    // LatestVersion, so the number is read off the ARN's `:<version>` suffix.
    LatestVersion: resp.LatestVersion ?? versionOfArn(resp.LatestVersionArn),
  });
}

/** The version number a qualified connector ARN ends with, or `undefined`. */
function versionOfArn(arn: string | undefined): number | undefined {
  const match = arn === undefined ? null : /:network-connector:[^:]+:(\d+)$/.exec(arn);
  return match ? Number(match[1]) : undefined;
}
