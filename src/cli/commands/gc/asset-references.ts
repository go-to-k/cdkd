import type { BootstrapMarker } from '../../../assets/asset-storage.js';
import { PARTITION_TABLE } from '../../../utils/aws-partition.js';
import { ecrRegistryHostPattern } from '../../../utils/ecr-uri.js';
import { escapeRegExp } from '../../../utils/regexp.js';

/**
 * References to one region's asset storage collected from cdkd state files.
 */
export interface AssetReferences {
  /** S3 keys in the asset bucket that some state file references. */
  s3Keys: Set<string>;
  /** ECR image tags in the container repo that some state file references. */
  imageTags: Set<string>;
  /** ECR image digests (`sha256:<hex>`) that some state file references. */
  imageDigests: Set<string>;
}

/**
 * Characters that terminate an S3 key extracted from a URL-shaped string.
 * Whitespace / quotes never appear in cdkd's content-addressed asset keys
 * (`<sha256>.zip` etc.); `?` strips query strings (pre-signed URLs).
 */
const KEY_TERMINATORS = '[^\\s"\'?]';

/**
 * URL suffixes gc must match that {@link PARTITION_TABLE} does NOT carry.
 *
 * Empty today, and deliberately kept as a declared seam rather than dropped:
 * it is what makes gc able to LEAD the derive table (issue #1785) now that
 * {@link AWS_URL_SUFFIXES} is built from it. Two directions need it:
 *
 * - A partition cdkd has recorded state for but whose region prefix is not in
 *   the derive table yet. Adding it here is a one-line, reviewable change that
 *   does not have to wait on the partition-table row.
 * - A suffix RETIRED from the derive table. Coupling propagates additions, but
 *   a row EDITED or removed there would silently stop gc matching state files
 *   already written with the old suffix — the irreversible direction. Such a
 *   suffix moves here rather than disappearing. `tests/unit/cli/gc.test.ts`
 *   fences that with a hand-written floor of the suffixes known today, so a
 *   removal reds until it is carried over deliberately.
 */
const GC_EXTRA_URL_SUFFIXES: readonly string[] = [];

/**
 * Every AWS partition's URL suffix. The asset-reference matchers match the
 * suffix against this CLOSED SET instead of hardcoding one literal
 * (issue #1781).
 *
 * Before this list, all three matchers spelled `amazonaws\.com` inline, so a
 * state file written in `aws-cn` / `us-iso*` / `us-isob*` (recording
 * `amazonaws.com.cn` / `c2s.ic.gov` / `sc2s.sgov.gov` hosts) matched none of
 * them and its assets read as UNREFERENCED.
 *
 * **What that actually deleted, measured rather than assumed.** The blast
 * radius is narrower than "every live asset" but still a silent, irreversible
 * delete:
 *
 * - **S3 was already rescued**, by accident. {@link CONTENT_HASH_KEY_RE}
 *   collects `<sha256>.<ext>` tokens out of ANY string regardless of host, and
 *   cdkd's file assets are content-addressed with an extension — so a
 *   non-commercial `https://…amazonaws.com.cn/<sha256>.zip` still had its key
 *   protected by the name-independent pass. Measured on a real `--dry-run`
 *   against a seeded `cn-north-1` state file: 71 of 72 objects, including the
 *   referenced one, were protected with the matchers still broken.
 * - **ECR was NOT rescued, and is where the bug actually deleted.** cdkd's
 *   image tags are bare 64-hex with no `.<ext>` tail, so the content-hash pass
 *   cannot see them, and digests are `sha256:<hex>` — also no tail. With the
 *   ECR matcher missing the suffix, a referenced non-commercial image is
 *   selected for deletion. That is the case the live test reproduced.
 *
 * Either way the failure direction is the opposite of the #1758 / #1745 sites,
 * which merely emit a host that does not resolve.
 *
 * Two properties of this list are load-bearing:
 *
 * - It is the union over ALL partitions, not
 *   `derivePartitionAndUrlSuffix(region).urlSuffix` for the caller's region.
 *   The scan reads EVERY state file in the state bucket, written by any cdkd
 *   binary for any region, so it must match every partition at once; a single
 *   derived literal would still delete a `cn-north-1` stack's images during a
 *   `us-east-1` gc run.
 * - It is a SUPERSET of the arms {@link derivePartitionAndUrlSuffix} knows
 *   (issue #1764). A suffix missing HERE deletes live assets, which is the
 *   irreversible direction, so this list must lead that table rather than
 *   follow it.
 *
 * The superset property is now MECHANICAL rather than hand-maintained (issue
 * #1785): the list is built FROM {@link PARTITION_TABLE} plus
 * {@link GC_EXTRA_URL_SUFFIXES}, so a partition arm added to that table
 * propagates here in the same commit instead of silently outrunning gc. It
 * used to be a hand-written literal, and the test meant to fence it iterated a
 * hand-written region list — so a new arm in the derive table redded nothing.
 *
 * It is a closed SET rather than a `[^/\s]+` wildcard so a look-alike host
 * (`https://<assetBucket>.s3.<region>.example.com/<key>`) is not treated as a
 * cdkd asset reference. That direction only ever over-PROTECTS, but it would
 * also let any string embedding the bucket name pin an object forever, which
 * quietly turns gc into a no-op.
 *
 * NOTE this is a weaker check than `src/utils/ecr-uri.ts`, which CAPTURES the
 * suffix and validates it against the region the host names. That is the right
 * shape there (one host, one caller-known region) and the wrong shape here:
 * the region in a scanned string is not necessarily the region whose partition
 * the suffix must belong to, and pairing them would re-inherit #1764's missing
 * arms on the irreversible side.
 */
