/**
 * State schema v12 (go-to-k/cdkd#4847 / go-to-k/cdkd#4852), through the real
 * `DeployEngine` / `DiffCalculator` / resolver: what `referenceProvenance`
 * a save persists. A queue NAMED from a secret, and a reader of its `Arn`
 * that also spells the secret reference, as in
 * `deploy-engine-reader-replaced-producer-4838.test.ts`.
 *
 * - the recording seam: the region that answered, the version off the lookup
 *   response, and the route (a value read through `Fn::GetAtt` is `read`);
 * - the persist writer: a written record takes this pass's entries, a skipped
 *   one keeps its previous entry (the same-generation gate), and a token under
 *   a create-only path of an in-place update keeps both generations;
 * - outputs, keyed by output;
 * - the one-time migration capture, its failure classes, and that it is one-time.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const log = vi.hoisted(() => ({ warn: [] as string[] }));
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn((m: unknown) => {
      log.warn.push(String(m));
    }),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});
/** The secret's current value / VersionId, and how the lookup answers. */
const secret = vi.hoisted(() => ({
  queue: 'sdin-q-1',
  version: 'a1b2c3d4-0000-1111-2222-333333333333' as string | undefined,
  mode: 'ok' as 'ok' | 'denied' | 'throttle',
  calls: 0,
}));
const answer = vi.hoisted(() => async (): Promise<unknown> => {
  secret.calls++;
  if (secret.mode === 'denied') {
    throw Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });
  }
  if (secret.mode === 'throttle') {
    throw Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
  }
  return {
    SecretString: JSON.stringify({ queue: secret.queue }),
    ...(secret.version !== undefined && { VersionId: secret.version }),
  };
});
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    secretsManager: {
      send: answer,
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
    send(): Promise<unknown> {
      return answer();
    }
    destroy(): void {}
  }
  return { ...actual, SecretsManagerClient: FakeSecretsManagerClient };
});
vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { dynamicReferenceRetryDelays } from '../../../src/deployment/intrinsic-resolver/account-drain.js';
import type { StackState } from '../../../src/types/state.js';

const REF = '{{resolve:secretsmanager:sdin:SecretString:queue::}}';
const V1 = 'a1b2c3d4-0000-1111-2222-333333333333';
const V2 = 'b1b2c3d4-0000-1111-2222-333333333333';
const URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/sdin-q-1';
const RECORDED_ARN = `arn:aws:sqs:us-east-1:123456789012:${REF}`;
const PLAIN_ARN = 'arn:aws:sqs:us-east-1:123456789012:sdin-q-1';

beforeEach(() => {
  secret.queue = 'sdin-q-1';
  secret.version = V1;
  secret.mode = 'ok';
  secret.calls = 0;
  log.warn.length = 0;
  dynamicReferenceRetryDelays.sleep = () => Promise.resolve();
});

const v11State = (
  extra: { queue?: object; reader?: object; outputs?: boolean } = {}
): StackState =>
  ({
    version: 11,
    stackName: 's',
    region: 'us-east-1',
    resources: {
      SecretQueue: {
        physicalId: URL,
        resourceType: 'AWS::SQS::Queue',
        properties: { QueueName: REF, VisibilityTimeout: 60, Tags: [{ Key: 'n', Value: REF }] },
        attributes: { Arn: RECORDED_ARN, QueueUrl: URL },
        dependencies: [],
        ...extra.queue,
      },
      Reader: {
        physicalId: '/p/reader',
        resourceType: 'AWS::SSM::Parameter',
        properties: {
          Name: '/p/reader',
          Type: 'String',
          Value: RECORDED_ARN,
          Description: 'a',
          Tags: { Name: REF },
        },
        attributes: {},
        dependencies: ['SecretQueue'],
        ...extra.reader,
      },
    },
    outputs: extra.outputs === false ? {} : { QueueArn: RECORDED_ARN },
    exportNames: [],
    lastModified: 0,
  }) as StackState;

interface Run {
  last: StackState | undefined;
  saves: number;
  calls: string[];
  thrown: unknown;
}

