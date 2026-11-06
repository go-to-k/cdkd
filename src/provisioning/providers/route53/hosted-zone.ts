import type { Route53Provider } from '../route53-provider.js';
import {
  CreateHostedZoneCommand,
  DeleteHostedZoneCommand,
  GetHostedZoneCommand,
  UpdateHostedZoneCommentCommand,
  UpdateHostedZoneFeaturesCommand,
  AssociateVPCWithHostedZoneCommand,
  ListHostedZonesByNameCommand,
  HostedZoneAlreadyExists,
  type CreateHostedZoneCommandInput,
  type CreateHostedZoneCommandOutput,
  type HostedZone,
  type ListHostedZonesByNameCommandOutput,
  type VPCRegion,
} from '@aws-sdk/client-route-53';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { CdkdError, ProvisioningError } from '../../../utils/error-handler.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource, retractCreatedResource } from '../../created-resource-sink.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { readConfigString, replayWarn, requireConfigString } from '../../config-shape.js';
import { acquireIdempotencyToken } from '../idempotency-token.js';
import { canonicalizeRoute53QueryName as canonicalizeQueryName } from '../../composite-id.js';
import type {
  CreateContext,
  ResourceCreateResult,
  ResourceUpdateResult,
  UpdateContext,
} from '../../../types/resource.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  declaresAcceleratedRecovery,
  VPCS_KEPT_ON_REMOVAL_NOTE,
  declaresNoVpcs,
} from './shared.js';

