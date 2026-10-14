/**
 * go-to-k/cdkd#4852, through the real `DeployEngine` / `DiffCalculator` /
 * resolver: a reader whose recorded `readVersions` (state schema v12) its
 * upstream no longer holds is PROMOTED by the diff from records alone, and the
 * engine's skip term SENDS it only when the read-route versions it is served
 * moved. The shapes #4851's "replaced in this run" rule cannot see:
 *
 * - an interrupted earlier deploy (the queue was replaced, the reader not);
 * - a producer updated in place in an earlier run (an SSM `Value`);
 * - a cross-stack consumer (`Fn::ImportValue`), whose producer's state is read
 *   once (gated), and which is pinned to the producer's recorded version;
 * - a nested child, whose upstream is the inherited snapshot.
 *
 * And what must NOT send: a rotation alone (CloudFormation parity), a
 * literal-only token, an upstream holding no version (no verdict).
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const log = vi.hoisted(() => ({ info: [] as string[], warn: [] as string[] }));
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn((m: unknown) => {
      log.info.push(String(m));
    }),
    warn: vi.fn((m: unknown) => {
      log.warn.push(String(m));
    }),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});
/** The secret's current value / VersionId, and each version's value. */
const secret = vi.hoisted(() => ({
  queue: 'sdin-q-1',
  version: 'a1b2c3d4-0000-1111-2222-333333333333',
  history: {} as Record<string, string>,
  /** Every lookup, as `<SecretId>@<VersionId or stage>`. */
  lookups: [] as string[],
  /** The region of each lookup, beside `lookups`. */
  regions: [] as string[],
}));
const answer = vi.hoisted(() => async (command?: unknown, region = 'us-east-1'): Promise<unknown> => {
  const input = (
    command as { input?: { SecretId?: string; VersionId?: string; VersionStage?: string } } | undefined
  )?.input;
  secret.lookups.push(`${String(input?.SecretId)}@${input?.VersionId ?? input?.VersionStage ?? ''}`);
  secret.regions.push(region);
  if (input?.VersionId !== undefined) {
    const queue = secret.history[input.VersionId];
    if (queue === undefined) {
      throw Object.assign(new Error('no such version'), { name: 'ResourceNotFoundException' });
    }
    return { SecretString: JSON.stringify({ queue }), VersionId: input.VersionId };
  }
  return { SecretString: JSON.stringify({ queue: secret.queue }), VersionId: secret.version };
});
vi.mock('../../../src/utils/aws-clients.js', () => {
  // Region-scoped client sets, so a lookup says which region asked.
  const clients = (region: string): Record<string, unknown> => ({
    sts: { send: async () => ({ Account: '123456789012' }) },
    secretsManager: {
      send: (command: unknown) => answer(command, region),
      config: { region: () => Promise.resolve(region) },
    },
    credentialConfig: {},
    withRegion: (target: string) => clients(target),
  });
  return { getAwsClients: () => clients('us-east-1') };
});
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
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ReferenceProvenance, StackState } from '../../../src/types/state.js';

const REF = '{{resolve:secretsmanager:sdin:SecretString:queue::}}';
const V1 = 'a1b2c3d4-0000-1111-2222-333333333333';
const V2 = 'b1b2c3d4-0000-1111-2222-333333333333';
const URL_1 = 'https://sqs.us-east-1.amazonaws.com/123456789012/sdin-q-1';
const URL_2 = URL_1.replace('sdin-q-1', 'sdin-q-2');
const RECORDED_ARN = `arn:aws:sqs:us-east-1:123456789012:${REF}`;
const PLAIN_ARN_1 = 'arn:aws:sqs:us-east-1:123456789012:sdin-q-1';
const PLAIN_ARN_2 = PLAIN_ARN_1.replace('sdin-q-1', 'sdin-q-2');

const at = (versions: string[], read?: string[]): ReferenceProvenance => ({
  region: 'us-east-1',
  versions,
  ...(read !== undefined && { readVersions: read }),
});

beforeEach(() => {
  secret.queue = 'sdin-q-1';
  secret.version = V1;
  secret.history = { [V1]: 'sdin-q-1' };
  secret.lookups = [];
  secret.regions = [];
  log.info.length = 0;
  log.warn.length = 0;
});

/** Rotate the secret to V2, whose value names the second queue. */
function rotate(): void {
  secret.queue = 'sdin-q-2';
  secret.version = V2;
  secret.history[V2] = 'sdin-q-2';
}