const AWS_URL_SUFFIXES = [
  ...new Set([...PARTITION_TABLE.map((row) => row.urlSuffix), ...GC_EXTRA_URL_SUFFIXES]),
];

/**
 * Spell an ASCII literal so it matches case-INSENSITIVELY inside a
 * case-SENSITIVE `RegExp`: `s3` → `[sS]3`, `amazonaws.com` →
 * `[aA][mM][aA][zZ][oO][nN][aA][wW][sS]\.[cC][oO][mM]`. EVERY character goes
 * through {@link escapeRegExp} first and the ASCII letters are folded after,
 * so the result is exactly as strict as an escaped literal outside the letters
 * it folds.
 *
 * This exists because gc must fold only PART of a pattern (issue #1847). Host
 * names are case-insensitive, so
 * `https://<assetBucket>.s3.<region>.AMAZONAWS.COM/<key>` in a state file names
 * the same object as the lower-cased spelling — and a reference gc misses reads
 * as UNREFERENCED, so the live object is DELETED. The obvious fix, the `i` flag
 * the ECR matcher carries, is per-REGEX and therefore all-or-nothing: it cannot
 * fold the host while leaving a KEY or a path-segment bucket exact, and those
 * segments are genuinely case-sensitive at S3. Which segment gets folded is
 * decided per shape at the matchers themselves — see the block above
 * `s3UriRe` for the authority / path-segment / DNS-label split.
 *
 * Two further properties are load-bearing:
 *
 * - Folding by character class rather than by flag leaves
 *   {@link URL_SUFFIX_ALTERNATION} — SHARED with the ECR matcher — spelled
 *   exactly as that matcher's own review settled it, so the S3 side cannot
 *   quietly redefine the constant the ECR side reads (issues #1792 / #1793).
 * - A two-character class is not `/k/i`. Under a `u` flag the `i` flag
 *   canonicalizes U+212A KELVIN SIGN onto ASCII `k` — the hazard
 *   `src/utils/ecr-uri.ts` guards its region / suffix checks against —
 *   whereas `[kK]` matches those two code points and nothing else, with or
 *   without `u`. (Measured, and pinned by `tests/unit/cli/gc.test.ts`:
 *   `/k/iu` matches U+212A, `/[kK]/u` does not.) The matchers below carry no
 *   `u` flag today, so this is about what adding one later could silently
 *   widen: with classes, nothing.
 */
