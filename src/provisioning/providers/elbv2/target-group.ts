import type { ELBv2Provider } from '../elbv2-provider.js';
import {
  CreateTargetGroupCommand,
  DeleteTargetGroupCommand,
  ModifyTargetGroupCommand,
  DescribeTargetGroupsCommand,
  ModifyTargetGroupAttributesCommand,
  RegisterTargetsCommand,
  DeregisterTargetsCommand,
  type Tag,
  type ProtocolEnum,
  type TargetTypeEnum,
  type TargetGroupIpAddressTypeEnum,
  type TargetDescription,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { isInterruptedWaitError } from '../../interrupt-watch.js';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import { clearOnUpdateRemoval } from '../../update-removal.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { markNotGone } from '../../not-gone.js';
import type {
  ResourceCreateResult,
  ResourceUpdateResult,
  SecretMasker,
} from '../../../types/resource.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource, retractCreatedResource } from '../../created-resource-sink.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import {
  hasErrorName,
  nameHeldBefore,
  skippedCleanupText,
  type NameHeldBefore,
} from '../create-ownership.js';
import {
  targetGroupNameFromArn,
  sentElbv2Name,
  answeredHeld,
  recordedNameMask,
  readTargets,
  toTargetDescriptions,
  targetsSecretCause,
  TARGETS_WHAT,
  RETAIN_REMOVED_ATTRIBUTE,
  targetGroupAttributes,
} from './shared.js';

// ─── AWS::ElasticLoadBalancingV2::TargetGroup ──────────────────────

export async function createTargetGroup(
  this: ELBv2Provider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  maskSecrets?: SecretMasker
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating TargetGroup ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const tags: Tag[] = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

  // go-to-k/cdkd#3989: refused before CreateTargetGroup, so a malformed list
  // neither strands a half-wired group nor registers a subset of it.
  const desiredTargets = readTargets(properties['Targets'], 'desired');
  if (desiredTargets.kind === 'malformed') {
    throw markNonRetryable(
      new ProvisioningError(
        `Targets of TargetGroup ${logicalId} is not a list of ${TARGETS_WHAT}` +
          `${targetsSecretCause(desiredTargets)} — the target group was not created`,
        resourceType,
        logicalId
      )
    );
  }

  // go-to-k/cdkd#4583: set only when the wiring-failure cleanup could not
  // delete the target group this call created (never one that held the name).
  let leftBehindArn: string | undefined;
  try {
    const matcher = properties['Matcher'] as { HttpCode?: string; GrpcCode?: string } | undefined;

    const tgName = sentElbv2Name(properties, logicalId);

    // Whether the cleanup below may delete what CreateTargetGroup returns:
    // on identical settings it hands back a target group that already held
    // the name (go-to-k/cdkd#4403). Asked only when a wiring step can fail.
    const tgAttributes = this.normalizeAttributes(properties['TargetGroupAttributes']);
    const targets = toTargetDescriptions(desiredTargets.items);
    const heldBefore: NameHeldBefore =
      tgAttributes.length > 0 || targets.length > 0
        ? await nameHeldBefore(
            async () =>
              answeredHeld(
                (await this.getClient().send(new DescribeTargetGroupsCommand({ Names: [tgName] })))
                  .TargetGroups
              ),
            (error) => hasErrorName(error, ['TargetGroupNotFoundException'])
          )
        : 'free';

    const response = await this.getClient().send(
      new CreateTargetGroupCommand({
        Name: tgName,
        Protocol: properties['Protocol'] as ProtocolEnum | undefined,
        Port: properties['Port'] !== undefined ? Number(properties['Port']) : undefined,
        VpcId: properties['VpcId'] as string | undefined,
        TargetType: properties['TargetType'] as TargetTypeEnum | undefined,
        ProtocolVersion: properties['ProtocolVersion'] as string | undefined,
        HealthCheckProtocol: properties['HealthCheckProtocol'] as ProtocolEnum | undefined,
        HealthCheckPort: properties['HealthCheckPort'] as string | undefined,
        HealthCheckPath: properties['HealthCheckPath'] as string | undefined,
        HealthCheckEnabled:
          properties['HealthCheckEnabled'] !== undefined
            ? Boolean(properties['HealthCheckEnabled'])
            : undefined,
        HealthCheckIntervalSeconds:
          properties['HealthCheckIntervalSeconds'] !== undefined
            ? Number(properties['HealthCheckIntervalSeconds'])
            : undefined,
        HealthCheckTimeoutSeconds:
          properties['HealthCheckTimeoutSeconds'] !== undefined
            ? Number(properties['HealthCheckTimeoutSeconds'])
            : undefined,
        HealthyThresholdCount:
          properties['HealthyThresholdCount'] !== undefined
            ? Number(properties['HealthyThresholdCount'])
            : undefined,
        UnhealthyThresholdCount:
          properties['UnhealthyThresholdCount'] !== undefined
            ? Number(properties['UnhealthyThresholdCount'])
            : undefined,
        IpAddressType: properties['IpAddressType'] as TargetGroupIpAddressTypeEnum | undefined,
        TargetControlPort:
          properties['TargetControlPort'] !== undefined
            ? Number(properties['TargetControlPort'])
            : undefined,
        ...(matcher && { Matcher: matcher }),
        ...(tags.length > 0 && { Tags: tags }),
      })
    );

    const tg = response.TargetGroups?.[0];
    if (!tg || !tg.TargetGroupArn) {
      throw new Error('CreateTargetGroup did not return TargetGroup ARN');
    }
    const tgArn = tg.TargetGroupArn;

    this.logger.debug(`Successfully created TargetGroup ${logicalId}: ${tgArn}`);
    // go-to-k/cdkd#5511: only a target group the name was free for.
    if (heldBefore === 'free') reportCreatedResource(logicalId, resourceType, tgArn);

    // TargetGroupAttributes and Targets ride on separate post-create calls
    // (ModifyTargetGroupAttributes / RegisterTargets). CreateTargetGroup has
    // already committed the TG, so a failure here would strand it outside
    // cdkd state and the next deploy's CREATE would collide on the unique TG
    // name — wrap in the same best-effort-delete-then-rethrow pattern as the
    // LoadBalancer create path above.
    try {
      if (tgAttributes.length > 0) {
        await this.getClient().send(
          new ModifyTargetGroupAttributesCommand({
            TargetGroupArn: tgArn,
            Attributes: tgAttributes,
          })
        );
        this.logger.debug(
          `Applied ${tgAttributes.length} TargetGroup attribute(s) for ${logicalId}`
        );
      }

      if (targets.length > 0) {
        await this.waitForLambdaTargetsActive(logicalId, properties['TargetType'], targets);
        await this.getClient().send(
          new RegisterTargetsCommand({ TargetGroupArn: tgArn, Targets: targets })
        );
        this.logger.debug(`Registered ${targets.length} target(s) for ${logicalId}`);
      }
    } catch (innerError) {
      if (heldBefore !== 'free') {
        this.logger.warn(
          maskerOrIdentity(maskSecrets)(
            skippedCleanupText(
              heldBefore,
              `TargetGroup ${logicalId} (${tgArn})`,
              pasteableAwsCommand(
                maskSecrets
              )`aws elbv2 delete-target-group --target-group-arn ${tgArn}`.render()
            )
          )
        );
      } else {
        if (isInterruptedWaitError(innerError)) {
          // Printed BEFORE the delete, at default verbosity, so a process that
          // dies mid-cleanup still leaves the user a handle (same as the
          // Listener path below).
          this.logger.warn(
            maskerOrIdentity(maskSecrets)(
              `Interrupted after creating TargetGroup ${logicalId} (${tgArn}) but before its ` +
                `targets were registered. Nothing in cdkd state refers to it, so cdkd is deleting ` +
                `it now. If that delete fails, remove it yourself: ` +
                `${pasteableAwsCommand(maskSecrets)`aws elbv2 delete-target-group --target-group-arn ${tgArn}`.render()}`
            )
          );
        }
        try {
          await this.getClient().send(new DeleteTargetGroupCommand({ TargetGroupArn: tgArn }));
          retractCreatedResource(logicalId, resourceType, tgArn);
          this.logger.debug(
            `Cleaned up partially-created TargetGroup ${logicalId} (${tgArn}) after wiring failure`
          );
        } catch (cleanupError) {
          leftBehindArn = tgArn;
          const tgCleanupHead = `Failed to clean up partially-created TargetGroup ${logicalId} (${tgArn}): `;
          this.logger.warn(
            // Masked for uniformity with the sibling lines in this same `try`
            // (issue #2050). The cleanup call carries only a physical ARN, so a
            // resolved property value reaching here would be surprising — but
            // "surprising" is not "impossible", and an unmasked line sitting
            // beside masked ones is what a later author copies.
            `${tgCleanupHead}${this.cleanupFailureText(tgCleanupHead, cleanupError, maskSecrets)} Manual deletion may be ` +
              `required before the next deploy: ` +
              `${pasteableAwsCommand(maskSecrets)`aws elbv2 delete-target-group --target-group-arn ${tgArn}`.render()}`
          );
        }
      }
      // The resource itself was created: an "already exists" from its wiring
      // is an auxiliary object's, not this resource's name collision (#3826).
      throw markAuxiliaryFailure(innerError, logicalId);
    }

    return {
      physicalId: tgArn,
      attributes: targetGroupAttributes(tg, tgArn),
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      maskerOrIdentity(maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create TargetGroup ${logicalId}: ${text}`,
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

export async function updateTargetGroup(
  this: ELBv2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  callerMaskSecrets?: SecretMasker,
  fromReadback = false
): Promise<ResourceUpdateResult> {
  // Every line below that can name the target group, its ARN included,
  // masks a pre-rotation secret-derived name too (go-to-k/cdkd#4339).
  const maskSecrets = recordedNameMask(
    callerMaskSecrets,
    previousProperties['Name'],
    targetGroupNameFromArn(physicalId)
  );
  this.logger.debug(`Updating TargetGroup ${logicalId}: ${maskSecrets(physicalId)}`);
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);

  // IpAddressType is createOnly in the CFn schema (the registry fallback
  // already classifies its change as replacement); TargetControlPort has
  // NO modify API at all AND is missing from the schema's
  // createOnlyProperties, so without this guard a change would be silently
  // dropped. Reject both with ResourceUpdateNotSupportedError — the deploy
  // engine matches it by class and falls back to replacement.
  // TargetControlPort is compared numerically ("8080" vs 8080 is a template
  // quoting difference, not a change); IpAddressType compares as a string.
  const immutableChanged = (key: string, coerce: boolean): boolean => {
    const next = properties[key];
    const prev = previousProperties[key];
    if (coerce) {
      const nextNum = next !== undefined ? Number(next) : undefined;
      const prevNum = prev !== undefined ? Number(prev) : undefined;
      return nextNum !== prevNum;
    }
    return JSON.stringify(next) !== JSON.stringify(prev);
  };
  for (const [immutableKey, coerce] of [
    ['IpAddressType', false],
    ['TargetControlPort', true],
  ] as Array<[string, boolean]>) {
    if (immutableChanged(immutableKey, coerce)) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        `ELBv2 TargetGroup ${immutableKey} is immutable on AWS — no Modify* API accepts it; it is fixed at creation. Re-deploy with cdkd deploy --replace, or destroy + redeploy the stack.`
      );
    }
  }

  // Before ModifyTargetGroup: a malformed desired `Targets` is refused with
  // nothing sent (go-to-k/cdkd#3989).
  const { newTargets, oldTargets } = await this.readUpdateTargets(
    logicalId,
    physicalId,
    resourceType,
    properties['Targets'],
    previousProperties['Targets'],
    properties['Port']
  );

  try {
    // Class 2 sanitize at the wire layer: `readCurrentState` always-emits
    // `Matcher: {}` for non-HTTP/HTTPS target groups (TCP / UDP / GENEVE
    // never carry HttpCode / GrpcCode). Without this guard, `cdkd drift
    // --revert` round-trips the `{}` placeholder back through
    // `ModifyTargetGroup`, which AWS rejects: "Matcher must contain
    // either HttpCode or GrpcCode". Treat the empty object the same as
    // an absent Matcher — drop the key from the API input.
    const rawMatcher = properties['Matcher'] as
      | { HttpCode?: string; GrpcCode?: string }
      | undefined;
    const matcher =
      rawMatcher && (rawMatcher.HttpCode !== undefined || rawMatcher.GrpcCode !== undefined)
        ? rawMatcher
        : undefined;

    // Removal semantics (issue #1160, CFn A/B us-east-1 2026-08-10, re-run
    // 2026-10-17 on HTTP, TCP, GENEVE, gRPC and lambda target groups):
    // CloudFormation RETAINS every health-check field EXCEPT
    // `HealthCheckPort` when it is removed from the template —
    // HealthCheckProtocol / HealthCheckPath / HealthCheckEnabled /
    // HealthCheckIntervalSeconds / HealthCheckTimeoutSeconds /
    // HealthyThresholdCount / UnhealthyThresholdCount and `Matcher`
    // (HttpCode and GrpcCode) all kept their customized values, so the
    // pass-through (absent -> undefined -> ModifyTargetGroup merge) is
    // CFn parity for those. `HealthCheckPort` is the one field CFn resets,
    // to `traffic-port` — on a GENEVE target group too, although that
    // protocol's create default is port 80.
    const healthCheckPort = clearOnUpdateRemoval(
      properties['HealthCheckPort'] as string | undefined,
      previousProperties['HealthCheckPort'] as string | undefined,
      'traffic-port'
    );

    await this.getClient().send(
      new ModifyTargetGroupCommand({
        TargetGroupArn: physicalId,
        HealthCheckProtocol: properties['HealthCheckProtocol'] as ProtocolEnum | undefined,
        HealthCheckPort: healthCheckPort,
        HealthCheckPath: properties['HealthCheckPath'] as string | undefined,
        HealthCheckEnabled:
          properties['HealthCheckEnabled'] !== undefined
            ? Boolean(properties['HealthCheckEnabled'])
            : undefined,
        HealthCheckIntervalSeconds:
          properties['HealthCheckIntervalSeconds'] !== undefined
            ? Number(properties['HealthCheckIntervalSeconds'])
            : undefined,
        HealthCheckTimeoutSeconds:
          properties['HealthCheckTimeoutSeconds'] !== undefined
            ? Number(properties['HealthCheckTimeoutSeconds'])
            : undefined,
        HealthyThresholdCount:
          properties['HealthyThresholdCount'] !== undefined
            ? Number(properties['HealthyThresholdCount'])
            : undefined,
        UnhealthyThresholdCount:
          properties['UnhealthyThresholdCount'] !== undefined
            ? Number(properties['UnhealthyThresholdCount'])
            : undefined,
        ...(matcher && { Matcher: matcher }),
      })
    );

    // ─── TargetGroupAttributes ───────────────────────────────────────
    // ModifyTargetGroupAttributes replaces ONLY the listed attrs — same
    // key-diff semantics as LoadBalancerAttributes: a removed key keeps
    // its live value, as CloudFormation leaves it (RETAIN_REMOVED_ATTRIBUTE).
    // Skip the call when nothing changed.
    const tgAttrDiff = this.diffAttributeBag(
      'TargetGroupAttributes',
      logicalId,
      properties['TargetGroupAttributes'],
      previousProperties['TargetGroupAttributes'],
      RETAIN_REMOVED_ATTRIBUTE,
      fromReadback,
      maskSecrets
    );
    if (tgAttrDiff.length > 0) {
      await this.getClient().send(
        new ModifyTargetGroupAttributesCommand({
          TargetGroupArn: physicalId,
          Attributes: tgAttrDiff,
        })
      );
      this.logger.debug(
        `Applied ${tgAttrDiff.length} TargetGroupAttributes change(s) for ${logicalId}`
      );
    }

    // ─── Targets ─────────────────────────────────────────────────────
    // RegisterTargets / DeregisterTargets diff keyed on the full
    // (Id, Port, AvailabilityZone, QuicServerId) tuple — a changed Port registers the new
    // tuple and deregisters the old one. Register first so a target whose
    // spelling changed never has a window with zero registrations; the one
    // exception is a QuicServerId-only change (see `deregisterFirst`), which
    // AWS only accepts as deregister then register.
    // BOTH sides are normalized against the SAME group port so the keys are
    // comparable — see toTargetDescriptions' note on why the omitted-Port
    // case is a destructive diff rather than a cosmetic one. Both were read
    // by `readUpdateTargets` above.
    const targetKey = (t: TargetDescription) =>
      JSON.stringify([t.Id, t.Port ?? null, t.AvailabilityZone ?? null, t.QuicServerId ?? null]);
    const oldTargetKeys = new Set(oldTargets.map(targetKey));
    const newTargetKeys = new Set(newTargets.map(targetKey));
    const targetsToRegister = newTargets.filter((t) => !oldTargetKeys.has(targetKey(t)));
    const targetsToDeregister = oldTargets.filter((t) => !newTargetKeys.has(targetKey(t)));
    // A target whose only change is its QuicServerId sits in BOTH sets under
    // the same (Id, Port, AvailabilityZone). AWS cannot modify a registered
    // target's server id: it must be deregistered, then registered again. So
    // those deregister FIRST: measured on a QUIC target group, RegisterTargets
    // for a different server id while one is registered is REFUSED ("deregister
    // the target first"). A change TO an absent server id is the exception: a
    // QUIC target group refuses a target without one, so deregistering first
    // would take the live target down for a register that cannot succeed;
    // that case stays register-first and AWS's refusal leaves it intact.
    // (A secret-derived recorded server id never reaches this path: its tuple
    // is filtered out of the recorded side, so there is nothing to pair.)
    const baseKey = (t: TargetDescription) =>
      JSON.stringify([t.Id, t.Port ?? null, t.AvailabilityZone ?? null]);
    const quicRegisterBaseKeys = new Set(
      targetsToRegister.filter((t) => t.QuicServerId !== undefined).map(baseKey)
    );
    const deregisterFirst = targetsToDeregister.filter((t) => quicRegisterBaseKeys.has(baseKey(t)));
    const deregisterAfter = targetsToDeregister.filter(
      (t) => !quicRegisterBaseKeys.has(baseKey(t))
    );
    const sendDeregister = async (targets: TargetDescription[]): Promise<void> => {
      if (targets.length === 0) return;
      await this.getClient().send(
        new DeregisterTargetsCommand({ TargetGroupArn: physicalId, Targets: targets })
      );
      this.logger.debug(`Deregistered ${targets.length} target(s) for ${logicalId}`);
    };
    // Wait BEFORE the early deregister, so the unregistered window is one
    // RegisterTargets call.
    if (targetsToRegister.length > 0) {
      await this.waitForLambdaTargetsActive(logicalId, properties['TargetType'], targetsToRegister);
    }
    await sendDeregister(deregisterFirst);
    if (targetsToRegister.length > 0) {
      try {
        await this.getClient().send(
          new RegisterTargetsCommand({ TargetGroupArn: physicalId, Targets: targetsToRegister })
        );
      } catch (registerError) {
        if (deregisterFirst.length === 0) throw registerError;
        // The early deregister already took those targets down: put them back.
        try {
          await this.getClient().send(
            new RegisterTargetsCommand({ TargetGroupArn: physicalId, Targets: deregisterFirst })
          );
        } catch (reRegisterError) {
          throw new Error(
            `${deregisterFirst.length} target(s) were deregistered to change their QuicServerId and ` +
              `could not be registered again; register them with their previous QuicServerId`,
            { cause: new AggregateError([registerError, reRegisterError]) }
          );
        }
        throw registerError;
      }
      this.logger.debug(`Registered ${targetsToRegister.length} target(s) for ${logicalId}`);
    }
    await sendDeregister(deregisterAfter);

    // Describe to get current attributes
    const describeResponse = await this.getClient().send(
      new DescribeTargetGroupsCommand({ TargetGroupArns: [physicalId] })
    );
    const tg = describeResponse.TargetGroups?.[0];

    // Apply tag diff. ELBv2 uses AddTags / RemoveTags with [arn].
    await this.applyTagDiff(
      physicalId,
      resourceType,
      logicalId,
      previousProperties['Tags'],
      properties['Tags'],
      maskSecrets
    );

    this.logger.debug(`Successfully updated TargetGroup ${logicalId}`);

    return {
      physicalId,
      wasReplaced: false,
      attributes: targetGroupAttributes(tg ?? {}, physicalId),
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      maskerOrIdentity(maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update TargetGroup ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

export async function deleteTargetGroup(
  this: ELBv2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting TargetGroup ${logicalId}: ${physicalId}`);

  try {
    await this.getClient().send(new DeleteTargetGroupCommand({ TargetGroupArn: physicalId }));
    this.logger.debug(`Successfully deleted TargetGroup ${logicalId}`);
  } catch (error) {
    if (this.isDeleteTargetGone(error, context, 'TargetGroupNotFoundException')) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logDeleteTargetGone(
        context,
        'Target group',
        physicalId,
        logicalId,
        `TargetGroup ${physicalId} does not exist, skipping deletion`
      );
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete TargetGroup ${logicalId}: ${text}`,
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
