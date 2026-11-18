import {
  type CloudWatchLogsClient,
  CreateDeliveryCommand,
  DeleteDeliveryCommand,
  GetDeliveryCommand,
  UpdateDeliveryConfigurationCommand,
  DescribeDeliveriesCommand,
  type DescribeDeliveriesResponse,
  type Delivery,
  type S3DeliveryConfiguration,
} from '@aws-sdk/client-cloudwatch-logs';
import { isDeepStrictEqual } from 'node:util';
import { getLogger } from '../../utils/logger.js';
import { safeMsg } from '../../utils/display-safe.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
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
  isStateBorne,
  readTags,
  reconcileTags,
  tagMap,
  wrapLogsError,
} from './logs-delivery/shared.js';

const WHAT = 'CloudWatch Logs delivery';

/** The members `UpdateDeliveryConfiguration` changes in place. */
const CONFIG_KEYS = [
  'RecordFields',
  'FieldDelimiter',
  'S3SuffixPath',
  'S3EnableHiveCompatiblePath',
] as const;

/**
 * CloudWatch Logs Delivery Provider
 *
 * Implements `AWS::Logs::Delivery` (the link between a delivery source and a
 * delivery destination) with `CreateDelivery` / `GetDelivery` /
 * `UpdateDeliveryConfiguration` / `DeleteDelivery`. Synchronous calls, so no
 * Cloud Control polling; also the route that works against the AWS Emulator.
 *
 * **Physical id is the AWS-generated delivery id** (`DeliveryId`, the
 * schema's primaryIdentifier and what `Ref` returns). `DeliverySourceName` and
 * `DeliveryDestinationArn` are create-only, so a change is a replacement.
 *
 * **Update** sends `RecordFields`, `FieldDelimiter` and the S3 options through
 * `UpdateDeliveryConfiguration`. That call cannot clear a value: a member the
 * template removes keeps its live value, and the update warns about it. Tags go
 * through `TagResource` / `UntagResource` on the delivery ARN.
 */
export class LogsDeliveryProvider implements ResourceProvider {
  private client: CloudWatchLogsClient;
  private logger = getLogger().child('LogsDeliveryProvider');

