import {
  DeleteWebhookCommand,
  UpdateProjectCommand,
  UpdateProjectVisibilityCommand,
  UpdateWebhookCommand,
  type ScopeConfiguration,
} from '@aws-sdk/client-codebuild';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch } from '../../region-check.js';
import type { ResourceUpdateResult, UpdateContext } from '../../../types/resource.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import type { CodeBuildProvider } from '../codebuild-provider.js';
import {
  DEFAULT_ENCRYPTION_KEY,
  type VisibilityRead,
  readVisibility,
  DEFAULT_WEBHOOK_BUILD_TYPE,
  type TriggersRead,
  readTriggers,
} from './shared.js';

/**
 * Bring the live webhook to what the template declares (go-to-k/cdkd#5627).
 * `liveWebhook` comes from `UpdateProject`'s answer, so this adds no read.
 *
 * CloudFormation's calls, from CloudTrail. `UpdateWebhook` runs on EVERY
 * project update with `Webhook: true`, an unchanged `Triggers` included, and
 * always sends `filterGroups` and `buildType`: a removed `FilterGroups` is `[]`
 * (the filters clear) and a removed `BuildType` is `BUILD`. A removed
 * `PullRequestBuildPolicy` is omitted and the live policy stays. The
 * unchanged-`Triggers` call stays, though it could be skipped: only it
 * restores an edit made out of band, and the update is already running.
 */
export async function reconcileWebhook(
  this: CodeBuildProvider,
  projectName: string,
  read: TriggersRead,
  liveWebhook: boolean
): Promise<void> {
  if (read.kind === 'disabled' && liveWebhook) {
    await this.getClient().send(new DeleteWebhookCommand({ projectName }));
    return;
  }
  if (read.kind !== 'enabled') return;
  if (!liveWebhook) {
    await this.createWebhook(projectName, read);
    return;
  }
  await this.getClient().send(
    new UpdateWebhookCommand({
      projectName,
      filterGroups: read.filterGroups ?? [],
      buildType: read.buildType ?? DEFAULT_WEBHOOK_BUILD_TYPE,
      rotateSecret: false,
      ...(read.pullRequestBuildPolicy !== undefined && {
        pullRequestBuildPolicy: read.pullRequestBuildPolicy,
      }),
    })
  );
}

/**
 * `UpdateProjectVisibility` (go-to-k/cdkd#2762). Omitting
 * `resourceAccessRole` CLEARS a role the project held: a CFn A/B (us-east-1)
 * moving `PUBLIC_READ` + role to `PRIVATE` with no role read back
 * `resourceAccessRole: null`.
 */
export async function applyVisibility(
  this: CodeBuildProvider,
  projectArn: string,
  read: Extract<VisibilityRead, { kind: 'usable' }>
): Promise<void> {
  await this.getClient().send(
    new UpdateProjectVisibilityCommand({
      projectArn,
      projectVisibility: read.visibility,
      ...(read.resourceAccessRole !== undefined && {
        resourceAccessRole: read.resourceAccessRole,
      }),
    })
  );
}

