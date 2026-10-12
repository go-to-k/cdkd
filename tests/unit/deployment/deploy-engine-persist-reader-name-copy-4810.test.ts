/**
 * Issue [#4810](https://github.com/go-to-k/cdkd/issues/4810), through the real
 * `DeployEngine` / `DiffCalculator` / resolver: a queue policy reading a queue
 * NAMED from a secret by `Ref` (its `Queues` URL), whose `PolicyDocument`
 * spells the secret reference literally. The reference puts the queue name into
 * the policy's own secrets bag, and the save's value scan rewrote the plaintext
 * `Queues` URL into `https://sqs.../{{resolve:...}}`, which the next destroy
 * sent to AWS (`InvalidAddress`). The URL is the queue's physical id, stored
 * in plaintext by design, so the policy's copy of it stays plaintext; the
 * literal reference is still persisted as the reference.
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

function policyDocument(sid: string, resource: unknown): Record<string, unknown> {
  return {
    Version: '2012-10-17',
    Statement: [{ Sid: sid, Effect: 'Allow', Action: 'sqs:SendMessage', Resource: resource }],
  };
}

async function deploy(): Promise<{
  sent: Record<string, unknown>[];
  persisted: Record<string, unknown> | undefined;
  thrown: unknown;
}> {
  const state = {
    version: 11,
    stackName: 's',
    region: 'us-east-1',
    resources: {
      SecretQueue: {
        physicalId: URL,
        resourceType: 'AWS::SQS::Queue',
        properties: { QueueName: REF },
        attributes: { Arn: RECORDED_ARN, QueueUrl: URL },
        dependencies: [],
      },
      Reader: {
        physicalId: 'reader-policy',
        resourceType: 'AWS::SQS::QueuePolicy',
        properties: { Queues: [URL], PolicyDocument: policyDocument('A', RECORDED_ARN) },
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
    update: vi.fn(async (_id: string, _pid: string, _type: string, props: Record<string, unknown>) => {
      sent.push(props);
      return { physicalId: 'reader-policy', attributes: {} };
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
        SecretQueue: { Type: 'AWS::SQS::Queue', Properties: { QueueName: REF } },
        Reader: {
          Type: 'AWS::SQS::QueuePolicy',
          Properties: {
            Queues: [{ Ref: 'SecretQueue' }],
            // The literal reference (#4810's shape), and a Sid change so the
            // policy is an UPDATE.
            PolicyDocument: policyDocument('B', RECORDED_ARN),
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
  return { sent, persisted: saved[saved.length - 1]?.resources['Reader']?.properties, thrown };
}

describe('a reader copy of a secret-named physical id is persisted as it is (#4810)', () => {
  it('keeps the plaintext Queues URL, and the literal reference as the reference', async () => {
    const run = await deploy();
    expect(run.thrown).toBeUndefined();
    // Premise: the policy was updated, with the queue name resolved in its
    // literal reference, so the policy's bag holds the queue name.
    expect(run.sent).toHaveLength(1);
    expect(run.sent[0]).toEqual({ Queues: [URL], PolicyDocument: policyDocument('B', PLAIN_ARN) });
    expect(run.persisted).toEqual({
      Queues: [URL],
      PolicyDocument: policyDocument('B', RECORDED_ARN),
    });
  });
});
