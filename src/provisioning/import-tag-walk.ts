/**
 * Shared, throttle-tolerant `aws:cdk:path` tag walk for `ResourceProvider.import`.
 *
 * Providers that adopt a resource without an explicit name property fall back
 * to step 3 of the lookup order documented in `./import-helpers.ts`: enumerate
 * the service's `List*`/`Describe*` pages, then issue ONE per-candidate read
 * (`DescribeX` / `ListTagsForResource`) to obtain the tag set — the list
 * summaries usually do not carry tags. That is an inherent **N+1** read
 * pattern: an account with many resources of the type produces one API call
 * per candidate in a tight loop, which is exactly the shape AWS rate-limits.
 *
 * Every provider previously hand-rolled this loop with NO backoff, so a single
 * throttled `Describe*` aborted the whole `cdkd import` run. This helper
 * centralises the loop and wraps BOTH the list page fetch and the per-candidate
 * describe in the deploy engine's `withRetry` with exponential backoff.
 *
 * ## Why a narrower classifier than `isRetryableTransientError`
 *
 * The deploy engine's classifier is tuned for the WRITE path: it also treats
 * eventual-consistency phrasings like `does not exist` / `not authorized to
 * perform` as transient, because a just-created dependency legitimately needs a
 * moment to propagate. On a read-only import walk those messages mean the
 * opposite — the candidate really is gone, or the caller's credentials really
 * lack the permission — and retrying them burns the full backoff budget per
 * candidate before surfacing the true error.
 *
 * So the walk retries throttling ONLY, reusing the deploy engine's throttle
 * tables verbatim ({@link THROTTLING_ERROR_NAMES} /
 * {@link RETRYABLE_HTTP_STATUS_CODES}) rather than maintaining a second copy.
 *
 * ## Batching
 *
 * Batched tag reads are deliberately NOT modelled here: the services this
 * helper currently serves (EMR `DescribeCluster`, DocDB
 * `ListTagsForResource`) expose only single-resource reads. A service that
 * genuinely offers a batch API (e.g. CodeCommit `BatchGetRepositories`) can
 * satisfy several candidates from one call inside its own `describe` callback,
 * or bypass the helper entirely.
 */

import { isThrottlingError } from '../deployment/retryable-errors.js';
import { withRetry, type RetryLogger } from '../deployment/retry.js';
import { getLogger } from '../utils/logger.js';
import { matchesCdkPath, type AwsTag } from './import-helpers.js';

/** Max number of retries after the first attempt, per API call in the walk. */
const DEFAULT_MAX_RETRIES = 5;
/** Initial backoff; each retry doubles it up to {@link DEFAULT_MAX_DELAY_MS}. */
const DEFAULT_INITIAL_DELAY_MS = 500;
/** Cap for the per-retry delay (0.5s -> 1s -> 2s -> 4s -> 5s, ~12.5s total). */
const DEFAULT_MAX_DELAY_MS = 5_000;
/**
 * Wall-clock ceiling for the WHOLE walk (all pages + all candidates), not just
 * one call. Backoff is per-call, so without this a sustained throttle against a
 * large account degrades into `(pages + candidates) x ~12.5s` of near-silent
 * retrying — ~42 minutes for 200 candidates, with no way to tell a slow walk
 * from a hung one. 10 minutes is generous for a healthy walk (a 200-candidate
 * DocDB account completes in seconds when AWS is not throttling) and bounds the
 * pathological case to something a user will wait through.
 */
const DEFAULT_MAX_WALK_MS = 10 * 60_000;
/**
 * Ceiling on pages fetched. A service that returns a non-advancing pagination
 * token (a bug, or a marker cdkd echoes back wrongly) would otherwise spin
 * forever. This is now the shared path every migrated provider runs on, so the
 * guard belongs here rather than in each caller.
 */
const DEFAULT_MAX_PAGES = 1_000;

