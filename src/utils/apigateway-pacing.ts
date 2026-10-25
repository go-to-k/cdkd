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
 * So the calls are spaced instead of retried: {@link apiGatewayPacing} waits
 * for a free slot before every attempt, keeping this process under the
 * documented rates with headroom for the other callers of the same account. The
 * waits are the time the throttled retries would have spent, without the
 * failures, so an unthrottled deploy is not slowed beyond a few seconds on a
 * very wide API.
 *
 * A LEAF: it imports nothing from cdkd.
 */

/** Spacing between two calls, in milliseconds, for one operation. */
const GLOBAL_INTERVAL_MS = 125; // 8 per second of the 10 allowed in total
const OPERATION_INTERVAL_MS: Readonly<Record<string, number>> = {
  CreateResource: 250, // 4 per second of the 5 allowed
  DeleteResource: 250,
  CreateApiKey: 250,
  DeleteApiKey: 250,
};

/**
 * SDK attempts for an API Gateway call. Pacing keeps this process under the
 * limit; what is left is another process sharing the account, which a throttle
 * clears within a few seconds. The SDK's own backoff for a throttle is
 * exponential from 500 ms, capped at 20 s.
 */
export const API_GATEWAY_MAX_ATTEMPTS = 8;

/** Hands out start times at least `intervalMs` apart. */
class Lane {
  private nextStart = 0;
  private readonly intervalMs: number;

  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  /** Reserves the next slot and returns how long to wait for it. */
  reserve(now: number): number {
    const start = Math.max(now, this.nextStart);
    this.nextStart = start + this.intervalMs;
    return start - now;
  }
}

/**
 * The pacer of one account and Region: one lane for all operations and one per
 * operation that has its own, lower, limit. A call waits for the later of its
 * two slots, and takes both, so neither lane runs ahead of the calls that
 * really went out.
 */
export class ApiGatewayPacer {
  private readonly all = new Lane(GLOBAL_INTERVAL_MS);
  private readonly perOperation = new Map<string, Lane>();

  /** Milliseconds `operation` has to wait before it is sent. */
  reserve(operation: string, now: number = Date.now()): number {
    const interval = OPERATION_INTERVAL_MS[operation];
    let wait = this.all.reserve(now);
    if (interval !== undefined) {
      let lane = this.perOperation.get(operation);
      if (lane === undefined) {
        lane = new Lane(interval);
        this.perOperation.set(operation, lane);
      }
      // The operation's own slot can be later than the shared one. The shared
      // slot is already taken, which only ever spaces other calls further.
      wait = Math.max(wait, lane.reserve(now));
    }
    return wait;
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
 * Makes every attempt of every call on `client` wait for its slot. Installed
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
      const wait = apiGatewayPacerFor(region).reserve(operation);
      if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
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
