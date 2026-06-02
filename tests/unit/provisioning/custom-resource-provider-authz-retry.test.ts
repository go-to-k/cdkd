import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// Transient-IAM-authorization retry behaviour for the Custom Resource provider.
// Kept in its own file (command-name dispatch rather than the main suite's
// ordered mockResolvedValueOnce queues) because the retry path spans multiple
// invocation attempts + an execution-environment recycle.
const mockLambdaSend = vi.fn();
const mockSnsSend = vi.fn();
const mockS3Send = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockLambdaSend },
    sns: { send: mockSnsSend },
    s3: { send: mockS3Send },
  }),
}));

const warnSpy = vi.fn();
vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => warnSpy(...args),
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

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://s3.example.com/presigned-url'),
}));

import { CustomResourceProvider } from '../../../src/provisioning/providers/custom-resource-provider.js';

const SERVICE_TOKEN =
  'arn:aws:lambda:us-east-1:123456789012:function:Stack-ProviderframeworkonEvent';
const AUTHZ_REASON =
  'TimeoutError: {"state":"TIMEOUT","observedResponses":{"403: User: arn:aws:sts::123456789012:assumed-role/Stack-ProviderframeworkonEventRole/Stack-ProviderframeworkonEvent is not authorized to perform: lambda:GetFunction on resource: arn:aws:lambda:us-east-1:123456789012:function:Stack-OnEvent because no identity-based policy allows the lambda:GetFunction action":10},"reason":"Waiter has timed out"}';

interface RetryProbe {
  isTransientAuthzFailure(reason: string | undefined): boolean;
}

/**
 * Wire all AWS commands by name. The async (Provider-framework) pattern is
 * used: invoke returns null, then cdkd polls S3 for the cfn-response. The S3
 * GetObject body is driven by how many times the backing function has been
 * invoked so far — attempt 1 returns the supplied `firstStatus` response,
 * attempt 2+ returns SUCCESS.
 */
function wireAsyncFlow(firstResponse: object): { invokes: () => number; updates: () => number } {
  let invokeCount = 0;
  let updateCount = 0;
  mockS3Send.mockImplementation((cmd: { constructor: { name: string } }) => {
    const name = cmd.constructor.name;
    if (name === 'GetObjectCommand') {
      const body = invokeCount >= 2
        ? { Status: 'SUCCESS', PhysicalResourceId: 'phys-123', Data: { Out: 'ok' } }
        : firstResponse;
      return Promise.resolve({ Body: { transformToString: () => Promise.resolve(JSON.stringify(body)) } });
    }
    return Promise.resolve({}); // PutObject / DeleteObject
  });
  mockLambdaSend.mockImplementation((cmd: { constructor: { name: string } }) => {
    const name = cmd.constructor.name;
    if (name === 'InvokeCommand') {
      invokeCount += 1;
      return Promise.resolve({ Payload: Buffer.from('null') }); // async pattern
    }
    if (name === 'UpdateFunctionConfigurationCommand') {
      updateCount += 1;
      return Promise.resolve({});
    }
    // GetFunction/GetFunctionConfiguration for the readiness + recycle waiters.
    return Promise.resolve({
      Configuration: { State: 'Active', LastUpdateStatus: 'Successful' },
    });
  });
  return { invokes: () => invokeCount, updates: () => updateCount };
}

function makeProvider(): CustomResourceProvider {
  return new CustomResourceProvider({ responseBucket: 'test-bucket', asyncResponseTimeoutMs: 10_000 });
}

