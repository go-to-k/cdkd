/**
 * AWS partition / URL-suffix derivation, shared across layers.
 *
 * Lives in `src/utils/` because it has consumers in two different layers: the
 * `cdkd local *` command family (which passes a region in once to keep the STS
 * hop minimal) and the provisioning layer's `AppSyncProvider`, which rebuilds a
 * child resource's ARN when AWS did not report one.
 *
 * It was originally defined in `src/local/ecs-task-resolver.ts`, which
 * re-exports it so every existing call site is unchanged; a provisioning
 * provider importing from `src/local/**` would invert the layering.
 *
 * NOTE `getAccountInfo().partition`
 * (`src/deployment/intrinsic-function-resolver.ts`) was hardcoded to `'aws'`
 * until issue #1730, which made it derive through THIS helper — so the two now
 * agree and either spelling is correct. Prefer this one where a region is
 * already in hand, since it needs no STS round trip.
 */

/**
 * Region prefix -> `{partition, urlSuffix}`, in match order.
 *
 * Exported so a caller needing the WHOLE mapping — rather than one region's
 * answer — can read it here instead of hand-maintaining a parallel list that
 * silently goes stale when a partition is added (issue #1785 couples `cdkd
 * gc`'s suffix list to this table for exactly that reason).
 *
 * Every row is VERIFIED against AWS-authored partition data rather than taken
 * from documentation prose (issue #1764 shipped the last three, and the issue
 * explicitly asked for confirmation rather than trust). Three independent
 * AWS-authored sources agree on every row, prefix AND suffix:
 *
 * 1. `@aws-sdk/util-endpoints`'s vendored `lib/aws/partitions.json` (the copy
 *    in this repo's own `node_modules`) — each row's `regionRegex` +
 *    `outputs.dnsSuffix`.
 * 2. botocore's `endpoints.json`, as shipped inside the official AWS CLI v2 —
 *    each row's `regionRegex` + `dnsSuffix`.
 * 3. `aws-cdk-lib`'s `region-info` `PARTITION_MAP` — each row's prefix +
 *    `domainSuffix`.
 *
 * Two things the sources settle that are easy to get wrong:
 *
 * - `aws-us-gov`'s suffix really IS the commercial `amazonaws.com`; GovCloud
 *   is the one non-commercial partition that does not have its own DNS suffix.
 * - Each partition is named by exactly ONE region prefix upstream, so this
 *   table needs no per-partition prefix list.
 *
 * Match ORDER is only load-bearing to the extent that no prefix here is a
 * prefix of another — `us-iso-` cannot swallow `us-isob-` / `us-isof-` because
 * of its trailing hyphen. A row whose prefix nests inside an earlier one would
 * be unreachable, so keep that invariant (it is pinned by a unit test).
 *
 * The one deliberate divergence from upstream is `eusc-`: the SDK / botocore
 * regex is `^eusc\-(de)\-\w+\-\d+$` and CDK pins the prefix `eusc-de-`, i.e.
 * both are scoped to today's single European Sovereign Cloud country. cdkd
 * matches on the broader `eusc-` because the failure directions are not
 * symmetric — a future `eusc-<cc>-…` region falling through to commercial is
 * the exact bug this table was widened to fix, while a false match is
 * impossible: no other partition's regions begin with `eusc-`.
 */
export const PARTITION_TABLE: ReadonlyArray<{
  readonly prefix: string;
  readonly partition: string;
  readonly urlSuffix: string;
}> = [
  { prefix: 'cn-', partition: 'aws-cn', urlSuffix: 'amazonaws.com.cn' },
  { prefix: 'us-gov-', partition: 'aws-us-gov', urlSuffix: 'amazonaws.com' },
  { prefix: 'us-iso-', partition: 'aws-iso', urlSuffix: 'c2s.ic.gov' },
  { prefix: 'us-isob-', partition: 'aws-iso-b', urlSuffix: 'sc2s.sgov.gov' },
  { prefix: 'us-isof-', partition: 'aws-iso-f', urlSuffix: 'csp.hci.ic.gov' },
  { prefix: 'eu-isoe-', partition: 'aws-iso-e', urlSuffix: 'cloud.adc-e.uk' },
  { prefix: 'eusc-', partition: 'aws-eusc', urlSuffix: 'amazonaws.eu' },
];

