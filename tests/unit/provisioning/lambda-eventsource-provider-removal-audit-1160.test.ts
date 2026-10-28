import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { UpdateEventSourceMappingCommand } from '@aws-sdk/client-lambda';
import { prepareRemovalForUpdate } from '../../../src/provisioning/update-removal.js';

// Issue #1160: AWS::Lambda::EventSourceMapping is registered in
// `removalHandledInUpdate`, so a removal update() leaves alone without a
// measured CloudFormation answer is named by update() itself.

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
import { getLogger } from '../../../src/utils/logger.js';

const TYPE = 'AWS::Lambda::EventSourceMapping';
const UUID = 'abcdef12-3456-7890-abcd-ef1234567890';
const ESM_ARN = 'arn:aws:lambda:us-east-1:123456789012:event-source-mapping:' + UUID;
const SQS_ARN = 'arn:aws:sqs:us-east-1:123456789012:q';
const KAFKA_ARN = 'arn:aws:kafka:us-east-1:123456789012:cluster/c/uuid';
const MQ_ARN = 'arn:aws:mq:us-east-1:123456789012:broker:b:b-1';
const DOCDB_ARN = 'arn:aws:rds:us-east-1:123456789012:cluster:c';
const UNKNOWN_ARN = 'arn:aws:example:us-east-1:123456789012:thing/t';

const warn = vi.mocked(getLogger().child('x').warn);

function keptLines(): string[] {
  return warn.mock.calls
    .map((c) => String(c[0]))
    .filter((l) => l.includes('cdkd keeps the current AWS'));
}

function updateInput(): Record<string, unknown> {
  const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateEventSourceMappingCommand);
  return (call?.[0] as { input: Record<string, unknown> }).input;
}

