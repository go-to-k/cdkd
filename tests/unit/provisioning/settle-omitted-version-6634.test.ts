/**
 * go-to-k/cdkd#6634: S3, SQS, SNS, KMS, Secrets Manager and IAM's role trust
 * policy write `Version: 2008-10-17` (what an omitted `Version` means) into a
 * policy document submitted without one (measured, go-to-k/cdkd#6624). The
 * post-write settle must take that read as the declared document — one read,
 * no "never showed" warning — while a read `2012-10-17` against an omitted
 * `Version`, and any change to a declared `Version`, still differ.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();
const fakeClient = { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } };

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3: fakeClient,
    sqs: fakeClient,
    sns: fakeClient,
    iam: fakeClient,
    kms: fakeClient,
    sts: fakeClient,
  }),
}));

const childLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(function (this: unknown) { return this; }),
}));
/** The `refresh-observed` warnings the unsettled outcome prints. */
const unsettledWarnings = (): string[] =>
  childLogger.warn.mock.calls
    .map((c) => String(c[0]))
    .filter((m) => m.includes('refresh-observed'));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => childLogger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { KMSProvider } from '../../../src/provisioning/providers/kms-provider.js';
import { S3BucketPolicyProvider } from '../../../src/provisioning/providers/s3-bucket-policy-provider.js';
import { SQSQueuePolicyProvider } from '../../../src/provisioning/providers/sqs-queue-policy-provider.js';
import { SNSTopicPolicyProvider } from '../../../src/provisioning/providers/sns-topic-policy-provider.js';
import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';
import {
  efsPolicyMatchesDeclared,
  policyDocumentMatchesDeclared,
} from '../../../src/provisioning/settle-after-own-write.js';
import { preFixBaselineUncomparedDriftKeys } from '../../../src/cli/commands/drift/baseline-keys.js';

const AFTER = { afterOwnWrite: true } as const;
const ACCT = '111111111111';

/** Per SDK command name, the answers in order (the last one repeats); others answer `{}`. */
let script: Record<string, Array<() => unknown>> = {};
const callsOf = (command: string): number =>
  mockSend.mock.calls.filter((c) => (c[0] as object).constructor.name === command).length;

beforeEach(() => {
  mockSend.mockReset();
  childLogger.warn.mockClear();
  script = {};
  const served: Record<string, number> = {};
  mockSend.mockImplementation((command: object) => {
    const name = command.constructor.name;
    const queue = script[name];
    if (queue === undefined) return Promise.resolve({});
    const index = Math.min(served[name] ?? 0, queue.length - 1);
    served[name] = (served[name] ?? 0) + 1;
    return Promise.resolve(queue[index]!());
  });
});

function zeroDelays<T extends object>(provider: T): T {
  (provider as unknown as { ownWriteRereadDelaysMs: readonly number[] }).ownWriteRereadDelaysMs = [
    0, 0, 0,
  ];
  return provider;
}
const bag = (read: unknown): Record<string, unknown> => read as Record<string, unknown>;

/** A document with no `Version`, and the two spellings a service may read it back with. */
function shapes(statement: Record<string, unknown>) {
  const declared = { Statement: [statement] };
  return {
    declared,
    filled: { Version: '2008-10-17', Statement: [statement] },
    other: { Version: '2012-10-17', Statement: [statement] },
  };
}

type Caller = {
  name: string;
  command: string;
  docs: ReturnType<typeof shapes>;
  /** Script the read to answer `doc` on every call. */
  serve: (doc: unknown) => void;
  read: () => Promise<unknown>;
  key: string;
  /** Whether this caller prints the unsettled warning (a member settle). */
  warns: boolean;
};

const BUCKET = 'bkt';
const Q1 = `https://sqs.us-east-1.amazonaws.com/${ACCT}/q1`;
const T1 = `arn:aws:sns:us-east-1:${ACCT}:t1`;

const kmsDocs = shapes({
  Action: 'kms:*',
  Effect: 'Allow',
  Principal: { AWS: `arn:aws:iam::${ACCT}:root` },
  Resource: '*',
});
const s3Docs = shapes({
  Action: 's3:GetObject',
  Effect: 'Allow',
  Principal: { AWS: `arn:aws:iam::${ACCT}:root` },
  Resource: `arn:aws:s3:::${BUCKET}/*`,
});
const sqsDocs = shapes({
  Action: 'sqs:SendMessage',
  Effect: 'Allow',
  Principal: { AWS: `arn:aws:iam::${ACCT}:root` },
  Resource: `arn:aws:sqs:us-east-1:${ACCT}:q1`,
});
const snsDocs = shapes({
  Action: 'sns:Publish',
  Effect: 'Allow',
  Principal: { Service: 's3.amazonaws.com' },
  Resource: T1,
});
const trustDocs = shapes({
  Action: 'sts:AssumeRole',
  Effect: 'Allow',
  Principal: { Service: 'lambda.amazonaws.com' },
});