async function deploy(opts: {
  state: StackState | undefined;
  queueVisibility?: number;
  tagKey?: string;
  readerDescription?: string;
  outputs?: boolean;
  /** The reader's tag spells the token (default); off, it holds it only through `Arn`. */
  readerSpellsSecret?: boolean;
}): Promise<Run> {
  const calls: string[] = [];
  const provider = {
    create: vi.fn(async (id: string) => {
      calls.push(`create:${id}`);
      return id === 'SecretQueue'
        ? {
            physicalId: URL.replace('sdin-q-1', secret.queue),
            attributes: {
              Arn: PLAIN_ARN.replace('sdin-q-1', secret.queue),
              QueueUrl: URL.replace('sdin-q-1', secret.queue),
            },
          }
        : { physicalId: '/p/reader', attributes: {} };
    }),
    update: vi.fn(async (id: string) => {
      calls.push(`update:${id}`);
      return id === 'SecretQueue'
        ? { physicalId: URL, attributes: { Arn: PLAIN_ARN, QueueUrl: URL } }
        : { physicalId: '/p/reader', attributes: {} };
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
      getState: vi
        .fn()
        .mockResolvedValue(opts.state === undefined ? null : { state: opts.state, etag: 'e0' }),
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
            VisibilityTimeout: opts.queueVisibility ?? 60,
            Tags: [{ Key: opts.tagKey ?? 'n', Value: REF }],
          },
        },
        Reader: {
          Type: 'AWS::SSM::Parameter',
          Properties: {
            Name: '/p/reader',
            Type: 'String',
            Value: { 'Fn::GetAtt': ['SecretQueue', 'Arn'] },
            Description: opts.readerDescription ?? 'a',
            Tags: opts.readerSpellsSecret === false ? { Name: 'plain' } : { Name: REF },
          },
        },
      },
      ...(opts.outputs !== false && {
        Outputs: { QueueArn: { Value: { 'Fn::GetAtt': ['SecretQueue', 'Arn'] } } },
      }),
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
  return { last: saved[saved.length - 1], saves: saved.length, calls, thrown };
}

const provenance = (run: Run, id: string): unknown =>
  run.last?.resources[id]?.referenceProvenance;

describe('the recording seam and the persist writer (written records)', () => {
  it('a first deploy records region, the response VersionId, and the read route', async () => {
    const run = await deploy({ state: undefined });
    expect(run.thrown).toBeUndefined();
    expect(run.last?.version).toBe(12);
    expect(provenance(run, 'SecretQueue')).toEqual({
      [REF]: { region: 'us-east-1', versions: [V1] },
    });
    // The reader spells the token (literal) AND reads the queue's fresh ARN
    // (read route, the producer's pass entry).
    expect(provenance(run, 'Reader')).toEqual({
      [REF]: { region: 'us-east-1', versions: [V1], readVersions: [V1] },
    });
    // A producer created this run hands its reader (and the output) the
    // plaintext ARN, stored as such (go-to-k/cdkd#4802), so the output holds
    // no token and no output provenance is written.
    expect(run.last?.outputs).toEqual({ QueueArn: PLAIN_ARN });
    expect(run.last?.outputReferenceProvenance).toBeUndefined();
    // Metadata only: no plaintext anywhere in the persisted record.
    expect(JSON.stringify(run.last)).not.toContain('"sdin-q-1"');
  });

  it('a value re-resolved out of an unchanged producer is recorded on the READ route', async () => {
    const first = await deploy({ state: undefined, readerSpellsSecret: false });
    // The reader stored the plaintext ARN once (its producer was created in
    // that run); a description edit rewrites it, now reading the UNCHANGED
    // queue's recorded `Arn`, which is re-resolved (go-to-k/cdkd#4800).
    const run = await deploy({
      state: first.last,
      readerSpellsSecret: false,
      readerDescription: 'b',
    });
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toContain('update:Reader');
    expect(run.last?.resources['Reader']?.properties['Value']).toBe(RECORDED_ARN);
    expect(provenance(run, 'Reader')).toEqual({
      [REF]: { region: 'us-east-1', versions: [V1], readVersions: [V1] },
    });
    // The output reads the same attribute through the same arm, keyed by output.
    expect(run.last?.outputReferenceProvenance).toEqual({
      QueueArn: { [REF]: { region: 'us-east-1', versions: [V1], readVersions: [V1] } },
    });
  });

  it('a lookup response with no VersionId records the region only', async () => {
    secret.version = undefined;
    const run = await deploy({ state: undefined });
    expect(provenance(run, 'SecretQueue')).toEqual({ [REF]: { region: 'us-east-1' } });
  });

  it('a record the update re-check SKIPPED keeps its previous entry (the same-generation gate)', async () => {
    const first = await deploy({ state: undefined });
    // A JSON key elsewhere in the secret changed: same value, new VersionId.
    secret.version = V2;
    // The queue is updated in place; the reader is promoted, resolves equal
    // to its record, and is skipped.
    const run = await deploy({ state: first.last, queueVisibility: 30 });
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toContain('update:SecretQueue');
    expect(run.calls).not.toContain('update:Reader');
    expect(provenance(run, 'Reader')).toEqual(provenance(first, 'Reader'));
  });

  it('mixed token: a create-only QueueName keeps both generations after an in-place update', async () => {
    const first = await deploy({ state: undefined });
    // Rotated: a NEW value at a new version. The diff compares tokens, so
    // QueueName stays NO_CHANGE and AWS keeps the old name; the edited tag
    // makes it an in-place update that sends the new value to the tag.
    secret.queue = 'sdin-q-2';
    secret.version = V2;
    const run = await deploy({ state: first.last, tagKey: 'n2' });
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toContain('update:SecretQueue');
    expect(run.calls).not.toContain('create:SecretQueue');
    // NOT pinned to V2 alone: AWS still holds V1's name.
    expect(provenance(run, 'SecretQueue')).toEqual({
      [REF]: { region: 'us-east-1', versions: [V1, V2] },
    });
  });
});

