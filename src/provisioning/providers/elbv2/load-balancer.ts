import type { ELBv2Provider } from '../elbv2-provider.js';
import {
  CreateLoadBalancerCommand,
  DeleteLoadBalancerCommand,
  DescribeLoadBalancersCommand,
  waitUntilLoadBalancerAvailable,
  DescribeLoadBalancerAttributesCommand,
  ModifyLoadBalancerAttributesCommand,
  SetSecurityGroupsCommand,
  ModifyCapacityReservationCommand,
  DescribeCapacityReservationCommand,
  type Tag,
  type LoadBalancerSchemeEnum,
  type LoadBalancerTypeEnum,
  type IpAddressType,
  type EnablePrefixForIpv6SourceNatEnum,
  type EnforceSecurityGroupInboundRulesOnPrivateLinkTrafficEnum,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { isTruthyCfnBoolean } from '../../data-delete-intent.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { markNotGone } from '../../not-gone.js';
import type { ResourceCreateResult, SecretMasker } from '../../../types/resource.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource, retractCreatedResource } from '../../created-resource-sink.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import {
  deleteWithProtectionCompensation,
  observeThenDisableProtection,
  protectionFlipKey,
  type ProtectionFlipRecord,
} from '../deletion-protection-compensation.js';
import {
  hasErrorName,
  nameHeldBefore,
  skippedCleanupText,
  type NameHeldBefore,
} from '../create-ownership.js';
import {
  sentElbv2Name,
  answeredHeld,
  capacityReservationDelays,
  loadBalancerAttributes,
  loadBalancerProtectionSite,
} from './shared.js';

// ─── AWS::ElasticLoadBalancingV2::LoadBalancer ─────────────────────

export async function createLoadBalancer(
  this: ELBv2Provider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  maskSecrets?: SecretMasker
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating LoadBalancer ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const tags: Tag[] = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

  // go-to-k/cdkd#4583: set only when the wiring-failure cleanup could not
  // delete the load balancer this call created (never one that held the name).
  let leftBehindArn: string | undefined;
  try {
    const lbName = sentElbv2Name(properties, logicalId);

    // Whether the cleanup below may delete what CreateLoadBalancer returns:
    // on identical settings it hands back a load balancer that already held
    // the name (go-to-k/cdkd#4403). Asked only when a wiring step can fail.
    const lbAttributes = this.normalizeAttributes(properties['LoadBalancerAttributes']);
    const enforcePrivateLink = properties[
      'EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic'
    ] as EnforceSecurityGroupInboundRulesOnPrivateLinkTrafficEnum | undefined;
    const minCapacity = properties['MinimumLoadBalancerCapacity'] as
      | { CapacityUnits?: number | string }
      | undefined;
    // Read ONCE, so the wait below and this gate cannot disagree.
    const waitForActive = process.env['CDKD_NO_WAIT'] !== 'true';
    const wiringDeclared =
      waitForActive ||
      lbAttributes.length > 0 ||
      enforcePrivateLink !== undefined ||
      minCapacity?.CapacityUnits !== undefined;
    const heldBefore: NameHeldBefore = wiringDeclared
      ? await nameHeldBefore(
          async () =>
            answeredHeld(
              (await this.getClient().send(new DescribeLoadBalancersCommand({ Names: [lbName] })))
                .LoadBalancers
            ),
          (error) => hasErrorName(error, ['LoadBalancerNotFoundException'])
        )
      : 'free';

    const ipv4IpamPoolId = properties['Ipv4IpamPoolId'] as string | undefined;
    const response = await this.getClient().send(
      new CreateLoadBalancerCommand({
        Name: lbName,
        Subnets: properties['Subnets'] as string[] | undefined,
        SubnetMappings: properties['SubnetMappings'] as
          | Array<{ SubnetId: string; AllocationId?: string; PrivateIPv4Address?: string }>
          | undefined,
        SecurityGroups: properties['SecurityGroups'] as string[] | undefined,
        Scheme: properties['Scheme'] as LoadBalancerSchemeEnum | undefined,
        Type: properties['Type'] as LoadBalancerTypeEnum | undefined,
        IpAddressType: properties['IpAddressType'] as IpAddressType | undefined,
        EnablePrefixForIpv6SourceNat: properties['EnablePrefixForIpv6SourceNat'] as
          | EnablePrefixForIpv6SourceNatEnum
          | undefined,
        // CFn flattens the SDK's `IpamPools` wrapper to a single
        // `Ipv4IpamPoolId` string (ipv4 is the only pool kind today).
        ...(ipv4IpamPoolId !== undefined && { IpamPools: { Ipv4IpamPoolId: ipv4IpamPoolId } }),
        ...(tags.length > 0 && { Tags: tags }),
      })
    );

    const lb = response.LoadBalancers?.[0];
    if (!lb || !lb.LoadBalancerArn) {
      // Theoretical AWS SDK contract violation: CreateLoadBalancer
      // returned success but with no LoadBalancerArn. Cannot clean up
      // — we have no ARN to delete. Has never been observed in
      // practice.
      throw new Error('CreateLoadBalancer did not return LoadBalancer ARN');
    }
    const lbArn = lb.LoadBalancerArn;

    this.logger.debug(`Successfully created LoadBalancer ${logicalId}: ${lbArn}`);
    // go-to-k/cdkd#5511: only a load balancer the name was free for.
    if (heldBefore === 'free') reportCreatedResource(logicalId, resourceType, lbArn);

    // CreateLoadBalancerCommand has succeeded — AWS has now committed
    // the LB. If the subsequent ModifyLoadBalancerAttributesCommand
    // throws, the LB exists on AWS but cdkd state will NOT (the throw
    // aborts before the success-return). The next redeploy plans
    // CREATE again and AWS rejects with `DuplicateLoadBalancerName`
    // (LB Names are unique per scheme within a region). Wrap the
    // attributes call in an inner try/catch that issues a best-effort
    // `DeleteLoadBalancerCommand` before re-throwing the original
    // error. A freshly-created LB has no listeners / target group
    // attachments yet, so a single DeleteLoadBalancer suffices (no
    // need to delete listeners first).
    try {
      // Wait for the LB to leave `provisioning` and reach `active`
      // unless --no-wait is set. CreateLoadBalancer returns a fully
      // formed LoadBalancer object synchronously, but with
      // `State.Code: provisioning` — the LB is NOT servable yet, and
      // `DNSName` (returned below as a GetAtt attribute) 503s until it
      // is. Both other engines wait here: CloudFormation before
      // CREATE_COMPLETE, Terraform's `aws_lb` before apply returns.
      //
      // Deliberately INSIDE the partial-create cleanup try/catch: a
      // waiter timeout with the LB already created on AWS but absent
      // from cdkd state would make the next deploy fail with
      // DuplicateLoadBalancerName (LB names are unique per scheme per
      // region), so it has to route through the same best-effort
      // DeleteLoadBalancer as an attributes-wiring failure. The cleanup
      // NARROWS that window rather than closing it — LB deletion is
      // asynchronous and outlives the DeleteLoadBalancer call, so an
      // immediate retry can still hit the duplicate-name error (issue
      // #1291 item 4).
      //
      // Create only. SetSubnets / SetSecurityGroups / SetIpAddressType
      // on update act on an already-active LB and need no waiter.
      if (waitForActive) {
        this.logger.debug(`Waiting for LoadBalancer ${logicalId} to reach active state...`);
        await waitUntilLoadBalancerAvailable(
          // 600s matches Terraform's default `aws_lb` create timeout.
          // minDelay/maxDelay override the AWS SDK defaults (15s / 120s)
          // per the #1177 poll-cap sweep: an ALB reaches `active` in
          // 90-180s, so a 120s-apart late poll can add minutes of dead
          // time to every deploy that creates one.
          { client: this.getClient(), maxWaitTime: 600, minDelay: 5, maxDelay: 10 },
          { LoadBalancerArns: [lbArn] }
        );
        this.logger.debug(`LoadBalancer ${logicalId} is active`);
      } else {
        this.logger.debug(
          `LoadBalancer ${logicalId} created (skipping active-state wait per --no-wait)`
        );
      }

      // Apply LoadBalancerAttributes if specified (normalized so an
      // unquoted-YAML numeric/boolean Value goes on the wire as a string,
      // matching the TG / Listener create paths).
      if (lbAttributes.length > 0) {
        await this.getClient().send(
          new ModifyLoadBalancerAttributesCommand({
            LoadBalancerArn: lbArn,
            Attributes: lbAttributes,
          })
        );
        this.logger.debug(
          `Applied ${lbAttributes.length} LoadBalancer attributes for ${logicalId}`
        );
      }

      // EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic has no
      // CreateLoadBalancer member — the only write path is SetSecurityGroups,
      // so re-issue the create-time security groups with the flag when the
      // template carries it (NLB + security-groups only; AWS rejects it
      // elsewhere and the error surfaces through the cleanup catch).
      if (enforcePrivateLink !== undefined) {
        await this.getClient().send(
          new SetSecurityGroupsCommand({
            LoadBalancerArn: lbArn,
            SecurityGroups: (properties['SecurityGroups'] as string[] | undefined) ?? [],
            EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic: enforcePrivateLink,
          })
        );
        // Masked because `enforcePrivateLink` IS a resolved property value.
        // Debug level is not an exemption (issue #2063 review): `--verbose`
        // is an ordinary way to run a failing deploy, and #1997 shipped this
        // exact shape as a leak (a resolved ASG name in a debug line). Masked
        // on the RAW value rather than the finished sentence so a value that
        // is the whole needle is caught at any length.
        this.logger.debug(
          `Applied EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic=${maskerOrIdentity(
            maskSecrets
          )(String(enforcePrivateLink))} for ${logicalId}`
        );
      }

      // MinimumLoadBalancerCapacity rides on the separate
      // ModifyCapacityReservation control-plane call (no CreateLoadBalancer
      // member). EnableCapacityReservationProvisionStabilize is a CFn-only
      // orchestration flag with NO SDK member: it opts the deploy into
      // waiting for the reservation to reach `provisioned` before success.
      if (minCapacity?.CapacityUnits !== undefined) {
        await this.getClient().send(
          new ModifyCapacityReservationCommand({
            LoadBalancerArn: lbArn,
            MinimumLoadBalancerCapacity: {
              CapacityUnits: Number(minCapacity.CapacityUnits),
            },
          })
        );
        // Same reason as the SetSecurityGroups debug above:
        // `MinimumLoadBalancerCapacity.CapacityUnits` is a resolved property
        // value, and it is the more reachable of the two — a
        // `{{resolve:secretsmanager:...}}` resolving to a numeric string is
        // accepted by `Number()` here and by AWS, so the plaintext prints.
        this.logger.debug(
          `Requested capacity reservation of ${maskerOrIdentity(maskSecrets)(
            String(minCapacity.CapacityUnits)
          )} LCU for ${logicalId}`
        );
        if (
          isTruthyCfnBoolean(properties['EnableCapacityReservationProvisionStabilize']) &&
          process.env['CDKD_NO_WAIT'] !== 'true'
        ) {
          await this.waitForCapacityReservationProvisioned(lbArn, logicalId);
        }
      }
    } catch (innerError) {
      if (heldBefore !== 'free') {
        this.logger.warn(
          maskerOrIdentity(maskSecrets)(
            skippedCleanupText(
              heldBefore,
              `LoadBalancer ${logicalId} (${lbArn})`,
              pasteableAwsCommand(
                maskSecrets
              )`aws elbv2 delete-load-balancer --load-balancer-arn ${lbArn}`.render()
            )
          )
        );
      } else {
        try {
          await this.getClient().send(new DeleteLoadBalancerCommand({ LoadBalancerArn: lbArn }));
          retractCreatedResource(logicalId, resourceType, lbArn);
          this.logger.debug(
            `Cleaned up partially-created LoadBalancer ${logicalId} (${lbArn}) after wiring failure`
          );
        } catch (cleanupError) {
          leftBehindArn = lbArn;
          const lbCleanupHead = `Failed to clean up partially-created LoadBalancer ${logicalId} (${lbArn}): `;
          this.logger.warn(
            // Masked for uniformity with the sibling lines in this same `try`
            // (issue #2063), matching the Listener / TargetGroup create paths.
            // The cleanup call carries only the AWS-issued ARN, so a resolved
            // property value reaching here would be surprising — but
            // "surprising" is not "impossible", and an unmasked line sitting
            // beside masked ones is what a later author copies.
            `${lbCleanupHead}${this.cleanupFailureText(lbCleanupHead, cleanupError, maskSecrets)} Manual deletion may be required before the next deploy: ${pasteableAwsCommand(maskSecrets)`aws elbv2 delete-load-balancer --load-balancer-arn ${lbArn}`.render()}`
          );
        }
      }
      // The resource itself was created: an "already exists" from its wiring
      // is an auxiliary object's, not this resource's name collision (#3826).
      throw markAuxiliaryFailure(innerError, logicalId);
    }

    return {
      physicalId: lbArn,
      attributes: loadBalancerAttributes(lb, lbArn),
    };
  } catch (error) {
    // `cause` carries the ORIGINAL error untouched (issue #2063): the
    // classifier walks it for `$metadata`, so only the human-readable
    // message is masked. This throw is the ONLY disclosure surface for a
    // NON-RETRYABLE `CreateLoadBalancer` rejection — nothing on this path
    // goes through `withRetry`, so there is no give-up summary behind it.
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      maskerOrIdentity(maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create LoadBalancer ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
    if (leftBehindArn !== undefined) {
      markCreatedBeforeFailure(thrown, logicalId, resourceType, leftBehindArn);
    }
    throw thrown;
  }
}

/**
 * Poll DescribeCapacityReservation until every zonal state reports
 * `provisioned` — the semantics of the CFn-only
 * `EnableCapacityReservationProvisionStabilize` flag (no SDK member; it
 * opts the deploy into waiting for the reservation instead of returning
 * while zones are still `pending`). Bounded at ~10 min / 15s interval;
 * a timeout WARNS and continues (the reservation keeps provisioning
 * asynchronously and the ModifyCapacityReservation was accepted), while a
 * `failed` zonal state throws — that reservation will never provision.
 *
 * Takes NO masker, deliberately (issue #2063 audit). Its only request is
 * `DescribeCapacityReservation({ LoadBalancerArn })` with an AWS-issued ARN,
 * so no resolved template value is in the payload for AWS to quote back into
 * the transient-failure `debug` line; the timeout `warn` and the `failed`
 * throw are assembled from a logical id, a count and an AWS-supplied zonal
 * reason. A structural reason, not a likelihood judgement — add the
 * parameter if this ever sends a template-derived member. The `failed` throw
 * is an ordinary `Error`, so it lands in `createLoadBalancer`'s masked catch
 * on the create path and in `update()`'s on the update path either way.
 */
export async function waitForCapacityReservationProvisioned(
  this: ELBv2Provider,
  lbArn: string,
  logicalId: string
): Promise<void> {
  const maxAttempts = 40;
  const intervalMs = 15_000;
  this.logger.debug(`Waiting for capacity reservation of ${logicalId} to provision...`);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // A transient Describe failure (throttle, network blip) is treated as
    // still-pending rather than thrown: on the create path an escaped error
    // lands in the partial-create cleanup and would DELETE a healthy LB
    // whose reservation was merely pending. Only a `failed` zonal state —
    // a definitive answer from AWS — aborts the wait.
    let zones;
    try {
      const resp = await this.getClient().send(
        new DescribeCapacityReservationCommand({ LoadBalancerArn: lbArn })
      );
      zones = resp.CapacityReservationState ?? [];
    } catch (probeError) {
      this.logger.debug(
        `DescribeCapacityReservation for ${logicalId} failed transiently (attempt ${attempt + 1}/${maxAttempts}): ${describeAwsFailure(probeError).detail}`
      );
      await capacityReservationDelays.sleep(intervalMs);
      continue;
    }
    const failed = zones.find((z) => z.State?.Code === 'failed');
    if (failed) {
      throw new Error(
        `Capacity reservation for ${logicalId} failed in ${failed.AvailabilityZone ?? 'an availability zone'}: ${failed.State?.Reason ?? 'no reason reported'}`
      );
    }
    if (zones.length === 0 || zones.every((z) => z.State?.Code === 'provisioned')) {
      this.logger.debug(`Capacity reservation for ${logicalId} is provisioned`);
      return;
    }
    await capacityReservationDelays.sleep(intervalMs);
  }
  this.logger.warn(
    `Capacity reservation for ${logicalId} did not reach 'provisioned' within ${(maxAttempts * intervalMs) / 60000} minutes; continuing (provisioning completes asynchronously)`
  );
}

/**
 * Delete a load balancer.
 *
 * The compensation boundary (issue #2204): a `--remove-protection` flip of
 * `deletion_protection.enabled` whose delete then fails terminally is undone
 * here, so a destroy that did not happen does not leave a live load balancer
 * with its guard stripped.
 */
export async function deleteLoadBalancer(
  this: ELBv2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void> {
  await deleteWithProtectionCompensation({
    registry: this.protectionFlips,
    key: protectionFlipKey(resourceType, physicalId, context?.expectedRegion),
    run: (flip) => this.deleteLoadBalancerOnce(logicalId, physicalId, resourceType, context, flip),
    compensation: {
      logicalId,
      physicalId,
      logger: this.logger,
      site: loadBalancerProtectionSite(physicalId, context?.expectedRegion),
      reEnable: async () => {
        await this.getClient().send(
          new ModifyLoadBalancerAttributesCommand({
            LoadBalancerArn: physicalId,
            Attributes: [{ Key: 'deletion_protection.enabled', Value: 'true' }],
          })
        );
      },
    },
  });
}

export async function deleteLoadBalancerOnce(
  this: ELBv2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context: DeleteContext | undefined,
  flip: ProtectionFlipRecord
): Promise<void> {
  this.logger.debug(`Deleting LoadBalancer ${logicalId}: ${physicalId}`);

  // `--remove-protection`: clear the `deletion_protection.enabled`
  // attribute before delete. Idempotent — ELBv2 accepts the call when
  // protection is already disabled. Non-fatal: log at debug if the
  // flip-off errors so the actual DeleteLoadBalancer proceeds. The pre-flip
  // readback is what lets a terminal failure restore ONLY a guard this run
  // turned off.
  if (context?.removeProtection === true) {
    try {
      await observeThenDisableProtection({
        flip,
        logger: this.logger,
        physicalId,
        mask: context?.maskSecrets,
        guardName: 'deletion_protection.enabled',
        observe: async () => {
          const resp = await this.getClient().send(
            new DescribeLoadBalancerAttributesCommand({ LoadBalancerArn: physicalId })
          );
          return (resp.Attributes ?? []).some(
            (a) => a.Key === 'deletion_protection.enabled' && a.Value === 'true'
          );
        },
        disable: async () => {
          await this.getClient().send(
            new ModifyLoadBalancerAttributesCommand({
              LoadBalancerArn: physicalId,
              Attributes: [{ Key: 'deletion_protection.enabled', Value: 'false' }],
            })
          );
        },
      });
      this.logger.debug(
        `Disabled deletion_protection.enabled on LoadBalancer ${logicalId} before delete`
      );
    } catch (flipError) {
      if (!this.isNotFoundError(flipError)) {
        this.logger.debug(
          maskerOrIdentity(context?.maskSecrets)(
            `Could not disable deletion_protection.enabled on ${physicalId}: ${describeAwsFailure(flipError).detail}`
          )
        );
      }
    }
  }

  try {
    await this.getClient().send(new DeleteLoadBalancerCommand({ LoadBalancerArn: physicalId }));
    // AWS took the delete. `DeleteLoadBalancer` has no wait after it today,
    // but the latch is what keeps a future one from re-enabling the guard on
    // a load balancer that is already going.
    flip.deleteAccepted = true;
    this.logger.debug(`Successfully deleted LoadBalancer ${logicalId}`);
  } catch (error) {
    if (this.isDeleteTargetGone(error, context, 'LoadBalancerNotFoundException')) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logDeleteTargetGone(
        context,
        'Load balancer',
        physicalId,
        logicalId,
        `LoadBalancer ${physicalId} does not exist, skipping deletion`
      );
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete LoadBalancer ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
    // The wrap names an AWS failure by its CLASS, and the delete classifiers
    // read `NotFoundException` in a message as "already deleted": only the
    // typed not-found above means this resource is gone (go-to-k/cdkd#2319).
    throw error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
  }
}
