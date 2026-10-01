import type { DeployEngine } from './deploy-engine.js';
import { injectiveKey } from '../state/record-keys.js';
import type { ResourceState } from '../types/state.js';
import { displaySafe } from '../utils/display-safe.js';
import { isStalePlaceholderArnAttribute } from './intrinsic-function-resolver.js';
import { readRecordAttributes } from './read-only-attribute-healer.js';
import {
  type StaleAttributeHealOutcome,
  isHealExcludedType,
  mergeHealedAttributes,
} from './stale-attribute-heal.js';

declare module './deploy-engine.js' {
  interface DeployEngine {
    /** @internal */
    healStaleAttributes: OmitThisParameter<typeof healStaleAttributes>;
    /** @internal */
    isHealEligible: OmitThisParameter<typeof isHealEligible>;
    /** @internal */
    readStaleAttributes: OmitThisParameter<typeof readStaleAttributes>;
    /** @internal */
    withHealedAttributes: OmitThisParameter<typeof withHealedAttributes>;
    /** @internal */
    hasUnpersistedHeals: OmitThisParameter<typeof hasUnpersistedHeals>;
  }
}

/**
 * Re-read a STALE record's attributes from AWS (issue
 * [#1852](https://github.com/go-to-k/cdkd/issues/1852)) — the resolver calls
 * this, through `ResolverContext.attributeHealer`, only when `Fn::GetAtt` is
 * about to take the physical-id fallback, or reaches one of the resolver's
 * heal-first arms (issue [#3627](https://github.com/go-to-k/cdkd/issues/3627)).
 *
 * The read is the provider's `import()` with `knownPhysicalId` — the same
 * primitive `orphan-adoption.ts` verifies a record with. It is READ-ONLY by
 * contract ("verify the resource exists and fetch attributes, do NOT
 * search"), it returns the map `create()` records (so a healed record looks
 * like a fresh one), and it is routed by the record's own `resourceType` +
 * `provisionedBy`, so a Cloud-Control-routed record is read through Cloud
 * Control. `getAttribute()` was the alternative and is implemented by about
 * half the providers — neither of the two types this issue names.
 *
 * NEVER throws and never retries: every failure is an outcome the resolver
 * words its refusal from, and the memo makes one read per record per deploy
 * the ceiling.
 */
export function healStaleAttributes(
  this: DeployEngine,
  logicalId: string,
  resource: ResourceState,
  stackName: string
): Promise<StaleAttributeHealOutcome> {
  // The eligibility gate runs on EVERY ask, ahead of the memo: the memo key
  // (logical id + physical id) survives an in-place UPDATE, so a read taken
  // by the diff pass would otherwise be served again AFTER this deploy
  // rewrote the record — a pre-update value handed out as the answer to a
  // miss that is now the provider's own.
  if (!this.isHealEligible(logicalId, resource)) {
    return Promise.resolve({ kind: 'not-attempted' });
  }
  // Encoded (go-to-k/cdkd#3496): a physical id is whatever AWS or the
  // template produced, and the record is an unchecked cast, so a separator
  // could let two records share one memo entry — one resource's read served
  // as another's heal. For string halves the old `<logicalId>\0<physicalId>`
  // key was already injective unless the logical id itself contains a NUL,
  // since the split point is then the FIRST NUL. cdkd validates no
  // logical-id charset, so a hand-written template or a hand-edited state
  // can carry one; encoding removes that precondition (and the
  // `[object Object]` conflation of non-string physical ids a template
  // literal had). Nothing else reads this key.
  const key = injectiveKey(logicalId, resource.physicalId);
  const inFlight = this.attributeHeals.get(key);
  if (inFlight) return inFlight;
  const heal = this.readStaleAttributes(logicalId, resource, stackName).catch(
    (error: unknown): StaleAttributeHealOutcome => ({ kind: 'failed', error })
  );
  this.attributeHeals.set(key, heal);
  return heal;
}

