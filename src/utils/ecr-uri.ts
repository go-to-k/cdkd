import { derivePartitionAndUrlSuffix } from './aws-partition.js';
import { escapeRegExp } from './regexp.js';

/** One HOST FORM AWS serves an ECR private registry under. */
export interface EcrRegistryHostForm {
  /**
   * The literal label run between the 12-digit account id and the region
   * segment — e.g. `dkr.ecr` in `<acct>.dkr.ecr.<region>.<urlSuffix>`.
   */
  labels: string;
  /**
   * The FIXED URL suffix this form is served under, or `undefined` when the
   * form carries the suffix of the region's own partition.
   */
  fixedUrlSuffix?: string;
}

/**
 * The ECR registry-host FORM TABLE — the ONE place the host forms AWS serves are
 * spelled (issue #1793).
 *
 * The forms used to be spelled TWICE, here and in `src/cli/commands/gc.ts`,
 * and the two already disagreed: gc carried the `-fips` and `on.aws` forms
 * while this module matched only the plain one, so a genuine FIPS or dual-stack
 * registry was not recognized here AT ALL and `cdkd local invoke` /
 * `run-task` classified it as a public image (anonymous pull, no
 * `docker login`).
 *
 * **What is shared is this TABLE, not the whole matcher** — read that precisely,
 * because the unification is deliberately PARTIAL. gc builds its pattern from
 * the table through {@link ecrRegistryHostPattern}; this module's own
 * {@link ECR_URI_HOST_REGEX} re-spells the alternation from the table's LABELS
 * column and cannot use that builder at all (its doc says why). So the shared
 * fact is which label runs AWS serves and which of them carry a FIXED suffix —
 * which is exactly what had drifted — while each matcher keeps its own
 * acceptance rule, deliberately: gc matches the suffix against the union over
 * every partition and {@link parseEcrRegistryHost} pairs it WITH the region (see
 * `gc.ts`'s `AWS_URL_SUFFIXES` doc for why the two strictnesses must not merge).
 *
 * A THIRD, looser spelling of "this is an ECR registry host" still lives outside
 * this table — `isCdkAssetImageUri`'s `host.includes('.dkr.ecr.')` in
 * `src/local/ecs-task-resolver.ts`, which recognizes only the plain form and is
 * case-SENSITIVE. It is tracked as issue #1846 rather than folded in here: it
 * must keep tolerating an UNRESOLVED host
 * (`${AWS::AccountId}.dkr.ecr.${AWS::Region}.${AWS::URLSuffix}`), so it cannot
 * simply become a call to either matcher.
 *
 * Every row is read off the AWS-published `ecr` endpoint list
 * (https://docs.aws.amazon.com/general/latest/gr/ecr.html) plus the docker
 * push / pull examples in the ECR user guide's "Making requests to Amazon ECR
 * registries", rather than inferred:
 *
 * - `<acct>.dkr.ecr.<region>.<urlSuffix>` — the IPv4-only registry endpoint,
 *   every partition.
 * - `<acct>.dkr.ecr-fips.<region>.<urlSuffix>` — the FIPS IPv4 endpoint, served
 *   in `us-east-1` / `us-east-2` / `us-west-1` / `us-west-2` /
 *   `us-gov-east-1` / `us-gov-west-1` — i.e. only in partitions whose suffix is
 *   `amazonaws.com`, which is why pairing it with the region's own partition
 *   suffix is exactly right rather than merely convenient.
 * - `<acct>.dkr-ecr.<region>.on.aws` — the dual-stack (IPv4 + IPv6) endpoint.
 * - `<acct>.dkr-ecr-fips.<region>.on.aws` — the dual-stack FIPS endpoint, in the
 *   same six regions as the IPv4 FIPS form. This one was missing from BOTH
 *   copies of the grammar; unifying them is what surfaced it.
 *
 * The two dual-stack forms carry a FIXED suffix, so their check is that literal
 * rather than the region's partition suffix — the TIGHTEST available check for
 * them, not a relaxation: `on.aws` is an AWS-owned domain, so unlike a captured
 * suffix it cannot be substituted by a host someone else owns. They are
 * accepted for ANY region rather than only the partitions AWS documents them
 * in, deliberately: under-accepting is precisely the issue #1764 failure (a
 * cdkd table lagging AWS made a GENUINE registry classify as public), and the
 * suffix being AWS-owned means the widening cannot point a `docker login`
 * anywhere but AWS.
 */
