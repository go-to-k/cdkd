import {
  type CloudWatchLogsClient,
  DeleteDeliverySourceCommand,
  GetDeliverySourceCommand,
  PutDeliverySourceCommand,
  type DeliverySource,
} from '@aws-sdk/client-cloudwatch-logs';
import { isDeepStrictEqual } from 'node:util';
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

const WHAT = 'CloudWatch Logs delivery source';

/**
 * CloudWatch Logs Delivery Source Provider
 *
 * Implements `AWS::Logs::DeliverySource` with `PutDeliverySource` /
 * `GetDeliverySource` / `DeleteDeliverySource`. The calls are synchronous, so
 * the SDK route skips Cloud Control's polling, and it is the route that works
 * against the AWS Emulator, whose Cloud Control reports a delivery source
 * created without making one.
 *
 * **Physical id is the source `Name`**, the schema's primaryIdentifier and
 * what `Ref` returns. `Name` is create-only, so a rename is a replacement.
 *
 * **Create refuses an existing name.** `PutDeliverySource` is an upsert, so a
 * create without the `GetDeliverySource` probe would silently take over a
 * same-named source another stack owns; CloudFormation's create fails there too.
 *
 * **Update re-sends the source** (`ResourceArn`, `LogType`,
 * `DeliverySourceConfiguration`) only when one of them changed; AWS decides
 * whether the change is accepted in place. Tags go through
 * `TagResource` / `UntagResource` on the source ARN.
 */
export class LogsDeliverySourceProvider implements ResourceProvider {
  private client: CloudWatchLogsClient;
  private logger = getLogger().child('LogsDeliverySourceProvider');

