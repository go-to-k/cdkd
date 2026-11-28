import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  DescribeContributorInsightsCommand,
  DescribeKinesisStreamingDestinationCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () =>
    new Proxy(
      {},
      { get: () => ({ send: mockSend, config: { region: () => Promise.resolve('us-east-1') } }) }
    ),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(function (this: unknown) {
      return this;
    }),
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

import { DynamoDBTableProvider } from '../../../src/provisioning/providers/dynamodb-table-provider.js';
import { DynamoDBGlobalTableProvider } from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';

/**
 * go-to-k/cdkd#7132: every send site of `UpdateContributorInsights` and
 * `EnableKinesisStreamingDestination`, on both table types, waits for the
 * change to land before it returns, as CloudFormation does. Each case
 * answers the first read with the transitional status and asserts the
 * provider read again (a provider that returned after the call reads
 * nothing).
 */

const STREAM = 'arn:aws:kinesis:us-east-1:123456789012:stream/s';
const identity = (s: string): string => s;

type Reads = { insights?: string[]; kinesis?: string[] };

/** Answer the settle reads in order (the last one repeats); everything else `{}`. */
function route(reads: Reads, preEnable: string[] = []): void {
  const insights = [...(reads.insights ?? [])];
  const kinesis = [...preEnable, ...(reads.kinesis ?? [])];
  const next = (q: string[]): string => (q.length > 1 ? q.shift()! : q[0]!);
  mockSend.mockImplementation(async (cmd: unknown) => {
    if (cmd instanceof DescribeContributorInsightsCommand) {
      return { ContributorInsightsStatus: next(insights) };
    }
    if (cmd instanceof DescribeKinesisStreamingDestinationCommand) {
      const status = next(kinesis);
      return {
        KinesisDataStreamDestinations:
          status === 'none' ? [] : [{ StreamArn: STREAM, DestinationStatus: status }],
      };
    }
    return {};
  });
}

const count = (ctor: abstract new (...a: never[]) => unknown): number =>
  mockSend.mock.calls.filter((c) => c[0] instanceof ctor).length;

const lastName = (): string =>
  (mockSend.mock.calls.at(-1)![0] as { constructor: { name: string } }).constructor.name;

