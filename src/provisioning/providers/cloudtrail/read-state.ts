import type { CloudTrailProvider } from '../cloudtrail-provider.js';
import {
  GetTrailCommand,
  GetTrailStatusCommand,
  GetEventSelectorsCommand,
  GetInsightSelectorsCommand,
  GetEventConfigurationCommand,
  ListTagsCommand,
  TrailNotFoundException,
} from '@aws-sdk/client-cloudtrail';
import { safeMsg } from '../../../utils/display-safe.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../../import-helpers.js';
import {
  type ResourceImportInput,
  type ResourceImportResult,
  type ResourceNotFound,
  RESOURCE_NOT_FOUND,
} from '../../../types/resource.js';
import { advancedSelectorsToCfn } from './shared.js';

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
 * `AdvancedEventSelectors` comes from the same `GetEventSelectors` call and
 * `AggregationConfigurations` from `GetEventConfiguration` (issue #2762).
 *
 * Returns `RESOURCE_NOT_FOUND` when the trail is gone (`TrailNotFoundException`).
 */
export async function readCurrentState(
  this: CloudTrailProvider,
  physicalId: string,
  _logicalId: string,
  _resourceType: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let trail;
  try {
    const resp = await this.getClient().send(new GetTrailCommand({ Name: physicalId }));
    trail = resp.Trail;
  } catch (err) {
    if (err instanceof TrailNotFoundException) return RESOURCE_NOT_FOUND;
    throw err;
  }
  if (!trail) return undefined;

  // Always-emit user-controllable top-level keys with placeholders so
  // console-side adds become visible to drift (the comparator's top-
  // level walk is state-keys-only, so an omitted key is invisible
  // forever). See docs/provider-rules.md#readcurrentstate-for-drift-detection.
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
  // or `AdvancedEventSelectors` (mutually exclusive — Class 1).
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
    // Issue #2762: always emitted (`[]` on a basic-selector trail). A
    // console-side change is drift only where the template DECLARES the key:
    // an undeclared key captured as `[]` is skipped by the comparator
    // (`undeclaredEmptyObservedKeys`).
    result['AdvancedEventSelectors'] = hasAdvanced
      ? advancedSelectorsToCfn(sel.AdvancedEventSelectors ?? [])
      : [];
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
        `CloudTrail ListTags(${trail.TrailARN}) failed: ${describeAwsFailure(err).detail}`
      );
    }
  }
  result['Tags'] = tags;

  // AggregationConfigurations — separate call (issue #2762), same member
  // names on both sides, `[]` being what AWS reports for a trail with none.
  // As for AdvancedEventSelectors, a console-side add is drift only where
  // the template declares the key (`undeclaredEmptyObservedKeys`). A failed
  // read omits the key rather than claiming the trail has none.
  try {
    const config = await this.getClient().send(
      new GetEventConfigurationCommand({ TrailName: physicalId })
    );
    result['AggregationConfigurations'] = (config.AggregationConfigurations ?? []).map((a) => ({
      ...(a.EventCategory !== undefined && { EventCategory: a.EventCategory }),
      ...(a.Templates !== undefined && { Templates: a.Templates }),
    }));
  } catch (err) {
    this.logger.debug(
      safeMsg`CloudTrail GetEventConfiguration(${physicalId}) failed: ${describeAwsFailure(err).detail}`
    );
  }

  return result;
}

export async function importImpl(
  this: CloudTrailProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
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
