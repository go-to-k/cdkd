import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ssm: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    sts: { send: () => Promise.resolve({ Account: '111122223333' }) },
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

import { SSMParameterProvider } from '../../../src/provisioning/providers/ssm-parameter-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';

const RESOURCE_TYPE = 'AWS::SSM::Parameter';
const NAME = '/cdkd/my-param';
const PROPS = { Name: NAME, Value: 'v', Tags: { team: 'core' } };

async function createError(
  provider: SSMParameterProvider,
  properties: Record<string, unknown> = PROPS
): Promise<unknown> {
  try {
    await provider.create('MyParam', RESOURCE_TYPE, properties);
  } catch (error) {
    return error;
  }
  throw new Error('create() did not throw');
}

describe('SSMParameterProvider created-before-failure mark (go-to-k/cdkd#4583)', () => {
  let provider: SSMParameterProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new SSMParameterProvider();
  });

  // go-to-k/cdkd#4971: the tags ride on PutParameter, so no call follows it
  // that could fail and leave the parameter behind for the mark to name.
  it('sends no call after PutParameter for a tagged create', async () => {
    mockSend.mockResolvedValueOnce({}); // PutParameter

    await provider.create('MyParam', RESOURCE_TYPE, PROPS);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0]![0].input.Tags).toEqual([{ Key: 'team', Value: 'core' }]);
  });

  it('does not mark when PutParameter itself failed', async () => {
    mockSend.mockRejectedValueOnce(new Error('ParameterAlreadyExists: already exists'));

    const error = await createError(provider);
    expect(error).toBeInstanceOf(Error);
    expect(createdBeforeFailure(error, 'MyParam', RESOURCE_TYPE)).toBeUndefined();
  });

  it('does not mark a pre-flight refusal (no Value)', async () => {
    const error = await createError(provider, { Name: NAME });
    expect(error).toBeInstanceOf(Error);
    expect(mockSend).not.toHaveBeenCalled();
    expect(createdBeforeFailure(error, 'MyParam', RESOURCE_TYPE)).toBeUndefined();
  });
});
