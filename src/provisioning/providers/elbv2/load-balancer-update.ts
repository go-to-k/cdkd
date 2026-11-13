import type { ELBv2Provider } from '../elbv2-provider.js';
import { deployReplaceCommand } from '../../../utils/pasteable-command.js';
import {
  ModifyLoadBalancerAttributesCommand,
  SetSubnetsCommand,
  SetSecurityGroupsCommand,
  SetIpAddressTypeCommand,
  ModifyCapacityReservationCommand,
  ModifyIpPoolsCommand,
  type SubnetMapping,
  type IpAddressType,
  type EnablePrefixForIpv6SourceNatEnum,
  type EnforceSecurityGroupInboundRulesOnPrivateLinkTrafficEnum,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { ResourceUpdateNotSupportedError } from '../../../utils/error-handler.js';
import { isTruthyCfnBoolean } from '../../data-delete-intent.js';
import { protectedReplacementAdvice } from '../../replacement-protection-advice.js';
import { clearOnUpdateRemoval } from '../../update-removal.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import type { ResourceUpdateResult, SecretMasker } from '../../../types/resource.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import { unchangedBehindSecretReference } from '../../secret-reference-immutable.js';
import {
  loadBalancerNameFromArn,
  recordedNameMask,
  RETAIN_REMOVED_ATTRIBUTE,
  LOG_DELIVERY_ATTRIBUTE,
} from './shared.js';

export async function updateLoadBalancer(
  this: ELBv2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  callerMaskSecrets?: SecretMasker,
  fromReadback = false
): Promise<ResourceUpdateResult> {
  // Masks a pre-rotation secret-derived `Name` the ARN carries too
  // (go-to-k/cdkd#4339), which this deploy's own masker never resolved.
  const maskSecrets = recordedNameMask(
    callerMaskSecrets,
    previousProperties['Name'],
    loadBalancerNameFromArn(physicalId)
  );
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
  // ELBv2 LoadBalancer Name / Type / Scheme are immutable after
  // creation. The deploy engine detects these via immutable-property
  // detection and replaces the resource. The remaining surface is
  // mutable in-place via separate Set*/Modify* calls:
  //   - LoadBalancerAttributes → ModifyLoadBalancerAttributes (key diff)
  //   - Subnets / SubnetMappings / EnablePrefixForIpv6SourceNat → SetSubnets
  //   - SecurityGroups / EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic
  //     → SetSecurityGroups (full replace)
  //   - IpAddressType → SetIpAddressType
  //   - Ipv4IpamPoolId → ModifyIpPools (removal → RemoveIpamPools)
  //   - MinimumLoadBalancerCapacity → ModifyCapacityReservation
  //     (removal → ResetCapacityReservation; the
  //     EnableCapacityReservationProvisionStabilize flag gates a
  //     provisioned-state wait, not an API field)
  //   - Tags → AddTags / RemoveTags (key diff)
  // Any other diff (Name / Type / Scheme) rejects with
  // ResourceUpdateNotSupportedError so `cdkd drift --revert` surfaces
  // the limitation instead of silently no-op'ing.
  const handledKeys = new Set([
    'LoadBalancerAttributes',
    'Subnets',
    'SubnetMappings',
    'SecurityGroups',
    'IpAddressType',
    'Tags',
    'EnablePrefixForIpv6SourceNat',
    'EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic',
    'Ipv4IpamPoolId',
    'MinimumLoadBalancerCapacity',
    'EnableCapacityReservationProvisionStabilize',
  ]);
  // Compared key by key: a secret-derived value is recorded as its
  // `{{resolve:...}}` reference and handed here resolved, which is no change
  // (go-to-k/cdkd#4275). `Name` is decided by the name the ARN carries; any
  // other key takes the masker arm, which only a key the engine replaces on
  // every change (`Type`, `Scheme`) can pass.
  let immutableChanged = false;
  for (const key of new Set([...Object.keys(properties), ...Object.keys(previousProperties)])) {
    if (handledKeys.has(key)) continue;
    if (JSON.stringify(properties[key]) === JSON.stringify(previousProperties[key])) continue;
    if (
      await unchangedBehindSecretReference({
        resourceType,
        key,
        desired: properties[key],
        previous: previousProperties[key],
        physicalName: key === 'Name' ? loadBalancerNameFromArn(physicalId) : undefined,
        // The deploy's own masker: whether a desired value is one this
        // deploy resolved is its question, not the recorded name's.
        maskSecrets: callerMaskSecrets,
      })
    ) {
      continue;
    }
    immutableChanged = true;
    break;
  }
  if (immutableChanged) {
    // Issue [#2610] site 1. `--replace` alone cannot succeed on a load
    // balancer whose `deletion_protection.enabled` attribute is on: the
    // replacement's DELETE runs from the deploy engine, which never sets
    // `DeleteContext.removeProtection` — see
    // `../replacement-protection-advice.ts` for the mechanism and for why the
    // RECORDED bag is the one to read. `deletion_protection.enabled` lives
    // INSIDE `LoadBalancerAttributes`, which `handledKeys` above strips from
    // the comparison, so this refusal is reached with the attribute
    // unexamined and the attribute diff is applied only further down — i.e.
    // at this point AWS still holds what `previousProperties` records.
    const deletionProtected = this.normalizeAttributes(
      previousProperties['LoadBalancerAttributes']
    ).some((a) => a.Key === 'deletion_protection.enabled' && isTruthyCfnBoolean(a.Value));
    const remedy = deletionProtected
      ? protectedReplacementAdvice({
          evidence:
            "cdkd's recorded properties for this load balancer carry " +
            'LoadBalancerAttributes deletion_protection.enabled=true',
          replaceFlags: deployReplaceCommand(),
          disable: {
            before: 'aws elbv2 modify-load-balancer-attributes --load-balancer-arn',
            identifier: physicalId,
            after: '--attributes Key=deletion_protection.enabled,Value=false',
            // An ARN carrying a secret-derived name (the pre-rotation one
            // included) withholds the command (go-to-k/cdkd#4339).
            maskSecrets,
          },
        })
      : `For Name / Type / Scheme re-deploy with ${deployReplaceCommand()}, or destroy + redeploy the stack.`;
    throw new ResourceUpdateNotSupportedError(
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      logicalId,
      'ELBv2 LoadBalancer Name / Type / Scheme are immutable on AWS — none of the ELBv2 Modify* / Set* APIs accept these fields; they are fixed at creation. cdkd handles LoadBalancerAttributes / Subnets / SubnetMappings / SecurityGroups / IpAddressType / Tags in-place. ' +
        remedy
    );
  }

  // ─── LoadBalancerAttributes ──────────────────────────────────────
  // ModifyLoadBalancerAttributes replaces ONLY the listed attrs — keys
  // not in the request are left untouched. Only added / changed keys are
  // sent; a removed key keeps its live value, as CloudFormation leaves it
  // (RETAIN_REMOVED_ATTRIBUTE). Skip the call entirely when nothing changed
  // so the no-drift round-trip is a clean no-op.
  //
  // A kept LOG-DELIVERY key is the one exposure in that parity: a template
  // that drops `access_logs.s3.*` together with the bucket it named leaves
  // the load balancer writing to a bucket name a third party could claim.
  // CloudFormation keeps these keys too (CFn A/B us-east-1 2026-10-17: a
  // dropped `access_logs.s3.enabled` / `bucket` / `prefix` and
  // `connection_logs.s3.*`, as single keys and as a whole list, all stayed),
  // so cdkd keeps them as well and warns, naming the keys (never values).
  const removedLogKeys: string[] = [];
  const submittedAttrs = this.diffAttributeBag(
    'LoadBalancerAttributes',
    logicalId,
    properties['LoadBalancerAttributes'],
    previousProperties['LoadBalancerAttributes'],
    (key) => {
      if (LOG_DELIVERY_ATTRIBUTE.test(key)) removedLogKeys.push(key);
      return RETAIN_REMOVED_ATTRIBUTE();
    },
    fromReadback,
    maskSecrets
  );
  if (submittedAttrs.length > 0) {
    await this.getClient().send(
      new ModifyLoadBalancerAttributesCommand({
        LoadBalancerArn: physicalId,
        Attributes: submittedAttrs,
      })
    );
    this.logger.debug(
      `Applied ${submittedAttrs.length} LoadBalancerAttributes change(s) for ${logicalId}`
    );
  }
  // A kind the desired bag already turns off (`<kind>_logs.s3.enabled:
  // 'false'`) delivers nothing, so its dropped bucket / prefix is not named.
  const desiredAttrs = new Map(
    this.normalizeAttributes(properties['LoadBalancerAttributes']).map((a) => [a.Key, a.Value])
  );
  const exposedLogKeys = removedLogKeys.filter(
    (key) => desiredAttrs.get(`${key.split('.')[0]}.s3.enabled`) !== 'false'
  );
  if (exposedLogKeys.length > 0) {
    const mask = maskerOrIdentity(maskSecrets);
    const keys = exposedLogKeys.map((key) => mask(key)).join(', ');
    const one = exposedLogKeys.length === 1;
    this.logger.warn(
      safeMsg`${logicalId}: LoadBalancerAttributes ${one ? 'key' : 'keys'} ${keys} ${one ? 'is' : 'are'} no longer declared and ${one ? 'keeps its live value' : 'keep their live values'}, as CloudFormation leaves ${one ? 'it' : 'them'}, so the load balancer may keep delivering logs to the bucket it names. To stop it, declare the matching '<kind>_logs.s3.enabled' key as 'false' and deploy.`
    );
  }

  // ─── Subnets / SubnetMappings ────────────────────────────────────
  // SetSubnets is a full-replace API: the request payload is the
  // complete desired set; AWS swaps in / out as needed. SubnetMappings
  // wins when both are present (matches CFn semantics — they're a
  // strict superset of Subnets). Skip the call when neither value
  // actually changed.
  const newSubnets = properties['Subnets'] as string[] | undefined;
  const oldSubnets = previousProperties['Subnets'] as string[] | undefined;
  const newMappings = properties['SubnetMappings'] as SubnetMapping[] | undefined;
  const oldMappings = previousProperties['SubnetMappings'] as SubnetMapping[] | undefined;
  const newIpv6SourceNat = properties['EnablePrefixForIpv6SourceNat'] as
    | EnablePrefixForIpv6SourceNatEnum
    | undefined;
  const oldIpv6SourceNat = previousProperties['EnablePrefixForIpv6SourceNat'] as
    | EnablePrefixForIpv6SourceNatEnum
    | undefined;
  const subnetsChanged = JSON.stringify(newSubnets) !== JSON.stringify(oldSubnets);
  const mappingsChanged = JSON.stringify(newMappings) !== JSON.stringify(oldMappings);
  // EnablePrefixForIpv6SourceNat rides on SetSubnets: a change re-issues the
  // current subnet set with the new flag. A REMOVED flag on its own is
  // retained (no call) — CFn retains most removed fields. The COMBINED case
  // (flag removed in the SAME deploy that changes Subnets, so the Set call is
  // issued WITHOUT the member) is A/B-verified: AWS RETAINS the live value on
  // omission — measured us-east-1 2026-08-12 against a dualstack NLB holding
  // the non-default `on`. Adding a third subnet with the member omitted left
  // the flag `on`. So omitting is correct and re-sending would be redundant.
  //
  // Scope of that evidence, because this code can emit TWO request forms and
  // they are fenced differently. The `nlb-source-nat` integ regression-fences
  // the `SubnetMappings` arm only. The plain `Subnets` arm was measured by
  // hand during the same A/B and retained identically, but nothing in the
  // repo reproduces it, so treat it as observed-once rather than guarded — if
  // AWS ever diverges per arm, the integ will not catch the `Subnets` side.
  const ipv6SourceNatChanged =
    newIpv6SourceNat !== undefined && newIpv6SourceNat !== oldIpv6SourceNat;
  if (subnetsChanged || mappingsChanged || ipv6SourceNatChanged) {
    await this.getClient().send(
      new SetSubnetsCommand({
        LoadBalancerArn: physicalId,
        ...(newMappings && newMappings.length > 0
          ? { SubnetMappings: newMappings }
          : { Subnets: newSubnets }),
        ...(newIpv6SourceNat !== undefined && {
          EnablePrefixForIpv6SourceNat: newIpv6SourceNat,
        }),
      })
    );
    this.logger.debug(`Updated Subnets / SubnetMappings for ${logicalId}`);
  }

  // ─── SecurityGroups ──────────────────────────────────────────────
  // SetSecurityGroups requires the full desired set (overrides the
  // previous association). Note: NLBs without a SG at create time
  // cannot have one added later — AWS will reject the call. That's
  // the deploy engine's replacement layer's problem; here we just
  // surface the AWS error if it fires.
  const newSGs = properties['SecurityGroups'] as string[] | undefined;
  const oldSGs = previousProperties['SecurityGroups'] as string[] | undefined;
  const newEnforce = properties['EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic'] as
    | EnforceSecurityGroupInboundRulesOnPrivateLinkTrafficEnum
    | undefined;
  const oldEnforce = previousProperties['EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic'] as
    | EnforceSecurityGroupInboundRulesOnPrivateLinkTrafficEnum
    | undefined;
  // EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic rides on
  // SetSecurityGroups: a change re-issues the current security-group set
  // with the new flag. A REMOVED flag is retained (no-op) — same rationale
  // as EnablePrefixForIpv6SourceNat above. The COMBINED case is A/B-verified
  // the same way: AWS RETAINS on omission — measured us-east-1 2026-08-12
  // against an NLB holding the non-default `off`, where adding a second
  // security group with the member omitted left the flag `off`. (Note the
  // SetSecurityGroups RESPONSE omits the field when the request did; the
  // DescribeLoadBalancers readback is the authoritative check.) The flag is
  // settable and readable on any SG-bearing NLB — no PrivateLink endpoint
  // service has to exist for the value to persist.
  const enforceChanged = newEnforce !== undefined && newEnforce !== oldEnforce;
  if (JSON.stringify(newSGs) !== JSON.stringify(oldSGs) || enforceChanged) {
    await this.getClient().send(
      new SetSecurityGroupsCommand({
        LoadBalancerArn: physicalId,
        SecurityGroups: newSGs ?? [],
        ...(newEnforce !== undefined && {
          EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic: newEnforce,
        }),
      })
    );
    this.logger.debug(`Updated SecurityGroups for ${logicalId}`);
  }

  // ─── IpAddressType ───────────────────────────────────────────────
  // A REMOVED IpAddressType is reset to the create default `ipv4`: a
  // CloudFormation update dropping `dualstack` from an ALB set it back to
  // `ipv4` in place (issue #1160, CFn A/B us-east-1 2026-10-17; only
  // `dualstack` was measured, `dualstack-without-public-ipv4` is assumed
  // to reset the same way), while
  // SetIpAddressType is never called for an absent value. `drift --revert`
  // writes no reset for a value its recorded baseline lacks (the
  // go-to-k/cdkd#4147 rule).
  const newIpType = (
    fromReadback
      ? properties['IpAddressType']
      : clearOnUpdateRemoval(
          properties['IpAddressType'],
          previousProperties['IpAddressType'],
          'ipv4'
        )
  ) as IpAddressType | undefined;
  const oldIpType = previousProperties['IpAddressType'] as IpAddressType | undefined;
  if (newIpType !== undefined && newIpType !== oldIpType) {
    await this.getClient().send(
      new SetIpAddressTypeCommand({
        LoadBalancerArn: physicalId,
        IpAddressType: newIpType,
      })
    );
    this.logger.debug(`Updated IpAddressType for ${logicalId}`);
  }

  // ─── Ipv4IpamPoolId ──────────────────────────────────────────────
  // ModifyIpPools sets / removes the IPAM pool association. Removal has a
  // dedicated API spelling (RemoveIpamPools: ['ipv4']), so — unlike the two
  // Set* flags above — dropping the property from the template detaches
  // the pool instead of silently retaining it.
  const newIpamPool = properties['Ipv4IpamPoolId'] as string | undefined;
  const oldIpamPool = previousProperties['Ipv4IpamPoolId'] as string | undefined;
  if (newIpamPool !== oldIpamPool) {
    await this.getClient().send(
      new ModifyIpPoolsCommand({
        LoadBalancerArn: physicalId,
        ...(newIpamPool !== undefined
          ? { IpamPools: { Ipv4IpamPoolId: newIpamPool } }
          : { RemoveIpamPools: ['ipv4'] }),
      })
    );
    this.logger.debug(
      newIpamPool !== undefined
        ? `Updated Ipv4IpamPoolId for ${logicalId}`
        : `Removed IPAM pool association for ${logicalId}`
    );
  }

  // ─── MinimumLoadBalancerCapacity ─────────────────────────────────
  // ModifyCapacityReservation sets the reservation; removal resets it via
  // the dedicated ResetCapacityReservation flag (a capacity reservation is
  // billable, so retaining a removed one would silently keep charging).
  const newCapacity = properties['MinimumLoadBalancerCapacity'] as
    | { CapacityUnits?: number | string }
    | undefined;
  const oldCapacity = previousProperties['MinimumLoadBalancerCapacity'] as
    | { CapacityUnits?: number | string }
    | undefined;
  const newCapacityUnits =
    newCapacity?.CapacityUnits !== undefined ? Number(newCapacity.CapacityUnits) : undefined;
  const oldCapacityUnits =
    oldCapacity?.CapacityUnits !== undefined ? Number(oldCapacity.CapacityUnits) : undefined;
  if (newCapacityUnits !== oldCapacityUnits) {
    await this.getClient().send(
      new ModifyCapacityReservationCommand({
        LoadBalancerArn: physicalId,
        ...(newCapacityUnits !== undefined
          ? { MinimumLoadBalancerCapacity: { CapacityUnits: newCapacityUnits } }
          : { ResetCapacityReservation: true }),
      })
    );
    // The update twin of the create-path capacity debug line, and the reason
    // this arm takes a masker at all: it has no try/catch, so its REJECTIONS
    // are masked by `update()`'s outer frame, but a debug line it emits on
    // the SUCCESS path never reaches that frame.
    //
    // The line therefore reports the value the TEMPLATE declared, not the
    // one that went on the wire (`'1e5'` logs as `1e5` while AWS received
    // `100000`). That divergence is deliberate: the masker matches by
    // literal occurrence, so only the declared spelling can be masked, and a
    // log line that cannot be masked is worth less than one that is
    // approximate.
    //
    // Masks the RAW property value, NOT `newCapacityUnits` — the `Number()`
    // coercion two statements up is exactly the "mask before you stringify"
    // gap the `SecretMasker` contract documents, and an earlier revision of
    // this line got it wrong while asserting the opposite in a comment.
    // A masker matches by LITERAL occurrence, so any value `Number()` does
    // not round-trip renders unmasked: `'0471'` prints `471`, `'1e5'` prints
    // `100000`, `' 4071'` prints `4071`, and a 20-digit value loses its tail
    // to float precision. The create twin above already masks the raw value;
    // this now matches it.
    this.logger.debug(
      newCapacityUnits !== undefined
        ? `Requested capacity reservation of ${maskerOrIdentity(maskSecrets)(
            String(newCapacity?.CapacityUnits)
          )} LCU for ${logicalId}`
        : `Reset capacity reservation for ${logicalId}`
    );
    if (
      newCapacityUnits !== undefined &&
      isTruthyCfnBoolean(properties['EnableCapacityReservationProvisionStabilize']) &&
      process.env['CDKD_NO_WAIT'] !== 'true'
    ) {
      await this.waitForCapacityReservationProvisioned(physicalId, logicalId);
    }
  }

  // ─── Tags ────────────────────────────────────────────────────────
  await this.applyTagDiff(
    physicalId,
    resourceType,
    logicalId,
    previousProperties['Tags'],
    properties['Tags'],
    maskSecrets
  );

  return { physicalId, wasReplaced: false };
}
