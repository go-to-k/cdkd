import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { ResourceNotFoundException } from '@aws-sdk/client-eventbridge';

const mockSend = vi.fn();

vi.mock('../../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    eventBridge: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../../src/utils/logger.js', () => {
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

import { EventBridgeBusProvider } from '../../../../src/provisioning/providers/eventbridge-bus-provider.js';
import { UpdateEventBusCommand } from '@aws-sdk/client-eventbridge';

describe('EventBridgeBusProvider import', () => {
  let provider: EventBridgeBusProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new EventBridgeBusProvider();
  });

  function makeInput(overrides: Record<string, unknown> = {}) {
    return {
      logicalId: 'MyBus',
      resourceType: 'AWS::Events::EventBus',
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: {},
      ...overrides,
    };
  }

  it('explicit override: verifies via DescribeEventBus and returns the physicalId', async () => {
    mockSend.mockResolvedValueOnce({
      Name: 'target',
      Arn: 'arn:aws:events:us-east-1:123456789012:event-bus/target',
    });

    const result = await provider.import(makeInput({ knownPhysicalId: 'target' }));

    expect(result).toEqual({ physicalId: 'target', attributes: {} });
  });

  it('explicit override: returns null when DescribeEventBus throws ResourceNotFoundException', async () => {
    mockSend.mockRejectedValueOnce(
      new ResourceNotFoundException({ message: 'not found', $metadata: {} })
    );

    const result = await provider.import(makeInput({ knownPhysicalId: 'missing' }));

    expect(result).toBeNull();
  });

  // The `aws:cdk:path` tag walk was removed (issue #1134): AWS rejects
  // `aws:`-prefixed tag writes, so the tag never exists on a real bus.
  // With no explicit id, import returns null without issuing any AWS call.
  it('returns null without any AWS call when only cdkPath is given', async () => {
    const result = await provider.import(makeInput());

    expect(result).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('EventBridgeBusProvider update region guard (issue #2613)', () => {
  let provider: EventBridgeBusProvider;
  const desired = { Name: 'my-bus', Description: 'new' };
  const previous = { Name: 'my-bus', Description: 'old' };

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new EventBridgeBusProvider();
  });

  it('refuses an update from a wrong-region client before any call', async () => {
    await expect(
      provider.update('MyBus', 'my-bus', 'AWS::Events::EventBus', desired, previous, {
        expectedRegion: 'us-west-2',
      })
    ).rejects.toThrow(/Refusing to update MyBus .*does not match stack state region us-west-2/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('updates when the client region matches the recorded one', async () => {
    mockSend.mockResolvedValue({});
    await provider.update('MyBus', 'my-bus', 'AWS::Events::EventBus', desired, previous, {
      expectedRegion: 'us-east-1',
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0]![0]).toBeInstanceOf(UpdateEventBusCommand);
  });

  it('without a recorded region proceeds and never resolves the client region', async () => {
    const region = vi.fn(() => Promise.resolve('us-west-2'));
    ((provider as unknown as { eventBridgeClient: { config: { region: unknown } } }).eventBridgeClient).config.region = region;
    mockSend.mockResolvedValue({});
    await provider.update('MyBus', 'my-bus', 'AWS::Events::EventBus', desired, previous);
    expect(region).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0]![0]).toBeInstanceOf(UpdateEventBusCommand);
  });
});