export async function update(
  this: CodeBuildProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  this.logger.debug(`Updating CodeBuild Project ${logicalId}: ${physicalId}`);
  const mask = maskerOrIdentity(context?.maskSecrets);
  // go-to-k/cdkd#2613: the physical id is a NAME, so a client in another
  // region than the state record would act on a same-named resource cdkd
  // does not manage. Refuse before any call; the client's region is
  // resolved only when there is one to compare with.
  assertRegionMatch(
    context?.expectedRegion ? await this.getClient().config.region() : undefined,
    context?.expectedRegion,
    resourceType,
    logicalId,
    physicalId,
    'pre-update'
  );

  // go-to-k/cdkd#5627: refused before `UpdateProject`, as CloudFormation
  // refuses the whole update. A rollback's replay leaves the webhook alone.
  const triggersRead = readTriggers(properties, mask);
  if (triggersRead.kind === 'unusable') {
    if (context?.replayingState !== true) {
      throw new ProvisioningError(triggersRead.reason, resourceType, logicalId, physicalId);
    }
    this.logger.warn(
      mask(
        `${triggersRead.reason}. Replaying a state record, so the webhook of CodeBuild ` +
          `Project ${physicalId} is left unchanged`
      )
    );
  }

  try {
    // The update addresses the recorded project, never a derived name: a
    // project keeps the name it was created under, whichever scheme that was.
    const input = this.mapProperties(() => physicalId, properties);
    input.name = physicalId;

    // Removal semantics (issue #1160, live CFn A/B 2026-08-10 on a
    // NO_SOURCE project). `UpdateProject` is a merge-semantics API — a
    // name-only update left every other live value untouched — so the
    // umbrella flagged all eight optional fields this provider forwards.
    // The A/B narrowed that to ONE: CloudFormation itself RETAINS
    // `Description` / `TimeoutInMinutes` / `QueuedTimeoutInMinutes` /
    // `ConcurrentBuildLimit` / `AutoRetryLimit` / `Cache` / `LogsConfig`
    // when the template drops them (CFn's own handler omits them from
    // `UpdateProject` and CodeBuild merges), so the pass-through above is
    // ALREADY CFn parity for those seven and they are deliberately NOT
    // reset — pinned by the retention tests rather than "fixed" into a
    // divergence.
    //
    // `BuildBatchConfig` is the one field CFn resets: after the removal
    // update the live project reported `buildBatchConfig: null`. The only
    // shape that clears it is an EMPTY object — omitting the field is the
    // no-op that produced the silent drop this issue tracks.
    //
    // This is `clearOnUpdateRemoval`'s semantic applied at the SDK layer
    // rather than through the helper itself: the helper substitutes a
    // clear value on the side it is given, and here the CFn side has no
    // spelling for "cleared" — the empty object is an SDK-shape value. It
    // is applied to the mapped input (instead of an adjusted property bag)
    // so the whole-bag forward into `mapProperties` stays intact.
    // Sub-key granularity, per docs/provider-rules.md#update-removal-semantics-clear-on-removal's
    // "test both shapes": a key dropped from a still-present
    // `BuildBatchConfig` needs no separate handling, because the block is
    // sent WHOLESALE — the mapper rebuilds it from the desired side each
    // time, so a dropped member arrives as an absent SDK member of a
    // present structure. That the empty object clears the whole block is
    // the same wholesale semantic, measured.
    const buildBatchConfigRemoved =
      properties['BuildBatchConfig'] == null && previousProperties['BuildBatchConfig'] != null;
    if (buildBatchConfigRemoved) {
      input.buildBatchConfig = {};
    }

    // go-to-k/cdkd#1160, CFn A/B (us-east-1, a CODECOMMIT-source project):
    // CloudFormation's UpdateProject carried `encryptionKey` and `tags` after
    // both were removed, and the project read back the AWS managed key
    // (`alias/aws/s3`, CodeBuild's documented default) and no user tag. A
    // direct probe showed the clear shapes: `encryptionKey: 'alias/aws/s3'`
    // reads back exactly as CFn's reset did (`''` is refused, min length
    // 1), and `tags: []` removes every tag (UpdateProject replaces the
    // list). `SourceVersion` is the opposite: CFn omitted it and the live
    // value was KEPT, so the merge pass-through is parity and it is not
    // reset. A `''` on either side is the `readCurrentState` placeholder for
    // "no key", never a declared one, so it counts as absent.
    const declaredKey = (value: unknown): boolean => value != null && value !== '';
    if (
      !declaredKey(properties['EncryptionKey']) &&
      declaredKey(previousProperties['EncryptionKey'])
    ) {
      input.encryptionKey = DEFAULT_ENCRYPTION_KEY;
    }
    if (properties['Tags'] == null && previousProperties['Tags'] != null) {
      input.tags = [];
    }

    // go-to-k/cdkd#5492, CFn A/B (us-east-1, a CODECOMMIT-source project in
    // a VPC with an EFS mount, a secondary source, version and artifact, and
    // a badge): each of `VpcConfig` / `FileSystemLocations` /
    // `SecondarySources` / `SecondaryArtifacts` / `SecondarySourceVersions`
    // / `BadgeEnabled` was removed once alone and once beside a
    // `Description` change. CloudFormation's UpdateProject (CloudTrail)
    // omitted the removed member every time and the live value was KEPT, so
    // the merge pass-through is parity and none of the six is reset.
    const updated = await this.getClient().send(new UpdateProjectCommand(input));

    const liveWebhook = updated.project?.webhook;
    await this.reconcileWebhook(physicalId, triggersRead, liveWebhook != null);
    // `UpdateWebhook` has no scope member and drift does not read `Triggers`,
    // so name a declared scope the live webhook does not hold. Compared with
    // the webhook itself, never the record: a scope removed and declared again
    // never left it. Declared fields only: AWS may fill in others.
    if (
      triggersRead.kind === 'enabled' &&
      triggersRead.scopeConfiguration !== undefined &&
      liveWebhook != null &&
      Object.entries(triggersRead.scopeConfiguration).some(
        ([key, value]) =>
          liveWebhook.scopeConfiguration?.[key as keyof ScopeConfiguration] !== value
      )
    ) {
      this.logger.warn(
        mask(
          `The Triggers.ScopeConfiguration of CodeBuild Project ${physicalId} differs from its ` +
            `live webhook, which cannot change scope: the webhook keeps its scope. Delete it ` +
            `with Webhook: false, then deploy Webhook: true to apply the new one`
        )
      );
    }

    // go-to-k/cdkd#2762: `Visibility` / `ResourceAccessRole`, sent as a pair
    // whenever either differs from the record. A removal is the default
    // pair (PRIVATE, no role), which CloudFormation also applies (CFn A/B).
    // An unusable desired value is warned about and the live pair left
    // alone: this path is state-replay reachable, so it cannot refuse.
    //
    // Removing `ResourceAccessRole` while `PUBLIC_READ` stays sends
    // `PUBLIC_READ` with no role; CloudFormation clears the role in this
    // case and keeps the public alias (CFn A/B on go-to-k/cdkd#2762).
    const desiredVisibility = readVisibility(properties, mask);
    const recorded = readVisibility(previousProperties, mask);
    if (desiredVisibility.kind === 'unusable') {
      // Name what stays live: a project recorded PUBLIC_READ stays public.
      const kept = recorded.kind === 'usable' ? ` (recorded ${recorded.visibility})` : '';
      this.logger.warn(
        mask(
          `${desiredVisibility.reason}. Leaving the visibility of CodeBuild Project ` +
            `${physicalId} unchanged${kept}; the same value is REFUSED on a template-path create`
        )
      );
    } else {
      // The record is read leniently (it is state, not the template): an
      // unreadable one counts as changed, so the desired pair is sent.
      const changed =
        recorded.kind !== 'usable' ||
        recorded.visibility !== desiredVisibility.visibility ||
        recorded.resourceAccessRole !== desiredVisibility.resourceAccessRole;
      if (changed) {
        const projectArn = updated.project?.arn;
        if (projectArn === undefined) {
          throw new Error('UpdateProject returned no project ARN for the visibility update');
        }
        await this.applyVisibility(projectArn, desiredVisibility);
      }
    }

    this.logger.debug(`Successfully updated CodeBuild Project ${logicalId}`);

    return { physicalId, wasReplaced: false };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update CodeBuild Project ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        ),
      true
    );
  }
}
