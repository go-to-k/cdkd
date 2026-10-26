import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { getLogger } from '../utils/logger.js';
import { canonicalizeRegion, sameRegion } from '../utils/aws-partition.js';
import { withSharedDrainBudget } from './drain-budget.js';
import { SECRET_MASK } from './secret-redaction.js';
import { markNonRetryable } from './retryable-errors.js';
import {
  type ResolverContext,
  AWS_NO_VALUE,
  detectUnknownIntrinsicKey,
  buildUnknownIntrinsicError,
  DRAIN_AFTER_REJECTION_MS,
  concurrentDrainCap,
  allSettledKeepingFirstRejection,
  coerceParameterTypedValue,
} from './intrinsic-resolver/support.js';
import { resolveGetAtt } from './intrinsic-resolver/getatt.js';
import { resolveImportValue } from './intrinsic-resolver/cross-stack.js';
import { CfnFallbackCache } from './intrinsic-resolver/cfn-fallback.js';
import { resolveGetStackOutput } from './intrinsic-resolver/stack-output.js';
import {
  DynamicReferenceCache,
  resolveTemplateLeafReferences,
} from './intrinsic-resolver/dynamic-refs.js';
import {
  resolveJoin,
  resolveSelect,
  resolveSplit,
  wholeReferenceSpans,
} from './intrinsic-resolver/string-functions.js';
import { resolveSub } from './intrinsic-resolver/sub.js';
import {
  resolveAnd,
  resolveBase64,
  resolveCidr,
  resolveConditionReference,
  resolveEquals,
  resolveFindInMap,
  resolveGetAZs,
  resolveIf,
  resolveNot,
  resolveOr,
} from './intrinsic-resolver/functions.js';
import { recordLeafResolution, regionLogText } from './intrinsic-resolver/masking.js';
import { displayMasked, logRender } from './intrinsic-resolver/masking-display.js';
import {
  evaluateConditions as evaluateTemplateConditions,
  resolveKeyUnit,
  resolveParameters as resolveTemplateParameters,
} from './intrinsic-resolver/params-conditions.js';
import { recordDroppedArrayElementsIn } from './intrinsic-resolver/parameter-secrets.js';
import { resolveRef } from './intrinsic-resolver/refs.js';
import { ResolverClients } from './intrinsic-resolver/clients.js';
import type { CloudFormationTemplate } from '../types/resource.js';
import type {
  CdkCrossAccountRefVerdict,
  ProducerLookup,
} from './intrinsic-resolver/cdk-cross-account-ref.js';
export {
  AWS_NO_VALUE,
  isStalePlaceholderArnAttribute,
  type RefStateLookup,
  type RefStateLookupOptions,
  refStateLookupFromResource,
  glueTableRefFromPhysicalId,
  cfnRefValueFromPhysicalId,
  lacksRecordedTableArn,
  carriesDynamicReference,
  type AbandonedResolution,
  DYNAMIC_REFERENCE_PREFIX,
  carriesFetchableDynamicReference,
  NAMELESS_DYNAMIC_REFERENCE_MARKERS,
  isNamelessDynamicReferenceError,
  type RedactedAttributeRead,
  type ResolverContext,
  type AwsAccountInfo,
  dynamicReferenceRetryDelays,
  concurrentDrainCap,
  isClientSafeRegion,
  getAccountInfo,
  isImpossibleEmptyStoredAttribute,
  resetAccountInfoCache,
  embedsAccountId,
  type ParameterDefinition,
  isUnboundTemplateParameter,
  parameterTypeMayLoseSecretIdentity,
  coerceParameterTypedValue,
} from './intrinsic-resolver/support.js';

/**
 * Behavior knobs for {@link IntrinsicFunctionResolver}.
 */
