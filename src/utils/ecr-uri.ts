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
 * own decision. The failure direction here is the safe one: NO credentials are
 * sent on any of the four call sites. Traced — `local run-task` and
 * `local invoke-agentcore` fall through to an anonymous `docker pull` that
 * fails, while `local invoke` and `local start-api` REFUSE before any pull.
 */
const ECR_URI_HOST_REGEX = /^(\d{12})\.dkr\.ecr\.([^.]+)\.([^/]+)\//;

/**
 * A region segment cdkd is willing to treat as a region id.
 *
 * Case is not the only way the `startsWith` partition classification can be
 * side-stepped: any leading junk defeats it the same way, and the captured
 * segment does not stay inert — it becomes an `ECRClient({region})` and is
 * interpolated into the fallback `docker login` endpoint. Measured before this
 * guard: `…dkr.ecr. us-iso-east-1.amazonaws.com/…` (leading space) and a
 * combining-mark form both parsed, yielding regions `" us-iso-east-1"` and
 * `"us-i̇so-east-1"`. Neither leaks credentials — an ACCEPTED suffix is always
 * an AWS-owned domain — but a region id is ASCII alphanumeric plus `-`, so
 * anything else is a malformed host and refusing it keeps the classification
 * honest.
 *
 * TESTED AGAINST THE RAW SEGMENT, BEFORE `toLowerCase()`, and that order is the
 * whole point: `String.prototype.toLowerCase` performs full Unicode case
 * folding, so the Kelvin sign U+212A folds to a plain ASCII `k`. Checking the
 * FOLDED segment therefore accepts `us-eKst-1` and yields the region
 * `us-ekst-1` — a region the host does not name — which is precisely the
 * class of substitution this guard exists to refuse. Matching `[A-Za-z0-9-]`
 * on the raw capture keeps case-insensitivity (the point of issue #1786) while
 * admitting only characters that fold to themselves.
 *
 * ONE DELIBERATE SIDE EFFECT, called out because it is a withdrawal rather than
 * an addition: refusing here also withdraws the #1764 foreign-suffix diagnostic
 * from a malformed-region host, so `<acct>.dkr.ecr.us_east_1.example.com/…`
 * now classifies as an ordinary public image and `ecs-task-resolver.ts` logs
 * nothing, where before the guard it logged the partition-gap warning. That is
 * the correct verdict rather than a regression: the diagnostic's whole subject
 * is "this suffix does not belong to its region's PARTITION", and for a segment
 * that is not a region id there is no partition to belong to — reporting it
 * would send the reader hunting for a table entry that could never exist. It is
 * pinned by a test so a future widening of the guard cannot flip it silently.
 */
const CANONICAL_REGION_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

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
 * cdkd, and keeping it in ONE function means both exported entry points below —
 * and the suffix COMPARISON itself — cannot drift apart.
 *
 * That is NOT the same as claiming every other caller of the partition helper
 * is already canonical, and the PR review measured that it is not:
 * `local-run-task.ts` / `local-invoke.ts` / `local-start-api.ts` derive
 * `${AWS::URLSuffix}` from the raw user `--region`, so `--region CN-NORTH-1`
 * synthesizes `…dkr.ecr.CN-NORTH-1.amazonaws.com/…` — a host carrying the
 * COMMERCIAL suffix for a `cn-` region, which this module then correctly
 * rejects as a look-alike. Both spellings are broken (the pre-#1786 code
 * accepted it and pointed a `docker login` at a host that does not exist), so
 * the right repair is to canonicalize the region where the CLI ACCEPTS it —
 * tracked as issue #1795. That repair does not replace this one: a CLI flag and
 * a host string read out of a template or a state record are different trust
 * questions, so this boundary keeps its own normalization either way.
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
  // Guarded on the RAW capture, BEFORE folding — see the regex's own comment:
  // `toLowerCase()` maps U+212A onto ASCII `k`, so testing the folded segment
  // would admit `us-eKst-1` as the region `us-ekst-1`.
  if (!CANONICAL_REGION_SEGMENT.test(m[2]!)) return undefined;
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