describe('AWS::DynamoDB::Table waits for its toggles (#7132)', () => {
  let provider: DynamoDBTableProvider;
  beforeEach(() => {
    mockSend.mockReset();
    provider = new DynamoDBTableProvider();
  });

  it('a table-level Contributor Insights ENABLE reads until ENABLED', async () => {
    route({ insights: ['ENABLING', 'ENABLED'] });
    await provider.sendContributorInsightsOp('t', { action: 'ENABLE' }, identity);
    expect(count(DescribeContributorInsightsCommand)).toBe(2);
    expect(lastName()).toBe('DescribeContributorInsightsCommand');
  });

  it('an index-level DISABLE reads the index until DISABLED', async () => {
    route({ insights: ['DISABLING', 'DISABLED'] });
    await provider.sendContributorInsightsOp('t', { indexName: 'g', action: 'DISABLE' }, identity);
    const reads = mockSend.mock.calls.filter(
      (c) => c[0] instanceof DescribeContributorInsightsCommand
    );
    expect(reads).toHaveLength(2);
    expect((reads[0]![0] as DescribeContributorInsightsCommand).input.IndexName).toBe('g');
  });

  it('a FAILED toggle fails the update (after the stale-read grace)', async () => {
    vi.useFakeTimers();
    try {
      route({ insights: ['FAILED'] });
      const p = provider.sendContributorInsightsOp('t', { action: 'ENABLE' }, identity).then(
        () => new Error('expected the update to fail'),
        (e: unknown) => e
      );
      await vi.advanceTimersByTimeAsync(60_000);
      expect(String(await p)).toContain('status FAILED');
    } finally {
      vi.useRealTimers();
    }
  });

  it('--no-wait (CDKD_NO_WAIT=true) skips both waits', async () => {
    vi.stubEnv('CDKD_NO_WAIT', 'true');
    try {
      route({ insights: ['ENABLING'], kinesis: ['ENABLING'] });
      await provider.sendContributorInsightsOp('t', { action: 'ENABLE' }, identity);
      await provider.applyKinesisStreamingDestination('t', { StreamArn: STREAM }, undefined, identity);
      expect(count(DescribeContributorInsightsCommand)).toBe(0);
      expect(count(DescribeKinesisStreamingDestinationCommand)).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('a Kinesis enable reads until the destination is ACTIVE', async () => {
    route({ kinesis: ['ENABLING', 'ACTIVE'] });
    await provider.applyKinesisStreamingDestination('t', { StreamArn: STREAM }, undefined, identity);
    expect(count(DescribeKinesisStreamingDestinationCommand)).toBe(2);
    expect(lastName()).toBe('DescribeKinesisStreamingDestinationCommand');
  });
});

describe('AWS::DynamoDB::GlobalTable waits for its replica toggles (#7132)', () => {
  let provider: DynamoDBGlobalTableProvider;
  const client = { send: mockSend } as unknown as DynamoDBClient;
  const describe_ = async (): Promise<{ tableArn?: string; streamArn?: string }> => ({});
  const run = (op: unknown): Promise<void> =>
    provider.sendReplicaSettingOp(client, 't', 'us-east-1', 'G', op as never, describe_, identity);

  beforeEach(() => {
    mockSend.mockReset();
    provider = new DynamoDBGlobalTableProvider();
  });

  it('a replica Contributor Insights ENABLE reads until ENABLED', async () => {
    route({ insights: ['ENABLING', 'ENABLED'] });
    await run({ kind: 'contributorInsights', action: 'ENABLE' });
    expect(count(DescribeContributorInsightsCommand)).toBe(2);
  });

  it('a replica index Contributor Insights ENABLE reads the index until ENABLED', async () => {
    route({ insights: ['ENABLING', 'ENABLED'] });
    await run({ kind: 'indexContributorInsights', indexName: 'g', action: 'ENABLE' });
    const reads = mockSend.mock.calls.filter(
      (c) => c[0] instanceof DescribeContributorInsightsCommand
    );
    expect(reads).toHaveLength(2);
    expect((reads[0]![0] as DescribeContributorInsightsCommand).input.IndexName).toBe('g');
  });

  it('--no-wait (CDKD_NO_WAIT=true) skips the replica waits', async () => {
    vi.stubEnv('CDKD_NO_WAIT', 'true');
    try {
      route({ insights: ['ENABLING'], kinesis: ['ENABLING'] }, ['none']);
      await run({ kind: 'contributorInsights', action: 'ENABLE' });
      await run({ kind: 'kinesisEnable', streamArn: STREAM });
      expect(count(DescribeContributorInsightsCommand)).toBe(0);
      // Only the pre-check read before the enable.
      expect(count(DescribeKinesisStreamingDestinationCommand)).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('a replica Kinesis enable reads until the destination is ACTIVE', async () => {
    // The pre-check finds no destination, the enable is sent, then the wait.
    route({ kinesis: ['ENABLING', 'ACTIVE'] }, ['none']);
    await run({ kind: 'kinesisEnable', streamArn: STREAM });
    expect(mockSend.mock.calls.map((c) => (c[0] as object).constructor.name)).toEqual([
      'DescribeKinesisStreamingDestinationCommand',
      'EnableKinesisStreamingDestinationCommand',
      'DescribeKinesisStreamingDestinationCommand',
      'DescribeKinesisStreamingDestinationCommand',
    ]);
  });

  it('a re-run that finds the destination still ENABLING waits for it too', async () => {
    route({ kinesis: ['ACTIVE'] }, ['ENABLING', 'ENABLING']);
    await run({ kind: 'kinesisEnable', streamArn: STREAM });
    expect(mockSend.mock.calls.map((c) => (c[0] as object).constructor.name)).toEqual([
      'DescribeKinesisStreamingDestinationCommand',
      'DescribeKinesisStreamingDestinationCommand',
      'DescribeKinesisStreamingDestinationCommand',
    ]);
  });
});