describe('CustomResourceProvider transient-IAM-authz retry', () => {
  beforeEach(() => {
    mockLambdaSend.mockReset();
    mockSnsSend.mockReset();
    mockS3Send.mockReset();
    warnSpy.mockReset();
    process.env['CDKD_CR_AUTHZ_MAX_RETRIES'] = '2';
  });
  afterEach(() => {
    delete process.env['CDKD_CR_AUTHZ_MAX_RETRIES'];
  });

  it('retries (recycling the backing fn) after a transient-authz FAILED, then succeeds', async () => {
    const counts = wireAsyncFlow({ Status: 'FAILED', Reason: AUTHZ_REASON });
    const provider = makeProvider();

    const result = await provider.create('AsyncResource', 'Custom::AsyncResource', {
      ServiceToken: SERVICE_TOKEN,
    });

    expect(result.physicalId).toBe('phys-123');
    expect(counts.invokes()).toBe(2); // first attempt failed (403), second succeeded
    expect(counts.updates()).toBe(1); // exec-env recycled once between attempts
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('transient IAM-authorization FAILED');
  });

  it('does NOT retry a non-authz FAILED (e.g. a real handler timeout) — throws on first attempt', async () => {
    const counts = wireAsyncFlow({ Status: 'FAILED', Reason: 'Operation timed out' });
    const provider = makeProvider();

    await expect(
      provider.create('AsyncResource', 'Custom::AsyncResource', { ServiceToken: SERVICE_TOKEN })
    ).rejects.toThrow('Custom resource handler returned FAILED: Operation timed out');

    expect(counts.invokes()).toBe(1); // no retry
    expect(counts.updates()).toBe(0); // no recycle
  });

  it('gives up after CDKD_CR_AUTHZ_MAX_RETRIES and throws the FAILED reason', async () => {
    // Never succeeds: GetObject always returns the transient-authz FAILED.
    let invokeCount = 0;
    let updateCount = 0;
    mockS3Send.mockImplementation((cmd: { constructor: { name: string } }) =>
      cmd.constructor.name === 'GetObjectCommand'
        ? Promise.resolve({
            Body: {
              transformToString: () =>
                Promise.resolve(JSON.stringify({ Status: 'FAILED', Reason: AUTHZ_REASON })),
            },
          })
        : Promise.resolve({})
    );
    mockLambdaSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor.name;
      if (name === 'InvokeCommand') {
        invokeCount += 1;
        return Promise.resolve({ Payload: Buffer.from('null') });
      }
      if (name === 'UpdateFunctionConfigurationCommand') {
        updateCount += 1;
        return Promise.resolve({});
      }
      return Promise.resolve({ Configuration: { State: 'Active', LastUpdateStatus: 'Successful' } });
    });

    const provider = makeProvider();
    await expect(
      provider.create('AsyncResource', 'Custom::AsyncResource', { ServiceToken: SERVICE_TOKEN })
    ).rejects.toThrow(/not authorized to perform/);

    expect(invokeCount).toBe(3); // 1 initial + 2 retries (CDKD_CR_AUTHZ_MAX_RETRIES=2)
    expect(updateCount).toBe(2); // recycled before each retry
  });

  it('does not retry at all when CDKD_CR_AUTHZ_MAX_RETRIES=0', async () => {
    process.env['CDKD_CR_AUTHZ_MAX_RETRIES'] = '0';
    const counts = wireAsyncFlow({ Status: 'FAILED', Reason: AUTHZ_REASON });
    const provider = makeProvider();

    await expect(
      provider.create('AsyncResource', 'Custom::AsyncResource', { ServiceToken: SERVICE_TOKEN })
    ).rejects.toThrow(/not authorized to perform/);
    expect(counts.invokes()).toBe(1);
    expect(counts.updates()).toBe(0);
  });
});

describe('isTransientAuthzFailure classification', () => {
  const probe = new CustomResourceProvider({ responseBucket: 't' }) as unknown as RetryProbe;

  it('matches the F2 framework 403 reason (not authorized / no identity-based policy)', () => {
    expect(probe.isTransientAuthzFailure(AUTHZ_REASON)).toBe(true);
    expect(probe.isTransientAuthzFailure('AccessDenied: Resource is not in the state functionActive')).toBe(true);
    expect(probe.isTransientAuthzFailure('Role arn:... cannot be assumed by ...')).toBe(true);
  });

  it('does NOT match generic / non-authz failures', () => {
    expect(probe.isTransientAuthzFailure('Operation timed out')).toBe(false);
    expect(probe.isTransientAuthzFailure('Too Many Requests')).toBe(false);
    expect(probe.isTransientAuthzFailure('TypeError: cannot read property foo of undefined')).toBe(false);
    expect(probe.isTransientAuthzFailure(undefined)).toBe(false);
    expect(probe.isTransientAuthzFailure('')).toBe(false);
  });
});
