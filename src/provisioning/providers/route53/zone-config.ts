import type { Route53Provider } from '../route53-provider.js';
import {
  GetHostedZoneCommand,
  ChangeTagsForResourceCommand,
  AssociateVPCWithHostedZoneCommand,
  DisassociateVPCFromHostedZoneCommand,
  CreateQueryLoggingConfigCommand,
  DeleteQueryLoggingConfigCommand,
  ListQueryLoggingConfigsCommand,
  type VPCRegion,
} from '@aws-sdk/client-route-53';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { isRefusedByName, type DeleteProgress } from '../../delete-started.js';
import type { UpdateContext } from '../../../types/resource.js';
import { declaredVpcIds, sentence } from './shared.js';

// ─── HostedZone Helpers ───────────────────────────────────────────

/**
 * Apply tags to a hosted zone using ChangeTagsForResource.
 * CFn property: HostedZoneTags (array of {Key, Value}).
 *
 * `previousProperties` is passed on the UPDATE path only, and turns this
 * from an add-only apply into a real DIFF (issue #1160). Without it a tag
 * removed from the template stayed on the zone forever — the add-only shape
 * has no way to express a removal, and the `length === 0` early return made
 * clearing ALL tags a silent no-op. `ChangeTagsForResource` takes
 * `RemoveTagKeys` alongside `AddTags` in ONE call, and CloudFormation does
 * untag a removed tag (live A/B, 2026-08-10), so the previous-minus-desired
 * key set is sent as removals. Create keeps passing `undefined` — there is
 * nothing to remove from a zone that did not exist a moment ago.
 */
