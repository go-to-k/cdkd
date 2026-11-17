import type { CcPhysicalIdContext } from '../sticky-exempt-physical-id.js';

// The shape of a `STICKY_CC_MIGRATION_EXEMPT` entry, apart from the table
// itself so that `sticky-exempt.ts` stays under the src file-size cap.

/**
 * How a type escapes the sticky `provisionedBy: 'cc-api'` routing rule.
 *
 * - `'cc-broken'` -- the CC handler CANNOT correctly manage the resource, so
 *   keeping existing state pinned to cc-api keeps a live bug alive. The
 *   fall-through is UNCONDITIONAL: no property check, and `forceCcApi` is
 *   ignored, because pinning here would be pinning to the broken handler.
 * - `'sdk-coverage'` -- CC routing WORKS (or misbehaves only on an update);
 *   the SDK provider has since been backfilled (issue #609) to cover the
 *   properties this resource actually uses. The fall-through is CONDITIONAL on
 *   that being true of the resource in hand, and suppressible with
 *   `forceCcApi`. A type admitted only for the SDK path's speed fits here
 *   too, since the next mutating deploy flips the record (the listener,
 *   issue #4679).
 */
export type StickyExemptMode = 'cc-broken' | 'sdk-coverage';

/**
 * One type's admission to the sticky-CC exemption, with the evidence that
 * admitted it.
 *
 * The fields are not documentation. `tests/unit/provisioning/
 * sticky-exempt-registry.test.ts` requires `integFixture` to name a directory
 * that EXISTS under `tests/integration/` and to have at least one row in
 * `docs/_generated/integ-last-run.tsv` -- so an entry naming a fixture that
 * never ran fails the unit suite. A fixture that ran before its parity arm was
 * added still passes, so that arm's real-AWS run is a merge condition of the
 * PR adding the entry. That is the mechanism behind "evidence rather than
 * assumption": physicalId parity is an
 * empirical per-type fact about what the CC handler mints as `Identifier`
 * versus what the SDK provider stores as `physicalId`, and it is FALSE in
 * general (composite ids, ARN-vs-name divergences). Asserting it from provider
 * source is not the same as observing it on a live resource.
 */
export interface StickyExemptEntry {
  mode: StickyExemptMode;
  /** What both layers store as physicalId, in words, for a reviewer. */
  physicalIdForm: string;
  /** The issue that admitted this type. */
  issue: string;
  /** The integ fixture whose run OBSERVED the parity. Must exist and have run. */
  integFixture: string;
  /**
   * Present only for a type whose Cloud Control id DIFFERS from the SDK
   * provider's (go-to-k/cdkd#5654): maps the recorded Cloud Control id to the
   * one the SDK provider stores for the same live resource. STRICT -- it
   * throws on any id that is not the measured Cloud Control form, so a record
   * it cannot place is refused rather than addressed under a guess. Its output
   * is evidence like parity is: the entry's fixture must observe it equal to
   * the SDK form on a live resource. Applied by {@link sdkAddressedPhysicalId}.
   * `ctx` carries the record's properties and its region, account and
   * partition, for a type whose SDK id is not inside the Cloud Control id
   * (go-to-k/cdkd#6490); a normalizer needing none of them ignores it.
   */
  normalizeCcPhysicalId?: (ccPhysicalId: string, ctx: CcPhysicalIdContext) => string;
  /**
   * Set when the normalizer reads `ctx.accountId`: only then is the account
   * resolved (from the per-credential cache, else STS), so an STS refusal
   * never blocks the flip of a type whose normalizer does not need it. Unset,
   * `ctx.accountId` is `''`, which an ARN-building normalizer refuses.
   */
  normalizerReadsAccountId?: true;
  /**
   * The attribute whose live value must equal the recorded Cloud Control id
   * when an SDK provider reads a normalized record: the check that the SDK id
   * (read from the record, not the id) names the resource Cloud Control
   * recorded, on reads whose provider path has no holder check of its own.
   */
  ccIdentityAttribute?: string;
}
