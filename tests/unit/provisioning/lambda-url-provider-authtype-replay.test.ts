import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, childLogger } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  childLogger.child.mockReturnValue(childLogger);
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

const RESOURCE_TYPE = 'AWS::Lambda::Url';
const FN_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:my-fn';
const URL = 'https://abc123.lambda-url.us-east-1.on.aws/';

/**
 * `CreateContext.replayingState` downgrade for the create-path `AuthType`
 * pre-flight refusal (issue #1544).
 *
 * Before this fix `create()` did not declare the optional `context`
 * parameter, so a state record carrying a malformed `AuthType` (written by an
 * older binary) hard-threw on the rollback executor's reverse-replacement
 * replay — leaving the old function URL unrestorable with only a hand-edit of
 * state.json as a remedy. Modeled on the #1542 BillingMode suite.
 */
describe('LambdaUrlProvider malformed AuthType on a state replay (issue #1544)', () => {
  let provider: LambdaUrlProvider;

  beforeEach(() => {
    mockSend.mockReset();
    childLogger.warn.mockReset();
    provider = new LambdaUrlProvider();
  });

  const baseProps = { TargetFunctionArn: FN_ARN };

  const createSucceeds = () =>
    mockSend.mockResolvedValue({ FunctionUrl: URL, FunctionArn: FN_ARN });

  const commandNames = () => mockSend.mock.calls.map((c) => c[0].constructor.name);

  // ─── replayingState: true → warn, proceed with the default ─────────────

  it('WARNS instead of throwing when the create is a state replay', async () => {
    createSucceeds();

    const result = await provider.create(
      'MyUrl',
      RESOURCE_TYPE,
      { ...baseProps, AuthType: null },
      { replayingState: true }
    );

    expect(result.physicalId).toBe(FN_ARN);
    const createCall = mockSend.mock.calls.find(
      (c) => c[0].constructor.name === 'CreateFunctionUrlConfigCommand'
    );
    expect(createCall?.[0].input.AuthType).toBe('NONE');
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('AWS::Lambda::Url AuthType must be a non-empty string')
    );
  });

  it('leaves a VALID AuthType untouched on a state replay', async () => {
    createSucceeds();

    await provider.create(
      'MyUrl',
      RESOURCE_TYPE,
      { ...baseProps, AuthType: 'AWS_IAM' },
      { replayingState: true }
    );

    const createCall = mockSend.mock.calls.find(
      (c) => c[0].constructor.name === 'CreateFunctionUrlConfigCommand'
    );
    expect(createCall?.[0].input.AuthType).toBe('AWS_IAM');
    expect(childLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('AWS::Lambda::Url AuthType')
    );
  });

  // ─── replayingState absent / false / empty context → refusal stands ────

  it('keeps the refusal on an ordinary template-path create (no context)', async () => {
    createSucceeds();

    // A blank AuthType silently defaulting to NONE is a PUBLIC function URL —
    // the very reason this site was guarded in #1493. The refusal must stay
    // on every template-path create.
    await expect(
      provider.create('MyUrl', RESOURCE_TYPE, { ...baseProps, AuthType: '' })
    ).rejects.toThrow(/AWS::Lambda::Url AuthType must be a non-empty string \(got a blank string\)/);

    expect(commandNames()).not.toContain('CreateFunctionUrlConfigCommand');
  });

  it('keeps the refusal when the context carries replayingState: false', async () => {
    createSucceeds();

    await expect(
      provider.create(
        'MyUrl',
        RESOURCE_TYPE,
        { ...baseProps, AuthType: null },
        { replayingState: false }
      )
    ).rejects.toThrow(/AWS::Lambda::Url AuthType must be a non-empty string/);
    expect(commandNames()).not.toContain('CreateFunctionUrlConfigCommand');
  });

  it('keeps the refusal when the context is present but carries no replay flag', async () => {
    createSucceeds();

    // `replayWarn` tests `=== true`; an empty context bag is an ordinary
    // create.
    await expect(
      provider.create('MyUrl', RESOURCE_TYPE, { ...baseProps, AuthType: null }, {})
    ).rejects.toThrow(/AWS::Lambda::Url AuthType must be a non-empty string/);
  });

  it('still defaults an ABSENT AuthType to NONE on a plain create', async () => {
    createSucceeds();

    await provider.create('MyUrl', RESOURCE_TYPE, { ...baseProps });

    const createCall = mockSend.mock.calls.find(
      (c) => c[0].constructor.name === 'CreateFunctionUrlConfigCommand'
    );
    expect(createCall?.[0].input.AuthType).toBe('NONE');
    expect(childLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('AWS::Lambda::Url AuthType')
    );
  });
});