// ─── AWS::Route53::HostedZone ──────────────────────────────────────
export async function createHostedZone(
  this: Route53Provider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  mask: ((text: string) => string) | undefined,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating Route 53 hosted zone ${logicalId}`);

  const name = properties['Name'] as string;
  if (!name) {
    throw new ProvisioningError(
      `Name is required for hosted zone ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  // go-to-k/cdkd#2762: create-only (declaring it used to route the zone
  // through Cloud Control). Sent as declared; Route 53 accepts both the bare
  // id and its `/delegationset/` form (measured us-east-1, 2026-10-27). A
  // non-string is refused, not dropped: dropping it would give the zone a
  // fresh set of name servers, which cannot be changed afterwards.
  let delegationSetId: string | undefined;
  try {
    delegationSetId =
      requireConfigString(
        properties['DelegationSetId'],
        '',
        'AWS::Route53::HostedZone DelegationSetId',
        replayWarn(this.logger, context)
      ) || undefined;
  } catch (error) {
    throw new ProvisioningError(
      `Hosted zone ${logicalId}: ${describeAwsFailure(error).detail}`,
      resourceType,
      logicalId,
      undefined,
      error instanceof Error ? error : undefined
    );
  }

  // Set once CreateHostedZone returns (or a replay ADOPTS the zone). No
  // failure after it is this zone's name collision: it is an auxiliary
  // call's (AssociateVPCWithHostedZone, UpdateHostedZoneFeatures) or cdkd's
  // own, so every one is marked (#3826, #3877).
  let zoneCreated = false;
  // go-to-k/cdkd#4583: the zone id once known, and whether the Accelerated
  // Recovery arm's rollback deleted it, for the failed-CREATE journal mark.
  let createdZoneId: string | undefined;
  let zoneRolledBack = false;
  try {
    const hostedZoneConfig = properties['HostedZoneConfig'] as Record<string, unknown> | undefined;
    // Refuse a malformed container rather than silently dropping the comment
    // (issue #1493): the truthiness gate below indexes it, so a string /
    // array / unresolved intrinsic would yield `undefined` and no comment.
    const createComment = readConfigString(
      hostedZoneConfig,
      'Comment',
      '',
      'AWS::Route53::HostedZone HostedZoneConfig'
    );

    // VPCs property (for private hosted zones)
    const vpcs = properties['VPCs'] as Array<Record<string, unknown>> | undefined;
    // For CreateHostedZone, only one VPC can be specified; additional VPCs are associated after creation
    const firstVpc = vpcs && vpcs.length > 0 ? vpcs[0] : undefined;

    // Issue #2039. `CallerReference` IS Route 53's idempotency key, and this
    // used to be `${logicalId}-${Date.now()}` — regenerated on every
    // re-invocation of `create()`, which is the worst shape of all: the call
    // LOOKS idempotent while a deploy-engine retry of a 500 whose zone was
    // actually created mints a SECOND hosted zone for the same domain (Route
    // 53 permits that precisely when the caller reference differs), with its
    // own NS delegation set, no state record, and no route to `cdkd destroy`.
    //
    // The token is stable across attempts of THIS create, so the replay is
    // refused with `HostedZoneAlreadyExists` and adopted below. It is
    // released once the zone is recorded, and on the rollback path that
    // deletes it, so a later create of the same logical id starts fresh.
    const callerReferenceToken = acquireIdempotencyToken({
      scope: 'CreateHostedZone',
      logicalId,
      // Route 53 accepts up to 128 characters for CallerReference.
      maxLength: 128,
    });

    const response = await this.createOrAdoptHostedZone(
      {
        Name: name,
        CallerReference: callerReferenceToken.value,
        ...(delegationSetId !== undefined ? { DelegationSetId: delegationSetId } : {}),
        ...(createComment !== ''
          ? {
              HostedZoneConfig: {
                Comment: createComment,
                // When VPCs are specified, this is a private hosted zone
                ...(firstVpc ? { PrivateZone: true } : {}),
              },
            }
          : firstVpc
            ? { HostedZoneConfig: { PrivateZone: true } }
            : {}),
        ...(firstVpc
          ? {
              VPC: {
                VPCId: firstVpc['VPCId'] as string,
                VPCRegion: firstVpc['VPCRegion'] as VPCRegion | undefined,
              },
            }
          : {}),
      },
      mask
    );
    zoneCreated = true;

    const hostedZone = response.HostedZone;
    if (!hostedZone?.Id) {
      throw new Error('CreateHostedZone did not return HostedZone.Id');
    }

    // Extract zone ID without /hostedzone/ prefix
    const zoneId = hostedZone.Id.replace('/hostedzone/', '');
    createdZoneId = zoneId;
    // go-to-k/cdkd#5511: reported before the VPC associations and later calls.
    reportCreatedResource(logicalId, resourceType, zoneId);

    // Associate additional VPCs (index 1+) after creation
    if (vpcs && vpcs.length > 1) {
      for (let i = 1; i < vpcs.length; i++) {
        const additionalVpc = vpcs[i]!;
        this.logger.debug(
          `Associating additional VPC ${String(additionalVpc['VPCId'])} with hosted zone ${zoneId}`
        );
        await this.getClient().send(
          new AssociateVPCWithHostedZoneCommand({
            HostedZoneId: zoneId,
            VPC: {
              VPCId: additionalVpc['VPCId'] as string,
              VPCRegion: additionalVpc['VPCRegion'] as VPCRegion | undefined,
            },
          })
        );
      }
    }

    // Apply tags (HostedZoneTags)
    await this.applyHostedZoneTags(zoneId, properties, logicalId, undefined, mask);

    // Configure query logging
    await this.applyQueryLoggingConfig(zoneId, properties, logicalId, undefined, mask);

    // `HostedZoneFeatures.EnableAcceleratedRecovery`: post-create
    // control-plane call. CreateHostedZone does NOT accept this field;
    // it requires a separate UpdateHostedZoneFeatures call AFTER the
    // zone is created. Same pattern as RecursiveLoop on Lambda::Function
    // (PR #719). AWS default is disabled, so we only call AWS when the
    // template explicitly enables it (calling with `false` would
    // be a no-op API hit). Failure here triggers `delete-on-post-create-
    // failure` atomicity — delete the just-created hosted zone before
    // bubbling the error, otherwise the next deploy retry sees an orphan
    // zone (live on AWS, not in cdkd state) and CREATE-collides.
    if (declaresAcceleratedRecovery(properties)) {
      try {
        await this.getClient().send(
          new UpdateHostedZoneFeaturesCommand({
            HostedZoneId: zoneId,
            EnableAcceleratedRecovery: true,
          })
        );
      } catch (uhfError) {
        this.logger.error(
          `UpdateHostedZoneFeatures failed for ${zoneId} after CreateHostedZone — rolling back the hosted zone to keep deploy retry idempotent`
        );
        try {
          // Detach query logging config first (applied above as part of
          // create()). AWS rejects DeleteHostedZone with
          // HostedZoneNotEmpty when a logging config is still attached,
          // so a template that sets BOTH `QueryLoggingConfig` and
          // `HostedZoneFeatures.EnableAcceleratedRecovery: true`
          // would leak the zone if the UHF rollback skipped this step.
          await this.deleteQueryLoggingConfigForZone(zoneId, logicalId);
          await this.getClient().send(new DeleteHostedZoneCommand({ Id: zoneId }));
          zoneRolledBack = true;
          retractCreatedResource(logicalId, resourceType, zoneId);
          // Released only after the delete SUCCEEDED, and the ORDER is what
          // matters here rather than the release itself. Route 53 does not
          // retain a DELETED zone's caller reference, so reusing one whose
          // zone is gone would simply create a new zone -- the release on
          // this arm is hygiene (it retires a generation nothing can adopt),
          // and a test cannot distinguish its presence from its absence.
          // Releasing BEFORE the delete is a different matter and is fenced:
          // a delete that FAILS leaves the zone live, and a retry that had
          // lost the caller reference would create a second zone beside an
          // orphan cdkd state never names, where keeping it adopts the zone.
          callerReferenceToken.release();
        } catch (deleteError) {
          const head = `Best-effort rollback DeleteHostedZone for ${zoneId} also failed: `;
          const m = maskerOrIdentity(mask);
          this.logger.warn(
            m(
              `${head}${this.warnFailureText(head, deleteError, mask)} The operator may need to clean up the orphan zone.`
            )
          );
        }
        const cause = uhfError instanceof Error ? uhfError : undefined;
        // The zone itself was created: an "already exists" from the feature
        // call is not this zone's collision, so the wrap does not restate it
        // (#3826). The outer catch marks the wrap again, a no-op.
        markAuxiliaryFailure(uhfError, logicalId);
        throw this.wrapCaughtError(
          mask,
          uhfError,
          (text) =>
            new ProvisioningError(
              `Failed to enable Accelerated Recovery on hosted zone ${logicalId} (${zoneId}): ${text}`,
              resourceType,
              logicalId,
              zoneId,
              cause
            )
        );
      }
      // As CloudFormation does, return only once the zone reports ENABLED
      // (measured ~4 min, us-east-1, 2026-10-28): until then Route 53 refuses
      // every record mutation on the zone, which a record set created in the
      // same deploy would otherwise hit. Outside the rollback above: a zone
      // whose enable is in flight is locked against DeleteHostedZone too, so
      // a failure here leaves the zone to the created-before-failure record.
      await this.waitForAcceleratedRecoveryFeatureSettled(
        zoneId,
        logicalId,
        resourceType,
        true,
        true
      );
    }

    // Collect name servers
    const nameServers = response.DelegationSet?.NameServers ?? [];

    this.logger.debug(`Successfully created hosted zone ${logicalId}: ${zoneId}`);

    callerReferenceToken.release();
    return {
      physicalId: zoneId,
      attributes: {
        Id: zoneId,
        NameServers: nameServers,
      },
    };
  } catch (error) {
    // BEFORE the rethrow: the Accelerated Recovery arm throws its own
    // ProvisioningError, which must carry the mark too.
    if (zoneCreated) markAuxiliaryFailure(error, logicalId);
    const cause = error instanceof Error ? error : undefined;
    const thrown =
      error instanceof ProvisioningError
        ? error
        : this.wrapCaughtError(
            mask,
            error,
            (text) =>
              new ProvisioningError(
                `Failed to create hosted zone ${logicalId}: ${text}`,
                resourceType,
                logicalId,
                undefined,
                cause
              )
          );
    // go-to-k/cdkd#4583: the zone (created, or adopted by caller reference
    // from this create's own earlier attempt) is live with no state record.
    if (createdZoneId !== undefined && !zoneRolledBack) {
      markCreatedBeforeFailure(thrown, logicalId, resourceType, createdZoneId);
    }
    throw thrown;
  }
}