interface Run {
  last: StackState | undefined;
  calls: string[];
  sent: Record<string, Record<string, unknown>>;
  thrown: unknown;
  /** Every `getState` call, as `<stack>`. */
  stateReads: string[];
}

async function deploy(opts: {
  stackName?: string;
  state: StackState;
  template: CloudFormationTemplate;
  levels: string[][];
  /** Producer stacks' states, by name, for a cross-stack read. */
  producers?: Record<string, StackState>;
  exportIndex?: Record<string, { value: unknown; producerStack: string; producerRegion: string }>;
  options?: Record<string, unknown>;
  /** What a readback of a resource returns (a `NoEcho` readback). */
  readBack?: Record<string, unknown>;
}): Promise<Run> {
  const stackName = opts.stackName ?? 's';
  const calls: string[] = [];
  const sent: Record<string, Record<string, unknown>> = {};
  const stateReads: string[] = [];
  const provider = {
    create: vi.fn(async (id: string, type: string, props: Record<string, unknown>) => {
      calls.push(`create:${id}`);
      sent[id] = props;
      return type === 'AWS::SQS::Queue'
        ? {
            physicalId: URL_1.replace('sdin-q-1', secret.queue),
            attributes: { Arn: PLAIN_ARN_1.replace('sdin-q-1', secret.queue) },
          }
        : { physicalId: `${id}-2`, attributes: {} };
    }),
    update: vi.fn(
      async (id: string, pid: string, _type: string, props: Record<string, unknown>) => {
        calls.push(`update:${id}`);
        sent[id] = props;
        return { physicalId: pid, attributes: {} };
      }
    ),
    delete: vi.fn(async (id: string) => {
      calls.push(`delete:${id}`);
    }),
    getAttribute: vi.fn(),
    readCurrentState: vi.fn().mockResolvedValue(opts.readBack),
  };
  const saveState = vi.fn().mockResolvedValue('etag');
  const exportIndex =
    opts.exportIndex === undefined
      ? undefined
      : {
          lookup: vi.fn(async (name: string) =>
            Object.hasOwn(opts.exportIndex!, name) ? opts.exportIndex![name] : undefined
          ),
          patchEntry: vi.fn().mockResolvedValue(undefined),
          prefetch: vi.fn(),
          updateForStack: vi.fn().mockResolvedValue(undefined),
        };
  const engine = new DeployEngine(
    {
      getState: vi.fn(async (name: string) => {
        // A producer read `Fn::GetStackOutput` makes itself (every read on
        // main) is tagged, so a case can assert this PR adds none beside it.
        stateReads.push(
          name !== stackName && new Error().stack?.includes('getSameAccountStackState') === true
            ? `${name}:get-stack-output`
            : name
        );
        if (name === stackName) return { state: opts.state, etag: 'e0' };
        const producer = opts.producers?.[name];
        return producer === undefined ? null : { state: producer, etag: 'p0' };
      }),
      listStacks: vi.fn(async () =>
        Object.keys(opts.producers ?? {}).map((n) => ({ stackName: n, region: 'us-east-1' }))
      ),
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
      getExecutionLevels: vi.fn().mockReturnValue(opts.levels),
      getDirectDependencies: vi.fn((_g: unknown, id: string) =>
        opts.levels.findIndex((l) => l.includes(id)) > 0 ? opts.levels[0]! : []
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
    { dryRun: false, forceStatefulRecreation: true, ...opts.options },
    'us-east-1',
    exportIndex as never
  );
  let thrown: unknown;
  await engine.deploy(stackName, opts.template).catch((e: unknown) => {
    thrown = e;
  });
  const saved = saveState.mock.calls
    .flat()
    .filter(
      (arg): arg is StackState =>
        typeof arg === 'object' && arg !== null && 'resources' in (arg as object)
    );
  return { last: saved[saved.length - 1], calls, sent, thrown, stateReads };
}

/** A queue named from the secret, and an SSM reader of its `Arn` that spells the secret too. */
function queueAndReader(args: {
  queue: { physicalId: string; provenance?: Record<string, ReferenceProvenance> };
  reader: { provenance?: Record<string, ReferenceProvenance>; spellsSecret?: boolean };
  esmReader?: boolean;
}): { state: StackState; template: CloudFormationTemplate } {
  const spells = args.reader.spellsSecret !== false;
  const state = {
    version: 12,
    stackName: 's',
    region: 'us-east-1',
    resources: {
      SecretQueue: {
        physicalId: args.queue.physicalId,
        resourceType: 'AWS::SQS::Queue',
        properties: { QueueName: REF, VisibilityTimeout: 60 },
        attributes: { Arn: RECORDED_ARN, QueueUrl: args.queue.physicalId },
        dependencies: [],
        ...(args.queue.provenance && { referenceProvenance: args.queue.provenance }),
      },
      Reader: args.esmReader
        ? {
            physicalId: 'esm-1',
            resourceType: 'AWS::Lambda::EventSourceMapping',
            properties: {
              EventSourceArn: RECORDED_ARN,
              FunctionName: 'f',
              Tags: [{ Key: 'n', Value: REF }],
            },
            attributes: {},
            dependencies: ['SecretQueue'],
            ...(args.reader.provenance && { referenceProvenance: args.reader.provenance }),
          }
        : {
            physicalId: '/p/reader',
            resourceType: 'AWS::SSM::Parameter',
            properties: {
              Name: '/p/reader',
              Type: 'String',
              Value: RECORDED_ARN,
              ...(spells && { Tags: { Name: REF } }),
            },
            attributes: {},
            dependencies: ['SecretQueue'],
            ...(args.reader.provenance && { referenceProvenance: args.reader.provenance }),
          },
    },
    outputs: {},
    lastModified: 0,
  } as StackState;
  const template: CloudFormationTemplate = {
    Resources: {
      SecretQueue: {
        Type: 'AWS::SQS::Queue',
        Properties: { QueueName: REF, VisibilityTimeout: 60 },
      },
      Reader: args.esmReader
        ? {
            Type: 'AWS::Lambda::EventSourceMapping',
            Properties: {
              EventSourceArn: { 'Fn::GetAtt': ['SecretQueue', 'Arn'] },
              FunctionName: 'f',
              Tags: [{ Key: 'n', Value: REF }],
            },
          }
        : {
            Type: 'AWS::SSM::Parameter',
            Properties: {
              Name: '/p/reader',
              Type: 'String',
              Value: { 'Fn::GetAtt': ['SecretQueue', 'Arn'] },
              ...(spells && { Tags: { Name: REF } }),
            },
          },
    },
  };
  return { state, template };
}

const LEVELS = [['SecretQueue'], ['Reader']];

describe('an interrupted earlier deploy (the queue was replaced, its reader not)', () => {
  it('promotes the reader from its record and sends it the queue AWS has', async () => {
    rotate();
    // The earlier run replaced the queue under the rotated name (V2) and
    // failed before the reader's update: the reader still records V1.
    const { state, template } = queueAndReader({
      queue: { physicalId: URL_2, provenance: { [REF]: at([V2]) } },
      reader: { provenance: { [REF]: at([V1], [V1]) } },
    });
    const run = await deploy({ state, template, levels: LEVELS });
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toEqual(['update:Reader']);
    expect(run.sent['Reader']?.['Value']).toBe(PLAIN_ARN_2);
    // Persisted in reference form, its read route now at the queue's version.
    expect(run.last?.resources['Reader']?.properties['Value']).toBe(RECORDED_ARN);
    expect(run.last?.resources['Reader']?.referenceProvenance).toEqual({
      [REF]: at([V2], [V2]),
    });
    // Decision 5: the deploy names why it sent the reader, never a token.
    const line = log.info.find((m) => m.includes('Reader is sent'));
    expect(line).toBeDefined();
    expect(line).not.toContain('{{resolve:');
    expect(line).not.toContain(V2);
    expect(JSON.stringify(run.last?.resources['Reader'])).not.toContain('sdin-q-2');
  });

  it('a reader whose read leaf is CREATE-ONLY is replaced, not updated in place', async () => {
    rotate();
    const { state, template } = queueAndReader({
      queue: { physicalId: URL_2, provenance: { [REF]: at([V2]) } },
      reader: { provenance: { [REF]: at([V1], [V1]) } },
      esmReader: true,
    });
    const run = await deploy({ state, template, levels: LEVELS });
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toContain('create:Reader');
    expect(run.calls).not.toContain('update:Reader');
    // The replacement is created with the queue AWS has, not the deleted one.
    expect(run.sent['Reader']?.['EventSourceArn']).toBe(PLAIN_ARN_2);
  });

  it('with no provenance field the reader is left as v11 left it (no promotion)', async () => {
    rotate();
    const { state, template } = queueAndReader({
      queue: { physicalId: URL_2 },
      reader: {},
    });
    const run = await deploy({ state, template, levels: LEVELS });
    expect(run.thrown).toBeUndefined();
    expect(run.calls).not.toContain('update:Reader');
  });

  it('S2: an upstream that records no version gives no verdict', async () => {
    rotate();
    const { state, template } = queueAndReader({
      queue: { physicalId: URL_2, provenance: { [REF]: { region: 'us-east-1' } } },
      reader: { provenance: { [REF]: at([V1], [V1]) } },
    });
    const run = await deploy({ state, template, levels: LEVELS });
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toEqual([]);
  });
});

describe('a version move whose value did not move (another key of a JSON secret)', () => {
  /** An SSM producer of the secret's `queue` key, read into a reader's create-only Name. */
  const shape = (producerVersions: string[], region = 'us-east-1', deletionPolicy?: 'Retain') => {
    const state = {
      version: 12,
      stackName: 's',
      region: 'us-east-1',
      resources: {
        Producer: {
          physicalId: '/p/producer',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Name: '/p/producer', Type: 'String', Value: REF, Description: 'b' },
          attributes: { Value: REF },
          dependencies: [],
          referenceProvenance: { [REF]: { region, versions: producerVersions } },
        },
        Reader: {
          physicalId: REF,
          resourceType: 'AWS::SSM::Parameter',
          properties: { Name: REF, Type: 'String', Value: 'x' },
          attributes: {},
          dependencies: ['Producer'],
          referenceProvenance: { [REF]: { region, versions: [V1], readVersions: [V1] } },
        },
      },
      outputs: {},
      lastModified: 0,
    } as StackState;
    const template: CloudFormationTemplate = {
      Resources: {
        Producer: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Name: '/p/producer', Type: 'String', Value: REF, Description: 'b' },
        },
        Reader: {
          ...(deletionPolicy !== undefined && { DeletionPolicy: deletionPolicy }),
          Type: 'AWS::SSM::Parameter',
          Properties: {
            Name: { 'Fn::GetAtt': ['Producer', 'Value'] },
            Type: 'String',
            Value: 'x',
          },
        },
      },
    };
    return { state, template };
  };
  const LV = [['Producer'], ['Reader']];

  it('is neither replaced nor updated, and records the served version so it is not promoted again', async () => {
    // V2 changed ANOTHER key: the `queue` key still reads `sdin-q-1`. The
    // producer was updated in place at V2 by an earlier run.
    secret.version = V2;
    secret.history[V2] = 'sdin-q-1';
    const { state, template } = shape([V2]);
    const run = await deploy({ state, template, levels: LV });
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toEqual([]);
    expect(log.info.some((m) => m.includes('is sent'))).toBe(false);
    const refreshed = run.last?.resources['Reader']?.referenceProvenance?.[REF];
    expect(refreshed?.readVersions).toEqual([V2]);
    // The next deploy promotes nothing and reads no old version.
    secret.lookups = [];
    const again = await deploy({ state: run.last!, template, levels: LV });
    expect(again.calls).toEqual([]);
    expect(secret.lookups).not.toContain(`sdin@${V1}`);
  });

  it('a recorded version that cannot be read counts as moved (no skip, no refresh)', async () => {
    secret.version = V2;
    secret.history = { [V2]: 'sdin-q-1' };
    const { state, template } = shape([V2]);
    const run = await deploy({ state, template, levels: LV });
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toContain('create:Reader');
    expect(run.last?.resources['Reader']?.referenceProvenance?.[REF]?.readVersions).not.toEqual([
      V1,
    ]);
  });

  it('compares in the region the record names', async () => {
    secret.version = V2;
    secret.history[V2] = 'sdin-q-1';
    const { state, template } = shape([V2], 'us-west-2');
    const run = await deploy({ state, template, levels: LV });
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toEqual([]);
    const atV1 = secret.lookups.indexOf(`sdin@${V1}`);
    expect(atV1).toBeGreaterThanOrEqual(0);
    expect(secret.regions[atV1]).toBe('us-west-2');
  });

  it('an attribute-only change keeps the refresh', async () => {
    secret.version = V2;
    secret.history[V2] = 'sdin-q-1';
    const { state, template } = shape([V2], 'us-east-1', 'Retain');
    const run = await deploy({ state, template, levels: LV });
    expect(run.thrown).toBeUndefined();
    expect(run.last?.resources['Reader']?.deletionPolicy).toBe('Retain');
    expect(run.last?.resources['Reader']?.referenceProvenance?.[REF]?.readVersions).toEqual([V2]);
  });

  it('a reader also holding a NoEcho value AWS holds refreshes too (the second skip)', async () => {
    secret.version = V2;
    secret.history[V2] = 'sdin-q-1';
    const { state, template } = shape([V2]);
    template.Parameters = { Pw: { Type: 'String', NoEcho: true } };
    (template.Resources['Reader']!.Properties as Record<string, unknown>)['Value'] = { Ref: 'Pw' };
    state.resources['Reader']!.properties['Value'] = '***';
    state.resources['Reader']!.noEchoLeaves = [['Value']];
    const run = await deploy({
      state,
      template,
      levels: LV,
      options: { parameters: { Pw: 'pw-value-123' } },
      readBack: { Name: 'sdin-q-1', Type: 'String', Value: 'pw-value-123' },
    });
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toEqual([]);
    expect(run.last?.resources['Reader']?.referenceProvenance?.[REF]?.readVersions).toEqual([V2]);
  });

  it('ten cycles of other-key rotation + producer edit never leave a standing promotion', async () => {
    const v = (i: number): string => `${String(i).padStart(2, '0')}b2c3d4-0000-1111-2222-333333333333`;
    let { state } = shape([V1]);
    const { template } = shape([V1]);
    for (let i = 1; i <= 10; i++) {
      // Another key rotated (the `queue` key still reads sdin-q-1), and an
      // earlier run updated the producer in place at that version.
      secret.version = v(i);
      secret.history[v(i)] = 'sdin-q-1';
      state = JSON.parse(JSON.stringify(state)) as StackState;
      state.resources['Producer']!.referenceProvenance = { [REF]: at([v(i)]) };
      const run = await deploy({ state, template, levels: LV });
      expect(run.thrown).toBeUndefined();
      expect(run.calls).toEqual([]);
      state = run.last!;
      expect(state.resources['Reader']?.referenceProvenance?.[REF]?.readVersions).toEqual([v(i)]);
    }
    // Settled: the next deploy promotes nothing, so it reads no older version.
    secret.lookups = [];
    const settled = await deploy({ state, template, levels: LV });
    expect(settled.calls).toEqual([]);
    expect(secret.lookups.filter((l) => !l.endsWith('@AWSCURRENT') && !l.endsWith('@'))).toEqual([]);
    expect(state.resources['Reader']?.referenceProvenance?.[REF]?.versions?.length).toBeLessThanOrEqual(2);
  });

  it('control: the value moved too, so the create-only reader is replaced with it', async () => {
    rotate();
    const { state, template } = shape([V2]);
    const run = await deploy({ state, template, levels: LV });
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toContain('create:Reader');
    expect(run.sent['Reader']?.['Name']).toBe('sdin-q-2');
  });
});

