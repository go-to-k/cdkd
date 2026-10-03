import type { CloudFormationClient, Export as CfnExport } from '@aws-sdk/client-cloudformation';
import type { ServiceDiscoveryClient } from '@aws-sdk/client-servicediscovery';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { getLogger } from '../utils/logger.js';
import { getAwsClients, type AwsClients } from '../utils/aws-clients.js';
import { canonicalizeRegion } from '../utils/aws-partition.js';
import { stripControlChars } from '../utils/regexp.js';
import { displaySafe, safeMsg } from '../utils/display-safe.js';
import { IntrinsicResolutionRefusalError } from '../utils/error-handler.js';
import { withSharedDrainBudget } from './drain-budget.js';
import { recordAssumedConditions } from './assumed-conditions.js';
import { markNonRetryable } from './retryable-errors.js';
import { ssmResolvedValueType } from '../utils/parameter-types.js';
import {
  maskSecretsInText,
  recordLogOnlyParameterValue,
  carryLogOnlyValuesCarriedBy,
  hasMaskableValues,
  inheritedParameterExpression,
  carryFreshNoEchoMark,
  SECRET_MASK,
  type RecordedSecretValues,
} from './secret-redaction.js';
import type { CloudFormationTemplate } from '../types/resource.js';
import { type ResourceState } from '../types/state.js';
import { clientDefaultsFor, type CredentialConfig } from '../utils/ambient-client-defaults.js';
import {
  type AbandonedResolution,
  type ResolverContext,
  type CachedDynamicReference,
  type ParameterDefinition,
  AWS_NO_VALUE,
  refStateLookupFromResource,
  cfnRefValueFromPhysicalId,
  detectUnknownIntrinsicKey,
  buildUnknownIntrinsicError,
  isDeliberateResolutionRefusal,
  DRAIN_AFTER_REJECTION_MS,
  concurrentDrainCap,
  allSettledKeepingFirstRejection,
  clientCacheKey,
  isClientSafeRegion,
  collectReferencedParameterNames,
  isUnboundTemplateParameter,
  coerceParameterTypedValue,
  coerceParameterDefault,
  inheritedSecretsCarriedBy,
  stringifyParameterForLog,
  boundAltered,
  QUOTABLE_RENDER,
  isStructured,
  quotedRender,
} from './intrinsic-resolver/support.js';
import * as getAttMixin from './intrinsic-resolver/getatt.js';
import * as crossStackMixin from './intrinsic-resolver/cross-stack.js';
import * as cfnFallbackMixin from './intrinsic-resolver/cfn-fallback.js';
import * as stackOutputMixin from './intrinsic-resolver/stack-output.js';
import * as stackStateMixin from './intrinsic-resolver/stack-state.js';
import * as dynamicRefsMixin from './intrinsic-resolver/dynamic-refs.js';
import * as stringFnMixin from './intrinsic-resolver/string-functions.js';
import * as fnMixin from './intrinsic-resolver/functions.js';
import * as maskingMixin from './intrinsic-resolver/masking.js';
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
   */
  private readonly regionScopedClients = new Map<string, AwsClients>();
  /**
   * ServiceDiscovery clients keyed by the region {@link clientsForRegion}
   * selected (`''` when it selected none). See {@link serviceDiscoveryClient}
   * for why this one service is not read off an `AwsClients` bag, and why the
   * PROMISE rather than the client is what is stored.
   */
  private readonly serviceDiscoveryClients = new Map<string, Promise<ServiceDiscoveryClient>>();
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
   * AWS clients for a REGION-SENSITIVE lookup, pinned to `targetRegion`
   * (issue [#1957](https://github.com/go-to-k/cdkd/issues/1957)).
   *
   * Every lookup in this class used to read `getAwsClients()` — the
   * PROCESS-GLOBAL singleton, whose region is whichever one the process
   * installed last. That is not the same thing as the region this resolver
   * stands for, and the gap is reachable on main:
   *
   * - `cdkd deploy` defaults to `--stack-concurrency 4` and re-points the
   *   singleton per stack, so two stacks in different regions race for one
   *   mutable global and stack B's `GetSecretValue` / `GetParameter` can run
   *   against stack A's client. The resolved value is redacted on its way into
   *   state, so nothing downstream records which region answered.
   * - `cdkd scrub --all` installs the clients ONCE while resolving per-stack
   *   regions, so a region-B `SecureString` whose region-A namesake is a plain
   *   `String` is classified PUBLIC and left in PLAINTEXT in state.json — the
   *   same disclosure class as GHSA-p5qg-v9gv-hc7w, not merely a wrong value.
   * - `cdkd drift --revert` WRITES the resolved value to a live resource, so
   *   there the wrong region is a wrong write rather than a wrong report.
   *
   * Fixing it here rather than at the ~10 `setAwsClients` call sites is what
   * makes it one mechanism instead of a per-command patch: this class already
   * knows its own region, and every construction site already passes the
   * per-stack one.
   *
   * REUSING THE AMBIENT CLIENTS REQUIRES PROOF THAT THEY ALREADY POINT AT
   * `targetRegion`, and the direction of that test is the whole correctness
   * argument. CloudFormation semantics say a stack's dynamic references resolve
   * in the STACK's region, and every construction site passes exactly that — so
   * once a region has been named, sending the lookup there is not an
   * optimisation to be justified, it is the requirement. Whether the ambient
   * singleton happens to agree only decides whether an object allocation can be
   * skipped.
   *
   * An earlier revision had this backwards twice over, and both failures are
   * worth naming because each looks reasonable in isolation.
   *
   * It first declined to override whenever the ambient region was UNKNOWN,
   * reasoning that overriding on an unproven mismatch might re-point a lookup
   * that works today. That fails OPEN, on the COMMON configuration: `aws
   * configure` writes the region to `~/.aws/config`, and `cdkd scrub` sets a
   * client region only when `--region` is passed. The disclosure this issue
   * exists to close stayed reachable — profile region `us-east-1`, stack B in
   * `ap-northeast-1`, a name that is `String` in A and `SecureString` in B,
   * `cdkd scrub --all` with no flags: B's reference answered by A, classified
   * public, plaintext left in `state.json`.
   *
   * It then determined the ambient region by reading `process.env` here, which
   * is worse than not knowing: the SDK memoizes a region-less client's region
   * at its first resolution while `deploy.ts`'s `switchRegion` keeps mutating
   * `AWS_REGION` per stack and restores it in each stack's `finally`, so the
   * environment could say `baseRegion` for a client long since pinned
   * elsewhere — and this method would conclude MATCH and hand back clients
   * pointing somewhere else.
   *
   * The fix for THAT was to ask the SDK (`ssm.config.region()`), and it was
   * still wrong, in a way worth writing down because it looks airtight. An
   * unconfigured `AwsClients` is not a bag of clients, it is a bag of DEFERRED
   * client constructions: `clientOptions` omits `region`, the getters are lazy,
   * and each member therefore samples the mutating environment at its own
   * instant and memoizes a possibly DIFFERENT region. Asking `ssm` measures one
   * member and says nothing about `secretsManager`, so the seam could short-
   * circuit on a us-west-2 `ssm` and then hand out a bag whose `secretsManager`
   * pins us-east-1 a moment later — issue #1957's Site 1 surviving inside the
   * arm meant to fix it.
   *
   * So the short-circuit is taken ONLY when the ambient's region is
   * CONFIGURED. That is not a heuristic: a configured bag passes `region` to
   * every member ({@link AwsClients.clientOptions}), so its members agree by
   * construction, and {@link AwsClients.withRegion} always sets one, so every
   * derived bag is internally consistent too. An unconfigured ambient is not
   * "of unknown region", it is "of not-yet-decided region", and there is
   * nothing to compare against — so it SCOPES. That is the same "unknown means
   * SCOPE, not skip" rule as above, applied one level deeper.
   *
   * Three arms return the ambient instance, each for a reason that is not
   * "we could not prove a mismatch":
   *
   * 1. No `targetRegion` — no region was ever named (see
   *    {@link explicitRegion}), so there is nothing to bind to.
   * 2. `targetRegion` is not safe to build a client from (see
   *    {@link isClientSafeRegion}) — which THROWS. An earlier revision warned
   *    and fell back to the ambient clients, reasoning that a malformed region
   *    reaching here is a cdkd bug and failing every lookup would turn it into
   *    an outage. That put this arm on the wrong side of the two-severity
   *    design: falling back to the ambient means READING ANOTHER REGION, which
   *    for `scrub` / `drift` / `import` — whose region is state-derived — is
   *    the disclosure this issue exists to close (a region-B `SecureString`
   *    classified against a region-A `String`). A stopped command is strictly
   *    better than a silent wrong-region read. The `Fn::GetAZs` entry still
   *    validates EARLIER so it can give a message naming the template
   *    construct; this arm is the backstop that guarantees no call site,
   *    present or future, routes unvalidated input into an SDK endpoint.
   * 3. The installed clients cannot DERIVE a sibling — `withRegion` is absent.
   *    In production that never happens: `getAwsClients()` returns an
   *    `AwsClients`. It is true only of a test double, and it is checked
   *    EXPLICITLY rather than left to emerge, for a reason the review of this
   *    change made concrete. The ~260 suites that stub `getAwsClients()` with a
   *    plain object used to stay on the ambient path as a side effect of the
   *    `undefined`-region guard above — the very guard that made the disclosure
   *    reachable. Removing that guard without putting something deliberate in
   *    its place would have traded a security hole for ~260 `TypeError`s, so
   *    the test-double case is now its own named arm and the security arm no
   *    longer has a testing job to do. Suites that are ABOUT region scoping use
   *    a real `AwsClients` and are unaffected by it.
   *
   * Regions are canonicalised on both sides before comparing, because
   * `--region US-EAST-1` is a documented input and the repo lowercases
   * elsewhere (`canonicalizeRegion`, issues #1795 / #1850). Without it an
   * uppercase spelling would build a second client for the same physical
   * region — benign, but wasteful and confusing in a debug log.
   */
  /** @internal */
  clientsForRegion(
    targetRegion: string | undefined,
    // The region's masked LOG TEXT when the caller built it from a template
    // (issue #3150), for the debug line and the refusal below.
    targetLogText?: string
  ): AwsClients {
    const ambient = getAwsClients();
    if (!targetRegion) return ambient;

    const target = canonicalizeRegion(targetRegion);
    // The region as this resolver prints it (issue #3150). A producer-region
    // guest's `explicitRegion` is template-derived: `resolverForProducerRegion`
    // builds one for a secret ARN's region, which no `isClientSafeRegion` gate
    // checks first, and an `Fn::Sub` can assemble that region around a short
    // secret. The guest carries the region's masked text for exactly this.
    const loggedTarget =
      targetLogText ??
      (targetRegion === this.explicitRegion ? this.explicitRegionLogText : undefined) ??
      target;
    if (!isClientSafeRegion(target)) {
      // Issue [#2827](https://github.com/go-to-k/cdkd/issues/2827)'s
      // enumeration, and issue #3150 for the guest: the guest's region arrives
      // as `explicitRegionLogText`, masked, stripped and masked again at the
      // guest's construction, where the context is (`***` once two spellings of its
      // region mask differently). `targetLogText` is
      // `resolveGetAZs`' masked region, which `isClientSafeRegion` has
      // already accepted one arm up. Any other region is a resolver's own
      // region as its command built it -- the stack's synthesized or recorded
      // region, `--region`, or a replay / drift / scrub resolver's region read
      // out of a literal token -- and no resolution of this pass produced it.
      // `displaySafe` AROUND the strip, since go-to-k/cdkd#3426.
      // `stripControlChars` leaves `U+2028` / `U+2029`, which a JSON log viewer
      // reads as line terminators, and this refusal prints a region text a
      // template can supply — the same residual the ten binding sites had, one
      // sanitizer short rather than none.
      // not-in-class(boundAltered(targetRegion ?? loggedTarget, displaySafe(stripControlChars(loggedTarget)), 64)): a REGION's log text, masked at the guest's construction (issue #3150), or a resolver's own region as its command built it (stack / --region / literal-token region).
      // The refusal CLASS, not a plain Error, and `markNonRetryable` beside it
      // (issue go-to-k/cdkd#3181 security review). This decides from a region
      // name a retry cannot change, and the per-unit recovery partitions on
      // OWNERSHIP: as a plain `Error` this arm was indistinguishable from a
      // failed fetch, so a bag-carrying context RECORDED it and walked on —
      // downgrading a guard whose subject is an AWS service HOSTNAME to a
      // token reported as unfetched. Reachable with the bag in hand:
      // `{{resolve:secretsmanager:arn:aws:secretsmanager:<region>:...}}` takes
      // the `named-region` verdict, and `resolverForProducerRegion` applies no
      // `isClientSafeRegion` gate of its own before the guest re-enters here.
      throw markNonRetryable(
        new IntrinsicResolutionRefusalError(
          `Refusing to build AWS clients for the region ` +
            `${boundAltered(targetRegion ?? loggedTarget, displaySafe(stripControlChars(loggedTarget)), 64)}: it is not a valid AWS region name, and a ` +
            `region is substituted into the AWS service hostname.`
        )
      );
    }

    // Ordered first among the reuse arms: a test double can answer none of the
    // questions below, and asking would be the TypeError this arm prevents.
    if (typeof ambient.withRegion !== 'function') return ambient;

    const cacheKey = clientCacheKey(target, ambient.credentialConfig ?? {});
    const cached = this.regionScopedClients.get(cacheKey);
    if (cached) return cached;

    // ONLY a CONFIGURED ambient can be reused — see the note above on why a
    // region-less bag cannot answer for itself.
    if (canonicalizeRegion(ambient.configuredRegion) === target) return ambient;

    const scoped = ambient.withRegion(target);
    this.regionScopedClients.set(cacheKey, scoped);
    // SANITIZED (go-to-k/cdkd#3426), and this site was the one the issue's own
    // list did not carry: `isClientSafeRegion` gated `target`, never
    // `loggedTarget`, which is the LOG TEXT of a possibly different string — a
    // guest's `explicitRegionLogText`, or `resolveGetAZs`' masked region. The
    // gate one arm up is a claim about the region cdkd will put in a hostname,
    // not about the text printed for it.
    // not-in-class(displaySafe(loggedTarget)): a REGION's log text, masked by the caller that built the region from a template (issue #3150), or a resolver's own region as its command built it (stack / --region / literal-token region).
    this.logger.debug(`Using region-scoped AWS clients for ${displaySafe(loggedTarget)}`);
    return scoped;
  }

  /**
   * The ServiceDiscovery client for the `HostedZoneId` namespace lookup, in the
   * region {@link clientsForRegion} selects (issue
   * [#1994](https://github.com/go-to-k/cdkd/issues/1994)).
   *
   * It is BUILT here rather than read off the bag for one reason: `AwsClients`
   * carries no `serviceDiscovery` member, and adding one would put a static
   * `@aws-sdk/client-servicediscovery` import into a module every command
   * loads. So the REGION DECISION is still `clientsForRegion`'s — including its
   * ambient-reuse rule and its refusal of a region that is not client-safe —
   * and only the construction is local: the chosen bag's
   * {@link AwsClients.credentialConfig} carries `--profile` / explicit
   * credentials across, and its {@link AwsClients.configuredRegion} is the
   * region to pin. An UNCONFIGURED bag (no region was ever named, i.e. the
   * no-argument constructor) pins nothing and lets the SDK's own chain
   * resolve — the same arm-1 answer `clientsForRegion` gives, and strictly
   * better than the `resolverRegion` this site used to read, which substitutes
   * `AWS_REGION` and then a hard-coded `us-east-1`.
   *
   * The PROMISE is memoized, not the client: the dynamic import makes this
   * async, so two callers arriving from different await depths can both be
   * inside the seam and would each construct (and leak) their own client. That
   * is defensive rather than measured — the unit case dispatching ten lookups
   * together produces ONE client either way, because they serialize on
   * `getAccountInfo`'s in-flight promise and reach here one at a time, which
   * the case says out loud. A REJECTED import is evicted
   * so a transient failure does not poison the rest of the deploy, mirroring
   * `cfnExportsPromises`. Lifetime is the resolver's own, like
   * {@link regionScopedClients} and {@link cfnClients}: at most one per region
   * per resolver, versus the one-per-CALL this replaces.
   */
  /** @internal */
  async serviceDiscoveryClient(): Promise<ServiceDiscoveryClient> {
    const scoped = this.clientsForRegion(this.explicitRegion);
    const region = scoped.configuredRegion;
    // The scoped bag's OWN credential configuration, read once for both the
    // key and the construction (issue #3588).
    const credentialConfig: CredentialConfig = scoped.credentialConfig ?? {};
    const key = clientCacheKey(region ?? '', credentialConfig);
    const cached = this.serviceDiscoveryClients.get(key);
    if (cached) return cached;

    const building = (async () => {
      const { ServiceDiscoveryClient } = await import('@aws-sdk/client-servicediscovery');
      return new ServiceDiscoveryClient({
        // The profile is passed rather than left to the `AWS_PROFILE` mirror
        // `program.ts` sets: `credentialConfig` can carry one, and relying on
        // the mirror made this the only site whose correctness depended on it.
        ...clientDefaultsFor(credentialConfig),
        ...(region ? { region } : {}),
      });
    })();
    this.serviceDiscoveryClients.set(key, building);
    building.catch(() => {
      if (this.serviceDiscoveryClients.get(key) === building) {
        this.serviceDiscoveryClients.delete(key);
      }
    });
    return building;
  }

  /**
   * Resolve parameter values from template Parameters section
   *
   * Merges default values from template with user-provided parameter values.
   * User-provided values take precedence over defaults.
   *
   * @param template CloudFormation template containing Parameters section
   * @param userParameters User-provided parameter values (e.g., from CLI)
   * @returns Record of parameter names to resolved values
   */
  async resolveParameters(
    template: CloudFormationTemplate,
    userParameters?: Record<string, string>,
    options?: {
      /**
       * The parent's `plaintext -> {{resolve:...}}` pairs, on a NESTED-STACK
       * CHILD engine only (issue #1903). Two things need it HERE, and both
       * are about the same seam — this method is where an already-decrypted
       * parent value first enters the child:
       *
       *  - the debug lines below print a parameter VALUE, and on this path
       *    that value is plaintext the child's own `recordedSecretValues`
       *    does not yet know about, so `stringifyParameterForLog`'s `NoEcho`
       *    test (the author's own declaration, which a CDK-synthesized
       *    nested-stack parameter never carries) is the only thing standing
       *    between `--verbose` and the secret;
       *  - `refuseCoercedInheritedSecret` needs the PRE-coercion string to
       *    decide whether the declared `Type` would push the value out of
       *    cdkd's string-keyed redaction model.
       */
      inheritedSecrets?: RecordedSecretValues;
    }
  ): Promise<Record<string, unknown>> {
    const inheritedSecrets = options?.inheritedSecrets;
    // SANITIZED as well as masked (go-to-k/cdkd#3426). The three lines below
    // print a template-supplied PARAMETER VALUE, so the control-character class
    // reaches them exactly as it reached the `Fn::ImportValue` bindings; they
    // are `debug` rather than `warn`, which changes when a reader sees it, not
    // whether. Mask, strip, mask — the {@link maskThenStripThenMask} order, and
    // for its reason: `stripControlChars` DELETES, so a plaintext split by an
    // invisible would be reconstituted contiguous by a strip after one mask.
    // Then `displaySafe`, for the class the strip does not cover. This is the
    // shape every masker reaching a render must have. This one is deliberately
    // narrower about BAGS than the builder: it masks against the INHERITED bag
    // alone, which is the only bag that can hold the needle at this seam, so a
    // FOURTH call site is a security decision rather than a copy.
    const maskInherited = (text: string): string => {
      // `hasMaskableValues` (go-to-k/cdkd#1998): an inherited bag holding
      // only the parent's LOG-ONLY needles still masks.
      const mask = (value: string): string =>
        inheritedSecrets && hasMaskableValues(inheritedSecrets)
          ? maskSecretsInText(value, inheritedSecrets)
          : value;
      return displaySafe(mask(stripControlChars(mask(text))));
    };
    // The context a user-provided value's leaves are masked against (issue
    // #3114): the inherited bag is the only one this method has, and it is also
    // the bag the parent registered its log twins under, so a value the parent
    // built around a short secret prints with the parent's mask.
    const inheritedLogContext: ResolverContext = {
      template,
      resources: {},
      ...(inheritedSecrets && { inheritedSecrets }),
    };
    // `Object.create(null)` (issue #2802). Every key here is a template
    // PARAMETER NAME, and the three writes below are plain assignments, so on a
    // plain object `parameters['__proto__'] = v` went to the inherited setter
    // and the value was lost. Safe as a null-prototype bag: the four callers of
    // `resolveParameters` index it or `Object.keys` it, and it is never coerced
    // or `Object.assign`ed. `diff-recursive.ts` DOES spread it, which is safe
    // for the opposite reason: a spread copies with DEFINE semantics, so a
    // `__proto__` own key survives into the target rather than hitting its
    // setter. An `Object.assign` would not, and there is none.
    const parameters: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const templateParameters = template.Parameters;

    if (!templateParameters || typeof templateParameters !== 'object') {
      return parameters;
    }

    // Computed lazily — only templates that actually carry an SSM-typed
    // default without a user-provided value pay for the template walk.
    let referencedNames: Set<string> | undefined;

    for (const [name, definition] of Object.entries(templateParameters)) {
      const paramDef = definition as ParameterDefinition;

      // No value provided and no default - this is an error. Decided by the
      // SHARED {@link isUnboundTemplateParameter} rather than by the shape of
      // the branches below, because `resolveSub`'s structural refusal asks the
      // very same question (issue #2285) and the two must not drift. Hoisted
      // above the branches so both sites read one definition of the population
      // instead of one site defining it and the other reconstructing it.
      // THE WHOLE LOOP BODY RENDERS `name`, and all six renders sanitize
      // (go-to-k/cdkd#3435 review round 2). The five debug lines below took
      // `maskInherited` -- already in scope, already the pass every VALUE on
      // this method uses -- rather than a second spelling. They are `debug`
      // rather than default-verbosity, which changes WHEN a reader sees the
      // line, not whether the bytes reach a terminal; and leaving five of six
      // on a premise the sixth refutes thirty lines down is the "sweep the
      // CLASS, not the instance" miss this repo keeps measuring.
      if (isUnboundTemplateParameter(name, template, userParameters)) {
        // SWEPT IN WITH THE 19 (go-to-k/cdkd#3432 review). This note carried
        // the SAME premise the eighteen logical-id ones could not support --
        // "CloudFormation requires a literal" -- and it is false here for the
        // same reason: cdkd reads the template as JSON, so a `Parameters` KEY is
        // only as constrained as the file, and `cdkd import
        // --migrate-from-cloudformation` reads a hand-written one. MEASURED by
        // the reviewer on this tree: a parameter named `Prod<ESC>[2K<CR>Evil`
        // put a live terminal-rewriting sequence on this THROW, which the user
        // sees at any verbosity.
        //
        // It sat outside go-to-k/cdkd#3432's own population because that issue
        // defined the population by grepping for the marker spelled with
        // `logicalId` in its parentheses, and this one names `name` instead.
        // (The literal tag is not written in this comment on purpose: the
        // checker scans raw text for it, so a prose mention parses as a marker
        // no site consumes -- which it then reports STALE. Measured while
        // writing this paragraph, exactly as `displayMasked`'s own doc warns.)
        // Fixed here rather than filed: it is the same class, in
        // the same file, one marker over -- and `scrub.ts`'s classification
        // note had just been edited to call this pattern's id "the only one
        // still rendered raw", which would have shipped as a standing
        // description of a live exposure.
        //
        // `maskInherited`, the same pass the five debug lines in this loop take
        // and the one this method already defines: it masks against the
        // INHERITED bag -- the only bag that can hold a needle at this seam --
        // then strips, masks again and runs `displaySafe`. An earlier revision
        // of this comment said the site had "no context to pass", which was
        // false: `inheritedLogContext` is in scope from the top of the method
        // (go-to-k/cdkd#3435 review round 2).
        throw new Error(
          `Parameter ${maskInherited(name)} is required but no value was provided and no default exists`
        );
      }

      // User-provided value takes precedence
      // `Object.hasOwn` (issue #2767): `name` is a declared parameter NAME, so
      // a bare `in` answered for an `Object.prototype` member and handed the
      // `Object` FUNCTION to `coerceParameterValue` as the user's value.
      if (userParameters && Object.hasOwn(userParameters, name)) {
        const userValue = userParameters[name];
        if (userValue !== undefined) {
          this.refuseCoercedInheritedSecret(name, paramDef, userValue, inheritedSecrets);
          parameters[name] = this.coerceParameterValue(userValue, paramDef.Type);
          this.logger.debug(
            `Parameter ${maskInherited(name)}: using user-provided value ${maskInherited(
              stringifyParameterForLog(
                paramDef,
                this.maskValueLeaves(userValue, inheritedLogContext)
              )
            )}`
          );
          continue;
        }
      }

      // Use default value if available
      if ('Default' in paramDef) {
        // SSM Parameter type: resolve the default value (SSM parameter path) via SSM API
        if (paramDef.Type.startsWith('AWS::SSM::Parameter::Value')) {
          // Skip the SSM lookup for parameters nothing in Resources / Outputs /
          // Conditions consumes. The load-bearing case is the CDK default
          // synthesizer's `BootstrapVersion` parameter (default
          // `/cdk-bootstrap/<qualifier>/version`), which is referenced only by
          // the `Rules.CheckBootstrapVersion` assertion cdkd never evaluates —
          // resolving it eagerly makes every deploy require `cdk bootstrap` in
          // the target region (GetParameter throws ParameterNotFound
          // otherwise), defeating cdkd-owned asset storage (issue #1002).
          referencedNames ??= collectReferencedParameterNames(template);
          if (!referencedNames.has(name)) {
            this.logger.debug(
              `Parameter ${maskInherited(name)}: skipping SSM resolution (not referenced by Resources/Outputs/Conditions)`
            );
            continue;
          }
          const ssmPath = String(paramDef.Default);
          // `ssmPath` is an SSM path from the parameter DEFINITION in the
          // template -- the same untrusted JSON the NAME comes from, so it takes
          // the same pass.
          this.logger.debug(
            `Parameter ${maskInherited(name)}: resolving SSM parameter path ${maskInherited(ssmPath)}`
          );
          const resolved = await this.resolveSSMParameter(ssmPath);
          // Coerced against the INNER type peeled out of `Value<...>`, never
          // the declared outer one -- see {@link ssmResolvedValueType} for why
          // the outer type is a silent no-op here, and for the two
          // AWS-published contracts that settle the split and the trim. A
          // `Value<List<String>>` parameter used to reach consumers as the raw
          // comma-separated string `GetParameter` returns (issue #2367).
          //
          // STRICTLY AFTER the `referencedNames` skip above, which `continue`s
          // before this branch ever reaches `GetParameter`, so nothing here can
          // make an unreferenced parameter resolvable again (issue #1002's
          // `BootstrapVersion` carve-out). That parameter is
          // `Value<String>` in any case, whose inner type coerces to itself.
          //
          // OFF THE DOCUMENTED TYPE SPACE this newly coerces where it used to
          // pass through: `Value<Number>` is not a Systems Manager parameter
          // type CloudFormation defines (Parameter Store has String /
          // StringList / SecureString), but if a template spells it, the peeled
          // `Number` now yields `Number(resolved)` -- and `NaN` for a
          // non-numeric Parameter Store value -- rather than the raw string.
          const resolvedType = ssmResolvedValueType(paramDef.Type);
          parameters[name] =
            resolvedType === undefined
              ? resolved
              : this.coerceParameterValue(resolved, resolvedType);
          this.logger.debug(
            `Parameter ${maskInherited(name)}: resolved SSM value ${maskInherited(
              stringifyParameterForLog(paramDef, resolved)
            )}`
          );
          continue;
        }

        // Bound the way the user-supplied path binds a value, so a defaulted
        // `CommaDelimitedList` is a list rather than a comma-joined string
        // (issue #2367). Only a STRING default is coerced -- see
        // {@link coerceParameterDefault} for the measured parsed shapes.
        parameters[name] = coerceParameterDefault(paramDef.Default, paramDef.Type);
        this.logger.debug(
          `Parameter ${maskInherited(name)}: using default value ${maskInherited(
            stringifyParameterForLog(paramDef, paramDef.Default)
          )}`
        );
        continue;
      }
    }

    return parameters;
  }

  /**
   * Resolve an SSM Parameter Store path to its actual value.
   * Used for parameters with type AWS::SSM::Parameter::Value<...>.
   */
  private async resolveSSMParameter(parameterName: string): Promise<string> {
    // Region-sensitive: SSM parameters are regional and independent, so the
    // same path in two regions is two different values (issue #1957).
    const client = this.clientsForRegion(this.explicitRegion).ssm;
    const response = await client.send(new GetParameterCommand({ Name: parameterName }));
    return response.Parameter?.Value ?? '';
  }

  /**
   * Coerce parameter value to the correct type based on parameter definition
   */
  private coerceParameterValue(value: string, type: string): unknown {
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
   * Evaluate all conditions in the template
   *
   * Conditions are defined in the Conditions section of the CloudFormation template
   * and can reference parameters and pseudo parameters
   */
  async evaluateConditions(context: ResolverContext): Promise<Record<string, boolean>> {
    // `Object.create(null)` (issue #2767). This is the PRODUCER of the bag
    // `resolveIf` and `filterResourcesByCondition` read, and every key in it is
    // a template-controlled condition NAME: on a plain object the memo test
    // below answered for an `Object.prototype` member before the definition was
    // ever evaluated, and `conditions['__proto__'] = false` routed through the
    // inherited setter and was lost, so a resource CloudFormation omits was
    // kept. Unlike `resolveValue`'s bag this one holds only booleans and is
    // never coerced or `Object.assign`ed -- its three readers index it or call
    // `Object.keys` -- so the null prototype costs nothing here.
    const conditions: Record<string, boolean> = Object.create(null) as Record<string, boolean>;
    const templateConditions = context.template.Conditions;
    // See `assumedConditionNames`. `inProgress` holds the evaluation path, so
    // marking it whenever a guess is made or read taints every condition whose
    // value that guess fed.
    const assumed = new Set<string>();
    recordAssumedConditions(conditions, assumed);

    if (!templateConditions || typeof templateConditions !== 'object') {
      return conditions;
    }

    // A CFn Condition can reference ANOTHER named condition via
    // `{Condition: OtherName}` inside `Fn::And` / `Fn::Or` / `Fn::Not`
    // (issue #840). Evaluation must therefore be DEPENDENCY-ORDERED, not
    // declaration-ordered: a composite condition referencing `IsPremium`
    // must see `IsPremium`'s evaluated boolean, regardless of which is
    // declared first. We evaluate lazily/recursively with memoization
    // (the `conditions` map doubles as the memo cache) and an in-progress
    // set as a cycle guard. `{Condition: X}` references inside the
    // definitions resolve through `evaluateByName` via the
    // `conditionResolver` hook threaded onto the context.
    // A PRIVATE needle bag when the caller brought none (issue #2748 review).
    // `maskSecretsRaw` is a no-op against absent bags, so the mask below is
    // worth exactly what this pass RECORDED — and two of the four callers hand
    // in a context literal with no bag at all: `cli/commands/diff-recursive.ts`
    // and `cli/commands/import.ts` (which also omits `skipDynamicReferences`,
    // so it really does fetch the secret). `deploy-engine`'s
    // `buildResolverContext` and `cdkd scrub`'s `resolverContext` both supply
    // one. MEASURED before this existed: `cdkd diff` on a template whose
    // `Conditions` entry assembles a reference out of its own resolved secret
    // printed the password in full at default verbosity.
    //
    // Fixed HERE rather than at the two call sites so a fifth caller cannot
    // reopen it — the per-site habit is what this class keeps costing.
    //
    // PRIVATE, and it dies with this call: it is never returned, never merged
    // into a caller's bag, and its `WeakMap`-keyed associations die with it. So
    // the bag this function INVENTS cannot become a redaction needle anywhere.
    //
    // That is a claim about the private bag ONLY, not about condition
    // evaluation in general — an earlier wording said "a conditions bag must
    // not reach an outputs bag" and was false for one caller: `cdkd scrub`
    // deliberately hands this pass its OUTPUTS bag (`scrub.ts`, so a condition's
    // secret IS a needle over `state.outputs` there), which is that caller's
    // decision and not something to undo from here. A caller that brought a bag
    // keeps it — the resolver fills it in place and the caller is entitled to
    // what this pass records.
    //
    // Residual, and it is NARROWER than it was: `maskSecretsInText` matches
    // LITERALLY, so a plaintext that reaches the message RE-ENCODED is not
    // masked by the bag alone. Issue
    // [#2759](https://github.com/go-to-k/cdkd/issues/2759) — which claimed
    // this note — closed the two spellings this file produces, each at the
    // site that still holds both forms: `Fn::Base64` registers its OUTPUT as a
    // derived mask-only needle, and the JSON encodings AT `maskValueLeaves`'s
    // call sites are leaf-masked before `stringifyValue` / `JSON.stringify`
    // runs.
    //
    // NOT A UNIVERSAL OVER THE FILE, and the qualifier is load-bearing: two
    // drafts of this note claimed one and a reviewer's grep refuted each. Since
    // issue #3114 the four `Fn::GetAtt` value lines, `Resolved Ref to
    // parameter` and the user-provided parameter line ARE among those call
    // sites, leaf-masked before `stringifyAttributeForLog` /
    // `stringifyParameterForLog` encodes them; the SSM-resolved and `Default`
    // parameter lines still pass the raw value to `stringifyParameterForLog`
    // and mask only its output. The checkable statement is
    // "`maskValueLeaves`'s call sites", not "every encoding". The FILE-WIDE
    // question -- "is every interpolating site masked or deliberately not" --
    // was answered by an AST checker that go-to-k/cdkd#3435 DELETED as
    // high-maintenance tooling, and nothing asks it now; each render is pinned
    // by its emitted bytes instead.
    //
    // WHAT STAYS OPEN, stated rather than implied: a re-encoding cdkd does not
    // perform — a URL escaping, a hash, an `Fn::Join` that transforms rather
    // than concatenates — still yields text no needle matches, and there is no
    // site at which to derive one. And the `Fn::Base64` derived needle is
    // MASK-ONLY, which `secret-redaction.ts` deliberately withholds from the
    // persist path's SUBSTRING arm — so an encoding EMBEDDED in a longer leaf
    // (`{"Fn::Join": ["", [{"Fn::Base64": <ref>}, "="]]}`) is not a whole-leaf
    // match and still reaches `state.json`. That withholding is a decision of
    // that module's, not an oversight here: an inline `***` is a value no
    // consumer can recognise or re-resolve, so widening it would be a
    // different and larger change. The needle FLOOR is a separate residual
    // (issues [#2516](https://github.com/go-to-k/cdkd/issues/2516) /
    // [#2745](https://github.com/go-to-k/cdkd/issues/2745)): a plaintext below
    // `MIN_NEEDLE_LENGTH` embedded in a longer string reaches only the
    // substring arm, so an `Fn::Base64` over such an input registers its
    // encoding only when the input has a registered log twin, its own pass's
    // or one a parent stack registered (the position mask, issues #3119 /
    // #3114), and nothing otherwise.
    const maskingContext: ResolverContext = context.recordedSecretValues
      ? context
      : { ...context, recordedSecretValues: new Map<string, string>() };

    const inProgress = new Set<string>();

    const evaluateByName = async (name: string): Promise<boolean> => {
      // `Object.hasOwn` rather than `in`. UNFALSIFIABLE while the bag above
      // carries no prototype -- a probe restoring `in` here is green, and that
      // is stated rather than left for the next reader to discover -- but this
      // memo decides whether a definition is evaluated at all, so it should not
      // depend on a property of a line 50 above it.
      if (Object.hasOwn(conditions, name)) {
        if (assumed.has(name)) for (const dependent of inProgress) assumed.add(dependent);
        return conditions[name]!;
      }
      if (inProgress.has(name)) {
        throw new Error(
          `Circular condition reference detected involving condition ${quotedRender(this.displayMasked(name, maskingContext), '"')}`
        );
      }
      // The TEMPLATE's own `Conditions` object comes from `JSON.parse`, so this
      // read needs the same own-key test (issue #2767): a condition named
      // `constructor` found the `Object` FUNCTION as its "definition", skipped
      // the not-declared arm below, and was handed to the resolver as a
      // condition body.
      const bag = templateConditions as Record<string, unknown>;
      const definition = Object.hasOwn(bag, name) ? bag[name] : undefined;
      if (definition === undefined) {
        // A `{Condition: X}` reference to an undeclared condition. Match the
        // Fn::If not-found behavior: warn and treat as false.
        this.logger.warn(
          `Condition ${this.displayMasked(name, maskingContext)} not found in template, assuming false`
        );
        conditions[name] = false;
        assumed.add(name);
        for (const dependent of inProgress) assumed.add(dependent);
        return false;
      }

      inProgress.add(name);
      try {
        // Resolve the definition with the condition-reference hook active so
        // nested `{Condition: Y}` references recurse through evaluateByName.
        const result = await this.resolveValue(definition, {
          ...maskingContext,
          conditionResolver: evaluateByName,
        });
        const value = Boolean(result);
        conditions[name] = value;
        // `value` carries nothing: it is `Boolean(result)`.
        this.logger.debug(
          `Evaluated condition ${this.displayMasked(name, maskingContext)} = ${value}`
        );
        return value;
      } finally {
        inProgress.delete(name);
      }
    };

    // Drive evaluation of every declared condition. Failures (including a
    // detected cycle) downgrade that condition to false rather than aborting
    // the whole deploy, matching the prior per-condition error tolerance.
    for (const name of Object.keys(templateConditions)) {
      try {
        // Its own drain budget, like `resolve`'s: a condition operand can
        // nest lists and joins just as deep, and without a store every level
        // would take a fresh cap (issue #2563). Opened per condition rather
        // than around the loop, because one condition's slow parts should not
        // spend the next one's budget. A condition that depends on another
        // re-enters `evaluateByName` INSIDE this store and inherits it.
        //
        // `withSharedDrainBudget` and NOT `drainDeadlines.run`, which always
        // installs a FRESH store. Both halves matter and the first cut of
        // this had only one: with no caller budget open, each condition gets
        // its own cap, which is what a downgraded-and-continue loop wants --
        // one condition's slow parts must not spend the next one's. INSIDE a
        // caller's budget it inherits instead, so the caller's aggregate
        // bound actually holds. `cdkd import` made that reachable: it calls
        // `evaluateConditions` inside the wrap around its resource loop
        // (`import.ts`), with a lock held and `saveState` downstream, so
        // `run` there would have cost `#conditions x` the cap on top.
        await withSharedDrainBudget(() => evaluateByName(name));
      } catch (error) {
        // MASKED (issue #2748). This catch renders a resolver error verbatim
        // at WARN level, so it is reached on an ordinary `cdkd deploy` with no
        // `--verbose`. `evaluateByName` reaches `resolveDynamicReferences`
        // below, and `resolveSub` / `resolveJoin` re-enter it with the
        // ASSEMBLED string — so a `Conditions` entry that builds a reference
        // out of a value this same pass resolved from a secret makes the
        // lookup fail NAMING that plaintext (`key 'key-<password>' not found
        // in secret '<id>'` — the EMBEDDED form, which is the one the residual
        // below is about; a key that is the plaintext WHOLE reads
        // `key '<password>' not found`). That throw is masked AT THE THROW since issue
        // [#2827](https://github.com/go-to-k/cdkd/issues/2827); this sentence
        // used to say it was "thrown unmasked by construction because every
        // other consumer masks at ITS own boundary", which that fix retired. Same class as the
        // lookup echoes issue #2728 closed further down this file, and this sink
        // was missed there because it lives in a different method and renders
        // ANY error, not only a lookup echo. What used to stand here as the
        // residual — a plaintext shorter than `MIN_NEEDLE_LENGTH` (4) embedded
        // in a longer name rather than whole, which no needle matches — is
        // CLOSED for the names THIS PASS ASSEMBLED, by issue
        // [#3150](https://github.com/go-to-k/cdkd/issues/3150): such a name is
        // masked BY POSITION, out of the log twin `resolveSub` / `resolveJoin`
        // BUILD for the assembled string — REGISTERED (`rememberLogTwin`) once
        // the substitution completes, so a later `Fn::FindInMap` throw finds
        // it, and HANDED to the dynamic-reference loop as a parameter for a
        // throw raised INSIDE that call, which is the example above: it prints
        // `key 'key-***' not found`
        // (`tests/unit/cli/import-resolver-error-masking.test.ts` pins it, and
        // `intrinsic-resolver-name-argument-log-twin.test.ts` pins this sink's
        // whole sentence). Do not shorten that to "registered": on the example's
        // own path `rememberLogTwin` has not run yet.
        //
        // What is closed is exactly what a twin can cover, and NOTHING WIDER:
        // a name this pass assembled. Any other text reaching this sink
        // carries no twin and gets the needle mask alone, whose substring arm
        // has a four-character floor — so a sub-floor plaintext can still
        // print here. **The ways that happens are NOT enumerated here, and a
        // count written here would be wrong.** State the DANGER DIRECTION;
        // each instance is stated where it is OWNED, which is the only place
        // that stays true when that code moves: an AWS SDK's text this sink
        // merely forwards
        // ([#3171](https://github.com/go-to-k/cdkd/issues/3171)); a name this
        // resolver hands to another module unmasked, where that module quotes
        // it back — `resolveGetStackOutput`'s state read was that, and
        // [#3234](https://github.com/go-to-k/cdkd/issues/3234) closed it by
        // masking at the hand-over frame, while the `Fn::ImportValue` sibling
        // still masks its caught message with the BAGS alone and so keeps the
        // positional half of the class open; and a PRODUCER's own output key,
        // whose bound `describeAvailableOutputs`' docstring owns.
        // Four review rounds on PR go-to-k/cdkd#3176 each found one more that
        // a tally here had missed, and `.claude/rules/layout-deployment-secrets.md`
        // records five rounds on go-to-k/cdkd#2803 refuting the same shape of
        // sentence. Do not restore a count.
        this.logger.warn(
          this.displayMasked(
            `Failed to evaluate condition ${name}: ${error instanceof Error ? error.message : String(error)}, assuming false`,
            maskingContext
          )
        );
        conditions[name] = false;
        assumed.add(name);
        inProgress.delete(name);
      }
    }

    return conditions;
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
   * Resolve ONE key of a bag, recovering per key when the caller opted in.
   *
   * Shared by the two sequential key walks that had this defect — the generic
   * object walk in {@link resolveValue} and `resolveSub`'s variable map — so
   * the recovery and the REFUSAL partition cannot drift between them. Both were
   * bare `for … await` loops, so the first failing key abandoned every later
   * one (issue go-to-k/cdkd#3218; the variable map was found beside it and is
   * the same defect, not a second one).
   *
   * An abandoned key keeps its INPUT value, matching what the per-token
   * recovery does with an unfetched token. That is safe only because the bag
   * obliges its consumer to fail the operation — `ResolverContext`'s field doc
   * carries the obligation and why it is not optional.
   *
   * **The log-twin invariant (issue go-to-k/cdkd#3100) under the KEY ordering**,
   * which is a separate claim from the token one and was missing while the
   * token half was stated twice. `matches` / `twinTokens` are built inside
   * `resolveDynamicReferencesWithLogTwin`, once per STRING LEAF, so the
   * pairing is leaf-local: a key abandoned beside a leaf never enters that
   * function for it and cannot shift its indices. Skipping a key changes only
   * WHICH leaves are visited, never how any visited leaf pairs — and a leaf
   * that is skipped pairs nothing at all rather than pairing wrongly. Fenced
   * by the key case in
   * `tests/unit/deployment/intrinsic-resolver-recovered-sibling-log-masking.test.ts`.
   *
   * **Both call sites reach it only when a bag is present, and that gate lives
   * at the CALL SITE rather than in here on purpose.** `resolveValue` recurses
   * once per nesting level, so routing every level through a second async
   * frame roughly doubles the resolver's frame cost for a deeply nested
   * property and lowers the depth at which it raises `RangeError`. An early
   * return inside this method would not help — the frame is created by the
   * call. Gating outside leaves every caller that passes no bag (deploy, diff,
   * drift, rollback) on exactly the pre-#3218 call shape, which is what makes
   * "a bagless caller is unchanged" true in the stack dimension too. Measured,
   * not reasoned: the heavier shape inverted the frame-weight ordering that
   * `tests/unit/cli/import-observed-baseline-refusal-matrix.test.ts` bisects
   * for, and that is how it was caught rather than shipped.
   */
  /** @internal */
  async resolveKeyUnit(
    key: string,
    val: unknown,
    context: ResolverContext,
    /**
     * The caller's bag, passed EXPLICITLY rather than re-read off `context`,
     * so the push site needs no non-null assertion.
     *
     * This does NOT make "only runs when a bag exists" a type-level fact, and
     * an earlier revision of this comment claimed it did: a future
     * `resolveKeyUnit(key, val, context, context.abandonedResolutions ?? [])`
     * type-checks, reintroduces the per-level frame, and silently discards
     * every entry. The call-site gate below is the real control; this
     * parameter only removes an assertion.
     */
    abandoned: AbandonedResolution[]
  ): Promise<unknown> {
    try {
      return await this.resolveValue(val, context);
    } catch (err) {
      // The refusal gate, in the same order as the token loop's catch.
      if (isDeliberateResolutionRefusal(err)) throw err;
      abandoned.push(this.abandonedUnit('key', key, err, context, val));
      return val;
    }
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

  /**
   * Copy any {@link ResolverContext.inheritedSecrets} pair whose PLAINTEXT is
   * present in a just-resolved parameter value into this context's
   * `recordedSecretValues` (issues #1903 / #2087).
   *
   * WHY AT RESOLUTION TIME. This is the whole of the #2087 fix. The parent
   * hands a nested child already-resolved plaintext, so the child's own
   * resolution never sees a `{{resolve:` and cannot record the pair itself; the
   * first cut pre-SEEDED every child resource's map with the parent's bag,
   * which restored the redaction but destroyed the per-resource scoping
   * `perResourceSecrets` exists for. `redactSecretsForState` substring-matches
   * at or above {@link MIN_NEEDLE_LENGTH}, so a child resource that never
   * referenced the parameter but happens to spell `my-production-bucket` while
   * the secret is `production` had its state persisted as
   * `my-{{resolve:...}}-bucket` — which `redactParametersForDiff` does NOT
   * mirror on the desired side (it rewrites only the PARAMETERS), so every
   * later deploy saw a change: a perpetual UPDATE, or a perpetual REPLACEMENT
   * on a create-only property.
   *
   * Recording here binds the pair to exactly the resources whose resolution
   * consumed the parameter — which are exactly the ones that can carry the
   * plaintext into their persisted state — so the child gets the SAME scoping
   * RULE the PARENT already has, where `perResourceSecrets` is keyed by logical
   * id.
   *
   * That is PARITY with the parent, not a claim of exactness. Once a pair is in
   * a resource's bag, `redactSecretsForState` substring-matches every leaf of
   * THAT resource, so a resource which both `Ref`s the parameter and carries an
   * unrelated literal spelling the plaintext has the literal rewritten too. The
   * parent has precisely this residual for any resource that resolves a
   * `{{resolve:...}}`; what #2087 removed was the much wider version, where
   * every resource in the child got the bag whether it consumed the parameter
   * or not.
   *
   * The TWO ARMS of the match live in {@link inheritedSecretsCarriedBy}, shared
   * with the refusal below so the two can never drift apart.
   *
   * Covers every consumption shape, because `Fn::Sub` / `Fn::Join` /
   * `Fn::Select` / `Fn::FindInMap` all re-enter `resolveValue` and reach the
   * parameter through this same `Ref` branch.
   *
   * WHICH EXPRESSION the pair is recorded against is the issue
   * [#2291](https://github.com/go-to-k/cdkd/issues/2291) round-2 fix, and
   * skipping it made the persist and diff halves DISAGREE.
   *
   * `inherited` is keyed by PLAINTEXT, so two parent parameters resolving to
   * ONE value collapse to a single entry there and this method used to copy
   * whichever expression SURVIVED. That is invisible for a leaf spelled exactly
   * `{Ref: P}` — the persist path positions such a leaf through the parent's
   * per-parameter association and never consults this bag's value — but an
   * EMBEDDING shape (`Fn::Sub`, `Fn::Join`, and `{'Fn::Sub': '${P}'}`, which
   * `crossStackSourceKey` refuses because its `Fn::Sub` arm requires a dotted
   * attribute) fell to the plaintext-keyed VALUE SCAN, which reads exactly this
   * bag. Meanwhile `DeployEngine.redactParametersForDiff` answers PER PARAMETER.
   * So `Fn::Sub "postgres://u:${LoserParam}@host"` — the dominant CDK
   * connection-string shape — persisted the SURVIVOR's expression while the
   * desired side computed the LOSER's, and the two never matched again: a
   * perpetual UPDATE, or a perpetual REPLACEMENT on a create-only property.
   * That is issue [#2087](https://github.com/go-to-k/cdkd/issues/2087)'s symptom
   * arriving through a different door, prevented for the bare-`Ref` leaf and
   * created for the embedded one.
   *
   * Recording THIS parameter's own expression makes the value scan agree with
   * the diff side, so both halves move together.
   *
   * ONE SLOT PER PLAINTEXT is still all this bag can hold, so when ONE
   * resource consumes two such parameters the slot holds whichever `Ref`
   * resolved LAST, and a value-scanned embedding leaf would take that one
   * whatever it embeds. The persist path therefore no longer leaves an
   * `Fn::Sub` / `Fn::Join` over the child's parameters to this slot: since
   * issue [#2320](https://github.com/go-to-k/cdkd/issues/2320)
   * `positionByParameterPlaceholders` answers each placeholder from its OWN
   * parameter association, which is what `redactParametersForDiff` renders on
   * the desired side. What still reaches the slot is an embedding leaf that
   * arm refuses (issue [#4446](https://github.com/go-to-k/cdkd/issues/4446)):
   * two or more parts whose text the template cannot state; a rendering that
   * does not reassemble the resolved leaf; an unknown span the value scan
   * would rewrite; a recorded plaintext in the template's literal text, or one
   * the final re-scan still finds; and a recorded plaintext crossing a
   * placeholder's edge. There the order-dependent disagreement with the diff
   * side remains.
   *
   * Substituting is deliberately NOT done here — the resolved value is what
   * reaches AWS, and an `Fn::Equals` over a parameter must compare the real
   * value or the condition flips.
   */
  private recordInheritedParameterSecrets(
    parameterName: string,
    value: unknown,
    context: ResolverContext
  ): void {
    const inherited = context.inheritedSecrets;
    const recorded = context.recordedSecretValues;
    // go-to-k/cdkd#1998: a `NoEcho` value the PARENT consumed is a log-only
    // needle of the parent's bag, and the child's own parameter declaration
    // (a CDK-synthesized one never says `NoEcho`) cannot re-derive it. Carried
    // BEFORE the size test below, which reads a bag holding only log-only
    // needles as empty.
    if (inherited && recorded) carryLogOnlyValuesCarriedBy(inherited, recorded, value);
    if (!inherited || inherited.size === 0 || !recorded) return;
    // Issue #2291 round 2. THIS parameter's own expression, when the parent
    // certified one, rather than the collapsed map's survivor. See the
    // "WHICH EXPRESSION" section of the doc above for why the survivor is the
    // wrong answer for an EMBEDDING leaf and what residual is left.
    for (const [plaintext, expression] of inheritedSecretsCarriedBy(value, inherited)) {
      // ASKED PER PLAINTEXT, not per VALUE (issue #2327). This bag is keyed by
      // PLAINTEXT, so the question it needs answered is "does THIS parameter
      // certify THIS plaintext" -- which `inheritedParameterExpression` answers
      // through the same predicate the persist side uses, for a scalar value
      // and for an ELEMENT of a coerced `CommaDelimitedList` alike. The earlier
      // spelling asked about the whole `value` and gated on `plaintext ===
      // value`, which can never hold once `coerceParameterValue` has turned the
      // parent's string into an ARRAY: the override typechecked but could not
      // fire, so a list-typed parameter kept the collapsed survivor here.
      //
      // The scalar answer is UNCHANGED by the move, because the recorder's
      // condition 2 already subsumes the old gate: the association's recorded
      // plaintext IS this parameter's whole resolved value, so it can only
      // equal a carried plaintext that the old `plaintext === value` also
      // accepted. `inheritedSecretsCarriedBy` still returns pairs for OTHER
      // inherited plaintexts this value merely CONTAINS, and those still fall
      // through to their own parameter's expression -- handing them this one's
      // would be the collapse, one step over.
      //
      // `typeof own === 'string'` rather than `!== undefined`: the function
      // answers with an ARRAY for a list-typed parameter's whole value, and
      // this bag holds strings. Nothing here asks for that shape, but the guard
      // is what says so rather than leaving it to the argument passed above.
      const own = inheritedParameterExpression(inherited, parameterName, plaintext);
      recorded.set(plaintext, typeof own === 'string' ? own : expression);
      // go-to-k/cdkd#3717: a `NoEcho` value the parent supplied in THIS deploy
      // stays fresh in the child resource's bag, or its no-change skip reads
      // the new value's `***` as equal to the recorded `***`.
      carryFreshNoEchoMark(inherited, recorded, plaintext);
    }
  }

  /**
   * Record the value of a `NoEcho: true` PARAMETER as a LOG-ONLY needle of the
   * pass that consumed it (go-to-k/cdkd#1998). `NoEcho` is the template
   * author's declaration that the value is sensitive, and CloudFormation masks
   * it everywhere it echoes one.
   *
   * Every leaf a log line can spell is recorded: a string leaf, the
   * `String()` form of a number (a `Number` parameter is coerced before this
   * runs), and a list's comma-joined form, the spelling the user supplied and
   * the one `String()` renders. Log-only, so over-covering costs a masked log
   * line and nothing else. Recorded into the pass's own bag and nowhere else:
   * a pass without one (the parameter pass's log context) has no masker to
   * feed.
   */
  private recordNoEchoParameterValue(
    paramDef: ParameterDefinition | undefined,
    value: unknown,
    context: ResolverContext
  ): void {
    const bag = context.recordedSecretValues;
    if (paramDef?.NoEcho !== true || bag === undefined) return;
    // One spelling rule, shared with the deploy's diff log masker, which
    // records every `NoEcho` value up front (go-to-k/cdkd#4049).
    recordLogOnlyParameterValue(bag, value);
  }

  /**
   * Refuse a child parameter whose declared `Type` would COERCE an inherited
   * secret out of cdkd's string-keyed secret model (issue #1903, review round
   * 2).
   *
   * THE MODEL IS STRING-KEYED END TO END. `RecordedSecretValues` is keyed by
   * plaintext STRING, {@link recordInheritedParameterSecrets} scans strings and
   * string array elements, and `redactSecretsForState` rewrites string LEAVES.
   * `coerceParameterValue` turns a `Number` / `List<Number>` parameter into a JS
   * number before any of that runs, so the pair was never recorded, the leaf was
   * never rewritten, and the child's `state.json` persisted the DECRYPTED value
   * verbatim — the exact disclosure this issue closes for `String` parameters —
   * with `cdkd diff --recursive` then reporting a change on every run.
   *
   * WHY A REFUSAL RATHER THAN RECORDING ON THE PRE-COERCION STRING. Recording
   * the pair is not enough on its own: the persisted leaf is a NUMBER, so the
   * redactor would additionally have to rewrite a number leaf into an
   * expression STRING, matched by `String(n) === plaintext`. That comparison
   * both UNDER-covers (`"007"` coerces to `7` and stringifies back to `"7"`, so
   * a zero-padded secret silently stays plaintext) and OVER-covers (a numeric
   * secret like `8080` whole-value-matches every unrelated port in the bag —
   * issue #2087's class, on a path where `MIN_NEEDLE_LENGTH` does not apply).
   * A remedy that can silently under-cover is the wrong one for a disclosure
   * path, so this refuses and NAMES the parameter instead.
   *
   * The blast radius is nil for CDK-authored apps: CDK synthesizes every
   * nested-stack cross-reference parameter as `Type: String`. A hand-authored
   * template that really wants a numeric secret can declare the parameter
   * `String` and keep the value a string, which is what CloudFormation's own
   * `NoEcho` / dynamic-reference handling assumes anyway.
   *
   * SCOPED TO THE INHERITED BAG, which is non-empty only on a nested-stack
   * child engine, and only for a value that actually carries a pair the parent
   * PROVED secret. An ordinary `Type: Number` parameter is untouched.
   *
   * The message never quotes the value.
   */
  private refuseCoercedInheritedSecret(
    name: string,
    paramDef: ParameterDefinition,
    userValue: string,
    inherited: RecordedSecretValues | undefined
  ): void {
    if (!inherited || inherited.size === 0) return;
    // MEASURE the loss; do not enumerate the types that cause it. A hand-kept
    // list of "types that lose string identity" was wrong the moment it was
    // written: it named `Number` / `List<Number>` and explicitly cleared
    // `CommaDelimitedList` as safe because it "produces an array of strings
    // (both of which the recording scan and the redactor handle)". That holds
    // only while the secret contains no comma -- and the dominant Secrets
    // Manager shape is a JSON blob, which is nothing but commas. `,`-splitting
    // shreds the plaintext into FRAGMENTS, so neither arm of
    // `inheritedSecretsCarriedBy` matches, nothing is recorded, the redactor is
    // the identity, and the child's state.json keeps the cleartext -- the exact
    // escape this refusal exists to close, on a type an audit had cleared.
    //
    // Comparing the pairs BEFORE and AFTER coercion answers the real question
    // ("did coercion destroy a needle we would have redacted with?") instead of
    // a proxy for it. It subsumes `Number` and `List<Number>`, covers the
    // `.trim()` whitespace variant, keeps a comma-FREE `CommaDelimitedList`
    // secret working, and cannot go stale when a new `Type` is added to
    // `coerceParameterValue`.
    const carriedBefore = inheritedSecretsCarriedBy(userValue, inherited).length;
    if (carriedBefore === 0) return;
    const carriedAfter = inheritedSecretsCarriedBy(
      this.coerceParameterValue(userValue, paramDef.Type),
      inherited
    ).length;
    if (carriedAfter >= carriedBefore) return;
    // `markNonRetryable` for the same reason the `Fn::GetAtt` refusals above
    // carry it: the decision comes from the template's declared `Type`, which
    // no retry rewrites, and the message interpolates a template-controlled
    // parameter NAME that the substring-matching retry classifiers can read as
    // transient (issue #1838).
    //
    // `name` is a template-declared PARAMETER key, i.e. arbitrary JSON, so it
    // takes the builder like every other identifier this file renders
    // (go-to-k/cdkd#3435 review round 2). It appears TWICE in this message, so
    // it is bound once. The declared `Type` takes it too (issue #3441): this
    // arm is reached by any type the coercion SPLITS, and
    // `isListParameterType` accepts every `List<...>` spelling, so the inner
    // text is arbitrary template JSON.
    const loggedName = this.displayMasked(name);
    const loggedType = this.displayMasked(paramDef.Type);
    throw markNonRetryable(
      new IntrinsicResolutionRefusalError(
        `Nested-stack parameter ${quotedRender(loggedName, "'")} is declared ${QUOTABLE_RENDER.test(loggedType) ? `'Type: ${loggedType}'` : 'with a Type that is not a plain identifier'}, but the ` +
          `parent stack resolved a SECRET dynamic reference into it. cdkd keeps a resolved ` +
          `secret out of persisted state by rewriting STRING leaves back to their ` +
          `{{resolve:...}} expression; coercing this value to ${quotedRender(loggedType, "'", 'that Type')} destroys the ` +
          `plaintext cdkd would have matched on, so the DECRYPTED secret would be left in the ` +
          `child stack's state.json with nothing to redact it back ` +
          `to. Declare ${quotedRender(loggedName, "'", 'the parameter')} as 'Type: String' in the nested stack's template (CDK does ` +
          `this by default for cross-stack references), or stop passing a secret reference ` +
          `into it.`,
        undefined,
        'NESTED_STACK_SECRET_PARAMETER_TYPE'
      )
    );
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
  nameIsNeverAResource(logicalId: string, context: ResolverContext): boolean {
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
  lookupResourceRecord(
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
   */
  /** @internal */
  async resolveRef(logicalId: string, context: ResolverContext): Promise<unknown> {
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
      return value;
    }

    // Check if it's a pseudo parameter
    const pseudoValue = await this.resolvePseudoParameter(logicalId, context);
    if (pseudoValue !== undefined) {
      const valueStr =
        typeof pseudoValue === 'symbol' ? pseudoValue.toString() : String(pseudoValue);
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
  private resolveRefValue(
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
  private noteRefStateMask(logicalId: string, key: string, context: ResolverContext): void {
    this.pushRedactedAttributeRead(context, {
      kind: 'ref-state-key',
      logicalId,
      key,
      display: `Ref ${this.displayMasked(logicalId, context)} (state key ${key})`,
    });
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
IntrinsicFunctionResolver.prototype.staleRecordRemedy = getAttMixin.staleRecordRemedy;
IntrinsicFunctionResolver.prototype.unenrichedRemedy = getAttMixin.unenrichedRemedy;
IntrinsicFunctionResolver.prototype.healWithheld = getAttMixin.healWithheld;
IntrinsicFunctionResolver.prototype.withheldRemedy = getAttMixin.withheldRemedy;
IntrinsicFunctionResolver.prototype.healStaleAttributes = getAttMixin.healStaleAttributes;
IntrinsicFunctionResolver.prototype.usableHealedAttribute = getAttMixin.usableHealedAttribute;
IntrinsicFunctionResolver.prototype.serveHealedAttribute = getAttMixin.serveHealedAttribute;
IntrinsicFunctionResolver.prototype.constructWithStaleRecordHeal =
  getAttMixin.constructWithStaleRecordHeal;
IntrinsicFunctionResolver.prototype.constructGuardedAttribute =
  getAttMixin.constructGuardedAttribute;
IntrinsicFunctionResolver.prototype.healBeforeConstructing = getAttMixin.healBeforeConstructing;
IntrinsicFunctionResolver.prototype.constructAttribute = getAttMixin.constructAttribute;
IntrinsicFunctionResolver.prototype.refuseUnservedAttribute = getAttMixin.refuseUnservedAttribute;
IntrinsicFunctionResolver.prototype.refuseUnconstructibleAttribute =
  getAttMixin.refuseUnconstructibleAttribute;
IntrinsicFunctionResolver.prototype.refuseUndefinedAttribute = getAttMixin.refuseUndefinedAttribute;
IntrinsicFunctionResolver.prototype.describeFailureObserved = getAttMixin.describeFailureObserved;
IntrinsicFunctionResolver.prototype.guardedPhysicalIdFallback =
  getAttMixin.guardedPhysicalIdFallback;
