import type { IntrinsicFunctionResolver } from '../intrinsic-function-resolver.js';
import { isSettledInstanceState } from '../../provisioning/ec2-instance-state.js';
import type { ResourceState } from '../../types/state.js';
import { canonicalizeRegion, derivePartitionAndUrlSuffix } from '../../utils/aws-partition.js';
import { displaySafe } from '../../utils/display-safe.js';
import { IntrinsicResolutionRefusalError } from '../../utils/error-handler.js';
import {
  s3BucketArn,
  s3BucketDomainName,
  s3BucketDualStackDomainName,
  s3BucketRegionalDomainName,
  s3BucketWebsiteUrl,
} from '../../utils/s3-endpoints.js';
import {
  isSensitiveAttributeName,
  stringifyAttributeForLog,
  stringifyValue,
} from '../../utils/stringify.js';
import {
  type AwsAccountInfo,
  NESTED_STACK_OUTPUT_ATTRIBUTE_PREFIX,
  NESTED_STACK_RESOURCE_TYPE,
  type RedactedAttributeRead,
  type ResolverContext,
  cachedCloudFrontDomainNames,
  cachedEc2InstanceAttributes,
  cachedSecurityGroupVpcIds,
  cachedVpcDefaultSecurityGroups,
  carriesDynamicReference,
  embedsAccountId,
  getAccountInfo,
  isImpossibleEmptyStoredAttribute,
  isStalePlaceholderArnAttribute,
  isStructured,
  nestedStackChildRegionFromLocalArn,
  quotedRender,
} from './support.js';
import { markNonRetryable } from '../retryable-errors.js';
import {
  carriesSecretMask,
  crossStackSourceKey,
  recordFreshNoEchoValuesIn,
  splitGetAttStringForm,
} from '../secret-redaction.js';
import {
  type StaleAttributeHealOutcome,
  StaleAttributeMissSignal,
  readHealedAttribute,
} from '../stale-attribute-heal.js';
import { GetDistributionCommand } from '@aws-sdk/client-cloudfront';
import {
  DescribeInstancesCommand,
  DescribeLaunchTemplatesCommand,
  DescribeSecurityGroupsCommand,
  DescribeVpcsCommand,
} from '@aws-sdk/client-ec2';

