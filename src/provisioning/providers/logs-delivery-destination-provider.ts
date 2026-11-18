import {
  type CloudWatchLogsClient,
  DeleteDeliveryDestinationCommand,
  DeleteDeliveryDestinationPolicyCommand,
  GetDeliveryDestinationCommand,
  GetDeliveryDestinationPolicyCommand,
  PutDeliveryDestinationCommand,
  PutDeliveryDestinationPolicyCommand,
  type DeliveryDestination,
  type DeliveryDestinationType,
  type OutputFormat,
} from '@aws-sdk/client-cloudwatch-logs';
import { getLogger } from '../../utils/logger.js';
import { safeMsg } from '../../utils/display-safe.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { markNonRetryable } from '../../deployment/retryable-errors.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { resolveExplicitPhysicalId } from '../import-helpers.js';
import { logicalIdShown } from '../composite-id.js';
import { markCreatedBeforeFailure } from '../auxiliary-failure.js';
import { reportCreatedResource } from '../created-resource-sink.js';
import { definedAttributes } from '../attribute-map.js';
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
import {
  PropertyReader,
  isLogsNotFound,
  isPlainRecord,
  isStateBorne,
  readTags,
  reconcileTags,
  tagMap,
  wrapLogsError,
} from './logs-delivery/shared.js';

const WHAT = 'CloudWatch Logs delivery destination';

/**
 * CloudWatch Logs Delivery Destination Provider
 *
 * Implements `AWS::Logs::DeliveryDestination` with `PutDeliveryDestination` /
 * `GetDeliveryDestination` / `DeleteDeliveryDestination`, plus
 * `Put/Get/DeleteDeliveryDestinationPolicy` for `DeliveryDestinationPolicy`.
 * Synchronous calls, so no Cloud Control polling; also the route that works
 * against the AWS Emulator, whose Cloud Control reports a destination created
 * without making one.
 *
 * **Physical id is the destination `Name`** (the schema's primaryIdentifier,
 * what `Ref` returns). `Name`, `DestinationResourceArn`,
 * `DeliveryDestinationType` and `OutputFormat` are create-only, so update
 * changes only `Tags` and `DeliveryDestinationPolicy`.
 *
 * **Create refuses an existing name**: `PutDeliveryDestination` is an upsert
 * and would otherwise take over another stack's destination.
 */
export class LogsDeliveryDestinationProvider implements ResourceProvider {
  private client: CloudWatchLogsClient;
  private logger = getLogger().child('LogsDeliveryDestinationProvider');

