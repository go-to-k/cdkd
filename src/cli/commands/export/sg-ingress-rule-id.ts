import {
  DescribeSecurityGroupRulesCommand,
  type DescribeSecurityGroupRulesResult,
  type EC2Client,
  type SecurityGroupRule,
} from '@aws-sdk/client-ec2';
import { getLogger } from '../../../utils/logger.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { canonicalizeIpProtocolValue } from '../../../utils/ip-protocol.js';
import { withRetry } from '../../../deployment/retry.js';
import { isThrottlingError } from '../../../deployment/retryable-errors.js';
import {
  type CompositePhysicalIdContext,
  type CompositePhysicalIdIdentifier,
  type IdentifierBackfillDeps,
} from './composite-physical-id.js';
import { quotedOrNotShown, showRecordValue } from './render.js';

/**
 * The `sgr-…` shape, anchored. Shape-only — the hex body's LENGTH is not
 * pinned, because this exists to tell the identifier apart from the two other
 * strings that can sit in the same state row, not to validate an id AWS itself
 * minted:
 *
 *  - cdkd's own composite physicalId, which starts `sg-` (the parent group) and
 *    carries `|` separators; and
 *  - a bare `sg-…` group id, which a hand-edited row could put under
 *    `attributes.Id`.
 *
 * Anchoring is what does the discriminating: `^sgr-[0-9a-f]+$` cannot match
 * either, because `|` and the composite's trailing segments have nowhere to go.
 * A bare `startsWith('sgr-')` would accept `sgr-abc|tcp|443|443`.
 *
 * Measured live (us-east-1, 2026-08-14) from a CloudFormation stack carrying a
 * standalone ingress rule: `PhysicalResourceId` = `sgr-02345615af6d2db0d`, and
 * both `Ref` and `Fn::GetAtt .Id` return that same value.
 */
const SG_RULE_ID_PATTERN = /^sgr-[0-9a-f]+$/;

/**
 * The {@link CompositePhysicalIdIdentifier} for `AWS::EC2::SecurityGroupIngress`.
 *
 * The `recordedArnIdentifier` sibling of the family, differing only in that the
 * identifier is an `sgr-` rule id rather than an ARN — so it gets its own
 * builder rather than an `isUsable` callback threaded through that one, which
 * would make the ARN family's every message ("which is not a <service> ARN",
 * "so cdkd records <field>") conditional on a shape it no longer owns.
 *
 * Two accepted sources, validated by the SAME predicate — the point #1771
 * made about the EIP splitter's segment binding applies here verbatim:
 * validating one side is not a discriminator.
 *
 * 1. `attributes.Id`, which every writer produces today — a fresh deploy, a
 *    `cdkd import --resource <logicalId>=sgr-…`, and the recursive
 *    `--migrate-from-cloudformation` walk (which hands CFn's
 *    `PhysicalResourceId` to `EC2Provider.import` as `knownPhysicalId`, and
 *    that value IS the `sgr-` id — measured above).
 * 2. A physicalId that is ALREADY the bare rule id. **No cdkd path writes this
 *    shape today** — unlike `AWS::S3Tables::Table`, whose Cloud-Control import
 *    genuinely records the bare ARN — so it is accepted defensively rather than
 *    because it is live: CFn's `PhysicalResourceId` for the type is exactly
 *    this string, so a row hand-repaired from a CFn console listing, or written
 *    by some future Cloud-Control routing of the type, carries an unambiguous
 *    identifier that it would be perverse to refuse. Such a row is separately
 *    BROKEN for `cdkd destroy` (`deleteSecurityGroupIngress` needs the 4-part
 *    tuple), which is another reason to let the export hand it to CFn rather
 *    than strand it.
 */
