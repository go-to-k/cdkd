import {
  RevokeSecurityGroupIngressCommand,
  type RevokeSecurityGroupIngressCommandInput,
  type SecurityGroupRule,
} from '@aws-sdk/client-ec2';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { CdkdError, ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { stateOrphanRecordRemedy } from '../../state-orphan-remedy.js';
import { compositeIdFormatMessage } from '../../composite-id.js';
import { maskerOrIdentity, type MaskerFn } from '../../masked-retry-logger.js';
import type { ResourceDeleteResult, ResourceUpdateResult } from '../../../types/resource.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  isRedactedRecordedValue,
  REDACTED_DELETE_ADDRESS_SKIP_REASON,
  redactedDeleteAddressFields,
  redactedDeleteAddressSkip,
} from '../../redacted-delete-address.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { getStackRecords } from '../../../deployment/stack-records-scope.js';
import { deleteSkipReason } from '../../../deployment/delete-outcome.js';
import { EC2_SG_INGRESS_ID_FORMAT } from './network-support.js';
import {
  MAX_SG_RULE_PAGES,
  SG_RULE_ID_PATTERN,
  comparableIngressIdentity,
  descriptionKey,
  narrowIngressIpProtocol,
  recordedSgRuleId,
  securityGroupRuleMatchesCfnIngress,
  stackIngressRuleHolder,
  survivingRecordOfRuleId,
} from './sg-support.js';
import type { EC2Provider } from '../ec2-provider.js';

/**
 * Why a stale-id delete kept its record (go-to-k/cdkd#4355). Fixed, and free of
 * the already-deleted needles `deleteSkippedMessage` lists: the callers read
 * those as success and would drop the record.
 */
const SG_INGRESS_UNPROVEN_RULE_SKIP_REASON =
  'recorded rule id is stale; live rule not proven to be this stack';

/**
 * After a revoke by a recorded `sgr-` id found nothing — the id is stale, or
 * the rule is gone — find THIS stack's rule among the live ones and revoke it
 * by its own id (go-to-k/cdkd#4355). A live rule counts as this stack's only
 * when both its identity (protocol, ports, source) AND its description match
 * the record (an absent description matches an absent one): a bare tuple
 * match could be someone else's re-add after this stack's rule was revoked
 * out of band. Exactly one such rule is revoked. No rule with its identity
 * means gone, and only same-identity rules with a DIFFERENT (unredacted)
 * description are judged someone else's and left, with a warning; every
 * other branch (several matches, a redacted description, a group that cannot
 * be read, no properties) may leave this stack's rule live, so it returns a
 * skip and the record is kept. The extra call is made only on this path.
 */