export interface IntrinsicFunctionResolverOptions {
  /**
   * `--strict-getatt` (issue #1111): when true, EVERY unknown-attribute
   * physicalId fallback in `constructAttribute` (any suffix, not just the
   * always-fatal `*Arn` / `*Url` shape mismatches) becomes a hard error
   * instead of a warn-and-return. Default false (warn-and-return, counted
   * via {@link IntrinsicFunctionResolver.getPhysicalIdFallbackCount}).
   */
  strictGetAtt?: boolean;
  /**
   * `--no-cfn-fallback` (issue #1697): when false, disables the
   * CloudFormation fallback for cross-stack references. By default
   * (true), an `Fn::ImportValue` / `Fn::GetStackOutput` reference that
   * is not found in cdkd state falls back to CloudFormation
   * (`ListExports` / `DescribeStacks` outputs) so a cdkd-deployed
   * consumer can reference a producer stack still managed by
   * CloudFormation (`cdk deploy` / raw CFn). cdkd-first precedence is
   * inherent — the fallback only runs after a cdkd-state miss — and a
   * CFn-sourced resolution is a WEAK reference: deliberately not
   * recorded into `state.imports` / `state.outputReads` (cdkd cannot
   * protect a producer it does not manage, and CFn's export-in-use
   * protection cannot see cdkd consumers).
   */
  cfnFallback?: boolean;
  /**
   * The producer artifacts of the cloud assembly the command holds, consulted
   * LAZILY and only by an `Fn::GetStackOutput` carrying a `RoleArn`, to
   * recognize the cross-account reference aws-cdk-lib generates and read it
   * through the producer account's CDK lookup role
   * (`intrinsic-resolver/cdk-cross-account-ref.ts`). Absent: nothing is
   * classified, and every `RoleArn` behaves as it always has.
   */
  producerLookup?: ProducerLookup;
  /**
   * The account of the stack this resolver serves, as synthesized. Only the
   * refusal of an aws-cdk-lib-generated cross-account reference reads it, to
   * name the account `cdk bootstrap --trust-for-lookup` must trust.
   */
  consumerAccount?: string;
}

/**
 * CloudFormation Intrinsic Function Resolver
 *
 * Resolves CloudFormation intrinsic functions in template values before
 * sending them to Cloud Control API or SDK providers.
 *
 * Supported functions:
 * - Ref (resources and parameters)
 * - Fn::GetAtt
 * - Fn::Join
 * - Fn::Sub
 * - Fn::Select
 * - Fn::Split
 * - Fn::If (Conditions)
 * - Fn::Equals
 * - Fn::And (logical AND)
 * - Fn::Or (logical OR)
 * - Fn::Not (logical NOT)
 * - Fn::ImportValue (cross-stack references)
 * - Fn::GetStackOutput (cross-stack/cross-region output reference)
 * - Fn::FindInMap (mapping lookups)
 * - Fn::Base64 (base64 encoding)
 * - Fn::GetAZs (availability zone listing)
 * - Fn::Cidr (CIDR address block calculation)
 */
