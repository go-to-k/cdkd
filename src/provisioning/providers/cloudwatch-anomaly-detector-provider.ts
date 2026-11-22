import {
  CloudWatchClient,
  PutAnomalyDetectorCommand,
  DeleteAnomalyDetectorCommand,
  DescribeAnomalyDetectorsCommand,
  ResourceNotFoundException,
  type AnomalyDetector,
  type DescribeAnomalyDetectorsCommandInput,
  type PutAnomalyDetectorCommandInput,
  type DeleteAnomalyDetectorCommandInput,
  type SingleMetricAnomalyDetector,
  type MetricMathAnomalyDetector,
  type AnomalyDetectorConfiguration,
  type MetricCharacteristics,
  type Dimension,
} from '@aws-sdk/client-cloudwatch';
import { createHash } from 'node:crypto';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { stateOrphanRecordRemedy } from '../state-orphan-remedy.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
  UpdateContext,
  ReadCurrentStateContext,
  ResourceNotFound,
} from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import { holdsSecretDerivedEntry } from '../iam-policy-targets.js';
import {
  OWN_WRITE_REREAD_DELAYS_MS,
  reReadUntilSettled,
  warnUnsettledMember,
} from '../settle-after-own-write.js';
import { maskDeep, maskerOrIdentity, type MaskerFn } from '../masked-retry-logger.js';
import { markNotGone } from '../not-gone.js';
import {
  redactedDeleteAddressFields,
  redactedDeleteAddressSkip,
} from '../redacted-delete-address.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { parseCfnTimestamp } from '../../utils/cfn-timestamp.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';

/**
 * The registry schema's read-only primaryIdentifier, under both of the names
 * AWS has published it as: `Id` (what an aws-cdk-lib `attrId` emits) and
 * `AnomalyDetectorId`. AWS has renamed it in both directions (#4668, #4902),
 * so both stay. Both are cdkd's deterministic physical id.
 */
