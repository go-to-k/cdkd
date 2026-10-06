import {
  carriesDynamicReference,
  cfnRefValueFromPhysicalId,
  isImpossibleEmptyStoredAttribute,
  isStalePlaceholderArnAttribute,
  refStateLookupFromResource,
} from '../deployment/intrinsic-function-resolver.js';
import { carriesSecretMask, SECRET_MASK } from '../deployment/secret-redaction.js';
import { displayIdent, displaySafe } from '../utils/display-safe.js';
import type { ProviderRegistry } from '../provisioning/provider-registry.js';
import type { ResourceState, StackState } from '../types/state.js';
import { getLogger } from '../utils/logger.js';
import { isSensitiveAttributeName } from '../utils/stringify.js';
import { isCustomResourceType } from '../provisioning/custom-resource-secure-references.js';
import { injectiveKey } from '../state/record-keys.js';
import { isReadableBag } from '../types/state.js';
import { isReadableResourceEntry } from '../state/malformed-resources-bag.js';

/**
 * Why a reference to an orphaned record that is NOT a readable resource record
 * is left in place rather than resolved (go-to-k/cdkd#3350).
 *
 * `cdkd orphan` may drop such a record — refusing to would close the way out of
 * it — but it must not resolve THROUGH one. Measured before this guard: a
 * string or number record made a sibling's `{"Ref": O}` resolve to `undefined`,
 * which the save then dropped from the JSON, and its `Fn::Sub` `${O}` became
 * the literal `x-undefined`. Reported as unresolvable instead, so a plain run
 * aborts naming the site and `--force` leaves the intrinsic untouched — there
 * is no cached value to fall back to either, since the cache lives inside the
 * record that cannot be read.
 */
const UNREADABLE_ORPHAN_RECORD_REASON =
  "the orphaned resource's state record is not a readable resource record (not an object, " +
  'no resource type, or no physical id), so nothing in it can be substituted';

/**
 * Whether the fetcher may read an orphaned record at all: the ENTRY class's
 * predicate PLUS a non-empty string `physicalId`. The entry predicate stops at
 * `resourceType` on purpose (its own note), but every LIVE value this fetcher
 * produces is derived from the physical id — `{"resourceType": "T"}` alone
 * made `{"Ref": O}` resolve to `undefined` and `Fn::Sub` to `x-undefined`
 * exactly as a string record did, and a type whose `Ref` recovery reads the id
 * threw a bare `TypeError` (review of go-to-k/cdkd#3568). The `--force` cache
 * is skipped for such a record too, deliberately: a record with no identity is
 * not one whose cached values can be trusted to describe a live resource.
 */
function isResolvableOrphanRecord(entry: unknown): boolean {
  if (!isReadableResourceEntry(entry)) return false;
  const physicalId = (entry as { physicalId?: unknown }).physicalId;
  return typeof physicalId === 'string' && physicalId !== '';
}

/**
 * One rewrite the orphan rewriter has applied (or wanted to apply but
 * couldn't). Rendered as the audit table that `cdkd orphan` prints before
 * (and during) state save.
 *
 * - `kind: 'ref'` — a `{Ref: O}` was replaced with the value CFn's `Ref`
 *   returns for O (its physicalId for most types; see
 *   {@link cfnRefValueFromPhysicalId} for the exceptions).
 * - `kind: 'getAtt'` — a `{Fn::GetAtt: [O, attr]}` (array OR string form)
 *   was replaced with the attribute value: the recorded one when servable,
 *   otherwise a live read.
 * - `kind: 'sub'` — an `${O}` or `${O.attr}` placeholder inside an
 *   `Fn::Sub` template string was substituted in place. The substituted
 *   sub-template (rather than the whole Fn::Sub block) is recorded so the
 *   audit row shows exactly what changed.
 * - `kind: 'dependency'` — the orphan's logicalId was removed from the
 *   `dependencies` array of another resource.
 *
 * `before` and `after` are JSON-serializable snapshots; the CLI renders
 * them as `JSON.stringify(value)` in the audit table.
 */
export interface OrphanRewrite {
  /** logicalId of the resource whose state was rewritten. */
  logicalId: string;
  /** Dotted JSON-pointer-ish path within the resource (e.g. `properties.Bucket`). */
  path: string;
  kind: 'ref' | 'getAtt' | 'sub' | 'dependency';
  before: unknown;
  after: unknown;
  /**
   * logicalId of the orphan that this rewrite resolved. Useful for the
   * audit table header ("rewrites caused by orphaning O") and for
   * grouping unresolvable-attribute errors by orphan.
   */
  orphanLogicalId: string;
}

/**
 * One reference to an orphan that the rewriter could not resolve.
 *
 * Collected up front (rather than thrown immediately) so a single failed
 * orphan run can list every unresolvable site at once instead of forcing
 * the user through one fix-rerun-fix cycle per attribute.
 */
export interface UnresolvableReference {
  /** logicalId of the resource that holds the unresolvable reference. */
  logicalId: string;
  path: string;
  /** logicalId of the orphan whose attribute could not be fetched. */
  orphanLogicalId: string;
  /** The CFn attribute name (`Arn`, `Ref`, `WebsiteURL`, …). `Ref` for `{Ref: O}` and Fn::Sub `${O}`. */
  attribute: string;
  /** Human-readable reason. */
  reason: string;
}

/**
 * Result of {@link rewriteResourceReferences}.
 *
 * `state` is a brand-new `StackState` value (input is not mutated). When
 * `unresolvable` is non-empty the caller decides whether to abort
 * (default) or to fall back to cached attributes via `--force`. The
 * `rewrites` audit log is always populated even on failure so users see
 * what _would_ have changed.
 */
