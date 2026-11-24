import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#6578: `CreateArchive` carries no idempotency token, so it goes
// through a client that does not replay a 5xx inside one `send` (the EventBus
// provider's #4639 shape, after the Kinesis #3978 test). Every other call keeps
// the shared client's full SDK retry.

const { mockSend, sentVia, baseStrategy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  /** `[command name, client id]` per send attempt. */
  sentVia: [] as Array<[string, number]>,
  /** Stand-in for the SDK's resolved retry strategy: it retries a server fault only. */
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

vi.mock('@aws-sdk/client-eventbridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-eventbridge')>();
  let nextId = 0;
  class EventBridgeClient {
    readonly id = nextId++;
    config = {
      region: () => Promise.resolve('us-east-1'),
      retryStrategy: async (): Promise<unknown> => baseStrategy,
    };
    send = async (command: { constructor: { name: string } }): Promise<unknown> => {
      const strategy = (await this.config.retryStrategy()) as typeof baseStrategy;
      let token: unknown = await strategy.acquireInitialRetryToken('events');
      for (let attempt = 1; ; attempt++) {
        sentVia.push([command.constructor.name, this.id]);
        try {
          return await mockSend(command);
        } catch (error) {
          if (attempt >= 3) throw error;
          try {
            token = await strategy.refreshRetryTokenForRetry(token, { error });
          } catch {
            throw error;
          }
        }
      }
    };
  }
  return { ...actual, EventBridgeClient };
});

vi.mock('../../../src/utils/aws-clients.js', async () => {
  const { EventBridgeClient } = await import('@aws-sdk/client-eventbridge');
  const shared = new EventBridgeClient({});
  return { getAwsClients: () => ({ eventBridge: shared }) };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(function (this: unknown) { return this; }),
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

import { EventBridgeArchiveProvider } from '../../../src/provisioning/providers/eventbridge-archive-provider.js';
import { getAwsClients } from '../../../src/utils/aws-clients.js';

const TYPE = 'AWS::Events::Archive';
const BUS_ARN = 'arn:aws:events:us-east-1:123456789012:event-bus/b';

const transient500 = (): Error =>
  Object.assign(new Error('Internal failure'), {
    name: 'InternalException',
    $fault: 'server',
    $metadata: { httpStatusCode: 500 },
  });

describe('EventBridgeArchiveProvider create client (issue #6578)', () => {
  let provider: EventBridgeArchiveProvider;
  const sharedId = (getAwsClients().eventBridge as unknown as { id: number }).id;

  beforeEach(() => {
    mockSend.mockReset();
    sentVia.length = 0;
    provider = new EventBridgeArchiveProvider();
  });

  it('a 5xx from CreateArchive is not replayed inside the send', async () => {
    mockSend.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'CreateArchiveCommand') throw transient500();
      return {};
    });

    await expect(
      provider.create('Arch', TYPE, { ArchiveName: 'a', SourceArn: BUS_ARN })
    ).rejects.toThrow(/Failed to create EventBridge archive Arch/);

    const creates = sentVia.filter(([name]) => name === 'CreateArchiveCommand');
    expect(creates).toHaveLength(1);
    // Sent through its own client, not the shared one.
    expect(creates[0]![1]).not.toBe(sharedId);
  });

  it('the settle wait keeps the shared client and its SDK retry', async () => {
    let describes = 0;
    mockSend.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'CreateArchiveCommand') return { State: 'CREATING' };
      describes++;
      if (describes === 1) throw transient500();
      return { State: 'ENABLED', ArchiveArn: 'arn:x' };
    });

    await provider.create('Arch', TYPE, { ArchiveName: 'a', SourceArn: BUS_ARN });

    const reads = sentVia.filter(([name]) => name === 'DescribeArchiveCommand');
    expect(reads).toHaveLength(2);
    expect(reads.every(([, id]) => id === sharedId)).toBe(true);
  });
});
