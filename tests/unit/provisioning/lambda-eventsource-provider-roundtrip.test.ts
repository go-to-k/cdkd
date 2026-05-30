import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { UpdateEventSourceMappingCommand } from '@aws-sdk/client-lambda';

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

const UUID = 'abcdef12-3456-7890-abcd-ef1234567890';

describe('LambdaEventSourceMappingProvider read-update round-trip', () => {
  let provider: LambdaEventSourceMappingProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new LambdaEventSourceMappingProvider();
    // UpdateEventSourceMappingCommand returns the mapping ARN — keep
    // the mock generic so the tag-diff branch in update() is satisfied.
    mockSend.mockResolvedValue({
      EventSourceMappingArn: `arn:aws:lambda:us-east-1:123:event-source-mapping:${UUID}`,
    });
  });

  it('Class 1 — SQS source round-trip does NOT push SourceAccessConfigurations to AWS', async () => {
    // Mechanical guard for Class 1 placeholder regression on SQS sources.
    // SourceAccessConfigurations is only valid for Kafka / MQ / DocumentDB —
    // pushing `[]` against an SQS source is rejected by
    // UpdateEventSourceMappingCommand. The Class 1 guard kicks in at
    // readCurrentState (not emitted on SQS) so the field never reaches
    // update().
    const observed = {
      FunctionName: 'arn:aws:lambda:us-east-1:123:function:fn',
      EventSourceArn: 'arn:aws:sqs:us-east-1:123:my-queue',
      BatchSize: 10,
      Enabled: true,
      FunctionResponseTypes: [] as string[],
      // SourceAccessConfigurations intentionally absent (Class-1 guarded out)
    };

    await provider.update('L', UUID, 'AWS::Lambda::EventSourceMapping', observed, observed);

    const updateCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof UpdateEventSourceMappingCommand
    );
    expect(updateCall).toBeDefined();
    const input = updateCall?.[0].input as { SourceAccessConfigurations?: unknown };
    expect(input.SourceAccessConfigurations).toBeUndefined();
  });

  it('Class 1 — Kafka source round-trip does NOT push FunctionResponseTypes to AWS', async () => {
    // FunctionResponseTypes is only valid for SQS / Kinesis / DynamoDB
    // (the sources where ReportBatchItemFailures applies). Pushing `[]`
    // against a Kafka source is rejected.
    const observed = {
      FunctionName: 'arn:aws:lambda:us-east-1:123:function:fn',
      EventSourceArn: 'arn:aws:kafka:us-east-1:123:cluster/my-cluster/abc',
      BatchSize: 100,
      Enabled: true,
      SourceAccessConfigurations: [] as Array<{ Type?: string; URI?: string }>,
      // FunctionResponseTypes intentionally absent (Class-1 guarded out)
    };

    await provider.update('L', UUID, 'AWS::Lambda::EventSourceMapping', observed, observed);

    const updateCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof UpdateEventSourceMappingCommand
    );
    expect(updateCall).toBeDefined();
    const input = updateCall?.[0].input as { FunctionResponseTypes?: unknown };
    expect(input.FunctionResponseTypes).toBeUndefined();
  });

  it('Kinesis source round-trip preserves StartingPosition / ParallelizationFactor without rejection', async () => {
    // Kinesis-specific fields are populated and survive the round-trip
    // — the truthy-gate fix ensures `0`-valued fields like
    // TumblingWindowInSeconds (used to disable) reach AWS.
    const observed = {
      FunctionName: 'arn:aws:lambda:us-east-1:123:function:fn',
      EventSourceArn: 'arn:aws:kinesis:us-east-1:123:stream/my-stream',
      BatchSize: 50,
      StartingPosition: 'LATEST',
      ParallelizationFactor: 2,
      MaximumRecordAgeInSeconds: -1, // infinite — falsy under truthy-gate, must reach AWS
      TumblingWindowInSeconds: 0, // disabled — falsy under truthy-gate, must reach AWS
      MaximumBatchingWindowInSeconds: 0, // disabled — falsy under truthy-gate
      Enabled: true,
      FunctionResponseTypes: [] as string[],
    };

    await provider.update('L', UUID, 'AWS::Lambda::EventSourceMapping', observed, observed);

    const updateCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof UpdateEventSourceMappingCommand
    );
    expect(updateCall).toBeDefined();
    const input = updateCall?.[0].input as {
      ParallelizationFactor?: number;
      MaximumRecordAgeInSeconds?: number;
      TumblingWindowInSeconds?: number;
      MaximumBatchingWindowInSeconds?: number;
      SourceAccessConfigurations?: unknown;
    };
    expect(input.ParallelizationFactor).toBe(2);
    // Falsy-but-meaningful values must reach AWS — this is the truthy-gate fix.
    expect(input.MaximumRecordAgeInSeconds).toBe(-1);
    expect(input.TumblingWindowInSeconds).toBe(0);
    expect(input.MaximumBatchingWindowInSeconds).toBe(0);
    // Class-1 guard: Kinesis does not get SourceAccessConfigurations.
    expect(input.SourceAccessConfigurations).toBeUndefined();
  });

  it('round-trip on no-drift snapshot does not push placeholder arrays of the wrong source kind', async () => {
    // Stronger assertion: state == AWS implies update() must not push
    // anything that would round-trip-reject. The Class-1 guard keeps
    // wrong-kind placeholders from ever entering state, so this is the
    // structural guard for the next change to readCurrentState/update.
    const observed = {
      FunctionName: 'arn:aws:lambda:us-east-1:123:function:fn',
      EventSourceArn: 'arn:aws:dynamodb:us-east-1:123:table/my-table/stream/2024',
      BatchSize: 100,
      StartingPosition: 'TRIM_HORIZON',
      Enabled: true,
      FunctionResponseTypes: [] as string[],
      // No SourceAccessConfigurations — DynamoDB Streams doesn't support it.
    };

    await provider.update('L', UUID, 'AWS::Lambda::EventSourceMapping', observed, observed);

    const updateCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof UpdateEventSourceMappingCommand
    );
    expect(updateCall).toBeDefined();
    const input = updateCall?.[0].input as Record<string, unknown>;
    expect(input.SourceAccessConfigurations).toBeUndefined();
  });

  describe('#609 backfill: 4 mutable props on update', () => {
    function getUpdateInput(): Record<string, unknown> {
      const call = mockSend.mock.calls.find(
        (c) => c[0] instanceof UpdateEventSourceMappingCommand
      );
      return (call?.[0] as { input: Record<string, unknown> }).input;
    }

    it('CFn KmsKeyArn → SDK KMSKeyArn (casing flip mirrors create)', async () => {
      const arn = 'arn:aws:kms:us-east-1:123:key/abc';
      await provider.update(
        'L',
        UUID,
        'AWS::Lambda::EventSourceMapping',
        {
          FunctionName: 'fn',
          EventSourceArn: 'arn:aws:sqs:us-east-1:123:q',
          KmsKeyArn: arn,
        },
        {
          FunctionName: 'fn',
          EventSourceArn: 'arn:aws:sqs:us-east-1:123:q',
        }
      );

      const input = getUpdateInput();
      expect(input['KMSKeyArn']).toBe(arn);
      expect(input['KmsKeyArn']).toBeUndefined();
    });

    it('empty-string KmsKeyArn → SDK KMSKeyArn=\'\' (Lambda-documented clear sentinel)', async () => {
      // Use `!== undefined` so an explicit `''` reaches AWS as the
      // clear-back-to-AWS-owned-key sentinel rather than being silently
      // dropped by a truthy gate.
      await provider.update(
        'L',
        UUID,
        'AWS::Lambda::EventSourceMapping',
        {
          FunctionName: 'fn',
          EventSourceArn: 'arn:aws:sqs:us-east-1:123:q',
          KmsKeyArn: '',
        },
        {
          FunctionName: 'fn',
          EventSourceArn: 'arn:aws:sqs:us-east-1:123:q',
          KmsKeyArn: 'arn:aws:kms:us-east-1:123:key/old',
        }
      );

      const input = getUpdateInput();
      expect(input['KMSKeyArn']).toBe('');
    });

    it('forwards LoggingConfig / MetricsConfig / ProvisionedPollerConfig to UpdateEventSourceMapping', async () => {
      const loggingConfig = { Level: 'DEBUG', LogGroup: 'lg' };
      const metricsConfig = { Metrics: ['EventCount'] };
      const provisionedPollerConfig = { MinimumPollers: 2, MaximumPollers: 8 };

      await provider.update(
        'L',
        UUID,
        'AWS::Lambda::EventSourceMapping',
        {
          FunctionName: 'fn',
          EventSourceArn: 'arn:aws:sqs:us-east-1:123:q',
          LoggingConfig: loggingConfig,
          MetricsConfig: metricsConfig,
          ProvisionedPollerConfig: provisionedPollerConfig,
        },
        {
          FunctionName: 'fn',
          EventSourceArn: 'arn:aws:sqs:us-east-1:123:q',
        }
      );

      const input = getUpdateInput();
      expect(input['LoggingConfig']).toBe(loggingConfig);
      expect(input['MetricsConfig']).toBe(metricsConfig);
      expect(input['ProvisionedPollerConfig']).toBe(provisionedPollerConfig);
    });
  });

  describe('#609 backfill: 3 create-only props are silently omitted on update', () => {
    function getUpdateInput(): Record<string, unknown> {
      const call = mockSend.mock.calls.find(
        (c) => c[0] instanceof UpdateEventSourceMappingCommand
      );
      return (call?.[0] as { input: Record<string, unknown> }).input;
    }

    it('omits Queues / Topics / StartingPositionTimestamp from UpdateEventSourceMapping', async () => {
      // These 3 props are absent from `UpdateEventSourceMappingRequest`
      // (confirmed against `@aws-sdk/client-lambda` 3.x type defs). AWS
      // would reject a forwarded value with `ValidationException`; CFn
      // semantics treat a template change to these as a replace, which
      // cdkd's diff layer schedules independently of update(). The
      // provider's update() must NOT forward them even when present in
      // properties — this test guards against a future copy-paste
      // regression that wires them into the update input shape.
      await provider.update(
        'L',
        UUID,
        'AWS::Lambda::EventSourceMapping',
        {
          FunctionName: 'fn',
          SelfManagedEventSource: { Endpoints: { KAFKA_BOOTSTRAP_SERVERS: ['b.example:9092'] } },
          Queues: ['queue-a'],
          Topics: ['topic-a'],
          StartingPositionTimestamp: 1717000000,
        },
        {
          FunctionName: 'fn',
          SelfManagedEventSource: { Endpoints: { KAFKA_BOOTSTRAP_SERVERS: ['b.example:9092'] } },
        }
      );

      const input = getUpdateInput();
      expect(input['Queues']).toBeUndefined();
      expect(input['Topics']).toBeUndefined();
      expect(input['StartingPositionTimestamp']).toBeUndefined();
    });
  });
});
