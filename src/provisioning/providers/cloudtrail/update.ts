import type { CloudTrailProvider } from '../cloudtrail-provider.js';
import {
  UpdateTrailCommand,
  StartLoggingCommand,
  StopLoggingCommand,
  PutEventSelectorsCommand,
  PutInsightSelectorsCommand,
  PutEventConfigurationCommand,
  type AggregationConfiguration,
  type InsightSelector,
} from '@aws-sdk/client-cloudtrail';
import { safeMsg } from '../../../utils/display-safe.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import { clearOnUpdateRemoval, withRemovalDefaults } from '../../update-removal.js';
import {
  type ResourceUpdateResult,
  type UpdateContext,
  RESOURCE_NOT_FOUND,
} from '../../../types/resource.js';
import {
  emptyToUndefined,
  trailBoolean,
  resolveCloudWatchLogsPair,
  readListBlock,
  listOf,
  retainPreviousLists,
  setKey,
  nonEmptyListOf,
  eventSelectorRequest,
  ADVANCED_SELECTOR_PHRASE,
  ACCESS_DENIAL_CLASS,
  withoutTrailIdentifiers,
  removalsLeftInPlace,
  leftInPlaceWarning,
} from './shared.js';

export async function update(
  this: CloudTrailProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  // The bag the engine records when nothing is skipped; `effectiveProperties`
  // patches a skipped list block into it (below).
  const desiredProperties = properties;
  properties = withRemovalDefaults(
    this.removalDefaults,
    resourceType,
    properties,
    previousProperties,
    context
  );
  this.logger.debug(`Updating CloudTrail Trail ${logicalId}: ${physicalId}`);
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);

  // `readCurrentState` always-emits empty-string `''` placeholders for
  // several optional fields (S3KeyPrefix, KMSKeyId, SnsTopicName) so
  // console-side
  // adds are detectable as drift (per docs/provider-rules.md#readcurrentstate-for-drift-detection
  //  "always emit user-controllable top-level keys"). `cdkd drift
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
  //   account, not a different fixture. Until then a removal is kept and
  //   named in this update's own warning (removalsLeftInPlace, #5541).
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
  // Booleans go through trailBoolean, so a `'false'` string is the boolean
  // CloudFormation reads (#6166 review).
  const isMultiRegionTrail = trailBoolean(properties['IsMultiRegionTrail']);
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
  // back to pass-through, and a removal kept that way is named in this
  // update's warning (removalsLeftInPlace).
  const globalEventsResetSkipped = isMultiRegionTrail !== false;
  const includeGlobalServiceEvents = globalEventsResetSkipped
    ? trailBoolean(properties['IncludeGlobalServiceEvents'])
    : clearOnUpdateRemoval(
        trailBoolean(properties['IncludeGlobalServiceEvents']),
        trailBoolean(previousProperties['IncludeGlobalServiceEvents']),
        false
      );
  const enableLogFileValidation = trailBoolean(properties['EnableLogFileValidation']);
  const isLogging = trailBoolean(properties['IsLogging']);
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
  const isOrganizationTrail = trailBoolean(properties['IsOrganizationTrail']);
  // Like IsOrganizationTrail, a removal is not reset: CFn behaviour is
  // unmeasured, so it is kept and named in removalsLeftInPlace's warning.
  const recursiveLogging = trailBoolean(properties['RecursiveLogging']);
  // What a later failure leaves applied (issue #2762): the selector and
  // aggregation writes are separate calls, so the thrown message names the
  // one that already landed.
  const appliedBeforeFailure: string[] = [];

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
        RecursiveLogging: recursiveLogging,
      })
    );

    // Issue #5541: name what UpdateTrail kept as soon as it has applied, so
    // a later selector or tag failure cannot drop the line.
    const keptNames = removalsLeftInPlace(
      properties,
      previousProperties,
      context,
      globalEventsResetSkipped
    );
    if (keptNames.length > 0) {
      this.logger.warn(
        leftInPlaceWarning(logicalId, keptNames, context?.replayingState ? 'rollback' : 'deploy')
      );
    }

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
    //
    // `AdvancedEventSelectors` (issue #2762) shares the one
    // `PutEventSelectors` call: it replaces the trail's WHOLE selector set,
    // so the two lists are planned together (`eventSelectorRequest`), and an
    // unusable value in EITHER skips the call — sending the other alone would
    // overwrite the selectors the skipped one describes.
    const basicRead = readListBlock(
      properties['EventSelectors'],
      'AWS::CloudTrail::Trail EventSelectors'
    );
    const advancedRead = readListBlock(
      properties['AdvancedEventSelectors'],
      'AWS::CloudTrail::Trail AdvancedEventSelectors'
    );
    for (const read of [basicRead, advancedRead]) {
      if (read.kind === 'unusable') {
        this.logger.warn(
          safeMsg`${read.detail} The trail's existing event selectors are left untouched for this update rather than reset to the AWS default.`
        );
      }
    }
    const selectorsUnusable = basicRead.kind === 'unusable' || advancedRead.kind === 'unusable';
    const newEventSelectors = listOf(basicRead);
    const newAdvancedSelectors = listOf(advancedRead);
    const oldEventSelectors = previousProperties['EventSelectors'];
    const oldAdvancedSelectors = previousProperties['AdvancedEventSelectors'];
    const hadAdvancedSelectors =
      Array.isArray(oldAdvancedSelectors) && oldAdvancedSelectors.length > 0;

    // Issue #2762: aggregation works on the events the selectors deliver,
    // so an aggregation REMOVAL goes before a selector change and every
    // other aggregation change after it.
    const aggregationRead = readListBlock(
      properties['AggregationConfigurations'],
      'AWS::CloudTrail::Trail AggregationConfigurations'
    );
    if (aggregationRead.kind === 'unusable') {
      this.logger.warn(
        safeMsg`${aggregationRead.detail} The trail's existing aggregation configurations are left untouched for this update rather than cleared.`
      );
    }
    const newAggregation = listOf(aggregationRead);
    const aggregationChanged =
      aggregationRead.kind !== 'unusable' &&
      setKey(newAggregation) !== setKey(previousProperties['AggregationConfigurations']);
    const aggregationCleared = aggregationChanged && nonEmptyListOf(aggregationRead) === undefined;
    const putAggregation = async (): Promise<void> => {
      // AWS's own unset shape is the empty list (`GetEventConfiguration` on
      // a trail with no aggregation answers `AggregationConfigurations: []`).
      this.logger.debug(
        safeMsg`Updating aggregation configurations for CloudTrail Trail ${logicalId}`
      );
      await this.getClient().send(
        new PutEventConfigurationCommand({
          TrailName: physicalId,
          AggregationConfigurations: (newAggregation ??
            []) as unknown as AggregationConfiguration[],
        })
      );
    };
    if (aggregationCleared) {
      await putAggregation();
      appliedBeforeFailure.push('AggregationConfigurations was cleared');
    }

    if (
      !selectorsUnusable &&
      (JSON.stringify(newEventSelectors) !== JSON.stringify(oldEventSelectors) ||
        setKey(newAdvancedSelectors) !== setKey(oldAdvancedSelectors))
    ) {
      // A `drift --revert` desired bag is the live readback with the drifted
      // list overlaid, so it can carry BOTH lists: the live one it started
      // from and the baseline one being restored. The list equal to the live
      // (previous) side is the one being replaced, so only the other is
      // sent, which overwrites it. A template declaring both keeps sending
      // both, for AWS to refuse.
      let basicToSend = newEventSelectors;
      let advancedToSend = newAdvancedSelectors;
      if (
        context?.desiredFromAwsReadback === true &&
        nonEmptyListOf(basicRead) !== undefined &&
        nonEmptyListOf(advancedRead) !== undefined
      ) {
        if (JSON.stringify(newEventSelectors) === JSON.stringify(oldEventSelectors)) {
          basicToSend = undefined;
        } else if (setKey(newAdvancedSelectors) === setKey(oldAdvancedSelectors)) {
          advancedToSend = undefined;
        }
      }
      const { members, isReset: isRemoval } = eventSelectorRequest(basicToSend, advancedToSend);
      this.logger.debug(
        isRemoval
          ? `Resetting event selectors to the AWS default for CloudTrail Trail ${logicalId}`
          : `Updating event selectors for CloudTrail Trail ${logicalId}`
      );
      try {
        await this.getClient().send(
          new PutEventSelectorsCommand({
            TrailName: physicalId,
            ...members,
          })
        );
        appliedBeforeFailure.push('the event selectors were updated');
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
        // `.detail`, never `.summary`: the classifier below matches AWS's OWN
        // wording, which `.summary` replaces with the wire name alone. Same text as
        // the `instanceof Error ?` ternary it replaced, minus that ternary's throw.
        // Matched with the trail's id and every ARN cut out
        // ({@link withoutTrailIdentifiers}).
        const failure = describeAwsFailure(error);
        const message = withoutTrailIdentifiers(failure.detail, physicalId);
        const errorClass = error instanceof Error ? error.name : '';
        // A reset REMOVING recorded advanced selectors (issue #2762) is the
        // template asking for exactly that switch, so it fails loudly too.
        if (
          !isRemoval ||
          hadAdvancedSelectors ||
          ACCESS_DENIAL_CLASS.test(errorClass) ||
          !ADVANCED_SELECTOR_PHRASE.test(message)
        ) {
          throw error;
        }
        // The class at warn, AWS's text at debug (go-to-k/cdkd#2319).
        const m = maskerOrIdentity(context?.maskSecrets);
        const head =
          `CloudTrail Trail ${logicalId}: skipping the EventSelectors reset — the ` +
          `trail is using AdvancedEventSelectors, which AWS manages through a ` +
          `separate API, so there are no basic event selectors to clear (`;
        if (failure.redacted) this.logger.debug(m(`${head}${m(failure.detail)})`));
        this.logger.warn(m(`${head}${failure.redacted ? failure.summary : failure.detail})`));
      }
    }

    if (aggregationChanged && !aggregationCleared) {
      await putAggregation();
      appliedBeforeFailure.push('AggregationConfigurations was updated');
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
    const oldIsLogging = trailBoolean(previousProperties['IsLogging']);
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
      resourceType,
      logicalId,
      previousProperties['Tags'],
      properties['Tags']
    );

    this.logger.debug(`Successfully updated CloudTrail Trail ${logicalId}`);

    // A skipped list block is recorded as what AWS still holds, the PREVIOUS
    // value, so the next deploy diffs the template against it again and the
    // warning repeats until the template is fixed. An unusable previous
    // value drops the key.
    const skipped = [
      ...(selectorsUnusable ? ['EventSelectors', 'AdvancedEventSelectors'] : []),
      ...(aggregationRead.kind === 'unusable' ? ['AggregationConfigurations'] : []),
    ];
    if (skipped.length === 0) return { physicalId, wasReplaced: false };
    // Only a present-but-unusable previous value needs the live reading,
    // so the read runs on that malformed path alone.
    const needsLive = skipped.some(
      (key) => previousProperties[key] != null && !Array.isArray(previousProperties[key])
    );
    const live = needsLive ? await this.readLiveForRecord(physicalId, resourceType) : undefined;
    return {
      physicalId,
      wasReplaced: false,
      effectiveProperties: retainPreviousLists(
        desiredProperties,
        previousProperties,
        skipped,
        live
      ),
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update CloudTrail Trail ${logicalId}: ${text}` +
            (appliedBeforeFailure.length > 0
              ? ` (selector/aggregation writes already applied before this failure: ${appliedBeforeFailure.join('; ')})`
              : ''),
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/**
 * The live read-back a skipped block is recorded from when its previous
 * value is unusable. Best-effort: a failed read answers `undefined`, which
 * drops the key rather than failing an update AWS already applied.
 */
export async function readLiveForRecord(
  this: CloudTrailProvider,
  physicalId: string,
  resourceType: string
): Promise<Record<string, unknown> | undefined> {
  try {
    const live = await this.readCurrentState(physicalId, '', resourceType);
    return live !== undefined && live !== RESOURCE_NOT_FOUND ? live : undefined;
  } catch (error) {
    this.logger.debug(
      safeMsg`CloudTrail read-back for the record failed: ${describeAwsFailure(error).detail}`
    );
    return undefined;
  }
}
