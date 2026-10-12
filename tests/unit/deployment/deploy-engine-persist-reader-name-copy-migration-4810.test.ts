/**
 * Issue [#4810](https://github.com/go-to-k/cdkd/issues/4810), the MIGRATION half,
 * through the real `DeployEngine` / `DiffCalculator` / resolver: a record an
 * earlier cdkd wrote holds a reader's copy of a secret-named physical id in its
 * rewritten `{{resolve:` form. Today's template is unchanged, so nothing may be
 * replaced or sent; the record is repaired to the plaintext copy, so the next
 * destroy addresses the real resource.
 */
import { describe, it, expect, vi } from 'vite-plus/test';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    secretsManager: {
      send: vi.fn().mockResolvedValue({ SecretString: JSON.stringify({ queue: 'sdin-q-1' }) }),
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));
vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn().mockImplementation(() => ({
      send: () => Promise.reject(new Error('DescribeType unavailable in this test')),
    })),
  };
});
vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  class FakeSecretsManagerClient {
    readonly config = { region: () => Promise.resolve('us-east-1') };
    constructor(_config?: unknown) {}
    async send(): Promise<unknown> {
      return { SecretString: JSON.stringify({ queue: 'sdin-q-1' }) };
    }
    destroy(): void {}
  }
  return { ...actual, SecretsManagerClient: FakeSecretsManagerClient };
});
vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { StackState } from '../../../src/types/state.js';

const REF = '{{resolve:secretsmanager:sdin:SecretString:queue::}}';
const TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:sdin-q-1';
const QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/sdin-q-1';
const REWRITTEN_URL = `https://sqs.us-east-1.amazonaws.com/123456789012/${REF}`;

interface Run {
  calls: string[];
  persisted: StackState['resources'][string] | undefined;
  thrown: unknown;
}

async function deploy(
  resources: StackState['resources'],
  templateResources: Record<string, unknown>,
  order: string[][],
  extra: Partial<StackState> = {},
  engineOptions: Record<string, unknown> = {}
): Promise<Run> {
  const state = {
    version: 11,
    stackName: 's',
    region: 'us-east-1',
    resources,
    outputs: {},
    lastModified: 0,
    ...extra,
  } as StackState;
  const calls: string[] = [];
  const provider = {
    create: vi.fn(async (id: string) => {
      calls.push('create:' + id);
      return { physicalId: 'new', attributes: {} };
    }),
    update: vi.fn(async (id: string) => {
      calls.push('update:' + id);
      return { physicalId: resources[id]!.physicalId, attributes: {} };
    }),
    delete: vi.fn(async (id: string) => {
      calls.push('delete:' + id);
    }),
    getAttribute: vi.fn(),
    readCurrentState: vi.fn().mockResolvedValue(undefined),
  };
  const saveState = vi.fn().mockResolvedValue('etag');
  const reader = order[order.length - 1]![0]!;
  const engine = new DeployEngine(
    {
      getState: vi.fn().mockResolvedValue({ state, etag: 'e0' }),
      saveState,
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      appendRollbackJournalSegment: vi.fn(),
      popRollbackJournalSegment: vi.fn(),
      deleteRollbackJournal: vi.fn(),
    } as never,
    { acquireLockWithRetry: vi.fn().mockResolvedValue(true), releaseLock: vi.fn() } as never,
    {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue(order),
      getDirectDependencies: vi.fn((_g: unknown, id: string) => (id === reader ? [order[0]![0]] : [])),
    } as never,
    new DiffCalculator(),
    {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    } as never,
    { dryRun: false, ...engineOptions },
    'us-east-1'
  );
  let thrown: unknown;
  await engine.deploy('s', { Resources: templateResources } as never).catch((e: unknown) => {
    thrown = e;
  });
  const saved = saveState.mock.calls
    .flat()
    .filter(
      (a): a is StackState => typeof a === 'object' && a !== null && 'resources' in (a as object)
    );
  return { calls, persisted: saved[saved.length - 1]?.resources[reader], thrown };
}