export function recordedRuleIdIdentifier(): CompositePhysicalIdIdentifier {
  const isUsableIdentifier = (value: string): boolean => SG_RULE_ID_PATTERN.test(value.trim());

  return {
    field: 'Id',
    backfill: backfillSecurityGroupIngressRuleId,
    resolve: ({ logicalId, physicalId, attributes }) => {
      // Trimmed on RETURN as well as in the guard, matching the ARN family: a
      // padded value is otherwise shipped with the whitespace and CFn rejects
      // the identifier verbatim.
      const recorded = attributes['Id'];
      if (typeof recorded === 'string' && isUsableIdentifier(recorded)) {
        return recorded.trim();
      }
      if (isUsableIdentifier(physicalId)) {
        return physicalId.trim();
      }
      const recordedNote =
        typeof recorded === 'string' && recorded.trim()
          ? `attributes.Id is recorded as ${showRecordValue(recorded)}, which is not an 'sgr-…' ` +
            `security-group rule id`
          : `attributes.Id is missing or empty`;
      throw new Error(
        `cdkd's physical id for AWS::EC2::SecurityGroupIngress is the composite ` +
          `'<groupId>|<ipProtocol>|<fromPort>|<toPort>', but CloudFormation IMPORT identifies ` +
          `the rule by the 'sgr-...' security-group rule id AWS assigns, which cdkd state does ` +
          `not record usably for ${quotedOrNotShown(logicalId)} (${recordedNote}). Two causes, with different ` +
          `remedies. (1) The rule declares MORE THAN ONE source — e.g. both CidrIp and CidrIpv6 ` +
          `on the same resource — so AWS minted one rule per source and cdkd deliberately ` +
          `recorded neither id, because neither is 'the' identifier for this resource. ` +
          `Re-deploying does not help; split it into one AWS::EC2::SecurityGroupIngress ` +
          `resource per source, which is also the shape CloudFormation will manage after the ` +
          `export. (2) Otherwise the rule was deployed by a cdkd older than ` +
          `https://github.com/go-to-k/cdkd/issues/1761, which did not record the id at all. AWS ` +
          `returns it only from AuthorizeSecurityGroupIngress itself, so a no-op re-deploy will ` +
          `NOT heal the record either: change any property of the rule (cdkd revokes and ` +
          `re-authorizes, minting a fresh id, with a momentary traffic interruption) or destroy ` +
          `and re-deploy it, then re-run cdkd export. In both cases you can instead remove ` +
          `${quotedOrNotShown(logicalId)} from the stack before exporting — the rule stays in AWS and can be ` +
          `re-declared in CloudFormation afterwards.`
      );
    },
  };
}

/**
 * Page ceiling for the {@link backfillSecurityGroupIngressRuleId} walk, and its
 * `MaxResults`. The twins of `MAX_SG_RULE_PAGES` / `SG_RULE_PAGE_SIZE` in
 * `src/provisioning/providers/ec2-provider.ts`, restated here for the same
 * reason {@link SG_RULE_ID_PATTERN} is: neither module may pull the other's
 * graph.
 *
 * 20 pages x 1000 rules covers 20,000 rules on ONE security group, far beyond
 * any real one (AWS's default quota is 60 rules per SG, 1000 at the maximum
 * increase). That arithmetic only holds because the request pins `MaxResults` —
 * without it AWS applies its own page size and the bound would cap an unknown
 * number of rules. Exhausting it is treated as "could not see the whole group",
 * which is a REFUSAL here rather than the provider's silent `undefined`: the
 * uniqueness verdict below is a statement about the whole group, so answering
 * from a partial view is exactly how a genuine 2-match becomes a false
 * "exactly one".
 */
const MAX_SG_RULE_PAGES = 20;
const SG_RULE_PAGE_SIZE = 1000;

/**
 * The `(protocol, fromPort, toPort)` triple cdkd's composite physical id
 * carries for an `AWS::EC2::SecurityGroupIngress`, plus the group it lives on.
 */
interface SecurityGroupIngressTuple {
  readonly groupId: string;
  readonly ipProtocol: string;
  readonly fromPort: number;
  readonly toPort: number;
}