export async function applyHostedZoneTags(
  this: Route53Provider,
  zoneId: string,
  properties: Record<string, unknown>,
  logicalId: string,
  previousProperties?: Record<string, unknown>,
  mask?: (text: string) => string
): Promise<void> {
  // A present-but-MALFORMED desired list must not be read as "the user
  // removed every tag". `readHostedZoneTags` collapses anything it cannot
  // use to a SHORTER list, which is indistinguishable from a real removal at
  // the value level — and acting on it would UNTAG a live zone on the
  // strength of an unresolved intrinsic. That is the destructive direction of
  // the "never infer a default from a possibly-malformed value" rule
  // (issues #1471 / #1493).
  //
  // The check is deliberately LOSSY-READ based, not just container-shaped: a
  // per-ELEMENT malformation (`[{ Key: { Ref: 'X' } }]`) is still "genuinely
  // an array", so a container-only guard would let exactly this destructive
  // case through one level down. Any entry the reader had to drop makes the
  // WHOLE list unusable.
  const desiredRaw = properties['HostedZoneTags'];
  if (desiredRaw != null && !Array.isArray(desiredRaw)) {
    this.logger.warn(
      `AWS::Route53::HostedZone HostedZoneTags must be an array on ${logicalId}; ` +
        `ignoring it and leaving the live tags untouched (no tag is added or removed)`
    );
    return;
  }

  const tags = this.readHostedZoneTags(properties);
  if (Array.isArray(desiredRaw) && tags.length !== desiredRaw.length) {
    this.logger.warn(
      `AWS::Route53::HostedZone HostedZoneTags on ${logicalId} carries ` +
        `${desiredRaw.length - tags.length} entr(y|ies) with a non-string Key or Value ` +
        `(check for an unresolved intrinsic); leaving the live tags untouched rather than ` +
        `applying a partial set or removing the tags those entries name`
    );
    return;
  }

  const previousTags = previousProperties ? this.readHostedZoneTags(previousProperties) : undefined;

  const desiredKeys = new Set(tags.map((t) => t.Key));
  // Removals are the previous side minus the desired side. Computing them
  // this way guarantees no key appears in BOTH lists, which the API would
  // otherwise have to arbitrate. De-duplicated because the previous side is
  // a STATE record and may legitimately carry a repeated key.
  const removeTagKeys = [
    ...new Set(
      (previousTags ?? [])
        .map((t) => t.Key)
        .filter((key) => key.length > 0 && !desiredKeys.has(key))
    ),
  ];

  if (tags.length === 0 && removeTagKeys.length === 0) return;

  try {
    await this.getClient().send(
      new ChangeTagsForResourceCommand({
        ResourceType: 'hostedzone',
        ResourceId: zoneId,
        ...(tags.length > 0 && {
          AddTags: tags.map((t) => ({ Key: t.Key, Value: t.Value })),
        }),
        ...(removeTagKeys.length > 0 && { RemoveTagKeys: removeTagKeys }),
      })
    );
    this.logger.debug(
      `Applied ${tags.length} tag(s) and removed ${removeTagKeys.length} tag(s) on hosted zone ${logicalId}`
    );
  } catch (error) {
    const detail = describeAwsFailure(error).detail;
    // The REMOVAL arm below throws through `wrapCaughtError`, so an
    // AWS-authored failure is persisted as its class only (go-to-k/cdkd#2319)
    // and stamped: its callers wrap this in `withRetry`, which reads the
    // withheld text on the `cause` chain to tell a retryable tag failure
    // from a permanent one. The warn on the ADD arm is terminal-only.
    // A failed ADD is self-healing: the template still declares the tag, so
    // the next deploy retries it. A failed REMOVAL is NOT — this update
    // returns success, state is rewritten WITHOUT the tag, and the next
    // deploy's previous side no longer carries it, so the removal is never
    // attempted again and the tag survives on AWS forever with `cdkd diff`
    // reporting clean. That is precisely the #1160 failure mode this fix
    // exists to close, so a removal failure has to be loud.
    if (removeTagKeys.length > 0) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to remove tag(s) ${removeTagKeys.join(', ')} from hosted zone ${logicalId}: ` +
              `${sentence(text)} The removal will NOT be retried on the next deploy (state no ` +
              `longer records the tag), so it is reported instead of ignored.`,
            'AWS::Route53::HostedZone',
            logicalId,
            zoneId,
            cause
          )
      );
    }
    // Masked: AWS can echo a resolved tag value back (go-to-k/cdkd#2319).
    const m = mask ?? ((text: string) => text);
    this.logger.warn(m(`Failed to apply tags to hosted zone ${logicalId}: ${m(detail)}`));
  }
}

/**
 * Read `HostedZoneTags` off a property bag, dropping entries whose shape an
 * unresolved intrinsic or a hand-authored L1 made unusable. Returns a
 * possibly-SHORTER list rather than throwing — the caller compares the length
 * against the raw input to decide whether the read was lossy, and only the
 * DESIRED side treats a lossy read as a refusal. The previous (state-borne)
 * side stays permissive: a record an older binary wrote must not block an
 * ordinary update, which a rollback replay could not then edit its way out of.
 *
 * `Value` is validated as well as `Key`. Route 53 rejects a tag whose value
 * is absent or non-string, and because Add and Remove ride the SAME
 * `ChangeTagsForResource` call, one bad value would fail the whole request —
 * silently taking the REMOVALS down with it.
 */
export function readHostedZoneTags(
  this: Route53Provider,
  properties: Record<string, unknown>
): Array<{ Key: string; Value: string }> {
  const tags = properties['HostedZoneTags'];
  if (!Array.isArray(tags)) return [];
  return tags.filter((t): t is { Key: string; Value: string } => {
    if (typeof t !== 'object' || t === null) return false;
    const entry = t as { Key?: unknown; Value?: unknown };
    return typeof entry.Key === 'string' && typeof entry.Value === 'string';
  });
}

/**
 * Apply QueryLoggingConfig to a hosted zone.
 * CFn property: QueryLoggingConfig ({ CloudWatchLogsLogGroupArn }).
 * Only one query logging config per hosted zone is allowed.
 */
export async function applyQueryLoggingConfig(
  this: Route53Provider,
  zoneId: string,
  properties: Record<string, unknown>,
  logicalId: string,
  previousProperties?: Record<string, unknown>,
  mask?: (text: string) => string,
  markUnsettled?: (propertyName: string) => void
): Promise<void> {
  const cloudWatchLogsLogGroupArn = this.readQueryLogGroupArn(properties);

  // A present-but-MALFORMED desired block must not be read as a REMOVAL —
  // deleting a live query-logging config on the strength of an unresolved
  // intrinsic is the destructive direction of the #1471 / #1493 rule.
  //
  // "Malformed" here means a NON-OBJECT container, or an object whose
  // `CloudWatchLogsLogGroupArn` is PRESENT but unusable (an unresolved
  // intrinsic renders as `{ CloudWatchLogsLogGroupArn: { Ref: … } }`). An
  // object that simply LACKS the key — `{}` — is treated as ABSENT, i.e. a
  // genuine removal, because that is exactly what this provider's own
  // `readHostedZone` emits as the canonical "no live config": `cdkd drift`
  // hands `observedProperties` back as the desired side on `--revert`, so
  // warning on `{}` would fire on every hosted-zone revert and tell the user
  // to omit a block they never wrote.
  const desiredBlock = properties['QueryLoggingConfig'];
  const desiredBlockIsObject =
    typeof desiredBlock === 'object' && desiredBlock !== null && !Array.isArray(desiredBlock);
  const desiredArnPresent =
    desiredBlockIsObject &&
    (desiredBlock as Record<string, unknown>)['CloudWatchLogsLogGroupArn'] !== undefined;
  const desiredUnusable =
    cloudWatchLogsLogGroupArn === undefined &&
    desiredBlock != null &&
    (!desiredBlockIsObject || desiredArnPresent);

  if (desiredUnusable) {
    this.logger.warn(
      `AWS::Route53::HostedZone QueryLoggingConfig on ${logicalId} carries no usable ` +
        `CloudWatchLogsLogGroupArn; leaving the live query logging config untouched ` +
        `(omit the block entirely to delete it)`
    );
    return;
  }

  if (cloudWatchLogsLogGroupArn === undefined) {
    // REMOVAL (issue #1160). `previousProperties` is supplied on the UPDATE
    // path only, so create still returns silently for an absent block.
    // Dropping `QueryLoggingConfig` from the template used to leave the live
    // config in place: query logging kept writing to CloudWatch — and kept
    // billing — with the template saying otherwise and `cdkd diff` reporting
    // no changes, i.e. permanently invisible. CloudFormation deletes it
    // (live A/B, 2026-08-10).
    //
    // Gated on the PREVIOUS side actually having carried a config rather
    // than firing on every update: a `ListQueryLoggingConfigs` probe per
    // hosted-zone update would cost a call on every deploy to discover
    // nothing, and deleting a config cdkd never created is out of scope for
    // a removal reset (that is drift, which `cdkd drift` owns).
    if (previousProperties !== undefined && this.readQueryLogGroupArn(previousProperties)) {
      this.logger.debug(
        `QueryLoggingConfig removed from template for hosted zone ${logicalId}; deleting the live config`
      );
      // `deleteQueryLoggingConfigForZone` swallows its own failures, which is
      // right on the create + delete paths that call it. On the REMOVAL path
      // it is not: this update returns success, state is rewritten without
      // `QueryLoggingConfig`, and the next deploy's previous side no longer
      // carries it — so a swallowed failure means the config keeps writing to
      // CloudWatch, and billing, forever with `cdkd diff` clean. That is the
      // exact #1160 failure mode, so verify the delete actually happened.
      markUnsettled?.('QueryLoggingConfig');
      await this.deleteQueryLoggingConfigForZone(zoneId, logicalId);
      const remaining = await this.listQueryLoggingConfigIds(zoneId);
      if (remaining.length > 0) {
        throw new ProvisioningError(
          `QueryLoggingConfig was removed from the template for hosted zone ${logicalId} but ` +
            `the live config (${remaining.join(', ')}) is still present. The removal will NOT ` +
            `be retried on the next deploy (state no longer records the property), so it is ` +
            `reported instead of ignored.`,
          'AWS::Route53::HostedZone',
          logicalId,
          zoneId
        );
      }
    }
    return;
  }

  // Unchanged on an update: leave it alone. The replacement below is not
  // atomic, so re-running it on every deploy could lose a working config to
  // a change that never touched it (a Comment edit, say). A config deleted
  // out of band is drift, which `cdkd drift` owns.
  if (
    previousProperties !== undefined &&
    this.readQueryLogGroupArn(previousProperties) === cloudWatchLogsLogGroupArn
  ) {
    return;
  }

  try {
    // Delete existing query logging config first (only one allowed per zone).
    // Marked first: a create failing after this leaves no config, and an
    // unchanged template could not tell (#5380).
    markUnsettled?.('QueryLoggingConfig');
    await this.deleteQueryLoggingConfigForZone(zoneId, logicalId);

    await this.getClient().send(
      new CreateQueryLoggingConfigCommand({
        HostedZoneId: zoneId,
        CloudWatchLogsLogGroupArn: cloudWatchLogsLogGroupArn,
      })
    );
    this.logger.debug(`Applied query logging config to hosted zone ${logicalId}`);
  } catch (error) {
    // On a create this is a replay finding its own config. On an update the
    // ARN changed, so it is the OLD config, whose delete was swallowed.
    if (
      previousProperties === undefined &&
      error instanceof Error &&
      error.name === 'QueryLoggingConfigAlreadyExists'
    ) {
      this.logger.debug(`Query logging config already exists for hosted zone ${logicalId}`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to apply query logging config to hosted zone ${logicalId}: ${text}`,
          'AWS::Route53::HostedZone',
          logicalId,
          zoneId,
          cause
        )
    );
  }
}