export class IntrinsicFunctionResolver {
  /** @internal */
  logger = getLogger().child('IntrinsicFunctionResolver');
  /** @internal */
  readonly resolverRegion: string;
  /**
   * The region the CONSTRUCTOR was given, or `undefined` when it was called
   * without one — unlike {@link resolverRegion}, which substitutes
   * `AWS_REGION` / `us-east-1` so every consumer has a string to work with.
   *
   * The distinction is load-bearing for `ResolverClients.clientsForRegion`
   * and for nothing else: re-pointing an AWS lookup away from the ambient clients is
   * only safe when a caller SAID which region this resolver stands for.
   *
   * IN PRODUCTION THIS IS ALWAYS SET, and saying so matters more than the
   * guard it enables. Every construction site defaults the region BEFORE the
   * constructor and passes a `string` — `deploy.ts`, `scrub.ts`, `drift.ts`,
   * `import.ts`, `export.ts`, `diff-recursive.ts`, `rollback-executor.ts` —
   * so the `undefined` arm is reachable only through the no-argument
   * constructor, which nothing but tests uses. It is kept because the
   * parameter is optional and the arm must therefore exist, not because a
   * shipped path depends on it.
   *
   * That has a USER-VISIBLE consequence, deliberately accepted (issue #1957
   * review). For a REGION-AGNOSTIC stack (no `env.region`) run with neither
   * `--region` nor `AWS_REGION`, the region those callers compute is the
   * hard-coded `us-east-1` fallback, so the lookup now goes there — where
   * before it followed the ambient clients to whatever `~/.aws/config` said.
   * The new behaviour is the consistent one: `us-east-1` is already the region
   * cdkd keys that stack's state file, its lock and its export index under, so
   * the resolved value and the record that stores it now agree. Previously
   * they did not, which is the same class of defect this issue is about, one
   * layer up. A stack WITH an explicit `env.region` is unaffected — every
   * caller prefers it (`scrub.ts` does `stack.region || region`).
   */
  /** @internal */
  readonly explicitRegion: string | undefined;
  /**
   * The AWS clients this resolver builds for itself and their caches
   * (`regionScopedClients`, `serviceDiscoveryClients`, `cfnClients`; issues
   * #1957, #1994, #1697). Created once in the constructor and never replaced,
   * so every cache lives exactly as long as this resolver, as the fields it
   * replaces did.
   * @internal
   */
  readonly clients: ResolverClients;
  /**
   * The CloudFormation fallback for cross-stack references (issue #1697) and
   * its two memos (`cfnExportsPromises`, `cfnStackOutputsCache`). Created once
   * in the constructor and never replaced, like {@link clients}.
   * @internal
   */
  readonly cfnFallbackCache: CfnFallbackCache;
  /**
   * Resolvers pinned to a PRODUCER stack's region, for re-resolving a
   * cross-stack imported value that was persisted REDACTED (issue
   * [#1934](https://github.com/go-to-k/cdkd/issues/1934)); see
   * {@link reresolveCrossStackValue}.
   *
   * A whole resolver rather than a client bag, because what has to be
   * region-scoped is not only the lookup but the VALUE CACHE behind it:
   * `DynamicReferenceCache.cachedDynamicReferences` is keyed by the expression (plus the
   * credential identity, issue #3660) and is sound only because one resolver
   * stands for one stack in one region (issue #1933). Resolving a producer's expression inside THIS resolver would put a
   * foreign region's answer under a key the consumer's own lookups read — the
   * exact cross-region leak that field's instance scope closed. A separate
   * resolver per producer region keeps that invariant by construction.
   *
   * WHAT THAT DOES *NOT* BUY, stated because an earlier revision of this note
   * implied it did: a separate instance isolates only the state this class
   * OWNS. The `{{resolve:...}}` SECRET VERDICT store lives in
   * `secret-redaction.ts`, is process-global and is keyed by the expression
   * string alone, so a guest's resolution would still pin a foreign region's
   * verdict for every later reader. That half is closed at the WRITE instead —
   * see {@link pinSecretVerdict} and {@link producerRegionGuest}, which also
   * record why re-keying that store is not available from this lane.
   *
   * Bounded like `ResolverClients.regionScopedClients`: an entry exists only for a
   * producer region that DIFFERS from this resolver's own, and at most one per
   * such region. Same lifetime too — the resolver's own, with no teardown.
   */
  private readonly producerRegionResolvers = new Map<string, IntrinsicFunctionResolver>();
  /**
   * True on a resolver built by {@link resolverForProducerRegion} to answer for
   * ANOTHER stack's region — a read-only guest of this deploy.
   *
   * Its one consequence is {@link pinSecretVerdict}: a guest never writes the
   * PROCESS-GLOBAL secret-verdict store, because a verdict keyed by the
   * expression string alone would carry a foreign region's answer into the
   * consumer's own next pass. Deliberately NOT on
   * {@link IntrinsicFunctionResolverOptions} — no caller outside this class may
   * declare itself a guest, and the flag is set by the one line that builds
   * one.
   */
  /** @internal */
  producerRegionGuest = false;

