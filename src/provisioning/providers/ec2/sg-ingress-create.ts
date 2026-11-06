import {
  AuthorizeSecurityGroupIngressCommand,
  type AuthorizeSecurityGroupIngressCommandInput,
  type AuthorizeSecurityGroupIngressCommandOutput,
  DescribeSecurityGroupRulesCommand,
  type DescribeSecurityGroupRulesResult,
  type SecurityGroupRule,
} from '@aws-sdk/client-ec2';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { packCompositeId } from '../../composite-id.js';
import { maskerOrIdentity, type MaskerFn } from '../../masked-retry-logger.js';
import type { ResourceCreateResult } from '../../../types/resource.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import {
  getPriorAttempts,
  markRefusedBeforeApplying,
} from '../../../deployment/prior-attempt-scope.js';
import { awaitInFlightSibling, getStackRecords } from '../../../deployment/stack-records-scope.js';
import {
  AUTHORIZE_SOCKET_RESENDS,
  AUTHORIZE_SOCKET_RESEND_DELAY_MS,
  MAX_SG_RULE_PAGES,
  SG_RULE_PAGE_SIZE,
  authorizeDefinitelyNotApplied,
  comparableIngressIdentity,
  ingressRuleIdentity,
  isConnectTimeout,
  isResendableSocketFailure,
  narrowIngressIpProtocol,
  singleSecurityGroupRuleId,
  stackIngressRuleHolder,
} from './sg-support.js';
import type { EC2Provider } from '../ec2-provider.js';

// ─── AWS::EC2::SecurityGroupIngress ───────────────────────────────

/**
 * @param onUnusableProtocol When supplied, a malformed `IpProtocol` WARNS and
 *   defaults instead of throwing. Passed by `updateSecurityGroupIngress`,
 *   which reaches this method as the re-create half of a delete-then-create
 *   replacement: by then `RevokeSecurityGroupIngress` has already committed,
 *   so a refusal would leave the rule deleted from AWS with the op failed —
 *   and on a rollback replay the value comes from a STATE record, which no
 *   template edit can fix. Absent (the plain CREATE dispatch) it throws.
 * @param replayingState A rollback replay, whose rule is one this stack
 *   recorded: an identical rule already on the group is adopted
 *   (go-to-k/cdkd#4355, {@link resolveDuplicateIngress}).
 * @param revokedRule Set by `updateSecurityGroupIngress`: the physical id of
 *   the previous rule it has just revoked, which a refusal names.
 * @param onIdLookedUp Called once the "already exists" arm has looked the
 *   rule id up, so a caller wanting the id does not walk the group again
 *   (go-to-k/cdkd#4484).
 */
