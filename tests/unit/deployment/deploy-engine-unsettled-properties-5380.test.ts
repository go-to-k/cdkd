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
import { RESOURCE_NOT_FOUND, type CloudFormationTemplate, type UpdateContext } from '../../../src/types/resource.js';
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
  /** The replacement fallback's create fails. */
  createFails?: boolean;
  /** Extra provider hooks (`readCurrentState`, `unsettledInTransition`, ...). */
  hooks?: Record<string, unknown>;
}): Promise<Run> {
  const levels = opts.levels ?? [['S']];
  const contexts: Array<UpdateContext | undefined> = [];
  const created: string[] = [];
  const saves: StackState[] = [];
  const provider = {
    create: vi.fn(async (id: string) => {
      created.push(id);
      if (opts.createFails === true) throw failure('replacement create failed');
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
    ...opts.hooks,
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

  it('records it when update() rethrows a provider wait interrupted by the user (InterruptedWaitError)', async () => {
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

  it('records a mark that arrives while the automatic rollback runs, in the post-rollback save', async () => {
    const QUEUE = 'AWS::SQS::Queue';
    const template = templateOf(encrypted);
    template.Resources['T'] = { Type: QUEUE, Properties: { QueueName: 'q', Note: 'x' } };
    let tCalls = 0;
    const run = await deploy({
      state: stateOf({}, { T: { ...streamRecord('q'), resourceType: QUEUE, properties: { QueueName: 'q' } } }),
      template,
      levels: [['S', 'T']],
      update: async (id, pid, _props, _prev, context) => {
        if (id === 'S') {
          // Past S's 60 ms deadline and the outer catch, inside T's revert.
          await new Promise((r) => setTimeout(r, 200));
          context?.markUnsettled?.(ENC);
          await new Promise(() => undefined);
        }
        tCalls++;
        // The deploy's update is quick; the rollback's revert of it is slow.
        if (tCalls > 1) await new Promise((r) => setTimeout(r, 400));
        return { physicalId: pid, attributes: {} };
      },
      options: {
        resourceWarnAfterByType: { [TYPE]: 20 },
        resourceTimeoutByType: { [TYPE]: 60 },
      },
    });
    expect(run.thrown).toBeDefined();
    // Premise: T was reverted, so the rollback ran past the late mark.
    expect(tCalls).toBe(2);
    expect(run.saved?.resources['S']?.unsettledProperties).toEqual([ENC]);
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

  it('a mark from a retried attempt survives the attempt that failed without marking', async () => {
    let attempt = 0;
    const run = await deploy({
      state: stateOf(),
      template: templateOf(encrypted),
      update: async (_id, _pid, _props, _prev, context) => {
        attempt++;
        if (attempt === 1) {
          context?.markUnsettled?.(ENC);
          throw Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
        }
        throw failure('settle wait timed out');
      },
      options: { noRollback: true },
    });
    expect(run.thrown).toBeDefined();
    // Premise: the engine retried.
    expect(attempt).toBe(2);
    expect(run.saved?.resources['S']?.unsettledProperties).toEqual([ENC]);
  }, 20_000);

  it('ignores a mark naming no property this resource sends or holds', async () => {
    const run = await deploy({
      state: stateOf(),
      template: templateOf(encrypted),
      update: async (_id, _pid, _props, _prev, context) => {
        context?.markUnsettled?.('NotAProperty');
        context?.markUnsettled?.(ENC);
        throw failure('ENABLING_FAILED');
      },
      options: { noRollback: true },
    });
    expect(run.saved?.resources['S']?.unsettledProperties).toEqual([ENC]);
  });

  it('accepts a mark for a key only the record holds (a removal); an ignored one leaves the record\'s own names', async () => {
    const removal = await deploy({
      state: stateOf({ properties: encrypted }),
      template: templateOf(plain),
      update: async (_id, _pid, _props, _prev, context) => {
        context?.markUnsettled?.(ENC);
        throw failure('DISABLING_FAILED');
      },
      options: { noRollback: true },
    });
    expect(removal.saved?.resources['S']?.unsettledProperties).toEqual([ENC]);
    const converging = await deploy({
      state: stateOf({ unsettledProperties: ['Gone'] }),
      template: templateOf(plain),
      update: async (_id, _pid, _props, _prev, context) => {
        context?.markUnsettled?.('Gone');
        throw failure('still failing');
      },
      options: { noRollback: true },
    });
    expect(converging.saved?.resources['S']?.unsettledProperties).toEqual(['Gone']);
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

  it('a replacement fallback whose create fails keeps the mark on the old record', async () => {
    const run = await deploy({
      state: stateOf(),
      template: templateOf(encrypted),
      update: async (id, _pid, _props, _prev, context) => {
        context?.markUnsettled?.(ENC);
        throw new ResourceUpdateNotSupportedError(TYPE, id);
      },
      options: { replace: true, noRollback: true },
      createFails: true,
    });
    expect(run.thrown).toBeDefined();
    expect(run.created).toEqual(['S']);
    const record = run.saved?.resources['S'];
    expect(record?.physicalId).toBe('stream');
    expect(record?.unsettledProperties).toEqual([ENC]);
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

describe('the engine converges unsettled names before the removal step (go-to-k/cdkd#5487)', () => {
  /** A fake resource: `update()` makes AWS hold the desired bag. */
  function fakeAws(initial: Record<string, unknown>) {
    const aws = { live: { ...initial } as Record<string, unknown>, reads: 0 };
    return {
      aws,
      hooks: {
        readCurrentState: vi.fn(async () => {
          aws.reads++;
          return { ...aws.live };
        }),
      },
      update: (async (_id, pid, props) => {
        aws.live = { ...props };
        return { physicalId: pid, attributes: {} };
      }) as UpdateFn,
    };
  }

  it('a key absent from the template and the record but live-added is removed, and the name clears', async () => {
    const f = fakeAws({ DeliveryStreamName: 'stream', Extra: 'attempted' });
    let prev: Record<string, unknown> | undefined;
    const run = await deploy({
      state: stateOf({ unsettledProperties: ['Extra'] }),
      template: templateOf(plain),
      hooks: f.hooks,
      update: async (id, pid, props, previous, context) => {
        prev = previous;
        expect([...(context?.removedProperties ?? [])]).toContain('Extra');
        return f.update(id, pid, props, previous, context);
      },
    });
    expect(run.thrown).toBeUndefined();
    expect(prev?.['Extra']).toBe('attempted');
    expect(run.saved?.resources['S']).not.toHaveProperty('unsettledProperties');
  });

  it('a key whose live value equals the template is still handed over with the live previous side', async () => {
    const f = fakeAws({ DeliveryStreamName: 'stream', Extra: 'v' });
    let prev: Record<string, unknown> | undefined;
    await deploy({
      state: stateOf({ properties: { DeliveryStreamName: 'stream', Extra: 'old' }, unsettledProperties: ['Extra'] }),
      template: templateOf({ DeliveryStreamName: 'stream', Extra: 'v' }),
      hooks: f.hooks,
      update: async (id, pid, props, previous, context) => {
        prev = previous;
        return f.update(id, pid, props, previous, context);
      },
    });
    // Equal sides: a provider's own comparison sends nothing (a same-value call AWS refuses).
    expect(prev?.['Extra']).toBe('v');
  });

  it('a refusal names drift --accept as the escape hatch when the provider can be drifted', async () => {
    const f = fakeAws({ DeliveryStreamName: 'stream' });
    const run = await deploy({
      state: stateOf({ unsettledProperties: [ENC] }),
      template: templateOf(plain),
      hooks: { ...f.hooks, unsettledInTransition: async (_p: string, _l: string, _t: string, n: ReadonlySet<string>) => n },
      update: f.update,
      options: { noRollback: true },
    });
    const chain: string[] = [];
    for (let e: unknown = run.thrown; e instanceof Error && chain.length < 8; e = e.cause) chain.push(e.message);
    expect(chain.join('\n')).toContain("run 'cdkd drift --accept' once it has");
  });

  it('a name AWS is still changing refuses the update before any call, and stays unsettled', async () => {
    const f = fakeAws({ DeliveryStreamName: 'stream' });
    const run = await deploy({
      state: stateOf({ unsettledProperties: [ENC] }),
      template: templateOf(plain),
      hooks: { ...f.hooks, unsettledInTransition: async (_p: string, _l: string, _t: string, n: ReadonlySet<string>) => n },
      update: f.update,
      options: { noRollback: true },
    });
    expect(run.thrown).toBeDefined();
    expect(run.contexts).toHaveLength(0);
    expect(run.saved?.resources['S']?.unsettledProperties).toEqual([ENC]);
  });

  it('an unreadable resource refuses the update before any call, and the name stays', async () => {
    const run = await deploy({
      state: stateOf({ unsettledProperties: ['Extra'] }),
      template: templateOf(plain),
      hooks: { readCurrentState: async () => { throw new Error('throttled'); } },
      update: async (_id, pid) => ({ physicalId: pid, attributes: {} }),
      options: { noRollback: true },
    });
    expect(run.thrown).toBeDefined();
    expect(run.contexts).toHaveLength(0);
    expect(run.saved?.resources['S']?.unsettledProperties).toEqual(['Extra']);
  });

  it('a key the read does not report leaves the previous side, so its template value is sent again', async () => {
    const f = fakeAws({ DeliveryStreamName: 'stream' });
    let prev: Record<string, unknown> | undefined;
    await deploy({
      state: stateOf({ properties: { DeliveryStreamName: 'stream', Extra: 'v' }, unsettledProperties: ['Extra'] }),
      template: templateOf({ DeliveryStreamName: 'stream', Extra: 'v' }),
      hooks: f.hooks,
      update: async (id, pid, props, previous, context) => {
        prev = previous;
        return f.update(id, pid, props, previous, context);
      },
    });
    expect(prev).not.toHaveProperty('Extra');
  });

  it('a resource the read reports gone refuses the update before any call', async () => {
    const run = await deploy({
      state: stateOf({ unsettledProperties: ['Extra'] }),
      template: templateOf(plain),
      hooks: { readCurrentState: async () => RESOURCE_NOT_FOUND },
      update: async (_id, pid) => ({ physicalId: pid, attributes: {} }),
      options: { noRollback: true },
    });
    expect(run.thrown).toBeDefined();
    expect(run.contexts).toHaveLength(0);
  });

  it('a successful update AWS does not reflect keeps the name (the mark clears only on proof)', async () => {
    const f = fakeAws({ DeliveryStreamName: 'stream', Extra: 'attempted' });
    const run = await deploy({
      state: stateOf({ properties: { DeliveryStreamName: 'stream', Extra: 'v' }, unsettledProperties: ['Extra'] }),
      template: templateOf({ DeliveryStreamName: 'stream', Extra: 'v' }),
      hooks: f.hooks,
      // The call "succeeds" but AWS keeps the attempted value.
      update: async (_id, pid) => ({ physicalId: pid, attributes: {} }),
    });
    expect(run.thrown).toBeUndefined();
    expect(run.saved?.resources['S']?.unsettledProperties).toEqual(['Extra']);
  });

  it('a name still in transition after a successful update stays unsettled', async () => {
    const f = fakeAws({ DeliveryStreamName: 'stream', Extra: 'v' });
    let calls = 0;
    const run = await deploy({
      state: stateOf({ properties: { DeliveryStreamName: 'stream', Extra: 'v' }, unsettledProperties: ['Extra'] }),
      template: templateOf({ DeliveryStreamName: 'stream', Extra: 'v' }),
      // Settled before the update, moving again after it.
      hooks: { ...f.hooks, unsettledInTransition: async (_p: string, _l: string, _t: string, n: ReadonlySet<string>) => (calls++ === 0 ? new Set() : n) },
      update: f.update,
    });
    expect(run.thrown).toBeUndefined();
    expect(run.saved?.resources['S']?.unsettledProperties).toEqual(['Extra']);
  });

  it('unsettled Tags keep the record as the previous side (no live-only tag is removed) and clear once AWS holds them', async () => {
    const f = fakeAws({ DeliveryStreamName: 'stream', Tags: [{ Key: 'a', Value: '1' }, { Key: 'operator', Value: 'x' }] });
    let prev: Record<string, unknown> | undefined;
    const run = await deploy({
      state: stateOf({ properties: { DeliveryStreamName: 'stream', Tags: [{ Key: 'a', Value: '1' }] }, unsettledProperties: ['Tags'] }),
      template: templateOf({ DeliveryStreamName: 'stream', Tags: [{ Key: 'a', Value: '1' }] }),
      hooks: f.hooks,
      update: async (id, pid, props, previous, context) => {
        prev = previous;
        expect(context?.changedProperties?.has('Tags')).toBe(true);
        // AWS keeps the operator tag: the update upserts, it does not replace.
        return { physicalId: pid, attributes: {} };
      },
    });
    expect(prev?.['Tags']).toEqual([{ Key: 'a', Value: '1' }]);
    expect(f.aws.live['Tags']).toEqual([{ Key: 'a', Value: '1' }, { Key: 'operator', Value: 'x' }]);
    expect(run.saved?.resources['S']).not.toHaveProperty('unsettledProperties');
  });

  it('unsettled Tags whose template tag AWS still lacks stay unsettled', async () => {
    const f = fakeAws({ DeliveryStreamName: 'stream', Tags: [] });
    const run = await deploy({
      state: stateOf({ properties: { DeliveryStreamName: 'stream', Tags: [{ Key: 'a', Value: '1' }] }, unsettledProperties: ['Tags'] }),
      template: templateOf({ DeliveryStreamName: 'stream', Tags: [{ Key: 'a', Value: '1' }] }),
      hooks: f.hooks,
      update: async (_id, pid) => ({ physicalId: pid, attributes: {} }),
    });
    expect(run.saved?.resources['S']?.unsettledProperties).toEqual(['Tags']);
  });

  it('only unsettled Tags take no live read before the update', async () => {
    const f = fakeAws({ DeliveryStreamName: 'stream', Tags: [{ Key: 'a', Value: '1' }] });
    await deploy({
      state: stateOf({ properties: { DeliveryStreamName: 'stream', Tags: [{ Key: 'a', Value: '1' }] }, unsettledProperties: ['Tags'] }),
      template: templateOf({ DeliveryStreamName: 'stream', Tags: [{ Key: 'a', Value: '1' }] }),
      hooks: f.hooks,
      update: async (id, pid, props, previous, context) => {
        // No read before the update: Tags are never substituted.
        expect(f.aws.reads).toBe(0);
        return f.update(id, pid, props, previous, context);
      },
    });
  });

  it('a provider readUnsettled hook is preferred over readCurrentState', async () => {
    const f = fakeAws({ DeliveryStreamName: 'stream', Extra: 'v' });
    const readUnsettled = vi.fn(async () => ({ DeliveryStreamName: 'stream', Extra: 'from-hook' }));
    let prev: Record<string, unknown> | undefined;
    await deploy({
      state: stateOf({ properties: { DeliveryStreamName: 'stream', Extra: 'v' }, unsettledProperties: ['Extra'] }),
      template: templateOf({ DeliveryStreamName: 'stream', Extra: 'v' }),
      hooks: { ...f.hooks, readUnsettled },
      update: async (id, pid, props, previous, context) => {
        prev = previous;
        return f.update(id, pid, props, previous, context);
      },
    });
    expect(prev?.['Extra']).toBe('from-hook');
    // Before the update and for the post-update proof.
    expect(readUnsettled).toHaveBeenCalledTimes(2);
  });

  it('without unsettled names neither convergence hook is called', async () => {
    const f = fakeAws({ DeliveryStreamName: 'stream' });
    const readUnsettled = vi.fn(async () => ({}));
    const unsettledInTransition = vi.fn(async () => new Set<string>());
    await deploy({
      state: stateOf(),
      template: templateOf(encrypted),
      hooks: { ...f.hooks, readUnsettled, unsettledInTransition },
      update: f.update,
    });
    expect(readUnsettled).not.toHaveBeenCalled();
    expect(unsettledInTransition).not.toHaveBeenCalled();
  });
});

describe('convergence messages say what happened (go-to-k/cdkd#5487)', () => {
  const warnLines = async (): Promise<string[]> => {
    const { getLogger } = await import('../../../src/utils/logger.js');
    return (getLogger().warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
  };

  it('the in-transition refusal covers a hook that could not read as well as a moving value', async () => {
    const run = await deploy({
      state: stateOf({ unsettledProperties: ['Extra'] }),
      template: templateOf(plain),
      hooks: { unsettledInTransition: async (_p: string, _l: string, _t: string, n: ReadonlySet<string>) => n },
      update: async (_id, pid) => ({ physicalId: pid, attributes: {} }),
      options: { noRollback: true },
    });
    const chain: string[] = [];
    for (let e: unknown = run.thrown; e instanceof Error && chain.length < 8; e = e.cause) {
      chain.push(e.message);
    }
    expect(chain.join('\n')).toMatch(/AWS is still changing it or cdkd could not confirm it settled/);
    // This provider has no readCurrentState: no `cdkd drift` escape hatch is named.
    expect(chain.join('\n')).not.toContain('drift --accept');
  });

  it('a live-only key the template never had is not called removed from the template', async () => {
    const before = (await warnLines()).length;
    await deploy({
      state: stateOf({ properties: { DeliveryStreamName: 'stream', Gone: 'g' }, unsettledProperties: ['Extra'] }),
      template: templateOf(plain),
      hooks: {
        readCurrentState: async () => ({ DeliveryStreamName: 'stream', Extra: 'attempted' }),
        removalHandledInUpdate: new Map([[TYPE, new Set<string>()]]),
      },
      update: async (_id, pid) => ({ physicalId: pid, attributes: {} }),
    });
    const lines = (await warnLines()).slice(before);
    const live = lines.filter((l) => l.includes('Extra'));
    expect(live.some((l) => l.includes('set on the resource but in no template'))).toBe(true);
    expect(live.some((l) => l.includes('removed from the template'))).toBe(false);
    // The recorded key the template dropped keeps its own wording.
    expect(lines.some((l) => l.includes('Gone') && l.includes('removed from the template'))).toBe(true);
  });
});
