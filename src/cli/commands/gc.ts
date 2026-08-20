import readline from 'node:readline/promises';
import { Command, Option } from 'commander';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { ECRClient, DescribeImagesCommand, BatchDeleteImageCommand } from '@aws-sdk/client-ecr';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { commonOptions } from '../options.js';
import { getLogger } from '../../utils/logger.js';
import type { Logger } from '../../types/config.js';
import { withErrorHandling, CdkdError, normalizeAwsError } from '../../utils/error-handler.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import {
  namedCliRegion,
  rawCliRegion,
  reconcileMarkerRegionWithLegacyDefault,
  resolveEffectiveRegion,
} from '../region-options.js';
import { getDefaultStateBucketName } from '../config-loader.js';
import {
  getBootstrapMarkerKey,
  parseBootstrapMarker,
  readBootstrapMarkerBody,
  type BootstrapMarker,
} from '../../assets/asset-storage.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { PARTITION_TABLE } from '../../utils/aws-partition.js';
import { ecrRegistryHostPattern } from '../../utils/ecr-uri.js';
import { escapeRegExp } from '../../utils/regexp.js';
import {
  listAllStateKeys,
  listAllLockKeys,
  describeStateKey,
  LOCK_FILE_SUFFIX,
} from './state-file-keys.js';

/**
 * `cdkd gc` — garbage-collect unreferenced objects / images from the
 * cdkd-owned asset storage of ONE region (issue #1012).
 *
 * cdkd-owned asset storage (issue #1002) is content-addressed and never
 * deleted on `cdkd destroy` (another stack or a future rollback may
 * reference the same hash), so the asset bucket / container-asset ECR repo
 * grow without bound — and `cdk gc` cannot reach them by design. cdkd can
 * gc them PRECISELY because its state files record exactly which assets
 * are in use.
 *
 * Safety posture (this command DELETES user data — every ambiguity is
 * biased toward NOT deleting):
 *
 * - Names come from the region's bootstrap marker, never recomputed from
 *   the naming convention (custom-name compatibility, issue #1011). No
 *   marker → the region is not opted in; friendly no-op. CDK bootstrap
 *   storage (`cdk-hnb659fds-*`) is never touched — that stays `cdk gc`'s
 *   job.
 * - The reference scan lists EVERY state file in the WHOLE state bucket
 *   (any `--state-prefix`), and a state file that fails to JSON-parse
 *   aborts the whole run — deleting on partial knowledge is how a live
 *   asset gets deleted.
 * - Any stack lock in the bucket aborts the run: a deploy in flight may
 *   have published assets whose state write has not landed yet.
 * - `--older-than` (default 30d) age-guards every deletion: an object /
 *   image newer than the cutoff is kept even when unreferenced (protects
 *   in-flight publishes and recent rollback targets). Missing timestamps
 *   are treated as "new" (kept).
 * - Every S3 call pins `ExpectedBucketOwner`; a 403 on the asset bucket is
 *   a foreign-bucket refusal like the create / teardown sides.
 */

/** Default `--older-than` when the flag is not passed. */
const DEFAULT_OLDER_THAN_MS = 30 * 24 * 60 * 60 * 1000; // 30d

/** S3 `DeleteObjects` accepts at most 1,000 keys per call. */
const S3_DELETE_BATCH_SIZE = 1000;

/** ECR `BatchDeleteImage` accepts at most 100 image ids per call. */
const ECR_DELETE_BATCH_SIZE = 100;

/**
 * Parse the `--older-than` age guard: `<n>d` (days) or `<n>h` (hours),
 * decimals allowed (`1.5d`). Zero, negative, missing-unit, and
 * unknown-unit values are rejected at parse time — a zero / negative age
 * guard would disable the in-flight-publish protection entirely.
 *
 * Kept local (rather than extending `parseDuration` in `options.ts`):
 * the deploy-side duration grammar is seconds/minutes/hours for
 * per-resource deadlines, while gc ages are naturally days — mixing `30s`
 * into an age guard invites typos that all but disable it.
 */
