import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { PutRetentionPolicyCommand } from '@aws-sdk/client-cloudwatch-logs';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudWatchLogs: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

const RESOURCE_TYPE = 'AWS::Logs::LogGroup';
const PHYSICAL_ID = '/cdkd/class-guard-test';

// LogGroupClass is documented by CloudFormation as "Update requires: Updates
// are not supported" and CloudWatch Logs has no API to change a log group's
// class after creation. cdkd previously silently DROPPED the change (deploy
// reported success while AWS kept the old class, and state recorded the new
// one so the next diff saw no change). The guard throws the typed
// ResourceUpdateNotSupportedError so the deploy fails actionably and
// `--replace` can recreate the log group under the new class.
describe('LogsLogGroupProvider LogGroupClass update guard', () => {
  let provider: LogsLogGroupProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    provider = new LogsLogGroupProvider();
  });

  it('throws ResourceUpdateNotSupportedError on a STANDARD -> INFREQUENT_ACCESS change, before any mutation', async () => {
    await expect(
      provider.update(
        'ClassLg',
        PHYSICAL_ID,
        RESOURCE_TYPE,
        { LogGroupClass: 'INFREQUENT_ACCESS', RetentionInDays: 1 },
        { LogGroupClass: 'STANDARD', RetentionInDays: 1 }
      )
    ).rejects.toMatchObject({ name: 'ResourceUpdateNotSupportedError' });

    // The guard must fire BEFORE any other mutation is applied.
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('treats an absent property as STANDARD (absent -> INFREQUENT_ACCESS throws)', async () => {
    await expect(
      provider.update('ClassLg', PHYSICAL_ID, RESOURCE_TYPE, { LogGroupClass: 'INFREQUENT_ACCESS' }, {})
    ).rejects.toThrow(ResourceUpdateNotSupportedError);
  });

  it('does NOT throw on an explicit-STANDARD <-> absent transition (both mean the default class)', async () => {
    await expect(
      provider.update('ClassLg', PHYSICAL_ID, RESOURCE_TYPE, {}, { LogGroupClass: 'STANDARD' })
    ).resolves.toBeDefined();
  });

  it('proceeds with unrelated updates when the class is unchanged', async () => {
    await provider.update(
      'ClassLg',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      { LogGroupClass: 'INFREQUENT_ACCESS', RetentionInDays: 7 },
      { LogGroupClass: 'INFREQUENT_ACCESS', RetentionInDays: 1 }
    );

    const retention = mockSend.mock.calls.find(
      (c) => c[0] instanceof PutRetentionPolicyCommand
    );
    expect(retention).toBeDefined();
  });

  it('carries the actionable --replace suggestion in the message', async () => {
    const err = await provider
      .update(
        'ClassLg',
        PHYSICAL_ID,
        RESOURCE_TYPE,
        { LogGroupClass: 'INFREQUENT_ACCESS' },
        { LogGroupClass: 'STANDARD' }
      )
      .catch((e: Error) => e);
    expect((err as Error).message).toMatch(/--replace/);
    expect((err as Error).message).toMatch(/'STANDARD' -> 'INFREQUENT_ACCESS'/);
  });
});
