import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { UpdateEventSourceMappingCommand } from '@aws-sdk/client-lambda';

// Issue #3851: update() sends the Kafka config blocks, shaped by what
// UpdateEventSourceMapping accepts (measured live, see kafkaConfigForUpdate).

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

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
  return { getLogger: () => ({ child: () => childLogger }) };
});

import { LambdaEventSourceMappingProvider } from '../../../src/provisioning/providers/lambda-eventsource-provider.js';

const TYPE = 'AWS::Lambda::EventSourceMapping';
const UUID = 'abcdef12-3456-7890-abcd-ef1234567890';
const SR_JSON = {
  SchemaRegistryURI: 'https://registry.example.com',
  EventRecordFormat: 'JSON',
  SchemaValidationConfigs: [{ Attribute: 'VALUE' }],
};
const SR_SOURCE = { ...SR_JSON, EventRecordFormat: 'SOURCE' };

describe.each(['SelfManagedKafkaEventSourceConfig', 'AmazonManagedKafkaEventSourceConfig'])(
  'LambdaEventSourceMappingProvider.update — %s (issue #3851)',
  (block) => {
    let provider: LambdaEventSourceMappingProvider;

    beforeEach(() => {
      vi.clearAllMocks();
      provider = new LambdaEventSourceMappingProvider();
      mockSend.mockResolvedValue({ UUID, EventSourceMappingArn: `arn:esm:${UUID}` });
    });

    function props(config?: unknown): Record<string, unknown> {
      return { FunctionName: 'fn', BatchSize: 10, ...(config !== undefined && { [block]: config }) };
    }

    async function sentBlock(desired?: unknown, previous?: unknown): Promise<unknown> {
      await provider.update('Esm', UUID, TYPE, props(desired), props(previous));
      const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateEventSourceMappingCommand);
      expect(call).toBeDefined();
      const input = (call![0] as UpdateEventSourceMappingCommand).input as unknown as Record<
        string,
        unknown
      >;
      return Object.prototype.hasOwnProperty.call(input, block) ? input[block] : 'ABSENT';
    }

    it('sends an added SchemaRegistryConfig without the unchanged ConsumerGroupId', async () => {
      expect(
        await sentBlock(
          { ConsumerGroupId: 'g', SchemaRegistryConfig: SR_JSON },
          { ConsumerGroupId: 'g' }
        )
      ).toEqual({ SchemaRegistryConfig: SR_JSON });
    });

    it('sends a changed SchemaRegistryConfig', async () => {
      expect(
        await sentBlock({ SchemaRegistryConfig: SR_SOURCE }, { SchemaRegistryConfig: SR_JSON })
      ).toEqual({ SchemaRegistryConfig: SR_SOURCE });
    });

    it('sends the documented reset when SchemaRegistryConfig is removed from the block', async () => {
      expect(
        await sentBlock(
          { ConsumerGroupId: 'g' },
          { ConsumerGroupId: 'g', SchemaRegistryConfig: SR_JSON }
        )
      ).toEqual({ SchemaRegistryConfig: {} });
    });

    it('sends the documented reset when the whole block is removed', async () => {
      expect(await sentBlock(undefined, { SchemaRegistryConfig: SR_JSON })).toEqual({
        SchemaRegistryConfig: {},
      });
    });

    it('sends a changed ConsumerGroupId, for AWS to answer', async () => {
      expect(await sentBlock({ ConsumerGroupId: 'new' }, { ConsumerGroupId: 'old' })).toEqual({
        ConsumerGroupId: 'new',
      });
    });

    it.each([
      ['a rollback state replay', { replayingState: true }],
      ['a drift --revert readback', { desiredFromAwsReadback: true }],
    ])('never sends a changed ConsumerGroupId on %s', async (_label, context) => {
      await provider.update(
        'Esm',
        UUID,
        TYPE,
        props({ ConsumerGroupId: 'old', SchemaRegistryConfig: SR_JSON }),
        props({ ConsumerGroupId: 'new' }),
        context
      );
      const input = (mockSend.mock.calls[0]![0] as UpdateEventSourceMappingCommand)
        .input as unknown as Record<string, unknown>;
      expect(input[block]).toEqual({ SchemaRegistryConfig: SR_JSON });
    });

    it.each([
      ['an unchanged block', { ConsumerGroupId: 'g', SchemaRegistryConfig: SR_JSON }],
      ['a block holding only ConsumerGroupId', { ConsumerGroupId: 'g' }],
    ])('sends nothing for %s', async (_label, config) => {
      expect(await sentBlock(config, config)).toBe('ABSENT');
    });

    it('sends nothing when the block was never declared', async () => {
      expect(await sentBlock(undefined, undefined)).toBe('ABSENT');
    });

    it('leaves a present-but-malformed desired block alone rather than reading a removal', async () => {
      expect(await sentBlock('not-an-object', { SchemaRegistryConfig: SR_JSON })).toBe('ABSENT');
    });
  }
);

describe('LambdaEventSourceMappingProvider.update — ConsumptionMode stays out of the block', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({ UUID, EventSourceMappingArn: `arn:esm:${UUID}` });
  });

  it('never names an unchanged ConsumptionMode when the schema registry changes', async () => {
    const provider = new LambdaEventSourceMappingProvider();
    await provider.update(
      'Esm',
      UUID,
      TYPE,
      {
        FunctionName: 'fn',
        SelfManagedKafkaEventSourceConfig: { ConsumptionMode: 'Queue', SchemaRegistryConfig: SR_JSON },
      },
      { FunctionName: 'fn', SelfManagedKafkaEventSourceConfig: { ConsumptionMode: 'Queue' } }
    );
    const input = (mockSend.mock.calls[0]![0] as UpdateEventSourceMappingCommand).input;
    expect(input.SelfManagedKafkaEventSourceConfig).toEqual({ SchemaRegistryConfig: SR_JSON });
  });
});