describe('what never sends (CloudFormation parity)', () => {
  it('a rotation alone: the queue still records V1, the reader is not promoted', async () => {
    const { state, template } = queueAndReader({
      queue: { physicalId: URL_1, provenance: { [REF]: at([V1]) } },
      reader: { provenance: { [REF]: at([V1], [V1]) } },
    });
    rotate();
    const run = await deploy({ state, template, levels: LEVELS });
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toEqual([]);
    // The same lookups as a reader with no read versions: the arm costs none.
    const withField = [...secret.lookups];
    secret.lookups = [];
    const control = queueAndReader({
      queue: { physicalId: URL_1, provenance: { [REF]: at([V1]) } },
      reader: { provenance: { [REF]: at([V1]) } },
    });
    const controlRun = await deploy({ ...control, levels: LEVELS });
    expect(controlRun.calls).toEqual([]);
    expect(withField).toEqual(secret.lookups);
  });

  it('a literal-only token: a reader that only spells the secret is not promoted', async () => {
    const state = {
      version: 12,
      stackName: 's',
      region: 'us-east-1',
      resources: {
        Spelled: {
          physicalId: '/p/spelled',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Name: '/p/spelled', Type: 'String', Value: REF },
          attributes: {},
          dependencies: [],
          referenceProvenance: { [REF]: at([V1]) },
        },
      },
      outputs: {},
      lastModified: 0,
    } as StackState;
    rotate();
    const run = await deploy({
      state,
      template: {
        Resources: {
          Spelled: {
            Type: 'AWS::SSM::Parameter',
            Properties: { Name: '/p/spelled', Type: 'String', Value: REF },
          },
        },
      },
      levels: [['Spelled']],
    });
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toEqual([]);
  });
});