export async function createSecurityGroupIngress(
  this: EC2Provider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  onUnusableProtocol?: (message: string) => void,
  maskSecrets?: MaskerFn,
  replayingState = false,
  revokedRule?: string,
  onIdLookedUp?: () => void
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating SecurityGroupIngress ${logicalId}`);

  const groupId = properties['GroupId'] as string;
  if (!groupId) {
    throw new ProvisioningError(
      `GroupId is required for SecurityGroupIngress ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  // Guarded HERE rather than in `buildIpPermission` (which re-reads the same
  // bag on this path): that helper is also reached from
  // `deleteSecurityGroupIngress` and from the REVOKE half of the inline-rule
  // update diff, both carrying STATE-borne rules, where a refusal would break
  // destroy and rollback. Refusing on the create path stops a malformed value
  // before the helper is ever reached. `coerceNumber` because an unquoted
  // YAML `IpProtocol: -1` is a NUMBER today and deploys fine (issue #1513).
  // `narrowIngressIpProtocol` wraps that guard and ALSO reports the bag that
  // describes what it resolved, so the engine can record the value actually
  // sent instead of the malformed / numeric one the template wrote (issue
  // #1633). The refusal / warn behavior is unchanged — the callback is
  // forwarded verbatim.
  const { ipProtocol, narrowed } = narrowIngressIpProtocol(properties, onUnusableProtocol);
  // Absent unless the resolved protocol differs from the declared one, which
  // is what keeps an ordinary rule's state record byte-identical.
  const effectiveProperties = narrowed === properties ? undefined : narrowed;
  const fromPort = properties['FromPort'] as number | undefined;
  const toPort = properties['ToPort'] as number | undefined;

  // Refuse a `|` in any segment BEFORE `AuthorizeSecurityGroupIngress` runs
  // (issue #1672). `GroupId` is an AWS-generated `sg-...` and the ports are
  // numbers, so the only segment cdkd's own guards would let through as an
  // arbitrary string is `IpProtocol` — `requireConfigString` accepts any
  // non-blank string. AWS itself would reject such a protocol, so this is
  // unverified defense-in-depth rather than a measured hazard; refusing here
  // rather than leaving it to AWS keeps the id from being recorded on the
  // "already exists" arm below. The downgrade reuses `onUnusableProtocol`,
  // which `updateSecurityGroupIngress` passes UNCONDITIONALLY: that path has
  // already REVOKED the rule, so a throw would leave it deleted from AWS with
  // no template-side remedy — the same constraint the protocol guard above
  // records.
  const physicalId = packCompositeId(
    resourceType,
    logicalId,
    [
      { name: 'groupId', value: groupId },
      { name: 'ipProtocol', value: ipProtocol },
      { name: 'fromPort', value: fromPort ?? '-1' },
      { name: 'toPort', value: toPort ?? '-1' },
    ],
    // Issue #2176: the masker goes through unconditionally, and the refusal
    // arm stays conditional. Threaded a round later than its 13 siblings
    // because this helper takes a CALLBACK rather than a context, so the
    // thread stopped one layer short of the dispatcher that holds one. The
    // UPDATE twin is threaded too (round 3): `.claude/rules/providers.md`
    // notes the update arm is the one a multi-destination bag actually
    // reaches, so closing only the create side would have left the reachable
    // half open.
    { maskSecrets, ...(onUnusableProtocol && { onRefusal: onUnusableProtocol }) }
  );

  // go-to-k/cdkd#4355: set once a send of THIS call failed ambiguously and
  // was re-sent below, so a Duplicate on the re-send may be that send's rule.
  let earlierSendAmbiguous = false;
  try {
    // One SDK send per call (go-to-k/cdkd#4355): each failure is classified
    // per send, the engine's retry repeats a throttle or a 5xx, and
    // `sendAuthorizeIngress` re-sends a socket error itself — neither the
    // single-send client nor the engine's retry would.
    const response = await this.sendAuthorizeIngress(
      logicalId,
      () => {
        earlierSendAmbiguous = true;
      },
      {
        GroupId: groupId,
        // Override the protocol with the GUARDED value. `buildIpPermission`
        // deliberately re-reads the raw bag (it is shared with the
        // state-borne delete / revoke paths), and its own `?? '-1'` only
        // rescues null/undefined — so without this override a warned-about
        // `''` / `{}` / `true` would reach AWS verbatim, fail the call, and
        // leave the rule revoked on the update path. That is the blocker this
        // guard exists to prevent, one level further along.
        IpPermissions: [{ ...this.buildIpPermission(properties), IpProtocol: ipProtocol }],
      }
    );

    // Issue #1761: the `sgr-...` rule id is read off the response the
    // MUTATING call itself returned — deliberately not from a follow-up
    // `DescribeSecurityGroupRules`. Adding an `await` between the Authorize
    // above and the return below re-creates the issue #1710 orphan class: a
    // throw there leaves the rule live on AWS while the failed CREATE
    // journals no physicalId, so nothing ever revokes it.
    // `singleSecurityGroupRuleId` is pure and cannot throw.
    const ruleId = singleSecurityGroupRuleId(response.SecurityGroupRules);

    this.logger.debug(`Successfully created SecurityGroupIngress ${logicalId}: ${physicalId}`);

    return {
      physicalId,
      // Recorded under `Id`, which is BOTH the type's CloudFormation
      // `primaryIdentifier` and its only `Fn::GetAtt` attribute name (live
      // `describe-type`, us-east-1, 2026-08-13: `primaryIdentifier` and
      // `readOnlyProperties` are both exactly `["/properties/Id"]`). cdkd's
      // physicalId for the type is the composite tuple its own revoke call
      // needs, which is NOT the CFn identifier — so without this attribute
      // `cdkd export` has nothing to resolve (issue #1761).
      attributes: ruleId ? { Id: ruleId } : {},
      ...(effectiveProperties && { effectiveProperties }),
    };
  } catch (error) {
    // An identical rule is already on the group. Adopted only when it is
    // this stack's own (go-to-k/cdkd#4355); otherwise the create refuses.
    if (error instanceof Error && error.message.includes('already exists')) {
      // The Authorize FAILED, so no response carries the rule id — but an
      // adopted rule is reported as provisioned and state is written from
      // it, so the id has to be looked up or `cdkd export` refuses exactly
      // the resources a re-run adopted (issue #1761). The refusal names it
      // too. Best-effort by construction: `lookupIngressRuleId` swallows its
      // own failures and returns `undefined`. Safe to `await` here in a way
      // the success arm is not — this path created nothing, so there is
      // nothing to orphan.
      const desired = { ...properties, IpProtocol: ipProtocol };
      const existingRuleId = await this.lookupIngressRuleId(logicalId, groupId, desired);
      onIdLookedUp?.();
      await this.resolveDuplicateIngress({
        logicalId,
        resourceType,
        groupId,
        desired,
        existingRuleId,
        replayingState,
        // An earlier send of THIS write may have authorized the rule: an
        // earlier engine retry of this dispatch failed without a definite
        // answer. (Each send is classified on its own: `ec2SingleSend`.)
        ownAttemptMayHaveLanded:
          earlierSendAmbiguous || getPriorAttempts(logicalId)?.possiblyLanded() === true,
        ...(maskSecrets && { maskSecrets }),
        ...(revokedRule !== undefined && { revokedRule }),
      });
      // The same record the success arm writes: this arm reports the rule as
      // provisioned, so state is written here too and the narrowing has to
      // reach it or the phantom drift survives on the idempotent path.
      return {
        physicalId,
        attributes: existingRuleId ? { Id: existingRuleId } : {},
        ...(effectiveProperties && { effectiveProperties }),
      };
    }
    const cause = error instanceof Error ? error : undefined;
    const failure = this.wrapCaughtError(
      maskerOrIdentity(maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create SecurityGroupIngress ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
    // go-to-k/cdkd#4355: an Authorize AWS PROVABLY did not apply (a 4xx or
    // a throttle on a single send, with no earlier attempt of this dispatch
    // left in doubt) is journaled without its bag, so a rule someone adds by
    // hand before the re-run is not adopted. Anything else may have landed:
    // its bag stays evidence, and the dispatch remembers it so a duplicate
    // on the engine's retry keeps its bag too.
    const lookup = getPriorAttempts(logicalId);
    if (
      authorizeDefinitelyNotApplied(error) &&
      !earlierSendAmbiguous &&
      lookup?.possiblyLanded() !== true
    ) {
      markRefusedBeforeApplying(failure);
    } else {
      lookup?.notePossiblyLanded();
    }
    throw failure;
  }
}

/**
 * Send one `AuthorizeSecurityGroupIngress` through the single-send client,
 * re-sending up to {@link AUTHORIZE_SOCKET_RESENDS} times on a socket error
 * that can follow a written request (go-to-k/cdkd#4355). The SDK would have
 * re-sent those, but `ec2SingleSend` turns its retries off so every failure
 * is classified per send, and the engine's retry does not repeat socket
 * errors — without this a network blip fails the create outright.
 *
 * Each such failure may have authorized the rule, so it is reported through
 * `onAmbiguousResend` and noted on the dispatch: a Duplicate from the
 * re-send then refuses WITHOUT the refusal mark, keeping the evidence for
 * the next deploy. Any other failure (and the last socket error) is thrown
 * unchanged.
 */
export async function sendAuthorizeIngress(
  this: EC2Provider,
  logicalId: string,
  onAmbiguousResend: () => void,
  input: AuthorizeSecurityGroupIngressCommandInput
): Promise<AuthorizeSecurityGroupIngressCommandOutput> {
  for (let resend = 0; ; resend++) {
    try {
      return await this.ec2AuthorizeClient.send(new AuthorizeSecurityGroupIngressCommand(input));
    } catch (error) {
      const connectTimeout = isConnectTimeout(error);
      if (
        resend >= AUTHORIZE_SOCKET_RESENDS ||
        !(connectTimeout || isResendableSocketFailure(error))
      ) {
        throw error;
      }
      // A connect timeout sent nothing, so it is re-sent without the flag.
      if (!connectTimeout) {
        onAmbiguousResend();
        getPriorAttempts(logicalId)?.notePossiblyLanded();
      }
      this.logger.debug(
        safeMsg`SecurityGroupIngress ${logicalId}: Authorize failed on the socket (${describeAwsFailure(error).summary}); re-sending`
      );
      await this.sleep(AUTHORIZE_SOCKET_RESEND_DELAY_MS * (resend + 1));
    }
  }
}

/**
 * Decide what an `InvalidPermission.Duplicate` on an ingress create means
 * (go-to-k/cdkd#4355): return to adopt the existing rule, throw to refuse.
 *
 * AWS reports the same error for a rule an interrupted run of THIS stack
 * left behind (the Authorize landed, the run died before state recorded it)
 * and for an identical rule another owner added by hand or from another
 * stack. Adopting the second records it as this stack's, and `cdkd destroy`
 * then revokes it from under its owner. So the rule is adopted only when
 * this stack's own records show it:
 *
 * - a rollback replay (`replayingState`), whose bag IS a state record; or
 * - a bag this stack's rollback journal recorded for the logical id
 *   ({@link getPriorAttempts}) that describes the same rule.
 *
 * A retry of the same create in this run (the engine's, after a send that
 * got no definite answer) whose first Authorize may have landed is NOT
 * evidence in this run: AWS records no creation time for a rule, so nothing
 * tells that rule from a stranger's added meanwhile. It refuses, but WITHOUT
 * the refusal mark (`ownAttemptMayHaveLanded`), so the failed op keeps its
 * attempted bag and the next `cdkd deploy` adopts — a pre-existing identical
 * rule included. A throttled send applied nothing and leaves no doubt.
 *
 * Anything else refuses, naming the existing rule — including a journal
 * that cannot be read, and a caller that bound no evidence. The journal is
 * read only here, so an ordinary create makes no extra call.
 */
export async function resolveDuplicateIngress(
  this: EC2Provider,
  input: {
    logicalId: string;
    resourceType: string;
    groupId: string;
    desired: Record<string, unknown>;
    existingRuleId: string | undefined;
    replayingState: boolean;
    ownAttemptMayHaveLanded: boolean;
    maskSecrets?: MaskerFn;
    revokedRule?: string;
  }
): Promise<void> {
  const { logicalId, resourceType, groupId, desired, existingRuleId } = input;
  if (input.replayingState) {
    // The replay licence needs no further evidence (its bag is a state
    // record), so the adopted id is logged where an operator can audit it.
    this.logger.warn(
      safeMsg`SecurityGroupIngress ${logicalId}: the rollback replay adopted the existing identical rule ${existingRuleId ?? '(id not found)'} on ${groupId} as this stack's`
    );
    return;
  }
  const wanted = ingressRuleIdentity(groupId, desired);
  // go-to-k/cdkd#4492: another record of THIS stack already holds the rule —
  // two template rules CDK could not dedupe (a token port resolving to a
  // literal one), or a standalone rule repeating its group's inline one. AWS
  // keeps one rule for both. Not when the holder records a rule id the live
  // rule does not carry (or the live id is unknown): then the live rule is
  // not proven to be the one this stack made.
  const holder = stackIngressRuleHolder(getStackRecords()?.live(), logicalId, groupId, desired, {
    live: existingRuleId,
  });
  if (holder !== undefined) {
    this.logger.info(
      safeMsg`SecurityGroupIngress ${logicalId}: the identical rule ${existingRuleId ?? '(id not found)'} on ${groupId} is already held by ${holder} of this stack; both records share it`
    );
    return;
  }
  // A twin dispatched in the same deploy may have authorized the rule and
  // not yet recorded it. Wait for it to settle, then ask again: adopted only
  // once its record holds the live rule, never when it failed.
  const sibling = await this.settledInFlightIngressHolder(
    logicalId,
    resourceType,
    groupId,
    desired,
    existingRuleId
  );
  if (sibling !== undefined) {
    this.logger.info(
      safeMsg`SecurityGroupIngress ${logicalId}: the identical rule ${existingRuleId ?? '(id not found)'} on ${groupId} was just created in this deploy and is held by ${sibling} of this stack; both records share it`
    );
    return;
  }
  const lookup = getPriorAttempts(logicalId);
  let unreadable: string | undefined;
  if (lookup !== undefined) {
    try {
      const attempts = await lookup.attempts();
      if (attempts.some((bag) => ingressRuleIdentity(bag['GroupId'], bag) === wanted)) {
        this.logger.info(
          safeMsg`SecurityGroupIngress ${logicalId}: adopting the existing identical rule ${existingRuleId ?? '(id not found)'} on ${groupId}, which this stack's rollback journal shows an earlier deploy of it attempted`
        );
        return;
      }
    } catch (error) {
      // `summary` in the thrown (persisted) message: an S3 AccessDenied's
      // `detail` names the caller's role ARN and the bucket key.
      const failure = describeAwsFailure(error);
      unreadable = failure.summary;
      this.logger.debug(
        safeMsg`SecurityGroupIngress ${logicalId}: rollback journal read failed: ${failure.detail}`
      );
    }
  }
  const rule = existingRuleId ? `rule ${existingRuleId}` : 'an identical rule';
  const message =
    `Cannot create SecurityGroupIngress ${logicalId}: ${rule} already exists on security ` +
    `group ${groupId}, and nothing in this stack's records shows cdkd created it` +
    (unreadable === undefined
      ? ''
      : ` (the stack's rollback journal could not be read: ${unreadable})`) +
    `. cdkd does not adopt it, because 'cdkd destroy' would then revoke a rule its owner ` +
    `still relies on. Remove this rule from the stack if the existing one already covers ` +
    `it, or, if the existing rule is a leftover nobody owns (for example from an ` +
    `interrupted cdkd deploy), revoke it and re-deploy` +
    (existingRuleId
      ? `: ${pasteableAwsCommand(
          input.maskSecrets
        )`aws ec2 revoke-security-group-ingress --group-id ${groupId} --security-group-rule-ids ${existingRuleId}`.render()}`
      : '.') +
    (input.ownAttemptMayHaveLanded
      ? ` An earlier attempt of this create got no definite answer from AWS and may ` +
        `have authorized this rule itself, so the attempt is kept in the stack's ` +
        `rollback journal: the next 'cdkd deploy' adopts the rule if it is still identical.`
      : '') +
    (input.revokedRule === undefined
      ? ''
      : ` This was an update: the previous rule (${input.revokedRule}) has already been ` +
        `revoked, and the existing rule was left untouched` +
        // Only a deploy journals the op `--revert-failed` replays.
        (lookup === undefined
          ? '.'
          : `; 'cdkd rollback <stack> --revert-failed' re-authorizes the previous rule` +
            (input.ownAttemptMayHaveLanded
              ? `, after first revoking the existing identical rule, which the kept attempt ` +
                `names as this stack's, if it carries this stack's description; otherwise it is ` +
                `left and named.`
              : '.')));
  const refusal = markNonRetryable(
    new ProvisioningError(
      input.maskSecrets ? input.maskSecrets(message) : message,
      resourceType,
      logicalId
    )
  );
  // Marked so the failed op is journaled WITHOUT this bag: the bag is what a
  // later deploy reads as "this stack attempted the rule", and what
  // `cdkd rollback --revert-failed` reverts an update FROM (revoking it).
  // Left unmarked when this dispatch's own earlier send may have made the
  // rule: then the bag is the evidence the next deploy adopts on.
  if (!input.ownAttemptMayHaveLanded) markRefusedBeforeApplying(refusal);
  throw refusal;
}

/**
 * go-to-k/cdkd#4492: a create or update of this deploy still in flight whose
 * rule is the one `desired` describes — a twin dispatched beside this one,
 * whose Authorize won — awaited until it settles, then the live records
 * re-asked for a holder of the live rule (any record, by the same check). `undefined` when there is none, when it failed, or when
 * it is itself waiting (two writes that both met someone else's rule).
 */
export async function settledInFlightIngressHolder(
  this: EC2Provider,
  logicalId: string,
  resourceType: string,
  groupId: string,
  desired: Record<string, unknown>,
  existingRuleId: string | undefined
): Promise<string | undefined> {
  const view = getStackRecords();
  const wanted = comparableIngressIdentity(groupId, desired);
  if (view?.inFlight === undefined || wanted === undefined) return undefined;
  for (const sibling of [...view.inFlight()]) {
    if (sibling.logicalId === logicalId || sibling.resourceType !== resourceType) continue;
    const props = sibling.properties();
    if (props === undefined || comparableIngressIdentity(props['GroupId'], props) !== wanted) {
      continue;
    }
    if ((await awaitInFlightSibling(view, logicalId, sibling)) !== true) continue;
    const holder = stackIngressRuleHolder(view.live(), logicalId, groupId, desired, {
      live: existingRuleId,
    });
    // Any record now holding the live rule is this stack's evidence, as on
    // the first ask — the twin itself, or another record that settled
    // meanwhile (the twin may record a stale id).
    if (holder !== undefined) return holder;
  }
  return undefined;
}

/**
 * Every rule on `groupId`, walking `NextToken` up to {@link MAX_SG_RULE_PAGES}
 * pages; `undefined` when the group could not be read whole. Throws what
 * `DescribeSecurityGroupRules` throws.
 */
export async function listGroupRules(
  this: EC2Provider,
  groupId: string
): Promise<SecurityGroupRule[] | undefined> {
  const rules: SecurityGroupRule[] = [];
  let nextToken: string | undefined;
  let pages = 0;
  do {
    if (pages >= MAX_SG_RULE_PAGES) return undefined;
    const resp: DescribeSecurityGroupRulesResult = await this.ec2Client.send(
      new DescribeSecurityGroupRulesCommand({
        Filters: [{ Name: 'group-id', Values: [groupId] }],
        MaxResults: SG_RULE_PAGE_SIZE,
        ...(nextToken && { NextToken: nextToken }),
      })
    );
    rules.push(...(resp.SecurityGroupRules ?? []));
    nextToken = resp.NextToken;
    pages += 1;
  } while (nextToken);
  return rules;
}

/** The {@link EC2Provider} methods this module defines. */
export const sgIngressCreateMethods = {
  createSecurityGroupIngress,
  sendAuthorizeIngress,
  resolveDuplicateIngress,
  settledInFlightIngressHolder,
  listGroupRules,
};
