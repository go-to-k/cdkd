import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { CreateEventSourceMappingCommand } from '@aws-sdk/client-lambda';

// Mock AWS clients before importing the provider
const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

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

import { LambdaEventSourceMappingProvider } from '../../../src/provisioning/providers/lambda-eventsource-provider.js';

describe('LambdaEventSourceMappingProvider', () => {
  let provider: LambdaEventSourceMappingProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new LambdaEventSourceMappingProvider();
  });

  describe('import (explicit-override only)', () => {
    function makeInput(overrides: Partial<{ knownPhysicalId: string }> = {}) {
      return {
        logicalId: 'MyMapping',
        resourceType: 'AWS::Lambda::EventSourceMapping',
        cdkPath: 'MyStack/MyMapping',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {
          FunctionName: 'my-function',
          EventSourceArn: 'arn:aws:sqs:us-east-1:123456789012:my-queue',
        },
        ...overrides,
      };
    }

    it('returns physicalId when knownPhysicalId is supplied (no AWS calls)', async () => {
      const uuid = 'abcdef12-3456-7890-abcd-ef1234567890';
      const result = await provider.import(makeInput({ knownPhysicalId: uuid }));

      expect(result).toEqual({ physicalId: uuid, attributes: { Id: uuid } });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns null when knownPhysicalId is not supplied (no auto lookup)', async () => {
      const result = await provider.import(makeInput());

      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('create — #609 backfill: 7 new props', () => {
    const UUID = 'abcdef12-3456-7890-abcd-ef1234567890';

    beforeEach(() => {
      // CreateEventSourceMapping returns the new mapping's UUID
      mockSend.mockResolvedValue({ UUID });
    });

    function getCreateInput(): Record<string, unknown> {
      const call = mockSend.mock.calls.find(
        (c) => c[0] instanceof CreateEventSourceMappingCommand
      );
      return (call?.[0] as { input: Record<string, unknown> }).input;
    }

    it('CFn KmsKeyArn → SDK KMSKeyArn (casing flip)', async () => {
      // CFn schema says `KmsKeyArn` (lower-case `ms`); the SDK input
      // shape is `KMSKeyArn` (upper-case `MS`). A missed casing flip
      // would silently drop the property — exactly what #609 closes.
      const arn = 'arn:aws:kms:us-east-1:123456789012:key/abc-123';
      await provider.create('L', 'AWS::Lambda::EventSourceMapping', {
        FunctionName: 'fn',
        EventSourceArn: 'arn:aws:sqs:us-east-1:123:q',
        KmsKeyArn: arn,
      });

      const input = getCreateInput();
      expect(input['KMSKeyArn']).toBe(arn);
      // CFn-cased key MUST NOT leak through to the SDK call.
      expect(input['KmsKeyArn']).toBeUndefined();
    });

    it('forwards LoggingConfig / MetricsConfig / ProvisionedPollerConfig as-is', async () => {
      const loggingConfig = { Level: 'INFO', LogGroup: 'lg', Destination: { Schema: 'JSON' } };
      const metricsConfig = { Metrics: ['EventCount'] };
      const provisionedPollerConfig = { MinimumPollers: 1, MaximumPollers: 5 };

      await provider.create('L', 'AWS::Lambda::EventSourceMapping', {
        FunctionName: 'fn',
        EventSourceArn: 'arn:aws:sqs:us-east-1:123:q',
        LoggingConfig: loggingConfig,
        MetricsConfig: metricsConfig,
        ProvisionedPollerConfig: provisionedPollerConfig,
      });

      const input = getCreateInput();
      expect(input['LoggingConfig']).toBe(loggingConfig);
      expect(input['MetricsConfig']).toBe(metricsConfig);
      expect(input['ProvisionedPollerConfig']).toBe(provisionedPollerConfig);
    });

    it('forwards Queues (self-managed source target list)', async () => {
      await provider.create('L', 'AWS::Lambda::EventSourceMapping', {
        FunctionName: 'fn',
        SelfManagedEventSource: { Endpoints: { KAFKA_BOOTSTRAP_SERVERS: ['b.example:9092'] } },
        Queues: ['queue-a', 'queue-b'],
      });

      const input = getCreateInput();
      expect(input['Queues']).toEqual(['queue-a', 'queue-b']);
    });

    it('forwards Topics (self-managed Kafka topic list)', async () => {
      await provider.create('L', 'AWS::Lambda::EventSourceMapping', {
        FunctionName: 'fn',
        SelfManagedEventSource: { Endpoints: { KAFKA_BOOTSTRAP_SERVERS: ['b.example:9092'] } },
        Topics: ['topic-a'],
      });

      const input = getCreateInput();
      expect(input['Topics']).toEqual(['topic-a']);
    });

    it('coerces StartingPositionTimestamp number (epoch seconds) → Date', async () => {
      // CFn schema says `Number` for the field; the AWS::Lambda::EventSourceMapping
      // CFn docs phrase it as a Unix epoch in seconds. SDK expects a `Date`.
      const epochSeconds = 1717000000; // 2024-05-29T18:13:20Z
      await provider.create('L', 'AWS::Lambda::EventSourceMapping', {
        FunctionName: 'fn',
        EventSourceArn: 'arn:aws:kinesis:us-east-1:123:stream/s',
        StartingPosition: 'AT_TIMESTAMP',
        StartingPositionTimestamp: epochSeconds,
      });

      const input = getCreateInput() as { StartingPositionTimestamp: Date };
      expect(input.StartingPositionTimestamp).toBeInstanceOf(Date);
      expect(input.StartingPositionTimestamp.getTime()).toBe(epochSeconds * 1000);
    });

    it('coerces StartingPositionTimestamp ISO string → Date (defensive)', async () => {
      await provider.create('L', 'AWS::Lambda::EventSourceMapping', {
        FunctionName: 'fn',
        EventSourceArn: 'arn:aws:kinesis:us-east-1:123:stream/s',
        StartingPosition: 'AT_TIMESTAMP',
        StartingPositionTimestamp: '2024-05-29T18:13:20.000Z',
      });

      const input = getCreateInput() as { StartingPositionTimestamp: Date };
      expect(input.StartingPositionTimestamp).toBeInstanceOf(Date);
      expect(input.StartingPositionTimestamp.toISOString()).toBe('2024-05-29T18:13:20.000Z');
    });

    it('passes a Date through StartingPositionTimestamp unchanged', async () => {
      const d = new Date('2024-05-29T18:13:20.000Z');
      await provider.create('L', 'AWS::Lambda::EventSourceMapping', {
        FunctionName: 'fn',
        EventSourceArn: 'arn:aws:kinesis:us-east-1:123:stream/s',
        StartingPosition: 'AT_TIMESTAMP',
        StartingPositionTimestamp: d,
      });

      const input = getCreateInput() as { StartingPositionTimestamp: Date };
      expect(input.StartingPositionTimestamp).toBe(d);
    });

    it('omits all 7 props from the SDK input when absent (no defaults leaked)', async () => {
      await provider.create('L', 'AWS::Lambda::EventSourceMapping', {
        FunctionName: 'fn',
        EventSourceArn: 'arn:aws:sqs:us-east-1:123:q',
      });

      const input = getCreateInput();
      // Guards against any "always emit default" regression.
      expect(input['KMSKeyArn']).toBeUndefined();
      expect(input['LoggingConfig']).toBeUndefined();
      expect(input['MetricsConfig']).toBeUndefined();
      expect(input['ProvisionedPollerConfig']).toBeUndefined();
      expect(input['Queues']).toBeUndefined();
      expect(input['Topics']).toBeUndefined();
      expect(input['StartingPositionTimestamp']).toBeUndefined();
    });
  });
});