  /**
   * How a producer-region guest PRINTS its own `explicitRegion` (issue
   * [#3150](https://github.com/go-to-k/cdkd/issues/3150)): the masked log text
   * its creator held for that region, which a template can assemble around a
   * short secret, or `***` once a later spelling of the same region masks
   * differently. Display only; `undefined` on an ordinary resolver, whose
   * region its command built (the stack's synthesized or recorded region,
   * `--region`, or a region read out of a literal token).
   */
  /** @internal */
  explicitRegionLogText: string | undefined;
  /** @internal */
  readonly strictGetAtt: boolean;
  /** @internal */
  readonly cfnFallback: boolean;
  /** @internal */
  readonly producerLookup: ProducerLookup | undefined;
  /** @internal */
  readonly consumerAccount: string | undefined;
  /**
   * Memoized {@link classifyCdkCrossAccountRef} verdicts, keyed by producer
   * stack, account, region and role name: a stack referencing one producer
   * from many sites classifies it once.
   */
  /** @internal */
  readonly cdkCrossAccountRefVerdicts = new Map<string, CdkCrossAccountRefVerdict>();
  /**
   * Number of unknown-attribute resolutions that fell back to the physical
   * ID (the warn path) since construction / the last
   * {@link resetPhysicalIdFallbackCount}. Counting semantics (issue #1111
   * item 3): the deploy engine resets this at the start of each `deploy()`
   * run AND again right before provisioning on the change path — the diff
   * phase resolves through this same counted resolver, so without the
   * second reset a fallback site on a to-be-updated resource would count
   * once during diff and again during provisioning (~2x distinct sites in
   * the summary). Each distinct fallback site therefore counts once per
   * run: the surfaced summary covers provisioning + output resolution on
   * the change path, diff + output resolution on the no-change path, and
   * diff only under --dry-run. Instance-scoped, so parallel stacks (each
   * with their own engine + resolver) never share a counter; for the same
   * reason a nested-stack CHILD engine's fallbacks are counted by the
   * child's own resolver and are NOT aggregated into the parent stack's
   * deploy summary.
   */
  /** @internal */
  physicalIdFallbackCount = 0;

  /**
   * The dynamic-reference value cache (`cachedDynamicReferences`, issues
   * #1933, #3660) and the warned-once set for anomalous SSM `Type`s
   * (`warnedUnrecognizedSsmTypes`). Created once in the constructor and never
   * replaced or cleared, like {@link clients}; a producer-region guest is its
   * own resolver and builds its own.
   * @internal
   */
  readonly dynamicReferenceCache: DynamicReferenceCache;

  constructor(region?: string, options?: IntrinsicFunctionResolverOptions) {
    this.resolverRegion = region || process.env['AWS_REGION'] || 'us-east-1';
    this.explicitRegion = region || undefined;
    this.strictGetAtt = options?.strictGetAtt ?? false;
    this.cfnFallback = options?.cfnFallback ?? true;
    this.producerLookup = options?.producerLookup;
    this.consumerAccount = options?.consumerAccount;
    // `explicitRegion` and `resolverRegion` are assigned above and nowhere
    // else, so they pass by value. `explicitRegionLogText` is set on a
    // producer-region guest AFTER construction (and can turn into `***`), and
    // `logger` is a writable field, so both are read live. The masker is this
    // resolver itself, whose methods read its bags at call time.
    this.clients = new ResolverClients({
      explicitRegion: this.explicitRegion,
      explicitRegionLogText: () => this.explicitRegionLogText,
      logger: () => this.logger,
    });
    this.cfnFallbackCache = new CfnFallbackCache({
      clients: this.clients,
      resolverRegion: this.resolverRegion,
      logger: () => this.logger,
      resolver: this,
    });
    this.dynamicReferenceCache = new DynamicReferenceCache();
  }

  /** Unknown-attribute physicalId fallbacks recorded since the last reset. */
  getPhysicalIdFallbackCount(): number {
    return this.physicalIdFallbackCount;
  }

  /** Reset the per-run fallback counter (called at the start of each deploy). */
  resetPhysicalIdFallbackCount(): void {
    this.physicalIdFallbackCount = 0;
  }

  /**
   * Resolve an SSM Parameter Store path to its actual value.
   * Used for parameters with type AWS::SSM::Parameter::Value<...>.
   * @internal
   */
  async resolveSSMParameter(parameterName: string): Promise<string> {
    // Region-sensitive: SSM parameters are regional and independent, so the
    // same path in two regions is two different values (issue #1957).
    const client = this.clients.clientsForRegion(this.explicitRegion).ssm;
    const response = await client.send(new GetParameterCommand({ Name: parameterName }));
    return response.Parameter?.Value ?? '';
  }

  /**
   * Coerce parameter value to the correct type based on parameter definition
   * @internal
   */
  coerceParameterValue(value: string, type: string): unknown {
    return coerceParameterTypedValue(value, type);
  }

