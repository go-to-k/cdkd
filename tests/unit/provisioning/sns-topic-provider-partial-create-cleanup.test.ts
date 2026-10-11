import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, ownershipSend, warnSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  // The lookup before the create (go-to-k/cdkd#4403): STS for the account,
  // then GetTopicAttributes on the ARN the name maps to. Its own spy, so each
  // case's primed CreateTopic / wiring / cleanup sequence stays as is; the
  // name is free by default.
  ownershipSend: vi.fn(),
  warnSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sns: {
      send: (command: { constructor: { name: string } }) =>
        command.constructor.name === 'GetTopicAttributesCommand'
          ? ownershipSend(command)
          : mockSend(command),
      config: { region: () => Promise.resolve('us-east-1') },
    },
    sts: { send: ownershipSend },
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
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import { provenNothingCreated } from '../../../src/deployment/generated-name-guard.js';
import {
  FORGED_CTRL,
  FORGED_QUOTE,
  expectWithheld,
} from './pasteable-aws-command-assert.js';

const RESOURCE_TYPE = 'AWS::SNS::Topic';
const TOPIC_ARN = 'arn:aws:sns:us-east-1:123:MyTopic';

describe('SNSTopicProvider partial-create cleanup (Issue #376)', () => {
  let provider: SNSTopicProvider;

  beforeEach(() => {
    mockSend.mockReset();
    warnSpy.mockReset();
    ownershipSend.mockReset();
    ownershipSend.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetCallerIdentityCommand') {
        return { Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/u' };
      }
      throw Object.assign(new Error('Topic does not exist'), { name: 'NotFoundException' });
    });
    provider = new SNSTopicProvider();
  });

  describe('a topic that held the name before CreateTopic handed it back (go-to-k/cdkd#4403)', () => {
    const props = { TopicName: 'MyTopic', DataProtectionPolicy: { Name: 'p' } };

    it('looks up the ARN the name maps to, from STS and the client region', async () => {
      mockSend.mockResolvedValueOnce({ TopicArn: TOPIC_ARN });
      mockSend.mockResolvedValueOnce({});

      await provider.create('MyTopic', RESOURCE_TYPE, props);

      const lookup = ownershipSend.mock.calls
        .map(([c]) => c as { constructor: { name: string }; input: Record<string, unknown> })
        .find((c) => c.constructor.name === 'GetTopicAttributesCommand');
      expect(lookup?.input).toEqual({ TopicArn: 'arn:aws:sns:us-east-1:123456789012:MyTopic' });
      // BEFORE the create: asked after it, the name is always held by what
      // the create just made, and no cleanup would ever run.
      expect(Math.max(...ownershipSend.mock.invocationCallOrder)).toBeLessThan(
        mockSend.mock.invocationCallOrder[0]!
      );
    });

    it('is not deleted when the wiring fails', async () => {
      ownershipSend.mockImplementation(async (command: { constructor: { name: string } }) =>
        command.constructor.name === 'GetCallerIdentityCommand'
          ? { Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/u' }
          : { Attributes: { TopicArn: TOPIC_ARN } }
      );
      mockSend.mockResolvedValueOnce({ TopicArn: TOPIC_ARN });
      mockSend.mockRejectedValueOnce(new Error('DataProtectionPolicy boom'));

      await expect(provider.create('MyTopic', RESOURCE_TYPE, props)).rejects.toThrow(
        'DataProtectionPolicy boom'
      );

      expect(mockSend.mock.calls.map((c) => c[0].constructor.name)).toEqual([
        'CreateTopicCommand',
        'SetTopicAttributesCommand',
      ]);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('already existed before this create');
    });

    it.each([
      ['STS fails', 'GetCallerIdentityCommand'],
      ['the topic read fails with something other than NotFound', 'GetTopicAttributesCommand'],
    ])('is not deleted when %s, and the warning names the manual delete', async (_label, failing) => {
      ownershipSend.mockImplementation(async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === failing) {
          // A message a text match would read as "not found": only the
          // error NAME may decide.
          throw Object.assign(new Error('Topic does not exist or you are not authorized'), {
            name: 'AuthorizationError',
          });
        }
        return { Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/u' };
      });
      mockSend.mockResolvedValueOnce({ TopicArn: TOPIC_ARN });
      mockSend.mockRejectedValueOnce(new Error('DataProtectionPolicy boom'));

      await expect(provider.create('MyTopic', RESOURCE_TYPE, props)).rejects.toThrow(
        'DataProtectionPolicy boom'
      );

      expect(mockSend.mock.calls.map((c) => c[0].constructor.name)).not.toContain('DeleteTopicCommand');
      const warned = String(warnSpy.mock.calls[0]?.[0]);
      expect(warned).toContain('could not tell whether this create made');
      expect(warned).toContain(`aws sns delete-topic --topic-arn ${TOPIC_ARN}`);
    });

    // Each condition of the wiring gate, alone: dropping one leaves that step
    // running with no lookup, and a held topic deleted again.
    it.each([
      ['ArchivePolicy', { TopicName: 'MyTopic.fifo', FifoTopic: true, ArchivePolicy: { MessageRetentionPeriod: 30 } }],
      [
        'DeliveryStatusLogging',
        {
          TopicName: 'MyTopic',
          DeliveryStatusLogging: [
            { Protocol: 'sqs', SuccessFeedbackRoleArn: 'arn:aws:iam::123:role/r', SuccessFeedbackSampleRate: '100' },
          ],
        },
      ],
      ['Subscription', { TopicName: 'MyTopic', Subscription: [{ Protocol: 'sqs', Endpoint: 'arn:aws:sqs:us-east-1:123:q' }] }],
    ] as const)('keeps a held topic whose %s step fails', async (_label, properties) => {
      ownershipSend.mockImplementation(async (command: { constructor: { name: string } }) =>
        command.constructor.name === 'GetCallerIdentityCommand'
          ? { Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/u' }
          : { Attributes: { TopicArn: TOPIC_ARN } }
      );
      mockSend.mockResolvedValueOnce({ TopicArn: TOPIC_ARN });
      mockSend.mockRejectedValueOnce(new Error('wiring boom'));

      await expect(provider.create('MyTopic', RESOURCE_TYPE, properties)).rejects.toThrow('wiring boom');

      expect(ownershipSend).toHaveBeenCalled();
      expect(mockSend.mock.calls.map((c) => c[0].constructor.name)).not.toContain('DeleteTopicCommand');
    });

    it.each(['held', 'unknown'] as const)('masks a secret-derived name in the %s warning', async (arm) => {
      const secretArn = 'arn:aws:sns:us-east-1:123456789012:topic-SECRETVALUE';
      ownershipSend.mockImplementation(async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'GetCallerIdentityCommand') {
          return { Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/u' };
        }
        if (arm === 'held') return { Attributes: { TopicArn: secretArn } };
        throw Object.assign(new Error('denied'), { name: 'AuthorizationError' });
      });
      mockSend.mockResolvedValueOnce({ TopicArn: secretArn });
      mockSend.mockRejectedValueOnce(new Error('wiring boom'));

      await expect(
        provider.create(
          'MyTopic',
          RESOURCE_TYPE,
          { TopicName: 'topic-SECRETVALUE', DataProtectionPolicy: { Name: 'p' } },
          { maskSecrets: (t: string) => t.split('SECRETVALUE').join('***') }
        )
      ).rejects.toThrow();

      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).not.toBe('');
      expect(warned).not.toContain('SECRETVALUE');
    });

    const topicLookups = (): string[] =>
      ownershipSend.mock.calls
        .map(([c]) => c as { constructor: { name: string }; input: { TopicArn?: string } })
        .filter((c) => c.constructor.name === 'GetTopicAttributesCommand')
        .map((c) => c.input.TopicArn ?? '');
    const identityCalls = (): number =>
      ownershipSend.mock.calls.filter(
        ([c]) => (c as { constructor: { name: string } }).constructor.name === 'GetCallerIdentityCommand'
      ).length;

    it('takes the partition from the STS ARN (aws-cn)', async () => {
      ownershipSend.mockImplementation(async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'GetCallerIdentityCommand') {
          return { Account: '123456789012', Arn: 'arn:aws-cn:iam::123456789012:user/u' };
        }
        throw Object.assign(new Error('Topic does not exist'), { name: 'NotFoundException' });
      });
      mockSend.mockResolvedValueOnce({ TopicArn: TOPIC_ARN });
      mockSend.mockResolvedValueOnce({});

      await provider.create('MyTopic', RESOURCE_TYPE, props);

      expect(topicLookups()).toEqual(['arn:aws-cn:sns:us-east-1:123456789012:MyTopic']);
    });

    it('reads an STS answer with no account as no answer, and does not delete', async () => {
      ownershipSend.mockImplementation(async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'GetCallerIdentityCommand') return {};
        throw Object.assign(new Error('Topic does not exist'), { name: 'NotFoundException' });
      });
      mockSend.mockResolvedValueOnce({ TopicArn: TOPIC_ARN });
      mockSend.mockRejectedValueOnce(new Error('DataProtectionPolicy boom'));

      await expect(provider.create('MyTopic', RESOURCE_TYPE, props)).rejects.toThrow(
        'DataProtectionPolicy boom'
      );

      expect(topicLookups()).toEqual([]);
      expect(mockSend.mock.calls.map((c) => c[0].constructor.name)).not.toContain('DeleteTopicCommand');
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('could not tell whether this create made');
    });

    it.each([
      ['no Arn (so no partition)', { Account: '123456789012' }],
      ['an 11-digit Account', { Account: '12345678901', Arn: 'arn:aws:iam::12345678901:user/u' }],
    ])('reads an STS answer with %s as no answer, and does not delete', async (_label, identity) => {
      ownershipSend.mockImplementation(async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'GetCallerIdentityCommand') return identity;
        throw Object.assign(new Error('Topic does not exist'), { name: 'NotFoundException' });
      });
      mockSend.mockResolvedValueOnce({ TopicArn: TOPIC_ARN });
      mockSend.mockRejectedValueOnce(new Error('DataProtectionPolicy boom'));

      await expect(provider.create('MyTopic', RESOURCE_TYPE, props)).rejects.toThrow(
        'DataProtectionPolicy boom'
      );

      expect(topicLookups()).toEqual([]);
      expect(mockSend.mock.calls.map((c) => c[0].constructor.name)).not.toContain('DeleteTopicCommand');
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('could not tell whether this create made');
    });

    it('asks STS once per provider for a validated identity, and again after a failed one', async () => {
      // Two creates: STS answered once and remembered.
      for (let i = 0; i < 2; i++) {
        mockSend.mockResolvedValueOnce({ TopicArn: TOPIC_ARN });
        mockSend.mockResolvedValueOnce({});
        await provider.create('MyTopic', RESOURCE_TYPE, props);
      }
      expect(identityCalls()).toBe(1);

      // A failed STS answer is not remembered: the next create asks again.
      const fresh = new SNSTopicProvider();
      ownershipSend.mockClear();
      let failOnce = true;
      ownershipSend.mockImplementation(async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'GetCallerIdentityCommand') {
          if (failOnce) {
            failOnce = false;
            throw Object.assign(new Error('throttled'), { name: 'Throttling' });
          }
          return { Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/u' };
        }
        throw Object.assign(new Error('Topic does not exist'), { name: 'NotFoundException' });
      });
      for (let i = 0; i < 2; i++) {
        mockSend.mockResolvedValueOnce({ TopicArn: TOPIC_ARN });
        mockSend.mockResolvedValueOnce({});
        await fresh.create('MyTopic', RESOURCE_TYPE, props);
      }
      expect(identityCalls()).toBe(2);
      expect(topicLookups()).toHaveLength(1);
    });

    it('asks nothing for a topic without a wiring step', async () => {
      mockSend.mockResolvedValueOnce({ TopicArn: TOPIC_ARN });

      await provider.create('MyTopic', RESOURCE_TYPE, { TopicName: 'MyTopic', DisplayName: 'd' });

      expect(ownershipSend).not.toHaveBeenCalled();
    });
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

  it('issues DeleteTopicCommand when DeliveryStatusLogging Protocol normalization throws synchronously (inner-catch handles non-mockSend throws)', async () => {
    // normalizeDeliveryStatusProtocolOrThrow rejects unknown protocols
    // BEFORE the SetTopicAttributesCommand fires. The throw is
    // synchronous (not a mockSend rejection). Verifies the inner try
    // catches both AWS-side rejection AND in-process throws.
    mockSend.mockResolvedValueOnce({ TopicArn: TOPIC_ARN }); // CreateTopicCommand
    mockSend.mockResolvedValueOnce({}); // DeleteTopicCommand cleanup

    await expect(
      provider.create('MyTopic', RESOURCE_TYPE, {
        TopicName: 'MyTopic',
        DeliveryStatusLogging: [
          {
            Protocol: 'no-such-protocol',
            SuccessFeedbackRoleArn: 'arn:aws:iam::123:role/X',
          },
        ],
      })
    ).rejects.toThrow('Failed to create SNS topic');

    const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
    expect(names).toEqual(['CreateTopicCommand', 'DeleteTopicCommand']);
    expect(mockSend.mock.calls[1][0].input).toEqual({ TopicArn: TOPIC_ARN });
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

  describe('the recovery command names the topic ARN through pasteableAwsCommand (issue #3136)', () => {
    async function warnFor(topicArn: string): Promise<string> {
      mockSend.mockResolvedValueOnce({ TopicArn: topicArn }); // CreateTopicCommand
      mockSend.mockRejectedValueOnce(new Error('SetTopicAttributes boom'));
      mockSend.mockRejectedValueOnce(new Error('DeleteTopic also failed'));
      await expect(
        provider.create('MyTopic', RESOURCE_TYPE, {
          TopicName: 'MyTopic',
          DataProtectionPolicy: { Name: 'test', Statement: [] },
        })
      ).rejects.toThrow('SetTopicAttributes boom');
      return String(warnSpy.mock.calls[0][0]);
    }

    it('renders a clean ARN bare', async () => {
      expect(await warnFor(TOPIC_ARN)).toContain(`aws sns delete-topic --topic-arn ${TOPIC_ARN}`);
    });

    // A shell-active character withholds it (go-to-k/cdkd#3950).
    it('withholds the command for an ARN carrying a quote', async () => {
      expectWithheld(await warnFor(`${TOPIC_ARN}${FORGED_QUOTE}`), 'aws sns delete-topic');
    });

    it('withholds the command for an ARN carrying a control byte', async () => {
      expectWithheld(await warnFor(`${TOPIC_ARN}${FORGED_CTRL}`), 'aws sns delete-topic');
    });

    it('withholds the command for an ARN the caller masker would change', async () => {
      mockSend.mockResolvedValueOnce({ TopicArn: `${TOPIC_ARN}-s3cr3t` });
      mockSend.mockRejectedValueOnce(new Error('SetTopicAttributes boom'));
      mockSend.mockRejectedValueOnce(new Error('DeleteTopic also failed'));
      await expect(
        provider.create(
          'MyTopic',
          RESOURCE_TYPE,
          { TopicName: 'MyTopic', DataProtectionPolicy: { Name: 'test', Statement: [] } },
          { maskSecrets: (t: string) => t.replaceAll('s3cr3t', '***') }
        )
      ).rejects.toThrow('SetTopicAttributes boom');
      const msg = String(warnSpy.mock.calls[0][0]);
      expectWithheld(msg, 'aws sns delete-topic');
      expect(msg).not.toContain('s3cr3t');
    });
  });

  // go-to-k/cdkd#4583: a topic this create made and left behind is named for
  // `cdkd rollback --revert-failed`; one it cleaned up, or one that held the
  // name before, is not.
  describe('createdBeforeFailure mark (go-to-k/cdkd#4583)', () => {
    const props = { TopicName: 'MyTopic', DataProtectionPolicy: { Name: 'p' } };
    async function failure(): Promise<unknown> {
      return provider.create('MyTopic', RESOURCE_TYPE, props).then(
        () => expect.fail('create resolved'),
        (e: unknown) => e
      );
    }

    it('go-to-k/cdkd#4705 E-3: a 4xx on the wiring with the topic left behind keeps the intent', async () => {
      mockSend.mockResolvedValueOnce({ TopicArn: TOPIC_ARN });
      mockSend.mockRejectedValueOnce(Object.assign(new Error('ValidationException: bad input'), { name: 'ValidationException', $metadata: { httpStatusCode: 400 } }));
      mockSend.mockRejectedValueOnce(new Error('DeleteTopic boom'));
      expect(provenNothingCreated(await failure(), 'MyTopic', RESOURCE_TYPE)).toBe(false);
    });

    it('marks the topic ARN when the wiring fails and the cleanup delete fails', async () => {
      mockSend.mockResolvedValueOnce({ TopicArn: TOPIC_ARN });
      mockSend.mockRejectedValueOnce(new Error('wiring boom'));
      mockSend.mockRejectedValueOnce(new Error('DeleteTopic boom'));
      expect(createdBeforeFailure(await failure(), 'MyTopic', RESOURCE_TYPE)).toBe(TOPIC_ARN);
    });

    it('does not mark when the cleanup delete succeeded', async () => {
      mockSend.mockResolvedValueOnce({ TopicArn: TOPIC_ARN });
      mockSend.mockRejectedValueOnce(new Error('wiring boom'));
      mockSend.mockResolvedValueOnce({});
      const error = await failure();
      // The cleanup delete was really sent, so the undefined is the cleanup's.
      const deleteCall = mockSend.mock.calls.find(
        (c) => c[0].constructor.name === 'DeleteTopicCommand'
      );
      expect(deleteCall?.[0].input).toEqual({ TopicArn: TOPIC_ARN });
      expect(createdBeforeFailure(error, 'MyTopic', RESOURCE_TYPE)).toBeUndefined();
    });

    it('does not mark a topic that held the name before (cleanup skipped)', async () => {
      ownershipSend.mockImplementation(async (command: { constructor: { name: string } }) =>
        command.constructor.name === 'GetCallerIdentityCommand'
          ? { Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/u' }
          : { Attributes: { TopicArn: TOPIC_ARN } }
      );
      mockSend.mockResolvedValueOnce({ TopicArn: TOPIC_ARN });
      mockSend.mockRejectedValueOnce(new Error('wiring boom'));
      const error = await failure();
      // The wiring call was reached (so the undefined is the held skip's, not an
      // earlier refusal's), and the held topic was never deleted.
      const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
      const wiring = mockSend.mock.calls.find(
        (c) => c[0].constructor.name === 'SetTopicAttributesCommand'
      );
      expect(wiring?.[0].input).toMatchObject({
        TopicArn: TOPIC_ARN,
        AttributeName: 'DataProtectionPolicy',
      });
      expect(names).not.toContain('DeleteTopicCommand');
      expect(createdBeforeFailure(error, 'MyTopic', RESOURCE_TYPE)).toBeUndefined();
    });

    it('does not mark when CreateTopic itself fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('CreateTopic boom'));
      expect(createdBeforeFailure(await failure(), 'MyTopic', RESOURCE_TYPE)).toBeUndefined();
    });
  });
});