function caseFoldLiteral(literal: string): string {
  // Escape FIRST, then fold: {@link escapeRegExp} only ever inserts backslashes,
  // and a backslash is not `[A-Za-z]`, so the letters of the escaped string are
  // exactly the letters of the input and the two passes cannot interfere.
  return escapeRegExp(literal).replace(
    /[A-Za-z]/g,
    (ch) => `[${ch.toLowerCase()}${ch.toUpperCase()}]`
  );
}

/**
 * `(?:amazonaws\.com\.cn|amazonaws\.com|...)` — {@link AWS_URL_SUFFIXES} as a
 * non-capturing alternation, LONGEST FIRST so `amazonaws.com.cn` is tried
 * before its own `amazonaws.com` prefix instead of relying on backtracking.
 *
 * The `(?:` is load-bearing, not stylistic: every matcher below reads its
 * results by GROUP INDEX (`match[1]` is the S3 key / the ECR tag, `match[2]`
 * the ECR digest), and this alternation sits BEFORE those groups in all three
 * patterns. Making it capturing would shift every index by one and silently
 * collect the suffix as if it were a key.
 *
 * `spellSuffix` decides how each suffix is written out, so the SET, the
 * longest-first order and the non-capturing property keep exactly one
 * definition while the two consumers differ in case handling — see
 * {@link URL_SUFFIX_ALTERNATION_CASE_FOLDED}.
 */
function buildUrlSuffixAlternation(spellSuffix: (suffix: string) => string): string {
  return `(?:${[...AWS_URL_SUFFIXES]
    .sort((a, b) => b.length - a.length)
    .map(spellSuffix)
    .join('|')})`;
}

/**
 * The case-SENSITIVE spelling, consumed by {@link ECR_REGISTRY_HOST}.
 *
 * Folding THIS constant would be inert for its only consumer — the ECR matcher
 * carries the `i` flag, so it already matches an upper-cased suffix either way.
 * The constraint is the other direction: this is the spelling the ECR side's
 * own review settled on (issues #1792 / #1793), and the S3 matchers must widen
 * through their own {@link URL_SUFFIX_ALTERNATION_CASE_FOLDED} copy rather than
 * by editing the shared one, so an S3-side change can never reach the ECR
 * grammar.
 */
const URL_SUFFIX_ALTERNATION = buildUrlSuffixAlternation(escapeRegExp);

/**
 * The case-FOLDED spelling, consumed by the three S3 matchers (issue #1847).
 * Same suffix set, same order, letters folded per {@link caseFoldLiteral} — so
 * an upper-cased or mixed-case host suffix collects the key. Still a CLOSED
 * set: folding widens the SPELLING of each suffix, never which suffixes count.
 */
const URL_SUFFIX_ALTERNATION_CASE_FOLDED = buildUrlSuffixAlternation(caseFoldLiteral);

/**
 * `[sS]3`, case-folded (issue #1847). One constant for BOTH places the literal
 * `s3` appears: the `s3://` URI SCHEME and the `s3` HOST LABEL of the two HTTPS
 * shapes. The two roles differ but the spelling and the fold argument are the
 * same, and a single constant is what stops the three matchers drifting into
 * two different spellings of it.
 */
const S3_SEGMENT_CASE_FOLDED = caseFoldLiteral('s3');

/**
 * `[hH][tT][tT][pP][sS]` — the URI scheme, case-folded (issue #1847). A scheme
 * is case-insensitive by RFC 3986 §3.1, and folding a fixed literal that is
 * neither the bucket name nor the key can only ever over-PROTECT.
 */
const HTTPS_SCHEME_CASE_FOLDED = caseFoldLiteral('https');