describe('LambdaEventSourceMappingProvider removal audit (issue #1160)', () => {
  let provider: LambdaEventSourceMappingProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockImplementation((cmd: unknown) =>
      Promise.resolve(
        cmd instanceof UpdateEventSourceMappingCommand
          ? { UUID, EventSourceMappingArn: ESM_ARN }
          : { Tags: {} }
      )
    );
    provider = new LambdaEventSourceMappingProvider();
  });

  it('audits every handled property, so none falls to the shared removal line', () => {
    const handled = [...provider.handledProperties.get(TYPE)!].sort();
    const audited = [...provider.removalHandledInUpdate.get(TYPE)!].sort();
    expect(audited).toEqual(handled);
  });

  it('leaves the caller nothing to warn about when every property is removed', () => {
    const baseline = Object.fromEntries(
      [...provider.handledProperties.get(TYPE)!].map((key) => [key, 'x'])
    );
    const prep = prepareRemovalForUpdate(provider, TYPE, { FunctionName: 'fn' }, baseline);
    expect(prep.context.removedProperties?.size).toBeGreaterThan(20);
    expect(prep.unhandled).toEqual([]);
  });

  it('names a BatchSize it cannot reset on a source it cannot classify', async () => {
    await provider.update(
      'L',
      UUID,
      TYPE,
      { FunctionName: 'fn', EventSourceArn: UNKNOWN_ARN },
      { FunctionName: 'fn', EventSourceArn: UNKNOWN_ARN, BatchSize: 7 }
    );

    expect(updateInput()['BatchSize']).toBeUndefined();
    expect(keptLines()).toEqual([
      'L (AWS::Lambda::EventSourceMapping): property BatchSize was removed from the template; cdkd keeps the current AWS value on a mapping whose source kind cdkd cannot tell, since what CloudFormation resets there is not measured. Declare the value you want instead.',
    ]);
  });

  // Third CloudFormation A/B: on a provisioned-mode Kafka mapping CFn sent
  // neither key on their removal, and the mapping kept 3 / 3600.
  describe('Kafka retry removals while provisioned mode stays declared', () => {
    const kafka = {
      FunctionName: 'fn',
      EventSourceArn: KAFKA_ARN,
      ProvisionedPollerConfig: { MinimumPollers: 1, MaximumPollers: 2 },
    };
    const cfnKeepsLines = (): string[] =>
      warn.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes('as CloudFormation keeps'));

    it('keeps both, as CloudFormation keeps them, in one line', async () => {
      await provider.update('L', UUID, TYPE, kafka, {
        ...kafka,
        MaximumRetryAttempts: 3,
        MaximumRecordAgeInSeconds: 3600,
      });

      const input = updateInput();
      expect(input).not.toHaveProperty('MaximumRetryAttempts');
      expect(input).not.toHaveProperty('MaximumRecordAgeInSeconds');
      expect(keptLines()).toEqual([]);
      expect(cfnKeepsLines()).toEqual([
        'L (AWS::Lambda::EventSourceMapping): properties MaximumRetryAttempts, MaximumRecordAgeInSeconds were removed from the template; the Kafka mapping keeps its current values, as CloudFormation keeps them. Declare -1 for no limit instead.',
      ]);
    });

    it.each(['MaximumRetryAttempts', 'MaximumRecordAgeInSeconds'])(
      'words a lone %s removal in the singular',
      async (key) => {
        await provider.update('L', UUID, TYPE, kafka, { ...kafka, [key]: 5 });

        expect(updateInput()).not.toHaveProperty(key);
        expect(keptLines()).toEqual([]);
        expect(cfnKeepsLines()).toEqual([
          `L (AWS::Lambda::EventSourceMapping): property ${key} was removed from the template; the Kafka mapping keeps its current value, as CloudFormation keeps it. Declare -1 for no limit instead.`,
        ]);
      }
    );

    it('still names an unmeasured ParallelizationFactor in the general kept line', async () => {
      await provider.update('L', UUID, TYPE, kafka, {
        ...kafka,
        MaximumRetryAttempts: 3,
        ParallelizationFactor: 2,
      });

      expect(keptLines()).toEqual([
        'L (AWS::Lambda::EventSourceMapping): property ParallelizationFactor was removed from the template; cdkd keeps the current AWS value on this Kafka mapping, since what CloudFormation resets there is not measured. Declare the value you want instead.',
      ]);
      expect(cfnKeepsLines()).toHaveLength(1);
      expect(cfnKeepsLines()[0]).toContain('property MaximumRetryAttempts was removed');
    });

    it('words the line as absent from what is restored on a rollback replay', async () => {
      await provider.update(
        'L',
        UUID,
        TYPE,
        kafka,
        { ...kafka, MaximumRecordAgeInSeconds: 3600 },
        { replayingState: true }
      );

      expect(cfnKeepsLines()).toEqual([
        'L (AWS::Lambda::EventSourceMapping): property MaximumRecordAgeInSeconds is absent from the configuration being restored; the Kafka mapping keeps its current value, as CloudFormation keeps it. Declare -1 for no limit instead.',
      ]);
    });

    it('keeps the unmeasured line on a provisioned-mode SQS mapping', async () => {
      const sqs = { ...kafka, EventSourceArn: SQS_ARN };
      await provider.update('L', UUID, TYPE, sqs, { ...sqs, MaximumRetryAttempts: 3 });

      expect(cfnKeepsLines()).toEqual([]);
      expect(keptLines()).toEqual([
        'L (AWS::Lambda::EventSourceMapping): property MaximumRetryAttempts was removed from the template; cdkd keeps the current AWS value on this SQS mapping, since what CloudFormation resets there is not measured. Declare the value you want instead.',
      ]);
    });

    it('falls back to the unmeasured line when the update enters provisioned mode', async () => {
      const { ProvisionedPollerConfig: _ppc, ...onDemand } = kafka;
      await provider.update('L', UUID, TYPE, kafka, { ...onDemand, MaximumRetryAttempts: 3 });

      expect(cfnKeepsLines()).toEqual([]);
      expect(keptLines()).toEqual([
        'L (AWS::Lambda::EventSourceMapping): property MaximumRetryAttempts was removed from the template; cdkd keeps the current AWS value on this Kafka mapping, since what CloudFormation resets there is not measured. Declare the value you want instead.',
      ]);
    });

    it('falls back to the unmeasured line when the update also leaves provisioned mode', async () => {
      const { ProvisionedPollerConfig: _ppc, ...leaving } = kafka;
      await provider.update('L', UUID, TYPE, leaving, { ...kafka, MaximumRetryAttempts: 3 });

      expect(updateInput()['ProvisionedPollerConfig']).toEqual({});
      expect(updateInput()).not.toHaveProperty('MaximumRetryAttempts');
      expect(cfnKeepsLines()).toEqual([]);
      expect(keptLines()).toEqual([
        'L (AWS::Lambda::EventSourceMapping): property MaximumRetryAttempts was removed from the template; cdkd keeps the current AWS value on this Kafka mapping, since what CloudFormation resets there is not measured. Declare the value you want instead.',
      ]);
    });
  });

  it('names every kept Kafka error-handling removal in one line outside provisioned mode', async () => {
    const kafka = { FunctionName: 'fn', EventSourceArn: KAFKA_ARN };
    await provider.update('L', UUID, TYPE, kafka, {
      ...kafka,
      MaximumRetryAttempts: 3,
      MaximumRecordAgeInSeconds: 600,
    });

    const input = updateInput();
    expect(input['MaximumRetryAttempts']).toBeUndefined();
    expect(input['MaximumRecordAgeInSeconds']).toBeUndefined();
    expect(keptLines()).toEqual([
      'L (AWS::Lambda::EventSourceMapping): properties MaximumRetryAttempts, MaximumRecordAgeInSeconds were removed from the template; cdkd keeps the current AWS values on this Kafka mapping, since what CloudFormation resets there is not measured. Declare the values you want instead.',
    ]);
  });

  it.each([
    ['Amazon MQ', MQ_ARN, {}],
    ['DocumentDB', DOCDB_ARN, { DocumentDBEventSourceConfig: { DatabaseName: 'db' } }],
  ])(
    'names a kept MaximumBatchingWindowInSeconds on a %s mapping',
    async (label, arn, extra) => {
      const props = { FunctionName: 'fn', EventSourceArn: arn, ...extra };
      await provider.update('L', UUID, TYPE, props, {
        ...props,
        MaximumBatchingWindowInSeconds: 3,
      });

      expect(updateInput()['MaximumBatchingWindowInSeconds']).toBeUndefined();
      const lines = keptLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(
        `property MaximumBatchingWindowInSeconds was removed from the template; cdkd keeps the current AWS value on this ${label} mapping`
      );
    }
  );

  it('names the classified kind of an SQS mapping in the kept line', async () => {
    const props = { FunctionName: 'fn', EventSourceArn: SQS_ARN };
    await provider.update('L', UUID, TYPE, props, {
      ...props,
      LoggingConfig: { SystemLogLevel: 'DEBUG' },
    });

    expect(updateInput()['LoggingConfig']).toBeUndefined();
    expect(keptLines()).toEqual([
      'L (AWS::Lambda::EventSourceMapping): property LoggingConfig was removed from the template; cdkd keeps the current AWS value on this SQS mapping, since what CloudFormation resets there is not measured. Declare the value you want instead.',
    ]);
  });

  it.each([
    [
      'a Kafka mapping without provisioned mode',
      KAFKA_ARN,
      'BisectBatchOnFunctionError is absent from the configuration being restored while the Kafka mapping does not declare ProvisionedPollerConfig',
    ],
    [
      'a source it cannot classify',
      UNKNOWN_ARN,
      'BisectBatchOnFunctionError is absent from the configuration being restored, but cdkd cannot tell',
    ],
  ])('words a kept Bisect removal on a rollback replay of %s', async (_case, arn, needle) => {
    const props = { FunctionName: 'fn', EventSourceArn: arn };
    await provider.update(
      'L',
      UUID,
      TYPE,
      props,
      { ...props, BisectBatchOnFunctionError: true },
      { replayingState: true }
    );

    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes(needle))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('removed from the template'))).toEqual([]);
  });

  it('names a kept LoggingConfig / ProvisionedPollerConfig / FunctionResponseTypes / SourceAccessConfigurations off their kinds', async () => {
    const props = { FunctionName: 'fn', EventSourceArn: UNKNOWN_ARN };
    await provider.update('L', UUID, TYPE, props, {
      ...props,
      LoggingConfig: { SystemLogLevel: 'DEBUG' },
      ProvisionedPollerConfig: { MinimumPollers: 1 },
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      SourceAccessConfigurations: [{ Type: 'BASIC_AUTH', URI: 'arn:aws:secretsmanager:x' }],
      ParallelizationFactor: 2,
      TumblingWindowInSeconds: 30,
    });

    const lines = keptLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(
      'properties ParallelizationFactor, TumblingWindowInSeconds, FunctionResponseTypes, SourceAccessConfigurations, LoggingConfig, ProvisionedPollerConfig were removed'
    );
  });

  it.each([
    [
      'a Kafka batching window (CloudFormation keeps it)',
      { EventSourceArn: KAFKA_ARN },
      { MaximumBatchingWindowInSeconds: 3 },
    ],
    [
      'an SQS ProvisionedPollerConfig (CloudFormation keeps it)',
      { EventSourceArn: SQS_ARN },
      { ProvisionedPollerConfig: { MinimumPollers: 2, MaximumPollers: 5 } },
    ],
    [
      'resets on their own kinds',
      { EventSourceArn: 'arn:aws:kinesis:us-east-1:123:stream/s' },
      {
        BatchSize: 7,
        MaximumBatchingWindowInSeconds: 3,
        MaximumRetryAttempts: 3,
        MaximumRecordAgeInSeconds: 600,
        ParallelizationFactor: 2,
        TumblingWindowInSeconds: 30,
        FunctionResponseTypes: ['ReportBatchItemFailures'],
      },
    ],
    [
      'Kafka resets',
      { EventSourceArn: KAFKA_ARN },
      {
        BatchSize: 7,
        LoggingConfig: { SystemLogLevel: 'DEBUG' },
        ProvisionedPollerConfig: { MinimumPollers: 1 },
        SourceAccessConfigurations: [{ Type: 'VPC_SUBNET', URI: 'subnet:subnet-1' }],
      },
    ],
  ])('names nothing for %s', async (_case, source, removed) => {
    const props = { FunctionName: 'fn', ...source };
    await provider.update('L', UUID, TYPE, props, { ...props, ...removed });

    expect(keptLines()).toEqual([]);
  });
});

