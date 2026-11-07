import { type RetryLogger } from '../../retry.js';
import { clearRecordedSecretExpressions } from '../../secret-redaction.js';

/**
 * AWS Account information cache
 */
export interface AwsAccountInfo {
  accountId: string;
  region: string;
  partition: string;
}

/**
 * The genuinely region-independent half of {@link AwsAccountInfo} — the ONLY
 * part that may be cached across callers (issue #1746).
 *
 * `region` is the CALLER's, and `partition` is a function of it, so caching a
 * whole `AwsAccountInfo` pinned the FIRST caller's region on every later
 * no-override call. That was benign-ish while `partition` was hardcoded to
 * `'aws'`; issue #1730 made the partition DERIVE from the region, so the stale
 * region started dragging a stale partition with it — a first call from a
 * `cn-north-1`-scoped resolver cached `{region: 'cn-north-1', partition:
 * 'aws-cn'}` and a later no-override call from a us-east-1 context read
 * `aws-cn`. Caching the ACCOUNT alone and deriving region + partition per call
 * removes the failure mode rather than papering over it.
 */
export interface CachedAccountIdentity {
  accountId: string;
}

/**
 * The real account identity, per CREDENTIAL IDENTITY: keyed by
 * {@link credentialFingerprint} of the active `AwsClients`' credential
 * configuration (issue [#3660](https://github.com/go-to-k/cdkd/issues/3660)).
 *
 * Process-wide, and a CLI run has one identity, so for the CLI this holds one
 * entry. A LIBRARY caller can install `AwsClients` for account A, deploy, then
 * install account B's in the same process (or run both in per-stack scopes);
 * keyed by nothing, B's `AWS::AccountId` and every ARN built from it resolved
 * as A's. The in-flight slot in `account-drain.ts` shares the key.
 */
export const cachedAccountIdentities = new Map<string, CachedAccountIdentity>();

/**
 * Availability-zone names per (credential identity, region): keyed by
 * `injectiveKey(credentialFingerprint, region)` (issue
 * [#3660](https://github.com/go-to-k/cdkd/issues/3660)). The zone list is an
 * ACCOUNT's answer — an opt-in or restricted zone is visible to one account and
 * not another — so a region-only key served one identity's list to the next.
 */
export const cachedAvailabilityZones = new Map<string, string[]>();

/**
 * One resolved dynamic reference, as remembered by
 * `DynamicReferenceCache.cachedDynamicReferences` (`dynamic-refs.ts`).
 *
 * `secret` is the verdict the resolution that PRODUCED this value reached —
 * `true` for every `secretsmanager` spelling and for an `ssm` parameter whose
 * `GetParameter` response classified it as a `SecureString`. It is carried HERE
 * rather than re-derived from the process-global verdict store on every hit
 * because the two now have different lifetimes (issue #1933): another stack's
 * resolver — plausibly in another region, where the same parameter NAME is a
 * plain `String` — RETRACTS the store's memo when its own lookup comes back
 * public, and this instance's later resources would then stop redacting a value
 * that is genuinely secret for THEM. The entry answers for the region and the
 * stack that resolved it, which is the whole point of the instance scope.
 */
export interface CachedDynamicReference {
  value: string;
  secret: boolean;
  /**
   * State schema v12: the version id the lookup response carried (a Secrets
   * Manager `VersionId`, an SSM `Version`), so a cache hit records the same
   * provenance the lookup did. Absent when the response carried none.
   */
  version?: string;
}

/** What `namedRequestMasks` (`stack-output.ts`) returns (go-to-k/cdkd#3171). */
export interface NamedRequestMasks {
  /** A masked clone of `error` and its whole cause chain; classification survives. */
  error: (error: unknown) => unknown;
  /** A caught SDK message, masked for interpolation into a line or a throw. */
  text: (message: string) => string;
  /** The `withRetry` logger for the same request. */
  retryLogger: RetryLogger;
}

