import type { IntrinsicFunctionResolver } from '../intrinsic-function-resolver.js';
import type { ServiceDiscoveryClient } from '@aws-sdk/client-servicediscovery';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { getAwsClients, type AwsClients } from '../../utils/aws-clients.js';
import { canonicalizeRegion, sameRegion } from '../../utils/aws-partition.js';
import { stripControlChars } from '../../utils/regexp.js';
import { displaySafe } from '../../utils/display-safe.js';
import { IntrinsicResolutionRefusalError } from '../../utils/error-handler.js';
import { markNonRetryable } from '../retryable-errors.js';
import {
  ambientCredentialConfig,
  clientDefaultsFor,
  type CredentialConfig,
} from '../../utils/ambient-client-defaults.js';
import { clientCacheKey, isClientSafeRegion, boundAltered } from './support.js';

/** What a {@link ResolverClients} reads from the resolver it serves. */
export interface ResolverClientsDeps {
  /**
   * The region the resolver's constructor was given (its `explicitRegion`).
   * A value: the resolver assigns it once, in its constructor.
   */
  readonly explicitRegion: string | undefined;
  /**
   * How a producer-region guest prints that region (its
   * `explicitRegionLogText`). A LIVE getter: the guest's creator sets it
   * after construction and may later change it to `***`.
   */
  readonly explicitRegionLogText: () => string | undefined;
  /** The resolver's logger, read live (a writable field). */
  readonly logger: () => Pick<IntrinsicFunctionResolver['logger'], 'debug'>;
}

/**
 * The AWS clients one resolver builds for itself, and the caches that hold
 * them. One instance per resolver, created in its constructor and never
 * reset, so each cache keeps the resolver's own lifetime (see the notes on
 * {@link regionScopedClients}).
 */
export class ResolverClients {
  /**
   * AWS clients pinned to a region OTHER than the ambient singleton's, built
   * lazily on first mismatch and keyed by region (issue #1957).
   *
   * Lifetime is deliberately the resolver's own, matching {@link cfnClients}:
   * both are per-region SDK clients built for one resolver, and neither is
   * destroyed, because `IntrinsicFunctionResolver` has
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
   * (`CfnFallbackCache`'s `cfnExportsPromises` and `cfnStackOutputsCache`)
   * carry the fingerprint too.
   *
   * The VALUE caches carry the fingerprint as well (issue
   * [#3660](https://github.com/go-to-k/cdkd/issues/3660)): the resolver's
   * `cachedDynamicReferences`, and the process-global account identity
   * behind `getAccountInfo` and `cachedAvailabilityZones`.
   */
  readonly regionScopedClients = new Map<string, AwsClients>();
  /**
   * ServiceDiscovery clients keyed by the region {@link clientsForRegion}
   * selected (`''` when it selected none). See {@link serviceDiscoveryClient}
   * for why this one service is not read off an `AwsClients` bag, and why the
   * PROMISE rather than the client is what is stored.
   */
  readonly serviceDiscoveryClients = new Map<string, Promise<ServiceDiscoveryClient>>();
  /**
   * Per-region CloudFormation clients for the cross-stack fallback
   * lookups (issue #1697). Keyed by region because `Fn::GetStackOutput`
   * may target a region different from the consumer's deploy region, and by
   * the credential fingerprint for {@link regionScopedClients}' reason.
   */
  readonly cfnClients = new Map<string, CloudFormationClient>();

  private readonly deps: ResolverClientsDeps;

  constructor(deps: ResolverClientsDeps) {
    this.deps = deps;
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
   *    the resolver's `explicitRegion`), so there is nothing to bind to.
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
  clientsForRegion(targetRegion: string | undefined, targetLogText?: string): AwsClients {
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
      // allow-raw-region-compare: picks the log text of THIS exact string; another spelling of the region prints as `target`.
      (targetRegion === this.deps.explicitRegion ? this.deps.explicitRegionLogText() : undefined) ??
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
    if (sameRegion(ambient.configuredRegion, target)) return ambient;

    const scoped = ambient.withRegion(target);
    this.regionScopedClients.set(cacheKey, scoped);
    // SANITIZED (go-to-k/cdkd#3426), and this site was the one the issue's own
    // list did not carry: `isClientSafeRegion` gated `target`, never
    // `loggedTarget`, which is the LOG TEXT of a possibly different string — a
    // guest's `explicitRegionLogText`, or `resolveGetAZs`' masked region. The
    // gate one arm up is a claim about the region cdkd will put in a hostname,
    // not about the text printed for it.
    // not-in-class(displaySafe(loggedTarget)): a REGION's log text, masked by the caller that built the region from a template (issue #3150), or a resolver's own region as its command built it (stack / --region / literal-token region).
    this.deps.logger().debug(`Using region-scoped AWS clients for ${displaySafe(loggedTarget)}`);
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
  async serviceDiscoveryClient(): Promise<ServiceDiscoveryClient> {
    const scoped = this.clientsForRegion(this.deps.explicitRegion);
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
   * Lazily-constructed per-region CloudFormation client (issue #1697), for
   * `CfnFallbackCache`'s `ListExports` / `DescribeStacks` reads.
   *
   * Built with the ambient clients' {@link AwsClients.credentialConfig}, the
   * way {@link serviceDiscoveryClient} is (issue
   * [#1983](https://github.com/go-to-k/cdkd/issues/1983)). An explicit
   * `AwsClientConfig.credentials` has no environment path — only a LIBRARY
   * caller passes one, and it never runs the CLI's `AWS_PROFILE` mirror — so a
   * client built from `awsClientDefaults()` alone ran the CFn fallback reads
   * under the default chain's identity instead. The explicit `credentials`
   * spread AFTER the defaults, so they outrank an assumed `--role-arn` role,
   * matching {@link AwsClients}' own spread order.
   *
   * Not routed through {@link clientsForRegion}: the region here is always
   * the one the caller named, never the ambient's, and a test double without
   * `credentialConfig` degrades to the default chain rather than throwing.
   * Keyed by region AND credential fingerprint for the reason
   * {@link regionScopedClients} gives (issue #3588).
   *
   * The region is FOLDED first, for the key and the client alike (issue
   * [#2209](https://github.com/go-to-k/cdkd/issues/2209)): `ListExports` passes
   * the RAW `resolverRegion` while `DescribeStacks` passes a template `Region`
   * folded, so one region held two entries, and a mis-cased spelling reached the
   * SDK's case-sensitive endpoint resolution. {@link clientsForRegion} folds the
   * same way.
   */
  getCfnClient(rawRegion: string): CloudFormationClient {
    const region = canonicalizeRegion(rawRegion);
    const credentialConfig = ambientCredentialConfig();
    const key = clientCacheKey(region, credentialConfig);
    let client = this.cfnClients.get(key);
    if (!client) {
      client = new CloudFormationClient({ ...clientDefaultsFor(credentialConfig), region });
      this.cfnClients.set(key, client);
    }
    return client;
  }
}
