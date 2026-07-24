import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';

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
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: { isSupportedResourceType: vi.fn(() => true) },
}));

describe('DeployEngine — rollback journal (issue #1183)', () => {
  const stackName = 'journal-test';

  let journal: {
    appendRollbackJournalSegment: ReturnType<typeof vi.fn>;
    deleteRollbackJournal: ReturnType<typeof vi.fn>;
    loadRollbackJournal: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeChange(logicalId: string): ResourceChange {
    return {
      logicalId,
      changeType: 'CREATE',
      resourceType: 'AWS::S3::Bucket',
      desiredProperties: {},
      propertyChanges: [],
    } as unknown as ResourceChange;
  }

  function buildEngine(opts: {
    changes: Map<string, ResourceChange>;
    deps: Record<string, string[]>;
    failOn?: Set<string>;
    noRollback?: boolean;
    currentEtag?: string;
    currentResources?: Record<string, ResourceState>;
  }) {
    const provider = {
      create: vi.fn().mockImplementation((logicalId: string) =>
        opts.failOn?.has(logicalId)
          ? Promise.reject(new Error(`create failed: ${logicalId}`))
          : Promise.resolve({ physicalId: `phys-${logicalId}`, attributes: {} })
      ),
      update: vi.fn().mockResolvedValue({ physicalId: 'phys-x', wasReplaced: false }),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    const currentState: StackState = {
      version: 8,
      stackName,
      region: 'us-east-1',
      resources: opts.currentResources ?? {},
      outputs: {},
      lastModified: Date.now(),
    };

    journal = {
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
    };

    const mockStateBackend = {
      getState: vi.fn().mockResolvedValue(
        opts.currentEtag === undefined ? null : { state: currentState, etag: opts.currentEtag }
      ),
      saveState: vi.fn().mockResolvedValue('etag-1'),
      ...journal,
    };

    const mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    const mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([Object.keys(opts.deps)]),
      getDirectDependencies: vi.fn((_dag: unknown, id: string) => opts.deps[id] ?? []),
    };
    const mockDiffCalculator = {
      calculateDiff: vi.fn().mockResolvedValue(opts.changes),
      hasChanges: vi.fn().mockReturnValue(true),
      filterByType: vi.fn().mockImplementation((changes: Map<string, ResourceChange>, type: string) =>
        [...changes.values()].filter((c) => c.changeType === type)
      ),
    };
    const mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      getCloudControlProvider: vi.fn(),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };

    return new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { concurrency: 4, noRollback: opts.noRollback ?? false, roleArn: 'arn:aws:iam::1:role/r' },
      'us-east-1'
    );
  }

  const template: CloudFormationTemplate = {
    Resources: { A: { Type: 'AWS::S3::Bucket', Properties: {} }, B: { Type: 'AWS::S3::Bucket', Properties: {} } },
  };

  it('writes a no-rollback-failure segment when --no-rollback deploy fails', async () => {
    const changes = new Map([
      ['A', makeChange('A')],
      ['B', makeChange('B')],
    ]);
    const engine = buildEngine({ changes, deps: { A: [], B: [] }, failOn: new Set(['B']), noRollback: true, currentEtag: 'e0' });
    await expect(engine.deploy(stackName, template)).rejects.toThrow();
    expect(journal.appendRollbackJournalSegment).toHaveBeenCalledOnce();
    const seg = journal.appendRollbackJournalSegment.mock.calls[0]![2];
    expect(seg.reason).toBe('no-rollback-failure');
    expect(seg.initialDeploy).toBe(false);
    expect(seg.roleArn).toBe('arn:aws:iam::1:role/r');
    // Only the successfully-created A is in the segment.
    expect(seg.operations.map((o: { logicalId: string }) => o.logicalId)).toEqual(['A']);
  });

  it('marks initialDeploy true when the failed deploy was the first deploy', async () => {
    const changes = new Map([
      ['A', makeChange('A')],
      ['B', makeChange('B')],
    ]);
    const engine = buildEngine({ changes, deps: { A: [], B: [] }, failOn: new Set(['B']), noRollback: true, currentEtag: undefined });
    await expect(engine.deploy(stackName, template)).rejects.toThrow();
    const seg = journal.appendRollbackJournalSegment.mock.calls[0]![2];
    expect(seg.initialDeploy).toBe(true);
  });

  it('auto-rollback writes an auto-rollback-started segment then deletes it on a clean replay', async () => {
    const changes = new Map([
      ['A', makeChange('A')],
      ['B', makeChange('B')],
    ]);
    const engine = buildEngine({ changes, deps: { A: [], B: [] }, failOn: new Set(['B']), noRollback: false, currentEtag: 'e0' });
    await expect(engine.deploy(stackName, template)).rejects.toThrow();
    expect(journal.appendRollbackJournalSegment).toHaveBeenCalledOnce();
    expect(journal.appendRollbackJournalSegment.mock.calls[0]![2].reason).toBe('auto-rollback-started');
    // Clean rollback (A deletes fine) → journal deleted after the post-rollback save.
    expect(journal.deleteRollbackJournal).toHaveBeenCalled();
  });
});
