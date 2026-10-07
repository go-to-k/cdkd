import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// go-to-k/cdkd#3978 layer (b): `CreateStream` carries no idempotency token, so
// the AWS SDK's own retry of a 5xx whose request had succeeded replays it
// inside ONE `send` and collides with the stream the first send made. That
// `ResourceInUseException` surfaced from the engine's first attempt and read as
// a stream somebody else holds.

const { mockSend, sentVia, baseStrategy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  /** `[command name, client config]` per send, so a test can see WHICH client sent it. */
  sentVia: [] as Array<[string, { retryStrategy: () => Promise<unknown> }]>,
  /** A stand-in for the SDK's resolved V2 retry strategy: it retries a server fault only. */
  baseStrategy: {
    acquireInitialRetryToken: async (_scope: string) => 'token',
    refreshRetryTokenForRetry: async (_token: unknown, info: { error?: unknown }) => {
      if ((info.error as { $fault?: string } | undefined)?.$fault !== 'server') {
        throw new Error('not retryable');
      }
      return 'retry-token';
    },
    recordSuccess: (_token: unknown) => undefined,
  },
}));

/** How many times the stand-in SDK replays one `send` (the standard mode's 3 attempts). */
const SDK_MAX_ATTEMPTS = 3;

vi.mock('@aws-sdk/client-kinesis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-kinesis')>();
  return {
    ...actual,
    KinesisClient: vi.fn().mockImplementation(() => {
      const config = {
        region: () => Promise.resolve('us-east-1'),
        retryStrategy: async (): Promise<unknown> => baseStrategy,
      };
      return {
        config,
        // Models the SDK retry middleware: on a failure it asks the client's
        // RESOLVED strategy whether to retry, and replays the same request
        // when the strategy hands back a token.
        send: async (command: { constructor: { name: string } }) => {
          sentVia.push([command.constructor.name, config]);
          const strategy = (await config.retryStrategy()) as typeof baseStrategy;
          let token: unknown = await strategy.acquireInitialRetryToken('kinesis');
          for (let attempt = 1; ; attempt++) {
            try {
              return await mockSend(command);
            } catch (error) {
              if (attempt >= SDK_MAX_ATTEMPTS) throw error;
              try {
                token = await strategy.refreshRetryTokenForRetry(token, { error });
              } catch {
                throw error;
              }
            }
          }
        },
      };
    }),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { Readable } from 'node:stream';
import { ResourceInUseException } from '@aws-sdk/client-kinesis';
import { withoutServerErrorRetries } from '../../../src/provisioning/providers/ambiguous-create.js';
import { KinesisStreamProvider } from '../../../src/provisioning/providers/kinesis-provider.js';
import { withRetry } from '../../../src/deployment/retry.js';
import {
  isNameCollisionErrorFrom,
  isReplayedNameCollisionFrom,
} from '../../../src/deployment/retryable-errors.js';
import {
  isAuxiliaryMarkOf,
  RETRY_AUXILIARY_OWNER,
} from '../../../src/provisioning/auxiliary-failure.js';

const TYPE = 'AWS::Kinesis::Stream';
const PROPS = { Name: 'orders', ShardCount: 1, Tags: [{ Key: 'team', Value: 'a' }] };

/** The shape `isTransientServerError` / `isAmbiguousOutcomeError` classify (issue #2026). */
const transient500 = (): Error =>
  Object.assign(new Error('Internal failure'), {
    name: 'InternalFailure',
    $fault: 'server',
    $metadata: { httpStatusCode: 500 },
  });

const throttled = (): Error =>
  Object.assign(new Error('Rate exceeded'), {
    name: 'ThrottlingException',
    $fault: 'server',
    $metadata: { httpStatusCode: 503 },
  });

/** Advance the fake clock on every backoff. */
const advancingSleep = (ms: number): Promise<void> => {
  vi.setSystemTime(Date.now() + Math.max(ms, 1000));
  return Promise.resolve();
};

/** A fake Kinesis. `streams` counts RESOURCES, not calls. */
class FakeKinesis {
  readonly streams = new Set<string>();
  readonly calls: string[] = [];
  /** The named call does its work, THEN throws this (a lost response). */
  readonly loseNextResponse = new Map<string, Error>();

  send = async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = command.constructor.name;
    this.calls.push(name);
    const streamName = command.input['StreamName'] as string;
    switch (name) {
      case 'CreateStreamCommand': {
        if (this.streams.has(streamName)) {
          throw new ResourceInUseException({
            message: `Stream ${streamName} under account 123456789012 already exists.`,
            $metadata: { httpStatusCode: 400 },
          });
        }
        this.streams.add(streamName);
        const error = this.loseNextResponse.get(name);
        if (error) {
          this.loseNextResponse.delete(name);
          throw error;
        }
        return {};
      }
      case 'DescribeStreamCommand':
        return {
          StreamDescription: {
            StreamStatus: 'ACTIVE',
            StreamARN: `arn:aws:kinesis:us-east-1:123456789012:stream/${streamName}`,
          },
        };
      default:
        return {};
    }
  };
}