describe('a record an earlier deploy rewrote is repaired, never replaced (#4810)', () => {
  it('a create-only copy (an SNS subscription TopicArn): no replacement, and the copy is repaired', async () => {
    // Security review on PR #4817: the plaintext desired copy against the
    // record's rewritten one read as MOVED and replaced the subscription.
    const sub = {
      TopicArn: { Ref: 'SecretTopic' },
      Protocol: 'sqs',
      Endpoint: 'arn:aws:sqs:us-east-1:123456789012:plainq',
      FilterPolicy: { k: [REF] },
    };
    const run = await deploy(
      {
        SecretTopic: {
          physicalId: TOPIC_ARN,
          resourceType: 'AWS::SNS::Topic',
          properties: { TopicName: REF },
          attributes: { TopicArn: TOPIC_ARN },
          dependencies: [],
        },
        Sub: {
          physicalId: 'sub-1',
          resourceType: 'AWS::SNS::Subscription',
          properties: { ...sub, TopicArn: `arn:aws:sns:us-east-1:123456789012:${REF}` },
          attributes: {},
          dependencies: ['SecretTopic'],
        },
      } as StackState['resources'],
      {
        SecretTopic: { Type: 'AWS::SNS::Topic', Properties: { TopicName: REF } },
        Sub: { Type: 'AWS::SNS::Subscription', Properties: sub },
      },
      [['SecretTopic'], ['Sub']]
    );
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toEqual([]);
    expect(run.persisted?.physicalId).toBe('sub-1');
    expect(run.persisted?.properties['TopicArn']).toBe(TOPIC_ARN);
    expect(run.persisted?.properties['FilterPolicy']).toEqual({ k: [REF] });
  });

  it("a queue policy: Queues and the provider's recorded cdkd:WrittenQueues are repaired, nothing sent", async () => {
    const policyDocument = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: 'sqs:SendMessage',
          Resource: `arn:aws:sqs:us-east-1:123456789012:${REF}`,
        },
      ],
    };
    const run = await deploy(
      {
        SecretQueue: {
          physicalId: QUEUE_URL,
          resourceType: 'AWS::SQS::Queue',
          properties: { QueueName: REF },
          attributes: {},
          dependencies: [],
        },
        Reader: {
          physicalId: 'reader-policy',
          resourceType: 'AWS::SQS::QueuePolicy',
          properties: { Queues: [REWRITTEN_URL], PolicyDocument: policyDocument },
          // The provider records it comma-joined.
          attributes: { 'cdkd:WrittenQueues': REWRITTEN_URL, Whole: REF },
          dependencies: ['SecretQueue'],
        },
      } as StackState['resources'],
      {
        SecretQueue: { Type: 'AWS::SQS::Queue', Properties: { QueueName: REF } },
        Reader: {
          Type: 'AWS::SQS::QueuePolicy',
          Properties: { Queues: [{ Ref: 'SecretQueue' }], PolicyDocument: policyDocument },
        },
      },
      [['SecretQueue'], ['Reader']]
    );
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toEqual([]);
    expect(run.persisted?.properties['Queues']).toEqual([QUEUE_URL]);
    expect(run.persisted?.properties['PolicyDocument']).toEqual(policyDocument);
    expect(run.persisted?.attributes?.['cdkd:WrittenQueues']).toBe(QUEUE_URL);
    // A whole-token attribute may be a literal reference: never rewritten.
    expect(run.persisted?.attributes?.['Whole']).toBe(REF);
  });

  it('a stored copy that is NOT the legacy form of today\'s copy is a real change: the update is sent', async () => {
    // The reader used to point at another queue; the template now reads the
    // secret-named one. Only a stored leaf EQUAL to the legacy form is repaired.
    const policyDocument = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: 'sqs:SendMessage',
          Resource: `arn:aws:sqs:us-east-1:123456789012:${REF}`,
        },
      ],
    };
    const OTHER_URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/other-queue';
    const run = await deploy(
      {
        SecretQueue: {
          physicalId: QUEUE_URL,
          resourceType: 'AWS::SQS::Queue',
          properties: { QueueName: REF },
          attributes: {},
          dependencies: [],
        },
        Reader: {
          physicalId: 'reader-policy',
          resourceType: 'AWS::SQS::QueuePolicy',
          properties: { Queues: [OTHER_URL], PolicyDocument: policyDocument },
          attributes: {},
          dependencies: ['SecretQueue'],
        },
      } as StackState['resources'],
      {
        SecretQueue: { Type: 'AWS::SQS::Queue', Properties: { QueueName: REF } },
        Reader: {
          Type: 'AWS::SQS::QueuePolicy',
          Properties: { Queues: [{ Ref: 'SecretQueue' }], PolicyDocument: policyDocument },
        },
      },
      [['SecretQueue'], ['Reader']]
    );
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toEqual(['update:Reader']);
    expect(run.persisted?.properties['Queues']).toEqual([QUEUE_URL]);
  });

  it("a record whose rewriting reference today's template no longer reads is repaired from the record's own reference", async () => {
    // Review M2 on PR #4817: the literal reference that put the queue name into
    // the policy's bag was removed, so today's bag cannot spell the legacy
    // form; the record's own `{{resolve:` text still can.
    const policyDocument = {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: 'sqs:SendMessage', Resource: '*' }],
    };
    const run = await deploy(
      {
        SecretQueue: {
          physicalId: QUEUE_URL,
          resourceType: 'AWS::SQS::Queue',
          properties: { QueueName: REF },
          attributes: {},
          dependencies: [],
        },
        Reader: {
          physicalId: 'reader-policy',
          resourceType: 'AWS::SQS::QueuePolicy',
          properties: { Queues: [REWRITTEN_URL], PolicyDocument: policyDocument },
          attributes: { 'cdkd:WrittenQueues': REWRITTEN_URL },
          dependencies: ['SecretQueue'],
        },
      } as StackState['resources'],
      {
        SecretQueue: { Type: 'AWS::SQS::Queue', Properties: { QueueName: REF } },
        Reader: {
          Type: 'AWS::SQS::QueuePolicy',
          Properties: { Queues: [{ Ref: 'SecretQueue' }], PolicyDocument: policyDocument },
        },
      },
      [['SecretQueue'], ['Reader']]
    );
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toEqual([]);
    expect(run.persisted?.properties['Queues']).toEqual([QUEUE_URL]);
    expect(run.persisted?.attributes?.['cdkd:WrittenQueues']).toBe(QUEUE_URL);
  });

  it("the record's own reference is NOT looked up where the stack reads another region (it could answer for that region's secret)", async () => {
    // Review minor-A on PR #4817: with a foreign producer region on record, a
    // region-less reference refuses (`ambiguous`), so there is no map and no
    // repair: the update goes out as before rather than a guess.
    const policyDocument = {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: 'sqs:SendMessage', Resource: '*' }],
    };
    const run = await deploy(
      {
        SecretQueue: {
          physicalId: QUEUE_URL,
          resourceType: 'AWS::SQS::Queue',
          properties: { QueueName: REF },
          attributes: {},
          dependencies: [],
        },
        Reader: {
          physicalId: 'reader-policy',
          resourceType: 'AWS::SQS::QueuePolicy',
          properties: { Queues: [REWRITTEN_URL], PolicyDocument: policyDocument },
          attributes: {},
          dependencies: ['SecretQueue'],
        },
      } as StackState['resources'],
      {
        SecretQueue: { Type: 'AWS::SQS::Queue', Properties: { QueueName: REF } },
        Reader: {
          Type: 'AWS::SQS::QueuePolicy',
          Properties: { Queues: [{ Ref: 'SecretQueue' }], PolicyDocument: policyDocument },
        },
      },
      [['SecretQueue'], ['Reader']],
      {
        imports: [
          { exportName: 'X', producerStack: 'P', sourceRegion: 'eu-west-1' },
        ] as unknown as StackState['imports'],
      }
    );
    expect(run.calls).toEqual(['update:Reader']);
  });

  const legacyBucketReader = (
    extra: Partial<StackState> = {},
    engineOptions: Record<string, unknown> = {}
  ): Promise<Run> => {
    // A copy after a SHORT prefix: `s3://` and a bucket named `x-<secret>`.
    // The record's own reference is the only source of its legacy spelling
    // (today's template reads no secret in the reader).
    const BUCKET = 'x-sdin-q-1';
    const stored = `s3://x-${REF}/k`;
    return deploy(
      {
        SecretBucket: {
          physicalId: BUCKET,
          resourceType: 'AWS::S3::Bucket',
          properties: { BucketName: `x-${REF}` },
          attributes: {},
          dependencies: [],
        },
        Reader: {
          physicalId: '/reader',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Name: '/reader', Type: 'String', Value: stored },
          attributes: {},
          dependencies: ['SecretBucket'],
        },
      } as StackState['resources'],
      {
        SecretBucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: `x-${REF}` } },
        Reader: {
          Type: 'AWS::SSM::Parameter',
          Properties: {
            Name: '/reader',
            Type: 'String',
            Value: { 'Fn::Join': ['', ['s3://', { Ref: 'SecretBucket' }, '/k']] },
          },
        },
      },
      [['SecretBucket'], ['Reader']],
      extra,
      engineOptions
    );
  };

  it('a copy after a short prefix (s3:// and a short bucket id) is repaired from the record', async () => {
    const run = await legacyBucketReader();
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toEqual([]);
    expect(run.persisted?.properties['Value']).toBe('s3://x-sdin-q-1/k');
  });

  it('with INCOMPLETE producer-region evidence (a nested child whose parent gave none) there is no lookup', async () => {
    const run = await legacyBucketReader(
      {},
      { parentStackInfo: { parentStack: 'P', parentLogicalId: 'C', parentRegion: 'us-east-1' } }
    );
    expect(run.calls).toEqual(['update:Reader']);
  });
});
