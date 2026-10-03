import type { IntrinsicFunctionResolver } from '../intrinsic-function-resolver.js';
import type { ResourceState } from '../../types/state.js';
import {
  AccountIdUnavailableError,
  IntrinsicResolutionRefusalError,
} from '../../utils/error-handler.js';
import { derivePartitionAndUrlSuffix } from '../../utils/aws-partition.js';
import { isSensitiveAttributeName, stringifyAttributeForLog } from '../../utils/stringify.js';
import {
  type AwsAccountInfo,
  type ResolverContext,
  effectiveAccountInfoRegion,
  embedsAccountId,
  getAccountInfo,
  isStructured,
} from './support.js';
import { carriesSecretMask } from '../secret-redaction.js';
import {
  type StaleAttributeHealOutcome,
  StaleAttributeMissSignal,
  readHealedAttribute,
} from '../stale-attribute-heal.js';

declare module '../intrinsic-function-resolver.js' {
  interface IntrinsicFunctionResolver {
    /** @internal */
    staleRecordRemedy: OmitThisParameter<typeof staleRecordRemedy>;
    /** @internal */
    unenrichedRemedy: OmitThisParameter<typeof unenrichedRemedy>;
    /** @internal */
    healWithheld: OmitThisParameter<typeof healWithheld>;
    /** @internal */
    withheldRemedy: OmitThisParameter<typeof withheldRemedy>;
    /** @internal */
    healStaleAttributes: OmitThisParameter<typeof healStaleAttributes>;
    /** @internal */
    usableHealedAttribute: OmitThisParameter<typeof usableHealedAttribute>;
    /** @internal */
    serveHealedAttribute: OmitThisParameter<typeof serveHealedAttribute>;
    /** @internal */
    constructWithStaleRecordHeal: OmitThisParameter<typeof constructWithStaleRecordHeal>;
    /** @internal */
    constructGuardedAttribute: OmitThisParameter<typeof constructGuardedAttribute>;
    /** @internal */
    healBeforeConstructing: OmitThisParameter<typeof healBeforeConstructing>;
  }
}

/**
 * The remedy half of a STALE-RECORD refusal (issue
 * [#1852](https://github.com/go-to-k/cdkd/issues/1852)), worded from what the
 * heal observed, and from whether the healer writes (a `readOnly` one does
 * not), so it is true on the path taken.
 *
 * The sentence it replaces — "deploy the stack again so the resource's next
 * update heals the record" — was false for the commonest case: a deploy that
 * changes none of the resource's own properties takes the no-change skip and
 * never runs `update()`, so "again" healed nothing.
 *
 * Every clause is cdkd-authored; AWS's text stays behind `--verbose`
 * ({@link describeFailureObserved}), because a denied read quotes the
 * caller's account, role and session.
 */
