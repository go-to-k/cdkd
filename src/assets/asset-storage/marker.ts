import { getLogger } from '../../utils/logger.js';
import { CdkdError } from '../../utils/error-handler.js';
import {
  parseFailureDebugDetail,
  jsonParseFailureStandIn,
  utf8ByteLength,
} from '../../utils/json-parse-failure.js';
import type { S3StateBackend } from '../../state/s3-state-backend.js';
import { canonicalizeRegion } from '../../utils/aws-partition.js';
import { displayIdent, safeMsg, STACK_REF_MAX_CODE_POINTS } from '../../utils/display-safe.js';
import { ASSET_SUPPORT_VERSION, BOOTSTRAP_MARKER_PREFIX } from './names.js';

/**
 * State-bucket key of the bootstrap marker for a region.
 */
export function getBootstrapMarkerKey(region: string): string {
  return `${BOOTSTRAP_MARKER_PREFIX}${region}.json`;
}

/**
 * Outcome of {@link readBootstrapMarkerBody}.
 */
export interface BootstrapMarkerRead {
  /** The marker body, or `null` when neither spelling of the key exists. */
  body: string | null;
  /**
   * The key the body ACTUALLY came from. On a miss this is the canonical key.
   *
   * Every caller must follow it rather than re-deriving `getBootstrapMarkerKey`:
   * `parseBootstrapMarker` names it in its error messages, `cdkd gc` prints it,
   * and `cdkd bootstrap --destroy` DELETES it — deleting the canonical key when
   * the body came from the raw one orphans the marker (a review catch on issue
   * #1995's PR).
   */
  resolvedKey: string;
}

/**
 * Read a region's bootstrap marker, probing the CANONICAL key first and the
 * region's RAW spelling second (issues #1836 / #1995 / #2021).
 *
 * Why two probes: the READ side folds region case (SDK endpoint resolution is
 * case-sensitive, and folding also keeps one region from occupying two cache
 * slots), but the WRITE side does not — `cdkd bootstrap` derives its region as
 * `options.region || AWS_REGION || 'us-east-1'` verbatim and uses that spelling
 * for {@link getBootstrapMarkerKey}. Aligning the write side is issue #1820's
 * lane; until then this read is independent of it.
 *
 * HOW REACHABLE the raw key actually is (measured for #2021, because this PR
 * turns the probe into a SHARED contract for four callers and the earlier
 * per-caller comments overstated it). A plain `AWS_REGION=US-EAST-1 cdkd
 * bootstrap` CANNOT write `cdkd-bootstrap/US-EAST-1.json`: the marker is
 * written LAST, and both resources have to be created first with names derived
 * from that same raw region — `getCdkdAssetBucketName` yields
 * `cdkd-assets-<acct>-US-EAST-1`, which S3 rejects as a bucket name, and
 * `region !== 'us-east-1'` is true for `US-EAST-1` so `CreateBucket` is also
 * handed `LocationConstraint: 'US-EAST-1'`, an invalid enum value. The
 * conventional name is never run through `validateAssetBucketName` (that guards
 * only `--asset-bucket`), so it fails at S3 rather than earlier. The raw key is
 * therefore reachable only when ALL of these hold:
 *
 * 1. both `--asset-bucket` and `--container-repo` are given as valid lowercase
 *    names, so neither conventional name is derived from the raw region; AND
 * 2. the asset bucket ALREADY EXISTS and is owned by this account, so the
 *    `CreateBucket` carrying the bad `LocationConstraint` is never issued;
 *
 * plus, outside that flow, a marker written by hand or by a cdkd predating
 * those guards. Probe 2 is kept rather than dropped because that state is real
 * and losing it silently re-points a bootstrapped region at `cdk gc`-collectable
 * storage — the exact #2021 failure — while the cost is one extra `GetObject`
 * on a non-canonical region only. It is skipped entirely when the region was
 * already canonical, so the common path still costs exactly one `GetObject`.
 * Both conditions are pinned by tests, so this claim cannot rot silently.
 *
 * This helper deliberately does NOT catch: each caller keeps its own policy on
 * top (`cdkd gc` / `cdkd bootstrap --destroy` translate `NoSuchBucket` into a
 * "never bootstrapped" message and hard-error on anything else;
 * `loadBootstrapContainerRepo` is best-effort and warns-and-falls-back).
 */
