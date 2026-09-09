/**
 * The region literal the `as BucketLocationConstraint` fences pin.
 *
 * Four call sites cast a region string to `BucketLocationConstraint` — three of
 * them the raw one, and `s3-bucket-provider.ts` its own `canonicalRegion` —
 * (`src/provisioning/providers/s3-bucket-provider.ts`,
 * `src/cli/commands/bootstrap.ts`, `src/cli/commands/state-migrate.ts`,
 * `src/assets/asset-storage.ts`). The regression each of their fences exists to
 * catch is a future "soundness fix" that FILTERS the region to enum members:
 * that compiles, leaves every `us-east-1` / `eu-west-1` row green, and silently
 * omits `CreateBucketConfiguration` for a region the enum does not list -- which
 * on a REGIONAL endpoint answers `IllegalLocationConstraintException`, i.e. a
 * broken deploy. A fence can only catch it while the region it pins is ABSENT
 * from the enum.
 *
 * ## Why this is one shared constant instead of a literal per file
 *
 * The three sibling fences each pinned `'ca-west-1'` and each said, in prose,
 * that they chose it BECAUSE the enum omitted it. `@aws-sdk/client-s3` then
 * moved 3.1018.0 -> 3.1126.0 and the enum grew 33 -> 38 members, taking
 * `ca-west-1` with it -- so all three went SILENTLY inert, green through the
 * exact regression they were written for, at three of the four cast sites
 * (issue [#2862](https://github.com/go-to-k/cdkd/issues/2862)). Nothing could
 * have caught that, because each file states the property in a comment and none
 * of them asserts it.
 *
 * Sharing the literal makes the property assertable CENTRALLY, instead of in a
 * copy per fenced row that drifts silently. Only one of the four suites is
 * actually PREVENTED from hosting its own — `asset-storage.test.ts` mocks
 * `@aws-sdk/client-s3` with a plain factory carrying no enum, so a guard written
 * there would assert against its own mock (`state-migrate.test.ts` mocks with an
 * `importActual` spread and `bootstrap.test.ts` does not mock the module at all,
 * so either COULD).
 *
 * **The guard is in
 * `tests/unit/provisioning/s3-bucket-provider-location-constraint-case.test.ts`**,
 * beside the sweep that pins the same property for the fourth site, and
 * `tests/unit/scripts/enum-absent-region-binding.test.ts` repeats it as a
 * guard-the-guard for its own rows — deliberately, since those rows would
 * otherwise report a healthy binding to a dead value. Both copies read live
 * data, so they cannot disagree. Either fails the moment this region becomes a
 * member, turning the silent inertness above into a loud failure naming what to
 * re-derive.
 *
 * Re-derive a replacement with:
 *
 *   node --input-type=module -e "
 *   import { BucketLocationConstraint } from '@aws-sdk/client-s3';
 *   import { RegionInfo } from 'aws-cdk-lib/region-info';
 *   const m = new Set(Object.values(BucketLocationConstraint));
 *   console.log(RegionInfo.regions.map(r => r.name).filter(r => !m.has(r)).sort().join('\n'));"
 *
 * As of 2026-09-09 every absent region is non-commercial (`aws-iso*` plus
 * `eusc-de-east-1`); `us-east-1` is absent BY DESIGN and must never be chosen,
 * since it is the one region whose `LocationConstraint` must be OMITTED.
 *
 * The partition does not matter to the gate this constant is pinning: all four
 * sites decide the `CreateBucketConfiguration` on a bare `region !== 'us-east-1'`
 * with no partition branch, so an `aws-iso` region traverses byte-identical
 * lines to a commercial one. It DOES reach other code on three of them —
 * `bootstrap.ts`, `state-migrate.ts` and `asset-storage.ts` each build a bucket
 * policy through `buildDenyExternalAccessPolicy`, which derives the partition
 * one hop further out (`src/utils/deny-external-access-policy.ts`), so the ARNs
 * there read
 * `arn:aws-iso:s3:::…` where `ca-west-1` produced `arn:aws:s3:::…`. No row
 * asserts those ARNs, so the change is inert today; a row added later that DOES
 * assert one must derive the partition rather than hardcode `aws`.
 */
export const ENUM_ABSENT_REGION = 'us-iso-east-1';

/**
 * A mis-cased spelling of {@link ENUM_ABSENT_REGION}, for the row where issue
 * [#2282](https://github.com/go-to-k/cdkd/issues/2282)'s case fold and issue
 * [#2322](https://github.com/go-to-k/cdkd/issues/2322)'s enum widening meet:
 * the fold has to survive on a region the enum omits. Kept beside the constant
 * so re-deriving one cannot leave the other behind.
 */
export const ENUM_ABSENT_REGION_MISCASED = 'US-Iso-East-1';
