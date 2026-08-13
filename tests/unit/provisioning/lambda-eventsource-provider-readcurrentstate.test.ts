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

import {
  classifyEventSource,
  LambdaEventSourceMappingProvider,
} from '../../../src/provisioning/providers/lambda-eventsource-provider.js';

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

    it('re-spells SelfManagedEventSource.Endpoints back to the CFn key (issue #1384)', async () => {
      // State holds the template's `KafkaBootstrapServers`; emitting the SDK's
      // `KAFKA_BOOTSTRAP_SERVERS` here would fire guaranteed drift on every
      // clean run of a self-managed-Kafka ESM.
      mockSend.mockResolvedValueOnce({
        UUID: 'abc-123',
        FunctionArn: 'arn:aws:lambda:us-east-1:123:function:fn',
        EventSourceMappingArn: 'arn:aws:lambda:us-east-1:123:event-source-mapping:abc-123',
        State: 'Enabled',
        SelfManagedEventSource: { Endpoints: { KAFKA_BOOTSTRAP_SERVERS: ['b:9092'] } },
        Topics: ['t-a'],
      });
      mockSend.mockResolvedValueOnce({ Tags: {} });

      const result = await provider.readCurrentState(
        'abc-123',
        'L',
        'AWS::Lambda::EventSourceMapping'
      );
      expect(result?.['SelfManagedEventSource']).toEqual({
        Endpoints: { KafkaBootstrapServers: ['b:9092'] },
      });
    });

    it('round-trips the exact template blob back out of readCurrentState (issue #1384)', async () => {
      // The two directions are asserted separately elsewhere; this pins that
      // they COMPOSE. A drift run compares the template-shaped state value
      // against this output, so any asymmetry is permanent phantom drift.
      const templateBlob = {
        Endpoints: { KafkaBootstrapServers: ['b-1:9092', 'b-2:9092'], FutureType: ['x:1'] },
        FutureSibling: 'keep-me',
      };
      // What AWS echoes back for that template (the SDK enum key).
      mockSend.mockResolvedValueOnce({
        UUID: 'abc-123',
        FunctionArn: 'arn:aws:lambda:us-east-1:123:function:fn',
        EventSourceMappingArn: 'arn:aws:lambda:us-east-1:123:event-source-mapping:abc-123',
        State: 'Enabled',
        SelfManagedEventSource: {
          Endpoints: { KAFKA_BOOTSTRAP_SERVERS: ['b-1:9092', 'b-2:9092'], FutureType: ['x:1'] },
          FutureSibling: 'keep-me',
        },
        Topics: ['t-a'],
      });
      mockSend.mockResolvedValueOnce({ Tags: {} });

      const result = await provider.readCurrentState(
        'abc-123',
        'L',
        'AWS::Lambda::EventSourceMapping'
      );

      expect(result?.['SelfManagedEventSource']).toEqual(templateBlob);
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

  // Issue #1815: `classifyEventSource` hand-enumerated `arn:aws:` and
  // `arn:aws-cn:` per service, so an event source in ANY other partition —
  // GovCloud, the four iso partitions, `aws-eusc` — classified as `unknown`.
  // `unknown` is in neither `KINDS_WITH_FUNCTION_RESPONSE_TYPES` nor
  // `KINDS_WITH_SOURCE_ACCESS_CONFIGURATIONS`, so the type-discriminator
  // placeholders silently stopped being emitted and the drift comparator saw a
  // one-sided difference on every clean run. The classifier is module-private,
  // so it is pinned through the emission it gates — which is also the behavior
  // that actually matters.
  describe('issue #1815: partition-independent event-source classification', () => {
    async function readWithSource(eventSourceArn: string): Promise<Record<string, unknown>> {
      mockSend.mockResolvedValueOnce({
        UUID: 'abc-123',
        FunctionArn: 'arn:aws:lambda:us-east-1:123:function:fn',
        EventSourceArn: eventSourceArn,
        EventSourceMappingArn: 'arn:aws:lambda:us-east-1:123:event-source-mapping:abc-123',
        State: 'Enabled',
      });
      mockSend.mockResolvedValueOnce({ Tags: {} });
      const result = await provider.readCurrentState(
        'abc-123',
        'L',
        'AWS::Lambda::EventSourceMapping'
      );
      return result ?? {};
    }

    // SQS / Kinesis / DynamoDB gate `FunctionResponseTypes`.
    it.each([
      ['aws-us-gov', 'arn:aws-us-gov:sqs:us-gov-west-1:123:my-queue'],
      ['aws-iso', 'arn:aws-iso:sqs:us-iso-east-1:123:my-queue'],
      ['aws-iso-b', 'arn:aws-iso-b:kinesis:us-isob-east-1:123:stream/my-stream'],
      ['aws-iso-f', 'arn:aws-iso-f:dynamodb:us-isof-south-1:123:table/t/stream/2024'],
      ['aws-eusc', 'arn:aws-eusc:sqs:eusc-de-east-1:123:my-queue'],
    ])(
      'emits the FunctionResponseTypes placeholder for a %s event source',
      async (_partition, arn) => {
        const r = await readWithSource(arn);
        // Pre-fix this partition classified `unknown`, so the key was absent.
        expect(r['FunctionResponseTypes']).toEqual([]);
        expect('SourceAccessConfigurations' in r).toBe(false);
      }
    );

    // Kafka / MQ / DocumentDB gate `SourceAccessConfigurations` instead.
    it.each([
      ['aws-us-gov', 'arn:aws-us-gov:kafka:us-gov-west-1:123:cluster/c/uuid-1'],
      ['aws-iso', 'arn:aws-iso:mq:us-iso-east-1:123:broker:b:b-uuid'],
      ['aws-eusc', 'arn:aws-eusc:rds:eusc-de-east-1:123:cluster:docdb-1'],
    ])(
      'emits the SourceAccessConfigurations placeholder for a %s event source',
      async (_partition, arn) => {
        const r = await readWithSource(arn);
        expect(r['SourceAccessConfigurations']).toEqual([]);
        expect('FunctionResponseTypes' in r).toBe(false);
      }
    );

    // Commercial / China counter-cases: the two partitions the pre-fix
    // enumeration DID handle must keep behaving byte-identically.
    it.each([
      ['aws', 'arn:aws:sqs:us-east-1:123:my-queue'],
      ['aws-cn', 'arn:aws-cn:sqs:cn-north-1:123:my-queue'],
    ])('is unchanged for a %s event source', async (_partition, arn) => {
      const r = await readWithSource(arn);
      expect(r['FunctionResponseTypes']).toEqual([]);
      expect('SourceAccessConfigurations' in r).toBe(false);
    });

    // Widening the partition segment must not start classifying things that
    // are not event sources. An unrelated service and a non-ARN both stay
    // `unknown`, so NEITHER placeholder is emitted.
    it.each([
      ['an unrelated service ARN', 'arn:aws-us-gov:s3:::my-bucket'],
      ['a non-AWS ARN-shaped string', 'arn:notaws:sqs:us-gov-west-1:123:my-queue'],
      ['a bare non-ARN string', 'my-queue'],
    ])('classifies %s as unknown (neither placeholder emitted)', async (_label, arn) => {
      const r = await readWithSource(arn);
      expect('FunctionResponseTypes' in r).toBe(false);
      expect('SourceAccessConfigurations' in r).toBe(false);
    });

    // The rewrite replaced a `startsWith` chain with a TABLE LOOKUP, and the
    // service segment is user-controlled (it comes from the template's
    // `EventSourceArn`). A bare `TABLE[service] ?? 'unknown'` reaches
    // `Object.prototype`, so these names return a FUNCTION — which `??` never
    // replaces, making `classifyEventSource` hand back a function typed as
    // `EventSourceKind`. The `startsWith` chain being replaced had no such
    // reach, so this is what keeps the rewrite behavior-preserving rather
    // than merely equivalent on the happy path.
    //
    // Asserted on the classifier's RETURN VALUE, not through `readCurrentState`.
    // That is deliberate and was measured: every production consumer is a
    // `Set.has(kind)`, and a prototype member misses every set exactly as
    // `'unknown'` does — so a behavior-level version of this row passed with
    // the guard fully reverted. A test that cannot fail is worse than none,
    // because it reads as coverage.
    it.each([['constructor'], ['toString'], ['hasOwnProperty'], ['valueOf'], ['isPrototypeOf']])(
      'classifies the Object.prototype key %s as unknown, not as a prototype member',
      (service) => {
        const kind = classifyEventSource({
          EventSourceArn: `arn:aws:${service}:us-east-1:123:thing`,
        });
        expect(kind).toBe('unknown');
        expect(typeof kind).toBe('string');
      }
    );

    // The real services must still resolve — otherwise the row above could be
    // satisfied by a lookup that returns 'unknown' for everything.
    // Both partitions per row, per the #1745 convention: the commercial
    // spelling is the counter-case proving the widening did not REPLACE the
    // old behavior. `mq` and `rds`->`documentdb` had no commercial assertion
    // anywhere before this, and the two placeholder sets cannot tell
    // within-set kinds apart (sqs/kinesis/dynamodb, kafka/mq/documentdb), so
    // a table typo between them was invisible to every behavior-level test.
    it.each([
      ['sqs', 'sqs'],
      ['kinesis', 'kinesis'],
      ['dynamodb', 'dynamodb'],
      ['kafka', 'kafka'],
      ['mq', 'mq'],
      ['rds', 'documentdb'],
    ])('classifies the %s service segment as %s in every partition', (service, expected) => {
      expect(classifyEventSource({ EventSourceArn: `arn:aws:${service}:us-east-1:123:x` })).toBe(
        expected
      );
      expect(
        classifyEventSource({ EventSourceArn: `arn:aws-us-gov:${service}:us-gov-west-1:123:x` })
      ).toBe(expected);
      expect(
        classifyEventSource({ EventSourceArn: `arn:aws-cn:${service}:cn-north-1:123:x` })
      ).toBe(expected);
    });

  });
});
