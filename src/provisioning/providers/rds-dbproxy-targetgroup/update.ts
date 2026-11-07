import type { RDSDBProxyTargetGroupProvider } from '../rds-dbproxy-targetgroup-provider.js';
import {
  RegisterDBProxyTargetsCommand,
  DeregisterDBProxyTargetsCommand,
  DescribeDBProxyTargetGroupsCommand,
  ModifyDBProxyTargetGroupCommand,
  AddTagsToResourceCommand,
  RemoveTagsFromResourceCommand,
  DBProxyTargetNotFoundFault,
} from '@aws-sdk/client-rds';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import { markNonRetryable, markRedactedCause } from '../../../deployment/retryable-errors.js';
import { assertRegionMatch } from '../../region-check.js';
import { requireConfigString } from '../../config-shape.js';
import type { UpdateContext, ResourceUpdateResult } from '../../../types/resource.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { recordedPrincipalsRepair } from '../../iam-policy-targets.js';
import {
  DBPROXY_TAG_OPTIONS,
  DBPROXY_TAGS_WHAT,
  planTagDiff,
  refuseMalformedDesiredTags,
  tagPlanWarning,
} from '../../tag-list.js';
import { unchangedBehindSecretReference } from '../../secret-reference-immutable.js';
import {
  type TargetListKind,
  readTargetLists,
  SECRET_DERIVED_TARGETS_REPAIR,
  readProxyName,
  missingIdentifiers,
} from './shared.js';

/**
 * In-place update support: target add/remove (DBClusterIdentifiers /
 * DBInstanceIdentifiers diff) via `RegisterDBProxyTargets` /
 * `DeregisterDBProxyTargets`, and ConnectionPoolConfigurationInfo
 * rewrite via `ModifyDBProxyTargetGroup`. DBProxyName + TargetGroupName
 * are part of the resource identity — a diff in either surfaces as
 * replacement upstream (not handled here).
 */
