import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * Issue #3978: a main create that SUCCEEDED server-side but answered with an
 * AMBIGUOUS failure (an HTTP 5xx, or a socket reset / timeout after the
 * request was sent) is retried by the wrapper, and the replay collides with
 * the resource the first send made. That "already exists" carries no mark, so
 * it used to be credited as the resource's own name collision, and a caller
 * answered it by deleting a live resource (`--replace`'s old one, the
 * rollback reverse-replacement's new one).
 *
 * Driven through the REAL retry wrapper, the REAL Kinesis provider (its
 * `CreateStream` has no idempotency token and its replay does not adopt) and
 * the REAL classifier; only `KinesisClient.prototype.send` is stubbed, and it
 * answers by command name.
 *
 * Out of scope here: the AWS SDK's OWN retry of the same 5xx inside one
 * `send` (issue #3978 layer (b)), which surfaces the collision from the
 * wrapper's FIRST attempt and so is invisible to any wrapper-level latch.
 */

vi.mock('../../../src/utils/logger.js', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return { getLogger: () => logger };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({}),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

import { KinesisClient } from '@aws-sdk/client-kinesis';

import { withRetry } from '../../../src/deployment/retry.js';
import {
  isAmbiguousOutcomeError,
  isNameCollisionError,
  isNameCollisionErrorFrom,
  isRetryableTransientError,
  isUpdateUnsupportedError,
  hasReplayMayCollide,
  markNameCollision,
  markReplayMayCollide,
} from '../../../src/deployment/retryable-errors.js';
import {
  replayRollback,
  type CompletedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { KinesisStreamProvider } from '../../../src/provisioning/providers/kinesis-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { isAuxiliaryFailure } from '../../../src/provisioning/auxiliary-failure.js';
import { CloudControlOperationFailedError } from '../../../src/provisioning/cloud-control-provider.js';
import type { ResourceState } from '../../../src/types/state.js';
import { awsSdkError } from '../_aws-sdk-error.js';

const LOGICAL_ID = 'Stream';
const TYPE = 'AWS::Kinesis::Stream';
const PROPERTIES = { Name: 'stream', ShardCount: 1 };
/** Kinesis's own wording for a stream name that is taken. */
const COLLISION = 'Stream stream under account 123456789012 already exists.';

/**
 * A smithy `ServiceException` as `decorateServiceException` builds one for a
 * server fault: `$fault: 'server'`, the HTTP status on `$metadata`, and the
 * `UnknownError` placeholder when the body carried no message -- the shape
 * measured live for issue #2026 (`name=InternalFailure http=500`).
 */
function serverFault(status: number, name: string, message = 'UnknownError'): Error {
  const error = new Error(message);
  error.name = name;
  Object.assign(error, {
    $fault: 'server',
    $metadata: { httpStatusCode: status, requestId: 'req-5xx', attempts: 3 },
  });
  return error;
}

/**
 * A Node socket failure as `@smithy/node-http-handler` rethrows it: no HTTP
 * status (no response was read), the errno `code`, and the `$metadata` the
 * retry middleware stamps on its way out. The handler renames `ECONNRESET` /
 * `EPIPE` / `ETIMEDOUT` to `TimeoutError` and leaves `ECONNREFUSED` and the
 * unreachable-host codes as a plain `Error`; `name` lets a case pick either.
 */
function socketError(code: string, name?: string): Error {
  const error = new Error(`socket hang up (${code})`);
  if (name !== undefined) error.name = name;
  Object.assign(error, { code, $metadata: { attempts: 3, totalRetryDelay: 0 } });
  return error;
}

/** The handler's connect / idle timeout: `TimeoutError` with no `code`. */
function codelessTimeout(): Error {
  const error = new Error('Socket timed out without establishing a connection within 1000 ms');
  error.name = 'TimeoutError';
  Object.assign(error, { $metadata: { attempts: 3, totalRetryDelay: 0 } });
  return error;
}

/**
 * A retry filter independent of the predicate under test: the replay must
 * happen whatever `isAmbiguousOutcomeError` answers, so a failure reads as
 * "the latch did not arm" and never as "nothing was replayed".
 */
function retriesSocketFailures(_text: string, e: unknown): boolean {
  const cause = (e as { cause?: { code?: unknown; name?: unknown } }).cause;
  return cause?.code !== undefined || cause?.name === 'TimeoutError';
}

type Sendable = { send: (command: unknown) => Promise<unknown> };
type Outcome = 'ok' | 'collide' | Error;

/** `createStreamOutcomes[i]` is what the i-th `CreateStream` does. */
function stubKinesis(createStreamOutcomes: Outcome[]): string[] {
  const sent: string[] = [];
  let creates = 0;
  vi.spyOn(KinesisClient.prototype as unknown as Sendable, 'send').mockImplementation(
    async (command: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      sent.push(name);
      if (name === 'CreateStreamCommand') {
        const outcome = createStreamOutcomes[creates++] ?? 'collide';
        if (outcome === 'collide') throw awsSdkError(COLLISION, 'ResourceInUseException');
        if (outcome instanceof Error) throw outcome;
        return {};
      }
      if (name === 'DescribeStreamCommand') {
        return {
          StreamDescription: {
            StreamStatus: 'ACTIVE',
            StreamARN: 'arn:aws:kinesis:us-east-1:123456789012:stream/stream',
          },
        };
      }
      return {};
    }
  );
  return sent;
}

const noSleep = (): Promise<void> => Promise.resolve();

function createThroughRetry(
  opts: { isRetryable?: (text: string, error: unknown) => boolean; sleep?: (ms: number) => Promise<void> } = {}
): Promise<unknown> {
  const provider = new KinesisStreamProvider();
  return withRetry(
    () => provider.create(LOGICAL_ID, TYPE, structuredClone(PROPERTIES)),
    LOGICAL_ID,
    { sleep: opts.sleep ?? noSleep, ...(opts.isRetryable && { isRetryable: opts.isRetryable }) }
  ).then(
    () => undefined,
    (e: unknown) => e
  );
}

const creates = (sent: string[]): number => sent.filter((c) => c === 'CreateStreamCommand').length;

beforeEach(() => {
  vi.stubEnv('AWS_REGION', 'us-east-1');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('a create replayed after an ambiguous 5xx colliding with itself (#3978)', () => {
  it.each([
    ['500 InternalFailure', serverFault(500, 'InternalFailure')],
    ['503 ServiceUnavailable', serverFault(503, 'ServiceUnavailable', 'Service Unavailable')],
    ['502 BadGateway', serverFault(502, 'BadGateway')],
    ['504 GatewayTimeout', serverFault(504, 'GatewayTimeout')],
  ])('is not credited as the resource name collision after a %s', async (_label, fault) => {
    const sent = stubKinesis([fault, 'collide']);
    const error = await createThroughRetry();

    // The shape the issue describes: the first CreateStream answered 5xx (the
    // stub stands in for one that materialized the stream anyway), the default
    // classifier retried it, and the replay collided.
    expect(creates(sent)).toBe(2);
    expect(error).toBeInstanceOf(Error);
    // The thrown error is the replay's and still RELAYS AWS's "already
    // exists": only the carried mark can keep the verdict false.
    expect((error as Error).message).toContain(COLLISION);
    expect(isNameCollisionError((error as Error).message)).toBe(true);
    expect(isNameCollisionErrorFrom(error, LOGICAL_ID)).toBe(false);
  });

  it.each([
    ['ECONNRESET as a plain Error', () => socketError('ECONNRESET')],
    ['ECONNRESET renamed TimeoutError (the HTTP/1 handler)', () => socketError('ECONNRESET', 'TimeoutError')],
    ['a code-less TimeoutError (connect / idle timeout)', codelessTimeout],
  ])('a network failure after the send is covered too: %s', async (_l, fault) => {
    // No default classifier retries a socket error today, so the replay is
    // reached through a caller-supplied one; the latch must not depend on
    // which classifier chose to retry.
    const sent = stubKinesis([fault(), 'collide']);
    const error = await createThroughRetry({ isRetryable: retriesSocketFailures });
    expect(creates(sent)).toBe(2);
    expect(isNameCollisionErrorFrom(error, LOGICAL_ID)).toBe(false);
  });

  it('the latch is per call: a later call colliding first still classifies', async () => {
    const sent = stubKinesis([serverFault(500, 'InternalFailure'), 'collide', 'collide']);
    const first = await createThroughRetry();
    // Replayed, so the false verdict is the latch's and not a bare 5xx.
    expect(creates(sent)).toBe(2);
    expect(isNameCollisionErrorFrom(first, LOGICAL_ID)).toBe(false);
    const second = await createThroughRetry();
    expect(isNameCollisionErrorFrom(second, LOGICAL_ID)).toBe(true);
  });

  it('a replay that succeeds is returned as before', async () => {
    stubKinesis([serverFault(503, 'ServiceUnavailable'), 'ok']);
    const provider = new KinesisStreamProvider();
    const result = await withRetry(
      () => provider.create(LOGICAL_ID, TYPE, structuredClone(PROPERTIES)),
      LOGICAL_ID,
      { sleep: noSleep }
    );
    expect(result.physicalId).toBe('stream');
  });
});

describe('clean rejections before a collision leave a genuine collision credited (#3978)', () => {
  it('a genuine first-attempt collision still classifies', async () => {
    const sent = stubKinesis(['collide']);
    const error = await createThroughRetry();
    expect(creates(sent)).toBe(1);
    expect(isNameCollisionErrorFrom(error, LOGICAL_ID)).toBe(true);
  });

  it.each([
    ['a 400 throttle', awsSdkError('Rate exceeded for stream stream.', 'LimitExceededException')],
    // S3's `SlowDown` is a 503: a THROTTLE by name, so a clean rejection even
    // though its status is in the transient-server set.
    ['a 503 throttle by name', serverFault(503, 'SlowDown', 'Please reduce your request rate.')],
  ])('%s, then a collision with a pre-existing stream, still classifies', async (_l, first) => {
    const sent = stubKinesis([first, 'collide']);
    const error = await createThroughRetry();
    // The throttle WAS retried -- otherwise this proves nothing about the latch.
    expect(creates(sent)).toBe(2);
    expect(isNameCollisionErrorFrom(error, LOGICAL_ID)).toBe(true);
  });

  it('a 503 the SDK flags as a throttle via $retryable still classifies', async () => {
    const throttled = serverFault(503, 'ServiceUnavailable', 'busy');
    Object.assign(throttled, { $retryable: { throttling: true } });
    const sent = stubKinesis([throttled, 'collide']);
    const error = await createThroughRetry();
    expect(creates(sent)).toBe(2);
    expect(isNameCollisionErrorFrom(error, LOGICAL_ID)).toBe(true);
  });

  it('a socket that never connected (ECONNREFUSED) does not arm the latch', async () => {
    const sent = stubKinesis([socketError('ECONNREFUSED'), 'collide']);
    const error = await createThroughRetry({ isRetryable: retriesSocketFailures });
    expect(creates(sent)).toBe(2);
    expect(isNameCollisionErrorFrom(error, LOGICAL_ID)).toBe(true);
  });

  it('IAM-propagation retries keep their dense schedule and leave a collision credited', async () => {
    // A propagation rejection is a 400 the service answered before acting.
    const propagation = awsSdkError(
      'The role defined for the function cannot be assumed by Lambda.',
      'InvalidParameterValueException'
    );
    const sent = stubKinesis([propagation, propagation, 'collide']);
    const slept: number[] = [];
    const error = await createThroughRetry({
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });
    expect(creates(sent)).toBe(3);
    // The dense grid's first two steps (250ms, 500ms), not the generic 1s/2s.
    expect(slept).toEqual([250, 500]);
    expect(isNameCollisionErrorFrom(error, LOGICAL_ID)).toBe(true);
  });
});

describe('the latch on the UPDATE path (accepted trade, stated in retry.ts)', () => {
  // The loop cannot tell a create from an update, and the mark also meets
  // `isUpdateUnsupportedError`'s anchor: an update whose earlier attempt ended
  // ambiguous no longer auto-replaces on `UnsupportedActionException`; it
  // fails, and a re-run replaces. Pinned so the trade stays a decision.
  const unsupported = (): Error =>
    new ProvisioningError(
      `Failed to update ${LOGICAL_ID}: unsupported`,
      TYPE,
      LOGICAL_ID,
      undefined,
      awsSdkError('Resource type does not support UPDATE', 'UnsupportedActionException')
    );
  const wrapped5xx = (): Error =>
    new ProvisioningError(
      `Failed to update ${LOGICAL_ID}: UnknownError`,
      TYPE,
      LOGICAL_ID,
      undefined,
      serverFault(500, 'InternalFailure')
    );

  async function run(first: () => Error): Promise<unknown> {
    let n = 0;
    const error = await withRetry(
      () => Promise.reject(n++ === 0 ? first() : unsupported()),
      LOGICAL_ID,
      { sleep: noSleep }
    ).then(
      () => undefined,
      (e: unknown) => e
    );
    // The thrown error is the REPLAY's UnsupportedAction, not the first one.
    expect(n).toBe(2);
    expect(String(error)).toContain('unsupported');
    return error;
  }

  it('withholds the auto-replacement after an ambiguous attempt', async () => {
    expect(isUpdateUnsupportedError(await run(wrapped5xx), LOGICAL_ID)).toBe(false);
  });

  it('keeps it after a clean one', async () => {
    const throttle = (): Error =>
      new ProvisioningError('x', TYPE, LOGICAL_ID, undefined, awsSdkError('Rate exceeded', 'ThrottlingException'));
    expect(isUpdateUnsupportedError(await run(throttle), LOGICAL_ID)).toBe(true);
  });

  it('the replay stamp alone does not widen it (only the auxiliary mark reaches it)', () => {
    // A Cloud Control update rejection carries the owner id and no cause, so
    // the auxiliary mark cannot land; the stamp must not suppress it either.
    const cc = markReplayMayCollide(
      new CloudControlOperationFailedError('UPDATE failed for Stream: x', TYPE, LOGICAL_ID, 'p', 'UnsupportedActionException', 'UPDATE')
    );
    expect(hasReplayMayCollide(cc)).toBe(true);
    expect(isUpdateUnsupportedError(cc, LOGICAL_ID)).toBe(true);
  });
});

describe('isAmbiguousOutcomeError', () => {
  const wrap = (cause: Error): Error =>
    new ProvisioningError(`Failed to create ${LOGICAL_ID}: x`, TYPE, LOGICAL_ID, undefined, cause);

  it.each([500, 502, 503, 504])('is true for a non-throttle %i, bare and wrapped', (status) => {
    expect(isAmbiguousOutcomeError(serverFault(status, 'InternalFailure'))).toBe(true);
    expect(isAmbiguousOutcomeError(wrap(serverFault(status, 'InternalFailure')))).toBe(true);
  });

  it.each(['ECONNRESET', 'EPIPE', 'ETIMEDOUT'])('is true for a %s socket error', (code) => {
    expect(isAmbiguousOutcomeError(socketError(code))).toBe(true);
    expect(isAmbiguousOutcomeError(wrap(socketError(code)))).toBe(true);
  });

  it('is true for the SDK client-side TimeoutError', () => {
    const e = new Error('Connection timed out after 5000 ms');
    e.name = 'TimeoutError';
    expect(isAmbiguousOutcomeError(wrap(e))).toBe(true);
  });

  it.each(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND'])(
    'is false for %s: the request never reached a server',
    (code) => {
      expect(isAmbiguousOutcomeError(wrap(socketError(code)))).toBe(false);
    }
  );

  it('is false for throttles, a 4xx, a 501 and non-AWS values', () => {
    expect(isAmbiguousOutcomeError(serverFault(503, 'SlowDown'))).toBe(false);
    expect(isAmbiguousOutcomeError(wrap(serverFault(503, 'Throttling')))).toBe(false);
    const flagged = serverFault(500, 'InternalFailure');
    Object.assign(flagged, { $retryable: { throttling: true } });
    expect(isAmbiguousOutcomeError(flagged)).toBe(false);
    expect(isAmbiguousOutcomeError(awsSdkError('Rate exceeded', 'ThrottlingException'))).toBe(false);
    expect(isAmbiguousOutcomeError(awsSdkError(COLLISION, 'ResourceInUseException'))).toBe(false);
    expect(isAmbiguousOutcomeError(serverFault(501, 'NotImplemented'))).toBe(false);
    // S3's `RequestTimeout` is the SERVER saying it never received the whole
    // request: a clean 400 rejection, not an unknown outcome.
    expect(isAmbiguousOutcomeError(awsSdkError('socket not read', 'RequestTimeout'))).toBe(false);
    expect(isAmbiguousOutcomeError(new Error('boom'))).toBe(false);
    expect(isAmbiguousOutcomeError('ECONNRESET')).toBe(false);
    expect(isAmbiguousOutcomeError(undefined)).toBe(false);
    expect(isAmbiguousOutcomeError(null)).toBe(false);
  });

  it('reads five links, like every other walk in the module', () => {
    let chain: unknown = serverFault(500, 'InternalFailure');
    for (let i = 0; i < 4; i++) chain = new Error('wrap', { cause: chain });
    expect(isAmbiguousOutcomeError(chain)).toBe(true);
    expect(isAmbiguousOutcomeError(new Error('wrap', { cause: chain }))).toBe(false);
  });

  it('a $retryable throttle above a 5xx wins too', () => {
    const outer = serverFault(503, 'ServiceUnavailable');
    Object.assign(outer, { $retryable: { throttling: true }, cause: serverFault(500, 'InternalFailure') });
    expect(isAmbiguousOutcomeError(outer)).toBe(false);
  });

  it.each([
    'InternalFailure',
    'HandlerInternalFailure',
    'ServiceInternalError',
    'NetworkFailure',
    'NotStabilized',
    'ServiceTimeout',
    // Reported from inside the handler's create, after it may have made the
    // resource -- unlike an SDK-level throttle, which is a clean rejection.
    'GeneralServiceException',
    'Throttling',
  ])(
    'is true for a Cloud Control handler %s',
    (code) => {
      const e = new CloudControlOperationFailedError('CREATE failed for Stream: x', TYPE, LOGICAL_ID, undefined, code, 'CREATE');
      expect(isAmbiguousOutcomeError(e)).toBe(true);
      expect(isAmbiguousOutcomeError(new Error('wrap', { cause: e }))).toBe(true);
    }
  );

  // Every other `HandlerErrorCode` in `@aws-sdk/client-cloudcontrol`, so a
  // code added to the ambiguous set by mistake shows up here.
  it.each([
    'AlreadyExists',
    'InvalidRequest',
    'AccessDenied',
    'InvalidCredentials',
    'ServiceLimitExceeded',
    'NotFound',
    'NotUpdatable',
    'ResourceConflict',
    'UnauthorizedTaggingOperation',
  ])(
    'is false for a Cloud Control handler %s',
    (code) => {
      const e = new CloudControlOperationFailedError('CREATE failed for Stream: x', TYPE, LOGICAL_ID, undefined, code, 'CREATE');
      expect(isAmbiguousOutcomeError(e)).toBe(false);
    }
  );

  it('a throttle name anywhere above the status wins', () => {
    // A throttle wrapping a 5xx is the service declaring a clean rejection.
    const outer = serverFault(503, 'SlowDown');
    Object.assign(outer, { cause: serverFault(500, 'InternalFailure') });
    expect(isAmbiguousOutcomeError(outer)).toBe(false);
  });

  it('never throws on a hostile chain', () => {
    const hostile = {
      get cause(): unknown {
        throw new Error('getter');
      },
    };
    expect(() => isAmbiguousOutcomeError(hostile)).not.toThrow();
    expect(isAmbiguousOutcomeError(hostile)).toBe(false);
  });

  it('every ambiguous 5xx is one the default classifier retries', () => {
    // The latch matters only where the wrapper REPLAYS: keep the two in step.
    for (const status of [500, 502, 503, 504]) {
      const e = wrap(serverFault(status, 'InternalFailure'));
      expect(isRetryableTransientError(e, e.message)).toBe(true);
    }
  });
});

describe('the rollback reverse-replacement arm after an ambiguous 5xx (#3978)', () => {
  const silentLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => silentLogger,
  } as unknown as RollbackExecutorContext['logger'];

  function res(overrides: Partial<ResourceState> = {}): ResourceState {
    return {
      physicalId: 'phys',
      resourceType: TYPE,
      properties: {},
      attributes: {},
      dependencies: [],
      ...overrides,
    };
  }

  it('fails the op instead of deleting the live new stream', async () => {
    // Reverting a Name change (stream -> stream-new) re-creates `stream`; its
    // CreateStream answers 500 while materializing, the replay meets it, and
    // the delete-new-first arm used to delete the live `stream-new`, which
    // never held the name. The third outcome is what a pre-fix run's
    // re-create after that delete meets, so it completes instead of retrying
    // "already exists" for minutes; a fixed run never sends it.
    // `createWithRollbackRetry` takes no `sleep`, so the inner loop's 1s
    // backoff is real; the case's timeout is raised for it.
    const sent = stubKinesis([serverFault(500, 'InternalFailure'), 'collide', 'ok']);
    const provider = new KinesisStreamProvider();
    const del = vi.spyOn(provider, 'delete').mockResolvedValue(undefined);
    const ctx: RollbackExecutorContext = {
      region: 'us-east-1',
      logger: silentLogger,
      providerRegistry: {
        getProviderFor: () => ({ provider, provisionedBy: 'sdk' }),
      } as unknown as RollbackExecutorContext['providerRegistry'],
    };
    const op: CompletedOperation = {
      logicalId: LOGICAL_ID,
      changeType: 'UPDATE',
      resourceType: TYPE,
      physicalId: 'stream-new',
      previousState: res({ physicalId: 'stream', properties: structuredClone(PROPERTIES) }),
    };
    const state: Record<string, ResourceState> = {
      [LOGICAL_ID]: res({
        physicalId: 'stream-new',
        properties: { ...PROPERTIES, Name: 'stream-new' },
      }),
    };

    const result = await replayRollback([op], state, 'CdkdX', ctx);

    // THE DISCRIMINATOR, first so a regression fails HERE.
    expect(del).not.toHaveBeenCalled();
    expect(creates(sent)).toBe(2);
    expect(result.failures).toBe(1);
    expect(state[LOGICAL_ID]?.physicalId).toBe('stream-new');
    const failed = vi
      .mocked(silentLogger.warn)
      .mock.calls.map((c) => String(c[0]))
      .filter((l) => l.includes('Rollback failed for'));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain(COLLISION);
  }, 15_000);
});

describe('the replay stamp reaches chains the auxiliary mark cannot (#3978)', () => {
  const wrapped500 = (): Error =>
    new ProvisioningError(
      `Failed to create ${LOGICAL_ID}: UnknownError`,
      TYPE,
      LOGICAL_ID,
      undefined,
      serverFault(500, 'InternalFailure')
    );
  const ccCollision = (): Error =>
    new CloudControlOperationFailedError(
      `CREATE failed for ${LOGICAL_ID}: Resource of type '${TYPE}' with identifier 'stream' already exists.`,
      TYPE,
      LOGICAL_ID,
      'stream',
      'AlreadyExists',
      'CREATE'
    );

  async function replay(first: () => Error, second: () => Error): Promise<unknown> {
    let n = 0;
    const error = await withRetry(() => Promise.reject(n++ === 0 ? first() : second()), LOGICAL_ID, {
      sleep: noSleep,
    }).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(n).toBe(2);
    return error;
  }

  it('a Cloud Control AlreadyExists (owner id, no cause) after a 5xx is not credited', async () => {
    const error = await replay(wrapped500, ccCollision);
    // The auxiliary mark had no link to land on; the stamp is what holds.
    expect(isAuxiliaryFailure(error)).toBe(false);
    expect(hasReplayMayCollide(error)).toBe(true);
    expect(isNameCollisionErrorFrom(error, LOGICAL_ID)).toBe(false);
  });

  it('a Cloud Control handler InternalFailure arms it too', async () => {
    const handlerFailure = (): Error =>
      new CloudControlOperationFailedError(
        `CREATE failed for ${LOGICAL_ID}: Internal Failure`,
        TYPE,
        LOGICAL_ID,
        undefined,
        'InternalFailure',
        'CREATE'
      );
    let n = 0;
    const error = await withRetry(
      () => Promise.reject(n++ === 0 ? handlerFailure() : ccCollision()),
      LOGICAL_ID,
      // The default classifier does not retry this message; a caller's does.
      { sleep: noSleep, isRetryable: (_t, e) => n === 1 && e instanceof CloudControlOperationFailedError }
    ).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(n).toBe(2);
    expect(isNameCollisionErrorFrom(error, LOGICAL_ID)).toBe(false);
  });

  it('a Cloud Control AlreadyExists with no earlier ambiguous attempt still classifies', async () => {
    const error = await withRetry(() => Promise.reject(ccCollision()), LOGICAL_ID, {
      sleep: noSleep,
    }).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(hasReplayMayCollide(error)).toBe(false);
    expect(isNameCollisionErrorFrom(error, LOGICAL_ID)).toBe(true);
  });

  it('a provider wrapper stamped markNameCollision after a 5xx is not credited', async () => {
    const marked = (): Error =>
      markNameCollision(
        new ProvisioningError(
          `Failed to create ${LOGICAL_ID}: conflicting record`,
          TYPE,
          LOGICAL_ID,
          undefined,
          awsSdkError('conflicting record', 'InvalidChangeBatch')
        )
      );
    const error = await replay(wrapped500, marked);
    expect(isNameCollisionErrorFrom(error, LOGICAL_ID)).toBe(false);
  });

  it('holds when a caller re-wraps the stamped error', async () => {
    const error = await replay(wrapped500, ccCollision);
    const rewrapped = new ProvisioningError('Resource creation failed', TYPE, LOGICAL_ID, undefined, error as Error);
    expect(isNameCollisionErrorFrom(rewrapped, LOGICAL_ID)).toBe(false);
  });

  it('an outer loop latches on an inner loop stamped throw it cannot mark auxiliary', async () => {
    // The nested delete-then-re-create shape: the inner default loop sees the
    // 5xx and throws the stamped CC collision; the outer loop (retrying
    // "already exists") must keep stamping its later fresh inner loops.
    let n = 0;
    const error = await withRetry(
      () =>
        withRetry(() => Promise.reject(n++ === 0 ? wrapped500() : ccCollision()), LOGICAL_ID, {
          sleep: noSleep,
        }),
      LOGICAL_ID,
      { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 1, sleep: noSleep, isRetryable: () => true }
    ).then(
      () => undefined,
      (e: unknown) => e
    );
    // Outer attempt 1 = inner (500, collide); outer attempt 2 = one collision.
    expect(n).toBe(3);
    expect(isNameCollisionErrorFrom(error, LOGICAL_ID)).toBe(false);
  });
});

describe('markReplayMayCollide / hasReplayMayCollide', () => {
  it('stamps non-enumerably and leaves primitives and frozen errors alone', () => {
    const e = markReplayMayCollide(new Error('x'));
    expect(hasReplayMayCollide(e)).toBe(true);
    expect(Object.keys(e)).toEqual([]);
    // A spread copies enumerable SYMBOL keys too, so this sees what
    // `Object.keys` / `JSON.stringify` cannot.
    expect(Object.getOwnPropertySymbols({ ...e })).toEqual([]);
    expect(markReplayMayCollide('x')).toBe('x');
    expect(markReplayMayCollide(undefined)).toBe(undefined);
    const frozen = Object.freeze(new Error('y'));
    expect(() => markReplayMayCollide(frozen)).not.toThrow();
    expect(hasReplayMayCollide(frozen)).toBe(false);
  });

  it('never throws on an error whose isExtensible trap throws', async () => {
    const trap = new Proxy(new Error('TRAP-target'), {
      isExtensible(): boolean {
        throw new Error('TRAP');
      },
    });
    expect(() => markReplayMayCollide(trap)).not.toThrow();
    // Through the wrapper: the error it settles is the one the operation threw.
    let n = 0;
    const serverFailure = new Error('UnknownError');
    Object.assign(serverFailure, { $metadata: { httpStatusCode: 500 } });
    const thrown = await withRetry(
      () => Promise.reject(n++ === 0 ? serverFailure : trap),
      'Stream',
      { sleep: () => Promise.resolve() }
    ).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(n).toBe(2);
    expect(thrown).toBe(trap);
  });

  it('is not anchored: a stamp under another resource id still withholds the verdict', () => {
    // The owner's link credits on its own (Cloud Control AlreadyExists at depth
    // 0, ahead of the other-id link where the anchor would stop the walk), so
    // only an unanchored read of the stamp below can keep this false.
    const inner = markReplayMayCollide(
      new ProvisioningError('x', 'AWS::X::Y', 'Other', undefined, new Error('y'))
    );
    const outer = new CloudControlOperationFailedError(
      'CREATE failed for Stream: already exists',
      'AWS::X::Y',
      'Stream',
      'p',
      'AlreadyExists',
      'CREATE'
    );
    expect(isNameCollisionErrorFrom(outer, 'Stream')).toBe(true);
    Object.defineProperty(outer, 'cause', { value: inner });
    expect(isNameCollisionErrorFrom(outer, 'Stream')).toBe(false);
  });

  it('reads five links, own properties only, and never throws', () => {
    let chain: unknown = markReplayMayCollide(new Error('x'));
    for (let i = 0; i < 4; i++) chain = new Error('wrap', { cause: chain });
    expect(hasReplayMayCollide(chain)).toBe(true);
    expect(hasReplayMayCollide(new Error('wrap', { cause: chain }))).toBe(false);
    expect(hasReplayMayCollide(Object.create(markReplayMayCollide(new Error('proto'))))).toBe(false);
    const hostile = {
      get cause(): unknown {
        throw new Error('getter');
      },
    };
    expect(hasReplayMayCollide(hostile)).toBe(false);
    expect(hasReplayMayCollide(null)).toBe(false);
  });
});
