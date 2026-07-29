/**
 * Success-path tail of `DeployEngine.doDeploy`.
 *
 * The tail used to be four fully serialized S3 round trips after the last
 * resource settled: drain observed captures -> saveState -> delete the
 * rollback journal -> update the exports index -> (finally) release the lock.
 * The journal delete and the exports-index update target disjoint objects and
 * neither reads what the other writes, so they now run CONCURRENTLY.
 *
 * These tests pin the parts that are NOT free to move:
 *   - both post-save writes still happen strictly AFTER the state save
 *     (deleting the journal before the new baseline is durable would lose the
 *     ability to revert);
 *   - the lock is still released strictly AFTER both of them (an early release
 *     would let a concurrent deploy observe a journal we are about to delete,
 *     or race the exports-index read-modify-write);
 *   - and that they really do overlap rather than serialize.
 *
 * Plus the `onCurrentStateLoaded` pre-provisioning gate: it must fire exactly
 * once, with the post-lock state, before any provider call — and a throw from
 * it must abort the deploy with the lock released and nothing provisioned.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';

vi.mock('../../../src/utils/logger.js', () => {
  const l = {
    debug: vi.fn(),
    info: vi.fn(),
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
    resolveParameters: vi.fn().mockResolvedValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: { isSupportedResourceType: vi.fn(() => true) },
}));

const stackName = 'tail-stack';

const template: CloudFormationTemplate = {
  Resources: { A: { Type: 'AWS::S3::Bucket', Properties: {} } },
};

function makeChange(): Map<string, ResourceChange> {
  return new Map<string, ResourceChange>([
    [
      'A',
      {
        logicalId: 'A',
        changeType: 'CREATE',
        resourceType: 'AWS::S3::Bucket',
        desiredProperties: {},
        propertyChanges: [],
      } as unknown as ResourceChange,
    ],
  ]);
}

interface Harness {
  engine: DeployEngine;
  order: string[];
  provider: { create: ReturnType<typeof vi.fn> };
  stateBackend: {
    getState: ReturnType<typeof vi.fn>;
    saveState: ReturnType<typeof vi.fn>;
    deleteRollbackJournal: ReturnType<typeof vi.fn>;
    loadRollbackJournal: ReturnType<typeof vi.fn>;
  };
  exportIndexStore: { updateForStack: ReturnType<typeof vi.fn> };
  lockManager: { releaseLock: ReturnType<typeof vi.fn> };
}

function buildHarness(opts: {
  /** Resolve the journal delete / exports update only when released. */
  gate?: { journal?: Promise<void>; exports?: Promise<void> };
  onCurrentStateLoaded?: (stackName: string, state: StackState | undefined) => Promise<void>;
  currentState?: StackState;
} = {}): Harness {
  const order: string[] = [];

  const provider = {
    create: vi.fn().mockImplementation(() => {
      order.push('create');
      return Promise.resolve({ physicalId: 'phys-A', attributes: {} });
    }),
    update: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    getAttribute: vi.fn(),
  };

  const stateBackend = {
    getState: vi.fn().mockImplementation(() => {
      order.push('getState');
      // The real backend returns `null` (not a record with a null state)
      // when the stack has no state at all.
      return Promise.resolve(opts.currentState ? { state: opts.currentState, etag: 'e0' } : null);
    }),
    saveState: vi.fn().mockImplementation(async () => {
      order.push('saveState');
      return 'etag-1';
    }),
    deleteRollbackJournal: vi.fn().mockImplementation(async () => {
      order.push('journal:start');
      await opts.gate?.journal;
      order.push('journal:end');
    }),
    loadRollbackJournal: vi.fn().mockResolvedValue(null),
    appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
    popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
  };

  const exportIndexStore = {
    updateForStack: vi.fn().mockImplementation(async () => {
      order.push('exports:start');
      await opts.gate?.exports;
      order.push('exports:end');
    }),
  };

  const lockManager = {
    acquireLockWithRetry: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn().mockImplementation(async () => {
      order.push('releaseLock');
    }),
  };

  const dagBuilder = {
    buildGraph: vi.fn().mockReturnValue({}),
    getExecutionLevels: vi.fn().mockReturnValue([['A']]),
    getDirectDependencies: vi.fn().mockReturnValue([]),
  };
  const diffCalculator = {
    calculateDiff: vi.fn().mockResolvedValue(makeChange()),
    hasChanges: vi.fn().mockReturnValue(true),
    filterByType: vi
      .fn()
      .mockImplementation((changes: Map<string, ResourceChange>, type: string) =>
        [...changes.values()].filter((c) => c.changeType === type)
      ),
  };
  const providerRegistry = {
    getProvider: vi.fn().mockReturnValue(provider),
    getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
    getRegisteredTypes: vi.fn().mockReturnValue([]),
    getCloudControlProvider: vi.fn(),
    validateResourceTypes: vi.fn(),
    validateResourceProperties: vi.fn(),
  };

  const engine = new DeployEngine(
    stateBackend as never,
    lockManager as never,
    dagBuilder as never,
    diffCalculator as never,
    providerRegistry as never,
    {
      concurrency: 4,
      ...(opts.onCurrentStateLoaded && { onCurrentStateLoaded: opts.onCurrentStateLoaded }),
    },
    'us-east-1',
    exportIndexStore as never
  );

  return { engine, order, provider, stateBackend, exportIndexStore, lockManager };
}