/**
 * Is `resource` still the record this deploy LOADED — same physical id, same
 * `attributes` object — and of a type whose attributes are an AWS read-back?
 * See {@link healBaseline}. Asked by the read AND by the persist merge: a
 * read taken before this deploy rewrote the record must reach neither a later
 * resolution nor the rewritten record.
 */
export function isHealEligible(
  this: DeployEngine,
  logicalId: string,
  resource: ResourceState
): boolean {
  const loaded = Object.hasOwn(this.healBaseline, logicalId)
    ? this.healBaseline[logicalId]
    : undefined;
  return (
    loaded !== undefined &&
    loaded.physicalId === resource.physicalId &&
    loaded.attributes === resource.attributes &&
    !isHealExcludedType(resource.resourceType)
  );
}

export async function readStaleAttributes(
  this: DeployEngine,
  logicalId: string,
  resource: ResourceState,
  stackName: string
): Promise<StaleAttributeHealOutcome> {
  // `getProviderFor` can throw for a type this build cannot route; the
  // caller's `.catch` turns that into `failed`, which is the honest outcome.
  const { provider } = this.providerRegistry.getProviderFor({
    resourceType: resource.resourceType,
    properties: resource.properties,
    provisionedBy: resource.provisionedBy,
    // The record is its own baseline (issue #3713): an unrecognized key it
    // carries is by definition unchanged, so the read stays on the layer
    // that wrote the record instead of moving to Cloud Control.
    previousProperties: resource.properties,
  });
  // The read's logic is shared with `cdkd diff`'s read-only healer, so a
  // guard or masking rule cannot land in only one of them (go-to-k/cdkd#4196).
  const outcome = await readRecordAttributes({
    provider,
    logicalId,
    resource,
    stackName,
    region: this.stackRegion,
  });
  if (outcome.kind !== 'read') return outcome;
  const { attributes } = outcome;
  if (Object.keys(attributes).length > 0) {
    this.healedAttributes.set(logicalId, {
      physicalId: resource.physicalId,
      resourceType: resource.resourceType,
      attributes,
    });
  }
  this.logger.debug(
    `Re-read the attributes of ${displaySafe(logicalId)} (${displaySafe(resource.resourceType)}) from AWS — its state record lacked one a Fn::GetAtt asked for (#1852): ${Object.keys(attributes).length} attribute(s) read`
  );
  return outcome;
}

/**
 * The record to persist for `logicalId`: `record` itself, or a copy whose
 * `attributes` gained what this deploy's heal read. MERGED, never replaced —
 * only `attributes` is touched, and within it only keys the record does not
 * hold (or holds as a pre-#1681 placeholder ARN). Skipped when the record no
 * longer describes the resource that was read: a replacement or a Type change
 * this deploy made.
 */
export function withHealedAttributes(
  this: DeployEngine,
  logicalId: string,
  record: ResourceState
): ResourceState {
  const healed = this.healedAttributes.get(logicalId);
  if (
    healed === undefined ||
    healed.physicalId !== record.physicalId ||
    healed.resourceType !== record.resourceType ||
    // Rewritten by a provider THIS deploy (in place, so the ids still match):
    // its new attribute map is the provider's answer, and a read taken before
    // the update must not be merged under it.
    !this.isHealEligible(logicalId, record)
  ) {
    return record;
  }
  const merged = mergeHealedAttributes(record.attributes, healed.attributes, (key, value) =>
    isStalePlaceholderArnAttribute(record.resourceType, key, value)
  );
  return merged === record.attributes || merged === undefined
    ? record
    : { ...record, attributes: merged };
}

/** Would a save of `resources` persist something a heal read? The no-change path's trigger. */
export function hasUnpersistedHeals(
  this: DeployEngine,
  resources: Readonly<Record<string, ResourceState>>
): boolean {
  for (const logicalId of this.healedAttributes.keys()) {
    const record = Object.hasOwn(resources, logicalId) ? resources[logicalId] : undefined;
    if (record !== undefined && this.withHealedAttributes(logicalId, record) !== record) {
      return true;
    }
  }
  return false;
}