  /**
   * Resolve all intrinsic functions in a value
   */
  async resolve(value: unknown, context: ResolverContext): Promise<unknown> {
    // One drain budget per CALL unless the caller already opened one; see
    // {@link withSharedDrainBudget}.
    return await withSharedDrainBudget(() => this.resolveValue(value, context));
  }

  /**
   * Warn that a drain stopped waiting for `pending` inputs of a failed
   * resolution (issue [#2814](https://github.com/go-to-k/cdkd/issues/2814)).
   * The helper calls this at most once per budget. The text carries a count
   * and the cap, nothing the template or AWS supplied, so it needs no masking.
   */
  /** @internal */
  warnAbandonedParts(pending: number): void {
    const capSeconds = (concurrentDrainCap.ms ?? DRAIN_AFTER_REJECTION_MS) / 1000;
    const parts = pending === 1 ? '1 concurrent part was' : `${pending} concurrent parts were`;
    // not-in-class(parts): a COUNT of the drain's still-pending inputs in
    // fixed wording, never a resolved value.
    // not-in-class(capSeconds): the drain cap in seconds -- a constant, or
    // the `concurrentDrainCap` test seam.
    this.logger.warn(
      `A resolution failed while ${parts} still running, and cdkd stopped waiting ` +
        `because the wait after a failure (capped at ${capSeconds}s) was used up. ` +
        'A secret such a part resolves from now on is still recorded, but only what ' +
        'runs after it arrives can mask it: output already printed or saved is not revisited.'
    );
  }

  /**
   * Record where a cross-stack read's value lies on the string it resolved to
   * -- the whole of it -- as the parameter `Ref` arm below does (issue
   * #4527). An `Fn::Join` / `Fn::Sub` holding `source` reads that span to
   * position the read on its own output, and an `Fn::If` selecting it lends
   * it, so an EMBEDDED read is answered from its own association however many
   * parts beside it have no fixed text. Any STRING value is recorded, spans or
   * not (an empty one, a source with no key), in the same shape the `Ref` arm
   * records a parameter's; a record with no span reads exactly as no record.
   */
  private recordCrossStackReadSpan(
    context: ResolverContext,
    source: Record<string, unknown>,
    value: unknown
  ): unknown {
    if (typeof value === 'string') {
      recordLeafResolution(this, context, source, {
        input: value,
        output: value,
        substitutions: [],
        complete: true,
        parameterSpans: wholeReferenceSpans(source, value),
      });
    }
    return value;
  }