export const ECR_REGISTRY_HOST_FORMS: readonly EcrRegistryHostForm[] = [
  { labels: 'dkr.ecr' },
  { labels: 'dkr.ecr-fips' },
  { labels: 'dkr-ecr', fixedUrlSuffix: 'on.aws' },
  { labels: 'dkr-ecr-fips', fixedUrlSuffix: 'on.aws' },
];

/**
 * {@link ECR_REGISTRY_HOST_FORMS} ordered LONGEST LABELS FIRST, so
 * `dkr.ecr-fips` is tried before its own `dkr.ecr` prefix instead of relying on
 * backtracking.
 */
const ECR_HOST_FORMS_LONGEST_FIRST = [...ECR_REGISTRY_HOST_FORMS].sort(
  (a, b) => b.labels.length - a.labels.length
);

/**
 * {@link ECR_REGISTRY_HOST_FORMS} keyed by its (already lower-case) labels, for
 * resolving which suffix rule the matched form wants.
 */
const ECR_HOST_FORM_BY_LABELS = new Map(ECR_REGISTRY_HOST_FORMS.map((form) => [form.labels, form]));

/**
 * The host half of an ECR image URI as a regex SOURCE string, built from
 * {@link ECR_REGISTRY_HOST_FORMS} (issue #1793).
 *
 * ONE consumer: `cdkd gc`, which passes loose non-capturing sub-patterns and
 * matches the suffix against the union over every partition.
 *
 * **This module does NOT call it**, and that is structural rather than an
 * oversight — {@link ECR_URI_HOST_REGEX} re-spells the alternation from the
 * table's LABELS column instead. The strict matcher needs the suffix CAPTURED,
 * at a FIXED group index, to pair it with the region; this builder inlines a
 * `fixedUrlSuffix` as an UNCAPTURED literal, so the capturing-group count would
 * differ per alternative and the group index of the suffix would depend on which
 * form matched. Making the fixed suffix capturing to even the count is not the
 * fix either: it would hand gc a group it does not want, ahead of the tag /
 * digest groups it reads BY POSITION. So the sharable unit is the table, not the
 * pattern — and the cross-matcher test in `tests/unit/cli/gc.test.ts` is driven
 * off the table, so a row added there must work on BOTH sides or the suite reds.
 *
 * Every group this function ADDS is non-capturing, and that is load-bearing
 * rather than stylistic, for the same by-position reason: `gc.ts` reads its ECR
 * tag / digest by GROUP INDEX, and a capturing group here would silently shift
 * them. The caller's own three sub-patterns are interpolated verbatim, so
 * whether THOSE capture is the caller's business.
 */
export function ecrRegistryHostPattern(segments: {
  /** Pattern matching the 12-digit account id. */
  accountId: string;
  /** Pattern matching the region segment. */
  region: string;
  /**
   * Pattern matching the URL suffix of a form that carries its region's own
   * partition suffix. The fixed-suffix forms ignore it and spell their own.
   */
  partitionUrlSuffix: string;
}): string {
  const forms = ECR_HOST_FORMS_LONGEST_FIRST.map((form) => {
    const suffix =
      form.fixedUrlSuffix === undefined
        ? segments.partitionUrlSuffix
        : escapeRegExp(form.fixedUrlSuffix);
    return `${escapeRegExp(form.labels)}\\.${segments.region}\\.${suffix}`;
  });
  return `${segments.accountId}\\.(?:${forms.join('|')})`;
}