/**
 * Read `QueryLoggingConfig.CloudWatchLogsLogGroupArn` off a property bag,
 * returning `undefined` for an absent block, a malformed container, or a
 * blank / non-string ARN. One helper so the DESIRED and PREVIOUS sides
 * cannot classify the same shape differently — an asymmetry there would
 * make a removal fire (or not) depending on which side was malformed.
 */
export function readQueryLogGroupArn(
  this: Route53Provider,
  properties: Record<string, unknown>
): string | undefined {
  const config = properties['QueryLoggingConfig'];
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return undefined;
  const arn = (config as Record<string, unknown>)['CloudWatchLogsLogGroupArn'];
  return typeof arn === 'string' && arn.length > 0 ? arn : undefined;
}

/**
 * List the live query-logging config ids for a hosted zone.
 *
 * Used by the REMOVAL path to VERIFY the delete landed, because
 * `deleteQueryLoggingConfigForZone` deliberately swallows its failures and a
 * swallowed removal is permanent (see the call site). A zone that has gone
 * away counts as "no config", so the NotFound shapes resolve to `[]` rather
 * than failing the deploy on a resource that is already absent.
 */
export async function listQueryLoggingConfigIds(
  this: Route53Provider,
  zoneId: string
): Promise<string[]> {
  try {
    const response = await this.getClient().send(
      new ListQueryLoggingConfigsCommand({ HostedZoneId: zoneId })
    );
    return (response.QueryLoggingConfigs ?? [])
      .map((config) => config.Id)
      .filter((id): id is string => typeof id === 'string');
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'NoSuchHostedZone' || error.name === 'NoSuchQueryLoggingConfig')
    ) {
      return [];
    }
    throw error;
  }
}

