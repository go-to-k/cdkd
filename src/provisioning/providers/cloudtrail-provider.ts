import {
  CloudTrailClient,
  CreateTrailCommand,
  DeleteTrailCommand,
  UpdateTrailCommand,
  StartLoggingCommand,
  StopLoggingCommand,
  PutEventSelectorsCommand,
  PutInsightSelectorsCommand,
  GetTrailCommand,
  GetTrailStatusCommand,
  GetEventSelectorsCommand,
  GetInsightSelectorsCommand,
  ListTagsCommand,
  AddTagsCommand,
  RemoveTagsCommand,
  TrailNotFoundException,
  type EventSelector,
  type InsightSelector,
} from '@aws-sdk/client-cloudtrail';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../import-helpers.js';
import { clearOnUpdateRemoval } from '../update-removal.js';
import { requireConfigArray } from '../config-shape.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * The selector set a trail carries when its template declares NO
 * `EventSelectors`, and therefore the RESET payload for a removal.
 *
 * Live CFn A/B (issue #1549, us-east-1, 2026-08-11): removing `EventSelectors`
 * from a deployed trail's template resets the live selectors to exactly this
 * shape — AWS echoes it back as `{ReadWriteType: 'All', IncludeManagementEvents:
 * true, DataResources: [], ExcludeManagementEventSources: []}`, the two empty
 * lists being response-side defaults that do NOT need sending.
 *
 * It is a VALUE, not an empty array, because `PutEventSelectors` rejects `[]`
 * with `InvalidEventSelectorsException: Specify a valid number of selectors
 * (1 to 5) for your trail` — the divergence from the `InsightSelectors` sibling,
 * where AWS documents `[]` as the removal shape.
 */
const DEFAULT_EVENT_SELECTORS: readonly EventSelector[] = Object.freeze([
  Object.freeze({ ReadWriteType: 'All', IncludeManagementEvents: true }),
]) as readonly EventSelector[];

/**
 * `undefined` for an absent / null / EMPTY optional string field.
 *
 * Module-scoped since issue #1565 so `create()` can use it too: an always-emit
 * placeholder can reach `create()` — `drift --accept` falls back to mutating
 * `properties` when `observedProperties` is absent, and the rollback executor
 * replays `previousState.properties` through `create()` on a reverse
 * replacement — and `CreateTrail` with `CloudWatchLogsLogGroupArn: ''` is an
 * UNPROBED shape that may 400 on ARN format. `''` there means "not
 * configured", which is exactly what omitting the field says.
 *
 * The update path is where the distinction between absent and `''` matters
 * (see {@link resolveCloudWatchLogsPair}); on create there is no previous
 * value to clear, so both collapse to "omit".
 */
function emptyToUndefined(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return v as string;
}

/**
 * Resolve the `CloudWatchLogsLogGroupArn` / `CloudWatchLogsRoleArn` pair for an
 * `UpdateTrail`, distinguishing an ABSENT desired side from an explicit `''`.
 *
 * The pair is all-or-nothing on AWS, so the two fields are decided TOGETHER —
 * the caller cannot build the half-configured request AWS rejects.
 *
 * - ABSENT (`undefined` / `null`) on BOTH sides -> send neither. The template
 *   never declared them, and the live CFn A/B (2026-08-10) measured a template
 *   removal as RETAINED, so sending nothing IS the parity behavior. `null`
 *   counts as absent because a JSON state round-trip can produce one where the
 *   template had nothing.
 * - BOTH `''` -> send both. `''` is the clear, which is what makes a
 *   `drift --revert` of a console-side enable actually revert (issue #1565).
 *   On an already-unwired trail that re-asserts a null field, which AWS accepts
 *   as the no-op it is, and it rides an `UpdateTrail` this method issues
 *   anyway. Deliberately NOT gated on "differs from the previous side": that
 *   gate would also stop forwarding an UNCHANGED populated pair, which
 *   `cloudtrail-provider-roundtrip.test.ts` pins as a wire-layer guarantee.
 * - BOTH populated -> send both verbatim.
 * - Anything else — a non-string value, or exactly ONE half populated -> send
 *   NEITHER, and report it. Both shapes are unusable rather than meaningful:
 *   coercing them would send `''` next to a real ARN (the request AWS rejects)
 *   or, worse, read a malformed `null` as a CLEAR and silently disable a live
 *   trail's CloudWatch Logs delivery — the
 *   `malformed-value-must-not-read-as-removal` class this same file already
 *   guards for `EventSelectors`. Leaving the pair alone is the non-destructive
 *   reading, and the caller warns so the divergence is loud.
 *
 * Only the DESIRED side decides, which keeps the guard-the-desired-side-only
 * rule intact.
 */
function resolveCloudWatchLogsPair(properties: Record<string, unknown>): {
  logGroupArn: string | undefined;
  roleArn: string | undefined;
  unusable?: string;
} {
  const desiredGroup = properties['CloudWatchLogsLogGroupArn'];
  const desiredRole = properties['CloudWatchLogsRoleArn'];
  const groupAbsent = desiredGroup == null;
  const roleAbsent = desiredRole == null;
  if (groupAbsent && roleAbsent) return { logGroupArn: undefined, roleArn: undefined };

  if (typeof desiredGroup !== 'string' || typeof desiredRole !== 'string') {
    return {
      logGroupArn: undefined,
      roleArn: undefined,
      unusable:
        `CloudWatchLogsLogGroupArn / CloudWatchLogsRoleArn must both be strings ` +
        `(got ${describeValue(desiredGroup)} / ${describeValue(desiredRole)}) — check for ` +
        `an unresolved intrinsic or a half-written state record`,
    };
  }
  if ((desiredGroup === '') !== (desiredRole === '')) {
    return {
      logGroupArn: undefined,
      roleArn: undefined,
      unusable:
        `CloudWatchLogsLogGroupArn / CloudWatchLogsRoleArn are all-or-nothing on AWS, ` +
        `but only one of them carries a value — sending the pair would be rejected`,
    };
  }
  return { logGroupArn: desiredGroup, roleArn: desiredRole };
}

/** Human-readable type for a warning, without echoing user data. */
function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'nothing';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return value === '' ? "''" : 'a string';
  return `a ${typeof value}`;
}

