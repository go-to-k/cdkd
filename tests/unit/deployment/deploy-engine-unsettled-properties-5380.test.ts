/**
 * go-to-k/cdkd#5380, through the real `DeployEngine` / `DiffCalculator`: a
 * provider's `update()` declares `UpdateContext.markUnsettled(key)` before an
 * irreversible call. When the update then fails, the failure save records the
 * key as `ResourceState.unsettledProperties` (names only; `properties` keeps
 * the recorded value). The next deploy treats the key as changed even when the
 * template and the record agree, hands it to the provider as
 * `UpdateContext.unsettledProperties`, and a successful update clears it.
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
vi.mock('../../../src/utils/aws-clients.js', () => {
  const clients = (region: string): Record<string, unknown> => ({
    sts: { send: async () => ({ Account: '123456789012' }) },
    credentialConfig: {},
    config: { region: () => Promise.resolve(region) },
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
vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { InterruptedWaitError } from '../../../src/provisioning/interrupt-watch.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';
import { markNonRetryable } from '../../../src/deployment/retryable-errors.js';
import type { CloudFormationTemplate, UpdateContext } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';

const TYPE = 'AWS::KinesisFirehose::DeliveryStream';
const ENC = 'DeliveryStreamEncryptionConfigurationInput';

type UpdateFn = (
  id: string,
  pid: string,
  props: Record<string, unknown>,
  prev: Record<string, unknown>,
  context: UpdateContext | undefined
) => Promise<Record<string, unknown>>;

interface Run {
  thrown: unknown;
  /** Every `update()` call's context. */
  contexts: Array<UpdateContext | undefined>;
  /** The last state document saved. */
  saved: StackState | undefined;
  /** Every state document saved, in order. */
  saves: StackState[];
  created: string[];
}

async function deploy(opts: {
  state: StackState;
  template: CloudFormationTemplate;
  update: UpdateFn;
  options?: Record<string, unknown>;
  levels?: string[][];
}): Promise<Run> {
  const levels = opts.levels ?? [['S']];
  const contexts: Array<UpdateContext | undefined> = [];
  const created: string[] = [];
  const saves: StackState[] = [];
  const provider = {
    create: vi.fn(async (id: string) => {
      created.push(id);
      return { physicalId: 'new-stream', attributes: {} };
    }),
    update: vi.fn(
      async (
        id: string,
        pid: string,
        _type: string,
        props: Record<string, unknown>,
        prev: Record<string, unknown>,
        context?: UpdateContext
      ) => {
        contexts.push(context);
        return opts.update(id, pid, props, prev, context);
      }
    ),
    delete: vi.fn(),
    getAttribute: vi.fn(),
  };
  const engine = new DeployEngine(
    {
      getState: vi.fn(async () => ({ state: opts.state, etag: 'e0' })),
      saveState: vi.fn(async (_s: string, _r: string, state: StackState) => {
        saves.push(JSON.parse(JSON.stringify(state)) as StackState);
        return 'etag';
      }),
      getStateIfExists: vi.fn(async () => ({ state: opts.state, etag: 'e0' })),
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
      getExecutionLevels: vi.fn().mockReturnValue(levels),
      getDirectDependencies: vi.fn(() => []),
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
    'us-east-1'
  );
  let thrown: unknown;
  await engine.deploy('s', opts.template).catch((e: unknown) => {
    thrown = e;
  });
  return { thrown, contexts, saved: saves.at(-1), saves, created };
}

function streamRecord(name: string, record: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: name,
    resourceType: TYPE,
    properties: { DeliveryStreamName: name },
    attributes: {},
    dependencies: [],
    ...record,
  } as ResourceState;
}

function stateOf(record: Partial<ResourceState> = {}, others: Record<string, ResourceState> = {}): StackState {
  return {
    version: 13,
    stackName: 's',
    region: 'us-east-1',
    resources: { S: streamRecord('stream', record), ...others },
    outputs: {},
    lastModified: 0,
  } as StackState;
}

const templateOf = (
  properties: Record<string, unknown>,
  others: Record<string, Record<string, unknown>> = {}
): CloudFormationTemplate =>
  ({
    Resources: {
      S: { Type: TYPE, Properties: properties },
      ...Object.fromEntries(
        Object.entries(others).map(([id, props]) => [id, { Type: TYPE, Properties: props }])
      ),
    },
  }) as CloudFormationTemplate;

const encrypted = { DeliveryStreamName: 'stream', [ENC]: { KeyType: 'AWS_OWNED_CMK' } };
const plain = { DeliveryStreamName: 'stream' };

/** A non-retryable failure, so the engine's retry backoff does not run. */
const failure = (message: string): Error => markNonRetryable(new Error(message));

