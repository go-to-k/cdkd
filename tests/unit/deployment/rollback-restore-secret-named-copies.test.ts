// go-to-k/cdkd#4801: a rollback that restores a record holding a PLAINTEXT
// copy of a secret-derived physical name (a reader's `Queues` URL) must persist
// that copy as the previous record did.
// The replay re-resolves the record's own `{{resolve:` references, and the
// value scan then rewrote every copy of the resolved name into the reference,
// so the next destroy deleted by an address AWS does not know.
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
// Pass-through retry: no real backoff on any path these tests take.
vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});
vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

import {
  replayRollback,
  replayFailedOperations,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { redactRollbackRecord } from '../../../src/deployment/rollback-executor/replay-secrets.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { TemplateResource } from '../../../src/types/resource.js';
import type { RollbackJournalSegment } from '../../../src/types/rollback-journal.js';

const REF = '{{resolve:secretsmanager:sdin:SecretString:queue::}}';
const NAME = 'sdin-q-1';
const URL = `https://sqs.us-east-1.amazonaws.com/123456789012/${NAME}`;
const ARN_REF = `arn:aws:sqs:us-east-1:123456789012:${REF}`;
const ARN = `arn:aws:sqs:us-east-1:123456789012:${NAME}`;

/** The records a normal deploy persists for a secret-named queue and its policy. */
function previousState(): StackState {
  return {
    version: 11,
    stackName: 's',
    region: 'us-east-1',
    resources: {
      SecretQueue: {
        physicalId: URL,
        resourceType: 'AWS::SQS::Queue',
        properties: { QueueName: REF, VisibilityTimeout: 60 },
        attributes: { Arn: ARN_REF, QueueUrl: URL },
        dependencies: [],
      },
      Policy: {
        physicalId: URL,
        resourceType: 'AWS::SQS::QueuePolicy',
        properties: {
          Queues: [URL],
          PolicyDocument: { Statement: [{ Sid: 'A', Resource: ARN_REF }] },
        },
        // The real provider's shape: create and update return the queues they
        // wrote, and delete reads them back (`recordedQueues`).
        attributes: { 'cdkd:WrittenQueues': URL },
        dependencies: ['SecretQueue'],
      },
      Breaker: {
        physicalId: '/p/breaker',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Name: '/p/breaker', Type: 'String', Value: 'a' },
        attributes: {},
        dependencies: [],
      },
    },
    outputs: {},
    lastModified: 0,
  } as StackState;
}

/**
 * Deploy `template` over {@link previousState} with `Breaker`'s update failing
 * last, so the automatic rollback reverts every update before it. Returns the
 * last state saved and the provider's `update` mock.
 */
