/**
 * Issue [#4810](https://github.com/go-to-k/cdkd/issues/4810): the rollback
 * JOURNAL a deploy writes redacts each op with the resolution's own secrets
 * bag (`deploy-engine/rollback.ts`), and a reader's copy of a read physical id
 * survives only while that is the SAME bag instance the resolver recorded the
 * copy into. A copied bag drops the copies and rewrites the reader's `Queues`
 * URL into `https://sqs.../{{resolve:...}}`, which the replay would then send.
 * (Restoring the journaled record on an automatic rollback is
 * go-to-k/cdkd#4801's half, PR #4803.)
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
import { recordPhysicalNameCopy } from '../../../src/deployment/secret-redaction.js';

const REF = '{{resolve:secretsmanager:sdin:SecretString:queue::}}';
const URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/sdin-q-1';
const RECORDED_ARN = `arn:aws:sqs:us-east-1:123456789012:${REF}`;

function policyDocument(sid: string, resource: unknown): Record<string, unknown> {
  return {
    Version: '2012-10-17',
    Statement: [{ Sid: sid, Effect: 'Allow', Action: 'sqs:SendMessage', Resource: resource }],
  };
}

describe('the rollback journal keeps a reader copy of a read physical id (#4810)', () => {
  it("journals the policy's Queues URL in plaintext, from the resolution's own bag", async () => {
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
    const provider = {
      create: vi.fn(async () => {
        throw new Error('boom-create');
      }),
      update: vi.fn(async () => ({ physicalId: 'reader-policy', attributes: {} })),
      delete: vi.fn(),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(undefined),
    };
    const appendRollbackJournalSegment = vi.fn().mockResolvedValue(undefined);
    const engine = new DeployEngine(
      {
        getState: vi.fn().mockResolvedValue({ state, etag: 'e0' }),
        saveState: vi.fn().mockResolvedValue('etag'),
        loadRollbackJournal: vi.fn().mockResolvedValue(null),
        purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
        rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
        warmConnections: vi.fn().mockResolvedValue(undefined),
        appendRollbackJournalSegment,
        popRollbackJournalSegment: vi.fn(),
        deleteRollbackJournal: vi.fn(),
      } as never,
      { acquireLockWithRetry: vi.fn().mockResolvedValue(true), releaseLock: vi.fn() } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue([['SecretQueue'], ['Reader'], ['Failer']]),
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
    await engine
      .deploy('s', {
        Resources: {
          SecretQueue: { Type: 'AWS::SQS::Queue', Properties: { QueueName: REF } },
          Reader: {
            Type: 'AWS::SQS::QueuePolicy',
            Properties: {
              Queues: [{ Ref: 'SecretQueue' }],
              PolicyDocument: policyDocument('B', RECORDED_ARN),
            },
          },
          Failer: { Type: 'AWS::SNS::Topic', Properties: { TopicName: 'x' } },
        },
      })
      .catch(() => undefined);
    // Premise: the reader's update was journaled.
    const ops = appendRollbackJournalSegment.mock.calls
      .flat()
      .flatMap((arg) => JSON.stringify(arg ?? null))
      .join('\n');
    expect(ops).toContain('"logicalId":"Reader"');
    // The journal walk redacts with the resolution's OWN bag instance, which
    // carries the copies it read: the Queues URL stays the physical id.
    expect(ops).toContain(`"Queues":["${URL}"]`);
    expect(ops).not.toContain('/123456789012/{{resolve:');
  });

  it("the save after an automatic rollback keeps the restored reader's copy (the final save's writer)", () => {
    // The automatic rollback has TWO writers: the replay's own restore
    // redaction (go-to-k/cdkd#4801, PR #4803) and the FINAL save, which
    // re-scans the restored record with the failing deploy's per-resource bag.
    // That bag is the resolution's own instance, which carries the copies.
    const engine = new DeployEngine(
      {} as never,
      {} as never,
      {} as never,
      new DiffCalculator(),
      {} as never,
      { dryRun: false },
      'us-east-1'
    ) as unknown as {
      perResourceSecrets: Map<string, Map<string, string>>;
      redactStateForPersist: (state: StackState) => StackState;
    };
    const restored = {
      version: 11,
      stackName: 's',
      region: 'us-east-1',
      resources: {
        Reader: {
          physicalId: 'reader-policy',
          resourceType: 'AWS::SQS::QueuePolicy',
          properties: { Queues: [URL], PolicyDocument: policyDocument('A', RECORDED_ARN) },
          attributes: {},
          dependencies: [],
        },
      },
      outputs: {},
      lastModified: 0,
    } as StackState;
    const withCopy = new Map([['sdin-q-1', REF]]);
    recordPhysicalNameCopy(withCopy, URL);
    engine.perResourceSecrets.set('Reader', withCopy);
    expect(engine.redactStateForPersist(restored).resources['Reader']!.properties['Queues']).toEqual([
      URL,
    ]);
    // Control: the same bag without the copies is the pre-fix rewrite.
    engine.perResourceSecrets.set('Reader', new Map([['sdin-q-1', REF]]));
    expect(engine.redactStateForPersist(restored).resources['Reader']!.properties['Queues']).toEqual([
      `https://sqs.us-east-1.amazonaws.com/123456789012/${REF}`,
    ]);
  });
});