describe('the one-time migration capture (v11 -> v12)', () => {
  it('writes only the field onto unchanged records, sends nothing, and saves version 12', async () => {
    const state = v11State();
    const before = JSON.parse(JSON.stringify(state)) as StackState;
    const run = await deploy({ state });
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toEqual([]);
    expect(run.last?.version).toBe(12);
    // The queue's physical id holds the plaintext, so its version is proven.
    expect(provenance(run, 'SecretQueue')).toEqual({
      [REF]: { region: 'us-east-1', versions: [V1] },
    });
    // The reader's id does not: region only, and readVersions NEVER.
    expect(provenance(run, 'Reader')).toEqual({ [REF]: { region: 'us-east-1' } });
    // Nothing else of either record changed.
    for (const id of ['SecretQueue', 'Reader']) {
      const { referenceProvenance: _f, constructPath: _c, ...rest } = run.last!.resources[id]!;
      expect(rest).toEqual(before.resources[id]);
    }
    expect(log.warn.filter((m) => m.includes('state schema v12 migration'))).toEqual([]);
  });

  it('is one-time: the next deploy makes no capture lookup', async () => {
    const first = await deploy({ state: v11State({ outputs: false }), outputs: false });
    expect(secret.calls).toBeGreaterThan(0);
    secret.calls = 0;
    const second = await deploy({ state: first.last, outputs: false });
    expect(second.thrown).toBeUndefined();
    expect(secret.calls).toBe(0);
    expect(second.saves).toBe(0);
  });

  it('a record that already has the field ({} included) is not captured', async () => {
    const run = await deploy({
      state: v11State({
        queue: { referenceProvenance: {} },
        reader: { referenceProvenance: {} },
        outputs: false,
      }),
      outputs: false,
    });
    expect(secret.calls).toBe(0);
    expect(run.saves).toBe(0);
  });

  it('a definitive failure writes {} per token and warns once per record; then it is final', async () => {
    secret.mode = 'denied';
    const run = await deploy({ state: v11State({ outputs: false }), outputs: false });
    expect(run.thrown).toBeUndefined();
    expect(provenance(run, 'SecretQueue')).toEqual({ [REF]: {} });
    expect(provenance(run, 'Reader')).toEqual({ [REF]: {} });
    const warnings = log.warn.filter((m) => m.includes('state schema v12 migration'));
    expect(warnings).toHaveLength(2);
    // Names the record, never the token.
    expect(warnings.join('\n')).not.toContain('{{resolve:');
    secret.calls = 0;
    const second = await deploy({ state: run.last, outputs: false });
    expect(secret.calls).toBe(0);
    expect(second.saves).toBe(0);
  });

  it('throttling leaves the field absent, and the next deploy retries', async () => {
    secret.mode = 'throttle';
    const run = await deploy({ state: v11State({ outputs: false }), outputs: false });
    expect(run.thrown).toBeUndefined();
    expect(run.saves).toBe(0);
    secret.mode = 'ok';
    secret.calls = 0;
    const second = await deploy({ state: v11State({ outputs: false }), outputs: false });
    expect(secret.calls).toBeGreaterThan(0);
    expect(provenance(second, 'SecretQueue')).toEqual({
      [REF]: { region: 'us-east-1', versions: [V1] },
    });
  });

  it('the outputs share: an unchanged v11 outputs bag gains its provenance once', async () => {
    const run = await deploy({
      state: v11State({
        queue: { referenceProvenance: {} },
        reader: { referenceProvenance: {} },
      }),
    });
    expect(run.thrown).toBeUndefined();
    expect(run.last?.outputs).toEqual({ QueueArn: RECORDED_ARN });
    expect(run.last?.outputReferenceProvenance).toEqual({
      QueueArn: { [REF]: { region: 'us-east-1', versions: [V1], readVersions: [V1] } },
    });
    const second = await deploy({ state: run.last });
    expect(second.saves).toBe(0);
  });
});
