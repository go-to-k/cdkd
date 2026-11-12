import type { CloudTrailProvider } from '../cloudtrail-provider.js';
import {
  CreateTrailCommand,
  StartLoggingCommand,
  PutEventSelectorsCommand,
  PutInsightSelectorsCommand,
  PutEventConfigurationCommand,
  type AggregationConfiguration,
  type EventSelector,
  type InsightSelector,
} from '@aws-sdk/client-cloudtrail';
import { safeMsg } from '../../../utils/display-safe.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../../deployment/retryable-errors.js';
import { maskerOrIdentity, type MaskerFn } from '../../masked-retry-logger.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import { replayWarn, requireConfigArray } from '../../config-shape.js';
import type { ResourceCreateResult, CreateContext } from '../../../types/resource.js';
import {
  isAuxiliaryFailure,
  markAuxiliaryFailure,
  markCreatedBeforeFailure,
} from '../../auxiliary-failure.js';
import { reportCreatedResource } from '../../created-resource-sink.js';
import { generatedNameFor } from '../../resource-name.js';
import {
  emptyToUndefined,
  retainPreviousLists,
  eventSelectorRequest,
  trailBoolean,
} from './shared.js';

/**
 * The failure wrap the create / update / delete catches build.
 *
 * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
 * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
 * `deployments/{runId}.jsonl`, and an `AccessDeniedException` names the
 * caller's assumed-role ARN. AWS's own text goes to `debug` through the
 * operation's `maskSecrets` (`mask`), and the wrap is stamped
 * `markRedactedCause`, so the retry classifiers read the withheld text on the
 * `cause` chain. An "already exists" is restated ({@link relayedNameCollision}),
 * except from a failure after `CreateTrail` returned, which is marked
 * auxiliary on the `cause` ({@link markAuxiliaryFailure}): there "it" would
 * read as this trail (#3826). A cdkd-authored or transport error
 * keeps its text, masked, stamped only when the mask changed it
 * (`wrapMaskedAwsError`, issue #4244); a non-`Error` throw is withheld like an
 * AWS one, unstamped (it has no chain). The delete checks `TrailNotFoundException` by type before it wraps.
 *
 * `build` must thread `error` as `cause`, and runs twice, so it must stay a
 * side-effect-free constructor call.
 */
export function wrapCaughtError(
  this: CloudTrailProvider,
  mask: MaskerFn | undefined,
  error: unknown,
  build: (text: string) => ProvisioningError
): ProvisioningError {
  const m = maskerOrIdentity(mask);
  const failure = describeAwsFailure(error);
  if (!failure.redacted) return wrapMaskedAwsError(m, error, build);
  this.logger.debug(m(build(m(failure.detail)).message));
  const relay = isAuxiliaryFailure(error) ? '' : relayedNameCollision(failure.detail);
  const wrapped = build(`${m(failure.summary)}${relay}`);
  return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
}

