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
 * an addition: a malformed-region host is now classified as an ordinary public
 * image with NO cdkd-side signal at all — neither the ECR verdict nor the #1764
 * foreign-suffix diagnostic. Both arms change, not just the foreign one:
 * `<acct>.dkr.ecr.us_east_1.example.com/…` used to log the partition-gap
 * warning and now logs nothing, and `<acct>.dkr.ecr.us_east_1.amazonaws.com/…`
 * used to be ACCEPTED as ECR and is now refused. That is the correct verdict
 * rather than a regression — the diagnostic's whole subject is "this suffix does
 * not belong to its region's PARTITION", and a segment that is not a region id
 * has no partition to belong to, so reporting it would send the reader hunting
 * for a table entry that could never exist — but it does mean a typo'd region
 * gets no cdkd-side hint, only docker's own pull failure. Both arms are pinned
 * by tests so a future widening of the guard cannot flip them silently.
 */
const CANONICAL_REGION_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/**
 * A URL suffix cdkd is willing to compare against the partition table.
 *
 * The SAME raw-capture rule as the region, and for the same reason one layer
 * over: the suffix is folded before the comparison, so a code point folding
 * into ASCII can impersonate a partition's suffix. This became reachable the
 * moment issue #1764 landed `aws-isoe`'s `cloud.adc-e.uk` — that suffix
 * contains a `k`, so `…dkr.ecr.eu-isoe-west-1.cloud.adc-e.uK/…` (Kelvin
 * sign) folded onto it and was ACCEPTED. Not a credential leak, since UTS-46
 * maps U+212A to `k` too and the host resolves to the real AWS domain, but it
 * falsifies the invariant the region guard's comment above states, so both
 * captures are held to the same rule rather than only the one that was
 * measured first.
 *
 * Dots are admitted because a suffix is a dotted DNS name; every other
 * character is refused, so the accepted set stays exactly the partition
 * table's own literals.
 */
const CANONICAL_URL_SUFFIX = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

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
 * This does NOT duplicate `canonicalizeRegion`, which issue #1795 added inside
 * `derivePartitionAndUrlSuffix` so the mapping folds its own input. The two
 * answer different questions and both are needed: that one makes the partition
 * LOOKUP case-insensitive for every caller, while these guards decide whether
 * the captured segments are a region id and a URL suffix AT ALL. Folding alone
 * cannot do that — folding is precisely what turns `us-eKst-1` into the
 * plausible `us-ekst-1` (see the guards' own comments), so a fold-only helper
 * makes the substitution easier to reach, not harder. Double-folding is a
 * no-op, which is why the redundant `toLowerCase()` calls below are left in
 * rather than removed: they keep this function the single answer for the
 * comparison even if the helper's behaviour changes again.
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
  // BOTH guarded on the RAW capture, BEFORE folding — see each regex's own
  // comment: `toLowerCase()` maps U+212A onto ASCII `k`, so testing the folded
  // value would admit `us-eKst-1` as the region `us-ekst-1`, and `cloud.adc-e.uK`
  // as the `aws-isoe` suffix `cloud.adc-e.uk`.
  if (!CANONICAL_REGION_SEGMENT.test(m[2]!)) return undefined;
  if (!CANONICAL_URL_SUFFIX.test(m[3]!)) return undefined;
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
