import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { GetTopicAttributesCommand, SetTopicAttributesCommand } from '@aws-sdk/client-sns';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sns: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

const childLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => childLogger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  SNSTopicPolicyProvider,
  defaultTopicPolicy,
} from '../../../src/provisioning/providers/sns-topic-policy-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

const TYPE = 'AWS::SNS::TopicPolicy';
const T1 = 'arn:aws:sns:us-east-1:123456789012:topic-1';
const T2 = 'arn:aws:sns:us-east-1:123456789012:topic-2';
const T3 = 'arn:aws:sns:us-east-1:123456789012:topic-3';
const DOC_OLD = {
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Principal: { Service: 'events.amazonaws.com' }, Action: 'sns:Publish', Resource: '*' }],
};
const DOC_NEW = {
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Principal: { Service: 's3.amazonaws.com' }, Action: 'sns:Publish', Resource: '*' }],
};

function notFound(): Error {
  const e = new Error('Topic does not exist');
  e.name = 'NotFoundException';
  return e;
}

function named(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

/** Every SetTopicAttributes call, in order, as [TopicArn, AttributeValue]. */
function sets(): Array<[string, string]> {
  return mockSend.mock.calls
    .map((c) => c[0] as unknown)
    .filter((cmd): cmd is SetTopicAttributesCommand => cmd instanceof SetTopicAttributesCommand)
    .map((cmd) => [cmd.input.TopicArn!, cmd.input.AttributeValue!]);
}

function reads(): string[] {
  return mockSend.mock.calls
    .map((c) => c[0] as unknown)
    .filter((cmd): cmd is GetTopicAttributesCommand => cmd instanceof GetTopicAttributesCommand)
    .map((cmd) => cmd.input.TopicArn!);
}

/** Route mockSend by command: GetTopicAttributes answers from `policies`, SetTopicAttributes from `setErrors`. */
function routeSend(
  policies: Record<string, string | Error | undefined> = {},
  setErrors: Record<string, Error> = {}
): void {
  mockSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof GetTopicAttributesCommand) {
      const p = policies[cmd.input.TopicArn!];
      if (p instanceof Error) return Promise.reject(p);
      return Promise.resolve({ Attributes: p === undefined ? {} : { Policy: p } });
    }
    if (cmd instanceof SetTopicAttributesCommand) {
      const err = setErrors[cmd.input.TopicArn!];
      return err ? Promise.reject(err) : Promise.resolve({});
    }
    return Promise.reject(new Error('unexpected command'));
  });
}

describe('defaultTopicPolicy (go-to-k/cdkd#4610)', () => {
  it('is the policy SNS gives a new topic, scoped to the ARN and its owner account', () => {
    const doc = JSON.parse(defaultTopicPolicy(T2)!) as {
      Id: string;
      Statement: Array<{ Resource: string; Condition: unknown; Principal: unknown; Action: string[] }>;
    };
    expect(doc.Id).toBe('__default_policy_ID');
    expect(doc.Statement).toHaveLength(1);
    expect(doc.Statement[0]!.Resource).toBe(T2);
    expect(doc.Statement[0]!.Condition).toEqual({
      StringEquals: { 'AWS:SourceOwner': '123456789012' },
    });
    expect(doc.Statement[0]!.Principal).toEqual({ AWS: '*' });
    expect(doc.Statement[0]!.Action).toContain('SNS:Publish');
  });

  it('is exactly the CloudFormation handler document', () => {
    expect(JSON.parse(defaultTopicPolicy(T2)!)).toEqual({
      Version: '2008-10-17',
      Id: '__default_policy_ID',
      Statement: [
        {
          Sid: '__default_statement_ID',
          Effect: 'Allow',
          Principal: { AWS: '*' },
          Action: [
            'SNS:GetTopicAttributes',
            'SNS:SetTopicAttributes',
            'SNS:AddPermission',
            'SNS:RemovePermission',
            'SNS:DeleteTopic',
            'SNS:Subscribe',
            'SNS:ListSubscriptionsByTopic',
            'SNS:Publish',
          ],
          Resource: T2,
          Condition: { StringEquals: { 'AWS:SourceOwner': '123456789012' } },
        },
      ],
    });
  });

  it('takes the account of another partition from the ARN', () => {
    const arn = 'arn:aws-cn:sns:cn-north-1:210987654321:t';
    const doc = JSON.parse(defaultTopicPolicy(arn)!) as {
      Statement: Array<{ Resource: string; Condition: { StringEquals: Record<string, string> } }>;
    };
    expect(doc.Statement[0]!.Resource).toBe(arn);
    expect(doc.Statement[0]!.Condition.StringEquals['AWS:SourceOwner']).toBe('210987654321');
  });

  it('is undefined for a value that is not a topic ARN', () => {
    expect(defaultTopicPolicy('')).toBeUndefined();
    expect(defaultTopicPolicy('MyStack-MyTopicPolicy-XYZ')).toBeUndefined();
  });
});