export async function revokeMatchingLiveRule(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  groupId: string,
  properties: Record<string, unknown> | undefined,
  context: DeleteContext | undefined
): Promise<void | ResourceDeleteResult> {
  const commandsFor = (candidates: string[]): string =>
    candidates.length === 0
      ? ''
      : ` If one of the rules is this stack's, revoke it by hand: ${candidates
          .map((id) =>
            pasteableAwsCommand()`aws ec2 revoke-security-group-ingress --group-id ${groupId} --security-group-rule-ids ${id}`.render()
          )
          .join(' ; ')}`;
  // The rule may still be live and this stack's, so the record is KEPT and
  // the delete reports a skip (exit 2, re-runnable) — never "deleted".
  const keep = (why: string, candidates: string[] = []): ResourceDeleteResult => {
    this.logger.warn(
      safeMsg`SecurityGroupIngress ${logicalId}: its recorded rule id is stale and ${why}, so nothing was revoked and the record is kept.` +
        commandsFor(candidates)
    );
    return { outcome: 'skipped', reason: SG_INGRESS_UNPROVEN_RULE_SKIP_REASON };
  };
  if (properties === undefined) return keep('state records no properties to find its rule by');
  let rules: SecurityGroupRule[] | undefined;
  try {
    rules = await this.listGroupRules(groupId);
  } catch (error) {
    return keep(
      safeMsg`the group's rules could not be read (${describeAwsFailure(error).summary})`
    );
  }
  if (rules === undefined) return keep('the group has too many rules to read whole');
  const sameRule = rules.filter(
    (rule) =>
      rule.IsEgress !== true &&
      typeof rule.SecurityGroupRuleId === 'string' &&
      securityGroupRuleMatchesCfnIngress(rule, properties)
  );
  const sameIds = sameRule.map((rule) => rule.SecurityGroupRuleId!);
  if (sameRule.length === 0) {
    // Nothing on the group is this rule any more: it is gone.
    this.logger.debug(
      safeMsg`SecurityGroupIngress ${physicalId} does not exist, skipping deletion`
    );
    return;
  }
  // A redacted recorded description can never equal a live one, so it
  // cannot tell this stack's rule from someone else's.
  if (isRedactedRecordedValue(properties['Description'])) {
    return keep(
      'its recorded description is redacted, so its live rule cannot be told apart',
      sameIds
    );
  }
  const recordedDescription = descriptionKey(properties['Description']);
  const ours = sameRule.filter((rule) => descriptionKey(rule.Description) === recordedDescription);
  if (ours.length > 1) {
    return keep(
      `${ours.length} live rules match its record`,
      ours.map((rule) => rule.SecurityGroupRuleId!)
    );
  }
  if (ours.length === 0) {
    // Live rules with its protocol, ports and source, but none with its
    // description: judged someone else's, so left in place.
    this.logger.warn(
      safeMsg`SecurityGroupIngress ${logicalId}: its recorded rule is gone, and no live rule with its protocol, ports and source also carries its description, so nothing was revoked.` +
        commandsFor(sameIds)
    );
    return;
  }
  // go-to-k/cdkd#4492: a surviving record of the stack that records THIS live
  // rule's id holds it (this record's id is the stale one), so the rule is
  // its, and only this record goes.
  const liveId = ours[0]!.SecurityGroupRuleId!;
  const keeper = survivingRecordOfRuleId(getStackRecords()?.survivors(), logicalId, liveId);
  if (keeper !== undefined) {
    this.logger.info(
      safeMsg`SecurityGroupIngress ${logicalId}: its recorded rule id is stale, and the live rule ${liveId} matching its record is held by ${keeper} of this stack, so it was left in place`
    );
    return;
  }
  const outcome = await this.revokeIngressRule(logicalId, physicalId, resourceType, context, {
    GroupId: groupId,
    SecurityGroupRuleIds: [liveId],
  });
  if (outcome === 'not-matched') {
    this.logger.debug(
      safeMsg`SecurityGroupIngress ${logicalId}: the rule matching its record vanished before the revoke`
    );
  }
}

/**
 * Best-effort lookup of the `sgr-...` id of an ALREADY-EXISTING ingress rule
 * (issue #1761).
 *
 * The "already exists" arm of {@link createSecurityGroupIngress} calls
 * this; its successful arm reads the id straight off
 * `AuthorizeSecurityGroupIngress`'s own response, which is what keeps the
 * mutating path free of the issue #1710 orphan hazard. The other caller is
 * `updateSecurityGroupIngress`'s equal-sides replay, AFTER the create
 * returned without an id (go-to-k/cdkd#4484): the record it restores
 * already names the rule, so nothing there can be orphaned.
 *
 * **Never throws.** A `DescribeSecurityGroupRules` failure (permissions,
 * throttle, a rule that no longer matches) degrades to `undefined`, which
 * records no attribute — `cdkd export` then refuses that one resource with
 * its own actionable message, which is strictly better than failing a deploy
 * that AWS already considers satisfied.
 *
 * Returns a value only when EXACTLY ONE non-egress rule on the group matches
 * the requested `(protocol, ports, source)` triple. Zero matches means the
 * rule is one cdkd cannot pin down; two or more
 * means the identifier would be ambiguous, and adopting an ambiguous id is
 * the #1658 failure mode (a state row that looks adopted but names the wrong
 * AWS object).
 *
 * **Paginated, unlike every other `Describe*` in this file.** That is not an
 * inconsistency to tidy away: the "exactly one" verdict above is a statement
 * about the WHOLE group, so a truncated first page turns a genuine 2-match
 * into a false "exactly one" and records the wrong `sgr-` id — the precise
 * outcome the ambiguity fence exists to prevent. A group can hold thousands
 * of rules (the account-level quota is per-SG, not per-page), so truncation
 * is reachable. `MAX_SG_RULE_PAGES` bounds the walk; exhausting it is treated
 * as "could not see the whole group" and records nothing, same as a throw.
 */