const ID_ATTRIBUTES = ['AnomalyDetectorId', 'Id'] as const;

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
 * server-generated identifier in the API cdkd calls; the registry schema's
 * read-only primaryIdentifier (`Id`, published for a while as
 * `AnomalyDetectorId`) is minted
 * only by the Cloud Control handlers, which cdkd does not use for this type
 * (`cdkd drift` reads it back by descriptor instead, #4668 / #6769). cdkd therefore
 * derives a DETERMINISTIC physical id from the descriptor (see
 * {@link derivePhysicalId}) — every descriptor field is createOnly in the
 * registry schema, so the id is stable across in-place updates
 * (`Configuration` is the only mutable property).
 */
export class CloudWatchAnomalyDetectorProvider implements ResourceProvider {
  private cloudWatchClient: CloudWatchClient;
  private logger = getLogger().child('CloudWatchAnomalyDetectorProvider');

  /**
   * The failure wrap this provider's create, update and delete catches throw.
   *
   * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
   * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
   * `deployments/{runId}.jsonl`, and an `AccessDenied` names the caller's
   * assumed-role ARN. AWS's own text goes to `debug` through the operation's
   * masker, and the wrap is stamped `markRedactedCause`, so the retry
   * classifiers read the withheld text on the `cause` chain. An "already
   * exists" is restated ({@link relayedNameCollision}), so a create-first
   * replacement still recognises the collision. A cdkd-authored or transport
   * error keeps its text, masked, stamped only when the mask changed it
   * (`wrapMaskedAwsError`, issue #4244); a non-`Error` throw is withheld like
   * an AWS one, unstamped (it has no chain). A delete catch tests not-found
   * before it wraps.
   *
   * `build` must thread `error` as `cause`, and runs twice, so it must stay a
   * side-effect-free constructor call.
   */
  private wrapCaughtError(
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
        // Expose the read-only primaryIdentifier so `Fn::GetAtt` resolves
        // from cached attributes under either name.
        attributes: { AnomalyDetectorId: physicalId, Id: physicalId },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        maskerOrIdentity(context?.maskSecrets),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to create CloudWatch anomaly detector ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            undefined,
            cause
          )
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
        attributes: { AnomalyDetectorId: physicalId, Id: physicalId },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        maskerOrIdentity(context?.maskSecrets),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update CloudWatch anomaly detector ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
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
  ): Promise<void | ResourceDeleteResult> {
    this.logger.debug(`Deleting CloudWatch anomaly detector ${logicalId}: ${physicalId}`);

    if (!properties) {
      throw new ProvisioningError(
        `Cannot delete AnomalyDetector ${logicalId}: the state record carries no properties, ` +
          `and DeleteAnomalyDetector addresses the model by its metric descriptor. ` +
          `Delete the detector manually and drop the record with ` +
          // go-to-k/cdkd#4602: the whole-stack form only on a stack destroy.
          `${stateOrphanRecordRemedy(context, logicalId)}.`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    // go-to-k/cdkd#3952: DeleteAnomalyDetector addresses the model by its whole
    // metric descriptor, and a ResourceNotFoundException below reads as
    // "already deleted" -- so any redacted part of it would DROP the record.
    // The physicalId encodes the same descriptor, but its `,` / `=` separators
    // are unescaped, so it is not a lossless second source and is not used.
    const skip = redactedDeleteAddressSkip(
      this.logger,
      logicalId,
      'CloudWatch anomaly detector',
      redactedDeleteAddressFields({
        Namespace: properties['Namespace'],
        MetricName: properties['MetricName'],
        Stat: properties['Stat'],
        Dimensions: properties['Dimensions'],
        SingleMetricAnomalyDetector: properties['SingleMetricAnomalyDetector'],
        MetricMathAnomalyDetector: properties['MetricMathAnomalyDetector'],
      }),
      context
    );
    if (skip) return skip;

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
      const thrown = this.wrapCaughtError(
        maskerOrIdentity(context?.maskSecrets),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to delete CloudWatch anomaly detector ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
      // The wrap names an AWS failure by its CLASS, and the delete classifiers
      // read `NotFoundException` in a message as "already deleted": only the
      // typed not-found above means this resource is gone (go-to-k/cdkd#2319).
      throw error instanceof Error && error.name.includes('NotFound')
        ? markNotGone(thrown)
        : thrown;
    }
  }

  /**
   * Resolve a `Fn::GetAtt` attribute. The registry schema exposes a single
   * read-only attribute, `Id` (also published as `AnomalyDetectorId`) — cdkd's
   * deterministic physical id.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- the id is derived locally; no AWS call needed
  async getAttribute(
    physicalId: string,
    resourceType: string,
    attributeName: string,
    logicalId: string
  ): Promise<unknown> {
    if ((ID_ATTRIBUTES as readonly string[]).includes(attributeName)) return physicalId;
    throw new ProvisioningError(
      `Unknown attribute ${attributeName} for ${resourceType} (only 'AnomalyDetectorId' and 'Id' are defined)`,
      resourceType,
      logicalId,
      physicalId
    );
  }

  /**
   * Read the detector back for `cdkd drift` and the deploy-time baseline
   * (go-to-k/cdkd#6769). The physical id is a cdkd descriptor, not an AWS id,
   * so the record's own descriptor addresses it: `DescribeAnomalyDetectors`
   * (paginated; by `Namespace` + `MetricName` for a single-metric detector, by
   * type for a metric-math one), filtered to the detector whose descriptor is
   * the recorded one ({@link findDetector}). None matching is
   * `RESOURCE_NOT_FOUND`: the descriptor is createOnly, so a detector with
   * another one is another resource. Any failure throws.
   *
   * The descriptor is returned in the record's own form (the top-level tuple,
   * `SingleMetricAnomalyDetector`, or `MetricMathAnomalyDetector`), from the
   * matched detector. `Configuration` is always returned, `{}` when nothing is
   * set, so an exclusion added out of band to a detector declaring none is
   * drift against the captured baseline; `MetricTimezone` is re-keyed to the
   * CFn `MetricTimeZone`, and each `ExcludedTimeRanges` time keeps the
   * record's spelling when it is the same instant (CFn reads an offset-less
   * time as UTC). `MetricCharacteristics` is returned as read.
   *
   * A record whose descriptor holds a redacted or secret-derived value cannot
   * be matched: `undefined` (drift unknown), with no call.
   *
   * On the capture right after cdkd's own write (`context.afterOwnWrite`) a
   * detector not listed yet, or one whose `Configuration` is not the declared
   * one yet, is re-read on the settle schedule.
   */
  async readCurrentState(
    _physicalId: string,
    logicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: ReadCurrentStateContext
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    if (resourceType !== 'AWS::CloudWatch::AnomalyDetector' || !properties) return undefined;
    const descriptor = {
      Namespace: properties['Namespace'],
      MetricName: properties['MetricName'],
      Stat: properties['Stat'],
      Dimensions: properties['Dimensions'],
      SingleMetricAnomalyDetector: properties['SingleMetricAnomalyDetector'],
      MetricMathAnomalyDetector: properties['MetricMathAnomalyDetector'],
    };
    if (holdsSecretDerivedEntry(descriptor)) return undefined;
    if (!hasDescriptor(buildDeleteParams(properties))) return undefined;

    const readOnce = async (): Promise<Record<string, unknown> | ResourceNotFound> => {
      const detector = await this.findDetector(properties);
      return detector === undefined ? RESOURCE_NOT_FOUND : readbackOf(detector, properties);
    };
    if (context?.afterOwnWrite !== true) return readOnce();
    const declared = declaredConfiguration(properties);
    const { answer, settled } = await reReadUntilSettled(
      readOnce,
      (a) => a !== RESOURCE_NOT_FOUND && sameConfiguration(a['Configuration'], declared),
      this.ownWriteRereadDelaysMs
    );
    if (!settled && answer !== RESOURCE_NOT_FOUND) {
      warnUnsettledMember(this.logger, logicalId, resourceType, 'Configuration');
    }
    return answer;
  }

  /** Waits between the post-write re-reads (`OWN_WRITE_REREAD_DELAYS_MS`; tests shorten it). */
  ownWriteRereadDelaysMs: readonly number[] = OWN_WRITE_REREAD_DELAYS_MS;

  /**
   * The live detector whose descriptor is the record's, or `undefined`. A
   * single-metric detector matches on namespace, metric name, stat, the
   * dimension SET, and the account when the record declares one (one AWS
   * answers with no account stands in only when the record names the caller's
   * own account); a metric-math one on its query list, each
   * recorded leaf equal to the live one (scalars compared as strings, a
   * `Dimensions` list as a set).
   */
  private async findDetector(
    properties: Record<string, unknown>
  ): Promise<AnomalyDetector | undefined> {
    const recordedSingle = properties['SingleMetricAnomalyDetector'] as
      | Record<string, unknown>
      | undefined;
    const math = properties['MetricMathAnomalyDetector'] as Record<string, unknown> | undefined;
    const isMath = math !== undefined && recordedSingle === undefined;
    const ns = recordedSingle?.['Namespace'] ?? properties['Namespace'];
    const metric = recordedSingle?.['MetricName'] ?? properties['MetricName'];
    const input: DescribeAnomalyDetectorsCommandInput = isMath
      ? { AnomalyDetectorTypes: ['METRIC_MATH'] }
      : {
          AnomalyDetectorTypes: ['SINGLE_METRIC'],
          ...(typeof ns === 'string' && { Namespace: ns }),
          ...(typeof metric === 'string' && { MetricName: metric }),
        };
    const all: AnomalyDetector[] = [];
    let nextToken: string | undefined;
    do {
      const resp = await this.cloudWatchClient.send(
        new DescribeAnomalyDetectorsCommand({
          ...input,
          ...(nextToken && { NextToken: nextToken }),
        })
      );
      all.push(...(resp.AnomalyDetectors ?? []));
      nextToken = resp.NextToken;
    } while (nextToken);

    if (isMath) {
      const queries = math['MetricDataQueries'];
      return all.find((d) => leavesMatch(queries, d.MetricMathAnomalyDetector?.MetricDataQueries));
    }
    const stat = recordedSingle?.['Stat'] ?? properties['Stat'];
    const dims = recordedSingle?.['Dimensions'] ?? properties['Dimensions'];
    const account = recordedSingle?.['AccountId'];
    const matches = all.filter((d) => {
      const live = liveSingle(d);
      return (
        scalarText(live.Namespace) === scalarText(ns) &&
        scalarText(live.MetricName) === scalarText(metric) &&
        scalarText(live.Stat) === scalarText(stat) &&
        leavesMatch(dims ?? [], live.Dimensions ?? [])
      );
    });
    const noAccount = matches.find((d) => liveSingle(d).AccountId === undefined);
    if (account === undefined) return noAccount ?? matches[0];
    const exact = matches.find((d) => scalarText(liveSingle(d).AccountId) === scalarText(account));
    if (exact !== undefined || noAccount === undefined) return exact;
    // An own-account detector may read back with no AccountId: it is the
    // record's only when the record names the caller's own account, else a
    // deleted cross-account detector would read as this one. One STS call,
    // made only here.
    const identity = await getAwsClients().sts.send(new GetCallerIdentityCommand({}));
    return identity.Account !== undefined && identity.Account === scalarText(account)
      ? noAccount
      : undefined;
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
      return {
        physicalId: input.knownPhysicalId,
        attributes: { AnomalyDetectorId: input.knownPhysicalId, Id: input.knownPhysicalId },
      };
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

/**
 * A single-metric detector's descriptor: `SingleMetricAnomalyDetector`, or the
 * deprecated top-level fields when AWS answers only those.
 */
function liveSingle(d: AnomalyDetector): SingleMetricAnomalyDetector {
  return (
    d.SingleMetricAnomalyDetector ?? {
      Namespace: d.Namespace,
      MetricName: d.MetricName,
      Stat: d.Stat,
      Dimensions: d.Dimensions,
    }
  );
}

/** A `[{Name, Value}]` list, sorted by name so it compares as a set. */
function isDimensionList(value: unknown): value is Array<Record<string, unknown>> {
  return (
    Array.isArray(value) &&
    value.every((e) => typeof e === 'object' && e !== null && 'Name' in e && 'Value' in e)
  );
}
const byName = (list: Array<Record<string, unknown>>): Array<Record<string, unknown>> =>
  [...list].sort((a, b) => String(a['Name']).localeCompare(String(b['Name'])));

/**
 * Whether every leaf `recorded` holds equals the one at the same place in
 * `live`: scalars as strings (a record may spell `Period` `"300"`), a list
 * element by element at the same length, a `Dimensions` list as a set. A key
 * the record does not hold is not compared, nor is one of
 * {@link OPTIONAL_QUERY_MEMBERS} the answer leaves out.
 */
function leavesMatch(recorded: unknown, live: unknown): boolean {
  if (recorded === undefined || recorded === null) return true;
  if (Array.isArray(recorded)) {
    if (!Array.isArray(live) || live.length !== recorded.length) return false;
    const [r, l] =
      isDimensionList(recorded) && isDimensionList(live)
        ? [byName(recorded), byName(live)]
        : [recorded, live as unknown[]];
    return r.every((entry, i) => leavesMatch(entry, l[i]));
  }
  if (typeof recorded === 'object') {
    if (typeof live !== 'object' || live === null) return false;
    return Object.entries(recorded as Record<string, unknown>).every(([k, v]) => {
      const at = (live as Record<string, unknown>)[k];
      // A member AWS may leave out of its answer (a default, or the own
      // account) does not make the detector another one.
      if (at === undefined && OPTIONAL_QUERY_MEMBERS.has(k)) return true;
      return leavesMatch(v, at);
    });
  }
  return live !== undefined && live !== null && scalarText(recorded) === scalarText(live);
}

/** Metric-math query members AWS may omit when they hold the default. */
const OPTIONAL_QUERY_MEMBERS: ReadonlySet<string> = new Set([
  'Label',
  'Period',
  'ReturnData',
  'Unit',
]);

/** A leaf as text (`"300"` and `300` alike); a non-scalar as its JSON, absent as `''`. */
function scalarText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * `live` in the shape of `recorded`: each key the record holds, from the live
 * value at that place (a `Dimensions` list in the record's order, matched by
 * name). Only called on a match ({@link leavesMatch}), so every key has a live
 * value.
 */
function projectOnto(recorded: unknown, live: unknown): unknown {
  if (Array.isArray(recorded) && Array.isArray(live)) {
    if (isDimensionList(recorded) && isDimensionList(live)) {
      return recorded.map((r) => {
        const hit = live.find((l) => String(l['Name']) === String(r['Name']));
        return hit === undefined ? undefined : { Name: hit['Name'], Value: hit['Value'] };
      });
    }
    return recorded.map((entry, i) => projectOnto(entry, live[i]));
  }
  if (
    typeof recorded === 'object' &&
    recorded !== null &&
    typeof live === 'object' &&
    live !== null
  ) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(recorded)) {
      const value = (live as Record<string, unknown>)[key];
      if (value !== undefined)
        out[key] = projectOnto((recorded as Record<string, unknown>)[key], value);
    }
    return out;
  }
  return live;
}

/** A Range time as CFn spells it: the record's spelling when it is the same instant. */
function rangeTime(live: Date | undefined, recorded: unknown): string | undefined {
  if (!(live instanceof Date)) return undefined;
  if (typeof recorded === 'string' && parseCfnTimestamp(recorded).getTime() === live.getTime()) {
    return recorded;
  }
  // CFn's documented `yyyy-MM-dd'T'HH:mm:ss`, read as UTC (issue #5311).
  return live.toISOString().slice(0, 19);
}

/** The CFn-shaped `Configuration` of a detector (`{}` when nothing is set). */
function configurationOf(
  live: AnomalyDetectorConfiguration | undefined,
  recorded: unknown
): Record<string, unknown> {
  const rec = (recorded ?? {}) as Record<string, unknown>;
  const recRanges = Array.isArray(rec['ExcludedTimeRanges'])
    ? (rec['ExcludedTimeRanges'] as Array<Record<string, unknown>>)
    : [];
  const out: Record<string, unknown> = {};
  if (live?.MetricTimezone !== undefined) out['MetricTimeZone'] = live.MetricTimezone;
  const ranges = live?.ExcludedTimeRanges ?? [];
  if (ranges.length > 0 || rec['ExcludedTimeRanges'] !== undefined) {
    out['ExcludedTimeRanges'] = ranges.map((r, i) => ({
      StartTime: rangeTime(r.StartTime, recRanges[i]?.['StartTime']),
      EndTime: rangeTime(r.EndTime, recRanges[i]?.['EndTime']),
    }));
  }
  return out;
}

/** The record's `Configuration`, in the read's shape. */
function declaredConfiguration(properties: Record<string, unknown>): Record<string, unknown> {
  const rec = (properties['Configuration'] ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (rec['MetricTimeZone'] !== undefined) out['MetricTimeZone'] = rec['MetricTimeZone'];
  if (Array.isArray(rec['ExcludedTimeRanges'])) {
    out['ExcludedTimeRanges'] = rec['ExcludedTimeRanges'];
  }
  return out;
}

/** Whether a read `Configuration` is the declared one (range times compared as instants). */
function sameConfiguration(read: unknown, declared: Record<string, unknown>): boolean {
  const r = (read ?? {}) as Record<string, unknown>;
  if (r['MetricTimeZone'] !== declared['MetricTimeZone']) return false;
  const instants = (v: unknown): string =>
    JSON.stringify(
      (Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []).map((range) =>
        ['StartTime', 'EndTime'].map((k) =>
          typeof range[k] === 'string' ? parseCfnTimestamp(range[k]).getTime() : range[k]
        )
      )
    );
  return instants(r['ExcludedTimeRanges']) === instants(declared['ExcludedTimeRanges']);
}

/** The matched detector in the record's CFn shape (see `readCurrentState`). */
function readbackOf(
  d: AnomalyDetector,
  properties: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const single = liveSingle(d);
  if (properties['SingleMetricAnomalyDetector'] !== undefined) {
    out['SingleMetricAnomalyDetector'] = projectOnto(
      properties['SingleMetricAnomalyDetector'],
      single
    );
  }
  if (properties['MetricMathAnomalyDetector'] !== undefined) {
    out['MetricMathAnomalyDetector'] = projectOnto(
      properties['MetricMathAnomalyDetector'],
      d.MetricMathAnomalyDetector
    );
  }
  if (properties['Namespace'] !== undefined) out['Namespace'] = single.Namespace;
  if (properties['MetricName'] !== undefined) out['MetricName'] = single.MetricName;
  if (properties['Stat'] !== undefined) out['Stat'] = single.Stat;
  if (properties['Dimensions'] !== undefined) {
    out['Dimensions'] = projectOnto(properties['Dimensions'], single.Dimensions ?? []);
  }
  out['Configuration'] = configurationOf(d.Configuration, properties['Configuration']);
  if (d.MetricCharacteristics !== undefined) {
    out['MetricCharacteristics'] =
      d.MetricCharacteristics.PeriodicSpikes === undefined
        ? {}
        : { PeriodicSpikes: d.MetricCharacteristics.PeriodicSpikes };
  }
  return out;
}

/**
 * CFn carries Range times as ISO-8601 strings; the SDK models them as Date.
 * The documented `yyyy-MM-dd'T'HH:mm:ss` has no offset, which CFn reads as
 * UTC (issue #5311), not the deployer's local zone.
 */
function toDate(value: unknown, mask: MaskerFn): Date | undefined {
  if (value === undefined) return undefined;
  if (value instanceof Date) return value;
  const parsed =
    typeof value === 'string'
      ? parseCfnTimestamp(value)
      : typeof value === 'number'
        ? new Date(value)
        : new Date(NaN);
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
