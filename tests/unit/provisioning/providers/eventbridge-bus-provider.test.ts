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
      cdkPath: 'MyStack/MyBus',
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