export function parseOlderThan(value: string): number {
  const match = /^(\d+(?:\.\d+)?)([dh])$/.exec(value.trim());
  if (!match) {
    throw new Error(
      `Invalid --older-than "${value}": expected <number>d or <number>h (e.g. 30d, 12h)`
    );
  }
  const num = Number(match[1]);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(`Invalid --older-than "${value}": must be greater than zero`);
  }
  const multiplier = match[2] === 'd' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
  return Math.round(num * multiplier);
}

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
  //   from the bootstrap marker, and `validateAssetBucketName` holds that to
  //   lower case, so an upper-cased spelling in a byte-compared position is
  //   never this bucket. Matched EXACTLY.
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

/**
 * Scan every state file in the state bucket and collect the referenced
 * asset keys / image tags / digests for the marker's bucket + repo.
 *
 * Fail safe: a state file that fails to JSON-parse aborts the whole run —
 * a reference we could not read is a reference we would otherwise delete.
 * A state key that disappeared between the listing and the read (destroy
 * completed concurrently) is skipped: its references are legitimately gone.
 */
async function scanReferencedAssets(
  stateBackend: Pick<S3StateBackend, 'listRawKeys' | 'getRawObject'>,
  marker: BootstrapMarker,
  logger: Logger
): Promise<AssetReferences> {
  const refs: AssetReferences = {
    s3Keys: new Set(),
    imageTags: new Set(),
    imageDigests: new Set(),
  };
  const stateKeys = await listAllStateKeys(stateBackend);
  logger.info(`Scanning ${stateKeys.length} state file(s) for asset references...`);
  for (const key of stateKeys) {
    const body = await stateBackend.getRawObject(key);
    if (body === null) {
      logger.debug(`State file ${key} disappeared during the scan — skipping`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      const described = describeStateKey(key);
      const regionMatch = /^(\S+) \((\S+)\)$/.exec(described);
      const inspectHint = regionMatch
        ? `cdkd state show ${regionMatch[1]} --stack-region ${regionMatch[2]}`
        : `cdkd state show ${described}`;
      throw new CdkdError(
        `State file '${key}' is not valid JSON — aborting: gc must know every ` +
          `referenced asset before deleting anything, and this file's references ` +
          `are unreadable. Repair or remove the corrupt state file ` +
          `('${inspectHint}' to inspect), then re-run.`,
        'GC_STATE_UNREADABLE',
        error as Error
      );
    }
    collectAssetReferences(parsed, marker, refs);
  }
  logger.debug(
    `Referenced: ${refs.s3Keys.size} S3 key(s), ${refs.imageTags.size} image tag(s), ` +
      `${refs.imageDigests.size} image digest(s)`
  );
  return refs;
}

/** An S3 object eligible for deletion. */
interface S3Candidate {
  key: string;
  size: number;
  lastModified: Date;
}

/** An ECR image eligible for deletion. */
interface EcrCandidate {
  digest: string;
  tags: string[];
  size: number;
  pushedAt: Date;
}

/**
 * List the asset bucket (paginated, `ExpectedBucketOwner`) and pick the
 * deletion candidates: keys NOT referenced AND strictly older than the
 * cutoff. Objects with no `LastModified` are kept (treated as new).
 *
 * A missing bucket is an idempotent skip (nothing to gc there); a 403 is
 * a foreign-bucket refusal, mirroring the create / teardown sides.
 */
async function listS3Candidates(
  s3Client: Pick<S3Client, 'send'>,
  bucket: string,
  accountId: string,
  refs: AssetReferences,
  cutoffMs: number,
  logger: Logger
): Promise<S3Candidate[]> {
  const candidates: S3Candidate[] = [];
  let continuationToken: string | undefined;
  try {
    do {
      const response = await s3Client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          ExpectedBucketOwner: accountId,
          ...(continuationToken && { ContinuationToken: continuationToken }),
        })
      );
      for (const obj of response.Contents ?? []) {
        if (!obj.Key) continue;
        if (refs.s3Keys.has(obj.Key)) continue;
        if (!obj.LastModified || obj.LastModified.getTime() >= cutoffMs) continue;
        candidates.push({ key: obj.Key, size: obj.Size ?? 0, lastModified: obj.LastModified });
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);
  } catch (error) {
    const err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err.name === 'NoSuchBucket' || err.name === 'NotFound') {
      logger.info(`Asset bucket ${bucket} does not exist — skipping`);
      return [];
    }
    if (err.$metadata?.httpStatusCode === 403) {
      throw new CdkdError(
        `Asset bucket '${bucket}' exists but is not owned by account ${accountId} ` +
          `(or access is denied). Refusing to touch it.`,
        'ASSET_STORAGE_FOREIGN_BUCKET',
        error as Error
      );
    }
    throw normalizeAwsError(error, { bucket, operation: 'ListObjectsV2' });
  }
  return candidates;
}