describe('a producer updated in place in an earlier run (an SSM Value)', () => {
  it('sends its reader the value the producer holds now', async () => {
    rotate();
    const state = {
      version: 12,
      stackName: 's',
      region: 'us-east-1',
      resources: {
        Producer: {
          physicalId: '/p/producer',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Name: '/p/producer', Type: 'String', Value: REF, Description: 'b' },
          attributes: { Value: REF },
          dependencies: [],
          // Updated in place at V2 by an earlier run (its Description edit).
          referenceProvenance: { [REF]: at([V2]) },
        },
        Reader: {
          physicalId: '/p/reader',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Name: '/p/reader', Type: 'String', Value: REF, Description: REF },
          attributes: {},
          dependencies: ['Producer'],
          referenceProvenance: { [REF]: at([V1], [V1]) },
        },
      },
      outputs: {},
      lastModified: 0,
    } as StackState;
    const run = await deploy({
      state,
      template: {
        Resources: {
          Producer: {
            Type: 'AWS::SSM::Parameter',
            Properties: { Name: '/p/producer', Type: 'String', Value: REF, Description: 'b' },
          },
          Reader: {
            Type: 'AWS::SSM::Parameter',
            Properties: {
              Name: '/p/reader',
              Type: 'String',
              Value: { 'Fn::GetAtt': ['Producer', 'Value'] },
              Description: REF,
            },
          },
        },
      },
      levels: [['Producer'], ['Reader']],
    });
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toEqual(['update:Reader']);
    expect(run.sent['Reader']?.['Value']).toBe('sdin-q-2');
  });
});

