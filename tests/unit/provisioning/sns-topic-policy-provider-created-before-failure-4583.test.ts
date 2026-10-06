import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sns: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { SNSTopicPolicyProvider } from '../../../src/provisioning/providers/sns-topic-policy-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';

const TYPE = 'AWS::SNS::TopicPolicy';
const T1 = 'arn:aws:sns:us-east-1:123456789012:topic-1';
const T2 = 'arn:aws:sns:us-east-1:123456789012:topic-2';
const T3 = 'arn:aws:sns:us-east-1:123456789012:topic-3';
const PROPS = {
  Topics: [T1, T2, T3],
  PolicyDocument: { Version: '2012-10-17', Statement: [] },
};

async function createError(props: Record<string, unknown> = PROPS): Promise<unknown> {
  return new SNSTopicPolicyProvider().create('TopicPolicy', TYPE, props).then(
    () => {
      throw new Error('expected create to fail');
    },
    (e: unknown) => e
  );
}

describe('SNSTopicPolicyProvider create marks only the topics it wrote (#4583)', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('marks exactly the already-written topics when a later SetTopicAttributes fails', async () => {
    mockSend.mockResolvedValueOnce({}); // T1
    mockSend.mockResolvedValueOnce({}); // T2
    mockSend.mockRejectedValueOnce(new Error('AuthorizationError: not authorized')); // T3
    const error = await createError();
    // Never T3: its policy is not one this create wrote.
    expect(createdBeforeFailure(error, 'TopicPolicy', TYPE)).toBe(`${T1},${T2}`);
  });

  it('leaves no mark when the first SetTopicAttributes fails', async () => {
    mockSend.mockRejectedValueOnce(new Error('NotFound: Topic does not exist'));
    const error = await createError();
    expect(createdBeforeFailure(error, 'TopicPolicy', TYPE)).toBeUndefined();
  });

  it('leaves no mark on the pre-flight missing-PolicyDocument refusal', async () => {
    const error = await createError({ Topics: [T1] });
    expect(mockSend).not.toHaveBeenCalled();
    expect(createdBeforeFailure(error, 'TopicPolicy', TYPE)).toBeUndefined();
  });

  it('delete() with the marked id clears only the written topics', async () => {
    mockSend.mockResolvedValue({});
    await new SNSTopicPolicyProvider().delete('TopicPolicy', `${T1},${T2}`, TYPE, PROPS);
    const cleared = mockSend.mock.calls.map((c) => (c[0] as { input: { TopicArn: string } }).input.TopicArn);
    expect(cleared).toEqual([T1, T2]);
  });
});