describe('DeployEngine — success-path tail ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs the journal delete and the exports-index update CONCURRENTLY', async () => {
    let releaseJournal: () => void = () => {};
    const journalGate = new Promise<void>((r) => {
      releaseJournal = r;
    });
    const h = buildHarness({ gate: { journal: journalGate } });

    const deploying = h.engine.deploy(stackName, template);
    // Let everything up to the blocked journal delete run.
    await new Promise((resolve) => setImmediate(resolve));

    // If the two were still serialized behind the journal delete, the exports
    // update would not have started yet.
    expect(h.order).toContain('journal:start');
    expect(h.order).toContain('exports:start');

    releaseJournal();
    await deploying;
  });

  it('keeps both post-save writes strictly after saveState and before the lock release', async () => {
    const h = buildHarness();
    await h.engine.deploy(stackName, template);

    const save = h.order.indexOf('saveState');
    const release = h.order.indexOf('releaseLock');
    expect(save).toBeGreaterThanOrEqual(0);
    expect(release).toBeGreaterThan(save);

    for (const marker of ['journal:start', 'journal:end', 'exports:start', 'exports:end']) {
      expect(h.order.indexOf(marker)).toBeGreaterThan(save);
      expect(h.order.indexOf(marker)).toBeLessThan(release);
    }
  });

  it('still releases the lock when the exports-index update rejects', async () => {
    const h = buildHarness();
    h.exportIndexStore.updateForStack.mockRejectedValue(new Error('index boom'));

    await expect(h.engine.deploy(stackName, template)).rejects.toThrow('index boom');
    expect(h.lockManager.releaseLock).toHaveBeenCalledOnce();
  });

  it('works with no exports index store configured', async () => {
    // Nested-stack children and unit harnesses may construct the engine
    // without one; the Promise.all must tolerate the undefined branch.
    const h = buildHarness();
    (h.engine as unknown as { exportIndexStore?: unknown }).exportIndexStore = undefined;

    await expect(h.engine.deploy(stackName, template)).resolves.toBeDefined();
    expect(h.stateBackend.deleteRollbackJournal).toHaveBeenCalledOnce();
  });
});

describe('DeployEngine — onCurrentStateLoaded pre-provisioning gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fires once with the post-lock state, before any provider call', async () => {
    const existing: StackState = {
      version: 8,
      stackName,
      region: 'us-east-1',
      resources: {},
      outputs: {},
      lastModified: 1,
    };
    const seen: Array<[string, StackState | undefined]> = [];
    const order: string[] = [];
    const h = buildHarness({
      currentState: existing,
      onCurrentStateLoaded: async (name, state) => {
        order.push('gate');
        seen.push([name, state]);
      },
    });
    h.provider.create.mockImplementation(() => {
      order.push('create');
      return Promise.resolve({ physicalId: 'phys-A', attributes: {} });
    });

    await h.engine.deploy(stackName, template);

    expect(seen).toEqual([[stackName, existing]]);
    expect(order.indexOf('gate')).toBeLessThan(order.indexOf('create'));
  });

  it('passes undefined when the stack has no state at all (first deploy)', async () => {
    const seen: Array<StackState | undefined> = [];
    const h = buildHarness({
      onCurrentStateLoaded: async (_name, state) => {
        seen.push(state);
      },
    });

    await h.engine.deploy(stackName, template);

    expect(seen).toEqual([undefined]);
  });

  it('aborts the deploy without provisioning anything when the gate throws', async () => {
    const h = buildHarness({
      onCurrentStateLoaded: async () => {
        throw new Error('declined');
      },
    });

    await expect(h.engine.deploy(stackName, template)).rejects.toThrow('declined');
    expect(h.provider.create).not.toHaveBeenCalled();
    expect(h.stateBackend.saveState).not.toHaveBeenCalled();
    // The engine's finally still runs.
    expect(h.lockManager.releaseLock).toHaveBeenCalledOnce();
  });
});
