import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  AMBIGUOUS_LATCH_TTL_MS,
  AmbiguousCreateLatch,
  CREATION_DATE_SKEW_MARGIN_MS,
  RecentIdSet,
  isInsideWindow,
  withoutServerErrorRetries,
} from '../../../src/provisioning/providers/ambiguous-create.js';
import { Readable } from 'node:stream';
import { CreateKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { withStackName } from '../../../src/provisioning/resource-name.js';
import { withRetry } from '../../../src/deployment/retry.js';
import {
  hasReplayMayCollide,
  isNameCollisionErrorFrom,
  markReplayMayCollide,
} from '../../../src/deployment/retryable-errors.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

/** Ambiguous: a 5xx (issue #2026). */
const transient500 = (): Error =>
  Object.assign(new Error('internal'), { $fault: 'server', $metadata: { httpStatusCode: 500 } });

/** Definite: the service declared it did nothing. */
const client400 = (): Error =>
  Object.assign(new Error('bad request'), {
    name: 'ValidationException',
    $fault: 'client',
    $metadata: { httpStatusCode: 400 },
  });

const T0 = new Date('2026-10-01T00:00:00Z').getTime();

describe('AmbiguousCreateLatch (issue #2080)', () => {
  let latch: AmbiguousCreateLatch;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    latch = new AmbiguousCreateLatch('CreateThing');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('arms on an ambiguous failure with a window from attempt start to attempt end, skew-widened', () => {
    vi.setSystemTime(T0 + 3_000); // the attempt took 3 s
    latch.noteFailure('Res', transient500(), T0);

    expect(latch.take('Res')).toEqual({
      floorMs: T0 - CREATION_DATE_SKEW_MARGIN_MS,
      ceilingMs: T0 + 3_000 + CREATION_DATE_SKEW_MARGIN_MS,
    });
  });

  it('arms on a definite failure the SDK threw after replaying an ambiguous attempt (#4639)', () => {
    vi.setSystemTime(T0 + 3_000);
    latch.noteFailure('Res', markReplayMayCollide(client400()), T0);

    expect(latch.take('Res')).toEqual({
      floorMs: T0 - CREATION_DATE_SKEW_MARGIN_MS,
      ceilingMs: T0 + 3_000 + CREATION_DATE_SKEW_MARGIN_MS,
    });
  });

  it('does not arm on a definite failure', () => {
    latch.noteFailure('Res', client400(), T0);

    expect(latch.take('Res')).toBeUndefined();
  });

  it('clears on take, so one ambiguous failure is looked up once', () => {
    latch.noteFailure('Res', transient500(), T0);
    latch.take('Res');

    expect(latch.take('Res')).toBeUndefined();
  });

  it('widens to cover every ambiguous attempt: earliest start, latest end', () => {
    latch.noteFailure('Res', transient500(), T0);
    vi.setSystemTime(T0 + 20_000);
    latch.noteFailure('Res', transient500(), T0 + 10_000);

    const window = latch.take('Res');
    expect(window?.floorMs).toBe(T0 - CREATION_DATE_SKEW_MARGIN_MS);
    expect(window?.ceilingMs).toBe(T0 + 20_000 + CREATION_DATE_SKEW_MARGIN_MS);
  });

  it('merges the window an attempt took BEFORE creating when that attempt is ambiguous too', () => {
    latch.noteFailure('Res', transient500(), T0);
    const carried = latch.take('Res')!;
    vi.setSystemTime(T0 + 20_000);

    latch.noteFailure('Res', transient500(), T0 + 15_000, carried);

    const window = latch.take('Res');
    expect(window?.floorMs).toBe(T0 - CREATION_DATE_SKEW_MARGIN_MS);
    expect(window?.ceilingMs).toBe(T0 + 20_000 + CREATION_DATE_SKEW_MARGIN_MS);
  });

  it('drops the carried window when the attempt fails DEFINITELY', () => {
    latch.noteFailure('Res', transient500(), T0);
    const carried = latch.take('Res')!;

    latch.noteFailure('Res', client400(), T0 + 15_000, carried);

    expect(latch.take('Res')).toBeUndefined();
  });

  it('expires after the TTL', () => {
    latch.noteFailure('Res', transient500(), T0);
    vi.setSystemTime(T0 + AMBIGUOUS_LATCH_TTL_MS + 1);

    expect(latch.take('Res')).toBeUndefined();
  });

  it('measures the TTL from the LATEST arm, not the first', () => {
    latch.noteFailure('Res', transient500(), T0);
    vi.setSystemTime(T0 + AMBIGUOUS_LATCH_TTL_MS - 1_000);
    latch.noteFailure('Res', transient500(), Date.now());
    vi.setSystemTime(T0 + AMBIGUOUS_LATCH_TTL_MS + 60_000);

    expect(latch.take('Res')).toBeDefined();
  });

  it('keys by stack as well as logical id', () => {
    withStackName('StackA', () => latch.noteFailure('Res', transient500(), T0));

    expect(withStackName('StackB', () => latch.take('Res'))).toBeUndefined();
    expect(withStackName('StackA', () => latch.take('Res'))).toBeDefined();
  });

  it('keys by scope: two latches do not share entries', () => {
    const other = new AmbiguousCreateLatch('CreateOther');
    latch.noteFailure('Res', transient500(), T0);

    expect(other.take('Res')).toBeUndefined();
  });
});

describe('isInsideWindow', () => {
  const window = { floorMs: 100, ceilingMs: 200 };

  it('is inclusive at both ends and false outside or without a date', () => {
    expect(isInsideWindow(new Date(100), window)).toBe(true);
    expect(isInsideWindow(new Date(200), window)).toBe(true);
    expect(isInsideWindow(new Date(99), window)).toBe(false);
    expect(isInsideWindow(new Date(201), window)).toBe(false);
    expect(isInsideWindow(undefined, window)).toBe(false);
  });
});

describe('RecentIdSet', () => {
  it('is bounded, evicting the oldest id first', () => {
    const set = new RecentIdSet();
    for (let i = 0; i <= 10_000; i++) set.add(`id-${i}`);

    expect(set.has('id-0')).toBe(false);
    expect(set.has('id-1')).toBe(true);
    expect(set.has('id-10000')).toBe(true);
  });
});

/**
 * A REAL `KMSClient` (no module mock) against a stub HTTP handler: pins that
 * wrapping the resolved `config.retryStrategy` really changes what the SDK's
 * retry middleware does inside one `send`, on the SDK version this repo pins.
 */
describe('withoutServerErrorRetries against a real SDK client', () => {
  /** A queued response, or a socket-level failure the handler throws instead. */
  type Stub = { status: number; body: string } | { throws: Error };
  const makeClient = (responses: Stub[]) => {
    const requests: number[] = [];
    const client = new KMSClient({
      region: 'us-east-1',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
      requestHandler: {
        handle: async () => {
          requests.push(requests.length);
          const next = responses.shift() ?? { status: 200, body: '{"KeyMetadata":{"KeyId":"k"}}' };
          if ('throws' in next) throw next.throws;
          return {
            response: {
              statusCode: next.status,
              headers: { 'content-type': 'application/x-amz-json-1.1' },
              body: Readable.from([Buffer.from(next.body)]),
            },
          };
        },
      } as never,
    });
    return { client, requests };
  };

  const serverError = { status: 500, body: '{"__type":"KMSInternalException","message":"boom"}' };
  const throttle = { status: 400, body: '{"__type":"ThrottlingException","message":"slow"}' };

  it('an unwrapped client retries a 500 inside one send (the silent replay this closes)', async () => {
    const { client, requests } = makeClient([serverError]);

    await client.send(new CreateKeyCommand({}));

    expect(requests).toHaveLength(2);
  });

  it('a wrapped client sends a 500 ONCE and throws it unchanged', async () => {
    const { client, requests } = makeClient([serverError]);
    withoutServerErrorRetries(client);

    const error = await client.send(new CreateKeyCommand({})).catch((e: unknown) => e);

    expect(requests).toHaveLength(1);
    expect((error as { name?: string }).name).toBe('KMSInternalException');
    expect((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode).toBe(
      500
    );
  });

  it.each([
    ['DependencyTimeoutException', '{"__type":"DependencyTimeoutException","message":"slow dep"}'],
    ['ServiceUnavailableException', '{"__type":"ServiceUnavailableException","message":"down"}'],
  ])('a wrapped client sends a non-throttle 503 (%s) ONCE and throws it unchanged', async (name, body) => {
    // cdkd's `isThrottlingError` reads ANY 503 as a throttle by status; the
    // wrapper must not, or KMS's documented 503 stays a silent SDK replay.
    const { client, requests } = makeClient([{ status: 503, body }]);
    withoutServerErrorRetries(client);

    const error = await client.send(new CreateKeyCommand({})).catch((e: unknown) => e);

    expect(requests).toHaveLength(1);
    expect((error as { name?: string }).name).toBe(name);
    expect((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode).toBe(
      503
    );
  });

  it.each([
    ['a reset connection', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
    ['a client timeout', Object.assign(new Error('timed out'), { name: 'TimeoutError' })],
  ])('a wrapped client keeps the SDK retry of %s', async (_what, failure) => {
    // Ambiguous too, but the engine does not retry these: refusing them would
    // fail the deploy instead (the residual docs/troubleshooting.md records).
    const { client, requests } = makeClient([{ throws: failure }]);
    withoutServerErrorRetries(client);

    await client.send(new CreateKeyCommand({}));

    expect(requests.length).toBeGreaterThanOrEqual(2);
  }, 20_000);

  it('a wrapped client still retries a throttle that arrives as a 5xx', async () => {
    const { client, requests } = makeClient([
      { status: 503, body: '{"__type":"ThrottlingException","message":"slow"}' },
    ]);
    withoutServerErrorRetries(client);

    await client.send(new CreateKeyCommand({}));

    expect(requests).toHaveLength(2);
  }, 20_000);

  it('a wrapped client still retries a throttle', async () => {
    const { client, requests } = makeClient([throttle]);
    withoutServerErrorRetries(client);

    await client.send(new CreateKeyCommand({}));

    expect(requests).toHaveLength(2);
  }, 20_000);

  // Issue #4639: what the SDK replays after an ambiguous attempt is stamped, so
  // a replay colliding with the resource its first request made is not
  // credited to another holder.
  const collide = {
    status: 400,
    body: '{"__type":"AlreadyExistsException","message":"Thing already exists"}',
  };
  const fails = (code: string, message: string): Stub => ({
    throws: Object.assign(new Error(message), { code }),
  });
  const sendError = async (client: KMSClient): Promise<unknown> =>
    client.send(new CreateKeyCommand({})).then(
      () => undefined,
      (e: unknown) => e
    );

  it.each([
    ['a reset after the send', fails('ECONNRESET', 'socket hang up')],
    ['a broken pipe', fails('EPIPE', 'write EPIPE')],
    ['a socket timeout', fails('ETIMEDOUT', 'read ETIMEDOUT')],
    ['a client timeout', { throws: Object.assign(new Error('timed out'), { name: 'TimeoutError' }) }],
  ])('stamps the replay collision that follows %s', async (_what, failure) => {
    const { client, requests } = makeClient([failure as Stub, collide]);
    withoutServerErrorRetries(client);

    const error = await sendError(client);

    expect(requests).toHaveLength(2);
    expect((error as { name?: string }).name).toBe('AlreadyExistsException');
    expect(hasReplayMayCollide(error)).toBe(true);
  }, 20_000);

  it('an unwrapped client throws the same replay collision UNSTAMPED (the #4639 shape)', async () => {
    const { client, requests } = makeClient([fails('ECONNRESET', 'socket hang up'), collide]);

    const error = await sendError(client);

    expect(requests).toHaveLength(2);
    expect((error as { name?: string }).name).toBe('AlreadyExistsException');
    expect(hasReplayMayCollide(error)).toBe(false);
  }, 20_000);

  it.each([
    ['a refused connection', fails('ECONNREFUSED', 'connect ECONNREFUSED')],
    ['an unresolved host', fails('ENOTFOUND', 'getaddrinfo ENOTFOUND')],
    ['an unreachable host', fails('EHOSTUNREACH', 'connect EHOSTUNREACH')],
    ['a throttle', throttle],
  ])('retries %s in the SDK and leaves the next collision unstamped', async (_what, failure) => {
    // Never reached the service, or the service declared it did nothing: the
    // collision is with a resource that already held the name.
    const { client, requests } = makeClient([failure as Stub, collide]);
    withoutServerErrorRetries(client);

    const error = await sendError(client);

    expect(requests).toHaveLength(2);
    expect((error as { name?: string }).name).toBe('AlreadyExistsException');
    expect(hasReplayMayCollide(error)).toBe(false);
  }, 20_000);

  it('keeps the stamp across a later unambiguous attempt in the same send', async () => {
    const { client, requests } = makeClient([
      fails('ECONNRESET', 'socket hang up'),
      throttle,
      collide,
    ]);
    withoutServerErrorRetries(client);

    const error = await sendError(client);

    expect(requests).toHaveLength(3);
    expect(hasReplayMayCollide(error)).toBe(true);
  }, 20_000);

  it('does not carry the stamp into the next send on the same client', async () => {
    const { client, requests } = makeClient([
      fails('ECONNRESET', 'socket hang up'),
      { status: 200, body: '{"KeyMetadata":{"KeyId":"k"}}' },
      collide,
    ]);
    withoutServerErrorRetries(client);

    await client.send(new CreateKeyCommand({}));
    const error = await sendError(client);

    expect(requests).toHaveLength(3);
    expect(hasReplayMayCollide(error)).toBe(false);
  }, 20_000);

  it('stamps a 5xx it refuses when an earlier attempt of the send was ambiguous', async () => {
    const { client, requests } = makeClient([fails('ECONNRESET', 'socket hang up'), serverError]);
    withoutServerErrorRetries(client);

    const error = await sendError(client);

    expect(requests).toHaveLength(2);
    expect((error as { name?: string }).name).toBe('KMSInternalException');
    expect(hasReplayMayCollide(error)).toBe(true);
  }, 20_000);

  describe('through the engine retry', () => {
    const LOGICAL_ID = 'Thing';
    const createThroughRetry = (client: KMSClient): Promise<unknown> =>
      withRetry(
        async () => {
          try {
            return await client.send(new CreateKeyCommand({}));
          } catch (e) {
            throw new ProvisioningError(
              `Failed to create ${LOGICAL_ID}: ${(e as Error).message}`,
              'AWS::KMS::Key',
              LOGICAL_ID,
              'thing',
              e as Error
            );
          }
        },
        LOGICAL_ID,
        { sleep: () => Promise.resolve() }
      ).then(
        () => undefined,
        (e: unknown) => e
      );

    it('a reset then a collision is this create own replay, not a name collision', async () => {
      const { client, requests } = makeClient([fails('ECONNRESET', 'socket hang up'), collide]);
      withoutServerErrorRetries(client);

      const error = await createThroughRetry(client);

      expect(requests).toHaveLength(2);
      expect(hasReplayMayCollide(error)).toBe(true);
      expect(isNameCollisionErrorFrom(error, LOGICAL_ID)).toBe(false);
    }, 20_000);

    it('unwrapped, the same sequence is credited as a name collision (the #4639 failure)', async () => {
      const { client } = makeClient([fails('ECONNRESET', 'socket hang up'), collide]);

      const error = await createThroughRetry(client);

      expect(hasReplayMayCollide(error)).toBe(false);
      expect(isNameCollisionErrorFrom(error, LOGICAL_ID)).toBe(true);
    }, 20_000);

    it('a refused connection then a collision stays a name collision', async () => {
      const { client } = makeClient([fails('ECONNREFUSED', 'connect ECONNREFUSED'), collide]);
      withoutServerErrorRetries(client);

      const error = await createThroughRetry(client);

      expect(hasReplayMayCollide(error)).toBe(false);
      expect(isNameCollisionErrorFrom(error, LOGICAL_ID)).toBe(true);
    }, 20_000);
  });
});
