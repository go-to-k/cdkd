import { type IpPermission, type SecurityGroupRule } from '@aws-sdk/client-ec2';
import { requireConfigString } from '../../config-shape.js';
import { canonicalizeIpProtocolValue } from '../../../utils/ip-protocol.js';
import type { ResourceState } from '../../../types/state.js';
import { isRedactedRecordedValue } from '../../redacted-delete-address.js';
import { THROTTLING_ERROR_NAMES } from '../../../deployment/retryable-errors.js';

/** The `AuthorizeSecurityGroupIngress` default protocol: "all protocols". */
const SG_INGRESS_IP_PROTOCOL_DEFAULT = '-1';

/** The refusal path both the create guard and the canonicalizer report under. */
const SG_INGRESS_IP_PROTOCOL_PATH = 'AWS::EC2::SecurityGroupIngress IpProtocol';

/**
 * Bounded eventual-consistency retry for the `DescribeSecurityGroups`
 * read-back (`readSecurityGroupVpcId`, issue #3097): an answer
 * `isNotFoundError` classifies as not-found is retried, everything else omits
 * the attribute at once. Five ATTEMPTS (four retries) a second apart cover the
 * propagation window EC2 documents for its read APIs;
 * `securityGroupReadbackDelays.sleep` is the unit-test seam (the pattern
 * `deleteTableRetryDelays` uses), and the fallback is the provider's own
 * `sleep`, so the class has one timer to fake.
 */
export const SG_READBACK_NOT_FOUND_ATTEMPTS = 5;
export const SG_READBACK_RETRY_DELAY_MS = 1000;
export const securityGroupReadbackDelays: { sleep?: (ms: number) => Promise<void> } = {};

/**
 * Page ceiling for {@link EC2Provider.lookupIngressRuleId}'s
 * `DescribeSecurityGroupRules` walk (issue #1761).
 *
 * The walk asks for {@link SG_RULE_PAGE_SIZE} rules per page, so 20 pages cover
 * 20,000 rules on a single security group — far beyond any real one (AWS's
 * default quota is 60 rules per SG, 1000 at the maximum quota increase). That
 * arithmetic only holds because the request pins `MaxResults`; without it AWS
 * applies its own default page size and the bound would mean an unknown number
 * of rules. The bound exists only so a pathological / looping `NextToken` cannot
 * hang a deploy; reaching it records nothing rather than answering from a
 * partial view.
 */
export const MAX_SG_RULE_PAGES = 20;

/**
 * `MaxResults` for that walk. `DescribeSecurityGroupRules` accepts 5-1000; the
 * ceiling is what makes {@link MAX_SG_RULE_PAGES}'s "20,000 rules" true and
 * keeps the common case (a group with a handful of rules) to ONE round trip.
 */
export const SG_RULE_PAGE_SIZE = 1000;

/**
 * The `sgr-…` security-group rule id, anchored.
 *
 * The twin of `SG_RULE_ID_PATTERN` in `src/cli/commands/export.ts`, restated
 * rather than imported for the same reason that file restates
 * `ROUTE_DESTINATION_KEYS` instead of importing it from here: neither module may
 * pull the other's graph (the export command would drag in this provider and its
 * SDK client).
 *
 * Anchoring is what discriminates. `startsWith('sgr-')` also accepts
 * `sgr-0abc|tcp|443|443` — a composite wearing the identifier's prefix — which
 * on the import path reaches AWS as a malformed id and raises
 * `InvalidSecurityGroupRuleId.Malformed`, an error `isNotFoundError` does not
 * match, so `verifyExplicit` would THROW and abort the whole `cdkd import` run
 * instead of declining that one row.
 */
export const SG_RULE_ID_PATTERN = /^sgr-[0-9a-f]+$/;