export interface OrphanRewriteResult {
  state: StackState;
  rewrites: OrphanRewrite[];
  unresolvable: UnresolvableReference[];
}

/**
 * Caller-supplied options that control how unresolvable references are
 * handled.
 *
 * - `force = false` (default): unresolvable references are collected and
 *   returned via `unresolvable`; the caller is expected to abort.
 * - `force = true`: the rewriter consults the orphan's
 *   `state.attributes` cache as a fallback. If the cache holds a value
 *   for the attribute, the original intrinsic is replaced with that
 *   value and a warning is logged. If the cache also lacks the attr,
 *   the rewriter leaves the original intrinsic untouched (it does NOT
 *   substitute a literal `undefined` / `null`) and surfaces the site
 *   via `unresolvable` for visibility.
 */
export interface OrphanRewriteOptions {
  force?: boolean;
}

/**
 * Attributes whose recorded VALUE is a secret although their NAME does not
 * pass `isSensitiveAttributeName` — so the name rule cannot see them. Keyed by
 * resource type, read by own key. `AWS::AppSync::ApiKey`'s `ApiKey` is the
 * `x-api-key` value itself, recorded in plaintext at create.
 * `AWS::EC2::IpamExternalResourceVerificationToken`'s `TokenValue` is a
 * credential Cloud Control records in plaintext (`cloud-control-provider.ts`);
 * that type has no `getAttribute`, so every read of it reaches `--force`'s
 * cache fallback. `AWS::IVS::StreamKey`'s `Value` is the stream key itself
 * (Cloud-Control-routed; `docs/_generated/provider-coverage.json` lists it).
 */
const SECRET_VALUED_ATTRIBUTES: ReadonlyMap<string, readonly string[]> = new Map([
  ['AWS::AppSync::ApiKey', ['ApiKey']],
  ['AWS::EC2::IpamExternalResourceVerificationToken', ['TokenValue']],
  ['AWS::IVS::StreamKey', ['Value']],
]);

/**
 * Whether any OBJECT KEY inside `value`, at any depth, is credential-named: an
 * attribute that is itself innocently named can hold a `{Password: ...}` leaf,
 * and serving it whole would print that leaf in the audit table.
 */
function carriesSensitiveNamedLeaf(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  // An array's entries are its index keys, never sensitive; its elements recurse.
  return Object.entries(value).some(
    ([key, leaf]) => isSensitiveAttributeName(key) || carriesSensitiveNamedLeaf(leaf)
  );
}

/**
 * The orphan's RECORDED value for `attribute`, when the record holds one the
 * deploy-time resolver would serve as-is (go-to-k/cdkd#4186).
 *
 * GATED ON A LIVE ANSWER. The caller takes this value only after the live
 * read returned a defined value for the same attribute, so it never widens
 * what the live-read-only path could substitute and print; see the call site.
 *
 * WHY RECORDED OVER LIVE. `IntrinsicFunctionResolver.resolveGetAtt` serves a
 * `Fn::GetAtt` from this same `attributes` map whenever it holds the key, so
 * this chooses the same value the resolver would — not necessarily the value
 * a rewritten sibling was deployed with (a row still holding its intrinsic
 * never went through the resolver), and not necessarily the value AWS holds
 * today for an attribute AWS changes later (an instance's `PublicIp`). The
 * live `provider.getAttribute(...)` read is addressed by the recorded NAME for
 * most SDK providers, so after the resource was deleted out of band and a
 * DIFFERENT one took its name — the situation `cdkd orphan` is the documented
 * remedy for — it answered with the FOREIGN resource's attribute and planted
 * that into the dependents' state.
 *
 * NOT SERVED, so the live answer (or, when there is none, `--force`'s
 * fallback) still decides,
 * mirroring each arm on which the resolver does not serve the stored value
 * verbatim either:
 * - an absent key, or `''` where `isImpossibleEmptyStoredAttribute` says the
 *   resource cannot hold it — the record predates the attribute;
 * - `AWS::EC2::VPC` `Ipv6CidrBlocks`, which the resolver never serves stored
 *   (an association after the create leaves the recorded list stale);
 * - a pre-#1681 placeholder ARN (`isStalePlaceholderArnAttribute`), which the
 *   resolver heals by a re-read;
 * - a value carrying the redaction mask (`SECRET_MASK`): it is all cdkd kept of
 *   the value, and a mask must never become a sibling's property, on this
 *   path or through `--force`'s fallback (go-to-k/cdkd#4602);
 * - a value carrying a `{{resolve:...}}` reference (a nested stack's redacted
 *   output, issue #2055), which the resolver re-resolves in a context this
 *   analyzer pass does not have.
 *
 * And the classes whose recorded value may be a SECRET PLAINTEXT, so it must
 * not replace the live answer — the rewrite audit table prints every
 * substituted value at default verbosity, and the live answer is what the
 * pre-#4186 path printed. (The live-answer gate already keeps a provider that
 * cannot answer, e.g. Cloud Control's whole-model record, out of here.)
 * - an attribute whose NAME is credential-bearing (`isSensitiveAttributeName`,
 *   the predicate the resolver's log redaction uses): `AWS::IAM::AccessKey`
 *   records `SecretAccessKey` in plaintext, and no mask covers it;
 * - every attribute of a custom resource, whose `Data` names certify nothing
 *   and which a record written before `NoEcho` masking holds in plaintext;
 * - an attribute in {@link SECRET_VALUED_ATTRIBUTES}, a secret the name rule
 *   cannot see, and a value holding a credential-named leaf at any depth.
 * The one reshaping the resolver applies is applied too: a legacy
 * comma-joined Route 53 `NameServers` string becomes the list it stands for.
 * The dotted-path walk over a nested `attributes` object (issue #381) is the
 * resolver's second served arm and is mirrored, OWN keys only.
 */
