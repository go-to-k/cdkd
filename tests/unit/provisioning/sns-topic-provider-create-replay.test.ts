import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { CreateTopicCommand, DeleteTopicCommand } from '@aws-sdk/client-sns';

const mockSend = vi.fn();
// The logger factory builds its child logger EAGERLY, so `warn` has to be
// hoisted with it (the aws-clients factory below only closes over `mockSend`).
const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sns: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
    }),
  };
});

import { SNSTopicProvider } from '../../../src/provisioning/providers/sns-topic-provider.js';

const TOPIC_ARN = 'arn:aws:sns:us-east-1:0:topic';
const ROLE_A = 'arn:aws:iam::0:role/feedback-a';

/**
 * `CreateContext.replayingState` downgrade for the CREATE path (issue #1551).
 *
 * `SNSTopicProvider.create()` declared no `context` parameter at all, so the
 * `REPLAYING_STATE_CREATE_CONTEXT` the rollback executor's
 * reverse-replacement arm passes as the 4th argument was silently ignored and
 * `buildDeliveryStatusAttributeMap`'s `'throw'` mode fired on a bag that is a
 * cdkd STATE record — leaving the old topic unrestorable with only a hand-edit
 * of state.json as a remedy. Issue #1538 fixed the update side only.
 */
describe('SNSTopicProvider create() replay tolerance (issue #1551)', () => {
  let provider: SNSTopicProvider;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSend.mockImplementation((cmd) =>
      cmd instanceof CreateTopicCommand ? Promise.resolve({ TopicArn: TOPIC_ARN }) : Promise.resolve({})
    );
    provider = new SNSTopicProvider();
  });

  const commandNames = (): string[] => mockSend.mock.calls.map((c) => c[0].constructor.name);

  // The warn-mode and throw-mode wordings differ per shape (the throw names
  // `unsupported DeliveryStatusLogging protocol`, the warn says `skipping
  // ... with unsupported protocol`), so each shape carries BOTH patterns
  // rather than one loose pattern that would match either by accident.
  const malformedShapes: Array<[string, unknown, RegExp, RegExp]> = [
    ['a non-array container', 'enabled', /must be an array/, /must be an array/],
    ['a non-object entry', ['garbage'], /\{Protocol, \.\.\.\} objects/, /\{Protocol, \.\.\.\} objects/],
    [
      'an unsupported protocol',
      [{ Protocol: 'smtp', SuccessFeedbackRoleArn: ROLE_A }],
      /skipping DeliveryStatusLogging entry with unsupported protocol "smtp"/,
      /unsupported DeliveryStatusLogging protocol "smtp"/,
    ],
  ];

  for (const [label, logging, warnPattern, throwPattern] of malformedShapes) {
    it(`WARNS instead of throwing on ${label} when the create is a state replay`, async () => {
      const result = await provider.create(
        'L',
        'AWS::SNS::Topic',
        { TopicName: 'topic', DeliveryStatusLogging: logging },
        { replayingState: true }
      );

      expect(result.physicalId).toBe(TOPIC_ARN);
      // The topic is CREATED and kept — the pre-fix throw ran the partial-create
      // cleanup and deleted it, which is what made the replay unrecoverable.
      expect(commandNames()).toContain('CreateTopicCommand');
      expect(commandNames()).not.toContain('DeleteTopicCommand');
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(warnPattern));
    });

    it(`keeps the refusal on ${label} for a template-path create`, async () => {
      await expect(
        provider.create('L', 'AWS::SNS::Topic', {
          TopicName: 'topic',
          DeliveryStatusLogging: logging,
        })
      ).rejects.toThrow(throwPattern);

      // Pre-flight failure of a wiring step still best-effort-deletes the topic.
      expect(mockSend.mock.calls.some((c) => c[0] instanceof DeleteTopicCommand)).toBe(true);
    });
  }

  it('keeps the refusal when the context carries replayingState: false', async () => {
    await expect(
      provider.create(
        'L',
        'AWS::SNS::Topic',
        { TopicName: 'topic', DeliveryStatusLogging: 'enabled' },
        { replayingState: false }
      )
    ).rejects.toThrow(/must be an array/);
  });

  it('keeps the refusal when the context is present but carries no replay flag', async () => {
    await expect(
      provider.create(
        'L',
        'AWS::SNS::Topic',
        { TopicName: 'topic', DeliveryStatusLogging: 'enabled' },
        {}
      )
    ).rejects.toThrow(/must be an array/);
  });

  it('applies a VALID DeliveryStatusLogging entry unchanged on a state replay', async () => {
    await provider.create(
      'L',
      'AWS::SNS::Topic',
      {
        TopicName: 'topic',
        DeliveryStatusLogging: [{ Protocol: 'lambda', SuccessFeedbackRoleArn: ROLE_A }],
      },
      { replayingState: true }
    );

    const attributeCall = mockSend.mock.calls.find(
      (c) => c[0].constructor.name === 'SetTopicAttributesCommand'
    );
    expect(attributeCall?.[0].input).toEqual({
      TopicArn: TOPIC_ARN,
      AttributeName: 'LambdaSuccessFeedbackRoleArn',
      AttributeValue: ROLE_A,
    });
    expect(warn).not.toHaveBeenCalled();
  });
});
