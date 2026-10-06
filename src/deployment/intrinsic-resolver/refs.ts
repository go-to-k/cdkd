import type { IntrinsicFunctionResolver } from '../intrinsic-function-resolver.js';
import { safeMsg } from '../../utils/display-safe.js';
import { IntrinsicResolutionRefusalError } from '../../utils/error-handler.js';
import { markNonRetryable } from '../retryable-errors.js';
import { type ResourceState } from '../../types/state.js';
import {
  type ResolverContext,
  type ParameterDefinition,
  refStateLookupFromResource,
  cfnRefValueFromPhysicalId,
  stringifyParameterForLog,
  isStructured,
} from './support.js';
import { recordSecretNamedRead } from './getatt.js';

declare module '../intrinsic-function-resolver.js' {
  interface IntrinsicFunctionResolver {
    /** @internal */
    nameIsNeverAResource: OmitThisParameter<typeof nameIsNeverAResource>;
    /** @internal */
    lookupResourceRecord: OmitThisParameter<typeof lookupResourceRecord>;
    /** @internal */
    resolveRef: OmitThisParameter<typeof resolveRef>;
    /** @internal */
    resolveRefValue: OmitThisParameter<typeof resolveRefValue>;
    /** @internal */
    noteRefStateMask: OmitThisParameter<typeof noteRefStateMask>;
  }
}

/**
 * Is `logicalId` a name CloudFormation never resolves to a resource (issue
 * #3916)? A template cannot declare one logical id as both a Parameter and a
 * Resource, and `Ref` to a declared Parameter always yields its value. So a
 * state record keyed by such a name is planted or stale, and answering from
 * it let state pick a parameter's value: the value deploy sends to AWS, and
 * the one nested `cdkd export` both submits and checks IAM principals with.
 *
 * - A parameter is one the TEMPLATE declares, or one the caller BOUND that
 *   the template does not declare as a Resource. Value-applying callers
 *   (deploy, import, scrub, export) bind declared names only; `cdkd diff
 *   --recursive` also keeps a parent's raw nested inputs for names the child
 *   does not declare, and such an input must not hide a child resource.
 * - A pseudo-parameter name (`AWS::` prefix, which no logical id can carry)
 *   is kept away from state for the same reason.
 * - Deliberately NOT "only names `template.Resources` declares": several
 *   callers pass state records for a template that does not list them (an
 *   empty `Resources` beside a populated bag), and that is covered behaviour.
 */
/** @internal */
export function nameIsNeverAResource(
  this: IntrinsicFunctionResolver,
  logicalId: string,
  context: ResolverContext
): boolean {
  if (logicalId.startsWith('AWS::')) return true;
  // `!= null` and `typeof`: a YAML `Parameters:` with an empty body parses
  // to `null`, and `Object.hasOwn(null, k)` throws.
  const declared: unknown = context.template?.Parameters;
  if (declared != null && typeof declared === 'object' && Object.hasOwn(declared, logicalId)) {
    return true;
  }
  if (context.parameters == null || !Object.hasOwn(context.parameters, logicalId)) return false;
  const resources: unknown = context.template?.Resources;
  return !(
    resources != null &&
    typeof resources === 'object' &&
    Object.hasOwn(resources, logicalId)
  );
}

/**
 * The ONE read of a state record by logical id, shared by `Ref` and
 * `Fn::GetAtt` (the only two arms that take a record out of
 * `context.resources`; every other method receives it from them).
 *
 * - `Object.hasOwn`, never a bare read (issue #2767): the logical id is
 *   template text, and a plain-object read walks the prototype chain.
 * - A record whose `physicalId` is not a string, or that is not an object at
 *   all, is REFUSED here, above every reader (issue #3576). Nothing in
 *   `src/state/` checks the type, so a hand edit or a foreign writer can
 *   leave a number, and the arms below call `.startsWith` / `.replace` on
 *   it (a bare `TypeError`) or build an ARN from it. cdkd never writes such
 *   a record, so no answer derived from it is honest. `markNonRetryable`:
 *   the verdict is a function of the persisted record, and the message
 *   carries a template-controlled id. A NULL record keeps missing as before.
 * - A PARAMETER or pseudo-parameter name is never answered from state
 *   (issue #3916): see {@link nameIsNeverAResource}.
 */
