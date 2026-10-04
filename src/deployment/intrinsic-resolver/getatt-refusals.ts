import type { IntrinsicFunctionResolver } from '../intrinsic-function-resolver.js';
import { displaySafe } from '../../utils/display-safe.js';
import { IntrinsicResolutionRefusalError } from '../../utils/error-handler.js';
import { type ResolverContext, quotedRender } from './support.js';
import { markNonRetryable } from '../retryable-errors.js';
import { StaleAttributeMissSignal } from '../stale-attribute-heal.js';

declare module '../intrinsic-function-resolver.js' {
  interface IntrinsicFunctionResolver {
    /** @internal */
    refuseUnservedAttribute(
      ...args: Parameters<OmitThisParameter<typeof refuseUnservedAttribute>>
    ): never;
    /** @internal */
    refuseUnconstructibleAttribute(
      ...args: Parameters<OmitThisParameter<typeof refuseUnconstructibleAttribute>>
    ): never;
    /** @internal */
    refuseUndefinedAttribute(
      ...args: Parameters<OmitThisParameter<typeof refuseUndefinedAttribute>>
    ): never;
    /** @internal */
    describeFailureObserved: OmitThisParameter<typeof describeFailureObserved>;
    /** @internal */
    guardedPhysicalIdFallback: OmitThisParameter<typeof guardedPhysicalIdFallback>;
  }
}

/**
 * Refuse an attribute the state record omits and a live read could not
 * serve (issue [#3096](https://github.com/go-to-k/cdkd/issues/3096)).
 *
 * The arms that call this all share one shape: the provider recorded no
 * value because AWS had not assigned one yet or the read-back failed (issue
 * #3077 made the key ABSENT rather than `''`), the resolver re-reads it
 * live, and the read finds nothing — or fails. Before #3096 every such arm
 * answered the PHYSICAL ID: an `i-...` where an IP address or a DNS name
 * belongs, a `vpc-...` in a security-group slot, a distribution id where a
 * hostname belongs, a proxy name in a `VpcId` position. Loud only where AWS
 * rejects the shape; an Output, an export or a free-text property carried it
 * silently. The security group `VpcId` arm (issue #3097) joined with the
 * opposite pre-fix defect — it answered `undefined`, which `Fn::Join`
 * renders `'undefined'` — and takes the same refusal. The physical id can
 * never be the value for these attributes, so the honest answer is a
 * refusal naming the resource, the attribute, what was observed and the
 * remedy.
 *
 * DELIBERATELY NOT `markNonRetryable`, unlike every other refusal in this
 * file but the unknown-account guard: the verdict is TIME-DEPENDENT. A
 * `pending` instance settles seconds later, and a failed describe can
 * succeed on the next attempt, so cdkd must not DECLARE it terminal — the
 * marker is that declaration, and `withRetry` honours it ahead of every
 * classifier. Leaving it off promises no retry: `isRetryableTransientError`
 * reads throttle names and HTTP statuses off the `cause` chain — which this
 * refusal deliberately does not carry, see below — and everything else by
 * message substring, and this message matches nothing on its own. So the
 * nested-stack replay (`NestedStackProvider.create` runs the child deploy
 * inside the parent's `withRetry`) re-runs the child only when an
 * interpolated hole happens to carry a pattern — the `logicalId` (the #1838
 * hazard: `DependencyViolation` and two other bare words), or the error
 * CLASS name `describeFailureObserved` puts in `observed`, which none of
 * the EC2 describes raises (the Cloud Map `GetNamespace` read, issue #4077,
 * can: its throttle `RequestLimitExceeded` is a retryable name, and a retry
 * is what a throttled read wants) — and then re-describes and can heal.
 * Measured, not designed: the unknown-account guard sits in exactly the
 * same place. Threading a sanitized SDK error as `cause` so a throttled
 * describe classifies as transient was considered and left out — a
 * `CdkdError`'s `cause` is rendered at default verbosity by `formatError`
 * (`Caused by:`), so the clone would need its own fence. What the
 * refusal does at each consumer: a resource property fails the resource; a
 * stack Output is caught per-output by `DeployEngine.
 * handleOutputResolutionFailure`, skipped and recorded in `skippedOutputs`
 * (#2740), then re-resolved on the next deploy; an `Fn::Sub` re-raises it
 * (#1740); a `Conditions` entry still absorbs it to `false`
 * (`evaluateConditions`).
 *
 * `observed` and `remedy` are cdkd-authored sentences built by the caller
 * from an instance STATE name, an error CLASS name or a fixed phrase — never
 * AWS's raw message, which `describeFailureObserved` keeps at debug (the
 * per-reader rule in `.claude/rules/provider-resource-identity.md`: a
 * denied describe quotes the caller's account, role and session).
 */
