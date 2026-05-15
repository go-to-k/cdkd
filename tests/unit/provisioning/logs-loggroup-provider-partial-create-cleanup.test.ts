import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, warnSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warnSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudWatchLogs: {
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
    sts: {
      send: vi.fn(() => Promise.resolve({ Account: '123456789012' })),
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { LogsLogGroupProvider } from '../../../src/provisioning/providers/logs-loggroup-provider.js';

const RESOURCE_TYPE = 'AWS::Logs::LogGroup';

describe('LogsLogGroupProvider partial-create cleanup (Issue #376)', () => {
  let provider: LogsLogGroupProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new LogsLogGroupProvider();
  });

  it('issues DeleteLogGroupCommand when PutRetentionPolicyCommand fails after CreateLogGroup succeeded', async () => {
    mockSend.mockResolvedValueOnce({}); // CreateLogGroupCommand
    mockSend.mockRejectedValueOnce(new Error('PutRetentionPolicy boom'));
    mockSend.mockResolvedValueOnce({}); // DeleteLogGroupCommand cleanup

    await expect(
      provider.create('MyLG', RESOURCE_TYPE, {
        LogGroupName: '/cdkd/my-log-group',
        RetentionInDays: 7,
      })
    ).rejects.toThrow('Failed to create log group');

    const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
    expect(names).toEqual([
      'CreateLogGroupCommand',
      'PutRetentionPolicyCommand',
      'DeleteLogGroupCommand',
    ]);
    expect(mockSend.mock.calls[2][0].input).toEqual({ logGroupName: '/cdkd/my-log-group' });
  });

  it('does NOT issue DeleteLogGroupCommand when CreateLogGroup hit ResourceAlreadyExistsException (pre-existing LG)', async () => {
    // Use the real SDK error class so `instanceof` matches inside the
    // provider. Import lazily to avoid hoisting issues.
    const { ResourceAlreadyExistsException: SdkExc } = await import(
      '@aws-sdk/client-cloudwatch-logs'
    );
    const alreadyExists = new SdkExc({
      message: 'already exists',
      $metadata: {},
    });
    mockSend.mockRejectedValueOnce(alreadyExists);
    mockSend.mockRejectedValueOnce(new Error('PutRetentionPolicy boom'));

    await expect(
      provider.create('MyLG', RESOURCE_TYPE, {
        LogGroupName: '/cdkd/my-log-group',
        RetentionInDays: 7,
      })
    ).rejects.toThrow('Failed to create log group');

    const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
    expect(names).not.toContain('DeleteLogGroupCommand');
  });

  it('does NOT issue DeleteLogGroupCommand when CreateLogGroup itself fails with a non-AlreadyExists error', async () => {
    mockSend.mockRejectedValueOnce(new Error('CreateLogGroup boom'));

    await expect(
      provider.create('MyLG', RESOURCE_TYPE, {
        LogGroupName: '/cdkd/my-log-group',
      })
    ).rejects.toThrow('Failed to create log group');

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].constructor.name).toBe('CreateLogGroupCommand');
  });

  it('re-throws the original error even when DeleteLogGroupCommand cleanup itself fails', async () => {
    mockSend.mockResolvedValueOnce({}); // CreateLogGroupCommand
    mockSend.mockRejectedValueOnce(new Error('PutRetentionPolicy boom (original)'));
    mockSend.mockRejectedValueOnce(new Error('DeleteLogGroup also failed'));

    await expect(
      provider.create('MyLG', RESOURCE_TYPE, {
        LogGroupName: '/cdkd/my-log-group',
        RetentionInDays: 7,
      })
    ).rejects.toThrow('PutRetentionPolicy boom (original)');

    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = String(warnSpy.mock.calls[0][0]);
    expect(warnMsg).toContain('aws logs delete-log-group --log-group-name');
    expect(warnMsg).toContain('/cdkd/my-log-group');
  });
});