describe('SNSTopicPolicyProvider.update resets a dropped topic (go-to-k/cdkd#4610)', () => {
  let provider: SNSTopicPolicyProvider;

  beforeEach(() => {
    mockSend.mockReset();
    vi.clearAllMocks();
    provider = new SNSTopicPolicyProvider();
  });

  it('writes the kept topics, then resets the topic the new list drops to its default policy', async () => {
    routeSend();
    const result = await provider.update(
      'P',
      `${T1},${T2}`,
      TYPE,
      { Topics: [T1], PolicyDocument: DOC_NEW },
      { Topics: [T1, T2], PolicyDocument: DOC_OLD }
    );
    expect(sets()).toEqual([
      [T1, JSON.stringify(DOC_NEW)],
      [T2, defaultTopicPolicy(T2)!],
    ]);
    // Never the empty Policy SNS rejects.
    expect(sets().map(([, v]) => v)).not.toContain('');
    expect(result).toEqual({ physicalId: T1, wasReplaced: false, attributes: {} });
  });

  it('resets nothing when the list keeps every recorded topic (negative control)', async () => {
    routeSend();
    await provider.update(
      'P',
      `${T1},${T2}`,
      TYPE,
      { Topics: [T2, T1, T3], PolicyDocument: DOC_NEW },
      { Topics: [T1, T2], PolicyDocument: DOC_OLD }
    );
    expect(sets().map(([arn]) => arn)).toEqual([T2, T1, T3]);
    expect(reads()).toEqual([]);
  });

  it('a revert of a completed update ([T1] -> [T1,T2], reverted with update(prev)) resets T2 by the id', async () => {
    // The in-place revert (go-to-k/cdkd#4615) passes the CURRENT record's id
    // (what the failed deploy wrote) with the previous properties as desired
    // and the attempted ones as previous.
    routeSend();
    const result = await provider.update(
      'P',
      `${T1},${T2}`,
      TYPE,
      { Topics: [T1], PolicyDocument: DOC_OLD },
      { Topics: [T1, T2], PolicyDocument: DOC_NEW }
    );
    expect(sets()).toEqual([
      [T1, JSON.stringify(DOC_OLD)],
      [T2, defaultTopicPolicy(T2)!],
    ]);
    // The id names T2 as written: no content read is needed.
    expect(reads()).toEqual([]);
    expect(result.physicalId).toBe(T1);
  });

  describe('a topic only the previous bag lists (an attempted list)', () => {
    it('is reset when it carries that bag document (key order and whitespace differ)', async () => {
      const live = '{ "Statement": [{"Resource":"*","Action":"sns:Publish","Principal":{"Service":"s3.amazonaws.com"},"Effect":"Allow"}], "Version":"2012-10-17" }';
      routeSend({ [T2]: live });
      await provider.update(
        'P',
        T1,
        TYPE,
        { Topics: [T1], PolicyDocument: DOC_OLD },
        { Topics: [T1, T2], PolicyDocument: DOC_NEW }
      );
      expect(sets()).toEqual([
        [T1, JSON.stringify(DOC_OLD)],
        [T2, defaultTopicPolicy(T2)!],
      ]);
    });

    it('is read BEFORE any write', async () => {
      routeSend({ [T2]: JSON.stringify(DOC_NEW) });
      await provider.update(
        'P',
        T1,
        TYPE,
        { Topics: [T1], PolicyDocument: DOC_OLD },
        { Topics: [T1, T2], PolicyDocument: DOC_NEW }
      );
      const first = mockSend.mock.calls[0]![0] as unknown;
      expect(first).toBeInstanceOf(GetTopicAttributesCommand);
    });

    it('is neither read nor reset when the new list keeps it', async () => {
      routeSend({ [T2]: JSON.stringify(DOC_NEW) });
      await provider.update(
        'P',
        T1,
        TYPE,
        { Topics: [T1, T2], PolicyDocument: DOC_NEW },
        { Topics: [T1, T2], PolicyDocument: DOC_NEW }
      );
      expect(reads()).toEqual([]);
      expect(sets()).toEqual([
        [T1, JSON.stringify(DOC_NEW)],
        [T2, JSON.stringify(DOC_NEW)],
      ]);
    });

    it('is left alone when it carries another writer policy', async () => {
      routeSend({ [T2]: JSON.stringify(DOC_OLD) });
      await provider.update(
        'P',
        T1,
        TYPE,
        { Topics: [T1], PolicyDocument: DOC_OLD },
        { Topics: [T1, T2], PolicyDocument: DOC_NEW }
      );
      expect(reads()).toEqual([T2]);
      expect(sets().map(([arn]) => arn)).toEqual([T1]);
    });

    it('is left alone when it already carries its default policy, or is gone', async () => {
      routeSend({ [T2]: defaultTopicPolicy(T2), [T3]: notFound() });
      await provider.update(
        'P',
        T1,
        TYPE,
        { Topics: [T1], PolicyDocument: DOC_OLD },
        { Topics: [T1, T2, T3], PolicyDocument: DOC_NEW }
      );
      expect(sets().map(([arn]) => arn)).toEqual([T1]);
    });

    it('is left alone, with a warning naming it, when its policy cannot be read', async () => {
      routeSend({ [T2]: named('AuthorizationErrorException', 'not authorized') });
      await provider.update(
        'P',
        T1,
        TYPE,
        { Topics: [T1], PolicyDocument: DOC_OLD },
        { Topics: [T1, T2], PolicyDocument: DOC_NEW }
      );
      expect(sets().map(([arn]) => arn)).toEqual([T1]);
      const warned = childLogger.warn.mock.calls.map((c) => String(c[0]));
      expect(warned.some((w) => w.includes(T2) && w.includes('AuthorizationErrorException'))).toBe(true);
    });

    it('is neither read nor reset, with a warning, when the bag records no document', async () => {
      routeSend({ [T2]: JSON.stringify(DOC_NEW) });
      await provider.update(
        'P',
        T1,
        TYPE,
        { Topics: [T1], PolicyDocument: DOC_OLD },
        { Topics: [T1, T2] }
      );
      expect(reads()).toEqual([]);
      expect(sets().map(([arn]) => arn)).toEqual([T1]);
      const warned = childLogger.warn.mock.calls.map((c) => String(c[0]));
      expect(warned.some((w) => w.includes(T2))).toBe(true);
    });

    it('matches a string document by content too', async () => {
      routeSend({ [T2]: JSON.stringify(DOC_NEW) });
      await provider.update(
        'P',
        T1,
        TYPE,
        { Topics: [T1], PolicyDocument: DOC_OLD },
        { Topics: [T1, T2], PolicyDocument: JSON.stringify(DOC_NEW, null, 2) }
      );
      expect(sets().map(([arn]) => arn)).toEqual([T1, T2]);
    });
  });

  it('skips a dropped topic that is gone', async () => {
    routeSend({}, { [T2]: notFound() });
    await expect(
      provider.update(
        'P',
        `${T1},${T2}`,
        TYPE,
        { Topics: [T1], PolicyDocument: DOC_NEW },
        { Topics: [T1, T2], PolicyDocument: DOC_OLD },
        { expectedRegion: 'us-east-1' }
      )
    ).resolves.toMatchObject({ physicalId: T1 });
  });

  it('refuses a dropped topic NotFound when the client is in another region than the record', async () => {
    routeSend({}, { [T2]: notFound() });
    const err = await provider
      .update(
        'P',
        `${T1},${T2}`,
        TYPE,
        { Topics: [T1], PolicyDocument: DOC_NEW },
        { Topics: [T1, T2], PolicyDocument: DOC_OLD },
        { expectedRegion: 'us-west-2' }
      )
      .catch((e: unknown) => e);
    // The region refusal passes through the catch unwrapped, addressed to the topic.
    expect(err).toBeInstanceOf(ProvisioningError);
    expect((err as Error).message).toMatch(/^Refusing to treat NotFound/);
    expect((err as Error).message).toContain('us-west-2');
    expect((err as ProvisioningError).physicalId).toBe(T2);
  });

  it('fails the update when resetting a dropped topic fails', async () => {
    routeSend({}, { [T2]: named('InvalidParameterException', 'Invalid parameter: Policy') });
    const err = await provider
      .update(
        'P',
        `${T1},${T2}`,
        TYPE,
        { Topics: [T1], PolicyDocument: DOC_NEW },
        { Topics: [T1, T2], PolicyDocument: DOC_OLD }
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProvisioningError);
    expect((err as Error).message).toContain('Failed to update SNS topic policy P');
  });
});