/**
 * Parse cdkd's `<groupId>|<ipProtocol>|<fromPort>|<toPort>` physical id, or
 * `undefined` when it is not that shape.
 *
 * EXACTLY four segments, all non-blank. A longer id is the issue
 * [#1672](https://github.com/go-to-k/cdkd/issues/1672) ambiguity — a segment
 * carrying the separator — and decoding its first four parts would silently
 * look up a DIFFERENT rule's tuple, so it is refused like any other unparseable
 * shape.
 *
 * The ports are the `'-1'` AWS itself uses for "all ports", which is what
 * `EC2Provider` packs when the template declares no `FromPort` / `ToPort`; a
 * segment that is not a finite number yields `undefined` rather than `NaN`, so
 * a malformed id refuses instead of matching nothing and blaming AWS.
 *
 * A BLANK port segment is refused EXPLICITLY, before `Number()` ever sees it,
 * because `Number('')` is `0` rather than `NaN` — so `sg-x|tcp||443` would
 * otherwise parse to `fromPort: 0` and go and look up a REAL tuple (ICMP type
 * 0 is echo reply, a live rule shape), adopting an id for a rule the record
 * does not name. That is also why the blank is not simply folded to `-1`: this
 * module and `EC2Provider.cfnIngressPortValue` disagree about what a blank
 * MEANS — the provider reads it as `-1` (all ports) because its input is a CFn
 * property the template legitimately omits, while here it is a SEGMENT of an
 * id cdkd itself wrote, and cdkd never writes an empty one. A blank segment is
 * therefore evidence the id is damaged, not evidence of an absent port.
 */
function parseSecurityGroupIngressComposite(
  physicalId: string
): SecurityGroupIngressTuple | undefined {
  const parts = physicalId.trim().split('|');
  if (parts.length !== 4) return undefined;
  const [groupId, ipProtocol, fromPort, toPort] = parts as [string, string, string, string];
  if (!groupId.trim() || !ipProtocol.trim()) return undefined;
  const fromRaw = fromPort.trim();
  const toRaw = toPort.trim();
  if (!fromRaw || !toRaw) return undefined;
  const from = Number(fromRaw);
  const to = Number(toRaw);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return undefined;
  return { groupId: groupId.trim(), ipProtocol: ipProtocol.trim(), fromPort: from, toPort: to };
}

/**
 * Does this `DescribeSecurityGroupRules` row describe the rule cdkd's composite
 * physical id names?
 *
 * The protocol goes through {@link canonicalizeIpProtocolValue} on BOTH sides
 * rather than a raw compare: EC2 rewrites the four protocol numbers it has a
 * name for before storing the rule, so a record packed from `IpProtocol: 6`
 * carries `'6'` while the readback says `'tcp'` and a raw compare would match
 * nothing (the issue #1643 fold, at a fourth call site).
 *
 * An omitted port reads back as `-1`, which is the same spelling the composite
 * carries for an absent one — so the two sides are directly comparable.
 */
function ruleMatchesIngressTuple(
  rule: SecurityGroupRule,
  tuple: SecurityGroupIngressTuple
): boolean {
  // `=== true`, not `!== false`: an ABSENT `IsEgress` counts as ingress. That
  // asymmetry is deliberate and matches `EC2Provider.lookupIngressRuleId` —
  // tightening it to `=== false` would make every rule AWS ever reports
  // without the field unmatchable, turning a healable row into a permanent
  // "found NO ingress rule" refusal. AWS populates the field today; the
  // looser test costs nothing while it does, and keeps healing working if it
  // ever stops.
  if (rule.IsEgress === true) return false;
  if (
    canonicalizeIpProtocolValue(rule.IpProtocol) !== canonicalizeIpProtocolValue(tuple.ipProtocol)
  )
    return false;
  if ((rule.FromPort ?? -1) !== tuple.fromPort) return false;
  if ((rule.ToPort ?? -1) !== tuple.toPort) return false;
  return true;
}

/**
 * Outcome of ONE security group's paginated `DescribeSecurityGroupRules` walk.
 *
 * Carries NO row identity on purpose: it is what the per-group memo stores, so
 * a second row on the same group must be able to build its own refusal from
 * it. A cached `Error` would name whichever row happened to walk first.
 */
export type SecurityGroupRuleLookup =
  | { readonly ok: true; readonly rules: SecurityGroupRule[] }
  | {
      readonly ok: false;
      /**
       * The walk was still paginating at the page ceiling. Carries NO
       * `detail`, unlike the failure kinds below: there is no AWS error text
       * to quote, and the only other thing this arm could carry — the group
       * id — is one the caller already holds on its own tuple. A copy here
       * would be a second place for it to go stale and a field the message
       * never reads.
       */
      readonly kind: 'truncated';
    }
  | {
      readonly ok: false;
      /** Which remedy the caller's message should prescribe. */
      readonly kind: 'auth' | 'throttled' | 'failed';
      /** The AWS failure text, quoted verbatim into the caller's refusal. */
      readonly detail: string;
    };

