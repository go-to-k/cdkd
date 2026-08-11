import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { CreateTopicCommand, SetTopicAttributesCommand } from '@aws-sdk/client-sns';

const mockSend = vi.fn();
// `vi.mock` factories are hoisted above these declarations, and the logger
// factory builds its child logger EAGERLY (unlike the aws-clients factory,
// which only closes over `mockSend`), so `warn` must be hoisted with it.
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

import {
  SNSTopicProvider,
  buildDeliveryStatusAttributeMap,
} from '../../../src/provisioning/providers/sns-topic-provider.js';

const TOPIC_ARN = 'arn:aws:sns:us-east-1:0:topic';
const ROLE_A = 'arn:aws:iam::0:role/feedback-a';
const ROLE_B = 'arn:aws:iam::0:role/feedback-b';

/** Collect the {AttributeName, AttributeValue} pairs of every SetTopicAttributes call. */
function setAttributeCalls(): Array<{ AttributeName: string; AttributeValue: string }> {
  return mockSend.mock.calls
    .filter((c) => c[0] instanceof SetTopicAttributesCommand)
    .map((c) => c[0].input as { AttributeName: string; AttributeValue: string });
}

/**
 * Issue #1538: `buildDeliveryStatusAttributeMap`'s DESIRED side is not always
 * template-borne. The rollback executor's revert arm calls
 * `provider.update(..., previousState.properties, ...)` and
 * `cdkd drift --revert` likewise puts a state-derived bag on the desired
 * side, so a state record carrying an unsupported protocol / malformed shape
 * (a hand-written imported template, or a record an older binary wrote) used
 * to hit the throw sites and fail PERMANENTLY — no template-side remedy
 * exists. The fix: the UPDATE desired side warns-and-skips ('warn' mode)
 * while the CREATE path — always template-borne — still throws ('throw').
 */