/** @internal */
export function lookupResourceRecord(
  this: IntrinsicFunctionResolver,
  logicalId: string,
  via: 'Ref' | 'Fn::GetAtt',
  context: ResolverContext
): ResourceState | undefined {
  if (this.nameIsNeverAResource(logicalId, context)) {
    if (Object.hasOwn(context.resources, logicalId)) {
      this.logger.debug(
        safeMsg`Ignoring the state record named ${this.displayMasked(logicalId, context)}: that name is a parameter, not a resource`
      );
    }
    return undefined;
  }
  const resource = Object.hasOwn(context.resources, logicalId)
    ? context.resources[logicalId]
    : undefined;
  if (!resource) return undefined;
  const isObject = typeof resource === 'object' && !Array.isArray(resource);
  const physicalId: unknown = isObject
    ? (resource as { physicalId?: unknown }).physicalId
    : undefined;
  if (typeof physicalId !== 'string') {
    const loggedId = this.displayMasked(logicalId, context);
    const got = physicalId === null ? 'null' : typeof physicalId;
    const what = isObject
      ? `the state record's physical id is ${got}, not a string`
      : `the state record is ${Array.isArray(resource) ? 'an array' : typeof resource}, not an object`;
    const remedy = isObject
      ? `Set the resource's "physicalId" in the stack's state.json back to the id AWS knows the resource by.`
      : `Restore the resource's record in the stack's state.json, or remove it and re-import the resource.`;
    throw markNonRetryable(
      new IntrinsicResolutionRefusalError(
        `${via} ${loggedId}: ${what}. cdkd always records an object with a string id, so ` +
          `this record was edited by hand or written by another tool. ${remedy}`,
        undefined,
        'STATE_PHYSICAL_ID_NOT_STRING'
      )
    );
  }
  return resource;
}

/**
 * Resolve Ref intrinsic function
 *
 * Ref can reference:
 * 1. Resources (returns physical ID)
 * 2. Parameters (returns parameter value)
 * 3. Pseudo parameters (AWS::Region, AWS::AccountId, etc.)
 *
 * A parameter or pseudo-parameter name never reaches arm 1, whatever state
 * holds under that name (issue #3916, `nameIsNeverAResource`).
 *
 * `onParameter` is called when arm 2 answers, so a caller placing the value
 * on a string can record it as a PARAMETER span (issue #4446) without
 * re-deciding which arm a name takes.
 */