/**
 * Describe the container repo's images (paginated) and pick the deletion
 * candidates: an image is REFERENCED when any of its tags OR its digest is
 * in the referenced set; candidates are unreferenced AND strictly older
 * than the cutoff. Images with no `imagePushedAt` are kept (treated as
 * new). A missing repo is an idempotent skip.
 */
async function listEcrCandidates(
  ecrClient: Pick<ECRClient, 'send'>,
  repositoryName: string,
  refs: AssetReferences,
  cutoffMs: number,
  logger: Logger
): Promise<EcrCandidate[]> {
  const candidates: EcrCandidate[] = [];
  let nextToken: string | undefined;
  try {
    do {
      const response = await ecrClient.send(
        new DescribeImagesCommand({
          repositoryName,
          ...(nextToken && { nextToken }),
        })
      );
      for (const image of response.imageDetails ?? []) {
        if (!image.imageDigest) continue;
        const tags = image.imageTags ?? [];
        const referenced =
          refs.imageDigests.has(image.imageDigest) || tags.some((t) => refs.imageTags.has(t));
        if (referenced) continue;
        if (!image.imagePushedAt || image.imagePushedAt.getTime() >= cutoffMs) continue;
        candidates.push({
          digest: image.imageDigest,
          tags,
          size: image.imageSizeInBytes ?? 0,
          pushedAt: image.imagePushedAt,
        });
      }
      nextToken = response.nextToken;
    } while (nextToken);
  } catch (error) {
    const err = error as { name?: string };
    if (err.name === 'RepositoryNotFoundException') {
      logger.info(`Container-asset repository ${repositoryName} does not exist — skipping`);
      return [];
    }
    throw normalizeAwsError(error, { operation: 'DescribeImages' });
  }
  return candidates;
}

/** `12345678` → `11.8 MiB` — human-readable byte count for the plan. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 'B';
  for (const u of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = u;
  }
  return `${value.toFixed(1)} ${unit}`;
}

/** Age of a timestamp relative to now, in whole days (or hours under 1d). */
function formatAge(date: Date): string {
  const ageMs = Date.now() - date.getTime();
  const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  if (days >= 1) return `${days}d old`;
  return `${Math.max(0, Math.floor(ageMs / (60 * 60 * 1000)))}h old`;
}

/**
 * Interactive confirmation for the deletion. Follows the repo's
 * destructive-prompt convention (same pattern family as
 * `promptBootstrapDestroyConfirm`): print the plan as a WARN block,
 * `--yes` skips, a non-TTY stdin without `--yes` is a hard error (never
 * hang / never silently decline in CI), and the prompt defaults to NO.
 */
export async function promptGcConfirm(input: {
  planLines: string[];
  yes: boolean;
  region: string;
}): Promise<boolean> {
  const logger = getLogger();
  logger.warn('');
  // Name the REGION above the plan (issue #2029). Since that value can now come
  // from `~/.aws/config` - a source the user never typed on this command line -
  // the plan must say which region it is about. It was inferrable only by
  // accident before: the DEFAULT storage name embeds the region
  // (`cdkd-assets-<acct>-<region>`), but a bootstrap run with
  // `--asset-bucket` / `--container-repo` prints custom names with no region
  // anywhere, so `-y` deleted in an unnamed region.
  logger.warn(`cdkd gc will delete the following unreferenced assets in ${input.region}:`);
  for (const line of input.planLines) {
    logger.warn(`  - ${line}`);
  }

  if (input.yes) return true;

  if (process.stdin.isTTY !== true) {
    throw new CdkdError(
      'The gc confirmation prompt cannot run in a non-interactive environment. ' +
        'Pass --yes / -y to confirm the deletion, or run the command from a real terminal.',
      'NON_INTERACTIVE_CONFIRM'
    );
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('\nContinue? (y/N): ');
    const trimmed = answer.trim().toLowerCase();
    return trimmed === 'y' || trimmed === 'yes';
  } finally {
    rl.close();
  }
}