/**
 * `CreateHostedZone`, with the retry-replay case ADOPTED rather than failed
 * (issue [#2039](https://github.com/go-to-k/cdkd/issues/2039)).
 *
 * A stable `CallerReference` stops a replayed create from minting a second
 * zone, but on its own it converts the replay into a hard
 * `HostedZoneAlreadyExists` — so the first attempt's zone would still be live
 * and still absent from state, only now the deploy fails as well. Route 53
 * reports the caller reference back on every `HostedZone`, which is what lets
 * the replay find the zone the lost response described and continue with it.
 *
 * The lookup is `ListHostedZonesByName`, which starts at the requested DNS
 * name and returns zones in name order, so the walk stops as soon as the name
 * changes rather than paging the whole account. A `GetHostedZone` follows,
 * because only that call returns the `DelegationSet` whose `NameServers` are
 * the resource's `Fn::GetAtt` value — an adopted zone must return the same
 * attributes a first-attempt create would have.
 *
 * Finding nothing rethrows the original error: a caller reference AWS says is
 * taken but that names no zone we can see is not something to paper over.
 */
export async function createOrAdoptHostedZone(
  this: Route53Provider,
  input: CreateHostedZoneCommandInput,
  mask?: (text: string) => string
): Promise<Partial<Pick<CreateHostedZoneCommandOutput, 'HostedZone' | 'DelegationSet'>>> {
  try {
    return await this.getClient().send(new CreateHostedZoneCommand(input));
  } catch (error) {
    // `instanceof` alone is not enough: a duplicate `@aws-sdk/client-route-53`
    // anywhere in the tree gives the error a different class object, and the
    // adopt path would then silently never run.
    const isAlreadyExists =
      error instanceof HostedZoneAlreadyExists ||
      (error as { name?: string } | undefined)?.name === 'HostedZoneAlreadyExists';
    if (!isAlreadyExists) {
      throw error;
    }
    // The lookup is best-effort and must never REPLACE the diagnosis. A
    // missing `route53:ListHostedZonesByName` / `route53:GetHostedZone`
    // permission would otherwise surface as `AccessDenied`, sending the next
    // reader after a permissions problem instead of the caller-reference
    // collision that actually happened.
    let adopted: HostedZone | undefined;
    try {
      adopted = await this.findHostedZoneByCallerReference(input.Name!, input.CallerReference!);
    } catch (lookupError) {
      const head = `CreateHostedZone for ${input.Name} was refused as already-existing, and the lookup that would have adopted the existing zone failed: `;
      this.logger.warn(
        maskerOrIdentity(mask)(
          `${head}${this.warnFailureText(head, lookupError, mask)} Reporting the original error.`
        )
      );
      throw error;
    }
    if (!adopted?.Id) {
      throw error;
    }
    this.logger.warn(
      `CreateHostedZone for ${input.Name} was replayed after a lost response; adopting the hosted zone ${adopted.Id} the previous attempt already created instead of creating a second one`
    );
    try {
      const described = await this.getClient().send(new GetHostedZoneCommand({ Id: adopted.Id }));
      return {
        HostedZone: described.HostedZone ?? adopted,
        ...(described.DelegationSet ? { DelegationSet: described.DelegationSet } : {}),
      };
    } catch (describeError) {
      const head = `Adopted hosted zone ${adopted.Id} but could not read it back: `;
      this.logger.warn(
        maskerOrIdentity(mask)(
          `${head}${this.warnFailureText(head, describeError, mask)} Reporting the original error rather than returning a zone with no NameServers.`
        )
      );
      throw error;
    }
  }
}