export async function readBootstrapMarkerBody(
  stateBackend: Pick<S3StateBackend, 'getRawObject'>,
  rawRegion: string,
  opts: { logPrefix?: string } = {}
): Promise<BootstrapMarkerRead> {
  const canonicalKey = getBootstrapMarkerKey(canonicalizeRegion(rawRegion));
  const rawKey = getBootstrapMarkerKey(rawRegion);

  const body = await stateBackend.getRawObject(canonicalKey);
  if (body !== null || rawKey === canonicalKey) {
    return { body, resolvedKey: canonicalKey };
  }

  const rawBody = await stateBackend.getRawObject(rawKey);
  if (rawBody === null) {
    // Neither spelling exists — report the CANONICAL key as the resolved one,
    // so a caller's not-found message names the key a canonical-region
    // `cdkd bootstrap` would write.
    return { body: null, resolvedKey: canonicalKey };
  }

  const subject = opts.logPrefix ? `${opts.logPrefix}: bootstrap marker` : 'Bootstrap marker';
  getLogger().debug(
    `${subject} found at the un-folded key '${rawKey}' (none at '${canonicalKey}') — ` +
      `an upper-cased region was used at 'cdkd bootstrap' time.`
  );
  return { body: rawBody, resolvedKey: rawKey };
}

/**
 * Pragmatic S3 bucket-name check for `cdkd bootstrap --asset-bucket`
 * (issue #1011): 3-63 chars, lowercase letters / digits / dots / hyphens,
 * starting and ending with a letter or digit. Rejecting before any AWS call
 * gives a clearer error than S3's own `InvalidBucketName`.
 */
const ASSET_BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/**
 * Pragmatic ECR repository-name check for `cdkd bootstrap --container-repo`
 * (issue #1011): 2-256 chars of `[a-z0-9]` runs joined by single `.` / `_` /
 * `-` / `/` separators (no leading / trailing / doubled separators).
 */
const CONTAINER_REPO_NAME_PATTERN = /^[a-z0-9]+(?:[._\-/][a-z0-9]+)*$/;

/**
 * Validate a custom asset bucket name (`cdkd bootstrap --asset-bucket`).
 * Throws before any AWS call so a typo never reaches S3.
 */
export function validateAssetBucketName(name: string): void {
  if (!ASSET_BUCKET_NAME_PATTERN.test(name)) {
    throw new CdkdError(
      `--asset-bucket '${name}' is not a valid S3 bucket name. Bucket names must be ` +
        `3-63 characters of lowercase letters, digits, dots, and hyphens, and must ` +
        `start and end with a letter or digit.`,
      'INVALID_ASSET_STORAGE_NAME'
    );
  }
}

/** The ECR repository name rule `validateContainerRepoName` and the marker parse share. */
function isValidContainerRepoName(name: string): boolean {
  return name.length >= 2 && name.length <= 256 && CONTAINER_REPO_NAME_PATTERN.test(name);
}

/**
 * Validate a custom container-asset ECR repository name
 * (`cdkd bootstrap --container-repo`). Throws before any AWS call.
 */
export function validateContainerRepoName(name: string): void {
  if (!isValidContainerRepoName(name)) {
    throw new CdkdError(
      `--container-repo '${name}' is not a valid ECR repository name. Repository names ` +
        `must be 2-256 characters of lowercase letters and digits, optionally separated ` +
        `by single '.', '_', '-', or '/' characters (no leading, trailing, or doubled ` +
        `separators).`,
      'INVALID_ASSET_STORAGE_NAME'
    );
  }
}

/**
 * Bootstrap marker object written by `cdkd bootstrap` to
 * `s3://{stateBucket}/cdkd-bootstrap/{region}.json`. Its presence records
 * explicit user intent ("I ran the new bootstrap for this region") — chosen
 * over a `HeadBucket` probe on the conventional name because a marker is
 * immune to name-squatting / coincidence and gives future custom-name
 * support a natural home (design §4.1).
 */
export interface BootstrapMarker {
  /** cdkd-owned S3 bucket that file assets will be published to. */
  assetBucket: string;
  /** cdkd-owned ECR repository that container-image assets will be pushed to. */
  containerRepo: string;
  /** Marker schema version ({@link ASSET_SUPPORT_VERSION}). */
  assetSupportVersion: number;
  /** ISO-8601 timestamp of the bootstrap run that wrote the marker. */
  createdAt: string;
}