export function refuseUnservedAttribute(
  this: IntrinsicFunctionResolver,
  site: {
    logicalId: string;
    attributeName: string;
    resourceType: string;
    physicalId: string;
    context: ResolverContext;
    observed: string;
    remedy: string;
  }
): never {
  const { logicalId, attributeName, resourceType, physicalId, context, observed, remedy } = site;
  // not-in-class(observed): a cdkd-authored sentence built from an AWS state name or an error CLASS name; the raw AWS text stays at debug.
  // not-in-class(remedy): a cdkd-authored literal chosen by the calling arm.
  //
  // The type through the builder (issue #3441). Every CURRENT caller sits
  // behind a `resourceType === '<literal>'` test, but this helper gates on
  // nothing itself, so leaving it raw would make its safety a property of
  // every future caller.
  throw new IntrinsicResolutionRefusalError(
    `Cannot resolve Fn::GetAtt [${this.displayMasked(logicalId, context)}, ${this.displayMasked(attributeName, context)}] for ${this.displayMasked(resourceType, context)}: ` +
      `${observed}. The physical id ${quotedRender(this.displayMasked(physicalId, context), '"')} is not a usable ` +
      `${this.displayMasked(attributeName, context)}, so cdkd refuses to substitute it. ${remedy}`
  );
}

/**
 * Refuse a CloudFormation attribute cdkd cannot BUILD and the state record
 * does not hold (issue [#4077](https://github.com/go-to-k/cdkd/issues/4077)).
 *
 * These arms used to answer `undefined`. CloudFormation answers the real
 * value, so no value cdkd could substitute is correct, and `undefined` was
 * the worst of them: a resource property dropped the key silently, a
 * `Fn::Join` / `Fn::Sub` rendered the text `undefined` into the value it
 * sent to AWS, and a stack Output was skipped without a warning. A refusal
 * takes the per-site outcome every other refusal gets (resource fails,
 * Output warns and skips or fails under `--strict-getatt`, `Fn::Sub`
 * re-raises, `Conditions` absorb it).
 *
 * Reached only after the #1852 heal settled (every caller runs
 * {@link healBeforeConstructing} first), so the remedy is worded from its
 * outcome. Marked non-retryable: the verdict is the record plus the heal's
 * memoized outcome, which a retry cannot change, and the message
 * interpolates the template's logical id.
 */
export function refuseUnconstructibleAttribute(
  this: IntrinsicFunctionResolver,
  site: {
    logicalId: string;
    attributeName: string;
    resourceType: string;
    context: ResolverContext;
    why: string;
    /**
     * Replaces the stale-record remedy when the heal COMPLETED without the
     * value (`read`, or `not-attempted` for a record this deploy wrote): the
     * arm then knows the likelier cause better than "re-record it" does.
     */
    remedyWhenHealCompleted?: string;
  }
): never {
  const { logicalId, attributeName, resourceType, context, why, remedyWhenHealCompleted } = site;
  const healOutcome =
    context.staleAttributeHeal?.phase === 'settled'
      ? context.staleAttributeHeal.outcome
      : undefined;
  const healCompleted =
    (healOutcome?.kind === 'read' && (healOutcome.withheldKeys?.length ?? 0) === 0) ||
    healOutcome?.kind === 'not-attempted';
  const remedy =
    remedyWhenHealCompleted !== undefined && healCompleted
      ? remedyWhenHealCompleted
      : this.staleRecordRemedy(healOutcome, context);
  // not-in-class(why): a cdkd-authored literal chosen by the calling arm.
  // not-in-class(remedy): a cdkd-authored literal, or `staleRecordRemedy`'s cdkd-authored sentence.
  throw markNonRetryable(
    new IntrinsicResolutionRefusalError(
      `Cannot resolve Fn::GetAtt [${this.displayMasked(logicalId, context)}, ${this.displayMasked(attributeName, context)}] for ${this.displayMasked(resourceType, context)}: ` +
        `the state record holds no value for it and ${why}, so cdkd refuses to substitute ` +
        `one. ${remedy}`
    )
  );
}

/**
 * Refuse an `Fn::GetAtt` naming an attribute the CloudFormation schema does
 * not define for the type (issue
 * [#4077](https://github.com/go-to-k/cdkd/issues/4077)). CloudFormation
 * rejects such a template at validation, before anything is created; cdkd
 * refuses the reference. Marked non-retryable: the verdict is the template.
 */
export function refuseUndefinedAttribute(
  this: IntrinsicFunctionResolver,
  site: {
    logicalId: string;
    attributeName: string;
    resourceType: string;
    context: ResolverContext;
    defined: string;
  }
): never {
  const { logicalId, attributeName, resourceType, context, defined } = site;
  // not-in-class(defined): a cdkd-authored list of the type's schema attributes, a literal at every call site.
  throw markNonRetryable(
    new IntrinsicResolutionRefusalError(
      `Cannot resolve Fn::GetAtt [${this.displayMasked(logicalId, context)}, ${this.displayMasked(attributeName, context)}] for ${this.displayMasked(resourceType, context)}: ` +
        `CloudFormation defines no such attribute for this type (its attributes: ${defined}), ` +
        `and rejects the template. Reference one of those attributes instead.`
    )
  );
}

