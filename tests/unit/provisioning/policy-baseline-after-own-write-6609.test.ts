import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { GetTopicAttributesCommand } from '@aws-sdk/client-sns';
import { GetPolicyCommand, ResourceNotFoundException } from '@aws-sdk/client-lambda';

const mockSend = vi.fn();
const childLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(function (this: unknown) { return this; }),
}));
const loggedNoBaseline = (): boolean =>
  childLogger.debug.mock.calls.some((c) => String(c[0]).includes('No drift baseline captured'));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sqs: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    sns: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    lambda: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
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

import { SQSQueuePolicyProvider } from '../../../src/provisioning/providers/sqs-queue-policy-provider.js';
import { SNSTopicPolicyProvider } from '../../../src/provisioning/providers/sns-topic-policy-provider.js';
import { LambdaPermissionProvider } from '../../../src/provisioning/providers/lambda-permission-provider.js';
import { preFixBaselineUncomparedDriftKeys } from '../../../src/cli/commands/drift/baseline-keys.js';

const AFTER = { afterOwnWrite: true } as const;

function zeroDelays(provider: object): void {
  (provider as { ownWriteRereadDelaysMs: readonly number[] }).ownWriteRereadDelaysMs = [0, 0, 0];
}

const Q1 = 'https://sqs.us-east-1.amazonaws.com/111111111111/q1';
const Q2 = 'https://sqs.us-east-1.amazonaws.com/111111111111/q2';
const T1 = 'arn:aws:sns:us-east-1:111111111111:topic1';

const sqsDeclared = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { AWS: '111111111111' },
      Action: 'sqs:SendMessage',
      Resource: 'arn:aws:sqs:us-east-1:111111111111:q1',
    },
  ],
};
const sqsOld = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { AWS: '222222222222' },
      Action: 'sqs:ReceiveMessage',
      Resource: 'arn:aws:sqs:us-east-1:111111111111:q1',
    },
  ],
};
const snsDeclared = {
  Version: '2008-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { Service: 's3.amazonaws.com' },
      Action: 'sns:Publish',
      Resource: T1,
    },
  ],
};
const snsOld = {
  Version: '2008-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { AWS: '*' },
      Action: ['sns:GetTopicAttributes', 'sns:Subscribe'],
      Resource: T1,
    },
  ],
};

const snsDefault = {
  Version: '2008-10-17',
  Id: '__default_policy_ID',
  Statement: [
    {
      Sid: '__default_statement_ID',
      Effect: 'Allow',
      Principal: { AWS: '*' },
      Action: ['SNS:GetTopicAttributes', 'SNS:Subscribe'],
      Resource: T1,
    },
  ],
};

const attrs = (doc?: unknown) => ({
  Attributes: doc === undefined ? {} : { Policy: JSON.stringify(doc) },
});

