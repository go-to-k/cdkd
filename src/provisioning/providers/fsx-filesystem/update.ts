import type { FSxFileSystemProvider } from '../fsx-filesystem-provider.js';
import { deployReplaceCommand } from '../../../utils/pasteable-command.js';
import {
  UpdateFileSystemCommand,
  DescribeFileSystemsCommand,
  type FileSystem,
  type StorageType,
  type NetworkType,
} from '@aws-sdk/client-fsx';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import type { ResourceUpdateResult, UpdateContext } from '../../../types/resource.js';
import {
  TOP_LEVEL_IMMUTABLE_PROPS,
  TOP_LEVEL_LEFT_IN_PLACE_PROPS,
  leftInPlaceWarning,
  toNumber,
} from './shared.js';

export async function update(
  this: FSxFileSystemProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
  const changed = (key: string): boolean =>
    JSON.stringify(properties[key]) !== JSON.stringify(previousProperties[key]);

  // Defensive guard: registry-createOnly top-level changes should have
  // been routed through DELETE+CREATE by the replacement-detection layer.
  // An undefined→defined transition (property ADDED post-create) is a
  // change too — do not require both sides to be present.
  for (const key of TOP_LEVEL_IMMUTABLE_PROPS) {
    const next = properties[key];
    const prev = previousProperties[key];
    if (JSON.stringify(next ?? null) !== JSON.stringify(prev ?? null)) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        `AWS FSx FileSystem ${key} is immutable on AWS — UpdateFileSystem does not accept ${key}; the property is fixed at creation. Re-deploy with ${deployReplaceCommand(true)} (the type is in cdkd's stateful-recreate guard set, so a bare --replace is refused a second time with STATEFUL_REPLACE_BLOCKED), or destroy + redeploy the stack.`
      );
    }
  }

  // Variant sub-property immutability: the CFn registry schema does NOT
  // mark the <Variant>Configuration blocks (or their sub-fields) createOnly,
  // so the schema-based replacement fallback never fires for them — the
  // provider classifies each itself, mapping the UpdateFileSystem-mutable
  // subset and rejecting every other changed sub-field with a --replace
  // pointer. At most ONE variant block is present per file system.
  const variantConfigKey = this.detectVariantConfigKey(properties, previousProperties);
  const {
    diff: variantDiff,
    hasMutableDiff: variantHasMutableDiff,
    leftInPlace,
    aliases,
  } = variantConfigKey
    ? this.computeVariantConfigDiff(
        resourceType,
        logicalId,
        variantConfigKey,
        (properties[variantConfigKey] ?? {}) as Record<string, unknown>,
        (previousProperties[variantConfigKey] ?? {}) as Record<string, unknown>
      )
    : { diff: {}, hasMutableDiff: false, leftInPlace: [], aliases: { add: [], remove: [] } };
  const aliasesChanged = aliases.add.length > 0 || aliases.remove.length > 0;
  // Issue #1160: named once, and only after the update SUCCEEDED (the
  // shared caller's own warning has the same timing) — a retried attempt
  // would repeat it, and a failure falling back to replacement would make
  // "stays in place" false. Not on `drift --revert`: its previous side is
  // an AWS readback, so a key the baseline lacks was never removed from a
  // template, and the revert sent nothing for it before either.
  const leftInPlaceNames = [
    ...TOP_LEVEL_LEFT_IN_PLACE_PROPS.filter(
      (key) => properties[key] === undefined && previousProperties[key] !== undefined
    ),
    ...leftInPlace.map((key) => `${variantConfigKey}.${key}`),
  ];
  const warnLeftInPlace = (): void => {
    if (leftInPlaceNames.length === 0 || context?.desiredFromAwsReadback) return;
    this.logger.warn(
      leftInPlaceWarning(
        logicalId,
        leftInPlaceNames,
        context?.replayingState ? 'rollback' : 'deploy',
        {
          fileSystemType: properties['FileSystemType'] ?? previousProperties['FileSystemType'],
          storageTypes: [previousProperties['StorageType'], properties['StorageType']],
          deploymentTypes: [previousProperties, properties].map((side) =>
            variantConfigKey
              ? (side[variantConfigKey] as Record<string, unknown> | undefined)?.['DeploymentType']
              : undefined
          ),
          desiredNetworkType: properties['NetworkType'],
          desiredEndpointIpv6AddressRange:
            variantConfigKey === 'OpenZFSConfiguration'
              ? (properties[variantConfigKey] as Record<string, unknown> | undefined)?.[
                  'EndpointIpv6AddressRange'
                ]
              : undefined,
        }
      )
    );
  };

  // §3b Class 2 wire-layer sanitize. `readCurrentState` emits
  // `StorageCapacity ?? 0` as its always-emit placeholder, and the 0 is
  // REACHABLE on a real AWS shape: FSx Lustre Intelligent-Tiering
  // (`DataReadCacheConfiguration`) does not provision capacity, so
  // `DescribeFileSystems` returns no `StorageCapacity` for it —
  // `StorageCapacity` is neither createOnly nor required in the registry
  // schema for exactly that reason. If such a placeholder ever reaches
  // here as a "change" (an undefined-at-capture / defined-later
  // transition), shipping `StorageCapacity: 0` would earn an opaque AWS
  // rejection. Suppress the field instead of sending it: 0 is never a
  // legal desired capacity, so there is nothing to express — and
  // suppressing rather than throwing keeps an otherwise-valid update (a
  // variant-config diff in the same call) working, instead of failing it
  // over a synthetic value the user never wrote. Folded into the
  // `changed()` flag so the no-op early-return below also sees it: when
  // the placeholder is the ONLY diff, the update is correctly a no-op
  // rather than an empty UpdateFileSystem call.
  const resolvedStorageCapacity = toNumber(properties['StorageCapacity']);
  const storageCapacityIsPlaceholder =
    resolvedStorageCapacity !== undefined && resolvedStorageCapacity <= 0;
  if (storageCapacityIsPlaceholder && changed('StorageCapacity')) {
    this.logger.debug(
      `Suppressing non-positive StorageCapacity (${resolvedStorageCapacity}) for FSx FileSystem ${logicalId}: this is the readCurrentState placeholder for a capacity-less file system (Lustre Intelligent-Tiering), not a desired value.`
    );
  }
  // Issue #1160: a top-level property REMOVED from the desired side has
  // nothing to send — `UpdateFileSystem` keeps a field it is not sent, and
  // cdkd sends no reset for these (`TOP_LEVEL_LEFT_IN_PLACE_PROPS`; the
  // removal is named in `warnLeftInPlace`). Counting it as a change would
  // only issue an `UpdateFileSystem` carrying no update field.
  const sendsChange = (key: string): boolean => changed(key) && properties[key] !== undefined;
  const storageCapacityChanged = sendsChange('StorageCapacity') && !storageCapacityIsPlaceholder;
  const storageTypeChanged = sendsChange('StorageType');
  const typeVersionChanged = sendsChange('FileSystemTypeVersion');
  const networkTypeChanged = sendsChange('NetworkType');
  const tagsChanged = changed('Tags');

  if (
    !variantHasMutableDiff &&
    !storageCapacityChanged &&
    !storageTypeChanged &&
    !typeVersionChanged &&
    !networkTypeChanged &&
    !aliasesChanged &&
    !tagsChanged
  ) {
    this.logger.debug(`No mutable diff for FSx FileSystem ${logicalId}, skipping update`);
    warnLeftInPlace();
    return { physicalId, wasReplaced: false };
  }

  this.logger.debug(`Updating FSx FileSystem ${logicalId}: ${physicalId}`);

  try {
    // One deadline for every wait this update runs: the FILE_SYSTEM_UPDATE
    // action, then the alias changes (go-to-k/cdkd#5469).
    const deadline = Date.now() + this.maxWaitMs;
    const needsUpdateCall =
      variantHasMutableDiff ||
      storageCapacityChanged ||
      storageTypeChanged ||
      typeVersionChanged ||
      networkTypeChanged;

    let updatedFs: FileSystem | undefined;

    if (needsUpdateCall) {
      const callTimeMs = Date.now();
      const updateResponse = await this.getClient().send(
        new UpdateFileSystemCommand({
          FileSystemId: physicalId,
          ...(storageCapacityChanged && {
            StorageCapacity: toNumber(properties['StorageCapacity']),
          }),
          ...(storageTypeChanged && {
            StorageType: properties['StorageType'] as StorageType | undefined,
          }),
          ...(typeVersionChanged && {
            FileSystemTypeVersion: properties['FileSystemTypeVersion'] as string | undefined,
          }),
          ...(networkTypeChanged && {
            NetworkType: properties['NetworkType'] as NetworkType | undefined,
          }),
          ...(variantHasMutableDiff && variantConfigKey ? { [variantConfigKey]: variantDiff } : {}),
        })
      );

      // UpdateFileSystem applies the change via an ASYNC administrative
      // action (`AdministrativeActions[].Type: FILE_SYSTEM_UPDATE`) — the
      // Lifecycle can report AVAILABLE while the config change has not
      // propagated to the Describe view yet (observed live: a
      // DataCompressionType NONE -> LZ4 change still read NONE seconds
      // after UpdateFileSystem returned). Wait until THIS update's action
      // completes so the next read (drift compare, verify scripts) sees
      // the final values — CloudFormation waits the same way.
      //
      // The wait must scope to actions from THIS update: FSx keeps
      // completed/FAILED actions in the AdministrativeActions history, so
      // an unscoped wait would (a) mistake a PAST failed update for this
      // one, permanently failing every retry, and (b) return early when
      // the just-created action is not visible in Describe yet. The
      // UpdateFileSystem response carries the newly-created action —
      // derive the tracking threshold from its RequestTime, falling back
      // to the local call time minus a clock-skew margin.
      const respPendingActions = (updateResponse.FileSystem?.AdministrativeActions ?? []).filter(
        (a) =>
          a.AdministrativeActionType === 'FILE_SYSTEM_UPDATE' &&
          (a.Status === 'PENDING' || a.Status === 'IN_PROGRESS')
      );
      const requestTimes = respPendingActions
        .map((a) => a.RequestTime?.getTime())
        .filter((t): t is number => t !== undefined);
      const actionThresholdMs =
        requestTimes.length > 0 ? Math.min(...requestTimes) : callTimeMs - 60_000;

      updatedFs = await this.waitForUpdateActionComplete(
        physicalId,
        logicalId,
        resourceType,
        actionThresholdMs,
        // When the update response CONFIRMED a newly-created action, the
        // wait must actually observe an in-threshold action at least once
        // before returning — a lagging Describe read replica could
        // otherwise yield an empty filtered list (inProgress=false) and
        // return prematurely with the pre-update config.
        respPendingActions.length > 0,
        deadline,
        context?.maskSecrets
      );
    }

    // go-to-k/cdkd#5469: after the UpdateFileSystem action settled, so the
    // alias actions never overlap it.
    if (aliasesChanged) {
      await this.applyAliasDelta(physicalId, logicalId, resourceType, aliases, deadline);
    }

    if (tagsChanged) {
      await this.applyTagDiff(
        physicalId,
        resourceType,
        logicalId,
        properties['Tags'],
        previousProperties['Tags']
      );
    }

    // Re-derive the attribute set so the deploy engine's state write keeps
    // GetAtt-served attributes (DNSName / LustreMountName / ResourceARN)
    // fresh across updates — an update result without attributes would
    // otherwise degrade Fn::GetAtt to the physical-id fallback. Best-effort:
    // the real update already succeeded at this point, so a transient
    // Describe failure must NOT fail (and roll back) the whole update —
    // returning without attributes lets the deploy engine carry the
    // previously-stored attributes forward, which is exactly the intended
    // degradation.
    if (!updatedFs) {
      try {
        const resp = await this.getClient().send(
          new DescribeFileSystemsCommand({ FileSystemIds: [physicalId] })
        );
        updatedFs = resp.FileSystems?.[0];
      } catch (describeError) {
        this.logger.debug(
          `Post-update attribute refresh for ${physicalId} failed (returning without attributes): ${
            describeAwsFailure(describeError).detail
          }`
        );
      }
    }

    this.logger.debug(`Successfully updated FSx FileSystem ${logicalId}`);
    warnLeftInPlace();

    return {
      physicalId,
      wasReplaced: false,
      ...(updatedFs && { attributes: this.buildAttributes(updatedFs) }),
    };
  } catch (error) {
    if (error instanceof ProvisioningError) throw error;
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update FSx FileSystem ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}
