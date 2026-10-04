import type { IntrinsicFunctionResolver } from '../intrinsic-function-resolver.js';
import type { ResourceState } from '../../types/state.js';
import { canonicalizeRegion } from '../../utils/aws-partition.js';
import { IntrinsicResolutionRefusalError } from '../../utils/error-handler.js';
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
  carriesDynamicReference,
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
import { type StaleAttributeHealOutcome } from '../stale-attribute-heal.js';
import { NOT_CONSTRUCTED, constructAttributeForCoreTypes } from './getatt-construct-core.js';
import { constructAttributeForAppTypes } from './getatt-construct-app.js';
import { constructAttributeForComputeTypes } from './getatt-construct-compute.js';

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
    constructAttribute: OmitThisParameter<typeof constructAttribute>;
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
        // the unknown-account refusal in `constructGuardedAttribute`.
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
 * The per-resource-type attribute construction itself.
 *
 * Many CloudFormation attributes are not returned by Cloud Control API,
 * so we need to construct them manually.
 *
 * Reached only through {@link constructGuardedAttribute}, which vets the
 * result. Keep this method's NAME — `scripts/gen-sdk-attr-coverage.ts` reads
 * the resource types it and its `constructAttributeFor*` helpers reference.
 */
export async function constructAttribute(
  this: IntrinsicFunctionResolver,
  resource: ResourceState,
  attributeName: string,
  // No longer unused (issue #2827 review): the three EC2 fallback warns in
  // getatt-construct-core.ts and getatt-construct-compute.ts
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
  // constructions in `getatt-construct-*.ts` (issue #1850). `accountInfo.region` is whatever
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
  // makes it exhaustive WITHIN THIS METHOD and its helpers, which receive only
  // the folded `region`, never `accountInfo`: a constructed attribute added
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
  // The five S3 branches (getatt-construct-core.ts) pass this region OUT to `s3-endpoints.ts`,
  // which folds again on entry — deliberately, not redundantly. That module
  // has a SECOND caller (`S3BucketProvider.buildAttributes`, what lands in
  // state) that still hands it a raw `client.config.region()`, so folding
  // only here would make the resolver's `Fn::GetAtt` answer disagree with
  // `readCurrentState` — the exact phantom drift that module exists to
  // prevent (#1745).
  const { accountId, partition } = accountInfo;
  const region = canonicalizeRegion(accountInfo.region);
  // The per-type handlers, in their original order (issue #4337).
  const constructAttributeForCoreTypesResult = await constructAttributeForCoreTypes.call(
    this,
    resource,
    attributeName,
    context,
    logicalId,
    resourceType,
    physicalId,
    accountId,
    partition,
    region
  );
  if (constructAttributeForCoreTypesResult !== NOT_CONSTRUCTED)
    return constructAttributeForCoreTypesResult;
  const constructAttributeForAppTypesResult = await constructAttributeForAppTypes.call(
    this,
    resource,
    attributeName,
    context,
    logicalId,
    resourceType,
    physicalId,
    accountId,
    partition,
    region
  );
  if (constructAttributeForAppTypesResult !== NOT_CONSTRUCTED)
    return constructAttributeForAppTypesResult;
  const constructAttributeForComputeTypesResult = await constructAttributeForComputeTypes.call(
    this,
    attributeName,
    context,
    logicalId,
    resourceType,
    physicalId,
    accountId,
    partition,
    region
  );
  if (constructAttributeForComputeTypesResult !== NOT_CONSTRUCTED)
    return constructAttributeForComputeTypesResult;

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