describe('KinesisStreamProvider create retry safety (issue #3978)', () => {
  let provider: KinesisStreamProvider;
  let aws: FakeKinesis;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T00:00:00Z'));
    aws = new FakeKinesis();
    mockSend.mockReset();
    mockSend.mockImplementation(aws.send);
    sentVia.length = 0;
    provider = new KinesisStreamProvider();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const createWithRetry = () =>
    withRetry(() => provider.create('Stream', TYPE, PROPS), 'Stream', { sleep: advancingSleep });

  it('a lost CreateStream response surfaces the replay collision as one THIS create may have made', async () => {
    aws.loseNextResponse.set('CreateStreamCommand', transient500());

    const error = await createWithRetry().catch((e: unknown) => e);

    // One stream, never two: the name collides rather than duplicating.
    expect([...aws.streams]).toEqual(['orders']);
    // The 5xx left the SDK unreplayed and reached the engine's retry, which
    // sent the create again.
    expect(aws.calls.filter((c) => c === 'CreateStreamCommand')).toHaveLength(2);
    expect(sentVia.filter(([n]) => n === 'CreateStreamCommand')).toHaveLength(2);
    // Read as a REPLAYED collision, never as a name somebody else holds --
    // the verdict a delete-first path would act on. Without the dedicated
    // client the SDK stand-in replays the 5xx inside one send, and the
    // collision is credited to another holder.
    expect(isNameCollisionErrorFrom(error, 'Stream')).toBe(false);
    expect(
      isReplayedNameCollisionFrom(error, 'Stream', (link) =>
        isAuxiliaryMarkOf(link, RETRY_AUXILIARY_OWNER)
      )
    ).toBe(true);
    // Never adopted: a name is not attribution.
    expect(aws.calls).not.toContain('AddTagsToStreamCommand');
  });

  it('a stream that already existed before any ambiguous attempt is still a name collision', async () => {
    aws.streams.add('orders');

    const error = await createWithRetry().catch((e: unknown) => e);

    expect(aws.calls.filter((c) => c === 'CreateStreamCommand')).toHaveLength(1);
    expect(isNameCollisionErrorFrom(error, 'Stream')).toBe(true);
    expect(aws.calls).not.toContain('AddTagsToStreamCommand');
  });

  it('a create with no failure still completes through the follow-up calls', async () => {
    const result = await createWithRetry();

    expect(result.physicalId).toBe('orders');
    expect(aws.calls).toContain('AddTagsToStreamCommand');
  });

  it('sends CreateStream through a client that refuses the SDK retry of a 5xx, and nothing else', async () => {
    await provider.create('Stream', TYPE, PROPS);

    const createConfig = sentVia.find(([n]) => n === 'CreateStreamCommand')![1];
    const strategy = (await createConfig.retryStrategy()) as typeof baseStrategy;
    await expect(
      strategy.refreshRetryTokenForRetry('t', { error: transient500() } as never)
    ).rejects.toThrow();
    await expect(
      strategy.refreshRetryTokenForRetry('t', { error: throttled() } as never)
    ).resolves.toBe('retry-token');

    for (const name of ['DescribeStreamCommand', 'AddTagsToStreamCommand']) {
      const config = sentVia.find(([n]) => n === name)![1];
      expect(await config.retryStrategy()).toBe(baseStrategy);
    }
  });
});

/**
 * A REAL `KinesisClient` (the module mock above is bypassed with
 * `importActual`) against a stub HTTP handler: pins that the wrapper takes hold
 * on the client this provider builds, not only on the KMS client
 * `ambiguous-create.test.ts` uses.
 */
describe('withoutServerErrorRetries on a real KinesisClient (issue #3978)', () => {
  const makeClient = async () => {
    const { KinesisClient: RealKinesisClient, CreateStreamCommand } =
      await vi.importActual<typeof import('@aws-sdk/client-kinesis')>('@aws-sdk/client-kinesis');
    const requests: number[] = [];
    const client = new RealKinesisClient({
      region: 'us-east-1',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
      requestHandler: {
        handle: async () => {
          requests.push(requests.length);
          const first = requests.length === 1;
          return {
            response: {
              statusCode: first ? 500 : 200,
              headers: { 'content-type': 'application/x-amz-json-1.1' },
              body: Readable.from([
                Buffer.from(first ? '{"__type":"InternalFailure","message":"boom"}' : '{}'),
              ]),
            },
          };
        },
      } as never,
    });
    const send = () =>
      client.send(new CreateStreamCommand({ StreamName: 'orders', ShardCount: 1 }));
    return { client, requests, send };
  };

  it('an unwrapped client replays a CreateStream 500 inside one send', async () => {
    const { requests, send } = await makeClient();

    await send();

    expect(requests).toHaveLength(2);
  });

  it('a wrapped client sends a CreateStream 500 once and throws it', async () => {
    const { client, requests, send } = await makeClient();
    withoutServerErrorRetries(client);

    const error = await send().catch((e: unknown) => e);

    expect(requests).toHaveLength(1);
    expect((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode).toBe(
      500
    );
  });
});