/**
 * The hosted zone carrying `callerReference`, or `undefined`.
 *
 * Scoped to zones whose name matches `dnsName`: `ListHostedZonesByName` is
 * ordered by name, so once the name differs no later page can hold ours.
 */
export async function findHostedZoneByCallerReference(
  this: Route53Provider,
  dnsName: string,
  callerReference: string
): Promise<HostedZone | undefined> {
  const wanted = canonicalizeQueryName(dnsName);
  let marker: { DNSName?: string; HostedZoneId?: string } | undefined = { DNSName: wanted };
  while (marker) {
    const page: ListHostedZonesByNameCommandOutput = await this.getClient().send(
      new ListHostedZonesByNameCommand({
        DNSName: marker.DNSName,
        ...(marker.HostedZoneId ? { HostedZoneId: marker.HostedZoneId } : {}),
      })
    );
    for (const zone of page.HostedZones ?? []) {
      if (canonicalizeQueryName(zone.Name ?? '') !== wanted) {
        return undefined;
      }
      if (zone.CallerReference === callerReference) {
        return zone;
      }
    }
    marker =
      page.IsTruncated && page.NextDNSName
        ? {
            DNSName: page.NextDNSName,
            ...(page.NextHostedZoneId ? { HostedZoneId: page.NextHostedZoneId } : {}),
          }
        : undefined;
  }
  return undefined;
}

