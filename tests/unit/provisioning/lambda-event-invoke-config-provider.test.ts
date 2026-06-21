import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { ResourceNotFoundException } from '@aws-sdk/client-lambda';

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

import { LambdaEventInvokeConfigProvider } from '../../../src/provisioning/providers/lambda-event-invoke-config-provider.js';

const DLQ_ARN = 'arn:aws:sqs:us-east-1:123456789012:my-dlq';

/** Return the SDK command-input object from the Nth mockSend call. */
function inputOf(callIndex = 0): Record<string, unknown> {
  return mockSend.mock.calls[callIndex][0].input as Record<string, unknown>;
}

describe('LambdaEventInvokeConfigProvider', () => {
  let provider: LambdaEventInvokeConfigProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new LambdaEventInvokeConfigProvider();
  });

  describe('create', () => {
    it('Puts the config and returns the compound <FunctionName>|<Qualifier> physical id', async () => {
      mockSend.mockResolvedValueOnce({});
      const result = await provider.create('Cfg', 'AWS::Lambda::EventInvokeConfig', {
        FunctionName: 'my-fn',
        Qualifier: '$LATEST',
        MaximumEventAgeInSeconds: 120,
        MaximumRetryAttempts: 1,
        DestinationConfig: { OnFailure: { Destination: DLQ_ARN } },
      });

      expect(result.physicalId).toBe('my-fn|$LATEST');
      const input = inputOf();
      expect(input.FunctionName).toBe('my-fn');
      expect(input.MaximumEventAgeInSeconds).toBe(120);
      expect(input.MaximumRetryAttempts).toBe(1);
      expect(input.DestinationConfig).toEqual({ OnFailure: { Destination: DLQ_ARN } });
      // The whole bug: an empty OnSuccess must NEVER be emitted.
      expect((input.DestinationConfig as Record<string, unknown>).OnSuccess).toBeUndefined();
    });

    it('coerces stringly-typed numeric props to numbers at the wire boundary', async () => {
      mockSend.mockResolvedValueOnce({});
      await provider.create('Cfg', 'AWS::Lambda::EventInvokeConfig', {
        FunctionName: 'my-fn',
        MaximumEventAgeInSeconds: '300',
        MaximumRetryAttempts: '2',
      });
      const input = inputOf();
      expect(input.MaximumEventAgeInSeconds).toBe(300);
      expect(input.MaximumRetryAttempts).toBe(2);
    });

    it('throws when FunctionName is missing', async () => {
      await expect(
        provider.create('Cfg', 'AWS::Lambda::EventInvokeConfig', {})
      ).rejects.toThrow(/FunctionName is required/);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('update (regression: full-replace Put, never an empty OnSuccess)', () => {
    it('changing only MaximumEventAgeInSeconds/MaximumRetryAttempts re-Puts the full config without an empty OnSuccess', async () => {
      mockSend.mockResolvedValueOnce({});
      const previous = {
        FunctionName: 'my-fn',
        Qualifier: '$LATEST',
        MaximumEventAgeInSeconds: 120,
        MaximumRetryAttempts: 1,
        DestinationConfig: { OnFailure: { Destination: DLQ_ARN } },
      };
      const desired = {
        ...previous,
        MaximumEventAgeInSeconds: 300,
        MaximumRetryAttempts: 2,
      };

      const result = await provider.update(
        'Cfg',
        'my-fn|$LATEST',
        'AWS::Lambda::EventInvokeConfig',
        desired,
        previous
      );

      expect(result.wasReplaced).toBe(false);
      expect(mockSend).toHaveBeenCalledTimes(1);
      const input = inputOf();
      expect(input.MaximumEventAgeInSeconds).toBe(300);
      expect(input.MaximumRetryAttempts).toBe(2);
      // Must send the configured OnFailure, and must NOT inject an empty
      // OnSuccess (the exact shape the Cloud Control patch route failed on).
      expect(input.DestinationConfig).toEqual({ OnFailure: { Destination: DLQ_ARN } });
      expect((input.DestinationConfig as Record<string, unknown>).OnSuccess).toBeUndefined();
    });

    it('is a no-op (no AWS call) when nothing changed (drift --revert round-trip)', async () => {
      const props = {
        FunctionName: 'my-fn',
        MaximumEventAgeInSeconds: 120,
        MaximumRetryAttempts: 1,
        DestinationConfig: { OnFailure: { Destination: DLQ_ARN } },
      };
      const result = await provider.update(
        'Cfg',
        'my-fn|$LATEST',
        'AWS::Lambda::EventInvokeConfig',
        { ...props },
        { ...props }
      );
      expect(result.wasReplaced).toBe(false);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('parses the compound physical id and calls DeleteFunctionEventInvokeConfig', async () => {
      mockSend.mockResolvedValueOnce({});
      await provider.delete('Cfg', 'my-fn|2', 'AWS::Lambda::EventInvokeConfig');
      const input = inputOf();
      expect(input.FunctionName).toBe('my-fn');
      expect(input.Qualifier).toBe('2');
    });

    it('omits Qualifier for an unqualified ($LATEST) physical id', async () => {
      mockSend.mockResolvedValueOnce({});
      await provider.delete('Cfg', 'my-fn|$LATEST', 'AWS::Lambda::EventInvokeConfig');
      const input = inputOf();
      expect(input.FunctionName).toBe('my-fn');
      expect(input.Qualifier).toBeUndefined();
    });

    it('treats ResourceNotFoundException as idempotent success when regions match', async () => {
      mockSend.mockRejectedValueOnce(
        new ResourceNotFoundException({ message: 'gone', $metadata: {} })
      );
      await expect(
        provider.delete('Cfg', 'my-fn|$LATEST', 'AWS::Lambda::EventInvokeConfig', undefined, {
          expectedRegion: 'us-east-1',
        })
      ).resolves.toBeUndefined();
    });

    it('throws on ResourceNotFoundException when expectedRegion does NOT match the client region', async () => {
      // Client mock reports us-east-1; expectedRegion is eu-west-1 → the
      // NotFound must NOT be swallowed (it would mask a delete issued against
      // the wrong region).
      mockSend.mockRejectedValueOnce(
        new ResourceNotFoundException({ message: 'gone', $metadata: {} })
      );
      await expect(
        provider.delete('Cfg', 'my-fn|$LATEST', 'AWS::Lambda::EventInvokeConfig', undefined, {
          expectedRegion: 'eu-west-1',
        })
      ).rejects.toThrow();
    });
  });

  describe('create with OnSuccess destination', () => {
    it('emits the OnSuccess sub-key when a Destination is present', async () => {
      mockSend.mockResolvedValueOnce({});
      const onSuccessArn = 'arn:aws:sqs:us-east-1:123456789012:success-q';
      await provider.create('Cfg', 'AWS::Lambda::EventInvokeConfig', {
        FunctionName: 'my-fn',
        DestinationConfig: {
          OnSuccess: { Destination: onSuccessArn },
          OnFailure: { Destination: DLQ_ARN },
        },
      });
      const input = inputOf();
      expect(input.DestinationConfig).toEqual({
        OnSuccess: { Destination: onSuccessArn },
        OnFailure: { Destination: DLQ_ARN },
      });
    });
  });

  describe('readCurrentState', () => {
    it('surfaces the mutable props + OnFailure, dropping the AWS-injected empty OnSuccess', async () => {
      mockSend.mockResolvedValueOnce({
        MaximumEventAgeInSeconds: 120,
        MaximumRetryAttempts: 1,
        DestinationConfig: { OnSuccess: {}, OnFailure: { Destination: DLQ_ARN } },
      });
      const state = await provider.readCurrentState(
        'my-fn|$LATEST',
        'Cfg',
        'AWS::Lambda::EventInvokeConfig'
      );
      // Qualifier MUST be emitted even for the default '$LATEST' — CDK always
      // synthesizes it into state, so omitting it here would surface phantom
      // drift on every `cdkd drift` for a base async Lambda.
      expect(state).toEqual({
        FunctionName: 'my-fn',
        Qualifier: '$LATEST',
        MaximumEventAgeInSeconds: 120,
        MaximumRetryAttempts: 1,
        DestinationConfig: { OnFailure: { Destination: DLQ_ARN } },
      });
    });

    it('emits a non-default Qualifier from the physical id', async () => {
      mockSend.mockResolvedValueOnce({ MaximumRetryAttempts: 0 });
      const state = await provider.readCurrentState(
        'my-fn|2',
        'Cfg',
        'AWS::Lambda::EventInvokeConfig'
      );
      expect(state).toEqual({
        FunctionName: 'my-fn',
        Qualifier: '2',
        MaximumRetryAttempts: 0,
      });
    });

    it('returns undefined when the config is gone', async () => {
      mockSend.mockRejectedValueOnce(
        new ResourceNotFoundException({ message: 'gone', $metadata: {} })
      );
      const state = await provider.readCurrentState(
        'my-fn|$LATEST',
        'Cfg',
        'AWS::Lambda::EventInvokeConfig'
      );
      expect(state).toBeUndefined();
    });
  });

  describe('import (explicit-override only)', () => {
    it('returns physicalId when knownPhysicalId is supplied (no AWS calls)', async () => {
      const result = await provider.import({
        logicalId: 'Cfg',
        resourceType: 'AWS::Lambda::EventInvokeConfig',
        cdkPath: 'MyStack/Cfg',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: { FunctionName: 'my-fn' },
        knownPhysicalId: 'my-fn|$LATEST',
      });
      expect(result).toEqual({ physicalId: 'my-fn|$LATEST', attributes: {} });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns null without an explicit physical id', async () => {
      const result = await provider.import({
        logicalId: 'Cfg',
        resourceType: 'AWS::Lambda::EventInvokeConfig',
        cdkPath: 'MyStack/Cfg',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: { FunctionName: 'my-fn' },
      });
      expect(result).toBeNull();
    });
  });
});