describe('a failed update records what it left unsettled (go-to-k/cdkd#5380)', () => {
  it('records the marked key on the record; the properties keep the recorded value', async () => {
    const run = await deploy({
      state: stateOf(),
      template: templateOf(encrypted),
      update: async (_id, _pid, _props, _prev, context) => {
        context?.markUnsettled?.(ENC);
        throw failure('ENABLING_FAILED');
      },
      options: { noRollback: true },
    });
    expect(run.thrown).toBeDefined();
    const record = run.saved?.resources['S'];
    expect(record?.unsettledProperties).toEqual([ENC]);
    expect(record?.properties).toEqual(plain);
    expect(run.saved?.version).toBe(14);
  });

  it('records nothing for a failed update that marked nothing', async () => {
    const run = await deploy({
      state: stateOf(),
      template: templateOf(encrypted),
      update: async () => {
        throw failure('refused before sending');
      },
      options: { noRollback: true },
    });
    expect(run.thrown).toBeDefined();
    expect(run.saves.length).toBeGreaterThan(0);
    for (const save of run.saves) expect(save.resources['S']).not.toHaveProperty('unsettledProperties');
  });

  it('records it under the automatic rollback too (the failed op is not reverted)', async () => {
    const run = await deploy({
      state: stateOf(),
      template: templateOf(encrypted),
      update: async (_id, _pid, _props, _prev, context) => {
        context?.markUnsettled?.(ENC);
        throw failure('DISABLING_FAILED');
      },
    });
    expect(run.thrown).toBeDefined();
    expect(run.saved?.resources['S']?.unsettledProperties).toEqual([ENC]);
  });

  it('records it on Ctrl-C during the wait after the call', async () => {
    const run = await deploy({
      state: stateOf(),
      template: templateOf(encrypted),
      update: async (_id, _pid, _props, _prev, context) => {
        context?.markUnsettled?.(ENC);
        throw new InterruptedWaitError('waiting to enable');
      },
    });
    expect(run.thrown).toBeDefined();
    expect(run.saved?.resources['S']?.unsettledProperties).toEqual([ENC]);
  });

  it('records it when the per-resource deadline abandons the call', async () => {
    let release!: () => void;
    const run = await deploy({
      state: stateOf(),
      template: templateOf(encrypted),
      update: async (_id, _pid, _props, _prev, context) => {
        context?.markUnsettled?.(ENC);
        // The wait never ends on its own: only the engine's deadline does.
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { physicalId: 'stream', attributes: {} };
      },
      options: { noRollback: true, resourceWarnAfterMs: 20, resourceTimeoutMs: 60 },
    });
    release();
    expect(run.thrown).toBeDefined();
    expect(run.saved?.resources['S']?.unsettledProperties).toEqual([ENC]);
  });

  it("a sibling's per-resource save after the failure already carries the mark", async () => {
    let failed!: () => void;
    const sFailed = new Promise<void>((resolve) => {
      failed = resolve;
    });
    const run = await deploy({
      state: stateOf({}, { T: streamRecord('other') }),
      template: templateOf(encrypted, { T: { DeliveryStreamName: 'other', Note: 'x' } }),
      levels: [['S', 'T']],
      update: async (id, pid, _props, _prev, context) => {
        if (id === 'S') {
          context?.markUnsettled?.(ENC);
          setTimeout(failed, 0);
          throw failure('ENABLING_FAILED');
        }
        await sFailed;
        await new Promise((r) => setTimeout(r, 20));
        return { physicalId: pid, attributes: {} };
      },
      options: { noRollback: true },
    });
    expect(run.thrown).toBeDefined();
    // T's own save: the first one whose T record holds the new property.
    const tSave = run.saves.find((save) => save.resources['T']?.properties['Note'] === 'x');
    expect(tSave).toBeDefined();
    expect(tSave?.resources['S']?.unsettledProperties).toEqual([ENC]);
  });

  it('records a mark the provider made after the deadline had abandoned its call', async () => {
    // T is another type, so only S's type takes the short deadline.
    const QUEUE = 'AWS::SQS::Queue';
    const template = templateOf(encrypted);
    template.Resources['T'] = { Type: QUEUE, Properties: { QueueName: 'q', Note: 'x' } };
    const run = await deploy({
      state: stateOf({}, { T: { ...streamRecord('q'), resourceType: QUEUE, properties: { QueueName: 'q' } } }),
      template,
      levels: [['S', 'T']],
      update: async (id, pid, _props, _prev, context) => {
        if (id === 'S') {
          // Past the 60 ms deadline, while T still holds the deploy open.
          await new Promise((r) => setTimeout(r, 120));
          context?.markUnsettled?.(ENC);
          await new Promise(() => undefined);
        }
        await new Promise((r) => setTimeout(r, 300));
        return { physicalId: pid, attributes: {} };
      },
      options: {
        noRollback: true,
        resourceWarnAfterByType: { [TYPE]: 20 },
        resourceTimeoutByType: { [TYPE]: 60 },
      },
    });
    expect(run.thrown).toBeDefined();
    expect(run.saved?.resources['S']?.unsettledProperties).toEqual([ENC]);
  });

  it('unions with what an earlier failure left unsettled', async () => {
    const run = await deploy({
      state: stateOf({ unsettledProperties: ['Tags'] }),
      template: templateOf(encrypted),
      update: async (_id, _pid, _props, _prev, context) => {
        context?.markUnsettled?.(ENC);
        throw failure('ENABLING_FAILED');
      },
      options: { noRollback: true },
    });
    expect(run.saved?.resources['S']?.unsettledProperties).toEqual([ENC, 'Tags']);
  });

  it('a mark followed by a successful update records nothing', async () => {
    const run = await deploy({
      state: stateOf(),
      template: templateOf(encrypted),
      update: async (_id, pid, _props, _prev, context) => {
        context?.markUnsettled?.(ENC);
        return { physicalId: pid, attributes: {} };
      },
    });
    expect(run.thrown).toBeUndefined();
    expect(run.saved?.resources['S']).not.toHaveProperty('unsettledProperties');
  });

  it('a mark followed by a successful update stays off the record when ANOTHER row fails', async () => {
    const run = await deploy({
      state: stateOf({}, { T: streamRecord('other') }),
      template: templateOf(encrypted, { T: { DeliveryStreamName: 'other', Note: 'x' } }),
      levels: [['S'], ['T']],
      update: async (id, pid, _props, _prev, context) => {
        if (id === 'S') {
          context?.markUnsettled?.(ENC);
          return { physicalId: pid, attributes: {} };
        }
        throw failure('T failed');
      },
      options: { noRollback: true },
    });
    expect(run.thrown).toBeDefined();
    expect(run.contexts).toHaveLength(2);
    expect(run.saved?.resources['S']).not.toHaveProperty('unsettledProperties');
  });

  it('the replacement fallback\'s discarded mark stays off the record when ANOTHER row fails', async () => {
    const run = await deploy({
      state: stateOf({}, { T: streamRecord('other') }),
      template: templateOf(encrypted, { T: { DeliveryStreamName: 'other', Note: 'x' } }),
      levels: [['S'], ['T']],
      update: async (id, _pid, _props, _prev, context) => {
        if (id === 'S') {
          context?.markUnsettled?.(ENC);
          throw new ResourceUpdateNotSupportedError(TYPE, id);
        }
        throw failure('T failed');
      },
      options: { replace: true, noRollback: true },
    });
    expect(run.thrown).toBeDefined();
    expect(run.created).toEqual(['S']);
    expect(run.saved?.resources['S']?.physicalId).toBe('new-stream');
    expect(run.saved?.resources['S']).not.toHaveProperty('unsettledProperties');
  });

  it('the replacement fallback discards the failed update\'s mark', async () => {
    const run = await deploy({
      state: stateOf(),
      template: templateOf(encrypted),
      update: async (id, _pid, _props, _prev, context) => {
        context?.markUnsettled?.(ENC);
        throw new ResourceUpdateNotSupportedError(TYPE, id);
      },
      options: { replace: true },
    });
    expect(run.thrown).toBeUndefined();
    expect(run.created).toEqual(['S']);
    const record = run.saved?.resources['S'];
    expect(record?.physicalId).toBe('new-stream');
    expect(record).not.toHaveProperty('unsettledProperties');
  });
});

