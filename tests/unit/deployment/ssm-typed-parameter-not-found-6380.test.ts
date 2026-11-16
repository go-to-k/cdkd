import { describe, it, expect, vi } from 'vite-plus/test';
import { IntrinsicFunctionResolver } from '../../../src/deployment/intrinsic-function-resolver.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

/**
 * Issue #6380: SSM answers `GetParameter` on a missing path with a
 * MESSAGE-LESS `ParameterNotFound` (the SDK fills in `UnknownError`), so a
 * deploy relaying it raw printed `Failed: stack:X: UnknownError` and never
 * named the path a `valueForStringParameter` parameter reads.
 */
const PATH = '/my-app/missing';
const TEMPLATE = {
  Parameters: {
    SsmParameterValueMissing: { Type: 'AWS::SSM::Parameter::Value<String>', Default: PATH },
  },
  Resources: {
    Topic: {
      Type: 'AWS::SNS::Topic',
      Properties: { DisplayName: { Ref: 'SsmParameterValueMissing' } },
    },
  },
} as unknown as CloudFormationTemplate;

/** The SDK's shape for SSM's message-less 400. */
const parameterNotFound = (): Error =>
  Object.assign(new Error('UnknownError'), {
    name: 'ParameterNotFound',
    $fault: 'client',
    $metadata: { httpStatusCode: 400 },
  });

const failureOf = async (resolver: IntrinsicFunctionResolver): Promise<unknown> =>
  resolver.resolveParameters(TEMPLATE).then(
    () => undefined,
    (e: unknown) => e
  );

describe('a missing SSM-typed parameter (#6380)', () => {
  it('names the path, the template parameter and the region, non-retryably, keeping the AWS error as cause', async () => {
    const resolver = new IntrinsicFunctionResolver('eu-west-1');
    const awsError = parameterNotFound();
    vi.spyOn(resolver, 'resolveSSMParameter').mockRejectedValue(awsError);

    const err = await failureOf(resolver);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain(`SSM parameter ${PATH}`);
    expect(message).toContain('template parameter SsmParameterValueMissing');
    expect(message).toContain('was not found in region eu-west-1');
    expect(message).not.toContain('UnknownError');
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect((err as Error).cause).toBe(awsError);
  });

  it('omits the region clause when the resolver has no explicit region', async () => {
    const resolver = new IntrinsicFunctionResolver();
    vi.spyOn(resolver, 'resolveSSMParameter').mockRejectedValue(parameterNotFound());

    const message = ((await failureOf(resolver)) as Error).message;

    expect(message).toContain(`SSM parameter ${PATH}`);
    expect(message).toContain('was not found.');
    expect(message).not.toContain('in region');
  });

  it('relays any other SSM failure unchanged', async () => {
    const resolver = new IntrinsicFunctionResolver('eu-west-1');
    const denied = Object.assign(new Error('not authorized to perform ssm:GetParameter'), {
      name: 'AccessDeniedException',
      $fault: 'client',
      $metadata: { httpStatusCode: 400 },
    });
    vi.spyOn(resolver, 'resolveSSMParameter').mockRejectedValue(denied);

    expect(await failureOf(resolver)).toBe(denied);
  });
});