/**
 * SDK Provider for AWS CloudTrail resources
 *
 * Supports:
 * - AWS::CloudTrail::Trail
 *
 * CloudTrail CreateTrail/UpdateTrail are synchronous - the CC API adds
 * unnecessary polling overhead for operations that complete immediately.
 */
export class CloudTrailProvider implements ResourceProvider {
  private client: CloudTrailClient | undefined;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('CloudTrailProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::CloudTrail::Trail',
      new Set([
        'S3BucketName',
        'TrailName',
        'S3KeyPrefix',
        'IsMultiRegionTrail',
        'IncludeGlobalServiceEvents',
        'EnableLogFileValidation',
        'IsLogging',
        'Tags',
        'CloudWatchLogsLogGroupArn',
        'CloudWatchLogsRoleArn',
        'KMSKeyId',
        'SnsTopicName',
        'EventSelectors',
        'InsightSelectors',
        'IsOrganizationTrail',
      ]),
    ],
  ]);

  private getClient(): CloudTrailClient {
    if (!this.client) {
      this.client = new CloudTrailClient(
        this.providerRegion ? { region: this.providerRegion } : {}
      );
    }
    return this.client;
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating CloudTrail Trail ${logicalId}`);

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
    const isMultiRegionTrail = properties['IsMultiRegionTrail'] as boolean | undefined;
    const includeGlobalServiceEvents = properties['IncludeGlobalServiceEvents'] as
      | boolean
      | undefined;
    const enableLogFileValidation = properties['EnableLogFileValidation'] as boolean | undefined;
    const isLogging = properties['IsLogging'] as boolean | undefined;
    const tags = properties['Tags'] as Array<{ Key: string; Value: string }> | undefined;
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
    const isOrganizationTrail = properties['IsOrganizationTrail'] as boolean | undefined;
    const eventSelectors = properties['EventSelectors'] as EventSelector[] | undefined;
    const insightSelectors = properties['InsightSelectors'] as InsightSelector[] | undefined;

    try {
      const result = await this.getClient().send(
        new CreateTrailCommand({
          Name: trailName ?? logicalId,
          S3BucketName: s3BucketName,
          S3KeyPrefix: s3KeyPrefix,
          IsMultiRegionTrail: isMultiRegionTrail,
          IncludeGlobalServiceEvents: includeGlobalServiceEvents,
          EnableLogFileValidation: enableLogFileValidation,
          TagsList: tags ? tags.map((t) => ({ Key: t.Key, Value: t.Value })) : undefined,
          CloudWatchLogsLogGroupArn: cloudWatchLogsLogGroupArn,
          CloudWatchLogsRoleArn: cloudWatchLogsRoleArn,
          KmsKeyId: kmsKeyId,
          SnsTopicName: snsTopicName,
          IsOrganizationTrail: isOrganizationTrail,
        })
      );

      const trailArn = result.TrailARN!;

      // Apply EventSelectors if specified (requires separate API call)
      if (eventSelectors && eventSelectors.length > 0) {
        this.logger.debug(`Setting event selectors for CloudTrail Trail ${logicalId}`);
        await this.getClient().send(
          new PutEventSelectorsCommand({
            TrailName: trailArn,
            EventSelectors: eventSelectors,
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
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create CloudTrail Trail ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating CloudTrail Trail ${logicalId}: ${physicalId}`);

    // `readCurrentState` always-emits empty-string `''` placeholders for
    // several optional fields (S3KeyPrefix, KMSKeyId, SnsTopicName) so
    // console-side
    // adds are detectable as drift (per docs/provider-development.md
    // § 3b "always emit user-controllable top-level keys"). `cdkd drift
    // --revert` round-trips the placeholder back through this `update()`,
    // and this helper drops the placeholder so the wire layer never sees
    // it. Mirrors the canonical Class 2 pattern in `sqs-queue-provider.ts`
    // (`serializeRedrivePolicy`).
    //
    // The CloudWatch Logs PAIR is the EXCEPTION and does not come through
    // here — see `resolveCloudWatchLogsPair`. Dropping its placeholder made
    // `drift --revert` of a console-side enable a silent no-op that still
    // reported success (issue #1565), so that pair forwards `''` as a clear
    // instead.
    //
    // The helper's ORIGINAL rationale — that `UpdateTrail` rejects an
    // empty string outright — is simply WRONG, and every field it named
    // has now been measured. A live probe (2026-08-10, issue #1160) sent
    // `''` ALONE for `SnsTopicName` and for `CloudWatchLogsLogGroupArn`
    // against a real trail; a second (2026-08-11, issue #1533) sent `''`
    // ALONE for `KmsKeyId`. All three were ACCEPTED and nulled the field
    // out, which is why `''` is the removal-reset sentinel below. The
    // claimed `KmsKeyId is not in valid ARN format` rejection never
    // reproduced.

    // Removal semantics (issue #1160, live CFn A/B 2026-08-10 on a real
    // trail with every optional field set, then removed from the template).
    // `UpdateTrail` is a merge-semantics API — a Name+S3BucketName-only
    // update left every other live value untouched — so an absent field is
    // a silent no-op where CloudFormation resets. The A/B split the
    // umbrella's SUSPECT row in two:
    //
    //   RESET by CFn (mirrored below): S3KeyPrefix -> '', SnsTopicName ->
    //   '', KMSKeyId -> '', IsMultiRegionTrail -> false,
    //   EnableLogFileValidation -> false, IncludeGlobalServiceEvents ->
    //   false. Each clear sentinel was probed ALONE against the live trail;
    //   the empty string is accepted for all three string fields and nulls
    //   them out.
    //
    //   `KMSKeyId` joined that list on 2026-08-11 (issue #1533), from its
    //   own CFn A/B: a trail deployed through real CloudFormation with
    //   `KMSKeyId: !GetAtt Key.Arn`, then UPDATE'd with the property
    //   REMOVED, read back as `KmsKeyId: null`. The same run pinned the two
    //   halves separately, because "CFn resets it" does not tell you the
    //   wire shape: `UpdateTrail` with `KmsKeyId` ABSENT left the live key
    //   attached (merge semantics — the divergence), and `KmsKeyId: ''`
    //   was ACCEPTED and cleared it (the reset payload).
    //
    //   The A/B was previously blocked on the belief that a
    //   customer-managed KMS key's pending-deletion window would leave an
    //   orphan behind. It does not: a `PendingDeletion` key is the
    //   AWS-mandated terminal state of a deleted key, which the integ
    //   fixtures `loggroup-kms-associate` / `propagation-races-2` /
    //   `s3-vectors` already assert as the expected post-destroy outcome.
    //
    //   RETAINED by CFn (left as pass-through, pinned by tests):
    //   CloudWatchLogsLogGroupArn / CloudWatchLogsRoleArn kept their live
    //   values through the removal update, so the pass-through is already
    //   CFn parity. `IsOrganizationTrail` is NOT reset either, but for a
    //   different reason — it is the one field that remains UNMEASURABLE
    //   here: flipping it needs an Organizations management (or delegated
    //   administrator) account, and the integ account is not in an
    //   organization at all (`AWSOrganizationsNotInUseException`, probed
    //   2026-08-11). It is recorded as permanently unmeasured on this
    //   account rather than guessed; re-measuring needs a different
    //   account, not a different fixture.
    //
    // The previous side is normalized through `emptyToUndefined` for presence
    // detection: `readCurrentState` always-emits `''` placeholders for
    // S3KeyPrefix / SnsTopicName / KMSKeyId, and a placeholder means "was not
    // set" — without this a never-configured field would look like a removal
    // and send a pointless clear. The three BOOLEANS are always-emitted too, but
    // need no equivalent: their emitted value is the real live value (or the
    // CFn default), so "present in the previous side" is already the right
    // presence answer for them.
    const s3BucketName = properties['S3BucketName'] as string | undefined;
    const s3KeyPrefix = clearOnUpdateRemoval(
      emptyToUndefined(properties['S3KeyPrefix']),
      emptyToUndefined(previousProperties['S3KeyPrefix']),
      ''
    );
    const isMultiRegionTrail = clearOnUpdateRemoval(
      properties['IsMultiRegionTrail'] as boolean | undefined,
      previousProperties['IsMultiRegionTrail'] as boolean | undefined,
      false
    );
    // AWS rejects a multi-region trail that excludes global service events
    // ("Multi-Region trail must include global service events"), so the
    // reset is skipped while the trail stays multi-region. In the A/B both
    // fields were removed together and CFn reset multi-region in the same
    // call, which is why the combination never came up; resetting it under
    // a retained `IsMultiRegionTrail: true` would manufacture a hard AWS
    // failure on a combination that was never measured.
    // The reset applies ONLY when the trail is known-single-region. An
    // `undefined` here means neither side declared `IsMultiRegionTrail`, so
    // the live value is unknown — it can be `true` on a console-changed or
    // imported trail, and sending `IncludeGlobalServiceEvents: false` alone
    // would then be REJECTED by AWS. Turning a silent no-op into a hard
    // deploy failure on an unmeasured combination is strictly worse than
    // leaving the (already CFn-divergent) no-op in place, so unknown falls
    // back to pass-through.
    const includeGlobalServiceEvents =
      isMultiRegionTrail === false
        ? clearOnUpdateRemoval(
            properties['IncludeGlobalServiceEvents'] as boolean | undefined,
            previousProperties['IncludeGlobalServiceEvents'] as boolean | undefined,
            false
          )
        : (properties['IncludeGlobalServiceEvents'] as boolean | undefined);
    const enableLogFileValidation = clearOnUpdateRemoval(
      properties['EnableLogFileValidation'] as boolean | undefined,
      previousProperties['EnableLogFileValidation'] as boolean | undefined,
      false
    );
    const isLogging = properties['IsLogging'] as boolean | undefined;
    // The CloudWatch Logs pair keys on PRESENCE, not emptiness (issue #1565).
    // `emptyToUndefined` conflates two different desired sides:
    //
    //   ABSENT  — the template never declared it. The live CFn A/B measured
    //             this as RETAINED, so it must NOT be sent (parity pin).
    //   `''`    — an explicit clear. Since #1565 `readCurrentState` emits the
    //             pair as `''` on an unwired trail, so `cdkd drift --revert`
    //             of a console-side ENABLE feeds exactly this shape as the
    //             desired side. Dropping it made the revert a NO-OP that
    //             still printed success: the wiring stayed, and the next
    //             drift reported the same difference forever. Making the
    //             drift visible without making it revertable is half a
    //             feature and a new lie.
    //
    // The `''` clear is safe on the wire: the #1160 probe accepted it for
    // `CloudWatchLogsLogGroupArn`, and this fixture's own phase 2b clears
    // BOTH fields that way against a live trail on every run.
    //
    // Decided as a PAIR, so the request can never carry one half without the
    // other — the shape AWS holds all-or-nothing.
    const cwPair = resolveCloudWatchLogsPair(properties);
    if (cwPair.unusable !== undefined) {
      this.logger.warn(
        `CloudTrail Trail ${logicalId}: ${cwPair.unusable}. The trail's existing ` +
          `CloudWatch Logs wiring is left untouched for this update.`
      );
    }
    const cloudWatchLogsLogGroupArn = cwPair.logGroupArn;
    const cloudWatchLogsRoleArn = cwPair.roleArn;
    const kmsKeyId = clearOnUpdateRemoval(
      emptyToUndefined(properties['KMSKeyId']),
      emptyToUndefined(previousProperties['KMSKeyId']),
      ''
    );
    const snsTopicName = clearOnUpdateRemoval(
      emptyToUndefined(properties['SnsTopicName']),
      emptyToUndefined(previousProperties['SnsTopicName']),
      ''
    );
    const isOrganizationTrail = properties['IsOrganizationTrail'] as boolean | undefined;

    try {
      await this.getClient().send(
        new UpdateTrailCommand({
          Name: physicalId,
          S3BucketName: s3BucketName,
          S3KeyPrefix: s3KeyPrefix,
          IsMultiRegionTrail: isMultiRegionTrail,
          IncludeGlobalServiceEvents: includeGlobalServiceEvents,
          EnableLogFileValidation: enableLogFileValidation,
          CloudWatchLogsLogGroupArn: cloudWatchLogsLogGroupArn,
          CloudWatchLogsRoleArn: cloudWatchLogsRoleArn,
          KmsKeyId: kmsKeyId,
          SnsTopicName: snsTopicName,
          IsOrganizationTrail: isOrganizationTrail,
        })
      );

      // Update EventSelectors if changed. Removing the property (or emptying
      // the array) RESETS the trail to AWS's default selector rather than
      // retaining the custom one — the #1160 absent-field class, measured
      // rather than reasoned by analogy from the `InsightSelectors` sibling
      // below (issue #1549).
      //
      // Live CFn A/B, us-east-1, 2026-08-11: a trail deployed with
      // `EventSelectors: [{ReadWriteType: WriteOnly, IncludeManagementEvents:
      // true}]`, then UPDATE'd through real CloudFormation with the property
      // REMOVED, read back as
      // `[{ReadWriteType: All, IncludeManagementEvents: true, DataResources: [],
      // ExcludeManagementEventSources: []}]` — i.e. CFn CLEARS the custom
      // selector back to the default a selector-less trail has.
      //
      // The wire shape for that reset is NOT the empty array the
      // `InsightSelectors` branch uses. The same probe run:
      // `PutEventSelectors` with `EventSelectors: []` is REJECTED with
      // `InvalidEventSelectorsException: Specify a valid number of selectors
      // (1 to 5) for your trail`, while sending the explicit default selector
      // reproduces the post-removal read byte for byte. So the two branches
      // legitimately differ in PAYLOAD while agreeing on POLICY: fire the Put
      // whenever the diff fires, never skip on absence.
      //
      // The RESET is gated on a GENUINELY ABSENT value (or a real empty
      // array), never on falsiness or a missing `.length`. A malformed value
      // — `EventSelectors: {}` from an unresolved `Fn::If`, a mis-nested
      // block, an explicit `null` — must NOT read as a removal: doing so would
      // WIPE the live selectors on a template the user never meant as a
      // removal, turning a pre-fix silent no-op into destruction. That is the
      // `malformed-value-must-not-read-as-removal` class, and
      // `requireConfigArray` is the repo's guard for exactly this shape
      // (issue #1493): a present-but-non-array value is refused rather than
      // defaulted away.
      //
      // WARN rather than throw, and skip the whole branch (issue #1551, the
      // rule `.claude/rules/providers.md` states for every UPDATE-path
      // refusal): `rollback-executor.ts` and `cdkd drift --revert` both call
      // `update(..., previousState.properties, ...)`, so this desired bag can
      // be a historical cdkd STATE record with no template-side remedy. The
      // fallback is to leave the live selectors ALONE — not to reset them,
      // which is the destructive direction, and not to send the malformed
      // value, which is what the guard exists to stop.
      const rawEventSelectors = properties['EventSelectors'];
      let eventSelectorsUnusable = false;
      let newEventSelectors: EventSelector[] | undefined;
      if (rawEventSelectors != null) {
        try {
          newEventSelectors = requireConfigArray(
            rawEventSelectors,
            'AWS::CloudTrail::Trail EventSelectors'
          ) as EventSelector[];
        } catch (error) {
          eventSelectorsUnusable = true;
          this.logger.warn(
            `${error instanceof Error ? error.message : String(error)} The trail's ` +
              `existing event selectors are left untouched for this update rather ` +
              `than reset to the AWS default.`
          );
        }
      }
      const oldEventSelectors = previousProperties['EventSelectors'] as EventSelector[] | undefined;
      if (
        !eventSelectorsUnusable &&
        JSON.stringify(newEventSelectors) !== JSON.stringify(oldEventSelectors)
      ) {
        const isRemoval = newEventSelectors === undefined || newEventSelectors.length === 0;
        const eventSelectorsToSend: readonly EventSelector[] =
          newEventSelectors === undefined || newEventSelectors.length === 0
            ? DEFAULT_EVENT_SELECTORS
            : newEventSelectors;
        this.logger.debug(
          isRemoval
            ? `Resetting event selectors to the AWS default for CloudTrail Trail ${logicalId}`
            : `Updating event selectors for CloudTrail Trail ${logicalId}`
        );
        try {
          await this.getClient().send(
            new PutEventSelectorsCommand({
              TrailName: physicalId,
              EventSelectors: [...eventSelectorsToSend],
            })
          );
        } catch (error) {
          // A trail switched to AdvancedEventSelectors out of band still has
          // the basic selectors recorded in cdkd state, so the diff fires and
          // AWS rejects the Put — which would turn a pre-fix no-op into a hard
          // deploy failure on a combination nobody measured. Only the RESET
          // path tolerates it (there are no basic selectors left to clear);
          // an explicit template value still fails loudly, because the user
          // asked for something AWS cannot deliver on this trail. Mirrors the
          // `IncludeGlobalServiceEvents` reset's rule a few dozen lines up.
          // The message match is deliberately SPACE / CASE tolerant: AWS's own
          // model spells it "advanced event selectors" (spaced, lowercase),
          // so the obvious `/AdvancedEventSelectors/` — the CFn / SDK type
          // spelling — would never match a real rejection and this arm would
          // be DEAD in production while a hand-written fixture kept it green.
          // Caught by review; the wording was read out of
          // `@aws-sdk/client-cloudtrail`'s `InvalidEventSelectorsException`
          // doc rather than guessed.
          const message = error instanceof Error ? error.message : String(error);
          if (!isRemoval || !/advanced[\s-]*event[\s-]*selector/i.test(message)) throw error;
          this.logger.warn(
            `CloudTrail Trail ${logicalId}: skipping the EventSelectors reset — the ` +
              `trail is using AdvancedEventSelectors, which AWS manages through a ` +
              `separate API, so there are no basic event selectors to clear (${message})`
          );
        }
      }

      // Update InsightSelectors if changed. AWS-documented way to
      // remove InsightSelectors is `PutInsightSelectors` with an empty
      // array, so we always issue the Put when the diff fires (load-
      // bearing for `cdkd drift --revert` clearing console-added
      // InsightSelectors back to their templated absence).
      const newInsightSelectors = properties['InsightSelectors'] as InsightSelector[] | undefined;
      const oldInsightSelectors = previousProperties['InsightSelectors'] as
        | InsightSelector[]
        | undefined;
      if (JSON.stringify(newInsightSelectors) !== JSON.stringify(oldInsightSelectors)) {
        this.logger.debug(`Updating insight selectors for CloudTrail Trail ${logicalId}`);
        await this.getClient().send(
          new PutInsightSelectorsCommand({
            TrailName: physicalId,
            InsightSelectors: newInsightSelectors ?? [],
          })
        );
      }

      // Handle IsLogging changes. An ABSENT desired value is NOT a request to
      // start logging (issue #1549): `IsLogging` is CFn-required, so absence
      // is unreachable from a valid template, but a rollback / `drift --revert`
      // replay feeds a cdkd STATE record in as the desired bag and a partial
      // record written by an older binary can lack the key. Before this guard
      // a desired `undefined` against a previous `false` compared as a change
      // and took the `else` arm, so the replay silently STARTED logging on a
      // trail the record says was stopped.
      const oldIsLogging = previousProperties['IsLogging'] as boolean | undefined;
      if (isLogging !== undefined && isLogging !== oldIsLogging) {
        if (isLogging === false) {
          this.logger.debug(`Stopping logging for CloudTrail Trail ${logicalId}`);
          await this.getClient().send(new StopLoggingCommand({ Name: physicalId }));
        } else {
          this.logger.debug(`Starting logging for CloudTrail Trail ${logicalId}`);
          await this.getClient().send(new StartLoggingCommand({ Name: physicalId }));
        }
      }

      // Apply tag diff. CloudTrail's AddTags / RemoveTags take a `ResourceId`
      // (the trail ARN) and `TagsList` of full {Key, Value} objects.
      // RemoveTags requires the full tag objects (not just keys), per the
      // CloudTrail SDK contract.
      await this.applyTagDiff(
        physicalId,
        previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
        properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
      );

      this.logger.debug(`Successfully updated CloudTrail Trail ${logicalId}`);

      return { physicalId, wasReplaced: false };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update CloudTrail Trail ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting CloudTrail Trail ${logicalId}: ${physicalId}`);

    try {
      // Stop logging before deletion (ignore errors)
      try {
        await this.getClient().send(new StopLoggingCommand({ Name: physicalId }));
      } catch {
        // Ignore errors when stopping logging
      }

      await this.getClient().send(new DeleteTrailCommand({ Name: physicalId }));
      this.logger.debug(`Successfully deleted CloudTrail Trail ${logicalId}`);
    } catch (error) {
      if (error instanceof TrailNotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`CloudTrail Trail ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete CloudTrail Trail ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  getAttribute(
    _physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    // Arn is stored in attributes during create
    return Promise.resolve(attributeName);
  }

  /**
   * Apply a diff between old and new CFn-shape Tags arrays via CloudTrail's
   * `AddTags` / `RemoveTags` APIs. Note: CloudTrail's `RemoveTags` takes
   * full `{Key, Value}` objects in `TagsList` (NOT just keys), unlike most
   * other AWS services.
   */
  private async applyTagDiff(
    trailArn: string,
    oldTagsRaw: Array<{ Key?: string; Value?: string }> | undefined,
    newTagsRaw: Array<{ Key?: string; Value?: string }> | undefined
  ): Promise<void> {
    const toMap = (
      tags: Array<{ Key?: string; Value?: string }> | undefined
    ): Map<string, string> => {
      const m = new Map<string, string>();
      for (const t of tags ?? []) {
        if (t.Key !== undefined && t.Value !== undefined) m.set(t.Key, t.Value);
      }
      return m;
    };

    const oldMap = toMap(oldTagsRaw);
    const newMap = toMap(newTagsRaw);

    const tagsToAdd: Array<{ Key: string; Value: string }> = [];
    for (const [k, v] of newMap) {
      if (oldMap.get(k) !== v) tagsToAdd.push({ Key: k, Value: v });
    }
    const tagsToRemove: Array<{ Key: string; Value: string }> = [];
    for (const [k, v] of oldMap) {
      if (!newMap.has(k)) tagsToRemove.push({ Key: k, Value: v });
    }

    if (tagsToRemove.length > 0) {
      await this.getClient().send(
        new RemoveTagsCommand({ ResourceId: trailArn, TagsList: tagsToRemove })
      );
      this.logger.debug(`Removed ${tagsToRemove.length} tag(s) from CloudTrail Trail ${trailArn}`);
    }
    if (tagsToAdd.length > 0) {
      await this.getClient().send(
        new AddTagsCommand({ ResourceId: trailArn, TagsList: tagsToAdd })
      );
      this.logger.debug(`Added/updated ${tagsToAdd.length} tag(s) on CloudTrail Trail ${trailArn}`);
    }
  }

  /**
   * Adopt an existing CloudTrail trail into cdkd state.
   *
   * Lookup order:
   *  1. `--resource` override or `Properties.TrailName` → verify via `GetTrail`.
   *  2. `ListTrails` + `ListTags` (CloudTrail uses `Tag[]` arrays per ARN),
   *     match `aws:cdk:path` tag.
   */
  /**
   * Read the AWS-current CloudTrail Trail configuration in CFn-property shape.
   *
   * Issues `GetTrail`, plus best-effort `GetTrailStatus` (for `IsLogging`)
   * and `GetEventSelectors` (for `EventSelectors`). Each enrichment call is
   * wrapped in its own try/catch so an "AccessDenied" or other transient
   * error on the secondary calls omits that key without failing the
   * whole snapshot — the comparator only descends into keys present in
   * state.
   *
   * Mapping: AWS `GetTrail` returns `KmsKeyId` (lowercase `s`) while CFn
   * uses `KMSKeyId`; we re-shape the key. SnsTopicARN is the Trail's
   * derived field; the cdkd state property is `SnsTopicName` so we
   * surface `SnsTopicName` directly from `GetTrail.SnsTopicName`.
   *
   * Tags are surfaced via a follow-up `ListTags(ResourceIdList=[arn])` call
   * (using the trail ARN from the same `GetTrail` response). CDK's `aws:*`
   * auto-tags are filtered out and the result key is omitted when AWS
   * reports no user tags.
   *
   * `InsightSelectors` is surfaced via a follow-up `GetInsightSelectors`
   * call — same shape on both sides (`[{InsightType}]`). The key is
   * always emitted (`[]` when AWS reports none) so a console-side ADD
   * is detectable on the v3 observedProperties baseline.
   *
   * Returns `undefined` when the trail is gone (`TrailNotFoundException`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    let trail;
    try {
      const resp = await this.getClient().send(new GetTrailCommand({ Name: physicalId }));
      trail = resp.Trail;
    } catch (err) {
      if (err instanceof TrailNotFoundException) return undefined;
      throw err;
    }
    if (!trail) return undefined;

    // Always-emit user-controllable top-level keys with placeholders so
    // console-side adds become visible to drift (the comparator's top-
    // level walk is state-keys-only, so an omitted key is invisible
    // forever). See docs/provider-development.md § 3b.
    const result: Record<string, unknown> = {};
    if (trail.Name !== undefined) result['TrailName'] = trail.Name;
    // S3BucketName is required to create a trail; AWS always returns it.
    if (trail.S3BucketName !== undefined) result['S3BucketName'] = trail.S3BucketName;
    result['S3KeyPrefix'] = trail.S3KeyPrefix ?? '';
    result['IsMultiRegionTrail'] = trail.IsMultiRegionTrail ?? false;
    result['IncludeGlobalServiceEvents'] = trail.IncludeGlobalServiceEvents ?? true;
    result['EnableLogFileValidation'] = trail.LogFileValidationEnabled ?? false;

    // CloudWatchLogsLogGroupArn / CloudWatchLogsRoleArn are an all-or-nothing
    // pair: both required when CW logs are enabled, neither when disabled.
    // They are nonetheless emitted UNCONDITIONALLY
    // (issue #1565), because the guard that used to withhold them made a
    // console-side ENABLE permanently invisible to `cdkd drift`: the
    // comparator's top-level walk is baseline-keys-only, so a key absent
    // from the captured snapshot is never compared at all.
    //
    // Both premises the guard rested on are now disproven, each by its own
    // probe, which is why this can be an always-emit rather than a
    // discriminator:
    //
    //  - "AWS rejects a `''` round-trip with `CloudWatchLogsLogGroupArn is
    //    not in valid ARN format`" — DISPROVEN by the issue #1160 live probe
    //    (2026-08-10): `''` is accepted for this field and nulls it out.
    //  - "a console-side enable shows up as both fields appearing at once on
    //    the next read" — FALSE for the reason above; that wording was
    //    corrected in the #1160 review and is what issue #1565 was filed on.
    //
    // The all-or-nothing discriminator is preserved where it actually
    // matters — the WRITE side — rather than by withholding the read: the
    // update path decides both fields TOGETHER
    // (`resolveCloudWatchLogsPair`), forwarding them on PRESENCE so an
    // explicit `''` CLEARS and an ABSENT pair is retained, and refusing any
    // half-populated or non-string shape. The pair is emitted TOGETHER here
    // too, so the snapshot never describes the half-configured state AWS
    // cannot hold.
    //
    // This is deliberately NOT the
    // `feedback_always_emit_check_type_discriminator.md` pattern, and the
    // difference is worth naming: that pattern guards the emit on a SIBLING
    // discriminator whose false value makes the field illegal on AWS, so a
    // console-side add is impossible and nothing is lost by withholding it.
    // Here the pair's own presence IS the switch, so withholding it hides the
    // one change worth catching. See docs/provider-development.md ("Two
    // failure modes when an always-emit placeholder round-trips").
    result['CloudWatchLogsLogGroupArn'] = trail.CloudWatchLogsLogGroupArn ?? '';
    result['CloudWatchLogsRoleArn'] = trail.CloudWatchLogsRoleArn ?? '';

    result['KMSKeyId'] = trail.KmsKeyId ?? '';
    result['SnsTopicName'] = trail.SnsTopicName ?? '';
    result['IsOrganizationTrail'] = trail.IsOrganizationTrail ?? false;

    // IsLogging — separate call. Treat any error as "feature not configured"
    // and omit the key.
    try {
      const status = await this.getClient().send(new GetTrailStatusCommand({ Name: physicalId }));
      result['IsLogging'] = status.IsLogging ?? false;
    } catch {
      // Best-effort.
    }

    // EventSelectors — separate call. AWS returns either `EventSelectors`
    // or `AdvancedEventSelectors` (mutually exclusive — Class 1). cdkd
    // state's CFn shape is `EventSelectors` only.
    //
    // When AWS has AdvancedEventSelectors configured, surfacing
    // `EventSelectors: []` would round-trip through `update()` and
    // attempt PutEventSelectors, which AWS rejects when the trail
    // is using AdvancedEventSelectors. Skip emit in that case — the
    // discriminator-false state cannot legally have EventSelectors, so
    // a console-side switch back to basic EventSelectors shows up on
    // the next read.
    try {
      const sel = await this.getClient().send(
        new GetEventSelectorsCommand({ TrailName: physicalId })
      );
      const hasAdvanced =
        Array.isArray(sel.AdvancedEventSelectors) && sel.AdvancedEventSelectors.length > 0;
      if (!hasAdvanced) {
        result['EventSelectors'] = (sel.EventSelectors ?? []).map(
          (es) => es as unknown as Record<string, unknown>
        );
      }
    } catch {
      // Best-effort.
    }

    // InsightSelectors — separate call. Same shape on both sides
    // (CFn `[{InsightType}]` matches SDK), so we emit verbatim and
    // always-emit `[]` on no result so a console-side ADD is visible
    // to drift on the v3 observedProperties baseline.
    let insightSelectors: Array<{ InsightType?: string }> = [];
    try {
      const insight = await this.getClient().send(
        new GetInsightSelectorsCommand({ TrailName: physicalId })
      );
      insightSelectors = (insight.InsightSelectors ?? []).map((s) => ({
        ...(s.InsightType !== undefined && { InsightType: s.InsightType }),
      }));
    } catch {
      // InsightNotEnabledException / permissions / etc — best-effort.
    }
    result['InsightSelectors'] = insightSelectors;

    // Tags via ListTags. Always emit `Tags: []` so a console-side tag
    // add on a previously-untagged trail is detectable as drift (per
    // § 3b). When the trail ARN is missing or ListTags fails, fall back
    // to the empty placeholder rather than dropping the key.
    let tags: Array<{ Key: string; Value: string }> = [];
    if (trail.TrailARN) {
      try {
        const tagsResp = await this.getClient().send(
          new ListTagsCommand({ ResourceIdList: [trail.TrailARN] })
        );
        tags = normalizeAwsTagsToCfn(tagsResp.ResourceTagList?.[0]?.TagsList);
      } catch (err) {
        this.logger.debug(
          `CloudTrail ListTags(${trail.TrailARN}) failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    result['Tags'] = tags;

    return result;
  }

  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'TrailName');
    if (explicit) {
      try {
        await this.getClient().send(new GetTrailCommand({ Name: explicit }));
        return { physicalId: explicit, attributes: {} };
      } catch (err) {
        if (err instanceof TrailNotFoundException) return null;
        throw err;
      }
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // DescribeStackResources or the template's physical-name property; a trail
    // reaching here needs an explicit `--resource` override.
    return null;
  }
}
