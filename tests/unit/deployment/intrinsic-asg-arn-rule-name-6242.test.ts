import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { IntrinsicResolutionRefusalError } from '../../../src/utils/error-handler.js';

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: warnSpy, error: vi.fn(), child: () => fns };
  return { getLogger: () => fns };
});
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) } }),
}));

/**
 * go-to-k/cdkd#6242, measured against CloudFormation: `Fn::GetAtt [Rule,
 * RuleName]` returned the whole rule ARN (the physical id) where CloudFormation
 * returns the plain name, on a custom bus too; `Fn::GetAtt [Asg,
 * AutoScalingGroupARN]` returned the group NAME (its upper-case `ARN` suffix
 * slipped past the fallback's `*Arn` guard) though the provider records the
 * ARN under `Arn`.
 */
const resolve = (type: string, physicalId: string, attributes: Record<string, unknown>, attr: string) =>
  new IntrinsicFunctionResolver('us-east-1').resolve({ 'Fn::GetAtt': ['X', attr] }, {
    template: { Resources: { X: { Type: type, Properties: {} } } },
    resources: { X: { physicalId, resourceType: type, properties: {}, attributes, dependencies: [] } },
  } as ResolverContext);

describe('Fn::GetAtt RuleName / AutoScalingGroupARN (#6242)', () => {
  beforeEach(() => {
    resetAccountInfoCache();
    warnSpy.mockReset();
  });

  it.each([
    ['a custom-bus rule ARN', 'arn:aws:events:us-east-1:123456789012:rule/my-bus/my-rule'],
    ['a default-bus rule ARN', 'arn:aws:events:us-east-1:123456789012:rule/my-rule'],
    ['a bare rule name', 'my-rule'],
  ])('RuleName is the plain rule name for %s', async (_label, physicalId) => {
    await expect(resolve('AWS::Events::Rule', physicalId, {}, 'RuleName')).resolves.toBe('my-rule');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('AutoScalingGroupARN is the recorded Arn, never the group name', async () => {
    const arn =
      'arn:aws:autoscaling:us-east-1:123456789012:autoScalingGroup:3b75d676-c4d6-454e-98bf-245fe81d1685:autoScalingGroupName/my-asg';
    await expect(
      resolve('AWS::AutoScaling::AutoScalingGroup', 'my-asg', { Arn: arn }, 'AutoScalingGroupARN')
    ).resolves.toBe(arn);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('AutoScalingGroupARN refuses when no ARN is recorded, rather than serving the group name', async () => {
    const error = await resolve('AWS::AutoScaling::AutoScalingGroup', 'my-asg', {}, 'AutoScalingGroupARN').then(
      () => undefined,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(IntrinsicResolutionRefusalError);
    expect((error as Error).message).toContain('AutoScalingGroupARN');
  });
});
