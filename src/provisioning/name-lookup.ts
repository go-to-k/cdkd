/**
 * Shared plumbing for `ResourceProvider.lookupNames` (go-to-k/cdkd#4705): the
 * plan-time check of which generated names a resource already holds.
 *
 * Every lookup is BATCHED per type -- a batch call or a bounded listing, never
 * one call per resource where the service has a batch -- and every API call
 * goes through ONE run-wide limiter per API, so a `deploy --all` of many
 * stacks shares each API's concurrency instead of multiplying it into
 * throttling. A listing by prefix is filtered to whole-name matches by the
 * caller (`App-Queue1` never matches `App-Queue10`).
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

/** The longest prefix every one of `names` starts with (`''` for none). */
export function commonPrefix(names: readonly string[]): string {
  if (names.length === 0) return '';
  let prefix = names[0]!;
  for (const name of names.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < name.length && prefix[i] === name[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix === '') break;
  }
  return prefix;
}

/**
 * Look `names` up one by one with `lookupOne` (its holder's physical id, or
 * `undefined`), at most `concurrency` at once through `api`'s limiter: the
 * fallback for a type whose batch answer is inexact or too long to page.
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

/**
 * Page through a listing until it ends or `maxPages` pages were read.
 * `undefined` when the listing did not end within the bound: the caller then
 * looks the names up one by one instead of reading on.
 */
export async function boundedPages<T>(
  maxPages: number,
  page: (token: string | undefined) => Promise<{ items: T[]; next: string | undefined }>
): Promise<T[] | undefined> {
  const out: T[] = [];
  let token: string | undefined;
  for (let n = 0; n < maxPages; n++) {
    const { items, next } = await page(token);
    out.push(...items);
    if (next === undefined || next === '') return out;
    token = next;
  }
  return undefined;
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

/**
 * Thrown by a `lookupNames` whose batch cannot answer exactly here (its
 * listing is not granted, or does not end within its bound): the caller then
 * looks each name up through the provider's own `import()`, bounded.
 */
export class LookupEachNameInstead extends Error {
  constructor(why: string) {
    super(why);
    this.name = 'LookupEachNameInstead';
  }
}
