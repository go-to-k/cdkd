import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateEventSourceMappingCommand,
  DeleteEventSourceMappingCommand,
  GetEventSourceMappingCommand,
  UpdateEventSourceMappingCommand,
} from '@aws-sdk/client-lambda';
import { isRetryableTransientError } from '../../../src/deployment/retryable-errors.js';

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

  describe('delete — transient in-use teardown lock', () => {
    const UUID = 'abcdef12-3456-7890-abcd-ef1234567890';

    it('wraps the ResourceInUseException "in use" error as a retryable ProvisioningError', async () => {
      // On destroy, DeleteEventSourceMapping can throw while the ESM is
      // briefly locked by its own state transition. The provider does not
      // retry itself — the destroy paths (deploy-engine / destroy-runner)
      // wrap the call in a retry loop and classify the error. Here we
      // assert the wrapped message preserves the "because it is in use"
      // substring so the shared classifier marks it retryable.
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof GetEventSourceMappingCommand) {
          return Promise.resolve({ UUID, State: 'Enabled' });
        }
        if (cmd instanceof DeleteEventSourceMappingCommand) {
          return Promise.reject(
            new Error('Cannot delete the event source mapping because it is in use.')
          );
        }
        return Promise.resolve({});
      });

      let thrown: unknown;
      try {
        await provider.delete('L', UUID, 'AWS::Lambda::EventSourceMapping', undefined, {
          expectedRegion: 'us-east-1',
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(Error);
      const msg = (thrown as Error).message;
      expect(msg).toContain('because it is in use');
      // The wrapped error must classify as retryable so the destroy retry
      // loop backs off and re-attempts within the same run.
      expect(isRetryableTransientError(thrown, msg)).toBe(true);
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

  describe('update — removal-on-UPDATE clear sentinels (issue #976)', () => {
    const UUID = 'abcdef12-3456-7890-abcd-ef1234567890';
    const ARN = 'arn:aws:lambda:us-east-1:123456789012:event-source-mapping:' + UUID;
    const SQS_ARN = 'arn:aws:sqs:us-east-1:123456789012:my-queue';
    const KAFKA_ARN = 'arn:aws:kafka:us-east-1:123456789012:cluster/c/uuid';

    beforeEach(() => {
      // UpdateEventSourceMapping returns the ESM ARN (used for the tag diff);
      // ListTags returns an empty tag set so applyTagDiff is a no-op.
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof UpdateEventSourceMappingCommand) {
          return Promise.resolve({ UUID, EventSourceMappingArn: ARN });
        }
        return Promise.resolve({ Tags: {} });
      });
    });

    function getUpdateInput(): Record<string, unknown> {
      const call = mockSend.mock.calls.find(
        (c) => c[0] instanceof UpdateEventSourceMappingCommand
      );
      return (call?.[0] as { input: Record<string, unknown> }).input;
    }

    it('sends FilterCriteria: {} when FilterCriteria is removed from the template', async () => {
      await provider.update(
        'L',
        UUID,
        'AWS::Lambda::EventSourceMapping',
        { FunctionName: 'fn', EventSourceArn: SQS_ARN, BatchSize: 10 },
        {
          FunctionName: 'fn',
          EventSourceArn: SQS_ARN,
          BatchSize: 5,
          FilterCriteria: { Filters: [{ Pattern: '{"body":["hunt"]}' }] },
        }
      );

      const input = getUpdateInput();
      expect(input['FilterCriteria']).toEqual({});
      expect(input['BatchSize']).toBe(10);
    });

    it('sends ScalingConfig: {} when ScalingConfig is removed from the template', async () => {
      await provider.update(
        'L',
        UUID,
        'AWS::Lambda::EventSourceMapping',
        { FunctionName: 'fn', EventSourceArn: SQS_ARN },
        {
          FunctionName: 'fn',
          EventSourceArn: SQS_ARN,
          ScalingConfig: { MaximumConcurrency: 2 },
        }
      );

      expect(getUpdateInput()['ScalingConfig']).toEqual({});
    });

    it('sends both FilterCriteria: {} and ScalingConfig: {} when both are removed', async () => {
      await provider.update(
        'L',
        UUID,
        'AWS::Lambda::EventSourceMapping',
        { FunctionName: 'fn', EventSourceArn: SQS_ARN, BatchSize: 10 },
        {
          FunctionName: 'fn',
          EventSourceArn: SQS_ARN,
          BatchSize: 5,
          FilterCriteria: { Filters: [{ Pattern: '{"body":["hunt"]}' }] },
          ScalingConfig: { MaximumConcurrency: 2 },
        }
      );

      const input = getUpdateInput();
      expect(input['FilterCriteria']).toEqual({});
      expect(input['ScalingConfig']).toEqual({});
    });

    it('sends DestinationConfig: {} when DestinationConfig is removed', async () => {
      await provider.update(
        'L',
        UUID,
        'AWS::Lambda::EventSourceMapping',
        { FunctionName: 'fn', EventSourceArn: SQS_ARN },
        {
          FunctionName: 'fn',
          EventSourceArn: SQS_ARN,
          DestinationConfig: { OnFailure: { Destination: 'arn:aws:sqs:us-east-1:123:dlq' } },
        }
      );

      expect(getUpdateInput()['DestinationConfig']).toEqual({});
    });

    it('sends MetricsConfig: { Metrics: [] } when MetricsConfig is removed', async () => {
      await provider.update(
        'L',
        UUID,
        'AWS::Lambda::EventSourceMapping',
        { FunctionName: 'fn', EventSourceArn: SQS_ARN },
        {
          FunctionName: 'fn',
          EventSourceArn: SQS_ARN,
          MetricsConfig: { Metrics: ['EventCount'] },
        }
      );

      expect(getUpdateInput()['MetricsConfig']).toEqual({ Metrics: [] });
    });

    it("sends KMSKeyArn: '' when KmsKeyArn is removed", async () => {
      await provider.update(
        'L',
        UUID,
        'AWS::Lambda::EventSourceMapping',
        { FunctionName: 'fn', EventSourceArn: SQS_ARN },
        {
          FunctionName: 'fn',
          EventSourceArn: SQS_ARN,
          KmsKeyArn: 'arn:aws:kms:us-east-1:123:key/abc',
        }
      );

      expect(getUpdateInput()['KMSKeyArn']).toBe('');
    });

    it('restores numeric defaults on removal (retry -1, recordAge -1, parallelization 1, tumbling 0)', async () => {
      await provider.update(
        'L',
        UUID,
        'AWS::Lambda::EventSourceMapping',
        { FunctionName: 'fn', EventSourceArn: 'arn:aws:kinesis:us-east-1:123:stream/s' },
        {
          FunctionName: 'fn',
          EventSourceArn: 'arn:aws:kinesis:us-east-1:123:stream/s',
          MaximumRetryAttempts: 5,
          MaximumRecordAgeInSeconds: 3600,
          ParallelizationFactor: 4,
          TumblingWindowInSeconds: 30,
        }
      );

      const input = getUpdateInput();
      expect(input['MaximumRetryAttempts']).toBe(-1);
      expect(input['MaximumRecordAgeInSeconds']).toBe(-1);
      expect(input['ParallelizationFactor']).toBe(1);
      expect(input['TumblingWindowInSeconds']).toBe(0);
    });

    it('does NOT restore stream-only numeric defaults for an SQS source (AWS rejects them off-stream)', async () => {
      // The numeric restores are Kinesis/DynamoDB-only. If a hand-authored /
      // imported previous template carried one on an SQS mapping and it is
      // removed, cdkd must NOT send the reset value (AWS would reject it).
      await provider.update(
        'L',
        UUID,
        'AWS::Lambda::EventSourceMapping',
        { FunctionName: 'fn', EventSourceArn: SQS_ARN },
        {
          FunctionName: 'fn',
          EventSourceArn: SQS_ARN,
          MaximumRetryAttempts: 5,
          MaximumRecordAgeInSeconds: 3600,
          ParallelizationFactor: 4,
          TumblingWindowInSeconds: 30,
        }
      );

      const input = getUpdateInput();
      expect(input['MaximumRetryAttempts']).toBeUndefined();
      expect(input['MaximumRecordAgeInSeconds']).toBeUndefined();
      expect(input['ParallelizationFactor']).toBeUndefined();
      expect(input['TumblingWindowInSeconds']).toBeUndefined();
    });

    it('clears FunctionResponseTypes to [] on removal for an SQS source (kind allows it)', async () => {
      await provider.update(
        'L',
        UUID,
        'AWS::Lambda::EventSourceMapping',
        { FunctionName: 'fn', EventSourceArn: SQS_ARN },
        {
          FunctionName: 'fn',
          EventSourceArn: SQS_ARN,
          FunctionResponseTypes: ['ReportBatchItemFailures'],
        }
      );

      expect(getUpdateInput()['FunctionResponseTypes']).toEqual([]);
    });

    it('does NOT clear FunctionResponseTypes for a Kafka source (kind rejects [])', async () => {
      await provider.update(
        'L',
        UUID,
        'AWS::Lambda::EventSourceMapping',
        { FunctionName: 'fn', EventSourceArn: KAFKA_ARN },
        {
          FunctionName: 'fn',
          EventSourceArn: KAFKA_ARN,
          FunctionResponseTypes: ['ReportBatchItemFailures'],
        }
      );

      expect(getUpdateInput()['FunctionResponseTypes']).toBeUndefined();
    });

    it('clears SourceAccessConfigurations to [] on removal for a Kafka source', async () => {
      await provider.update(
        'L',
        UUID,
        'AWS::Lambda::EventSourceMapping',
        { FunctionName: 'fn', EventSourceArn: KAFKA_ARN },
        {
          FunctionName: 'fn',
          EventSourceArn: KAFKA_ARN,
          SourceAccessConfigurations: [{ Type: 'BASIC_AUTH', URI: 'arn:aws:secretsmanager:...' }],
        }
      );

      expect(getUpdateInput()['SourceAccessConfigurations']).toEqual([]);
    });

    it('does NOT clear SourceAccessConfigurations for an SQS source (kind rejects [])', async () => {
      await provider.update(
        'L',
        UUID,
        'AWS::Lambda::EventSourceMapping',
        { FunctionName: 'fn', EventSourceArn: SQS_ARN },
        {
          FunctionName: 'fn',
          EventSourceArn: SQS_ARN,
          SourceAccessConfigurations: [{ Type: 'BASIC_AUTH', URI: 'arn:aws:secretsmanager:...' }],
        }
      );

      expect(getUpdateInput()['SourceAccessConfigurations']).toBeUndefined();
    });

    it('restores MaximumBatchingWindowInSeconds to 0 on removal for an SQS source', async () => {
      await provider.update(
        'L',
        UUID,
        'AWS::Lambda::EventSourceMapping',
        { FunctionName: 'fn', EventSourceArn: SQS_ARN },
        {
          FunctionName: 'fn',
          EventSourceArn: SQS_ARN,
          MaximumBatchingWindowInSeconds: 20,
        }
      );

      expect(getUpdateInput()['MaximumBatchingWindowInSeconds']).toBe(0);
    });

    it('does NOT restore MaximumBatchingWindowInSeconds for a Kafka source (500ms default unrepresentable)', async () => {
      await provider.update(
        'L',
        UUID,
        'AWS::Lambda::EventSourceMapping',
        { FunctionName: 'fn', EventSourceArn: KAFKA_ARN },
        {
          FunctionName: 'fn',
          EventSourceArn: KAFKA_ARN,
          MaximumBatchingWindowInSeconds: 20,
        }
      );

      expect(getUpdateInput()['MaximumBatchingWindowInSeconds']).toBeUndefined();
    });

    it('does NOT clear LoggingConfig / ProvisionedPollerConfig / BatchSize on removal (no documented sentinel)', async () => {
      await provider.update(
        'L',
        UUID,
        'AWS::Lambda::EventSourceMapping',
        { FunctionName: 'fn', EventSourceArn: SQS_ARN },
        {
          FunctionName: 'fn',
          EventSourceArn: SQS_ARN,
          BatchSize: 10,
          LoggingConfig: { Level: 'INFO' },
          ProvisionedPollerConfig: { MinimumPollers: 1, MaximumPollers: 5 },
        }
      );

      const input = getUpdateInput();
      expect(input['LoggingConfig']).toBeUndefined();
      expect(input['ProvisionedPollerConfig']).toBeUndefined();
      expect(input['BatchSize']).toBeUndefined();
    });

    it('does NOT send any clear sentinel when the property is unchanged (still present)', async () => {
      await provider.update(
        'L',
        UUID,
        'AWS::Lambda::EventSourceMapping',
        {
          FunctionName: 'fn',
          EventSourceArn: SQS_ARN,
          FilterCriteria: { Filters: [{ Pattern: '{"body":["hunt"]}' }] },
          ScalingConfig: { MaximumConcurrency: 2 },
        },
        {
          FunctionName: 'fn',
          EventSourceArn: SQS_ARN,
          FilterCriteria: { Filters: [{ Pattern: '{"body":["hunt"]}' }] },
          ScalingConfig: { MaximumConcurrency: 2 },
        }
      );

      const input = getUpdateInput();
      // Present-in-both: the existing set-when-present guards forward the new
      // value verbatim; the removal path must NOT overwrite it with a sentinel.
      expect(input['FilterCriteria']).toEqual({ Filters: [{ Pattern: '{"body":["hunt"]}' }] });
      expect(input['ScalingConfig']).toEqual({ MaximumConcurrency: 2 });
    });

    it('does NOT send a clear sentinel when the property was never set (absent in both)', async () => {
      await provider.update(
        'L',
        UUID,
        'AWS::Lambda::EventSourceMapping',
        { FunctionName: 'fn', EventSourceArn: SQS_ARN, BatchSize: 10 },
        { FunctionName: 'fn', EventSourceArn: SQS_ARN, BatchSize: 5 }
      );

      const input = getUpdateInput();
      expect(input['FilterCriteria']).toBeUndefined();
      expect(input['ScalingConfig']).toBeUndefined();
      expect(input['DestinationConfig']).toBeUndefined();
      expect(input['MetricsConfig']).toBeUndefined();
      expect(input['KMSKeyArn']).toBeUndefined();
      expect(input['MaximumRetryAttempts']).toBeUndefined();
    });
  });
});