/**
 * Test seam: overriding `sleep` lets unit tests drive the throttle backoff
 * without real waits. Mirrors `describeTypeRetryDelays` in
 * `src/provisioning/describe-type.ts`, which this retry is modeled on.
 */
export const securityGroupRuleLookupRetryDelays: { sleep?: (ms: number) => Promise<void> } = {};

/**
 * Retries after the first attempt, THROTTLE-shaped failures only. At the
 * default backoff (1s -> 2s -> 4s -> 8s) this adds at most ~15s of sleep,
 * which is small next to what it prevents: `cdkd export` is all-or-nothing, so
 * one `RequestLimitExceeded` — the commonest EC2 Describe failure there is —
 * would otherwise abort the WHOLE run. A non-throttle failure (a missing
 * `ec2:DescribeSecurityGroupRules` being the important one) is surfaced
 * immediately, since it cannot heal by waiting.
 */
const MAX_SG_RULE_THROTTLE_RETRIES = 4;

/**
 * Does this failure say the CALLER lacks permission, as opposed to anything
 * else AWS can fail with?
 *
 * Only these get the "Grant ec2:DescribeSecurityGroupRules" sentence. Sending
 * every failure to that remedy is how a throttle got reported as a permissions
 * problem: the user checks a policy that was correct all along, while the
 * actual advice ("re-run it") goes unsaid.
 */
function isAuthorizationShapedError(err: unknown): boolean {
  const errName = err instanceof Error ? err.name : '';
  const message = describeAwsFailure(err).detail;
  return /AccessDenied|UnauthorizedOperation|AuthFailure|not authorized to perform/i.test(
    `${errName} ${message}`
  );
}

/**
 * Walk EVERY ingress/egress rule AWS holds on one security group, retrying a
 * throttled page (issue [#1791](https://github.com/go-to-k/cdkd/issues/1791)
 * review).
 *
 * Returns the failure rather than throwing it, because the caller owns the
 * message: every refusal here names the cdkd ROW that could not be resolved,
 * and this function does not know which row (possibly rows, via the memo)
 * asked.
 */
async function describeAllSecurityGroupRules(
  groupId: string,
  ec2Client: EC2Client
): Promise<SecurityGroupRuleLookup> {
  const rules: SecurityGroupRule[] = [];
  let nextToken: string | undefined;
  let pages = 0;
  do {
    if (pages >= MAX_SG_RULE_PAGES) {
      return { ok: false, kind: 'truncated' };
    }
    let resp: DescribeSecurityGroupRulesResult;
    try {
      resp = await withRetry(
        () =>
          ec2Client.send(
            new DescribeSecurityGroupRulesCommand({
              Filters: [{ Name: 'group-id', Values: [groupId] }],
              MaxResults: SG_RULE_PAGE_SIZE,
              ...(nextToken && { NextToken: nextToken }),
            })
          ),
        `DescribeSecurityGroupRules(${showRecordValue(groupId)})`,
        {
          maxRetries: MAX_SG_RULE_THROTTLE_RETRIES,
          isRetryable: (_message, error) => isThrottlingError(error),
          logger: getLogger().child('Export'),
          ...(securityGroupRuleLookupRetryDelays.sleep
            ? { sleep: securityGroupRuleLookupRetryDelays.sleep }
            : {}),
        }
      );
    } catch (err) {
      const detail = describeAwsFailure(err).detail;
      const kind = isAuthorizationShapedError(err)
        ? 'auth'
        : isThrottlingError(err)
          ? 'throttled'
          : 'failed';
      return { ok: false, kind, detail };
    }
    rules.push(...(resp.SecurityGroupRules ?? []));
    nextToken = resp.NextToken;
    pages += 1;
  } while (nextToken);
  return { ok: true, rules };
}

/**
 * {@link describeAllSecurityGroupRules}, memoized per GROUP for the lifetime of
 * one {@link buildImportPlan} call — see
 * {@link IdentifierBackfillDeps.securityGroupRuleCache}.
 *
 * The PROMISE is cached, not its resolution, so rows resolved concurrently on
 * one group also share a single walk rather than racing to start their own.
 */