/**
 * Resolve the `IpProtocol` an `AWS::EC2::SecurityGroupIngress` rule actually
 * SENDS, plus the bag that describes it (issue #1633).
 *
 * ONE source for a decision three call sites have to agree on, exactly as
 * `narrowRouteDestinations` is for the Route destinations: the create arm
 * (which authorizes the rule), the update arm (which revokes then re-creates
 * it), and the DIFF-side canonicalizer. If those disagreed, state and template
 * would each be normalized to a different protocol and the fix would become
 * the bug — the lesson `.claude/rules/providers.md` records from #1591.
 *
 * Two shapes reach the wire as something other than what the template wrote,
 * and BOTH have to be recorded or they become permanent phantom drift, because
 * `readSecurityGroupIngressCurrentState` can only ever return what AWS holds:
 *
 * - a MALFORMED value (`''` / `{}` / `true` / an explicit `null`), which
 *   `requireConfigString` refuses on the template-path create and — under
 *   `onUnusable` — warn-substitutes the default on the replay-reachable paths;
 * - a finite NUMBER, the accepted-by-design shape from an unquoted YAML
 *   `IpProtocol: -1` (issue #1513), which is stringified before it is sent.
 *
 * The second is not announced by a warning, and does not need to be: unlike a
 * dropped destination key it loses NOTHING — `-1` and `'-1'` name the same
 * protocol — so there is no silent loss for `effectiveProperties` to launder
 * into a clean record, which is the hazard the "already ANNOUNCED" clause of
 * the `effectiveProperties` contract exists to guard against. Recording the
 * string additionally fixes the delete path, which forwards the state record
 * to `buildIpPermission` and would otherwise hand the EC2 API a number.
 *
 * `narrowed` is a FRESH object only when the sent value differs from the
 * declared one, so an ordinary `IpProtocol: 'tcp'` bag is returned untouched
 * and compares byte-for-byte as before.
 *
 * @param onUnusable Passed straight through to `requireConfigString`: absent,
 *   a malformed value THROWS (the template-path create, where the user can fix
 *   the template); supplied, it warns and takes the default. The canonicalizer
 *   passes a no-op — a diff must never throw, and it must never warn either,
 *   since the provisioning path already announces the same substitution.
 */
export function narrowIngressIpProtocol(
  properties: Record<string, unknown>,
  onUnusable?: (message: string) => void
): { ipProtocol: string; narrowed: Record<string, unknown> } {
  const declared = properties['IpProtocol'];
  const ipProtocol = requireConfigString(
    declared,
    SG_INGRESS_IP_PROTOCOL_DEFAULT,
    SG_INGRESS_IP_PROTOCOL_PATH,
    { coerceNumber: true, ...(onUnusable && { onUnusable }) }
  );

  // An ABSENT key stays absent. The drift comparator only descends into keys
  // present in cdkd state, so adding the default here would START comparing a
  // key the template never declared — manufacturing the very drift this helper
  // removes, in the one case that does not have it today.
  if (declared === undefined || declared === ipProtocol) {
    return { ipProtocol, narrowed: properties };
  }
  return { ipProtocol, narrowed: { ...properties, IpProtocol: ipProtocol } };
}

/**
 * Fold a rule bag's `IpProtocol` to the spelling AWS will hold (issue #1648).
 *
 * DIFF-side only — see the call site in `canonicalizeDesiredProperties` for why
 * this is not done inside `narrowIngressIpProtocol`, which also feeds the wire.
 * Returns the original object when nothing changes, so an ordinary rule
 * compares byte-for-byte as before.
 */
export function canonicalizeSgRuleProtocol(rule: Record<string, unknown>): Record<string, unknown> {
  if (!('IpProtocol' in rule)) return rule;
  const next = canonicalizeIpProtocolValue(rule['IpProtocol']);
  if (next === rule['IpProtocol']) return rule;
  return { ...rule, IpProtocol: next };
}

/**
 * The `AWS::EC2::SecurityGroup` inline-rule twin of
 * {@link canonicalizeSgRuleProtocol}: fold every element of the two rule lists.
 * Identity-returns when nothing changes, and leaves a non-array list or a
 * non-object element alone so a malformed template still reaches AWS's own
 * validation rather than being reshaped here.
 */
export function canonicalizeSgInlineRuleProtocols(
  properties: Record<string, unknown>
): Record<string, unknown> {
  let out = properties;
  for (const key of ['SecurityGroupIngress', 'SecurityGroupEgress'] as const) {
    const list = out[key];
    if (!Array.isArray(list)) continue;
    let changed = false;
    const mapped = list.map((el) => {
      if (el === null || typeof el !== 'object' || Array.isArray(el)) return el;
      const next = canonicalizeSgRuleProtocol(el as Record<string, unknown>);
      if (next !== el) changed = true;
      return next;
    });
    if (changed) out = { ...out, [key]: mapped };
  }
  return out;
}

