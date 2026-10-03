/**
 * Judge an AWS `CreationTime` against AWS's OWN clock (go-to-k/cdkd#4428).
 *
 * The FSx and EFS create tokens are deterministic per stack, so a create can be
 * answered with a file system it did not make (one an earlier destroy kept).
 * The providers tell the two apart by asking whether the file system was
 * created after this create was first sent. Comparing AWS's `CreationTime`
 * with the LOCAL clock is wrong on a host whose clock runs fast -- Docker
 * Desktop, WSL and paused VMs drift by more than any small margin, while SigV4
 * signing tolerates five minutes -- and would refuse EVERY ordinary create,
 * leaving the file system it just made unrecorded.
 *
 * So {@link withServerClock} records, per command, the HTTP `Date` header of
 * the response AWS answered with and the local times around that attempt.
 * {@link earliestOwnCreationTime} then moves the local first-send time onto
 * AWS's clock by the measured skew. When no `Date` header was seen it falls
 * back to the SigV4 bound ({@link CLOCK_FALLBACK_MARGIN_MS}) instead.
 */

/** What one answered attempt of a command saw: local send/receive times and AWS's `Date`. */
export interface ServerClockReading {
  /** Local time the attempt was sent. */
  readonly sentAtMs: number;
  /** Local time its response arrived. */
  readonly receivedAtMs: number;
  /** The response's HTTP `Date` header, or `undefined` when absent or unparseable. */
  readonly serverDateMs: number | undefined;
}

/**
 * Tolerance on a server-clock comparison. The HTTP `Date` header has one-second
 * resolution, and a file system's `CreationTime` is stamped inside the request,
 * so a fresh create lands within a few seconds of the response's `Date`.
 */
export const SERVER_CLOCK_MARGIN_MS = 5_000;

/**
 * Tolerance when no `Date` header was seen: the five-minute skew SigV4 itself
 * accepts, so a host clock AWS still signs requests for never refuses a fresh
 * create. A file system an earlier run made is normally far older than this.
 */
export const CLOCK_FALLBACK_MARGIN_MS = 5 * 60_000;

const readings = new WeakMap<object, ServerClockReading>();

interface MiddlewareStackLike {
  add(
    middleware: (
      next: (args: unknown) => Promise<{ response?: unknown }>
    ) => (args: unknown) => Promise<{ response?: unknown }>,
    options: { step: 'deserialize'; priority: 'low'; name: string }
  ): void;
}

const dateHeaderOf = (response: unknown): number | undefined => {
  const headers = (response as { headers?: Record<string, unknown> } | undefined)?.headers;
  if (headers === undefined || headers === null || typeof headers !== 'object') return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'date' && typeof value === 'string') {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
  }
  return undefined;
};

/**
 * Record the AWS `Date` of every attempt `command` makes; the last answered
 * attempt's reading wins, which is the one whose result the caller sees.
 *
 * Added at the LOW-priority end of the `deserialize` step, i.e. INSIDE the
 * deserializer, so `next` returns the raw HTTP response -- for an error
 * response too, before the deserializer turns it into a thrown exception.
 */
export function withServerClock<C extends { middlewareStack: unknown }>(command: C): C {
  (command.middlewareStack as MiddlewareStackLike).add(
    (next) => async (args) => {
      const sentAtMs = Date.now();
      const result = await next(args);
      readings.set(command, {
        sentAtMs,
        receivedAtMs: Date.now(),
        serverDateMs: dateHeaderOf(result.response),
      });
      return result;
    },
    { step: 'deserialize', priority: 'low', name: 'cdkdServerClockMiddleware' }
  );
  return command;
}

/** The last answered attempt's reading for `command`, if any. */
export function serverClockReading(command: object): ServerClockReading | undefined {
  return readings.get(command);
}

/** TEST-ONLY: stand in for an answered attempt, for suites whose client `send` is mocked. */
export function recordServerClockForTests(command: object, reading: ServerClockReading): void {
  readings.set(command, reading);
}

/**
 * The earliest `CreationTime`, on AWS's clock, a file system made by a create
 * FIRST sent at local time `firstSentLocalMs` can carry. Anything older was not
 * made by it.
 */
export function earliestOwnCreationTime(
  firstSentLocalMs: number,
  reading: ServerClockReading | undefined
): number {
  if (reading?.serverDateMs === undefined) {
    return firstSentLocalMs - CLOCK_FALLBACK_MARGIN_MS;
  }
  // AWS's clock minus ours, measured at this response. The first send moves
  // onto AWS's clock by it; for a create sent once this reduces to
  // `serverDate - requestDuration - margin`.
  const skewMs = reading.serverDateMs - reading.receivedAtMs;
  return firstSentLocalMs + skewMs - SERVER_CLOCK_MARGIN_MS;
}