/**
 * Fold an AWS region name to its canonical lower-case spelling.
 *
 * AWS region ids ARE lower case — `${AWS::Region}` always returns that form —
 * but nothing between a `--region` flag and an SDK client enforces it, and
 * essentially everything downstream is case-SENSITIVE (issue
 * [#1795](https://github.com/go-to-k/cdkd/issues/1795)):
 *
 * - This module's own `PARTITION_TABLE` walk is a `startsWith` prefix test, so
 *   `--region CN-NORTH-1` fell through to the commercial partition and the
 *   `cdkd local *` commands synthesized
 *   `<acct>.dkr.ecr.CN-NORTH-1.amazonaws.com/...` — a `cn-` region carrying the
 *   commercial suffix, a host that does not exist.
 * - The AWS SDK's endpoint resolution is case-sensitive in the SAME direction.
 *   Measured against this repo's vendored `@aws-sdk/util-endpoints` partition
 *   data: `cn-north-1` resolves `aws-cn` / `amazonaws.com.cn` while
 *   `CN-NORTH-1` resolves `aws` / `amazonaws.com` (both the exact-match table
 *   and the `regionRegex` fallback are case-sensitive). So EVERY SDK client
 *   built from a raw region — `STSClient` for `${AWS::AccountId}`, the ECR /
 *   SecretsManager / SSM clients further down the `cdkd local` path — talks to
 *   the wrong partition's endpoint and fails.
 * - `${AWS::Region}` substituted from a raw value spells the region wrongly
 *   inside every ARN the resolver builds from it.
 *
 * Applied BOTH in `derivePartitionAndUrlSuffix` (so any caller of the mapping
 * inherits it) AND at the `cdkd local *` region-resolution points (so the
 * region VALUE those commands hand to SDK clients and to `${AWS::Region}` is
 * canonical too). Double-folding is a no-op, which is what makes having it in
 * both places safe rather than redundant.
 */
export function canonicalizeRegion<T extends string | undefined>(region: T): T {
  return (typeof region === 'string' ? region.toLowerCase() : region) as T;
}

/**
 * Derive the AWS partition / URL suffix for an AWS region. Same mapping
 * CloudFormation applies to `${AWS::Partition}` / `${AWS::URLSuffix}`.
 *
 * An unrecognized region resolves to the commercial partition. That fallback
 * is deliberate (a brand-new commercial region must keep working before this
 * table hears about it), but it is also what made the pre-#1764 gap quiet: a
 * genuine registry host in a partition missing from the table came back with
 * the COMMERCIAL suffix, so `parseEcrRegistryHost` (`src/utils/ecr-uri.ts`)
 * rejected it under the strict host check issue #1758 added and the image was
 * classified `public` — anonymous pull, no `docker login`, opaque failure.
 *
 * The region is CANONICALIZED through {@link canonicalizeRegion} before the
 * prefix tests (issue [#1795](https://github.com/go-to-k/cdkd/issues/1795)),
 * so every present and future caller inherits ONE normalization point and the
 * three `cdkd local *` call sites cannot drift apart again.
 *
 * This is only HALF the answer at those call sites, and the half it is NOT is
 * worth stating: canonicalizing here fixes the derived SUFFIX, but each caller
 * also passes the raw region VALUE to its SDK clients and stores it as
 * `${AWS::Region}`. The AWS SDK's own endpoint resolution is case-sensitive in
 * exactly the same way (measured against this repo's vendored
 * `@aws-sdk/util-endpoints` partition data: `CN-NORTH-1` resolves to the
 * COMMERCIAL `amazonaws.com`), so the callers canonicalize the value too — see
 * `canonicalizeRegion`'s own note.
 */
export function derivePartitionAndUrlSuffix(region: string): {
  partition: string;
  urlSuffix: string;
} {
  const canonical = canonicalizeRegion(region);
  for (const { prefix, partition, urlSuffix } of PARTITION_TABLE) {
    if (canonical.startsWith(prefix)) return { partition, urlSuffix };
  }
  return { partition: 'aws', urlSuffix: 'amazonaws.com' };
}