// ─── SecurityGroup rule helpers ──────────────────────────────────────
//
// `IpPermissions` reverse-mapping: AWS returns SG rules in normalized
// `IpPermissions[]` form where each permission can carry multiple
// `IpRanges`, `Ipv6Ranges`, `UserIdGroupPairs`, and `PrefixListIds`
// entries. The CFn `SecurityGroupIngress` / `SecurityGroupEgress` shape
// is rule-list-style — one entry per `(protocol, ports, source-or-dest)`
// tuple. The reverse-map produces one CFn rule per source/dest entry
// inside each AWS permission, matching the field naming the
// in-place SG update path (`applySecurityGroupRuleDiff`) expects so
// `cdkd drift --revert` can round-trip cleanly.

type SgDirection = 'ingress' | 'egress';
export type CfnSgRule = Record<string, unknown>;

/**
 * Flatten AWS `IpPermission[]` (the `DescribeSecurityGroups` shape) into
 * a flat list of CFn-shaped rules. Each `IpRanges` / `Ipv6Ranges` /
 * `UserIdGroupPairs` / `PrefixListIds` entry inside a permission becomes
 * its own CFn rule, so the resulting list aligns 1:1 with the way users
 * template `SecurityGroupIngress` / `SecurityGroupEgress`.
 *
 * Field names follow CFn direction conventions:
 *  - ingress: `SourceSecurityGroupId`, `SourceSecurityGroupOwnerId`, `SourcePrefixListId`
 *  - egress:  `DestinationSecurityGroupId`, `DestinationPrefixListId`
 *    (AWS does not return a peer-owner id for egress, matching CFn.)
 *
 * `Description` is surfaced when AWS returns it on the source/dest entry
 * (per-rule descriptions are stored on the entry, not the parent
 * permission).
 */
export function flattenIpPermissions(perms: IpPermission[], direction: SgDirection): CfnSgRule[] {
  const out: CfnSgRule[] = [];
  for (const p of perms) {
    const base: CfnSgRule = {};
    if (p.IpProtocol !== undefined) base['IpProtocol'] = p.IpProtocol;
    if (p.FromPort !== undefined) base['FromPort'] = p.FromPort;
    if (p.ToPort !== undefined) base['ToPort'] = p.ToPort;

    for (const ip of p.IpRanges ?? []) {
      const rule: CfnSgRule = { ...base };
      if (ip.CidrIp !== undefined) rule['CidrIp'] = ip.CidrIp;
      if (ip.Description !== undefined) rule['Description'] = ip.Description;
      out.push(rule);
    }
    for (const ipv6 of p.Ipv6Ranges ?? []) {
      const rule: CfnSgRule = { ...base };
      if (ipv6.CidrIpv6 !== undefined) rule['CidrIpv6'] = ipv6.CidrIpv6;
      if (ipv6.Description !== undefined) rule['Description'] = ipv6.Description;
      out.push(rule);
    }
    for (const grp of p.UserIdGroupPairs ?? []) {
      const rule: CfnSgRule = { ...base };
      if (direction === 'ingress') {
        if (grp.GroupId !== undefined) rule['SourceSecurityGroupId'] = grp.GroupId;
        if (grp.UserId !== undefined) rule['SourceSecurityGroupOwnerId'] = grp.UserId;
      } else {
        if (grp.GroupId !== undefined) rule['DestinationSecurityGroupId'] = grp.GroupId;
      }
      if (grp.Description !== undefined) rule['Description'] = grp.Description;
      out.push(rule);
    }
    for (const pl of p.PrefixListIds ?? []) {
      const rule: CfnSgRule = { ...base };
      if (direction === 'ingress') {
        if (pl.PrefixListId !== undefined) rule['SourcePrefixListId'] = pl.PrefixListId;
      } else {
        if (pl.PrefixListId !== undefined) rule['DestinationPrefixListId'] = pl.PrefixListId;
      }
      if (pl.Description !== undefined) rule['Description'] = pl.Description;
      out.push(rule);
    }

    // Empty-source permission (rare but legal — e.g. a permission with
    // only `IpRanges: []`). Emit the bare protocol/port shell so the
    // shape isn't lost; the comparator may still fire drift, which is
    // correct because the user templated nothing here.
    if (
      (p.IpRanges?.length ?? 0) === 0 &&
      (p.Ipv6Ranges?.length ?? 0) === 0 &&
      (p.UserIdGroupPairs?.length ?? 0) === 0 &&
      (p.PrefixListIds?.length ?? 0) === 0
    ) {
      out.push({ ...base });
    }
  }
  return out;
}

/**
 * Identity-key for a CFn SG rule. Matches the diff key used by
 * `applySecurityGroupRuleDiff` so the read-side reverse-mapping and the
 * write-side rule diff agree on rule identity for `cdkd drift --revert`.
 *
 * Direction-sensitive: ingress uses `Source*` fields, egress uses
 * `Destination*`.
 */
