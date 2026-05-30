import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  GetEventSourceMappingCommand,
  ListTagsCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-lambda';

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

describe('LambdaEventSourceMappingProvider.readCurrentState', () => {
  let provider: LambdaEventSourceMappingProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new LambdaEventSourceMappingProvider();
  });

  it('returns CFn-shaped properties (happy path, Enabled derived from State)', async () => {
    mockSend.mockResolvedValueOnce({
      UUID: 'abc-123',
      FunctionArn: 'arn:aws:lambda:us-east-1:123:function:fn',
      EventSourceArn: 'arn:aws:sqs:us-east-1:123:my-queue',
      EventSourceMappingArn: 'arn:aws:lambda:us-east-1:123:event-source-mapping:abc-123',
      BatchSize: 10,
      MaximumBatchingWindowInSeconds: 5,
      MaximumRetryAttempts: 3,
      State: 'Enabled',
      StateTransitionReason: 'USER_INITIATED', // AWS-managed, not surfaced
      LastModified: new Date(0),
    });
    // ListTags — no user tags
    mockSend.mockResolvedValueOnce({ Tags: {} });

    const result = await provider.readCurrentState(
      'abc-123',
      'Logical',
      'AWS::Lambda::EventSourceMapping'
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetEventSourceMappingCommand);
    expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(ListTagsCommand);
    // SQS source supports FunctionResponseTypes but not
    // SourceAccessConfigurations — the placeholder is type-discriminator-
    // gated so a `cdkd drift --revert` round-trip cannot push a
    // `SourceAccessConfigurations: []` to AWS (which would be rejected).
    expect(result).toEqual({
      FunctionName: 'arn:aws:lambda:us-east-1:123:function:fn',
      EventSourceArn: 'arn:aws:sqs:us-east-1:123:my-queue',
      BatchSize: 10,
      MaximumBatchingWindowInSeconds: 5,
      MaximumRetryAttempts: 3,
      Enabled: true,
      FunctionResponseTypes: [],
      Tags: [],
    });
  });

  it('surfaces FunctionName as bare name when state holds the bare name and ARN tail matches', async () => {
    mockSend.mockResolvedValueOnce({
      UUID: 'abc-123',
      FunctionArn: 'arn:aws:lambda:us-east-1:123:function:my-fn',
      EventSourceArn: 'arn:aws:sqs:us-east-1:123:my-queue',
      EventSourceMappingArn: 'arn:aws:lambda:us-east-1:123:event-source-mapping:abc-123',
      State: 'Enabled',
    });
    mockSend.mockResolvedValueOnce({ Tags: {} });

    const result = await provider.readCurrentState(
      'abc-123',
      'Logical',
      'AWS::Lambda::EventSourceMapping',
      { FunctionName: 'my-fn' }
    );

    // State carried the bare name; the ARN tail matches; surface the
    // bare-name shape so the comparator sees no drift.
    expect(result?.['FunctionName']).toBe('my-fn');
  });

  it('surfaces FunctionName as ARN when state holds the ARN form', async () => {
    mockSend.mockResolvedValueOnce({
      UUID: 'abc-123',
      FunctionArn: 'arn:aws:lambda:us-east-1:123:function:my-fn',
      EventSourceArn: 'arn:aws:sqs:us-east-1:123:my-queue',
      EventSourceMappingArn: 'arn:aws:lambda:us-east-1:123:event-source-mapping:abc-123',
      State: 'Enabled',
    });
    mockSend.mockResolvedValueOnce({ Tags: {} });

    const result = await provider.readCurrentState(
      'abc-123',
      'Logical',
      'AWS::Lambda::EventSourceMapping',
      { FunctionName: 'arn:aws:lambda:us-east-1:123:function:my-fn' }
    );

    expect(result?.['FunctionName']).toBe('arn:aws:lambda:us-east-1:123:function:my-fn');
  });

  it('surfaces Tags from ListTags with aws:* filtered out', async () => {
    mockSend.mockResolvedValueOnce({
      FunctionArn: 'arn:aws:lambda:us-east-1:123:function:fn',
      EventSourceArn: 'arn:aws:sqs:us-east-1:123:my-queue',
      EventSourceMappingArn: 'arn:aws:lambda:us-east-1:123:event-source-mapping:abc-123',
      State: 'Enabled',
    });
    mockSend.mockResolvedValueOnce({
      Tags: { Foo: 'Bar', 'aws:cdk:path': 'MyStack/MyMapping' },
    });

    const result = await provider.readCurrentState(
      'abc-123',
      'Logical',
      'AWS::Lambda::EventSourceMapping'
    );
    expect(result?.['Tags']).toEqual([{ Key: 'Foo', Value: 'Bar' }]);
  });

  it('marks Enabled=false when State is Disabled', async () => {
    mockSend.mockResolvedValueOnce({
      FunctionArn: 'arn:aws:lambda:us-east-1:123:function:fn',
      EventSourceArn: 'arn:aws:sqs:us-east-1:123:my-queue',
      State: 'Disabled',
    });

    const result = await provider.readCurrentState(
      'abc-123',
      'Logical',
      'AWS::Lambda::EventSourceMapping'
    );
    expect(result?.['Enabled']).toBe(false);
  });

  it('returns undefined when mapping gone', async () => {
    mockSend.mockRejectedValueOnce(
      new ResourceNotFoundException({ message: 'gone', $metadata: {} })
    );

    const result = await provider.readCurrentState(
      'abc-123',
      'Logical',
      'AWS::Lambda::EventSourceMapping'
    );
    expect(result).toBeUndefined();
  });

  describe('#609 backfill: 7 readback branches', () => {
    it('emits KmsKeyArn from SDK KMSKeyArn (casing flip back; emit-when-present)', async () => {
      // SDK returns `KMSKeyArn`; CFn state holds `KmsKeyArn`. The
      // readback must flip the casing back or drift would surface as
      // a phantom KmsKeyArn vs KMSKeyArn mismatch on every run.
      mockSend.mockResolvedValueOnce({
        UUID: 'abc-123',
        FunctionArn: 'arn:aws:lambda:us-east-1:123:function:fn',
        EventSourceArn: 'arn:aws:sqs:us-east-1:123:q',
        EventSourceMappingArn: 'arn:aws:lambda:us-east-1:123:event-source-mapping:abc-123',
        State: 'Enabled',
        KMSKeyArn: 'arn:aws:kms:us-east-1:123:key/abc',
      });
      mockSend.mockResolvedValueOnce({ Tags: {} });

      const result = await provider.readCurrentState(
        'abc-123',
        'L',
        'AWS::Lambda::EventSourceMapping'
      );
      expect(result?.['KmsKeyArn']).toBe('arn:aws:kms:us-east-1:123:key/abc');
      // SDK-cased key MUST NOT leak through.
      expect(result?.['KMSKeyArn']).toBeUndefined();
    });

    it('omits KmsKeyArn when AWS returns no KMSKeyArn (omit-when-absent; no phantom drift)', async () => {
      // The typical ESM uses AWS-owned encryption (no customer key);
      // AWS returns no KMSKeyArn field. An emit-as-empty-string here
      // would force guaranteed drift on every clean run.
      mockSend.mockResolvedValueOnce({
        UUID: 'abc-123',
        FunctionArn: 'arn:aws:lambda:us-east-1:123:function:fn',
        EventSourceArn: 'arn:aws:sqs:us-east-1:123:q',
        EventSourceMappingArn: 'arn:aws:lambda:us-east-1:123:event-source-mapping:abc-123',
        State: 'Enabled',
      });
      mockSend.mockResolvedValueOnce({ Tags: {} });

      const result = await provider.readCurrentState(
        'abc-123',
        'L',
        'AWS::Lambda::EventSourceMapping'
      );
      expect(result).toBeDefined();
      expect('KmsKeyArn' in (result ?? {})).toBe(false);
    });

    it('emits LoggingConfig / MetricsConfig / ProvisionedPollerConfig as-is when present', async () => {
      const loggingConfig = { Level: 'INFO', LogGroup: 'lg', Destination: { Schema: 'JSON' } };
      const metricsConfig = { Metrics: ['EventCount'] };
      const provisionedPollerConfig = { MinimumPollers: 1, MaximumPollers: 5 };
      mockSend.mockResolvedValueOnce({
        UUID: 'abc-123',
        FunctionArn: 'arn:aws:lambda:us-east-1:123:function:fn',
        EventSourceArn: 'arn:aws:sqs:us-east-1:123:q',
        EventSourceMappingArn: 'arn:aws:lambda:us-east-1:123:event-source-mapping:abc-123',
        State: 'Enabled',
        LoggingConfig: loggingConfig,
        MetricsConfig: metricsConfig,
        ProvisionedPollerConfig: provisionedPollerConfig,
      });
      mockSend.mockResolvedValueOnce({ Tags: {} });

      const result = await provider.readCurrentState(
        'abc-123',
        'L',
        'AWS::Lambda::EventSourceMapping'
      );
      expect(result?.['LoggingConfig']).toEqual(loggingConfig);
      expect(result?.['MetricsConfig']).toEqual(metricsConfig);
      expect(result?.['ProvisionedPollerConfig']).toEqual(provisionedPollerConfig);
    });

    it('emits Queues / Topics as cloned arrays when present', async () => {
      // The spread `[...resp.Queues]` defends against AWS SDK returning
      // the same reference twice (would couple cdkd state to the SDK's
      // response object). A direct === assertion would catch a future
      // refactor that drops the clone.
      const queues = ['q-a', 'q-b'];
      const topics = ['t-a'];
      mockSend.mockResolvedValueOnce({
        UUID: 'abc-123',
        FunctionArn: 'arn:aws:lambda:us-east-1:123:function:fn',
        EventSourceMappingArn: 'arn:aws:lambda:us-east-1:123:event-source-mapping:abc-123',
        State: 'Enabled',
        SelfManagedEventSource: { Endpoints: { KAFKA_BOOTSTRAP_SERVERS: ['b:9092'] } },
        Queues: queues,
        Topics: topics,
      });
      mockSend.mockResolvedValueOnce({ Tags: {} });

      const result = await provider.readCurrentState(
        'abc-123',
        'L',
        'AWS::Lambda::EventSourceMapping'
      );
      expect(result?.['Queues']).toEqual(['q-a', 'q-b']);
      expect(result?.['Queues']).not.toBe(queues);
      expect(result?.['Topics']).toEqual(['t-a']);
      expect(result?.['Topics']).not.toBe(topics);
    });

    it('converts StartingPositionTimestamp Date → epoch seconds (matches CFn shape)', async () => {
      // AWS returns Date; CFn template supplies (and state stores) the
      // epoch-seconds number per AWS::Lambda::EventSourceMapping schema.
      // The conversion lets the drift comparator see the same shape on
      // both sides — without it, every read would surface phantom drift.
      const epochSeconds = 1717000000;
      mockSend.mockResolvedValueOnce({
        UUID: 'abc-123',
        FunctionArn: 'arn:aws:lambda:us-east-1:123:function:fn',
        EventSourceArn: 'arn:aws:kinesis:us-east-1:123:stream/s',
        EventSourceMappingArn: 'arn:aws:lambda:us-east-1:123:event-source-mapping:abc-123',
        State: 'Enabled',
        StartingPosition: 'AT_TIMESTAMP',
        StartingPositionTimestamp: new Date(epochSeconds * 1000),
      });
      mockSend.mockResolvedValueOnce({ Tags: {} });

      const result = await provider.readCurrentState(
        'abc-123',
        'L',
        'AWS::Lambda::EventSourceMapping'
      );
      expect(result?.['StartingPositionTimestamp']).toBe(epochSeconds);
    });

    it('omits all 7 new props when AWS returns none of them (clean omit-when-absent)', async () => {
      mockSend.mockResolvedValueOnce({
        UUID: 'abc-123',
        FunctionArn: 'arn:aws:lambda:us-east-1:123:function:fn',
        EventSourceArn: 'arn:aws:sqs:us-east-1:123:q',
        EventSourceMappingArn: 'arn:aws:lambda:us-east-1:123:event-source-mapping:abc-123',
        State: 'Enabled',
      });
      mockSend.mockResolvedValueOnce({ Tags: {} });

      const result = await provider.readCurrentState(
        'abc-123',
        'L',
        'AWS::Lambda::EventSourceMapping'
      );
      const r = result ?? {};
      for (const k of [
        'KmsKeyArn',
        'LoggingConfig',
        'MetricsConfig',
        'ProvisionedPollerConfig',
        'Queues',
        'Topics',
        'StartingPositionTimestamp',
      ]) {
        expect(k in r).toBe(false);
      }
    });
  });
});
