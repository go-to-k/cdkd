import type { IntrinsicFunctionResolver } from '../intrinsic-function-resolver.js';
import { displayLeaf, displayMasked, logRender, maskValueLeaves } from './masking-display.js';
import { outputNameLogText } from './masking.js';
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
  splitGetAttStringForm,
} from '../secret-redaction.js';
import { type StaleAttributeHealOutcome } from '../stale-attribute-heal.js';
import { NOT_CONSTRUCTED, constructAttributeForCoreTypes } from './getatt-construct-core.js';
import { recordedTokenRoutes, reresolveByRecordedRoutes } from './recorded-reference-routes.js';
import { constructAttributeForAppTypes } from './getatt-construct-app.js';
import { constructAttributeForComputeTypes } from './getatt-construct-compute.js';
import {
  constructWithStaleRecordHeal,
  healMaskedOwnIdAttribute,
  healStaleAttributes,
  serveHealedAttribute,
  staleRecordRemedy,
  usableHealedAttribute,
} from './getatt-heal.js';
import { guardedPhysicalIdFallback } from './getatt-refusals.js';
import { reresolveCrossStackValue } from './cross-stack.js';
import { lookupResourceRecord } from './refs.js';
import { noteAttributeSecrecy, recordSecretNamedRead } from './getatt/secrecy.js';
import { reresolveRecordedReferences } from './getatt/reresolve.js';
import { flatMemberObject } from './getatt-construct-flat-members.js';

export {
  noteAttributeSecrecy,
  publicNoEchoTokens,
  pushRedactedAttributeRead,
  recordSecretNamedRead,
} from './getatt/secrecy.js';
export { referencesMatchPhysicalId, reresolveRecordedReferences } from './getatt/reresolve.js';

/**
 * An attribute `resolveGetAtt` never serves from the state record, because it
 * changes on the live resource after the create and nothing re-records it:
 * the VPC's `Ipv6CidrBlocks` and `CidrBlockAssociations` (a later
 * `VPCCidrBlock` association; a Cloud Control record holds the list as it
 * was at create, go-to-k/cdkd#6232) and the
 * Subnet's `Ipv6CidrBlocks`, `NetworkAclAssociationId` and
 * `BlockPublicAccessStates` (an in-place `Ipv6CidrBlock` update, a
 * `SubnetNetworkAclAssociation`, a VPC block-public-access exclusion;
 * go-to-k/cdkd#5944). Exported so a reader that otherwise prefers the
 * recorded value can mirror it.
 */
export function isAlwaysLiveAttribute(resourceType: string, attributeName: string): boolean {
  if (resourceType === 'AWS::EC2::VPC')
    return attributeName === 'Ipv6CidrBlocks' || attributeName === 'CidrBlockAssociations';
  if (resourceType !== 'AWS::EC2::Subnet') return false;
  return (
    attributeName === 'Ipv6CidrBlocks' ||
    attributeName === 'NetworkAclAssociationId' ||
    attributeName === 'BlockPublicAccessStates' ||
    attributeName.startsWith('BlockPublicAccessStates.')
  );
}

/**
 * Resolve Fn::GetAtt intrinsic function
 */