/**
 * The `IpProtocol` component of a security-group rule identity key.
 *
 * A NUMBER is stringified so a record written BEFORE issue #1633 still matches:
 * AWS always reports the protocol as a string, so a legacy record holding the
 * number `-1` keyed as `{"p":-1}` against AWS's `{"p":"-1"}` and matched
 * nothing — `readSecurityGroupIngressCurrentState` returned `undefined` and
 * `cdkd drift` reported the rule as GONE, forever. The canonicalizer makes such
 * a record's diff NO_CHANGE, so no deploy ever rewrites it either; normalizing
 * at the KEY is what heals the existing population with no migration.
 *
 * Anything that is neither a string nor a number is passed through UNCHANGED
 * rather than blanket-`String()`-ed: a malformed object would otherwise key as
 * the useless `'[object Object]'`, silently collapsing every malformed record
 * onto one bucket. Such a rule matches nothing either way — this keeps the
 * non-match honest instead of manufacturing a fake identity.
 */
export function sgProtocolKey(value: unknown): unknown {
  // Issue #1643 extends the #1633 normalization from the value's TYPE to its
  // SPELLING, for the same reason and at the same place. AWS not only always
  // reports the protocol as a string, it also substitutes the canonical NAME
  // for the four numbers it has one for (`1`/`6`/`17`/`58` ->
  // `icmp`/`tcp`/`udp`/`icmpv6`, measured us-east-1 2026-08-12) and lower-cases
  // a name it is given. So a record holding `'6'` keyed as `{"p":"6"}` against
  // AWS's `{"p":"tcp"}` and matched nothing — exactly the failure the comment
  // below describes for the legacy numeric `-1`, one value-mapping deeper.
  // Normalizing at the KEY heals the existing population with no migration
  // here too, and keeps the standalone lookup and the inline-rule reconcile
  // reading ONE definition of protocol identity.
  return canonicalizeIpProtocolValue(value ?? '-1');
}

/**
 * The rule a standalone `AWS::EC2::SecurityGroupIngress` bag describes, as a
 * comparable key (go-to-k/cdkd#4355): the group, protocol, port range and
 * source — what AWS treats as the same rule. `Description` is left out, since
 * AWS reports a duplicate whatever the description says.
 */
export function ingressRuleIdentity(groupId: unknown, properties: Record<string, unknown>): string {
  const source = (key: string): unknown => properties[key] ?? null;
  return JSON.stringify({
    g: groupId ?? null,
    p: sgProtocolKey(properties['IpProtocol']),
    f: cfnIngressPortValue(properties['FromPort']),
    t: cfnIngressPortValue(properties['ToPort']),
    c4: source('CidrIp'),
    c6: source('CidrIpv6'),
    sg: source('SourceSecurityGroupId'),
    sgName: source('SourceSecurityGroupName'),
    sgOwner: source('SourceSecurityGroupOwnerId'),
    pl: source('SourcePrefixListId'),
  });
}

/** The keys `ingressRuleIdentity` reads: a redacted one names no rule. */
const INGRESS_IDENTITY_KEYS = [
  'IpProtocol',
  'FromPort',
  'ToPort',
  'CidrIp',
  'CidrIpv6',
  'SourceSecurityGroupId',
  'SourceSecurityGroupName',
  'SourceSecurityGroupOwnerId',
  'SourcePrefixListId',
] as const;

/**
 * go-to-k/cdkd#4492: `rule`'s {@link ingressRuleIdentity} on `group`, or
 * `undefined` when it cannot be compared. A rule whose ports are not readable
 * numbers, or whose identity holds a redacted value (`***`, an unresolved
 * reference), matches nothing — two such records can compare equal while
 * naming different rules. Spellings are compared as written otherwise
 * (`IpProtocol` / ports aside), so two spellings of one rule (a group name
 * against its id, `-1` with explicit ports, a CIDR written two ways, an owner
 * id present on one side only) do not pair: that fails CLOSED (a refusal, or
 * a revoke the sibling's own create re-authorizes on the next deploy).
 */
export function comparableIngressIdentity(group: unknown, rule: unknown): string | undefined {
  if (
    !isPlainRecord(rule) ||
    typeof group !== 'string' ||
    group === '' ||
    isRedactedRecordedValue(group) ||
    !INGRESS_IDENTITY_KEYS.every((key) => !isRedactedRecordedValue(rule[key])) ||
    !Number.isFinite(cfnIngressPortValue(rule['FromPort'])) ||
    !Number.isFinite(cfnIngressPortValue(rule['ToPort']))
  ) {
    return undefined;
  }
  return ingressRuleIdentity(group, rule);
}

