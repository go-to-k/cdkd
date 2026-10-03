import type { CloudFormationClient, Export as CfnExport } from '@aws-sdk/client-cloudformation';
import type { ServiceDiscoveryClient } from '@aws-sdk/client-servicediscovery';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { getLogger } from '../utils/logger.js';
import { type AwsClients } from '../utils/aws-clients.js';
import { canonicalizeRegion } from '../utils/aws-partition.js';
import { withSharedDrainBudget } from './drain-budget.js';
import { SECRET_MASK } from './secret-redaction.js';
import {
  type ResolverContext,
  type CachedDynamicReference,
  AWS_NO_VALUE,
  detectUnknownIntrinsicKey,
  buildUnknownIntrinsicError,
  DRAIN_AFTER_REJECTION_MS,
  concurrentDrainCap,
  allSettledKeepingFirstRejection,
  coerceParameterTypedValue,
} from './intrinsic-resolver/support.js';
import * as getAttMixin from './intrinsic-resolver/getatt.js';
import * as getAttRefusalsMixin from './intrinsic-resolver/getatt-refusals.js';
import * as getAttHealMixin from './intrinsic-resolver/getatt-heal.js';
import * as crossStackMixin from './intrinsic-resolver/cross-stack.js';
import * as cfnFallbackMixin from './intrinsic-resolver/cfn-fallback.js';
import * as stackOutputMixin from './intrinsic-resolver/stack-output.js';
import * as stackStateMixin from './intrinsic-resolver/stack-state.js';
import * as dynamicRefsMixin from './intrinsic-resolver/dynamic-refs.js';
import * as stringFnMixin from './intrinsic-resolver/string-functions.js';
import * as fnMixin from './intrinsic-resolver/functions.js';
import * as maskingMixin from './intrinsic-resolver/masking.js';
import * as paramsConditionsMixin from './intrinsic-resolver/params-conditions.js';
import * as parameterSecretsMixin from './intrinsic-resolver/parameter-secrets.js';
import * as refsMixin from './intrinsic-resolver/refs.js';
import * as clientsMixin from './intrinsic-resolver/clients.js';
export {
  AWS_NO_VALUE,
  isStalePlaceholderArnAttribute,
  type RefStateLookup,
  type RefStateLookupOptions,
  refStateLookupFromResource,
  glueTableRefFromPhysicalId,
  cfnRefValueFromPhysicalId,
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
  accountInfoClock,
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
   * The distinction is load-bearing for {@link clientsForRegion} and for
   * nothing else: re-pointing an AWS lookup away from the ambient clients is
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
   * AWS clients pinned to a region OTHER than the ambient singleton's, built
   * lazily on first mismatch and keyed by region (issue #1957).
   *
   * Lifetime is deliberately the resolver's own, matching {@link cfnClients}
   * two fields down: both are per-region SDK clients this instance builds for
   * itself, and neither is destroyed, because `IntrinsicFunctionResolver` has
   * no teardown hook and every construction site (`DeployEngine`, `scrub`,
   * `drift`, `import`, `diff-recursive`, `export`, `rollback-executor`) would
   * have to grow one. The bound on what that costs is small and worth stating:
   * an entry exists only when a resolver's region DIFFERS from the ambient
   * one — i.e. only on a genuinely cross-region run — and at most one per
   * foreign region per resolver, versus the ambient clients which are already
   * created and destroyed per stack by `deploy.ts`.
   *
   * KEYED BY REGION AND CREDENTIAL FINGERPRINT ({@link clientCacheKey}, issue
   * [#3588](https://github.com/go-to-k/cdkd/issues/3588)). An entry pins the
   * credential configuration of the ambient instance it was derived from, and
   * that half is process-wide only for the CLI (one `--profile`, one
   * `--role-arn`): a LIBRARY caller can drive one resolver across two
   * `setAwsClients` installs (or cdkd's per-stack scopes) with different
   * explicit credentials, and keyed by region alone the second's lookups ran under the first's
   * identity. {@link cfnClients} and {@link serviceDiscoveryClients} share the
   * key for the same reason, and the two CloudFormation fallback memos
   * ({@link cfnExportsPromises}, {@link cfnStackOutputsCache}) carry the
   * fingerprint too.
   *
   * The VALUE caches carry the fingerprint as well (issue
   * [#3660](https://github.com/go-to-k/cdkd/issues/3660)):
   * {@link cachedDynamicReferences}, and the process-global account identity
   * behind `getAccountInfo` and `cachedAvailabilityZones`.
   * @internal
   */
  readonly regionScopedClients = new Map<string, AwsClients>();
  /**
   * ServiceDiscovery clients keyed by the region {@link clientsForRegion}
   * selected (`''` when it selected none). See {@link serviceDiscoveryClient}
   * for why this one service is not read off an `AwsClients` bag, and why the
   * PROMISE rather than the client is what is stored.
   * @internal
   */
  readonly serviceDiscoveryClients = new Map<string, Promise<ServiceDiscoveryClient>>();
  /**
   * Resolvers pinned to a PRODUCER stack's region, for re-resolving a
   * cross-stack imported value that was persisted REDACTED (issue
   * [#1934](https://github.com/go-to-k/cdkd/issues/1934)); see
   * {@link reresolveCrossStackValue}.
   *
   * A whole resolver rather than a client bag, because what has to be
   * region-scoped is not only the lookup but the VALUE CACHE behind it:
   * {@link cachedDynamicReferences} is keyed by the expression (plus the
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
   * Bounded like {@link regionScopedClients}: an entry exists only for a
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
  /**
   * Per-region CloudFormation clients for the cross-stack fallback
   * lookups (issue #1697). Keyed by region because `Fn::GetStackOutput`
   * may target a region different from the consumer's deploy region, and by
   * the credential fingerprint for {@link regionScopedClients}' reason.
   */
  /** @internal */
  readonly cfnClients = new Map<string, CloudFormationClient>();
  /**
   * Memoized full `ListExports` listing for the `Fn::ImportValue`
   * fallback (issue #1697 review). Without it, EVERY cdkd-miss import
   * re-paginates the whole region's export list — a deploy consuming N
   * values from CFn producers pays N full walks and exposes itself to
   * ListExports throttling. Resolver instances are per-deploy (the
   * engine constructs one per stack), so the cache lifetime matches the
   * exports-index philosophy: stable within a deploy, fresh across
   * deploys. FAILED fetches are not cached (the rejection handler
   * clears the slot) so a transient throttle does not poison the rest
   * of the deploy's lookups.
   *
   * Keyed by the credential fingerprint (issue #3588): a listing is an answer
   * one identity was allowed to read, so it is never handed to another.
   */
  /** @internal */
  readonly cfnExportsPromises = new Map<string, Promise<CfnExport[]>>();
  /**
   * Memoized per-(region, stack) `DescribeStacks` outputs for the
   * `Fn::GetStackOutput` fallback (issue #1697 review) — a stack
   * referencing the same CFn producer N times pays one call. Successful
   * lookups (including the definitive "stack does not exist" miss) are
   * cached; lookup FAILURES are evicted so they are retried. Keyed by the
   * credential fingerprint as well, for {@link cfnExportsPromises}' reason.
   */
  /** @internal */
  readonly cfnStackOutputsCache = new Map<string, Promise<Record<string, string> | undefined>>();
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
   * Resolved `{{resolve:secretsmanager:...}}` / `{{resolve:ssm:...}}` values,
   * keyed by the full expression and the credential identity that read it
   * (`injectiveKey(credentialFingerprint, expression)`, issue
   * [#3660](https://github.com/go-to-k/cdkd/issues/3660): a library caller can
   * drive one resolver under two `AwsClients` identities, and the same NAME
   * read by two accounts is two values) — INSTANCE-scoped, which closes the CACHE half
   * of issue [#1933](https://github.com/go-to-k/cdkd/issues/1933). The issue is
   * only PARTIALLY addressed by this field: see "what this does NOT settle"
   * below.
   *
   * It used to be a module-global map keyed by the expression ALONE, and both
   * halves of that were wrong for the same reason: the key and the lifetime
   * were narrower than the value they stood for.
   *
   * - REGION. Secrets Manager secrets and SSM parameters are regional and
   *   independent — the same NAME in `us-east-1` and `ap-northeast-1` is two
   *   different values, routinely two different credentials — so the first
   *   region to resolve an expression won it for the whole process, and every
   *   later stack in every other region silently reused that value.
   * - STACK. Nothing reset the map between stacks, so a second stack's
   *   resolution cache-HIT and skipped the lookup that re-records the value as
   *   a secret. `cdkd scrub --all` then found an empty secrets map for that
   *   stack and reported it clean.
   *
   * Instance scope settles both at once because a region boundary and a stack
   * boundary are BOTH resolver boundaries in cdkd: {@link resolverRegion} is
   * fixed at construction, and every caller builds one resolver per stack
   * (`DeployEngine` per deploy, `scrub` / `import` / `diff-recursive` /
   * `rollback-executor` per stack). Re-keying by region alone would have left
   * the stack half open, which is why the lifetime — not the key — is what
   * moved.
   *
   * ONE caller is a known EXCEPTION to that invariant, and it is written down
   * here because an invariant recorded without its exception is how the next
   * change breaks it: `cdkd export` builds a single `paramResolver`
   * (`src/cli/commands/export.ts`, the `buildResolvedParametersPerStack`
   * pre-pass) and shares it across every node of a nested-stack tree, while the
   * nodes carry a per-node `region`. It is safe TODAY for two independent
   * reasons — the resolver is constructed with the tree's single `rootRegion`
   * and nested children do not yet diverge from it, and that pre-pass passes no
   * `recordedSecretValues` bag, so neither the region nor the secrets-recording
   * dimension has anything to cross. Both stop holding the moment cross-region
   * nested stacks ship or that pass starts recording secrets; a resolver per
   * node is the fix then, not a wider key here.
   *
   * The OTHER half of the same outcome — the lookups themselves reading the
   * process-ambient `getAwsClients()` singleton, whose region is whichever the
   * process installed last — was issue
   * [#1957](https://github.com/go-to-k/cdkd/issues/1957) and is now closed by
   * {@link clientsForRegion}: a resolver whose region differs from the ambient
   * one builds its own region-pinned clients (carrying the ambient profile /
   * credentials) instead of reading whatever the singleton currently holds.
   * The two halves remain SEPARATE mechanisms and both are needed — this field
   * stops a resolved value from travelling between regions or stacks, while
   * the scoped clients stop the FIRST resolution from reading the wrong region
   * (no cache involved, so nothing here could ever have prevented it).
   */
  /** @internal */
  readonly cachedDynamicReferences = new Map<string, CachedDynamicReference>();

  /**
   * `(parameter name, reported Type)` pairs this resolver has already
   * warned about (issue #1933 review).
   *
   * Keyed on the PAIR rather than the name alone: two different anomalous types
   * for one parameter are two different facts — the line REPORTS the type, so
   * suppressing the second would hide a `Type` nobody has seen yet behind one
   * that was already explained. The volume problem this set exists for is N
   * IDENTICAL lines for N occurrences of one reference, which the pair still
   * bounds, because the type is a property of the parameter rather than of the
   * occurrence.
   *
   * The warning is per LOOKUP, and a parameter with an anomalous `Type` is
   * deliberately never cached (see `cacheable` in `resolveDynamicReferences`),
   * so it is re-looked-up for every occurrence of the reference in the stack —
   * which without this set means one identical warn line per occurrence per
   * pass, on the exact template that most needs the line to be READ. Scoped to
   * the resolver, like the value cache: a different stack genuinely deserves
   * its own warning, since the parameter it names may be a different region's.
   */
  /** @internal */
  readonly warnedUnrecognizedSsmTypes = new Set<string>();

  constructor(region?: string, options?: IntrinsicFunctionResolverOptions) {
    this.resolverRegion = region || process.env['AWS_REGION'] || 'us-east-1';
    this.explicitRegion = region || undefined;
    this.strictGetAtt = options?.strictGetAtt ?? false;
    this.cfnFallback = options?.cfnFallback ?? true;
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
    const client = this.clientsForRegion(this.explicitRegion).ssm;
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
        return await this.resolveTemplateLeafReferences(value, context);
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
      return resolved.filter((v) => v !== AWS_NO_VALUE);
    }

    const obj = value as Record<string, unknown>;

    // Check for intrinsic functions
    if ('Ref' in obj) {
      return await this.resolveRef(obj['Ref'] as string, context);
    }

    if ('Fn::GetAtt' in obj) {
      return await this.resolveGetAtt(obj['Fn::GetAtt'] as [string, unknown] | string, context);
    }

    // Both pass the intrinsic OBJECT itself, the key its resolution record is
    // stored under for this pass (issue #3156).
    if ('Fn::Join' in obj) {
      return await this.resolveJoin(obj['Fn::Join'] as [string, unknown], context, obj);
    }

    if ('Fn::Sub' in obj) {
      return await this.resolveSub(
        obj['Fn::Sub'] as string | [string, Record<string, unknown>],
        context,
        obj
      );
    }

    if ('Fn::Select' in obj) {
      return await this.resolveSelect(obj['Fn::Select'], context);
    }

    if ('Fn::Split' in obj) {
      return await this.resolveSplit(obj['Fn::Split'] as [string, unknown], context);
    }

    if ('Fn::If' in obj) {
      return await this.resolveIf(obj['Fn::If'] as [string, unknown, unknown], context, obj);
    }

    if ('Fn::Equals' in obj) {
      return await this.resolveEquals(obj['Fn::Equals'] as [unknown, unknown], context);
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
      return await this.resolveConditionReference(obj['Condition'], context);
    }

    if ('Fn::And' in obj) {
      return await this.resolveAnd(obj['Fn::And'] as unknown[], context);
    }

    if ('Fn::Or' in obj) {
      return await this.resolveOr(obj['Fn::Or'] as unknown[], context);
    }

    if ('Fn::Not' in obj) {
      return await this.resolveNot(obj['Fn::Not'] as [unknown], context);
    }

    if ('Fn::ImportValue' in obj) {
      return await this.resolveImportValue(obj['Fn::ImportValue'], context);
    }

    if ('Fn::GetStackOutput' in obj) {
      return await this.resolveGetStackOutput(obj['Fn::GetStackOutput'], context);
    }

    if ('Fn::FindInMap' in obj) {
      return await this.resolveFindInMap(
        obj['Fn::FindInMap'] as [unknown, unknown, unknown] | [unknown, unknown, unknown, unknown],
        context
      );
    }

    if ('Fn::Base64' in obj) {
      return await this.resolveBase64(obj['Fn::Base64'], context);
    }

    if ('Fn::GetAZs' in obj) {
      return await this.resolveGetAZs(obj['Fn::GetAZs'], context);
    }

    if ('Fn::Cidr' in obj) {
      return await this.resolveCidr(obj['Fn::Cidr'] as [unknown, unknown, unknown], context);
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
      throw buildUnknownIntrinsicError(unknownIntrinsicKey);
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
          : await this.resolveKeyUnit(key, val, context, context.abandonedResolutions);
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
          `Property ${this.logRender(key, context)} resolved to AWS::NoValue, omitting from object`
        );
      }
    }
    return resolved;
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
    if (target === canonicalizeRegion(this.explicitRegion)) return this;

    // The region as `regionLogText` spells it (issue #3150): a `Fn::GetStackOutput`
    // region or a secret ARN's region can be assembled around a short secret.
    // A guest prints it on its region-scoped clients line and in that method's
    // refusal, which strips it and cuts it to 64 characters: hence mask, strip,
    // mask, as the `Fn::GetAZs` gate does. The creation line below prints the
    // same text.
    const regionText =
      producerRegionLogText !== undefined
        ? canonicalizeRegion(producerRegionLogText)
        : this.regionLogText(producerRegion, context);
    // THE BUILDER, not the bare strip-and-mask helper (go-to-k/cdkd#3426):
    // this text is printed on the line below AND carried on the guest as
    // `explicitRegionLogText`, which `clientsForRegion` prints again, so it
    // owes `displaySafe` as well as the strip. The equality test below compares
    // two texts built the same way, so routing both through the builder leaves
    // the "two spellings mask differently" verdict unchanged.
    const guestRegionText = this.displayMasked(regionText, context);

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
}

IntrinsicFunctionResolver.prototype.maskSecretsRaw = maskingMixin.maskSecretsRaw;
IntrinsicFunctionResolver.prototype.abandonedUnit = maskingMixin.abandonedUnit;
IntrinsicFunctionResolver.prototype.maskNeedlesForLog = maskingMixin.maskNeedlesForLog;
IntrinsicFunctionResolver.prototype.hasLogOnlyNeedles = maskingMixin.hasLogOnlyNeedles;
IntrinsicFunctionResolver.prototype.maskPrintedNeedlesForLog =
  maskingMixin.maskPrintedNeedlesForLog;
IntrinsicFunctionResolver.prototype.maskRenderedNeedlesForLog =
  maskingMixin.maskRenderedNeedlesForLog;
IntrinsicFunctionResolver.prototype.maskNeedlesOfBags = maskingMixin.maskNeedlesOfBags;
IntrinsicFunctionResolver.prototype.isRecordedSecretForLog = maskingMixin.isRecordedSecretForLog;
IntrinsicFunctionResolver.prototype.logTwinText = maskingMixin.logTwinText;
IntrinsicFunctionResolver.prototype.splitLogTwins = maskingMixin.splitLogTwins;
IntrinsicFunctionResolver.prototype.productLogTwin = maskingMixin.productLogTwin;
IntrinsicFunctionResolver.prototype.logTextOfLeaf = maskingMixin.logTextOfLeaf;
IntrinsicFunctionResolver.prototype.outputNameLogText = maskingMixin.outputNameLogText;
IntrinsicFunctionResolver.prototype.regionLogText = maskingMixin.regionLogText;
IntrinsicFunctionResolver.prototype.tokenAssembledFromSecret =
  maskingMixin.tokenAssembledFromSecret;
IntrinsicFunctionResolver.prototype.tokenAssembledForRecording =
  maskingMixin.tokenAssembledForRecording;
IntrinsicFunctionResolver.prototype.refuseSecretAssembledReference =
  maskingMixin.refuseSecretAssembledReference;
IntrinsicFunctionResolver.prototype.straddleSafeTwin = maskingMixin.straddleSafeTwin;
IntrinsicFunctionResolver.prototype.dynamicReferenceNameLogText =
  maskingMixin.dynamicReferenceNameLogText;
IntrinsicFunctionResolver.prototype.logTwinBag = maskingMixin.logTwinBag;
IntrinsicFunctionResolver.prototype.registeredLogTwin = maskingMixin.registeredLogTwin;
IntrinsicFunctionResolver.prototype.logTwinOfProduct = maskingMixin.logTwinOfProduct;
IntrinsicFunctionResolver.prototype.recordLeafResolution = maskingMixin.recordLeafResolution;
IntrinsicFunctionResolver.prototype.nestedPartResolution = maskingMixin.nestedPartResolution;
IntrinsicFunctionResolver.prototype.rememberLogTwin = maskingMixin.rememberLogTwin;
IntrinsicFunctionResolver.prototype.maskValueLeaves = maskingMixin.maskValueLeaves;
IntrinsicFunctionResolver.prototype.maskThenStripThenMask = maskingMixin.maskThenStripThenMask;
IntrinsicFunctionResolver.prototype.displayMasked = maskingMixin.displayMasked;
IntrinsicFunctionResolver.prototype.logRender = maskingMixin.logRender;
IntrinsicFunctionResolver.prototype.splitDelimiterRender = maskingMixin.splitDelimiterRender;
IntrinsicFunctionResolver.prototype.displayMaskedIdent = maskingMixin.displayMaskedIdent;
IntrinsicFunctionResolver.prototype.displayLeaf = maskingMixin.displayLeaf;

IntrinsicFunctionResolver.prototype.resolveIf = fnMixin.resolveIf;
IntrinsicFunctionResolver.prototype.resolveEquals = fnMixin.resolveEquals;
IntrinsicFunctionResolver.prototype.resolveConditionReference = fnMixin.resolveConditionReference;
IntrinsicFunctionResolver.prototype.resolveAnd = fnMixin.resolveAnd;
IntrinsicFunctionResolver.prototype.resolveOr = fnMixin.resolveOr;
IntrinsicFunctionResolver.prototype.resolveNot = fnMixin.resolveNot;
IntrinsicFunctionResolver.prototype.resolveFindInMap = fnMixin.resolveFindInMap;
IntrinsicFunctionResolver.prototype.resolveBase64 = fnMixin.resolveBase64;
IntrinsicFunctionResolver.prototype.resolveGetAZs = fnMixin.resolveGetAZs;
IntrinsicFunctionResolver.prototype.resolvePseudoParameter = fnMixin.resolvePseudoParameter;
IntrinsicFunctionResolver.prototype.resolveCidr = fnMixin.resolveCidr;
IntrinsicFunctionResolver.prototype.expandIPv6 = fnMixin.expandIPv6;
IntrinsicFunctionResolver.prototype.ipv6ToBigInt = fnMixin.ipv6ToBigInt;
IntrinsicFunctionResolver.prototype.bigIntToIPv6 = fnMixin.bigIntToIPv6;

IntrinsicFunctionResolver.prototype.resolveJoin = stringFnMixin.resolveJoin;
IntrinsicFunctionResolver.prototype.subPlaceholderWarning = stringFnMixin.subPlaceholderWarning;
IntrinsicFunctionResolver.prototype.subPlaceholderNamesADeclaredTemplateEntity =
  stringFnMixin.subPlaceholderNamesADeclaredTemplateEntity;
IntrinsicFunctionResolver.prototype.rethrowStructuralSubFailure =
  stringFnMixin.rethrowStructuralSubFailure;
IntrinsicFunctionResolver.prototype.subListRefusal = stringFnMixin.subListRefusal;
IntrinsicFunctionResolver.prototype.resolveSub = stringFnMixin.resolveSub;
IntrinsicFunctionResolver.prototype.resolveSelect = stringFnMixin.resolveSelect;
IntrinsicFunctionResolver.prototype.renderGetAttArg = stringFnMixin.renderGetAttArg;
IntrinsicFunctionResolver.prototype.describeOperandShape = stringFnMixin.describeOperandShape;
IntrinsicFunctionResolver.prototype.describeSplitValueSource =
  stringFnMixin.describeSplitValueSource;
IntrinsicFunctionResolver.prototype.resolveSplit = stringFnMixin.resolveSplit;

IntrinsicFunctionResolver.prototype.resolveDynamicReferences =
  dynamicRefsMixin.resolveDynamicReferences;
IntrinsicFunctionResolver.prototype.resolveTemplateLeafReferences =
  dynamicRefsMixin.resolveTemplateLeafReferences;
IntrinsicFunctionResolver.prototype.resolveDynamicReferencesWithLogTwin =
  dynamicRefsMixin.resolveDynamicReferencesWithLogTwin;
IntrinsicFunctionResolver.prototype.resolveSecretsManagerReference =
  dynamicRefsMixin.resolveSecretsManagerReference;
IntrinsicFunctionResolver.prototype.sendWithThrottleRetry = dynamicRefsMixin.sendWithThrottleRetry;
IntrinsicFunctionResolver.prototype.resolveSSMReference = dynamicRefsMixin.resolveSSMReference;

IntrinsicFunctionResolver.prototype.reresolveCrossStackValue =
  crossStackMixin.reresolveCrossStackValue;
IntrinsicFunctionResolver.prototype.pinSecretVerdict = crossStackMixin.pinSecretVerdict;
IntrinsicFunctionResolver.prototype.resolveImportValue = crossStackMixin.resolveImportValue;
IntrinsicFunctionResolver.prototype.lookupCfnExport = cfnFallbackMixin.lookupCfnExport;
IntrinsicFunctionResolver.prototype.describeAvailableOutputs =
  cfnFallbackMixin.describeAvailableOutputs;
IntrinsicFunctionResolver.prototype.fetchAllCfnExports = cfnFallbackMixin.fetchAllCfnExports;
IntrinsicFunctionResolver.prototype.lookupCfnStackOutputs = cfnFallbackMixin.lookupCfnStackOutputs;
IntrinsicFunctionResolver.prototype.fetchCfnStackOutputs = cfnFallbackMixin.fetchCfnStackOutputs;
IntrinsicFunctionResolver.prototype.getCfnClient = cfnFallbackMixin.getCfnClient;
IntrinsicFunctionResolver.prototype.recordImport = crossStackMixin.recordImport;
IntrinsicFunctionResolver.prototype.resolveGetStackOutput = stackOutputMixin.resolveGetStackOutput;
IntrinsicFunctionResolver.prototype.recordOutputRead = stackOutputMixin.recordOutputRead;
IntrinsicFunctionResolver.prototype.positionalNameMask = stackOutputMixin.positionalNameMask;
IntrinsicFunctionResolver.prototype.maskStateReadError = stackOutputMixin.maskStateReadError;
IntrinsicFunctionResolver.prototype.maskNamedError = stackOutputMixin.maskNamedError;
IntrinsicFunctionResolver.prototype.namedRequestMasks = stackOutputMixin.namedRequestMasks;
IntrinsicFunctionResolver.prototype.getSameAccountStackState =
  stackStateMixin.getSameAccountStackState;
IntrinsicFunctionResolver.prototype.getCrossAccountStackState =
  stackStateMixin.getCrossAccountStackState;

IntrinsicFunctionResolver.prototype.pushRedactedAttributeRead =
  getAttMixin.pushRedactedAttributeRead;
IntrinsicFunctionResolver.prototype.resolveGetAtt = getAttMixin.resolveGetAtt;
IntrinsicFunctionResolver.prototype.publicNoEchoTokens = getAttMixin.publicNoEchoTokens;
IntrinsicFunctionResolver.prototype.noteAttributeSecrecy = getAttMixin.noteAttributeSecrecy;
IntrinsicFunctionResolver.prototype.rejectPlaceholderArnAttribute =
  getAttMixin.rejectPlaceholderArnAttribute;
IntrinsicFunctionResolver.prototype.staleRecordRemedy = getAttHealMixin.staleRecordRemedy;
IntrinsicFunctionResolver.prototype.unenrichedRemedy = getAttHealMixin.unenrichedRemedy;
IntrinsicFunctionResolver.prototype.healWithheld = getAttHealMixin.healWithheld;
IntrinsicFunctionResolver.prototype.withheldRemedy = getAttHealMixin.withheldRemedy;
IntrinsicFunctionResolver.prototype.healStaleAttributes = getAttHealMixin.healStaleAttributes;
IntrinsicFunctionResolver.prototype.usableHealedAttribute = getAttHealMixin.usableHealedAttribute;
IntrinsicFunctionResolver.prototype.serveHealedAttribute = getAttHealMixin.serveHealedAttribute;
IntrinsicFunctionResolver.prototype.constructWithStaleRecordHeal =
  getAttHealMixin.constructWithStaleRecordHeal;
IntrinsicFunctionResolver.prototype.constructGuardedAttribute =
  getAttHealMixin.constructGuardedAttribute;
IntrinsicFunctionResolver.prototype.healBeforeConstructing = getAttHealMixin.healBeforeConstructing;
IntrinsicFunctionResolver.prototype.constructAttribute = getAttMixin.constructAttribute;
IntrinsicFunctionResolver.prototype.refuseUnservedAttribute =
  getAttRefusalsMixin.refuseUnservedAttribute;
IntrinsicFunctionResolver.prototype.refuseUnconstructibleAttribute =
  getAttRefusalsMixin.refuseUnconstructibleAttribute;
IntrinsicFunctionResolver.prototype.refuseUndefinedAttribute =
  getAttRefusalsMixin.refuseUndefinedAttribute;
IntrinsicFunctionResolver.prototype.describeFailureObserved =
  getAttRefusalsMixin.describeFailureObserved;
IntrinsicFunctionResolver.prototype.guardedPhysicalIdFallback =
  getAttRefusalsMixin.guardedPhysicalIdFallback;
IntrinsicFunctionResolver.prototype.resolveParameters = paramsConditionsMixin.resolveParameters;
IntrinsicFunctionResolver.prototype.evaluateConditions = paramsConditionsMixin.evaluateConditions;
IntrinsicFunctionResolver.prototype.resolveKeyUnit = paramsConditionsMixin.resolveKeyUnit;
IntrinsicFunctionResolver.prototype.recordInheritedParameterSecrets =
  parameterSecretsMixin.recordInheritedParameterSecrets;
IntrinsicFunctionResolver.prototype.recordNoEchoParameterValue =
  parameterSecretsMixin.recordNoEchoParameterValue;
IntrinsicFunctionResolver.prototype.refuseCoercedInheritedSecret =
  parameterSecretsMixin.refuseCoercedInheritedSecret;
IntrinsicFunctionResolver.prototype.nameIsNeverAResource = refsMixin.nameIsNeverAResource;
IntrinsicFunctionResolver.prototype.lookupResourceRecord = refsMixin.lookupResourceRecord;
IntrinsicFunctionResolver.prototype.resolveRef = refsMixin.resolveRef;
IntrinsicFunctionResolver.prototype.resolveRefValue = refsMixin.resolveRefValue;
IntrinsicFunctionResolver.prototype.noteRefStateMask = refsMixin.noteRefStateMask;
IntrinsicFunctionResolver.prototype.clientsForRegion = clientsMixin.clientsForRegion;
IntrinsicFunctionResolver.prototype.serviceDiscoveryClient = clientsMixin.serviceDiscoveryClient;
