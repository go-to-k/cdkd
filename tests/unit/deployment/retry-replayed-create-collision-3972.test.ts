import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * Issue #3972: a RETRYABLE auxiliary failure inside `create()` makes the retry
 * wrapper REPLAY the create, and the replayed MAIN create collides with the
 * resource the first attempt left behind. That "already exists" is raised
 * before the replay's own auxiliary flag is set, so it carries no auxiliary
 * mark, and the wrapper throws it as the LAST error. Crediting it as the
 * resource's own name collision deletes a live resource: `--replace` removes
 * the old one, and the rollback's reverse-replacement removes the new one.
 *
 * Driven through the REAL retry wrapper, the REAL Kinesis provider (it does
 * not retire the stream its create materialized, so its replay collides) and
 * the REAL classifier; only `KinesisClient.prototype.send` is stubbed, and it
 * answers by command name.
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
  isNameCollisionError,
  isNameCollisionErrorFrom,
  isRecreateRetryableError,
  markNonRetryable,
} from '../../../src/deployment/retryable-errors.js';
import {
  replayRollback,
  type CompletedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import {
  auxiliaryLogicalId,
  isAuxiliaryFailure,
  markAuxiliaryFailure,
} from '../../../src/provisioning/auxiliary-failure.js';
import { KinesisStreamProvider } from '../../../src/provisioning/providers/kinesis-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import type { ResourceState } from '../../../src/types/state.js';
import { awsSdkError } from '../_aws-sdk-error.js';

const LOGICAL_ID = 'Stream';
const TYPE = 'AWS::Kinesis::Stream';
const PROPERTIES = { Name: 'stream', ShardCount: 1, Tags: [{ Key: 'k', Value: 'v' }] };
/** Kinesis's own wording for a stream name that is taken. */
const COLLISION = 'Stream stream under account 123456789012 already exists.';
const THROTTLE = 'Rate exceeded for stream stream under account 123456789012.';

type Sendable = { send: (command: unknown) => Promise<unknown> };

/**
 * `createStreamOutcomes[i]` is what the i-th `CreateStream` does ('ok' or
 * 'collide'); `tagThrottles` is how many `AddTagsToStream` calls are throttled
 * before one succeeds. Returns the command log.
 */
function stubKinesis(opts: {
  createStreamOutcomes: Array<'ok' | 'collide'>;
  tagThrottles: number;
}): string[] {
  const sent: string[] = [];
  let creates = 0;
  let tags = 0;
  vi.spyOn(KinesisClient.prototype as unknown as Sendable, 'send').mockImplementation(
    async (command: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      sent.push(name);
      if (name === 'CreateStreamCommand') {
        const outcome = opts.createStreamOutcomes[creates++] ?? 'collide';
        if (outcome === 'collide') throw awsSdkError(COLLISION, 'ResourceInUseException');
        return {};
      }
      if (name === 'AddTagsToStreamCommand' && tags++ < opts.tagThrottles) {
        throw awsSdkError(THROTTLE, 'LimitExceededException');
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

function createThroughRetry(provider = new KinesisStreamProvider()): Promise<unknown> {
  return withRetry(
    () => provider.create(LOGICAL_ID, TYPE, structuredClone(PROPERTIES)),
    LOGICAL_ID,
    { sleep: noSleep }
  ).then(
    () => undefined,
    (e: unknown) => e
  );
}

beforeEach(() => {
  vi.stubEnv('AWS_REGION', 'us-east-1');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('a replayed create colliding with its own earlier attempt (#3972)', () => {
  it('is not credited as the resource name collision by the retry wrapper', async () => {
    const sent = stubKinesis({ createStreamOutcomes: ['ok', 'collide'], tagThrottles: 1 });
    const error = await createThroughRetry();

    // The shape the issue describes, and not a shortcut to it: the stream was
    // created, its tag call was throttled, the wrapper replayed create(), and
    // the replay's CreateStream collided.
    expect(sent.filter((c) => c === 'CreateStreamCommand')).toHaveLength(2);
    expect(sent.filter((c) => c === 'AddTagsToStreamCommand')).toHaveLength(1);
    expect(error).toBeInstanceOf(Error);
    // What the wrapper throws is the replay's, and it still RELAYS AWS's
    // "already exists": the message is unchanged, so only the carried mark
    // can keep the verdict false.
    expect((error as Error).message).toContain(COLLISION);
    expect(isNameCollisionError((error as Error).message)).toBe(true);
    expect(isNameCollisionErrorFrom(error, LOGICAL_ID)).toBe(false);
  });

  it('covers the nested loops wrapped around the delete-then-re-create sites', async () => {
    // `deploy-engine.ts`'s --replace fallback and recreate site nest a
    // default-schedule `withRetry` inside an outer one whose classifier is
    // `isRecreateRetryableError` -- which RETRIES "already exists". The outer
    // loop therefore replays a fresh inner loop that has never seen the
    // auxiliary failure; its throws must still not be credited.
    const sent = stubKinesis({ createStreamOutcomes: ['ok', 'collide'], tagThrottles: 1 });
    const provider = new KinesisStreamProvider();
    const error = await withRetry(
      () =>
        withRetry(() => provider.create(LOGICAL_ID, TYPE, structuredClone(PROPERTIES)), LOGICAL_ID, {
          sleep: noSleep,
        }),
      LOGICAL_ID,
      {
        maxRetries: 2,
        initialDelayMs: 1,
        maxDelayMs: 1,
        sleep: noSleep,
        isRetryable: isRecreateRetryableError,
      }
    ).then(
      () => undefined,
      (e: unknown) => e
    );

    // Outer attempt 1 = inner (ok+throttle, collide); outer attempts 2 and 3 =
    // one colliding CreateStream each.
    expect(sent.filter((c) => c === 'CreateStreamCommand')).toHaveLength(4);
    expect((error as Error).message).toContain(COLLISION);
    expect(isNameCollisionErrorFrom(error, LOGICAL_ID)).toBe(false);
  });

  it('a genuine first-attempt collision still classifies (negative control)', async () => {
    const sent = stubKinesis({ createStreamOutcomes: ['collide'], tagThrottles: 0 });
    const error = await createThroughRetry();

    expect(sent.filter((c) => c === 'CreateStreamCommand')).toHaveLength(1);
    expect(sent).not.toContain('AddTagsToStreamCommand');
    expect(isNameCollisionErrorFrom(error, LOGICAL_ID)).toBe(true);
  });

  it('the latch is per call: a later call colliding first still classifies', async () => {
    // State held across `withRetry` calls would silence every later genuine
    // collision in the run.
    stubKinesis({ createStreamOutcomes: ['ok', 'collide', 'collide'], tagThrottles: 1 });
    const provider = new KinesisStreamProvider();
    const first = await createThroughRetry(provider);
    expect(isNameCollisionErrorFrom(first, LOGICAL_ID)).toBe(false);

    const second = await createThroughRetry(provider);
    expect(isNameCollisionErrorFrom(second, LOGICAL_ID)).toBe(true);
  });

  it('a replay that succeeds is returned as before', async () => {
    // A provider that retires its resource in the catch replays cleanly; the
    // fix must not turn the auxiliary failure into a give-up.
    stubKinesis({ createStreamOutcomes: ['ok', 'ok'], tagThrottles: 1 });
    const provider = new KinesisStreamProvider();
    const result = await withRetry(
      () => provider.create(LOGICAL_ID, TYPE, structuredClone(PROPERTIES)),
      LOGICAL_ID,
      { sleep: noSleep }
    );
    expect(result.physicalId).toBe('stream');
  });
});

describe('every throw exit of the wrapper carries the mark forward (#3972)', () => {
  /** A provider-shaped collision: the owner's wrapper over AWS's error. */
  function wrappedCollision(): Error {
    return new ProvisioningError(
      `Failed to create ${LOGICAL_ID}: ${COLLISION}`,
      TYPE,
      LOGICAL_ID,
      undefined,
      awsSdkError(COLLISION, 'ResourceInUseException')
    );
  }
  function auxThrottle(): Error {
    return markAuxiliaryFailure(
      new ProvisioningError(
        `Failed to create ${LOGICAL_ID}: ${THROTTLE}`,
        TYPE,
        LOGICAL_ID,
        undefined,
        awsSdkError(THROTTLE, 'LimitExceededException')
      ),
      LOGICAL_ID
    );
  }

  it('the markNonRetryable exit', async () => {
    let n = 0;
    const error = await withRetry(
      () => Promise.reject(n++ === 0 ? auxThrottle() : markNonRetryable(wrappedCollision())),
      LOGICAL_ID,
      { sleep: noSleep }
    ).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(n).toBe(2);
    expect(isNameCollisionErrorFrom(error, LOGICAL_ID)).toBe(false);
  });

  it('an unmarked collision with no earlier auxiliary failure is left alone', async () => {
    // The same exit, unlatched: nothing is marked that the provider did not.
    const error = await withRetry(
      () => Promise.reject(markNonRetryable(wrappedCollision())),
      LOGICAL_ID,
      { sleep: noSleep }
    ).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(isNameCollisionErrorFrom(error, LOGICAL_ID)).toBe(true);
  });
});

describe('isAuxiliaryFailure', () => {
  it('reads a mark at the top, beneath an owner wrapper, and on a non-Error link', () => {
    expect(isAuxiliaryFailure(markAuxiliaryFailure(new Error('x'), 'A'))).toBe(true);
    const wrapped = new ProvisioningError('x', TYPE, 'A', undefined, new Error('y'));
    expect(isAuxiliaryFailure(wrapped)).toBe(false);
    markAuxiliaryFailure(wrapped, 'A');
    expect(isAuxiliaryFailure(wrapped)).toBe(true);
    expect(isAuxiliaryFailure({ logicalId: auxiliaryLogicalId('A') })).toBe(true);
  });

  it('is false for an owner id, an unmarked chain, primitives and a mark past the walk', () => {
    expect(isAuxiliaryFailure(new ProvisioningError('x', TYPE, 'A'))).toBe(false);
    expect(isAuxiliaryFailure(new Error('x', { cause: new Error('y') }))).toBe(false);
    expect(isAuxiliaryFailure('A/auxiliary')).toBe(false);
    expect(isAuxiliaryFailure(undefined)).toBe(false);
    // A non-string or inherited logicalId is not a mark.
    expect(isAuxiliaryFailure({ logicalId: 1 })).toBe(false);
    expect(isAuxiliaryFailure(Object.create({ logicalId: auxiliaryLogicalId('A') }))).toBe(false);
    // Five links are walked, as `markAuxiliaryFailure` walks them.
    let chain: unknown = { logicalId: auxiliaryLogicalId('A') };
    for (let i = 0; i < 4; i++) chain = { logicalId: 'A', cause: chain };
    expect(isAuxiliaryFailure(chain)).toBe(true);
    expect(isAuxiliaryFailure({ logicalId: 'A', cause: chain })).toBe(false);
  });
});

describe('the rollback reverse-replacement arm does not delete the live new stream (#3972)', () => {
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

  it('fails the op instead of deleting the new stream', async () => {
    // The issue's rollback shape: the Name changed (stream -> stream-new), so
    // reverting re-creates `stream`; its tag call is throttled, the replayed
    // CreateStream meets the `stream` attempt 1 just made, and the
    // delete-new-first arm used to delete the live `stream-new`, which never
    // held the name.
    // The third outcome is what a pre-fix run's re-create after its delete
    // meets, so that arm completes instead of retrying "already exists" for
    // minutes; a fixed run never sends it.
    const sent = stubKinesis({ createStreamOutcomes: ['ok', 'collide', 'ok'], tagThrottles: 1 });
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
      [LOGICAL_ID]: res({ physicalId: 'stream-new', properties: { ...PROPERTIES, Name: 'stream-new' } }),
    };

    const result = await replayRollback([op], state, 'CdkdX', ctx);

    // THE DISCRIMINATOR, asserted first so a regression fails HERE: before
    // #3972 the collision arm deleted `stream-new`.
    expect(del).not.toHaveBeenCalled();
    // Reached the shape under test: created, throttled, replayed, collided.
    expect(sent.filter((c) => c === 'CreateStreamCommand')).toHaveLength(2);
    expect(result.failures).toBe(1);
    expect(state[LOGICAL_ID]?.physicalId).toBe('stream-new');
  }, 15_000);
});