/** A record's recorded `sgr-` rule id, when it has one. */
export function recordedSgRuleId(
  attributes: Readonly<Record<string, unknown>> | undefined
): string | undefined {
  const recorded = attributes?.['Id'];
  return typeof recorded === 'string' && SG_RULE_ID_PATTERN.test(recorded) ? recorded : undefined;
}

/**
 * go-to-k/cdkd#4492: a `SecurityGroupIngress` record in `records`, other than
 * `selfLogicalId`'s, recording `ruleId` as its rule — the rule is that
 * record's, whatever this one's stale record says.
 */
export function survivingRecordOfRuleId(
  records: Iterable<readonly [string, ResourceState]> | undefined,
  selfLogicalId: string,
  ruleId: string
): string | undefined {
  for (const [lid, record] of records ?? []) {
    if (lid === selfLogicalId || record.resourceType !== 'AWS::EC2::SecurityGroupIngress') continue;
    if (recordedSgRuleId(record.attributes) === ruleId) return lid;
  }
  return undefined;
}

/**
 * How a standalone holder's recorded `sgr-` id must relate to the rule:
 * - `live`: the id of the rule AWS holds (a create's duplicate). A holder
 *   recording an id counts only when it IS that id — not when the live id is
 *   unknown — or the live rule is not proven to be the one this stack made.
 * - `own`: the deleting record's own recorded id. When both record one they
 *   must be equal: a holder recording another rule does not hold this one,
 *   and deferring to it would leave this record's rule live with no record.
 */
type HolderRuleIdCheck = { live: string | undefined } | { own: string | undefined };

/** The record fields {@link stackIngressRuleHolder} reads (a `ResourceState` or a read-context sibling). */
type IngressHolderRecord = Pick<ResourceState, 'resourceType' | 'properties' | 'attributes'> & {
  physicalId?: string | undefined;
};

/**
 * go-to-k/cdkd#4492: a record in `records`, other than `selfLogicalId`'s, that
 * holds the ingress rule `rule` describes on `groupId`: an
 * `AWS::EC2::SecurityGroupIngress` record describing it (subject to
 * `idCheck`), or the `AWS::EC2::SecurityGroup` record of `groupId` declaring
 * it inline. An inline holder has no id to check: AWS mints no per-rule id a
 * group record keeps, and only the stack's OWN group (`physicalId === groupId`)
 * qualifies, so the rule is on a group this stack created.
 */
export function stackIngressRuleHolder(
  records: Iterable<readonly [string, IngressHolderRecord]> | undefined,
  selfLogicalId: string,
  groupId: string | undefined,
  rule: Record<string, unknown>,
  idCheck?: HolderRuleIdCheck
): string | undefined {
  if (records === undefined) return undefined;
  const wanted = comparableIngressIdentity(groupId, rule);
  if (wanted === undefined) return undefined;
  for (const [lid, record] of records) {
    if (lid === selfLogicalId) continue;
    const props = record.properties;
    if (record.resourceType === 'AWS::EC2::SecurityGroupIngress') {
      if (!isPlainRecord(props) || comparableIngressIdentity(props['GroupId'], props) !== wanted) {
        continue;
      }
      const ruleId = recordedSgRuleId(record.attributes);
      if (ruleId !== undefined && idCheck !== undefined) {
        if ('live' in idCheck && ruleId !== idCheck.live) continue;
        if ('own' in idCheck && idCheck.own !== undefined && ruleId !== idCheck.own) continue;
      }
      return lid;
    }
    if (record.resourceType === 'AWS::EC2::SecurityGroup' && record.physicalId === groupId) {
      const inline = isPlainRecord(props) ? props['SecurityGroupIngress'] : undefined;
      if (
        Array.isArray(inline) &&
        inline.some((entry) => comparableIngressIdentity(groupId, entry) === wanted)
      ) {
        return lid;
      }
    }
  }
  return undefined;
}

/**
 * Do two CFn `[{Key, Value}]` tag lists hold the same pairs, in any order? A
 * malformed entry on either side makes them differ.
 */