/**
 * Whether an error hit during the read-only tag walk is a rate-limit rejection
 * worth backing off on.
 *
 * Delegates the error + `.cause` chain traversal to the deploy engine's
 * {@link isThrottlingError} (throttling error names + retryable HTTP statuses,
 * at every cause depth) and adds the canonical `Rate exceeded` message, which
 * several services return with an HTTP 400 and a service-specific error name.
 *
 * This is deliberately NARROWER than `isRetryableTransientError`: that
 * classifier also treats write-path eventual-consistency phrasings (`does not
 * exist`, `not authorized to perform`) as transient, because a just-created
 * dependency legitimately needs a moment to propagate. On a read-only walk
 * those mean the candidate really is gone or the credentials really lack the
 * permission, and retrying them burns the full backoff budget per candidate
 * before surfacing the true error.
 *
 * Exported for direct unit testing and for providers whose tag walk cannot use
 * {@link importTagWalk} verbatim.
 */
export function isThrottlingLikeError(error: unknown, message: string): boolean {
  return isThrottlingError(error) || message.includes('Rate exceeded');
}

/**
 * Module-level test hooks for the walk's backoff.
 *
 * Providers do not expose a retry option on `import()`, so their wiring tests
 * cannot inject `retry.sleep` per call — without this hook every throttle-path
 * wiring test pays a real 0.5s+ backoff wait. Tests set `sleep` to a resolved
 * no-op in `beforeEach` (and clear it in `afterEach`); a per-call
 * `retry.sleep` still wins when supplied. Never set this in production code.
 */
export const importTagWalkTestHooks: {
  sleep?: ((ms: number) => Promise<void>) | undefined;
} = {};

/** Thrown when the walk exceeds its wall-clock budget or page ceiling. */
export class ImportTagWalkLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportTagWalkLimitError';
  }
}

/** One page of `List*` results plus the marker/token for the next page. */
export interface ImportTagWalkPage<TSummary> {
  /** Candidates on this page. `undefined`/empty is treated as "no candidates". */
  items: readonly TSummary[] | undefined;
  /** Pagination token for the next page; falsy ends the walk. */
  nextMarker?: string | undefined;
}

/** Retry/backoff tuning. Every field is optional; the defaults suit all callers. */
export interface ImportTagWalkRetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  /**
   * Wall-clock ceiling for the WHOLE walk. Defaults to
   * {@link DEFAULT_MAX_WALK_MS}. Checked before each page fetch and each
   * candidate describe; exceeding it throws {@link ImportTagWalkLimitError}.
   */
  maxWalkMs?: number;
  /** Max pages to fetch before giving up. Defaults to {@link DEFAULT_MAX_PAGES}. */
  maxPages?: number;
  /**
   * Debug logger; receives one line per retry attempt and one per skipped
   * candidate. Defaults to the process logger, so a throttled walk is visible
   * under `--verbose` without the caller wiring anything up.
   */
  logger?: RetryLogger;
  /**
   * Interrupt check, invoked once per second while backing off. Throws
   * {@link onInterrupted}'s error to abort the walk early — same seam the
   * deploy path uses so Ctrl-C during a throttled sleep is honored here too.
   */
  isInterrupted?: () => boolean;
  /** Error factory for the {@link isInterrupted} abort. */
  onInterrupted?: () => Error;
  /** Override the sleep implementation (used by tests to skip real waits). */
  sleep?: (ms: number) => Promise<void>;
}

export interface ImportTagWalkOptions<TSummary, TDetail> {
  /**
   * The `aws:cdk:path` value to match. An empty/undefined path short-circuits
   * to `null` without issuing any API call — mirrors the `if (!input.cdkPath)`
   * guard every provider used to carry inline.
   */
  cdkPath: string | undefined;
  /** Fetch one page of candidates. `marker` is `undefined` on the first call. */
  listPage: (marker: string | undefined) => Promise<ImportTagWalkPage<TSummary>>;
  /**
   * Read the per-candidate detail carrying the tags. Return `undefined` to skip
   * the candidate (e.g. it was deleted between the list and the describe).
   */
  describe: (summary: TSummary) => Promise<TDetail | undefined>;
  /** Extract the tag list from the detail (and/or the summary). */
  tagsOf: (detail: TDetail, summary: TSummary) => readonly AwsTag[] | undefined;
  /** Logical id used only in retry log lines. */
  logicalId?: string;
  retry?: ImportTagWalkRetryOptions;
}