export async function update(
  this: RDSDBProxyTargetGroupProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  const dbProxyName = readProxyName(properties['DBProxyName']);
  if (!dbProxyName) {
    throw new ProvisioningError(
      `DBProxyName is required for AWS::RDS::DBProxyTargetGroup ${logicalId} update`,
      resourceType,
      logicalId,
      physicalId
    );
  }
  // WARN, not throw: a rollback replays through `update()` with a historical
  // cdkd STATE record as the desired bag, so refusing here could leave a
  // resource un-rollbackable with no template-side remedy (issue #1513). The
  // `delete()` / `readCurrentState` reads below stay unguarded for the same
  // reason — both are state-side, never template-borne.
  //
  // Kept as a warning on EVERY caller, the template path included, when the
  // #3728 split was widened (issue #3740). `TargetGroupName` is createOnly
  // (CFn schema), so a changed value is a REPLACEMENT and never reaches
  // `update()`: a malformed value arriving here is one the recorded target
  // group already carries, and the only template edit that changes it
  // replaces the resource — not a repair a refusal could point at.
  const targetGroupName = requireConfigString(
    properties['TargetGroupName'],
    'default',
    'AWS::RDS::DBProxyTargetGroup TargetGroupName',
    { onUnusable: (message) => this.logger.warn(message) }
  );

  // Defensive: reject diffs in immutable identity fields. Replacement-rules.ts
  // SHOULD have routed those to a CREATE+DELETE replacement upstream; we
  // double-check here so a missing rule entry doesn't silently corrupt state.
  // The fields let through below because their recorded side is a secret
  // reference: confirmed against AWS before any write (see the probe).
  const exemptedBySecretReference: string[] = [];
  for (const field of ['DBProxyName', 'TargetGroupName']) {
    const oldVal = previousProperties[field];
    // Compare the GUARDED value for TargetGroupName, not the raw one. The
    // guard above may have warned and substituted 'default'; comparing the
    // raw `null` here would then throw `ResourceUpdateNotSupportedError` and
    // send the engine into a REPLACEMENT — making the warning's "using the
    // default for this update" a lie twelve lines after it was logged.
    const newVal = field === 'TargetGroupName' ? targetGroupName : properties[field];
    // TargetGroupName defaults to 'default' on AWS — treat undefined and
    // 'default' as equivalent on either side to avoid false-positive diff.
    const normalize = (v: unknown) =>
      field === 'TargetGroupName' && (v === undefined || v === 'default') ? 'default' : v;
    // A secret-derived name is recorded as its `{{resolve:...}}` reference
    // and handed here resolved, which is no change (go-to-k/cdkd#4275). The
    // physical id is the target group ARN, which names neither field.
    if (JSON.stringify(normalize(oldVal)) === JSON.stringify(normalize(newVal))) continue;
    if (
      await unchangedBehindSecretReference({
        resourceType,
        key: field,
        desired: newVal,
        previous: oldVal,
        maskSecrets: context?.maskSecrets,
      })
    ) {
      exemptedBySecretReference.push(field);
    } else {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        `${field} is immutable on AWS::RDS::DBProxyTargetGroup — destroy + redeploy to change it`
      );
    }
  }

  // Refused on every path, before any call: a malformed desired list read as
  // empty would untag every live key (tag-list.ts).
  refuseMalformedDesiredTags(
    properties['Tags'],
    resourceType,
    logicalId,
    physicalId,
    'Tags',
    DBPROXY_TAGS_WHAT,
    DBPROXY_TAG_OPTIONS
  );

  // Every AWS call below -- the live target read, the pool, deregister and
  // register calls -- addresses the proxy by NAME, which another region can
  // also hold, and the deregister arm reads NotFound as success: refuse a
  // wrong-region client before any of them goes out.
  // The client region is resolved only when there is a recorded region to
  // hold it to: without one the check is a no-op, and resolving it can fail
  // on a client with no region configured.
  if (context?.expectedRegion) {
    assertRegionMatch(
      await this.getClient().config.region(),
      context.expectedRegion,
      resourceType,
      logicalId,
      physicalId,
      'pre-update'
    );
  }

  // go-to-k/cdkd#4275: every write below is addressed by the DESIRED proxy
  // and target group names, not by the physical id. A field exempted above
  // proves only that its desired value is still secret-derived, and a secret
  // ROTATED under an unchanged reference resolves to another proxy's name:
  // AWS must confirm the desired names still address the recorded target
  // group (its ARN is the physical id) before anything is written. Any
  // failure to confirm keeps the refusal.
  //
  // A rollback revert re-resolves BOTH sides with today's secret, so they
  // compare equal and nothing is exempted above, while the names may now
  // address another proxy: a replay is confirmed the same way, whatever the
  // names' provenance (the masker's substring floor misses a short name).
  const replayCheck = exemptedBySecretReference.length === 0 && context?.replayingState === true;
  if (exemptedBySecretReference.length > 0 || replayCheck) {
    const fields = replayCheck
      ? 'DBProxyName / TargetGroupName'
      : exemptedBySecretReference.join(' / ');
    const provenance = replayCheck
      ? 'replayed by a rollback, which resolves any secret they come from again'
      : 'secret-derived';
    // Each resolved name masked as a VALUE first, so one below the masker's
    // substring floor is caught where AWS quotes it, then the whole line.
    const base = context?.maskSecrets ?? ((t: string) => t);
    const maskNames = (text: string): string => {
      let out = text;
      // Longest first: a name inside the other must not break its match.
      for (const name of [dbProxyName, targetGroupName].sort((a, b) => b.length - a.length)) {
        const masked = base(name);
        if (name !== '' && masked !== name) out = out.split(name).join(masked);
      }
      return base(out);
    };
    let liveArn: string | undefined;
    let lookupFailure: unknown;
    try {
      const response = await this.getClient().send(
        new DescribeDBProxyTargetGroupsCommand({
          DBProxyName: dbProxyName,
          TargetGroupName: targetGroupName,
        })
      );
      liveArn = response.TargetGroups?.[0]?.TargetGroupArn;
    } catch (error) {
      // A NOT-FOUND answer is an answer, not a failure: the resolved names
      // address nothing, which is the usual shape of a rotated proxy name
      // (AWS throws rather than returning an empty list). It falls through
      // to the non-retryable rotation refusal below; re-running would never
      // help it.
      const notFound =
        error instanceof Error &&
        (error.name === 'DBProxyNotFoundFault' || error.name === 'DBProxyTargetGroupNotFoundFault');
      if (!notFound) lookupFailure = error ?? new Error('an empty rejection');
      this.logger.debug(
        maskNames(
          `Could not confirm that the resolved names address ${logicalId}'s target group: ` +
            describeAwsFailure(error).detail
        )
      );
    }
    if (lookupFailure !== undefined) {
      // The refusal names the failure's CLASS only (the wire code, e.g.
      // `ThrottlingException`, `AccessDenied`): it
      // is not a rotation, and the operator's next step depends on which.
      // A `ProvisioningError`, NOT `ResourceUpdateNotSupportedError`: the
      // engine turns the latter into a replacement under `--replace`, and an
      // unconfirmed lookup is no evidence of a rename. The AWS text stays on
      // the cause (masked by the engine's error path), stamped so the retry
      // classifiers read it: a throttle stays retryable.
      const failureClass =
        lookupFailure instanceof Error && lookupFailure.name !== ''
          ? lookupFailure.name
          : 'an unreadable failure';
      const refusal = new ProvisioningError(
        `${fields} of AWS::RDS::DBProxyTargetGroup ${logicalId} is ${provenance}, and whether ` +
          `${replayCheck ? 'the names still address' : 'the value its secret resolves to still addresses'} the recorded target group could ` +
          `not be confirmed (${maskNames(failureClass)}) — re-run once the lookup can succeed`,
        resourceType,
        logicalId,
        physicalId,
        lookupFailure instanceof Error ? lookupFailure : undefined
      );
      markRedactedCause(refusal);
      throw refusal;
    }
    if (liveArn !== physicalId) {
      // A `ProvisioningError`, NOT `ResourceUpdateNotSupportedError`
      // (go-to-k/cdkd#4275): the template still spells the same reference, so
      // this is a rotation, not a rename, and the engine turns the typed error
      // into a replacement under `--replace`. Under `UpdateReplacePolicy:
      // Retain` that replacement is create-only, and `create()` registers the
      // targets on whatever proxy the secret now names, which can be another
      // environment's. Non-retryable: re-running reads the same secret.
      throw markNonRetryable(
        new ProvisioningError(
          `${fields} of AWS::RDS::DBProxyTargetGroup ${logicalId} is ${provenance}, and ` +
            `${replayCheck ? 'the names now address' : 'the value its secret now resolves to addresses'} ` +
            `${liveArn === undefined ? 'no target group' : 'a different target group'} ` +
            `(${replayCheck ? 'the proxy, or a secret its name comes from, may have changed' : 'the secret may have been rotated'}). ` +
            `cdkd does not move registered targets to another proxy, with or without ` +
            `--replace: ${replayCheck ? 'make the names address the proxy that holds this target group again' : "restore the secret's value to the proxy that holds this target group"}`,
          resourceType,
          logicalId,
          physicalId
        )
      );
    }
  }

  // go-to-k/cdkd#3945: both sides are read as target lists before ANY call,
  // the pool config included. The previous side is the state record, and a
  // rollback revert or `drift --revert` replays this method with a recorded
  // bag as the DESIRED side, so neither is trusted to be a list. A refusal,
  // not a warning, on every caller: a malformed list names no target, and
  // any diff against it deregisters a real one or registers a stranger.
  const next = readTargetLists({
    DBClusterIdentifiers: properties['DBClusterIdentifiers'],
    DBInstanceIdentifiers: properties['DBInstanceIdentifiers'],
  });
  let prev = readTargetLists({
    DBClusterIdentifiers: previousProperties['DBClusterIdentifiers'],
    DBInstanceIdentifiers: previousProperties['DBInstanceIdentifiers'],
  });
  const mask = context?.maskSecrets ?? ((t: string) => t);
  // A recorded list cdkd keeps as a dynamic reference or its mask is read
  // from the proxy instead, when the desired side is well-formed (the IAM
  // `readPrincipalSides` rule, go-to-k/cdkd#3906). ADD-only: the live list
  // is narrowed to the desired identifiers, so nothing is deregistered on
  // its evidence — a target registered elsewhere stays, and is warned about.
  if (
    next.malformed.length === 0 &&
    prev.malformed.length > 0 &&
    prev.malformed.every((k) => prev.secretDerived.includes(k))
  ) {
    let live: Record<TargetListKind, string[]>;
    try {
      live = await this.readLiveTargets(dbProxyName, targetGroupName);
    } catch (error) {
      throw new ProvisioningError(
        `the recorded ${prev.malformed.join(' / ')} of AWS::RDS::DBProxyTargetGroup ${logicalId} ` +
          `is secret-derived and could not be read from the proxy — no target registered or ` +
          `deregistered, and the connection pool left unchanged`,
        resourceType,
        logicalId,
        physicalId,
        error instanceof Error ? error : undefined
      );
    }
    const lists = { ...prev.lists };
    for (const kind of prev.malformed) {
      const extra = missingIdentifiers(live[kind], next.lists[kind]);
      lists[kind] = missingIdentifiers(live[kind], extra);
      if (extra.length > 0) {
        this.logger.warn(
          safeMsg`The recorded ${kind} of DB proxy target group ${logicalId} is secret-derived, so cdkd read it from the proxy; the proxy also holds ${extra.length} target(s) the template does not declare, which cdkd leaves registered.`
        );
      }
    }
    prev = { lists, malformed: [], secretDerived: [] };
  }
  if (next.malformed.length > 0 || prev.malformed.length > 0) {
    const which = [
      ...next.malformed.map((k) => `desired ${k}`),
      ...prev.malformed.map((k) => `recorded ${k}`),
    ];
    throw new ProvisioningError(
      `${which.join(' / ')} of AWS::RDS::DBProxyTargetGroup ${logicalId} is not a list of RDS ` +
        `DB identifiers — no target registered or deregistered, and the connection pool ` +
        `left unchanged` +
        (prev.malformed.length > 0
          ? `: ${recordedPrincipalsRepair(
              prev.malformed,
              prev.secretDerived,
              'RDS DB identifiers',
              SECRET_DERIVED_TARGETS_REPAIR
            )}`
          : ''),
      resourceType,
      logicalId,
      physicalId
    );
  }

  const tagPlan = planTagDiff(previousProperties['Tags'], properties['Tags'], DBPROXY_TAG_OPTIONS);
  const tagWarning = tagPlanWarning(tagPlan, resourceType, logicalId);
  if (tagWarning !== undefined) this.logger.warn(tagWarning);

  const client = this.getClient();

  // 1. ConnectionPoolConfigurationInfo diff.
  const oldPool = previousProperties['ConnectionPoolConfigurationInfo'] as
    | Record<string, unknown>
    | undefined;
  const newPool = properties['ConnectionPoolConfigurationInfo'] as
    | Record<string, unknown>
    | undefined;
  if (JSON.stringify(oldPool) !== JSON.stringify(newPool)) {
    this.logger.debug(
      mask(`Updating connection pool config for ${dbProxyName}/${targetGroupName}`)
    );
    try {
      await client.send(
        new ModifyDBProxyTargetGroupCommand({
          DBProxyName: dbProxyName,
          TargetGroupName: targetGroupName,
          // Pass new config (may be empty {} when user removed the block;
          // AWS treats empty as "reset to defaults").
          ConnectionPoolConfig: (newPool ?? {}) as never,
        })
      );
    } catch (error) {
      throw this.wrapError(
        error,
        'UPDATE (pool config)',
        resourceType,
        logicalId,
        physicalId,
        mask
      );
    }
  }

  // 2. Target diff: deregister removed, register added. Process clusters
  // and instances independently so the SDK call shape stays clean.
  const clustersToRemove = missingIdentifiers(
    prev.lists.DBClusterIdentifiers,
    next.lists.DBClusterIdentifiers
  );
  const clustersToAdd = missingIdentifiers(
    next.lists.DBClusterIdentifiers,
    prev.lists.DBClusterIdentifiers
  );
  const instancesToRemove = missingIdentifiers(
    prev.lists.DBInstanceIdentifiers,
    next.lists.DBInstanceIdentifiers
  );
  const instancesToAdd = missingIdentifiers(
    next.lists.DBInstanceIdentifiers,
    prev.lists.DBInstanceIdentifiers
  );

  if (clustersToRemove.length > 0 || instancesToRemove.length > 0) {
    this.logger.debug(
      mask(
        `Deregistering targets from ${dbProxyName}/${targetGroupName}: ` +
          `clusters=[${clustersToRemove.map(mask).join(',')}], ` +
          `instances=[${instancesToRemove.map(mask).join(',')}]`
      )
    );
    try {
      await client.send(
        new DeregisterDBProxyTargetsCommand({
          DBProxyName: dbProxyName,
          TargetGroupName: targetGroupName,
          DBClusterIdentifiers: clustersToRemove.length > 0 ? clustersToRemove : undefined,
          DBInstanceIdentifiers: instancesToRemove.length > 0 ? instancesToRemove : undefined,
        })
      );
    } catch (error) {
      // Idempotent: a target that's already gone is fine. The region was
      // checked before the first call, so this NotFound is this region's.
      if (!(error instanceof DBProxyTargetNotFoundFault)) {
        throw this.wrapError(
          error,
          'UPDATE (deregister)',
          resourceType,
          logicalId,
          physicalId,
          mask
        );
      }
    }
  }

  if (clustersToAdd.length > 0 || instancesToAdd.length > 0) {
    this.logger.debug(
      mask(
        `Registering targets to ${dbProxyName}/${targetGroupName}: ` +
          `clusters=[${clustersToAdd.map(mask).join(',')}], ` +
          `instances=[${instancesToAdd.map(mask).join(',')}]`
      )
    );
    try {
      await client.send(
        new RegisterDBProxyTargetsCommand({
          DBProxyName: dbProxyName,
          TargetGroupName: targetGroupName,
          DBClusterIdentifiers: clustersToAdd.length > 0 ? clustersToAdd : undefined,
          DBInstanceIdentifiers: instancesToAdd.length > 0 ? instancesToAdd : undefined,
        })
      );
    } catch (error) {
      throw this.wrapError(error, 'UPDATE (register)', resourceType, logicalId, physicalId, mask);
    }
  }

  // 3. Tags diff, addressed by the physicalId (the TargetGroupArn).
  const tagsToRemove = tagPlan.remove;
  const tagsToAdd = [...tagPlan.set].map(([Key, Value]) => ({ Key, Value }));
  if (tagsToRemove.length > 0) {
    try {
      await client.send(
        new RemoveTagsFromResourceCommand({
          ResourceName: physicalId,
          TagKeys: tagsToRemove,
        })
      );
    } catch (error) {
      throw this.wrapError(
        error,
        'UPDATE (remove tags)',
        resourceType,
        logicalId,
        physicalId,
        mask
      );
    }
  }
  if (tagsToAdd.length > 0) {
    try {
      await client.send(
        new AddTagsToResourceCommand({
          ResourceName: physicalId,
          Tags: tagsToAdd,
        })
      );
    } catch (error) {
      throw this.wrapError(error, 'UPDATE (add tags)', resourceType, logicalId, physicalId, mask);
    }
  }

  return { physicalId, wasReplaced: false };
}