/**
 * Delete the S3 candidates via chunked `DeleteObjects` (1,000 keys per
 * call, `ExpectedBucketOwner`). Per-key `Errors` are surfaced as a hard
 * error so gc never reports success while objects remain.
 */
async function deleteS3Candidates(
  s3Client: Pick<S3Client, 'send'>,
  bucket: string,
  accountId: string,
  candidates: S3Candidate[]
): Promise<void> {
  const failures: string[] = [];
  for (let i = 0; i < candidates.length; i += S3_DELETE_BATCH_SIZE) {
    const chunk = candidates.slice(i, i + S3_DELETE_BATCH_SIZE);
    const response = await s3Client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        ExpectedBucketOwner: accountId,
        Delete: { Objects: chunk.map((c) => ({ Key: c.key })), Quiet: true },
      })
    );
    for (const err of response.Errors ?? []) {
      failures.push(`${err.Key ?? '<unknown>'} (${err.Code ?? 'Error'}: ${err.Message ?? ''})`);
    }
  }
  if (failures.length > 0) {
    throw new CdkdError(
      `Failed to delete ${failures.length} object(s) from asset bucket '${bucket}': ` +
        failures.join('; '),
      'GC_DELETE_FAILED'
    );
  }
}

/**
 * Delete the ECR candidates via chunked `BatchDeleteImage` (100 image ids
 * per call), addressed by digest so every tag of the image goes with it.
 * Per-image `failures` are surfaced as a hard error.
 */
async function deleteEcrCandidates(
  ecrClient: Pick<ECRClient, 'send'>,
  repositoryName: string,
  candidates: EcrCandidate[]
): Promise<void> {
  const failures: string[] = [];
  for (let i = 0; i < candidates.length; i += ECR_DELETE_BATCH_SIZE) {
    const chunk = candidates.slice(i, i + ECR_DELETE_BATCH_SIZE);
    const response = await ecrClient.send(
      new BatchDeleteImageCommand({
        repositoryName,
        imageIds: chunk.map((c) => ({ imageDigest: c.digest })),
      })
    );
    for (const failure of response.failures ?? []) {
      failures.push(
        `${failure.imageId?.imageDigest ?? '<unknown>'} ` +
          `(${failure.failureCode ?? 'Error'}: ${failure.failureReason ?? ''})`
      );
    }
  }
  if (failures.length > 0) {
    throw new CdkdError(
      `Failed to delete ${failures.length} image(s) from repository '${repositoryName}': ` +
        failures.join('; '),
      'GC_DELETE_FAILED'
    );
  }
}

export interface GcOptions {
  stateBucket?: string;
  region?: string;
  profile?: string;
  roleArn?: string;
  /** Age guard in milliseconds (parsed from `--older-than`, default 30d). */
  olderThan: number;
  /** Print the reclaim plan and exit without prompting or deleting. */
  dryRun: boolean;
  /** `-y` / `--yes` — skip the interactive confirmation. */
  yes: boolean;
  verbose: boolean;
}

/**
 * `cdkd gc` implementation. See the module JSDoc for the safety posture.
 */