/**
 * The HOST half of an ECR registry, built from the ONE authoritative FORM TABLE
 * in `src/utils/ecr-uri.ts` (issue #1793) instead of spelled a second time here.
 *
 * That module owns which segment spellings AWS serves — the plain
 * `<acct>.dkr.ecr.<region>.<urlSuffix>`, its FIPS sibling
 * `<acct>.dkr.ecr-fips.<region>.<urlSuffix>`, and the two dual-stack forms
 * `<acct>.dkr-ecr[-fips].<region>.on.aws` — while each matcher keeps its own
 * suffix-ACCEPTANCE rule on top: gc passes the union over every partition
 * ({@link URL_SUFFIX_ALTERNATION}), whereas `parseEcrRegistryHost` pairs the
 * captured suffix WITH the region. See the {@link AWS_URL_SUFFIXES} doc for why
 * the two strictnesses are deliberate and must not be merged.
 *
 * gc is the ONLY consumer of {@link ecrRegistryHostPattern}: the strict matcher
 * there needs the suffix captured at a fixed group index and so re-spells the
 * alternation off the same table's labels column. What the two share is the
 * TABLE, not the pattern — enough to stop the FORMS drifting, which is what had
 * gone wrong, and the cross-matcher test in `tests/unit/cli/gc.test.ts` is driven
 * off the table so a row added there must work on both sides.
 *
 * Sharing the table immediately brought a form gc was MISSING:
 * `<acct>.dkr-ecr-fips.<region>.on.aws`, the dual-stack FIPS endpoint. A form
 * missing here reads a live image as unreferenced and DELETES it, so this is the
 * irreversible direction — which is the whole argument for one definition.
 *
 * `on.aws` still does not reach the S3 matchers, and now cannot: it is an
 * ECR-only endpoint, so folding it into the shared suffix set would also make
 * `https://<assetBucket>.s3.<region>.on.aws/<key>` a recognized S3 reference —
 * and in the form table a fixed suffix travels WITH its own form rather than
 * sitting in a shared set, so that separation is mechanical instead of
 * remembered.
 *
 * Account and region are matched loosely on purpose (see the extractor doc):
 * collecting a reference from another account's or region's URI can only KEEP
 * more, never delete more — which is also why the extra forms are worth
 * carrying even though cdkd's own publisher writes the plain one.
 *
 * Every group is non-capturing, for the {@link URL_SUFFIX_ALTERNATION} reason;
 * {@link ecrRegistryHostPattern} guarantees it for the groups IT adds.
 */
const ECR_REGISTRY_HOST = ecrRegistryHostPattern({
  accountId: '\\d{12}',
  region: '[a-z0-9-]+',
  partitionUrlSuffix: URL_SUFFIX_ALTERNATION,
});

/**
 * cdkd's publishers write content-addressed keys (`<sha256>.<ext>`). A
 * second, name-independent pass collects every such token from every
 * scanned string — belt-and-braces against URL captures that ran through
 * an embedded separator (e.g. two `s3://` URIs joined by a comma yield ONE
 * over-long capture, leaving both real keys unprotected). Over-collection
 * only ever KEEPS more.
 */
const CONTENT_HASH_KEY_RE = /\b[0-9a-f]{64}\.[A-Za-z0-9]+\b/g;

/**
 * Try to decode a base64-looking string (e.g. `Fn::Base64`-resolved EC2 /
 * ASG UserData stored in state) so references INSIDE it are collected too —
 * an `aws s3 cp s3://<assetBucket>/<key>` in UserData is a long-lived
 * reference (every future scale-out fetches it at boot). Returns null for
 * strings that are not plausibly base64-encoded text; a binary decode is
 * rejected by the control-character check. Hex strings (valid base64
 * alphabet) decode to binary and are rejected the same way.
 */