export function staleRecordRemedy(
  this: IntrinsicFunctionResolver,
  outcome: StaleAttributeHealOutcome | undefined,
  context?: ResolverContext
): string {
  const touch =
    `change any property of the resource so its next update re-records the attributes, ` +
    `or re-import it with 'cdkd import'`;
  if (outcome === undefined) {
    return (
      `Run 'cdkd deploy': it re-reads a stale record's attributes from AWS and heals the ` +
      `record. Otherwise ${touch}.`
    );
  }
  // A read-only healer (`cdkd diff`'s) writes nothing, so its read heals no
  // record: word the outcome as the preview's own read, not a heal attempt.
  const preview = context?.attributeHealer?.readOnly === true;
  const attempted = preview
    ? `This preview re-read the attributes from AWS`
    : `cdkd tried to re-read the attributes from AWS to heal the record`;
  switch (outcome.kind) {
    case 'failed':
      return (
        `${attempted}, but ` +
        `${this.describeFailureObserved('the provider read', outcome.error, context)}. ` +
        (preview
          ? `A preview writes nothing to state; 'cdkd deploy' issues the same read and records ` +
            `the attribute once the read returns it. Fix the read (a missing read permission is the ` +
            `usual cause), or ${touch}.`
          : `Fix that (a missing read permission is the usual cause) and deploy again — cdkd ` +
            `retries the read on every deploy until the record is healed — or ${touch}.`)
      );
    case 'not-found':
      return (
        `${attempted}, but AWS reports no ` +
        `resource behind the recorded physical id — it was probably deleted outside cdkd. ` +
        `Check it with 'cdkd drift', then re-create it (change the resource so it is replaced) ` +
        `or remove it from state.`
      );
    case 'read':
      if ((outcome.withheldKeys?.length ?? 0) > 0) return this.withheldRemedy(context);
      return preview
        ? `This preview re-read the resource from AWS and the read reports no usable value ` +
            `for this attribute either; ${touch}.`
        : `cdkd re-read the resource from AWS and the read reports no usable value for this ` +
            `attribute either, so there is nothing to heal the record with; ${touch}.`;
    case 'not-attempted':
      return (
        // No reason in the preview: "written by this deploy" is false there,
        // and naming another would claim to know why the healer declined.
        (preview
          ? `cdkd did not re-read it from AWS for this preview; `
          : `cdkd did not re-read it from AWS (the record was written by this deploy, or this ` +
            `resource type has no read-only lookup); `) + `${touch}.`
      );
  }
}

/**
 * The remedy half of the "not enriched" refusal. The pre-#1852 sentence,
 * plus what the heal established: a completed re-read that reports no such
 * attribute CONFIRMS the type does not supply it; a context with no healer
 * re-read nothing, so the record may merely predate the enrichment and
 * `cdkd deploy` is what heals it.
 */
export function unenrichedRemedy(
  this: IntrinsicFunctionResolver,
  resourceType: string,
  attributeName: string,
  outcome: StaleAttributeHealOutcome | undefined,
  context?: ResolverContext
): string {
  // The type through the builder (issue #3441): `guardedPhysicalIdFallback`
  // is the arm a type NO routing table matched lands on, so it is arbitrary
  // template text here.
  const fileIssue =
    `Avoid this Fn::GetAtt, or file an issue at https://github.com/go-to-k/cdkd/issues ` +
    `so cdkd can enrich ${this.displayMasked(resourceType, context)}.${this.displayMasked(attributeName, context)}.`;
  if (outcome === undefined) {
    // The hint goes FIRST: the sentence ends on the attribute name, which
    // `intrinsic-resolver-name-argument-log-twin.test.ts` anchors on.
    return (
      `If this record was written by an older cdkd that did not record the attribute yet, ` +
      `'cdkd deploy' re-reads it from AWS and heals the record. ${fileIssue}`
    );
  }
  if (outcome.kind === 'read') {
    if (this.healWithheld(outcome, attributeName)) return this.withheldRemedy(context);
    return (
      `cdkd re-read the resource's attributes from AWS and the read reports none by that ` +
      `name. ${fileIssue}`
    );
  }
  return fileIssue;
}

/** Did the heal's read report this attribute (by its top-level key) and cdkd withhold it as masked? */
export function healWithheld(
  this: IntrinsicFunctionResolver,
  outcome: Extract<StaleAttributeHealOutcome, { kind: 'read' }>,
  attributeName: string
): boolean {
  const head = attributeName.split('.')[0];
  return outcome.withheldKeys?.some((key) => key === attributeName || key === head) ?? false;
}

/**
 * The remedy when the re-read DID report a value and cdkd withheld it: Cloud
 * Control's read-back is masked wherever cdkd cannot certify a key as a
 * read-only attribute, which is every key when `DescribeType` is unavailable.
 * "The read reports none ... file an issue" would be false here.
 *
 * A `readOnly` healer's read (`cdkd diff`'s) ran under the preview's own
 * credentials, not the deploy role's, so that remedy names those instead.
 */