/** @internal */
export async function resolveRef(
  this: IntrinsicFunctionResolver,
  logicalId: string,
  context: ResolverContext,
  onParameter?: () => void
): Promise<unknown> {
  // `Object.hasOwn`, not a bare property read (issue #2767). `logicalId` is
  // template-controlled, and a plain-object read walks the PROTOTYPE chain:
  // `resources['constructor']` is the `Object` function, which is truthy, so
  // this arm was TAKEN and the not-found throw at the end of this method never
  // ran. `resolveRefValue(Object)` then reached `cfnRefValueFromPhysicalId`
  // with an undefined physical id, fell through every `resourceType` guard,
  // and returned `undefined` -- which `resolveSub` `String()`s, shipping the
  // literal text `undefined` into a live property. The name now misses like
  // any other unknown one and reaches the ordinary refusal below.
  const resource = this.lookupResourceRecord(logicalId, 'Ref', context);
  if (resource) {
    const refValue = this.resolveRefValue(logicalId, resource, context);
    // Before the line (go-to-k/cdkd#3869): a resource named from a secret
    // serves a name no masker knows.
    recordSecretNamedRead(logicalId, refValue, context);
    // `refValue` through the builder (issue #3479, PR #3575 review): it is
    // the physical id from the STATE RECORD or a segment of it (see
    // `cfnRefValueFromPhysicalId`), which is not always AWS-assigned, so the
    // secret question this line used to answer is not the control-character
    // one. `String()` first: the id itself is a string (see
    // `lookupResourceRecord`), but a `Ref` served out of the record's
    // `properties` / `attributes` is not checked, and the builder calls
    // `.replace`. A `SECRET_MASK` read back from a bagless caller renders
    // unchanged.
    //
    // `resolved to`, not `->`, on this and every other `Resolved …` line:
    // pasted, `->` is `-` plus a `>` redirect onto the bare render that
    // follows, so a template value would choose a file to truncate
    // (go-to-k/cdkd#4161).
    this.logger.debug(
      `Resolved Ref to resource: ${this.logRender(logicalId, context)} resolved to ${this.logRender(String(refValue), context)}`
    );
    return refValue;
  }

  // Check if it's a parameter
  // `Object.hasOwn` for the same reason as the resource read above (issue
  // #2767): `'constructor' in {}` is true, so the bare `in` bound this arm to
  // an `Object.prototype` member and read the function as the parameter's
  // value. Swept together because a name that misses the resource bag lands
  // here next, so fixing only one moves the wrong answer one line down rather
  // than removing it. Membership, NOT a value test: a DECLARED parameter
  // holding `undefined` must still take this arm and return `undefined`,
  // which is the pre-existing behaviour issue #2285 recorded deliberately.
  if (context.parameters && Object.hasOwn(context.parameters, logicalId)) {
    const value = context.parameters[logicalId];
    // `Object.hasOwn` (issue #2802): the TEMPLATE's `Parameters` object comes
    // from `JSON.parse`, so a bare read answered the `Object` FUNCTION as the
    // definition for a parameter named `constructor` and handed it to
    // `stringifyParameterForLog`.
    const declared = context.template.Parameters;
    // `!= null`, NOT `!== undefined`, for the reason spelled out at the
    // `Fn::FindInMap` read: the optional chain this replaced short-circuited
    // on NULL too, and `Object.hasOwn(null, k)` throws. A YAML `Parameters:`
    // with an empty body parses to `null` and reaches here through
    // `cdkd import --migrate-from-cloudformation`.
    const paramDef = (
      declared != null && Object.hasOwn(declared, logicalId) ? declared[logicalId] : undefined
    ) as ParameterDefinition | undefined;
    // go-to-k/cdkd#1998: a `NoEcho` value becomes a LOG-ONLY needle of the
    // pass that consumes it, so the provider's masker, the engine's error and
    // event masking and this resolver's own lines mask it. Never a map entry:
    // persistence is unchanged.
    this.recordNoEchoParameterValue(paramDef, value, context);
    // Issue #1903 / #2087: a nested-stack child records the parent's
    // already-resolved secret HERE, at the point a resource actually
    // consumes the parameter, so the pair lands in that resource's own bag.
    // The NAME goes with it since issue #2291 round 2 -- it is what selects
    // this parameter's own expression over the collapsed map's survivor.
    // Recorded BEFORE the debug line below (go-to-k/cdkd#4049): a list
    // parameter split out of a parent's `NoEcho` string is masked only by
    // the element fragments this carries, which the inherited bag lacks.
    this.recordInheritedParameterSecrets(logicalId, value, context);
    // Through `displayMasked`, which consults `context.inheritedSecrets`
    // too: a pass that records nothing (no `recordedSecretValues`) still
    // masks the parent's plaintext. `stringifyParameterForLog` only covers
    // the author's own `NoEcho` declaration, and a CDK-synthesized
    // nested-stack parameter never carries one.
    this.logger.debug(
      `Resolved Ref to parameter: ${this.logRender(logicalId, context)} resolved to ${this.logRender(
        stringifyParameterForLog(paramDef, this.maskValueLeaves(value, context)),
        context,
        { structured: isStructured(value), redacted: paramDef?.NoEcho === true }
      )}`
    );
    onParameter?.();
    return value;
  }

  // Check if it's a pseudo parameter
  const pseudoValue = await this.resolvePseudoParameter(logicalId, context);
  if (pseudoValue !== undefined) {
    const valueStr = typeof pseudoValue === 'symbol' ? pseudoValue.toString() : String(pseudoValue);
    // THE ONE SITE IN go-to-k/cdkd#3432's POPULATION WHERE THE ID IS REALLY CONSTRAINED, and the marker
    // below says so rather than repeating the premise its eighteen siblings could not support. Reaching
    // this line means `resolvePseudoParameter` returned a value, and that method is a `switch` over
    // cdkd-authored literal case labels with a `default` of `undefined` -- so `logicalId` here is one of
    // those spellings, byte for byte, whatever the template wrote. A template-supplied name that merely
    // RESEMBLES one (a trailing ESC on the region pseudo-parameter) misses every case and falls through
    // to the not-found arm below, which renders through the builder. MEASURED both ways by
    // `tests/unit/deployment/resolver-logical-id-control-chars.test.ts`, so the premise is fenced rather
    // than asserted: that suite READS the case labels out of this method and drives every one, and drives
    // the near-miss spelling too, which lands on the not-found warn with its control character stripped.
    // No count is written here on purpose -- the suite derives the population and carries the floor, and
    // a number in a comment is one that goes stale (this comment's own first draft said nine; it is eight).
    //
    // PLAIN PROSE, not the `not-in-class(...)` note spelling the other sites
    // carry: that syntax was read by an AST checker go-to-k/cdkd#3435 deleted,
    // so a note in that shape here would look like a machine-checked verdict
    // and be nothing of the kind. The ones remaining in this file are
    // pre-existing and are a recorded backlog row, not this change's to sweep
    // (no count written here, for the reason the paragraph above gives).
    //
    // THE CLAIM: `logicalId` here is one of `resolvePseudoParameter`'s own
    // literal case labels -- not template text -- so it carries neither a
    // resolved value nor a control character.
    // `valueStr` through the builder (issue #3479): a pseudo-parameter
    // VALUE is not constrained the way its name is -- `AWS::StackName` is the
    // manifest-derived stack name.
    this.logger.debug(
      `Resolved Ref to pseudo parameter: ${logicalId} resolved to ${this.logRender(valueStr, context)}`
    );
    return pseudoValue;
  }

  // Not found. In a best-effort context (diff), a Ref to a resource this
  // same deploy will CREATE is routine — log at debug, not warn (#1017).
  //
  // RENDERED THROUGH THE BUILDER, and this is the one site go-to-k/cdkd#3426
  // MEASURED leaking through an exclusion marker rather than past one. The
  // marker here used to read "a message built here from logicalId alone,
  // which is a literal per CloudFormation's grammar" — true about SECRETS,
  // which is the only question the marker answers, and false about CONTROL
  // CHARACTERS twice over. `resolveSub` re-enters `resolveRef` with whatever
  // text sits between `${` and `}`, which nothing validates; and cdkd reads
  // the template as JSON, so even a Resources KEY is only as constrained as
  // the file. Measured on this tree: `{"Fn::Sub": "x${Prod<ESC>[2K<CR>Evil}"}`
  // put a live `ESC[2K` + CR on this warn, at DEFAULT verbosity.
  //
  // `displayMasked` rather than `displayIdent`, and go-to-k/cdkd#3432 CLOSED
  // the 19 sibling sites with the same choice — 18 of them wrapped and their
  // exclusion notes deleted, one (the pseudo-parameter render) left as it is
  // because `resolvePseudoParameter`'s switch has already MATCHED by then.
  // Every one is held by its emitted BYTES in
  // `tests/unit/deployment/resolver-logical-id-control-chars.test.ts`, one
  // case per site, rather than by any source-shape rule. Two
  // reasons for the builder over the identifier renderer, and neither is "it
  // is stronger":
  //
  //  - `displayIdent` does not mask, and refusing to reason about whether a
  //    logical id can ever coincide with a recorded needle is cheaper than
  //    being right about it. (What the trace actually shows is narrower than
  //    this site's first revision claimed: `Ref`, `Fn::GetAtt`'s first
  //    element and `Fn::Sub`'s `${...}` text are all template LITERALS, never
  //    a resolution product, so the mask is defence in depth here rather than
  //    a live exposure. The CONTROL-CHARACTER half is the measured one.)
  //  - `displayIdent` QUOTES and BOUNDS, which changes the rendering of a
  //    legitimate id carrying a space and breaks two things that read these
  //    messages: `scrub.ts`'s shape patterns and the whole-tuple de-dup
  //    fixture. The builder is the identity on every legitimate id.
  const loggedLogicalId = this.displayMasked(logicalId, context);
  const notFoundMsg = `Ref ${loggedLogicalId} not found (not a resource, parameter, or pseudo parameter)`;
  if (context.bestEffort) {
    this.logger.debug(notFoundMsg);
  } else {
    this.logger.warn(notFoundMsg);
  }
  // `markNonRetryable` for the same reason as the two `Fn::GetAtt` throws
  // above: `logicalId` is template-controlled and reaches a substring-matching
  // retry classifier. `resolveSub`'s no-dot arm re-throws this one.
  throw markNonRetryable(new Error(`Ref ${loggedLogicalId} not found`));
}