function tryDecodeBase64Text(value: string): string | null {
  if (value.length < 24 || value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x08\x0e-\x1f\ufffd]/.test(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Per-(bucket, repo) reference extractors. Built once per run.
 *
 * Matched shapes (all carry the bucket / repo name verbatim):
 * - (bucket, key) location OBJECTS — any object carrying the asset bucket
 *   name as a value (`{S3Bucket, S3Key}` Lambda Code, `{Bucket, Key}`
 *   ApiGateway BodyS3Location / SFN DefinitionS3Location, ...) — handled
 *   in the walk itself; every sibling string value is collected.
 * - `s3://<assetBucket>/<key>` URIs.
 * - `https://<assetBucket>.s3[.<region>].<urlSuffix>/<key>`
 *   (virtual-hosted style, region / dualstack variants included).
 * - `https://s3[.<region>].<urlSuffix>/<assetBucket>/<key>` (path style).
 * - `<ecrHost>/<containerRepo>:<tag>` and/or `...@sha256:<digest>` image
 *   URIs, where `<ecrHost>` is {@link ECR_REGISTRY_HOST}. Account / region
 *   are matched loosely on purpose: collecting a reference from another
 *   account's or region's URI can only over-protect (keep more), never
 *   delete more.
 *
 * `<urlSuffix>` in the two S3 shapes is
 * {@link URL_SUFFIX_ALTERNATION_CASE_FOLDED}, i.e. EVERY partition's suffix at
 * once — see {@link AWS_URL_SUFFIXES} for why a per-region derived literal is
 * the wrong shape here (issue #1781). Every S3 HOST segment is matched
 * case-insensitively, including the bucket label of the virtual-hosted shape,
 * while the KEY and the bucket in the other two shapes stay EXACT (issue
 * #1847); the per-shape reasoning is in the block above `s3UriRe`.
 */
function buildReferenceExtractors(marker: BootstrapMarker): {
  extractFromString: (value: string, refs: AssetReferences) => void;
} {
  // The bucket name in TWO spellings, because the right answer differs per URL
  // shape — see the segment notes below.
  const bucketExact = escapeRegExp(marker.assetBucket);
  const bucketFolded = caseFoldLiteral(marker.assetBucket);
  const repo = escapeRegExp(marker.containerRepo);
  // These three stay case-SENSITIVE regexes whose segments are spelled folded
  // where folding is CORRECT, rather than becoming `i`-flagged ones (issue
  // #1847). The flag is per-regex and so all-or-nothing: it cannot fold a host
  // while leaving a key or a path-segment bucket exact.
  //
  // FOLDED in every shape, none of these being a case-sensitive identifier:
  //
  // - The SCHEME (`s3` / `https`) — case-insensitive by RFC 3986 3.1.
  // - The `s3` HOST LABEL.
  // - The SUFFIX (`URL_SUFFIX_ALTERNATION_CASE_FOLDED`) — still a CLOSED set,
  //   so a look-alike host (`...s3.<region>.example.com`) is no more a match
  //   than before; only each suffix's SPELLING widened.
  // - The REGION segment needed nothing: `[^/\s]*` already accepts any case
  //   (and the `s3.dualstack.<region>` / no-region variants with it).
  //
  // NOT FOLDED in any shape: the KEY capture. S3 object keys ARE
  // case-sensitive, so a folded key would be collected in a spelling that can
  // never equal the `ListObjectsV2` key — collected yet INERT, i.e. the live
  // object is still deleted (the mirror of the ECR digest trap below).
  //
  // The BUCKET NAME is the one segment whose answer DIFFERS per shape, because
  // the same name plays a different ROLE in each URL. Reading it as "the bucket
  // is an identifier, so keep it exact everywhere" is wrong on the third shape,
  // and wrong in the deleting direction:
  //
  // - `s3://<bucket>/<key>` — the bucket is the URI AUTHORITY of an SDK/CLI
  //   style URI that is never resolved through DNS; the SDK sends the name as
  //   given. `S3://MYBUCKET/<key>` therefore addresses a DIFFERENT bucket than
  //   the marker's. Note the reason is the MARKER, not S3's naming rules:
  //   legacy pre-2018 `us-east-1` buckets could carry upper case, so
  //   "S3 forbids it" would be false — but the name gc compares against comes
  //   from the bootstrap marker, and `parseBootstrapMarker` holds that to
  //   `validateAssetBucketName`'s lower-case rule (go-to-k/cdkd#4114), so an
  //   upper-cased spelling in a byte-compared position is never this bucket.
  //   Matched EXACTLY.
  // - path-style `https://s3.<region>.<suffix>/<bucket>/<key>` — the bucket is
  //   a PATH segment, and S3 compares those byte for byte. Same conclusion, so
  //   also matched EXACTLY.
  // - virtual-hosted `https://<bucket>.s3.<region>.<suffix>/<key>` — the bucket
  //   is the leftmost label of the HOST, and host names are case-insensitive,
  //   so `https://MYBUCKET.s3.<region>.<suffix>/<key>` reaches the SAME live
  //   object as the lower-cased spelling. Missing it is exactly the
  //   irreversible delete issue #1847 exists to close, so this one is FOLDED.
  //
  // Folding the label here does NOT reintroduce the {@link AWS_URL_SUFFIXES}
  // doc's "pin an object forever" hazard. That warning is about a WILDCARD
  // suffix, which would make any look-alike host count as a reference. A match
  // here still requires the whole anchored shape
  // `https://<name>.s3<...>.<one of the closed suffix set>/<key>` — and a
  // string of that shape IS a reference to the object, so protecting it is
  // correct rather than spurious.
  //
  // The folded label also cannot silently protect the WRONG bucket's keys.
  // Again the reason is the marker rather than a claim about every S3 bucket
  // that has ever existed: the label is matched against the marker's name,
  // which is lower case by construction, so the only spellings it accepts are
  // case-variants of that one name — and a virtual-hosted host resolves
  // case-insensitively, so each of them addresses this same bucket. (A legacy
  // upper-case bucket name could not be reached this way at all: AWS does not
  // serve virtual-hosted-style requests for names that are not DNS-compliant.)
  const s3UriRe = new RegExp(
    `${S3_SEGMENT_CASE_FOLDED}://${bucketExact}/(${KEY_TERMINATORS}+)`,
    'g'
  );
  const virtualHostedRe = new RegExp(
    `${HTTPS_SCHEME_CASE_FOLDED}://${bucketFolded}\\.${S3_SEGMENT_CASE_FOLDED}[^/\\s]*\\.` +
      `${URL_SUFFIX_ALTERNATION_CASE_FOLDED}/(${KEY_TERMINATORS}+)`,
    'g'
  );
  const pathStyleRe = new RegExp(
    `${HTTPS_SCHEME_CASE_FOLDED}://${S3_SEGMENT_CASE_FOLDED}[^/\\s]*\\.` +
      `${URL_SUFFIX_ALTERNATION_CASE_FOLDED}/${bucketExact}/(${KEY_TERMINATORS}+)`,
    'g'
  );
  // The `i` flag is what makes the HOST match case-INSENSITIVELY (issue #1792).
  // DNS is case-insensitive, so a state file recording
  // `<acct>.DKR.ECR.<region>.AMAZONAWS.COM/...` names the same registry, and
  // missing it here reads a live image as unreferenced and DELETES it — the
  // irreversible direction. One flag covers the labels, the region AND the
  // suffix, which per-segment character classes cannot: the suffix alternation
  // is SHARED with the case-sensitive S3 matchers above, so widening it there
  // would change those too.
  //
  // Its reach PAST the host is not uniformly harmless, and the three tails
  // differ — which is why the digest is folded on insert below (see
  // `extractOnce`) instead of stored as captured:
  //
  // - The DIGEST class `[0-9a-f]{64}` is genuinely widened by the flag, to
  //   upper-case hex. A collected digest is compared for EXACT equality against
  //   ECR's `imageDigest`, which is always lower-case, so an upper-cased
  //   `...@SHA256:AAAA...` reference lands in `imageDigests` in a spelling that
  //   can NEVER match — collected but INERT, i.e. the live image is still
  //   selected for deletion. The flag alone does not protect it; lower-casing on
  //   insert is what does. An OCI digest is defined as lower-case hex, so the
  //   fold cannot merge two distinct digests.
  // - The TAG capture is deliberately NOT folded. ECR tags ARE case-sensitive
  //   (`MyTag` and `mytag` are two tags), so the verbatim capture is the
  //   matching spelling and folding it would create the mirror-image inert
  //   collection.
  // - The `<repo>` segment is matched as an escaped LITERAL and never captured,
  //   so folding it can only over-collect, i.e. over-PROTECT.
  const ecrRe = new RegExp(
    `${ECR_REGISTRY_HOST}/${repo}` +
      `(?::([A-Za-z0-9_][A-Za-z0-9._-]{0,127}))?(?:@(sha256:[0-9a-f]{64}))?`,
    'gi'
  );

  const extractOnce = (value: string, refs: AssetReferences): void => {
    for (const re of [s3UriRe, virtualHostedRe, pathStyleRe]) {
      for (const match of value.matchAll(re)) {
        if (match[1]) refs.s3Keys.add(match[1]);
      }
    }
    for (const match of value.matchAll(ecrRe)) {
      // Tag verbatim, digest FOLDED — see the `ecrRe` comment above for why the
      // two tails differ. `toLowerCase()` is safe on a digest specifically
      // because the character set is `sha256:` + hex, which has no Unicode
      // special case (unlike the region / suffix guards in `src/utils/ecr-uri.ts`,
      // where U+212A folds onto ASCII `k`).
      if (match[1]) refs.imageTags.add(match[1]);
      if (match[2]) refs.imageDigests.add(match[2].toLowerCase());
    }
    // Name-independent content-hash pass (see CONTENT_HASH_KEY_RE).
    for (const match of value.matchAll(CONTENT_HASH_KEY_RE)) {
      refs.s3Keys.add(match[0]);
    }
  };

  return {
    extractFromString(value: string, refs: AssetReferences): void {
      extractOnce(value, refs);
      // One decode level covers Fn::Base64-resolved UserData in state.
      const decoded = tryDecodeBase64Text(value);
      if (decoded !== null) {
        extractOnce(decoded, refs);
      }
    },
  };
}

/**
 * Deep-walk a parsed state file and collect every reference to the target
 * region's asset bucket / container repo into `refs`.
 *
 * The walk covers the ENTIRE state document — a superset of the spec'd
 * `properties` / `observedProperties` / `attributes` / `outputs` fields —
 * because over-collection can only KEEP more (safe direction) and a future
 * state field carrying an asset reference is then protected automatically.
 * Unexpected value types are walked defensively (arrays / objects
 * recursed, non-strings ignored).
 */
export function collectAssetReferences(
  stateDocument: unknown,
  marker: BootstrapMarker,
  refs: AssetReferences
): void {
  const { extractFromString } = buildReferenceExtractors(marker);

  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      extractFromString(value, refs);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      // Any object carrying the asset bucket name as a VALUE is treated as
      // a (bucket, key) location shape: `{S3Bucket, S3Key}` (Lambda Code,
      // nested-stack TemplateURL pairs), `{Bucket, Key}` (ApiGateway
      // BodyS3Location, StepFunctions DefinitionS3Location), and any
      // future variant. EVERY sibling string value is collected as a
      // candidate key — a non-key sibling merely protects a key that does
      // not exist (safe over-collection), while a missed shape would
      // delete a live asset (found as a review blocker on this PR).
      const values = Object.values(record);
      if (values.some((v) => v === marker.assetBucket)) {
        for (const v of values) {
          if (typeof v === 'string' && v !== marker.assetBucket) {
            refs.s3Keys.add(v);
          }
        }
      }
      for (const item of values) walk(item);
    }
  };

  walk(stateDocument);
}
