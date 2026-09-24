import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-function-resolver.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: {
      send: vi.fn().mockResolvedValue({
        Account: '123456789012',
        Arn: 'arn:aws:iam::123456789012:user/test',
      }),
    },
  }),
}));

/**
 * Issue #3627: `SNSTopicProvider` (and Cloud Control, whose primary identifier
 * is `TopicArn`) record the topic ARN as the physical id. With no recorded
 * attributes — a record `cdkd import` wrote before the fix — the resolver read
 * that ARN as a NAME, serving a doubled ARN for `TopicArn` and the ARN for
 * `TopicName`, with no warning.
 */
describe('IntrinsicFunctionResolver - AWS::SNS::Topic over an ARN physical id', () => {
  const ARN = 'arn:aws:sns:us-east-1:123456789012:orders';

  beforeEach(() => resetAccountInfoCache());

  const resolveAttr = (physicalId: string, attribute: string): Promise<unknown> => {
    const context: ResolverContext = {
      template: { Resources: { Topic: { Type: 'AWS::SNS::Topic', Properties: {} } } },
      resources: {
        Topic: {
          physicalId,
          resourceType: 'AWS::SNS::Topic',
          properties: {},
          attributes: {},
          dependencies: [],
        },
      },
    };
    return new IntrinsicFunctionResolver('us-east-1').resolve(
      { 'Fn::GetAtt': ['Topic', attribute] },
      context
    );
  };

  it('serves the ARN physical id as TopicArn, not a doubled ARN', async () => {
    await expect(resolveAttr(ARN, 'TopicArn')).resolves.toBe(ARN);
  });

  it('serves the ARN tail as TopicName', async () => {
    await expect(resolveAttr(ARN, 'TopicName')).resolves.toBe('orders');
  });

  it('keeps the name-shaped physical id arms', async () => {
    await expect(resolveAttr('orders', 'TopicArn')).resolves.toBe(ARN);
    await expect(resolveAttr('orders', 'TopicName')).resolves.toBe('orders');
  });
});