/**
 * The `observed` clause of {@link refuseUnservedAttribute} for a live read
 * that THREW: names the read and the error's CLASS at default verbosity and
 * puts AWS's own text behind `--verbose`, since a denied describe quotes the
 * caller's account, role and session into its message.
 */
export function describeFailureObserved(
  this: IntrinsicFunctionResolver,
  read: string,
  err: unknown,
  context?: ResolverContext
): string {
  // `displaySafe` rather than `stripControlChars`: the latter keeps
  // `U+2028` / `U+2029`, which a terminal renders as a line break (the
  // `error-handler.ts` `formatError` rule). An SDK error name is ASCII.
  // Slice THEN trim, so a cut at a space leaves no trailing one; a name
  // with no ASCII in it (a hand-rolled mock — SDK names are ASCII) blanks
  // to nothing, and `Error` is the honest class to print then.
  // A non-`Error` throw (a string, a rejected plain object) has no class
  // to name: `Error` is the honest word, not `typeof err`.
  const name =
    displaySafe(err instanceof Error && err.name ? err.name : 'Error', { asciiOnly: true })
      .slice(0, 64)
      .trim() || 'Error';
  // The HTTP status, when the SDK attached one, tells an operator apart a
  // denial (403) from a throttle (429 / 503) without `--verbose`; a network
  // failure carries a generic `Error` name and no status at all.
  const status = (err as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata
    ?.httpStatusCode;
  const errorClass =
    typeof status === 'number' && Number.isInteger(status) ? `${name}, HTTP ${status}` : name;
  // not-in-class(read): the AWS API name the calling arm issued, a literal at every call site.
  // not-in-class(errorClass): the thrown error's CLASS name plus its numeric HTTP status, bounded and display-safe; the message is masked beside it.
  this.logger.debug(
    `${read} failed (${errorClass}): ${this.displayMasked(err instanceof Error ? err.message : String(err), context)}`
  );
  return `${read} failed (${errorClass}); re-run with --verbose for the AWS error text`;
}

/**
 * Shared unknown-attribute physicalId fallback (issues #1106 / #1111).
 *
 * Applied by BOTH the final unknown-type fallback of
 * {@link constructAttribute} and every per-type handler's
 * `default:`-for-an-unknown-attribute branch:
 *
 * - An attribute name ending in `Arn` whose fallback value is not
 *   ARN-shaped (or ending in `Url` whose fallback is not an http(s) URL)
 *   cannot be what CloudFormation would return — hard-fail. The #1103
 *   incident shipped four resource NAMES into stack Outputs where ARNs
 *   were requested, with a green deploy. A physicalId that already IS an
 *   ARN / URL passes the shape check and remains a valid fallback.
 * - Under `--strict-getatt`, EVERY unknown-attribute fallback (any
 *   suffix) is a hard error.
 * - Otherwise: `Alias` / `Endpoint` and every other suffix keep the
 *   warn-and-return behavior (an alias or endpoint is
 *   shape-indistinguishable from a plain name, so a hard-fail there
 *   would risk failing correct deploys — false positives are
 *   unacceptable). Each warn-and-return increments the per-run fallback
 *   counter surfaced in the deploy summary.
 *
 * A `return physicalId` that is the CORRECT value for a KNOWN attribute
 * (e.g. `AWS::KMS::Key.KeyId`, `AWS::SNS::Topic.TopicName`) must NOT
 * route through this helper — those are explicit `case`s in the
 * per-type handlers.
 */
export function guardedPhysicalIdFallback(
  this: IntrinsicFunctionResolver,
  logicalId: string,
  attributeName: string,
  resourceType: string,
  physicalId: string,
  // Issue [#2827](https://github.com/go-to-k/cdkd/issues/2827) review round 2.
  // `attributeName` here is `resolveGetAtt`'s `resolvedAttributeName` — the
  // SAME binding masked at the type refusal, the nested-stack refusal and the
  // success line — and this helper is the `default:` arm of 38 `Fn::GetAtt`
  // call sites, so it is the most reachable interpolation of it in the file.
  // It took no `context` and therefore had nothing to mask against; its only
  // caller has had one since this PR renamed `_context`.
  context?: ResolverContext
): string {
  // Issue #1852: under the heal wrapper's PROBE context, do not decide — the
  // record may simply be stale, and the wrapper re-reads it before any
  // verdict. Raised before the shape test on purpose: the warn-and-return
  // arm below serves a wrong value just as the refusal serves none.
  if (context?.staleAttributeHeal?.phase === 'probe') throw new StaleAttributeMissSignal();
  const healOutcome =
    context?.staleAttributeHeal?.phase === 'settled'
      ? context.staleAttributeHeal.outcome
      : undefined;
  // `read` = the provider's own read-back reports no such attribute, which is
  // what "not enriched" means; `not-attempted` / no healer = nothing says
  // otherwise. Only a FAILED or NOT-FOUND read makes that sentence a guess.
  const recordMayBeStale = healOutcome?.kind === 'failed' || healOutcome?.kind === 'not-found';
  // Every path below renders the type, and this helper is where a type NO
  // routing table matched lands (the final `default` of
  // `constructAttribute`), so it is arbitrary template text: through the
  // builder once, for all four renders (issue #3441).
  const loggedType = this.displayMasked(resourceType, context);
  const expectsArnShape = attributeName.endsWith('Arn') && !physicalId.startsWith('arn:');
  const expectsUrlShape = attributeName.endsWith('Url') && !/^https?:\/\//.test(physicalId);
  if (expectsArnShape || expectsUrlShape) {
    const expectedShape = expectsArnShape ? 'an ARN (arn:...)' : 'a URL (http(s)://...)';
    // Terminal (issue #1838 / #1874 review): the verdict is a function of the
    // ATTRIBUTE NAME's suffix, the already-created resource's physical id, and
    // the static "this type is not enriched" fact — none of which a retry
    // changes. Marked because the message interpolates `logicalId`; see
    // `rejectPlaceholderArnAttribute` for the full reasoning.
    throw markNonRetryable(
      new IntrinsicResolutionRefusalError(
        `Cannot resolve Fn::GetAtt [${this.displayMasked(logicalId, context)}, ${this.displayMasked(attributeName, context)}] for ${loggedType}: ` +
          (recordMayBeStale
            ? `the state record holds no value for it, and the physical ID `
            : `attributes are not enriched for this resource type, and the physical ID `) +
          `fallback ${quotedRender(this.displayMasked(physicalId, context), '"')} is not ${expectedShape}. CloudFormation would return ` +
          `a different value here, so falling back to the physical ID would silently ` +
          `produce a wrong value (e.g. in stack Outputs). ` +
          (recordMayBeStale
            ? this.staleRecordRemedy(healOutcome, context)
            : this.unenrichedRemedy(resourceType, attributeName, healOutcome, context))
      )
    );
  }
  if (this.strictGetAtt) {
    // Terminal (issue #1838 / #1874 review): the verdict is a CLI FLAG plus
    // the same static enrichment fact. A flag cannot change mid-deploy, so no
    // retry of this resolution can ever take a different branch.
    throw markNonRetryable(
      new IntrinsicResolutionRefusalError(
        `Cannot resolve Fn::GetAtt [${this.displayMasked(logicalId, context)}, ${this.displayMasked(attributeName, context)}] for ${loggedType}: ` +
          (recordMayBeStale
            ? `the state record holds no value for it, and --strict-getatt `
            : `attributes are not enriched for this resource type, and --strict-getatt `) +
          `rejects the physical ID fallback ${quotedRender(this.displayMasked(physicalId, context), '"')} (which may not be the value ` +
          `CloudFormation would return). Drop --strict-getatt to fall back with a warning. ` +
          (recordMayBeStale
            ? this.staleRecordRemedy(healOutcome, context)
            : this.unenrichedRemedy(resourceType, attributeName, healOutcome, context))
      )
    );
  }
  this.physicalIdFallbackCount++;
  if (recordMayBeStale) {
    // The same warn-and-return as below, but the "unknown attribute" wording
    // would be a guess: the record may simply be stale and the re-read that
    // would have said so did not complete. Say what was observed instead.
    this.logger.warn(
      `The state record for ${this.displayMasked(logicalId, context)} (${loggedType}) holds no ` +
        `${this.displayMasked(attributeName, context)}, returning physical ID. ` +
        this.staleRecordRemedy(healOutcome, context)
    );
    return physicalId;
  }
  // DEFAULT VERBOSITY, and the most reachable of the three (issue #2827
  // review round 2): the two throws above need a shape mismatch or a flag,
  // this fires on every unenriched attribute.
  // A value the re-read reported but cdkd WITHHELD as masked is not an
  // "unknown attribute" the user can do nothing about: name the permission.
  const withheld =
    healOutcome?.kind === 'read' && this.healWithheld(healOutcome, attributeName)
      ? `. ${this.withheldRemedy(context)}`
      : '';
  this.logger.warn(
    `Unknown attribute ${this.displayMasked(attributeName, context)} for resource type ${loggedType}, returning physical ID${withheld}`
  );
  return physicalId;
}