function servableRecordedAttribute(
  orphan: ResourceState,
  attribute: string
): { served: true; value: unknown } | { served: false } {
  if (
    (orphan.resourceType === 'AWS::EC2::VPC' && attribute === 'Ipv6CidrBlocks') ||
    isSensitiveAttributeName(attribute) ||
    isCustomResourceType(orphan.resourceType) ||
    SECRET_VALUED_ATTRIBUTES.get(orphan.resourceType)?.includes(attribute)
  ) {
    return { served: false };
  }
  const bag: unknown = orphan.attributes;
  // An unreadable map holds nothing; `--force`'s fallback says why.
  if (bag === undefined || !isReadableBag(bag)) return { served: false };
  const attributes = bag as Record<string, unknown>;
  const stored = Object.hasOwn(attributes, attribute) ? attributes[attribute] : undefined;
  let value = isImpossibleEmptyStoredAttribute(orphan.resourceType, attribute, stored)
    ? undefined
    : stored;
  if (value !== undefined) {
    if (isStalePlaceholderArnAttribute(orphan.resourceType, attribute, value)) {
      return { served: false };
    }
    if (
      orphan.resourceType === 'AWS::Route53::HostedZone' &&
      attribute === 'NameServers' &&
      typeof value === 'string'
    ) {
      value = value === '' ? [] : value.split(',');
    }
  } else if (attribute.includes('.')) {
    let cursor: unknown = attributes;
    for (const part of attribute.split('.')) {
      if (cursor !== null && typeof cursor === 'object' && Object.hasOwn(cursor, part)) {
        cursor = (cursor as Record<string, unknown>)[part];
      } else {
        cursor = undefined;
        break;
      }
    }
    value = cursor;
  }
  if (
    value === undefined ||
    carriesSecretMask(value) ||
    carriesDynamicReference(value) ||
    carriesSensitiveNamedLeaf(value)
  ) {
    return { served: false };
  }
  return { served: true, value };
}

/**
 * Why `--force`'s cache fallback must NOT splice `cached` for `attribute` of a
 * `resourceType` record, or `undefined` when it may. The same classes
 * {@link servableRecordedAttribute} refuses to serve, minus the two that are
 * about staleness rather than secrecy (go-to-k/cdkd#4602).
 */
function unsplicableCachedAttribute(
  resourceType: string,
  attribute: string,
  cached: unknown
): string | undefined {
  if (isSensitiveAttributeName(attribute)) return 'a credential-named attribute';
  if (isCustomResourceType(resourceType)) return "a custom resource's attribute";
  if (SECRET_VALUED_ATTRIBUTES.get(resourceType)?.includes(attribute)) {
    return 'a secret-valued attribute';
  }
  if (carriesSecretMask(cached)) return `the redaction mask ('${SECRET_MASK}')`;
  if (carriesDynamicReference(cached)) return 'an unresolved dynamic reference';
  if (carriesSensitiveNamedLeaf(cached)) return 'a value with a credential-named field';
  return undefined;
}

/**
 * Attribute resolver for one orphan resource: the RECORDED value when the
 * record holds a servable one ({@link servableRecordedAttribute}), otherwise a
 * live `provider.getAttribute(...)` read. Memoizes results so multiple
 * references to the same `(orphan, attr)` pair only hit AWS once.
 *
 * Exposed as a class so the unit tests can plug in a fake registry
 * without faking the AWS SDK.
 */
class AttributeFetcher {
  private cache = new Map<string, unknown>();
  private logger = getLogger().child('OrphanRewriter');
  private orphans: Record<string, ResourceState>;
  private providerRegistry: ProviderRegistry;
  private options: OrphanRewriteOptions;

  constructor(
    orphans: Record<string, ResourceState>,
    providerRegistry: ProviderRegistry,
    options: OrphanRewriteOptions
  ) {
    this.orphans = orphans;
    this.providerRegistry = providerRegistry;
    this.options = options;
  }