export async function create(
  this: CloudTrailProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating CloudTrail Trail ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

  const s3BucketName = properties['S3BucketName'] as string | undefined;
  if (!s3BucketName) {
    throw new ProvisioningError(
      `S3BucketName is required for CloudTrail Trail ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  const trailName = properties['TrailName'] as string | undefined;
  const s3KeyPrefix = emptyToUndefined(properties['S3KeyPrefix']);
  // Booleans go through trailBoolean: a `'false'` string would otherwise
  // reach `isLogging !== false` below and START logging.
  const isMultiRegionTrail = trailBoolean(properties['IsMultiRegionTrail']);
  const includeGlobalServiceEvents = trailBoolean(properties['IncludeGlobalServiceEvents']);
  const enableLogFileValidation = trailBoolean(properties['EnableLogFileValidation']);
  const isLogging = trailBoolean(properties['IsLogging']);
  // `emptyToUndefined` on the create path too (issue #1565): a state replay
  // can feed an always-emit `''` placeholder in here, and `CreateTrail` with
  // an empty ARN is an unprobed shape. On create `''` and absent both mean
  // "not configured".
  //
  // `resolveCloudWatchLogsPair` is deliberately NOT used here: there is no
  // previous value to clear on a create, so `''` has no second meaning. A
  // HALF-populated pair replayed through a reverse replacement therefore
  // sends one half and AWS errors — loud is the right direction on a path
  // that is creating the trail from scratch, where silently dropping the
  // wiring would hand back a trail that looks configured and is not.
  const cloudWatchLogsLogGroupArn = emptyToUndefined(properties['CloudWatchLogsLogGroupArn']);
  const cloudWatchLogsRoleArn = emptyToUndefined(properties['CloudWatchLogsRoleArn']);
  const kmsKeyId = emptyToUndefined(properties['KMSKeyId']);
  const snsTopicName = emptyToUndefined(properties['SnsTopicName']);
  const isOrganizationTrail = trailBoolean(properties['IsOrganizationTrail']);
  const recursiveLogging = trailBoolean(properties['RecursiveLogging']);
  const eventSelectors = properties['EventSelectors'] as EventSelector[] | undefined;
  const insightSelectors = properties['InsightSelectors'] as InsightSelector[] | undefined;
  // Issue #2762: a present-but-non-array value is refused before any call
  // (a warning that leaves it unapplied on a state replay, which the template
  // cannot fix).
  const advancedEventSelectors =
    properties['AdvancedEventSelectors'] == null
      ? undefined
      : requireConfigArray(
          properties['AdvancedEventSelectors'],
          'AWS::CloudTrail::Trail AdvancedEventSelectors',
          replayWarn(this.logger, context)
        );
  const aggregationConfigurations =
    properties['AggregationConfigurations'] == null
      ? undefined
      : requireConfigArray(
          properties['AggregationConfigurations'],
          'AWS::CloudTrail::Trail AggregationConfigurations',
          replayWarn(this.logger, context)
        );
  // A replay that skipped one of them records the trail without it, since
  // the call never went out.
  const skippedOnReplay = [
    ...(properties['AdvancedEventSelectors'] != null && advancedEventSelectors === undefined
      ? ['AdvancedEventSelectors']
      : []),
    ...(properties['AggregationConfigurations'] != null && aggregationConfigurations === undefined
      ? ['AggregationConfigurations']
      : []),
  ];

  // Set once CreateTrail returns: a later failure is an auxiliary call's and
  // must not classify as this trail's name collision (#3826).
  let trailCreated = false;
  // go-to-k/cdkd#4583: the created trail's ARN (delete()'s physical id).
  let createdTrailArn: string | undefined;
  try {
    const result = await this.getCreateClient().send(
      new CreateTrailCommand({
        // go-to-k/cdkd#5095: a stack with an instance id generates the
        // name; a legacy stack keeps the bare logical id.
        Name: trailName ?? generatedNameFor('AWS::CloudTrail::Trail', logicalId),
        S3BucketName: s3BucketName,
        S3KeyPrefix: s3KeyPrefix,
        IsMultiRegionTrail: isMultiRegionTrail,
        IncludeGlobalServiceEvents: includeGlobalServiceEvents,
        EnableLogFileValidation: enableLogFileValidation,
        TagsList: properties['Tags']
          ? desiredTags.map((t) => ({ Key: t.Key, Value: t.Value }))
          : undefined,
        CloudWatchLogsLogGroupArn: cloudWatchLogsLogGroupArn,
        CloudWatchLogsRoleArn: cloudWatchLogsRoleArn,
        KmsKeyId: kmsKeyId,
        SnsTopicName: snsTopicName,
        IsOrganizationTrail: isOrganizationTrail,
        RecursiveLogging: recursiveLogging,
      })
    );

    trailCreated = true;
    const trailArn = result.TrailARN!;
    createdTrailArn = result.TrailARN;
    // go-to-k/cdkd#5511: report before the selectors and StartLogging.
    if (createdTrailArn) reportCreatedResource(logicalId, resourceType, createdTrailArn);

    // Apply EventSelectors / AdvancedEventSelectors if specified (one
    // separate call carrying both lists; see `eventSelectorRequest`). With
    // neither, the trail keeps the default a new trail has.
    const basicForCreate =
      eventSelectors && eventSelectors.length > 0
        ? (eventSelectors as unknown as Array<Record<string, unknown>>)
        : undefined;
    if (basicForCreate || (advancedEventSelectors && advancedEventSelectors.length > 0)) {
      this.logger.debug(`Setting event selectors for CloudTrail Trail ${logicalId}`);
      await this.getClient().send(
        new PutEventSelectorsCommand({
          TrailName: trailArn,
          ...eventSelectorRequest(basicForCreate, advancedEventSelectors).members,
        })
      );
    }

    // Issue #2762: AggregationConfigurations ride PutEventConfiguration,
    // sent after the selectors whose events they aggregate.
    if (aggregationConfigurations && aggregationConfigurations.length > 0) {
      this.logger.debug(
        safeMsg`Setting aggregation configurations for CloudTrail Trail ${logicalId}`
      );
      await this.getClient().send(
        new PutEventConfigurationCommand({
          TrailName: trailArn,
          AggregationConfigurations:
            aggregationConfigurations as unknown as AggregationConfiguration[],
        })
      );
    }

    // Apply InsightSelectors if specified (requires separate API call)
    if (insightSelectors && insightSelectors.length > 0) {
      this.logger.debug(`Setting insight selectors for CloudTrail Trail ${logicalId}`);
      await this.getClient().send(
        new PutInsightSelectorsCommand({
          TrailName: trailArn,
          InsightSelectors: insightSelectors,
        })
      );
    }

    // Start logging unless the template explicitly says otherwise. Unlike
    // update()'s branch (issue #1549), an ABSENT desired value deliberately
    // still starts logging here: a create has no live trail whose current
    // state could be kept, and a trail that logs nothing is the useless
    // default — CFn / the CDK L2 both create a logging trail. So absence
    // means "the CFn default", not "leave it alone".
    if (isLogging !== false) {
      this.logger.debug(`Starting logging for CloudTrail Trail ${logicalId}`);
      await this.getClient().send(new StartLoggingCommand({ Name: trailArn }));
    }

    this.logger.debug(`Successfully created CloudTrail Trail ${logicalId}: ${trailArn}`);

    return {
      physicalId: trailArn,
      attributes: {
        Arn: trailArn,
      },
      ...(skippedOnReplay.length > 0 && {
        effectiveProperties: retainPreviousLists(properties, {}, skippedOnReplay),
      }),
    };
  } catch (error) {
    if (trailCreated) markAuxiliaryFailure(error, logicalId);
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create CloudTrail Trail ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
    // go-to-k/cdkd#4583: the trail is live with no state record; name it for
    // the failed-CREATE journal once CreateTrail has returned its ARN.
    if (createdTrailArn) markCreatedBeforeFailure(thrown, logicalId, resourceType, createdTrailArn);
    throw thrown;
  }
}