  /** Recursively resolve a value. */
  /** @internal */
  async resolveValue(value: unknown, context: ResolverContext): Promise<unknown> {
    // Primitives: return as-is (but check strings for dynamic references)
    if (typeof value !== 'object' || value === null) {
      if (typeof value === 'string' && value.includes('{{resolve:')) {
        // `skipDynamicReferences` leaves SECRET references unresolved (handled
        // per-reference inside resolveDynamicReferences) but still resolves an
        // ssm reference to a `String` / `StringList` parameter — that is public
        // config, stored RESOLVED in state, so the diff must resolve it too to
        // compare like-for-like. An ssm reference to a `SecureString` is a
        // secret and is left unresolved with the rest (issue #1901).
        return await resolveTemplateLeafReferences(this, value, context);
      }
      return value;
    }

    // Arrays: resolve each element, filtering out AWS::NoValue
    if (Array.isArray(value)) {
      // Drained, not a bare `Promise.all`: a list is a concurrent resolution
      // like a join's parts, and a list nested INSIDE a join part is how a
      // join-level drain alone would still let a late recording escape (issue
      // #2563).
      const resolved = await allSettledKeepingFirstRejection(
        () => value.map((v) => this.resolveValue(v, context)),
        (pending) => this.warnAbandonedParts(pending)
      );
      const kept = resolved.filter((v) => v !== AWS_NO_VALUE);
      // Issue #4954: which elements dropped, for the persist walk pairing a
      // shrunken bag array with its source; only when one did.
      if (kept.length !== resolved.length) {
        const dropped: number[] = [];
        resolved.forEach((v, i) => {
          if (v === AWS_NO_VALUE) dropped.push(i);
        });
        recordDroppedArrayElementsIn(context, value, dropped);
      }
      return kept;
    }

    const obj = value as Record<string, unknown>;

    // Check for intrinsic functions
    if ('Ref' in obj) {
      // A `Ref` the PARAMETER arm answers records where its value lies on the
      // string it resolved to (issue #4446): the whole of it. An `Fn::Join` /
      // `Fn::Sub` holding this object reads that span to position the
      // parameter on its own output, and an `Fn::If` selecting it lends it.
      // Only a STRING value has spans; any other is `String()`-rendered by the
      // embedding intrinsic and positioned by nothing.
      const logicalId = obj['Ref'] as string;
      let fromParameter = false;
      const value = await resolveRef(this, logicalId, context, () => {
        fromParameter = true;
      });
      if (fromParameter && typeof value === 'string') {
        recordLeafResolution(this, context, obj, {
          input: value,
          output: value,
          substitutions: [],
          complete: true,
          parameterSpans: wholeReferenceSpans({ Ref: logicalId }, value),
        });
      }
      return value;
    }

    if ('Fn::GetAtt' in obj) {
      return this.recordCrossStackReadSpan(
        context,
        obj,
        await resolveGetAtt(this, obj['Fn::GetAtt'] as [string, unknown] | string, context)
      );
    }

    // Both pass the intrinsic OBJECT itself, the key its resolution record is
    // stored under for this pass (issue #3156).
    if ('Fn::Join' in obj) {
      return await resolveJoin(this, obj['Fn::Join'] as [string, unknown], context, obj);
    }

    if ('Fn::Sub' in obj) {
      return await resolveSub(
        this,
        obj['Fn::Sub'] as string | [string, Record<string, unknown>],
        context,
        obj
      );
    }

    if ('Fn::Select' in obj) {
      return await resolveSelect(this, obj['Fn::Select'], context);
    }

    if ('Fn::Split' in obj) {
      return await resolveSplit(this, obj['Fn::Split'] as [string, unknown], context);
    }

    if ('Fn::If' in obj) {
      return await resolveIf(this, obj['Fn::If'] as [string, unknown, unknown], context, obj);
    }

    if ('Fn::Equals' in obj) {
      return await resolveEquals(this, obj['Fn::Equals'] as [unknown, unknown], context);
    }

    // `{Condition: <name>}` — a named-condition reference. Valid only inside
    // another condition's definition (`Fn::And` / `Fn::Or` / `Fn::Not`),
    // where it resolves to the referenced condition's evaluated boolean
    // (issue #840). This form is ONLY reachable during `evaluateConditions`,
    // which is the sole code path that threads a `conditionResolver` hook onto
    // the context — so gate the branch on `context.conditionResolver` being
    // present. Outside that context (a normal resource / output property), a
    // single-key `{Condition: "<string>"}` object is a plain property literally
    // named `Condition`, NOT an intrinsic, and must fall through to be resolved
    // as an ordinary object — otherwise it would be silently coerced to a
    // boolean (and to `false`, since neither the resolver hook nor the
    // already-evaluated `conditions` map is available there), corrupting the
    // property. The single-key + `typeof string` guards remain as defense in
    // depth so even inside `evaluateConditions` a composite-condition object
    // carrying sibling keys is never misread as the reference form.
    if (
      context.conditionResolver &&
      'Condition' in obj &&
      Object.keys(obj).length === 1 &&
      typeof obj['Condition'] === 'string'
    ) {
      return await resolveConditionReference(this, obj['Condition'], context);
    }

    if ('Fn::And' in obj) {
      return await resolveAnd(this, obj['Fn::And'] as unknown[], context);
    }

    if ('Fn::Or' in obj) {
      return await resolveOr(this, obj['Fn::Or'] as unknown[], context);
    }

    if ('Fn::Not' in obj) {
      return await resolveNot(this, obj['Fn::Not'] as [unknown], context);
    }

    if ('Fn::ImportValue' in obj) {
      return this.recordCrossStackReadSpan(
        context,
        obj,
        await resolveImportValue(this, obj['Fn::ImportValue'], context)
      );
    }

    if ('Fn::GetStackOutput' in obj) {
      return this.recordCrossStackReadSpan(
        context,
        obj,
        await resolveGetStackOutput(this, obj['Fn::GetStackOutput'], context)
      );
    }

    if ('Fn::FindInMap' in obj) {
      return await resolveFindInMap(
        this,
        obj['Fn::FindInMap'] as [unknown, unknown, unknown] | [unknown, unknown, unknown, unknown],
        context
      );
    }

    if ('Fn::Base64' in obj) {
      return await resolveBase64(this, obj['Fn::Base64'], context);
    }

    if ('Fn::GetAZs' in obj) {
      return await resolveGetAZs(this, obj['Fn::GetAZs'], context);
    }

    if ('Fn::Cidr' in obj) {
      return await resolveCidr(this, obj['Fn::Cidr'] as [unknown, unknown, unknown], context);
    }

    // Unknown intrinsic: a lone `{ "Ref": ... }` / `{ "Fn::X": ... }` whose key
    // is not in the handled set above. Hard-error instead of silently passing
    // the broken value through to the provider (e.g. CFn language extensions
    // like Fn::ToJsonString / Fn::Length / Fn::ForEach that cdkd cannot
    // resolve). The single-key guard means a real property literally named
    // "Ref"/"Fn::Something" alongside siblings is NOT misdetected.
    const unknownIntrinsicKey = detectUnknownIntrinsicKey(obj);
    if (unknownIntrinsicKey !== undefined) {
      // The message is composed inside `buildUnknownIntrinsicError`, and its two
      // interpolations are annotated THERE. A second note here would be a copy
      // of an argument made at the construction site, on a statement that
      // composes nothing.
      // `markNonRetryable` (go-to-k/cdkd#1889): an unsupported intrinsic stays
      // unsupported on a retry, and the key is template text.
      throw markNonRetryable(buildUnknownIntrinsicError(unknownIntrinsicKey));
    }

    // Not an intrinsic function: recursively resolve object properties.
    //
    // A `__proto__` key is written with `defineProperty` (issue #2767). The keys
    // come from the TEMPLATE and `JSON.parse` makes `__proto__` an OWN key, so
    // `Object.entries` yields it -- but `resolved['__proto__'] = v` routes
    // through the inherited setter and the key is simply ABSENT from the result,
    // with no error and no warning. This object is what deploy hands the
    // provider, so a free-form property bag lost the entry silently: a custom
    // resource's properties, ECS `DockerLabels`, a Step Functions
    // `DefinitionSubstitutions` map.
    //
    // `Object.create(null)` is the obvious fix and is what `secret-redaction.ts`
    // uses at its four comparable walks. It is WRONG HERE, because this bag is a
    // resolved VALUE and callers coerce one: `String()` on a null-prototype
    // object throws `Cannot convert object to primitive value` where it returned
    // `[object Object]` -- reachable from `resolveJoin`'s `String(resolved)` on
    // an object-valued part, and from `resolveSub`, whose catch would launder
    // the throw into a retained `${...}` placeholder. Shadowing the one key
    // keeps the prototype, so every consumer and every coercion is untouched and
    // the fix carries no behaviour change beyond the key surviving.
    const resolved: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      // Per-KEY recovery (issue go-to-k/cdkd#3218), the sibling of the
      // per-token one in `resolveDynamicReferencesWithLogTwin`. It is a
      // SEPARATE fix and not a consequence of that one: #3218's repro fails on
      // `{"A": {"Ref": "NoSuchThing"}, "B": "{{resolve:secretsmanager:...}}"}`,
      // where `A` throws out of `resolveRef` and never reaches the token loop
      // at all, so `B` was never fetched and recorded no needle — and a needle
      // is the only thing that drives redaction.
      //
      // The bag test is HERE, not inside the helper: see `resolveKeyUnit`'s
      // doc for why an extra async frame per nesting level is not free.
      const resolvedVal =
        context.abandonedResolutions === undefined
          ? await this.resolveValue(val, context)
          : await resolveKeyUnit(this, key, val, context, context.abandonedResolutions);
      // Skip properties that resolve to AWS::NoValue
      if (resolvedVal !== AWS_NO_VALUE) {
        if (key === '__proto__') {
          Object.defineProperty(resolved, key, {
            value: resolvedVal,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        } else {
          resolved[key] = resolvedVal;
        }
      } else {
        // `key` is a template object key -- arbitrary JSON, same class as a
        // `Resources` key (go-to-k/cdkd#3435 review round 2).
        this.logger.debug(
          `Property ${logRender(this, key, context)} resolved to AWS::NoValue, omitting from object`
        );
      }
    }
    return resolved;
  }

  /**
   * The resolver for a region-LESS token whose v12 record names `region` as
   * the one that resolved it (go-to-k/cdkd#4847): this resolver for its own
   * region, otherwise its producer-region GUEST for `region`, which pins no
   * verdict in the process-global store a region-less key shares across
   * regions. What the rollback replay, `cdkd drift` and `cdkd scrub` route a
   * recorded region through.
   */
  resolverForRecordedRegion(region: string): IntrinsicFunctionResolver {
    return this.resolverForProducerRegion(region);
  }

  /** @internal */
  resolverForProducerRegion(
    producerRegion: string | undefined,
    context?: ResolverContext,
    // The region's log text when the caller holds it: a region parsed out of a
    // dynamic reference, or one `canonicalizeRegion` already transformed
    // (issue #3150), which may therefore already be lowercased; lowercasing
    // it again is a no-op. Otherwise the raw region's twin is looked up.
    producerRegionLogText?: string
  ): IntrinsicFunctionResolver {
    if (!producerRegion) return this;
    const target = canonicalizeRegion(producerRegion);
    if (sameRegion(target, this.explicitRegion)) return this;

    // The region as `regionLogText` spells it (issue #3150): a `Fn::GetStackOutput`
    // region or a secret ARN's region can be assembled around a short secret.
    // A guest prints it on its region-scoped clients line and in that method's
    // refusal, which strips it and cuts it to 64 characters: hence mask, strip,
    // mask, as the `Fn::GetAZs` gate does. The creation line below prints the
    // same text.
    const regionText =
      producerRegionLogText !== undefined
        ? canonicalizeRegion(producerRegionLogText)
        : regionLogText(this, producerRegion, context);
    // THE BUILDER, not the bare strip-and-mask helper (go-to-k/cdkd#3426):
    // this text is printed on the line below AND carried on the guest as
    // `explicitRegionLogText`, which `clientsForRegion` prints again, so it
    // owes `displaySafe` as well as the strip. The equality test below compares
    // two texts built the same way, so routing both through the builder leaves
    // the "two spellings mask differently" verdict unchanged.
    const guestRegionText = displayMasked(this, regionText, context);

    const cached = this.producerRegionResolvers.get(target);
    if (cached) {
      // One guest serves every spelling of its canonical region, and its text
      // came from the first. A later spelling that masks differently (a literal
      // `us-west-2_q7` beside an `Fn::Sub` assembling it around a recorded
      // `q7`) makes the guest print `***` from then on, not the first's text.
      if (cached.explicitRegionLogText !== guestRegionText) {
        cached.explicitRegionLogText = SECRET_MASK;
      }
      return cached;
    }

    const scoped = new IntrinsicFunctionResolver(target, {
      strictGetAtt: this.strictGetAtt,
      cfnFallback: this.cfnFallback,
    });
    // Set after construction rather than through the options bag: this is an
    // INTERNAL mode with exactly one producer (the line above), and nothing
    // outside this class may declare itself a guest.
    scoped.producerRegionGuest = true;
    scoped.explicitRegionLogText = guestRegionText;
    this.producerRegionResolvers.set(target, scoped);
    this.logger.debug(`Using a producer-region resolver for ${guestRegionText}`);
    return scoped;
  }

  /**
   * The template's parameter values: user-provided first, then each `Default`
   * (`resolveParameters` in `intrinsic-resolver/params-conditions.ts`).
   */
  resolveParameters(
    template: CloudFormationTemplate,
    userParameters?: Record<string, string>,
    options?: Parameters<typeof resolveTemplateParameters>[3]
  ): Promise<Record<string, unknown>> {
    return resolveTemplateParameters(this, template, userParameters, options);
  }

  /**
   * Every template `Conditions` entry, evaluated (`evaluateConditions` in
   * `intrinsic-resolver/params-conditions.ts`).
   */
  evaluateConditions(context: ResolverContext): Promise<Record<string, boolean>> {
    return evaluateTemplateConditions(this, context);
  }
}
