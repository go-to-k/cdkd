import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateEventSourceMappingCommand,
  UpdateEventSourceMappingCommand,
} from '@aws-sdk/client-lambda';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

// Issue #3848: `SelfManagedKafkaEventSourceConfig.ConsumptionMode` is not modelled
// by `@aws-sdk/client-lambda`, whose serializer drops it, so the provider refuses
// it on the template path and warns on a replay.

const { mockSend, mockWarn } = vi.hoisted(() => ({ mockSend: vi.fn(), mockWarn: vi.fn() }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
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
const REFUSAL_PREFIX =
  'AWS::Lambda::EventSourceMapping Esm: SelfManagedKafkaEventSourceConfig.ConsumptionMode ' +
  'cannot be sent by cdkd yet';

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

describe('LambdaEventSourceMappingProvider — ConsumptionMode (issue #3848)', () => {
  let provider: LambdaEventSourceMappingProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new LambdaEventSourceMappingProvider();
    mockSend.mockResolvedValue({ UUID, EventSourceMappingArn: `arn:esm:${UUID}` });
  });

  describe('create', () => {
    it('refuses a template-path create before any AWS call, unwrapped', async () => {
      const error = await captureError(
        provider.create('Esm', TYPE, kafkaProps({ ConsumerGroupId: 'g', ConsumptionMode: 'Queue' }))
      );
      expect(error).toBeInstanceOf(ProvisioningError);
      // A raw prefix and no cause: the refusal is not re-labelled by the
      // create() wrapper, which would prepend "Failed to create ...".
      expect((error as ProvisioningError).message.startsWith(REFUSAL_PREFIX)).toBe(true);
      expect((error as ProvisioningError).cause).toBeUndefined();
      expect((error as ProvisioningError).message).toContain('Remove ConsumptionMode');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('warns and creates on a state replay', async () => {
      const result = await provider.create(
        'Esm',
        TYPE,
        kafkaProps({ ConsumerGroupId: 'g', ConsumptionMode: 'Queue' }),
        { replayingState: true }
      );
      expect(result.physicalId).toBe(UUID);
      expect(mockWarn).toHaveBeenCalledTimes(1);
      expect(mockWarn.mock.calls[0]![0]).toContain(REFUSAL_PREFIX);
      expect(mockSend.mock.calls[0]![0]).toBeInstanceOf(CreateEventSourceMappingCommand);
    });

    it('creates without a warning when the member is absent', async () => {
      await provider.create('Esm', TYPE, kafkaProps({ ConsumerGroupId: 'g' }));
      expect(mockWarn).not.toHaveBeenCalled();
      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  describe('update', () => {
    it('refuses an added ConsumptionMode on the template path before any AWS call', async () => {
      const error = await captureError(
        provider.update(
          'Esm',
          UUID,
          TYPE,
          kafkaProps({ ConsumerGroupId: 'g', ConsumptionMode: 'Queue' }),
          kafkaProps({ ConsumerGroupId: 'g' })
        )
      );
      expect(error).toBeInstanceOf(ProvisioningError);
      expect((error as ProvisioningError).message.startsWith(REFUSAL_PREFIX)).toBe(true);
      expect((error as ProvisioningError).message).toContain('UpdateEventSourceMapping');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuses a changed ConsumptionMode on the template path', async () => {
      const error = await captureError(
        provider.update(
          'Esm',
          UUID,
          TYPE,
          kafkaProps({ ConsumptionMode: 'Queue' }),
          kafkaProps({ ConsumptionMode: 'Stream' })
        )
      );
      expect(error).toBeInstanceOf(ProvisioningError);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('updates an unchanged ConsumptionMode without a warning', async () => {
      const props = kafkaProps({ ConsumptionMode: 'Queue' });
      await provider.update('Esm', UUID, TYPE, { ...props, BatchSize: 50 }, props);
      expect(mockWarn).not.toHaveBeenCalled();
      expect(mockSend.mock.calls[0]![0]).toBeInstanceOf(UpdateEventSourceMappingCommand);
    });

    it.each([
      ['a rollback state replay', { replayingState: true }],
      ['a drift --revert readback', { desiredFromAwsReadback: true }],
    ])('warns and updates on %s', async (_label, context) => {
      await provider.update(
        'Esm',
        UUID,
        TYPE,
        kafkaProps({ ConsumptionMode: 'Queue' }),
        kafkaProps({}),
        context
      );
      expect(mockWarn).toHaveBeenCalledTimes(1);
      expect(mockWarn.mock.calls[0]![0]).toContain(REFUSAL_PREFIX);
      expect(mockSend.mock.calls[0]![0]).toBeInstanceOf(UpdateEventSourceMappingCommand);
    });
  });
});