/**
 * Delete query logging config(s) for a hosted zone.
 */
export async function deleteQueryLoggingConfigForZone(
  this: Route53Provider,
  zoneId: string,
  logicalId: string,
  progress?: DeleteProgress
): Promise<void> {
  try {
    const listResponse = await this.getClient().send(
      new ListQueryLoggingConfigsCommand({ HostedZoneId: zoneId })
    );
    const configs = listResponse.QueryLoggingConfigs ?? [];
    for (const config of configs) {
      if (config.Id) {
        // go-to-k/cdkd#4946: before the call, whose failure is swallowed below
        // and may have landed; restored when AWS refused it by name.
        const before = progress?.stripped;
        if (progress) progress.stripped = true;
        try {
          await this.getClient().send(new DeleteQueryLoggingConfigCommand({ Id: config.Id }));
        } catch (deleteError) {
          if (progress && before !== undefined && isRefusedByName(deleteError)) {
            progress.stripped = before;
          }
          throw deleteError;
        }
        this.logger.debug(`Deleted query logging config ${config.Id} for hosted zone ${logicalId}`);
      }
    }
  } catch (error) {
    // NoSuchHostedZone or NoSuchQueryLoggingConfig are not fatal during cleanup
    if (
      error instanceof Error &&
      (error.name === 'NoSuchHostedZone' || error.name === 'NoSuchQueryLoggingConfig')
    ) {
      return;
    }
    this.logger.warn(
      `Failed to delete query logging config for hosted zone ${logicalId}: ${describeAwsFailure(error).detail}`
    );
  }
}

