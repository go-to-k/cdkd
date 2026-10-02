import { CloudFormationClient, type Export as CfnExport } from '@aws-sdk/client-cloudformation';
import { DescribeAvailabilityZonesCommand } from '@aws-sdk/client-ec2';
import type { ServiceDiscoveryClient } from '@aws-sdk/client-servicediscovery';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { getLogger } from '../utils/logger.js';
import { getAwsClients, type AwsClients } from '../utils/aws-clients.js';
import { canonicalizeRegion, derivePartitionAndUrlSuffix } from '../utils/aws-partition.js';
import { stripControlChars } from '../utils/regexp.js';
import { displaySafe, safeMsg } from '../utils/display-safe.js';
import { UNSHOWABLE_VALUE } from '../utils/pasteable-command.js';
import { IntrinsicResolutionRefusalError } from '../utils/error-handler.js';
import { withSharedDrainBudget } from './drain-budget.js';
import { recordAssumedConditions } from './assumed-conditions.js';
import { markNonRetryable } from './retryable-errors.js';
import { ssmResolvedValueType } from '../utils/parameter-types.js';
import {
  maskSecretsInText,
  maskRecordedSecretsInText,
  recordLogOnlyValue,
  recordLogOnlyParameterValue,
  unionOfSecretBags,
  carryLogOnlyValuesCarriedBy,
  carryLogOnlyValues,
  recordLogOnlySplitFragments,
  hasMaskableValues,
  hasLogOnlyValues,
  recordIntrinsicLeafResolution,
  recordIntrinsicLeafResolutionAs,
  intrinsicLeafResolutionOf,
  inheritedParameterExpression,
  recordDerivedMaskOnlyValue,
  recordFreshNoEchoValuesIn,
  embedsFreshNoEchoValue,
  carryFreshNoEchoMark,
  SECRET_MASK,
  type DynamicReferenceSubstitution,
  type IntrinsicLeafResolution,
  type RecordedSecretValues,
} from './secret-redaction.js';
import type { CloudFormationTemplate } from '../types/resource.js';
import { type ResourceState } from '../types/state.js';
import {
  ambientCredentialConfig,
  clientDefaultsFor,
  credentialFingerprint,
  type CredentialConfig,
} from '../utils/ambient-client-defaults.js';
import { injectiveKey } from '../state/record-keys.js';
import {
  type LogTwin,
  type AbandonedResolution,
  type ResolverContext,
  type CachedDynamicReference,
  type ParameterDefinition,
  AWS_NO_VALUE,
  refStateLookupFromResource,
  cfnRefValueFromPhysicalId,
  detectUnknownIntrinsicKey,
  buildUnknownIntrinsicError,
  LOG_TWINS_BY_PASS,
  carriesDynamicReference,
  NESTED_STACK_OUTPUT_ATTRIBUTE_PREFIX,
  selectIndexPosition,
  carriesFetchableDynamicReference,
  isDeliberateResolutionRefusal,
  cachedAvailabilityZones,
  DRAIN_AFTER_REJECTION_MS,
  concurrentDrainCap,
  allSettledKeepingFirstRejection,
  clientCacheKey,
  isClientSafeRegion,
  getAccountInfo,
  collectReferencedParameterNames,
  isUnboundTemplateParameter,
  coerceParameterTypedValue,
  coerceParameterDefault,
  inheritedSecretsCarriedBy,
  stringifyParameterForLog,
  boundAltered,
  QUOTABLE_RENDER,
  isLogInert,
  isLogInertJson,
  isStructured,
  quotedRender,
} from './intrinsic-resolver/support.js';
import * as getAttMixin from './intrinsic-resolver/getatt.js';
import * as crossStackMixin from './intrinsic-resolver/cross-stack.js';
import * as dynamicRefsMixin from './intrinsic-resolver/dynamic-refs.js';
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
  private warnAbandonedParts(pending: number): void {
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
  private async resolveKeyUnit(
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
   * per-parameter association and never consults this bag's value — but every
   * EMBEDDING shape (`Fn::Sub`, `Fn::Join`, and `{'Fn::Sub': '${P}'}`, which
   * `crossStackSourceKey` refuses because its `Fn::Sub` arm requires a dotted
   * attribute) falls to the plaintext-keyed VALUE SCAN, which reads exactly this
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
   * THE RESIDUAL, and the earlier version of this note UNDERSTATED IT. It said
   * the leftover case was "no worse than the behaviour before this fix". That
   * is true only of the shape it was measured on. MEASURED 2026-08-27 against
   * `main` (f56c2cf9) and against this branch, one child resource, parameters
   * `A` and `B` resolving to one plaintext:
   *
   * | shape                                    | main    | here    |
   * | ---------------------------------------- | ------- | ------- |
   * | `{Ref: A}` and `{Ref: B}`                | agree   | agree   |
   * | `Fn::Sub '${A}'` only                    | agree   | agree   |
   * | `Fn::Sub 'x${A}'` **and** `{Ref: B}`     | agree   | DISAGREE|
   *
   * The third row is a NEW disagreement this PR introduces, not a pre-existing
   * one it fails to fix: `main` had both halves take the collapsed survivor, so
   * they matched (on the WRONG expression, which is issue #2291, but they
   * matched). Here the DIFF side is per-parameter while an EMBEDDED leaf can
   * only be redacted by the plaintext-keyed value scan, and this bag holds ONE
   * entry — whichever `Ref` resolved LAST. So the embedded leaf takes `B`'s
   * expression while the desired side computes `A`'s, and the resource reports
   * an UPDATE on every deploy (a REPLACEMENT, on a create-only property).
   *
   * It is ORDER-DEPENDENT, which is why it is narrow: reversing the two
   * properties makes the embedded parameter the last one resolved and the two
   * halves agree again (measured). It also needs BOTH leaves in ONE resource —
   * `perResourceSecrets` is keyed by logical id, so two resources get two bags
   * and each is right. A resource that consumes and embeds BOTH parameters is
   * unfixable here for the same reason and is genuinely inherent.
   *
   * CLOSING IT NEEDS A PLACEHOLDER-SPAN POSITION ARM — aligning an `Fn::Sub` /
   * `Fn::Join` source against the resolved string to locate each placeholder's
   * span and rewrite it from the association. That is a new positioning
   * CONCEPT rather than an arm beside the existing ones: the persist path would
   * have to reproduce the resolver's substitution semantics from a module that
   * holds neither a resolver nor a parameter bag, and any divergence between
   * the two reproductions is this same perpetual-UPDATE bug. Deferred to issue
   * [#2320](https://github.com/go-to-k/cdkd/issues/2320) with the measurement.
   * It shares only the word "span" with issue #2102, which registers live
   * values for `{{resolve:...}}` TOKEN spans on the drift paths.
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
  private nameIsNeverAResource(logicalId: string, context: ResolverContext): boolean {
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
  private async resolveRef(logicalId: string, context: ResolverContext): Promise<unknown> {
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

  /**
   * Resolve Fn::Join intrinsic function
   *
   * Fn::Join: [delimiter, [value1, value2, ...]]
   */
  private async resolveJoin(
    joinArgs: [string, unknown],
    context: ResolverContext,
    source: object
  ): Promise<string> {
    const [delimiter, rawValues] = joinArgs;

    // The 2nd arg is normally a literal array, but CloudFormation also allows it
    // to be a SINGLE intrinsic that RETURNS a list (Fn::Cidr / Fn::GetAZs /
    // Fn::Split, or a Ref to a list-typed parameter -- any `List<...>` type
    // or `CommaDelimitedList`). In that case
    // resolve it first so it becomes an array before we map over it.
    let values: unknown = rawValues;
    if (!Array.isArray(values)) {
      values = await this.resolveValue(values, context);
    }

    if (!Array.isArray(values)) {
      throw new Error(
        `Fn::Join's second argument must be a list (an array literal or a list-returning intrinsic such as Fn::Cidr / Fn::GetAZs / Fn::Split / a Ref to a list-typed parameter — any List<...> type or CommaDelimitedList), but resolved to ${typeof values}`
      );
    }

    // Resolve each value first, draining every part before a rejection
    // surfaces (issue #2563): a part that records a secret must finish
    // recording before a caller's `catch` / `finally` sees the failure.
    //
    // Each part carries its LOG TWIN (issue #3100, see `LogTwin`). A STRING
    // part is resolved here rather than through `resolveValue`, whose string
    // arm is exactly `resolveDynamicReferences` over a string holding a
    // `{{resolve:` opener and the string itself otherwise, so the value is
    // unchanged and the substitution's twin is kept. A part in a LITERAL list
    // that spells no reference keeps itself as its twin even when it equals a
    // recorded secret: a template literal is not a resolution product, and
    // masking it would be a needle mask with no floor. Every other part — an
    // intrinsic, or an element of a list an intrinsic returned — is a
    // resolution product, whose twin is decided only AFTER the drain: the
    // parts resolve concurrently, and a product checked as soon as it settled
    // would miss a secret a sibling part records later in the same Join.
    const literalList = Array.isArray(rawValues);
    // Each part also returns its `input` text and its own pass's evidence
    // (issue #3156), read only after the drain and in part order, so the
    // record does not depend on which part settled first.
    const resolvedParts = await allSettledKeepingFirstRejection(
      () =>
        values.map(
          async (
            v
          ): Promise<
            LogTwin & {
              readonly product: boolean;
              readonly raw?: { value: unknown };
              readonly input: string;
              readonly substitutions: readonly DynamicReferenceSubstitution[];
              readonly complete: boolean;
            }
          > => {
            if (typeof v === 'string') {
              // An element of a list an intrinsic returned can still spell a
              // reference after that intrinsic resolved it (a resolved value that
              // is itself reference text). Its second resolution starts from the
              // twin the first one registered, so the first stage's mask is kept
              // (issue #3114). A literal element's seed differs from its text only
              // when a product of this pass equals that text, or when the text is
              // itself a recorded secret (a token-shaped plaintext, issue #1917),
              // so for a literal the seed can only mask more.
              const part = v.includes('{{resolve:')
                ? await this.resolveDynamicReferencesWithLogTwin(
                    v,
                    this.logTwinOfProduct({ result: v, twin: v }, context).twin,
                    context
                  )
                : { result: v, twin: v, substitutions: [], complete: true };
              return {
                result: part.result,
                twin: part.twin,
                product: !literalList,
                input: v,
                substitutions: part.substitutions,
                complete: part.complete,
              };
            }
            const raw = await this.resolveValue(v, context);
            const resolved = String(raw);
            return {
              result: resolved,
              twin: resolved,
              product: true,
              raw: { value: raw },
              // A nested `Fn::Join` / `Fn::Sub` / `Fn::If` part lends its own
              // record (issue #3306).
              ...this.nestedPartResolution(context, v, resolved),
            };
          }
        ),
      (pending) => this.warnAbandonedParts(pending)
    );
    const parts = resolvedParts.map((part) => {
      if (!part.product) return part;
      // An intrinsic part is twinned from its RAW value, so a list keeps its
      // elements' twins through the stringification; a string element of a
      // list an intrinsic returned keeps its own twin rule.
      if (part.raw)
        return { result: part.result, twin: this.productLogTwin(part.raw.value, context) };
      return this.logTwinOfProduct(part, context);
    });

    let result = parts.map((part) => part.result).join(delimiter);
    let twin = parts.map((part) => part.twin).join(delimiter);
    const substitutions = resolvedParts.flatMap((part) => part.substitutions);
    let complete = resolvedParts.every((part) => part.complete);
    // Resolve any dynamic references in the joined result (secret refs are
    // left unresolved per-reference when skipDynamicReferences is set). The
    // CDK `secretValueFromJson` shape completes its token only HERE, so this
    // substitution is the write the twin most needs to see.
    if (result.includes('{{resolve:')) {
      const joined = await this.resolveDynamicReferencesWithLogTwin(result, twin, context);
      ({ result, twin } = joined);
      substitutions.push(...joined.substitutions);
      complete &&= joined.complete;
    }
    this.recordLeafResolution(context, source, {
      input: resolvedParts.map((part) => part.input).join(delimiter),
      output: result,
      substitutions,
      complete,
    });
    this.rememberLogTwin(context, result, twin);
    this.logger.debug(
      `Resolved Fn::Join: ${this.logRender(this.logTwinText(result, twin, context), context)}`
    );
    return result;
  }

  /**
   * The warning emitted when `Fn::Sub` keeps a `${...}` placeholder verbatim.
   *
   * It carries the underlying reason (issue #1740 item 2): the old text
   * asserted `not found` for EVERY failure, which was the wrong cause whenever
   * the variable WAS found and its resolution failed for some other reason.
   * Deliberate refusals no longer reach this path at all — they re-throw.
   */
  private subPlaceholderWarning(varName: string, error: unknown): string {
    const reason = error instanceof Error ? error.message : String(error);
    return `Fn::Sub variable ${varName} could not be resolved (${reason}), keeping placeholder`;
  }

  /**
   * Does this `Fn::Sub` placeholder NAME an entity of this template -- a
   * resource (issue [#2270](https://github.com/go-to-k/cdkd/issues/2270)) or
   * an unbound parameter (issue
   * [#2285](https://github.com/go-to-k/cdkd/issues/2285))?
   *
   * The discriminator `resolveSub`'s catch was missing. Two very different
   * things reach that catch and it collapsed both into "keep the placeholder":
   *
   *  - `${some_shell_var}` / `${config.value}` — ORDINARY TEXT that merely
   *    looks like a placeholder. Real CloudFormation rejects it (a `${}` in a
   *    `Fn::Sub` body must name something, or be escaped `${!...}`), but cdkd
   *    has always accepted it, and templates in the wild rely on that. Keeping
   *    it is right.
   *  - `${Child.Outputs.Foo}` — a REFERENCE to a resource this very template
   *    declares, whose resolution failed. Keeping it ships `${Child.Outputs.Foo}`
   *    into a live resource's property with a warn line as the only signal,
   *    which is the defect. Refusing is right.
   *
   * The test is on the HEAD SEGMENT (everything before the first dot — the
   * same split `template-parser.ts` uses to draw the DAG edge for this exact
   * placeholder, and the same one `resolveGetAtt` now uses). A head that names
   * a declared resource cannot be ordinary text: the template author picked
   * that logical id.
   *
   * BOTH the live `context.resources` map and the TEMPLATE's `Resources` block
   * count, and they answer for DIFFERENT populations rather than one being a
   * superset of the other:
   *
   * - the TEMPLATE arm is what fences the reported defect — a resource the
   *   template DECLARES which is absent from state, whose `Fn::GetAtt` throws
   *   `Resource X not found`. A `context.resources`-only test would leave that
   *   unfenced, which is why the template arm exists.
   * - the `context.resources` arm answers when the head IS live but the
   *   reference still fails for a NON-refusal reason: a malformed attribute
   *   (`${Child.}` reaches `Invalid Fn::GetAtt format`), or a transient SDK
   *   error surfacing out of `reresolveCrossStackValue`. It is also the ONLY
   *   arm that fires when the two maps DISAGREE in the other direction — a
   *   resource in state that the template no longer declares.
   *
   * Neither arm is redundant, and neither is dead: `tests/unit/deployment/
   * intrinsic-sub-nested-stack-outputs.test.ts` drives each one in isolation
   * (an empty `Resources` with a populated `resources`, and the reverse).
   *
   * PARAMETERS are included too, but only for the UNBOUND population
   * {@link isUnboundTemplateParameter} defines -- declared, no `Default`, no
   * bound value (issue
   * [#2285](https://github.com/go-to-k/cdkd/issues/2285)). `resolveRef` and
   * `resolvePseudoParameter` already answer for every parameter that HAS a
   * value, so that population is the whole of what this arm newly refuses,
   * and it is the one whose placeholder used to be persisted verbatim.
   *
   * The predicate is SHARED with `resolveParameters`, which raises
   * `Parameter <name> is required ...` for exactly the same population up
   * front -- so on a plain `cdkd deploy` this arm is unreachable by
   * construction, and what it actually covers is the caller that CATCHES that
   * error and resolves anyway (`cdkd import`, in every mode, on a context that
   * is not `bestEffort`).
   *
   * A parameter carrying a `Default` the caller never merged stays OUT, for
   * the reason recorded on the shared predicate.
   *
   * An earlier revision excluded parameters WHOLESALE and justified that by
   * "the routine `cdkd scrub` case (it takes no `--parameters`)". That reason
   * was FALSE and is recorded here so it is not reintroduced: `scrub.ts`'s `resolverContext` factory sets
   * `bestEffort: true` in the same object literal that binds `template` and
   * `resources`, so scrub short-circuits in `rethrowStructuralSubFailure`
   * before this predicate is consulted at all — it can neither benefit from
   * nor be harmed by what this function includes.
   */
  private subPlaceholderNamesADeclaredTemplateEntity(
    varName: string,
    context: ResolverContext
  ): boolean {
    const firstDot = varName.indexOf('.');
    const head = firstDot >= 0 ? varName.slice(0, firstDot) : varName;
    if (head === '') return false;
    // Not for a parameter or pseudo-parameter name (issue #3916): a record
    // planted under it must not decide refuse-vs-warn either.
    if (!this.nameIsNeverAResource(head, context) && Object.hasOwn(context.resources, head)) {
      return true;
    }
    const declared = context.template?.Resources;
    if (declared !== undefined && declared !== null && typeof declared === 'object') {
      if (Object.hasOwn(declared, head)) return true;
    }
    return isUnboundTemplateParameter(head, context.template, context.parameters);
  }

  /**
   * Refuse to launder a STRUCTURAL `Fn::Sub` failure into a literal
   * (issues [#2270](https://github.com/go-to-k/cdkd/issues/2270) and
   * [#2285](https://github.com/go-to-k/cdkd/issues/2285)).
   *
   * Called from both arms of `resolveSub`'s catch — the dotted (GetAtt) one
   * and the bare (Ref) one — after the
   * {@link IntrinsicResolutionRefusalError} re-throw that issue #1740 added.
   * That earlier fix made the DELIBERATE refusals loud; this one covers the
   * rest, which is where #2270 lived: `Invalid Fn::GetAtt format` and
   * `Resource X not found for Fn::GetAtt` are plain `Error`s, so they were
   * laundered.
   *
   * The ORIGINAL error is re-thrown UNCHANGED — not wrapped, not re-worded.
   * The retry classifiers in `retryable-errors.ts` match on the message by
   * SUBSTRING and `markNonRetryable` rides the error OBJECT, so wrapping would
   * silently re-classify a genuinely transient failure (an SDK error surfacing
   * out of the nested-stack output re-resolution below) as terminal, or a
   * terminal one as retryable via a template-controlled logical id spliced
   * into a new message. Loudness is the fix; changing the error is not part of
   * it.
   *
   * `bestEffort` is EXEMPT. That flag marks the diff / `cdkd scrub` callers,
   * whose documented expected case is a reference to a resource this same
   * deploy will CREATE (the CDK logical-id-churn dance, issue #1017) — exactly
   * the "declared but not in state" shape this refuses. Those callers also
   * catch resolution failures and keep the raw intrinsic, so refusing there
   * would change diff output for no gain.
   */
  private rethrowStructuralSubFailure(
    varName: string,
    error: unknown,
    context: ResolverContext
  ): void {
    if (context.bestEffort) return;
    if (!this.subPlaceholderNamesADeclaredTemplateEntity(varName, context)) return;
    throw error;
  }

  /**
   * Refuse a LIST where `Fn::Sub` needs a string (issue
   * [#3809](https://github.com/go-to-k/cdkd/issues/3809)). CloudFormation
   * rejects the template for every list source: a `${X}` resolving to a
   * `List<...>` / `CommaDelimitedList` parameter, a list-valued attribute or
   * `AWS::NotificationARNs` ("variable X in Fn::Sub expression does not resolve
   * to a string"), and a variable-map value that is a list, USED or not ("every
   * value of the context object of every Fn::Sub object must be a string or a
   * function that returns a string"). `String()` over the array used to render
   * `a,b` instead, so cdkd deployed a template CloudFormation refuses.
   *
   * RETURNS the refusal rather than throwing it: `resolveSub` keeps the FIRST
   * one and throws only after every variable and placeholder has resolved and
   * the final dynamic-reference pass has run, so a `{{resolve:...}}` behind
   * the list still records its needle (the go-to-k/cdkd#3218 class, which
   * `cdkd scrub` depends on).
   *
   * `subject` names template-controlled text, so it is masked here, once.
   * Marked non-retryable: no retry changes a template.
   */
  private subListRefusal(
    subject: string,
    value: unknown,
    context: ResolverContext
  ): IntrinsicResolutionRefusalError | undefined {
    if (!Array.isArray(value)) return undefined;
    const count = `${value.length} item${value.length === 1 ? '' : 's'}`;
    return markNonRetryable(
      new IntrinsicResolutionRefusalError(
        `Fn::Sub: ${this.displayMasked(subject, context)} resolves to a list (an array of ${count}), ` +
          `not a string. CloudFormation rejects this template too, because every Fn::Sub ` +
          `variable must resolve to a string. Render the list with Fn::Join in the variable ` +
          `map instead, for example ["ids=\${Ids}", {"Ids": {"Fn::Join": [",", {"Ref": "SubnetIds"}]}}].`
      )
    );
  }

  /**
   * Resolve Fn::Sub intrinsic function
   *
   * Fn::Sub supports two forms:
   * 1. String with ${VarName} placeholders
   * 2. [String, {VarName: value, ...}] with explicit variable mapping
   *
   * Note: This is a simplified implementation that doesn't handle async properly
   * inside replace(). For full async support, we'd need to collect all replacements
   * first, then do them synchronously.
   */
  private async resolveSub(
    subArgs: string | [string, Record<string, unknown>],
    context: ResolverContext,
    source: object
  ): Promise<string> {
    let template: string;
    // Resolved INTO A FRESH OBJECT, never back into the caller's map (issue
    // #2739). `subArgs[1]` is the object inside the caller's template — an
    // Output's `Value['Fn::Sub'][1]`, a resource property's — and writing the
    // resolved values into it left the template holding a plaintext where it
    // had held a `{{resolve:...}}` reference or an intrinsic. A template is a
    // description, not a cache: a later resolution of the same object with a
    // fresh recording map would then return the plaintext without recording
    // it (no token left for `resolveDynamicReferences` to see), and the
    // positioning source `DeployEngine.resolveOutputs` retains would carry
    // the secret. The plain-string form and `Fn::Join` never mutated theirs.
    //
    // `Object.create(null)`, not `{}`: the variable NAMES come from the
    // template, and `JSON.parse` makes `__proto__` an OWN key there, so a
    // plain object would route that one assignment through the inherited
    // prototype setter and render `${__proto__}` as `[object Object]` — the
    // same reason `redactByPath`'s object walk builds its output that way.
    // The membership test below therefore sees OWN keys only, on EITHER form
    // (the plain-string form used to test against a plain `{}` too), and it is
    // an `Object.hasOwn` besides (issue #2776): a placeholder
    // naming an `Object.prototype` member the map does not carry
    // (`${constructor}`, `${toString}`) used to substitute that member's
    // source text and now falls through to pseudo-parameter / `Ref`
    // resolution like any other unknown name.
    const variables: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    // The LOG TWIN of each variable whose raw value was a STRING (issue #3100,
    // see `LogTwin`), null-prototype for the reason `variables` is. A string
    // variable is resolved here rather than through `resolveValue`, whose
    // string arm is exactly `resolveDynamicReferences` over a string holding a
    // `{{resolve:` opener and the string itself otherwise, so the value is
    // unchanged: a reference-bearing one keeps its substitution's twin, and a
    // LITERAL keeps itself even when it equals a recorded secret. A variable
    // with no entry here (an intrinsic) is a resolution product, masked whole
    // at the replacement below when it is a recorded secret.
    const variableTwins: Record<string, string> = Object.create(null) as Record<string, string>;
    // What each variable contributes to the object's record (issue #3156),
    // keyed like the two maps above. Read per placeholder USE below, so a
    // variable the template never names contributes nothing to the record. A
    // STRING variable contributes its RAW text with its own dynamic-reference
    // pass, so a token it holds reaches `input` as the token (issue #3306); an
    // intrinsic one contributes its own record when the pass kept one
    // (`nestedPartResolution`), and its resolved text otherwise -- looked up
    // from `variableSources` at the placeholder, so an unused variable is
    // never stringified here.
    const variableSources: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const variableRecords: Record<
      string,
      Pick<IntrinsicLeafResolution, 'input' | 'substitutions' | 'complete'>
    > = Object.create(null) as Record<
      string,
      Pick<IntrinsicLeafResolution, 'input' | 'substitutions' | 'complete'>
    >;
    // The FIRST list refusal (issue #3809), thrown only once the walk is done
    // -- see `subListRefusal`.
    let listRefusal: IntrinsicResolutionRefusalError | undefined;

    // The TEMPLATE must be a string on both forms (issue #2776), checked before
    // the variable map below. CloudFormation takes only a literal string there,
    // and without this guard a non-string died at `template.matchAll is not a
    // function` — a TypeError naming this function's internals rather than
    // the template's shape. Refused on the same terms as the second element:
    // the TYPE is named and never the value, and it is marked non-retryable
    // because no retry changes a template.
    const subTemplateKind = (value: unknown): string =>
      value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (Array.isArray(subArgs)) {
      const [templateString, variableMap] = subArgs as unknown[];
      if (typeof templateString !== 'string') {
        throw markNonRetryable(
          new Error(
            `Fn::Sub: the first element must be a string, got ${subTemplateKind(templateString)}`
          )
        );
      }
      template = templateString;
      // A `null` / primitive second element is refused UNCONDITIONALLY —
      // newly enforced validation. Before this change `null` always threw
      // (`Object.entries(null)`) and so did a non-empty string (its indexed
      // entries could not be assigned back onto the primitive), but a number,
      // a boolean or an empty string failed only once a placeholder reached
      // the `in` test, so a placeholder-free template beside one resolved.
      // The cross-stack reader in `secret-redaction.ts` relies on the shape
      // never being recorded, and copying into a fresh object would have made
      // those three variants resolve silently. An ARRAY second element still
      // resolves by index (`${0}`); its non-enumerable `length` is no longer
      // a variable (`${length}` used to render the count through `in`), since
      // `Object.entries` copies own ENUMERABLE keys.
      if (typeof variableMap !== 'object' || variableMap === null) {
        throw markNonRetryable(
          new Error(
            `Fn::Sub: the second element must be a variable map, got ${
              variableMap === null ? 'null' : typeof variableMap
            }`
          )
        );
      }
      for (const [key, val] of Object.entries(variableMap)) {
        if (typeof val === 'string') {
          // The string arm needs no per-key wrapper: it enters the token loop
          // directly, which recovers per TOKEN and only throws for a refusal —
          // and a refusal must abort this walk too.
          const resolved = val.includes('{{resolve:')
            ? await this.resolveDynamicReferencesWithLogTwin(val, val, context)
            : { result: val, twin: val, substitutions: [], complete: true };
          variables[key] = resolved.result;
          variableTwins[key] = resolved.twin;
          variableRecords[key] = {
            input: val,
            substitutions: resolved.substitutions,
            complete: resolved.complete,
          };
        } else {
          // Same sequential-walk defect as the object bag (issue
          // go-to-k/cdkd#3218), found beside it: `Fn::Sub: ["...", {A: {Ref:
          // "NoSuchThing"}, B: "{{resolve:secretsmanager:...}}"}]` loses `B`
          // identically. The non-string arm is the one that needs the wrapper,
          // because it is the arm that can throw for a reason the token loop
          // never sees.
          // Deliberately writes NO `variableTwins` entry, abandoned or not:
          // this arm never set one, and the substitution site below falls back
          // to `productLogTwin` for exactly the keys it omits. An abandoned key
          // keeps its INPUT — an intrinsic object — and that fallback masks it
          // the same way it masks any other non-string product.
          // Bag-gated at the call site, as in `resolveValue` — see
          // `resolveKeyUnit`'s doc for why the extra frame is not free.
          variables[key] =
            context.abandonedResolutions === undefined
              ? await this.resolveValue(val, context)
              : await this.resolveKeyUnit(key, val, context, context.abandonedResolutions);
          variableSources[key] = val;
          // Refused whether or not the template names it: CloudFormation
          // validates every value of the map (issue #3809).
          listRefusal ??= this.subListRefusal(
            `the variable-map value ${key}`,
            variables[key],
            context
          );
        }
      }
    } else {
      if (typeof subArgs !== 'string') {
        throw markNonRetryable(
          new Error(`Fn::Sub: the template must be a string, got ${subTemplateKind(subArgs)}`)
        );
      }
      template = subArgs;
    }

    // Collect all replacements
    // `twin` is the replacement's LOG TWIN (issue #3100); an entry no secret
    // can reach (an escape, an empty `${}`, a pseudo parameter, a kept
    // placeholder) carries its replacement as its own twin.
    // `record` is set only for a variable: what it contributes to the
    // object's record (issues #3156, #3306).
    const replacements: Array<{
      match: string;
      replacement: string;
      twin: string;
      record?: Pick<IntrinsicLeafResolution, 'input' | 'substitutions' | 'complete'>;
    }> = [];
    // Match BOTH the literal-escape form `${!X}` and the variable form `${X}`.
    // The CloudFormation rule: a `${` immediately followed by `!` is an escape —
    // it renders as the literal text `${X}` with NO variable substitution. We
    // capture the optional leading `!` so escaped tokens are special-cased here
    // (emit `${X}` literally) and never reach variable / Ref / GetAtt resolution.
    const matches = template.matchAll(/\$\{(!)?([^}]*)\}/g);

    for (const match of matches) {
      const isEscaped = match[1] === '!';
      const varNameStr = match[2];

      // Literal-escape form `${!X}` -> emit `${X}` verbatim, no resolution.
      if (isEscaped) {
        const escapedLiteral = `\${${varNameStr ?? ''}}`;
        replacements.push({ match: match[0], replacement: escapedLiteral, twin: escapedLiteral });
        continue;
      }

      if (!varNameStr) {
        // An empty `${}` has nothing to resolve — leave it verbatim. Push an
        // entry so the positional single-pass replace below stays aligned.
        replacements.push({ match: match[0], replacement: match[0], twin: match[0] });
        continue;
      }

      let replacement: string;
      // Set only by the arms that RESOLVED something (issue #3100).
      let twinReplacement: string | undefined;
      let record: Pick<IntrinsicLeafResolution, 'input' | 'substitutions' | 'complete'> | undefined;

      // Check explicit variables first. `Object.hasOwn` rather than `in`
      // (issue #2776), on all three maps. UNFALSIFIABLE while they carry no
      // prototype -- a probe restoring `in` here is green, and that is stated
      // rather than left for the next reader to discover (the same note
      // `evaluateConditions`' memo carries) -- but whether a placeholder is
      // BOUND should not depend on how a map far above was allocated:
      // with a plain `{}` there, `${constructor}` rendered the `Object`
      // function's source text into a live property.
      if (Object.hasOwn(variables, varNameStr)) {
        replacement = String(variables[varNameStr]);
        twinReplacement = Object.hasOwn(variableTwins, varNameStr)
          ? variableTwins[varNameStr]
          : this.productLogTwin(variables[varNameStr], context);
        if (Object.hasOwn(variableRecords, varNameStr)) record = variableRecords[varNameStr];
        else if (Object.hasOwn(variableSources, varNameStr)) {
          record = this.nestedPartResolution(context, variableSources[varNameStr], replacement);
        }
      } else {
        // Check if it's a pseudo parameter. `AWS::NotificationARNs` is a LIST
        // one, refused like any other list (issue #3809).
        const pseudoValue = await this.resolvePseudoParameter(varNameStr, context);
        const pseudoRefusal = this.subListRefusal(
          `the variable \${${varNameStr}}`,
          pseudoValue,
          context
        );
        listRefusal ??= pseudoRefusal;
        if (pseudoRefusal) {
          replacement = match[0];
        } else if (pseudoValue !== undefined) {
          replacement = String(pseudoValue);
        } else {
          // Try to resolve as Ref
          try {
            const value = await this.resolveRef(varNameStr, context);
            const refusal = this.subListRefusal(`the variable \${${varNameStr}}`, value, context);
            listRefusal ??= refusal;
            replacement = refusal ? match[0] : String(value);
            if (!refusal) twinReplacement = this.productLogTwin(value, context);
          } catch (refError) {
            // A DELIBERATE refusal (`lookupResourceRecord`'s malformed-record
            // one, #3576) is the final answer on both arms below (issue #1740),
            // re-raised ahead of the GetAtt fallback. A bare re-throw: the
            // refusal was masked at its own throw.
            if (refError instanceof IntrinsicResolutionRefusalError) throw refError;
            // If not found, try to resolve as GetAtt (e.g., "Resource.Attribute")
            if (varNameStr.includes('.')) {
              try {
                const value = await this.resolveGetAtt(varNameStr, context);
                const refusal = this.subListRefusal(
                  `the variable \${${varNameStr}}`,
                  value,
                  context
                );
                listRefusal ??= refusal;
                replacement = refusal ? match[0] : String(value);
                if (!refusal) twinReplacement = this.productLogTwin(value, context);
              } catch (getAttError) {
                // A DELIBERATE refusal is re-raised, never laundered into a
                // literal `${...}` (issue #1740). Only a genuine miss — or an
                // unexpected failure whose cause the warning now names — falls
                // through to keeping the placeholder.
                // A bare re-throw composes no message: the refusal was masked at
                // its own throw one level down, which is a site this file's
                // coverage checker already governs. Masking it again here would
                // mask a mask.
                if (getAttError instanceof IntrinsicResolutionRefusalError) throw getAttError;
                // Issue #2270: a plain `Error` from a placeholder that NAMES a
                // resource of this template is structural too, and keeping it
                // ships `${Child.Outputs.Foo}` into a live property. Issue
                // #2285 adds the head segments that name an UNBOUND template
                // parameter on the same terms.
                this.rethrowStructuralSubFailure(varNameStr, getAttError, context);
                // MASKED (issue
                // [#2827](https://github.com/go-to-k/cdkd/issues/2827)'s
                // sweep), and DEFENCE IN DEPTH rather than a closed leak —
                // stated so the next reader does not assume a case exists for
                // it. Both operands of this warn are TEMPLATE literals: the
                // placeholder text, and a message whose reachable forms name
                // `varNameStr` (`Resource X not found for Fn::GetAtt`). A
                // plaintext can reach it only through an SDK rejection raised
                // inside an attribute lookup, which no unit fixture here
                // drives. The mask stays because the cost is one call and the
                // alternative is deciding, per future AWS error text, whether
                // this line is safe. Masked at the MESSAGE rather than per raw
                // value because the reason IS a caught message; the sub-floor
                // bound that implies is the one `evaluateConditions` states.
                this.logger.warn(
                  this.displayMasked(this.subPlaceholderWarning(varNameStr, getAttError), context)
                );
                replacement = match[0]; // Keep original placeholder
              }
            } else {
              // Issue #2270's other half, on the SAME terms as the dotted arm
              // above: `${MyBucket}` naming a resource this template declares
              // is an implicit `Ref`, never ordinary text, so a `Ref MyBucket
              // not found` here is structural and must not become a literal.
              // This is also the arm issue #2285 lives on: `${Stage}` naming a
              // parameter the template DECLARES with no `Default` and no bound
              // value is an implicit `Ref` for the same reason.
              this.rethrowStructuralSubFailure(varNameStr, refError, context);
              // Masked for the reason its `Fn::GetAtt` twin above is.
              this.logger.warn(
                this.displayMasked(this.subPlaceholderWarning(varNameStr, refError), context)
              );
              replacement = match[0]; // Keep original placeholder
            }
          }
        }
      }

      replacements.push({
        match: match[0],
        replacement,
        twin: twinReplacement ?? replacement,
        ...(record ? { record } : {}),
      });
    }

    // Apply all replacements in a SINGLE left-to-right pass over the same
    // regex, consuming the pre-collected replacements positionally. This avoids
    // the first-occurrence hazard of a sequential `String.replace(match, ...)`
    // loop — e.g. an escaped `${!X}` produces the literal `${X}`, which a later
    // `${X}` variable replacement's `.replace` would otherwise clobber — and
    // never re-scans an escaped token's literal output.
    let cursor = 0;
    let result = template.replace(/\$\{(!)?([^}]*)\}/g, (whole) => {
      const entry = replacements[cursor++];
      // Every regex match pushes exactly one entry during collection (including
      // the verbatim-kept empty `${}`), so this stays positionally aligned;
      // fall back to the matched text if a gap ever appears.
      return entry ? entry.replacement : whole;
    });
    // The LOG TWIN (issue #3100): the same positional pass over the same
    // template, consuming each entry's twin instead.
    let twinCursor = 0;
    let twin = template.replace(/\$\{(!)?([^}]*)\}/g, (whole) => {
      const entry = replacements[twinCursor++];
      return entry ? entry.twin : whole;
    });

    // The record (issue #3156). `input` is the template with each USED
    // variable replaced by what it contributes (issue #3306): a string
    // variable's RAW text, an intrinsic one's own record input or its
    // resolved text, every other placeholder by its replacement. So a token a
    // variable holds stays a token in `input`, beside the replacement that
    // resolved it, and the replacements the used variables made count ahead of
    // the final pass's own over the substituted template.
    let inputCursor = 0;
    const input = template.replace(/\$\{(!)?([^}]*)\}/g, (whole) => {
      const entry = replacements[inputCursor++];
      return entry ? (entry.record?.input ?? entry.replacement) : whole;
    });
    const substitutions = replacements.flatMap((entry) => entry.record?.substitutions ?? []);
    let complete = replacements.every((entry) => entry.record?.complete ?? true);

    // Resolve any dynamic references in the substituted result (secret refs are
    // left unresolved per-reference when skipDynamicReferences is set).
    if (result.includes('{{resolve:')) {
      const substituted = await this.resolveDynamicReferencesWithLogTwin(result, twin, context);
      ({ result, twin } = substituted);
      substitutions.push(...substituted.substitutions);
      complete &&= substituted.complete;
    }
    // After the final pass, so every reference in the template has recorded.
    if (listRefusal) throw listRefusal;
    this.recordLeafResolution(context, source, { input, output: result, substitutions, complete });
    this.rememberLogTwin(context, result, twin);
    this.logger.debug(
      `Resolved Fn::Sub: ${this.logRender(this.logTwinText(result, twin, context), context)}`
    );
    return result;
  }

  /**
   * Resolve Fn::Select intrinsic function
   *
   * Fn::Select: [index, [value1, value2, ...]]
   * Returns the value at the specified index in the list. The index may be an
   * intrinsic; it is resolved, then must name a position (issue #3574).
   */
  private async resolveSelect(selectArgs: unknown, context: ResolverContext): Promise<unknown> {
    if (!Array.isArray(selectArgs) || selectArgs.length !== 2) {
      // Destructuring anything else either throws a bare `TypeError` (an
      // object is not iterable) or, for a STRING operand, silently reads its
      // first two characters as the index and the list.
      throw markNonRetryable(
        new IntrinsicResolutionRefusalError(
          `Fn::Select takes a two-element list [index, list], got ${this.describeOperandShape(selectArgs, context)}`
        )
      );
    }
    const [index, list] = selectArgs as [unknown, unknown];

    // The index is RESOLVED, then validated (issue #3574). CloudFormation
    // accepts a `Ref` to a parameter and an `Fn::FindInMap` here, and the raw
    // operand used to be the property key: an intrinsic index read the key
    // `"[object Object]"` and yielded `undefined` with no warning, and a
    // string coercing to `NaN` passed BOTH bounds checks, so `"constructor"`
    // read the `Array` function off the prototype chain. `selectIndexPosition`
    // admits only a non-negative safe integer, so the read below is an own
    // element by construction and the placeholder carries no template text.
    const resolvedIndex = await this.resolveValue(index, context);
    const position = selectIndexPosition(resolvedIndex);
    if (position === undefined) {
      const source = this.describeSplitValueSource(index);
      const sourceClause = source ? ` (from ${this.displayMasked(source.label, context)})` : '';
      throw markNonRetryable(
        new IntrinsicResolutionRefusalError(
          `Fn::Select: the index${sourceClause} must resolve to a non-negative integer ` +
            `(a number, or its decimal string with no leading zero), got ${this.describeOperandShape(resolvedIndex, context)}. ` +
            `Use a literal, a Ref to a parameter or an Fn::FindInMap that yields one.`
        )
      );
    }

    const resolvedList = await this.resolveValue(list, context);

    if (!Array.isArray(resolvedList)) {
      // A plain `Error`, unlike the two refusals above, and deliberately left
      // so: the LIST is often a resolution product (`Fn::GetAtt`, a
      // parameter), and `cdkd scrub`'s per-key recovery abandons a plain error
      // for that key alone, where a refusal class abandons the enclosing
      // property.
      throw new Error(`Fn::Select: list must be an array, got ${typeof resolvedList}`);
    }

    // The position through the builder: a resolved index can come from a
    // parameter carrying a SECRET (a nested-stack child's inherited one), and
    // `displayMasked` masks it where the bare integer would not be.
    const loggedPosition = this.displayMasked(String(position), context);
    if (position >= resolvedList.length) {
      if (loggedPosition !== String(position)) {
        // The placeholder is a PROPERTY VALUE sent to AWS and persisted, so a
        // masked position cannot go into it.
        throw markNonRetryable(
          new IntrinsicResolutionRefusalError(
            `Fn::Select: the index ${loggedPosition} is out of bounds (array length: ` +
              `${resolvedList.length}), and it resolves from a secret value, so cdkd will ` +
              `not write it into the OutOfBounds placeholder.`
          )
        );
      }
      // Reached only when the position did not mask, so it renders as is.
      this.logger.warn(
        `Fn::Select: index ${position} out of bounds (array length: ${resolvedList.length})`
      );
      return `{{Fn::Select:${position}:OutOfBounds}}`;
    }

    const result: unknown = resolvedList[position];
    this.logger.debug(
      // LEAF-masked before the encoding, not after (issue
      // [#2759](https://github.com/go-to-k/cdkd/issues/2759)): `JSON.stringify`
      // escapes a leaf holding `"` / `\` / a control character, and a needle
      // matches literally — so a mask over the ENCODED text misses exactly the
      // secrets that carry those bytes. Leaf-masking also reaches the
      // whole-value arm, which has no {@link MIN_NEEDLE_LENGTH} floor.
      `Resolved Fn::Select: index ${loggedPosition} resolved to ${this.logRender(JSON.stringify(this.maskValueLeaves(result, context)), context, { structured: true })}`
    );
    return result;
  }

  /**
   * Render ONE `Fn::GetAtt` argument for {@link describeSplitValueSource}'s
   * label. A string is emitted verbatim; anything else is named by its
   * intrinsic key (`<Fn::Sub>`) or, failing that, as `<intrinsic>` — never by
   * default stringification, whose answer for an object is `[object Object]`.
   */
  private renderGetAttArg(arg: unknown): string {
    if (typeof arg === 'string') return arg;
    if (typeof arg === 'object' && arg !== null && !Array.isArray(arg)) {
      const keys = Object.keys(arg as Record<string, unknown>);
      const key = keys.length === 1 ? keys[0] : undefined;
      if (key !== undefined && (key === 'Ref' || key.startsWith('Fn::'))) return `<${key}>`;
    }
    return '<intrinsic>';
  }

  /**
   * Name a malformed operand's type, and its value when that is a scalar, for
   * a refusal message. The value is template text or a resolution product, so
   * it goes through the builder (issue #3479).
   */
  private describeOperandShape(value: unknown, context: ResolverContext): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return `an array of ${value.length}`;
    if (typeof value === 'string')
      return `string ${quotedRender(this.displayMasked(value, context), '"')}`;
    if (typeof value === 'number' || typeof value === 'boolean') {
      return `${typeof value} ${this.displayMasked(String(value), context)}`;
    }
    return typeof value;
  }

  /**
   * Name the UNRESOLVED value argument of an `Fn::Split` for its refusal
   * message (issue [#1874](https://github.com/go-to-k/cdkd/issues/1874)).
   *
   * `ResolverContext` carries no referencing logical id / attribute, and
   * threading one through this cross-cutting file for a message would be a
   * plumbing change out of proportion to the win. The value EXPRESSION is
   * already in hand, though, and for the shapes that actually reach the
   * refusal it is exactly what the user needs to find the site:
   *
   * - a list-valued `Fn::GetAtt` renders as `Fn::GetAtt [Zone, NameServers]`,
   *   naming both the resource and the attribute;
   * - a `Ref` to a LIST-TYPED parameter — any `List<...>` type or `CommaDelimitedList`, per the
   *   shared `isListParameterType` — the SECOND genuinely reachable array
   *   source, via `coerceParameterValue` — renders as `Ref MyListParam`,
   *   naming the parameter.
   *
   * Anything else degrades to its bare intrinsic key, or to `undefined` for a
   * literal (which the message then simply omits). `resolveSelect` borrows the
   * label for its index refusal (issue #3574); only `kind` is Split-specific.
   *
   * `kind` is not decoration: the caller uses it to pick the remedy, since the
   * `Fn::GetAtt` remedy (drop the `Fn::Split`, and the #1868 note for the
   * reader whose `Fn::Split` was that bug's workaround) is irrelevant and
   * confusing for a parameter reference or a hand-written literal.
   */
  private describeSplitValueSource(
    value: unknown
  ): { label: string; kind: 'getatt' | 'ref' | 'other' } | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length !== 1) return undefined;
    const key = keys[0] as string;
    // allow-template-keyed-bag-read: `key` came out of `Object.keys(value)` two
    // lines up, so it is an OWN key by construction.
    const args = (value as Record<string, unknown>)[key];

    if (key === 'Ref') {
      return typeof args === 'string'
        ? { label: `Ref ${args}`, kind: 'ref' }
        : { label: 'Ref', kind: 'ref' };
    }
    if (key !== 'Fn::GetAtt') {
      return key.startsWith('Fn::') ? { label: key, kind: 'other' } : undefined;
    }
    // Both CFn spellings: the `[logicalId, attribute]` list and the
    // `"logicalId.attribute"` string the shorthand YAML `!GetAtt` produces.
    if (Array.isArray(args)) {
      // The attribute name (arg 2) may itself be an intrinsic — CloudFormation
      // allows any string-valued expression there, and `resolveGetAtt` resolves
      // it — so an all-strings guard would drop the WHOLE label back to a bare
      // `Fn::GetAtt`, losing the logical id, which is the one piece of site
      // information the message has. Render each element instead, and never
      // interpolate an object directly: the default `String(...)` of one is
      // `[object Object]`, which names nothing.
      return {
        label: `Fn::GetAtt [${args.map((a) => this.renderGetAttArg(a)).join(', ')}]`,
        kind: 'getatt',
      };
    }
    if (typeof args === 'string') {
      // Split on the FIRST dot only. An attribute name may itself contain dots
      // (`Child.Outputs.Key` on a nested stack), and CloudFormation parses that
      // as `[Child, Outputs.Key]` — a naive split-on-every-dot renders a
      // three-element GetAtt that does not exist, which is worse than useless
      // in a message whose whole job is to name the site.
      //
      // This branch WAS unreachable end to end and its unit test pinned that
      // unreachability, on the note that it would red the day nested-path
      // `Fn::GetAtt` landed. It landed (issue #2270): `resolveGetAtt` now
      // splits the string spelling on the FIRST dot, so a 3+-segment
      // `Child.Outputs.Key` resolves and can reach `resolveSplit`'s refusal.
      // The rendering below was found already correct, and the test now drives
      // this branch through the live path instead of pinning the old throw.
      const dot = args.indexOf('.');
      const rendered = dot === -1 ? args : `${args.slice(0, dot)}, ${args.slice(dot + 1)}`;
      return { label: `Fn::GetAtt [${rendered}]`, kind: 'getatt' };
    }
    return { label: 'Fn::GetAtt', kind: 'getatt' };
  }

  /**
   * Resolve Fn::Split intrinsic function
   *
   * Fn::Split: [delimiter, string]
   * Splits a string into a list of strings using the specified delimiter
   *
   * A non-string value is REFUSED, and an ARRAY is refused with its own
   * message (issue [#1874](https://github.com/go-to-k/cdkd/issues/1874)).
   * Passing an array through unchanged was considered and rejected: real
   * CloudFormation rejects `Fn::Split` over a list too, so a template written
   * that way was never valid CFn. It only ever worked because cdkd resolved
   * `AWS::Route53::HostedZone.NameServers` to a comma-delimited STRING, which
   * was the defect PR #1868 fixed — so the post-upgrade failure is a correct
   * rejection of an invalid template, not a regression. Accepting the array
   * would let cdkd deploy templates that `cdkd export` /
   * `cdkd import --migrate-from-cloudformation` then cannot hand back to
   * CloudFormation, breaking the bidirectional-migration guarantee. What WAS
   * genuinely wrong is the message: `value must be a string, got object` names
   * neither the situation nor the remedy.
   *
   * Both refusals throw {@link IntrinsicResolutionRefusalError} rather than a
   * bare `Error`, matching the deliberate refusals already in this file. The
   * #1740 laundering path this class exists for is NOT reachable from here
   * today: `Fn::Sub`'s `${LogicalId.Attribute}` form cannot syntactically
   * contain an `Fn::Split`, and its 2-arg variable-map form resolves each
   * value through `resolveValue` OUTSIDE any catch, so either class would
   * propagate identically there. Using the class anyway keeps "deliberate
   * refusal" a property of the THROW rather than of the one catch that
   * happens to inspect it. It does NOT make the refusal un-launderable: this
   * file's own `evaluateConditions` catches everything per condition, warns,
   * and downgrades that condition to `false`, so an `Fn::Split`-over-a-list
   * inside a `Conditions` entry IS silently absorbed today — by both classes
   * alike, so the choice regresses nothing, but the class is not a guarantee
   * against a class-agnostic catch.
   *
   * Both are additionally `markNonRetryable` (issue #1838). The test is "can
   * this ever succeed on a retry" — an `Fn::Split` over an array never can —
   * NOT "does today's wording collide with a pattern", which is exactly the
   * criterion `retryable-errors.ts` documents as insufficient: the classifiers
   * match by SUBSTRING, and `sourceClause` interpolates template-controlled
   * text, so a logical id like `MyDependencyViolationHandler` puts
   * `DependencyViolation` (a whitespace-free entry in the table — the only
   * one until issue #2116 added the name-cooldown error codes) into the
   * message. Reachability is real even though resolution runs outside
   * `withRetry` on the flat path: `NestedStackProvider.create` runs a child
   * `DeployEngine.deploy()` and re-throws, and the parent wraps `create()` in
   * `withRetry` — so inside a nested stack each retry re-runs a full child
   * deploy plus rollback, up to the ~47s schedule, on a path that cannot
   * succeed. Marked at the THROW rather than in the constructor because the
   * class is retryable in general: its fabricated-account arm (see
   * `constructGuardedAttribute`) IS genuinely time-dependent
   * (`getAccountInfo` caches a fabricated answer for only 10s precisely so a
   * later attempt can heal), so a constructor-level marker would wrongly make
   * that one terminal too.
   */
  private async resolveSplit(
    splitArgs: [string, unknown],
    context: ResolverContext
  ): Promise<string[]> {
    const [delimiter, value] = splitArgs;

    // Resolve the value first
    const resolvedValue = await this.resolveValue(value, context);

    if (typeof resolvedValue !== 'string') {
      const source = this.describeSplitValueSource(value);
      // SANITIZED at the point the clause is BUILT (go-to-k/cdkd#3435 security
      // round 3, which measured it): `source.label` is `Ref <args>` /
      // `Fn::GetAtt [<arg>]` / a raw template key, all template-controlled, and
      // both throws below reach the user at any verbosity -- the same sink this
      // PR measured for `Resource <id> not found`. The three notes that used to
      // exempt it read "assembled from literals here", which is FALSE and is
      // contradicted by `describeSplitValueSource`'s own doc comment one method
      // up ("interpolates template-controlled text"). Wrapped once here rather
      // than at each throw, so a THIRD consumer of the clause inherits it.
      const sourceClause = source ? ` (from ${this.displayMasked(source.label, context)})` : '';
      if (Array.isArray(resolvedValue)) {
        // The remedy is per-source, and the DEFAULT is the neutral one. Only a
        // value that IS an Fn::GetAtt gets the Route 53 example and the #1868
        // note — that note is addressed to the reader whose Fn::Split was a
        // workaround for THAT attribute bug, so emitting it at a `Ref` to a
        // list-typed parameter, or at a literal array the user wrote
        // out by hand, only misdirects. A literal names nothing about itself,
        // so it takes the neutral text rather than the Fn::GetAtt one.
        const remedy =
          source?.kind === 'ref'
            ? `A list-typed parameter — any List<...> type (List<AWS::EC2::Subnet::Id>, ` +
              `List<Number>, …) or CommaDelimitedList — is already a list.`
            : source?.kind === 'getatt'
              ? `A list-valued Fn::GetAtt (for example ` +
                `AWS::Route53::HostedZone.NameServers or AWS::EC2::VPC.Ipv6CidrBlocks) ` +
                `already returns a list. If you wrote the Fn::Split as a workaround for ` +
                `cdkd resolving that attribute to a comma-delimited string, that bug is ` +
                `fixed (PR #1868) and the workaround is no longer needed.`
              : // Not an exhaustive list on purpose: the source clause above
                // already names the actual intrinsic, and several others reach
                // this arm (Fn::GetAZs, Fn::Cidr, a nested Fn::Split, an
                // Fn::If / Fn::FindInMap selecting a list).
                `Several intrinsics already return a list — among them a ` +
                `list-valued Fn::GetAtt, a Ref to a list-typed parameter (any ` +
                `List<...> type or CommaDelimitedList), Fn::GetAZs, Fn::Cidr, ` +
                `and Fn::Split itself.`;
        // `remedy` is a cdkd-authored sentence chosen by the arm above;
        // `sourceClause` is sanitized where it is built.
        throw markNonRetryable(
          new IntrinsicResolutionRefusalError(
            `Fn::Split: the value to split${sourceClause} is ALREADY a list ` +
              `(an array of ${resolvedValue.length} item${resolvedValue.length === 1 ? '' : 's'}), ` +
              `not a string. CloudFormation rejects Fn::Split over a list too, so this ` +
              `template is not valid CloudFormation either. Remove the Fn::Split and use ` +
              `the value directly. ${remedy}`
          )
        );
      }
      const got = resolvedValue === null ? 'null' : typeof resolvedValue;
      // `sourceClause` is sanitized where it is built.
      throw markNonRetryable(
        new IntrinsicResolutionRefusalError(
          `Fn::Split: the value to split${sourceClause} must be a string, got ${got}. ` +
            `Fn::Split accepts only a string; check the value or the intrinsic that ` +
            `produced it.`
        )
      );
    }

    const result = resolvedValue.split(delimiter);
    // go-to-k/cdkd#4049: a piece holding part of a LOG-ONLY needle (a `NoEcho`
    // parameter's value) becomes a log-only needle itself, recorded BEFORE the
    // debug line below so that line masks it, and into the pass's bag so the
    // provider's masker and the error / event masking do too. LOG-ONLY, so
    // nothing persisted moves. The print-only corpus's pieces go into that
    // corpus alone, as `resolveBase64` records its encodings.
    //
    // A context with no pass bag (an inherited-only one) records nothing it
    // could keep, so the pieces go into a bag of THIS call's own, read as a
    // print-only corpus by this call's line alone: it must not rely on some
    // earlier resolution having recorded them.
    let lineContext = context;
    if (this.hasLogOnlyNeedles(context)) {
      if (context.recordedSecretValues) {
        recordLogOnlySplitFragments(
          [context.inheritedSecrets, context.recordedSecretValues],
          context.recordedSecretValues,
          resolvedValue,
          String(delimiter)
        );
      } else {
        const linePieces: RecordedSecretValues = new Map();
        if (context.printingSecrets !== undefined) {
          carryLogOnlyValues(context.printingSecrets, linePieces);
        }
        recordLogOnlySplitFragments(
          [context.inheritedSecrets],
          linePieces,
          resolvedValue,
          String(delimiter)
        );
        lineContext = { ...context, printingSecrets: linePieces };
      }
    }
    if (context.printingSecrets !== undefined && hasLogOnlyValues(context.printingSecrets)) {
      recordLogOnlySplitFragments(
        [context.printingSecrets],
        context.printingSecrets,
        resolvedValue,
        String(delimiter)
      );
    }
    // Issue #3100: a piece of a string an earlier write masked keeps its part
    // of that mask, on this line and on an outer Join over the pieces.
    // An EMPTY delimiter splits into single characters, which no needle can
    // mask without every character becoming one (go-to-k/cdkd#4049): when the
    // value carries a masked needle, the line prints every piece as `***`.
    // (That covers this line only: an `Fn::Join` / `Fn::Sub` over the pieces
    // prints them character-spaced, a documented residual. Registering each
    // character as a log twin would close it, but a twin also feeds the
    // `Fn::Base64` persist detector, which would move state.)
    const pieceTwins =
      String(delimiter) === '' &&
      this.maskRenderedNeedlesForLog(resolvedValue, lineContext) !== resolvedValue
        ? result.map(() => SECRET_MASK)
        : this.splitLogTwins(resolvedValue, delimiter, result, context);
    this.logger.debug(
      // Leaf-masked before the encoding — see `resolveSelect`'s twin comment
      // (issue [#2759](https://github.com/go-to-k/cdkd/issues/2759)). The
      // delimiter through the builder (issue #3479): it is raw template text,
      // and a structural operand is still arbitrary JSON.
      `Resolved Fn::Split: split by ${this.splitDelimiterRender(String(delimiter), lineContext)} resolved to ${this.logRender(JSON.stringify(this.maskValueLeaves(pieceTwins, lineContext)), lineContext, { structured: true })}`
    );
    return result;
  }

  /**
   * Resolve Fn::If intrinsic function
   *
   * Fn::If: [conditionName, valueIfTrue, valueIfFalse]
   * Returns valueIfTrue if condition evaluates to true, otherwise valueIfFalse
   */
  private async resolveIf(
    ifArgs: [string, unknown, unknown],
    context: ResolverContext,
    source: object
  ): Promise<unknown> {
    const [conditionName, valueIfTrue, valueIfFalse] = ifArgs;
    // The `Fn::If` object answers for the branch it selected (issue #3306):
    // the nested-stack carry reads the record of the object the template
    // spells, and that is this one, not the branch. A STRING branch is
    // resolved by the dynamic-reference pass `resolveValue`'s string arm runs
    // on a reference-bearing string (on any other it returns the string, which
    // is what the pass returns there too), here so its replacements can be
    // recorded; an object branch lends its own record, when the pass kept one.
    const resolveBranch = async (branch: unknown): Promise<unknown> => {
      if (typeof branch === 'string') {
        const pass = await this.resolveDynamicReferencesWithLogTwin(branch, branch, context);
        this.recordLeafResolution(context, source, {
          input: branch,
          output: pass.result,
          substitutions: pass.substitutions,
          complete: pass.complete,
        });
        return pass.result;
      }
      const resolved = await this.resolveValue(branch, context);
      if (context.recordedSecretValues !== undefined) {
        recordIntrinsicLeafResolutionAs(context.recordedSecretValues, source, branch);
      }
      return resolved;
    };

    // Check if condition is evaluated in context. `Object.hasOwn` (issue
    // #2767): `conditionName` is template-controlled, so a bare `in` answered
    // for an `Object.prototype` member -- `Fn::If: ["constructor", A, B]`
    // skipped this warn, read the `Object` FUNCTION as the condition value, and
    // selected the TRUE branch, where the not-found path assumes false.
    if (!context.conditions || !Object.hasOwn(context.conditions, conditionName)) {
      // A DEFAULT-VERBOSITY warn naming a template-supplied condition name --
      // `Fn::If`'s first element, arbitrary JSON (go-to-k/cdkd#3435 review
      // round 2, found by driving the route rather than by reading).
      // `String(...)` FIRST. `resolveIf`'s arguments arrive through an
      // unchecked cast, so element 0 can be a number or an object; the old bare
      // interpolation coerced it, and `displayMasked` -> `stripControlChars`
      // calls `.replace` and would throw a TypeError instead -- turning a
      // warn-and-assume-false into a failed resource (go-to-k/cdkd#3435 review
      // round 3, measured). Coercing keeps the pre-existing behaviour and
      // sanitizes what it produces.
      this.logger.warn(
        `Condition ${this.displayMasked(String(conditionName), context)} not found in context, assuming false`
      );
      return await resolveBranch(valueIfFalse);
    }

    const conditionValue = context.conditions[conditionName];
    const selectedValue = conditionValue ? valueIfTrue : valueIfFalse;

    // `conditionValue` carries nothing: a boolean, or a list of booleans.
    this.logger.debug(
      `Resolved Fn::If: condition ${this.logRender(String(conditionName), context)} = ${conditionValue}, selected ${conditionValue ? 'true' : 'false'} branch`
    );

    return await resolveBranch(selectedValue);
  }

  /**
   * Resolve Fn::Equals intrinsic function
   *
   * Fn::Equals: [value1, value2]
   * Returns true if both values are equal after resolution
   */
  private async resolveEquals(
    equalsArgs: [unknown, unknown],
    context: ResolverContext
  ): Promise<boolean> {
    const [value1, value2] = equalsArgs;

    // Resolve both values
    const resolved1 = await this.resolveValue(value1, context);
    const resolved2 = await this.resolveValue(value2, context);

    // Deep equality check
    const result = JSON.stringify(resolved1) === JSON.stringify(resolved2);

    // Masked like every other operand-rendering site (`Fn::Select` / `Fn::Split`
    // / `Fn::Join` / `Fn::Sub`). An operand can be a resolved cross-stack value:
    // `cdkd scrub` gained a `stateBackend` on its CONDITION context in issue
    // #2133, so `{"Fn::Equals": [{"Fn::ImportValue": "..."}, "x"]}` now resolves
    // the producer's export -- and `reresolveCrossStackValue` hands back the
    // PLAINTEXT -- inside the command whose whole purpose is removing it.
    // not-in-class(result): a CONDITION verdict -- a boolean, or a list of booleans.
    this.logger.debug(
      // Leaf-masked before the encoding — see `resolveSelect`'s twin comment
      // (issue [#2759](https://github.com/go-to-k/cdkd/issues/2759)).
      `Resolved Fn::Equals: ${this.logRender(JSON.stringify(this.maskValueLeaves(resolved1, context)), context, { structured: true })} === ${this.logRender(JSON.stringify(this.maskValueLeaves(resolved2, context)), context, { structured: true })} resolved to ${result}`
    );

    return result;
  }

  /**
   * Resolve a `{Condition: <name>}` named-condition reference (issue #840).
   *
   * Inside `Fn::And` / `Fn::Or` / `Fn::Not` a CFn Condition may reference
   * another named condition. When the resolver is mid-`evaluateConditions`
   * the `conditionResolver` hook is present and lazily evaluates the
   * referenced condition (recursing + memoizing + cycle-guarding) so the
   * result is order-independent. Outside that context (which is invalid CFn
   * but handled defensively) we fall back to the already-evaluated
   * `conditions` map, matching `Fn::If`'s warn-and-assume-false behavior.
   */
  private async resolveConditionReference(
    conditionName: string,
    context: ResolverContext
  ): Promise<boolean> {
    if (context.conditionResolver) {
      return await context.conditionResolver(conditionName);
    }

    // `Object.hasOwn` for the same reason as `resolveIf`'s test (issue #2767) —
    // but DEFENSIVE, and known to be so: the only call site gates on
    // `context.conditionResolver` being present, and the branch above returns
    // for exactly that case, so nothing reaches this line today. It is left
    // correct rather than pinned, since a test for it would have to construct a
    // context the resolver never builds. Were it reachable, the bare `in` would
    // hand `Fn::And` / `Fn::Or` / `Fn::Not` the `Object` FUNCTION behind the
    // `boolean` assertion below, which hides the mismatch rather than reporting
    // it.
    if (context.conditions && Object.hasOwn(context.conditions, conditionName)) {
      return context.conditions[conditionName]!;
    }

    // The sibling of the `Fn::If` warn above, on the CONDITION-REFERENCE path,
    // and default-verbosity for the same reason.
    this.logger.warn(
      `Condition ${this.displayMasked(conditionName, context)} not found in context, assuming false`
    );
    return false;
  }

  /**
   * Resolve Fn::And intrinsic function
   *
   * Returns true if all conditions evaluate to true
   * Syntax: { "Fn::And": [ condition1, condition2, ... ] }
   */
  private async resolveAnd(conditions: unknown[], context: ResolverContext): Promise<boolean> {
    if (!Array.isArray(conditions) || conditions.length < 2 || conditions.length > 10) {
      throw new Error(`Fn::And requires between 2 and 10 conditions, got ${conditions.length}`);
    }

    // Resolve all conditions
    const results: boolean[] = [];
    for (const condition of conditions) {
      const resolved = await this.resolveValue(condition, context);
      results.push(Boolean(resolved));
    }

    // Return true if all are true
    const result = results.every((r) => r === true);

    // not-in-class(results.join(', ')): a CONDITION verdict -- a boolean, or a list of booleans.
    // not-in-class(result): a CONDITION verdict -- a boolean, or a list of booleans.
    this.logger.debug(`Resolved Fn::And: [${results.join(', ')}] resolved to ${result}`);

    return result;
  }

  /**
   * Resolve Fn::Or intrinsic function
   *
   * Returns true if at least one condition evaluates to true
   * Syntax: { "Fn::Or": [ condition1, condition2, ... ] }
   */
  private async resolveOr(conditions: unknown[], context: ResolverContext): Promise<boolean> {
    if (!Array.isArray(conditions) || conditions.length < 2 || conditions.length > 10) {
      throw new Error(`Fn::Or requires between 2 and 10 conditions, got ${conditions.length}`);
    }

    // Resolve all conditions
    const results: boolean[] = [];
    for (const condition of conditions) {
      const resolved = await this.resolveValue(condition, context);
      results.push(Boolean(resolved));
    }

    // Return true if at least one is true
    const result = results.some((r) => r === true);

    // not-in-class(results.join(', ')): a CONDITION verdict -- a boolean, or a list of booleans.
    // not-in-class(result): a CONDITION verdict -- a boolean, or a list of booleans.
    this.logger.debug(`Resolved Fn::Or: [${results.join(', ')}] resolved to ${result}`);

    return result;
  }

  /**
   * Resolve Fn::Not intrinsic function
   *
   * Returns the inverse of the condition
   * Syntax: { "Fn::Not": [ condition ] }
   */
  private async resolveNot(notArgs: [unknown], context: ResolverContext): Promise<boolean> {
    if (!Array.isArray(notArgs) || notArgs.length !== 1) {
      throw new Error(
        `Fn::Not requires exactly one condition, got ${Array.isArray(notArgs) ? notArgs.length : 0}`
      );
    }

    const [condition] = notArgs;

    // Resolve the condition
    const resolved = await this.resolveValue(condition, context);
    const result = !resolved;

    // not-in-class(Boolean(resolved)): a CONDITION verdict -- a boolean, or a list of booleans.
    // not-in-class(result): a CONDITION verdict -- a boolean, or a list of booleans.
    this.logger.debug(`Resolved Fn::Not: ${Boolean(resolved)} resolved to ${result}`);

    return result;
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

  /**
   * Resolve Fn::FindInMap intrinsic function
   *
   * Fn::FindInMap: [MapName, TopLevelKey, SecondLevelKey]
   * Fn::FindInMap: [MapName, TopLevelKey, SecondLevelKey, { DefaultValue: <value> }]
   * Looks up a value in the Mappings section of the template. When the optional
   * 4th argument supplies a `DefaultValue` and the requested top-level OR
   * second-level key is absent, CloudFormation returns the DefaultValue instead
   * of failing; cdkd mirrors that here. Without a DefaultValue the missing-key
   * cases throw (backward compatible).
   */
  private async resolveFindInMap(
    findInMapArgs: [unknown, unknown, unknown] | [unknown, unknown, unknown, unknown],
    context: ResolverContext
  ): Promise<unknown> {
    const [rawMapName, rawTopLevelKey, rawSecondLevelKey, rawOptions] = findInMapArgs;

    // Recursively resolve each argument (they could be Refs or other intrinsic functions)
    const mapName = String(await this.resolveValue(rawMapName, context));
    const topLevelKey = String(await this.resolveValue(rawTopLevelKey, context));
    const secondLevelKey = String(await this.resolveValue(rawSecondLevelKey, context));

    // Optional 4th argument: { DefaultValue: <value> }. The DefaultValue may
    // itself be an intrinsic, so resolve it lazily only when we need to fall
    // back to it. `hasDefaultValue` distinguishes "no 4th arg" from a 4th arg
    // whose DefaultValue is intentionally undefined/null.
    const hasDefaultValue =
      typeof rawOptions === 'object' &&
      rawOptions !== null &&
      !Array.isArray(rawOptions) &&
      'DefaultValue' in (rawOptions as Record<string, unknown>);
    const resolveDefault = (): Promise<unknown> =>
      this.resolveValue((rawOptions as Record<string, unknown>)['DefaultValue'], context);

    // Access the Mappings section of the template
    const mappings = context.template.Mappings;
    // `Object.hasOwn` on all three lookups below (issue #2767). Every one of
    // `mapName` / `topLevelKey` / `secondLevelKey` is template-controlled, and
    // mapping keys are FREE-FORM text rather than logical ids, so this is the
    // most reachable site of the class: `Fn::FindInMap: [M, K, "constructor"]`
    // returned the `Object` function as the resolved VALUE instead of throwing,
    // and a `__proto__` top-level key returned `Object.prototype`.
    // `!= null`, NOT `!== undefined`: the read this replaced was `mappings?.[…]`,
    // whose optional chain short-circuits on NULL as well, and `Object.hasOwn`
    // throws `Cannot convert undefined or null to object`. A YAML `Mappings:`
    // with an empty body parses to `null` and reaches here through
    // `cdkd import --migrate-from-cloudformation`, so the narrower test turned
    // the `DefaultValue` arm and the named refusal below into a raw `TypeError`.
    // The `!mappings` guard underneath is falsy-checked for exactly that reason.
    const map = (
      mappings != null && Object.hasOwn(mappings, mapName) ? mappings[mapName] : undefined
    ) as Record<string, Record<string, unknown>> | undefined;

    if (!mappings) {
      if (hasDefaultValue) {
        return await resolveDefault();
      }
      throw new Error(`Fn::FindInMap: no Mappings section found in template`);
    }

    if (!map) {
      if (hasDefaultValue) {
        return await resolveDefault();
      }
      // MASKED at the throw (issue
      // [#2827](https://github.com/go-to-k/cdkd/issues/2827)): all three
      // `Fn::FindInMap` arguments come back from `resolveValue`, so any of
      // them can be a decrypted secret an `Fn::Sub` assembled. Masked per RAW
      // value, which is what reaches the floorless whole-value arm.
      throw new Error(
        `Fn::FindInMap: mapping ${quotedRender(this.displayMasked(mapName, context), "'")} not found in Mappings section`
      );
    }

    const topLevel = Object.hasOwn(map, topLevelKey) ? map[topLevelKey] : undefined;
    if (!topLevel || typeof topLevel !== 'object') {
      if (hasDefaultValue) {
        return await resolveDefault();
      }
      throw new Error(
        `Fn::FindInMap: top-level key ${quotedRender(this.displayMasked(topLevelKey, context), "'")} ` +
          `not found in mapping ${quotedRender(this.displayMasked(mapName, context), "'")}`
      );
    }

    if (!Object.hasOwn(topLevel, secondLevelKey)) {
      if (hasDefaultValue) {
        return await resolveDefault();
      }
      throw new Error(
        `Fn::FindInMap: second-level key ${quotedRender(this.displayMasked(secondLevelKey, context), "'")} ` +
          `not found in mapping ${quotedRender(this.displayMasked(mapName, context), "'")} under ` +
          // `under`, not `->`: pasted, `->` is `-` plus a `>` redirect onto the
          // quoted top-level key, which `QUOTABLE_RENDER` admits as a path
          // (`../x`, go-to-k/cdkd#4100 review M1).
          `top-level key ${quotedRender(this.displayMasked(topLevelKey, context), "'")}`
      );
    }

    const result = topLevel[secondLevelKey];
    this.logger.debug(
      // MASKED like the three throws above (issue
      // [#2827](https://github.com/go-to-k/cdkd/issues/2827) review): all three
      // keys come back from `resolveValue`, and this is the SUCCESS path — the
      // common one — so leaving it bare printed at `--verbose` exactly the
      // values the neighbouring refusals mask. The mapped VALUE is leaf-masked
      // too: a mapping may legitimately hold a value assembled from a secret.
      `Resolved Fn::FindInMap: ${this.logRender(mapName, context)}.` +
        `${this.logRender(topLevelKey, context)}.` +
        `${this.logRender(secondLevelKey, context)} resolved to ` +
        `${this.logRender(JSON.stringify(this.maskValueLeaves(result, context)), context, { structured: true })}`
    );
    return result;
  }

  /**
   * Resolve Fn::Base64 intrinsic function
   *
   * Fn::Base64: valueToEncode
   * Returns the Base64 representation of the input string
   */
  private async resolveBase64(value: unknown, context: ResolverContext): Promise<string> {
    // Recursively resolve the value first (it could be another intrinsic function)
    const resolvedValue = await this.resolveValue(value, context);

    if (typeof resolvedValue !== 'string') {
      // Names the TYPE only, never the value — nothing to mask, and nothing to
      // widen. Left as-is deliberately while its two siblings that DO
      // interpolate a value (`Fn::GetAtt`'s attribute-name refusal,
      // `Fn::Cidr`'s `ipBlock`) gained `maskValueLeaves`.
      throw new Error(`Fn::Base64: value must resolve to a string, got ${typeof resolvedValue}`);
    }

    const result = Buffer.from(resolvedValue).toString('base64');

    // DERIVED NEEDLE (issue
    // [#2759](https://github.com/go-to-k/cdkd/issues/2759)). `Fn::Base64` over
    // a dynamic reference produces the secret in a trivially reversible
    // encoding, and every needle in the bag matches LITERALLY — so nothing
    // downstream can see it. The log line below masked the INPUT and printed
    // the OUTPUT in the same breath, and `resolveBase64` RETURNS `result`, so
    // the encoded secret reached `redactSecretsForState` and was persisted to
    // `state.json`, where one command decodes it (the GHSA-p5qg-v9gv-hc7w
    // class). Registering the TRANSFORMED value gives the existing masker
    // something to match, at the one site that still holds both forms.
    //
    // THE DETECTOR IS THE MASKER ITSELF — "did masking change the input?" —
    // rather than a `secrets.has(resolvedValue)` membership test, because the
    // input is often ASSEMBLED (`Fn::Sub` builds a UserData script around a
    // `{{resolve:...}}` reference), and base64 of a string that merely
    // CONTAINS a secret decodes back to that secret just as completely. TWO
    // maskers ask it, and each sees what the other cannot: the NEEDLE mask
    // catches a plaintext at or above {@link MIN_NEEDLE_LENGTH} wherever it
    // sits, and the POSITION mask (`logTextOfLeaf`, issue #3100) catches a
    // sub-floor plaintext an earlier write of this pass put into the input,
    // which the substring arm is blind to by design (issues #2516 / #2745).
    // Before the second asked (issue #3119), `port:` + a two-character
    // `secretValueFromJson('pin')` under `Fn::Base64` — the CDK UserData
    // shape — persisted its encoding to `state.json` in the clear while the
    // debug line beside it was already masked. The position twin is keyed by
    // the exact string a secret was written into, so a value it masks CARRIES
    // that secret's text, and registering its encoding is the same direction
    // the needle arm takes.
    //
    // THIS DECISION PERSISTS, and since issue #3114 it crosses the nested-stack
    // boundary: the position mask also reads the twins the PARENT registered
    // (`registeredLogTwin`), so in a CHILD this guard records the encoding into
    // the child's own bag and `***` lands in the child's `state.json` (a
    // rollback replay of that resource then refuses the masked baseline). The
    // log line below is not the only thing a change here affects.
    //
    // MASK-ONLY, not an expression pair. The whole point of an expression is
    // that a reader can re-resolve it, and re-resolving `{{resolve:...}}` here
    // would yield the PLAINTEXT rather than its base64 — a value AWS would
    // reject as UserData. `recordMaskOnlyValue` also refuses to demote a
    // plaintext that already carries a real expression, so registering the
    // encoding can never weaken the entry for the secret itself.
    //
    // Recorded BEFORE the debug line, which is what lets that line's NEEDLE
    // mask catch its right half; the line masks the right half whole on a
    // positioned input regardless, since the encoding decodes straight back
    // to the plaintext the input's mask hides.
    const inputLogText = this.logTextOfLeaf(resolvedValue, context);
    if (
      context.recordedSecretValues &&
      (inputLogText !== resolvedValue ||
        this.maskNeedlesForLog(resolvedValue, context) !== resolvedValue)
    ) {
      // DERIVED, so a leaf EMBEDDING the encoding is masked whole too
      // (go-to-k/cdkd#2453).
      recordDerivedMaskOnlyValue(context.recordedSecretValues, result);
      // The encoding of a FRESH `NoEcho` value is fresh too (go-to-k/cdkd#3662),
      // or a Base64 consumer of a re-minted token would be skipped as
      // `***` == `***`. The encoding of an ordinary secret is NOT: its record
      // already positions the reference, and marking it would update that
      // resource on every deploy.
      if (embedsFreshNoEchoValue(resolvedValue, context.recordedSecretValues)) {
        recordFreshNoEchoValuesIn(result, context.recordedSecretValues);
      }
    }
    // go-to-k/cdkd#1998: the encoding of text holding a LOG-ONLY needle (a
    // `NoEcho` parameter's value) decodes straight back to it, so it is a
    // log-only needle too. LOG-ONLY, deliberately, and outside the guard
    // above: that guard decides what is PERSISTED and must not see this class.
    if (
      context.recordedSecretValues &&
      this.hasLogOnlyNeedles(context) &&
      this.maskPrintedNeedlesForLog(resolvedValue, context) !==
        this.maskNeedlesForLog(resolvedValue, context)
    ) {
      recordLogOnlyValue(context.recordedSecretValues, result);
    }
    // The PRINT-ONLY twin (go-to-k/cdkd#4043): an encoding of text that only
    // the print-only corpus masks is recorded THERE, never into the pass's
    // bag, whose log-only needles decide an export alias.
    const printing = context.printingSecrets;
    if (
      printing !== undefined &&
      hasMaskableValues(printing) &&
      this.maskRenderedNeedlesForLog(resolvedValue, context) !==
        this.maskPrintedNeedlesForLog(resolvedValue, context)
    ) {
      recordLogOnlyValue(printing, result);
    }

    this.logger.debug(
      `Resolved Fn::Base64: ${this.logRender(inputLogText, context)} resolved to ${this.logRender(inputLogText !== resolvedValue ? SECRET_MASK : result, context)}`
    );
    return result;
  }

  /**
   * Resolve Fn::GetAZs intrinsic function
   *
   * Fn::GetAZs: region
   * Returns a list of availability zones for the specified region.
   * If region is empty string or {"Ref": "AWS::Region"}, uses the current region.
   * Results are cached per region to avoid repeated API calls.
   */
  private async resolveGetAZs(value: unknown, context: ResolverContext): Promise<string[]> {
    // Recursively resolve the value first (it could be a Ref or other intrinsic function)
    const resolvedValue = await this.resolveValue(value, context);

    let region: string;
    /**
     * Which region's clients answer the `DescribeAvailabilityZones` below.
     *
     * `DescribeAvailabilityZones` lists the AZs of the region the CLIENT is
     * pointed at; the `region-name` filter narrows that listing, it does not
     * widen it to another region. So a foreign-region client returns an EMPTY
     * list, which this method then caches and hands back as the resolved value
     * of `Fn::GetAZs` — silently, since an empty list is not an error here
     * (issue #1957).
     *
     * When the template names a region explicitly, THAT is the region to talk
     * to. Otherwise fall back to the resolver's own — but only when it was
     * given explicitly (see {@link explicitRegion}).
     */
    let clientRegion: string | undefined;
    // How `region` is printed (issue #3150): a template-supplied region takes
    // its raw value's log text; the account's own region has none.
    let loggedRegionText: string | undefined;
    if (typeof resolvedValue === 'string' && resolvedValue !== '') {
      // REFUSE a template-derived region that is not region-shaped, BEFORE it
      // can reach `clientsForRegion` (issue #1957 review).
      //
      // This argument is the only attacker-influenceable value in this class
      // that now selects an SDK ENDPOINT: it is template-derived and can arrive
      // through an `Fn::ImportValue` or a parameter, so it is not necessarily
      // written by whoever runs the deploy. Before dynamic-reference lookups
      // were bound to a region it only fed the `region-name` FILTER below and
      // could not build a client; binding made it reachable, so the gate ships
      // with the binding. The measured escape is `evil.example.com#`, which the
      // SSM endpoint ruleset turns into
      // `https://ssm.evil.example.com/#.amazonaws.com` — a SigV4-SIGNED request
      // (access key id + signature) to an attacker-controlled host.
      //
      // THROW rather than fall back to the resolver's own region. Substituting
      // a different region's AZ names would be a silent wrong answer that
      // propagates into subnet placement, which is worse than a stopped deploy;
      // and a template asking for the AZs of a non-region is a bug or an
      // attack, never something to paper over. `clientsForRegion` keeps its own
      // softer backstop for any FUTURE caller, but this path is the one that is
      // reachable today and it fails loudly.
      const requested = canonicalizeRegion(resolvedValue);
      if (!isClientSafeRegion(requested)) {
        // MASKED BEFORE THE TRANSFORM (issue
        // [#2827](https://github.com/go-to-k/cdkd/issues/2827)). `resolvedValue`
        // comes back from `resolveValue`, so an `Fn::Sub`-assembled region
        // position can BE a decrypted secret; masking the finished message
        // instead would be decorative, because `stripControlChars` and
        // `.slice(0, 64)` both rewrite the text a literal needle has to match
        // — a measured 80-character secret printed its first 64 characters at
        // default verbosity with the needle recorded and a boundary mask
        // applied. Masking the RAW value also reaches the whole-value arm,
        // which has no {@link MIN_NEEDLE_LENGTH} floor.
        throw new Error(
          // `the value` LEADS the clause: after `: ` a quoted value would be
          // the pasted clause's COMMAND, and `QUOTABLE_RENDER` admits a path
          // (`'/usr/bin/touch' is not …` runs touch; go-to-k/cdkd#4100 M2).
          `Fn::GetAZs: the value ${quotedRender(this.displayMasked(this.logTextOfLeaf(resolvedValue, context) !== resolvedValue ? SECRET_MASK : resolvedValue, context).slice(0, 64), "'")} is not a valid AWS ` +
            `region name. A region is substituted into the AWS service hostname, so cdkd will ` +
            `not build a client from it.`
        );
      }
      region = requested;
      clientRegion = requested;
      loggedRegionText = this.regionLogText(resolvedValue, context);
    } else {
      // Empty string or non-string: use current region
      const accountInfo = await getAccountInfo(this.resolverRegion);
      region = accountInfo.region;
      clientRegion = this.explicitRegion;
    }

    // Check cache. The key is read HERE, synchronously beside the
    // `clientsForRegion` selection below, and reused at the `set`, so the list is
    // filed under the identity whose client read it (issue #3660). Never log it.
    const azCacheKey = injectiveKey(credentialFingerprint(ambientCredentialConfig()), region);
    const cached = cachedAvailabilityZones.get(azCacheKey);
    if (cached) {
      // `region` masked for the reason the two throws below state: it has
      // cleared `isClientSafeRegion`, which a real plaintext can (issue #2827
      // review).
      this.logger.debug(
        `Resolved Fn::GetAZs from cache: ${this.logRender(loggedRegionText ?? region, context)} resolved to ${this.logRender(JSON.stringify(this.maskValueLeaves(cached, context)), context, { structured: true })}`
      );
      return cached;
    }

    // Call EC2 DescribeAvailabilityZones
    const ec2Client = this.clientsForRegion(
      clientRegion,
      loggedRegionText === undefined ? undefined : this.displayMasked(loggedRegionText, context)
    ).ec2;

    // The try wraps ONLY the call. The empty-list refusal below deliberately
    // sits outside it: inside, the catch would rewrap it into
    // `failed to describe ...: no availability zones returned ...` — a doubled
    // prefix, and a "failed to describe" on a call that SUCCEEDED.
    let azNames: string[];
    try {
      const response = await ec2Client.send(
        new DescribeAvailabilityZonesCommand({
          Filters: [
            {
              Name: 'region-name',
              Values: [region],
            },
            {
              Name: 'state',
              Values: ['available'],
            },
          ],
        })
      );

      azNames = (response.AvailabilityZones || [])
        .map((az) => az.ZoneName)
        .filter((name): name is string => name !== undefined)
        .sort();
    } catch (error) {
      // BOTH halves masked, and per raw value (issue
      // [#2827](https://github.com/go-to-k/cdkd/issues/2827)). `region` has
      // cleared `isClientSafeRegion`, which is only
      // `/^[a-z0-9][a-z0-9-]{0,30}$/` — a real plaintext passes it — and the
      // caught AWS message quotes the region back.
      //
      // The AWS text takes the region's POSITIONAL mask first (go-to-k/cdkd#3171):
      // the needle mask alone cannot see a sub-floor secret an `Fn::Sub`
      // assembled into the region, and the SDK quotes the region as SENT —
      // canonicalized, which is why the pair keys on `region` rather than on
      // the raw value `loggedRegionText` was derived from.
      const loggedRegion = this.displayMasked(loggedRegionText ?? region, context);
      const masks = this.namedRequestMasks([[region, loggedRegion]], context);
      throw new Error(
        `Fn::GetAZs: failed to describe availability zones for region ` +
          `${quotedRender(loggedRegion, "'")}: ` +
          `${masks.text(error instanceof Error ? error.message : String(error))}`
      );
    }

    // An EMPTY list is never a legitimate answer: every enabled AWS region has
    // at least one availability zone. It means the call was answered by the
    // wrong region's endpoint (the `region-name` filter narrows a listing, it
    // does not redirect one), or the region is opt-in and not enabled on this
    // account. Neither is a value to hand back — and it must certainly not be
    // CACHED, because `cachedAvailabilityZones` is module-global, so one
    // degenerate answer would be replayed as the resolved value of every later
    // `Fn::GetAZs` for that region and identity in the process (issue #1957
    // review).
    if (azNames.length === 0) {
      throw new Error(
        `Fn::GetAZs: no availability zones returned for region ` +
          `${quotedRender(this.displayMasked(loggedRegionText ?? region, context), "'")}. Either the region ` +
          `is not enabled on this account (opt-in regions must be enabled before use), or the ` +
          `request was answered by a different region's endpoint.`
      );
    }

    cachedAvailabilityZones.set(azCacheKey, azNames);
    this.logger.debug(
      `Resolved Fn::GetAZs: ${this.logRender(loggedRegionText ?? region, context)} resolved to ${this.logRender(JSON.stringify(this.maskValueLeaves(azNames, context)), context, { structured: true })}`
    );
    return azNames;
  }

  /**
   * Resolve pseudo parameters
   *
   * Pseudo parameters are built-in CloudFormation references like AWS::Region
   */
  private async resolvePseudoParameter(
    name: string,
    context?: ResolverContext
  ): Promise<string | string[] | symbol | undefined> {
    switch (name) {
      case 'AWS::Region': {
        const accountInfo = await getAccountInfo(this.resolverRegion);
        return accountInfo.region;
      }

      case 'AWS::AccountId': {
        const accountInfo = await getAccountInfo(this.resolverRegion);
        return accountInfo.accountId;
      }

      case 'AWS::Partition': {
        const accountInfo = await getAccountInfo(this.resolverRegion);
        return accountInfo.partition;
      }

      case 'AWS::StackName':
        return context?.stackName ?? 'UnknownStack';

      case 'AWS::StackId': {
        // cdkd doesn't use CloudFormation stacks, generate a synthetic ID.
        // The partition is derived, not hardcoded (issue #1730 review) — this
        // is the same defect class as `getAccountInfo`'s own field, one site
        // over, and `arn:aws:` is wrong in every non-commercial partition.
        // The REGION segment is folded for the same reason (issue #1850). This
        // site is in `resolvePseudoParameter` rather than `constructAttribute`,
        // so it does NOT inherit that method's destructure-level fold — worth
        // stating, because the fold's own comment calls itself exhaustive and
        // that is true only WITHIN `constructAttribute`.
        const info = await getAccountInfo(this.resolverRegion);
        return `arn:${info.partition}:cloudformation:${canonicalizeRegion(info.region)}:${info.accountId}:stack/${context?.stackName ?? 'UnknownStack'}/cdkd`;
      }

      case 'AWS::URLSuffix':
        // Derived rather than hardcoded (issue #1730 review): `amazonaws.com.cn`
        // in `aws-cn`, and CloudFormation resolves `${AWS::URLSuffix}` through
        // exactly this mapping. Deliberately NO `getAccountInfo` hop, unlike
        // `AWS::Partition` / `AWS::StackId` which need the account: the suffix is
        // a pure function of the region. The round trip could only add latency
        // and, on an STS outage, a warning.
        //
        // An earlier revision justified that by saying `resolverRegion` is what
        // `getAccountInfo(this.resolverRegion)` "would have set `region` to
        // anyway". That stopped being true when issue #1882 folded
        // `effectiveAccountInfoRegion`: for a mis-cased `resolverRegion` the
        // two now differ in case. The OUTPUT is unaffected, because
        // `derivePartitionAndUrlSuffix` canonicalizes its own input (issue
        // #1795) -- which is the whole reason the skipped hop is still safe --
        // but the stated reason had to change with it.
        return derivePartitionAndUrlSuffix(this.resolverRegion).urlSuffix;

      case 'AWS::NotificationARNs':
        // cdkd has no stack-notification-ARN concept — a cdkd deploy never
        // sets SNS notification ARNs on a stack — so the list is always
        // empty. Returned as an EMPTY LIST, as CloudFormation resolves it (issue #3809): an
        // `Fn::Join` over it renders '' there, and inside `Fn::Sub` it is
        // rejected as a list, which `resolveSub` mirrors. It used to be '',
        // on which `Fn::Join` failed with "resolved to string".
        return [];

      case 'AWS::NoValue':
        // Return special symbol to indicate property should be omitted
        return AWS_NO_VALUE;

      default:
        return undefined;
    }
  }

  /**
   * Resolve CloudFormation Dynamic References in a string value
   *
   * Supports:
   * - {{resolve:secretsmanager:SECRET_ID:SecretString:JSON_KEY:VERSION_STAGE:VERSION_ID}}
   * - {{resolve:ssm:PARAMETER_NAME}}
   *
   * Results are cached to avoid repeated API calls.
   */
  /**
   * The SECRET answer alone: mask any resolved secret value out of `text`,
   * using the secrets recorded on the resolution pass (GHSA fix). No-op when
   * the pass recorded no secrets.
   *
   * ## NOT a display form, and the name says so
   *
   * This was `maskSecretsForLog` until go-to-k/cdkd#3426, and the name was the
   * defect. It answers "does this text contain a recorded secret" and makes no
   * claim about CONTROL CHARACTERS — but it read as "the spelling a log line
   * takes", so TEN local bindings took its result and interpolated it later,
   * one of them reaching an `Fn::ImportValue` warn and throw with a live
   * `ESC[2K` + CR from a template-supplied export name (measured on this tree,
   * at DEFAULT verbosity, on the DEFAULT path). Renaming it is what makes the
   * hazard visible at the BINDING rather than at the render: `const x =
   * this.maskSecretsRaw(...)` states that more work is owed.
   *
   * Reachable from ONE place, {@link maskThenStripThenMask}, which is itself
   * reachable only from {@link displayMasked}. That containment is the whole
   * mechanism. It used to be enforced by an AST walk that resolved an
   * interpolated identifier to its declaration; go-to-k/cdkd#3435 deleted that
   * checker, and what holds the containment now is
   * `tests/unit/deployment/resolver-display-masked-population.test.ts`, which
   * asserts the exact reference COUNTS from the AST (one caller each) and
   * refuses a direct `${this.<raw masker>(...)}` interpolation by line rule.
   * Do not call this from a new site: a binding of it interpolated LATER is
   * the shape neither survivor can see.
   *
   * ## What the masking itself does
   *
   * A value with a registered LOG TWIN prints as its twin first (issue
   * [#3150](https://github.com/go-to-k/cdkd/issues/3150)). The needle mask
   * matches a secret under {@link MIN_NEEDLE_LENGTH} only as the whole text,
   * so a name an `Fn::Sub` assembled around a 1-3 character secret (a map key,
   * a stack or output name, an attribute name, the secret id of a dynamic
   * reference) printed in the clear at every site that handed its RAW value
   * here, although the pass had registered where the secret sits. Looking the
   * twin up HERE, rather than at each such site, is what makes the class
   * closed for raw values: every one of those sites already reaches this
   * method through the builder.
   * The twin prints as it is: it is the raw text with masked spans, so it
   * holds no recorded needle the raw text lacks. When the needle mask ALSO
   * changes the raw text the whole text is masked instead, the rule
   * `logTwinText` applies to a Join / Sub line, since the two masks' spans
   * cannot be merged. What this cannot see is a value TRANSFORMED before it
   * arrives (a lowercased region, a sliced output name, an assembled
   * sentence); those sites derive their text from the twin themselves.
   *
   * ## The SELF-COMPARISON, and why it did not block the strip
   *
   * The line below compares `maskNeedlesForLog(text) !== text` — the NEEDLE
   * mask, not this method's own result — so making the RENDER path strip
   * changes no comparison anywhere. An earlier revision of `displayMasked`'s
   * comment said stripping could not move inside "the masker" because its
   * result is also a comparison; that was a claim about this expression, and
   * the expression's operand is a different function. The measurement that
   * settled it: every one of this method's 20 escaping call sites rendered
   * into a log line, a throw, or a `display:` field that becomes one — none
   * compared, persisted or re-parsed the result — so the render path could
   * take the strip whole.
   */
  private maskSecretsRaw(text: string, context?: ResolverContext): string {
    const registered = this.registeredLogTwin(text, context);
    const needled = this.maskNeedlesForLog(text, context);
    // go-to-k/cdkd#1998: the LOG-ONLY needles join here, at the render, and
    // nowhere upstream of it. When they change nothing this is the recorded
    // answer byte for byte. When they do and no twin is registered, the
    // printing mask is the answer; with a twin, its spans cannot be merged
    // with the log-only ones, so the whole text is masked — the rule the two
    // lines below already apply to the recorded needles.
    if (this.hasLogOnlyNeedles(context) || hasMaskableValues(context?.printingSecrets)) {
      const printed = this.maskRenderedNeedlesForLog(text, context);
      if (printed !== needled) return registered === undefined ? printed : SECRET_MASK;
    }
    if (registered === undefined) return needled;
    return needled !== text ? SECRET_MASK : registered;
  }

  /**
   * Build one {@link AbandonedResolution}, masking BOTH of its text fields.
   *
   * One constructor for both walks so neither can grow a second masking rule:
   * `subject` and `message` are the only fields a consumer may render, and each
   * carries its own route to a plaintext — an assembled reference puts one in
   * the raw token (issue #2827), and an SDK rejection echoes the `Name` it was
   * handed — which `sendWithThrottleRetry` now masks by position before it
   * rethrows (go-to-k/cdkd#3171), so this is the second layer on that route.
   * `error` is not re-masked here and is documented as classification-only.
   */
  /** @internal */
  abandonedUnit(
    unit: AbandonedResolution['unit'],
    subject: string,
    error: unknown,
    context: ResolverContext | undefined,
    rawInput: unknown,
    /**
     * Applied to {@link AbandonedResolution.message} BEFORE the needle mask.
     *
     * `subject` is twin-derived, so it is safe at any length. `message` is not:
     * it comes from the thrown error, which for an SDK rejection echoes the
     * NAME it was handed, and the needle mask alone has a `MIN_NEEDLE_LENGTH`
     * floor. Measured: an assembled reference whose variable resolves to a
     * SUB-FLOOR secret came back as `Parameter /deleted/pw1 not found.` in the
     * clear, out of the field this interface documents as masked. The token
     * loop passes a redactor that maps each raw reference segment through
     * `nameLogText`, which is twin-derived and therefore floor-free.
     */
    preRedact?: (text: string) => string
  ): AbandonedResolution {
    const raw = error instanceof Error ? error.message : String(error);
    return {
      unit,
      subject: this.displayMasked(subject, context),
      message: this.displayMasked(preRedact === undefined ? raw : preRedact(raw), context),
      error,
      carriedDynamicReference: carriesDynamicReference(rawInput),
      carriedFetchableReference: carriesFetchableDynamicReference(rawInput),
    };
  }

  /**
   * The needle mask alone: {@link maskSecretsRaw} without the log-twin
   * lookup. For the two DETECTORS that must ask the needle mask apart from the
   * position mask: `logTwinText`, which asks it of a value that already has a
   * twin, and `resolveBase64`, whose other operand is the position mask. A
   * message masks through `displayMasked`.
   */
  private maskNeedlesForLog(text: string, context?: ResolverContext): string {
    let masked = text;
    // BOTH BAGS, and the inherited one FIRST (issue #1903 review round 2). A
    // nested-stack CHILD engine is the only place `context.parameters` holds
    // DECRYPTED plaintext — the PARENT resolved the child's `Parameters` block
    // — and that plaintext is not in `recordedSecretValues` until some
    // resource's `{Ref: <Param>}` actually resolves and
    // `recordInheritedParameterSecrets` copies the pair across. Every log line
    // emitted BEFORE that moment (the two parameter lines, and any line the
    // child's own resolution reaches first) therefore had nothing to mask
    // against and printed the secret at `--verbose`.
    //
    // Masking against the inherited bag is never a widening: its keys are pairs
    // the parent PROVED secret, so anything it masks is a value that must not
    // be echoed regardless of which resource is being resolved.
    //
    // The RECORDED needles only (go-to-k/cdkd#1998): this answer is also a
    // DETECTOR — `resolveBase64` records what it persists from it, the
    // unsupported-service arm refuses on it, and the log-twin machinery that
    // `Fn::Base64` reads is built from it — so a log-only needle must not move
    // it. The render adds the log-only needles in {@link maskSecretsRaw}.
    //
    // ONE pass over both bags' entries (go-to-k/cdkd#4049): masked bag by bag,
    // the inherited bag's shorter needle cut a longer needle the pass bag held
    // and the rest of it printed. Whether the text CHANGES is the same either
    // way, so the detectors reading this answer are unaffected.
    const union: RecordedSecretValues = new Map([
      ...(context?.inheritedSecrets ?? []),
      ...(context?.recordedSecretValues ?? []),
    ]);
    if (union.size > 0) masked = maskRecordedSecretsInText(masked, union);
    return masked;
  }

  /**
   * Does either bag hold a LOG-ONLY needle (go-to-k/cdkd#1998)? The cheap
   * test that lets a print skip {@link maskPrintedNeedlesForLog} in the
   * common case, where there is none.
   */
  private hasLogOnlyNeedles(context?: ResolverContext): boolean {
    return (
      hasLogOnlyValues(context?.inheritedSecrets) || hasLogOnlyValues(context?.recordedSecretValues)
    );
  }

  /**
   * The PRINTING mask: {@link maskNeedlesForLog} plus the pass's LOG-ONLY
   * needles (go-to-k/cdkd#1998), both bags in the same order, each in ONE
   * regex so a longer needle of either class wins over a shorter one it
   * overlaps. Never a detector: see {@link maskNeedlesForLog}.
   */
  private maskPrintedNeedlesForLog(text: string, context?: ResolverContext): string {
    return this.maskNeedlesOfBags(text, context);
  }

  /**
   * {@link maskPrintedNeedlesForLog} plus {@link ResolverContext.printingSecrets}:
   * the RENDER mask only (go-to-k/cdkd#4043), never a detector.
   */
  private maskRenderedNeedlesForLog(text: string, context?: ResolverContext): string {
    return this.maskNeedlesOfBags(text, context, context?.printingSecrets);
  }

  private maskNeedlesOfBags(
    text: string,
    context?: ResolverContext,
    printing?: RecordedSecretValues
  ): string {
    // ONE pass over both bags (go-to-k/cdkd#4049), as {@link maskNeedlesForLog}.
    const union = unionOfSecretBags([
      context?.inheritedSecrets,
      context?.recordedSecretValues,
      printing,
    ]);
    return hasMaskableValues(union) ? maskSecretsInText(text, union) : text;
  }

  /**
   * Is `value` WHOLE a secret either bag holds (issue #3100)? Asked of a
   * resolution PRODUCT only — never of a template literal — so an exact match
   * at any length is a verdict about what was written, not a floorless needle.
   */
  private isRecordedSecretForLog(value: string, context?: ResolverContext): boolean {
    // No `''` guard: no writer records an empty plaintext (every recording
    // site requires a truthy value), so `has('')` already answers false.
    return (
      context?.recordedSecretValues?.has(value) === true ||
      context?.inheritedSecrets?.has(value) === true
    );
  }

  /**
   * The text a `Resolved Fn::Join:` / `Resolved Fn::Sub:` line prints (issue
   * #3100): the twin through the needle mask — unless the needle mask ALSO
   * fires on the value itself, in which case the whole line is masked. The
   * twin splits the text at the spans it masked, so a 4+ character recorded
   * secret that overlaps one of them (or IS the whole value) is no longer a
   * contiguous needle in the twin, and masking the twin alone would print the
   * part of it outside the span. The value's own needle mask cannot be merged
   * with the twin's positions, so the line gives both up for `***`: never
   * more text than either mask alone would print. Returns the text BEFORE the
   * needle mask; each log line wraps it in `displayMasked` itself, so the
   * sanitization happens at the render rather than here.
   */
  private logTwinText(result: string, twin: string, context?: ResolverContext): string {
    const bothMasksFire = twin !== result && this.maskNeedlesForLog(result, context) !== result;
    return bothMasksFire ? SECRET_MASK : twin;
  }

  /**
   * The log twins of `Fn::Split`'s pieces (issue #3100), each registered for
   * the pass so an outer `Fn::Join` over the pieces keeps the mask. A source
   * that is itself a recorded or inherited secret counts as a twin of `***`;
   * a source with neither is its pieces' own twin.
   *
   * The source's twin is split by the same delimiter. When both splits give
   * the same number of pieces they are paired by position; when they do not —
   * a secret carrying the delimiter, or a delimiter that occurs in the mask
   * itself — no pairing can be trusted, so every piece is masked whole. Every
   * masked piece is registered by VALUE, so an equal string elsewhere in the
   * pass is masked too: the over-masking direction `logTwinOfProduct` accepts.
   */
  private splitLogTwins(
    value: string,
    delimiter: string,
    pieces: string[],
    context: ResolverContext
  ): string[] {
    // A source that IS a recorded or inherited secret is masked whole even
    // with no registered twin — a `Ref` to a parameter holding one is never
    // registered, since no substitution in this pass wrote it.
    const sourceTwin = this.isRecordedSecretForLog(value, context)
      ? SECRET_MASK
      : this.registeredLogTwin(value, context);
    if (sourceTwin === undefined) return pieces;
    const twinPieces = sourceTwin.split(delimiter);
    // A delimiter that occurs in the mask itself splits `***` into pieces that
    // can coincide in COUNT with the value's while pairing nothing, so the
    // count test alone is not enough.
    const aligned = twinPieces.length === pieces.length && !SECRET_MASK.includes(delimiter);
    return pieces.map((piece, index) => {
      // Through `logTwinText`, like the Join / Sub lines: a piece's twin can
      // split a 4+ character secret the piece still holds whole.
      const twin = this.logTwinText(
        piece,
        aligned ? (twinPieces[index] ?? SECRET_MASK) : SECRET_MASK,
        context
      );
      this.rememberLogTwin(context, piece, twin);
      return twin;
    });
  }

  /**
   * The log twin of a resolution product as `String(value)` renders it (issue
   * #3100). A LIST is stringified element by element exactly as
   * `Array.prototype.join` does (`null` / `undefined` as the empty string,
   * nested lists recursively, comma-separated), so each element keeps its own
   * twin: `String()` over the whole list produced a string no registered twin
   * matched. No cycle guard: a product is JSON-sourced state or a fresh
   * resolution result, and neither can hold a self-referencing list.
   */
  private productLogTwin(value: unknown, context: ResolverContext): string {
    if (Array.isArray(value)) {
      return value
        .map((element: unknown) =>
          element === null || element === undefined ? '' : this.productLogTwin(element, context)
        )
        .join(',');
    }
    const text = String(value);
    return this.logTwinOfProduct({ result: text, twin: text }, context).twin;
  }

  /**
   * The pre-mask log text of a string LEAF a debug line prints (issue #3100):
   * the leaf treated as a resolution product — masked whole when it is a
   * recorded secret, otherwise the masked twin this pass registered for it —
   * and then `logTwinText`'s whole-line guard. The caller still wraps the
   * result in `displayMasked`. Used where the text is needed BEFORE that
   * masker, or apart from it: the `Fn::Base64` line and its detector, and the
   * names issue [#3150](https://github.com/go-to-k/cdkd/issues/3150)
   * transforms or composes before printing (`regionLogText`,
   * `outputNameLogText`, the invalid-region refusals, the cross-stack `origin`
   * strings). A leaf printed as it is needs none of it: `displayMasked`
   * looks the twin up itself, which is how `maskValueLeaves` gives its lines
   * and the THROWN messages it masks (the `Fn::Cidr` argument refusals, for
   * one) the same position mask.
   */
  /** @internal */
  logTextOfLeaf(value: string, context?: ResolverContext): string {
    return this.logTwinText(
      value,
      this.logTwinOfProduct({ result: value, twin: value }, context).twin,
      context
    );
  }

  /**
   * The log text of a nested stack's OUTPUT name, the part of `attributeName`
   * after `Outputs.` (issue [#3150](https://github.com/go-to-k/cdkd/issues/3150)).
   * The twin registry is keyed by the exact string, so the suffix has no twin
   * of its own: it is sliced from the twin of the WHOLE attribute name. A twin
   * that no longer starts with the literal prefix has a mask over part of it
   * (a secret was written into the prefix), so the slice offset no longer
   * lines up and the suffix prints as `***`.
   */
  /** @internal */
  outputNameLogText(attributeName: string, context?: ResolverContext): string {
    const twin = this.logTextOfLeaf(attributeName, context);
    return twin.startsWith(NESTED_STACK_OUTPUT_ATTRIBUTE_PREFIX)
      ? twin.slice(NESTED_STACK_OUTPUT_ATTRIBUTE_PREFIX.length)
      : SECRET_MASK;
  }

  /**
   * The log text of a template-supplied REGION as the resolver uses it, i.e.
   * after `canonicalizeRegion` (issue #3150). The twin is taken from the RAW
   * value, the string a write registered, and lowercased the same way: a
   * lookup of the canonical form finds no twin once the raw value had an
   * upper-case part, and lowercasing leaves every `***` span where it was.
   */
  /** @internal */
  regionLogText(rawRegion: string, context?: ResolverContext): string {
    const canonical = canonicalizeRegion(rawRegion);
    const text = canonicalizeRegion(this.logTextOfLeaf(rawRegion, context));
    // Lowercasing can FORM a recorded needle the raw value's case hid, and it
    // may overlap a masked span, where masking the twin cannot see it: the
    // whole region is masked then, the rule `logTwinText` applies.
    return text !== canonical && this.maskNeedlesForLog(canonical, context) !== canonical
      ? SECRET_MASK
      : text;
  }

  /**
   * Whether the dynamic-reference token `fullMatch` was ASSEMBLED from a
   * secret (issue #2743): its log text differs from the token, so a
   * twin mask sits inside it (floor-free, which is how a substituted secret of
   * any length shows), or the needle mask changes the raw token (a recorded
   * plaintext of four or more characters sits in it with no twin, which is
   * how a `Ref` to a parameter a parent decrypted shows). A sub-floor secret
   * that merely coincides with the token's literal text trips neither.
   */
  /** @internal */
  tokenAssembledFromSecret(
    fullMatch: string,
    tokenLogText: string,
    context: ResolverContext | undefined
  ): boolean {
    return tokenLogText !== fullMatch || this.maskNeedlesForLog(fullMatch, context) !== fullMatch;
  }

  /**
   * The issue #4166 variant of {@link tokenAssembledFromSecret}: the twin half
   * as is, the needle half against `inheritedSecrets` ONLY. That half exists
   * for a `Ref` to a parameter a parent decrypted, which leaves no twin mask;
   * a secret substituted within this pass leaves one. The pass's own bag is
   * left out because it holds every secret this resource already resolved,
   * and one that merely coincides with a LITERAL token's text (`DB_USER`'s
   * `myapp` inside `DB_PASSWORD`'s secret id) discloses nothing, so refusing
   * on it would fail a template by property order alone.
   */
  /** @internal */
  tokenAssembledForRecording(
    fullMatch: string,
    tokenLogText: string,
    context: ResolverContext | undefined
  ): boolean {
    if (tokenLogText !== fullMatch) return true;
    const inherited = context?.inheritedSecrets;
    return (
      inherited !== undefined &&
      inherited.size > 0 &&
      maskRecordedSecretsInText(fullMatch, inherited) !== fullMatch
    );
  }

  /**
   * Refuse a SECRET result of a resolvable token ASSEMBLED from a secret
   * (issue #4166): `{{resolve:ssm:/app/${Name}}}` with `Name` a secret, where
   * `/app/<Name>` is a `SecureString`. Recording that result would make the
   * assembled token the expression of its plaintext, and every state writer
   * (the frame, skeleton, whole-value and substring arms) then puts that
   * expression, with the other secret inside it, into `state.json`. A writer
   * that refused the expression would leave the token's plaintext in the
   * clear instead, so the refusal belongs here, before anything is recorded
   * or cached.
   *
   * "Assembled" is {@link tokenAssembledForRecording}: a twin mask in the
   * token, or a secret a parent passed in. A secret this pass resolved that
   * merely coincides with a literal token's text is not counted.
   *
   * Called once the token is known to resolve to a secret: before the lookup
   * for `secretsmanager` / `ssm-secure`, secret by spelling (issue #4266), and
   * after it for `ssm`, whose failed lookup keeps its own masked error and
   * whose public result records no expression.
   * The caller exempts persisted text (`cdkd drift`, the rollback replay), as
   * the unsupported-service arm does (issue #2743).
   */
  /** @internal */
  refuseSecretAssembledReference(
    fullMatch: string,
    tokenLogText: string,
    context: ResolverContext | undefined
  ): void {
    if (!this.tokenAssembledForRecording(fullMatch, tokenLogText, context)) return;
    throw markNonRetryable(
      new IntrinsicResolutionRefusalError(
        `Refusing to resolve ${this.displayMasked(tokenLogText, context)}: the reference was ` +
          `assembled from a secret value and resolves to a secret, so recording it would write ` +
          `that value into state inside the reference. Build the reference name from non-secret values.`
      )
    );
  }

  /**
   * The log text of a name or token whose `twin` masks spans of `raw` (issue
   * [#3150](https://github.com/go-to-k/cdkd/issues/3150)). The twin prints
   * unless the needle mask ALSO changes `raw`; then the two must agree. When
   * the needle-masked `raw` IS the twin, both masked the same spans and the
   * twin is safe (`/probe/***` for a 4+ character secret the name holds
   * whole). When they differ, a recorded secret straddles a masked span
   * (`q7ab` across `id-***ab`), no text can honour both, and the name prints
   * as `***`. Coarser `logTwinText` gives up whenever both masks fire.
   */
  /** @internal */
  straddleSafeTwin(raw: string, twin: string, context?: ResolverContext): string {
    if (twin === raw) return twin;
    const needled = this.maskNeedlesForLog(raw, context);
    if (needled === raw) return twin;
    return needled === twin ? twin : SECRET_MASK;
  }

  /**
   * The log text of a name parsed out of a dynamic-reference token (issue
   * [#3150](https://github.com/go-to-k/cdkd/issues/3150)). `resolveSub` /
   * `resolveJoin` re-enter the dynamic-reference loop with the ASSEMBLED string
   * and its twin, so a secret id, JSON key, version stage or id, SSM parameter
   * name, service or ARN region assembled around a short secret has its masked
   * spelling in `tokenTwin` only. Every such name is a run of the token's
   * `:`-separated pieces, so its log text is the twin's run over the same
   * pieces. Nothing is registered: the pass's log-twin registry also decides
   * what `Fn::Base64` persists, so the mapping lives in the returned function.
   *
   * `tokenTwin` is the twin's own `{{resolve:...}}` token paired with this one.
   * Each run's text goes through `straddleSafeTwin`, so a name whose needle
   * mask disagrees with its twin prints as `***`. A name whose runs carry different
   * twins, or a token whose pieces do not pair with the twin's (a mask
   * covering a `:`), prints as `***` too.
   *
   * A name that is no run of the token is a default the caller synthesized
   * (`AWSCURRENT` for an empty version stage, `''` for an absent version id),
   * printed as it is. Should the token spell such a non-empty name inside a longer
   * piece, it prints as `***`: the run rule says nothing about that text.
   */
  /** @internal */
  dynamicReferenceNameLogText(
    inner: string,
    tokenTwin: string,
    context?: ResolverContext
  ): (name: string) => string {
    const twinPieces = tokenTwin.slice('{{resolve:'.length, -'}}'.length).split(':');
    const pieces = inner.split(':');
    if (twinPieces.length !== pieces.length) return () => SECRET_MASK;
    return (name) => {
      let text: string | undefined;
      for (let start = 0; start < pieces.length; start++) {
        for (let end = start + 1; end <= pieces.length; end++) {
          if (pieces.slice(start, end).join(':') !== name) continue;
          // Through `straddleSafeTwin`: a 4+ character recorded secret that
          // overlaps a masked span is split in the twin, and only the raw
          // name's needle mask can still see it.
          const twin = this.straddleSafeTwin(name, twinPieces.slice(start, end).join(':'), context);
          if (text !== undefined && text !== twin) return SECRET_MASK;
          text = twin;
          // A longer run from the same start is a longer string.
          break;
        }
      }
      return text ?? (name !== '' && inner.includes(name) ? SECRET_MASK : name);
    };
  }

  /** The bag a pass's log twins are keyed by (issue #3100): the recorded one, else the inherited one. */
  private logTwinBag(context?: ResolverContext): RecordedSecretValues | undefined {
    return context?.recordedSecretValues ?? context?.inheritedSecrets;
  }

  /**
   * The masked twin registered for `value`, looked up under the pass's OWN bag
   * and under the INHERITED one (issue
   * [#3114](https://github.com/go-to-k/cdkd/issues/3114)). A nested-stack
   * child receives, as `inheritedSecrets`, the very object its parent resolved
   * the `AWS::CloudFormation::Stack` resource with: the deploy engine binds the
   * resource context's `recordedSecretValues` as the resource's secrets, and
   * `NestedStackProvider` hands that binding to the child. So a parameter value
   * the parent built around a short secret (`port:q7` -> `port:***`) is
   * registered under the child's inherited bag, while the child registers its
   * own writes under its own bag. Two DIFFERENT registered twins mask the
   * whole string, the rule `rememberLogTwin` applies within one bag. Lookups
   * only: `rememberLogTwin` still registers under `logTwinBag`, the context's
   * own `recordedSecretValues` whenever it carries one (every context
   * `buildResolverContext` returns does; the log-only context
   * `resolveParameters` builds carries none, and nothing on that path
   * registers), so such a child never writes into its parent's registry. A
   * context with ONLY an inherited bag registers into that bag, as it did
   * before this lookup existed.
   *
   * ONE LEVEL ONLY. The bag a child hands its own nested stack is the child's
   * OWN resource bag, so no twin registered ABOVE the child is reachable from a
   * grandchild. Where the middle stack passes the value THROUGH
   * (`{ Ref: Param }` straight into the grandchild's `Parameters`) nothing ever
   * registers a twin in that bag, so the grandchild prints the value whether or
   * not the bag holds pairs. Where the middle RE-WRAPS it (an `Fn::Join` around
   * the `Ref`) the middle registers its own twin, and the hand-off still drops
   * a bag holding no pairs (it passes `inheritedSecrets` only when `size` is
   * nonzero). What reaches a grandchild instead is the parent's WHOLE-VALUE
   * entry: the middle's `{ Ref }` copies it into the middle's bag, which is then
   * non-empty and handed down. Issue #3156 made the carry record that entry for
   * the intrinsic frames it used to refuse; a frame it still refuses (listed on
   * `recordNestedStackParameterExpressions`) keeps both gaps.
   *
   * The registry is keyed by VALUE, and `splitLogTwins`' unaligned arm
   * registers every piece, public ones included. So a child `Fn::Base64` over a
   * string exactly equal to such a piece of its parent's persists `***` for a
   * non-secret property, the over-masking hazard issue #3119 already accepts
   * within one pass, now reachable across the parent / child boundary.
   */
  private registeredLogTwin(value: string, context?: ResolverContext): string | undefined {
    const own = context?.recordedSecretValues
      ? LOG_TWINS_BY_PASS.get(context.recordedSecretValues)?.get(value)
      : undefined;
    const inherited = context?.inheritedSecrets
      ? LOG_TWINS_BY_PASS.get(context.inheritedSecrets)?.get(value)
      : undefined;
    if (own === undefined) return inherited;
    return inherited === undefined || inherited === own ? own : SECRET_MASK;
  }

  /**
   * The log twin of a RESOLUTION PRODUCT — an intrinsic part, variable or
   * placeholder — for issue #3100. Masked whole when its value is a recorded
   * secret. Otherwise a part that carries no mask of its own takes the masked
   * twin an earlier write of this pass registered for that exact string
   * (`rememberLogTwin`) — how a Join part that is itself an `Fn::Sub`, or a
   * `Fn::Select` over a reference-bearing string, keeps the inner mask. A part
   * whose OWN masked twin disagrees with the registered one (a list element
   * still spelling a reference) is masked whole, since the two span sets
   * cannot be merged; one that agrees keeps its twin.
   *
   * The registry is keyed by VALUE, so a product equal to a registered string
   * from another provenance takes its mask too. That over-masks a line whose
   * text holds a recorded secret at a position some write in this pass put
   * one. The registry holds masked twins only, so a lookup never unmasks.
   *
   * The whole-secret check reads the bags as they stand when the product is
   * placed, before the enclosing Join / Sub runs its final substitution. A
   * secret that substitution records is therefore not matched against an
   * earlier product equal to it. Such a product did not come from that secret:
   * a parameter holding one arrives in the inherited bag before its `Ref`
   * resolves, so what stays printed is a public value that coincides with it.
   */
  private logTwinOfProduct(part: LogTwin, context?: ResolverContext): LogTwin {
    if (this.isRecordedSecretForLog(part.result, context)) {
      return { result: part.result, twin: SECRET_MASK };
    }
    const registered = this.registeredLogTwin(part.result, context);
    if (registered === undefined || registered === part.twin) return part;
    return { result: part.result, twin: part.twin === part.result ? registered : SECRET_MASK };
  }

  /**
   * Record the `Fn::Join` / `Fn::Sub` / `Fn::If` object `source`'s own
   * resolution under the pass bag the nested-stack carry reads (issues
   * [#3156](https://github.com/go-to-k/cdkd/issues/3156),
   * [#3306](https://github.com/go-to-k/cdkd/issues/3306)). The key is the
   * object `resolveValue` dispatched on, and a context with no bag has no pass
   * to scope it to.
   */
  private recordLeafResolution(
    context: ResolverContext,
    source: object,
    resolution: IntrinsicLeafResolution
  ): void {
    if (context.recordedSecretValues === undefined) return;
    recordIntrinsicLeafResolution(context.recordedSecretValues, source, resolution);
  }

  /**
   * What a NESTED intrinsic part contributes to its outer object's record
   * (issue [#3306](https://github.com/go-to-k/cdkd/issues/3306)): the part's
   * own record when this pass kept one for that object, so a token the part
   * spelled reaches the outer `input` raw with
   * the replacement that resolved it. Any other part contributes its resolved
   * text and no replacement, as before. A record the pass kept describes THIS
   * resolution: the part was just resolved into the same bag, and a
   * resolution that differs from an earlier one poisons the record, which
   * reads as none. `complete` is lent with the rest, though for every record
   * the resolver writes a token the part left unreplaced also stays in its
   * `input`, a second span the carry refuses on its own, so no case pins it.
   */
  private nestedPartResolution(
    context: ResolverContext,
    part: unknown,
    resolved: string
  ): Pick<IntrinsicLeafResolution, 'input' | 'substitutions' | 'complete'> {
    const own =
      context.recordedSecretValues !== undefined && typeof part === 'object' && part !== null
        ? intrinsicLeafResolutionOf(context.recordedSecretValues, part)
        : undefined;
    if (own === undefined) return { input: resolved, substitutions: [], complete: true };
    return { input: own.input, substitutions: own.substitutions, complete: own.complete };
  }

  /**
   * Register a MASKED `twin` as the log twin of `result` for this pass (issue
   * #3100). An unmasked twin is not registered, so a later literal that
   * resolves to the same string cannot replace an earlier write's mask, and
   * two DIFFERENT masked twins for one string register `***` for the whole
   * string, since their spans cannot be merged. Scoped to the pass's bag
   * through a `WeakMap`, like the cross-stack associations, so it dies with
   * the bag. An unrelated pass cannot reach these strings; a nested child
   * whose `inheritedSecrets` is this bag reads them (`registeredLogTwin`).
   */
  /** @internal */
  rememberLogTwin(context: ResolverContext, result: string, twin: string): void {
    if (twin === result) return;
    const bag = this.logTwinBag(context);
    if (!bag) return;
    let twins = LOG_TWINS_BY_PASS.get(bag);
    if (!twins) {
      twins = new Map<string, string>();
      LOG_TWINS_BY_PASS.set(bag, twins);
    }
    const existing = twins.get(result);
    twins.set(result, existing === undefined || existing === twin ? twin : SECRET_MASK);
  }

  /**
   * A copy of `value` with every string LEAF (and every object KEY) masked, for
   * a caller about to ENCODE it into a message (issue
   * [#2759](https://github.com/go-to-k/cdkd/issues/2759)).
   *
   * `stringifyValue` / `JSON.stringify` ESCAPE a leaf containing `"`, `\` or a
   * control character, and {@link maskSecretsInText} matches a needle
   * LITERALLY — so masking the ENCODED text misses exactly the plaintexts the
   * encoder rewrote (`pa"ss\word12` encodes to `["pa\"ss\\word12"]`, which no
   * needle matches). Masking each leaf first also buys the WHOLE-VALUE arm,
   * which has no {@link MIN_NEEDLE_LENGTH} floor, for a leaf that IS the
   * plaintext.
   *
   * Returns the STRUCTURE rather than a rendered string, deliberately: each
   * call site keeps its own encoder, so this changes which characters are
   * masked and nothing about how a value RENDERS. Encoding here instead
   * dropped `JSON.stringify`'s quotes around a bare string and made a `cdkd
   * scrub` log line unrecognisable to its own test.
   *
   * Object KEYS are masked too: a `Fn::Split` / `Fn::GetAtt` chain can put a
   * resolved value in key position, and an unmasked key discloses exactly as
   * much as an unmasked value.
   *
   * Cycle-safe by MEMOIZATION rather than a depth cap: a self-referential
   * structure terminates (the replacement is registered before its children are
   * walked, so the cycle closes on it) and a legal deep one is still walked to
   * the bottom. A repeated but NON-cyclic sub-object gets its real rendering
   * rather than a placeholder — see the note at the `Map`.
   */
  /** @internal */
  maskValueLeaves(value: unknown, context?: ResolverContext): unknown {
    // MEMOIZED, not a visited-SET (issue #2827 review round 1). A `Set` that is
    // never popped cannot tell a CYCLE from a DAG: an object referenced twice
    // in the same structure — an `Fn::Split` result reused at two positions is
    // the ordinary way to get one — rendered as `null` the second time, which
    // this method's own doc claimed happened only to a cycle. A `Map` from node
    // to its already-computed replacement terminates a cycle just as a set
    // does (the entry is written BEFORE the children are walked) while giving a
    // repeat its real rendering.
    const done = new Map<object, unknown>();
    const walk = (node: unknown): unknown => {
      if (typeof node === 'string') {
        return this.displayMasked(node, context);
      }
      if (node === null || typeof node !== 'object') return node;
      const memo = done.get(node);
      if (memo !== undefined) return memo;
      if (Array.isArray(node)) {
        const out: unknown[] = [];
        // Registered BEFORE the walk, so a self-referential array terminates
        // against this same (still-growing) instance instead of recursing.
        done.set(node, out);
        for (const item of node) out.push(walk(item));
        return out;
      }
      // `Object.create(null)`, and a PLAIN assignment onto it (issue #2802's
      // rule; the shape `:6291` uses). This was `Object.assign(out, { [k]: v })`
      // — and `Object.assign` INVOKES a setter on the receiver's prototype
      // chain, so a masked key of `__proto__` ran `Object.prototype.__proto__`'s
      // setter: own keys `[]`, prototype hijacked, `JSON.stringify` `{}`. Not a
      // disclosure (every leaf is already masked) but the field vanishes from
      // the diagnostic, which is the failure this walk exists to avoid. A
      // null-prototype receiver has no such setter to reach, so the assignment
      // is an ordinary own-key write.
      //
      // ONE STATED COST of rendering the KEY through the builder: two DISTINCT
      // keys that produce the same display collapse to one entry, so the
      // rendering shows fewer fields than the value has. Since
      // go-to-k/cdkd#3426 that needs NO secret at all — the builder strips and
      // trims, so `" Name"` and `"Name"` collide, two keys differing only by a
      // control character collide, and an all-control key becomes the empty
      // string. (Before, the collapse required both keys to mask to `***`.)
      // Accepted rather than worked
      // around on the same terms as before: both keys are rendered either way,
      // and the loss is a field COUNT in a diagnostic, never a disclosure.
      // Disambiguating them would put an index into a masked key, which is a
      // worse trade.
      //
      // The memo's CYCLE arm is unreachable from `resolveValue`: a template is
      // parsed from JSON so it holds no cycle, and a hand-built one recurses in
      // the resolver's own walk long before this runs (measured, review round 3).
      // Kept as defence in depth for a caller arriving another way — and BOTH
      // memo arms are pinned by tests that call this method directly, which is
      // the only way to reach either (`resolveValue` REBUILDS the structure, so
      // a shared sub-object arriving through it is no longer one reference by
      // the time the walk runs).
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      done.set(node, out);
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        // allow-template-keyed-bag-read: `out` is `Object.create(null)` two lines
        // up, so this write has no inherited setter to reach — which is the whole
        // reason the receiver was changed from `{}`. The critic's own
        // `Object.create(null)` arm does not fire here because the bag is
        // declared inside this arrow rather than an enclosing scope.
        out[this.displayMasked(key, context)] = walk(child);
      }
      return out;
    };
    return walk(value);
  }

  /**
   * Mask `value`, STRIP its control characters, then mask again — the shape a
   * message that truncates its input needs (issue
   * [#2827](https://github.com/go-to-k/cdkd/issues/2827) review round 1).
   *
   * NEITHER SINGLE ORDER IS CORRECT, and both were measured. Masking AFTER
   * `stripControlChars` is what this fix was written to avoid: the strip
   * rewrites the text a literal needle has to match. But masking BEFORE it is
   * not safe either, because `stripControlChars` DELETES rather than replaces —
   * so a plaintext SPLIT by an invisible (`S3cret\u200ePassw0rd`) is missed by
   * the first mask and then RECONSTITUTED contiguous by the strip. That is the
   * go-to-k/cdkd#2874 class arriving through a different door.
   *
   * Masking in BOTH string spaces closes both: the first pass catches a needle
   * that occurs literally, the second catches one that only becomes contiguous
   * after stripping. `maskSecretsInText` is idempotent, so the overlap costs
   * nothing, and the caller truncates AFTERWARDS — never between the two.
   *
   * WHICH HALF IS FENCED, stated because a mutation probe made the difference
   * visible. The FIRST mask is demonstrated by a test: deleting it (masking
   * only after the strip) reds the split-needle case, because the recorded
   * needle is then the split form and the strip has destroyed it. The SECOND
   * mask earns its place when the bag holds a needle that is the STRIPPED form
   * of the text in hand. A value this resolver resolved cannot be that text
   * (the split copy is itself recorded, so the first mask catches it), but a
   * template LITERAL can: issue #3150's region-scoped clients refusal prints
   * a producer-region guest's region through {@link displayMasked}, and a
   * literal ARN region spelling a recorded `st-1` as `s` + U+0001 + `t-1` is
   * masked only by the second pass
   * (`intrinsic-resolver-name-argument-log-twin.test.ts` pins both halves on
   * that route).
   *
   * ONE CALLER, {@link displayMasked}, since go-to-k/cdkd#3426. It is most of
   * the answer and reads like all of it — it omits `displaySafe`, and
   * therefore `U+2028` / `U+2029` and the bidi overrides — so a site reaching
   * for it directly is the near-miss back onto the treadmill. A DIRECT
   * `${this.maskThenStripThenMask(...)}` interpolation is refused by
   * `resolver-display-masked-population.test.ts`'s line rule; a BINDING of it
   * rendered later is not seen by anything since go-to-k/cdkd#3435 deleted the
   * AST checker, which is why the one-caller containment above is the control
   * that matters.
   *
   * THE BOUND, since this file's job is to state them: this covers a needle
   * split by a character `stripControlChars` removes. A needle split by
   * anything else, or one whose canonical form differs for another reason, is
   * `outputs-export-alias.ts`'s `canonicalForSecretScan` problem and is not
   * solved here.
   */
  private maskThenStripThenMask(value: string, context?: ResolverContext): string {
    return this.maskSecretsRaw(stripControlChars(this.maskSecretsRaw(value, context)), context);
  }

  /**
   * The ONE way a masked value reaches a message in this file — and, since
   * go-to-k/cdkd#3426, the ONLY exit from the masking machinery at all.
   *
   * ## Why this exists rather than a rule about call sites
   *
   * {@link maskSecretsRaw} answers "does this text contain a recorded secret"
   * and makes NO claim about control characters. That split produced a
   * four-round treadmill on go-to-k/cdkd#3408. Round 1 found the four
   * `Fn::GetStackOutput` throws rendering a masked name raw and fixed them.
   * Round 2 found the CloudFormation-fallback warn — the DEFAULT path, at
   * DEFAULT verbosity — and the self-reference throw. Round 3 found the
   * `reresolveCrossStackValue` origin builder and `describeAvailableOutputs`.
   * Each round fixed what it found and the next round found more, because the
   * population was never enumerated. Measured 2026-09-19 with a
   * comment-stripped scan: SEVENTY-ONE interpolations rendered a bare masker
   * result directly, plus thirteen hand-spelled
   * `displaySafe(maskThenStripThenMask(...))` compositions and two bare
   * `maskThenStripThenMask` interpolations — and three reviewers between them
   * reached eight of the eighty-six.
   *
   * ROUND FIVE was the BINDING shape: `const loggedExportName =
   * this.<masker>(...)` interpolated later, which a line-shaped scanner
   * forbidding `${this.<masker>(` structurally cannot see. Ten of them existed,
   * and `loggedExportName` was a LIVE exposure — an `Fn::ImportValue` export
   * name carrying `ESC[2K` + CR reached a warn AND a throw unstripped, at
   * default verbosity on the default path.
   *
   * Patching those ten sites would have been the fifth round of one
   * enumeration. What closes the class instead is that there is no longer a
   * masking answer a site can reach WITHOUT the strip: every escaping call of
   * the old `maskSecretsForLog` now calls this builder, the raw masker is
   * reachable only through {@link maskThenStripThenMask}, and that helper is
   * reachable only from here.
   *
   * ## What keeps it closed
   *
   * `tests/unit/deployment/resolver-display-masked-population.test.ts`, which
   * asserts from the AST that `maskSecretsRaw` is referenced only inside
   * `maskThenStripThenMask` and that helper only inside this builder — exact
   * reference counts, no inference — and refuses a direct
   * `${this.<raw masker>(...)}` interpolation by line rule.
   *
   * An AST walk that ALSO resolved an interpolated identifier to its
   * declaration used to cover the BINDING shape. go-to-k/cdkd#3435 deleted it
   * as high-maintenance tooling (23 commits across it and its suite in nine
   * days; a widening attempted one PR earlier produced nine defects inside
   * itself and was withdrawn), so that shape is now held by the containment
   * above — there is no bare masker to bind, because nothing outside this
   * builder may call one.
   *
   * KNOWN BOUND, stated rather than implied away: a site carrying an
   * exclusion marker is exempt from that walk, because the marker answers the
   * SECRET question ("this value cannot carry a plaintext"), which is not the
   * control-character question. Such a site sanitizes by hand or not at all —
   * `clientsForRegion`'s two region renders are both markered, and both
   * sanitize. Widening the walk to judge every interpolated value is
   * go-to-k/cdkd#3405's mixed-render scope, not this builder's.
   *
   * (The marker's literal spelling is deliberately not written in this comment:
   * the checker scans the raw text for it, and a prose mention parses as a
   * marker no site consumes — which it then reports STALE. Measured while
   * writing this paragraph.)
   *
   * ## What it does, in order
   *
   * `maskThenStripThenMask` first — mask, strip, mask — because
   * `stripControlChars` DELETES, so a plaintext split by an invisible would be
   * reconstituted contiguous by a strip applied after a single mask. Then
   * `displaySafe`, which covers the class `stripControlChars` does not:
   * `U+2028` / `U+2029` (line terminators to JSON and web log viewers) and the
   * Trojan-Source bidi overrides. That composition is what the `physicalId`
   * renders here already spelled by hand; this names it, and they now share it.
   *
   * It is the ONE sanctioned exit from the masking machinery, which is a
   * SECURITY decision and a sound one: every path through it passes the
   * needle-and-twin mask, twice, so it is strictly stronger than the bare
   * masker it replaced and cannot be weaker at any input.
   */
  /** @internal */
  displayMasked(value: string, context?: ResolverContext): string {
    return displaySafe(this.maskThenStripThenMask(value, context));
  }

  /**
   * {@link displayMasked} for a value or name on a `--verbose` `Resolved …`
   * line, bounded so a pasted line cannot run or redirect through it
   * (go-to-k/cdkd#4161): the masked display when {@link isLogInert} admits it,
   * so an ordinary value and a `***` mask print as they always did, and
   * otherwise `UNSHOWABLE_VALUE`, the description cdkd's other pasteable
   * prose uses (the go-to-k/cdkd#4229 decision). A description runs nothing
   * under either quote flip, which a JSON-quoted value does not. The mask runs
   * FIRST, so nothing it hid is shown. Not closed here: a PLAIN name that is
   * itself a command word right after a `: ` (go-to-k/cdkd#4249).
   *
   * Not `displayMaskedIdent`: that quotes every value a mask ALTERED
   * (`"port:***"`), cuts at 255 characters and blanks non-ASCII, and the
   * integ fixtures' masked-line checks read the bare mask
   * (`nested-stack-3level`'s `masked_whole` wants `<prefix>***` at the line's
   * end).
   *
   * Two opt-ins, each set by the CALLER from what produced the text, never
   * inferred from the text itself (go-to-k/cdkd#4243 review):
   * - `redacted`: the text is `stringifyParameterForLog` /
   *   `stringifyAttributeForLog`'s own `<redacted>` token, printed bare as it
   *   always was. A template value spelled `<redacted>` is a `<` and a `>`
   *   redirect and is described like any other.
   * - `structured`: the text is a JSON render (`stringifyValue`'s of an array
   *   or object, or a `JSON.stringify` the caller built). Kept while
   *   {@link isLogInertJson} admits it, so a list of plain or masked values
   *   still reads as one; otherwise described.
   */
  /** @internal */
  logRender(
    value: string,
    context: ResolverContext | undefined,
    opts: { readonly structured?: boolean; readonly redacted?: boolean } = {}
  ): string {
    const shown = this.displayMasked(value, context);
    if (opts.redacted === true && shown === '<redacted>') return shown;
    const inert = opts.structured === true ? isLogInertJson(shown) : isLogInert(shown);
    return inert ? shown : UNSHOWABLE_VALUE;
  }

  /**
   * The `Fn::Split` delimiter on its `Resolved` line: `"<d>"` when the masked
   * delimiter is {@link isLogInert}, otherwise described. `quotedRender`'s
   * class admits `|`, `<`, `>` and `*` because they are literal INSIDE cdkd's
   * `"…"`, but an unpaired `"` above the line flips that quote and leaves the
   * delimiter bare, where `>` redirects (go-to-k/cdkd#4229's `"` flip).
   */
  private splitDelimiterRender(delimiter: string, context: ResolverContext | undefined): string {
    const shown = this.displayMasked(delimiter, context);
    return isLogInert(shown)
      ? `"${shown}"`
      : 'a delimiter (not shown: it is not a plain identifier)';
  }

  /**
   * {@link displayMasked}, then bounded as an IDENTIFIER (go-to-k/cdkd#3617):
   * bare when plain, otherwise one JSON string, so a template- or state-chosen
   * name cannot close a quote of cdkd's own and write a clause into the
   * message. Masked FIRST: `displayIdent` blanks non-ASCII and cuts, either of
   * which would stop a recorded plaintext inside the name from matching.
   */
  /** @internal */
  displayMaskedIdent(value: string, context?: ResolverContext, maxCodePoints?: number): string {
    // The ASCII allowlist runs BETWEEN two masks: `displayIdent` would blank a
    // non-ASCII character to a space after the mask, and a recorded secret
    // spelled with that space (`correct horse` beside `correct<NBSP>horse`)
    // would then print byte for byte.
    const asciiMasked = this.displayMasked(
      displaySafe(this.displayMasked(value, context), { asciiOnly: true }),
      context
    );
    return boundAltered(value, asciiMasked, maxCodePoints);
  }

  /**
   * The display form of a LOG-TWIN leaf — the second render route, named for
   * the same reason as {@link displayMasked} and closed by the same scanner.
   *
   * `logTextOfLeaf` resolves a value to its registered twin (or `SECRET_MASK`),
   * which is a MASKING answer and, like `maskSecretsRaw`'s, says nothing
   * about control characters. Four `origin` builders interpolated it raw — the
   * `Fn::ImportValue` pair, the `Fn::GetStackOutput` one and the nested-stack
   * attribute one — and those strings flow into `redactedAttributeReads[].display`
   * and out through a `ProvisioningError` message.
   *
   * This route is why fixing the secret masker alone did not close the class:
   * `displayMasked` covers every site that renders a needle-masked value, and
   * these render something else. Two routes, two names, one checker refusing
   * the raw form of both.
   *
   * Composed rather than re-derived. `maskSecretsInText` is idempotent (see
   * {@link maskThenStripThenMask}), so masking twin text again costs nothing
   * and cannot change the twin — which keeps this a STRICT addition of the
   * strip and the `displaySafe` pass, with the twin resolution untouched.
   */
  /** @internal */
  displayLeaf(value: string, context?: ResolverContext): string {
    return this.displayMasked(this.logTextOfLeaf(value, context), context);
  }

  /**
   * Resolve an SSM Parameter Store dynamic reference
   *
   * Format: ssm:PARAMETER_NAME
   * Parts[0] = 'ssm'
   * Parts[1] = PARAMETER_NAME
   */
  /**
   * Resolve Fn::Cidr intrinsic function
   *
   * Fn::Cidr returns an array of CIDR address blocks.
   * Syntax: { "Fn::Cidr": [ ipBlock, count, cidrBits ] }
   * - ipBlock: The user-specified CIDR address block to be split
   * - count: The number of CIDRs to generate
   * - cidrBits: The number of subnet bits for the CIDR (e.g., "64" for /64 in IPv6)
   */
  private async resolveCidr(
    args: [unknown, unknown, unknown],
    context: ResolverContext
  ): Promise<string[]> {
    const [rawIpBlock, rawCount, rawCidrBits] = args;
    const ipBlock = (await this.resolveValue(rawIpBlock, context)) as string;
    const count = Number(await this.resolveValue(rawCount, context));
    const cidrBits = Number(await this.resolveValue(rawCidrBits, context));

    if (!ipBlock || typeof ipBlock !== 'string') {
      throw new Error(
        `Fn::Cidr: ipBlock must be a string, got ${typeof ipBlock}: ${JSON.stringify(this.maskValueLeaves(ipBlock, context))}`
      );
    }

    // `count` / `cidrBits` through the builder (PR #3575 review): as
    // `Number()` results they cannot carry a control character, but they come
    // back from `resolveValue`, so a numeric secret whose text survives
    // `Number()` would otherwise print (`"0064"` or `"1e3"` does not survive,
    // and is not masked).
    this.logger.debug(
      // Leaf-masked like the refusal above (issue #2827 review): `ipBlock`
      // comes back from `resolveValue`.
      `Resolving Fn::Cidr: ipBlock=${this.displayMasked(JSON.stringify(this.maskValueLeaves(ipBlock, context)), context)}, count=${this.displayMasked(String(count), context)}, cidrBits=${this.displayMasked(String(cidrBits), context)}`
    );

    const isIpv6 = ipBlock.includes(':');
    const results: string[] = [];

    if (isIpv6) {
      // IPv6 CIDR calculation
      // Parse the base IPv6 address and prefix
      const [baseAddr, prefixStr] = ipBlock.split('/');
      const basePrefix = parseInt(prefixStr!, 10);
      const subnetPrefix = 128 - cidrBits; // cidrBits = host bits, so subnet prefix = 128 - cidrBits

      // Expand IPv6 address to full form
      const expanded = this.expandIPv6(baseAddr!);
      const addrBigInt = this.ipv6ToBigInt(expanded);

      // Calculate subnet size
      const subnetSize = BigInt(1) << BigInt(128 - subnetPrefix);

      // Mask the base address to the network prefix
      const prefixMask =
        (BigInt(1) << BigInt(128)) -
        BigInt(1) -
        ((BigInt(1) << BigInt(128 - basePrefix)) - BigInt(1));
      const networkBase = addrBigInt & prefixMask;

      for (let i = 0; i < count; i++) {
        const subnetAddr = networkBase + subnetSize * BigInt(i);
        results.push(`${this.bigIntToIPv6(subnetAddr)}/${subnetPrefix}`);
      }
    } else {
      // IPv4 CIDR calculation
      const [baseAddr, prefixStr] = ipBlock.split('/');
      const basePrefix = parseInt(prefixStr!, 10);
      const subnetPrefix = 32 - cidrBits;

      const parts = baseAddr!.split('.').map(Number);
      const baseInt = ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
      const subnetSize = 1 << (32 - subnetPrefix);
      const prefixMask = (0xffffffff << (32 - basePrefix)) >>> 0;
      const networkBase = (baseInt & prefixMask) >>> 0;

      for (let i = 0; i < count; i++) {
        const subnetAddr = (networkBase + subnetSize * i) >>> 0;
        const a = (subnetAddr >>> 24) & 0xff;
        const b = (subnetAddr >>> 16) & 0xff;
        const c = (subnetAddr >>> 8) & 0xff;
        const d = subnetAddr & 0xff;
        results.push(`${a}.${b}.${c}.${d}/${subnetPrefix}`);
      }
    }

    // The RESULT is derived from `ipBlock`, so it inherits its provenance
    // (issue #2827 review, item D2: one of the five encodings the fix's own
    // comment had claimed were all leaf-masked).
    //
    // As NEEDLE masks the two on this line are MUTUALLY redundant, and no test
    // can discriminate either one (measured both ways, review round 4:
    // stripping the leaf walk reds nothing, and so does stripping the outer
    // call; only removing BOTH reds). Since issue #3100 the leaf arm also
    // consults the pass's log-twin registry, which only ever masks MORE: a
    // computed CIDR equal to a string an earlier write masked by position is
    // masked by the leaf walk and not by the outer call, an over-mask. For the
    // needle part the leaf arm is `displayMasked`,
    // so the only thing that could separate per-leaf from whole-JSON masking is
    // `maskSecretsInText`'s asymmetry — the whole-string arm has no floor while
    // the substring arm is floored at {@link MIN_NEEDLE_LENGTH} = 4 — and
    // reaching it needs a needle of 3 characters or fewer equal to a WHOLE leaf.
    // `results` holds only values this method COMPUTED: dotted-decimal (min 9
    // characters, `0.0.0.0/0`) or colon-hex (min 17, `bigIntToIPv6` never
    // compresses), over `[0-9a-f:./-]` plus `NaN` / `Infinity` — nothing
    // `JSON.stringify` escapes, and nothing short enough. So the two orders
    // produce identical output for every needle set.
    //
    // BOTH stay, because the redundancy is a property of what `results` holds
    // TODAY rather than of the site: the day this pushes something it did not
    // compute, the leaf walk is the mask that still works.
    this.logger.debug(
      `Fn::Cidr result: ${this.displayMasked(JSON.stringify(this.maskValueLeaves(results, context)), context)}`
    );
    return results;
  }

  /** Expand IPv6 address to full 8-group form */
  private expandIPv6(addr: string): string {
    // Handle :: expansion
    if (addr.includes('::')) {
      const [left, right] = addr.split('::');
      const leftParts = left ? left.split(':') : [];
      const rightParts = right ? right.split(':') : [];
      const missing = 8 - leftParts.length - rightParts.length;
      const middle = Array.from({ length: missing }, () => '0000');
      const all = [...leftParts, ...middle, ...rightParts];
      return all.map((p: string) => p.padStart(4, '0')).join(':');
    }
    return addr
      .split(':')
      .map((p) => p.padStart(4, '0'))
      .join(':');
  }

  /** Convert expanded IPv6 string to BigInt */
  private ipv6ToBigInt(expanded: string): bigint {
    const parts = expanded.split(':');
    let result = BigInt(0);
    for (const part of parts) {
      result = (result << BigInt(16)) | BigInt(parseInt(part, 16));
    }
    return result;
  }

  /** Convert BigInt to compressed IPv6 string */
  private bigIntToIPv6(n: bigint): string {
    const parts: string[] = [];
    for (let i = 7; i >= 0; i--) {
      parts.push(((n >> BigInt(i * 16)) & BigInt(0xffff)).toString(16));
    }
    // Simple format — don't compress with :: for clarity
    return parts.join(':');
  }
}

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
IntrinsicFunctionResolver.prototype.lookupCfnExport = crossStackMixin.lookupCfnExport;
IntrinsicFunctionResolver.prototype.describeAvailableOutputs =
  crossStackMixin.describeAvailableOutputs;
