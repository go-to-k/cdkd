import {
  CreateRouteTableCommand,
  DeleteRouteTableCommand,
  CreateRouteCommand,
  DeleteRouteCommand,
  ReplaceRouteCommand,
  AssociateRouteTableCommand,
  DisassociateRouteTableCommand,
} from '@aws-sdk/client-ec2';
import {
  CdkdError,
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { compositeIdFormatMessage, packCompositeId } from '../../composite-id.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import { acquireIdempotencyToken } from '../idempotency-token.js';
import { maskerOrIdentity, type MaskerFn } from '../../masked-retry-logger.js';
import type {
  CreateContext,
  UpdateContext,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../../types/resource.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  EC2_ROUTE_ID_FORMAT,
  narrowRouteDestinations,
  routeMultipleDestinationsMessage,
  routeTargetParams,
} from './network-support.js';
import type { EC2Provider } from '../ec2-provider.js';

// ─── AWS::EC2::RouteTable ─────────────────────────────────────────

export async function createRouteTable(
  this: EC2Provider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating RouteTable ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

  const vpcId = properties['VpcId'] as string;
  if (!vpcId) {
    throw new ProvisioningError(
      `VpcId is required for RouteTable ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  // Issue #2039: a replayed create would leave an unstated route table
  // behind. Same release rule as the NAT gateway above.
  const routeTableToken = acquireIdempotencyToken({
    scope: 'CreateRouteTable',
    logicalId,
  });

  try {
    const { response, tagsApplied } = await this.sendTaggedCreate(
      logicalId,
      'route-table',
      desiredTags,
      (TagSpecifications) =>
        this.ec2Client.send(
          new CreateRouteTableCommand({
            VpcId: vpcId,
            ClientToken: routeTableToken.value,
            ...(TagSpecifications && { TagSpecifications }),
          })
        )
    );

    const routeTableId = response.RouteTable!.RouteTableId!;

    // Apply tags the create did not carry (go-to-k/cdkd#4971)
    if (!tagsApplied)
      await this.applyTags(
        routeTableId,
        desiredTags,
        logicalId,
        maskerOrIdentity(context?.maskSecrets)
      );

    this.logger.debug(`Successfully created RouteTable ${logicalId}: ${routeTableId}`);

    routeTableToken.release();
    return {
      physicalId: routeTableId,
      attributes: {
        RouteTableId: routeTableId,
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create RouteTable ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}

export async function deleteRouteTable(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting RouteTable ${logicalId}: ${physicalId}`);

  try {
    await this.ec2Client.send(new DeleteRouteTableCommand({ RouteTableId: physicalId }));
    this.logger.debug(`Successfully deleted RouteTable ${logicalId}`);
  } catch (error) {
    if (this.isNotFoundError(error)) {
      const clientRegion = await this.ec2Client.config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`RouteTable ${physicalId} does not exist, skipping deletion`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapDeleteError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete RouteTable ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

// ─── AWS::EC2::Route ──────────────────────────────────────────────

export async function createRoute(
  this: EC2Provider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  onMultipleDestinations?: (message: string) => void,
  maskSecrets?: MaskerFn
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating Route ${logicalId}`);

  const routeTableId = properties['RouteTableId'] as string;
  const destinationCidrBlock = properties['DestinationCidrBlock'] as string | undefined;
  const destinationIpv6CidrBlock = properties['DestinationIpv6CidrBlock'] as string | undefined;
  const destinationPrefixListId = properties['DestinationPrefixListId'] as string | undefined;
  // The destination key doubles as the physicalId's second segment
  // (`<routeTableId>|<destination>`); deleteRoute / readRouteCurrentState
  // discriminate the three forms by shape (':' = IPv6, 'pl-' = prefix list).
  const destination = destinationCidrBlock || destinationIpv6CidrBlock || destinationPrefixListId;

  if (!routeTableId || !destination) {
    throw new ProvisioningError(
      `RouteTableId and one of DestinationCidrBlock/DestinationIpv6CidrBlock/DestinationPrefixListId are required for Route ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  // A CFn-invalid template carrying MORE than one destination key would
  // otherwise deploy with only the highest-precedence one and silently drop
  // the rest, while CloudFormation / `CreateRoute` reject the combination
  // (InvalidParameterCombination). Refuse instead of narrowing (issue #1566).
  // `onMultipleDestinations` downgrades this to a warning on the STATE-borne
  // paths (rollback replay / the update path's delete-and-recreate), where a
  // refusal would leave the route unrestorable from a record the user cannot
  // edit; the pre-fix precedence then applies, so behavior there is unchanged.
  // Counted with the SAME predicate the `||` chain above uses (plain
  // truthiness), not a hand-listed `undefined | null | ''` set. The casts on
  // the three reads promise `string | undefined`, but the property bag is
  // `unknown`-valued at runtime, so a numeric `0` from an unquoted YAML
  // scalar is reachable — and under a narrower predicate the guard would
  // count a destination the chain skips, producing a spurious refusal.
  const { declared: declaredDestinations, narrowed: narrowedProperties } =
    narrowRouteDestinations(properties);

  // Set ONLY by the warn arm below, and only to the bag this method actually
  // sends — see the note there (issue #1591).
  let effectiveProperties: Record<string, unknown> | undefined;

  if (declaredDestinations.length > 1) {
    const message = routeMultipleDestinationsMessage(logicalId, declaredDestinations);
    if (onMultipleDestinations) {
      // The message states WHAT happened and nothing about WHY, because the
      // two callers reach it for different reasons: the create arm is a
      // state replay (no prior delete), the update arm is a
      // delete-and-recreate. An earlier draft asserted a cdkd-state origin
      // (false on a template-borne update) and its replacement asserted a
      // just-deleted route (false on the replay create) — each caller's own
      // comment carries the rationale instead.
      //
      // `usedKey` comes from the SAME helper that resolves the wire call's
      // destination, so it always names the key actually sent — see
      // `narrowRouteDestinations` for why the winner is simply the first
      // declared key.
      const usedKey = declaredDestinations[0]!;
      // Hand the engine the bag we actually SEND, so state matches AWS
      // (issue #1591 — the residue #1590 knowingly left behind). Without
      // this the engine records every declared destination key while
      // `readRouteCurrentState` can only ever return the one AWS holds, so
      // the losers become PERMANENT phantom drift: reported by every
      // `cdkd drift`, and "repaired" by `drift --revert` into another
      // `update()` that delete-and-recreates the route and re-emits this
      // same warning, forever.
      //
      // Only the losing DESTINATION keys are dropped — everything else in
      // the bag was sent verbatim. The narrowing is already announced by the
      // warning below, so recording it makes state agree with the message
      // rather than hiding a loss the user was never told about.
      effectiveProperties = narrowedProperties;
      onMultipleDestinations(`${message} Continuing with ${usedKey} and ignoring the rest.`);
    } else {
      throw new ProvisioningError(message, resourceType, logicalId);
    }
  }

  // Refuse a `|` in either segment BEFORE `CreateRoute` runs (issue #1672).
  // Neither is realistically pipe-capable — `RouteTableId` is an AWS-generated
  // `rtb-...` and the destination is a CIDR or a `pl-...` prefix-list id — so
  // this is uniform defense-in-depth. The downgrade is what matters here: the
  // callback is the SAME one `updateRoute` already passes UNCONDITIONALLY,
  // because that path DELETES the route before re-creating it, so a throw
  // would strand a deleted route with no template-side remedy (issue #1566);
  // the create dispatch passes it only on a state replay, so the refusal
  // still stands on a template-borne deploy.
  const physicalId = packCompositeId(
    resourceType,
    logicalId,
    [
      { name: 'routeTableId', value: routeTableId },
      { name: 'destination', value: destination },
    ],
    // Issue #2176: the masker goes through unconditionally, and the refusal
    // arm stays conditional. Threaded a round later than its 13 siblings
    // because this helper takes a CALLBACK rather than a context, so the
    // thread stopped one layer short of the dispatcher that holds one. The
    // UPDATE twin is threaded too (round 3): `.claude/rules/providers.md`
    // notes the update arm is the one a multi-destination bag actually
    // reaches, so closing only the create side would have left the reachable
    // half open.
    { maskSecrets, ...(onMultipleDestinations && { onRefusal: onMultipleDestinations }) }
  );

  try {
    await this.ec2Client.send(
      new CreateRouteCommand({
        RouteTableId: routeTableId,
        ...(destinationCidrBlock
          ? { DestinationCidrBlock: destinationCidrBlock }
          : destinationIpv6CidrBlock
            ? { DestinationIpv6CidrBlock: destinationIpv6CidrBlock }
            : { DestinationPrefixListId: destinationPrefixListId }),
        ...routeTargetParams(properties),
      })
    );

    this.logger.debug(`Successfully created Route ${logicalId}: ${physicalId}`);

    return {
      physicalId,
      attributes: {},
      ...(effectiveProperties && { effectiveProperties }),
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      maskerOrIdentity(maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create Route ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}

export async function updateRoute(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  this.logger.debug(`Updating Route ${logicalId}: ${physicalId}`);
  const maskSecrets: MaskerFn | undefined = context?.maskSecrets;

  // No-op short-circuit: a `cdkd drift --revert` round-trip can call
  // update() with new == old when only sibling resources drifted.
  // Without this guard, the `ReplaceRoute` below would needlessly
  // rewrite a Route that AWS already has in the right shape.
  if (JSON.stringify(properties) === JSON.stringify(previousProperties)) {
    return { physicalId, wasReplaced: false };
  }

  // The multi-destination refusal, on the TEMPLATE path, BEFORE any AWS
  // call (issue #3728). Neither arm below refuses it: the `ReplaceRoute`
  // arm warns, and the delete + create arm hands the re-create the warn
  // callback because the route is already deleted by then.
  //
  // WHO reaches it: a template carrying extra destination keys behind
  // intrinsics that all resolved (the deploy pre-flight,
  // `mutually-exclusive-properties.ts`, already refuses LITERAL duplicates),
  // on an update that changes something else, such as the target. The
  // recorded route may hold only one key: `canonicalizeDesiredProperties`
  // narrows BOTH diff sides to the winning key, so a losing key is never
  // compared, never a createOnly change, and reaches here only in the raw
  // resolved bag `update()` receives.
  //
  // WHY refuse: the value is template-borne, and the remedy (remove the
  // losing keys; cdkd sends only the first declared one) replaces nothing —
  // the diff sees no destination change, so it is this method's ordinary
  // update. That is unlike the `|` separator below, whose segments are the
  // route's identity. The two state-borne callers (the rollback executor's
  // revert arms set `replayingState`, `cdkd drift --revert` sets
  // `desiredFromAwsReadback`) keep the warning: their bag has no
  // template-side remedy.
  if (context?.replayingState !== true && context?.desiredFromAwsReadback !== true) {
    const { declared } = narrowRouteDestinations(properties);
    if (declared.length > 1) {
      throw new ProvisioningError(
        `${routeMultipleDestinationsMessage(logicalId, declared)} The route was not changed.`,
        resourceType,
        logicalId,
        physicalId
      );
    }
  }

  // The in-place arm (issue #5068): the route the physical id names is the
  // one the desired bag names, so only a TARGET changed — every target key
  // is "Update requires: No interruption" in CloudFormation, which EC2
  // serves with the single atomic `ReplaceRoute`. Delete + create would
  // leave the route table without the route between the two calls, and
  // lose it outright if the create were refused.
  //
  // `RouteTableId` and the three destination keys are createOnly, so a
  // change to either takes the engine's replacement path and never reaches
  // `update()`. The identity check below is what decides the arm, not that
  // premise: a bag whose route table or destination does not match the id
  // still falls through to the delete + create arm, as before.
  const { declared: declaredDestinations, narrowed: narrowedProperties } =
    narrowRouteDestinations(properties);
  const usedDestinationKey = declaredDestinations[0];
  const routeTableId = properties['RouteTableId'];
  const destination = usedDestinationKey === undefined ? undefined : properties[usedDestinationKey];
  if (
    usedDestinationKey !== undefined &&
    typeof routeTableId === 'string' &&
    typeof destination === 'string' &&
    `${routeTableId}|${destination}` === physicalId
  ) {
    // Only the two state-borne callers get here with more than one
    // destination (the template path refused above). They keep the
    // warning, and state records the bag actually sent (issue #1591).
    let effectiveProperties: Record<string, unknown> | undefined;
    if (declaredDestinations.length > 1) {
      effectiveProperties = narrowedProperties;
      this.logger.warn(
        safeMsg`${routeMultipleDestinationsMessage(logicalId, declaredDestinations)} Continuing with ${usedDestinationKey} and ignoring the rest.`
      );
    }
    try {
      await this.ec2Client.send(
        new ReplaceRouteCommand({
          RouteTableId: routeTableId,
          [usedDestinationKey]: destination,
          ...routeTargetParams(properties),
        })
      );
      this.logger.debug(safeMsg`Successfully replaced the target of Route ${logicalId}`);
      return {
        physicalId,
        wasReplaced: false,
        ...(effectiveProperties && { effectiveProperties }),
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        maskerOrIdentity(maskSecrets),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update Route ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  // The bag names a different route than the physical id (a destination or
  // route table change that did not take the replacement path): delete the
  // recorded route and create the desired one.
  try {
    await this.deleteRoute(
      logicalId,
      physicalId,
      resourceType,
      maskSecrets ? { maskSecrets } : undefined
    );
    const createResult = await this.createRoute(
      logicalId,
      resourceType,
      properties,
      // NOTE: this downgrades the multi-destination guard and the composite
      // id's separator refusal, nothing else. The required-field check at
      // the top of createRoute is deliberately NOT downgraded and can still
      // throw on this post-delete path (a bag missing RouteTableId or every
      // destination has nothing to create from) — that is pre-existing
      // behavior, not something this callback claims to cover.
      //
      // Passed on EVERY update, because the route was already deleted above
      // and a throw here would strand it. What that costs differs per guard
      // (issue #3728):
      //  - multi-destination: nothing on the template path, which refused
      //    it before the delete (above); only the two state-borne callers
      //    reach this warning with one.
      //  - the `|` separator: kept a warning on the template path too, by
      //    decision. Both segments are createOnly (`RouteTableId`, the
      //    destination keys), so a changed value is a replacement and does
      //    not reach `update()`; an unchanged pipe-carrying pair matches the
      //    id and takes the `ReplaceRoute` arm above, packing nothing.
      //    Neither segment is realistically pipe-capable anyway.
      (message) => this.logger.warn(message),
      // Issue #2176 round 3: the re-create is what packs the composite id, so
      // the masker has to reach IT rather than being used in this frame.
      maskSecrets
    );
    return {
      physicalId: createResult.physicalId,
      wasReplaced: true,
      ...(createResult.attributes && { attributes: createResult.attributes }),
      // Forwarded, not re-derived: the re-create above is the call that
      // narrowed, and this is the path the phantom drift actually reached
      // users on — `update()` is the only entry a multi-destination bag can
      // still get through, since create refuses it outright (issue #1591).
      ...(createResult.effectiveProperties && {
        effectiveProperties: createResult.effectiveProperties,
      }),
    };
  } catch (error) {
    // Pass through cdkd-typed errors untouched (#1272): re-labelling an inner
    // ProvisioningError replaces its precise message with this outer one.
    // Accepted trade-off on the delete-then-create replacement path: a failed
    // re-create now surfaces as its own `Failed to create ...` (physicalId
    // undefined) rather than being relabelled `Failed to update ...`. The
    // inner message is the more precise one; nothing reads
    // ProvisioningError.physicalId.
    if (error instanceof CdkdError) throw error;
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      maskerOrIdentity(maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update Route ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

export async function deleteRoute(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting Route ${logicalId}: ${physicalId}`);

  const parts = physicalId.split('|');
  if (parts.length !== 2) {
    throw new ProvisioningError(
      compositeIdFormatMessage(EC2_ROUTE_ID_FORMAT, logicalId, physicalId),
      resourceType,
      logicalId,
      physicalId
    );
  }

  const [routeTableId, destination] = parts;

  try {
    // The destination segment discriminates by shape: ':' = IPv6 CIDR,
    // 'pl-' = managed prefix list, anything else = IPv4 CIDR.
    const destinationParam = destination?.includes(':')
      ? { DestinationIpv6CidrBlock: destination }
      : destination?.startsWith('pl-')
        ? { DestinationPrefixListId: destination }
        : { DestinationCidrBlock: destination };
    await this.ec2Client.send(
      new DeleteRouteCommand({
        RouteTableId: routeTableId,
        ...destinationParam,
      })
    );
    this.logger.debug(`Successfully deleted Route ${logicalId}`);
  } catch (error) {
    if (this.isNotFoundError(error)) {
      const clientRegion = await this.ec2Client.config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`Route ${physicalId} does not exist, skipping deletion`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapDeleteError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete Route ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

// ─── AWS::EC2::SubnetRouteTableAssociation ────────────────────────

export async function createSubnetRouteTableAssociation(
  this: EC2Provider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating SubnetRouteTableAssociation ${logicalId}`);

  const subnetId = properties['SubnetId'] as string;
  const routeTableId = properties['RouteTableId'] as string;

  if (!subnetId || !routeTableId) {
    throw new ProvisioningError(
      `SubnetId and RouteTableId are required for SubnetRouteTableAssociation ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  try {
    const response = await this.ec2Client.send(
      new AssociateRouteTableCommand({
        SubnetId: subnetId,
        RouteTableId: routeTableId,
      })
    );

    const associationId = response.AssociationId!;
    this.logger.debug(
      `Successfully created SubnetRouteTableAssociation ${logicalId}: ${associationId}`
    );

    return {
      physicalId: associationId,
      attributes: {},
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create SubnetRouteTableAssociation ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}

export function updateSubnetRouteTableAssociation(
  this: EC2Provider,
  logicalId: string,
  physicalId: string
): Promise<ResourceUpdateResult> {
  void physicalId;
  return Promise.reject(
    new ResourceUpdateNotSupportedError(
      'AWS::EC2::SubnetRouteTableAssociation',
      logicalId,
      'destroy + redeploy the association. (SubnetId, RouteTableId) is immutable'
    )
  );
}

export async function deleteSubnetRouteTableAssociation(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting SubnetRouteTableAssociation ${logicalId}: ${physicalId}`);

  try {
    await this.ec2Client.send(new DisassociateRouteTableCommand({ AssociationId: physicalId }));
    this.logger.debug(`Successfully deleted SubnetRouteTableAssociation ${logicalId}`);
  } catch (error) {
    if (this.isNotFoundError(error)) {
      const clientRegion = await this.ec2Client.config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(
        `SubnetRouteTableAssociation ${physicalId} does not exist, skipping deletion`
      );
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapDeleteError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete SubnetRouteTableAssociation ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/** The {@link EC2Provider} methods this module defines. */
export const routeMethods = {
  createRouteTable,
  deleteRouteTable,
  createRoute,
  updateRoute,
  deleteRoute,
  createSubnetRouteTableAssociation,
  updateSubnetRouteTableAssociation,
  deleteSubnetRouteTableAssociation,
};
