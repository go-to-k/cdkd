import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateEventSourceMappingCommand,
  UpdateEventSourceMappingCommand,
} from '@aws-sdk/client-lambda';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

// Issue #3850: `SelfManagedKafkaEventSourceConfig.ConsumptionMode` goes to
// CreateEventSourceMapping, and UpdateEventSourceMapping refuses a change, so the
// provider never names it on update, refuses a change on the template path and
// warns on a replay.

const { mockSend, mockWarn } = vi.hoisted(() => ({ mockSend: vi.fn(), mockWarn: vi.fn() }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

// Issue #2080: the create call goes through a dedicated `LambdaClient` (one
// whose SDK retry refuses a 5xx); route it to the same mock.
vi.mock('@aws-sdk/client-lambda', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-lambda')>()),
  LambdaClient: vi.fn().mockImplementation(() => ({
    send: (command: unknown) => mockSend(command),
    config: {},
  })),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockWarn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => ({ child: () => childLogger }) };
});

import { LambdaEventSourceMappingProvider } from '../../../src/provisioning/providers/lambda-eventsource-provider.js';

const TYPE = 'AWS::Lambda::EventSourceMapping';
const UUID = 'abcdef12-3456-7890-abcd-ef1234567890';
const REFUSAL = 'SelfManagedKafkaEventSourceConfig.ConsumptionMode cannot be changed';

function kafkaProps(config: Record<string, unknown>): Record<string, unknown> {
  return {
    FunctionName: 'fn',
    SelfManagedEventSource: { Endpoints: { KafkaBootstrapServers: ['broker:9092'] } },
    Topics: ['t'],
    SelfManagedKafkaEventSourceConfig: config,
  };
}

