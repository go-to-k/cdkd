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

import {
  RETRYABLE_HTTP_STATUS_CODES,
  THROTTLING_ERROR_NAMES,
} from '../deployment/retryable-errors.js';
import { withRetry, type RetryLogger } from '../deployment/retry.js';
import { matchesCdkPath, type AwsTag } from './import-helpers.js';

/** Max number of retries after the first attempt, per API call in the walk. */
const DEFAULT_MAX_RETRIES = 5;
/** Initial backoff; each retry doubles it up to {@link DEFAULT_MAX_DELAY_MS}. */
const DEFAULT_INITIAL_DELAY_MS = 500;
/** Cap for the per-retry delay (0.5s -> 1s -> 2s -> 4s -> 5s, ~12.5s total). */
const DEFAULT_MAX_DELAY_MS = 5_000;

/**
 * Walk the error + its `.cause` chain (bounded, mirroring the deploy engine's
 * own walk) looking for a throttling signal.
 *
 * Checks, in order:
 *   1. AWS SDK v3 throttling error `name` on the error or any wrapped cause —
 *      most AWS throttles surface as HTTP 400 with the signal only in the name.
 *   2. HTTP 429 / 503 on `$metadata` of the error or any wrapped cause.
 *   3. The canonical `Rate exceeded` message, which several services return
 *      with an HTTP 400 and a service-specific error name.
 *
 * Exported for direct unit testing and for providers whose tag walk cannot use
 * {@link importTagWalk} verbatim.
 */
export function isThrottlingLikeError(error: unknown, message: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current != null; depth++) {
    const name = (current as { name?: unknown }).name;
    if (typeof name === 'string' && THROTTLING_ERROR_NAMES.has(name)) return true;
    const status = (current as { $metadata?: { httpStatusCode?: number } }).$metadata
      ?.httpStatusCode;
    if (status !== undefined && RETRYABLE_HTTP_STATUS_CODES.has(status)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return message.includes('Rate exceeded');
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
  /** Debug logger; receives one line per retry attempt. */
  logger?: RetryLogger;
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
  const retryOpts = {
    maxRetries: options.retry?.maxRetries ?? DEFAULT_MAX_RETRIES,
    initialDelayMs: options.retry?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS,
    maxDelayMs: options.retry?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    isRetryable: (message: string, error: unknown) => isThrottlingLikeError(error, message),
    ...(options.retry?.logger && { logger: options.retry.logger }),
    ...(options.retry?.sleep && { sleep: options.retry.sleep }),
  };

  let marker: string | undefined;
  do {
    const currentMarker = marker;
    const page = await withRetry(() => listPage(currentMarker), logicalId, retryOpts);

    for (const summary of page.items ?? []) {
      const detail = await withRetry(() => describe(summary), logicalId, retryOpts);
      if (detail === undefined) continue;
      if (matchesCdkPath(tagsOf(detail, summary), cdkPath)) {
        return { summary, detail };
      }
    }

    marker = page.nextMarker;
  } while (marker);

  return null;
}