describe('SNSTopicProvider update() replay tolerance (issue #1538)', () => {
  let provider: SNSTopicProvider;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSend.mockResolvedValue({});
    provider = new SNSTopicProvider();
  });

  it('unsupported protocol in the DESIRED bag warns, skips that entry, and still applies the valid siblings', async () => {
    const previous = { TopicName: 'topic' };
    // A state-derived desired bag (e.g. rollback replay of a record written
    // by an older binary / imported hand-written template).
    const desired = {
      TopicName: 'topic',
      DeliveryStatusLogging: [
        { Protocol: 'smtp', SuccessFeedbackRoleArn: ROLE_A },
        { Protocol: 'lambda', SuccessFeedbackRoleArn: ROLE_B },
      ],
    };

    await provider.update('L', TOPIC_ARN, 'AWS::SNS::Topic', desired, previous);

    // Well-defined result: the unsupported entry maps to no attribute names,
    // the valid entry is applied verbatim.
    expect(setAttributeCalls()).toEqual([
      {
        TopicArn: TOPIC_ARN,
        AttributeName: 'LambdaSuccessFeedbackRoleArn',
        AttributeValue: ROLE_B,
      },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]?.[0] as string;
    expect(message).toContain('L');
    expect(message).toContain('"smtp"');
    expect(message).toContain('unsupported protocol');
    // Actionable: the accepted spellings are named.
    expect(message).toMatch(/application, firehose, http\/s, lambda, sqs/);
  });

  it('non-array DESIRED container warns and yields an empty map — no throw', async () => {
    const previous = {
      TopicName: 'topic',
      DeliveryStatusLogging: [{ Protocol: 'lambda', SuccessFeedbackRoleArn: ROLE_A }],
    };
    const desired = { TopicName: 'topic', DeliveryStatusLogging: { Protocol: 'lambda' } };

    await provider.update('L', TOPIC_ARN, 'AWS::SNS::Topic', desired, previous);

    // Empty desired map + populated previous map = the removal-reset arm.
    expect(setAttributeCalls()).toEqual([
      {
        TopicArn: TOPIC_ARN,
        AttributeName: 'LambdaSuccessFeedbackRoleArn',
        AttributeValue: '',
      },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]?.[0] as string;
    expect(message).toContain('L');
    expect(message).toContain('must be an array');
    expect(message).toContain('{"Protocol":"lambda"}');
  });

  it('non-object DESIRED entry warns, is skipped, and the valid siblings still apply', async () => {
    const previous = { TopicName: 'topic' };
    const desired = {
      TopicName: 'topic',
      DeliveryStatusLogging: ['garbage', { Protocol: 'sqs', FailureFeedbackRoleArn: ROLE_A }],
    };

    await provider.update('L', TOPIC_ARN, 'AWS::SNS::Topic', desired, previous);

    expect(setAttributeCalls()).toEqual([
      {
        TopicArn: TOPIC_ARN,
        AttributeName: 'SQSFailureFeedbackRoleArn',
        AttributeValue: ROLE_A,
      },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]?.[0] as string;
    expect(message).toContain('L');
    expect(message).toContain('"garbage"');
    expect(message).toContain('{Protocol, ...} objects');
  });

  it('a fully-unreplayable-before-#1538 state bag (all three malformed shapes across entries) completes the update', async () => {
    const previous = { TopicName: 'topic' };
    const desired = {
      TopicName: 'topic',
      DeliveryStatusLogging: [
        { Protocol: 'smtp', SuccessFeedbackRoleArn: ROLE_A },
        42,
        { Protocol: 'lambda', SuccessFeedbackSampleRate: 0 },
      ],
    };

    await provider.update('L', TOPIC_ARN, 'AWS::SNS::Topic', desired, previous);

    // The `!= null` presence gate still holds in warn mode: SampleRate 0 is sent.
    expect(setAttributeCalls()).toEqual([
      {
        TopicArn: TOPIC_ARN,
        AttributeName: 'LambdaSuccessFeedbackSampleRate',
        AttributeValue: '0',
      },
    ]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  // ─── The create contract is UNCHANGED: template-borne, fail fast ──────

  it('create() still throws on an unsupported protocol', async () => {
    mockSend.mockImplementation((cmd) =>
      cmd instanceof CreateTopicCommand
        ? Promise.resolve({ TopicArn: TOPIC_ARN })
        : Promise.resolve({})
    );

    await expect(
      provider.create('L', 'AWS::SNS::Topic', {
        TopicName: 'topic',
        DeliveryStatusLogging: [{ Protocol: 'smtp', SuccessFeedbackRoleArn: ROLE_A }],
      })
    ).rejects.toThrow(/unsupported DeliveryStatusLogging protocol "smtp"/);
  });

  it('create() still throws on a non-array container', async () => {
    mockSend.mockImplementation((cmd) =>
      cmd instanceof CreateTopicCommand
        ? Promise.resolve({ TopicArn: TOPIC_ARN })
        : Promise.resolve({})
    );

    await expect(
      provider.create('L', 'AWS::SNS::Topic', {
        TopicName: 'topic',
        DeliveryStatusLogging: 'enabled',
      })
    ).rejects.toThrow(/DeliveryStatusLogging must be an array/);
  });

  it('create() still throws on a non-object entry', async () => {
    mockSend.mockImplementation((cmd) =>
      cmd instanceof CreateTopicCommand
        ? Promise.resolve({ TopicArn: TOPIC_ARN })
        : Promise.resolve({})
    );

    await expect(
      provider.create('L', 'AWS::SNS::Topic', {
        TopicName: 'topic',
        DeliveryStatusLogging: ['garbage'],
      })
    ).rejects.toThrow(/entries must be[\s\S]*\{Protocol, \.\.\.\} objects/);
  });
});

describe('buildDeliveryStatusAttributeMap warn mode (issue #1538)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('non-array container: warn mode returns an empty map with one warning; skip mode stays silent', () => {
    expect(buildDeliveryStatusAttributeMap('enabled', 'L', 'warn').size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);

    warn.mockClear();
    expect(buildDeliveryStatusAttributeMap('enabled', 'L', 'skip').size).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warn mode still warns on a duplicate-protocol collision (desired-side advice)', () => {
    // The collision warning is gated on the DESIRED side, which since #1538
    // is 'throw' (create) OR 'warn' (update) — not 'throw' alone.
    const map = buildDeliveryStatusAttributeMap(
      [
        { Protocol: 'http/s', SuccessFeedbackRoleArn: ROLE_A },
        { Protocol: 'https', SuccessFeedbackRoleArn: ROLE_B },
      ],
      'MyTopic',
      'warn'
    );

    expect([...map.entries()]).toEqual([['HTTPSuccessFeedbackRoleArn', ROLE_B]]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('more than one entry');
  });

  it('warn mode never throws on any malformed shape', () => {
    expect(() => buildDeliveryStatusAttributeMap('enabled', 'L', 'warn')).not.toThrow();
    expect(() => buildDeliveryStatusAttributeMap([null, 42, []], 'L', 'warn')).not.toThrow();
    expect(() =>
      buildDeliveryStatusAttributeMap([{ Protocol: 'smtp' }], 'L', 'warn')
    ).not.toThrow();
  });
});

describe('per-entry skip interacting with the removal-reset arm (issue #1538 review)', () => {
  let provider: SNSTopicProvider;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSend.mockResolvedValue({});
    provider = new SNSTopicProvider();
  });

  it('an unsupported-protocol DESIRED entry resets the attributes its previous twin had set', async () => {
    // The most realistic breakage: the previous side carries a valid lambda
    // entry; the desired (state-derived) side carries a typo'd protocol for
    // the same intent. The typo'd entry maps to no attribute names, so the
    // removal-reset arm treats the lambda attributes as removed — pinned
    // here as the intended, well-defined semantic (and the warn says so).
    const previous = {
      TopicName: 'topic',
      DeliveryStatusLogging: [{ Protocol: 'lambda', SuccessFeedbackRoleArn: ROLE_A }],
    };
    const desired = {
      TopicName: 'topic',
      DeliveryStatusLogging: [{ Protocol: 'lamda', SuccessFeedbackRoleArn: ROLE_A }],
    };

    await provider.update('L', TOPIC_ARN, 'AWS::SNS::Topic', desired, previous);

    expect(setAttributeCalls()).toEqual([
      {
        TopicArn: TOPIC_ARN,
        AttributeName: 'LambdaSuccessFeedbackRoleArn',
        AttributeValue: '',
      },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]?.[0] as string;
    expect(message).toContain('"lamda"');
    expect(message).toMatch(/previously set for the skipped entry's protocol are reset/);
  });
});

describe('duplicate-protocol collision gate polarity (issue #1538 review)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("stays SILENT on a duplicate protocol in 'skip' mode (previous side)", () => {
    // The gate flipped from `onMalformed === 'throw'` to `!== 'skip'`; pin
    // the skip side so the previous-side walk never starts warning about
    // entries the user cannot act on.
    const map = buildDeliveryStatusAttributeMap(
      [
        { Protocol: 'lambda', SuccessFeedbackRoleArn: ROLE_A },
        { Protocol: 'lambda', SuccessFeedbackRoleArn: ROLE_B },
      ],
      'MyTopic',
      'skip'
    );

    expect([...map.entries()]).toEqual([['LambdaSuccessFeedbackRoleArn', ROLE_B]]);
    expect(warn).not.toHaveBeenCalled();
  });
});