describe('SQSQueuePolicyProvider.readCurrentState afterOwnWrite (#6609)', () => {
  let provider: SQSQueuePolicyProvider;
  const props = { Queues: [Q1], PolicyDocument: sqsDeclared };
  const read = (id: string, p: Record<string, unknown> | undefined, ctx?: typeof AFTER) =>
    provider.readCurrentState(id, 'L', 'AWS::SQS::QueuePolicy', p, ctx);

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new SQSQueuePolicyProvider();
    zeroDelays(provider);
  });

  it('1: settles on the first read when it is the declared document', async () => {
    mockSend.mockResolvedValueOnce(attrs(sqsDeclared));
    expect(await read(Q1, props, AFTER)).toEqual({ Queues: [Q1], PolicyDocument: sqsDeclared });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetQueueAttributesCommand);
  });

  it('2: re-reads past the OLD document until the declared one shows', async () => {
    mockSend
      .mockResolvedValueOnce(attrs(sqsOld))
      .mockResolvedValueOnce(attrs(sqsOld))
      .mockResolvedValueOnce(attrs(sqsDeclared));
    expect(await read(Q1, props, AFTER)).toEqual({ Queues: [Q1], PolicyDocument: sqsDeclared });
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it('3: re-reads past a missing Policy attribute', async () => {
    mockSend.mockResolvedValueOnce(attrs()).mockResolvedValueOnce(attrs(sqsDeclared));
    expect(await read(Q1, props, AFTER)).toEqual({ Queues: [Q1], PolicyDocument: sqsDeclared });
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('4: a different document that never goes away is returned as read (1 + 3 reads)', async () => {
    mockSend.mockResolvedValue(attrs(sqsOld));
    expect(await read(Q1, props, AFTER)).toEqual({ Queues: [Q1], PolicyDocument: sqsOld });
    expect(mockSend).toHaveBeenCalledTimes(4);
  });

  it('4b: no Policy attribute on every read captures no baseline (4 reads)', async () => {
    mockSend.mockResolvedValue(attrs());
    expect(await read(Q1, props, AFTER)).toBeUndefined();
    expect(mockSend).toHaveBeenCalledTimes(4);
  });

  it('4c: two queues, the second never gets a policy, capture no baseline', async () => {
    mockSend.mockImplementation(async (cmd: { input: { QueueUrl: string } }) =>
      cmd.input.QueueUrl === Q1 ? attrs(sqsDeclared) : attrs()
    );
    expect(
      await read(`${Q1},${Q2}`, { Queues: [Q1, Q2], PolicyDocument: sqsDeclared }, AFTER)
    ).toBeUndefined();
    expect(mockSend).toHaveBeenCalledTimes(8);
  });

  it('4e: two queues, Q2 still OLD on read 1, both declared on read 2: 4 sends', async () => {
    mockSend
      .mockResolvedValueOnce(attrs(sqsDeclared))
      .mockResolvedValueOnce(attrs(sqsOld))
      .mockResolvedValueOnce(attrs(sqsDeclared))
      .mockResolvedValueOnce(attrs(sqsDeclared));
    expect(
      await read(`${Q1},${Q2}`, { Queues: [Q1, Q2], PolicyDocument: sqsDeclared }, AFTER)
    ).toEqual({ Queues: [Q1, Q2], PolicyDocument: sqsDeclared });
    expect(mockSend).toHaveBeenCalledTimes(4);
  });

  it('4f: two queues, Q2 OLD on every read: returned as read after 8 sends', async () => {
    mockSend.mockImplementation(async (cmd: { input: { QueueUrl: string } }) =>
      cmd.input.QueueUrl === Q1 ? attrs(sqsDeclared) : attrs(sqsOld)
    );
    expect(
      await read(`${Q1},${Q2}`, { Queues: [Q1, Q2], PolicyDocument: sqsDeclared }, AFTER)
    ).toEqual({ Queues: [Q1, Q2], PolicyDocument: sqsDeclared });
    expect(mockSend).toHaveBeenCalledTimes(8);
  });

  it('4d: a one-element condition list settles against the scalar SQS stores', async () => {
    const withCond = (v: unknown) => ({
      Version: '2012-10-17',
      Statement: [
        {
          ...sqsDeclared.Statement[0],
          Condition: { StringEquals: { 'aws:SourceAccount': v } },
        },
      ],
    });
    const aws = withCond('111111111111');
    mockSend.mockResolvedValueOnce(attrs(aws));
    expect(
      await read(Q1, { Queues: [Q1], PolicyDocument: withCond(['111111111111']) }, AFTER)
    ).toEqual({ Queues: [Q1], PolicyDocument: aws });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('5: a bare account principal settles against its root-ARN readback', async () => {
    const aws = {
      Version: '2012-10-17',
      Statement: [
        {
          ...sqsDeclared.Statement[0],
          Principal: { AWS: 'arn:aws:iam::111111111111:root' },
        },
      ],
    };
    mockSend.mockResolvedValueOnce(attrs(aws));
    expect(await read(Q1, props, AFTER)).toEqual({ Queues: [Q1], PolicyDocument: aws });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('6: a drift read (no context) takes the OLD document as it is', async () => {
    mockSend.mockResolvedValueOnce(attrs(sqsOld));
    expect(await read(Q1, props)).toEqual({ Queues: [Q1], PolicyDocument: sqsOld });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('7: afterOwnWrite with no properties takes the first answer', async () => {
    mockSend.mockResolvedValueOnce(attrs(sqsOld));
    expect(await read(Q1, undefined, AFTER)).toEqual({ Queues: [Q1], PolicyDocument: sqsOld });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('8: two queues, the second without a policy on the first round, settle on round 2', async () => {
    const both = `${Q1},${Q2}`;
    mockSend
      .mockResolvedValueOnce(attrs(sqsDeclared))
      .mockResolvedValueOnce(attrs())
      .mockResolvedValueOnce(attrs(sqsDeclared))
      .mockResolvedValueOnce(attrs(sqsDeclared));
    expect(await read(both, { Queues: [Q1, Q2], PolicyDocument: sqsDeclared }, AFTER)).toEqual({
      Queues: [Q1, Q2],
      PolicyDocument: sqsDeclared,
    });
    expect(mockSend).toHaveBeenCalledTimes(4);
  });

  it('8b: two queues both declared on the first round cost one read per queue', async () => {
    mockSend.mockResolvedValue(attrs(sqsDeclared));
    expect(
      await read(`${Q1},${Q2}`, { Queues: [Q1, Q2], PolicyDocument: sqsDeclared }, AFTER)
    ).toEqual({ Queues: [Q1, Q2], PolicyDocument: sqsDeclared });
    expect(mockSend).toHaveBeenCalledTimes(2);
  });
});

describe('SNSTopicPolicyProvider.readCurrentState afterOwnWrite (#6609)', () => {
  let provider: SNSTopicPolicyProvider;
  const props = { Topics: [T1], PolicyDocument: snsDeclared };
  const read = (p: Record<string, unknown> | undefined, ctx?: typeof AFTER) =>
    provider.readCurrentState(T1, 'L', 'AWS::SNS::TopicPolicy', p, ctx);

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new SNSTopicPolicyProvider();
    zeroDelays(provider);
  });

  it('1: settles on the first read when it is the declared document', async () => {
    mockSend.mockResolvedValueOnce(attrs(snsDeclared));
    expect(await read(props, AFTER)).toEqual({ Topics: [T1], PolicyDocument: snsDeclared });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetTopicAttributesCommand);
  });

  it('2: re-reads past the default document until the declared one shows', async () => {
    mockSend
      .mockResolvedValueOnce(attrs(snsOld))
      .mockResolvedValueOnce(attrs(snsOld))
      .mockResolvedValueOnce(attrs(snsDeclared));
    expect(await read(props, AFTER)).toEqual({ Topics: [T1], PolicyDocument: snsDeclared });
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it('4: a different non-default document that never goes away is returned as read (4 reads)', async () => {
    mockSend.mockResolvedValue(attrs(snsOld));
    expect(await read(props, AFTER)).toEqual({ Topics: [T1], PolicyDocument: snsOld });
    expect(mockSend).toHaveBeenCalledTimes(4);
  });

  it('4b: the default policy on every read captures no baseline (4 reads)', async () => {
    mockSend.mockResolvedValue(attrs(snsDefault));
    expect(await read(props, AFTER)).toBeUndefined();
    expect(mockSend).toHaveBeenCalledTimes(4);
  });

  it('4c: default then declared settles on read 2', async () => {
    mockSend.mockResolvedValueOnce(attrs(snsDefault)).mockResolvedValueOnce(attrs(snsDeclared));
    expect(await read(props, AFTER)).toEqual({ Topics: [T1], PolicyDocument: snsDeclared });
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('6: a drift read (no context) takes the default document as it is', async () => {
    mockSend.mockResolvedValueOnce(attrs(snsOld));
    expect(await read(props)).toEqual({ Topics: [T1], PolicyDocument: snsOld });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

describe('LambdaPermissionProvider.readCurrentState afterOwnWrite (#6609)', () => {
  let provider: LambdaPermissionProvider;
  const SID = 'perm-1';
  const props = {
    FunctionName: 'fn',
    Action: 'lambda:InvokeFunction',
    Principal: 's3.amazonaws.com',
    SourceArn: 'arn:aws:s3:::bucket',
    SourceAccount: '111111111111',
  };
  const policy = (stmt: Record<string, unknown>) => ({
    Policy: JSON.stringify({ Version: '2012-10-17', Statement: [{ Sid: SID, Effect: 'Allow', ...stmt }] }),
  });
  const stmt = (principal: unknown, extraCondition: Record<string, unknown> = {}) => ({
    Action: 'lambda:InvokeFunction',
    Principal: principal,
    Condition: {
      ArnLike: { 'AWS:SourceArn': 'arn:aws:s3:::bucket' },
      StringEquals: { 'AWS:SourceAccount': '111111111111' },
      ...extraCondition,
    },
  });
  const matching = policy(stmt({ Service: 's3.amazonaws.com' }));
  const old = policy(stmt({ Service: 'sns.amazonaws.com' }));
  const read = (p: Record<string, unknown>, ctx?: typeof AFTER) =>
    provider.readCurrentState(SID, 'L', 'AWS::Lambda::Permission', p, ctx);
  const expected = { ...props };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new LambdaPermissionProvider();
    zeroDelays(provider);
  });

  it('9: settles on the first read holding the matching statement', async () => {
    mockSend.mockResolvedValueOnce(matching);
    expect(await read(props, AFTER)).toEqual(expected);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetPolicyCommand);
  });

  it('10: re-reads past ResourceNotFoundException and a missing statement', async () => {
    mockSend
      .mockRejectedValueOnce(new ResourceNotFoundException({ message: 'x', $metadata: {} }))
      .mockResolvedValueOnce(matching);
    expect(await read(props, AFTER)).toEqual(expected);
    expect(mockSend).toHaveBeenCalledTimes(2);

    mockSend.mockReset();
    mockSend
      .mockResolvedValueOnce({
        Policy: JSON.stringify({ Version: '2012-10-17', Statement: [{ Sid: 'other' }] }),
      })
      .mockResolvedValueOnce(matching);
    expect(await read(props, AFTER)).toEqual(expected);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('11: a different principal that never goes away is returned as read (4 reads)', async () => {
    mockSend.mockResolvedValue(old);
    expect(await read(props, AFTER)).toEqual({ ...expected, Principal: 'sns.amazonaws.com' });
    expect(mockSend).toHaveBeenCalledTimes(4);
  });

  it('11b: the statement missing on every read captures no baseline (4 reads)', async () => {
    mockSend.mockResolvedValue({
      Policy: JSON.stringify({ Version: '2012-10-17', Statement: [{ Sid: 'other' }] }),
    });
    expect(await read(props, AFTER)).toBeUndefined();
    expect(mockSend).toHaveBeenCalledTimes(4);
    expect(loggedNoBaseline()).toBe(true);
  });

  it('12: a bare account principal settles against its root-ARN readback', async () => {
    mockSend.mockResolvedValueOnce(
      policy({
        Action: 'lambda:InvokeFunction',
        Principal: { AWS: 'arn:aws:iam::111111111111:root' },
      })
    );
    const result = await read(
      { FunctionName: 'fn', Action: 'lambda:InvokeFunction', Principal: '111111111111' },
      AFTER
    );
    expect(result).toEqual({
      FunctionName: 'fn',
      Action: 'lambda:InvokeFunction',
      Principal: 'arn:aws:iam::111111111111:root',
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('13: InvokedViaFunctionUrl false settles against a statement without the Bool condition', async () => {
    mockSend.mockResolvedValueOnce(matching);
    expect(await read({ ...props, InvokedViaFunctionUrl: false }, AFTER)).toEqual(expected);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('14b: afterOwnWrite without a FunctionName sends nothing and captures no baseline', async () => {
    expect(
      await read({ Action: 'lambda:InvokeFunction', Principal: 's3.amazonaws.com' }, AFTER)
    ).toBeUndefined();
    expect(mockSend).toHaveBeenCalledTimes(0);
    expect(loggedNoBaseline()).toBe(false);
  });

  it('13b: a declared empty SourceAccount settles against a statement without the condition', async () => {
    mockSend.mockResolvedValueOnce(
      policy({
        Action: 'lambda:InvokeFunction',
        Principal: { Service: 's3.amazonaws.com' },
        Condition: { ArnLike: { 'AWS:SourceArn': 'arn:aws:s3:::bucket' } },
      })
    );
    const { SourceAccount: _unused, ...rest } = props;
    void _unused;
    expect(await read({ ...rest, SourceAccount: '' }, AFTER)).toEqual({
      FunctionName: 'fn',
      Action: 'lambda:InvokeFunction',
      Principal: 's3.amazonaws.com',
      SourceArn: 'arn:aws:s3:::bucket',
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('14: a drift read (no context) takes the OLD statement as it is', async () => {
    mockSend.mockResolvedValueOnce(old);
    expect(await read(props)).toEqual({ ...expected, Principal: 'sns.amazonaws.com' });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

describe('preFixBaselineUncomparedDriftKeys third rule (#6609)', () => {
  const policyCases: Array<[string, unknown, unknown]> = [
    ['AWS::SQS::QueuePolicy', sqsDeclared, sqsOld],
    ['AWS::SNS::TopicPolicy', snsDeclared, snsOld],
  ];

  for (const [type, declared, old] of policyCases) {
    const other = { Version: '2012-10-17', Statement: [{ Effect: 'Deny', Principal: '*', Action: '*', Resource: '*' }] };
    it(`${type}: 15/19 observed OLD, live declared -> PolicyDocument`, () => {
      expect(
        preFixBaselineUncomparedDriftKeys(
          type,
          { PolicyDocument: old },
          { PolicyDocument: declared },
          { PolicyDocument: declared }
        )
      ).toEqual(['PolicyDocument']);
    });
    it(`${type}: 16 live differs from the template -> []`, () => {
      expect(
        preFixBaselineUncomparedDriftKeys(
          type,
          { PolicyDocument: old },
          { PolicyDocument: declared },
          { PolicyDocument: old }
        )
      ).toEqual([]);
    });
    it(`${type}: 17 observed declared, live declared -> []`, () => {
      expect(
        preFixBaselineUncomparedDriftKeys(
          type,
          { PolicyDocument: declared },
          { PolicyDocument: declared },
          { PolicyDocument: declared }
        )
      ).toEqual([]);
    });
    it(`${type}: 18 observed OLD, live OTHER -> []`, () => {
      expect(
        preFixBaselineUncomparedDriftKeys(
          type,
          { PolicyDocument: old },
          { PolicyDocument: declared },
          { PolicyDocument: other }
        )
      ).toEqual([]);
    });
  }

  const lp = {
    FunctionName: 'fn',
    Action: 'lambda:InvokeFunction',
    Principal: 's3.amazonaws.com',
    SourceArn: 'arn:aws:s3:::bucket',
    SourceAccount: '111111111111',
  };

  it('19b: heals across a one-element condition list vs scalar spelling', () => {
    const cond = (v: unknown) => ({
      Version: '2012-10-17',
      Statement: [
        { ...sqsDeclared.Statement[0], Condition: { StringEquals: { 'aws:SourceAccount': v } } },
      ],
    });
    expect(
      preFixBaselineUncomparedDriftKeys(
        'AWS::SQS::QueuePolicy',
        { PolicyDocument: sqsOld },
        { PolicyDocument: cond(['111111111111']) },
        { PolicyDocument: cond('111111111111') }
      )
    ).toEqual(['PolicyDocument']);
  });

  it('20: Lambda::Permission observed OLD principal, live declared -> the eight keys', () => {
    expect(
      preFixBaselineUncomparedDriftKeys(
        'AWS::Lambda::Permission',
        { ...lp, Principal: 'sns.amazonaws.com' },
        lp,
        lp
      )
    ).toEqual([
      'Action',
      'Principal',
      'SourceArn',
      'SourceAccount',
      'PrincipalOrgID',
      'EventSourceToken',
      'FunctionUrlAuthType',
      'InvokedViaFunctionUrl',
    ]);
  });

  it('20b: Lambda::Permission live differs from the template -> []', () => {
    expect(
      preFixBaselineUncomparedDriftKeys(
        'AWS::Lambda::Permission',
        { ...lp, Principal: 'sns.amazonaws.com' },
        lp,
        { ...lp, Principal: 'sns.amazonaws.com' }
      )
    ).toEqual([]);
  });

  it('21: an absent observed baseline -> [] for each type', () => {
    expect(
      preFixBaselineUncomparedDriftKeys(
        'AWS::SQS::QueuePolicy',
        undefined,
        { PolicyDocument: sqsDeclared },
        { PolicyDocument: sqsDeclared }
      )
    ).toEqual([]);
    expect(
      preFixBaselineUncomparedDriftKeys(
        'AWS::SNS::TopicPolicy',
        undefined,
        { PolicyDocument: snsDeclared },
        { PolicyDocument: snsDeclared }
      )
    ).toEqual([]);
    expect(preFixBaselineUncomparedDriftKeys('AWS::Lambda::Permission', undefined, lp, lp)).toEqual([]);
  });
});