export async function lookupIngressRuleId(
  this: EC2Provider,
  logicalId: string,
  groupId: string,
  properties: Record<string, unknown>
): Promise<string | undefined> {
  try {
    const rules = await this.listGroupRules(groupId);
    if (rules === undefined) {
      this.logger.debug(
        `SecurityGroupIngress ${logicalId}: DescribeSecurityGroupRules on ${groupId} still ` +
          `paginating after ${MAX_SG_RULE_PAGES} pages — cannot prove the match is unique, ` +
          `so not recording an Id attribute`
      );
      return undefined;
    }

    const matches = rules.filter(
      (rule) => rule.IsEgress !== true && securityGroupRuleMatchesCfnIngress(rule, properties)
    );
    const ids = matches
      .map((rule) => rule.SecurityGroupRuleId)
      .filter((id): id is string => typeof id === 'string' && id.trim() !== '');
    if (ids.length !== 1) {
      this.logger.debug(
        `SecurityGroupIngress ${logicalId}: ${ids.length} existing rule(s) on ${groupId} match ` +
          `the requested protocol/ports/source — not recording an Id attribute`
      );
      return undefined;
    }
    return ids[0];
  } catch (error) {
    this.logger.debug(
      `SecurityGroupIngress ${logicalId}: could not look up the existing rule id on ${groupId} ` +
        `(${describeAwsFailure(error).detail}) — not recording an Id attribute`
    );
    return undefined;
  }
}

