import { derivePartitionAndUrlSuffix } from './aws-partition.js';

/**
 * Matching the HOST half of an ECR image URI:
 * `<acct>.dkr.ecr.<region>.<urlSuffix>/`.
 *
 * The suffix is CAPTURED rather than spelled out (issue #1758): the previous
 * pattern hardcoded `amazonaws.com` with an optional `.cn` tail, so a `us-iso*`
 * registry (`c2s.ic.gov` / `sc2s.sgov.gov`) never matched and the caller
 * silently classified a real ECR image as a user-managed one — skipping the
 * `docker login` it needs.
 *
 * KNOWN BOUND (issue #1792): the `dkr.ecr` LABELS are still matched
 * case-sensitively, so `<acct>.DKR.ECR.<region>.<suffix>/` does not match at
 * all. Audited deliberately while fixing issue #1786 rather than missed — that
 * issue's normalization covers the captured region + suffix, i.e. the strict
 * CHECK, whereas widening the shape MATCHER makes cdkd `docker login` to a
 * host shape it previously skipped, which is a behavior expansion wanting its
 * own decision. The failure direction here is the safe one (no credentials are
 * sent; the pull is merely attempted anonymously and fails).
 */
const ECR_URI_HOST_REGEX = /^(\d{12})\.dkr\.ecr\.([^.]+)\.([^/]+)\//;

/**
 * The ONE case-normalization boundary of this module (issue #1786).
 *
 * DNS is case-INSENSITIVE, so `US-ISO-EAST-1.amazonaws.com` and
 * `us-iso-east-1.amazonaws.com` name the same host — but both halves of the
 * #1758 suffix check were case-SENSITIVE, in OPPOSITE directions:
 *
 * - an upper-cased REGION fails every `startsWith` prefix test in
 *   `derivePartitionAndUrlSuffix`, so it falls through to the commercial
 *   partition whose suffix is `amazonaws.com` — which is exactly what an ISO
 *   look-alike host carries, so the strict check ACCEPTED it (the bypass);
 * - an upper-cased region or SUFFIX on a GENUINE host stopped matching its own
 *   partition's suffix, so a real ECR registry was REJECTED and the caller
 *   silently classified it as a user-managed image — the #1758 regression, one
 *   layer up.
 *
 * The normalization lives HERE rather than inside `derivePartitionAndUrlSuffix`
 * because this is the boundary where an untrusted, DNS-shaped string enters
 * cdkd: the partition helper has many other callers (issues #1730 / #1745 /
 * #1764) that pass an already-canonical region from a manifest or an ARN, and
 * a second, differently-cased copy of the rule is the failure #1786 is about.
 * Keeping it in ONE function means both exported entry points below — and the
 * suffix COMPARISON itself — cannot drift apart.
 *
 * The derived suffix is lower-cased too. Every entry in the partition table is
 * a lower-case literal today, so that is a no-op; it is there so this function
 * stays the single answer even if that table ever gains a mixed-case entry.
 */
function matchEcrRegistryHost(
  imageUri: string
): { accountId: string; region: string; suffix: string; expectedSuffix: string } | undefined {
  const m = ECR_URI_HOST_REGEX.exec(imageUri);
  if (!m) return undefined;
  // The account id is `\d{12}`, so it has no case to normalize.
  const region = m[2]!.toLowerCase();
  return {
    accountId: m[1]!,
    region,
    suffix: m[3]!.toLowerCase(),
    expectedSuffix: derivePartitionAndUrlSuffix(region).urlSuffix.toLowerCase(),
  };
}

/**
 * The account + region of an ECR image URI, or `undefined` when the URI is not
 * an ECR registry host for the region it names.
 *
 * Lives in `src/utils/` rather than beside its first caller because it has TWO
 * consumers in different layers — `src/local/ecr-puller.ts` (which needs the
 * `:tag` tail too) and `src/local/ecs-task-resolver.ts` (which classifies an
 * image that may carry a digest or no tag at all). Before issue #1758 they each
 * carried their own copy of the hardcoded commercial pattern, and fixing only
 * the pull path left `cdkd local run-task` broken outside the commercial
 * partition; ONE definition is what stops them drifting apart again.
 *
 * The module is deliberately free of AWS SDK imports, which is what lets
 * `ecs-task-resolver.ts` consume it without breaking the invariant that module
 * documents about itself (it resolves secrets through a separate module for
 * exactly that reason).
 *
 * The returned `region` is LOWER-CASED (issue #1786) — it is consumed as an SDK
 * client region by `ecr-puller.ts` and as the `region` of a `kind: 'ecr'` image
 * by `ecs-task-resolver.ts`, and the canonical spelling of an AWS region id is
 * lower case.
 */
export function parseEcrRegistryHost(
  imageUri: string
): { accountId: string; region: string } | undefined {
  const m = matchEcrRegistryHost(imageUri);
  if (!m) return undefined;
  // The captured suffix must be the one the region's partition actually uses.
  // Accepting ANY suffix would classify `<acct>.dkr.ecr.<region>.example.com`
  // as ECR and point a `docker login` at a registry cdkd does not own.
  if (m.suffix !== m.expectedSuffix) return undefined;
  return { accountId: m.accountId, region: m.region };
}

/**
 * True when the URI has the ECR HOST SHAPE but its suffix does not belong to
 * the region it names — i.e. exactly the case {@link parseEcrRegistryHost}
 * rejects for a reason the caller may want to report.
 *
 * The two rejections are worth telling apart at a call site that degrades
 * silently: a genuinely public image and a registry in a partition
 * `derivePartitionAndUrlSuffix` does not know yet (issue #1764) both come back
 * `undefined`, and only the second is a cdkd gap rather than a user choice.
 */
export function looksLikeEcrHostWithForeignSuffix(imageUri: string): boolean {
  // Shares `matchEcrRegistryHost`'s normalization with `parseEcrRegistryHost`
  // above (issue #1786) so the two verdicts cannot disagree on the same URI:
  // this predicate is documented as "exactly the case the parse rejects", and
  // before the shared boundary an upper-cased region made BOTH of them wrong,
  // consistently — the parse accepted a look-alike and this returned `false`.
  const m = matchEcrRegistryHost(imageUri);
  return m !== undefined && m.suffix !== m.expectedSuffix;
}