function cachedSecurityGroupRules(
  groupId: string,
  { ec2Client, securityGroupRuleCache }: IdentifierBackfillDeps
): Promise<SecurityGroupRuleLookup> {
  const cached = securityGroupRuleCache.get(groupId);
  if (cached) return cached;
  const pending = describeAllSecurityGroupRules(groupId, ec2Client);
  securityGroupRuleCache.set(groupId, pending);
  return pending;
}

/**
 * What to DO about a row more than one AWS rule matches — the part of the
 * refusal that is about the ambiguity itself rather than about how cdkd
 * noticed it.
 *
 * Written once because TWO arms below report a matched count above one: the
 * plain `> 1` refusal, and the unusable-id refusal (whose own remedy is "open
 * a cdkd issue" — right about the unreadable id, useless about the ambiguity).
 * A row that hits the second arm has BOTH problems, and before this was shared
 * it was the one row whose user never saw these two causes at all.
 *
 * Carries no row identity, so it can be appended to either message.
 */
const SG_INGRESS_AMBIGUITY_REMEDY =
  `Two causes, with different remedies. (1) ONE resource declaring MORE THAN ONE source (e.g. ` +
  `both CidrIp and CidrIpv6 on the same resource), for which AWS mints one rule per source: ` +
  `split it into one AWS::EC2::SecurityGroupIngress resource per source, which is also the ` +
  `shape CloudFormation will manage after the export. (2) TWO DISTINCT ` +
  `AWS::EC2::SecurityGroupIngress resources that differ only by SOURCE — port 443 from a CIDR ` +
  `and port 443 from a peer security group, say. cdkd's composite physical id carries no ` +
  `source, so those two rows carry byte-identical ids and splitting is not their remedy: set ` +
  `the row's attributes.Id to the 'sgr-...' id that belongs to it (cdkd then resolves from ` +
  `state and issues no lookup at all), or remove the row from the stack before exporting. Then ` +
  `re-run cdkd export.`;

/** The remedy every refusal below ends with — one place, so they cannot drift. */
function sgIngressExportEscapeHatch(logicalId: string): string {
  return (
    `You can instead remove ${quotedOrNotShown(logicalId)} from the stack before exporting — the rule stays in ` +
    `AWS and can be re-declared in CloudFormation afterwards.`
  );
}

/**
 * Live-read backfill of the `sgr-...` rule id for an
 * `AWS::EC2::SecurityGroupIngress` row that state does not carry one for
 * (issue [#1791](https://github.com/go-to-k/cdkd/issues/1791)).
 *
 * ## Why a live read at all
 *
 * Every row written by a cdkd older than issue #1761 has `attributes: {}`, and
 * `cdkd export` is ALL-OR-NOTHING — so ONE such row makes a whole stack
 * un-exportable. The obvious workaround does not exist: AWS returns the id only
 * from `AuthorizeSecurityGroupIngress`'s own response, so a no-op `cdkd deploy`
 * records nothing and the row is exactly as unexportable afterwards. Only a
 * re-authorization (a property change, or a destroy + deploy) heals it, which
 * is a traffic interruption to pay for a read cdkd can perform itself.
 *
 * ## Why the match is on the composite's tuple, and why EXACTLY ONE
 *
 * The row's identity, as far as cdkd state is concerned, IS
 * `<groupId>|<ipProtocol>|<fromPort>|<toPort>` — the tuple its own revoke call
 * needs. So the tuple is the most cdkd can filter on, and two AWS rules sharing
 * it are two rules cdkd's own physical id cannot tell apart either. Adopting
 * one of them would record an identifier that names the wrong AWS object, which
 * is the failure mode the #1761 already-exists arm's "exactly one" rule exists
 * to prevent — so ambiguity REFUSES, naming the candidates.
 *
 * The commonest ambiguity is the multi-source rule the state-only message
 * already describes: a resource declaring both `CidrIp` and `CidrIpv6` makes
 * AWS mint one rule PER SOURCE, both with this exact tuple. Splitting the
 * resource is the remedy in that case, and it is the same remedy CloudFormation
 * will want after the export. It is NOT the only cause, which is why the
 * refusal names two: TWO DISTINCT `AWS::EC2::SecurityGroupIngress` resources
 * differing only by source share one tuple as well — cdkd's composite carries
 * no source — and those are already one resource per source, so the remedy
 * there is to repair the row's `attributes.Id` (or drop the row) instead.
 *
 * Deliberately NOT narrowed by the recorded SOURCE (`CidrIp` and friends) even
 * though state carries it: {@link CompositePhysicalIdContext} does not carry
 * `properties`, and widening it to make ONE ambiguous case resolvable would
 * also make the export adopt a rule the physical id in state does not uniquely
 * name — a row that looks adopted while `cdkd destroy` would revoke a different
 * one. Refusing is the answer that keeps state and AWS agreeing.
 */