export function tagListsMatch(
  live: ReadonlyArray<unknown>,
  declared: ReadonlyArray<unknown>
): boolean {
  const pairs = (list: ReadonlyArray<unknown>): string[] | undefined =>
    list.every((entry) => isPlainRecord(entry) && typeof entry['Key'] === 'string')
      ? list
          .map((entry) => {
            const tag = entry as Record<string, unknown>;
            return JSON.stringify([tag['Key'], tag['Value'] ?? '']);
          })
          .sort()
      : undefined;
  const a = pairs(live);
  const b = pairs(declared);
  return a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A rule description for comparison: absent and empty are the same. */
export function descriptionKey(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Re-sends `sendAuthorizeIngress` makes on a resendable socket failure, and the
 * base of its linear backoff. Small and bounded: a blip, not an outage.
 */
export const AUTHORIZE_SOCKET_RESENDS = 2;
export const AUTHORIZE_SOCKET_RESEND_DELAY_MS = 500;

/**
 * Node socket codes raised when the connection was never established, so the
 * request never reached AWS (the set `retryable-errors/transient.ts` keeps out of its
 * ambiguous codes for that reason), plus `EAI_AGAIN` (DNS lookup failed).
 */
const NEVER_CONNECTED_SOCKET_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
]);

/**
 * Socket failures that can follow a WRITTEN request (the service may have
 * acted), which the SDK would re-send and `sendAuthorizeIngress` re-sends.
 */
const RESENDABLE_SOCKET_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'EADDRNOTAVAIL',
]);

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

/**
 * The SDK's CONNECT timeout (`@smithy/node-http-handler`: a `TimeoutError` with
 * no `code`, "the request socket did not establish a connection"): no request
 * was written. Every other `TimeoutError` (a request or socket-inactivity
 * timeout, or one carrying `ETIMEDOUT`) may follow a written request.
 */
export function isConnectTimeout(error: unknown): boolean {
  const e = error as { name?: unknown; code?: unknown; message?: unknown } | null;
  return (
    e?.name === 'TimeoutError' &&
    e.code === undefined &&
    typeof e.message === 'string' &&
    e.message.includes('did not establish a connection')
  );
}

/** A failure whose request provably never reached AWS (go-to-k/cdkd#4355). */
function neverReachedAws(error: unknown): boolean {
  if (isConnectTimeout(error)) return true;
  const code = errorCode(error);
  if (typeof code === 'string' && NEVER_CONNECTED_SOCKET_CODES.has(code)) return true;
  // No credentials (an expired SSO session): the request was never signed.
  return (error as { name?: unknown } | null)?.name === 'CredentialsProviderError';
}

/**
 * A socket failure after which the request may have been written, which
 * `sendAuthorizeIngress` re-sends (go-to-k/cdkd#4355). A connect timeout is
 * re-sent too but is NOT this: see {@link isConnectTimeout}.
 */
export function isResendableSocketFailure(error: unknown): boolean {
  if (isConnectTimeout(error)) return false;
  const code = errorCode(error);
  if (typeof code === 'string' && RESENDABLE_SOCKET_CODES.has(code)) return true;
  return (error as { name?: unknown } | null)?.name === 'TimeoutError';
}

/**
 * Whether a failed `AuthorizeSecurityGroupIngress` send PROVABLY applied
 * nothing (go-to-k/cdkd#4355): a 4xx, an identified throttle, or a request
 * that never reached AWS (a connection never established, no credentials). Anything
 * unclassified — a 5xx, a socket error, no `$metadata` — may have landed,
 * which is deliberately not `isAmbiguousOutcomeError`'s default: there an
 * unknown shape reads as "not ambiguous", here it must keep the bag.
 *
 * Per SEND: the Authorize goes through `ec2SingleSend` (no SDK retries), so the
 * error describes the one send it answers. An SDK-internal retry would hide
 * whether an earlier send was throttled (nothing applied) or ambiguous.
 */
export function authorizeDefinitelyNotApplied(error: unknown): boolean {
  if (neverReachedAws(error)) return true;
  const e = error as {
    name?: unknown;
    $retryable?: { throttling?: unknown };
    $metadata?: { httpStatusCode?: unknown };
  } | null;
  // A throttle IDENTIFIED as one (its name, or the SDK's flag) — never by a
  // bare 503, which `isThrottlingError` also counts but which can be a server
  // error after the request was applied.
  if (typeof e?.name === 'string' && THROTTLING_ERROR_NAMES.has(e.name)) return true;
  if (e?.$retryable?.throttling === true) return true;
  const status = e?.$metadata?.httpStatusCode;
  return typeof status === 'number' && status >= 400 && status < 500;
}

