import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
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
import { importTagWalkTestHooks } from '../../../../src/provisioning/import-tag-walk.js';

describe('EventBridgeBusProvider import', () => {
  let provider: EventBridgeBusProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new EventBridgeBusProvider();
    // Skip the walk's real exponential backoff in the throttle tests.
    importTagWalkTestHooks.sleep = async () => {};
  });

  afterEach(() => {
    importTagWalkTestHooks.sleep = undefined;
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

  it('tag-based lookup: matches aws:cdk:path via ListEventBuses + ListTagsForResource', async () => {
    mockSend
      .mockResolvedValueOnce({
        EventBuses: [
          { Name: 'other', Arn: 'arn:aws:events:us-east-1:123456789012:event-bus/other' },
          { Name: 'target', Arn: 'arn:aws:events:us-east-1:123456789012:event-bus/target' },
        ],
      })
      .mockResolvedValueOnce({ Tags: [{ Key: 'aws:cdk:path', Value: 'OtherStack/Other' }] })
      .mockResolvedValueOnce({ Tags: [{ Key: 'aws:cdk:path', Value: 'MyStack/MyBus' }] });

    const result = await provider.import(makeInput());

    expect(result).toEqual({ physicalId: 'target', attributes: {} });
  });

  it('skips a candidate whose tag read throws ResourceNotFoundException', async () => {
    mockSend
      .mockResolvedValueOnce({
        EventBuses: [
          { Name: 'gone', Arn: 'arn:aws:events:us-east-1:123456789012:event-bus/gone' },
          { Name: 'target', Arn: 'arn:aws:events:us-east-1:123456789012:event-bus/target' },
        ],
      })
      .mockRejectedValueOnce(
        new ResourceNotFoundException({ message: 'not found', $metadata: {} })
      )
      .mockResolvedValueOnce({ Tags: [{ Key: 'aws:cdk:path', Value: 'MyStack/MyBus' }] });

    const result = await provider.import(makeInput());

    expect(result).toEqual({ physicalId: 'target', attributes: {} });
  });

  it('returns null when no bus matches', async () => {
    mockSend
      .mockResolvedValueOnce({
        EventBuses: [
          { Name: 'only', Arn: 'arn:aws:events:us-east-1:123456789012:event-bus/only' },
        ],
      })
      .mockResolvedValueOnce({ Tags: [{ Key: 'aws:cdk:path', Value: 'OtherStack/Other' }] });

    const result = await provider.import(makeInput());

    expect(result).toBeNull();
  });

  // Issue #1091 batch 3: the tag walk is an N+1 ListTagsForResource burst
  // routed through the shared importTagWalk helper — a throttled per-candidate
  // tag read is retried with backoff instead of aborting the whole import,
  // while a non-throttling error still surfaces immediately.
  it('retries a throttled ListTagsForResource mid-walk and still finds the match', async () => {
    const throttled = new Error('Rate exceeded') as Error & {
      $metadata: { httpStatusCode: number };
    };
    throttled.name = 'ThrottlingException';
    throttled.$metadata = { httpStatusCode: 400 };

    mockSend
      .mockResolvedValueOnce({
        EventBuses: [
          { Name: 'target', Arn: 'arn:aws:events:us-east-1:123456789012:event-bus/target' },
        ],
      })
      .mockRejectedValueOnce(throttled)
      .mockResolvedValueOnce({ Tags: [{ Key: 'aws:cdk:path', Value: 'MyStack/MyBus' }] });

    const result = await provider.import(makeInput());

    expect(result).toEqual({ physicalId: 'target', attributes: {} });
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-throttling error during the walk', async () => {
    const denied = new Error('User is not authorized to perform events:ListTagsForResource');
    denied.name = 'AccessDeniedException';

    mockSend
      .mockResolvedValueOnce({
        EventBuses: [
          { Name: 'target', Arn: 'arn:aws:events:us-east-1:123456789012:event-bus/target' },
        ],
      })
      .mockRejectedValueOnce(denied);

    await expect(provider.import(makeInput())).rejects.toThrow(/not authorized/);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });
});