export async function updateSecurityGroupIngress(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  maskSecrets?: MaskerFn,
  replayingState = false,
  recordedAttributes?: Readonly<Record<string, unknown>>
): Promise<ResourceUpdateResult> {
  this.logger.debug(`Updating SecurityGroupIngress ${logicalId}: ${physicalId}`);

  // No-op short-circuit (mirrors `updateRoute`): a `cdkd drift --revert`
  // round-trip can call update() with new == old, which without this
  // guard would needlessly revoke + re-authorize the rule.
  if (JSON.stringify(properties) === JSON.stringify(previousProperties)) {
    if (!replayingState) return { physicalId, wasReplaced: false };
    // go-to-k/cdkd#4355: on a rollback replay the same bag on both sides is
    // `--revert-failed` over an update that journaled no attempted bag, and
    // the rule may be gone (a refused update had already revoked it) or live
    // (the failure came before any revoke). Authorize only, never revoke: a
    // revoked rule is re-created, and a live one answers Duplicate, which the
    // replay adopts. Short-circuiting would report a restore that never
    // happened; revoking first would drop a live rule for nothing.
    let idLookedUp = false;
    const restored = await this.createSecurityGroupIngress(
      logicalId,
      resourceType,
      properties,
      (message) => this.logger.warn(message),
      maskSecrets,
      true,
      undefined,
      () => {
        idLookedUp = true;
      }
    );
    // go-to-k/cdkd#4484: the recorded `sgr-` id may name the rule the refused
    // update revoked. An in-place answer is merged key-wise over the restored
    // record (`recordAfterRollbackUpdate`), so an Authorize response naming
    // no single id would leave that revoked id under `Id` for `cdkd export`
    // and `Fn::GetAtt`. So the answer is a replacement, whose attributes
    // REPLACE the record's: only an id proven now is recorded. A Duplicate
    // is no proof the recorded id still holds — an earlier send of this
    // replay that failed ambiguously, or an outer retry after a 5xx, may
    // have authorized the rule it now meets. Without an id in hand, and no
    // lookup already made by the Duplicate arm, the rule's id is looked up
    // by identity: best-effort (`lookupIngressRuleId` never throws), and
    // safe to `await` here since the record this replay restores already
    // names the rule, so nothing is orphaned.
    const ruleId =
      typeof restored.attributes?.['Id'] === 'string'
        ? restored.attributes['Id']
        : idLookedUp
          ? undefined
          : await this.lookupIngressRuleId(
              logicalId,
              properties['GroupId'] as string,
              // The Duplicate arm's identity bag. The create already warned
              // about a malformed protocol, so it is not warned twice.
              {
                ...properties,
                IpProtocol: narrowIngressIpProtocol(properties, () => undefined).ipProtocol,
              }
            );
    return {
      physicalId: restored.physicalId,
      wasReplaced: true,
      attributes: ruleId ? { Id: ruleId } : {},
      ...(restored.effectiveProperties && {
        effectiveProperties: restored.effectiveProperties,
      }),
    };
  }

  // go-to-k/cdkd#4492: when another surviving record of the stack holds this
  // record's OLD rule, revoking it would cut that record's access. A change
  // that keeps the rule's identity (a description — every identity key is
  // create-only, so the diff never sends more) then needs nothing at all:
  // re-authorizing would only meet the rule again, so the shared rule stays
  // exactly as it is and this record keeps naming it. A caller without a
  // diff (`drift --revert`) can still change the identity: the old rule
  // stays for its holder and the new one is authorized below.
  const keptFor = this.survivingIngressHolder(
    logicalId,
    physicalId.split('|')[0],
    previousProperties,
    recordedAttributes
  );
  if (
    keptFor !== undefined &&
    comparableIngressIdentity(properties['GroupId'], properties) ===
      comparableIngressIdentity(previousProperties['GroupId'], previousProperties)
  ) {
    this.logger.info(
      safeMsg`SecurityGroupIngress ${logicalId}: its rule is also held by ${keptFor} of this stack, so the update left it in place (AWS keeps one description for both)`
    );
    return {
      physicalId,
      wasReplaced: false,
      ...(recordedAttributes && { attributes: { ...recordedAttributes } }),
    };
  }

  // SecurityGroupIngress updates require replacement: revoke old, authorize new
  try {
    // go-to-k/cdkd#4492: an old rule a surviving record still holds is not
    // revoked (the delete would skip it for the same holder), and nothing
    // below may then claim it was.
    if (keptFor !== undefined) {
      this.logger.info(
        safeMsg`SecurityGroupIngress ${logicalId}: its previous rule is also held by ${keptFor} of this stack, so the update left it in place`
      );
    }
    const revoked =
      keptFor !== undefined
        ? undefined
        : await this.deleteSecurityGroupIngress(
            logicalId,
            physicalId,
            resourceType,
            previousProperties,
            // The old rule's recorded `sgr-` id, when there is one, revokes
            // exactly it (go-to-k/cdkd#4355).
            recordedAttributes || maskSecrets
              ? {
                  ...(recordedAttributes && { recordedAttributes }),
                  ...(maskSecrets && { maskSecrets }),
                }
              : undefined
          );
    // go-to-k/cdkd#3952: delete-then-create must ABORT when the revoke was
    // skipped (provider-delete-path.md): authorizing the new rule would leave
    // the old one live beside it with no record of it.
    const revokeSkip = deleteSkipReason(revoked);
    if (revokeSkip !== undefined) {
      const why =
        revokeSkip === REDACTED_DELETE_ADDRESS_SKIP_REASON
          ? 'its recorded permission is redacted in state'
          : 'its delete was skipped';
      throw markNonRetryable(
        new ProvisioningError(
          `Cannot update SecurityGroupIngress ${logicalId}: the previous rule could not be ` +
            `revoked because ${why}, so the new rule was ` +
            `NOT authorized. Revoke the old rule by hand, then drop its record with ` +
            // go-to-k/cdkd#4602: an UPDATE, so the stack is deployed and the
            // whole-stack form would drop every live record; no context
            // carries a stack destroy here, so this is the `--resource` form.
            `${stateOrphanRecordRemedy(undefined, logicalId)}; then re-deploy.`,
          resourceType,
          logicalId,
          physicalId
        )
      );
    }
    const createResult = await this.createSecurityGroupIngress(
      logicalId,
      resourceType,
      properties,
      // The revoke above has already committed, and on a rollback replay
      // `properties` is a STATE record — so warn and default rather than
      // strand the rule deleted with no template-side remedy.
      (message) => this.logger.warn(message),
      // Issue #2176 round 3: the re-create is what packs the composite id, so
      // the masker has to reach IT rather than being used in this frame.
      maskSecrets,
      replayingState,
      // Named in a refusal: the recorded `sgr-` id when there is one, else the
      // composite tuple — and nothing when the old rule was left in place.
      keptFor !== undefined
        ? undefined
        : typeof recordedAttributes?.['Id'] === 'string'
          ? recordedAttributes['Id']
          : physicalId
    );
    return {
      physicalId: createResult.physicalId,
      wasReplaced: true,
      ...(createResult.attributes && { attributes: createResult.attributes }),
      // Forward the re-create's narrowing (issue #1633). This arm is the one
      // the phantom drift is actually reachable through today — a malformed
      // `IpProtocol` only survives to reach a rule that already exists, and
      // the create arm above ran with the warn callback, so without this the
      // engine records the malformed desired bag and the next `cdkd drift`
      // reports the same difference again.
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
          `Failed to update SecurityGroupIngress ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/**
 * `permission` with every `Description` removed. A revoke never NEEDS one
 * ("If the security group rule has a description, you do not need to specify
 * the description to revoke the rule", EC2 API reference), but a description
 * that is SENT must match: a recorded description the live rule lacks — a
 * rule adopted from another owner (go-to-k/cdkd#4355), or one edited out of
 * band — answers `InvalidPermission.NotFound` in a non-default VPC, which the
 * delete reads as "already gone" and leaves the rule live. Dropping it also
 * keeps a redacted description from being sent (go-to-k/cdkd#3952).
 */
export function withoutDescription<T>(this: EC2Provider, value: T): T {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => this.withoutDescription(item)) as T;
  }
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'Description') continue;
    out[key] = this.withoutDescription(child);
  }
  return out as T;
}

/**
 * go-to-k/cdkd#4492: another record of this stack, outliving the operation,
 * that holds the rule `properties` describe on `groupId` — so this record's
 * revoke would cut its access. One predicate for the delete and the update's
 * revoke half, so the two cannot disagree about the same holder.
 */
export function survivingIngressHolder(
  this: EC2Provider,
  logicalId: string,
  groupId: string | undefined,
  properties: Record<string, unknown>,
  recordedAttributes: Readonly<Record<string, unknown>> | undefined
): string | undefined {
  return stackIngressRuleHolder(getStackRecords()?.survivors(), logicalId, groupId, properties, {
    own: recordedSgRuleId(recordedAttributes),
  });
}

export async function deleteSecurityGroupIngress(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void | ResourceDeleteResult> {
  this.logger.debug(`Deleting SecurityGroupIngress ${logicalId}: ${physicalId}`);

  // Parse composite physicalId: GroupId|Protocol|FromPort|ToPort
  const parts = physicalId.split('|');
  if (parts.length !== 4) {
    throw new ProvisioningError(
      compositeIdFormatMessage(EC2_SG_INGRESS_ID_FORMAT, logicalId, physicalId),
      resourceType,
      logicalId,
      physicalId
    );
  }

  const [groupId, ipProtocol, fromPortStr, toPortStr] = parts;

  // go-to-k/cdkd#4492: another record of this stack that outlives this
  // delete holds the same rule (see `resolveDuplicateIngress`), so revoking
  // it would cut that record's access. Only this record goes.
  if (properties !== undefined) {
    const holder = this.survivingIngressHolder(
      logicalId,
      groupId,
      properties,
      context?.recordedAttributes
    );
    if (holder !== undefined) {
      this.logger.info(
        safeMsg`SecurityGroupIngress ${logicalId}: its rule on ${groupId} is also held by ${holder} of this stack, so it was left in place`
      );
      return;
    }
  }

  // go-to-k/cdkd#4355: the recorded `sgr-` id addresses EXACTLY the rule it
  // names. But a recorded id can be STALE — a revoke-and-authorize that minted
  // a new id the record never received (a rollback's update arm keeps the old
  // attributes), or `--revert-failed`, whose record names the rule the refused
  // update already revoked while `properties` is the attempted rule. So a
  // not-found by id looks for this stack's live rule by its record
  // (`revokeMatchingLiveRule`) rather than reading as "gone".
  const recordedRuleId = context?.recordedAttributes?.['Id'];
  if (typeof recordedRuleId === 'string' && SG_RULE_ID_PATTERN.test(recordedRuleId)) {
    const byId = await this.revokeIngressRule(logicalId, physicalId, resourceType, context, {
      GroupId: groupId,
      SecurityGroupRuleIds: [recordedRuleId],
    });
    if (byId === 'revoked') return;
    return this.revokeMatchingLiveRule(
      logicalId,
      physicalId,
      resourceType,
      groupId!,
      properties,
      context
    );
  }

  // Build IpPermission from properties if available, otherwise from physicalId
  // go-to-k/cdkd#3952: RevokeSecurityGroupIngress matches the rule by its
  // permission, and a not-found below reads as "already deleted". NOT
  // `Description`: a revoke never needs it and every description is left
  // out of the permission below (`withoutDescription`), so a redacted one
  // cannot block the delete.
  if (properties) {
    const redactedSkip = redactedDeleteAddressSkip(
      this.logger,
      logicalId,
      'SecurityGroupIngress',
      redactedDeleteAddressFields({
        IpProtocol: properties['IpProtocol'],
        FromPort: properties['FromPort'],
        ToPort: properties['ToPort'],
        CidrIp: properties['CidrIp'],
        CidrIpv6: properties['CidrIpv6'],
        SourceSecurityGroupId: properties['SourceSecurityGroupId'],
        SourceSecurityGroupOwnerId: properties['SourceSecurityGroupOwnerId'],
        SourcePrefixListId: properties['SourcePrefixListId'],
      }),
      context
    );
    if (redactedSkip) return redactedSkip;
  }

  const ipPermission = properties
    ? this.withoutDescription(this.buildIpPermission(properties))
    : {
        IpProtocol: ipProtocol,
        FromPort: fromPortStr !== '-1' ? Number(fromPortStr) : undefined,
        ToPort: toPortStr !== '-1' ? Number(toPortStr) : undefined,
      };

  await this.revokeIngressRule(logicalId, physicalId, resourceType, context, {
    GroupId: groupId,
    IpPermissions: [ipPermission],
  });
}

/**
 * Send one `RevokeSecurityGroupIngress` for {@link deleteSecurityGroupIngress},
 * by rule id or by permission, answering whether it revoked a rule. A
 * not-found (after the region check), or a revoke that matched NOTHING
 * without an error (a default VPC answers so, listing the permission under
 * `UnknownIpPermissions`), is `'not-matched'`: the caller falls back from the
 * id, and on the permission path it is logged at warn, where it can also mean
 * the record no longer describes the live rule.
 */
export async function revokeIngressRule(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context: DeleteContext | undefined,
  input: RevokeSecurityGroupIngressCommandInput
): Promise<'revoked' | 'not-matched'> {
  const byId = input.SecurityGroupRuleIds !== undefined;
  const notMatched = (): 'not-matched' => {
    if (!byId) {
      this.logger.warn(
        safeMsg`SecurityGroupIngress ${logicalId}: no rule on the group matched ${physicalId}, so nothing was revoked; if the rule still exists, revoke it by hand`
      );
    }
    return 'not-matched';
  };
  try {
    const response = await this.ec2Client.send(new RevokeSecurityGroupIngressCommand(input));
    if ((response?.UnknownIpPermissions?.length ?? 0) > 0) return notMatched();
    this.logger.debug(`Successfully deleted SecurityGroupIngress ${logicalId}`);
    return 'revoked';
  } catch (error) {
    if (this.isNotFoundError(error)) {
      const clientRegion = await this.ec2Client.config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      return notMatched();
    }
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapDeleteError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete SecurityGroupIngress ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/** The {@link EC2Provider} methods this module defines. */
export const sgIngressUpdateMethods = {
  revokeMatchingLiveRule,
  lookupIngressRuleId,
  updateSecurityGroupIngress,
  withoutDescription,
  survivingIngressHolder,
  deleteSecurityGroupIngress,
  revokeIngressRule,
};