describe('a cross-stack consumer (Fn::ImportValue)', () => {
  /** A producer stack exporting its queue's ARN, at `versions`. */
  const producer = (physicalId: string, versions: string[]): StackState =>
    ({
      version: 12,
      stackName: 'p',
      region: 'us-east-1',
      resources: {
        SecretQueue: {
          physicalId,
          resourceType: 'AWS::SQS::Queue',
          properties: { QueueName: REF },
          attributes: { Arn: RECORDED_ARN },
          dependencies: [],
          referenceProvenance: { [REF]: at(versions) },
        },
      },
      outputs: { QueueArn: RECORDED_ARN, 'p-queue-arn': RECORDED_ARN },
      exportNames: ['p-queue-arn'],
      outputReferenceProvenance: {
        QueueArn: { [REF]: at(versions, versions) },
        'p-queue-arn': { [REF]: at(versions, versions) },
      },
      lastModified: 0,
    }) as StackState;
  const consumer = (
    read: string[] | undefined,
    description = 'a'
  ): { state: StackState; template: CloudFormationTemplate } => ({
    state: {
      version: 12,
      stackName: 'c',
      region: 'us-east-1',
      resources: {
        Reader: {
          physicalId: '/c/reader',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Name: '/c/reader', Type: 'String', Value: RECORDED_ARN, Description: 'a' },
          attributes: {},
          dependencies: [],
          ...(read !== undefined && { referenceProvenance: { [REF]: at(read, read) } }),
        },
      },
      outputs: {},
      imports: [{ sourceStack: 'p', sourceRegion: 'us-east-1', exportName: 'p-queue-arn' }],
      lastModified: 0,
    } as StackState,
    template: {
      Resources: {
        Reader: {
          Type: 'AWS::SSM::Parameter',
          Properties: {
            Name: '/c/reader',
            Type: 'String',
            Value: { 'Fn::ImportValue': 'p-queue-arn' },
            Description: description,
          },
        },
      },
    },
  });
  const exportIndex = {
    'p-queue-arn': { value: RECORDED_ARN, producerStack: 'p', producerRegion: 'us-east-1' },
  };

  it('is promoted after the producer replaced its queue, and sent the new one', async () => {
    rotate();
    const { state, template } = consumer([V1]);
    const run = await deploy({
      stackName: 'c',
      state,
      template,
      levels: [['Reader']],
      producers: { p: producer(URL_2, [V2]) },
      exportIndex,
    });
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toEqual(['update:Reader']);
    expect(run.sent['Reader']?.['Value']).toBe(PLAIN_ARN_2);
    expect(run.last?.resources['Reader']?.referenceProvenance).toEqual({ [REF]: at([V2], [V2]) });
    // The producer's state is read ONCE: the diff's gated read, reused by the
    // consumer's provisioning.
    expect(run.stateReads.filter((n) => n === 'p')).toEqual(['p']);
  });

  it('control: a rotation without a replacement promotes nothing and sends nothing', async () => {
    const { state, template } = consumer([V1]);
    rotate();
    const run = await deploy({
      stackName: 'c',
      state,
      template,
      levels: [['Reader']],
      producers: { p: producer(URL_1, [V1]) },
      exportIndex,
    });
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toEqual([]);
  });

  it('a consumer with no read versions never reads the producer state (the gate)', async () => {
    const { state, template } = consumer(undefined);
    const run = await deploy({
      stackName: 'c',
      state,
      template,
      levels: [['Reader']],
      producers: { p: producer(URL_1, [V1]) },
      exportIndex,
    });
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toEqual([]);
    expect(run.stateReads.filter((n) => n === 'p')).toEqual([]);
  });

  it('a reader with read versions whose cross-stack read carries no token reads no producer state', async () => {
    const { state, template } = queueAndReader({
      queue: { physicalId: URL_1, provenance: { [REF]: at([V1]) } },
      reader: { provenance: { [REF]: at([V1], [V1]) } },
    });
    // Its Description imports a plain export (a VPC id), beside the queue read.
    state.resources['Reader']!.properties['Description'] = 'vpc-123';
    (template.Resources['Reader']!.Properties as Record<string, unknown>)['Description'] = {
      'Fn::ImportValue': 'p-vpc',
    };
    const run = await deploy({
      state,
      template,
      levels: LEVELS,
      producers: { p: producer(URL_1, [V1]) },
      exportIndex: { 'p-vpc': { value: 'vpc-123', producerStack: 'p', producerRegion: 'us-east-1' } },
    });
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toEqual([]);
    expect(run.stateReads.filter((n) => n === 'p')).toEqual([]);
  });

  it('consumer pinning: an edited consumer after a rotation is sent the producer version', async () => {
    const { state, template } = consumer([V1], 'b');
    rotate();
    const run = await deploy({
      stackName: 'c',
      state,
      template,
      levels: [['Reader']],
      producers: { p: producer(URL_1, [V1]) },
      exportIndex,
    });
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toEqual(['update:Reader']);
    // The queue AWS has (V1's name), not the current version's.
    expect(run.sent['Reader']?.['Value']).toBe(PLAIN_ARN_1);
    expect(secret.lookups).toContain(`sdin@${V1}`);
  });
});

