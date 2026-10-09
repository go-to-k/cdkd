import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

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

import { ResourceAlreadyExistsException } from '@aws-sdk/client-cloudwatch-logs';
import { LogsLogGroupProvider } from '../../../src/provisioning/providers/logs-loggroup-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import { provenNothingCreated } from '../../../src/deployment/generated-name-guard.js';

const RESOURCE_TYPE = 'AWS::Logs::LogGroup';
const NAME = '/cdkd/my-log-group';
const PROPS = { LogGroupName: NAME, RetentionInDays: 7 };

async function createError(
  provider: LogsLogGroupProvider,
  properties: Record<string, unknown> = PROPS
): Promise<unknown> {
  try {
    await provider.create('MyLG', RESOURCE_TYPE, properties);
  } catch (error) {
    return error;
  }
  throw new Error('create() did not throw');
}

describe('LogsLogGroupProvider created-before-failure mark (go-to-k/cdkd#4583)', () => {
  let provider: LogsLogGroupProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new LogsLogGroupProvider();
  });

  it('marks the log group name when the wiring failed and the cleanup delete failed', async () => {
    mockSend.mockResolvedValueOnce({}); // CreateLogGroup
    mockSend.mockRejectedValueOnce(new Error('PutRetentionPolicy boom'));
    mockSend.mockRejectedValueOnce(new Error('DeleteLogGroup boom'));

    const error = await createError(provider);
    expect(createdBeforeFailure(error, 'MyLG', RESOURCE_TYPE)).toBe(NAME);
  });

  it('go-to-k/cdkd#4705 E-3: a 4xx on the wiring with the log group left behind keeps the intent', async () => {
    mockSend.mockResolvedValueOnce({}); // CreateLogGroup
    mockSend.mockRejectedValueOnce(Object.assign(new Error('ValidationException: bad input'), { name: 'ValidationException', $metadata: { httpStatusCode: 400 } }));
    mockSend.mockRejectedValueOnce(new Error('DeleteLogGroup boom'));
    const error = await createError(provider);
    expect(provenNothingCreated(error, 'MyLG', RESOURCE_TYPE)).toBe(false);
  });

  it('does not mark when the cleanup deleted the log group', async () => {
    mockSend.mockResolvedValueOnce({}); // CreateLogGroup
    mockSend.mockRejectedValueOnce(new Error('PutRetentionPolicy boom'));
    mockSend.mockResolvedValueOnce({}); // DeleteLogGroup

    const error = await createError(provider);
    expect(error).toBeInstanceOf(Error);
    expect(createdBeforeFailure(error, 'MyLG', RESOURCE_TYPE)).toBeUndefined();
  });

  it('does not mark a pre-existing log group the create adopted (cleanup skipped)', async () => {
    mockSend.mockRejectedValueOnce(
      new ResourceAlreadyExistsException({ message: 'already exists', $metadata: {} })
    );
    mockSend.mockRejectedValueOnce(new Error('PutRetentionPolicy boom'));

    const error = await createError(provider);
    expect(error).toBeInstanceOf(Error);
    expect(mockSend.mock.calls.map((c) => c[0].constructor.name)).not.toContain(
      'DeleteLogGroupCommand'
    );
    expect(createdBeforeFailure(error, 'MyLG', RESOURCE_TYPE)).toBeUndefined();
  });

  it('does not mark when CreateLogGroup itself failed', async () => {
    mockSend.mockRejectedValueOnce(new Error('AccessDenied'));

    const error = await createError(provider);
    expect(error).toBeInstanceOf(Error);
    expect(createdBeforeFailure(error, 'MyLG', RESOURCE_TYPE)).toBeUndefined();
  });

  it('does not mark a pre-flight refusal (malformed Tags)', async () => {
    const error = await createError(provider, { LogGroupName: NAME, Tags: 'not-a-list' });
    expect(error).toBeInstanceOf(Error);
    expect(mockSend).not.toHaveBeenCalled();
    expect(createdBeforeFailure(error, 'MyLG', RESOURCE_TYPE)).toBeUndefined();
  });
});