  constructor() {
    this.client = getAwsClients().cloudWatchLogs;
  }

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Logs::DeliverySource',
      new Set(['Name', 'ResourceArn', 'LogType', 'Tags', 'DeliverySourceConfiguration']),
    ],
  ]);

  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::Logs::DeliverySource',
      new Map([
        ['Arn', 'AWS-managed read-only attribute'],
        ['ResourceArns', 'AWS-managed read-only attribute (the ResourceArn sent, as a list)'],
        ['Service', 'AWS-managed read-only attribute'],
        ['Status', 'AWS-managed read-only attribute'],
        ['StatusReason', 'AWS-managed read-only attribute'],
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
    const name = reader.requiredString('Name');
    const input = this.putInput(reader, name);
    const tags = tagMap(reader.tags());

    let created = false;
    try {
      await this.refuseExisting(name, resourceType, logicalId);
      const resp = await this.client.send(
        new PutDeliverySourceCommand({ ...input, ...(tags && { tags }) })
      );
      created = true;
      reportCreatedResource(logicalId, resourceType, name);
      return { physicalId: name, attributes: sourceAttributes(resp.deliverySource) };
    } catch (error) {
      const thrown = this.wrapError('create', logicalId, resourceType, name, error);
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
    const sourceChanged = ['ResourceArn', 'LogType', 'DeliverySourceConfiguration'].some(
      (key) => !isDeepStrictEqual(properties[key], previousProperties[key])
    );
    // Validated before the first write.
    const input = sourceChanged ? this.putInput(reader, physicalId) : undefined;
    try {
      let source: DeliverySource | undefined;
      if (input) {
        source = (await this.client.send(new PutDeliverySourceCommand(input))).deliverySource;
      }
      source ??= (await this.client.send(new GetDeliverySourceCommand({ name: physicalId })))
        .deliverySource;
      if (!source?.arn) {
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
        source.arn,
        resourceType,
        logicalId,
        properties['Tags'],
        previousProperties['Tags']
      );
      return { physicalId, wasReplaced: false, attributes: sourceAttributes(source) };
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
      await this.client.send(new DeleteDeliverySourceCommand({ name: physicalId }));
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
      // A source a delivery still uses is refused with ConflictException; the
      // DAG deletes the delivery first, so it surfaces only for a delivery
      // outside this stack.
      throw this.wrapError('delete', logicalId, resourceType, physicalId, error);
    }
  }

  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    const resp = await this.client.send(new GetDeliverySourceCommand({ name: physicalId }));
    return sourceAttributes(resp.deliverySource)[attributeName];
  }

  /**
   * Adopt an existing source by the `--resource` override or the template's
   * `Name`, verified with `GetDeliverySource`. There is no tag-based lookup:
   * `Name` is required, so the explicit path always applies.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const name = resolveExplicitPhysicalId(input, 'Name');
    if (!name) return null;
    try {
      const resp = await this.client.send(new GetDeliverySourceCommand({ name }));
      if (!resp.deliverySource?.name) return null;
      return {
        physicalId: resp.deliverySource.name,
        attributes: sourceAttributes(resp.deliverySource),
      };
    } catch (error) {
      if (isLogsNotFound(error)) return null;
      throw error;
    }
  }

  /** Read the live source for `cdkd drift`, in the CFn shape. */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    let source: DeliverySource | undefined;
    try {
      source = (await this.client.send(new GetDeliverySourceCommand({ name: physicalId })))
        .deliverySource;
    } catch (error) {
      if (isLogsNotFound(error)) return RESOURCE_NOT_FOUND;
      throw error;
    }
    if (!source) return RESOURCE_NOT_FOUND;
    const result: Record<string, unknown> = {};
    if (source.name !== undefined) result['Name'] = source.name;
    // The write-only ResourceArn is the single entry of the read-only list.
    if (source.resourceArns?.length === 1) result['ResourceArn'] = source.resourceArns[0];
    if (source.logType !== undefined) result['LogType'] = source.logType;
    const liveConfig = source.deliverySourceConfiguration;
    if (liveConfig !== undefined && Object.keys(liveConfig).length > 0) {
      // AWS reports every configuration key, defaults included; keep the keys
      // the record declares so an undeclared default is not drift.
      const declared = properties?.['DeliverySourceConfiguration'];
      result['DeliverySourceConfiguration'] = isPlainRecord(declared)
        ? Object.fromEntries(Object.entries(liveConfig).filter(([k]) => k in declared))
        : { ...liveConfig };
    }
    if (source.arn) {
      try {
        result['Tags'] = await readTags(this.client, source.arn);
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

  private putInput(
    reader: PropertyReader,
    name: string
  ): {
    name: string;
    resourceArn: string;
    logType: string;
    deliverySourceConfiguration?: Record<string, string>;
  } {
    const resourceArn = reader.requiredString('ResourceArn');
    const logType = reader.requiredString('LogType');
    const config = reader.optionalStringMap('DeliverySourceConfiguration');
    return {
      name,
      resourceArn,
      logType,
      ...(config !== undefined && { deliverySourceConfiguration: config }),
    };
  }

  /**
   * Refuse a create whose name is already a source: `PutDeliverySource` would
   * overwrite it in place.
   */
  private async refuseExisting(name: string, resourceType: string, logicalId: string) {
    try {
      await this.client.send(new GetDeliverySourceCommand({ name }));
    } catch (error) {
      if (isLogsNotFound(error)) return;
      throw error;
    }
    throw markNonRetryable(
      new ProvisioningError(
        `${WHAT} ${logicalIdShown(logicalId)} cannot be created: a delivery source with its Name ` +
          'already exists in this account and region. Delete it, choose another Name, or adopt it ' +
          'into this stack with an import.',
        resourceType,
        logicalId
      )
    );
  }
}

function sourceAttributes(source: DeliverySource | undefined): Record<string, unknown> {
  return definedAttributes({
    Arn: source?.arn,
    ResourceArns: source?.resourceArns ? [...source.resourceArns] : undefined,
    Service: source?.service,
    Status: source?.status,
    StatusReason: source?.statusReason,
  });
}