export async function gcCommand(options: GcOptions): Promise<void> {
  const logger = getLogger();

  if (options.verbose) {
    logger.setLevel('debug');
  }

  logger.info('Starting cdkd gc...');
  logger.debug('Options:', options);

  // Resolve --role-arn / CDKD_ROLE_ARN before any AWS call.
  // `namedCliRegion`, not `canonicalizeRegion(options.region)`: this command
  // deliberately skips `foldRegionOption` (so `rawCliRegion` below still sees
  // the user's exact spelling for the marker's second probe), which left the
  // ENV half unfolded here - `AWS_REGION=US-EAST-1 cdkd gc --role-arn ...`
  // passed `undefined`, so `applyRoleArnIfSet` built `new STSClient({})` and
  // the SDK read the raw env itself (`SignatureDoesNotMatch`). Folding the
  // named region covers both halves without disturbing the raw capture.
  await applyRoleArnIfSet({
    roleArn: options.roleArn,
    region: namedCliRegion(options.region),
  });

  // Issue #1995. `region` picks BOTH the AWS clients' endpoints and the
  // bootstrap marker KEY, and the two want different treatment of case:
  //
  // - The CLIENTS need it CANONICAL. SDK endpoint resolution is case-sensitive
  //   (measured in `derivePartitionAndUrlSuffix`'s note: `CN-NORTH-1` resolves
  //   to the COMMERCIAL suffix), so an upper-cased `--region` builds clients
  //   pointing at the wrong partition.
  // - The marker KEY needs BOTH spellings probed. `cdkd bootstrap` derives its
  //   own region verbatim (issue #1820), so `AWS_REGION=US-EAST-1 cdkd
  //   bootstrap` really wrote `cdkd-bootstrap/US-EAST-1.json`. Folding the read
  //   and stopping would MISS that marker where the pre-fold read HIT it, and
  //   gc would report the region as not opted in. The probe below therefore
  //   tries the canonical key first and the raw spelling second — the same
  //   shape `loadBootstrapContainerRepo` uses (`src/cli/commands/
  //   local-state-loader.ts`), and what makes this read independent of when
  //   #1820 aligns the write side.
  //
  // The failure direction here is the SAFE one either way — a missed marker
  // deletes nothing, it just reports "not opted in" for a region that has
  // assets — which is why this is a usability fix rather than a data one.
  // Issue #2029. The region gc operates on now consults the AWS profile, and
  // the region its CLIENTS target is the same value by construction - the two
  // used to be resolved separately and could disagree, so gc could read one
  // region's marker and delete against another region's endpoints.
  //
  // The sequencing is forced by a dependency: the reconciliation has to ask
  // "does a marker already exist under the old default?", which needs the state
  // backend, which needs the bucket name, which needs the account id. So the
  // account lookup runs against a bag built from the UNRECONCILED region. That
  // is safe and not a shortcut: STS is region-agnostic for
  // `GetCallerIdentity`, and the state backend re-resolves the state bucket's
  // own region itself (`rebuildClientForBucketRegion`) because the bucket is
  // account-scoped. Only the ECR / asset-S3 clients are genuinely
  // region-specific, and they are built AFTER the reconciliation.
  const effective = await resolveEffectiveRegion(options);

  const accountClients = new AwsClients({
    region: effective.region,
    ...(options.profile && { profile: options.profile }),
  });

  // Account id is needed for the default bucket name AND for the
  // ExpectedBucketOwner pin on every S3 call, so always resolve it.
  const identity = await accountClients.sts.send(new GetCallerIdentityCommand({}));
  const accountId = identity.Account!;
  const bucketName = options.stateBucket ?? getDefaultStateBucketName(accountId);

  // State-bucket reads (marker, state scan, lock scan) go through the
  // state backend, which resolves the bucket's ACTUAL region itself — the
  // state bucket is account-scoped and may live in a different region
  // than --region. The asset bucket / ECR repo clients keep using --region.
  const markerS3Client = new S3Client({
    region: effective.region,
    ...(options.profile && { profile: options.profile }),
  });
  const stateBackend = new S3StateBackend(
    markerS3Client,
    { bucket: bucketName, prefix: 'cdkd' },
    { region: effective.region, ...(options.profile && { profile: options.profile }) }
  );

  // Hold an existing us-east-1 opt-in rather than silently reporting the region
  // as not opted in. `cdkd bootstrap` writes this key through the SAME resolver
  // and the SAME reconciliation, so the read and write sides cannot drift.
  const region = await reconcileMarkerRegionWithLegacyDefault({
    effective,
    probe: stateBackend,
    markerKeyFor: getBootstrapMarkerKey,
    logger,
  });
  // The RAW spelling, for the marker's second probe only (see the probe below).
  const rawRegion = rawCliRegion(options.region) ?? region;

  const awsClients =
    region === effective.region
      ? accountClients
      : new AwsClients({ region, ...(options.profile && { profile: options.profile }) });
  if (awsClients !== accountClients) accountClients.destroy();
  setAwsClients(awsClients);

  const ecrClient = new ECRClient({
    region,
    ...(options.profile && { profile: options.profile }),
  });

  try {
    // 1. Read the region's bootstrap marker — the source of truth for the
    //    asset bucket / repo names (never recompute the naming convention;
    //    custom-name compatibility, issue #1011). No marker → the region
    //    is not opted in to cdkd asset storage; nothing to gc. CDK
    //    bootstrap storage is deliberately out of scope — `cdk gc` owns it.
    const markerKey = getBootstrapMarkerKey(region);
    const rawMarkerKey = getBootstrapMarkerKey(rawRegion);
    let markerBody: string | null;
    // Which key the body actually came from — `parseBootstrapMarker` names it
    // in its error messages, so a malformed marker must point at the file that
    // really was read.
    let resolvedMarkerKey = markerKey;
    try {
      // Issue #2021 folded the canonical-then-raw probe (issue #1995) into
      // `readBootstrapMarkerBody`. THIS caller's policy is unchanged: the
      // helper does not catch, so `NoSuchBucket` is still translated into the
      // never-bootstrapped message below and every other failure still
      // hard-errors out of the command with nothing collected.
      const read = await readBootstrapMarkerBody(stateBackend, rawRegion);
      markerBody = read.body;
      resolvedMarkerKey = read.resolvedKey;
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchBucket') {
        logger.info(
          `State bucket '${bucketName}' does not exist — this account was never ` +
            `bootstrapped; nothing to garbage-collect.`
        );
        return;
      }
      throw error;
    }
    // NOTE a marker that EXISTS at the canonical key but fails to parse still
    // hard-errors below, and now masks a valid marker at the raw key (pre-#1995
    // only the raw key was ever read for an upper-cased region). That is the
    // safe direction and deliberately not smoothed over: gc deletes nothing on
    // a throw, and silently falling through to another key after finding a
    // CORRUPT one would hide the corruption while gc acted on second-choice
    // names. The remedy is the one the parse error already prints.
    if (markerBody === null) {
      const probed = rawMarkerKey === markerKey ? markerKey : `${markerKey}, ${rawMarkerKey}`;
      logger.info(
        `No bootstrap marker for region '${region}' (${probed}) — the region is not ` +
          `opted in to cdkd asset storage; nothing to garbage-collect. ` +
          `(CDK bootstrap storage is 'cdk gc' territory.)`
      );
      return;
    }
    const marker = parseBootstrapMarker(markerBody, resolvedMarkerKey);

    // 2. Lock guard: ANY stack lock in the bucket aborts — a deploy in
    //    flight may have published assets whose state write has not landed
    //    yet, and gc would see them as unreferenced. Simple and safe for v1.
    const lockKeys = await listAllLockKeys(stateBackend);
    if (lockKeys.length > 0) {
      const listing = lockKeys
        .map((k) => `  - ${describeStateKey(k, LOCK_FILE_SUFFIX)}  [${k}]`)
        .join('\n');
      throw new CdkdError(
        `Refusing to gc while ${lockKeys.length} stack(s) hold an active lock ` +
          `(a deploy in flight may have published assets whose state write has not ` +
          `landed yet):\n${listing}\n` +
          `Wait for the operation(s) to finish — or clear a stale lock with ` +
          `'cdkd force-unlock <stack>' — then re-run 'cdkd gc'.`,
        'GC_LOCKED'
      );
    }

    // 3. Reference collection: scan EVERY state file in the WHOLE bucket.
    const refs = await scanReferencedAssets(stateBackend, marker, logger);

    // 4. Deletion candidates, age-guarded by --older-than.
    const cutoffMs = Date.now() - options.olderThan;
    const s3Candidates = await listS3Candidates(
      awsClients.s3,
      marker.assetBucket,
      accountId,
      refs,
      cutoffMs,
      logger
    );
    const ecrCandidates = await listEcrCandidates(
      ecrClient,
      marker.containerRepo,
      refs,
      cutoffMs,
      logger
    );

    // 5. Nothing to do → info + exit 0, no prompt.
    if (s3Candidates.length === 0 && ecrCandidates.length === 0) {
      logger.info(
        `Nothing to garbage-collect in region '${region}': every object in ` +
          `${marker.assetBucket} / image in ${marker.containerRepo} is either ` +
          `referenced by a deployed stack or newer than the --older-than cutoff.`
      );
      return;
    }

    // 6. Reclaim plan + totals.
    const s3Bytes = s3Candidates.reduce((sum, c) => sum + c.size, 0);
    const ecrBytes = ecrCandidates.reduce((sum, c) => sum + c.size, 0);
    const planLines: string[] = [
      ...s3Candidates.map(
        (c) =>
          `s3://${marker.assetBucket}/${c.key} (${formatBytes(c.size)}, ${formatAge(c.lastModified)})`
      ),
      ...ecrCandidates.map(
        (c) =>
          `${marker.containerRepo}${c.tags.length > 0 ? `:${c.tags.join(',')}` : ''}` +
          `@${c.digest} (${formatBytes(c.size)}, ${formatAge(c.pushedAt)})`
      ),
    ];
    const totals =
      `Total: ${s3Candidates.length} S3 object(s) (${formatBytes(s3Bytes)}) + ` +
      `${ecrCandidates.length} ECR image(s) (${formatBytes(ecrBytes)}) = ` +
      `${formatBytes(s3Bytes + ecrBytes)} reclaimable`;

    if (options.dryRun) {
      logger.info('');
      logger.info(`Dry run — the following unreferenced assets in ${region} would be deleted:`);
      for (const line of planLines) {
        logger.info(`  - ${line}`);
      }
      logger.info(totals);
      logger.info('Dry run: nothing deleted. Re-run without --dry-run to delete.');
      return;
    }

    // 7. Confirmation (default: interactive y/N; `--yes` skips; non-TTY
    //    without `--yes` hard-errors inside the prompt helper).
    const confirmed = await promptGcConfirm({
      planLines: [...planLines, totals],
      yes: options.yes,
      region,
    });
    if (!confirmed) {
      logger.info('gc cancelled — nothing deleted.');
      return;
    }

    // 8. Delete.
    if (s3Candidates.length > 0) {
      await deleteS3Candidates(awsClients.s3, marker.assetBucket, accountId, s3Candidates);
      logger.info(
        `✓ Deleted ${s3Candidates.length} object(s) (${formatBytes(s3Bytes)}) from ` +
          `${marker.assetBucket}`
      );
    }
    if (ecrCandidates.length > 0) {
      await deleteEcrCandidates(ecrClient, marker.containerRepo, ecrCandidates);
      logger.info(
        `✓ Deleted ${ecrCandidates.length} image(s) (${formatBytes(ecrBytes)}) from ` +
          `${marker.containerRepo}`
      );
    }
    logger.info(`\n✓ gc completed: ${formatBytes(s3Bytes + ecrBytes)} reclaimed`);
  } finally {
    ecrClient.destroy();
    // If the backend rebuilt its client for the state bucket's region it
    // already destroyed this one; a second destroy is a safe no-op.
    markerS3Client.destroy();
    awsClients.destroy();
  }
}

