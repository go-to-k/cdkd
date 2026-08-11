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

/**
 * The UPDATE-path half of the same guard (issue #1551).
 *
 * #1544 downgraded the create site and deliberately left `update()` strict,
 * recording the reason: downgrading it with the `'NONE'` create default would
 * silently flip a live IAM-guarded function URL to PUBLIC. The refusal still
 * strands a replay, though — `rollback-executor.ts` and `drift --revert` both
 * call `update(..., previousState.properties, ...)` — so the fix is the
 * keep-the-PREVIOUS-value design, not the default.
 */
describe('LambdaUrlProvider malformed AuthType on the UPDATE path (issue #1551)', () => {
  let provider: LambdaUrlProvider;

  beforeEach(() => {
    mockSend.mockReset();
    childLogger.warn.mockReset();
    mockSend.mockResolvedValue({ FunctionUrl: URL, FunctionArn: FN_ARN });
    provider = new LambdaUrlProvider();
  });

  const updateInput = (): Record<string, unknown> | undefined =>
    mockSend.mock.calls.find((c) => c[0].constructor.name === 'UpdateFunctionUrlConfigCommand')?.[0]
      .input as Record<string, unknown> | undefined;

  it('WARNS and keeps the PREVIOUS AuthType instead of throwing', async () => {
    await provider.update(
      'MyUrl',
      FN_ARN,
      RESOURCE_TYPE,
      { TargetFunctionArn: FN_ARN, AuthType: null, InvokeMode: 'RESPONSE_STREAM' },
      { TargetFunctionArn: FN_ARN, AuthType: 'AWS_IAM', InvokeMode: 'BUFFERED' }
    );

    // The load-bearing assertion: NOT 'NONE'. Defaulting here would make a
    // live IAM-guarded URL public with only a warning to show for it.
    expect(updateInput()?.['AuthType']).toBe('AWS_IAM');
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('AWS::Lambda::Url AuthType must be a non-empty string')
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('would make the URL public')
    );
  });

  it('OMITS AuthType entirely when the previous side is unusable too', async () => {
    // Both sides junk: there is no value to keep, so the field is left out of
    // the merge-semantics update and AWS retains whatever the URL has now.
    await provider.update(
      'MyUrl',
      FN_ARN,
      RESOURCE_TYPE,
      { TargetFunctionArn: FN_ARN, AuthType: '', InvokeMode: 'RESPONSE_STREAM' },
      { TargetFunctionArn: FN_ARN, AuthType: null, InvokeMode: 'BUFFERED' }
    );

    const input = updateInput();
    expect(input).toBeDefined();
    expect(input && 'AuthType' in input).toBe(false);
    expect(input?.['FunctionName']).toBe(FN_ARN);
  });

  it('sends a VALID desired AuthType unchanged', async () => {
    await provider.update(
      'MyUrl',
      FN_ARN,
      RESOURCE_TYPE,
      { TargetFunctionArn: FN_ARN, AuthType: 'AWS_IAM' },
      { TargetFunctionArn: FN_ARN, AuthType: 'NONE' }
    );

    expect(updateInput()?.['AuthType']).toBe('AWS_IAM');
    expect(childLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('AWS::Lambda::Url AuthType')
    );
  });

  it('still defaults an ABSENT desired AuthType to NONE (a genuine template removal)', async () => {
    // Absence is not the guarded case: CFn resets a removed property to the
    // type default, and `AuthType` defaults to NONE. Unchanged by #1551.
    await provider.update(
      'MyUrl',
      FN_ARN,
      RESOURCE_TYPE,
      { TargetFunctionArn: FN_ARN, InvokeMode: 'RESPONSE_STREAM' },
      { TargetFunctionArn: FN_ARN, AuthType: 'AWS_IAM', InvokeMode: 'BUFFERED' }
    );

    expect(updateInput()?.['AuthType']).toBe('NONE');
    expect(childLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('AWS::Lambda::Url AuthType')
    );
  });
});