  constructor() {
    this.client = getAwsClients().cloudWatchLogs;
  }

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Logs::DeliveryDestination',
      new Set([
        'Name',
        'DestinationResourceArn',
        'DeliveryDestinationType',
        'OutputFormat',
        'DeliveryDestinationPolicy',
        'Tags',
      ]),
    ],
  ]);

  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    ['AWS::Logs::DeliveryDestination', new Map([['Arn', 'AWS-managed read-only attribute']])],
  ]);

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(safeMsg`Creating ${WHAT} ${logicalId}`);
    const reader = this.reader(properties, resourceType, logicalId, undefined, context);
    const name = reader.requiredString('Name');
    const destinationArn = reader.optionalString('DestinationResourceArn');
    const destinationType = reader.optionalString('DeliveryDestinationType');
    const outputFormat = reader.optionalString('OutputFormat');
    const tags = tagMap(reader.tags());
    const policy = this.readPolicy(properties, name, resourceType, logicalId, undefined, context);

    let created = false;
    try {
      await this.refuseExisting(name, resourceType, logicalId);
      const resp = await this.client.send(
        new PutDeliveryDestinationCommand({
          name,
          ...(destinationArn !== undefined && {
            deliveryDestinationConfiguration: { destinationResourceArn: destinationArn },
          }),
          ...(destinationType !== undefined && {
            deliveryDestinationType: destinationType as DeliveryDestinationType,
          }),
          ...(outputFormat !== undefined && { outputFormat: outputFormat as OutputFormat }),
          ...(tags && { tags }),
        })
      );
      created = true;
      reportCreatedResource(logicalId, resourceType, name);
      if (policy !== undefined) {
        await this.client.send(
          new PutDeliveryDestinationPolicyCommand({
            deliveryDestinationName: name,
            deliveryDestinationPolicy: policy,
          })
        );
      }
      return { physicalId: name, attributes: destinationAttributes(resp.deliveryDestination) };
    } catch (error) {
      const thrown = this.wrapError('create', logicalId, resourceType, name, error);
      // The destination exists once PutDeliveryDestination returned; name it
      // for --revert-failed when the policy call after it failed.
      if (created) markCreatedBeforeFailure(thrown, logicalId, resourceType, name);
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
    assertRegionMatch(
      context?.expectedRegion ? await this.client.config.region() : undefined,
      context?.expectedRegion,
      resourceType,
      logicalId,
      physicalId,
      'pre-update'
    );
    const reader = this.reader(properties, resourceType, logicalId, physicalId, context);
    reader.tags();
    const policy = this.readPolicy(
      properties,
      physicalId,
      resourceType,
      logicalId,
      physicalId,
      context
    );
    const previousPolicy = policyDocument(previousProperties['DeliveryDestinationPolicy']);
    try {
      const destination = (
        await this.client.send(new GetDeliveryDestinationCommand({ name: physicalId }))
      ).deliveryDestination;
      if (!destination?.arn) {
        throw new ProvisioningError(
          `${WHAT} ${logicalIdShown(logicalId)} returned no ARN`,
          resourceType,
          logicalId,
          physicalId
        );
      }
      await reconcileTags(
        this.client,
        this.logger,
        destination.arn,
        resourceType,
        logicalId,
        properties['Tags'],
        previousProperties['Tags']
      );
      if (policy !== undefined && policy !== previousPolicy) {
        await this.client.send(
          new PutDeliveryDestinationPolicyCommand({
            deliveryDestinationName: physicalId,
            deliveryDestinationPolicy: policy,
          })
        );
      } else if (
        properties['DeliveryDestinationPolicy'] === undefined &&
        previousProperties['DeliveryDestinationPolicy'] !== undefined
      ) {
        try {
          await this.client.send(
            new DeleteDeliveryDestinationPolicyCommand({ deliveryDestinationName: physicalId })
          );
        } catch (error) {
          if (!isLogsNotFound(error)) throw error;
        }
      }
      return {
        physicalId,
        wasReplaced: false,
        attributes: destinationAttributes(destination),
      };
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
    this.logger.debug(safeMsg`Deleting ${WHAT} ${logicalId}`);
    try {
      await this.client.send(new DeleteDeliveryDestinationCommand({ name: physicalId }));
    } catch (error) {
      if (isLogsNotFound(error)) {
        assertRegionMatch(
          await this.client.config.region(),
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(safeMsg`${WHAT} ${logicalId} does not exist, skipping deletion`);
        return;
      }
      // A destination a delivery still uses is refused with ConflictException;
      // the DAG deletes the delivery first.
      throw this.wrapError('delete', logicalId, resourceType, physicalId, error);
    }
  }

  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    const resp = await this.client.send(new GetDeliveryDestinationCommand({ name: physicalId }));
    return destinationAttributes(resp.deliveryDestination)[attributeName];
  }

  /**
   * Adopt an existing destination by the `--resource` override or the
   * template's `Name`, verified with `GetDeliveryDestination`. `Name` is
   * required, so there is no tag-based lookup.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const name = resolveExplicitPhysicalId(input, 'Name');
    if (!name) return null;
    try {
      const resp = await this.client.send(new GetDeliveryDestinationCommand({ name }));
      if (!resp.deliveryDestination?.name) return null;
      return {
        physicalId: resp.deliveryDestination.name,
        attributes: destinationAttributes(resp.deliveryDestination),
      };
    } catch (error) {
      if (isLogsNotFound(error)) return null;
      throw error;
    }
  }

  /** Read the live destination for `cdkd drift`, in the CFn shape. */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    let destination: DeliveryDestination | undefined;
    try {
      destination = (
        await this.client.send(new GetDeliveryDestinationCommand({ name: physicalId }))
      ).deliveryDestination;
    } catch (error) {
      if (isLogsNotFound(error)) return RESOURCE_NOT_FOUND;
      throw error;
    }
    if (!destination) return RESOURCE_NOT_FOUND;
    const result: Record<string, unknown> = {};
    if (destination.name !== undefined) result['Name'] = destination.name;
    const destinationArn = destination.deliveryDestinationConfiguration?.destinationResourceArn;
    if (destinationArn !== undefined) result['DestinationResourceArn'] = destinationArn;
    if (destination.deliveryDestinationType !== undefined) {
      result['DeliveryDestinationType'] = destination.deliveryDestinationType;
    }
    if (destination.outputFormat !== undefined) result['OutputFormat'] = destination.outputFormat;
    try {
      const policy = (
        await this.client.send(
          new GetDeliveryDestinationPolicyCommand({ deliveryDestinationName: physicalId })
        )
      ).policy?.deliveryDestinationPolicy;
      if (policy !== undefined && policy !== '') {
        const declared = properties?.['DeliveryDestinationPolicy'];
        result['DeliveryDestinationPolicy'] = {
          // Echo the name member only where the record declares it.
          ...(isPlainRecord(declared) &&
            declared['DeliveryDestinationName'] !== undefined && {
              DeliveryDestinationName: physicalId,
            }),
          DeliveryDestinationPolicy: parsePolicy(policy),
        };
      }
      if (destination.arn) result['Tags'] = await readTags(this.client, destination.arn);
    } catch (error) {
      if (isLogsNotFound(error)) return RESOURCE_NOT_FOUND;
      throw error;
    }
    return result;
  }

  // -- helpers -------------------------------------------------------------

  /** A failed operation as the `ProvisioningError` it throws ({@link wrapLogsError}). */
  private wrapError(
    operation: string,
    logicalId: string,
    resourceType: string,
    physicalId: string | undefined,
    error: unknown
  ): ProvisioningError {
    if (error instanceof ProvisioningError) return error;
    return wrapLogsError(this.logger, WHAT, operation, logicalId, resourceType, physicalId, error);
  }

  private reader(
    properties: Record<string, unknown>,
    resourceType: string,
    logicalId: string,
    physicalId: string | undefined,
    context?: CreateContext | UpdateContext
  ): PropertyReader {
    return new PropertyReader(
      properties,
      WHAT,
      resourceType,
      logicalId,
      physicalId,
      this.logger,
      isStateBorne(context)
    );
  }

  /**
   * `DeliveryDestinationPolicy` as the policy JSON `PutDeliveryDestinationPolicy`
   * takes, or `undefined` when absent. The block's `DeliveryDestinationName`,
   * when declared, must name this destination: the policy is attached to the
   * destination being deployed, and a policy on another one would outlive it.
   * A malformed block is refused on a template path and omitted with a
   * warning on a state-borne bag.
   */
  private readPolicy(
    properties: Record<string, unknown>,
    name: string,
    resourceType: string,
    logicalId: string,
    physicalId: string | undefined,
    context?: CreateContext | UpdateContext
  ): string | undefined {
    const block = properties['DeliveryDestinationPolicy'];
    if (block === undefined) return undefined;
    let problem: string | undefined;
    const document = policyDocument(block);
    if (!isPlainRecord(block)) {
      problem = 'DeliveryDestinationPolicy must be an object';
    } else if (
      block['DeliveryDestinationName'] !== undefined &&
      block['DeliveryDestinationName'] !== name
    ) {
      problem = 'DeliveryDestinationPolicy.DeliveryDestinationName must equal the destination Name';
    } else if (document === undefined) {
      problem =
        'DeliveryDestinationPolicy.DeliveryDestinationPolicy must be a policy document object or JSON string';
    }
    if (problem === undefined) return document;
    const message = `${problem} for ${WHAT} ${logicalIdShown(logicalId)}`;
    if (isStateBorne(context)) {
      this.logger.warn(safeMsg`${message}; omitting it while applying a state-borne bag`);
      return undefined;
    }
    throw new ProvisioningError(message, resourceType, logicalId, physicalId);
  }

  /** Refuse a create whose name is already a destination (an upsert would take it over). */
  private async refuseExisting(name: string, resourceType: string, logicalId: string) {
    try {
      await this.client.send(new GetDeliveryDestinationCommand({ name }));
    } catch (error) {
      if (isLogsNotFound(error)) return;
      throw error;
    }
    throw markNonRetryable(
      new ProvisioningError(
        `${WHAT} ${logicalIdShown(logicalId)} cannot be created: a delivery destination with its ` +
          'Name already exists in this account and region. Delete it, choose another Name, or ' +
          'adopt it with `cdkd import`.',
        resourceType,
        logicalId
      )
    );
  }
}

/** The policy JSON a `DeliveryDestinationPolicy` block carries, or `undefined` when unusable. */
function policyDocument(block: unknown): string | undefined {
  if (!isPlainRecord(block)) return undefined;
  const document = block['DeliveryDestinationPolicy'];
  if (typeof document === 'string' && document !== '') return document;
  if (isPlainRecord(document)) return JSON.stringify(document);
  return undefined;
}

/** The live policy as an object (the CFn shape), or the raw text when it is not JSON. */
function parsePolicy(policy: string): unknown {
  try {
    return JSON.parse(policy) as unknown;
  } catch {
    return policy;
  }
}

function destinationAttributes(
  destination: DeliveryDestination | undefined
): Record<string, unknown> {
  return definedAttributes({
    Arn: destination?.arn,
    DeliveryDestinationType: destination?.deliveryDestinationType,
  });
}