/**
 * Sync VPC associations for a private hosted zone during update.
 * Associates each desired VPC the zone lacks, then disassociates each live
 * VPC the previous side declared and the desired side dropped.
 * An absent or empty desired `VPCs` returns early, keeping every association,
 * as CloudFormation does (see {@link VPCS_KEPT_ON_REMOVAL_NOTE}).
 */
export async function syncVPCAssociations(
  this: Route53Provider,
  zoneId: string,
  properties: Record<string, unknown>,
  logicalId: string,
  previousProperties: Record<string, unknown>,
  mask?: (text: string) => string,
  marks?: Pick<UpdateContext, 'markUnsettled' | 'markAttempted'>
): Promise<void> {
  const desiredVpcs = properties['VPCs'] as Array<Record<string, unknown>> | undefined;
  if (!desiredVpcs || desiredVpcs.length === 0) return;

  try {
    // Get current VPC associations
    const getResponse = await this.getClient().send(new GetHostedZoneCommand({ Id: zoneId }));
    const currentVpcs = getResponse.VPCs ?? [];

    const currentVpcIds = new Set(currentVpcs.map((v) => v.VPCId));
    const desiredVpcIds = new Set(desiredVpcs.map((v) => v['VPCId'] as string));

    // Associate new VPCs
    for (const vpc of desiredVpcs) {
      const vpcId = vpc['VPCId'] as string;
      if (!currentVpcIds.has(vpcId)) {
        this.logger.debug(`Associating VPC ${vpcId} with hosted zone ${zoneId}`);
        marks?.markUnsettled?.('VPCs');
        await this.getClient().send(
          new AssociateVPCWithHostedZoneCommand({
            HostedZoneId: zoneId,
            VPC: {
              VPCId: vpcId,
              VPCRegion: vpc['VPCRegion'] as VPCRegion | undefined,
            },
          })
        );
        marks?.markAttempted?.('VPCs', [vpcId]);
        currentVpcIds.add(vpcId);
      }
    }

    // Only a VPC the previous side declared: one associated out of band is
    // drift, which `cdkd drift` owns. Every desired VPC is associated by
    // now and none is removed, so this cannot empty the zone.
    const previousVpcIds = new Set(declaredVpcIds(previousProperties['VPCs']));
    for (const vpc of currentVpcs) {
      if (vpc.VPCId && previousVpcIds.has(vpc.VPCId) && !desiredVpcIds.has(vpc.VPCId)) {
        this.logger.debug(`Disassociating VPC ${vpc.VPCId} from hosted zone ${zoneId}`);
        marks?.markUnsettled?.('VPCs');
        await this.getClient().send(
          new DisassociateVPCFromHostedZoneCommand({
            HostedZoneId: zoneId,
            VPC: {
              VPCId: vpc.VPCId,
              VPCRegion: vpc.VPCRegion,
            },
          })
        );
      }
    }
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to sync VPC associations for hosted zone ${logicalId}: ${text}`,
          'AWS::Route53::HostedZone',
          logicalId,
          zoneId,
          cause
        )
    );
  }
}
