/**
 * Shared plumbing for `ResourceProvider.lookupNames` (go-to-k/cdkd#4705): the
 * plan-time check of which generated names a resource already holds.
 *
 * Every lookup is an EXACT read by name: a batch read by name where the
 * service has one (`DescribeAlarms` `AlarmNames`, `DescribeLogGroups`
 * `logGroupIdentifiers`, `DescribeClusters`), otherwise one read per name.
 * Never a listing (`ListQueues`, `ListTopics`, `ListRules`, ...): a listing is
 * eventually consistent and omitted a queue another deployment had created a
 * minute earlier, so the create adopted it. Every API call goes through ONE
 * run-wide limiter per API, so a `deploy --all` of many stacks shares each
 * API's concurrency instead of multiplying it into throttling.
 */

/** In-flight calls per API, process-wide. */
const inFlight = new Map<string, number>();
const waiting = new Map<string, Array<() => void>>();

/**
 * Run `fn` once fewer than `max` calls of `api` are in flight in this
 * process. The limit absorbs a burst (dozens of alarm chunks, several stacks'
 * probes at once) instead of letting SDK retries cascade.
 */
export async function withApiLimit<T>(api: string, max: number, fn: () => Promise<T>): Promise<T> {
  if ((inFlight.get(api) ?? 0) >= max) {
    await new Promise<void>((resolve) => {
      const queue = waiting.get(api) ?? [];
      queue.push(resolve);
      waiting.set(api, queue);
    });
  } else {
    inFlight.set(api, (inFlight.get(api) ?? 0) + 1);
  }
  try {
    return await fn();
  } finally {
    const next = waiting.get(api)?.shift();
    if (next) next();
    else inFlight.set(api, (inFlight.get(api) ?? 1) - 1);
  }
}

/** `items` in consecutive slices of at most `size`. */
export function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Look `names` up one by one with `lookupOne` (its holder's physical id, or
 * `undefined`), at most `concurrency` at once through `api`'s limiter: the
 * read for a type with no batch read by name.
 */
export async function lookupEachName(
  names: readonly string[],
  api: string,
  concurrency: number,
  lookupOne: (name: string) => Promise<string | undefined>
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  await Promise.all(
    names.map((name) =>
      withApiLimit(api, concurrency, async () => {
        const holder = await lookupOne(name);
        if (holder !== undefined) found.set(name, holder);
      })
    )
  );
  return found;
}

/** A 403 (AccessDenied on a List / Describe): the batch call is not granted. */
export function isAccessDeniedError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  const status = (error as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata
    ?.httpStatusCode;
  return (
    name === 'AccessDenied' ||
    name === 'AccessDeniedException' ||
    name === 'AuthorizationError' ||
    name === 'UnauthorizedOperation' ||
    status === 403
  );
}