/**
 * Resolve the value a CloudFormation `Ref` returns for a resource.
 *
 * For most resource types `Ref` returns the physical id, which is what cdkd
 * stores. But for a few types CFn's `Ref` returns a sub-component of the
 * physical id, and returning the raw physical id breaks downstream consumers.
 *
 * The {@link REF_RETURNS_SEGMENT_AFTER_PIPE} types store a COMPOUND physical
 * id `<parentId>|<ref>` while CFn's `Ref` returns only the trailing `<ref>`
 * segment. Most are compound because Cloud Control provisions them (either
 * they have no SDK provider, or the #614 silent-drop routing sent an
 * SDK-backed type through CC) and its primaryIdentifier is compound; the rest
 * — `AWS::S3Tables::Namespace` / `::Table` — are compound because their own
 * SDK provider packs the segments. (`AWS::Glue::Table` builds one too, but
 * takes {@link glueTableRefFromPhysicalId}: either of its segments may
 * contain `|`.) The Set's header records the split per type; examples:
 *   - `AWS::ApiGateway::Model` → Ref is the model NAME; physical id is
 *     `<restApiId>|<modelName>`. A method wiring
 *     `RequestModels: { "application/json": { "Ref": <Model> } }` would
 *     otherwise get the compound id and API Gateway rejects it with
 *     "Invalid model identifier specified".
 *   - `AWS::ApiGateway::RequestValidator` → Ref is the RequestValidatorId;
 *     physical id is `<restApiId>|<requestValidatorId>`. A method wiring
 *     `RequestValidatorId: { "Ref": <Validator> }` would otherwise get the
 *     compound id and API Gateway rejects it with
 *     "Invalid Request Validator identifier specified".
 *   - `AWS::Cognito::UserPoolClient` → Ref is the client id; physical id is
 *     `<userPoolId>|<clientId>`. Any consumer of the client id (a CfnOutput,
 *     a Lambda env var, `cognito-idp` API calls) would otherwise get the
 *     compound id, which fails the `[\w+]+` client-id validation.
 * In every case the `Ref` value is the segment after the pipe (the parent id
 * is the first identifier component).
 *
 * The {@link REF_RETURNS_SEGMENT_BEFORE_FIRST_PIPE} types are the mirror
 * image: their compound primaryIdentifier puts the `Ref` component FIRST
 * (`<refId>|<parentId>` — e.g. `AWS::ApiGateway::Deployment`), so the value
 * is the segment before the first pipe.
 *
 * The {@link REF_RETURNS_NAME_FROM_ARN} types are SDK-provisioned with the
 * resource ARN stored as the physical id, while CFn's `Ref` returns the
 * resource NAME (the CFn physical resource id) — e.g. `AWS::Events::Rule`
 * (`Ref` is the rule name such as `mystack-ScheduledRule-ABC`; a consumer
 * calling `events:*` APIs by name or composing the name into another string
 * would otherwise get the full ARN) and `AWS::CloudTrail::Trail` (`Ref` is
 * the trail name). The name is extracted from the stored ARN.
 *
 * `AWS::S3Tables::Table` is a hybrid: on the SDK path its compound physical
 * id yields the table name via the after-pipe extraction, but a #614-routed
 * (Cloud Control) Table stores only the bare TableARN (which ends in a UUID,
 * not the name), so the resolver passes the resource's stored `properties` /
 * `attributes` as a `stateLookup` and `cfnRefValueFromPhysicalId` recovers
 * the name from the `TableName` property (issue #974).
 *
 * Two further mechanisms cover compounds neither Set can express (issue
 * #1681): {@link REF_RETURNS_SEGMENT_AT_INDEX} for an INTERIOR segment
 * (`AWS::Route53::RecordSet`'s `<hostedZoneId>|<name>|<type>` -> the record
 * name), and {@link REF_RETURNS_ARN_FROM_STATE} for the `AWS::AppSync::*`
 * children, whose `Ref` is an ARN recovered from the provider-recorded ARN
 * attribute through the same `stateLookup` seam.
 */