/**
 * Deploy-time asset mode for one (account, region) pair.
 *
 * - `legacy` — no marker: publish to the `assets.json` destinations verbatim,
 *   byte-identical to pre-#1002 behavior.
 * - `cdkd-assets` — marker present: assets belong in the cdkd-owned storage
 *   named by the marker (redirection + rewrite land in PR 2 of the phasing).
 */
export type AssetMode = { mode: 'legacy' } | { mode: 'cdkd-assets'; marker: BootstrapMarker };

/**
 * A marker-side name for a sentence (go-to-k/cdkd#3950): `'value'` when it is
 * a plain identifier, and `description` otherwise.
 *
 * `cdkd state info` takes the marker key from an S3 listing (the other callers
 * build it from a region), and the bucket / repository names come from the
 * marker's body, so anyone with `s3:PutObject` on the state bucket can choose
 * them. Inside cdkd's own `'...'` a `'` in such a value closes the
 * quote, and a JSON-quoted `$( )` would still run in a sentence that names
 * `cdkd bootstrap`, so a value that is not plain is described, not shown.
 * "Plain" is `displayIdent` returning the value unchanged: that admits only
 * `[A-Za-z0-9:_@./+=,~-]`, nothing a shell acts on mid-word, and it takes the
 * `/` every marker key carries, which `isPasteableIdent` refuses. The cap is
 * the stack-ref one, above S3's 1024-byte key limit, so a legitimate key is
 * never cut.
 */
export function quotedIfPlain(value: string, description: string): string {
  return isPlainName(value) ? `'${value}'` : description;
}

/**
 * Whitespace is refused before the round-trip: a value that IS `displayIdent`'s
 * own cut output (`<cap chars> [cut: N more characters withheld, tail
 * sha256:<hex>]`) is then refused without resting on the marker's tail digest
 * (go-to-k/cdkd#4109, go-to-k/cdkd#4002).
 */
export function isPlainName(value: string): boolean {
  return (
    !/\s/.test(value) && displayIdent(value, { maxCodePoints: STACK_REF_MAX_CODE_POINTS }) === value
  );
}

/**
 * An asset bucket / repository name printed UNQUOTED in a progress line. With
 * no `--asset-bucket` / `--container-repo`, `ensureAssetStorage` takes the
 * name from the marker's body, so it goes through `displayIdent`: a real name
 * reads as itself, and any other is JSON-quoted rather than printed raw
 * (go-to-k/cdkd#4109).
 */
export function shownName(value: string): string {
  return displayIdent(value, { maxCodePoints: STACK_REF_MAX_CODE_POINTS });
}

/**
 * The names a malformed marker being rewritten recorded that the rewrite does
 * NOT keep, for the rewrite warning (go-to-k/cdkd#4114): a marker with one
 * invalid name loses its valid one too, so storage it tracked is no longer
 * found by `cdkd gc` / `bootstrap --destroy` unless the operator is told which.
 * A recorded name equal to the one written back is omitted, so the clause is
 * never a false alarm. Rendered through `shownName`; empty when nothing is
 * dropped.
 */
export function droppedMarkerNames(
  body: string,
  assetBucket: string,
  containerRepo: string
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return '';
  }
  const fields = (parsed ?? {}) as { assetBucket?: unknown; containerRepo?: unknown };
  const dropped = (value: unknown, kept: string): value is string =>
    typeof value === 'string' && value !== '' && value !== kept;
  const named = [
    dropped(fields.assetBucket, assetBucket)
      ? `asset bucket ${shownName(fields.assetBucket)}`
      : undefined,
    dropped(fields.containerRepo, containerRepo)
      ? `container repository ${shownName(fields.containerRepo)}`
      : undefined,
  ].filter((n): n is string => n !== undefined);
  return named.length === 0
    ? ''
    : ` It recorded ${named.join(' and ')}; storage under those names is no longer tracked by cdkd.`;
}

/**
 * `Asset bucket name '<name>'` for a plain name. The name can come from the
 * marker's body (`ensureAssetStorage` reuses it when no `--asset-bucket` is
 * passed, and `verifyAssetStorageExists` checks its region), so any other is
 * described.
 */
export function bucketNameSubject(bucketName: string): string {
  return isPlainName(bucketName)
    ? `Asset bucket name '${bucketName}'`
    : 'An asset bucket name that is not a plain identifier';
}