/**
 * Matching the HOST half of an ECR image URI:
 * `<acct>.<labels>.<region>.<urlSuffix>/`.
 *
 * The suffix is CAPTURED rather than spelled out (issue #1758): the previous
 * pattern hardcoded `amazonaws.com` with an optional `.cn` tail, so a `us-iso*`
 * registry (`c2s.ic.gov` / `sc2s.sgov.gov`) never matched and the caller
 * silently classified a real ECR image as a user-managed one — skipping the
 * `docker login` it needs.
 *
 * The LABELS are captured too, because which suffix is expected depends on
 * WHICH form matched (issue #1793) — the dual-stack forms carry a fixed
 * `on.aws` rather than the region's partition suffix.
 *
 * Built from {@link ECR_REGISTRY_HOST_FORMS}'s LABELS column rather than through
 * {@link ecrRegistryHostPattern}: the builder cannot serve this matcher's fixed
 * capture-group layout (see its doc). The table is what the two matchers share.
 *
 * The `i` flag makes the labels case-INSENSITIVE (issue #1792). DNS is
 * case-insensitive, so `<acct>.DKR.ECR.<region>.<suffix>` names the same host,
 * but the labels were spelled as case-sensitive literals — and unlike the
 * issue #1786 defect one layer over, the host then did not match the SHAPE at
 * all, so `parseEcrRegistryHost` returned `undefined` AND
 * {@link looksLikeEcrHostWithForeignSuffix} returned `false`, i.e. not even the
 * issue #1764 diagnostic fired.
 *
 * Widening the shape is the right fix rather than a refusal because DOCKER
 * accepts an upper-cased registry host, so cdkd is not made to `docker login`
 * for a URI docker will then reject. `distribution/reference`'s grammar spells
 * `domain-component` as `([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])`
 * while the repository PATH is `alpha-numeric := [a-z0-9]+`, and
 * `ParseNormalizedNamed` raises `repository name must be lowercase` for the
 * REMOTE NAME only — `splitDockerDomain` performs no case folding on the
 * domain. This change never touches the repository path.
 *
 * What docker does NOT fold is its CREDENTIAL STORE, which is keyed on the
 * hostname verbatim (measured in issue #1801: a pull of an upper-cased host
 * sent no credentials at all, while the lower-cased spelling authenticated).
 * That is why the fix here is only the SHAPE match: the login / pull spelling
 * is reconciled one layer up by `ecr-puller.ts`'s `canonicalizeImageUriHost`,
 * which every docker-facing consumer already routes through. Issue #1817
 * tracks moving that fold in here.
 *
 * **Every verdict issues #1792 / #1793 changed, in full** — `p` is
 * {@link parseEcrRegistryHost}, `d` is
 * {@link looksLikeEcrHostWithForeignSuffix} (the issue #1764 diagnostic), `S`
 * is the region's own partition suffix and `F` a foreign one. The table is
 * spelled out because the DIAGNOSTIC-ONLY rows are the easy ones to omit: `p`
 * is unchanged there, so a summary that tracks only the parse verdict reads as
 * "no change" while a warning that never used to fire now does.
 *
 * ```text
 *   host                              before        after         what changed
 *   <a>.dkr.ecr.<r>.S                 p=ok  d=f     p=ok  d=f     nothing
 *   <a>.dkr.ecr.<r>.F                 p=und d=TRUE  p=und d=TRUE  nothing
 *   <a>.dkr.ecr.<r>.on.aws            p=und d=TRUE  p=und d=TRUE  nothing (*)
 *   <a>.DKR.ECR.<r>.S                 p=und d=f     p=ok  d=f     #1792 PARSE
 *   <a>.DKR.ECR.<r>.F                 p=und d=f     p=und d=TRUE  #1792 diag only
 *   <a>.dkr.ecr-fips.<r>.S            p=und d=f     p=ok  d=f     #1793 PARSE
 *   <a>.dkr.ecr-fips.<r>.F            p=und d=f     p=und d=TRUE  #1793 diag only
 *   <a>.dkr-ecr.<r>.on.aws            p=und d=f     p=ok  d=f     #1793 PARSE
 *   <a>.dkr-ecr-fips.<r>.on.aws       p=und d=f     p=ok  d=f     #1793 PARSE
 *   <a>.dkr-ecr.<r>.S                 p=und d=f     p=und d=TRUE  #1793 diag only
 *   <a>.dkr-ecr-fips.<r>.S            p=und d=f     p=und d=TRUE  #1793 diag only
 *   <a>.dkr.ecr-fips.<r>.on.aws       p=und d=f     p=und d=TRUE  #1793 diag only
 * ```
 *
 * (*) `dkr.ecr` + `on.aws` is the one mispairing that ALREADY reported `true`
 * before the change: the pre-#1793 pattern matched the plain labels against a
 * wildcard `([^/]+)` suffix, so `on.aws` was simply a suffix that is not
 * `amazonaws.com`. Every other row that flips `d` was previously refused at the
 * SHAPE, which is why both verdicts were quiet.
 *
 * The five `d`-only flips are an improvement in kind — a host AWS does not serve
 * now says so instead of passing silently as a public image — but the caller's
 * MESSAGE was written for the #1764 partition-gap case and now over-claims for a
 * form/suffix mispairing (`amazonaws.com` IS `us-east-1`'s partition suffix).
 * `src/local/ecs-task-resolver.ts` owns that wording; recorded on issue #1846.
 */
