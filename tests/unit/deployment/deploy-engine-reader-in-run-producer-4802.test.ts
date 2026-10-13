/**
 * Issue [#4802](https://github.com/go-to-k/cdkd/issues/4802), through the real
 * `DeployEngine` / `DiffCalculator` / resolver: a reader of a queue NAMED from a
 * secret, where the queue is UPDATED in the same deploy. The reader is served
 * the provider's fresh ARN (plaintext), and nothing put the secret into the
 * READER's bag, so it persisted the plaintext ARN, while the next deploy's diff
 * (which reads the queue's stored, reference-form ARN) saw the reference and
 * updated the reader once more. The reader now records the producer's own
 * secret pairs the value carries, and persists the reference, as a reader of
 * an unchanged queue does (go-to-k/cdkd#4800).
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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
// The secret's current `queue` value; a case rotating it sets this first.
const secret = vi.hoisted(() => ({ queue: 'sdin-q-1' }));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    secretsManager: {
      send: vi.fn(async () => ({ SecretString: JSON.stringify({ queue: secret.queue }) })),
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
      return { SecretString: JSON.stringify({ queue: secret.queue }) };
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
const URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/sdin-q-1';
const RECORDED_ARN = `arn:aws:sqs:us-east-1:123456789012:${REF}`;
const PLAIN_ARN = 'arn:aws:sqs:us-east-1:123456789012:sdin-q-1';
const URL_2 = URL.replace('sdin-q-1', 'sdin-q-2');
const PLAIN_ARN_2 = PLAIN_ARN.replace('sdin-q-1', 'sdin-q-2');

beforeEach(() => {
  secret.queue = 'sdin-q-1';
});

interface Run {
  /** The properties each reader UPDATE sent. */
  sent: Record<string, unknown>[];
  /** The reader's `Value` in the last state saved. */
  persistedValue: unknown;
  /** The last state saved, for a following deploy. */
  last: StackState | undefined;
  /** Every provider call, as `<verb>:<logicalId>`. */
  calls: string[];
  thrown: unknown;
}