  /**
   * Return the orphan's resolved value for `Ref` — never needs an AWS call.
   * Uses the shared {@link cfnRefValueFromPhysicalId} so types whose CFn `Ref`
   * is NOT the raw physical id (compound `<parent>|<child>` CC ids, ARN-stored
   * SDK ids like `AWS::Events::Rule`) substitute the same value CloudFormation
   * would have resolved.
   *
   * IT CAN FAIL, and the one failure is a REDACTED recovery key (issue
   * [#2847](https://github.com/go-to-k/cdkd/issues/2847), security review of
   * the fix round). For a handful of types CFn's `Ref` is a value stored in
   * `properties` / `attributes` rather than the physical id, and `cdkd import`
   * now masks any such key it cannot certify is a read-only attribute. The
   * lookup refuses to serve a mask, so the fall-through emits the RAW PHYSICAL
   * ID — for a Cloud-Control-routed `AWS::S3Tables::Table` a bare `TableARN`
   * ending in a UUID, not the table name — and that value would be spliced into
   * a sibling's persisted properties where NOTHING recognises it.
   *
   * That last clause is why this returns a result rather than a string. Before
   * the lookup learned to refuse a mask it returned the literal `'***'`, which
   * four unchanged readers DO recognise (`refuseMaskedReplayBaseline`, the
   * `cdkd export` blocker, drift's mask handling, the deploy-time refusal) — so
   * silently taking the fall-through here would have traded a guarded sentinel
   * for an unguarded wrong value, which is a worse outcome than the one the
   * refusal exists to prevent.
   *
   * ## `--force` does not change that
   *
   * The `--force` arm used to substitute {@link SECRET_MASK} (never the
   * physical id, which would be an unguarded wrong value: `cdkd orphan
   * --force` over a CC-imported `AWS::S3Tables::Table` whose `TableName` is
   * masked once wrote `arn:aws:s3tables:…/<uuid>` into a sibling). Splicing
   * the mask is still the #1498 corrupted-write class, so since
   * go-to-k/cdkd#4602 both arms refuse it, as {@link cacheFallback} refuses a
   * masked cached attribute: the `Ref` stays in place and the site is reported
   * unresolved, which `--force` lets the run complete over.
   */
  ref(orphanLogicalId: string): { ok: true; value: string } | { ok: false; reason: string } {
    if (!Object.hasOwn(this.orphans, orphanLogicalId)) {
      throw new Error(
        `Internal: Ref to '${orphanLogicalId}' has no orphan entry — should have been filtered out`
      );
    }
    const o = this.orphans[orphanLogicalId]!;
    // Before any read of it, and whatever `--force` says: see the constant.
    if (!isResolvableOrphanRecord(o)) {
      return { ok: false, reason: UNREADABLE_ORPHAN_RECORD_REASON };
    }
    let maskedKey: string | undefined;
    const value = cfnRefValueFromPhysicalId(
      o.resourceType,
      o.physicalId,
      refStateLookupFromResource(o, (key) => {
        maskedKey = key;
      })
    );
    if (maskedKey === undefined) {
      return { ok: true, value };
    }
    // SANITISED as DEFENCE IN DEPTH, and the comment says which because a
    // reviewer's trace refuted the obvious reason. `reason` does reach
    // `logger.warn` below AND the unresolvable table, both default verbosity,
    // and `resourceType` is template text cdkd never validates — but a HOSTILE
    // one cannot arrive HERE: `onMaskedValue` fires only from inside
    // `cfnRefValueFromPhysicalId`'s recovery branches, and every one of them
    // is gated on an exact literal (`=== 'AWS::S3Tables::Table'`,
    // `=== 'AWS::Glue::Table'`, `=== 'AWS::Route53::RecordSet'`,
    // `=== 'AWS::Backup::BackupSelection'`,
    // `=== 'AWS::CodeCommit::Repository'`, or a `REF_RETURNS_ARN_FROM_STATE`
    // Map lookup), so by construction this
    // value is one of a handful of cdkd literals. Kept because it costs
    // nothing and a future branch matched by PREFIX would make it live; NOT
    // fenced, because a case proving it would have to fake a reachability that
    // does not exist.
    const safeType = displaySafe(o.resourceType, { asciiOnly: true });
    const reason =
      `the redaction mask: state records '${SECRET_MASK}' for '${maskedKey}', the key ` +
      `CloudFormation's Ref returns for ${safeType} — cdkd cannot recover it, and the ` +
      `physical id is NOT that value`;
    // Refused with or without `--force` (go-to-k/cdkd#4602); the reason leads
    // with the class, as `cacheFallback`'s refusal names its own.
    return { ok: false, reason };
  }