export function withheldRemedy(this: IntrinsicFunctionResolver, context?: ResolverContext): string {
  const confirm =
    `it could not confirm that this is a read-only attribute of the type, and an ` +
    `unconfirmed value is never used.`;
  if (context?.attributeHealer?.readOnly === true) {
    return (
      `This preview re-read the resource through Cloud Control, but withheld the value: ` +
      `${confirm} Grant the credentials the preview runs with cloudformation:DescribeType ` +
      `and run the diff again (a deploy's own read needs the same permission); if they ` +
      `already have it, the name is a writable property rather ` +
      `than an attribute — reference the value the template sets instead.`
    );
  }
  return (
    `cdkd re-read the resource through Cloud Control, but withheld the value: ${confirm} ` +
    `Grant the deploy role cloudformation:DescribeType and deploy again; if the ` +
    `role already has it, the name is a writable property rather than an attribute — ` +
    `reference the value the template sets instead.`
  );
}

/**
 * Ask the context's healer (issue #1852) — `undefined` when it has none. The
 * healer is contracted never to throw; the `catch` makes that a property of
 * THIS call site rather than of every supplier, because a throw here would
 * fail a deploy the pre-#1852 code passed (the warn-and-return fallback).
 */
export async function healStaleAttributes(
  this: IntrinsicFunctionResolver,
  logicalId: string,
  resource: ResourceState,
  context: ResolverContext
): Promise<StaleAttributeHealOutcome | undefined> {
  if (context.attributeHealer === undefined) return undefined;
  try {
    return await context.attributeHealer(logicalId, resource);
  } catch (error) {
    return { kind: 'failed', error };
  }
}

/**
 * The attribute out of a heal's read-back, or `undefined` when the read does
 * not supply a USABLE one. A value carrying `SECRET_MASK` is not usable:
 * `CloudControlProvider.import` masks what it cannot certify, and serving
 * that would send the literal mask to AWS.
 */
export function usableHealedAttribute(
  this: IntrinsicFunctionResolver,
  outcome: StaleAttributeHealOutcome | undefined,
  attributeName: string
): unknown {
  if (outcome?.kind !== 'read') return undefined;
  const value = readHealedAttribute(outcome.attributes, attributeName);
  return value === undefined || carriesSecretMask(value) ? undefined : value;
}

/** Serve a value the #1852 heal just read from AWS, logging it like a cached read. */
export function serveHealedAttribute(
  this: IntrinsicFunctionResolver,
  logicalId: string,
  attributeName: string,
  value: unknown,
  context: ResolverContext
): unknown {
  // Through the same note as every value served from the recorded bag. A
  // healer is contracted to drop masked keys and `usableHealedAttribute`
  // refuses one here too, so this is the third layer, not the first: a mask
  // that still got through is RECORDED as a redacted read and the engine
  // refuses the consumer rather than sending `***` to AWS. Noted BEFORE the
  // log line (go-to-k/cdkd#3659), as every serving branch is.
  const noted = this.noteAttributeSecrecy(logicalId, attributeName, value, context);
  this.logger.debug(
    `Resolved Fn::GetAtt from a re-read of AWS (the state record lacked it): ${this.logRender(logicalId, context)}.${this.logRender(attributeName, context)} resolved to ${this.logRender(stringifyAttributeForLog(attributeName, this.maskValueLeaves(value, context)), context, { structured: isStructured(value), redacted: isSensitiveAttributeName(attributeName) })}`
  );
  return noted;
}

/**
 * {@link constructGuardedAttribute}, healing a STALE state record first when
 * the construction is about to take {@link guardedPhysicalIdFallback} (issue
 * [#1852](https://github.com/go-to-k/cdkd/issues/1852)).
 *
 * Three passes at most, and an AWS call on none of them unless the fallback
 * is actually reached:
 *
 * 1. PROBE — construct under a derived context whose fallback raises
 *    {@link StaleAttributeMissSignal} instead of deciding. Every per-type arm
 *    that CAN answer (the ~40 constructed ARNs, the live-read arms) returns
 *    here exactly as before — except the heal-first arms
 *    ({@link healBeforeConstructing}, issue #3627), which raise the signal
 *    too because their answer may be wrong for a record lacking the value.
 * 2. HEAL — only on the signal: ask the context's healer, which re-reads the
 *    record's attributes through its provider once per deploy. A value for
 *    this attribute is served from that read.
 * 3. SETTLE — otherwise construct again under a context carrying the heal's
 *    outcome, so the fallback decides exactly as it always has (refuse an
 *    `*Arn` / `*Url` shape, refuse under `--strict-getatt`, else warn and
 *    return the physical id) and words a refusal from what was observed.
 *
 * The phase rides a DERIVED context, never a field of this resolver: one
 * resolver instance serves every concurrently resolving resource of a stack.
 * A context with no healer skips all of it.
 */
