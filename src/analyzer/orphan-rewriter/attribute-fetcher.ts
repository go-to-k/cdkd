import {
  cfnRefValueFromPhysicalId,
  isImpossibleEmptyStoredAttribute,
  lacksRecordedRefArn,
  lacksRecordedTableArn,
  refStateLookupFromResource,
} from '../../deployment/intrinsic-function-resolver.js';
import { SECRET_MASK } from '../../deployment/secret-redaction.js';
import { displayIdent, displaySafe } from '../../utils/display-safe.js';
import type { ProviderRegistry } from '../../provisioning/provider-registry.js';
import type { ResourceState } from '../../types/state.js';
import { getLogger } from '../../utils/logger.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { injectiveKey } from '../../state/record-keys.js';
import { isReadableBag } from '../../types/state.js';
import type { OrphanRewriteOptions } from './types.js';
import {
  UNREADABLE_ORPHAN_RECORD_REASON,
  isResolvableOrphanRecord,
  servableRecordedAttribute,
  unsplicableCachedAttribute,
} from './recorded-attributes.js';

/**
 * Attribute resolver for one orphan resource: the RECORDED value when the
 * record holds a servable one ({@link servableRecordedAttribute}), otherwise a
 * live `provider.getAttribute(...)` read. Memoizes results so multiple
 * references to the same `(orphan, attr)` pair only hit AWS once.
 *
 * Exposed as a class so the unit tests can plug in a fake registry
 * without faking the AWS SDK.
 */
export class AttributeFetcher {
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
    // go-to-k/cdkd#5316: a table created before cdkd recorded its `TableARN`
    // (go-to-k/cdkd#739) has no value CloudFormation's `Ref` returns in state,
    // and the composite id is not one. Refused rather than spliced; the deploy
    // re-reads such a record from AWS, this command does not.
    if (lacksRecordedTableArn(o)) {
      return {
        ok: false,
        reason:
          "state records no usable 'TableARN' for this S3 Tables table, the value CloudFormation's Ref " +
          'returns, and the physical id is NOT that value',
      };
    }
    // go-to-k/cdkd#6243: the same for a GraphQL API / vector bucket imported
    // before cdkd recorded its ARN; its physical id is the bare id / name.
    const healedAttribute = lacksRecordedRefArn(o);
    if (healedAttribute !== undefined) {
      return {
        ok: false,
        reason:
          `state records no usable '${healedAttribute}' for this resource, the value CloudFormation's ` +
          'Ref returns, and the physical id is NOT that value',
      };
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
        reason: `no provider available for ${orphan.resourceType}: ${describeAwsFailure(err).detail}`,
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
      return this.cacheFallback(orphanLogicalId, attribute, describeAwsFailure(err).detail);
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
    // A cached value in one of `servableRecordedAttribute`'s secret or
    // not-a-value classes is not spliced here either (go-to-k/cdkd#4602;
    // a freshness-only exclusion, such as an always-live attribute, is
    // spliced with the warning below): the splice lands in the
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