const kms = (): KMSProvider => {
  const provider = zeroDelays(new KMSProvider());
  (provider as unknown as { client: unknown }).client = fakeClient;
  return provider;
};

const callers: Caller[] = [
  {
    name: 'AWS::KMS::Key KeyPolicy',
    command: 'GetKeyPolicyCommand',
    docs: kmsDocs,
    serve: (doc) => {
      script['DescribeKeyCommand'] = [() => ({ KeyMetadata: { KeyId: 'k1', Enabled: true } })];
      script['GetKeyPolicyCommand'] = [() => ({ Policy: JSON.stringify(doc, null, 2) })];
    },
    read: () =>
      kms().readCurrentState(
        'k1',
        'ProbeKey',
        'AWS::KMS::Key',
        { KeyPolicy: kmsDocs.declared },
        AFTER
      ),
    key: 'KeyPolicy',
    warns: true,
  },
  {
    name: 'AWS::S3::BucketPolicy PolicyDocument',
    command: 'GetBucketPolicyCommand',
    docs: s3Docs,
    serve: (doc) => {
      script['GetBucketPolicyCommand'] = [() => ({ Policy: JSON.stringify(doc) })];
    },
    read: () =>
      zeroDelays(new S3BucketPolicyProvider()).readCurrentState(
        BUCKET,
        'Policy',
        'AWS::S3::BucketPolicy',
        { Bucket: BUCKET, PolicyDocument: s3Docs.declared },
        AFTER
      ),
    key: 'PolicyDocument',
    warns: true,
  },
  {
    name: 'AWS::SQS::QueuePolicy PolicyDocument',
    command: 'GetQueueAttributesCommand',
    docs: sqsDocs,
    serve: (doc) => {
      script['GetQueueAttributesCommand'] = [
        () => ({ Attributes: { Policy: JSON.stringify(doc) } }),
      ];
    },
    read: () =>
      zeroDelays(new SQSQueuePolicyProvider()).readCurrentState(
        Q1,
        'QPolicy',
        'AWS::SQS::QueuePolicy',
        { Queues: [Q1], PolicyDocument: sqsDocs.declared },
        AFTER
      ),
    key: 'PolicyDocument',
    warns: false,
  },
  {
    name: 'AWS::SNS::TopicPolicy PolicyDocument',
    command: 'GetTopicAttributesCommand',
    docs: snsDocs,
    serve: (doc) => {
      script['GetTopicAttributesCommand'] = [
        () => ({ Attributes: { Policy: JSON.stringify(doc) } }),
      ];
    },
    read: () =>
      zeroDelays(new SNSTopicPolicyProvider()).readCurrentState(
        T1,
        'TPolicy',
        'AWS::SNS::TopicPolicy',
        { Topics: [T1], PolicyDocument: snsDocs.declared },
        AFTER
      ),
    key: 'PolicyDocument',
    warns: false,
  },
  {
    name: 'AWS::IAM::Role AssumeRolePolicyDocument',
    command: 'GetRoleCommand',
    docs: trustDocs,
    serve: (doc) => {
      script['GetRoleCommand'] = [
        () => ({
          Role: { RoleName: 'r', AssumeRolePolicyDocument: encodeURIComponent(JSON.stringify(doc)) },
        }),
      ];
    },
    read: () =>
      zeroDelays(new IAMRoleProvider()).readCurrentState(
        'r',
        'Role',
        'AWS::IAM::Role',
        { AssumeRolePolicyDocument: trustDocs.declared },
        AFTER
      ),
    key: 'AssumeRolePolicyDocument',
    warns: true,
  },
];

describe.each(callers)('$name declared with no Version', (caller) => {
  it('a read with the filled-in 2008-10-17 settles on the first read: recorded as read, no warning', async () => {
    caller.serve(caller.docs.filled);
    expect(bag(await caller.read())[caller.key]).toEqual(caller.docs.filled);
    expect(callsOf(caller.command)).toBe(1);
    expect(unsettledWarnings()).toEqual([]);
  });

  it('a read with 2012-10-17 is another document: the whole schedule is re-read', async () => {
    caller.serve(caller.docs.other);
    expect(bag(await caller.read())[caller.key]).toEqual(caller.docs.other);
    expect(callsOf(caller.command)).toBe(4);
    expect(unsettledWarnings()).toHaveLength(caller.warns ? 1 : 0);
  });
});