export async function constructWithStaleRecordHeal(
  this: IntrinsicFunctionResolver,
  resource: ResourceState,
  attributeName: string,
  context: ResolverContext,
  logicalId: string
): Promise<unknown> {
  if (context.attributeHealer === undefined) {
    return this.constructGuardedAttribute(resource, attributeName, context, logicalId);
  }
  try {
    return await this.constructGuardedAttribute(
      resource,
      attributeName,
      { ...context, staleAttributeHeal: { phase: 'probe' } },
      logicalId
    );
  } catch (error) {
    if (!(error instanceof StaleAttributeMissSignal)) throw error;
  }
  const outcome = (await this.healStaleAttributes(logicalId, resource, context)) ?? {
    kind: 'not-attempted' as const,
  };
  const healed = this.usableHealedAttribute(outcome, attributeName);
  if (healed !== undefined) {
    return this.serveHealedAttribute(logicalId, attributeName, healed, context);
  }
  return this.constructGuardedAttribute(
    resource,
    attributeName,
    { ...context, staleAttributeHeal: { phase: 'settled', outcome } },
    logicalId
  );
}

/**
 * Stand-in account id {@link constructGuardedAttribute} builds with (issue
 * #1730). Never served: a value that embeds it gets the real account
 * substituted, or is refused when there is none; one that does not never
 * needed the account. A NUL cannot occur in an AWS physical id, so a match is
 * always this stand-in.
 */
const UNKNOWN_ACCOUNT_STAND_IN = '\u0000cdkd-unknown-account\u0000';

/**
 * Construct resource attribute value based on resource type, refusing a value
 * that needs an account id STS could not report (issue #1730).
 *
 * Thin wrapper over {@link constructAttribute}. ~30 branches there build
 * `arn:<partition>:<svc>:<region>:<accountId>:...`, and `getAccountInfo`
 * REFUSES when STS cannot name the account and `AWS_ACCOUNT_ID` is unset —
 * there is no placeholder account to build from. Refusing every
 * `Fn::GetAtt` on that refusal would also fail the values the account is NOT
 * in, so the construction runs against {@link UNKNOWN_ACCOUNT_STAND_IN}, and
 * the account is asked for only when the result EMBEDS that stand-in.
 *
 * The test is on the CONSTRUCTED VALUE, not on the attribute NAME, and that
 * precision is the whole point: `AWS::S3::Bucket`'s `Arn` is
 * `arn:aws:s3:::<bucket>` with no account field, so a name-based `*Arn` guard
 * would refuse a value that needs no account. Everything the account id does
 * not appear in — `DomainName`, `Endpoint`, `WebsiteURL` — keeps resolving.
 * The match is a BARE substring rather than the colon-delimited `:<id>:` an
 * ARN uses, because not every account embedding is an ARN field:
 * `AWS::ECR::Repository`'s `RepositoryUri` is
 * `<accountId>.dkr.ecr.<region>.amazonaws.com/<repo>`.
 *
 * The refusal is an {@link IntrinsicResolutionRefusalError}, so `resolveSub`
 * re-raises it rather than keeping a literal `${Resource.Attribute}`.
 *
 * NOTE the naming: the per-type construction below KEEPS the name
 * `constructAttribute` and this guard takes a new one, rather than the other
 * way round. `scripts/gen-sdk-attr-coverage.ts` collects the set of resource
 * types `constructAttribute` references to decide which `*Arn` attributes the
 * resolver can already answer, so renaming that method emptied its walk.
 */
