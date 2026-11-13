import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...fns, child: () => fns }) };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: {
      send: vi.fn().mockResolvedValue({
        Account: '123456789012',
        Arn: 'arn:aws:iam::123456789012:user/test',
      }),
    },
    ec2: { send: vi.fn() },
  }),
}));

/**
 * go-to-k/cdkd#6170: `Ref AWS::StackId` ends in the context's `stackIdTail()`
 * (`cdkd` when it returns undefined), and a tail that throws (a corrupt marker)
 * is marked non-retryable, so the create retry loop does not re-run it.
 */
describe('Ref AWS::StackId and the context stackIdTail (go-to-k/cdkd#6170)', () => {
  beforeEach(() => resetAccountInfoCache());

  const resolveWith = (stackIdTail: () => string | undefined): Promise<unknown> => {
    const template: CloudFormationTemplate = { Resources: {} };
    const context: ResolverContext = { template, resources: {}, stackName: 'S', stackIdTail };
    return new IntrinsicFunctionResolver('us-east-1').resolve({ Ref: 'AWS::StackId' }, context);
  };

  it('a tail is the last segment of the stack id ARN', async () => {
    const id = await resolveWith(() => 'abc');
    expect(id).toBe('arn:aws:cloudformation:us-east-1:123456789012:stack/S/abc');
  });

  it('an undefined tail is the legacy cdkd', async () => {
    expect(await resolveWith(() => undefined)).toMatch(/:stack\/S\/cdkd$/);
  });

  it('a throwing tail rejects with an error marked non-retryable', async () => {
    const caught = await resolveWith(() => {
      throw new Error('boom');
    }).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('boom');
    expect(isMarkedNonRetryable(caught)).toBe(true);
  });
});