/**
 * The single `sgr-...` id an `AuthorizeSecurityGroupIngress` response reports
 * for a standalone `AWS::EC2::SecurityGroupIngress` (issue #1761).
 *
 * Pure by design: {@link EC2Provider.createSecurityGroupIngress} calls it
 * between the mutating Authorize and its return, where an `await` of anything
 * that can throw would re-create the issue #1710 orphan class.
 *
 * `undefined` unless the response carries EXACTLY ONE rule id. AWS mints one
 * rule per source entry, and cdkd sends one `IpPermission` per CFn resource —
 * but a template declaring both `CidrIp` and `CidrIpv6` on the same ingress
 * resource makes `buildIpPermission` emit two sources and AWS answers with two
 * rules. Neither is "the" CloudFormation identifier for the resource, so
 * recording nothing (and letting `cdkd export` refuse with its own message) is
 * the only answer that cannot silently name the wrong rule.
 */
export function singleSecurityGroupRuleId(
  rules: SecurityGroupRule[] | undefined
): string | undefined {
  const ids = (rules ?? [])
    .map((rule) => rule.SecurityGroupRuleId)
    .filter((id): id is string => typeof id === 'string' && id.trim() !== '');
  return ids.length === 1 ? ids[0] : undefined;
}

/**
 * A CFn `FromPort` / `ToPort` in the NUMBER form `DescribeSecurityGroupRules`
 * reports, for {@link securityGroupRuleMatchesCfnIngress}'s compare.
 *
 * An identity compare against `properties['FromPort'] as number` was wrong for
 * the same reason issue #1513 documents one property over: a YAML / JSON
 * template may spell a port as the STRING `"443"`, and `buildIpPermission`
 * passes it through to AWS unchanged, so such a rule deploys fine and would
 * then never match its own AWS-side row.
 *
 * Absent, `null`, and blank (INCLUDING whitespace-only) are AWS's `-1`, "all
 * ports". Everything that is not a number or a numeric string is `NaN`, which
 * compares unequal to everything — so the lookup records nothing rather than
 * matching some unrelated rule.
 *
 * A bare `Number(value)` was NOT enough for that last sentence, which an earlier
 * cut of this function claimed anyway: `Number` maps `' '` and `[]` to `0`,
 * `true` to `1`, and `['443']` to `443`. A whitespace-only port would then have
 * matched an ICMP **type-0** rule — a different rule, silently recorded — which
 * is the exact outcome the claim promised it could not produce.
 */
export function cfnIngressPortValue(value: unknown): number {
  if (value === undefined || value === null) return -1;
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return -1;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  // Booleans, arrays, objects: not a port in any spelling AWS or CFn accepts.
  return Number.NaN;
}

/**
 * Does a `DescribeSecurityGroupRules` rule describe the same ingress rule the
 * given CFn `AWS::EC2::SecurityGroupIngress` properties ask for?
 *
 * Deliberately NOT expressed via {@link sgRuleKey}: that key includes
 * `SourceSecurityGroupOwnerId` and `Description`, both of which AWS fills in on
 * the read side even when the template omits them, so a whole-key compare
 * would report "no match" for the ordinary same-account SG-to-SG rule this
 * lookup exists to find. Matching the fields the template actually pins —
 * protocol, port range, and whichever ONE source key it declares — is what
 * makes the comparison decidable from a partial template.
 *
 * The protocol goes through {@link sgProtocolKey} on BOTH sides, not a raw
 * compare: AWS substitutes the canonical NAME for the four protocols that have
 * one, so a template declaring `IpProtocol: 6` (or `'6'`) is read back as
 * `'tcp'` and would otherwise match nothing (the issue #1643 fold, one call site
 * further along).
 *
 * Ports are compared with AWS's own `-1` ("all") spelling on both sides, since
 * an omitted `FromPort` / `ToPort` reads back as `-1`, and the template side is
 * NUMERICALLY coerced — see {@link cfnIngressPortValue}.
 */
export function securityGroupRuleMatchesCfnIngress(
  rule: SecurityGroupRule,
  properties: Record<string, unknown>
): boolean {
  if (sgProtocolKey(rule.IpProtocol) !== sgProtocolKey(properties['IpProtocol'])) return false;
  if ((rule.FromPort ?? -1) !== cfnIngressPortValue(properties['FromPort'])) return false;
  if ((rule.ToPort ?? -1) !== cfnIngressPortValue(properties['ToPort'])) return false;

  // One source key per CFn ingress resource. When the template declares none
  // (legal — an all-sources rule is rejected by AWS, so this is the degenerate
  // case), protocol + ports alone decide, and the caller's "exactly one match"
  // rule still refuses an ambiguous answer.
  const sources: Array<[unknown, unknown]> = [
    [properties['CidrIp'], rule.CidrIpv4],
    [properties['CidrIpv6'], rule.CidrIpv6],
    [properties['SourceSecurityGroupId'], rule.ReferencedGroupInfo?.GroupId],
    [properties['SourcePrefixListId'], rule.PrefixListId],
  ];
  for (const [declared, actual] of sources) {
    if (declared !== undefined && declared !== null && declared !== actual) return false;
  }
  return true;
}

