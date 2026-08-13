import { describe, it, expect, vi, beforeEach, afterAll } from 'vite-plus/test';

// Mock AWS clients before importing the provider
const mockLogsSend = vi.fn();
const mockStsSend = vi.fn();

// Mutable so a test can drive the client's region (issue #1815 partition
// derivation). Reset to `us-east-1` in `beforeEach`.
const clientRegion = vi.hoisted(() => ({ value: 'us-east-1' as string | undefined }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudWatchLogs: {
      send: mockLogsSend,
      config: { region: () => Promise.resolve(clientRegion.value) },
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
  const originalAwsRegion = process.env['AWS_REGION'];

  afterAll(() => {
    if (originalAwsRegion === undefined) delete process.env['AWS_REGION'];
    else process.env['AWS_REGION'] = originalAwsRegion;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    clientRegion.value = 'us-east-1';
    delete process.env['AWS_REGION'];
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

  // Issue #1815: `buildArn` hardcoded `arn:aws:`, so outside the commercial
  // partition it recorded a structurally-valid but WRONG ARN into state and
  // served it as the `Arn` attribute — nothing downstream rejects it.
  describe('partition derivation (issue #1815)', () => {
    it('uses the aws-cn partition for a cn- region', async () => {
      clientRegion.value = 'cn-north-1';
      mockStsSend.mockResolvedValueOnce({ Account: '123456789012' });

      const result = await provider.getAttribute('/aws/lambda/my-fn', 'AWS::Logs::LogGroup', 'Arn');

      expect(result).toBe('arn:aws-cn:logs:cn-north-1:123456789012:log-group:/aws/lambda/my-fn:*');
    });

    it('uses the aws-us-gov partition for a us-gov- region', async () => {
      clientRegion.value = 'us-gov-west-1';
      mockStsSend.mockResolvedValueOnce({ Account: '123456789012' });

      const result = await provider.getAttribute('/aws/lambda/my-fn', 'AWS::Logs::LogGroup', 'Arn');

      expect(result).toBe(
        'arn:aws-us-gov:logs:us-gov-west-1:123456789012:log-group:/aws/lambda/my-fn:*'
      );
    });

    // The safety half of the pair: without a non-commercial account to test
    // against, "commercial output is unchanged byte for byte" is what makes
    // the change provably non-breaking.
    it('leaves a commercial region byte-identical to the pre-fix output', async () => {
      clientRegion.value = 'ap-northeast-1';
      mockStsSend.mockResolvedValueOnce({ Account: '123456789012' });

      const result = await provider.getAttribute('/aws/lambda/my-fn', 'AWS::Logs::LogGroup', 'Arn');

      expect(result).toBe(
        'arn:aws:logs:ap-northeast-1:123456789012:log-group:/aws/lambda/my-fn:*'
      );
    });

    it('derives the placeholder ARN partition from AWS_REGION when STS fails', async () => {
      process.env['AWS_REGION'] = 'cn-northwest-1';
      mockStsSend.mockRejectedValueOnce(new Error('STS unreachable'));

      const result = await provider.getAttribute('/aws/lambda/my-fn', 'AWS::Logs::LogGroup', 'Arn');

      expect(result).toBe('arn:aws-cn:logs:unknown:unknown:log-group:/aws/lambda/my-fn:*');
    });

    it('keeps the commercial placeholder ARN when STS fails with no AWS_REGION', async () => {
      mockStsSend.mockRejectedValueOnce(new Error('STS unreachable'));

      const result = await provider.getAttribute('/aws/lambda/my-fn', 'AWS::Logs::LogGroup', 'Arn');

      expect(result).toBe('arn:aws:logs:unknown:unknown:log-group:/aws/lambda/my-fn:*');
    });
  });
});