IntrinsicFunctionResolver.prototype.fetchAllCfnExports = crossStackMixin.fetchAllCfnExports;
IntrinsicFunctionResolver.prototype.lookupCfnStackOutputs = crossStackMixin.lookupCfnStackOutputs;
IntrinsicFunctionResolver.prototype.fetchCfnStackOutputs = crossStackMixin.fetchCfnStackOutputs;
IntrinsicFunctionResolver.prototype.getCfnClient = crossStackMixin.getCfnClient;
IntrinsicFunctionResolver.prototype.recordImport = crossStackMixin.recordImport;
IntrinsicFunctionResolver.prototype.resolveGetStackOutput = crossStackMixin.resolveGetStackOutput;
IntrinsicFunctionResolver.prototype.recordOutputRead = crossStackMixin.recordOutputRead;
IntrinsicFunctionResolver.prototype.positionalNameMask = crossStackMixin.positionalNameMask;
IntrinsicFunctionResolver.prototype.maskStateReadError = crossStackMixin.maskStateReadError;
IntrinsicFunctionResolver.prototype.maskNamedError = crossStackMixin.maskNamedError;
IntrinsicFunctionResolver.prototype.namedRequestMasks = crossStackMixin.namedRequestMasks;
IntrinsicFunctionResolver.prototype.getSameAccountStackState =
  crossStackMixin.getSameAccountStackState;
IntrinsicFunctionResolver.prototype.getCrossAccountStackState =
  crossStackMixin.getCrossAccountStackState;

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