export async function resolveGetAtt(
  resolver: IntrinsicFunctionResolver,
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
    const resolvedAttributeName = await resolver.resolveValue(rawAttributeName, context);
    if (typeof resolvedAttributeName !== 'string') {
      throw markNonRetryable(
        new Error(
          `Fn::GetAtt attribute name for ${displayMasked(resolver, logicalId, context)} must resolve to a string, got ${typeof resolvedAttributeName}: ${stringifyValue(maskValueLeaves(resolver, resolvedAttributeName, context))}`
        )
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
        new Error(`Invalid Fn::GetAtt format: ${displayMasked(resolver, getAtt, context)}`)
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
  const resource = lookupResourceRecord(resolver, logicalId, 'Fn::GetAtt', context);
  if (!resource) {
    // `markNonRetryable` for the reason given at the `Invalid Fn::GetAtt
    // format` throw above: `logicalId` is template-controlled and the retry
    // classifiers match by bare substring, so `Throttling*` / `SlowDown*` /
    // `*DependencyViolation*` construct names turn this deterministic
    // refusal transient. Scoped to THIS cdkd-authored throw -- a transient
    // SDK error surfacing out of `reresolveCrossStackValue` below must stay
    // retryable, which is why the mark is here and not in the `Fn::Sub` catch.
    // THIS MESSAGE IS RE-PARSED, which makes sanitizing it a GATE decision and not only a display one
    // (go-to-k/cdkd#3432). `src/cli/commands/scrub/abandoned-scan.ts`'s `TEMPLATE_SHAPE_FAILURE_PATTERNS` holds
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
      new Error(`Resource ${displayMasked(resolver, logicalId, context)} not found for Fn::GetAtt`)
    );
  }

  // go-to-k/cdkd#3869: the target's own needles BEFORE any branch below, so a
  // refusal that renders its physical id (`guardedPhysicalIdFallback`, a stale
  // placeholder) is masked too. The served value's leaves are recorded where
  // each branch serves it.
  recordSecretNamedRead(logicalId, undefined, context);

  // Check if attribute exists in resource.attributes
  // except an always-live attribute, which goes to constructAttribute's live
  // read because a stored copy may be stale (`isAlwaysLiveAttribute`).
  const skipCachedAttribute = isAlwaysLiveAttribute(resource.resourceType, attributeName);

  if (!skipCachedAttribute && resource.attributes !== undefined) {
    // Flat-key lookup first (SDK providers store nested attributes as flat
    // dot-keys, e.g. `attributes['Endpoint.Port'] = '3306'`).
    // `Object.hasOwn` (issue #2767). `attributeName` is free-form template text
    // -- the only validation is `typeof === 'string'` -- and `attributes` comes
    // from `JSON.parse` of state.json, so `Fn::GetAtt: [R, "constructor"]` read
    // the `Object` function, passed the `!== undefined` test below, and was
    // returned as the attribute VALUE into a live property.
    // A whole object whose members are recorded as flat dot-keys is
    // assembled from them (go-to-k/cdkd#6242, `flatMemberObject`).
    const storedValue = Object.hasOwn(resource.attributes, attributeName)
      ? resource.attributes[attributeName]
      : flatMemberObject(resource.resourceType, attributeName, resource.attributes);
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
        const outcome = await healStaleAttributes(resolver, logicalId, resource, context);
        const healed = usableHealedAttribute(resolver, outcome, attributeName);
        if (
          healed !== undefined &&
          !isStalePlaceholderArnAttribute(resource.resourceType, attributeName, healed)
        ) {
          return serveHealedAttribute(resolver, logicalId, attributeName, healed, context);
        }
        rejectPlaceholderArnAttribute(
          resolver,
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
      // go-to-k/cdkd#4849: a masked copy of the record's own physical id.
      const ownIdRead = healMaskedOwnIdAttribute(
        resolver,
        logicalId,
        resource,
        attributeName,
        flatValue,
        context
      );
      if (ownIdRead !== undefined) {
        const ownId = await ownIdRead;
        if (ownId !== undefined) return ownId;
      }
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
        const notedNameServers = noteAttributeSecrecy(
          resolver,
          logicalId,
          attributeName,
          nameServers,
          context
        );
        resolver.logger.debug(
          `Normalized legacy Fn::GetAtt attribute: ${logRender(resolver, logicalId, context)}.${logRender(resolver, attributeName, context)} normalized to ${logRender(resolver, stringifyAttributeForLog(attributeName, maskValueLeaves(resolver, nameServers, context)), context, { structured: isStructured(nameServers), redacted: isSensitiveAttributeName(attributeName) })}`
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
        : noteAttributeSecrecy(resolver, logicalId, attributeName, flatValue, context);
      resolver.logger.debug(
        `Resolved Fn::GetAtt from attributes: ${logRender(resolver, logicalId, context)}.${logRender(resolver, attributeName, context)} resolved to ${logRender(resolver, stringifyAttributeForLog(attributeName, maskValueLeaves(resolver, flatValue, context)), context, { structured: isStructured(flatValue), redacted: isSensitiveAttributeName(attributeName) })}`
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
        const childRegion = nestedStackChildRegionFromLocalArn(resource.physicalId);
        const nestedOrigin = `nested stack ${logicalId} ${displayLeaf(resolver, attributeName, context)}`;
        const nestedSourceKey = crossStackSourceKey({ 'Fn::GetAtt': getAtt });
        // go-to-k/cdkd#4847: the row's provenance (copied from the child's
        // outputs) names each token's region and version; the child's region
        // and the current version answer where it does not.
        const routes =
          context.recordedSecretValues === undefined || carriesSecretMask(flatValue)
            ? undefined
            : recordedTokenRoutes(flatValue, resource);
        if (routes !== undefined) {
          return await reresolveByRecordedRoutes(
            resolver,
            flatValue,
            logicalId,
            context,
            nestedOrigin,
            nestedSourceKey,
            routes,
            { region: childRegion }
          );
        }
        return await reresolveCrossStackValue(
          resolver,
          flatValue,
          childRegion,
          context,
          nestedOrigin,
          nestedSourceKey
        );
      }
      return await reresolveRecordedReferences(
        resolver,
        notedFlatValue,
        logicalId,
        context,
        `${logicalId}.${displayLeaf(resolver, attributeName, context)}`,
        crossStackSourceKey({ 'Fn::GetAtt': getAtt })
      );
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
        const notedCursor = noteAttributeSecrecy(
          resolver,
          logicalId,
          attributeName,
          cursor,
          context
        );
        resolver.logger.debug(
          `Resolved Fn::GetAtt from nested attributes: ${logRender(resolver, logicalId, context)}.${logRender(resolver, attributeName, context)} resolved to ${logRender(resolver, stringifyAttributeForLog(attributeName, maskValueLeaves(resolver, cursor, context)), context, { structured: isStructured(cursor), redacted: isSensitiveAttributeName(attributeName) })}`
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
        // not the other is how a redaction ships half-applied. The same holds
        // for a leaf redacted to its `{{resolve:` spelling (go-to-k/cdkd#4800).
        return await reresolveRecordedReferences(
          resolver,
          notedCursor,
          logicalId,
          context,
          `${logicalId}.${displayLeaf(resolver, attributeName, context)}`,
          crossStackSourceKey({ 'Fn::GetAtt': getAtt })
        );
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
      .map((k) => displayMasked(resolver, outputNameLogText(resolver, k, context), context));
    const declaredText = declared.length > 0 ? declared.join(', ') : '(none)';
    // Bound once because the message renders it TWICE (go-to-k/cdkd#3432). Two independent
    // `displayMasked(resolver,logicalId, context)` calls would also be correct, but a single binding is what
    // keeps the two spellings from drifting apart -- the shape the mask-coverage checker's identifier
    // resolution reads at both interpolations.
    const loggedLogicalId = displayMasked(resolver, logicalId, context);
    throw markNonRetryable(
      new IntrinsicResolutionRefusalError(
        // MASKED (issue #2827 review). `attributeName` here is
        // `resolvedAttributeName` from `resolveValue`, the SAME binding this
        // method's type refusal masks a few lines up — the sweep that built
        // this fix stopped at `throw new Error(` and missed both this
        // `markNonRetryable(new IntrinsicResolutionRefusalError(...))` and
        // the unknown-account refusal in `constructGuardedAttribute`.
        `Cannot resolve Fn::GetAtt [${loggedLogicalId}, ${displayMasked(resolver, attributeName, context)}]: the nested stack ` +
          `${quotedRender(loggedLogicalId, "'")} declares no output named ` +
          `${quotedRender(displayMasked(resolver, outputNameLogText(resolver, attributeName, context), context), "'")}. ` +
          `Its outputs are ${displayMasked(resolver, declaredText, context)}. ` +
          `Check the output name in the nested stack's template, and deploy the child ` +
          `stack again if you have just added it.`
      )
    );
  }

  const value = await constructWithStaleRecordHeal(
    resolver,
    resource,
    attributeName,
    context,
    logicalId
  );
  // Before the line, like `noteAttributeSecrecy` (go-to-k/cdkd#3869): a
  // CONSTRUCTED value (an ARN built from the physical id) is served outside
  // that note.
  recordSecretNamedRead(logicalId, value, context);
  resolver.logger.debug(
    `Resolved Fn::GetAtt: ${logRender(resolver, logicalId, context)}.${logRender(resolver, attributeName, context)} resolved to ${logRender(resolver, stringifyAttributeForLog(attributeName, maskValueLeaves(resolver, value, context)), context, { structured: isStructured(value), redacted: isSensitiveAttributeName(attributeName) })}`
  );
  return value;
}

/**
 * Refuse a pre-#1681 PLACEHOLDER ARN served from the cached attribute map
 * (issue #1729) — the `Fn::GetAtt` half of the guard
 * `cfnRefValueFromPhysicalId` applies to `Ref`.
 *
 * `Ref` and `Fn::GetAtt` read the SAME recorded attribute, and #1681 treated
 * only the `Ref` side: for an `AWS::AppSync::*` child created by a pre-#1681
 * binary, `{"Fn::GetAtt": ["MyDataSource", "DataSourceArn"]}` still resolved
 * to `arn:aws:appsync:*:*:apis/.../datasources/...` — structurally valid,
 * unusable, and indistinguishable downstream from a real ARN.
 *
 * Scoped to the `REF_RETURNS_ARN_FROM_STATE` types AND their declared
 * ARN attribute names, the narrowest form of the fix: a wildcard-bearing ARN
 * is only KNOWN to be a placeholder for these attributes, and some
 * other type could legitimately cache an ARN-shaped string carrying a `*` in
 * a position `isPlaceholderArn` inspects. Every other attribute of
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
  resolver: IntrinsicFunctionResolver,
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
      `Cannot resolve Fn::GetAtt [${displayMasked(resolver, logicalId, context)}, ${displayMasked(resolver, attributeName, context)}] for ` +
        `${resource.resourceType}: the recorded value ${quotedRender(stringifyValue(maskValueLeaves(resolver, value, context)), '"')} is a placeholder ` +
        `written by an older cdkd version — its region and account ` +
        `fields are literal wildcards, so it is not a usable ARN. ` +
        staleRecordRemedy(resolver, healOutcome, context)
    )
  );
}

/**
 * The per-resource-type attribute construction itself.
 *
 * Many CloudFormation attributes are not returned by Cloud Control API,
 * so we need to construct them manually.
 *
 * Reached only through `constructGuardedAttribute`, which vets the
 * result. Keep this method's NAME — `scripts/gen-sdk-attr-coverage.ts` reads
 * the resource types it and its `constructAttributeFor*` helpers reference.
 */
export async function constructAttribute(
  resolver: IntrinsicFunctionResolver,
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
  const constructAttributeForCoreTypesResult = await constructAttributeForCoreTypes(
    resolver,
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
  const constructAttributeForAppTypesResult = await constructAttributeForAppTypes(
    resolver,
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
  const constructAttributeForComputeTypesResult = await constructAttributeForComputeTypes(
    resolver,
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
  return guardedPhysicalIdFallback(
    resolver,
    logicalId,
    attributeName,
    resourceType,
    physicalId,
    context
  );
}
