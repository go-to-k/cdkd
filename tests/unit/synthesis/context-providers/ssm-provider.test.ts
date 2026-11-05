import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Mock AWS SDK
const mockSend = vi.fn();
const mockDestroy = vi.fn();
vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: vi.fn().mockImplementation(() => ({
    send: mockSend,
    destroy: mockDestroy,
  })),
  GetParameterCommand: vi.fn().mockImplementation((input) => ({
    ...input,
    _type: 'GetParameterCommand',
  })),
}));

// Mock logger
vi.mock('../../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

import { SSMContextProvider } from '../../../../src/synthesis/context-providers/ssm-provider.js';

describe('SSMContextProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return SSM parameter value', async () => {
    mockSend.mockResolvedValue({
      Parameter: {
        Name: '/my/param',
        Value: 'my-value',
      },
    });

    const provider = new SSMContextProvider({ region: 'us-east-1' });
    const result = await provider.resolve({ parameterName: '/my/param' });

    expect(result).toBe('my-value');
    expect(mockDestroy).toHaveBeenCalled();
  });

  it('should throw when parameterName not provided', async () => {
    const provider = new SSMContextProvider({ region: 'us-east-1' });

    await expect(provider.resolve({})).rejects.toThrow(
      'SSM context provider requires parameterName property'
    );
  });

  it('should throw when parameter not found', async () => {
    mockSend.mockResolvedValue({
      Parameter: undefined,
    });

    const provider = new SSMContextProvider({ region: 'us-east-1' });

    await expect(
      provider.resolve({ parameterName: '/nonexistent/param' })
    ).rejects.toThrow('SSM parameter not found: /nonexistent/param');
  });

  it('should throw when parameter value is undefined', async () => {
    mockSend.mockResolvedValue({
      Parameter: {
        Name: '/my/param',
        Value: undefined,
      },
    });

    const provider = new SSMContextProvider({ region: 'us-east-1' });

    await expect(
      provider.resolve({ parameterName: '/my/param' })
    ).rejects.toThrow('SSM parameter not found: /my/param');
  });

  it('should return dummyValue when ignoreErrorOnMissingContext is true and parameter missing', async () => {
    mockSend.mockResolvedValue({
      Parameter: undefined,
    });

    const provider = new SSMContextProvider({ region: 'us-east-1' });
    const result = await provider.resolve({
      parameterName: '/nonexistent/param',
      ignoreErrorOnMissingContext: true,
      dummyValue: 'fallback-value',
    });

    expect(result).toBe('fallback-value');
  });

  it('should throw when ignoreErrorOnMissingContext is true but dummyValue is not set', async () => {
    mockSend.mockResolvedValue({
      Parameter: undefined,
    });

    const provider = new SSMContextProvider({ region: 'us-east-1' });

    await expect(
      provider.resolve({
        parameterName: '/nonexistent/param',
        ignoreErrorOnMissingContext: true,
      })
    ).rejects.toThrow('SSM parameter not found: /nonexistent/param');
  });

  // `GetParameter` THROWS `ParameterNotFound` for an absent parameter; the
  // empty-response cases above are not what AWS returns (go-to-k/cdkd#5805).
  function parameterNotFound(): Error {
    return Object.assign(new Error('ParameterNotFound'), { name: 'ParameterNotFound' });
  }

  it('returns dummyValue when GetParameter throws ParameterNotFound and ignoreErrorOnMissingContext is set', async () => {
    mockSend.mockRejectedValueOnce(parameterNotFound());

    const provider = new SSMContextProvider({ region: 'us-east-1' });
    const result = await provider.resolve({
      parameterName: '/ecr/repo/latest-image-tag',
      ignoreErrorOnMissingContext: true,
      dummyValue: 'latest',
    });

    expect(result).toBe('latest');
    expect(mockDestroy).toHaveBeenCalled();
  });

  it('reports ParameterNotFound as not-found when ignoreErrorOnMissingContext is absent', async () => {
    mockSend.mockRejectedValueOnce(parameterNotFound());

    const provider = new SSMContextProvider({ region: 'us-east-1' });
    await expect(
      provider.resolve({ parameterName: '/nonexistent/param', dummyValue: 'latest' })
    ).rejects.toThrow('SSM parameter not found: /nonexistent/param');
  });

  it('rethrows any other GetParameter failure even with ignoreErrorOnMissingContext set', async () => {
    const denied = Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });
    mockSend.mockRejectedValueOnce(denied);

    const provider = new SSMContextProvider({ region: 'us-east-1' });
    await expect(
      provider.resolve({
        parameterName: '/p',
        ignoreErrorOnMissingContext: true,
        dummyValue: 'latest',
      })
    ).rejects.toBe(denied);
    expect(mockDestroy).toHaveBeenCalled();
  });

  it('should use region from props over awsConfig', async () => {
    mockSend.mockResolvedValue({
      Parameter: { Name: '/p', Value: 'v' },
    });

    const { SSMClient } = await import('@aws-sdk/client-ssm');

    const provider = new SSMContextProvider({ region: 'us-east-1' });
    await provider.resolve({
      parameterName: '/p',
      region: 'eu-west-1',
    });

    expect(SSMClient).toHaveBeenCalledWith({ region: 'eu-west-1' });
  });
});
