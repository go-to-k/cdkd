// issue #1160: absent-field removal reset to CFn defaults (lambda-url batch).
// UpdateFunctionUrlConfig uses merge semantics (live-probed 2026-07-27: an
// update omitting InvokeMode / Cors retains the live values), so a field
// DROPPED from the template must be sent as its explicit clear shape —
// InvokeMode -> 'BUFFERED' (the documented default), Cors -> {} (an empty
// Cors object clears CORS entirely) — else the old live value silently
// persists.
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { UpdateFunctionUrlConfigCommand } from '@aws-sdk/client-lambda';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { LambdaUrlProvider } from '../../../src/provisioning/providers/lambda-url-provider.js';

const FN_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:my-function';

describe('LambdaUrlProvider removal reset to CFn defaults (issue #1160)', () => {
  let provider: LambdaUrlProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({
      FunctionUrl: 'https://abc.lambda-url.us-east-1.on.aws/',
      FunctionArn: FN_ARN,
    });
    provider = new LambdaUrlProvider();
  });

  function sentUpdateInput(): Record<string, unknown> {
    expect(mockSend).toHaveBeenCalledTimes(1);
    const cmd = mockSend.mock.calls[0]?.[0] as UpdateFunctionUrlConfigCommand;
    expect(cmd).toBeInstanceOf(UpdateFunctionUrlConfigCommand);
    return cmd.input as unknown as Record<string, unknown>;
  }

  it('resets removed InvokeMode and Cors to their clear shapes', async () => {
    await provider.update(
      'MyUrl',
      FN_ARN,
      'AWS::Lambda::Url',
      { TargetFunctionArn: FN_ARN, AuthType: 'NONE' },
      {
        TargetFunctionArn: FN_ARN,
        AuthType: 'NONE',
        InvokeMode: 'RESPONSE_STREAM',
        Cors: { AllowOrigins: ['*'], MaxAge: 5 },
      }
    );

    const input = sentUpdateInput();
    expect(input['InvokeMode']).toBe('BUFFERED');
    expect(input['Cors']).toEqual({});
  });

  it('leaves never-present fields absent (no spurious reset)', async () => {
    await provider.update(
      'MyUrl',
      FN_ARN,
      'AWS::Lambda::Url',
      { TargetFunctionArn: FN_ARN, AuthType: 'AWS_IAM' },
      { TargetFunctionArn: FN_ARN, AuthType: 'NONE' }
    );

    const input = sentUpdateInput();
    expect('InvokeMode' in input).toBe(false);
    expect('Cors' in input).toBe(false);
  });

  it('passes kept fields through while resetting only the removed one', async () => {
    await provider.update(
      'MyUrl',
      FN_ARN,
      'AWS::Lambda::Url',
      { TargetFunctionArn: FN_ARN, AuthType: 'NONE', InvokeMode: 'RESPONSE_STREAM' },
      {
        TargetFunctionArn: FN_ARN,
        AuthType: 'NONE',
        InvokeMode: 'RESPONSE_STREAM',
        Cors: { AllowOrigins: ['https://example.com'] },
      }
    );

    const input = sentUpdateInput();
    expect(input['InvokeMode']).toBe('RESPONSE_STREAM');
    expect(input['Cors']).toEqual({});
  });

  it('clears CORS when the new side is the all-empty readCurrentState placeholder', async () => {
    // drift --revert round-trips the placeholder shape; with real previous
    // CORS it must still clear rather than silently keep the live config.
    await provider.update(
      'MyUrl',
      FN_ARN,
      'AWS::Lambda::Url',
      {
        TargetFunctionArn: FN_ARN,
        AuthType: 'NONE',
        Cors: { AllowOrigins: [], AllowMethods: [], AllowHeaders: [], ExposeHeaders: [] },
      },
      {
        TargetFunctionArn: FN_ARN,
        AuthType: 'NONE',
        Cors: { AllowOrigins: ['*'] },
      }
    );

    const input = sentUpdateInput();
    expect(input['Cors']).toEqual({});
  });

  it('does not send a clear when the previous side was only the empty placeholder', async () => {
    // Placeholder-empty previous means "no CORS was ever configured" — a
    // removal must not manufacture a clear call for it.
    await provider.update(
      'MyUrl',
      FN_ARN,
      'AWS::Lambda::Url',
      { TargetFunctionArn: FN_ARN, AuthType: 'AWS_IAM' },
      {
        TargetFunctionArn: FN_ARN,
        AuthType: 'NONE',
        Cors: { AllowOrigins: [], AllowMethods: [], AllowHeaders: [], ExposeHeaders: [] },
      }
    );

    const input = sentUpdateInput();
    expect('Cors' in input).toBe(false);
  });

  it('keeps the diff-based no-op guard: identical properties issue no AWS call', async () => {
    const props = {
      TargetFunctionArn: FN_ARN,
      AuthType: 'NONE',
      InvokeMode: 'RESPONSE_STREAM',
      Cors: { AllowOrigins: ['*'] },
    };
    const result = await provider.update('MyUrl', FN_ARN, 'AWS::Lambda::Url', props, {
      ...props,
    });

    expect(mockSend).not.toHaveBeenCalled();
    expect(result.physicalId).toBe(FN_ARN);
  });
});