describe('a cross-stack consumer (Fn::GetStackOutput)', () => {
  const producer = (physicalId: string, versions: string[]): StackState =>
    ({
      version: 12,
      stackName: 'p',
      region: 'us-east-1',
      resources: {
        SecretQueue: {
          physicalId,
          resourceType: 'AWS::SQS::Queue',
          properties: { QueueName: REF },
          attributes: { Arn: RECORDED_ARN },
          dependencies: [],
          referenceProvenance: { [REF]: at(versions) },
        },
      },
      outputs: { QueueArn: RECORDED_ARN },
      outputReferenceProvenance: { QueueArn: { [REF]: at(versions, versions) } },
      lastModified: 0,
    }) as StackState;
  const consumer = (description: string): { state: StackState; template: CloudFormationTemplate } => ({
    state: {
      version: 12,
      stackName: 'c',
      region: 'us-east-1',
      resources: {
        Reader: {
          physicalId: '/c/reader',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Name: '/c/reader', Type: 'String', Value: RECORDED_ARN, Description: 'a' },
          attributes: {},
          dependencies: [],
          referenceProvenance: { [REF]: at([V1], [V1]) },
        },
      },
      outputs: {},
      lastModified: 0,
    } as StackState,
    template: {
      Resources: {
        Reader: {
          Type: 'AWS::SSM::Parameter',
          Properties: {
            Name: '/c/reader',
            Type: 'String',
            Value: {
              'Fn::GetStackOutput': { StackName: 'p', OutputName: 'QueueArn', Region: 'us-east-1' },
            },
            Description: description,
          },
        },
      },
    },
  });

  it('is promoted and sent the new queue, reading the producer state no more than before', async () => {
    rotate();
    const { state, template } = consumer('a');
    const run = await deploy({
      stackName: 'c',
      state,
      template,
      levels: [['Reader']],
      producers: { p: producer(URL_2, [V2]) },
    });
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toEqual(['update:Reader']);
    expect(run.sent['Reader']?.['Value']).toBe(PLAIN_ARN_2);
    // The promotion and the pin reuse the state each `Fn::GetStackOutput` read
    // already holds: no producer read but the resolver's own.
    expect(run.stateReads.filter((n) => n.startsWith('p:'))).not.toEqual([]);
    expect(run.stateReads.filter((n) => n === 'p')).toEqual([]);
  });
});

