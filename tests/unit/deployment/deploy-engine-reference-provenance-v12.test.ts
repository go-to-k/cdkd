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
  /** go-to-k/cdkd#4847: the value each version id holds, for a pinned read. */
  history: {} as Record<string, string>,
  /** Every lookup, as `<SecretId>@<VersionId or stage>`. */
  lookups: [] as string[],
}));
const answer = vi.hoisted(() => async (command?: unknown): Promise<unknown> => {
  secret.calls++;
  const input = (
    command as { input?: { SecretId?: string; VersionId?: string; VersionStage?: string } } | undefined
  )?.input;
  const id = input?.SecretId;
  secret.lookups.push(`${String(id)}@${input?.VersionId ?? input?.VersionStage ?? ''}`);
  if (secret.mode === 'denied' || id === 'denied-secret') {
    throw Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });
  }
  if (secret.mode === 'throttle') {
    throw Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
  }
  if (input?.VersionId !== undefined) {
    const queue = secret.history[input.VersionId];
    if (queue === undefined) {
      throw Object.assign(new Error('no such version'), { name: 'ResourceNotFoundException' });
    }
    return { SecretString: JSON.stringify({ queue }), VersionId: input.VersionId };
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
    send(command: unknown): Promise<unknown> {
      return answer(command);
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
/** A token of a service cdkd does not resolve: left as written. */
const ODD = '{{resolve:custom-service:thing}}';
/** A token whose lookup the double denies. */
const DENIED = '{{resolve:secretsmanager:denied-secret:SecretString:x::}}';
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
  secret.history = { [V1]: 'sdin-q-1' };
  secret.lookups = [];
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
  /** What each provider update was sent. */
  sent: Record<string, Record<string, unknown>>;
}

async function deploy(opts: {
  state: StackState | undefined;
  queueVisibility?: number;
  tagKey?: string;
  readerDescription?: string;
  outputs?: boolean;
  /** The reader's tag spells the token (default); off, it holds it only through `Arn`. */
  readerSpellsSecret?: boolean;
  /** A second output spelling the token literally, beside the one reading `Arn`. */
  literalOutput?: boolean;
  /** The reader's provider answers its update with `effectiveProperties`. */
  readerEffectiveProperties?: boolean;
  /** The reader's provider answers its update with no attributes (they are carried). */
  readerUpdateNoAttributes?: boolean;
  /** A create-only change, so the queue is REPLACED. */
  fifo?: boolean;
  /** The literal output also carries an `Export.Name`. */
  exportLiteralOutput?: boolean;
  /** The reader's NAME (its first property) spells a token whose lookup is denied. */
  readerDeniedName?: boolean;
  dryRun?: boolean;
  /** The reader's provider reports its update sent nothing (Cloud Control's empty patch). */
  readerSentNothing?: boolean;
  /** A third resource whose only token is of a service cdkd does not resolve. */
  oddResource?: boolean;
  /** `--require-approval any-change`, answered NO. */
  declineApproval?: boolean;
}): Promise<Run> {
  const calls: string[] = [];
  const sent: Record<string, Record<string, unknown>> = {};
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
        : { physicalId: id === 'Odd' ? 'odd-topic' : '/p/reader', attributes: {} };
    }),
    update: vi.fn(
      async (id: string, _pid: string, _type: string, props: Record<string, unknown>) => {
        calls.push(`update:${id}`);
        sent[id] = props;
        return id === 'SecretQueue'
          ? { physicalId: URL, attributes: { Arn: PLAIN_ARN, QueueUrl: URL } }
          : {
              physicalId: '/p/reader',
              ...(!opts.readerUpdateNoAttributes && { attributes: {} }),
              ...(opts.readerSentNothing && { sentNothing: true }),
              ...(opts.readerEffectiveProperties && { effectiveProperties: { ...props } }),
            };
      }
    ),
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
      getExecutionLevels: vi
        .fn()
        .mockReturnValue(opts.oddResource ? [['SecretQueue', 'Odd'], ['Reader']] : [['SecretQueue'], ['Reader']]),
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
    {
      dryRun: opts.dryRun === true,
      forceStatefulRecreation: true,
      ...(opts.declineApproval && {
        requireApproval: 'any-change' as const,
        approveDeployment: async () => false,
      }),
    },
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
            ...(opts.fifo && { FifoQueue: true }),
          },
        },
        ...(opts.oddResource && {
          Odd: { Type: 'AWS::SNS::Topic', Properties: { TopicName: ODD } },
        }),
        Reader: {
          Type: 'AWS::SSM::Parameter',
          Properties: {
            Name: opts.readerDeniedName ? DENIED : '/p/reader',
            Type: 'String',
            Value: { 'Fn::GetAtt': ['SecretQueue', 'Arn'] },
            Description: opts.readerDescription ?? 'a',
            Tags: opts.readerSpellsSecret === false ? { Name: 'plain' } : { Name: REF },
          },
        },
      },
      ...(opts.outputs !== false && {
        Outputs: {
          QueueArn: { Value: { 'Fn::GetAtt': ['SecretQueue', 'Arn'] } },
          ...(opts.literalOutput && {
            Named: {
              Value: REF,
              ...(opts.exportLiteralOutput && { Export: { Name: 'named-export' } }),
            },
          }),
        },
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
  return { last: saved[saved.length - 1], saves: saved.length, calls, thrown, sent };
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

  it('two outputs holding one token keep their own routes (keyed by output)', async () => {
    const first = await deploy({ state: undefined, readerSpellsSecret: false });
    const run = await deploy({
      state: first.last,
      readerSpellsSecret: false,
      readerDescription: 'b',
      literalOutput: true,
    });
    expect(run.thrown).toBeUndefined();
    expect(run.last?.outputReferenceProvenance).toEqual({
      QueueArn: { [REF]: { region: 'us-east-1', versions: [V1], readVersions: [V1] } },
      Named: { [REF]: { region: 'us-east-1', versions: [V1] } },
    });
  });

  it('an Export.Name alias takes its output\'s provenance', async () => {
    const first = await deploy({ state: undefined, readerSpellsSecret: false });
    const run = await deploy({
      state: first.last,
      readerSpellsSecret: false,
      readerDescription: 'b',
      literalOutput: true,
      exportLiteralOutput: true,
    });
    expect(run.thrown).toBeUndefined();
    const field = run.last?.outputReferenceProvenance as Record<string, unknown>;
    expect(field['named-export']).toEqual({ [REF]: { region: 'us-east-1', versions: [V1] } });
  });

  it('a REPLACED record takes this pass alone, never the union', async () => {
    const first = await deploy({ state: undefined });
    // Rotated, and a create-only change: replaced under the new name.
    secret.queue = 'sdin-q-2';
    secret.version = V2;
    const run = await deploy({ state: first.last, fifo: true });
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toContain('create:SecretQueue');
    expect(provenance(run, 'SecretQueue')).toEqual({
      [REF]: { region: 'us-east-1', versions: [V2] },
    });
  });

  it('attributes carried on an in-place update (no fresh ones) keep both generations', async () => {
    const first = await deploy({ state: undefined });
    // A carried attribute holding the token, beside tokens at mutable paths only.
    first.last!.resources['Reader']!.attributes = { Echo: REF };
    secret.version = V2;
    secret.history[V2] = 'sdin-q-1';
    // The queue's record at V2 as well, so the reader's read route (pinned to
    // the queue's recorded version since go-to-k/cdkd#4847) reads V2 too.
    first.last!.resources['SecretQueue']!.referenceProvenance = {
      [REF]: { region: 'us-east-1', versions: [V2] },
    };
    const run = await deploy({
      state: first.last,
      readerDescription: 'b',
      readerUpdateNoAttributes: true,
    });
    expect(run.thrown).toBeUndefined();
    expect(run.last?.resources['Reader']?.attributes).toEqual({ Echo: REF });
    expect(provenance(run, 'Reader')).toEqual({
      [REF]: { region: 'us-east-1', versions: [V1, V2], readVersions: [V2] },
    });
  });

  it('a written record holding a token this pass recorded nothing for keys it {} (no later capture)', async () => {
    const run = await deploy({ state: undefined, oddResource: true });
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toContain('create:Odd');
    expect(provenance(run, 'Odd')).toEqual({ [ODD]: {} });
  });

  it('an update that sent nothing keeps the previous field', async () => {
    const first = await deploy({ state: undefined });
    secret.version = V2;
    const run = await deploy({ state: first.last, readerDescription: 'b', readerSentNothing: true });
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toContain('update:Reader');
    expect(provenance(run, 'Reader')).toEqual(provenance(first, 'Reader'));
  });

  it('the engine hands a nested child the inherited snapshot on every resolver context', () => {
    const snapshot = new Map([[REF, { region: 'us-west-2', versions: [V1] }]]);
    const engine = new DeployEngine(
      {} as never,
      {} as never,
      {} as never,
      new DiffCalculator(),
      {} as never,
      { inheritedReferenceProvenance: snapshot },
      'us-east-1'
    );
    const context = engine.buildResolverContext({ template: { Resources: {} }, resources: {} }, 's');
    expect(context.inheritedReferenceProvenance).toBe(snapshot);
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

describe('a write through effectiveProperties (it may carry previous leaves)', () => {
  it('takes the union for every token on an in-place update, a mutable one included', async () => {
    const first = await deploy({ state: undefined });
    expect(provenance(first, 'Reader')).toEqual({
      [REF]: { region: 'us-east-1', versions: [V1], readVersions: [V1] },
    });
    // Same value, new VersionId: nothing is replaced, the reader is edited.
    secret.version = V2;
    secret.history[V2] = 'sdin-q-1';
    // The queue's record at V2 as well, so the reader's read route (pinned to
    // the queue's recorded version since go-to-k/cdkd#4847) reads V2 too.
    first.last!.resources['SecretQueue']!.referenceProvenance = {
      [REF]: { region: 'us-east-1', versions: [V2] },
    };
    const run = await deploy({
      state: first.last,
      readerDescription: 'b',
      readerEffectiveProperties: true,
    });
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toContain('update:Reader');
    // The token sits only at mutable paths (`Tags`, `Value`), yet the bag the
    // provider returned may hold the previous generation's leaves.
    expect(provenance(run, 'Reader')).toEqual({
      [REF]: { region: 'us-east-1', versions: [V1, V2], readVersions: [V2] },
    });
  });

  it('control: the same update without effectiveProperties takes this run alone', async () => {
    const first = await deploy({ state: undefined });
    secret.version = V2;
    secret.history[V2] = 'sdin-q-1';
    // The queue's record at V2 as well, so the reader's read route (pinned to
    // the queue's recorded version since go-to-k/cdkd#4847) reads V2 too.
    first.last!.resources['SecretQueue']!.referenceProvenance = {
      [REF]: { region: 'us-east-1', versions: [V2] },
    };
    const run = await deploy({ state: first.last, readerDescription: 'b' });
    expect(provenance(run, 'Reader')).toEqual({
      [REF]: { region: 'us-east-1', versions: [V2], readVersions: [V2] },
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

  it('never records readVersions, even where the version is proven by the physical id', async () => {
    // The reader's id holds the queue's name, so its version is proven; it
    // read the value through `Fn::GetAtt`, which an equal reference form
    // cannot prove fresh.
    const run = await deploy({
      state: v11State({ reader: { physicalId: '/p/sdin-q-1/reader' }, outputs: false }),
      outputs: false,
    });
    expect(provenance(run, 'Reader')).toEqual({ [REF]: { region: 'us-east-1', versions: [V1] } });
  });

  it('a state read off the token-free fast path is never captured', async () => {
    const { markTokenFreeState } = await import('../../../src/state/token-free-state.js');
    const state = v11State({ outputs: false });
    // Contradictory on purpose: the mark alone must decide.
    markTokenFreeState(state);
    const run = await deploy({ state, outputs: false });
    expect(run.thrown).toBeUndefined();
    expect(secret.calls).toBe(0);
    expect(run.saves).toBe(0);
  });

  it('two records sharing one token cost one lookup (one record at a time, through the cache)', async () => {
    const run = await deploy({ state: v11State({ outputs: false }), outputs: false });
    expect(run.thrown).toBeUndefined();
    expect(secret.calls).toBe(1);
    expect(provenance(run, 'Reader')).toEqual({ [REF]: { region: 'us-east-1' } });
  });

  it('a property that cannot resolve leaves only its own tokens unattributed (the later ones still resolve)', async () => {
    const run = await deploy({
      state: v11State({
        reader: {
          properties: {
            Name: DENIED,
            Type: 'String',
            Value: RECORDED_ARN,
            Description: 'a',
            Tags: { Name: REF },
          },
        },
        outputs: false,
      }),
      outputs: false,
      readerDeniedName: true,
    });
    expect(run.thrown).toBeUndefined();
    expect(provenance(run, 'Reader')).toEqual({
      [DENIED]: {},
      [REF]: { region: 'us-east-1' },
    });
    expect(log.warn.filter((m) => m.includes('state schema v12 migration'))).toHaveLength(1);
  });

  it('a deploy declined at --require-approval makes no capture lookup', async () => {
    const run = await deploy({
      state: v11State({ outputs: false }),
      outputs: false,
      queueVisibility: 30,
      declineApproval: true,
    });
    expect(run.thrown).toBeDefined();
    expect(secret.calls).toBe(0);
    expect(log.warn.filter((m) => m.includes('state schema v12 migration'))).toEqual([]);
  });

  it('resolves only the properties whose stored value holds a token', async () => {
    const { IntrinsicFunctionResolver } = await import(
      '../../../src/deployment/intrinsic-function-resolver.js'
    );
    const spy = vi.spyOn(IntrinsicFunctionResolver.prototype, 'resolve');
    try {
      await deploy({ state: v11State({ outputs: false }), outputs: false });
      const captured = spy.mock.calls.filter(
        ([, context]) => (context as { provenanceCapture?: true }).provenanceCapture === true
      );
      // SecretQueue: QueueName, Tags. Reader: Value, Tags. Never Name / Type /
      // VisibilityTimeout / Description, which hold no token.
      expect(captured).toHaveLength(4);
    } finally {
      spy.mockRestore();
    }
  });

  it('--dry-run makes no capture lookup', async () => {
    const run = await deploy({ state: v11State({ outputs: false }), outputs: false, dryRun: true });
    expect(run.thrown).toBeUndefined();
    expect(secret.calls).toBe(0);
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

describe('a recorded reference re-resolved at its recorded version (go-to-k/cdkd#4847)', () => {
  /** The same state without any v12 field: what today's path reads. */
  const withoutProvenance = (state: StackState | undefined): StackState => {
    const copy = structuredClone(state!);
    delete copy.outputReferenceProvenance;
    for (const record of Object.values(copy.resources)) delete record.referenceProvenance;
    return copy;
  };

  it('a pin equal to the current version: one unpinned lookup, and the sends of a record without the field', async () => {
    const first = await deploy({ state: undefined, readerSpellsSecret: false });
    const runs: Array<{ run: Run; lookups: string[] }> = [];
    for (const state of [structuredClone(first.last!), withoutProvenance(first.last)]) {
      secret.lookups = [];
      const run = await deploy({ state, readerSpellsSecret: false, readerDescription: 'b' });
      expect(run.thrown).toBeUndefined();
      runs.push({ run, lookups: [...secret.lookups] });
    }
    const [pinned, today] = runs;
    // One unpinned lookup, which the pin equal to it reuses.
    expect(pinned!.lookups).toEqual(['sdin@AWSCURRENT']);
    expect(pinned!.run.calls).toEqual(today!.run.calls);
    expect(pinned!.run.sent).toEqual(today!.run.sent);
    expect(pinned!.run.sent['Reader']?.['Value']).toBe(PLAIN_ARN);
  });

  it("a reader that spells the token AND reads Arn, edited: the base's one lookup, no pinned one", async () => {
    const first = await deploy({ state: undefined });
    secret.lookups = [];
    const run = await deploy({ state: structuredClone(first.last!), readerDescription: 'b' });
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toEqual(['update:Reader']);
    // The merge base makes exactly this one lookup (measured, PR body table).
    expect(secret.lookups).toEqual(['sdin@AWSCURRENT']);
  });

  it('an unrelated redeploy: one unpinned lookup, no pinned one', async () => {
    const first = await deploy({ state: undefined, readerSpellsSecret: false });
    // Settled first: the reader stored the plaintext ARN in the run that
    // created its producer, and its next deploy rewrites it once.
    const settled = await deploy({ state: first.last, readerSpellsSecret: false });
    secret.lookups = [];
    const run = await deploy({ state: settled.last, readerSpellsSecret: false });
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toEqual([]);
    // The output's re-resolution of the queue's `Arn` makes the one lookup
    // it made before v12 (its physical-id proof); the pin equals that
    // version, so no pinned lookup follows.
    expect(secret.lookups).toEqual(['sdin@AWSCURRENT']);
  });

  it('after a rotation, a reader of the UNCHANGED queue is sent the ARN of the name it was created with', async () => {
    const first = await deploy({ state: undefined, readerSpellsSecret: false });
    secret.queue = 'sdin-q-2';
    secret.version = V2;
    secret.history[V2] = 'sdin-q-2';
    secret.lookups = [];
    const run = await deploy({
      state: structuredClone(first.last!),
      readerSpellsSecret: false,
      readerDescription: 'b',
    });
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toEqual(['update:Reader']);
    expect(run.sent['Reader']?.['Value']).toBe(PLAIN_ARN);
    // Unpinned first (the base's own lookup), then the pin: nothing else.
    expect(secret.lookups).toEqual(['sdin@AWSCURRENT', `sdin@${V1}`]);
    expect(log.warn.filter((w) => w.includes('as recorded'))).toEqual([]);
    // The reader persists the reference, read at V1.
    expect(run.last?.resources['Reader']?.properties['Value']).toBe(RECORDED_ARN);
    expect(provenance(run, 'Reader')).toEqual({
      [REF]: { region: 'us-east-1', versions: [V1], readVersions: [V1] },
    });
  });

  it("CONTROL: the same rotation with no field takes today's path (served as recorded, with the warning)", async () => {
    const first = await deploy({ state: undefined, readerSpellsSecret: false });
    secret.queue = 'sdin-q-2';
    secret.version = V2;
    secret.history[V2] = 'sdin-q-2';
    const run = await deploy({
      state: withoutProvenance(first.last),
      readerSpellsSecret: false,
      readerDescription: 'b',
    });
    expect(run.sent['Reader']?.['Value']).toBe(RECORDED_ARN);
    expect(log.warn.some((w) => w.includes('as recorded'))).toBe(true);
  });
});