export async function constructGuardedAttribute(
  this: IntrinsicFunctionResolver,
  resource: ResourceState,
  attributeName: string,
  context: ResolverContext,
  logicalId: string
): Promise<unknown> {
  // Built against the stand-in FIRST, so a value the account is not in never
  // asks STS at all: during an outage every such `Fn::GetAtt` (probe and
  // settle) would otherwise spend the SDK's own retry chain on a lookup it
  // does not need. Region and partition are what `getAccountInfo` would
  // derive (`accountInfoFor`).
  const region = effectiveAccountInfoRegion(this.resolverRegion);
  const standIn: AwsAccountInfo = {
    accountId: UNKNOWN_ACCOUNT_STAND_IN,
    region,
    partition: derivePartitionAndUrlSuffix(region).partition,
  };
  const value = await this.constructAttribute(resource, attributeName, context, logicalId, standIn);
  if (!embedsAccountId(value, UNKNOWN_ACCOUNT_STAND_IN)) return value;

  let accountId: string;
  try {
    accountId = (await getAccountInfo(this.resolverRegion)).accountId;
  } catch (error) {
    if (!(error instanceof AccountIdUnavailableError)) throw error;
    // `attributeName` masked for the reason its nested-stack sibling above
    // states (issue #2827 review). The type too (issue #3441): this guard vets
    // EVERY constructed value, and for a type no arm matched that value is the
    // physical id, so the type is arbitrary template text. The account
    // refusal's own message is cdkd-authored and withholds AWS-authored STS
    // message text, so it is appended as written, and NOT passed as
    // `cause`, which `formatError` would print a second time. NOT
    // `markNonRetryable`: a failed lookup is never cached, so a later attempt
    // can heal.
    throw new IntrinsicResolutionRefusalError(
      `Cannot resolve Fn::GetAtt [${this.displayMasked(logicalId, context)}, ${this.displayMasked(attributeName, context)}] for ${this.displayMasked(resource.resourceType, context)}: ` +
        `the value embeds this deploy's account id. ${error.message}`
    );
  }
  // The stand-in cannot occur in a physical id (it carries NULs), so replacing
  // it is exact: the result is what a build with the real account produces,
  // without repeating any live read the construction made.
  return withAccountId(value, accountId);
}

/** Replace {@link UNKNOWN_ACCOUNT_STAND_IN} in a constructed string or string list. */
function withAccountId(value: unknown, accountId: string): unknown {
  if (typeof value === 'string') return value.replaceAll(UNKNOWN_ACCOUNT_STAND_IN, accountId);
  if (Array.isArray(value)) {
    return value.map((entry: unknown) =>
      typeof entry === 'string' ? entry.replaceAll(UNKNOWN_ACCOUNT_STAND_IN, accountId) : entry
    );
  }
  return value;
}

/**
 * Route an arm that ANSWERS without the record through the #1852 heal first.
 *
 * The heal runs only when a construction raises
 * {@link StaleAttributeMissSignal}, which only `guardedPhysicalIdFallback`
 * did — so an arm that returned `undefined` (DynamoDB `StreamArn`, IAM
 * `RoleId`) or built a path-less IAM ARN never healed a record that lacks
 * the attribute, such as one `cdkd import` wrote before issue #3627's
 * read-backs. Under the probe phase this raises the signal; in the settled
 * phase (the read found nothing) or with no healer it returns, and the arm
 * answers: the IAM arms with their path-less ARN, the `StreamArn` / `RoleId`
 * arms with a refusal worded from the heal's outcome (issue #4077,
 * {@link refuseUnconstructibleAttribute}).
 */
export function healBeforeConstructing(
  this: IntrinsicFunctionResolver,
  context: ResolverContext
): void {
  if (context.staleAttributeHeal?.phase === 'probe') throw new StaleAttributeMissSignal();
}