/** The subject of the marker refusals: the marker named by its key when that is plain. */
export function markerSubject(markerKey: string): string {
  return isPlainName(markerKey)
    ? `Bootstrap marker '${markerKey}'`
    : 'A bootstrap marker whose key is not a plain identifier';
}

/**
 * Parse and validate a bootstrap marker body.
 *
 * Throws on malformed JSON or missing required fields — a corrupt marker is
 * treated like the marker-present-but-resources-missing case (hard error,
 * never a silent legacy fallback that would flip-flop stack properties
 * between deploys — design §4.1).
 */
export function parseBootstrapMarker(body: string, markerKey: string): BootstrapMarker {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    // A snippet-free STAND-IN as the cause, not V8's `SyntaxError` (issue
    // #5254): V8 quotes a window of the marker body, and `formatError` prints
    // a cause on its `Caused by:` line. The stand-in is still a `SyntaxError`
    // and carries the offset and size; V8's own text goes to `debug` only.
    getLogger().debug(
      safeMsg`${markerSubject(markerKey)} failed to parse: ${parseFailureDebugDetail(error)}`
    );
    throw new CdkdError(
      `${markerSubject(markerKey)} in the state bucket is not valid JSON. ` +
        `Re-run 'cdkd bootstrap' for this region to rewrite it.`,
      'INVALID_BOOTSTRAP_MARKER',
      jsonParseFailureStandIn(error, utf8ByteLength(body))
    );
  }
  const marker = parsed as Partial<BootstrapMarker>;
  // Version check FIRST: a future marker version may rename / remove the
  // v1 required fields, and classifying it as merely "malformed" would let
  // ensureAssetStorage's corrupt-marker rewrite path clobber it with v1
  // semantics — exactly what this guard exists to prevent.
  if (
    typeof marker.assetSupportVersion === 'number' &&
    marker.assetSupportVersion > ASSET_SUPPORT_VERSION
  ) {
    // A newer cdkd wrote this marker with semantics this binary does not
    // know. Interpreting it under v1 rules could publish to the wrong
    // destination — hard error instead (the marker is the user's explicit
    // opt-in, so silent legacy fallback is equally wrong here).
    throw new CdkdError(
      `${markerSubject(markerKey)} has assetSupportVersion ` +
        `${marker.assetSupportVersion}, but this cdkd only understands up to ` +
        `${ASSET_SUPPORT_VERSION}. Upgrade cdkd to deploy in this region.`,
      'UNSUPPORTED_BOOTSTRAP_MARKER_VERSION'
    );
  }
  if (
    typeof marker.assetBucket !== 'string' ||
    marker.assetBucket.length === 0 ||
    typeof marker.containerRepo !== 'string' ||
    marker.containerRepo.length === 0 ||
    typeof marker.assetSupportVersion !== 'number'
  ) {
    throw new CdkdError(
      `${markerSubject(markerKey)} in the state bucket is malformed ` +
        `(missing assetBucket / containerRepo / assetSupportVersion). ` +
        `Re-run 'cdkd bootstrap' for this region to rewrite it.`,
      'INVALID_BOOTSTRAP_MARKER'
    );
  }
  // The names are held to the `--asset-bucket` / `--container-repo` rules, as
  // every marker cdkd writes already is (go-to-k/cdkd#4114). The body is chosen
  // by anyone with `s3:PutObject` on the state bucket, and every reader sends
  // these names to S3 / ECR or deletes by them. A name no real bucket or
  // repository can have is malformed, so `cdkd bootstrap` rewrites the marker
  // and every other reader refuses.
  if (
    !ASSET_BUCKET_NAME_PATTERN.test(marker.assetBucket) ||
    !isValidContainerRepoName(marker.containerRepo)
  ) {
    throw new CdkdError(
      `${markerSubject(markerKey)} in the state bucket is malformed ` +
        `(its asset bucket or container repository name is not a valid name). ` +
        `Re-run 'cdkd bootstrap' for this region to rewrite it.`,
      'INVALID_BOOTSTRAP_MARKER'
    );
  }
  return {
    assetBucket: marker.assetBucket,
    containerRepo: marker.containerRepo,
    assetSupportVersion: marker.assetSupportVersion,
    createdAt: typeof marker.createdAt === 'string' ? marker.createdAt : '',
  };
}