describe('SNSTopicPolicyProvider.delete resets each topic to its default policy (go-to-k/cdkd#4610)', () => {
  let provider: SNSTopicPolicyProvider;

  beforeEach(() => {
    mockSend.mockReset();
    vi.clearAllMocks();
    provider = new SNSTopicPolicyProvider();
  });

  it('writes each named topic its default policy, never an empty Policy', async () => {
    routeSend();
    await provider.delete('P', `${T1},${T2}`, TYPE, { Topics: [T1, T2, T3] });
    expect(sets()).toEqual([
      [T1, defaultTopicPolicy(T1)!],
      [T2, defaultTopicPolicy(T2)!],
    ]);
  });

  it('throws on InvalidParameter instead of reporting the policy deleted', async () => {
    // Before #4610 an empty Policy drew InvalidParameter, which the delete read
    // as "already removed": the policy stayed and the record was dropped.
    routeSend({}, { [T1]: named('InvalidParameterException', 'Invalid parameter: Policy Error: null') });
    await expect(provider.delete('P', T1, TYPE)).rejects.toThrow(
      /Failed to delete SNS topic policy P/
    );
  });

  it('skips a topic that is gone and still resets the rest', async () => {
    routeSend({}, { [T1]: notFound() });
    await provider.delete('P', `${T1},${T2}`, TYPE, undefined, { expectedRegion: 'us-east-1' });
    expect(sets().map(([arn]) => arn)).toEqual([T1, T2]);
  });

  it('refuses a NotFound when the client is in another region than the record', async () => {
    routeSend({}, { [T1]: notFound() });
    const err = await provider
      .delete('P', T1, TYPE, undefined, { expectedRegion: 'us-west-2' })
      .catch((e: unknown) => e);
    // Passed through unwrapped: not the "Failed to delete" wrapper, addressed to the topic.
    expect(err).toBeInstanceOf(ProvisioningError);
    expect((err as Error).message).toMatch(/^Refusing to treat NotFound/);
    expect((err as Error).message).toContain('us-west-2');
    expect((err as ProvisioningError).physicalId).toBe(T1);
  });

  it('falls back to the literal topic ARNs Topics lists when the id is a policy NAME (old CFn migration)', async () => {
    routeSend();
    await provider.delete('P', 'MyStack-MyTopicPolicy-XYZ', TYPE, {
      Topics: [T1, T1, { Ref: 'X' }, 'not-an-arn', T2],
    });
    // Deduplicated, non-ARN entries dropped.
    expect(sets()).toEqual([
      [T1, defaultTopicPolicy(T1)!],
      [T2, defaultTopicPolicy(T2)!],
    ]);
  });

  it('keeps the id ARNs and adds the listed ones when the id mixes an ARN with a non-ARN segment', async () => {
    routeSend();
    await provider.delete('P', `${T3},MyStack-Policy-XYZ`, TYPE, { Topics: [T1] });
    expect(sets().map(([arn]) => arn)).toEqual([T3, T1]);
  });

  it('never widens an all-ARN id (a failed create mark) to the Topics list', async () => {
    routeSend();
    await provider.delete('P', T1, TYPE, { Topics: [T1, T2, T3] });
    expect(sets().map(([arn]) => arn)).toEqual([T1]);
  });

  it('refuses, non-retryably and before any write, an empty id even when Topics lists ARNs', async () => {
    routeSend();
    const err = await provider
      .delete('P', '', TYPE, { Topics: [T1, T2] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProvisioningError);
    expect((err as Error).message).toMatch(/its physical id is empty/);
    expect((err as Error).message).toContain('cdkd state orphan');
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('resets a topic named by both an id ARN segment and Topics exactly once', async () => {
    routeSend();
    await provider.delete('P', `${T1},MyStack-Policy-XYZ`, TYPE, { Topics: [T1] });
    expect(sets()).toEqual([[T1, defaultTopicPolicy(T1)!]]);
  });

  it('refuses a non-ARN id whose Topics lists no ARN, naming the by-hand reset and the record remedy', async () => {
    routeSend();
    const err = await provider
      .delete('P', 'MyStack-Policy-XYZ', TYPE, { Topics: [{ Ref: 'X' }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProvisioningError);
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect((err as Error).message).toContain('back to its default policy by hand');
    expect((err as Error).message).toContain('cdkd state orphan');
    expect((err as Error).message).toContain('--resource P');
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('SNSTopicPolicyProvider.update edge cases (go-to-k/cdkd#4610)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    vi.clearAllMocks();
  });

  it('does not address a non-ARN id segment; only debug-logs it when the previous Topics was checked instead', async () => {
    // An old CFn-migrated record: the id is the policy NAME, Topics the ARNs.
    routeSend({ [T2]: JSON.stringify(DOC_OLD) });
    await new SNSTopicPolicyProvider().update(
      'P',
      'MyStack-Policy-XYZ',
      TYPE,
      { Topics: [T1], PolicyDocument: DOC_NEW },
      { Topics: [T1, T2], PolicyDocument: DOC_OLD }
    );
    // T2 carried the record's document, so the content check resets it.
    expect(sets().map(([arn]) => arn)).toEqual([T1, T2]);
    expect(childLogger.warn).not.toHaveBeenCalled();
    const debugged = childLogger.debug.mock.calls.map((c) => String(c[0]));
    expect(debugged.some((d) => d.includes('MyStack-Policy-XYZ') && d.includes('checked instead'))).toBe(true);
  });

  it('warns about a non-ARN id segment when the previous Topics lists no ARN either', async () => {
    routeSend();
    await new SNSTopicPolicyProvider().update(
      'P',
      `${T1},not-an-arn`,
      TYPE,
      { Topics: [T1], PolicyDocument: DOC_NEW },
      { Topics: [{ Ref: 'X' }], PolicyDocument: DOC_OLD }
    );
    expect(sets().map(([arn]) => arn)).toEqual([T1]);
    const warned = childLogger.warn.mock.calls.map((c) => String(c[0]));
    expect(warned.some((w) => w.includes('not-an-arn') && w.includes('may still carry'))).toBe(true);
  });

  it('reads only literal topic ARNs from the previous Topics, once each', async () => {
    routeSend({ [T2]: JSON.stringify(DOC_NEW) });
    await new SNSTopicPolicyProvider().update(
      'P',
      T1,
      TYPE,
      { Topics: [T1], PolicyDocument: DOC_OLD },
      { Topics: [T2, T2, 'not-an-arn', `${T2},${T3}`, { Ref: 'X' }], PolicyDocument: DOC_NEW }
    );
    expect(reads()).toEqual([T2]);
  });

  it('treats an empty-string previous PolicyDocument as none recorded', async () => {
    routeSend({ [T2]: '' });
    await new SNSTopicPolicyProvider().update(
      'P',
      T1,
      TYPE,
      { Topics: [T1], PolicyDocument: DOC_OLD },
      { Topics: [T1, T2], PolicyDocument: '' }
    );
    expect(reads()).toEqual([]);
    expect(sets().map(([arn]) => arn)).toEqual([T1]);
    const warned = childLogger.warn.mock.calls.map((c) => String(c[0]));
    expect(warned.some((w) => w.includes('no policy document recorded'))).toBe(true);
  });

  it('masks the non-ARN id segment warning', async () => {
    routeSend();
    await new SNSTopicPolicyProvider().update(
      'P',
      `${T1},secret-policy-name`,
      TYPE,
      { Topics: [T1], PolicyDocument: DOC_NEW },
      { Topics: [{ Ref: 'X' }], PolicyDocument: DOC_OLD },
      { maskSecrets: (t: string) => t.split('secret-policy-name').join('***') }
    );
    const warned = childLogger.warn.mock.calls.map((c) => String(c[0]));
    expect(warned.some((w) => w.includes('may still carry') && w.includes('***'))).toBe(true);
    expect(warned.some((w) => w.includes('secret-policy-name'))).toBe(false);
  });

  it('masks the "no recorded document" warning', async () => {
    routeSend();
    await new SNSTopicPolicyProvider().update(
      'P',
      T1,
      TYPE,
      { Topics: [T1], PolicyDocument: DOC_OLD },
      { Topics: [T1, T2] },
      { maskSecrets: (t: string) => t.split('topic-2').join('***') }
    );
    const warned = childLogger.warn.mock.calls.map((c) => String(c[0]));
    expect(warned.some((w) => w.includes('no policy document recorded') && w.includes('***'))).toBe(true);
    expect(warned.some((w) => w.includes('topic-2'))).toBe(false);
  });

  it('masks the update-path warnings with the context masker', async () => {
    routeSend({ [T2]: named('AuthorizationErrorException', 'not authorized') });
    await new SNSTopicPolicyProvider().update(
      'P',
      T1,
      TYPE,
      { Topics: [T1], PolicyDocument: DOC_OLD },
      { Topics: [T1, T2], PolicyDocument: DOC_NEW },
      { maskSecrets: (t: string) => t.split('topic-2').join('***') }
    );
    const warned = childLogger.warn.mock.calls.map((c) => String(c[0]));
    expect(warned.length).toBeGreaterThan(0);
    expect(warned.some((w) => w.includes('topic-2'))).toBe(false);
    expect(warned.some((w) => w.includes('***'))).toBe(true);
  });
});
