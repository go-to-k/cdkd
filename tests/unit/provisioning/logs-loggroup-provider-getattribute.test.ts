import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock AWS clients before importing the provider
const mockLogsSend = vi.fn();
const mockStsSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudWatchLogs: {
      send: mockLogsSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
    sts: { send: mockStsSend },
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

import { LogsLogGroupProvider } from '../../../src/provisioning/providers/logs-loggroup-provider.js';

describe('LogsLogGroupProvider.getAttribute', () => {
  let provider: LogsLogGroupProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new LogsLogGroupProvider();
  });

  it('returns Arn templated from name + STS account + client region', async () => {
    mockStsSend.mockResolvedValueOnce({ Account: '123456789012' });

    const result = await provider.getAttribute(
      '/aws/lambda/my-fn',
      'AWS::Logs::LogGroup',
      'Arn'
    );

    expect(result).toBe('arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/my-fn:*');
  });

  it('returns undefined for unknown attribute (no STS call)', async () => {
    const result = await provider.getAttribute(
      '/aws/lambda/my-fn',
      'AWS::Logs::LogGroup',
      'Unknown'
    );

    expect(result).toBeUndefined();
    expect(mockStsSend).not.toHaveBeenCalled();
  });
});
