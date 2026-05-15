import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, warnSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warnSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ssm: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { SSMParameterProvider } from '../../../src/provisioning/providers/ssm-parameter-provider.js';

const RESOURCE_TYPE = 'AWS::SSM::Parameter';

describe('SSMParameterProvider partial-create cleanup (Issue #376)', () => {
  let provider: SSMParameterProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new SSMParameterProvider();
  });

  it('issues DeleteParameterCommand when AddTagsToResourceCommand fails after PutParameter succeeded', async () => {
    mockSend.mockResolvedValueOnce({}); // PutParameterCommand
    mockSend.mockRejectedValueOnce(new Error('AddTags boom')); // AddTagsToResourceCommand
    mockSend.mockResolvedValueOnce({}); // DeleteParameterCommand cleanup

    await expect(
      provider.create('MyParam', RESOURCE_TYPE, {
        Name: '/foo/bar',
        Type: 'String',
        Value: 'baz',
        Tags: [{ Key: 'k', Value: 'v' }],
      })
    ).rejects.toThrow('Failed to create SSM parameter');

    expect(mockSend).toHaveBeenCalledTimes(3);
    const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
    expect(names).toEqual([
      'PutParameterCommand',
      'AddTagsToResourceCommand',
      'DeleteParameterCommand',
    ]);
    expect(mockSend.mock.calls[2][0].input).toEqual({ Name: '/foo/bar' });
  });

  it('does NOT issue DeleteParameterCommand when PutParameter itself fails (nothing to clean up)', async () => {
    mockSend.mockRejectedValueOnce(new Error('PutParameter boom'));

    await expect(
      provider.create('MyParam', RESOURCE_TYPE, {
        Name: '/foo/bar',
        Type: 'String',
        Value: 'baz',
        Tags: [{ Key: 'k', Value: 'v' }],
      })
    ).rejects.toThrow('Failed to create SSM parameter');

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].constructor.name).toBe('PutParameterCommand');
  });

  it('re-throws the original AddTags error even when DeleteParameterCommand cleanup itself fails', async () => {
    mockSend.mockResolvedValueOnce({}); // PutParameterCommand
    mockSend.mockRejectedValueOnce(new Error('AddTags boom (original)')); // AddTagsToResourceCommand
    mockSend.mockRejectedValueOnce(new Error('DeleteParameter also failed')); // DeleteParameterCommand cleanup

    await expect(
      provider.create('MyParam', RESOURCE_TYPE, {
        Name: '/foo/bar',
        Type: 'String',
        Value: 'baz',
        Tags: [{ Key: 'k', Value: 'v' }],
      })
    ).rejects.toThrow('AddTags boom (original)');

    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = String(warnSpy.mock.calls[0][0]);
    expect(warnMsg).toContain('aws ssm delete-parameter --name');
    expect(warnMsg).toContain('/foo/bar');
  });

  it('does NOT issue cleanup when no Tags property is supplied (nothing can fail post-PutParameter)', async () => {
    mockSend.mockResolvedValueOnce({}); // PutParameterCommand

    await provider.create('MyParam', RESOURCE_TYPE, {
      Name: '/foo/bar',
      Type: 'String',
      Value: 'baz',
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].constructor.name).toBe('PutParameterCommand');
  });
});