/** The matched candidate: both the list summary and the described detail. */
export interface ImportTagWalkMatch<TSummary, TDetail> {
  summary: TSummary;
  detail: TDetail;
}

/**
 * Paginate `listPage`, `describe` each candidate, and return the first one
 * whose tags carry the requested `aws:cdk:path`. Returns `null` when no
 * candidate matches (or when `cdkPath` is empty).
 *
 * Both callbacks are individually retried with exponential backoff on
 * throttling errors, so one rate-limited call mid-walk no longer aborts the
 * whole import.
 */
export async function importTagWalk<TSummary, TDetail>(
  options: ImportTagWalkOptions<TSummary, TDetail>
): Promise<ImportTagWalkMatch<TSummary, TDetail> | null> {
  const { cdkPath, listPage, describe, tagsOf } = options;
  if (!cdkPath) return null;

  const logicalId = options.logicalId ?? 'import';
  const logger = options.retry?.logger ?? getLogger();
  const maxWalkMs = options.retry?.maxWalkMs ?? DEFAULT_MAX_WALK_MS;
  const maxPages = options.retry?.maxPages ?? DEFAULT_MAX_PAGES;

  // Per-call retry.sleep wins over the module-level test hook.
  const sleep = options.retry?.sleep ?? importTagWalkTestHooks.sleep;
  const retryOpts = {
    maxRetries: options.retry?.maxRetries ?? DEFAULT_MAX_RETRIES,
    initialDelayMs: options.retry?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS,
    maxDelayMs: options.retry?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    isRetryable: (message: string, error: unknown) => isThrottlingLikeError(error, message),
    logger,
    ...(options.retry?.isInterrupted && { isInterrupted: options.retry.isInterrupted }),
    ...(options.retry?.onInterrupted && { onInterrupted: options.retry.onInterrupted }),
    ...(sleep && { sleep }),
  };

  const startedAt = Date.now();
  const assertWithinBudget = (stage: string): void => {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= maxWalkMs) {
      throw new ImportTagWalkLimitError(
        `Timed out looking up ${logicalId} by its aws:cdk:path tag after ${Math.round(elapsed / 1000)}s ` +
          `(limit ${Math.round(maxWalkMs / 1000)}s, while ${stage}). ` +
          `AWS is likely throttling the lookup; retry, or pass an explicit physical id with --resource ${logicalId}=<physicalId>.`
      );
    }
  };

  let marker: string | undefined;
  let pages = 0;
  do {
    assertWithinBudget('listing candidates');

    if (++pages > maxPages) {
      throw new ImportTagWalkLimitError(
        `Gave up looking up ${logicalId} by its aws:cdk:path tag after ${maxPages} pages ` +
          `(the service may be returning a non-advancing pagination token). ` +
          `Pass an explicit physical id with --resource ${logicalId}=<physicalId>.`
      );
    }

    const currentMarker = marker;
    const page = await withRetry(() => listPage(currentMarker), logicalId, retryOpts);

    for (const summary of page.items ?? []) {
      assertWithinBudget('reading candidate tags');

      const detail = await withRetry(() => describe(summary), logicalId, retryOpts);
      if (detail === undefined) {
        // The candidate was skipped — deleted between the list and the
        // describe, or the provider's describe mapped a not-found to
        // `undefined`. Worth a debug line: a provider that maps a BROADER
        // error class to `undefined` turns a genuine failure into "no match",
        // and cdkd then CREATES a duplicate resource instead of adopting.
        logger.debug(
          `  ↷ Skipped an ${logicalId} import candidate: its detail lookup returned no result`
        );
        continue;
      }
      if (matchesCdkPath(tagsOf(detail, summary), cdkPath)) {
        return { summary, detail };
      }
    }

    marker = page.nextMarker;
  } while (marker);

  return null;
}
