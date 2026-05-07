import { describe, it, expect, vi, beforeEach } from 'vitest';
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

const TARGET_FN_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:my-fn';

describe('LambdaUrlProvider read-update round-trip', () => {
  let provider: LambdaUrlProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new LambdaUrlProvider();
  });

  it('Class 2 — URL with no CORS does not send all-empty Cors to AWS on round-trip', async () => {
    // Mechanical guard for Class 2 placeholder regression on
    // structurally-incomplete-when-empty fields. See
    // docs/provider-development.md § 3b "Read-update round-trip test".
    //
    // `readCurrentState` always-emits a `Cors` placeholder with empty
    // arrays for every sub-list so a console-side CORS toggle on a URL
    // configured without CORS surfaces as drift. On `cdkd drift
    // --revert` that placeholder must NOT round-trip into AWS as
    // `Cors: { AllowOrigins: [], AllowMethods: [], ... }` — that would
    // configure CORS-with-empty-allowlists instead of leaving CORS unset.
    const observed = {
      TargetFunctionArn: TARGET_FN_ARN,
      AuthType: 'NONE',
      InvokeMode: 'BUFFERED',
      Cors: {
        AllowOrigins: [],
        AllowMethods: [],
        AllowHeaders: [],
        ExposeHeaders: [],
      },
    };

    // Force the diff-based no-op gate open by changing one harmless
    // field, so we can inspect the actual UpdateFunctionUrlConfigCommand
    // payload that would be sent to AWS.
    const next = { ...observed, AuthType: 'AWS_IAM' };

    mockSend.mockResolvedValueOnce({
      FunctionUrl: 'https://abc.lambda-url.us-east-1.on.aws/',
      FunctionArn: TARGET_FN_ARN,
    });

    await provider.update('L', TARGET_FN_ARN, 'AWS::Lambda::Url', next, observed);

    const updateCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof UpdateFunctionUrlConfigCommand
    );
    expect(updateCalls).toHaveLength(1);
    const input = updateCalls[0]?.[0].input as { Cors?: unknown };
    // Class 2: an all-empty Cors must NOT reach AWS — it's the read-side
    // "no CORS configured" placeholder, not a real CORS configuration.
    expect(input.Cors).toBeUndefined();
  });

  it('round-trip on no-drift snapshot is a logical no-op (zero UpdateFunctionUrlConfigCommand calls)', async () => {
    // Stronger assertion for the diff-based no-op gate: state == AWS
    // implies update() must make no AWS-side mutations, so `cdkd drift
    // --revert` on a no-drift resource cannot accidentally clobber the
    // URL config.
    const observed = {
      TargetFunctionArn: TARGET_FN_ARN,
      AuthType: 'AWS_IAM',
      InvokeMode: 'BUFFERED',
      Cors: {
        AllowOrigins: [],
        AllowMethods: [],
        AllowHeaders: [],
        ExposeHeaders: [],
      },
    };

    await provider.update('L', TARGET_FN_ARN, 'AWS::Lambda::Url', observed, observed);

    const updateCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof UpdateFunctionUrlConfigCommand
    );
    expect(updateCalls).toHaveLength(0);
  });

  it('URL with CORS configured: round-trip preserves CORS fields without rejection', async () => {
    // The complement of the no-CORS test: a URL with real CORS
    // configured must round-trip through update() with the CORS payload
    // intact. Catches the over-eager Class 2 sanitize regression
    // (dropping legitimate non-empty arrays).
    const observed = {
      TargetFunctionArn: TARGET_FN_ARN,
      AuthType: 'NONE',
      InvokeMode: 'BUFFERED',
      Cors: {
        AllowOrigins: ['https://example.com'],
        AllowMethods: ['GET', 'POST'],
        AllowHeaders: ['Content-Type'],
        ExposeHeaders: [],
        MaxAge: 0,
        AllowCredentials: false,
      },
    };

    // Force the diff-based no-op gate open with a harmless field change.
    const next = { ...observed, AuthType: 'AWS_IAM' };

    mockSend.mockResolvedValueOnce({
      FunctionUrl: 'https://abc.lambda-url.us-east-1.on.aws/',
      FunctionArn: TARGET_FN_ARN,
    });

    await provider.update('L', TARGET_FN_ARN, 'AWS::Lambda::Url', next, observed);

    const updateCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof UpdateFunctionUrlConfigCommand
    );
    expect(updateCalls).toHaveLength(1);
    const input = updateCalls[0]?.[0].input as {
      Cors?: {
        AllowOrigins?: string[];
        AllowMethods?: string[];
        AllowHeaders?: string[];
        ExposeHeaders?: string[];
        MaxAge?: number;
        AllowCredentials?: boolean;
      };
    };
    expect(input.Cors).toBeDefined();
    expect(input.Cors?.AllowOrigins).toEqual(['https://example.com']);
    expect(input.Cors?.AllowMethods).toEqual(['GET', 'POST']);
    expect(input.Cors?.AllowHeaders).toEqual(['Content-Type']);
    // ExposeHeaders empty array is sanitized away (Class 2).
    expect(input.Cors?.ExposeHeaders).toBeUndefined();
    // Truthy-gate guard: MaxAge: 0 is a valid AWS input (= "do not
    // cache preflight responses") and must reach the AWS call.
    expect(input.Cors?.MaxAge).toBe(0);
    expect(input.Cors?.AllowCredentials).toBe(false);
  });
});
