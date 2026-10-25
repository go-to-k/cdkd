import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateStreamCommand,
  DescribeStreamSummaryCommand,
  UpdateStreamModeCommand,
  UpdateStreamRecordDistributionStrategyCommand,
} from '@aws-sdk/client-kinesis';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-kinesis', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-kinesis')>(
    '@aws-sdk/client-kinesis'
  );
  return {
    ...actual,
    KinesisClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { KinesisStreamProvider } from '../../../src/provisioning/providers/kinesis-provider.js';

const ACTIVE = {
  StreamDescription: { StreamName: 'mystream', StreamStatus: 'ACTIVE', StreamARN: 'arn:describe' },
};
// A DISTINCT ARN from the DescribeStream one: the strategy update must take
// its `StreamARN` from `resolveStreamArn` (DescribeStreamSummary).
const SUMMARY = { StreamDescriptionSummary: { StreamARN: 'arn:summary', OpenShardCount: 1 } };
const ON_DEMAND = { StreamMode: 'ON_DEMAND' };

function commandsOfType<T>(ctor: new (...args: never[]) => T): T[] {
  return mockSend.mock.calls.map((c) => c[0]).filter((c): c is T => c instanceof ctor);
}

describe('KinesisStreamProvider RecordDistributionStrategy (go-to-k/cdkd#2762)', () => {
  let provider: KinesisStreamProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    mockSend.mockResolvedValue({ ...ACTIVE, ...SUMMARY });
    provider = new KinesisStreamProvider();
  });

  it('declares RecordDistributionStrategy handled and WarmThroughputMiBps by design', () => {
    expect(provider.handledProperties.get('AWS::Kinesis::Stream')?.has('RecordDistributionStrategy')).toBe(true);
    expect(provider.handledProperties.get('AWS::Kinesis::Stream')?.has('WarmThroughputMiBps')).toBe(false);
    expect(provider.unhandledByDesign.get('AWS::Kinesis::Stream')?.has('WarmThroughputMiBps')).toBe(true);
  });

  it('sends the strategy on CreateStream itself', async () => {
    await provider.create('L', 'AWS::Kinesis::Stream', {
      Name: 'mystream',
      StreamModeDetails: ON_DEMAND,
      RecordDistributionStrategy: 'AUTO',
    });
    const [create] = commandsOfType(CreateStreamCommand);
    expect(create?.input.RecordDistributionStrategy).toBe('AUTO');
    expect(commandsOfType(UpdateStreamRecordDistributionStrategyCommand)).toHaveLength(0);
  });

  it('omits the strategy from CreateStream when the template declares none', async () => {
    await provider.create('L', 'AWS::Kinesis::Stream', {
      Name: 'mystream',
      StreamModeDetails: ON_DEMAND,
    });
    const [create] = commandsOfType(CreateStreamCommand);
    expect(create).toBeDefined();
    expect(create?.input).not.toHaveProperty('RecordDistributionStrategy');
  });

  it('refuses an unusable strategy on a template-path create, before any call', async () => {
    await expect(
      provider.create('L', 'AWS::Kinesis::Stream', {
        Name: 'mystream',
        StreamModeDetails: ON_DEMAND,
        RecordDistributionStrategy: { Ref: 'Unresolved' },
      })
    ).rejects.toThrow(/RecordDistributionStrategy must be a non-empty string/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('omits an unusable strategy with a warning on a state replay', async () => {
    await provider.create(
      'L',
      'AWS::Kinesis::Stream',
      { Name: 'mystream', StreamModeDetails: ON_DEMAND, RecordDistributionStrategy: '' },
      { replayingState: true }
    );
    const [create] = commandsOfType(CreateStreamCommand);
    expect(create).toBeDefined();
    expect(create?.input).not.toHaveProperty('RecordDistributionStrategy');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('default record distribution strategy')
    );
  });

  it('updates a changed strategy through the SUMMARY-resolved stream ARN', async () => {
    await provider.update(
      'L',
      'mystream',
      'AWS::Kinesis::Stream',
      { Name: 'mystream', StreamModeDetails: ON_DEMAND, RecordDistributionStrategy: 'AUTO' },
      {
        Name: 'mystream',
        StreamModeDetails: ON_DEMAND,
        RecordDistributionStrategy: 'USER_PARTITION_KEY',
      }
    );
    const cmds = commandsOfType(UpdateStreamRecordDistributionStrategyCommand);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]?.input).toEqual({ StreamARN: 'arn:summary', RecordDistributionStrategy: 'AUTO' });
  });

  it('sends the strategy AFTER the switch to ON_DEMAND that makes it valid', async () => {
    await provider.update(
      'L',
      'mystream',
      'AWS::Kinesis::Stream',
      { Name: 'mystream', StreamModeDetails: ON_DEMAND, RecordDistributionStrategy: 'AUTO' },
      { Name: 'mystream', StreamModeDetails: { StreamMode: 'PROVISIONED' }, ShardCount: 1 }
    );
    const order = mockSend.mock.calls
      .map((c) => c[0])
      .filter(
        (c) =>
          c instanceof UpdateStreamModeCommand ||
          c instanceof UpdateStreamRecordDistributionStrategyCommand
      )
      .map((c) => c.constructor.name);
    expect(order).toEqual([
      'UpdateStreamModeCommand',
      'UpdateStreamRecordDistributionStrategyCommand',
    ]);
  });

  it('makes no call when the strategy is unchanged', async () => {
    await provider.update(
      'L',
      'mystream',
      'AWS::Kinesis::Stream',
      { Name: 'mystream', StreamModeDetails: ON_DEMAND, RecordDistributionStrategy: 'AUTO' },
      { Name: 'mystream', StreamModeDetails: ON_DEMAND, RecordDistributionStrategy: 'AUTO' }
    );
    expect(commandsOfType(UpdateStreamRecordDistributionStrategyCommand)).toHaveLength(0);
  });

  it('resets a REMOVED strategy to USER_PARTITION_KEY, as CloudFormation does', async () => {
    await provider.update(
      'L',
      'mystream',
      'AWS::Kinesis::Stream',
      { Name: 'mystream', StreamModeDetails: ON_DEMAND },
      { Name: 'mystream', StreamModeDetails: ON_DEMAND, RecordDistributionStrategy: 'AUTO' }
    );
    const cmds = commandsOfType(UpdateStreamRecordDistributionStrategyCommand);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]?.input.RecordDistributionStrategy).toBe('USER_PARTITION_KEY');
  });

  it('sends no reset when the removed strategy was already the default', async () => {
    await provider.update(
      'L',
      'mystream',
      'AWS::Kinesis::Stream',
      { Name: 'mystream', StreamModeDetails: ON_DEMAND },
      {
        Name: 'mystream',
        StreamModeDetails: ON_DEMAND,
        RecordDistributionStrategy: 'USER_PARTITION_KEY',
      }
    );
    expect(commandsOfType(UpdateStreamRecordDistributionStrategyCommand)).toHaveLength(0);
  });

  it('sends no reset when the stream leaves ON_DEMAND, where the strategy does not apply', async () => {
    await provider.update(
      'L',
      'mystream',
      'AWS::Kinesis::Stream',
      { Name: 'mystream', StreamModeDetails: { StreamMode: 'PROVISIONED' }, ShardCount: 1 },
      { Name: 'mystream', StreamModeDetails: ON_DEMAND, RecordDistributionStrategy: 'AUTO' }
    );
    expect(commandsOfType(UpdateStreamModeCommand)).toHaveLength(1);
    expect(commandsOfType(UpdateStreamRecordDistributionStrategyCommand)).toHaveLength(0);
  });

  it('warns and leaves the live strategy alone when the UPDATE desired value is unusable', async () => {
    await provider.update(
      'L',
      'mystream',
      'AWS::Kinesis::Stream',
      { Name: 'mystream', StreamModeDetails: ON_DEMAND, RecordDistributionStrategy: 7 },
      { Name: 'mystream', StreamModeDetails: ON_DEMAND, RecordDistributionStrategy: 'AUTO' }
    );
    expect(commandsOfType(UpdateStreamRecordDistributionStrategyCommand)).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Leaving the record distribution strategy')
    );
  });

  it('reads an unusable RECORDED strategy as unrecorded and sends the desired one', async () => {
    await provider.update(
      'L',
      'mystream',
      'AWS::Kinesis::Stream',
      { Name: 'mystream', StreamModeDetails: ON_DEMAND, RecordDistributionStrategy: 'AUTO' },
      { Name: 'mystream', StreamModeDetails: ON_DEMAND, RecordDistributionStrategy: null }
    );
    expect(
      commandsOfType(UpdateStreamRecordDistributionStrategyCommand)[0]?.input
        .RecordDistributionStrategy
    ).toBe('AUTO');
  });

  it('reads the strategy back from DescribeStreamSummary when AWS reports one', async () => {
    mockSend.mockImplementation((cmd) => {
      if (cmd instanceof DescribeStreamSummaryCommand) {
        return Promise.resolve({
          StreamDescriptionSummary: { StreamARN: 'arn:summary', RecordDistributionStrategy: 'AUTO' },
        });
      }
      return Promise.resolve({
        StreamDescription: {
          StreamName: 'mystream',
          StreamStatus: 'ACTIVE',
          StreamModeDetails: ON_DEMAND,
        },
      });
    });
    const result = (await provider.readCurrentState(
      'mystream',
      'L',
      'AWS::Kinesis::Stream'
    )) as Record<string, unknown>;
    expect(result['RecordDistributionStrategy']).toBe('AUTO');
  });

  it('emits no strategy key when AWS reports none (a PROVISIONED stream)', async () => {
    mockSend.mockImplementation((cmd) => {
      if (cmd instanceof DescribeStreamSummaryCommand) {
        return Promise.resolve({ StreamDescriptionSummary: { StreamARN: 'arn:summary' } });
      }
      return Promise.resolve({
        StreamDescription: { StreamName: 'mystream', StreamStatus: 'ACTIVE' },
      });
    });
    const result = (await provider.readCurrentState(
      'mystream',
      'L',
      'AWS::Kinesis::Stream'
    )) as Record<string, unknown>;
    expect(result).not.toHaveProperty('RecordDistributionStrategy');
  });
});