export function resolveRefValue(
  this: IntrinsicFunctionResolver,
  logicalId: string,
  resource: ResourceState,
  context: ResolverContext
): string {
  // THE OPT-IN IS DECIDED HERE, and passing the callback unconditionally is
  // what made it inert (issue #2847 round-3 review, BLOCKER B2). The skip in
  // `refStateLookupFromResource` fires whenever a callback is supplied, so a
  // context with NO `redactedAttributeReads` bag — `cdkd diff`, `cdkd scrub`
  // and, decisively, `cdkd import` — still got the skip while
  // `noteRefStateMask` returned early with nowhere to record it: the mask was
  // dropped, the raw physical id fell through, and `cdkd import` PERSISTED it
  // into `resource.properties`, from where `cdkd export` writes it into the
  // imported template and `cdkd drift --revert` sends it to AWS.
  //
  // So the callback is passed only when there is somewhere to put the
  // refusal. Without a bag this is byte-for-byte the pre-#2847 resolution:
  // the mask is served, and the four readers that recognise it still do.
  const canRefuse = context.redactedAttributeReads !== undefined;
  return cfnRefValueFromPhysicalId(
    resource.resourceType,
    resource.physicalId,
    canRefuse
      ? refStateLookupFromResource(resource, (key) =>
          this.noteRefStateMask(logicalId, key, context)
        )
      : refStateLookupFromResource(resource)
  );
}

