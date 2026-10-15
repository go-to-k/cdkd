import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, warnSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warnSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ssm: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    // Explicit `sts` (issue 1824). `SSMParameterProvider.create` / `update` now
    // build the `Arn` attribute through `getAccountInfo`, which reads
    // `getAwsClients().sts` — so a mock omitting it made `stsClient.send` throw,
    // silently routing every create in this file through the FABRICATED-account
    // arm (a `logger.warn` per create, and no `Arn` recorded). Nothing here
    // asserts on the account, so the point is only to keep these suites on the
    // intended path rather than on an unrelated degraded one.
    sts: { send: () => Promise.resolve({ Account: '111122223333' }) },
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

  // go-to-k/cdkd#4971: the tags ride on PutParameter, so a tagged create has
  // no post-create call left whose failure would need a cleanup.
  it('sends a tagged create as one PutParameter carrying the tags (nothing can fail after it)', async () => {
    mockSend.mockResolvedValueOnce({}); // PutParameterCommand

    await provider.create('MyParam', RESOURCE_TYPE, {
      Name: '/foo/bar',
      Type: 'String',
      Value: 'baz',
      Tags: [{ Key: 'k', Value: 'v' }],
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].constructor.name).toBe('PutParameterCommand');
    expect(mockSend.mock.calls[0][0].input).toMatchObject({
      Overwrite: false,
      Tags: [{ Key: 'k', Value: 'v' }],
    });
    expect(warnSpy).not.toHaveBeenCalled();
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
});