async function captureError(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('LambdaEventSourceMappingProvider — ConsumptionMode (issue #3850)', () => {
  let provider: LambdaEventSourceMappingProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new LambdaEventSourceMappingProvider();
    mockSend.mockResolvedValue({ UUID, EventSourceMappingArn: `arn:esm:${UUID}` });
  });

  it.each(['Stream', 'Queue'])('sends a declared %s on create', async (mode) => {
    await provider.create('Esm', TYPE, kafkaProps({ ConsumerGroupId: 'g', ConsumptionMode: mode }));
    expect(mockWarn).not.toHaveBeenCalled();
    const command = mockSend.mock.calls[0]![0] as CreateEventSourceMappingCommand;
    expect(command).toBeInstanceOf(CreateEventSourceMappingCommand);
    expect(command.input.SelfManagedKafkaEventSourceConfig).toEqual({
      ConsumerGroupId: 'g',
      ConsumptionMode: mode,
    });
  });

  it('reads the mode back from AWS', async () => {
    mockSend.mockResolvedValue({
      UUID,
      SelfManagedEventSource: { Endpoints: { KAFKA_BOOTSTRAP_SERVERS: ['broker:9092'] } },
      SelfManagedKafkaEventSourceConfig: { ConsumerGroupId: 'g', ConsumptionMode: 'Queue' },
    });
    const state = await provider.readCurrentState(UUID, 'Esm', TYPE);
    expect(state).toMatchObject({
      SelfManagedKafkaEventSourceConfig: { ConsumerGroupId: 'g', ConsumptionMode: 'Queue' },
    });
  });

  it.each([
    ['StartingPosition', { StartingPosition: 'TRIM_HORIZON' }],
    ['StartingPositionTimestamp', { StartingPositionTimestamp: 1700000000 }],
    ['MaximumBatchingWindowInSeconds', { MaximumBatchingWindowInSeconds: 0 }],
  ])('replays an old Queue record beside %s without the mode', async (_label, extra) => {
    await provider.create(
      'Esm',
      TYPE,
      { ...kafkaProps({ ConsumerGroupId: 'g', ConsumptionMode: 'Queue' }), ...extra },
      { replayingState: true }
    );
    expect(mockWarn).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0]![0] as CreateEventSourceMappingCommand;
    expect(command.input.SelfManagedKafkaEventSourceConfig).toEqual({ ConsumerGroupId: 'g' });
  });

  it('replays a Stream record beside a StartingPosition as it is', async () => {
    await provider.create(
      'Esm',
      TYPE,
      { ...kafkaProps({ ConsumptionMode: 'Stream' }), StartingPosition: 'TRIM_HORIZON' },
      { replayingState: true }
    );
    expect(mockWarn).not.toHaveBeenCalled();
    const command = mockSend.mock.calls[0]![0] as CreateEventSourceMappingCommand;
    expect(command.input.SelfManagedKafkaEventSourceConfig).toEqual({ ConsumptionMode: 'Stream' });
  });

  it('keeps the mode on a replay of a sendable Queue record, and off the replay path', async () => {
    const sendable = kafkaProps({ ConsumptionMode: 'Queue' });
    await provider.create('Esm', TYPE, sendable, { replayingState: true });
    await provider.create('Esm', TYPE, { ...sendable, StartingPosition: 'TRIM_HORIZON' });
    expect(mockWarn).not.toHaveBeenCalled();
    for (const call of mockSend.mock.calls) {
      const command = call[0] as CreateEventSourceMappingCommand;
      expect(command.input.SelfManagedKafkaEventSourceConfig).toEqual({ ConsumptionMode: 'Queue' });
    }
  });

  describe('canonicalizeDriftPair', () => {
    const oldBaseline = kafkaProps({ ConsumerGroupId: 'g' });
    const live = (mode: string) => kafkaProps({ ConsumerGroupId: 'g', ConsumptionMode: mode });

    it('completes a baseline that predates the member, without mutating it', async () => {
      const aws = live('Stream');
      const result = await provider.canonicalizeDriftPair(TYPE, oldBaseline, aws, oldBaseline);
      expect(result.baseline).toEqual(aws);
      expect(result.aws).toBe(aws);
      expect(oldBaseline['SelfManagedKafkaEventSourceConfig']).toEqual({ ConsumerGroupId: 'g' });
    });

    it.each([
      ['a live Queue', oldBaseline, live('Queue'), oldBaseline],
      ['a template asking for Queue', oldBaseline, live('Stream'), live('Queue')],
      ['a baseline holding the member', live('Stream'), live('Stream'), oldBaseline],
      ['a readback without the member', oldBaseline, oldBaseline, oldBaseline],
      ['a mapping without the block', { FunctionName: 'fn' }, { FunctionName: 'fn' }, {}],
    ])('leaves %s alone', async (_label, baseline, aws, properties) => {
      const result = await provider.canonicalizeDriftPair(TYPE, baseline, aws, properties);
      expect(result.baseline).toBe(baseline);
      expect(result.aws).toBe(aws);
    });
  });

  describe('update', () => {
    it.each([
      ['Stream to Queue', { ConsumptionMode: 'Queue' }, { ConsumptionMode: 'Stream' }],
      ['Queue to Stream', { ConsumptionMode: 'Stream' }, { ConsumptionMode: 'Queue' }],
      ['an omitted mode to Queue', { ConsumptionMode: 'Queue' }, {}],
      ['a removed Queue', {}, { ConsumptionMode: 'Queue' }],
    ])('refuses %s before any AWS call', async (_label, desired, previous) => {
      const error = await captureError(
        provider.update('Esm', UUID, TYPE, kafkaProps(desired), kafkaProps(previous))
      );
      expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
      expect((error as Error).message).toContain(REFUSAL);
      expect((error as Error).message).toContain('--replace');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuses a removed block that held Queue', async () => {
      const { SelfManagedKafkaEventSourceConfig: _block, ...desired } = kafkaProps({});
      const error = await captureError(
        provider.update('Esm', UUID, TYPE, desired, kafkaProps({ ConsumptionMode: 'Queue' }))
      );
      expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it.each([
      ['an unchanged Queue', { ConsumptionMode: 'Queue' }, { ConsumptionMode: 'Queue' }],
      ['an omitted mode made an explicit Stream', { ConsumptionMode: 'Stream' }, {}],
      ['an explicit Stream removed', {}, { ConsumptionMode: 'Stream' }],
    ])('updates %s without naming the member', async (_label, desired, previous) => {
      await provider.update(
        'Esm',
        UUID,
        TYPE,
        { ...kafkaProps(desired), BatchSize: 50 },
        kafkaProps(previous)
      );
      expect(mockWarn).not.toHaveBeenCalled();
      const command = mockSend.mock.calls[0]![0] as UpdateEventSourceMappingCommand;
      expect(command).toBeInstanceOf(UpdateEventSourceMappingCommand);
      expect(JSON.stringify(command.input)).not.toContain('ConsumptionMode');
    });

    it.each([
      ['a rollback state replay', { replayingState: true }],
      ['a drift --revert readback', { desiredFromAwsReadback: true }],
    ])('warns and updates without the member on %s', async (_label, context) => {
      await provider.update(
        'Esm',
        UUID,
        TYPE,
        kafkaProps({ ConsumptionMode: 'Queue' }),
        kafkaProps({}),
        context
      );
      expect(mockWarn).toHaveBeenCalledTimes(1);
      expect(mockWarn.mock.calls[0]![0]).toContain(REFUSAL);
      const command = mockSend.mock.calls[0]![0] as UpdateEventSourceMappingCommand;
      expect(command).toBeInstanceOf(UpdateEventSourceMappingCommand);
      expect(JSON.stringify(command.input)).not.toContain('ConsumptionMode');
    });
  });
});
