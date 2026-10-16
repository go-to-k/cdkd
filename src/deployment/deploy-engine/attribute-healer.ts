import type { ProviderRegistry } from '../../provisioning/provider-registry.js';
import { injectiveKey } from '../../state/record-keys.js';
import type { Logger } from '../../types/config.js';
import type { ResourceState } from '../../types/state.js';
import { displaySafe, safeMsg } from '../../utils/display-safe.js';
import { isStalePlaceholderArnAttribute } from '../intrinsic-function-resolver.js';
import { isMaskedOwnIdCopy } from '../intrinsic-resolver/getatt-heal.js';
import { readRecordAttributes } from '../read-only-attribute-healer.js';
import { type StateNamingSecrets, secretNamePrintingBags } from '../secret-name-needles.js';
import type { RecordedSecretValues } from '../secret-redaction.js';
import { withPrintingSecrets } from '../resource-secrets-scope.js';
import {
  type StaleAttributeHealOutcome,
  isHealExcludedType,
  mergeHealedAttributes,
} from '../stale-attribute-heal.js';

/** What an {@link AttributeHealer} reads from the deploy it serves. */
export interface AttributeHealerDeps {
  providerRegistry: ProviderRegistry;
  stackRegion: string;
  logger: Pick<Logger, 'debug'>;
  /**
   * The records this deploy LOADED. A heal reads only a record still
   * identical to its loaded entry; see {@link AttributeHealer.isEligible}.
   */
  baseline: Readonly<Record<string, ResourceState>>;
  /** The secret pairs this deploy resolved for `logicalId`, read at merge time. */
  resolvedSecretsOf: (logicalId: string) => RecordedSecretValues | undefined;
  /**
   * The deploy's per-record judging bags (`stateNamingSecrets`,
   * go-to-k/cdkd#3869), read at heal time: the deploy binds its `NoEcho`
   * values and captures what each record stored after it builds this healer.
   */
  namingSecrets: () => StateNamingSecrets;
}

/**
 * One deploy's #1852 heal: re-reads a STALE record's attributes from AWS and
 * holds what it read until the next state save merges it.
 *
 * Built once per deploy over the records that deploy loaded, so nothing it
 * holds can reach another deploy. ENGINE-instance state, never module-global:
 * one engine deploys one stack, and `--stack-concurrency` runs several engines
 * at once.
 */
export class AttributeHealer {
  /**
   * Single-flight + per-deploy memo of the heal, keyed by logical id and
   * physical id. Holding the PROMISE is what makes it single-flight — every
   * concurrent resolution of the same record awaits the one read — and never
   * deleting an entry is what bounds it: one read per record per deploy,
   * success or failure, no retry.
   */
  private readonly heals = new Map<string, Promise<StaleAttributeHealOutcome>>();

  /**
   * What the heals of this deploy read, waiting for the next state save.
   *
   * Applied at `redactStateForPersist` — the choke point EVERY save passes
   * through — rather than written into the in-memory record, so a heal
   * survives every exit path that saves at all (success, a failed resource, a
   * failed output, the no-change path), whichever copy-on-write record map the
   * save happens to hold, and is scrubbed by the same redaction every other
   * attribute goes through. A path that saves NOTHING (`--dry-run`) persists
   * nothing and the next deploy re-heals.
   */
  private readonly healed = new Map<
    string,
    { physicalId: string; resourceType: string; attributes: Record<string, unknown> }
  >();

  private readonly deps: AttributeHealerDeps;

  constructor(deps: AttributeHealerDeps) {
    this.deps = deps;
  }