describe('policyDocumentMatchesDeclared: the omitted Version', () => {
  const statement = { Action: 's3:GetObject', Effect: 'Allow', Resource: '*' };
  const bare = { Statement: [statement] };
  const v2008 = { Version: '2008-10-17', Statement: [statement] };
  const v2012 = { Version: '2012-10-17', Statement: [statement] };

  it('a read 2008-10-17 matches a declared document with no Version, in either spelling', () => {
    expect(policyDocumentMatchesDeclared(v2008, bare)).toBe(true);
    expect(policyDocumentMatchesDeclared(JSON.stringify(v2008), bare)).toBe(true);
    expect(policyDocumentMatchesDeclared(v2008, JSON.stringify(bare))).toBe(true);
    // The single-object Statement a template may declare, read back as a list.
    expect(policyDocumentMatchesDeclared(v2008, { Statement: statement })).toBe(true);
  });

  it('a read 2012-10-17 does not match a declared document with no Version', () => {
    expect(policyDocumentMatchesDeclared(v2012, bare)).toBe(false);
    expect(policyDocumentMatchesDeclared(JSON.stringify(v2012), bare)).toBe(false);
  });

  it('a declared Version compares exactly', () => {
    expect(policyDocumentMatchesDeclared(v2008, v2012)).toBe(false);
    expect(policyDocumentMatchesDeclared(v2012, v2008)).toBe(false);
    expect(policyDocumentMatchesDeclared(bare, v2008)).toBe(false);
    expect(policyDocumentMatchesDeclared(bare, v2012)).toBe(false);
    expect(policyDocumentMatchesDeclared(v2008, v2008)).toBe(true);
    expect(policyDocumentMatchesDeclared(v2012, v2012)).toBe(true);
  });

  it('the fold drops only the Version: a different statement still differs', () => {
    expect(
      policyDocumentMatchesDeclared(
        { Version: '2008-10-17', Statement: [{ ...statement, Effect: 'Deny' }] },
        bare
      )
    ).toBe(false);
    expect(policyDocumentMatchesDeclared({ ...v2008, Id: 'x' }, bare)).toBe(false);
    expect(policyDocumentMatchesDeclared(undefined, bare)).toBe(false);
  });

  it('EFS: the added Resource and the filled-in Version fold together', () => {
    const fs = `arn:aws:elasticfilesystem:us-east-1:${ACCT}:file-system/fs-0123abcd`;
    const declared = { Statement: [{ Action: 'elasticfilesystem:ClientMount', Effect: 'Allow' }] };
    const read = {
      Version: '2008-10-17',
      Statement: [{ Action: 'elasticfilesystem:ClientMount', Effect: 'Allow', Resource: fs }],
    };
    expect(efsPolicyMatchesDeclared(read, declared, 'fs-0123abcd')).toBe(true);
    expect(efsPolicyMatchesDeclared({ ...read, Version: '2012-10-17' }, declared)).toBe(false);
  });
});

describe('the drift heal agrees with the settle (matched as the settle matches it)', () => {
  it('a KeyPolicy declared with no Version is skipped while the live key holds it with 2008-10-17', () => {
    const observed = { KeyPolicy: kmsDocs.declared };
    expect(
      preFixBaselineUncomparedDriftKeys(
        'AWS::KMS::Key',
        observed,
        { KeyPolicy: kmsDocs.declared },
        { KeyPolicy: kmsDocs.filled }
      )
    ).toEqual(['KeyPolicy']);
    expect(
      preFixBaselineUncomparedDriftKeys(
        'AWS::KMS::Key',
        observed,
        { KeyPolicy: kmsDocs.declared },
        { KeyPolicy: kmsDocs.other }
      )
    ).toEqual([]);
  });

  it('a queue policy whose recorded baseline holds the filled-in Version is compared, a stale one is skipped', () => {
    const heal = (observed: unknown, live: unknown) =>
      preFixBaselineUncomparedDriftKeys(
        'AWS::SQS::QueuePolicy',
        { PolicyDocument: observed },
        { Queues: [Q1], PolicyDocument: sqsDocs.declared },
        { PolicyDocument: live }
      );
    expect(heal(sqsDocs.filled, sqsDocs.filled)).toEqual([]);
    expect(heal(sqsDocs.other, sqsDocs.filled)).toEqual(['PolicyDocument']);
  });
});
