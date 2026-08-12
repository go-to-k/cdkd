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
 * `effectiveProperties` for the UPDATE-path `AuthType` warn arms (issue
 * #1654).
 *
 * The #1551 guard warns and SUBSTITUTES rather than throwing, so the deploy
 * SUCCEEDS while state kept the malformed `AuthType`. `readCurrentState` reads
 * `AuthType` back off `GetFunctionUrlConfig`, so that mismatch was permanent
 * phantom drift: re-reported by every `cdkd drift` and re-triggered by
 * `drift --revert`, which calls `update()` again. A SUBSTITUTED value is the
 * same class as a dropped key (`.claude/rules/providers.md`, #1633).
 */
describe('LambdaUrlProvider AuthType effectiveProperties (issue #1654)', () => {
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

  // ─── previous-value arm ────────────────────────────────────────────────

  it('records the PREVIOUS AuthType — the value actually SENT', async () => {
    const desired = {
      TargetFunctionArn: FN_ARN,
      AuthType: null,
      InvokeMode: 'RESPONSE_STREAM',
    };

    const result = await provider.update('MyUrl', FN_ARN, RESOURCE_TYPE, desired, {
      TargetFunctionArn: FN_ARN,
      AuthType: 'AWS_IAM',
      InvokeMode: 'BUFFERED',
    });

    // The exact previous string, matching what went on the wire — NOT the
    // malformed desired value and NOT the create default 'NONE'.
    expect(updateInput()?.['AuthType']).toBe('AWS_IAM');
    expect(result.effectiveProperties?.['AuthType']).toBe('AWS_IAM');
    // A complete replacement bag, not a patch.
    expect(result.effectiveProperties).toEqual({ ...desired, AuthType: 'AWS_IAM' });
  });

  // ─── OMITTED arm: the settled decision ─────────────────────────────────

  it('DROPS AuthType when the update omitted it (nothing was sent)', async () => {
    const desired = { TargetFunctionArn: FN_ARN, AuthType: '', InvokeMode: 'RESPONSE_STREAM' };

    const result = await provider.update('MyUrl', FN_ARN, RESOURCE_TYPE, desired, {
      TargetFunctionArn: FN_ARN,
      AuthType: null,
      InvokeMode: 'BUFFERED',
    });

    // Both sides are junk, so `UpdateFunctionUrlConfig` was sent WITHOUT
    // AuthType and its merge semantics retained the live value — which cdkd
    // never read. The decision (documented at the call site): drop the key,
    // so state never claims an auth type cdkd cannot vouch for.
    const input = updateInput();
    expect(input && 'AuthType' in input).toBe(false);

    expect(result.effectiveProperties).toBeDefined();
    expect('AuthType' in (result.effectiveProperties ?? {})).toBe(false);
    expect(result.effectiveProperties).toEqual({
      TargetFunctionArn: FN_ARN,
      InvokeMode: 'RESPONSE_STREAM',
    });
    // Explicitly NOT the create default: recording 'NONE' would describe a
    // PUBLIC function URL that may in fact still be IAM-guarded.
    expect(result.effectiveProperties?.['AuthType']).not.toBe('NONE');
  });

  it('drops the key on the omitted arm when the previous side is ABSENT too', async () => {
    const result = await provider.update(
      'MyUrl',
      FN_ARN,
      RESOURCE_TYPE,
      { TargetFunctionArn: FN_ARN, AuthType: '', InvokeMode: 'RESPONSE_STREAM' },
      { TargetFunctionArn: FN_ARN, InvokeMode: 'BUFFERED' }
    );

    // `toBeDefined` first: without it `'AuthType' in (undefined ?? {})` is
    // false and the assertion passes vacuously against the pre-fix provider.
    expect(result.effectiveProperties).toBeDefined();
    expect('AuthType' in (result.effectiveProperties ?? {})).toBe(false);
    expect(result.effectiveProperties).toEqual({
      TargetFunctionArn: FN_ARN,
      InvokeMode: 'RESPONSE_STREAM',
    });
  });

  // ─── the well-formed polarity is untouched ─────────────────────────────

  it('answers with NO effectiveProperties for a VALID desired AuthType', async () => {
    const result = await provider.update(
      'MyUrl',
      FN_ARN,
      RESOURCE_TYPE,
      { TargetFunctionArn: FN_ARN, AuthType: 'AWS_IAM' },
      { TargetFunctionArn: FN_ARN, AuthType: 'NONE' }
    );

    expect(updateInput()?.['AuthType']).toBe('AWS_IAM');
    // Absent means "record the desired properties" — the normal case.
    expect(result.effectiveProperties).toBeUndefined();
  });

  it('answers with NO effectiveProperties for an ABSENT desired AuthType', async () => {
    // Absence is a genuine template removal, not the guarded case: CFn resets
    // a removed property to the type default and cdkd sends 'NONE', which is
    // exactly what the desired bag already implies.
    const result = await provider.update(
      'MyUrl',
      FN_ARN,
      RESOURCE_TYPE,
      { TargetFunctionArn: FN_ARN, InvokeMode: 'RESPONSE_STREAM' },
      { TargetFunctionArn: FN_ARN, AuthType: 'AWS_IAM', InvokeMode: 'BUFFERED' }
    );

    expect(updateInput()?.['AuthType']).toBe('NONE');
    expect(result.effectiveProperties).toBeUndefined();
  });

  it('answers with NO effectiveProperties on the diff-based no-op path', async () => {
    const same = { TargetFunctionArn: FN_ARN, AuthType: 'AWS_IAM' };

    const result = await provider.update('MyUrl', FN_ARN, RESOURCE_TYPE, same, { ...same });

    expect(updateInput()).toBeUndefined();
    expect(result.effectiveProperties).toBeUndefined();
  });
});