export async function updateHostedZone(
  this: Route53Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  mask: ((text: string) => string) | undefined,
  context: UpdateContext | undefined
): Promise<ResourceUpdateResult> {
  this.logger.debug(`Updating Route 53 hosted zone ${logicalId}: ${physicalId}`);

  try {
    const hostedZoneConfig = properties['HostedZoneConfig'] as Record<string, unknown> | undefined;
    const comment = readConfigString(
      hostedZoneConfig,
      'Comment',
      '',
      'AWS::Route53::HostedZone HostedZoneConfig'
    );

    await this.getClient().send(
      new UpdateHostedZoneCommentCommand({
        Id: physicalId,
        Comment: comment,
      })
    );

    // Update tags. Passing the PREVIOUS side is what makes this a diff
    // rather than an add-only apply — a tag dropped from the template is
    // sent as a `RemoveTagKeys` entry (issue #1160).
    await this.applyHostedZoneTags(physicalId, properties, logicalId, previousProperties, mask);

    // Update query logging config. The previous side likewise turns an
    // absent desired block from "nothing to do" into a REMOVAL.
    await this.applyQueryLoggingConfig(
      physicalId,
      properties,
      logicalId,
      previousProperties,
      mask,
      context?.markUnsettled
    );

    // Associates added VPCs and disassociates dropped ones. A `VPCs` removed
    // whole (or emptied) changes nothing, as in CloudFormation, and is named
    // by the warning below (VPCS_KEPT_ON_REMOVAL_NOTE).
    await this.syncVPCAssociations(
      physicalId,
      properties,
      logicalId,
      previousProperties,
      mask,
      context
    );

    // `HostedZoneFeatures.EnableAcceleratedRecovery`: post-create
    // control-plane call, gated on the BOOLEAN-effective diff (i.e.
    // "is this zone supposed to have AcceleratedRecovery enabled").
    // Comparing the raw values would fire an unnecessary AWS call for
    // `prev: undefined, next: false` (both mean disabled — AWS default;
    // no transition needed). Removal of the property is treated as
    // disabled so a user dropping the template field turns the feature
    // off on the next deploy.
    // The previous side accepts the read-side key too: a template that used
    // it as an override was ENABLED by the pre-#5465 provider, so dropping
    // it must disable, and moving to `EnableAcceleratedRecovery: true` is
    // no change.
    const prevEnabled = declaresAcceleratedRecovery(previousProperties, true);
    const nextEnabled = declaresAcceleratedRecovery(
      properties,
      context?.desiredFromAwsReadback === true
    );
    if (prevEnabled !== nextEnabled) {
      await this.getClient().send(
        new UpdateHostedZoneFeaturesCommand({
          HostedZoneId: physicalId,
          EnableAcceleratedRecovery: nextEnabled,
        })
      );
      // As CloudFormation does, return only once the transition settles
      // (measured: minutes either way); only a toggle pays this wait.
      await this.waitForAcceleratedRecoveryFeatureSettled(
        physicalId,
        logicalId,
        resourceType,
        nextEnabled
      );
    }

    // Retrieve name servers
    const getResponse = await this.getClient().send(new GetHostedZoneCommand({ Id: physicalId }));
    const nameServers = getResponse.DelegationSet?.NameServers ?? [];

    this.logger.debug(`Successfully updated hosted zone ${logicalId}`);

    // Issue #1160: named only after the update SUCCEEDED. Not on
    // `drift --revert`: its previous side is an AWS readback, so a VPCs
    // missing from the desired side was never removed from a template.
    if (
      context?.desiredFromAwsReadback !== true &&
      declaresNoVpcs(properties['VPCs']) &&
      // Unsettled VPCs leave the previous side here (see `readUnsettled`).
      ((Array.isArray(previousProperties['VPCs']) && previousProperties['VPCs'].length > 0) ||
        context?.unsettledProperties?.has('VPCs') === true)
    ) {
      this.logger.warn(
        context?.replayingState
          ? safeMsg`${logicalId} (AWS::Route53::HostedZone): VPCs is absent from the state being restored, so the rollback leaves the zone's VPC associations in place. ${VPCS_KEPT_ON_REMOVAL_NOTE}`
          : safeMsg`${logicalId} (AWS::Route53::HostedZone): VPCs was removed from the template, and the zone keeps its current VPC associations, as CloudFormation leaves them. ${VPCS_KEPT_ON_REMOVAL_NOTE}`
      );
    }

    return {
      physicalId,
      wasReplaced: false,
      attributes: {
        Id: physicalId,
        NameServers: nameServers,
      },
    };
  } catch (error) {
    // Pass a cdkd-typed error through instead of re-labelling it. The two
    // removal paths above now raise their own `ProvisioningError` (a removal
    // that did not land is never retried, so it has to be loud), and
    // re-wrapping would bury that specific, actionable message under a
    // generic "Failed to update hosted zone" — the #1268 defect the
    // `update-wrap-coverage` critic exists to block.
    if (error instanceof CdkdError) {
      throw error;
    }
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update hosted zone ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}