  /** The records this healer judges eligibility against. */
  get baseline(): Readonly<Record<string, ResourceState>> {
    return this.deps.baseline;
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
  heal(
    logicalId: string,
    resource: ResourceState,
    stackName: string
  ): Promise<StaleAttributeHealOutcome> {
    // The eligibility gate runs on EVERY ask, ahead of the memo: the memo key
    // (logical id + physical id) survives an in-place UPDATE, so a read taken
    // by the diff pass would otherwise be served again AFTER this deploy
    // rewrote the record — a pre-update value handed out as the answer to a
    // miss that is now the provider's own.
    if (!this.isEligible(logicalId, resource)) {
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
    const inFlight = this.heals.get(key);
    if (inFlight) return inFlight;
    const heal = this.read(logicalId, resource, stackName).catch(
      (error: unknown): StaleAttributeHealOutcome => ({ kind: 'failed', error })
    );
    this.heals.set(key, heal);
    return heal;
  }

  /**
   * Is `resource` still the record this deploy LOADED — same physical id, same
   * `attributes` object — and of a type whose attributes are an AWS read-back?
   * Asked by the read AND by the persist merge: a read taken before this
   * deploy rewrote the record must reach neither a later resolution nor the
   * rewritten record.
   *
   * Compared by the `attributes` REFERENCE rather than the record's, because
   * the metadata-only arm re-spreads a record (`{ ...currentResource }`)
   * without a provider call — its attributes object survives the spread, a
   * create / update result's does not.
   */
  isEligible(logicalId: string, resource: ResourceState): boolean {
    const { baseline } = this.deps;
    const loaded = Object.hasOwn(baseline, logicalId) ? baseline[logicalId] : undefined;
    return (
      loaded !== undefined &&
      loaded.physicalId === resource.physicalId &&
      loaded.attributes === resource.attributes &&
      !isHealExcludedType(resource.resourceType)
    );
  }

  /** The read behind {@link heal}, unmemoized; it may throw. */
  async read(
    logicalId: string,
    resource: ResourceState,
    stackName: string
  ): Promise<StaleAttributeHealOutcome> {
    // `getProviderFor` can throw for a type this build cannot route; the
    // caller's `.catch` turns that into `failed`, which is the honest outcome.
    const { provider } = this.deps.providerRegistry.getProviderFor({
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
    // go-to-k/cdkd#3869: the read addresses AWS by the record's physical id, and
    // the provider's lines name it. A record named from a secret (or one holding
    // such a name) binds those spellings as log-only needles, judged against
    // the records this deploy loaded, as `cdkd diff`'s heal does.
    const outcome = await withPrintingSecrets(
      healPrintingBag(this.deps.baseline, logicalId, resource, this.deps.namingSecrets()),
      () =>
        readRecordAttributes({
          provider,
          logicalId,
          resource,
          stackName,
          region: this.deps.stackRegion,
        })
    );
    if (outcome.kind !== 'read') return outcome;
    const { attributes } = outcome;
    if (Object.keys(attributes).length > 0) {
      this.healed.set(logicalId, {
        physicalId: resource.physicalId,
        resourceType: resource.resourceType,
        attributes,
      });
    }
    this.deps.logger.debug(
      safeMsg`Re-read the attributes of ${displaySafe(logicalId)} (${displaySafe(resource.resourceType)}) from AWS — its state record lacked one a Fn::GetAtt asked for: ${Object.keys(attributes).length} attribute(s) read`
    );
    return outcome;
  }

  /**
   * The record to persist for `logicalId`: `record` itself, or a copy whose
   * `attributes` gained what this deploy's heal read. MERGED, never replaced —
   * only `attributes` is touched, and within it only keys the record does not
   * hold (or holds as a pre-#1681 placeholder ARN, or as `***` over a value carrying its
   * own physical id and no other recorded secret, go-to-k/cdkd#4849). Skipped when the record no
   * longer describes the resource that was read: a replacement or a Type change
   * this deploy made.
   */
  withHealedAttributes(logicalId: string, record: ResourceState): ResourceState {
    const healed = this.healed.get(logicalId);
    if (
      healed === undefined ||
      healed.physicalId !== record.physicalId ||
      healed.resourceType !== record.resourceType ||
      // Rewritten by a provider THIS deploy (in place, so the ids still match):
      // its new attribute map is the provider's answer, and a read taken before
      // the update must not be merged under it.
      !this.isEligible(logicalId, record)
    ) {
      return record;
    }
    const merged = mergeHealedAttributes(
      record.attributes,
      healed.attributes,
      (key, value, healedValue) =>
        isStalePlaceholderArnAttribute(record.resourceType, key, value) ||
        // go-to-k/cdkd#4849: a masked copy of the record's own physical id.
        isMaskedOwnIdCopy(record, key, value, healedValue, this.deps.resolvedSecretsOf(logicalId))
    );
    return merged === record.attributes || merged === undefined
      ? record
      : { ...record, attributes: merged };
  }

  /** Would a save of `resources` persist something a heal read? The no-change path's trigger. */
  hasUnpersistedHeals(resources: Readonly<Record<string, ResourceState>>): boolean {
    for (const logicalId of this.healed.keys()) {
      const record = Object.hasOwn(resources, logicalId) ? resources[logicalId] : undefined;
      if (record !== undefined && this.withHealedAttributes(logicalId, record) !== record) {
        return true;
      }
    }
    return false;
  }
}

/**
 * One judge per loaded map and judging bag (go-to-k/cdkd#3869). `secretNamePrintingBags`
 * reads the map LIVE and memoizes each record's needles by record IDENTITY, so
 * a heal judges each record once per deploy, not once per heal. That is sound
 * because a deploy only REPLACES entries of the loaded map, never mutates a
 * record object in place: `deploy-flow.ts` (`currentState.resources[id] =
 * withRebaselinedFingerprints(record, ...)`, which returns `record` or a copy)
 * and `deploy-engine/rollback.ts` (`currentState.resources[id] = record` for an
 * adopted orphan); a replaced entry is a new object, so it is judged afresh.
 * A judging bag other than the one the judge was built with (the deploy binds
 * its `NoEcho` values after it loads the map) builds a new judge;
 * `stateNamingSecrets` returns the same bag until its inputs change.
 */
const healJudges = new WeakMap<
  Readonly<Record<string, ResourceState>>,
  { namingSecrets: StateNamingSecrets; judge: (logicalId: string) => RecordedSecretValues }
>();

/**
 * The printing bag a heal of `resource` binds: its own name spellings and
 * those of each secret-named record of `baseline` it holds. A record other
 * than the one the map holds under its id is judged with itself in place.
 * Each record is judged with `namingSecrets` too: the stack's `NoEcho`
 * values (also carried as log-only needles, print-only) and what the record
 * stored where one served it.
 */
function healPrintingBag(
  baseline: Readonly<Record<string, ResourceState>>,
  logicalId: string,
  resource: ResourceState,
  namingSecrets: StateNamingSecrets
): RecordedSecretValues {
  if (!Object.hasOwn(baseline, logicalId) || baseline[logicalId] !== resource) {
    return secretNamePrintingBags({ ...baseline, [logicalId]: resource }, namingSecrets)(logicalId);
  }
  let hit = healJudges.get(baseline);
  if (hit === undefined || hit.namingSecrets !== namingSecrets) {
    hit = { namingSecrets, judge: secretNamePrintingBags(baseline, namingSecrets) };
    healJudges.set(baseline, hit);
  }
  return hit.judge(logicalId);
}
