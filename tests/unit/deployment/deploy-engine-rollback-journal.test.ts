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

  // Note: the `interrupted` (SIGINT) journal-write reason is exercised
  // end-to-end by the `rollback-command` integ fixture and shares the exact
  // `writeRollbackJournalSegment` helper the `no-rollback-failure` /
  // `auto-rollback-started` paths above use (only the reason literal +
  // initialDeploy differ). A unit test that emits a real `process.emit('SIGINT')`
  // races the test runner's own SIGINT listeners, so it is deliberately not
  // added here.

  it('a successful deploy deletes a pre-existing journal (fix-forward succeeded)', async () => {
    const changes = new Map([
      ['A', makeChange('A')],
      ['B', makeChange('B')],
    ]);
    const engine = buildEngine({ changes, deps: { A: [], B: [] }, currentEtag: 'e0' });
    await engine.deploy(stackName, template); // no failOn → succeeds
    expect(journal.deleteRollbackJournal).toHaveBeenCalledWith(stackName, 'us-east-1');
    expect(journal.appendRollbackJournalSegment).not.toHaveBeenCalled();
  });

  it('a journal-write failure warns but does not mask the original deploy error', async () => {
    const changes = new Map([
      ['A', makeChange('A')],
      ['B', makeChange('B')],
    ]);
    const engine = buildEngine({ changes, deps: { A: [], B: [] }, failOn: new Set(['B']), noRollback: true, currentEtag: 'e0' });
    journal.appendRollbackJournalSegment.mockRejectedValueOnce(new Error('S3 down'));
    // The original create-failure still propagates (not the journal error).
    await expect(engine.deploy(stackName, template)).rejects.toThrow(/FailingQueue|create failed|Failed to create resource B|B/);
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

  it('records the failed op with previousState + attemptedProperties (#1198)', async () => {
    const changes = new Map([
      ['A', makeChange('A')],
      ['B', makeChange('B')],
    ]);
    // B is an UPDATE whose provider call fails — its pre-op state and the
    // attempted (resolved) desired properties must land on the segment.
    const bChange = {
      logicalId: 'B',
      changeType: 'UPDATE',
      resourceType: 'AWS::S3::Bucket',
      desiredProperties: { p: 'new' },
      currentProperties: { p: 'old' },
      propertyChanges: [{ path: 'p', requiresReplacement: false }],
    } as unknown as ResourceChange;
    changes.set('B', bChange);
    const prevB: ResourceState = {
      physicalId: 'phys-B-old',
      resourceType: 'AWS::S3::Bucket',
      properties: { p: 'old' },
      attributes: {},
      dependencies: [],
    };
    const engine = buildEngine({
      changes,
      deps: { A: [], B: [] },
      noRollback: true,
      currentEtag: 'e0',
      currentResources: { B: prevB },
    });
    const provider = (
      engine as unknown as {
        providerRegistry: {
          getProviderFor: () => { provider: { update: ReturnType<typeof vi.fn> } };
        };
      }
    ).providerRegistry.getProviderFor().provider;
    provider.update.mockRejectedValue(new Error('update failed: B'));
    await expect(engine.deploy(stackName, template)).rejects.toThrow();
    const seg = journal.appendRollbackJournalSegment.mock.calls[0]![2];
    expect(seg.failedOperations).toHaveLength(1);
    const failed = seg.failedOperations[0];
    expect(failed.logicalId).toBe('B');
    expect(failed.changeType).toBe('UPDATE');
    expect(failed.previousState).toMatchObject({ physicalId: 'phys-B-old', properties: { p: 'old' } });
    expect(failed.physicalId).toBe('phys-B-old');
    expect(failed.attemptedProperties).toEqual({ p: 'new' });
  });

  it('records a failed DELETE op with previousState-derived id and no attemptedProperties (#1198)', async () => {
    const changes = new Map<string, ResourceChange>();
    changes.set('A', makeChange('A'));
    changes.set('D', {
      logicalId: 'D',
      changeType: 'DELETE',
      resourceType: 'AWS::S3::Bucket',
      propertyChanges: [],
    } as unknown as ResourceChange);
    const prevD: ResourceState = {
      physicalId: 'phys-D',
      resourceType: 'AWS::S3::Bucket',
      properties: { p: 'v' },
      attributes: {},
      dependencies: [],
    };
    const engine = buildEngine({
      changes,
      deps: { A: [], D: [] },
      noRollback: true,
      currentEtag: 'e0',
      currentResources: { D: prevD },
    });
    const provider = (
      engine as unknown as {
        providerRegistry: {
          getProviderFor: () => { provider: { delete: ReturnType<typeof vi.fn> } };
        };
      }
    ).providerRegistry.getProviderFor().provider;
    provider.delete.mockRejectedValue(new Error('delete failed: D'));
    await expect(engine.deploy(stackName, template)).rejects.toThrow();
    const seg = journal.appendRollbackJournalSegment.mock.calls[0]![2];
    const failed = seg.failedOperations.find((o: { logicalId: string }) => o.logicalId === 'D');
    expect(failed).toBeDefined();
    expect(failed.changeType).toBe('DELETE');
    expect(failed.physicalId).toBe('phys-D');
    expect(failed.previousState).toMatchObject({ physicalId: 'phys-D' });
    expect(failed.attemptedProperties).toBeUndefined();
  });

  it('journals a failed-only segment when the very first op fails (#1198)', async () => {
    const changes = new Map([['A', makeChange('A')]]);
    const engine = buildEngine({
      changes,
      deps: { A: [] },
      failOn: new Set(['A']),
      noRollback: true,
      currentEtag: 'e0',
    });
    await expect(engine.deploy(stackName, template)).rejects.toThrow();
    // Zero completed ops, but the failed op alone is worth journaling.
    expect(journal.appendRollbackJournalSegment).toHaveBeenCalledOnce();
    const seg = journal.appendRollbackJournalSegment.mock.calls[0]![2];
    expect(seg.operations).toEqual([]);
    expect(seg.failedOperations.map((o: { logicalId: string }) => o.logicalId)).toEqual(['A']);
    // A failed CREATE records no physical id (the provider threw).
    expect(seg.failedOperations[0].physicalId).toBeUndefined();
  });

  it('writes a no-rollback-failure segment when provisioning succeeds but output resolution fails', async () => {
    // Every resource op succeeds; resolveOutputs then throws (only reachable
    // under --strict-getatt). The engine persists state then journals a
    // `no-rollback-failure` segment so `cdkd rollback` can revert.
    const changes = new Map([
      ['A', makeChange('A')],
      ['B', makeChange('B')],
    ]);
    const engine = buildEngine({ changes, deps: { A: [], B: [] }, currentEtag: 'e0' });
    // Turn on strict-getatt + make the Output value resolution throw.
    (engine as unknown as { options: { strictGetAtt: boolean } }).options.strictGetAtt = true;
    const outputSentinel = { 'Fn::GetAtt': ['Missing', 'Arn'] };
    const resolver = (engine as unknown as { resolver: { resolve: ReturnType<typeof vi.fn> } }).resolver;
    resolver.resolve.mockImplementation((value: unknown) => {
      if (value === outputSentinel) return Promise.reject(new Error('unresolvable output'));
      return Promise.resolve(value);
    });
    const templateWithOutput: CloudFormationTemplate = {
      Resources: template.Resources,
      Outputs: { Bad: { Value: outputSentinel } },
    };
    await expect(engine.deploy(stackName, templateWithOutput)).rejects.toThrow(/unresolvable output|Missing/);
    expect(journal.appendRollbackJournalSegment).toHaveBeenCalledOnce();
    const seg = journal.appendRollbackJournalSegment.mock.calls[0]![2];
    expect(seg.reason).toBe('no-rollback-failure');
    // Both A and B completed before the output failure → both are journaled.
    expect(seg.operations.map((o: { logicalId: string }) => o.logicalId).sort()).toEqual(['A', 'B']);
  });
});