async function deploy(opts: {
  queueVisibility: number;
  readerDescription: string;
  readerStoredValue: string;
  /** A create-only change, so the queue is REPLACED. */
  fifo?: boolean;
  /** Start from this state instead of the one built here. */
  state?: StackState;
}): Promise<Run> {
  const built = {
    version: 11,
    stackName: 's',
    region: 'us-east-1',
    resources: {
      SecretQueue: {
        physicalId: URL,
        resourceType: 'AWS::SQS::Queue',
        properties: { QueueName: REF, VisibilityTimeout: 60 },
        // As the #4793 fixture's state records it.
        attributes: { Arn: RECORDED_ARN, QueueUrl: URL },
        dependencies: [],
      },
      Reader: {
        physicalId: '/p/reader',
        resourceType: 'AWS::SSM::Parameter',
        properties: {
          Name: '/p/reader',
          Type: 'String',
          Value: opts.readerStoredValue,
          Description: 'a',
          Tags: { Url: URL },
        },
        attributes: {},
        dependencies: ['SecretQueue'],
      },
    },
    outputs: {},
    lastModified: 0,
  } as StackState;
  const state = opts.state ?? built;
  const sent: Record<string, unknown>[] = [];
  const calls: string[] = [];
  const provider = {
    create: vi.fn(async (id: string) => {
      calls.push(`create:${id}`);
      // The replacement queue, named from the secret's CURRENT value.
      return { physicalId: URL_2, attributes: { Arn: PLAIN_ARN_2, QueueUrl: URL_2 } };
    }),
    update: vi.fn(async (id: string, _pid: string, _type: string, props: Record<string, unknown>) => {
      calls.push(`update:${id}`);
      if (id === 'SecretQueue') {
        // What the SQS provider reads back: the real ARN.
        return { physicalId: URL, attributes: { Arn: PLAIN_ARN, QueueUrl: URL } };
      }
      sent.push(props);
      return { physicalId: '/p/reader', attributes: {} };
    }),
    delete: vi.fn(async (id: string) => {
      calls.push(`delete:${id}`);
    }),
    getAttribute: vi.fn(),
    readCurrentState: vi.fn().mockResolvedValue(undefined),
  };
  const saveState = vi.fn().mockResolvedValue('etag');
  const engine = new DeployEngine(
    {
      getState: vi.fn().mockResolvedValue({ state, etag: 'e0' }),
      saveState,
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
      rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
      warmConnections: vi.fn().mockResolvedValue(undefined),
      appendRollbackJournalSegment: vi.fn(),
      popRollbackJournalSegment: vi.fn(),
      deleteRollbackJournal: vi.fn(),
    } as never,
    { acquireLockWithRetry: vi.fn().mockResolvedValue(true), releaseLock: vi.fn() } as never,
    {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([['SecretQueue'], ['Reader']]),
      getDirectDependencies: vi.fn((_g: unknown, id: string) =>
        id === 'Reader' ? ['SecretQueue'] : []
      ),
    } as never,
    new DiffCalculator(),
    {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    } as never,
    { dryRun: false, forceStatefulRecreation: true },
    'us-east-1'
  );
  let thrown: unknown;
  await engine
    .deploy('s', {
      Resources: {
        SecretQueue: {
          Type: 'AWS::SQS::Queue',
          Properties: {
            QueueName: REF,
            VisibilityTimeout: opts.queueVisibility,
            ...(opts.fifo && { FifoQueue: true }),
          },
        },
        Reader: {
          Type: 'AWS::SSM::Parameter',
          Properties: {
            Name: '/p/reader',
            Type: 'String',
            Value: { 'Fn::GetAtt': ['SecretQueue', 'Arn'] },
            Description: opts.readerDescription,
            // The common reader shape also reads the queue's physical id,
            // which stays plaintext beside the copied pair (go-to-k/cdkd#4810).
            Tags: { Url: { Ref: 'SecretQueue' } },
          },
        },
      },
      Outputs: { QueueArn: { Value: { 'Fn::GetAtt': ['SecretQueue', 'Arn'] } } },
    })
    .catch((e: unknown) => {
      thrown = e;
    });
  const saved = saveState.mock.calls
    .flat()
    .filter(
      (arg): arg is StackState =>
        typeof arg === 'object' && arg !== null && 'resources' in (arg as object)
    );
  const last = saved[saved.length - 1];
  return {
    sent,
    persistedValue: last?.resources['Reader']?.properties?.['Value'],
    last,
    calls,
    thrown,
  };
}

describe('a reader of a secret-named queue updated in the same deploy (#4802)', () => {
  it('is sent the fresh ARN, and persists the reference form', async () => {
    const run = await deploy({
      queueVisibility: 30,
      readerDescription: 'b',
      readerStoredValue: RECORDED_ARN,
    });
    expect(run.thrown).toBeUndefined();
    expect(run.sent.map((p) => p['Value'])).toEqual([PLAIN_ARN]);
    expect(run.persistedValue).toBe(RECORDED_ARN);
    expect(run.last?.resources['Reader']?.properties?.['Tags']).toEqual({ Url: URL });
    // The outputs pass reads the same pair: one answer whether the queue changed or not.
    expect(run.last?.outputs?.['QueueArn']).toBe(RECORDED_ARN);
    // The symptom: the following deploy, the queue unchanged, updates nothing.
    const next = await deploy({
      queueVisibility: 30,
      readerDescription: 'b',
      readerStoredValue: RECORDED_ARN,
      state: run.last,
    });
    expect(next.thrown).toBeUndefined();
    expect(next.calls).toEqual([]);
  });

  it('a reader of a queue REPLACED under a rotated secret is sent, and stores, the new ARN', async () => {
    // The secret now names `sdin-q-2`; the reader's record holds the reference.
    // A copied pair would make the reader's desired value equal that record,
    // and the reader would be skipped, left on the deleted queue's ARN.
    secret.queue = 'sdin-q-2';
    const run = await deploy({
      queueVisibility: 60,
      readerDescription: 'a',
      readerStoredValue: RECORDED_ARN,
      fifo: true,
    });
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toContain('create:SecretQueue');
    expect(run.sent.map((p) => p['Value'])).toEqual([PLAIN_ARN_2]);
    expect(run.persistedValue).toBe(PLAIN_ARN_2);
  });
});