export function sgRuleKey(rule: CfnSgRule, direction: SgDirection): string {
  const peerKey =
    direction === 'egress' ? rule['DestinationSecurityGroupId'] : rule['SourceSecurityGroupId'];
  const prefixKey =
    direction === 'egress' ? rule['DestinationPrefixListId'] : rule['SourcePrefixListId'];
  const peerOwner = direction === 'ingress' ? rule['SourceSecurityGroupOwnerId'] : undefined;
  return JSON.stringify({
    // STRINGIFIED so a record written BEFORE issue #1633 still matches. AWS
    // always reports the protocol as a string, so a legacy record holding the
    // NUMBER `-1` keyed as `{"p":-1}` against AWS's `{"p":"-1"}` and matched
    // nothing — `readSecurityGroupIngressCurrentState` returned `undefined`
    // and `cdkd drift` reported the rule as gone, forever. The canonicalizer
    // makes such a record's diff NO_CHANGE, so no deploy ever rewrites it
    // either; normalizing at the KEY is what heals the existing population
    // with no migration.
    p: sgProtocolKey(rule['IpProtocol']),
    f: rule['FromPort'] ?? null,
    t: rule['ToPort'] ?? null,
    c4: rule['CidrIp'] ?? null,
    c6: rule['CidrIpv6'] ?? null,
    peer: peerKey ?? null,
    peerOwner: peerOwner ?? null,
    pl: prefixKey ?? null,
    d: rule['Description'] ?? null,
  });
}

/**
 * Reorder AWS-returned rules to match state's templated order so the
 * drift comparator's positional array compare doesn't fire false drift
 * on AWS's normalized order.
 *
 * For each state rule, find a matching AWS rule by `sgRuleKey`. Output
 * matched rules in state's order; any AWS rules without a state match
 * (console-side adds, or rules state has but AWS doesn't) go at the end
 * preserving AWS's original order.
 *
 * If state didn't template rules at all, returns AWS rules unchanged.
 */
export function reconcileSgRules(
  awsRules: CfnSgRule[],
  stateRules: Array<Record<string, unknown>> | undefined,
  direction: SgDirection
): CfnSgRule[] {
  if (!stateRules || stateRules.length === 0) return awsRules;

  const remaining = [...awsRules];
  const reordered: CfnSgRule[] = [];
  for (const sr of stateRules) {
    const key = sgRuleKey(sr, direction);
    const idx = remaining.findIndex((ar) => sgRuleKey(ar, direction) === key);
    if (idx >= 0) {
      reordered.push(remaining.splice(idx, 1)[0]!);
    }
  }
  return [...reordered, ...remaining];
}

/**
 * Detect AWS's auto-attached "allow-all egress" rule that is created
 * with the SecurityGroup when the user does not template
 * `SecurityGroupEgress`. Filter signature is intentionally narrow — only
 * the exact AWS-default tuple (`-1` protocol, `0.0.0.0/0` CIDR, no
 * description, no per-rule ports). A user-defined rule that happens to
 * match the same tuple wouldn't be filtered if state templates egress
 * (the caller checks `stateEgress === undefined` before invoking).
 */
export function isDefaultEgressRule(rule: CfnSgRule): boolean {
  if (rule['IpProtocol'] !== '-1') return false;
  if (rule['CidrIp'] !== '0.0.0.0/0') return false;
  if (rule['CidrIpv6'] !== undefined) return false;
  if (rule['DestinationSecurityGroupId'] !== undefined) return false;
  if (rule['DestinationPrefixListId'] !== undefined) return false;
  if (rule['Description'] !== undefined) return false;
  // FromPort / ToPort: AWS returns them as -1 for the all-protocols
  // default, but some legacy responses omit them. Accept both.
  if (rule['FromPort'] !== undefined && rule['FromPort'] !== -1) return false;
  if (rule['ToPort'] !== undefined && rule['ToPort'] !== -1) return false;
  return true;
}
