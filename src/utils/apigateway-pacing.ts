/**
 * Client-side pacing for the API Gateway control plane.
 *
 * API Gateway rate-limits its management API per ACCOUNT and Region, and the
 * limits are low and fixed: 10 requests per second across every operation
 * (burst 40), and 5 per second for `CreateResource` and `DeleteResource`
 * (https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html).
 * cdkd dispatches every ready resource at once, so a REST API with a hundred
 * resources and methods sends dozens of calls in the same second. Measured on a
 * 122-resource stack: up to 52 `CreateResource` and 74 calls in total per
 * second, answered with `TooManyRequestsException` 491 times in one deploy.
 *
 * The SDK's own retry cannot absorb that. It makes 3 attempts by default and
 * its retry quota (500 tokens, 5 per retry) is spent after about 100 retries
 * per client. A call that exhausts the retries fails the resource, and a
 * `Method` fails half-built: its cleanup `DeleteMethod` is throttled as well,
 * the method stays behind, and the replay dies with `Method already exists for
 * this resource`.
 *
 * So the calls are paced instead of retried: {@link withApiGatewayPacing} takes a
 * token before every attempt, from token buckets shaped like the service's own
 * (a burst, then a steady refill), at a steady rate under the documented one
 * with headroom for the other callers of the same account. A small API fits in
 * the burst and is not delayed at all; a wide one settles at the steady rate,
 * which is the time the throttled retries would have spent, without the
 * failures.
 *
 * A LEAF: it imports nothing from cdkd.
 */

/** All operations together: the account limit is 10 per second, burst 40. */
const GLOBAL_BUCKET = { capacity: 30, perSecond: 8 };

/**
 * Operations with a lower limit of their own: 5 per second. `CreateApiKey` and
 * `DeleteApiKey` share it but are left out: no cdkd SDK path sends them
 * (`AWS::ApiGateway::ApiKey` goes through Cloud Control, which is not paced).
 */
const OPERATION_BUCKET = { capacity: 5, perSecond: 4 };
const LIMITED_OPERATIONS: ReadonlySet<string> = new Set(['CreateResource', 'DeleteResource']);

/**
 * SDK attempts for an API Gateway call. Pacing keeps this process under the
 * limit; what is left is another process sharing the account, which a throttle
 * clears within a few seconds. The SDK's own backoff for a throttle is
 * exponential from 500 ms, capped at 20 s.
 */
export const API_GATEWAY_MAX_ATTEMPTS = 8;

/**
 * A token bucket whose tokens are booked ahead of time: a caller that finds it
 * empty reserves the next token and waits for it, so callers of one operation
 * are served in order. `last` is the moment `tokens` is counted at, and can be
 * in the future while bookings are outstanding.
 */
class Bucket {
  protected tokens: number;
  protected last = 0;
  protected readonly capacity: number;
  protected readonly perMs: number;

  constructor(config: { capacity: number; perSecond: number }) {
    this.capacity = config.capacity;
    this.perMs = config.perSecond / 1000;
    this.tokens = config.capacity;
  }

  /** The first moment, not before `now`, at which a token is available. */
  availableAt(now: number): number {
    const at = Math.max(now, this.last);
    const tokens = Math.min(this.capacity, this.tokens + (at - this.last) * this.perMs);
    return tokens >= 1 ? at : at + (1 - tokens) / this.perMs;
  }

  /** Takes a token at `at`, which is not before {@link availableAt}. */
  take(at: number): void {
    this.tokens = Math.min(this.capacity, this.tokens + (at - this.last) * this.perMs) - 1;
    this.last = at;
  }
}

/**
 * The pacer of one Region, in two steps a call goes through in order:
 *
 *  1. {@link reserveOperation}: wait for the operation's OWN bucket, when it has
 *     one. Booked ahead, so the calls of one operation queue in order.
 *  2. {@link takeShared}: take a token of the bucket all operations share, at
 *     the moment the call is about to go. Never booked ahead, so a call that is
 *     still queued on its own bucket holds nothing of the shared one, and only a
 *     call that has satisfied its own limit can use up the shared tokens. Other
 *     operations go out beside a `CreateResource` queue instead of behind it.
 *
 * Keyed by Region only: two accounts in one Region share it, which errs on the
 * safe side.
 */
export class ApiGatewayPacer {
  private readonly all = new Bucket(GLOBAL_BUCKET);
  private readonly perOperation = new Map<string, Bucket>();

  /** Milliseconds `operation` waits for its own bucket; 0 when it has none. */
  reserveOperation(operation: string, now: number = performance.now()): number {
    if (!LIMITED_OPERATIONS.has(operation)) return 0;
    let lane = this.perOperation.get(operation);
    if (lane === undefined) {
      lane = new Bucket(OPERATION_BUCKET);
      this.perOperation.set(operation, lane);
    }
    const start = lane.availableAt(now);
    lane.take(start);
    // A float slot a hair past a whole millisecond is not worth a millisecond.
    return Math.max(0, Math.ceil(start - now - 1e-6));
  }

  /**
   * Takes a shared token and returns 0, or takes none and returns how long to
   * wait before asking again.
   */
  takeShared(now: number = performance.now()): number {
    const start = this.all.availableAt(now);
    if (start > now) return Math.max(1, Math.ceil(start - now - 1e-6));
    this.all.take(now);
    return 0;
  }
}

const pacers = new Map<string, ApiGatewayPacer>();

/** The one pacer of a Region, shared by every client of this process. */
export function apiGatewayPacerFor(region: string): ApiGatewayPacer {
  let pacer = pacers.get(region);
  if (pacer === undefined) {
    pacer = new ApiGatewayPacer();
    pacers.set(region, pacer);
  }
  return pacer;
}

/** Forget every pacer. TEST-ONLY. */
export function resetApiGatewayPacersForTests(): void {
  pacers.clear();
}

interface MiddlewareStack {
  add(
    middleware: (
      next: (args: unknown) => Promise<unknown>,
      context: { commandName?: string }
    ) => (args: unknown) => Promise<unknown>,
    options: { step: string; name: string; relation: string; toMiddleware: string }
  ): void;
}

/**
 * Makes every attempt of every call on `client` wait for its tokens. Installed
 * AFTER the SDK's retry middleware, so a retried attempt is paced like a first
 * one. Returns `client` for chaining.
 */
export function withApiGatewayPacing<
  T extends {
    middlewareStack: unknown;
    config: { region(): Promise<string> };
  },
>(client: T): T {
  const stack = client.middlewareStack as MiddlewareStack | undefined;
  // Left as it is rather than half-wrapped: a client without a middleware
  // stack is never the pinned SDK's, only a test double.
  if (typeof stack?.add !== 'function') return client;
  stack.add(
    (next, context) => async (args) => {
      const region = await client.config.region();
      // The SDK names the command `CreateResourceCommand`; the limits name the
      // operation `CreateResource`.
      const operation = (context.commandName ?? '').replace(/Command$/, '');
      const pacer = apiGatewayPacerFor(region);
      const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      const ownWait = pacer.reserveOperation(operation);
      if (ownWait > 0) await sleep(ownWait);
      // A call that loses the shared token to another asks again.
      for (let wait = pacer.takeShared(); wait > 0; wait = pacer.takeShared()) await sleep(wait);
      return next(args);
    },
    {
      step: 'finalizeRequest',
      name: 'cdkdApiGatewayPacing',
      relation: 'after',
      toMiddleware: 'retryMiddleware',
    }
  );
  return client;
}