// Issue #1160, CloudFormation A/B on a DocumentDB mapping: UpdateEventSourceMapping
// refuses DatabaseName / CollectionName even unchanged, and CloudFormation sends
// `{ FullDocument }` alone, or no block when FullDocument is not declared.
describe('LambdaEventSourceMappingProvider DocumentDBEventSourceConfig on update (issue #1160)', () => {
  let provider: LambdaEventSourceMappingProvider;
  const BLOCK = { DatabaseName: 'db1', CollectionName: 'c1', FullDocument: 'UpdateLookup' };
  const base = { FunctionName: 'fn', EventSourceArn: DOCDB_ARN };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockImplementation((cmd: unknown) =>
      Promise.resolve(
        cmd instanceof UpdateEventSourceMappingCommand
          ? { UUID, EventSourceMappingArn: ESM_ARN }
          : { Tags: {} }
      )
    );
    provider = new LambdaEventSourceMappingProvider();
  });

  function docdbWarnings(): string[] {
    return warn.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('DocumentDBEventSourceConfig'));
  }

  it.each([
    ['an ordinary update', { replayingState: false }],
    ['a rollback replay', { replayingState: true }],
  ])('sends only FullDocument on %s of a still-declared block', async (_case, context) => {
    const props = { ...base, DocumentDBEventSourceConfig: BLOCK, BatchSize: 20 };
    const result = await provider.update(
      'L',
      UUID,
      TYPE,
      props,
      { ...props, BatchSize: 10 },
      context
    );

    expect(updateInput()['DocumentDBEventSourceConfig']).toEqual({ FullDocument: 'UpdateLookup' });
    expect(docdbWarnings()).toEqual([]);
    expect(result.effectiveProperties).toBeUndefined();
  });

  it('sends no block when the declared block has no FullDocument', async () => {
    const block = { DatabaseName: 'db1', CollectionName: 'c1' };
    const props = { ...base, DocumentDBEventSourceConfig: block, BatchSize: 20 };
    await provider.update('L', UUID, TYPE, props, { ...props, BatchSize: 10 });

    expect(updateInput()).not.toHaveProperty('DocumentDBEventSourceConfig');
    expect(docdbWarnings()).toEqual([]);
  });

  it('keeps and records the live CollectionName when the template changes it', async () => {
    const props = { ...base, DocumentDBEventSourceConfig: { ...BLOCK, CollectionName: 'c2' } };
    const result = await provider.update('L', UUID, TYPE, props, {
      ...base,
      DocumentDBEventSourceConfig: BLOCK,
    });

    expect(updateInput()['DocumentDBEventSourceConfig']).toEqual({ FullDocument: 'UpdateLookup' });
    expect(docdbWarnings()).toEqual([
      'L (AWS::Lambda::EventSourceMapping): DocumentDBEventSourceConfig.CollectionName cannot be changed on an existing event source mapping (UpdateEventSourceMapping refuses it, and CloudFormation leaves it as it is), so the mapping keeps reading its current value. To read another database or collection, remove the mapping, deploy, then add it back.',
    ]);
    expect(result.effectiveProperties).toEqual({ ...base, DocumentDBEventSourceConfig: BLOCK });
  });

  it('keeps and records a CollectionName and FullDocument removed from a still-declared block', async () => {
    const props = { ...base, DocumentDBEventSourceConfig: { DatabaseName: 'db2' } };
    const result = await provider.update('L', UUID, TYPE, props, {
      ...base,
      DocumentDBEventSourceConfig: BLOCK,
    });

    expect(updateInput()).not.toHaveProperty('DocumentDBEventSourceConfig');
    const lines = docdbWarnings();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(
      'DocumentDBEventSourceConfig.DatabaseName / CollectionName cannot be changed on an existing event source mapping'
    );
    expect(lines[0]).toContain('keeps reading its current values.');
    expect(lines[1]).toBe(
      'L (AWS::Lambda::EventSourceMapping): DocumentDBEventSourceConfig.FullDocument was removed from the template; the mapping keeps its current value, as CloudFormation keeps it. Declare FullDocument: Default to turn the full-document lookup off.'
    );
    // FullDocument stays absent in the record, as every other removal does.
    expect(result.effectiveProperties).toEqual({
      ...base,
      DocumentDBEventSourceConfig: { DatabaseName: 'db1', CollectionName: 'c1' },
    });
  });

  it('records no CollectionName the previous block never declared', async () => {
    const block = { DatabaseName: 'db1', FullDocument: 'Default' };
    const props = { ...base, DocumentDBEventSourceConfig: { ...block, CollectionName: 'c2' } };
    const result = await provider.update('L', UUID, TYPE, props, {
      ...base,
      DocumentDBEventSourceConfig: block,
    });

    expect(result.effectiveProperties).toEqual({ ...base, DocumentDBEventSourceConfig: block });
    expect(result.effectiveProperties?.['DocumentDBEventSourceConfig']).not.toHaveProperty(
      'CollectionName'
    );
  });

  it('reports and records nothing when the record carries no block at all', async () => {
    const props = { ...base, DocumentDBEventSourceConfig: BLOCK };
    const result = await provider.update('L', UUID, TYPE, props, base);

    expect(updateInput()['DocumentDBEventSourceConfig']).toEqual({ FullDocument: 'UpdateLookup' });
    expect(docdbWarnings()).toEqual([]);
    expect(result.effectiveProperties).toBeUndefined();
  });

  it('reports and records nothing against a recorded block that is not an object', async () => {
    const props = { ...base, DocumentDBEventSourceConfig: BLOCK };
    const result = await provider.update('L', UUID, TYPE, props, {
      ...base,
      DocumentDBEventSourceConfig: 'not-an-object',
    });

    expect(updateInput()['DocumentDBEventSourceConfig']).toEqual({ FullDocument: 'UpdateLookup' });
    expect(docdbWarnings()).toEqual([]);
    expect(result.effectiveProperties).toBeUndefined();
  });

  it.each([
    ['a rollback replay', { replayingState: true }],
    ['a drift revert', { desiredFromAwsReadback: true }],
  ])('words a kept removal on %s as absent from what is restored', async (_case, context) => {
    const props = { ...base, DocumentDBEventSourceConfig: { DatabaseName: 'db1', CollectionName: 'c1' } };
    await provider.update(
      'L',
      UUID,
      TYPE,
      props,
      { ...base, DocumentDBEventSourceConfig: BLOCK, MaximumBatchingWindowInSeconds: 3 },
      context
    );

    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain(
      'L (AWS::Lambda::EventSourceMapping): DocumentDBEventSourceConfig.FullDocument is absent from the configuration being restored; the mapping keeps its current value, as CloudFormation keeps it. Declare FullDocument: Default to turn the full-document lookup off.'
    );
    expect(
      lines.filter((l) =>
        l.includes(
          'property MaximumBatchingWindowInSeconds is absent from the configuration being restored; cdkd keeps the current AWS value on this DocumentDB mapping'
        )
      )
    ).toHaveLength(1);
    expect(lines.filter((l) => l.includes('removed from the template'))).toEqual([]);
  });

  it('forwards a present-but-non-object block as it is, for AWS to refuse', async () => {
    const props = { ...base, DocumentDBEventSourceConfig: 'not-an-object' };
    await provider.update('L', UUID, TYPE, props, { ...base, DocumentDBEventSourceConfig: BLOCK });

    expect(updateInput()['DocumentDBEventSourceConfig']).toBe('not-an-object');
  });
});