describe('the next deploy converges an unsettled key (go-to-k/cdkd#5380)', () => {
  it('sends the update although the template and the record agree, naming the key', async () => {
    const run = await deploy({
      state: stateOf({ unsettledProperties: [ENC] }),
      template: templateOf(plain),
      update: async (_id, pid) => ({ physicalId: pid, attributes: {} }),
    });
    expect(run.thrown).toBeUndefined();
    expect(run.contexts).toHaveLength(1);
    expect([...(run.contexts[0]?.changedProperties ?? [])]).toContain(ENC);
    expect([...(run.contexts[0]?.unsettledProperties ?? [])]).toEqual([ENC]);
    // The successful update settles it.
    expect(run.saved?.resources['S']).not.toHaveProperty('unsettledProperties');
  });

  it('the same record without the field is skipped, and no context names a key unsettled', async () => {
    const skipped = await deploy({
      state: stateOf(),
      template: templateOf(plain),
      update: async (_id, pid) => ({ physicalId: pid, attributes: {} }),
    });
    expect(skipped.contexts).toHaveLength(0);
    const changed = await deploy({
      state: stateOf(),
      template: templateOf(encrypted),
      update: async (_id, pid) => ({ physicalId: pid, attributes: {} }),
    });
    expect(changed.contexts).toHaveLength(1);
    expect(changed.contexts[0]?.unsettledProperties).toBeUndefined();
  });

  it('a failed convergence keeps the key unsettled', async () => {
    const run = await deploy({
      state: stateOf({ unsettledProperties: [ENC] }),
      template: templateOf(plain),
      update: async () => {
        throw failure('settle wait timed out');
      },
      options: { noRollback: true },
    });
    expect(run.thrown).toBeDefined();
    expect(run.saved?.resources['S']?.unsettledProperties).toEqual([ENC]);
  });
});
