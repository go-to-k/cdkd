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
    update: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const currentState: StackState = {
    version: 8,
    stackName: STACK,
    region: REGION,
    resources: opts.resources,
    outputs: opts.outputs ?? {},
    lastModified: Date.now(),
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
        Promise.resolve(name === STACK ? (opts.journal ?? null) : { segments: [{ runId: RUN }] })
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

  it('the automatic rollback runs inside the run scope and drops the children segments for that run', async () => {
    const { engine, backend, provider } = build({
      nested: false,
      changes: new Map([
        ['A', createChange('A')],
        ['B', createChange('B')],
      ]),
      resources: { Child: record('Child', NESTED) },
      failCreateOf: 'B',
      levels: [['A'], ['B']],
    });
    const seenRuns: unknown[] = [];
    provider.delete.mockImplementation(() => {
      seenRuns.push(getNestedRevertRun());
      return Promise.resolve(undefined);
    });

    await expect(engine.deploy(STACK, templateOf(['A', 'B']))).rejects.toThrow();

    // A was rolled back (deleted) INSIDE the scope, carrying this run's id.
    expect(provider.delete).toHaveBeenCalledOnce();
    expect(seenRuns).toEqual([{ runId: RUN }]);
    // ...and the clean replay settled the nested child: only THIS run's
    // segments are dropped.
    expect(backend.dropRollbackJournalSegments).toHaveBeenCalledOnce();
    const [child, region, drop] = backend.dropRollbackJournalSegments.mock.calls[0]!;
    expect([child, region]).toEqual([`${STACK}~Child`, REGION]);
    expect((drop as (s: { runId?: string }) => boolean)({ runId: RUN })).toBe(true);
    expect((drop as (s: { runId?: string }) => boolean)({ runId: 'other-run' })).toBe(false);
  });

  it('a partial rollback keeps the children segments for a re-run', async () => {
    const { engine, backend, provider } = build({
      nested: false,
      changes: new Map([
        ['A', createChange('A')],
        ['B', createChange('B')],
      ]),
      resources: { Child: record('Child', NESTED) },
      failCreateOf: 'B',
      levels: [['A'], ['B']],
    });
    provider.delete.mockRejectedValue(new Error('delete failed'));

    await expect(engine.deploy(STACK, templateOf(['A', 'B']))).rejects.toThrow();

    expect(provider.delete).toHaveBeenCalled();
    expect(backend.dropRollbackJournalSegments).not.toHaveBeenCalled();
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
