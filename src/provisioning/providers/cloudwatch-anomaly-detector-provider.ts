import {
  CloudWatchClient,
  PutAnomalyDetectorCommand,
  DeleteAnomalyDetectorCommand,
  ResourceNotFoundException,
  type PutAnomalyDetectorCommandInput,
  type DeleteAnomalyDetectorCommandInput,
  type SingleMetricAnomalyDetector,
  type MetricMathAnomalyDetector,
  type AnomalyDetectorConfiguration,
  type MetricCharacteristics,
  type Dimension,
} from '@aws-sdk/client-cloudwatch';
import { createHash } from 'node:crypto';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
  UpdateContext,
} from '../../types/resource.js';
import { maskDeep, maskerOrIdentity, type MaskerFn } from '../masked-retry-logger.js';

/**
 * AWS CloudWatch AnomalyDetector Provider (issue #1304)
 *
 * Implements resource provisioning for AWS::CloudWatch::AnomalyDetector using
 * the CloudWatch SDK. The type is NON_PROVISIONABLE in the CloudFormation
 * registry (no Cloud Control handlers), so without this provider cdkd's
 * pre-flight rejects any template that declares it.
 *
 * API mapping: `PutAnomalyDetector` is an UPSERT keyed by the metric
 * descriptor (the single-metric tuple or the metric-math query set), and
 * `DeleteAnomalyDetector` takes the same descriptor. There is no
 * server-generated identifier; the registry schema's read-only `Id`
 * primaryIdentifier has no Cloud Control handler to mint it. cdkd therefore
 * derives a DETERMINISTIC physical id from the descriptor (see
 * {@link derivePhysicalId}) — every descriptor field is createOnly in the
 * registry schema, so the id is stable across in-place updates
 * (`Configuration` is the only mutable property).
 */
export class CloudWatchAnomalyDetectorProvider implements ResourceProvider {
  private cloudWatchClient: CloudWatchClient;
  private logger = getLogger().child('CloudWatchAnomalyDetectorProvider');