async function backfillSecurityGroupIngressRuleId(
  { logicalId, physicalId }: CompositePhysicalIdContext,
  deps: IdentifierBackfillDeps
): Promise<string> {
  const tuple = parseSecurityGroupIngressComposite(physicalId);
  if (!tuple) {
    throw new Error(
      `cdkd state records no 'sgr-...' security-group rule id for ${quotedOrNotShown(logicalId)}, and its ` +
        `physical id ${showRecordValue(physicalId)} is not cdkd's ` +
        `'<groupId>|<ipProtocol>|<fromPort>|<toPort>' composite either, so cdkd cannot look the ` +
        `rule up in AWS to recover the id CloudFormation IMPORT needs. Repair the record's ` +
        `physicalId (or its attributes.Id, which may be the 'sgr-...' id verbatim) and re-run ` +
        `cdkd export. ${sgIngressExportEscapeHatch(logicalId)}`
    );
  }

  const portRange =
    tuple.fromPort === tuple.toPort ? `${tuple.fromPort}` : `${tuple.fromPort}-${tuple.toPort}`;
  const tupleNote = `protocol ${showRecordValue(tuple.ipProtocol)}, ports ${portRange} on security group ${showRecordValue(tuple.groupId)}`;

  const lookup = await cachedSecurityGroupRules(tuple.groupId, deps);
  if (!lookup.ok) {
    if (lookup.kind === 'truncated') {
      throw new Error(
        `cdkd state records no 'sgr-...' security-group rule id for ${quotedOrNotShown(logicalId)}, and the ` +
          `DescribeSecurityGroupRules lookup on ${showRecordValue(tuple.groupId)} was still paginating after ` +
          `${MAX_SG_RULE_PAGES} pages — cdkd cannot prove a match is unique without seeing the ` +
          `whole group, and adopting an unproven id would name the wrong rule. ` +
          `${sgIngressExportEscapeHatch(logicalId)}`
      );
    }
    // One remedy per CAUSE. "Grant the permission" is right for exactly one of
    // these three, and saying it for a throttle sends the user to audit a
    // policy that was never the problem.
    const remedy =
      lookup.kind === 'auth'
        ? `Grant ec2:DescribeSecurityGroupRules and re-run cdkd export.`
        : lookup.kind === 'throttled'
          ? `AWS throttled the lookup and cdkd retried it ${MAX_SG_RULE_THROTTLE_RETRIES} times ` +
            `before giving up — no permission is missing. Re-run cdkd export once the account's ` +
            `EC2 describe rate has recovered.`
          : `Re-run cdkd export once that cause is resolved.`;
    throw new Error(
      `cdkd state records no 'sgr-...' security-group rule id for ${quotedOrNotShown(logicalId)} (the rule was ` +
        `deployed by a cdkd older than https://github.com/go-to-k/cdkd/issues/1761), and the ` +
        `DescribeSecurityGroupRules lookup that would have recovered it failed: ` +
        `${lookup.detail}. ${remedy} ${sgIngressExportEscapeHatch(logicalId)}`
    );
  }

  // The MATCHES are counted BEFORE any is discarded for carrying an unusable
  // id, because "exactly one" is a claim about how many rules match — not
  // about how many usable ids survived a filter. Folding the two together
  // collapses a genuine 2-match whose other candidate AWS reported without an
  // id into `length === 1` and adopts the survivor, which is precisely the
  // wrong-rule adoption this discipline exists to prevent (and it made the
  // zero case report "found NO ingress rule matching <tuple>" when rules did
  // in fact match).
  const matched = lookup.rules.filter((rule) => ruleMatchesIngressTuple(rule, tuple));
  const ids = matched
    .map((rule) => rule.SecurityGroupRuleId)
    .filter((id): id is string => typeof id === 'string' && SG_RULE_ID_PATTERN.test(id.trim()))
    .map((id) => id.trim());

  // No `matched.length > 0 &&` guard: `ids` is derived from `matched` by a
  // filter, so an empty `matched` gives an empty `ids` and `0 < 0` is already
  // false. The conjunct could not change the answer, and a reader who found it
  // there would reasonably assume it could.
  if (ids.length < matched.length) {
    const unusable = matched
      .filter(
        (rule) =>
          !(
            typeof rule.SecurityGroupRuleId === 'string' &&
            SG_RULE_ID_PATTERN.test(rule.SecurityGroupRuleId.trim())
          )
      )
      .map((rule) =>
        typeof rule.SecurityGroupRuleId === 'string'
          ? `${quotedOrNotShown(rule.SecurityGroupRuleId)}`
          : '<absent>'
      );
    // A matched count above one means this row is ALSO the genuine ambiguity
    // case, and the unreadable id is then the lesser of its two problems: even
    // if AWS had reported every id, cdkd still could not say which rule the row
    // is. Without this the user gets "open a cdkd issue" and never sees the
    // remedy they can actually act on, because that remedy lives only in the
    // `> 1` message this branch pre-empts.
    // The remedy tells the user to set `attributes.Id` to the id that belongs
    // to this row, so name the ids cdkd COULD read — otherwise it asks them to
    // pick a value it saw and withheld.
    const readableNote =
      ids.length > 0
        ? ` The readable candidates cdkd did see: ${ids.map((id) => `${quotedOrNotShown(id)}`).join(', ')}.`
        : '';
    const ambiguityNote =
      matched.length > 1
        ? ` Note that ${matched.length} rules matching one row is an ambiguity in its own ` +
          `right, which cdkd could not resolve even if every id were readable: ` +
          `${SG_INGRESS_AMBIGUITY_REMEDY}${readableNote}`
        : '';
    throw new Error(
      `cdkd state records no 'sgr-...' security-group rule id for ${quotedOrNotShown(logicalId)}, and a live ` +
        `DescribeSecurityGroupRules lookup found ${matched.length} ingress rule(s) matching ` +
        `${tupleNote}, but ${unusable.length} of them carry no usable 'sgr-...' rule id (AWS ` +
        `reported ${unusable.join(', ')}). cdkd adopts an id only on an EXACTLY ONE match, and ` +
        `that is a count of MATCHING RULES — so discarding the unreadable ones first would let ` +
        `a genuine two-match pass as "exactly one" and record an identifier naming the wrong ` +
        `rule. cdkd refuses instead. This is a DescribeSecurityGroupRules response shape cdkd ` +
        `does not expect; please open a cdkd issue if it persists.${ambiguityNote} ` +
        `${sgIngressExportEscapeHatch(logicalId)}`
    );
  }

  if (ids.length === 1) return ids[0]!;

  if (ids.length === 0) {
    throw new Error(
      `cdkd state records no 'sgr-...' security-group rule id for ${quotedOrNotShown(logicalId)} (the rule was ` +
        `deployed by a cdkd older than https://github.com/go-to-k/cdkd/issues/1761), and a live ` +
        `DescribeSecurityGroupRules lookup found NO ingress rule matching ${tupleNote} — so ` +
        `cdkd has no id to hand CloudFormation IMPORT. Either the rule was revoked outside cdkd, ` +
        `or the group lives in a region other than the one this export is running against. Run ` +
        `cdkd deploy to reconcile the stack, then re-run cdkd export. ` +
        `${sgIngressExportEscapeHatch(logicalId)}`
    );
  }

  throw new Error(
    `cdkd state records no 'sgr-...' security-group rule id for ${quotedOrNotShown(logicalId)}, and a live ` +
      `DescribeSecurityGroupRules lookup found ${ids.length} ingress rules matching ${tupleNote} ` +
      `(${ids.join(', ')}). cdkd's physical id identifies a rule only by group, protocol and ` +
      `port range, so it cannot say which of them ${quotedOrNotShown(logicalId)} is, and CloudFormation IMPORT ` +
      `needs exactly one — adopting either would record the wrong rule. ` +
      `${SG_INGRESS_AMBIGUITY_REMEDY} ${sgIngressExportEscapeHatch(logicalId)}`
  );
}