const ECR_URI_HOST_REGEX = new RegExp(
  `^(\\d{12})\\.(${ECR_HOST_FORMS_LONGEST_FIRST.map((form) => escapeRegExp(form.labels)).join(
    '|'
  )})\\.([^.]+)\\.([^/]+)/`,
  'i'
);

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
  if (!CANONICAL_REGION_SEGMENT.test(m[3]!)) return undefined;
  if (!CANONICAL_URL_SUFFIX.test(m[4]!)) return undefined;
  // The labels take FULL folding, deliberately UNLIKE the two guards above, and
  // the difference is what each capture is used FOR. The region and the suffix
  // are DERIVED FROM: the region becomes an `ECRClient({region})` and seeds the
  // partition lookup, and the suffix is compared against that lookup's answer,
  // so a code point folding into ASCII lets a host name one thing while cdkd
  // acts on another (`us-eKst-1` -> the region `us-ekst-1`). The labels only
  // SELECT a row from {@link ECR_REGISTRY_HOST_FORMS}, whose keys are four fixed
  // literals, and nothing downstream reads the captured spelling — so folding
  // can pick a row or pick none, and neither is a substitution.
  //
  // An ASCII-ONLY map was the previous spelling, reasoning from those guards,
  // and it is the WRONG one: under a future `u` flag (the case that reasoning
  // was about) the alternation WOULD match `dKr.ecr`, the ASCII map would leave
  // U+212A alone, the lookup would miss, and the fail-closed arm below would
  // REJECT a host UTS-46 maps onto the plain `dkr.ecr` — re-introducing the
  // issue #1792 failure (a genuine registry going quiet at BOTH entry points)
  // rather than preventing a substitution. Today the alternation refuses that
  // host first, since the `i` flag does not canonicalize U+212A onto `k` in
  // non-unicode mode, so the two spellings are indistinguishable by behaviour
  // and the choice is settled by which one stays correct.
  const form = ECR_HOST_FORM_BY_LABELS.get(m[2]!.toLowerCase());
  // Unreachable while the alternation stays ESCAPED — it is built from this very
  // table — but not dead: measured by de-escaping it, an unescaped `dkr.ecr`
  // matches `dkrxecr`, and this arm is what then refuses the host instead of
  // resolving it as the plain form. Fail-closed rather than an assertion.
  if (!form) return undefined;
  // The account id is `\d{12}`, so it has no case to normalize.
  const region = m[3]!.toLowerCase();
  return {
    accountId: m[1]!,
    region,
    suffix: m[4]!.toLowerCase(),
    // A fixed-suffix form (the dual-stack `on.aws` pair) is checked against its
    // own literal; every other form against the region's partition suffix.
    expectedSuffix: (
      form.fixedUrlSuffix ?? derivePartitionAndUrlSuffix(region).urlSuffix
    ).toLowerCase(),
  };
}

/**
 * The account + region of an ECR image URI, or `undefined` when the URI is not
 * an ECR registry host — either because it does not have one of the shapes
 * {@link ECR_REGISTRY_HOST_FORMS} lists, or because its suffix is not the one
 * the matched form carries for the region it names.
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
  // The captured suffix must be the one the matched form carries — the region's
  // partition suffix, or the form's own fixed literal. Accepting ANY suffix
  // would classify `<acct>.dkr.ecr.<region>.example.com` as ECR and point a
  // `docker login` at a registry cdkd does not own.
  if (m.suffix !== m.expectedSuffix) return undefined;
  return { accountId: m.accountId, region: m.region };
}

/**
 * True when the URI has one of the ECR HOST SHAPES but carries a suffix that
 * form does not serve for the region it names — i.e. exactly the case
 * {@link parseEcrRegistryHost} rejects for a reason the caller may want to
 * report.
 *
 * Since issue #1793 that covers a form / suffix MISPAIRING too, not only a
 * foreign suffix: `<acct>.dkr-ecr.<region>.amazonaws.com` and
 * `<acct>.dkr.ecr.<region>.on.aws` each spell one form's labels with the
 * other's suffix, and AWS serves neither.
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