  /**
   * NON_PROVISIONABLE type: Cloud Control has no handlers for it, so the
   * #614 unhandled-property auto-route must never send an
   * AnomalyDetector template to the CC path (it would fail at deploy time
   * with no handler). All properties are handled here instead.
   */
  readonly disableCcApiFallback = true;

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::CloudWatch::AnomalyDetector',
      new Set([
        'Namespace',
        'MetricName',
        'Stat',
        'Dimensions',
        'Configuration',
        'MetricCharacteristics',
        'SingleMetricAnomalyDetector',
        'MetricMathAnomalyDetector',
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.cloudWatchClient = awsClients.cloudWatch;
  }

  /**
   * Create an anomaly detection model via `PutAnomalyDetector`.
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating CloudWatch anomaly detector ${logicalId}`);

    // Issue #2178: `toDate` quotes the offending `ExcludedTimeRanges` entry
    // back at the user, and `properties` arrives RESOLVED. Absent means
    // unmasked, the contract's back-compatible default.
    const params = buildPutParams(properties, maskerOrIdentity(context?.maskSecrets));
    if (!hasDescriptor(params)) {
      throw new ProvisioningError(
        `AnomalyDetector ${logicalId} needs a metric descriptor: either SingleMetricAnomalyDetector, ` +
          `MetricMathAnomalyDetector, or the top-level Namespace/MetricName/Stat fields`,
        resourceType,
        logicalId
      );
    }

    try {
      await this.cloudWatchClient.send(new PutAnomalyDetectorCommand(params));

      const physicalId = derivePhysicalId(properties);
      this.logger.debug(
        `Successfully created CloudWatch anomaly detector ${logicalId}: ${physicalId}`
      );

      return {
        physicalId,
        // The registry schema's read-only `Id` primaryIdentifier — expose it
        // so `Fn::GetAtt [<detector>, Id]` resolves from cached attributes.
        attributes: { Id: physicalId },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create CloudWatch anomaly detector ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Update an anomaly detection model.
   *
   * Every descriptor field (Namespace / MetricName / Stat / Dimensions /
   * SingleMetricAnomalyDetector / MetricMathAnomalyDetector /
   * MetricCharacteristics) is createOnly in the registry schema, so the
   * diff layer classifies a change to any of them as a REPLACEMENT and this
   * method never sees it. The only in-place change is `Configuration`
   * (excluded time ranges / time zone), which `PutAnomalyDetector` upserts
   * for the unchanged descriptor.
   *
   * Removal semantics: `PutAnomalyDetector` REPLACES the stored
   * Configuration rather than merging (live-verified 2026-07-31 — a Put
   * with no `Configuration` resets MetricTimezone + ExcludedTimeRanges to
   * defaults), so re-putting the full desired properties matches CFn's
   * "removed property resets to default" behavior with no extra clearing.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating CloudWatch anomaly detector ${logicalId}: ${physicalId}`);

    try {
      await this.cloudWatchClient.send(
        new PutAnomalyDetectorCommand(
          // Issue #2178: same refusal, same bag, so the same masker (see `create`).
          buildPutParams(properties, maskerOrIdentity(context?.maskSecrets))
        )
      );

      this.logger.debug(`Successfully updated CloudWatch anomaly detector ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes: { Id: physicalId },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update CloudWatch anomaly detector ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete an anomaly detection model via `DeleteAnomalyDetector`.
   *
   * The API takes the metric DESCRIPTOR (not an id), so the state-recorded
   * `properties` are required to address the model. `ResourceNotFoundException`
   * is treated as idempotent success (after the shared region check).
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting CloudWatch anomaly detector ${logicalId}: ${physicalId}`);

    if (!properties) {
      throw new ProvisioningError(
        `Cannot delete AnomalyDetector ${logicalId}: the state record carries no properties, ` +
          `and DeleteAnomalyDetector addresses the model by its metric descriptor. ` +
          `Use 'cdkd state orphan <stack>' to drop the record and delete the detector manually.`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    try {
      await this.cloudWatchClient.send(
        new DeleteAnomalyDetectorCommand(buildDeleteParams(properties))
      );

      this.logger.debug(`Successfully deleted CloudWatch anomaly detector ${logicalId}`);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        const clientRegion = await this.cloudWatchClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Anomaly detector ${physicalId} does not exist, skipping deletion`);
        return;
      }

      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete CloudWatch anomaly detector ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Resolve a `Fn::GetAtt` attribute. The registry schema exposes a single
   * read-only attribute, `Id` — cdkd's deterministic physical id.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- Id is derived locally; no AWS call needed
  async getAttribute(
    physicalId: string,
    resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName === 'Id') return physicalId;
    throw new ProvisioningError(
      `Unknown attribute ${attributeName} for ${resourceType} (only 'Id' is defined)`,
      resourceType,
      physicalId
    );
  }

  /**
   * Adopt an existing anomaly detector into cdkd state.
   *
   * **Explicit override only.** Anomaly detectors are addressed by their
   * metric descriptor, carry no tags, and have no name property — there is
   * nothing to auto-look them up by. Users adopting one should pass
   * `--resource <logicalId>=<id>` where `<id>` is any stable identifier
   * (cdkd re-derives the canonical one on the next replacement).
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      return { physicalId: input.knownPhysicalId, attributes: { Id: input.knownPhysicalId } };
    }
    return null;
  }
}

/**
 * Map CFn-shaped properties onto the `PutAnomalyDetector` input. CloudWatch's
 * SDK uses the same PascalCase field names as the CloudFormation schema, so
 * the mapping is structural: the only shape conversion is
 * `Configuration.ExcludedTimeRanges[].StartTime/EndTime`, which CFn carries
 * as ISO-8601 strings and the SDK models as `Date`.
 */
function buildPutParams(
  properties: Record<string, unknown>,
  mask: MaskerFn
): PutAnomalyDetectorCommandInput {
  const params: PutAnomalyDetectorCommandInput = {};

  const single = properties['SingleMetricAnomalyDetector'] as
    | SingleMetricAnomalyDetector
    | undefined;
  if (single !== undefined) params.SingleMetricAnomalyDetector = single;

  const math = properties['MetricMathAnomalyDetector'] as MetricMathAnomalyDetector | undefined;
  if (math !== undefined) params.MetricMathAnomalyDetector = math;

  // Deprecated-but-supported top-level tuple (what CDK's L1 CfnAnomalyDetector
  // emits for the plain `namespace/metricName/stat` usage).
  if (properties['Namespace'] !== undefined) params.Namespace = properties['Namespace'] as string;
  if (properties['MetricName'] !== undefined) {
    params.MetricName = properties['MetricName'] as string;
  }
  if (properties['Stat'] !== undefined) params.Stat = properties['Stat'] as string;
  if (properties['Dimensions'] !== undefined) {
    params.Dimensions = properties['Dimensions'] as Dimension[];
  }

  const configuration = properties['Configuration'] as Record<string, unknown> | undefined;
  if (configuration !== undefined) {
    const mapped: AnomalyDetectorConfiguration = {};
    // CASING MISMATCH: the CFn property is `MetricTimeZone` (capital Z) but
    // the SDK field is `MetricTimezone` (lowercase z). Passing the CFn key
    // through verbatim is a CLIENT-SIDE silent drop — the SDK serializer
    // ignores unknown keys, so the value never reaches AWS (live-verified
    // 2026-07-31: miscased writes vanish; correctly-cased writes land AND
    // read back from DescribeAnomalyDetectors).
    if (configuration['MetricTimeZone'] !== undefined) {
      mapped.MetricTimezone = configuration['MetricTimeZone'] as string;
    }
    const ranges = configuration['ExcludedTimeRanges'] as
      | Array<Record<string, unknown>>
      | undefined;
    if (ranges !== undefined) {
      mapped.ExcludedTimeRanges = ranges.map((r) => ({
        StartTime: toDate(r['StartTime'], mask),
        EndTime: toDate(r['EndTime'], mask),
      }));
    }
    params.Configuration = mapped;
  }

  const characteristics = properties['MetricCharacteristics'] as MetricCharacteristics | undefined;
  if (characteristics !== undefined) params.MetricCharacteristics = characteristics;

  return params;
}

/**
 * `DeleteAnomalyDetector` addresses the model by the same descriptor shape as
 * Put, minus the mutable `Configuration` / `MetricCharacteristics`.
 */
function buildDeleteParams(properties: Record<string, unknown>): DeleteAnomalyDetectorCommandInput {
  const params: DeleteAnomalyDetectorCommandInput = {};

  const single = properties['SingleMetricAnomalyDetector'] as
    | SingleMetricAnomalyDetector
    | undefined;
  if (single !== undefined) params.SingleMetricAnomalyDetector = single;

  const math = properties['MetricMathAnomalyDetector'] as MetricMathAnomalyDetector | undefined;
  if (math !== undefined) params.MetricMathAnomalyDetector = math;

  if (properties['Namespace'] !== undefined) params.Namespace = properties['Namespace'] as string;
  if (properties['MetricName'] !== undefined) {
    params.MetricName = properties['MetricName'] as string;
  }
  if (properties['Stat'] !== undefined) params.Stat = properties['Stat'] as string;
  if (properties['Dimensions'] !== undefined) {
    params.Dimensions = properties['Dimensions'] as Dimension[];
  }

  return params;
}

/** CFn carries Range times as ISO-8601 strings; the SDK models them as Date. */
function toDate(value: unknown, mask: MaskerFn): Date | undefined {
  if (value === undefined) return undefined;
  if (value instanceof Date) return value;
  const parsed =
    typeof value === 'string' || typeof value === 'number' ? new Date(value) : new Date(NaN);
  if (Number.isNaN(parsed.getTime())) {
    // Fail here with the offending value — letting the serializer throw a
    // bare `RangeError: Invalid time value` later names no property.
    // JSON.stringify (not String) so a non-scalar renders its content
    // rather than '[object Object]' (lint: no-base-to-string).
    throw new Error(
      `Configuration.ExcludedTimeRanges contains an unparsable time value: ` +
        `${JSON.stringify(maskDeep(value, mask))}`
    );
  }
  return parsed;
}

/**
 * Derive the deterministic physical id from the metric descriptor.
 *
 * Single-metric detectors get a readable composite
 * (`<Namespace>:<MetricName>:<Stat>[:<Name=Value,...>]`, dimensions sorted by
 * name so template ordering does not change the id); metric-math detectors
 * get a content hash of their query set (`math:<sha256-16>`). Descriptor
 * fields are all createOnly, so the id never changes across in-place updates.
 */
function derivePhysicalId(properties: Record<string, unknown>): string {
  const single = properties['SingleMetricAnomalyDetector'] as
    | SingleMetricAnomalyDetector
    | undefined;
  const namespace = (single?.Namespace ?? properties['Namespace']) as string | undefined;
  const metricName = (single?.MetricName ?? properties['MetricName']) as string | undefined;
  const stat = (single?.Stat ?? properties['Stat']) as string | undefined;
  const dimensions = (single?.Dimensions ?? properties['Dimensions']) as Dimension[] | undefined;

  if (namespace !== undefined || metricName !== undefined) {
    const dims = (dimensions ?? [])
      .map((d) => `${d.Name}=${d.Value}`)
      .sort()
      .join(',');
    // AccountId (cross-account single-metric detectors) is part of the AWS
    // identity — without it two detectors differing only in source account
    // would collide on physical id, and an AccountId-only replacement would
    // trip the deploy engine's same-id create-first guard.
    const account = single?.AccountId !== undefined ? `${single.AccountId}:` : '';
    const base = `${account}${namespace ?? ''}:${metricName ?? ''}:${stat ?? ''}`;
    return dims.length > 0 ? `${base}:${dims}` : base;
  }

  const math = properties['MetricMathAnomalyDetector'];
  const digest = createHash('sha256')
    .update(JSON.stringify(math ?? {}))
    .digest('hex')
    .slice(0, 16);
  return `math:${digest}`;
}

function hasDescriptor(params: PutAnomalyDetectorCommandInput): boolean {
  return (
    params.SingleMetricAnomalyDetector !== undefined ||
    params.MetricMathAnomalyDetector !== undefined ||
    params.Namespace !== undefined ||
    params.MetricName !== undefined
  );
}
