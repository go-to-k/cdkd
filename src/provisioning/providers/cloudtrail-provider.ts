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
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

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
    const s3KeyPrefix = properties['S3KeyPrefix'] as string | undefined;
    const isMultiRegionTrail = properties['IsMultiRegionTrail'] as boolean | undefined;
    const includeGlobalServiceEvents = properties['IncludeGlobalServiceEvents'] as
      | boolean
      | undefined;
    const enableLogFileValidation = properties['EnableLogFileValidation'] as boolean | undefined;
    const isLogging = properties['IsLogging'] as boolean | undefined;
    const tags = properties['Tags'] as Array<{ Key: string; Value: string }> | undefined;
    const cloudWatchLogsLogGroupArn = properties['CloudWatchLogsLogGroupArn'] as string | undefined;
    const cloudWatchLogsRoleArn = properties['CloudWatchLogsRoleArn'] as string | undefined;
    const kmsKeyId = properties['KMSKeyId'] as string | undefined;
    const snsTopicName = properties['SnsTopicName'] as string | undefined;
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

      // Start logging if IsLogging is true (default behavior)
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
    // The helper's ORIGINAL rationale — that `UpdateTrail` rejects an
    // empty string outright — is only half true, and the surviving half
    // is unverified. A live probe (2026-08-10, issue #1160) sent `''`
    // ALONE for `SnsTopicName` and for `CloudWatchLogsLogGroupArn`
    // against a real trail: both were ACCEPTED and nulled the field out,
    // which is exactly why `''` is now the removal-reset sentinel below.
    // `KMSKeyId` was NOT probed (see the reset comment / issue #1533), so
    // it keeps the conservative drop.
    const emptyToUndefined = (v: unknown): string | undefined => {
      if (v === undefined || v === null || v === '') return undefined;
      return v as string;
    };

    // Removal semantics (issue #1160, live CFn A/B 2026-08-10 on a real
    // trail with every optional field set, then removed from the template).
    // `UpdateTrail` is a merge-semantics API — a Name+S3BucketName-only
    // update left every other live value untouched — so an absent field is
    // a silent no-op where CloudFormation resets. The A/B split the
    // umbrella's SUSPECT row in two:
    //
    //   RESET by CFn (mirrored below): S3KeyPrefix -> '', SnsTopicName ->
    //   '', IsMultiRegionTrail -> false, EnableLogFileValidation -> false,
    //   IncludeGlobalServiceEvents -> false. Each clear sentinel was probed
    //   ALONE against the live trail; the empty string is accepted for both
    //   string fields and nulls them out.
    //
    //   RETAINED by CFn (left as pass-through, pinned by tests):
    //   CloudWatchLogsLogGroupArn / CloudWatchLogsRoleArn kept their live
    //   values through the removal update, so the pass-through is already
    //   CFn parity. `KMSKeyId` and `IsOrganizationTrail` are NOT reset
    //   either, but for a different reason — neither could be A/B'd
    //   (a customer-managed KMS key's 7-day minimum deletion window would
    //   leave a pending-deletion orphan, and an organization trail needs an
    //   Organizations management account), so they are recorded as
    //   unmeasured rather than guessed. Tracked in issue #1533.
    //
    // The previous side is normalized through `emptyToUndefined` for presence
    // detection: `readCurrentState` always-emits `''` placeholders for
    // S3KeyPrefix / SnsTopicName, and a placeholder means "was not set" —
    // without this a never-configured field would look like a removal and
    // send a pointless clear. The three BOOLEANS are always-emitted too, but
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
    const cloudWatchLogsLogGroupArn = emptyToUndefined(properties['CloudWatchLogsLogGroupArn']);
    const cloudWatchLogsRoleArn = emptyToUndefined(properties['CloudWatchLogsRoleArn']);
    const kmsKeyId = emptyToUndefined(properties['KMSKeyId']);
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

      // Update EventSelectors if changed
      const newEventSelectors = properties['EventSelectors'] as EventSelector[] | undefined;
      const oldEventSelectors = previousProperties['EventSelectors'] as EventSelector[] | undefined;
      if (JSON.stringify(newEventSelectors) !== JSON.stringify(oldEventSelectors)) {
        if (newEventSelectors && newEventSelectors.length > 0) {
          this.logger.debug(`Updating event selectors for CloudTrail Trail ${logicalId}`);
          await this.getClient().send(
            new PutEventSelectorsCommand({
              TrailName: physicalId,
              EventSelectors: newEventSelectors,
            })
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

      // Handle IsLogging changes
      const oldIsLogging = previousProperties['IsLogging'] as boolean | undefined;
      if (isLogging !== oldIsLogging) {
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

    // Class 1 — CloudWatchLogsLogGroupArn / CloudWatchLogsRoleArn are a
    // type-discriminated pair: both required when CW logs are enabled,
    // neither when disabled.
    //
    // NOTE the original rationale here — that AWS rejects a `''` round-trip
    // with `CloudWatchLogsLogGroupArn is not in valid ARN format` — was
    // DISPROVEN by the issue #1160 probe (2026-08-10): `''` is accepted for
    // this field and nulls it out. The guard stands on its own remaining
    // rationale, which is the discriminator, not the rejection: the pair is
    // all-or-nothing, so emitting one placeholder without the other would
    // describe a state AWS cannot hold. Only emit both keys when AWS reports
    // both present (the discriminator is "both fields populated").
    // KNOWN BOUND, corrected 2026-08-10 (issue #1160 review): the previous
    // wording claimed "a console-side enable shows up as both fields
    // appearing at once on the next read". That is FALSE — the drift
    // comparator's top-level walk is baseline-keys-only, so a key absent
    // from the captured snapshot is never compared and a console-side
    // enable stays invisible. Emitting both as `''` would now be safe (the
    // update path drops them via `emptyToUndefined`, and the #1160 probe
    // disproved the rejection this guard was built on), so this is a
    // deliberate not-yet rather than an impossibility. Tracked in #1549. Pattern documented in
    // `feedback_always_emit_check_type_discriminator.md`.
    if (trail.CloudWatchLogsLogGroupArn && trail.CloudWatchLogsRoleArn) {
      result['CloudWatchLogsLogGroupArn'] = trail.CloudWatchLogsLogGroupArn;
      result['CloudWatchLogsRoleArn'] = trail.CloudWatchLogsRoleArn;
    }

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