/**
 * The `{{resolve:...}}` expressions this process has PROVEN resolve to a
 * SECRET, reached through `secret-redaction.ts`'s `recordedSecretExpressions`
 * store. Process-global, and cleared by `resetAccountInfoCache` so a test (or a
 * later phase) cannot inherit a verdict it just asked to forget.
 *
 * NOTE this store is deliberately WIDER-lived than the resolved VALUES it was
 * once paired with: those moved onto the resolver instance (issue #1933), while
 * a verdict is a statement about a reference's TYPE, which the redaction path
 * must be able to read with no resolver in hand. The asymmetry is safe in the
 * one direction that matters — a verdict inherited across regions can only make
 * a reference be treated AS a secret (persisted as its expression, never as
 * plaintext), and the reverse case re-asks AWS because the fresh response is
 * authoritative and the value cache no longer answers for another region.
 *
 * `ssm` is the kind that NEEDS the memory (issue #1901). A plain `ssm`
 * reference is not a secret by SPELLING the way `secretsmanager` is — whether
 * it resolves to public config or to a decrypted secret depends on the
 * parameter's `Type`, which is only knowable from the `GetParameter` response.
 * So secret-ness is discovered on the first resolution and remembered, keyed by
 * the full `{{resolve:...}}` expression. Two consumers need it AFTER the lookup
 * that populated it: the cache-hit arm (which must re-record the value as a
 * secret for the current resolution pass) and the diff / no-op path (which must
 * leave a SecureString reference unresolved without paying a lookup at all once
 * the type is known). A reference NOT in the set is only "not known to be
 * secure" — never "proven public" — so every arm that would leak still asks AWS
 * for the type first. Only the TYPE is remembered, never the decrypted value:
 * on the diff path the lookup is made with `WithDecryption: false`, so the
 * plaintext is never fetched at all there.
 *
 * A `secretsmanager` reference is recorded TOO, and that is issue
 * [#1916](https://github.com/go-to-k/cdkd/issues/1916). It needed no memory
 * while the only question asked of the set was "is this expression secret?",
 * which its spelling settles — but the set is ALSO the candidate list the
 * redaction path matches an INTRINSIC source leaf against
 * ({@link secret-redaction.redactSecretsForState}), and a list holding only the
 * ssm half cannot name the losing member of a collapsed
 * secretsmanager/secretsmanager pair. Recording every kind is what makes the
 * set mean what its name says. It changes no verdict here: every arm that reads
 * it for secret-ness already answers `true` on a `secretsmanager` spelling
 * before consulting it.
 *
 * The store lives in `secret-redaction.ts` rather than here (issue
 * [#1910](https://github.com/go-to-k/cdkd/issues/1910)) because the redaction
 * path is the other consumer: one set in the LEAF module means the redactor can
 * answer with no caller threading it, and the resolver reaches it along an
 * import edge it already has — the reverse would close a cycle.
 *
 * The resolver no longer reads or writes it through this facade (issue
 * [#4105](https://github.com/go-to-k/cdkd/issues/4105)): `pinSecretVerdict`
 * files each verdict under the resolver's SCOPE (region + credential
 * identity) and `isKnownSecret` reads only that scope, since another region's
 * `SecureString` under the same parameter name says nothing about this one.
 * Only `clear` is left here: an unscoped `add` / `delete` would write the
 * bare set behind the scoped half's back.
 */
export const recordedSecretExpressions = {
  clear: (): void => clearRecordedSecretExpressions(),
};

/**
 * Cache for EC2 instance attributes that require a live DescribeInstances
 * lookup (PrivateIp / PublicIp / PrivateDnsName / PublicDnsName /
 * AvailabilityZone). Keyed by `${physicalId}#${attributeName}`. The IP /
 * DNS attributes are not derivable from the instance id, so they are read
 * back from AWS once per (instance, attribute) and memoized for the PROCESS
 * lifetime — one `cdkd deploy` per CLI process, so "the deploy" in practice;
 * nothing in `src/` calls `resetAccountInfoCache`, tests do. Only a VALUE is cached — a settled instance's address, or the
 * known-empty `''` a settled instance reports for a public member it has
 * none of — never a refusal: a `pending` instance is re-described on the
 * next resolution, when it may have settled (issue #3096).
 */
export const cachedEc2InstanceAttributes: Record<string, string> = Object.create(null) as Record<
  string,
  string
>;

/**
 * The three sibling caches of {@link cachedEc2InstanceAttributes} (issues
 * #3096 / #3097), each holding a value the resolver read LIVE because the
 * state record omitted it — `definedAttributes` drops a member the provider
 * could not read back (issue #3077), so the `Fn::GetAtt` falls out of the
 * flat lookup and into `constructAttribute`'s per-type arm. Keyed by physical
 * id: the read is region-pinned (`clientsForRegion(this.explicitRegion)`),
 * so the key names one resource in that region, and the value — a default
 * security group id, a distribution hostname, a security group's VPC —
 * never changes; like the instance cache, a refusal caches nothing. Same
 * process lifetime, cleared together with it by {@link resetAccountInfoCache}.
 * The RDS `DBProxy` / `DBProxyEndpoint` `VpcId` arms have no cache because
 * they have no live read: `AwsClients` exposes no RDS client and this file
 * imports none, so those two arms refuse outright (see
 * `refuseUnservedAttribute`'s callers).
 *
 * All four are NULL-PROTOTYPE objects (#3096 delta review, measured): the
 * key is a state-record physical id, and on a plain `{}` a record holding
 * `constructor` / `__proto__` / `hasOwnProperty` read a FUNCTION out of
 * `Object.prototype` as the cached value — served with zero AWS calls, ahead
 * of every shape guard below. `Object.create(null)` has nothing to read; the
 * `delete`-based clears in `resetAccountInfoCache` keep the prototype.
 */
export const cachedVpcDefaultSecurityGroups: Record<string, string> = Object.create(null) as Record<
  string,
  string
>;
export const cachedCloudFrontDomainNames: Record<string, string> = Object.create(null) as Record<
  string,
  string
>;
export const cachedSecurityGroupVpcIds: Record<string, string> = Object.create(null) as Record<
  string,
  string
>;
