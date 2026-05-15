import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, warnSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warnSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sns: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { SNSTopicProvider } from '../../../src/provisioning/providers/sns-topic-provider.js';

const RESOURCE_TYPE = 'AWS::SNS::Topic';
const TOPIC_ARN = 'arn:aws:sns:us-east-1:123:MyTopic';

describe('SNSTopicProvider partial-create cleanup (Issue #376)', () => {
  let provider: SNSTopicProvider;

  beforeEach(() => {
    mockSend.mockReset();
    warnSpy.mockReset();
    provider = new SNSTopicProvider();
  });

  it('issues DeleteTopicCommand when SetTopicAttributes (DataProtectionPolicy) fails after CreateTopic succeeded', async () => {
    mockSend.mockResolvedValueOnce({ TopicArn: TOPIC_ARN }); // CreateTopicCommand
    mockSend.mockRejectedValueOnce(new Error('SetTopicAttributes boom')); // SetTopicAttributesCommand
    mockSend.mockResolvedValueOnce({}); // DeleteTopicCommand cleanup

    await expect(
      provider.create('MyTopic', RESOURCE_TYPE, {
        TopicName: 'MyTopic',
        DataProtectionPolicy: { Name: 'test', Statement: [] },
      })
    ).rejects.toThrow('Failed to create SNS topic');

    const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
    expect(names).toEqual(['CreateTopicCommand', 'SetTopicAttributesCommand', 'DeleteTopicCommand']);
    expect(mockSend.mock.calls[2][0].input).toEqual({ TopicArn: TOPIC_ARN });
  });

  it('does NOT issue DeleteTopicCommand when CreateTopic itself fails', async () => {
    mockSend.mockRejectedValueOnce(new Error('CreateTopic boom'));

    await expect(
      provider.create('MyTopic', RESOURCE_TYPE, { TopicName: 'MyTopic' })
    ).rejects.toThrow('Failed to create SNS topic');

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].constructor.name).toBe('CreateTopicCommand');
  });

  it('re-throws the original error even when DeleteTopicCommand cleanup itself fails', async () => {
    mockSend.mockResolvedValueOnce({ TopicArn: TOPIC_ARN }); // CreateTopicCommand
    mockSend.mockRejectedValueOnce(new Error('SetTopicAttributes boom (original)'));
    mockSend.mockRejectedValueOnce(new Error('DeleteTopic also failed'));

    await expect(
      provider.create('MyTopic', RESOURCE_TYPE, {
        TopicName: 'MyTopic',
        DataProtectionPolicy: { Name: 'test', Statement: [] },
      })
    ).rejects.toThrow('SetTopicAttributes boom (original)');

    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = String(warnSpy.mock.calls[0][0]);
    expect(warnMsg).toContain('aws sns delete-topic --topic-arn');
    expect(warnMsg).toContain(TOPIC_ARN);
  });
});