/**
 * The `Ref` twin of {@link noteAttributeSecrecy} (issue
 * [#2847](https://github.com/go-to-k/cdkd/issues/2847) review).
 *
 * `noteAttributeSecrecy`'s own contract is "every branch serving a value out
 * of a PERSISTED `attributes` bag must call this", and `Ref` was the branch
 * that did not: {@link refStateLookupFromResource} reads `properties` then
 * `attributes` to recover a `Ref` value the physical id cannot yield, and a
 * masked leaf there travelled all the way to AWS with `redactedAttributeReads`
 * left empty.
 *
 * It is a SEPARATE method rather than a call into `noteAttributeSecrecy` for
 * two reasons, and both are about what the entry has to SAY. The refusal
 * joins these entries into a user-facing sentence whose `Fn::GetAtt` arm ends
 * "stop reading it" — advice that is wrong here, because this read is CDKD's
 * own: CloudFormation defines these types' `Ref` as a state key rather than
 * the physical id, so no template edit stops it. And `noteAttributeSecrecy`'s
 * other half — recording a `NoEcho`-declared value as a mask-only needle — has
 * nothing to do at this site: the value has ALREADY been masked in state, so
 * there is no plaintext to register.
 *
 * THE SPELLING IS NO LONGER PARSED, and this paragraph used to say the
 * opposite (corrected in go-to-k/cdkd#3432). It read: "`Ref <LogicalId>
 * (state key <Key>)` is what `DeployEngine.maskedRecordRemedyFor` partitions
 * on ... that helper reads the logical id out of it". That was true when it
 * was written and stopped being true at that helper's round-4 review, which
 * moved the partition onto the `kind` / `logicalId` FIELDS precisely because
 * two successive regexes over this rendering each shipped a defect — the
 * second an `[A-Za-z0-9]+` id class that a HYPHENATED logical id falls out
 * of. `targetOf` reads `read.logicalId`; no regex touches `display`.
 *
 * What the shape IS still load-bearing for is a SENTENCE: the refusal's
 * `hasRefStateRead` arm tells the reader that "a 'Ref <LogicalId> (state key
 * <Key>)' entry above is CDKD's own read", so the `Ref ` prefix and the
 * `(state key ...)` clause have to keep appearing. Sanitizing the ID inside
 * them leaves both intact.
 *
 * THE ID IS SANITIZED, the attribute-read sibling's judgement one branch over
 * (go-to-k/cdkd#3432). `displayMasked` rather than `displayIdent`: the
 * builder neither quotes nor bounds, so every legitimate id renders exactly
 * as it did, and the deliberate collision `intrinsic-ref-state-mask.test.ts`
 * pins between this rendering and `noteAttributeSecrecy`'s is preserved
 * because BOTH sites take the same builder. The `logicalId` FIELD stays raw —
 * it is the routing key and the `--resource <id>=` argument.
 *
 * `key` is never masked before interpolation because it is not template text:
 * it comes from the fixed key lists `cfnRefValueFromPhysicalId` passes
 * (`TableName` / `Name` / `DatabaseName` / `SelectionId` / `RepositoryId` /
 * the AppSync ARN attributes), all cdkd literals.
 */
export function noteRefStateMask(
  this: IntrinsicFunctionResolver,
  logicalId: string,
  key: string,
  context: ResolverContext
): void {
  this.pushRedactedAttributeRead(context, {
    kind: 'ref-state-key',
    logicalId,
    key,
    display: `Ref ${this.displayMasked(logicalId, context)} (state key ${key})`,
  });
}