/**
 * Create the `cdkd gc` command (upstream `cdk gc` parity naming).
 */
export function createGcCommand(): Command {
  const cmd = new Command('gc')
    .description(
      "Garbage-collect unreferenced objects / images from ONE region's cdkd-owned asset " +
        'storage (asset bucket + container-asset ECR repo). References are collected from ' +
        'every cdkd state file; CDK bootstrap storage is never touched (use cdk gc for that).'
    )
    .option(
      '--state-bucket <bucket>',
      'S3 bucket holding cdkd state (default: cdkd-state-{accountId})'
    )
    .addOption(
      new Option(
        '--older-than <duration>',
        'Never delete an object / image newer than this age, even when unreferenced ' +
          '(protects in-flight publishes and recent rollback targets). Accepts <n>d / <n>h.'
      )
        .default(DEFAULT_OLDER_THAN_MS, '30d')
        .argParser(parseOlderThan)
    )
    .option('--dry-run', 'Print the reclaim plan (per-item list + totals) without deleting', false)
    .addOption(
      // Picks WHICH region's asset storage to gc. Unlike the other commands
      // this one does NOT fall back to a us-east-1 literal - it deletes, so it
      // refuses rather than guessing (issue #2029).
      new Option(
        '--region <region>',
        'Region whose cdkd asset storage to garbage-collect ' +
          '(defaults to AWS_REGION / AWS_DEFAULT_REGION, else the profile region; ' +
          'refuses if none is configured)'
      )
    )
    .action(
      withErrorHandling(async (options: GcOptions): Promise<void> => {
        await gcCommand(options);
      })
    );

  // Add common options (--profile, --role-arn, --verbose, --yes)
  commonOptions.forEach((opt) => cmd.addOption(opt));

  return cmd;
}