describe('a nested child engine (its upstream is the inherited snapshot)', () => {
  const childState = (read: string[]): StackState =>
    ({
      version: 12,
      stackName: 'parent~Child',
      region: 'us-east-1',
      resources: {
        Reader: {
          physicalId: '/n/reader',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Name: '/n/reader', Type: 'String', Value: RECORDED_ARN, Description: REF },
          attributes: {},
          dependencies: [],
          referenceProvenance: { [REF]: at(read, read) },
        },
      },
      outputs: {},
      lastModified: 0,
    }) as StackState;
  const childTemplate: CloudFormationTemplate = {
    Parameters: { QueueArn: { Type: 'String' } },
    Resources: {
      Reader: {
        Type: 'AWS::SSM::Parameter',
        Properties: {
          Name: '/n/reader',
          Type: 'String',
          Value: { Ref: 'QueueArn' },
          Description: REF,
        },
      },
    },
  };

  it('a child reader whose diff binds the redacted parameter is promoted and sent', async () => {
    rotate();
    const run = await deploy({
      stackName: 'parent~Child',
      state: childState([V1]),
      template: childTemplate,
      levels: [['Reader']],
      options: {
        parameters: { QueueArn: PLAIN_ARN_2 },
        inheritedSecrets: new Map([['sdin-q-2', REF]]),
        inheritedReferenceProvenance: new Map([[REF, at([V2], [V2])]]),
      },
    });
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toEqual(['update:Reader']);
    expect(run.sent['Reader']?.['Value']).toBe(PLAIN_ARN_2);
  });

  it('control: a snapshot at the version the child recorded sends nothing', async () => {
    const run = await deploy({
      stackName: 'parent~Child',
      state: childState([V1]),
      template: childTemplate,
      levels: [['Reader']],
      options: {
        parameters: { QueueArn: PLAIN_ARN_1 },
        inheritedSecrets: new Map([['sdin-q-1', REF]]),
        inheritedReferenceProvenance: new Map([[REF, at([V1], [V1])]]),
      },
    });
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toEqual([]);
  });
});