async function deployAndRollBack(
  template: Record<string, TemplateResource>,
  options: {
    orphans?: StackState['orphans'];
    levels?: string[][];
    imported?: Record<string, unknown>;
  } = {}
) {
  const state = previousState();
  if (options.orphans) state.orphans = options.orphans;
  const saved: StackState[] = [];
  const segments: RollbackJournalSegment[] = [];
  const provider = {
    create: vi.fn(),
    update: vi.fn(async (id: string) => {
      if (id === 'Breaker') throw new Error('deliberate failure after the other updates');
      return {
        physicalId: URL,
        attributes: id === 'Policy' ? { 'cdkd:WrittenQueues': URL } : {},
      };
    }),
    delete: vi.fn(),
    getAttribute: vi.fn(),
    readCurrentState: vi.fn().mockResolvedValue(undefined),
    import: vi.fn(async (input: { knownPhysicalId?: string }) =>
      options.imported === undefined
        ? null
        : { physicalId: input.knownPhysicalId, attributes: options.imported }
    ),
  };
  const engine = new DeployEngine(
    {
      getState: vi.fn().mockResolvedValue({ state, etag: 'e0' }),
      saveState: vi.fn(async (_n: string, _r: string, st: StackState) => {
        saved.push(structuredClone(st));
        return 'etag';
      }),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
      rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
      warmConnections: vi.fn().mockResolvedValue(undefined),
      appendRollbackJournalSegment: vi.fn(async (_n: string, _r: string, seg: unknown) => {
        segments.push(structuredClone(seg) as RollbackJournalSegment);
      }),
      popRollbackJournalSegment: vi.fn(),
      deleteRollbackJournal: vi.fn(),
    } as never,
    { acquireLockWithRetry: vi.fn().mockResolvedValue(true), releaseLock: vi.fn() } as never,
    {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi
        .fn()
        .mockReturnValue(options.levels ?? [['SecretQueue'], ['Policy'], ['Breaker']]),
      getDirectDependencies: vi.fn((_g: unknown, id: string) =>
        id === 'Policy' ? ['SecretQueue'] : id === 'Breaker' ? ['Policy'] : []
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
  await engine.deploy('s', { Resources: template }).catch(() => undefined);
  return { last: saved[saved.length - 1]!, update: provider.update, segments };
}

const BREAKER = {
  Type: 'AWS::SSM::Parameter',
  Properties: { Name: '/p/breaker', Type: 'String', Value: 'b' },
};

describe('rollback restore of a plaintext copy of a secret-derived name (#4801)', () => {
  // The policy reads the queue's ARN through `Fn::GetAtt`, or spells the
  // reference itself, which puts the queue name into the failing deploy's map
  // for the policy too, so the final save rescans the restored record with it
  // (go-to-k/cdkd#4810).
  it.each([
    ['an Fn::GetAtt of the queue', { 'Fn::GetAtt': ['SecretQueue', 'Arn'] }],
    ['a literal reference', ARN_REF],
  ] as const)(
    'keeps a reader’s Queues URL as AWS knows it, read through %s',
    async (_label, resource) => {
    const { last, update } = await deployAndRollBack({
      SecretQueue: {
        Type: 'AWS::SQS::Queue',
        Properties: { QueueName: REF, VisibilityTimeout: 60 },
      },
      Policy: {
        Type: 'AWS::SQS::QueuePolicy',
        Properties: {
          Queues: [{ Ref: 'SecretQueue' }],
          PolicyDocument: {
            Statement: [{ Sid: 'B', Resource: resource }],
          },
        },
      },
      Breaker: BREAKER,
    });
    // Premise: the policy was written, and its revert ran.
    expect(update.mock.calls.filter((c) => c[0] === 'Policy').length).toBe(2);
    const policy = last.resources['Policy']!;
    expect(policy.physicalId).toBe(URL);
    // What the SQS queue-policy provider deletes by.
    expect(policy.properties['Queues']).toEqual([URL]);
    // The position the previous record held as a reference stays one.
    expect(policy.properties['PolicyDocument']).toEqual({
      Statement: [{ Sid: 'A', Resource: ARN_REF }],
    });
    expect(policy.attributes).toEqual({ 'cdkd:WrittenQueues': URL });
  }
  );

  // A template spelling the reference itself puts the queue's name in the
  // FAILING deploy's map for the policy, so the journal's scrub of the
  // previous record was a second writer of the reference into `Queues`; the
  // journal is what `cdkd rollback` restores from. A REGRESSION GUARD over the
  // two keeps together: since go-to-k/cdkd#4810 the scan itself keeps this
  // physical-name copy, so it stays green without the journal's keep. The
  // adopted-orphan case below is the one that tells the journal's keep apart.
  it('journals the reader’s previous record as state held it, under a literal-reference template', async () => {
    const { segments } = await deployAndRollBack({
      SecretQueue: {
        Type: 'AWS::SQS::Queue',
        Properties: { QueueName: REF, VisibilityTimeout: 60 },
      },
      Policy: {
        Type: 'AWS::SQS::QueuePolicy',
        Properties: {
          Queues: [{ Ref: 'SecretQueue' }],
          PolicyDocument: { Statement: [{ Sid: 'B', Resource: ARN_REF }] },
        },
      },
      Breaker: BREAKER,
    });
    const journaled = segments
      .flatMap((s) => s.operations)
      .find((op) => op.logicalId === 'Policy')?.previousState;
    // Premise: the policy's update was journaled.
    expect(journaled).toBeDefined();
    expect(journaled).toMatchObject(previousState().resources['Policy']!);
  });

  // An adopted orphan's record carries attribute keys a LIVE readback added,
  // which state never held: the journal keep must not treat them as persisted,
  // while what the orphan entry itself recorded stays as state held it.
  it('journals an adopted orphan’s live-read attribute through the scan', async () => {
    const { segments } = await deployAndRollBack(
      {
        Kept: {
          Type: 'AWS::SSM::Parameter',
          // No explicit name: cdkd re-adopts only a resource it names itself.
          Properties: { Type: 'String', Value: REF },
        },
        Breaker: BREAKER,
      },
      {
        orphans: [
          {
            logicalId: 'Kept',
            orphanedAt: 0,
            state: {
              physicalId: '/p/kept',
              resourceType: 'AWS::SSM::Parameter',
              // Plaintext copies the orphan entry itself recorded: state held them.
              properties: { Type: 'String', Value: 'old', Copy: URL },
              attributes: { Recorded: URL },
              dependencies: [],
            },
          },
        ],
        levels: [['Kept'], ['Breaker']],
        imported: { Echo: NAME },
      }
    );
    const journaled = segments
      .flatMap((s) => s.operations)
      .find((op) => op.logicalId === 'Kept')?.previousState;
    // Premise: the orphan was adopted with the live key, and its update journaled.
    expect(journaled?.physicalId).toBe('/p/kept');
    expect(journaled?.properties['Copy']).toBe(URL);
    expect(journaled?.attributes).toEqual({ Echo: REF, Recorded: URL });
  });

  it('restores the secret-named owner with its secret positions as references', async () => {
    const { last, update } = await deployAndRollBack({
      SecretQueue: {
        Type: 'AWS::SQS::Queue',
        Properties: { QueueName: REF, VisibilityTimeout: 30 },
      },
      Policy: {
        Type: 'AWS::SQS::QueuePolicy',
        Properties: {
          Queues: [{ Ref: 'SecretQueue' }],
          PolicyDocument: {
            Statement: [{ Sid: 'A', Resource: { 'Fn::GetAtt': ['SecretQueue', 'Arn'] } }],
          },
        },
      },
      Breaker: BREAKER,
    });
    expect(update.mock.calls.filter((c) => c[0] === 'SecretQueue').length).toBe(2);
    const queue = last.resources['SecretQueue']!;
    expect(queue.properties).toEqual({ QueueName: REF, VisibilityTimeout: 60 });
    expect(queue.physicalId).toBe(URL);
    expect(queue.attributes?.['Arn']).toBe(ARN_REF);
    // Nothing persisted carries the resolved name outside a plaintext copy the
    // previous record held: the journal's own scrub already wrote this
    // record's `QueueUrl` as the reference, as an UPDATE deploy of it does.
    expect(JSON.stringify(queue.properties)).not.toContain(NAME);
  });
});

describe('redactRollbackRecord keeps only what the previous record persisted (#4801)', () => {
  const secrets = (): Map<string, string> => new Map([[NAME, REF]]);
  const previous = (): ResourceState => ({
    physicalId: URL,
    resourceType: 'AWS::SQS::QueuePolicy',
    properties: {
      Queues: [URL],
      PolicyDocument: { Statement: [{ Sid: 'A', Resource: ARN_REF }] },
    },
    attributes: { Url: URL, Arn: ARN_REF },
    dependencies: [],
  });

  it('keeps a plaintext leaf the restore reproduced byte for byte, in properties and attributes', () => {
    const prev = previous();
    // The provider's echo: the RESOLVED bag, every reference now plaintext.
    const restored: ResourceState = {
      ...prev,
      properties: {
        Queues: [URL],
        PolicyDocument: { Statement: [{ Sid: 'A', Resource: ARN }] },
      },
      attributes: { Url: URL, Arn: ARN },
    };
    const out = redactRollbackRecord(restored, secrets(), prev.properties, prev.attributes);
    expect(out.properties).toEqual(prev.properties);
    expect(out.attributes).toEqual({ Url: URL, Arn: ARN_REF });
  });

  it('redacts a leaf whose restored value differs from the persisted one', () => {
    const prev = previous();
    const echoed = `${URL}?echo`;
    const restored: ResourceState = {
      ...prev,
      properties: { Queues: [echoed], PolicyDocument: prev.properties['PolicyDocument'] },
      attributes: { Url: `${URL}/new`, Arn: ARN },
    };
    const out = redactRollbackRecord(restored, secrets(), prev.properties, prev.attributes);
    expect(out.properties['Queues']).toEqual([`${echoed.replace(NAME, REF)}`]);
    expect(out.attributes).toEqual({ Url: `${URL.replace(NAME, REF)}/new`, Arn: ARN_REF });
  });

  it('never keeps a persisted leaf that carried a reference', () => {
    // A persisted leaf that is the reference, and a restored bag holding the
    // reference verbatim: equal, but a reference-bearing leaf is the scan's.
    const prev: ResourceState = {
      ...previous(),
      properties: { Name: REF, Copy: URL },
      attributes: {},
    };
    const out = redactRollbackRecord(
      { ...prev, properties: { Name: NAME, Copy: URL } },
      secrets(),
      prev.properties,
      prev.attributes
    );
    expect(out.properties).toEqual({ Name: REF, Copy: URL });
  });

  it('never keeps a persisted reference-bearing leaf the restore reproduced exactly', () => {
    // The no-`effectiveProperties` arm: the restored leaf IS the persisted one,
    // a reference beside a plaintext copy. A leaf carrying a reference stays
    // the redaction's, whatever it held.
    const mixed = `${REF}-${NAME}`;
    const prev: ResourceState = { ...previous(), properties: { Mixed: mixed }, attributes: {} };
    const out = redactRollbackRecord(prev, secrets(), prev.properties, prev.attributes);
    expect(out.properties).toEqual({ Mixed: `${REF}-${REF}` });
  });

  it('leaves a whole-leaf mask in place', () => {
    const masked = 'mask-only-generated-value';
    const prev: ResourceState = { ...previous(), properties: { Data: masked }, attributes: {} };
    const map = secrets();
    map.set(masked, SECRET_MASK);
    const out = redactRollbackRecord(
      { ...prev, properties: { Data: masked } },
      map,
      prev.properties,
      prev.attributes
    );
    expect(out.properties).toEqual({ Data: SECRET_MASK });
  });

  it('never mutates the persisted record it restores from', () => {
    const prev = previous();
    const before = structuredClone(prev);
    // The no-`effectiveProperties` arm: the record IS the previous one.
    const out = redactRollbackRecord(prev, secrets(), prev.properties, prev.attributes);
    expect(prev).toEqual(before);
    expect(out.properties).toEqual(before.properties);
    expect(out.attributes).toEqual(before.attributes);
  });

  it('keeps an own __proto__ key as data while rebuilding a container', () => {
    const prev: ResourceState = {
      ...previous(),
      properties: JSON.parse(`{"__proto__": {"Copy": "${URL}"}, "Queues": ["${URL}"]}`),
      attributes: {},
    };
    const out = redactRollbackRecord(
      { ...prev, properties: JSON.parse(JSON.stringify(prev.properties)) },
      secrets(),
      prev.properties,
      prev.attributes
    );
    expect(Object.prototype.hasOwnProperty.call(out.properties, '__proto__')).toBe(true);
    expect(JSON.stringify(out.properties)).toBe(JSON.stringify(prev.properties));
  });
});

describe('each rollback arm restores a reader’s plaintext copies (#4801)', () => {
  const TYPE = 'AWS::Cognito::UserPoolIdentityProvider';
  const silentLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => silentLogger,
  } as unknown as RollbackExecutorContext['logger'];
  const ctxFor = (provider: Record<string, unknown>): RollbackExecutorContext => ({
    region: 'us-east-1',
    logger: silentLogger,
    providerRegistry: {
      getProviderFor: () => ({ provider }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
    recordEvent: () => {},
  });
  /** A reader's record: a reference it read, and two plaintext copies of the name. */
  const reader = (physicalId: string, extra: Record<string, unknown> = {}): ResourceState => ({
    physicalId,
    resourceType: TYPE,
    properties: { Queues: [URL], Resource: ARN_REF, ...extra },
    attributes: { Url: URL },
    dependencies: [],
  });
  // The provider's echo of the RESOLVED desired bag, and its attributes.
  const echo = { effectiveProperties: { Queues: [URL], Resource: ARN }, attributes: { Url: URL } };
  const expectRestored = (rec: ResourceState | undefined): void => {
    expect(rec?.properties).toEqual({ Queues: [URL], Resource: ARN_REF });
    expect(rec?.attributes).toEqual({ Url: URL });
  };

  it('revert of a completed UPDATE', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'p', ...echo });
    const state = { R: reader('p', { Changed: 'yes' }) };
    await replayRollback(
      [{ logicalId: 'R', changeType: 'UPDATE', resourceType: TYPE, physicalId: 'p', previousState: reader('p') }],
      state,
      'S',
      ctxFor({ update })
    );
    expect(update).toHaveBeenCalledTimes(1);
    expectRestored(state.R);
  });

  it('revert of a failed UPDATE', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'p', ...echo });
    const state = { R: reader('p') };
    await replayFailedOperations(
      [
        {
          logicalId: 'R',
          changeType: 'UPDATE',
          resourceType: TYPE,
          physicalId: 'p',
          previousState: reader('p'),
          attemptedProperties: { Queues: [URL], Resource: ARN_REF, Changed: 'yes' },
        },
      ],
      state,
      'S',
      ctxFor({ update })
    );
    expect(update).toHaveBeenCalledTimes(1);
    expectRestored(state.R);
  });

  it('re-create of a reverse replacement', async () => {
    const create = vi.fn().mockResolvedValue({ physicalId: 'old', ...echo });
    const del = vi.fn().mockResolvedValue(undefined);
    const state = { R: reader('new') };
    await replayRollback(
      [{ logicalId: 'R', changeType: 'UPDATE', resourceType: TYPE, physicalId: 'new', previousState: reader('old') }],
      state,
      'S',
      ctxFor({ create, delete: del })
    );
    expect(create).toHaveBeenCalledTimes(1);
    expectRestored(state.R);
  });
});
