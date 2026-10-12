/**
 * Issue [#4800](https://github.com/go-to-k/cdkd/issues/4800), end to end
 * through the real `DeployEngine`, `DiffCalculator` and resolver: a reader of
 * a queue NAMED from a secret, whose record holds its `Arn` as
 * `arn:...:{{resolve:secretsmanager:...}}`. While the queue is `NO_CHANGE`, the
 * reader's `Fn::GetAtt Queue.Arn` is served from that record, and it was sent
 * to AWS as the `{{resolve:` spelling (an SSM parameter refuses it, an SQS queue
 * policy silently matches nothing).
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
const URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/sdin-q-1';
const RECORDED_ARN = `arn:aws:sqs:us-east-1:123456789012:${REF}`;
const PLAIN_ARN = 'arn:aws:sqs:us-east-1:123456789012:sdin-q-1';

interface Run {
  /** The properties each reader UPDATE sent. */
  sent: Record<string, unknown>[];
  /** The reader's `Value` in the last state saved. */
  persistedValue: unknown;
  thrown: unknown;
}

async function deploy(opts: {
  queueVisibility: number;
  readerDescription: string;
  readerStoredValue: string;
}): Promise<Run> {
  const state = {
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
        },
        attributes: {},
        dependencies: ['SecretQueue'],
      },
    },
    outputs: {},
    lastModified: 0,
  } as StackState;
  const sent: Record<string, unknown>[] = [];
  const provider = {
    create: vi.fn(),
    update: vi.fn(async (id: string, _pid: string, _type: string, props: Record<string, unknown>) => {
      if (id === 'SecretQueue') {
        // What the SQS provider reads back: the real ARN.
        return { physicalId: URL, attributes: { Arn: PLAIN_ARN, QueueUrl: URL } };
      }
      sent.push(props);
      return { physicalId: '/p/reader', attributes: {} };
    }),
    delete: vi.fn(),
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
          Properties: { QueueName: REF, VisibilityTimeout: opts.queueVisibility },
        },
        Reader: {
          Type: 'AWS::SSM::Parameter',
          Properties: {
            Name: '/p/reader',
            Type: 'String',
            Value: { 'Fn::GetAtt': ['SecretQueue', 'Arn'] },
            Description: opts.readerDescription,
          },
        },
      },
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
  return { sent, persistedValue: last?.resources['Reader']?.properties?.['Value'], thrown };
}

describe('a reader of a NO_CHANGE secret-named queue (#4800)', () => {
  it('is sent the resolved ARN, and persists the expression', async () => {
    const run = await deploy({
      queueVisibility: 60,
      readerDescription: 'b',
      readerStoredValue: RECORDED_ARN,
    });
    expect(run.thrown).toBeUndefined();
    expect(run.sent.map((p) => p['Value'])).toEqual([PLAIN_ARN]);
    expect(run.persistedValue).toBe(RECORDED_ARN);
  });

  it('holding the plaintext ARN an update of the queue wrote: updated once, with the resolved ARN', async () => {
    const run = await deploy({
      queueVisibility: 60,
      readerDescription: 'a',
      readerStoredValue: PLAIN_ARN,
    });
    expect(run.thrown).toBeUndefined();
    expect(run.sent.map((p) => p['Value'])).toEqual([PLAIN_ARN]);
    expect(run.persistedValue).toBe(RECORDED_ARN);
  });

  it('holding the expression: a no-op redeploy updates nothing', async () => {
    const run = await deploy({
      queueVisibility: 60,
      readerDescription: 'a',
      readerStoredValue: RECORDED_ARN,
    });
    expect(run.thrown).toBeUndefined();
    expect(run.sent).toEqual([]);
  });

  it('control: the queue updated in the same deploy serves its fresh ARN', async () => {
    const run = await deploy({
      queueVisibility: 30,
      readerDescription: 'b',
      readerStoredValue: RECORDED_ARN,
    });
    expect(run.thrown).toBeUndefined();
    expect(run.sent.map((p) => p['Value'])).toEqual([PLAIN_ARN]);
  });
});
