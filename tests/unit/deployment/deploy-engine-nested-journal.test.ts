/**
 * `DeployEngine`'s side of the nested-child journal lifecycle (issue
 * [#3754](https://github.com/go-to-k/cdkd/issues/3754)).
 *
 * A NESTED engine (one built with `parentStackInfo`) that succeeds must KEEP
 * what it did — a `nested-pending-parent` segment, even an empty one — because
 * its parent's deploy is still running and a failure there reverts the child's
 * row by replaying exactly these ops. The ROOT engine that succeeds deletes its
 * own journal and every descendant's. An automatic rollback binds the run it is
 * replaying, and on a clean replay drops the reverted children's segments for
 * that run.
 *
 * Each "keeps" case carries the ROOT control that deletes, so neither arm can
 * pass by the engine simply never touching the journal.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { getNestedRevertRun } from '../../../src/deployment/nested-child-journal.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';
import type { RollbackJournalSegment } from '../../../src/types/rollback-journal.js';

const logs = vi.hoisted(() => ({ info: [] as string[] }));

vi.mock('../../../src/utils/logger.js', () => {
  const l = {
    debug: vi.fn(),
    info: vi.fn((m: string) => logs.info.push(String(m))),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => l,
  };
  return { getLogger: () => l };
});

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: { isSupportedResourceType: vi.fn(() => true) },
}));

const TYPE = 'AWS::SQS::Queue';
const NESTED = 'AWS::CloudFormation::Stack';
const STACK = 'Parent';
const REGION = 'us-east-1';
const RUN = 'run-3754';

function record(logicalId: string, resourceType = TYPE): ResourceState {
  return {
    physicalId: `phys-${logicalId}`,
    resourceType,
    properties: {},
    attributes: {},
    dependencies: [],
  };
}

function updateNestedChange(logicalId: string): ResourceChange {
  return {
    logicalId,
    changeType: 'UPDATE',
    resourceType: NESTED,
    currentProperties: { TemplateURL: 'old' },
    desiredProperties: { TemplateURL: 'new' },
    propertyChanges: [{ path: 'TemplateURL', oldValue: 'old', newValue: 'new' }],
  } as unknown as ResourceChange;
}

function createChange(logicalId: string): ResourceChange {
  return {
    logicalId,
    changeType: 'CREATE',
    resourceType: TYPE,
    desiredProperties: {},
    propertyChanges: [],
  } as unknown as ResourceChange;
}

interface Harness {
  engine: DeployEngine;
  backend: Record<string, ReturnType<typeof vi.fn>>;
  provider: Record<string, ReturnType<typeof vi.fn>>;
}

function build(opts: {
  nested: boolean;
  changes: Map<string, ResourceChange>;
  resources: Record<string, ResourceState>;
  outputs?: Record<string, unknown>;
  extraState?: Partial<StackState>;
  journal?: { segments: Partial<RollbackJournalSegment>[] } | null;
  childState?: StackState | null;
  failCreateOf?: string;
  levels?: string[][];
}): Harness {
  const provider = {
    create: vi.fn().mockImplementation((logicalId: string) =>
      logicalId === opts.failCreateOf
        ? Promise.reject(new Error(`boom ${logicalId}`))
        : Promise.resolve({ physicalId: `phys-${logicalId}`, attributes: {} })
    ),
    update: vi.fn().mockImplementation((logicalId: string) =>
      Promise.resolve({ physicalId: `phys-${logicalId}`, wasReplaced: false })
    ),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const currentState: StackState = {
    version: 8,
    stackName: STACK,
    region: REGION,
    resources: opts.resources,
    outputs: opts.outputs ?? {},
    lastModified: Date.now(),
    ...opts.extraState,
  };
  const backend = {
    getState: vi.fn().mockImplementation((name: string) =>
      Promise.resolve(
        name === STACK
          ? { state: currentState, etag: 'e0' }
          : opts.childState
            ? { state: opts.childState, etag: 'c0' }
            : null
      )
    ),
    saveState: vi.fn().mockResolvedValue('etag-1'),
    appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
    deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
    loadRollbackJournal: vi
      .fn()
      .mockImplementation((name: string) =>
        Promise.resolve(
          name === STACK
            ? (opts.journal ?? null)
            : { segments: [{ runId: RUN, reason: 'nested-pending-parent', operations: [] }] }
        )
      ),
    popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
    dropRollbackJournalSegments: vi.fn().mockResolvedValue(1),
  };
  const levels = opts.levels ?? [[...opts.changes.keys()]];
  const engine = new DeployEngine(
    backend as never,
    {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    } as never,
    {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue(levels),
      getDirectDependencies: vi.fn().mockImplementation((_g: unknown, id: string) => {
        const i = levels.findIndex((l) => l.includes(id));
        return i > 0 ? levels[i - 1]! : [];
      }),
    } as never,
    {
      calculateDiff: vi.fn().mockResolvedValue(opts.changes),
      hasChanges: vi.fn().mockReturnValue(opts.changes.size > 0),
      filterByType: vi
        .fn()
        .mockImplementation((all: Map<string, ResourceChange>, type: string) =>
          [...all.values()].filter((c) => c.changeType === type)
        ),
    } as never,
    {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      getCloudControlProvider: vi.fn(),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    } as never,
    {
      concurrency: 1,
      noRollback: false,
      eventRecorder: { runId: RUN, record: vi.fn() },
      ...(opts.nested && {
        parentStackInfo: { parentStack: 'Root', parentLogicalId: 'Child', parentRegion: REGION },
      }),
    },
    REGION
  );
  return { engine, backend, provider };
}

function templateOf(ids: string[]): CloudFormationTemplate {
  return { Resources: Object.fromEntries(ids.map((id) => [id, { Type: TYPE, Properties: {} }])) };
}

beforeEach(() => {
  vi.clearAllMocks();
  logs.info.length = 0;
});

describe('DeployEngine — nested child journal lifecycle (#3754)', () => {
  it('a NESTED engine that succeeds appends a nested-pending-parent segment and keeps its journal', async () => {
    const { engine, backend } = build({
      nested: true,
      changes: new Map([['Q', createChange('Q')]]),
      resources: {},
      outputs: { QueueUrl: 'old-url' },
    });

    await engine.deploy(STACK, templateOf(['Q']));

    expect(backend.deleteRollbackJournal).not.toHaveBeenCalled();
    expect(backend.appendRollbackJournalSegment).toHaveBeenCalledOnce();
    const [name, region, segment] = backend.appendRollbackJournalSegment.mock.calls[0]!;
    expect([name, region]).toEqual([STACK, REGION]);
    expect(segment).toMatchObject({
      reason: 'nested-pending-parent',
      runId: RUN,
      // The PRE-deploy outputs: the ops restore the resources, not these.
      previousOutputs: { outputs: { QueueUrl: 'old-url' } },
    });
    expect((segment as RollbackJournalSegment).operations.map((o) => o.logicalId)).toEqual(['Q']);
  });

  it('the pending segment carries the PRE-deploy cross-stack reads', async () => {
    const imports = [{ exportName: 'E', sourceStack: 'Producer', sourceRegion: 'us-west-2' }];
    const outputReads = [{ stackName: 'Producer', outputName: 'O', sourceRegion: 'us-west-2' }];
    const { engine, backend } = build({
      nested: true,
      changes: new Map([['Q', createChange('Q')]]),
      resources: {},
      extraState: { imports, outputReads } as unknown as Partial<StackState>,
    });

    await engine.deploy(STACK, templateOf(['Q']));

    const segment = backend.appendRollbackJournalSegment.mock.calls[0]![2] as RollbackJournalSegment;
    expect(segment.previousCrossStackReads).toEqual({ imports, outputReads });
  });

  it('a NESTED engine with NO changes still appends an EMPTY pending segment', async () => {
    const { engine, backend } = build({
      nested: true,
      changes: new Map(),
      resources: { Q: record('Q') },
    });

    await engine.deploy(STACK, templateOf(['Q']));

    expect(backend.deleteRollbackJournal).not.toHaveBeenCalled();
    expect(backend.appendRollbackJournalSegment).toHaveBeenCalledOnce();
    const segment = backend.appendRollbackJournalSegment.mock.calls[0]![2] as RollbackJournalSegment;
    // Present-and-empty is what tells the parent's revert "nothing to undo",
    // as opposed to "no record" (which it refuses).
    expect(segment.reason).toBe('nested-pending-parent');
    expect(segment.operations).toEqual([]);
  });

  it('CONTROL: the ROOT engine that succeeds deletes its journal and its nested child journal', async () => {
    const { engine, backend } = build({
      nested: false,
      changes: new Map([['Q', createChange('Q')]]),
      resources: { Child: record('Child', NESTED) },
      childState: {
        version: 8,
        stackName: `${STACK}~Child`,
        region: REGION,
        resources: { Leaf: record('Leaf') },
        outputs: {},
        lastModified: 0,
      },
    });

    await engine.deploy(STACK, templateOf(['Q']));

    expect(backend.appendRollbackJournalSegment).not.toHaveBeenCalled();
    expect(backend.deleteRollbackJournal.mock.calls.map((c) => c[0]).sort()).toEqual([
      STACK,
      `${STACK}~Child`,
    ]);
  });

  it('CONTROL: the ROOT no-change path deletes the child journal too', async () => {
    const { engine, backend } = build({
      nested: false,
      changes: new Map(),
      resources: { Child: record('Child', NESTED) },
      childState: null,
    });

    await engine.deploy(STACK, templateOf([]));

    expect(backend.appendRollbackJournalSegment).not.toHaveBeenCalled();
    expect(backend.deleteRollbackJournal.mock.calls.map((c) => c[0]).sort()).toEqual([
      STACK,
      `${STACK}~Child`,
    ]);
  });

  it('the automatic rollback runs inside the run scope, and a SETTLED one drops the reverted child pending segments', async () => {
    const { engine, backend, provider } = build({
      nested: false,
      changes: new Map([
        ['Child', updateNestedChange('Child')],
        ['B', createChange('B')],
      ]),
      resources: {
        Child: { ...record('Child', NESTED), properties: { TemplateURL: 'old' } },
        // A nested row this deploy did NOT touch: its journal is not ours.
        Other: record('Other', NESTED),
      },
      failCreateOf: 'B',
      levels: [['Child'], ['B']],
    });
    const seenRuns: unknown[] = [];
    provider.update.mockImplementation((logicalId: string) => {
      seenRuns.push(getNestedRevertRun());
      return Promise.resolve({ physicalId: `phys-${logicalId}`, wasReplaced: false });
    });

    await expect(engine.deploy(STACK, templateOf(['Child', 'B']))).rejects.toThrow();

    // Forward update outside any scope, the revert INSIDE this run's.
    expect(seenRuns).toEqual([undefined, { runId: RUN }]);
    expect(backend.dropRollbackJournalSegments).toHaveBeenCalledOnce();
    const [child, region, drop] = backend.dropRollbackJournalSegments.mock.calls[0]!;
    expect([child, region]).toEqual([`${STACK}~Child`, REGION]);
    const d = drop as (s: { runId?: string; reason?: string }) => boolean;
    expect(d({ runId: RUN, reason: 'nested-pending-parent' })).toBe(true);
    expect(d({ runId: 'other-run', reason: 'nested-pending-parent' })).toBe(false);
    // A child's own failure segment of the same run is not the parent's.
    expect(d({ runId: RUN, reason: 'no-rollback-failure' })).toBe(false);
  });

  it('a rollback whose post-rollback save FAILED keeps the child segments for the re-run', async () => {
    const { engine, backend } = build({
      nested: false,
      changes: new Map([
        ['Child', updateNestedChange('Child')],
        ['B', createChange('B')],
      ]),
      resources: { Child: { ...record('Child', NESTED), properties: { TemplateURL: 'old' } } },
      failCreateOf: 'B',
      levels: [['Child'], ['B']],
    });
    // Every save after the forward update fails: the partial saves, the
    // post-rollback save and its retry.
    backend.saveState.mockResolvedValueOnce('etag-1').mockRejectedValue(new Error('S3 down'));

    await expect(engine.deploy(STACK, templateOf(['Child', 'B']))).rejects.toThrow();

    expect(backend.dropRollbackJournalSegments).not.toHaveBeenCalled();
  });

  it('the post-rollback save RETRY path settles the reverted child too', async () => {
    const { engine, backend, provider } = build({
      nested: false,
      changes: new Map([
        ['Child', updateNestedChange('Child')],
        ['B', createChange('B')],
      ]),
      resources: { Child: { ...record('Child', NESTED), properties: { TemplateURL: 'old' } } },
      failCreateOf: 'B',
      levels: [['Child'], ['B']],
    });
    let reverted = false;
    let failedOnce = false;
    provider.update.mockImplementation((logicalId: string) => {
      if (provider.update.mock.calls.length === 2) reverted = true;
      return Promise.resolve({ physicalId: `phys-${logicalId}`, wasReplaced: false });
    });
    // The FIRST save after the revert (the post-rollback save) conflicts; its
    // retry and everything else succeeds.
    backend.saveState.mockImplementation(() => {
      if (reverted && !failedOnce) {
        failedOnce = true;
        return Promise.reject(new Error('412'));
      }
      return Promise.resolve('etag-x');
    });

    await expect(engine.deploy(STACK, templateOf(['Child', 'B']))).rejects.toThrow();

    expect(failedOnce).toBe(true);
    expect(backend.dropRollbackJournalSegments).toHaveBeenCalledOnce();
  });

  it('a rollback whose journal POP failed keeps the child segments for the re-run', async () => {
    // The re-run `cdkd rollback` replays the still-journaled segment, reverting
    // the Child row again, and must find the child's segments for the run.
    const { engine, backend } = build({
      nested: false,
      changes: new Map([
        ['Child', updateNestedChange('Child')],
        ['B', createChange('B')],
      ]),
      resources: { Child: { ...record('Child', NESTED), properties: { TemplateURL: 'old' } } },
      failCreateOf: 'B',
      levels: [['Child'], ['B']],
    });
    backend.popRollbackJournalSegment.mockRejectedValue(new Error('S3 down'));

    await expect(engine.deploy(STACK, templateOf(['Child', 'B']))).rejects.toThrow();

    expect(backend.popRollbackJournalSegment).toHaveBeenCalled();
    expect(backend.dropRollbackJournalSegments).not.toHaveBeenCalled();
  });

  it('a partial rollback keeps the children segments for a re-run', async () => {
    const { engine, backend, provider } = build({
      nested: false,
      changes: new Map([
        ['Child', updateNestedChange('Child')],
        ['B', createChange('B')],
      ]),
      resources: { Child: { ...record('Child', NESTED), properties: { TemplateURL: 'old' } } },
      failCreateOf: 'B',
      levels: [['Child'], ['B']],
    });
    let calls = 0;
    provider.update.mockImplementation(() =>
      ++calls === 1
        ? Promise.resolve({ physicalId: 'phys-Child', wasReplaced: false })
        : Promise.reject(new Error('revert failed'))
    );

    await expect(engine.deploy(STACK, templateOf(['Child', 'B']))).rejects.toThrow();

    expect(calls).toBe(2);
    expect(backend.dropRollbackJournalSegments).not.toHaveBeenCalled();
  });

  it('performRollback reports a nested row as reverted only when its revert RAN, not when it was skipped', async () => {
    const { engine, provider } = build({ nested: false, changes: new Map(), resources: {} });
    const op = {
      logicalId: 'Child',
      changeType: 'UPDATE',
      resourceType: NESTED,
      physicalId: 'phys-Child',
      previousState: { ...record('Child', NESTED), properties: { TemplateURL: 'old' } },
    };
    const previous = {
      version: 8,
      stackName: STACK,
      region: REGION,
      resources: {},
      outputs: {},
      lastModified: 0,
    } as StackState;
    const perform = (
      engine as unknown as {
        performRollback: (
          ops: unknown[],
          resources: Record<string, ResourceState>,
          stack: string,
          prev: StackState
        ) => Promise<{ revertedNestedRows: string[] }>;
      }
    ).performRollback.bind(engine);

    // The row is absent from state, so the executor SKIPS its revert.
    const skipped = await perform([op], {}, STACK, previous);
    expect(provider.update).not.toHaveBeenCalled();
    expect(skipped.revertedNestedRows).toEqual([]);

    // CONTROL: present, so the revert runs and the row counts.
    const ran = await perform(
      [op],
      { Child: { ...record('Child', NESTED), properties: { TemplateURL: 'new' } } },
      STACK,
      previous
    );
    expect(provider.update).toHaveBeenCalledOnce();
    expect(ran.revertedNestedRows).toEqual(['Child']);
  });

  it('a NESTED engine that succeeds leaves its own nested children journals alone', async () => {
    // Only the ROOT sweeps: a grandchild's pending segment must survive until
    // the top-level deploy succeeds, or a later parent failure cannot revert it.
    const { engine, backend } = build({
      nested: true,
      changes: new Map([['Q', createChange('Q')]]),
      resources: { Grand: record('Grand', NESTED) },
      childState: {
        version: 8,
        stackName: `${STACK}~Grand`,
        region: REGION,
        resources: {},
        outputs: {},
        lastModified: 0,
      },
    });

    await engine.deploy(STACK, templateOf(['Q']));

    expect(backend.deleteRollbackJournal).not.toHaveBeenCalled();
    expect(backend.dropRollbackJournalSegments).not.toHaveBeenCalled();
    expect(backend.appendRollbackJournalSegment).toHaveBeenCalledOnce();
  });

  it('a journal holding only nested-pending-parent segments prints no "previous deploy failed" note', async () => {
    const { engine } = build({
      nested: true,
      changes: new Map(),
      resources: { Q: record('Q') },
      journal: { segments: [{ reason: 'nested-pending-parent', operations: [] }] },
    });

    await engine.deploy(STACK, templateOf(['Q']));

    expect(logs.info.some((l) => l.includes('A previous deploy of'))).toBe(false);
  });

  it('CONTROL: a failure segment beside it still prints the note', async () => {
    const { engine } = build({
      nested: true,
      changes: new Map(),
      resources: { Q: record('Q') },
      journal: {
        segments: [
          { reason: 'nested-pending-parent', operations: [] },
          {
            reason: 'no-rollback-failure',
            operations: [{ logicalId: 'Q', resourceType: TYPE, changeType: 'CREATE' } as never],
          },
        ],
      },
    });

    await engine.deploy(STACK, templateOf(['Q']));

    expect(logs.info.some((l) => l.includes('A previous deploy of'))).toBe(true);
  });
});