  constructor() {
    this.client = getAwsClients().cloudWatchLogs;
  }

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Logs::Delivery',
      new Set([
        'DeliverySourceName',
        'DeliveryDestinationArn',
        'RecordFields',
        'FieldDelimiter',
        'S3SuffixPath',
        'S3EnableHiveCompatiblePath',
        'Tags',
      ]),
    ],
  ]);

  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::Logs::Delivery',
      new Map([
        ['DeliveryId', 'AWS-managed read-only attribute (primaryIdentifier / physical id)'],
        ['Arn', 'AWS-managed read-only attribute'],
        ['DeliveryDestinationType', 'AWS-managed read-only attribute'],
      ]),
    ],
  ]);

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(safeMsg`Creating ${WHAT} ${logicalId}`);
    const reader = this.reader(properties, resourceType, logicalId, undefined, context);
    const deliverySourceName = reader.requiredString('DeliverySourceName');
    const deliveryDestinationArn = reader.requiredString('DeliveryDestinationArn');
    const config = readConfig(reader);
    const tags = tagMap(reader.tags());

    let createdId: string | undefined;
    try {
      const resp = await this.client.send(
        new CreateDeliveryCommand({
          deliverySourceName,
          deliveryDestinationArn,
          ...config,
          ...(tags && { tags }),
        })
      );
      createdId = resp.delivery?.id;
      if (!createdId) {
        throw new ProvisioningError(
          `CreateDelivery succeeded but returned no delivery id for ${logicalIdShown(logicalId)}`,
          resourceType,
          logicalId
        );
      }
      reportCreatedResource(logicalId, resourceType, createdId);
      return { physicalId: createdId, attributes: deliveryAttributes(resp.delivery) };
    } catch (error) {
      const thrown = this.wrapError('create', logicalId, resourceType, createdId, error);
      if (createdId) markCreatedBeforeFailure(thrown, logicalId, resourceType, createdId);
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
    const config = readConfig(reader);
    const changed = CONFIG_KEYS.filter(
      (key) => !isDeepStrictEqual(properties[key], previousProperties[key])
    );
    const removed = changed.filter((key) => properties[key] === undefined);
    if (removed.length > 0) {
      this.logger.warn(
        safeMsg`${WHAT} ${logicalId}: ${removed.join(', ')} removed from the template keeps its ` +
          'current value: UpdateDeliveryConfiguration cannot clear it. Replace the delivery to reset it.'
      );
    }
    const sendConfig = changed.length > removed.length;
    try {
      if (sendConfig) {
        await this.client.send(
          new UpdateDeliveryConfigurationCommand({ id: physicalId, ...config })
        );
      }
      const delivery = (await this.client.send(new GetDeliveryCommand({ id: physicalId })))
        .delivery;
      if (!delivery?.arn) {
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
        delivery.arn,
        resourceType,
        logicalId,
        properties['Tags'],
        previousProperties['Tags']
      );
      return { physicalId, wasReplaced: false, attributes: deliveryAttributes(delivery) };
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
      await this.client.send(new DeleteDeliveryCommand({ id: physicalId }));
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
      throw this.wrapError('delete', logicalId, resourceType, physicalId, error);
    }
  }

  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName === 'DeliveryId') return physicalId;
    const resp = await this.client.send(new GetDeliveryCommand({ id: physicalId }));
    return deliveryAttributes(resp.delivery)[attributeName];
  }

  /**
   * Adopt an existing delivery: the `--resource` override (a delivery id),
   * verified with `GetDelivery`, else the delivery linking the template's
   * `DeliverySourceName` to its `DeliveryDestinationArn` (AWS allows one per
   * pair), found with `DescribeDeliveries`.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      try {
        const resp = await this.client.send(new GetDeliveryCommand({ id: input.knownPhysicalId }));
        if (!resp.delivery?.id) return null;
        return { physicalId: resp.delivery.id, attributes: deliveryAttributes(resp.delivery) };
      } catch (error) {
        if (isLogsNotFound(error)) return null;
        throw error;
      }
    }
    const props = input.properties ?? {};
    const sourceName = props['DeliverySourceName'];
    const destinationArn = props['DeliveryDestinationArn'];
    if (typeof sourceName !== 'string' || typeof destinationArn !== 'string') return null;
    let nextToken: string | undefined;
    do {
      const page: DescribeDeliveriesResponse = await this.client.send(
        new DescribeDeliveriesCommand({ deliverySourceNames: [sourceName], nextToken })
      );
      for (const delivery of page.deliveries ?? []) {
        if (
          delivery.id &&
          delivery.deliverySourceName === sourceName &&
          delivery.deliveryDestinationArn === destinationArn
        ) {
          return { physicalId: delivery.id, attributes: deliveryAttributes(delivery) };
        }
      }
      nextToken = page.nextToken;
    } while (nextToken);
    return null;
  }

  /** Read the live delivery for `cdkd drift`, in the CFn shape. */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    let delivery: Delivery | undefined;
    try {
      delivery = (await this.client.send(new GetDeliveryCommand({ id: physicalId }))).delivery;
    } catch (error) {
      if (isLogsNotFound(error)) return RESOURCE_NOT_FOUND;
      throw error;
    }
    if (!delivery) return RESOURCE_NOT_FOUND;
    const result: Record<string, unknown> = {};
    if (delivery.deliverySourceName !== undefined) {
      result['DeliverySourceName'] = delivery.deliverySourceName;
    }
    if (delivery.deliveryDestinationArn !== undefined) {
      result['DeliveryDestinationArn'] = delivery.deliveryDestinationArn;
    }
    if (delivery.recordFields !== undefined) result['RecordFields'] = [...delivery.recordFields];
    if (delivery.fieldDelimiter !== undefined) result['FieldDelimiter'] = delivery.fieldDelimiter;
    const s3 = delivery.s3DeliveryConfiguration;
    if (s3?.suffixPath !== undefined) result['S3SuffixPath'] = s3.suffixPath;
    if (s3?.enableHiveCompatiblePath !== undefined) {
      result['S3EnableHiveCompatiblePath'] = s3.enableHiveCompatiblePath;
    }
    if (delivery.arn) {
      try {
        result['Tags'] = await readTags(this.client, delivery.arn);
      } catch (error) {
        if (isLogsNotFound(error)) return RESOURCE_NOT_FOUND;
        throw error;
      }
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
}

/** The configuration members as the `CreateDelivery` / `UpdateDeliveryConfiguration` request spells them. */
function readConfig(reader: PropertyReader): {
  recordFields?: string[];
  fieldDelimiter?: string;
  s3DeliveryConfiguration?: S3DeliveryConfiguration;
} {
  const recordFields = reader.optionalStringList('RecordFields');
  const fieldDelimiter = reader.optionalString('FieldDelimiter');
  const suffixPath = reader.optionalString('S3SuffixPath');
  const hive = reader.optionalBoolean('S3EnableHiveCompatiblePath');
  const s3: S3DeliveryConfiguration = {
    ...(suffixPath !== undefined && { suffixPath }),
    ...(hive !== undefined && { enableHiveCompatiblePath: hive }),
  };
  return {
    ...(recordFields !== undefined && { recordFields }),
    ...(fieldDelimiter !== undefined && { fieldDelimiter }),
    ...(Object.keys(s3).length > 0 && { s3DeliveryConfiguration: s3 }),
  };
}

function deliveryAttributes(delivery: Delivery | undefined): Record<string, unknown> {
  return definedAttributes({
    DeliveryId: delivery?.id,
    Arn: delivery?.arn,
    DeliveryDestinationType: delivery?.deliveryDestinationType,
  });
}
