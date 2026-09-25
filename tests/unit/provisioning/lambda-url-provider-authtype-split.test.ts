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
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const RESOURCE_TYPE = 'AWS::Lambda::Url';
const FN_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:my-fn';
const URL = 'https://abc123.lambda-url.us-east-1.on.aws/';

/**
 * Issue #3740 (the #3728 shape): the update-path `AuthType` guard is split on
 * the ORIGIN of the desired bag. On a template-path update a malformed value is
 * template-borne and `AuthType` is mutable in place, so it is REFUSED before
 * `UpdateFunctionUrlConfig`; the rollback revert arms (`replayingState`) and
 * `cdkd drift --revert` (`desiredFromAwsReadback`) keep the warning and its
 * keep-the-previous-auth-type fallback.
 */
describe('LambdaUrlProvider malformed AuthType on update: template refuses, replay warns', () => {
  let provider: LambdaUrlProvider;

  beforeEach(() => {
    mockSend.mockReset();
    childLogger.warn.mockReset();
    mockSend.mockResolvedValue({ FunctionUrl: URL, FunctionArn: FN_ARN });
    provider = new LambdaUrlProvider();
  });

  const edit = (authType: unknown, context?: Record<string, unknown>) =>
    provider.update(
      'MyUrl',
      FN_ARN,
      RESOURCE_TYPE,
      { TargetFunctionArn: FN_ARN, AuthType: authType, InvokeMode: 'RESPONSE_STREAM' },
      { TargetFunctionArn: FN_ARN, AuthType: 'AWS_IAM', InvokeMode: 'BUFFERED' },
      context
    );

  const updateInput = (): Record<string, unknown> | undefined =>
    mockSend.mock.calls.find((c) => c[0].constructor.name === 'UpdateFunctionUrlConfigCommand')?.[0]
      .input as Record<string, unknown> | undefined;

  it.each([
    ['no context', undefined],
    ['both flags false', { replayingState: false, desiredFromAwsReadback: false }],
  ])('REFUSES on a template-path update (%s), before any AWS call', async (_label, context) => {
    const error = await edit(null, context).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProvisioningError);
    expect((error as Error).message).toMatch(
      /^AWS::Lambda::Url AuthType must be a non-empty string \(got null\)/
    );
    expect((error as Error).message).toMatch(
      /Nothing was applied to Lambda URL MyUrl; fix the template value$/
    );
    // Not re-labelled as an AWS update failure.
    expect((error as Error).message).not.toMatch(/Failed to update Lambda URL/);
    expect(mockSend).not.toHaveBeenCalled();
    expect(childLogger.warn).not.toHaveBeenCalled();
  });

  it.each(['', '   ', 1, ['AWS_IAM'], { 'Fn::If': ['C', 'NONE', 'AWS_IAM'] }])(
    'REFUSES the malformed shape %j on the template path',
    async (value) => {
      await expect(edit(value)).rejects.toThrow(/AWS::Lambda::Url AuthType must be/);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['a rollback revert arm (replayingState)', { replayingState: true }],
    ['cdkd drift --revert (desiredFromAwsReadback)', { desiredFromAwsReadback: true }],
  ])('keeps the warning on %s, sending the PREVIOUS auth type', async (_label, context) => {
    const result = await edit(null, context);

    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('AWS::Lambda::Url AuthType must be a non-empty string')
    );
    // Never the create default: that would make an IAM-guarded URL public.
    expect(updateInput()?.['AuthType']).toBe('AWS_IAM');
    expect(result.effectiveProperties?.['AuthType']).toBe('AWS_IAM');
  });

  it('does not refuse when nothing changed (the no-op early return runs first)', async () => {
    const same = { TargetFunctionArn: FN_ARN, AuthType: null };
    await expect(provider.update('MyUrl', FN_ARN, RESOURCE_TYPE, same, same)).resolves.toEqual({
      physicalId: FN_ARN,
      wasReplaced: false,
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('does not refuse a usable AuthType on the template path', async () => {
    await edit('NONE');
    expect(updateInput()?.['AuthType']).toBe('NONE');
    expect(childLogger.warn).not.toHaveBeenCalled();
  });
});