describe('the read-route source (design §2.2)', () => {
  it('a pin that cannot be read records the producer version, not the one served', async () => {
    // The queue records V1, but V1 can no longer be read (deprecated); a
    // JSON-keyed secret changed ANOTHER key, so the current V2 still holds the
    // queue's name and today's physical-id proof serves it.
    secret.version = V2;
    secret.history = {};
    const { state, template } = queueAndReader({
      queue: { physicalId: URL_1, provenance: { [REF]: at([V1]) } },
      reader: { provenance: { [REF]: at([V1], [V1]) }, spellsSecret: false },
    });
    // An edit, so the reader is written.
    (template.Resources['Reader']!.Properties as Record<string, unknown>)['Description'] = 'b';
    const run = await deploy({ state, template, levels: LEVELS });
    expect(run.thrown).toBeUndefined();
    expect(run.sent['Reader']?.['Value']).toBe(PLAIN_ARN_1);
    // Not V2: a reader recording V2 against a queue that records V1 would be
    // promoted on every later deploy.
    const entry = run.last?.resources['Reader']?.referenceProvenance?.[REF];
    expect(entry?.readVersions).toEqual([V1]);
  });

  it('an upstream holding two generations (no pin, no region) passes both to the read route', async () => {
    // A create-only token on a queue updated in place after a rotation holds
    // two generations; today's proof serves the current value (V2 still names
    // the queue: another JSON key changed).
    secret.version = V2;
    secret.history[V2] = 'sdin-q-1';
    const { state, template } = queueAndReader({
      queue: { physicalId: URL_1, provenance: { [REF]: { versions: [V1, V2] } } },
      reader: { provenance: { [REF]: at([V1], [V1]) }, spellsSecret: false },
    });
    (template.Resources['Reader']!.Properties as Record<string, unknown>)['Description'] = 'b';
    const run = await deploy({ state, template, levels: LEVELS });
    expect(run.thrown).toBeUndefined();
    expect(run.sent['Reader']?.['Value']).toBe(PLAIN_ARN_1);
    const entry = run.last?.resources['Reader']?.referenceProvenance?.[REF];
    expect(entry?.readVersions).toEqual([V1, V2]);
  });
});