declare module '../intrinsic-function-resolver.js' {
  interface IntrinsicFunctionResolver {
    /** @internal */
    pushRedactedAttributeRead: OmitThisParameter<typeof pushRedactedAttributeRead>;
    /** @internal */
    resolveGetAtt: OmitThisParameter<typeof resolveGetAtt>;
    /** @internal */
    publicNoEchoTokens: OmitThisParameter<typeof publicNoEchoTokens>;
    /** @internal */
    noteAttributeSecrecy: OmitThisParameter<typeof noteAttributeSecrecy>;
    /** @internal */
    rejectPlaceholderArnAttribute: OmitThisParameter<typeof rejectPlaceholderArnAttribute>;
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
    /** @internal */
    constructAttribute: OmitThisParameter<typeof constructAttribute>;
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
 * The ONE writer of {@link ResolverContext.redactedAttributeReads}, so the
 * bag's absent-context check and its de-duplication rule live in one place
 * rather than being re-spelled at each of the three pushing branches.
 *
 * DE-DUPES ON THE WHOLE TUPLE, not on `display` alone, and that is the last
 * decision this file moved out of string space (issue #2847 round-5 review).
 * An earlier revision compared renderings, which is where two of this PR's
 * blockers came from: a decision keyed on a joined human-readable string.
 * Here it gated entry EXISTENCE while `DeployEngine`'s Outputs guard filters
 * the surviving entries by `kind`, so an `attribute` entry whose `display`
 * collided with a later `ref-state-key` one suppressed the refusal outright.
 * Reachable only through an adversarial logical id (`Ref Foo (state key Table`
 * with an attribute named `Name)`) — `main`'s string bag is equally
 * contrived, which is why review called it a cleanup rather than a defect —
 * but the class is the point, not this instance.
 *
 * `key` carries its weight here: for the `attribute` kind it is the
 * ALREADY-MASKED attribute name, so two names differing only ABOVE the mask
 * still render and compare identically and still collapse, exactly as they
 * did when the bag held strings. Nothing else reads it, and comparing it is
 * what keeps it from being a field written by two producers and read by none.
 */
export function pushRedactedAttributeRead(
  this: IntrinsicFunctionResolver,
  context: ResolverContext,
  read: RedactedAttributeRead
): void {
  const bag = context.redactedAttributeReads;
  if (bag === undefined) return;
  const duplicate = bag.some(
    (entry) =>
      entry.kind === read.kind &&
      entry.logicalId === read.logicalId &&
      entry.key === read.key &&
      entry.display === read.display
  );
  if (duplicate) return;
  bag.push(read);
}

/**
 * Resolve Fn::GetAtt intrinsic function
 */
export async function resolveGetAtt(
  this: IntrinsicFunctionResolver,
  getAtt: [string, unknown] | string,
  context: ResolverContext
): Promise<unknown> {
  // Fn::GetAtt can be either [LogicalId, AttributeName] or "LogicalId.AttributeName"
  let logicalId: string;
  let attributeName: string;

  if (Array.isArray(getAtt)) {
    // The attribute name (arg 2) may itself be an intrinsic (e.g.
    // `{Ref: AttrNameParam}`, `{Fn::Sub: ...}`) — CloudFormation allows the
    // GetAtt attribute name to be any string-valued expression. Resolve it
    // first, before any string operations (`.includes`, `.split`, the
    // nested-path walk, the per-type switch), which would otherwise crash
    // with `attributeName.includes is not a function` on a non-string.
    // The logical id (arg 1) must be a static string per CFn, so it is not
    // resolved.
    const [rawLogicalId, rawAttributeName] = getAtt;
    logicalId = rawLogicalId;
    const resolvedAttributeName = await this.resolveValue(rawAttributeName, context);
    if (typeof resolvedAttributeName !== 'string') {
      throw new Error(
        `Fn::GetAtt attribute name for ${this.displayMasked(logicalId, context)} must resolve to a string, got ${typeof resolvedAttributeName}: ${stringifyValue(this.maskValueLeaves(resolvedAttributeName, context))}`
      );
    }
    attributeName = resolvedAttributeName;
  } else {
    // The STRING spelling (what the shorthand YAML `!GetAtt A.B` produces).
    // The SPLIT RULE ITSELF is deliberately not written here: it lives in
    // `splitGetAttStringForm`, which `crossStackSourceKey` calls too, and
    // that helper's doc carries the reasoning. Two copies of this rule is
    // exactly the defect issue #2270 fixed -- the resolver and the key
    // function each spelled it, and they disagreed.
    //
    // What matters AT THIS SITE: the rule accepts `Child.Outputs.Foo` as
    // `["Child", "Outputs.Foo"]`, which the ARRAY branch above already
    // resolves (the flat `Outputs.` dot-key
    // `NestedStackProvider.buildOutputsAttributes` writes, then the #2055
    // re-resolution arm below). The previous every-dot `parts.length !== 2`
    // test refused it: in `Fn::GetAtt` position that throw was loud, but
    // inside `Fn::Sub` the surrounding catch turned it into a KEPT literal,
    // so a property deployed with `${Child.Outputs.Foo}` still in it.
    // `template-parser.ts` already split the identical `Fn::Sub` placeholder
    // on the first dot to build the DAG edge, so the resolver had disagreed
    // with the dependency graph feeding it: the edge was drawn, the
    // reference was then not resolvable.
    const split = splitGetAttStringForm(getAtt);
    if (split === undefined) {
      // `markNonRetryable` (issue #2270 round 3). The verdict is a function of
      // the TEMPLATE TEXT, which no retry rewrites, and the message
      // interpolates that same template-controlled text into a string the
      // retry classifiers match by BARE SUBSTRING
      // (`isRetryableTransientError`) -- so a logical id like
      // `ThrottlingWidget` puts `Throttling` into a deterministic refusal and
      // makes it read as transient. That became REACHABLE when this PR let a
      // structural `Fn::Sub` failure escape its catch: the error crosses
      // `NestedStackProvider.create`, which the parent wraps in `withRetry`.
      // The MARK is the remedy rather than a re-worded message, deliberately
      // -- see `rethrowStructuralSubFailure`, which must re-throw the error
      // OBJECT untouched, and marking rides the object.
      // Through the builder (issue #3441): the operand is RAW template text,
      // so being pre-resolution answers the secret question but not the
      // control-character one.
      throw markNonRetryable(
        new Error(`Invalid Fn::GetAtt format: ${this.displayMasked(getAtt, context)}`)
      );
    }
    logicalId = split.logicalId;
    attributeName = split.attributeName;
  }

  // `Object.hasOwn` for the reason given at the `resolveRef` resource read
  // (issue #2767): a bare read walks the prototype chain, so
  // `Fn::GetAtt: ["constructor", "Arn"]` bound an `Object.prototype` member,
  // skipped the refusal below, and carried a function into the attribute
  // lookup -- where `resource.resourceType` and `resource.attributes` are both
  // `undefined` and the failure surfaces further from its cause than this
  // throw (measured: it reaches a live AWS call). Swept with the two
  // `resolveRef` arms because a template reaches all three by the same name.
  const resource = this.lookupResourceRecord(logicalId, 'Fn::GetAtt', context);
  if (!resource) {
    // `markNonRetryable` for the reason given at the `Invalid Fn::GetAtt
    // format` throw above: `logicalId` is template-controlled and the retry
    // classifiers match by bare substring, so `Throttling*` / `SlowDown*` /
    // `*DependencyViolation*` construct names turn this deterministic
    // refusal transient. Scoped to THIS cdkd-authored throw -- a transient
    // SDK error surfacing out of `reresolveCrossStackValue` below must stay
    // retryable, which is why the mark is here and not in the `Fn::Sub` catch.
    // THIS MESSAGE IS RE-PARSED, which makes sanitizing it a GATE decision and not only a display one
    // (go-to-k/cdkd#3432). `src/cli/commands/scrub.ts`'s `TEMPLATE_SHAPE_FAILURE_PATTERNS` holds
    // `/^Resource \S+ not found for Fn::GetAtt$/`, and a unit whose scan this error abandoned is
    // classified by whether that pattern matches: matching makes it a `warn`, missing makes it a `count`
    // that `cdkd scrub --dry-run --fail` gates on. The builder STRIPS and TRIMS, so an id carrying a CR
    // or padding -- which `\S+` could not span before -- matches now, and such a unit moves count ->
    // warn. That is the LENIENT direction and it is taken deliberately, for the reason go-to-k/cdkd#3426
    // recorded one pattern over on `Ref <id> not found`: a plain dangling `Fn::GetAtt` already warned, so
    // this opens no NEW bypass -- it extends an existing classification to ids differing from an ordinary
    // one only by characters nobody can see, and the alternative is a CI gate whose verdict depends on
    // invisible bytes in a logical id. Pinned in `tests/unit/cli/scrub-abandoned-scan-origin.test.ts`
    // beside its sibling, and the note in `scrub.ts` names both patterns.
    throw markNonRetryable(
      new Error(`Resource ${this.displayMasked(logicalId, context)} not found for Fn::GetAtt`)
    );
  }

  // Check if attribute exists in resource.attributes
  // For VPC Ipv6CidrBlocks, always use constructAttribute (dynamic fetch with retry)
  // because the stored value may be stale (empty array from before VPCCidrBlock association)
  const skipCachedAttribute =
    resource.resourceType === 'AWS::EC2::VPC' && attributeName === 'Ipv6CidrBlocks';

  if (!skipCachedAttribute && resource.attributes !== undefined) {
    // Flat-key lookup first (SDK providers store nested attributes as flat
    // dot-keys, e.g. `attributes['Endpoint.Port'] = '3306'`).
    // `Object.hasOwn` (issue #2767). `attributeName` is free-form template text
    // -- the only validation is `typeof === 'string'` -- and `attributes` comes
    // from `JSON.parse` of state.json, so `Fn::GetAtt: [R, "constructor"]` read
    // the `Object` function, passed the `!== undefined` test below, and was
    // returned as the attribute VALUE into a live property.
    const storedValue = Object.hasOwn(resource.attributes, attributeName)
      ? resource.attributes[attributeName]
      : undefined;
    // A pre-#3097 record for a security group declared without `VpcId`
    // holds `''` (the template's absent property, copied), and nothing
    // rewrites it on a no-change deploy; served here it would shadow the
    // live arm forever. Read it as ABSENT for this ONE attribute only.
    const flatValue = isImpossibleEmptyStoredAttribute(
      resource.resourceType,
      attributeName,
      storedValue
    )
      ? undefined
      : storedValue;
    if (flatValue !== undefined) {
      if (isStalePlaceholderArnAttribute(resource.resourceType, attributeName, flatValue)) {
        // A pre-#1681 placeholder is a STALE record like a missing key is, and
        // has the same no-change gap (issue #1852): the refusal's old remedy,
        // "deploy again so the next update heals it", never came true while
        // the resource's own properties did not change. Heal first; refuse —
        // with a remedy worded from what the heal observed — only when the
        // re-read cannot supply a usable ARN either.
        const outcome = await this.healStaleAttributes(logicalId, resource, context);
        const healed = this.usableHealedAttribute(outcome, attributeName);
        if (
          healed !== undefined &&
          !isStalePlaceholderArnAttribute(resource.resourceType, attributeName, healed)
        ) {
          return this.serveHealedAttribute(logicalId, attributeName, healed, context);
        }
        this.rejectPlaceholderArnAttribute(
          resource,
          attributeName,
          flatValue,
          logicalId,
          context,
          outcome
        );
      }
      // Earlier cdkd versions stored Route 53 HostedZone NameServers as a
      // comma-delimited string even though CloudFormation defines the
      // attribute as a list. Normalize that legacy state shape at the read
      // boundary so Fn::Join works without requiring users to recreate or
      // manually edit an existing state file.
      if (
        resource.resourceType === 'AWS::Route53::HostedZone' &&
        attributeName === 'NameServers' &&
        typeof flatValue === 'string'
      ) {
        const nameServers = flatValue === '' ? [] : flatValue.split(',');
        // Issue #2274 review: this branch ALSO serves a value out of the
        // PERSISTED `attributes` bag, so it takes the note like the two
        // below. It shipped without one, which is why this method's doc no
        // longer claims the pass-through shape makes a skip impossible.
        // Noted BEFORE the log line, as every serving branch here is
        // (go-to-k/cdkd#3659): see `noteAttributeSecrecy`'s ORDERING note.
        const notedNameServers = this.noteAttributeSecrecy(
          logicalId,
          attributeName,
          nameServers,
          context
        );
        this.logger.debug(
          `Normalized legacy Fn::GetAtt attribute: ${this.logRender(logicalId, context)}.${this.logRender(attributeName, context)} normalized to ${this.logRender(stringifyAttributeForLog(attributeName, this.maskValueLeaves(nameServers, context)), context, { structured: isStructured(nameServers), redacted: isSensitiveAttributeName(attributeName) })}`
        );
        return notedNameServers;
      }
      // The nested-stack dynamic-reference arm below re-resolves instead of
      // taking the note, so the predicate is bound once for both uses.
      const reresolvesNestedReference =
        resource.resourceType === NESTED_STACK_RESOURCE_TYPE &&
        attributeName.startsWith(NESTED_STACK_OUTPUT_ATTRIBUTE_PREFIX) &&
        carriesDynamicReference(flatValue);
      // Noted BEFORE the log line (go-to-k/cdkd#3659): the note is what puts
      // a `NoEcho` value into the CONSUMER's bag, and the line masks against
      // that bag, so logging first printed the plaintext at `--verbose`.
      const notedFlatValue = reresolvesNestedReference
        ? flatValue
        : this.noteAttributeSecrecy(logicalId, attributeName, flatValue, context);
      this.logger.debug(
        `Resolved Fn::GetAtt from attributes: ${this.logRender(logicalId, context)}.${this.logRender(attributeName, context)} resolved to ${this.logRender(stringifyAttributeForLog(attributeName, this.maskValueLeaves(flatValue, context)), context, { structured: isStructured(flatValue), redacted: isSensitiveAttributeName(attributeName) })}`
      );
      // A nested-stack child's outputs are read out of the child's PERSISTED
      // state by `NestedStackProvider`, which since PR #1899 holds a
      // secret-bearing output as its unresolved `{{resolve:...}}` expression
      // — so `{"Fn::GetAtt": ["Child", "Outputs.DbPassword"]}` used to reach
      // AWS as that literal token (issue #2055). Same class as #1934's
      // `Fn::ImportValue` / `Fn::GetStackOutput` arms, one reader further
      // out, so it takes the same helper rather than a fourth copy of the
      // walk.
      //
      // The log line above stays AHEAD of this re-resolution (the #1934
      // ordering rule), which is sound ONLY on this arm: here the value IS a
      // `{{resolve:...}}` token, so the line prints the token, never the
      // resolved value. Every other value served from this bag can be
      // plaintext -- a child output the #2274 in-run recovery handed back is
      // one -- which is why it takes the note BEFORE the line above
      // (go-to-k/cdkd#3659).
      //
      // The producer region is the CHILD's, read off the synthesized
      // `arn:cdkd-local:<childRegion>:...` physicalId `NestedStackProvider`
      // recorded — a secret NAME is regional, so the consumer's own region
      // can answer with a different secret. `undefined` (an unparseable or
      // hand-edited id) falls back to this resolver, which is the pre-fix
      // region and still strictly better than shipping the token.
      //
      // `sourceKey` is computed from the RAW `Fn::GetAtt` argument — the leaf
      // exactly as authored, BEFORE the intrinsic attribute-name resolution
      // above — because the persist path holds the unresolved template and
      // must derive the identical string from that same leaf
      // (`crossStackSourceKey`, issue #2059). The first cut passed
      // `undefined` here, which is that method's documented refusal
      // fall-back; it is not a neutral one. Falling back means the persist
      // path positions this leaf through the plaintext-keyed value scan, and
      // a child exporting `Cur` (`:AWSCURRENT`) and `Prev` (`:AWSPREVIOUS`)
      // of ONE rotating secret has both outputs resolve EQUAL during the
      // `AWSPENDING` window: `recordedSecretValues` collapses them, both
      // parent properties persist the survivor's expression, and
      // `resolveReplayProps` then applies the WRONG stage to the live
      // resource on a rollback or a `cdkd drift --revert`. That is the same
      // failure #2059 closed one reader further in, so it takes the same
      // key rather than a fourth positioning rule.
      //
      // A leaf the key function refuses — a non-literal attribute name, an
      // arity the resolver would not accept — still yields `undefined` and
      // still inherits today's behaviour.
      if (reresolvesNestedReference) {
        return await this.reresolveCrossStackValue(
          flatValue,
          nestedStackChildRegionFromLocalArn(resource.physicalId),
          context,
          `nested stack ${logicalId} ${this.displayLeaf(attributeName, context)}`,
          crossStackSourceKey({ 'Fn::GetAtt': getAtt })
        );
      }
      return notedFlatValue;
    }

    // Issue #381: nested-path fallback. CC API providers store CFn nested
    // attributes as actual nested objects (`attributes.Endpoint.Port`),
    // so a flat-key lookup for `Endpoint.Port` misses and the resolver
    // would otherwise fall through to `constructAttribute`'s
    // physicalId default. Walk the dot-separated path against the
    // attributes object before that fallback. Examples covered:
    // `AWS::RDS::DBCluster.Endpoint.Port`,
    // `AWS::RDS::DBCluster.Endpoint.Address`,
    // `AWS::RDS::DBCluster.ReadEndpoint.Address`,
    // `AWS::CloudFront::Distribution.DomainName` (no nesting, still
    // hits flat-key path), `AWS::ApiGateway::Method.MethodResponses`
    // (also no nesting).
    if (attributeName.includes('.')) {
      const parts = attributeName.split('.');
      let cursor: unknown = resource.attributes;
      for (const part of parts) {
        // `Object.hasOwn` for the same reason as the flat read above (issue
        // #2767): `Fn::GetAtt: [R, "Endpoint.constructor"]` walked into
        // `Object.prototype` and returned the function it found there.
        if (
          cursor &&
          typeof cursor === 'object' &&
          Object.hasOwn(cursor as Record<string, unknown>, part)
        ) {
          cursor = (cursor as Record<string, unknown>)[part];
        } else {
          cursor = undefined;
          break;
        }
      }
      if (cursor !== undefined) {
        // Noted BEFORE the log line (go-to-k/cdkd#3659); see the flat read.
        const notedCursor = this.noteAttributeSecrecy(logicalId, attributeName, cursor, context);
        this.logger.debug(
          `Resolved Fn::GetAtt from nested attributes: ${this.logRender(logicalId, context)}.${this.logRender(attributeName, context)} resolved to ${this.logRender(stringifyAttributeForLog(attributeName, this.maskValueLeaves(cursor, context)), context, { structured: isStructured(cursor), redacted: isSensitiveAttributeName(attributeName) })}`
        );
        // NO nested-stack re-resolution arm here, unlike the flat-key lookup
        // above, and that is a REACHABILITY claim rather than a decision:
        // `NestedStackProvider.buildOutputsAttributes` is the only writer of
        // an `Outputs.<Key>` attribute and it writes FLAT dot-keys, so a
        // redacted child output can never be served from this walk. A second
        // writer that stored those outputs as a nested object would need this
        // arm too, or it would ship the literal `{{resolve:...}}` token to AWS
        // — the very defect issue #2055 closed one branch up.
        //
        // The `NoEcho` note (issue #2274) IS applied here, unlike the
        // nested-stack arm above, and for the opposite reason: a custom
        // resource's `Data` is written into `attributes` verbatim, so a
        // handler answering `{"Data": {"Endpoint": {"Password": "..."}}}`
        // lands a sensitive leaf on exactly this walk. Serving one branch and
        // not the other is how a redaction ships half-applied.
        return notedCursor;
      }
    }
  }

  // Construct attribute value based on resource type
  // A nested stack's outputs are known EXACTLY -- `NestedStackProvider` writes
  // one flat `Outputs.<Key>` attribute per output the child actually declared
  // -- so an `Outputs.` attribute that reached here names an output that does
  // not exist (issue #2270 round 3). Falling through would be silently wrong
  // rather than merely unhelpful: `constructAttribute` has NO
  // `AWS::CloudFormation::Stack` case, so it lands on
  // `guardedPhysicalIdFallback`, whose ARN-shape test is
  // `!physicalId.startsWith('arn:')` -- and a nested stack's physical id is
  // the SYNTHETIC `arn:cdkd-local:<region>:<account>:nested-stack/<parent>/<id>`,
  // which starts with `arn:`. So the #1103 guard PASSES and a free-text
  // property (an SSM value, a tag, an env var) accepts that bogus
  // `cdkd-local` partition with a green deploy. Suffix matching cannot see
  // this -- measured -- because the value is ARN-shaped for an `*Arn`
  // attribute and the attribute here is usually not `*Arn` at all; the type
  // plus the `Outputs.` prefix is what identifies it.
  //
  // This became REACHABLE for the string spelling in this PR: it previously
  // threw `Invalid Fn::GetAtt format` before ever looking the resource up.
  // The array spelling could always reach it.
  //
  // `markNonRetryable` (issue #1838): the verdict is read off a PERSISTED
  // state record that no retry of this deploy rewrites, and the message
  // interpolates template-controlled names into a string the retry
  // classifiers match by bare substring.
  if (
    resource.resourceType === NESTED_STACK_RESOURCE_TYPE &&
    attributeName.startsWith(NESTED_STACK_OUTPUT_ATTRIBUTE_PREFIX)
  ) {
    // Each listed name through the twin of its WHOLE attribute key (issue
    // #3150): a key an earlier write of this pass assembled around a short
    // secret is registered under `Outputs.<name>`, and the sliced name alone
    // has no twin of its own. Sorting the whole keys sorts the names.
    const declared = Object.keys(resource.attributes ?? {})
      .filter((k) => k.startsWith(NESTED_STACK_OUTPUT_ATTRIBUTE_PREFIX))
      .sort()
      .map((k) => this.displayMasked(this.outputNameLogText(k, context), context));
    const declaredText = declared.length > 0 ? declared.join(', ') : '(none)';
    // Bound once because the message renders it TWICE (go-to-k/cdkd#3432). Two independent
    // `this.displayMasked(logicalId, context)` calls would also be correct, but a single binding is what
    // keeps the two spellings from drifting apart -- the shape the mask-coverage checker's identifier
    // resolution reads at both interpolations.
    const loggedLogicalId = this.displayMasked(logicalId, context);
    throw markNonRetryable(
      new IntrinsicResolutionRefusalError(
        // MASKED (issue #2827 review). `attributeName` here is
        // `resolvedAttributeName` from `resolveValue`, the SAME binding this
        // method's type refusal masks a few lines up — the sweep that built
        // this fix stopped at `throw new Error(` and missed both this
        // `markNonRetryable(new IntrinsicResolutionRefusalError(...))` and
        // the fabricated-account refusal below.
        `Cannot resolve Fn::GetAtt [${loggedLogicalId}, ${this.displayMasked(attributeName, context)}]: the nested stack ` +
          `${quotedRender(loggedLogicalId, "'")} declares no output named ` +
          `${quotedRender(this.displayMasked(this.outputNameLogText(attributeName, context), context), "'")}. ` +
          `Its outputs are ${this.displayMasked(declaredText, context)}. ` +
          `Check the output name in the nested stack's template, and deploy the child ` +
          `stack again if you have just added it.`
      )
    );
  }

  const value = await this.constructWithStaleRecordHeal(
    resource,
    attributeName,
    context,
    logicalId
  );
  this.logger.debug(
    `Resolved Fn::GetAtt: ${this.logRender(logicalId, context)}.${this.logRender(attributeName, context)} resolved to ${this.logRender(stringifyAttributeForLog(attributeName, this.maskValueLeaves(value, context)), context, { structured: isStructured(value), redacted: isSensitiveAttributeName(attributeName) })}`
  );
  return value;
}

/**
 * Values state already holds in the clear that a `NoEcho` handler can echo
 * back (go-to-k/cdkd#2453): the region, the stack name, and — for a named
 * producer — its `ServiceToken` plus each `:`-separated segment of it (the
 * account id, the function name) and every literal string of its template
 * `Properties`. {@link recordFreshNoEchoValuesIn} keeps a
 * value EQUAL to one of them out of the containment arm, so an echoed region
 * or account id does not flatten every ARN of the reading resource.
 */
export function publicNoEchoTokens(
  this: IntrinsicFunctionResolver,
  context: ResolverContext,
  producer?: string
): ReadonlySet<string> {
  const tokens = new Set<string>([this.resolverRegion]);
  if (context.stackName !== undefined) tokens.add(context.stackName);
  const serviceToken =
    producer === undefined || !Object.hasOwn(context.resources, producer)
      ? undefined
      : context.resources[producer]?.properties?.['ServiceToken'];
  if (typeof serviceToken === 'string') {
    tokens.add(serviceToken);
    for (const segment of serviceToken.split(':')) tokens.add(segment);
  }
  // The producer's LITERAL template inputs: a handler echoing
  // `event.ResourceProperties` returns them verbatim, and the template is
  // public. A literal carrying a `{{resolve:` is skipped: what the handler
  // saw was its resolved secret, not this text.
  const resources = context.template.Resources ?? {};
  if (producer !== undefined && Object.hasOwn(resources, producer)) {
    const walk = (node: unknown): void => {
      if (typeof node === 'string') {
        if (!node.includes('{{resolve:')) tokens.add(node);
        return;
      }
      if (node === null || typeof node !== 'object') return;
      for (const child of Object.values(node as Record<string, unknown>)) walk(child);
    };
    walk(resources[producer]?.Properties);
  }
  return tokens;
}

/**
 * Note what SECRECY the attribute just read carries, then hand it back
 * UNCHANGED (issue [#2274](https://github.com/go-to-k/cdkd/issues/2274)).
 *
 * Two independent notes, in the two directions a `NoEcho` custom-resource
 * `Data` value travels, and they are on one function because both are read
 * off the same value at the same instant:
 *
 * 1. **This run's fresh value.** If a provider declared this resource's
 *    attributes `NoEcho` earlier in THIS deploy, every string leaf becomes a
 *    MASK-ONLY needle in the CONSUMER's own bag, so the plaintext this
 *    resolution is about to substitute into the dependent's properties is
 *    masked when that record is persisted. Registering into
 *    `context.recordedSecretValues` — the consumer's bag — rather than the
 *    producer's is what makes it work at all: `perResourceSecrets` is keyed by
 *    LOGICAL ID, so a needle recorded under the custom resource's own id is
 *    not in the bag the DEPENDENT's record is scrubbed with.
 * 2. **A previous run's masked value.** If what came back IS the mask, this
 *    attribute was redacted into `state.json` by an earlier deploy and cdkd
 *    cannot recover it (there is no durable `NoEcho` flag and no expression to
 *    re-resolve — issue #2449). It is recorded as a redacted READ so the
 *    deploy engine can refuse to push the literal `***` to AWS.
 *
 * IT RETURNS THE VALUE, and passing through rather than mutating in place is
 * the point: a new attribute-serving branch is written as `return
 * this.noteAttributeSecrecy(...)` by imitation of the two that have it.
 * `Fn::GetAtt` must keep delivering the REAL value (CloudFormation does,
 * measured), so this can never rewrite what it is handed.
 *
 * IT IS NOT A GUARANTEE, and an earlier revision claimed it was ("impossible
 * to add a third branch that silently skips the note"). Nothing in the type
 * system stops a branch returning a value it never passed through here, and
 * one already did: the Route 53 `NameServers` legacy-shape normalization,
 * which reads the SAME persisted `attributes` bag and shipped without the
 * note (it takes it now). The rule the note actually needs is about the
 * SOURCE of the value — every branch serving one out of a PERSISTED
 * `attributes` bag must call this, and so must one serving (or embedding) a
 * persisted `properties` leaf, which a mask-only needle masks whole
 * (go-to-k/cdkd#2936: the VPC `CidrBlock` and Events rule `Arn` arms) — and
 * that is not a shape a compiler can enforce. `constructGuardedAttribute`'s return is deliberately outside it:
 * that value is fetched from AWS in this run, not read back from state, so
 * it can be neither a stale mask nor a value a provider declared `NoEcho`.
 *
 * A context supplying NEITHER field — the diff / no-op resolver, `cdkd
 * scrub`, `cdkd import` — pays two undefined checks and gets its value back.
 *
 * ORDERING: call it BEFORE any log line that prints the value
 * (go-to-k/cdkd#3659). Note 1 is what puts a `NoEcho` value into the bag
 * `displayMasked` masks against, so a line logged first prints the plaintext
 * at `--verbose`.
 */
export function noteAttributeSecrecy(
  this: IntrinsicFunctionResolver,
  logicalId: string,
  attributeName: string,
  value: unknown,
  context: ResolverContext
): unknown {
  const declared = context.noEchoAttributeResources?.get(logicalId);
  const attributeIsDeclared =
    declared === true || (declared !== undefined && declared.has(attributeName));
  if (attributeIsDeclared && context.recordedSecretValues) {
    // FRESH (go-to-k/cdkd#3662): declared by a provider in THIS deploy.
    recordFreshNoEchoValuesIn(
      value,
      context.recordedSecretValues,
      undefined,
      this.publicNoEchoTokens(context, logicalId)
    );
  }
  // The bag test stays HERE as well as inside `pushRedactedAttributeRead`:
  // a bagless context (the diff / no-op resolver, `cdkd scrub`, `cdkd
  // import`) must not pay for `displayMasked` on the hot path.
  if (context.redactedAttributeReads !== undefined && carriesSecretMask(value)) {
    // Masked for the reason the `origin` pusher states (issue #2827 review
    // round 2): `attributeName` is `resolveGetAtt`'s resolved one, and this
    // array is joined into a default-verbosity throw by the deploy engine.
    // THE FIELD AND THE DISPLAY NOW DIVERGE, deliberately (go-to-k/cdkd#3432).
    //
    // `logicalId` the FIELD stays raw: it is the routing key
    // `DeployEngine.maskedRecordRemedyFor` partitions on and the id its
    // `--resource <id>=` command interpolates, so a sanitized copy there
    // would be a different id.
    //
    // `display` is SANITIZED, which go-to-k/cdkd#3426 review round 3 raised
    // and deferred. The deferral rested on two claims, and BOTH were
    // re-measured before this change rather than inherited:
    //
    //  - "`displayIdent` quotes an id containing a space, breaking
    //    `intrinsic-ref-state-mask.test.ts`'s deliberate collision with
    //    `noteRefStateMask`'s rendering" — TRUE, which is why the remedy here
    //    is `displayMasked`, not `displayIdent`. The builder strips and
    //    `displaySafe`s without quoting or bounding, so `Ref Foo` and
    //    `Foo.Bar` render byte-identically to before and that fixture's
    //    collision survives. Both sites take it, so the two halves stay
    //    comparable.
    //  - "the sibling's spelling is PARSED by
    //    `DeployEngine.maskedRecordRemedyFor`" — NO LONGER TRUE, and that is
    //    what unblocks the pair. That helper's round-4 review moved its
    //    partition off a regex over `display` and onto the `kind` /
    //    `logicalId` FIELDS ("THE ROUTING KEY IS THE FIELD, not a capture
    //    group"); `targetOf` reads `read.logicalId`. Re-derived from the
    //    READERS rather than from the call graph: the only readers of
    //    `display` in `src` are this file's whole-tuple de-dup comparison and
    //    two `.join(', ')` message builders in `deploy-engine.ts`. Nothing
    //    re-parses it.
    const maskedAttributeName = this.displayMasked(attributeName, context);
    this.pushRedactedAttributeRead(context, {
      kind: 'attribute',
      logicalId,
      key: maskedAttributeName,
      display: `${this.displayMasked(logicalId, context)}.${maskedAttributeName}`,
    });
  }
  return value;
}

/**
 * Refuse a pre-#1681 PLACEHOLDER ARN served from the cached attribute map
 * (issue #1729) — the `Fn::GetAtt` half of the guard
 * {@link cfnRefValueFromPhysicalId} applies to `Ref`.
 *
 * `Ref` and `Fn::GetAtt` read the SAME recorded attribute, and #1681 treated
 * only the `Ref` side: for an `AWS::AppSync::*` child created by a pre-#1681
 * binary, `{"Fn::GetAtt": ["MyDataSource", "DataSourceArn"]}` still resolved
 * to `arn:aws:appsync:*:*:apis/.../datasources/...` — structurally valid,
 * unusable, and indistinguishable downstream from a real ARN.
 *
 * Scoped to the {@link REF_RETURNS_ARN_FROM_STATE} types AND their declared
 * ARN attribute names, the narrowest form of the fix: a wildcard-bearing ARN
 * is only KNOWN to be a placeholder for these three attributes, and some
 * other type could legitimately cache an ARN-shaped string carrying a `*` in
 * a position {@link isPlaceholderArn} inspects. Every other attribute of
 * these same types (`AWS::AppSync::ApiKey`'s `ApiKey`,
 * `AWS::AppSync::DataSource`'s `Name`) is untouched.
 *
 * THROWS rather than degrading, which is where it diverges from the `Ref`
 * half, and deliberately: `Ref`'s fallback is the raw compound id, whereas
 * the value here is requested under an ARN-suffixed attribute name, so
 * handing back a non-ARN would be exactly the shape mismatch
 * {@link guardedPhysicalIdFallback} already hard-fails on (the #1103 class —
 * a green deploy that ships a wrong value into stack Outputs / an IAM
 * policy). A resource in this state has no correct value to serve, so the
 * honest answer is to say so and name the remedy: the record heals on the
 * resource's next in-place update (#1727).
 */
export function rejectPlaceholderArnAttribute(
  this: IntrinsicFunctionResolver,
  resource: ResourceState,
  attributeName: string,
  value: unknown,
  logicalId: string,
  // Issue [#2827](https://github.com/go-to-k/cdkd/issues/2827) review round 2:
  // the third site spelled `markNonRetryable(new
  // IntrinsicResolutionRefusalError(...))`, missed by two sweeps that grepped
  // `throw new`. Its `attributeName` is `resolveGetAtt`'s resolved one, and
  // `value` is a PERSISTED attribute, so both need a bag.
  context?: ResolverContext,
  // What the #1852 heal observed before this refusal, so the remedy is true
  // on the path taken. `undefined` = no healer on this context, i.e. nothing
  // was re-read.
  healOutcome?: StaleAttributeHealOutcome
): void {
  if (!isStalePlaceholderArnAttribute(resource.resourceType, attributeName, value)) return;
  // Terminal (issue #1838 / #1874 review): the verdict is read off the
  // PERSISTED state record, which no retry of this deploy rewrites — the
  // placeholder only heals on the resource's next in-place update, i.e. a
  // LATER deploy. Marked because the message interpolates `logicalId`, and
  // the retry classifiers match by substring, so an ordinary composite CDK
  // id can otherwise make a deterministic refusal look transient. See
  // `resolveSplit` for the nested-stack chain that makes this reachable.
  // not-in-class(resource.resourceType): reached only when the type is a KEY of
  // REF_RETURNS_ARN_FROM_STATE (a whole-string `Map` lookup), so it is one of
  // that map's literals and carries no control character (issue #3441).
  throw markNonRetryable(
    new IntrinsicResolutionRefusalError(
      `Cannot resolve Fn::GetAtt [${this.displayMasked(logicalId, context)}, ${this.displayMasked(attributeName, context)}] for ` +
        `${resource.resourceType}: the recorded value ${quotedRender(stringifyValue(this.maskValueLeaves(value, context)), '"')} is a placeholder ` +
        `written by a cdkd version older than issue #1681 — its region and account ` +
        `fields are literal wildcards, so it is not a usable ARN. ` +
        this.staleRecordRemedy(healOutcome, context)
    )
  );
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
 * Construct resource attribute value based on resource type, refusing to
 * SERVE one built from a fabricated account id (issue #1730).
 *
 * Thin wrapper over {@link constructAttribute}. ~30 branches there
 * build `arn:<partition>:<svc>:<region>:<accountId>:...`, and when the account
 * id is the hardcoded `123456789012` fallback the result is an ARN naming
 * SOMEONE ELSE'S account with no wildcard in it — so `isPlaceholderArn` cannot
 * catch it and every consumer downstream, the state record included, receives
 * a confidently wrong value. Refusing matches how
 * {@link guardedPhysicalIdFallback} already treats a knowably-wrong `*Arn`
 * (the #1103 class): a resource in this state has no correct value to serve.
 *
 * The test is on the CONSTRUCTED VALUE, not on the attribute NAME, and that
 * precision is the whole point: `AWS::S3::Bucket`'s `Arn` is
 * `arn:aws:s3:::<bucket>` with no account field, so a name-based `*Arn` guard
 * would refuse a value the fabricated id cannot corrupt. Everything the
 * account id does not appear in — `DomainName`, `Endpoint`, `WebsiteURL` —
 * keeps resolving unchanged.
 *
 * The match is a BARE substring rather than the colon-delimited `:<id>:` an
 * ARN uses, because not every account embedding is an ARN field: PR review
 * caught `AWS::ECR::Repository`'s `RepositoryUri`
 * (`<accountId>.dkr.ecr.<region>.amazonaws.com/<repo>`), the one such site in
 * this method, where a colon-delimited test served the fabricated URI and
 * silently nullified the `CloudControlProvider` omission of the SAME
 * attribute. The direction is deliberately fail-SAFE: refusing is the honest
 * answer whenever cdkd cannot confirm the account, so a value that merely
 * CONTAINS the placeholder digits (a physicalId recorded against the AWS
 * documentation account) is refused rather than served — and only while STS
 * is failing, when the deploy has bigger problems.
 *
 * NOTE the naming: the per-type construction below KEEPS the name
 * `constructAttribute` and this guard takes a new one, rather than the other
 * way round. `scripts/gen-sdk-attr-coverage.ts` collects the set of resource
 * types `constructAttribute` references to decide which `*Arn` attributes the
 * resolver can already answer, so renaming that method emptied its walk and
 * the critic reported fresh `gap`s for CloudTrail Trail / RDS DBCluster /
 * DBInstance (measured — the first cut of this change did exactly that).
 */
export async function constructGuardedAttribute(
  this: IntrinsicFunctionResolver,
  resource: ResourceState,
  attributeName: string,
  context: ResolverContext,
  logicalId: string
): Promise<unknown> {
  const accountInfo = await getAccountInfo(this.resolverRegion);
  const value = await this.constructAttribute(
    resource,
    attributeName,
    context,
    logicalId,
    accountInfo
  );
  if (accountInfo.fabricated && embedsAccountId(value, accountInfo.accountId)) {
    // not-in-class(accountInfo.accountId): an AWS ACCOUNT ID from STS, never a resolved template value.
    throw new IntrinsicResolutionRefusalError(
      // `attributeName` masked for the reason its nested-stack sibling above
      // states (issue #2827 review). The type too (issue #3441): this guard
      // vets EVERY constructed value, and for a type no arm matched that
      // value is the physical id, so the type is arbitrary template text.
      `Cannot resolve Fn::GetAtt [${this.displayMasked(logicalId, context)}, ${this.displayMasked(attributeName, context)}] for ${this.displayMasked(resource.resourceType, context)}: ` +
        `STS did not report this deploy's account id, so cdkd would build the value from the ` +
        `placeholder account ${accountInfo.accountId} — structurally valid, naming a different ` +
        `account, and indistinguishable downstream from a real one. Fix the AWS credentials ` +
        `(or set AWS_ACCOUNT_ID to this deploy's account) and deploy again.`
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

/**
 * The per-resource-type attribute construction itself.
 *
 * Many CloudFormation attributes are not returned by Cloud Control API,
 * so we need to construct them manually.
 *
 * Reached only through {@link constructGuardedAttribute}, which vets the
 * result. Keep this method's NAME — `scripts/gen-sdk-attr-coverage.ts` reads
 * the resource types it references.
 */
export async function constructAttribute(
  this: IntrinsicFunctionResolver,
  resource: ResourceState,
  attributeName: string,
  // No longer unused (issue #2827 review): the three EC2 fallback warns below
  // interpolate `attributeName`, which is `resolveValue`'s result, so they
  // need a bag to mask against. Renamed from `_context` rather than left
  // underscored, because an underscored-but-read parameter is the shape a
  // future reader trusts to be inert.
  context: ResolverContext,
  logicalId: string,
  accountInfo: AwsAccountInfo
): Promise<unknown> {
  const { resourceType, physicalId } = resource;
  // The region is FOLDED once, here, rather than at each of the ~40 ARN / URI
  // constructions below (issue #1850). `accountInfo.region` is whatever
  // spelling the caller supplied (`--region || AWS_REGION || 'us-east-1'`);
  // the SOURCE now folds
  // (`effectiveAccountInfoRegion`, issue #1882), so this local fold is defense
  // in depth rather than the only one. Both are kept: double-folding is a
  // no-op, and an earlier revision of this comment called the region "folded
  // nowhere", which is exactly the claim that goes stale silently. The
  // reachability it also claimed -- that `cdkd deploy --region US-EAST-1`
  // SUCCEEDS because DNS is case-insensitive -- is FALSE and was corrected
  // with issue #1882's measurement -- but the mechanism is the
  // opposite of "it fails": `foldRegionOption` folds `--region` and
  // `AWS_REGION` at every handler's entry (issue #2065) and `AwsClients`
  // folds again, so the flag is CANONICAL before it can reach anything. It
  // never dies, because a raw spelling never gets that far. (It would if it
  // did: SigV4 compares a credential's region scope case-sensitively.) What
  // IS reachable is a Cloud Assembly carrying a raw region in its
  // `environment` string, which cdkd accepts and whose clients it folds.
  // Every value built here -- `arn:aws:sns:US-EAST-1:...`, a
  // `<acct>.dkr.ecr.US-EAST-1.amazonaws.com/...` registry host -- would
  // otherwise be one no IAM policy matches (policy matching IS
  // case-sensitive) and every SDK call taking it rejects. Folding at the
  // DESTRUCTURE rather than per site is what
  // makes it exhaustive WITHIN THIS METHOD: a constructed attribute added
  // later inherits it instead of having to remember. `partition` needs no
  // fold — `derivePartitionAndUrlSuffix` canonicalizes its own input (issue
  // #1795) — and double-folding is a no-op, so the two are safe side by side.
  //
  // "Exhaustive" is scoped to this METHOD on purpose, because the sibling
  // sites are not covered and pretending otherwise is how the next reader
  // stops looking: `resolvePseudoParameter`'s `AWS::StackId` folds
  // SEPARATELY (a few hundred lines down), `AWS::Region` now folds at its
  // SOURCE instead (`effectiveAccountInfoRegion`, issue #1882 — the CFn A/B
  // that note was waiting on found that a non-canonical region never reaches
  // CloudFormation at all), and six SDK providers build ARNs from
  // `client.config.region()` rather than from `accountInfo.region` and so are
  // unreachable from here at all — that source is folded by `AwsClients`'
  // constructor for a bag CONFIGURED with a region, not by this destructure
  // (issue #1881). A region-less bag resolves from the SDK's own chain
  // instead, which is why the CLI boundary folds the env vars too.
  //
  // The five S3 branches below pass this region OUT to `s3-endpoints.ts`,
  // which folds again on entry — deliberately, not redundantly. That module
  // has a SECOND caller (`S3BucketProvider.buildAttributes`, what lands in
  // state) that still hands it a raw `client.config.region()`, so folding
  // only here would make the resolver's `Fn::GetAtt` answer disagree with
  // `readCurrentState` — the exact phantom drift that module exists to
  // prevent (#1745).
  const { accountId, partition } = accountInfo;
  const region = canonicalizeRegion(accountInfo.region);

  // DynamoDB Table / GlobalTable (CDK TableV2 synthesizes as AWS::DynamoDB::GlobalTable; ARN format is identical)
  if (resourceType === 'AWS::DynamoDB::Table' || resourceType === 'AWS::DynamoDB::GlobalTable') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:dynamodb:${region}:${accountId}:table/${physicalId}`;
      case 'StreamArn':
        // Not buildable from the table name. Heal first (issue #3627): a
        // record imported before `import()` read it back lacks it, and
        // answering here never reached the #1852 re-read.
        this.healBeforeConstructing(context);
        this.refuseUnconstructibleAttribute({
          logicalId,
          attributeName,
          resourceType,
          context,
          why: 'cdkd cannot build it from the table name',
          // The commonest way here is a table with no StreamSpecification:
          // it has no stream, so no re-read or re-import can produce one.
          remedyWhenHealCompleted:
            'A table with no StreamSpecification has no stream, and CloudFormation cannot ' +
            'return a StreamArn for it either: add a StreamSpecification to the table. If ' +
            'it already has one, change any property of the table so its next update ' +
            're-records the attributes.',
        });
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // S3 Bucket
  if (resourceType === 'AWS::S3::Bucket') {
    switch (attributeName) {
      case 'Arn':
        return s3BucketArn(physicalId, region);
      case 'DomainName':
        return s3BucketDomainName(physicalId, region);
      case 'RegionalDomainName':
        return s3BucketRegionalDomainName(physicalId, region);
      case 'DualStackDomainName':
        return s3BucketDualStackDomainName(physicalId, region);
      case 'WebsiteURL':
        return s3BucketWebsiteUrl(physicalId, region);
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // IAM Role
  if (resourceType === 'AWS::IAM::Role') {
    switch (attributeName) {
      case 'Arn':
        // The built ARN drops a non-`/` `Path`, so a record lacking `Arn` (one
        // imported before `import()` read it back) is re-read first; the
        // construction stays the answer when there is no heal (issue #3627).
        this.healBeforeConstructing(context);
        return `arn:${partition}:iam::${accountId}:role/${physicalId}`;
      case 'RoleId':
        // Not buildable from the role name: heal first (issue #3627).
        this.healBeforeConstructing(context);
        this.refuseUnconstructibleAttribute({
          logicalId,
          attributeName,
          resourceType,
          context,
          why: 'cdkd cannot build it from the role name',
        });
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // EC2 VPC - dynamic attributes (IPv6 CIDR requires DescribeVpcs after VPCCidrBlock association)
  if (resourceType === 'AWS::EC2::VPC') {
    switch (attributeName) {
      case 'VpcId':
        return physicalId;
      case 'CidrBlock':
        // Served out of the PERSISTED record, so it takes the note
        // (go-to-k/cdkd#2936). The operand that answers here is in practice
        // `properties`: `resolveGetAtt`'s flat lookup serves a PRESENT
        // `attributes.CidrBlock` first, with its own note. A whole-leaf
        // mask-only needle can still put `***` in `properties`, and served
        // unnoted it reaches the consumer's property with nothing recorded
        // for `refuseRedactedAttributeReads` to refuse.
        return this.noteAttributeSecrecy(
          logicalId,
          attributeName,
          resource.attributes?.['CidrBlock'] || resource.properties?.['CidrBlock'],
          context
        );
      case 'Ipv6CidrBlocks': {
        // Must fetch dynamically - IPv6 CIDR is added by VPCCidrBlock resource after VPC creation.
        // After CC API reports VPCCidrBlock CREATE success, the CIDR may still be in
        // 'associating' state. Retry up to 30s waiting for 'associated'.
        try {
          // Region-sensitive for the same reason as the `DescribeInstances`
          // / `DescribeLaunchTemplates` siblings below: a VPC id only
          // resolves in its own region, and a foreign-region client answers
          // `InvalidVpcID.NotFound`, which lands in the catch below and
          // degrades to an EMPTY list — a downstream `Fn::Select` on it then
          // fails, or a list-valued property ships empty. Routed through
          // `clientsForRegion` (issue #1994) rather than built here: the
          // per-call construction leaked one client + socket pool per
          // lookup and read `resolverRegion`, whose `AWS_REGION` /
          // `us-east-1` substitution is the FAIL-OPEN shape issue #1957
          // removed from the dynamic-reference lookups.
          const ec2 = this.clientsForRegion(this.explicitRegion).ec2;
          const maxAttempts = 15;
          // Through the builder (issue #3479): the id is read off the STATE
          // RECORD, which is not always AWS-assigned (`cdkd import --resource
          // <id>=<physicalId>`, a record another binary or a hand edit
          // wrote), so being an id answers the secret question, not the
          // control-character one. Bound once for the five renders below.
          const loggedId = this.displayMasked(physicalId, context);
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const resp = await ec2.send(new DescribeVpcsCommand({ VpcIds: [physicalId] }));
            const associations = resp.Vpcs?.[0]?.Ipv6CidrBlockAssociationSet || [];
            const blocks = associations
              .filter((a) => a.Ipv6CidrBlockState?.State === 'associated')
              .map((a) => a.Ipv6CidrBlock);
            if (blocks.length > 0) {
              this.logger.debug(
                `Resolved VPC Ipv6CidrBlocks for ${loggedId}: ${this.displayMasked(JSON.stringify(this.maskValueLeaves(blocks, context)), context)}`
              );
              return blocks;
            }
            // Check if there are any associating CIDRs — if so, wait and retry
            const associating = associations.filter(
              (a) => a.Ipv6CidrBlockState?.State === 'associating'
            );
            if (associating.length === 0) {
              // No IPv6 CIDRs at all
              this.logger.debug(`No IPv6 CIDR associations found for VPC ${loggedId}`);
              return [];
            }
            // not-in-class(attempt): this loop's own counter, incremented by the `for` header — no template value can reach it.
            this.logger.debug(
              `VPC ${loggedId} IPv6 CIDR still associating (attempt ${attempt}/${maxAttempts}), waiting...`
            );
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
          this.logger.warn(
            `VPC ${loggedId} IPv6 CIDR did not reach 'associated' state after ${maxAttempts} attempts`
          );
          return [];
        } catch (error) {
          // The SDK message through the builder too: EC2's
          // `InvalidVpcID.NotFound` ECHOES the requested id, so sanitizing
          // only the id above would leave its copy in the message raw.
          // Rebuilt here rather than reusing `loggedId`, which the `try`
          // scopes away.
          this.logger.warn(
            `Failed to fetch VPC Ipv6CidrBlocks for ${this.displayMasked(physicalId, context)}: ${this.displayMasked(error instanceof Error ? error.message : String(error), context)}`
          );
          return [];
        }
      }
      case 'DefaultSecurityGroup': {
        // Reached only when the record OMITS the key: `resolveGetAtt`'s flat
        // lookup serves any present value first, `''` included.
        // `EC2Provider.createVpc` records the group id from a post-create
        // `DescribeSecurityGroups`, and omits the key when that read failed
        // (issue #3077), so this arm re-reads the same thing the provider
        // could not. It used to answer `attributes.DefaultSecurityGroup ||
        // physicalId` — the VPC id in a security-group position, with no
        // warning (issue #3096). A `vpc-...` can never satisfy an `sg-...`
        // slot, so a read that fails or finds nothing REFUSES instead;
        // unmarked, because the read can succeed on a retry.
        // The id goes into an EC2 FILTER value, and filters read `*` / `?`
        // as wildcards: a state record holding `vpc-*` would match every
        // VPC and serve another VPC's default group (#3096 security round).
        // Refused BEFORE the cache read AND the describe (the cache is keyed
        // by this id), and marked: the verdict is read off the persisted
        // record, which no retry rewrites, and the message interpolates the
        // logical id (#1838).
        if (!/^vpc-[0-9a-f]+$/.test(physicalId)) {
          throw markNonRetryable(
            new IntrinsicResolutionRefusalError(
              `Cannot resolve Fn::GetAtt [${this.displayMasked(logicalId, context)}, DefaultSecurityGroup] for AWS::EC2::VPC: the ` +
                `state record's physical id ${quotedRender(this.displayMasked(physicalId, context).slice(0, 64), '"')} ` +
                `is not a VPC id (vpc-<hex>), so cdkd will not use it as an EC2 filter value. Repair the ` +
                `record (cdkd import, or re-create the VPC) and deploy again.`
            )
          );
        }
        const cachedGroupId = cachedVpcDefaultSecurityGroups[physicalId];
        if (cachedGroupId !== undefined) return cachedGroupId;
        let groupId: string | undefined;
        try {
          const ec2 = this.clientsForRegion(this.explicitRegion).ec2;
          const resp = await ec2.send(
            new DescribeSecurityGroupsCommand({
              Filters: [
                { Name: 'vpc-id', Values: [physicalId] },
                { Name: 'group-name', Values: ['default'] },
              ],
            })
          );
          groupId = resp.SecurityGroups?.[0]?.GroupId;
        } catch (err) {
          this.refuseUnservedAttribute({
            logicalId,
            attributeName,
            resourceType,
            physicalId,
            context,
            observed: this.describeFailureObserved('DescribeSecurityGroups', err, context),
            remedy:
              'Fix the read (the vpc-id / group-name filtered DescribeSecurityGroups permission, or the region) and deploy again.',
          });
        }
        if (groupId) {
          cachedVpcDefaultSecurityGroups[physicalId] = groupId;
          return groupId;
        }
        this.refuseUnservedAttribute({
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context,
          observed: 'DescribeSecurityGroups found no group named "default" in the VPC',
          remedy: 'Check the VPC in the console, or reference the attribute from a later deploy.',
        });
      }
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // IAM Policy
  if (resourceType === 'AWS::IAM::Policy') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:iam::${accountId}:policy/${physicalId}`;
      case 'PolicyId':
        // Not an attribute of this type: the CloudFormation schema's only
        // read-only property is `Id`, so CloudFormation rejects this
        // Fn::GetAtt at template validation.
        this.refuseUndefinedAttribute({
          logicalId,
          attributeName,
          resourceType,
          context,
          defined: 'Id',
        });
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // IAM User
  if (resourceType === 'AWS::IAM::User') {
    switch (attributeName) {
      case 'Arn':
        // Path-less construction; heal first (issue #3627), as for the Role.
        this.healBeforeConstructing(context);
        return `arn:${partition}:iam::${accountId}:user/${physicalId}`;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // IAM Group
  if (resourceType === 'AWS::IAM::Group') {
    switch (attributeName) {
      case 'Arn':
        // Path-less construction; heal first (issue #3627), as for the Role.
        this.healBeforeConstructing(context);
        return `arn:${partition}:iam::${accountId}:group/${physicalId}`;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // IAM InstanceProfile
  if (resourceType === 'AWS::IAM::InstanceProfile') {
    switch (attributeName) {
      case 'Arn':
        // Path-less construction; heal first (issue #3627), as for the Role.
        this.healBeforeConstructing(context);
        return `arn:${partition}:iam::${accountId}:instance-profile/${physicalId}`;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // KMS Key
  if (resourceType === 'AWS::KMS::Key') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:kms:${region}:${accountId}:key/${physicalId}`;
      case 'KeyId':
        return physicalId;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // Cognito UserPool
  if (resourceType === 'AWS::Cognito::UserPool') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:cognito-idp:${region}:${accountId}:userpool/${physicalId}`;
      case 'UserPoolId':
        // The physical id IS the user pool id — a known-correct fallback,
        // so it must not route through the unknown-attribute guard.
        return physicalId;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // Kinesis Stream
  if (resourceType === 'AWS::Kinesis::Stream') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:kinesis:${region}:${accountId}:stream/${physicalId}`;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // EventBridge Rule. Custom event bus ARN: rule/{busName}/{ruleName};
  // default bus ARN: rule/{ruleName}. By the time constructAttribute runs,
  // properties.EventBusName (if templated) has been resolved to a literal
  // string or ARN by the deploy engine. Treat 'default' / unset as default bus.
  if (resourceType === 'AWS::Events::Rule') {
    switch (attributeName) {
      case 'Arn': {
        // The SDK provider stores the rule ARN as the physical id; only
        // construct an ARN when the stored id is a bare rule name.
        if (physicalId.startsWith('arn:')) {
          return physicalId;
        }
        // Noted before it is EMBEDDED (go-to-k/cdkd#2936's audit): the
        // built ARN holds a masked bus name as an inner span, which the
        // whole-leaf `carriesSecretMask` test cannot see, so the note has to
        // read the persisted leaf itself. Its OTHER half (a NoEcho-declared
        // resource's value becoming a mask-only needle) would therefore
        // register the bus name, not the built ARN; inert, since nothing
        // declares an Events rule NoEcho.
        const busRaw = this.noteAttributeSecrecy(
          logicalId,
          attributeName,
          resource.properties?.['EventBusName'],
          context
        );
        const bus = typeof busRaw === 'string' && busRaw && busRaw !== 'default' ? busRaw : '';
        // If EventBusName resolved to an ARN, extract the bus name segment
        const busName = bus.startsWith('arn:') ? bus.split('/').pop() || '' : bus;
        return busName
          ? `arn:${partition}:events:${region}:${accountId}:rule/${busName}/${physicalId}`
          : `arn:${partition}:events:${region}:${accountId}:rule/${physicalId}`;
      }
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // EventBridge EventBus
  if (resourceType === 'AWS::Events::EventBus') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:events:${region}:${accountId}:event-bus/${physicalId}`;
      case 'Name':
        return physicalId;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // EFS FileSystem
  if (resourceType === 'AWS::EFS::FileSystem') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:elasticfilesystem:${region}:${accountId}:file-system/${physicalId}`;
      case 'FileSystemId':
        return physicalId;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // Kinesis Data Firehose DeliveryStream
  if (resourceType === 'AWS::KinesisFirehose::DeliveryStream') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:firehose:${region}:${accountId}:deliverystream/${physicalId}`;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // CodeBuild Project
  if (resourceType === 'AWS::CodeBuild::Project') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:codebuild:${region}:${accountId}:project/${physicalId}`;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // CloudTrail Trail
  if (resourceType === 'AWS::CloudTrail::Trail') {
    switch (attributeName) {
      case 'Arn':
        // The SDK provider stores the trail ARN as the physical id; only
        // construct an ARN when the stored id is a bare trail name.
        if (physicalId.startsWith('arn:')) {
          return physicalId;
        }
        return `arn:${partition}:cloudtrail:${region}:${accountId}:trail/${physicalId}`;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // AppSync GraphQLApi (physicalId is the apiId)
  if (resourceType === 'AWS::AppSync::GraphQLApi') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:appsync:${region}:${accountId}:apis/${physicalId}`;
      case 'ApiId':
        return physicalId;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // `AWS::ApiGatewayV2::Api` (physicalId is the bare api id). The provider
  // RECORDS `ExecuteApiArn` on create / import / update (issue
  // [#2833](https://github.com/go-to-k/cdkd/issues/2833)), so the cached-attribute
  // read above answers for every resource cdkd has touched since. This
  // branch is for the ones it has NOT: a record written by an earlier
  // binary carries no `ExecuteApiArn`, and an API whose own properties are
  // unchanged diffs NO_CHANGE, so `update()` never runs and the heal never
  // fires — the HEADLINE case, since adding an `Fn::GetAtt` to a consumer
  // changes the consumer, not the API. Without this the read reached
  // `guardedPhysicalIdFallback`, which hard-throws on an `*Arn` whose
  // fallback is a bare api id (the #1179 class), and told the user to file
  // an issue for an attribute cdkd can construct from what it already holds.
  // Constructed rather than fetched: no ApiGatewayV2 API returns this ARN.
  // `constructGuardedAttribute` refuses the result when STS did not report
  // the real account, so a fabricated account cannot be baked in here any
  // more than in the provider's own builder.
  if (resourceType === 'AWS::ApiGatewayV2::Api') {
    switch (attributeName) {
      case 'ExecuteApiArn':
        return `arn:${partition}:execute-api:${region}:${accountId}:${physicalId}`;
      case 'ApiId':
        return physicalId;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // ServiceDiscovery namespaces (physicalId is the namespace id). All
  // three kinds share the ARN shape; the DNS kinds additionally expose
  // `HostedZoneId` (the Route 53 hosted zone AWS creates alongside the
  // namespace), which is NOT constructible — fetch it live and REFUSE on a
  // miss rather than falling back to the namespace id (a silently wrong
  // value baked into dependent resources) or answering `undefined` (which a
  // `Fn::Join` / `Fn::Sub` rendered as the text `undefined`, issue #4077).
  // `HttpNamespace` has no `HostedZoneId` in the CloudFormation schema.
  if (
    resourceType === 'AWS::ServiceDiscovery::PrivateDnsNamespace' ||
    resourceType === 'AWS::ServiceDiscovery::HttpNamespace' ||
    resourceType === 'AWS::ServiceDiscovery::PublicDnsNamespace'
  ) {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:servicediscovery:${region}:${accountId}:namespace/${physicalId}`;
      case 'Id':
        return physicalId;
      case 'HostedZoneId': {
        if (resourceType === 'AWS::ServiceDiscovery::HttpNamespace') {
          this.refuseUndefinedAttribute({
            logicalId,
            attributeName,
            resourceType,
            context,
            defined: 'Arn, Id',
          });
        }
        let hostedZoneId: string | undefined;
        try {
          const { GetNamespaceCommand } = await import('@aws-sdk/client-servicediscovery');
          // Region-sensitive: a namespace id only resolves in its own region
          // (issue #1994). See {@link serviceDiscoveryClient} for why this
          // one service is built here instead of read off the bag.
          const sd = await this.serviceDiscoveryClient();
          const resp = await sd.send(new GetNamespaceCommand({ Id: physicalId }));
          hostedZoneId = resp.Namespace?.Properties?.DnsProperties?.HostedZoneId;
        } catch (err) {
          // Unmarked (time-dependent): a throttled or denied read can
          // succeed on a later attempt. AWS's text stays behind --verbose
          // (`describeFailureObserved`), since `NamespaceNotFound` can echo
          // a state-record id (issue #3479).
          this.refuseUnservedAttribute({
            logicalId,
            attributeName,
            resourceType,
            physicalId,
            context,
            observed: this.describeFailureObserved('GetNamespace', err, context),
            remedy:
              'Fix the read (the servicediscovery:GetNamespace permission, or the region) and deploy again.',
          });
        }
        if (hostedZoneId) return hostedZoneId;
        this.refuseUnservedAttribute({
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context,
          observed: 'GetNamespace reported no DnsProperties.HostedZoneId for the namespace',
          remedy: 'Check the namespace in the Cloud Map console, and deploy again.',
        });
      }
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // ServiceDiscovery Service (physicalId is the service id)
  if (resourceType === 'AWS::ServiceDiscovery::Service') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:servicediscovery:${region}:${accountId}:service/${physicalId}`;
      case 'Id':
        return physicalId;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // CloudWatch Alarm (note: 'alarm:' separator, not '/')
  if (resourceType === 'AWS::CloudWatch::Alarm') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:cloudwatch:${region}:${accountId}:alarm:${physicalId}`;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // CloudWatch CompositeAlarm. CompositeAlarm has no SDK provider, so it is
  // routed via the Cloud Control API; its `Arn` is not always captured in
  // attributes, so synthesize it here. The ARN format is identical to a
  // metric alarm (`:alarm:<AlarmName>`), so it is fully derivable from the
  // physical id (the alarm name) — no AWS call is needed.
  if (resourceType === 'AWS::CloudWatch::CompositeAlarm') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:cloudwatch:${region}:${accountId}:alarm:${physicalId}`;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // RDS DBInstance (DocDB and Neptune share the same rds: service prefix and db: separator)
  if (
    resourceType === 'AWS::RDS::DBInstance' ||
    resourceType === 'AWS::DocDB::DBInstance' ||
    resourceType === 'AWS::Neptune::DBInstance'
  ) {
    switch (attributeName) {
      case 'DBInstanceArn':
      case 'Arn':
        return `arn:${partition}:rds:${region}:${accountId}:db:${physicalId}`;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // RDS DBCluster (DocDB and Neptune share the same rds: service prefix and cluster: separator)
  if (
    resourceType === 'AWS::RDS::DBCluster' ||
    resourceType === 'AWS::DocDB::DBCluster' ||
    resourceType === 'AWS::Neptune::DBCluster'
  ) {
    switch (attributeName) {
      case 'DBClusterArn':
      case 'Arn':
        return `arn:${partition}:rds:${region}:${accountId}:cluster:${physicalId}`;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // S3 Express Directory Bucket
  if (resourceType === 'AWS::S3Express::DirectoryBucket') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:s3express:${region}:${accountId}:bucket/${physicalId}`;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // Lambda Function
  if (resourceType === 'AWS::Lambda::Function') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:lambda:${region}:${accountId}:function:${physicalId}`;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // SQS Queue
  if (resourceType === 'AWS::SQS::Queue') {
    // Physical ID for SQS Queue is the queue URL
    // Extract queue name from URL: https://sqs.region.amazonaws.com/accountId/queueName
    let queueName = physicalId;
    if (physicalId.startsWith('https://')) {
      const parts = physicalId.split('/');
      queueName = parts[parts.length - 1] || physicalId;
    }

    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:sqs:${region}:${accountId}:${queueName}`;
      case 'QueueUrl':
        return physicalId; // Physical ID is already the queue URL
      case 'QueueName':
        return queueName;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // SNS Topic
  if (resourceType === 'AWS::SNS::Topic') {
    switch (attributeName) {
      // `SNSTopicProvider` and Cloud Control both record the topic ARN as
      // the physical id; a bare NAME is kept for any record that holds one.
      // Reading an ARN as a name served a doubled ARN and an ARN-valued
      // `TopicName`, with no warning (issue #3627).
      case 'TopicArn':
        return physicalId.startsWith('arn:')
          ? physicalId
          : `arn:${partition}:sns:${region}:${accountId}:${physicalId}`;
      case 'TopicName':
        return physicalId.startsWith('arn:') ? physicalId.split(':').pop() : physicalId;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // CloudWatch Logs Log Group
  if (resourceType === 'AWS::Logs::LogGroup') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:logs:${region}:${accountId}:log-group:${physicalId}:*`;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // ECR Repository
  if (resourceType === 'AWS::ECR::Repository') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:ecr:${region}:${accountId}:repository/${physicalId}`;
      case 'RepositoryUri':
        // The URL SUFFIX is derived for the same reason the partition is
        // (issue #1730 review): an ECR registry host is
        // `<acct>.dkr.ecr.<region>.amazonaws.com.cn` in `aws-cn`, so a
        // hardcoded `amazonaws.com` is the identical defect one field over —
        // and this is the very attribute whose account embedding the
        // fabricated-account guard had to be widened for.
        return `${accountId}.dkr.ecr.${region}.${derivePartitionAndUrlSuffix(region).urlSuffix}/${physicalId}`;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // ECS Cluster
  if (resourceType === 'AWS::ECS::Cluster') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:ecs:${region}:${accountId}:cluster/${physicalId}`;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // ECS Service — derive `Name` from the service ARN. The provider stores
  // the service ARN as the physical id (with an optional composite
  // `|<suffix>` used by some internal paths — readCurrentState's
  // `<clusterArn>|<serviceName>` form, and a `<serviceArn>|<clusterName>`
  // shape that has been observed at deploy time). Both shapes are
  // disambiguated by checking the LHS for `:service/`:
  //   - LHS is a service ARN (contains `:service/`) → last `/` segment
  //     is the service name (works for plain ARN and `<serviceArn>|x`).
  //   - LHS is a cluster ARN → the RHS after `|` is the service name
  //     (matches the import/readCurrentState `<clusterArn>|<serviceName>`
  //     format).
  if (resourceType === 'AWS::ECS::Service') {
    switch (attributeName) {
      case 'Name': {
        const pipeIdx = physicalId.indexOf('|');
        const left = pipeIdx >= 0 ? physicalId.substring(0, pipeIdx) : physicalId;
        if (left.includes(':service/')) {
          const lastSlash = left.lastIndexOf('/');
          return lastSlash >= 0 ? left.substring(lastSlash + 1) : physicalId;
        }
        if (pipeIdx >= 0) {
          return physicalId.substring(pipeIdx + 1);
        }
        return physicalId;
      }
      case 'ServiceArn': {
        // Documented GetAtt whose correct value IS the physicalId: the SDK
        // provider stores the service ARN as the physical ID, so return it
        // verbatim instead of routing through the guard — on imported /
        // legacy state without cached attributes, --strict-getatt would
        // otherwise reject a CORRECT fallback (review of issue #1111).
        // Compound `<a>|<b>` ids (import / readCurrentState shapes) are
        // disambiguated like `Name` above: the `:service/`-containing side
        // is the service ARN.
        const pipeIdx = physicalId.indexOf('|');
        if (pipeIdx < 0) return physicalId;
        const left = physicalId.substring(0, pipeIdx);
        if (left.includes(':service/')) return left; // <serviceArn>|<clusterName>
        // `<clusterArn>|<serviceName>`: the (new-format, long-ARN) service
        // ARN is `arn:...:service/<clusterName>/<serviceName>`, derivable
        // from the cluster ARN side.
        const clusterIdx = left.indexOf(':cluster/');
        if (clusterIdx < 0) return physicalId;
        const clusterName = left.substring(clusterIdx + ':cluster/'.length);
        const serviceName = physicalId.substring(pipeIdx + 1);
        return `${left.substring(0, clusterIdx)}:service/${clusterName}/${serviceName}`;
      }
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // EC2 Security Group
  if (resourceType === 'AWS::EC2::SecurityGroup') {
    switch (attributeName) {
      case 'GroupId':
        return physicalId; // Physical ID is already the group ID (sg-xxx)
      case 'VpcId': {
        // Reached only when the record OMITS the key: `resolveGetAtt`'s flat
        // lookup serves any present value first. `EC2Provider` records
        // `VpcId` from a post-create / post-update `DescribeSecurityGroups`
        // and omits the key when that read failed (issue #3097), so this arm
        // re-reads the same thing the provider could not. It used to answer
        // `undefined` (`// Would need API call`), which `Fn::Join` /
        // `Fn::Sub` render as the literal `'undefined'` — so a group declared
        // without `VpcId` (a hand-written L1 landing in the default VPC)
        // resolved to `''` from the record or `'undefined'` from here, where
        // CloudFormation answers the default VPC's id. A `sg-...` can never
        // satisfy a `vpc-...` slot, so a read that fails or finds nothing
        // REFUSES instead; unmarked, because the read can succeed on a retry.
        // The id is sent as a `GroupIds` member, not a filter, so `*` / `?`
        // carry no wildcard meaning there — the shape guard exists because
        // the id keys the cache below, and EC2 rejects a malformed id with
        // `InvalidGroupId.Malformed` anyway (#3125 pattern). Refused BEFORE
        // the cache read AND the describe, and marked: the verdict is read
        // off the persisted record, which no retry rewrites, and the message
        // interpolates the logical id (#1838).
        if (!/^sg-[0-9a-f]+$/.test(physicalId)) {
          throw markNonRetryable(
            new IntrinsicResolutionRefusalError(
              `Cannot resolve Fn::GetAtt [${this.displayMasked(logicalId, context)}, VpcId] for AWS::EC2::SecurityGroup: the ` +
                `state record's physical id ${quotedRender(this.displayMasked(physicalId, context).slice(0, 64), '"')} ` +
                `is not a security group id (sg-<hex>), so cdkd will not look it up. Repair the ` +
                `record (cdkd import, or re-create the security group) and deploy again.`
            )
          );
        }
        const cachedVpcId = cachedSecurityGroupVpcIds[physicalId];
        if (cachedVpcId !== undefined) return cachedVpcId;
        let vpcId: string | undefined;
        try {
          const ec2 = this.clientsForRegion(this.explicitRegion).ec2;
          const resp = await ec2.send(
            new DescribeSecurityGroupsCommand({ GroupIds: [physicalId] })
          );
          vpcId = resp.SecurityGroups?.[0]?.VpcId;
        } catch (err) {
          this.refuseUnservedAttribute({
            logicalId,
            attributeName,
            resourceType,
            physicalId,
            context,
            observed: this.describeFailureObserved('DescribeSecurityGroups', err, context),
            remedy:
              'Fix the read (the ec2:DescribeSecurityGroups permission, or the region) and deploy again.',
          });
        }
        if (vpcId) {
          cachedSecurityGroupVpcIds[physicalId] = vpcId;
          return vpcId;
        }
        this.refuseUnservedAttribute({
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context,
          observed: 'DescribeSecurityGroups reports no VpcId for the group',
          remedy:
            'Check the security group in the console, or reference the attribute from a later deploy.',
        });
      }
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // EC2 Subnet
  if (resourceType === 'AWS::EC2::Subnet') {
    switch (attributeName) {
      case 'SubnetId':
        return physicalId;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // EC2 Instance — IP / DNS / AZ attributes are AWS-assigned at launch and
  // are NOT derivable from the instance id, so they require a live
  // `DescribeInstances` lookup (cached per (physicalId, attribute) for the
  // deploy lifetime). Falling back to the physical id — as the previous
  // default did — handed the instance id to a downstream consumer expecting
  // an IP (e.g. an ELBv2 IP-target group registration, which rejects
  // `i-...` with `not a valid IPv4 address`).
  //
  // Reached only when the record OMITS the attribute: `resolveGetAtt`'s
  // flat lookup serves any stored value first, `''` included. Since issue
  // #3077 `EC2Provider` omits a public member only while the instance is
  // `pending` (a `--no-wait` create) and records a settled instance's
  // missing public address as the known `''` CloudFormation reports.
  if (resourceType === 'AWS::EC2::Instance') {
    switch (attributeName) {
      case 'InstanceId':
        // The physical id IS the instance id — a known-correct fallback,
        // so it must not route through the unknown-attribute guard.
        return physicalId;
      case 'PrivateIp':
      case 'PublicIp':
      case 'PrivateDnsName':
      case 'PublicDnsName':
      case 'AvailabilityZone': {
        const cacheKey = `${physicalId}#${attributeName}`;
        const cached = cachedEc2InstanceAttributes[cacheKey];
        if (cached !== undefined) {
          return cached;
        }
        let value: string | undefined;
        let stateName: string | undefined;
        try {
          // Region-sensitive: an instance id only resolves in its own region,
          // and a foreign-region client answers `InvalidInstanceID.NotFound`,
          // which lands in the catch below (issue #1957).
          const clients = this.clientsForRegion(this.explicitRegion);
          const response = await clients.ec2.send(
            new DescribeInstancesCommand({ InstanceIds: [physicalId] })
          );
          const instance = response.Reservations?.[0]?.Instances?.[0];
          stateName = instance?.State?.Name;
          switch (attributeName) {
            case 'PrivateIp':
              value = instance?.PrivateIpAddress;
              break;
            case 'PublicIp':
              value = instance?.PublicIpAddress;
              break;
            case 'PrivateDnsName':
              value = instance?.PrivateDnsName;
              break;
            case 'PublicDnsName':
              value = instance?.PublicDnsName;
              break;
            case 'AvailabilityZone':
              value = instance?.Placement?.AvailabilityZone;
              break;
          }
        } catch (err) {
          // The instance id is the WRONG value for every one of these
          // attributes, so a failed read is a refusal, not a fallback (issue
          // #3096). Unmarked: the read can succeed on a retry.
          this.refuseUnservedAttribute({
            logicalId,
            attributeName,
            resourceType,
            physicalId,
            context,
            observed: this.describeFailureObserved('DescribeInstances', err, context),
            remedy:
              'Fix the read (the ec2:DescribeInstances permission, or the region) and deploy again.',
          });
        }
        if (value !== undefined && value !== null && value !== '') {
          cachedEc2InstanceAttributes[cacheKey] = value;
          return value;
        }
        // The SAME three-state rule `EC2Provider.describedInstanceAttributes`
        // records by (issue #3077), through the ONE shared predicate
        // (`isSettledInstanceState`), applied at resolution time: a SETTLED
        // instance (any reported state but `pending`) with no public address
        // is a private-subnet instance, and CloudFormation answers `''` for
        // `PublicIp` / `PublicDnsName` there. It is a known value, so it is
        // cached like an address. Without this arm a `--no-wait` create in a
        // private subnet — whose record omits the pair and is never rewritten
        // by a no-change deploy — would refuse on every later resolution
        // (the residual that provider's doc comment tracked on #3096).
        const settled = isSettledInstanceState(stateName);
        if (settled && (attributeName === 'PublicIp' || attributeName === 'PublicDnsName')) {
          cachedEc2InstanceAttributes[cacheKey] = '';
          return '';
        }
        // Still `pending` (a `--no-wait` create read moments after launch),
        // or a settled instance with no private address / zone at all (a
        // terminated one, or a describe that returned no instance). Before
        // #3096 this warned `returning physical ID` and handed the instance
        // id to the consumer — an Output or an export carried it silently.
        // Nothing is cached: the next resolution re-describes, when the
        // instance may have settled. Unmarked for the same reason.
        // `stateName` is an EC2 state enum value (`pending` / `running` /
        // ...) from the describe, never a resolved template value.
        const observedState = stateName === undefined ? 'no instance state' : `state ${stateName}`;
        this.refuseUnservedAttribute({
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context,
          observed: `DescribeInstances reports no ${this.displayMasked(attributeName, context)} yet (${observedState})`,
          remedy: settled
            ? 'Check the instance in the console; a terminated or stopped instance has no such attribute to serve.'
            : 'Deploy without --no-wait so the instance is running before its attributes are read, or reference the attribute from a later deploy once it is.',
        });
      }
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // EC2 LaunchTemplate — `LatestVersionNumber` / `DefaultVersionNumber`
  // are AWS-derived integers that cdkd does not capture in state.
  // Resolve via `DescribeLaunchTemplates`. Return as a string so
  // downstream consumers (`AWS::AutoScaling::AutoScalingGroup`'s
  // `LaunchTemplate.Version`) get the form AWS accepts. Falling back
  // to the physical ID — as the previous default did — produced
  // `Invalid launch template version: either '$Default', '$Latest',
  // or a numeric version are allowed.` on `CreateAutoScalingGroup`.
  if (resourceType === 'AWS::EC2::LaunchTemplate') {
    if (attributeName === 'LatestVersionNumber' || attributeName === 'DefaultVersionNumber') {
      try {
        // Region-sensitive for the same reason as `DescribeInstances` above:
        // a launch-template id is regional (issue #1957).
        const clients = this.clientsForRegion(this.explicitRegion);
        const response = await clients.ec2.send(
          new DescribeLaunchTemplatesCommand({ LaunchTemplateIds: [physicalId] })
        );
        const lt = response.LaunchTemplates?.[0];
        const value =
          attributeName === 'LatestVersionNumber'
            ? lt?.LatestVersionNumber
            : lt?.DefaultVersionNumber;
        if (value !== undefined && value !== null) {
          return String(value);
        }
      } catch (err) {
        // The id through the builder (issue #3479), as the SDK message
        // beside it already was: a state-record id is not always
        // AWS-assigned (see the VPC `Ipv6CidrBlocks` arm).
        this.logger.warn(
          `DescribeLaunchTemplates(${this.displayMasked(physicalId, context)}) failed for ${this.displayMasked(attributeName, context)}: ${this.displayMasked(err instanceof Error ? err.message : String(err), context)}`
        );
      }
      // Fallback to "$Latest" / "$Default" — both are AWS-accepted
      // strings for the corresponding semantic, and let AWS pick the
      // version at API call time. Better than the resource-id
      // physicalId fallback which AWS rejects.
      return attributeName === 'LatestVersionNumber' ? '$Latest' : '$Default';
    }
    if (attributeName === 'LaunchTemplateId') {
      // The physical id IS the launch template id (lt-...) — a
      // known-correct fallback, so it must not route through the
      // unknown-attribute guard.
      return physicalId;
    }
    return this.guardedPhysicalIdFallback(
      logicalId,
      attributeName,
      resourceType,
      physicalId,
      context
    );
  }

  // CloudFront Distribution — `DomainName` is the AWS-assigned hostname
  // (`d111111abcdef8.cloudfront.net`), recorded by the provider from the
  // create / update response and omitted when that response lacked it
  // (issue #3077). The distribution id can never stand in for a hostname,
  // so the arm re-reads it live rather than falling to
  // `guardedPhysicalIdFallback` (issue #3096). `Id` IS the physical id.
  if (resourceType === 'AWS::CloudFront::Distribution') {
    switch (attributeName) {
      case 'Id':
        return physicalId;
      case 'DomainName': {
        // A distribution id is `E` + 13 upper-case alphanumerics. Refused
        // before the cache read (keyed by this id) and the `GetDistribution`
        // it would parameterise; marked, since the record decides it.
        if (!/^[A-Z0-9]+$/.test(physicalId)) {
          throw markNonRetryable(
            new IntrinsicResolutionRefusalError(
              `Cannot resolve Fn::GetAtt [${this.displayMasked(logicalId, context)}, DomainName] for AWS::CloudFront::Distribution: the ` +
                `state record's physical id ${quotedRender(this.displayMasked(physicalId, context).slice(0, 64), '"')} ` +
                `is not a distribution id (upper-case alphanumerics), so cdkd will not look it up. Repair the ` +
                `record (cdkd import, or re-create the distribution) and deploy again.`
            )
          );
        }
        const cachedDomainName = cachedCloudFrontDomainNames[physicalId];
        if (cachedDomainName !== undefined) return cachedDomainName;
        let domainName: string | undefined;
        try {
          // CloudFront is a global service; `AwsClients.cloudFront` answers
          // for any region, so the ambient / `--region` bag is the right one.
          const cloudFront = this.clientsForRegion(this.explicitRegion).cloudFront;
          const resp = await cloudFront.send(new GetDistributionCommand({ Id: physicalId }));
          domainName = resp.Distribution?.DomainName;
        } catch (err) {
          this.refuseUnservedAttribute({
            logicalId,
            attributeName,
            resourceType,
            physicalId,
            context,
            observed: this.describeFailureObserved('GetDistribution', err, context),
            remedy: 'Fix the read (the cloudfront:GetDistribution permission) and deploy again.',
          });
        }
        if (domainName) {
          cachedCloudFrontDomainNames[physicalId] = domainName;
          return domainName;
        }
        this.refuseUnservedAttribute({
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context,
          observed: 'GetDistribution reports no DomainName',
          remedy:
            'Check the distribution in the console, or reference the attribute from a later deploy.',
        });
      }
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // RDS DBProxy / DBProxyEndpoint — `VpcId` is read from `DescribeDBProxies`
  // / `DescribeDBProxyEndpoints` by the provider and omitted when the
  // response lacked it (issue #3077). The proxy / endpoint NAME can never
  // satisfy a `VpcId` position, and this file has no RDS client to re-read
  // it with (`AwsClients` exposes none), so the arm is a refusal only — a
  // VALUE-TYPED one, decided from the omitted key and the attribute name
  // (issue #3096). Marked non-retryable, unlike the live-read arms above:
  // no retry of this deploy rewrites the state record it is read from, and
  // the message interpolates the logical id (#1838). The next `update()` of
  // the resource records the key.
  if (resourceType === 'AWS::RDS::DBProxy' || resourceType === 'AWS::RDS::DBProxyEndpoint') {
    if (attributeName === 'VpcId') {
      // Issue #1852: the same no-change gap as the shared fallback — "its next
      // deploy records the value" is true only of a deploy that UPDATES the
      // proxy — and both providers' `import()` report `VpcId`, so let the heal
      // wrapper re-read the record before this refuses.
      if (context.staleAttributeHeal?.phase === 'probe') throw new StaleAttributeMissSignal();
      const vpcIdHealOutcome =
        context.staleAttributeHeal?.phase === 'settled'
          ? context.staleAttributeHeal.outcome
          : undefined;
      // not-in-class(resourceType): the enclosing `if` compared it for EQUALITY
      // with two literals, so it carries no control character (issue #3441).
      throw markNonRetryable(
        new IntrinsicResolutionRefusalError(
          `Cannot resolve Fn::GetAtt [${this.displayMasked(logicalId, context)}, ${this.displayMasked(attributeName, context)}] for ${resourceType}: ` +
            `the state record holds no VpcId for it (the read-back that would have recorded it reported none), ` +
            `and the physical id ${quotedRender(this.displayMasked(physicalId, context), '"')} is a name, not a VPC id, so cdkd ` +
            `refuses to substitute it. ` +
            `${this.staleRecordRemedy(vpcIdHealOutcome, context)} Referencing the VPC directly also works.`
        )
      );
    }
    return this.guardedPhysicalIdFallback(
      logicalId,
      attributeName,
      resourceType,
      physicalId,
      context
    );
  }

  // Default: fall back to the physical ID via the shared shape guard
  // (issue #1106 / #1111 — the same rules apply to every per-type
  // `default:` branch above).
  return this.guardedPhysicalIdFallback(
    logicalId,
    attributeName,
    resourceType,
    physicalId,
    context
  );
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
 * file but the fabricated-account guard: the verdict is TIME-DEPENDENT. A
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
 * Measured, not designed: the fabricated-account guard sits in exactly the
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