  /**
   * Return the orphan's resolved value for `Fn::GetAtt`: the recorded value
   * when {@link servableRecordedAttribute} serves one, otherwise a live
   * provider read on first call; subsequent calls reuse the memoized result.
   *
   * Returns `{ ok: true, value }` on success; `{ ok: false, reason }`
   * when the live fetch failed AND the `--force` cache fallback either
   * was disabled or also lacked the attribute. In the cache-fallback
   * success path returns `{ ok: true, value, fromCache: true }`.
   */
  async getAtt(
    orphanLogicalId: string,
    attribute: string
  ): Promise<{ ok: true; value: unknown; fromCache?: boolean } | { ok: false; reason: string }> {
    // ENCODED, not separated (go-to-k/cdkd#3496). The second half is an
    // `Fn::GetAtt` ATTRIBUTE name -- everything after the first dot, so it is
    // not even a logical id -- and the first is a key of an unchecked bag.
    const cacheKey = injectiveKey(orphanLogicalId, attribute);
    if (this.cache.has(cacheKey)) {
      return { ok: true, value: this.cache.get(cacheKey) };
    }

    if (!Object.hasOwn(this.orphans, orphanLogicalId)) {
      return {
        ok: false,
        reason: `Internal: GetAtt to '${orphanLogicalId}' has no orphan entry`,
      };
    }
    const orphan = this.orphans[orphanLogicalId]!;
    // ABOVE the provider lookup and the `--force` cache fallback alike: both
    // read fields of the record, and the fallback would index its `attributes`.
    if (!isResolvableOrphanRecord(orphan)) {
      return { ok: false, reason: UNREADABLE_ORPHAN_RECORD_REASON };
    }

    // RECORDED OVER A LIVE ANSWER (go-to-k/cdkd#4186): see `servableRecordedAttribute`.
    // Taken only AFTER the live read below answered with a defined value, so
    // the set of attributes this can substitute (and the audit table prints)
    // is exactly the set the live-read-only path already substituted. A
    // provider with no `getAttribute` (every Cloud-Control-routed record, whose
    // `attributes` is the whole resource model, some of it credentials no
    // name rule can recognise) or a live read that fails keeps its pre-#4186
    // outcome: unresolvable without `--force`.
    const recorded = servableRecordedAttribute(orphan, attribute);

    let provider;
    try {
      // Route via state-recorded `provisionedBy` (#614 schema v7+) so a
      // CC-managed orphan resolves Fn::GetAtt through Cloud Control's
      // getAttribute. Pre-v7 state has `provisionedBy: undefined` which
      // preserves legacy SDK routing.
      provider = this.providerRegistry.getProviderFor({
        resourceType: orphan.resourceType,
        provisionedBy: orphan.provisionedBy,
      }).provider;
    } catch (err) {
      return {
        ok: false,
        reason: `no provider available for ${orphan.resourceType}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!provider.getAttribute) {
      return this.cacheFallback(
        orphanLogicalId,
        attribute,
        `provider for ${orphan.resourceType} does not implement getAttribute`
      );
    }

    try {
      const value = await provider.getAttribute(
        orphan.physicalId,
        orphan.resourceType,
        attribute,
        orphanLogicalId
      );
      if (value === undefined) {
        return this.cacheFallback(
          orphanLogicalId,
          attribute,
          `provider returned undefined for ${orphan.resourceType}.${attribute}`
        );
      }
      // The live holder answered, so the attribute was already printable on
      // this path. Take the RECORDED value when there is one: after a name
      // takeover the answer describes the newcomer.
      const chosen = recorded.served ? recorded.value : value;
      this.cache.set(cacheKey, chosen);
      return { ok: true, value: chosen };
    } catch (err) {
      return this.cacheFallback(
        orphanLogicalId,
        attribute,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  /**
   * Try the orphan's `state.attributes[attribute]` as a last-resort value
   * source under `--force`. Without `--force`, returns the original
   * failure reason unchanged (caller pushes to `unresolvable`).
   */
  private cacheFallback(
    orphanLogicalId: string,
    attribute: string,
    reason: string
  ): { ok: true; value: unknown; fromCache: true } | { ok: false; reason: string } {
    if (!this.options.force) {
      return { ok: false, reason };
    }
    const orphan = this.orphans[orphanLogicalId]!;
    // An unreadable cache holds NOTHING, and is not indexed (go-to-k/cdkd#3345).
    // `attribute` comes from the SURVIVING record's stored `Fn::GetAtt`, so
    // indexing a list or a string answers for keys the cache does not hold —
    // measured: `attributes: ["v"]` served `'v'` for attribute `0`, and
    // `"abcdef"` served `'a'` for `0` and `6` for `length`, each spliced into
    // the sibling's persisted properties for the next deploy to send to AWS.
    // `null` already read as absent through the `?.`; it takes this arm now so
    // the warning says why. The run still continues under `--force`: the
    // intrinsic is left in place, the documented outcome of an empty cache.
    const bag: unknown = orphan.attributes;
    if (bag !== undefined && !isReadableBag(bag)) {
      this.logger.warn(
        `--force: state.attributes of ${displayIdent(orphanLogicalId)} is ` +
          `not a readable map, so it is not consulted for ` +
          `${displayIdent(attribute)}; leaving the original intrinsic in place.`
      );
      return {
        ok: false,
        reason: `${reason}; the state.attributes cache is not a readable map`,
      };
    }
    // OWN keys only, for the same reason: the name is template text, and a
    // readable map still answers `constructor` / `toString` / `__proto__` from
    // its prototype — measured, each spliced a function or `{}` into the
    // sibling's saved properties (review of go-to-k/cdkd#3568). The resolver's
    // own cached-attribute read has taken `Object.hasOwn` since issue #2767.
    const stored =
      bag !== undefined && Object.hasOwn(bag as object, attribute)
        ? (bag as Record<string, unknown>)[attribute]
        : undefined;
    // The resolver's flat lookup and this fallback are the two readers of a
    // stored attribute; both read a value the resource can never hold (a
    // security group's `VpcId: ''`, written by a pre-#3097 binary) as ABSENT,
    // or `--force` would splice `''` into the referring resource as its VPC.
    const cached = isImpossibleEmptyStoredAttribute(orphan.resourceType, attribute, stored)
      ? undefined
      : stored;
    if (cached === undefined) {
      this.logger.warn(
        `--force: state.attributes also lacks '${orphanLogicalId}.${attribute}'; leaving the original intrinsic in place.`
      );
      return {
        ok: false,
        reason: `${reason}; state.attributes cache also has no value for '${attribute}'`,
      };
    }
    // A cached value `servableRecordedAttribute` would not serve is not
    // spliced here either (go-to-k/cdkd#4602): the splice lands in the
    // referring resource's PERSISTED properties and `printRewriteSummary`
    // logs it at info, so a plaintext credential (`AWS::IAM::AccessKey`'s
    // `SecretAccessKey`, a custom resource's `Data`, a credential-named leaf)
    // would be written to state and printed; and `SECRET_MASK` or an
    // unresolved `{{resolve:...}}` is not the value at all, so the next deploy
    // would send it to AWS (the #1498 corrupted-write class). The intrinsic is
    // left in place and the site reported unresolved, as for an empty cache.
    const refusal = unsplicableCachedAttribute(orphan.resourceType, attribute, cached);
    if (refusal !== undefined) {
      this.logger.warn(
        `--force: the cached value for ${displayIdent(orphanLogicalId)}.${displayIdent(attribute)} ` +
          `is ${refusal}, so it is not written into the referring resource; leaving the ` +
          `original intrinsic in place.`
      );
      return {
        ok: false,
        reason: `${reason}; the state.attributes cache holds ${refusal}, which --force does not splice`,
      };
    }
    this.logger.warn(
      `--force: live fetch failed for '${orphanLogicalId}.${attribute}' (${reason}); ` +
        `falling back to cached value from state.attributes.`
    );
    const cacheKey = injectiveKey(orphanLogicalId, attribute);
    this.cache.set(cacheKey, cached);
    return { ok: true, value: cached, fromCache: true };
  }
}

/**
 * Rewrite every reference to the orphan resources in the rest of the
 * stack state, returning a NEW `StackState` (the input is treated as
 * immutable so callers can take a pre-orphan snapshot before invoking
 * this).
 *
 * Behavior is the inverse of `IntrinsicFunctionResolver`: the resolver
 * substitutes intrinsic functions when *deploying* a template; the
 * orphan rewriter substitutes them in *already-deployed state* so cdkd
 * forgets the orphan exists without breaking sibling resources that
 * still reference it.
 *
 * The rewriter handles the four reference shapes that show up in
 * persisted state:
 *
 * 1. `{Ref: O}` → orphan.physicalId
 * 2. `{Fn::GetAtt: [O, attr]}` → the orphan's recorded `attributes[attr]`
 *    when servable (go-to-k/cdkd#4186), else live `provider.getAttribute(...)`
 * 3. `{Fn::GetAtt: "O.attr"}` (string form) → same as #2
 * 4. `Fn::Sub` template strings — `${O}` and `${O.attr}` placeholders
 *    are substituted in place; unrelated placeholders are preserved.
 *
 * Plus dependency-array entries equal to an orphan logicalId are
 * removed.
 *
 * If `options.force` is false (the default), any unresolvable
 * `Fn::GetAtt` (provider error, missing impl, undefined return) is
 * collected and returned via `unresolvable` instead of being fixed up;
 * the caller is expected to abort. With `--force`, unresolvable
 * fetches fall back to the orphan's cached `state.attributes` and emit
 * a warning per case; if the cache also lacks the attr, the original
 * intrinsic is left alone (NOT replaced with `undefined`/`null`).
 *
 * Multi-orphan circular references are handled by reading every
 * `Ref` / `GetAtt` from the *original* orphan snapshot rather than
 * the in-flight rewritten state, so orphan A's reference to orphan B
 * still resolves cleanly to B's pre-removal physicalId.
 */
export async function rewriteResourceReferences(
  state: StackState,
  orphanLogicalIds: string[],
  providerRegistry: ProviderRegistry,
  options: OrphanRewriteOptions = {}
): Promise<OrphanRewriteResult> {
  const orphanSet = new Set(orphanLogicalIds);

  // Snapshot the orphan resources so multi-orphan circular refs (orphan A
  // references orphan B and vice versa) resolve against original state,
  // not against the in-flight rewrites.
  //
  // PRESENCE is `Object.hasOwn`, not truthiness: a `null` entry IS in the map,
  // and `cdkd orphan` over it is the way out of it (go-to-k/cdkd#3350) — the
  // falsy test threw this internal error instead. What the fetcher then does
  // with a record it cannot read is `UNREADABLE_ORPHAN_RECORD_REASON`'s.
  const orphans: Record<string, ResourceState> = Object.create(null);
  for (const id of orphanLogicalIds) {
    if (!Object.hasOwn(state.resources, id)) {
      throw new Error(`rewriteResourceReferences: orphan '${id}' not found in state.resources`);
    }
    orphans[id] = state.resources[id]!;
  }

  const fetcher = new AttributeFetcher(orphans, providerRegistry, options);
  const rewrites: OrphanRewrite[] = [];
  const unresolvable: UnresolvableReference[] = [];

  // Build the new resources map, skipping the orphans themselves.
  const newResources: Record<string, ResourceState> = {};
  for (const [logicalId, resource] of Object.entries(state.resources ?? {})) {
    if (orphanSet.has(logicalId)) continue;

    const rewrittenProperties = await rewriteValue(
      resource.properties as unknown,
      `properties`,
      logicalId,
      orphanSet,
      fetcher,
      rewrites,
      unresolvable
    );

    const rewrittenAttributes = resource.attributes
      ? await rewriteValue(
          resource.attributes as unknown,
          `attributes`,
          logicalId,
          orphanSet,
          fetcher,
          rewrites,
          unresolvable
        )
      : undefined;

    const newDeps = (resource.dependencies ?? []).filter((dep) => {
      if (orphanSet.has(dep)) {
        rewrites.push({
          logicalId,
          path: 'dependencies',
          kind: 'dependency',
          before: dep,
          after: null,
          orphanLogicalId: dep,
        });
        return false;
      }
      return true;
    });

    newResources[logicalId] = {
      ...resource,
      properties: rewrittenProperties as Record<string, unknown>,
      ...(rewrittenAttributes !== undefined && {
        attributes: rewrittenAttributes as Record<string, unknown>,
      }),
      dependencies: newDeps,
    };
  }

  // Outputs may also reference the orphan (e.g. CDK output { Value: { Ref: O } }).
  const newOutputs: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(state.outputs ?? {})) {
    newOutputs[name] = await rewriteValue(
      value,
      `outputs.${name}`,
      `<output:${name}>`,
      orphanSet,
      fetcher,
      rewrites,
      unresolvable
    );
  }

  // `skippedOutputs` (issue #2740) is DROPPED rather than carried, as
  // `cdkd import`, `cdkd drift --accept` and `cdkd rollback` drop it. This
  // rewrite substitutes FETCHED values into `properties`, `attributes` and
  // `outputs`, and a substitution alone can repair an output: an attribute
  // holding `{ "Fn::GetAtt": ["O", "NameServers"] }` makes an enclosing
  // `Fn::Select` fail, and replacing it with the fetched array makes that
  // output resolve — with the output's own digest unmoved and no template
  // resource change for the diff's change map to un-bind on. Carried, the
  // record would preview a key as absent while the next deploy publishes it.
  const { skippedOutputs: _droppedByOrphanRewrite, ...carriedState } = state;
  return {
    state: {
      ...carriedState,
      resources: newResources,
      outputs: newOutputs,
      lastModified: Date.now(),
    },
    rewrites,
    unresolvable,
  };
}

/**
 * Recursively walk a value (property tree, attribute tree, output value)
 * and replace every `Ref` / `Fn::GetAtt` / `Fn::Sub` reference to an
 * orphan with the orphan's resolved physical id / attribute value /
 * substituted template string respectively.
 *
 * Mirrors the recursion structure of `IntrinsicFunctionResolver` but
 * works in the inverse direction: only orphan references are substituted,
 * every other intrinsic is left intact (the deploy engine will resolve
 * those again on the next deploy).
 */
export async function rewriteReferencesInValue(
  value: unknown,
  pathPrefix: string,
  ownerLogicalId: string,
  orphanSet: Set<string>,
  fetcher: AttributeFetcher,
  rewrites: OrphanRewrite[],
  unresolvable: UnresolvableReference[]
): Promise<unknown> {
  return rewriteValue(
    value,
    pathPrefix,
    ownerLogicalId,
    orphanSet,
    fetcher,
    rewrites,
    unresolvable
  );
}

async function rewriteValue(
  value: unknown,
  pathPrefix: string,
  ownerLogicalId: string,
  orphanSet: Set<string>,
  fetcher: AttributeFetcher,
  rewrites: OrphanRewrite[],
  unresolvable: UnresolvableReference[]
): Promise<unknown> {
  // Primitives: no references possible.
  if (typeof value !== 'object' || value === null) return value;

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      out.push(
        await rewriteValue(
          value[i],
          `${pathPrefix}[${i}]`,
          ownerLogicalId,
          orphanSet,
          fetcher,
          rewrites,
          unresolvable
        )
      );
    }
    return out;
  }

  const obj = value as Record<string, unknown>;

  // {Ref: orphanLogicalId} → physicalId.
  // Only when the Ref target is in orphanSet — otherwise leave the
  // intrinsic alone so the deploy engine resolves it on next deploy.
  if ('Ref' in obj && Object.keys(obj).length === 1 && typeof obj['Ref'] === 'string') {
    const target = obj['Ref'];
    if (orphanSet.has(target)) {
      const result = fetcher.ref(target);
      if (!result.ok) {
        // Same shape as the `Fn::GetAtt` arm below: record the site and leave
        // the original intrinsic in place. `attribute` is the literal `Ref`,
        // which the `UnresolvableReference` doc already reserves for this form.
        unresolvable.push({
          logicalId: ownerLogicalId,
          path: pathPrefix,
          orphanLogicalId: target,
          attribute: 'Ref',
          reason: result.reason,
        });
        return value;
      }
      rewrites.push({
        logicalId: ownerLogicalId,
        path: pathPrefix,
        kind: 'ref',
        before: { Ref: target },
        after: result.value,
        orphanLogicalId: target,
      });
      return result.value;
    }
    return value;
  }

  // {Fn::GetAtt: [orphan, attr]} or {Fn::GetAtt: "orphan.attr"}.
  if ('Fn::GetAtt' in obj && Object.keys(obj).length === 1) {
    const arg = obj['Fn::GetAtt'];
    let target: string | undefined;
    let attribute: string | undefined;
    if (
      Array.isArray(arg) &&
      arg.length === 2 &&
      typeof arg[0] === 'string' &&
      typeof arg[1] === 'string'
    ) {
      target = arg[0];
      attribute = arg[1];
    } else if (typeof arg === 'string') {
      const dot = arg.indexOf('.');
      if (dot > 0) {
        target = arg.slice(0, dot);
        attribute = arg.slice(dot + 1);
      }
    }

    if (target && attribute && orphanSet.has(target)) {
      const result = await fetcher.getAtt(target, attribute);
      if (result.ok) {
        rewrites.push({
          logicalId: ownerLogicalId,
          path: pathPrefix,
          kind: 'getAtt',
          before: { 'Fn::GetAtt': [target, attribute] },
          after: result.value,
          orphanLogicalId: target,
        });
        return result.value;
      }
      unresolvable.push({
        logicalId: ownerLogicalId,
        path: pathPrefix,
        orphanLogicalId: target,
        attribute,
        reason: result.reason,
      });
      // Leave original intrinsic in place when unresolvable.
      return value;
    }
    return value;
  }

  // Fn::Sub: scan ${O} and ${O.attr} placeholders that target an orphan;
  // splice in resolved values, preserve unrelated placeholders.
  if ('Fn::Sub' in obj && Object.keys(obj).length === 1) {
    const arg = obj['Fn::Sub'];
    let template: string | undefined;
    let varMap: Record<string, unknown> | undefined;
    if (typeof arg === 'string') {
      template = arg;
    } else if (
      Array.isArray(arg) &&
      arg.length === 2 &&
      typeof arg[0] === 'string' &&
      typeof arg[1] === 'object' &&
      arg[1] !== null
    ) {
      template = arg[0];
      varMap = arg[1] as Record<string, unknown>;
    }

    if (template !== undefined) {
      const { rewritten, didChange, hasUnresolvable } = await rewriteSubTemplate(
        template,
        ownerLogicalId,
        pathPrefix,
        orphanSet,
        fetcher,
        rewrites,
        unresolvable,
        varMap
      );

      if (didChange) {
        // If the rewrite consumed every reference to an orphan, the result
        // can collapse to a plain string. We keep the Fn::Sub wrapper if a
        // non-orphan placeholder remains so the deploy engine can re-resolve
        // it later.
        const stillHasIntrinsics = /\$\{[^}]+\}/.test(rewritten);
        if (varMap && stillHasIntrinsics) {
          return { 'Fn::Sub': [rewritten, varMap] };
        }
        if (stillHasIntrinsics) {
          return { 'Fn::Sub': rewritten };
        }
        return rewritten;
      }
      // No change but unresolvable: leave the Fn::Sub block alone.
      // (hasUnresolvable already pushed the failure into `unresolvable`.)
      void hasUnresolvable;
      return value;
    }
    return value;
  }

  // Plain object: recurse into each key.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = await rewriteValue(
      v,
      pathPrefix === '' ? k : `${pathPrefix}.${k}`,
      ownerLogicalId,
      orphanSet,
      fetcher,
      rewrites,
      unresolvable
    );
  }
  return out;
}

/**
 * Walk a single Fn::Sub template string and replace each `${X}` /
 * `${X.attr}` placeholder that points at an orphan. Unrelated
 * placeholders (refs to non-orphan resources, parameter / pseudo-parameter
 * placeholders) are preserved verbatim so the deploy engine can resolve
 * them on the next deploy.
 */
async function rewriteSubTemplate(
  template: string,
  ownerLogicalId: string,
  pathPrefix: string,
  orphanSet: Set<string>,
  fetcher: AttributeFetcher,
  rewrites: OrphanRewrite[],
  unresolvable: UnresolvableReference[],
  varMap?: Record<string, unknown>
): Promise<{ rewritten: string; didChange: boolean; hasUnresolvable: boolean }> {
  const placeholderRe = /\$\{([^}]+)\}/g;
  const matches = [...template.matchAll(placeholderRe)];
  if (matches.length === 0) {
    return { rewritten: template, didChange: false, hasUnresolvable: false };
  }

  let didChange = false;
  let hasUnresolvable = false;
  // Build the rewritten string by scanning left to right; matchAll preserves
  // index order so we can use match.index reliably.
  let cursor = 0;
  let out = '';
  for (const m of matches) {
    const inner = m[1] ?? '';
    const start = m.index ?? 0;
    out += template.slice(cursor, start);
    cursor = start + m[0].length;

    // Explicit Fn::Sub var map shadows resource references.
    //
    // `in` over the CALLER's plain object, so it answers for an INHERITED name
    // too (`'constructor' in {}` is true). Wherever the writer binds own keys
    // only, this reader therefore shadows one placeholder more than the writer
    // substitutes. RETAINED as the conservative direction (issue #2767, the
    // sweep that made the resolver's resource / parameter / condition / mapping
    // reads own-keys): over-shadowing leaves the reference in the `Fn::Sub` for
    // the deploy engine to re-resolve, while `Object.hasOwn` here would REWRITE
    // a placeholder the writer may treat as bound, changing a live template.
    //
    // The disagreeing population is `constructor` / `toString` / `valueOf` /
    // `hasOwnProperty` and their siblings -- names that are `in` an object
    // without being own. It is NOT `__proto__`, which `JSON.parse` makes an own
    // key and both spellings therefore agree on. `crossStackSourceKey` in
    // `src/deployment/secret-redaction.ts` keeps the same wider test for the
    // same reason; this is the second copy of that decision.
    if (varMap && inner in varMap) {
      out += m[0];
      continue;
    }

    const dot = inner.indexOf('.');
    if (dot < 0) {
      // ${X} — Ref form.
      if (orphanSet.has(inner)) {
        const result = fetcher.ref(inner);
        if (!result.ok) {
          // Mirrors the `${X.attr}` arm below: preserve the placeholder and
          // record the site, so a non-`--force` run aborts instead of splicing
          // a value cdkd knows is wrong.
          unresolvable.push({
            logicalId: ownerLogicalId,
            path: pathPrefix,
            orphanLogicalId: inner,
            attribute: 'Ref',
            reason: result.reason,
          });
          out += m[0];
          hasUnresolvable = true;
        } else {
          rewrites.push({
            logicalId: ownerLogicalId,
            path: pathPrefix,
            kind: 'sub',
            before: m[0],
            after: result.value,
            orphanLogicalId: inner,
          });
          out += result.value;
          didChange = true;
        }
      } else {
        out += m[0];
      }
    } else {
      // ${X.attr} — GetAtt form.
      const target = inner.slice(0, dot);
      const attribute = inner.slice(dot + 1);
      if (orphanSet.has(target)) {
        const result = await fetcher.getAtt(target, attribute);
        if (result.ok) {
          const stringified = String(result.value);
          rewrites.push({
            logicalId: ownerLogicalId,
            path: pathPrefix,
            kind: 'sub',
            before: m[0],
            after: stringified,
            orphanLogicalId: target,
          });
          out += stringified;
          didChange = true;
        } else {
          unresolvable.push({
            logicalId: ownerLogicalId,
            path: pathPrefix,
            orphanLogicalId: target,
            attribute,
            reason: result.reason,
          });
          out += m[0];
          hasUnresolvable = true;
        }
      } else {
        out += m[0];
      }
    }
  }
  out += template.slice(cursor);
  return { rewritten: out, didChange, hasUnresolvable };
}
