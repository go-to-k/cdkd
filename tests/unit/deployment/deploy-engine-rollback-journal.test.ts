import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { getLogger } from '../../../src/utils/logger.js';
import { withSkipPrefix } from '../../../src/provisioning/resource-name.js';
import { markRefusedBeforeApplying } from '../../../src/deployment/prior-attempt-scope.js';
import { markCreatedBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { RESOURCE_NOT_FOUND, type CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';

// No real AWS client: the create-only DescribeType prefetch reads the
// process-global client factory (see _inert-cloudformation-client.ts).
vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

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
    markRollbackJournalSuperseded: ReturnType<typeof vi.fn>;
    popRollbackJournalSegment: ReturnType<typeof vi.fn>;
    reduceRollbackJournalToFailedOperations: ReturnType<typeof vi.fn>;
    dropRollbackJournalFailedOperations: ReturnType<typeof vi.fn>;
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
    eventRecorder?: { record: (e: unknown) => void; runId?: string };
  }) {
    const provider = {
      create: vi.fn().mockImplementation((logicalId: string) =>
        opts.failOn?.has(logicalId)
          ? Promise.reject(new Error(`create failed: ${logicalId}`))
          : Promise.resolve({ physicalId: `phys-${logicalId}`, attributes: {} })
      ),
      update: vi.fn().mockResolvedValue({ physicalId: 'phys-x', wasReplaced: false }),
      delete: vi.fn().mockResolvedValue(undefined),
      resourceIdentity: vi.fn().mockResolvedValue('created-token'),
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
      markRollbackJournalSuperseded: vi.fn().mockResolvedValue(undefined),
      popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
      reduceRollbackJournalToFailedOperations: vi.fn().mockResolvedValue(1),
      dropRollbackJournalFailedOperations: vi.fn().mockResolvedValue(1),
    };

    const mockStateBackend = {
      getState: vi.fn().mockResolvedValue(
        opts.currentEtag === undefined ? null : { state: currentState, etag: opts.currentEtag }
      ),
      saveState: vi.fn().mockResolvedValue('etag-1'),
      // go-to-k/cdkd#4600: the bucket-wide ownership scan before an orphan delete.
      listStacks: vi.fn().mockResolvedValue([]),
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
      {
        concurrency: 4,
        noRollback: opts.noRollback ?? false,
        roleArn: 'arn:aws:iam::1:role/r',
        ...(opts.eventRecorder && { eventRecorder: opts.eventRecorder as never }),
      },
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

  // Issue #4018: `cdkd rollback` replays the segment under the prefix flag the
  // deploy's providers derived names with, so the segment must carry the flag
  // of the deploy's OWN scope -- both values, since either default would pass
  // one of them.
  it.each([true, false])(
    'records the deploy scope skip-prefix flag (%s) on the segment',
    async (skip) => {
      const changes = new Map([
        ['A', makeChange('A')],
        ['B', makeChange('B')],
      ]);
      const engine = buildEngine({ changes, deps: { A: [], B: [] }, failOn: new Set(['B']), noRollback: true, currentEtag: 'e0' });
      await expect(withSkipPrefix(skip, () => engine.deploy(stackName, template))).rejects.toThrow();
      expect(journal.appendRollbackJournalSegment).toHaveBeenCalledOnce();
      expect(journal.appendRollbackJournalSegment.mock.calls[0]![2].skipPrefix).toBe(skip);
    }
  );

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

  it('a NO-CHANGE successful deploy also deletes a pre-existing journal (issue #1208)', async () => {
    // The typical fix-forward for a retained failed-only journal is removing
    // the failed resource from the template — which diffs as NO changes.
    // Without the no-change-path delete, the journal (and its note) would
    // linger indefinitely.
    const changes = new Map<string, ResourceChange>();
    const engine = buildEngine({ changes, deps: {}, currentEtag: 'e0' });
    (
      engine as unknown as {
        diffCalculator: { hasChanges: ReturnType<typeof vi.fn> };
      }
    ).diffCalculator.hasChanges.mockReturnValue(false);
    await engine.deploy(stackName, template);
    expect(journal.deleteRollbackJournal).toHaveBeenCalledWith(stackName, 'us-east-1');
  });

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

  // go-to-k/cdkd#4402: the success delete is a segment removal too; when it
  // fails, this run's completed ops must still supersede older failed attempts.
  it('a successful deploy whose journal DELETE fails carries its completed ids onto the journal', async () => {
    const changes = new Map([
      ['A', makeChange('A')],
      ['B', makeChange('B')],
    ]);
    const engine = buildEngine({ changes, deps: { A: [], B: [] }, currentEtag: 'e0' });
    // The real backend REPORTS a failed DeleteObject (it never throws).
    journal.deleteRollbackJournal.mockResolvedValue(false);

    await engine.deploy(stackName, template);

    expect(journal.markRollbackJournalSuperseded).toHaveBeenCalledTimes(1);
    const [stack, region, ids] = journal.markRollbackJournalSuperseded.mock.calls[0]!;
    expect([stack, region]).toEqual([stackName, 'us-east-1']);
    expect([...(ids as string[])].sort()).toEqual(['A', 'B']);
  });

  it('a journal delete that THROWS (client setup) also marks', async () => {
    const engine = buildEngine({ changes: new Map([['A', makeChange('A')]]), deps: { A: [] }, currentEtag: 'e0' });
    journal.deleteRollbackJournal.mockRejectedValue(new Error('no client'));

    await engine.deploy(stackName, template);

    expect(journal.markRollbackJournalSuperseded).toHaveBeenCalledWith(stackName, 'us-east-1', ['A']);
  });

  it('a successful deploy whose journal delete succeeds writes no marker', async () => {
    const engine = buildEngine({ changes: new Map([['A', makeChange('A')]]), deps: { A: [] }, currentEtag: 'e0' });
    journal.deleteRollbackJournal.mockResolvedValue(true);

    await engine.deploy(stackName, template);

    expect(journal.markRollbackJournalSuperseded).not.toHaveBeenCalled();
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

  it('clean auto-rollback keeps a failed-only segment for --revert-failed (issue #1208)', async () => {
    const changes = new Map([
      ['A', makeChange('A')],
      ['B', makeChange('B')],
    ]);
    const engine = buildEngine({ changes, deps: { A: [], B: [] }, failOn: new Set(['B']), noRollback: false, currentEtag: 'e0' });
    await expect(engine.deploy(stackName, template)).rejects.toThrow();
    // First append: the pre-rollback auto-rollback-started segment.
    expect(journal.appendRollbackJournalSegment.mock.calls[0]![2].reason).toBe('auto-rollback-started');
    // Clean rollback (A deletes fine) + the deploy failed on B's op → the
    // segment is POPPED and re-recorded failed-only instead of deleted, so
    // `cdkd rollback --revert-failed` still works in the default flow.
    expect(journal.popRollbackJournalSegment).toHaveBeenCalledWith(stackName, 'us-east-1');
    expect(journal.deleteRollbackJournal).not.toHaveBeenCalled();
    expect(journal.appendRollbackJournalSegment).toHaveBeenCalledTimes(2);
    const retained = journal.appendRollbackJournalSegment.mock.calls[1]![2];
    expect(retained.reason).toBe('auto-rollback-clean');
    expect(retained.operations).toEqual([]);
    expect(retained.failedOperations.map((o: { logicalId: string }) => o.logicalId)).toEqual(['B']);
    const infos = (getLogger().info as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(infos.some((m) => m.includes('pre-failure record was kept'))).toBe(true);
  });

  it('clean auto-rollback whose failed-only re-write FAILS claims no kept record', async () => {
    const changes = new Map([
      ['A', makeChange('A')],
      ['B', makeChange('B')],
    ]);
    const engine = buildEngine({ changes, deps: { A: [], B: [] }, failOn: new Set(['B']), noRollback: false, currentEtag: 'e0' });
    // The auto-rollback-started write lands; the failed-only re-write after the pop does not.
    journal.appendRollbackJournalSegment
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('S3 down'));
    await expect(engine.deploy(stackName, template)).rejects.toThrow();
    expect(journal.popRollbackJournalSegment).toHaveBeenCalledWith(stackName, 'us-east-1');
    expect(journal.appendRollbackJournalSegment).toHaveBeenCalledTimes(2);
    const infos = (getLogger().info as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(infos.some((m) => m.includes('pre-failure record was kept'))).toBe(false);
    expect(infos.some((m) => m.includes('--revert-failed'))).toBe(false);
  });

  it('clean auto-rollback with NO failed ops pops only THIS segment, preserving older ones (issue #1215)', async () => {
    const changes = new Map([['A', makeChange('A')]]);
    const engine = buildEngine({ changes, deps: { A: [] }, currentEtag: 'e0' });
    // Reach the private settle helper directly: a deploy that fails WITHOUT a
    // journaled failed op (e.g. a non-resource error mid-DAG) is hard to
    // simulate through the public API deterministically.
    await (
      engine as unknown as {
        settleJournalAfterCleanRollback: (
          stackName: string,
          failedOps: unknown[],
          initialDeploy: boolean
        ) => Promise<void>;
      }
    ).settleJournalAfterCleanRollback(stackName, [], false);
    // The clean rollback reverted only THIS attempt's ops — older segments
    // from prior un-reverted attempts keep their revert records. Pop deletes
    // the object itself when the last segment goes, so the common
    // single-segment case still ends journal-free.
    expect(journal.popRollbackJournalSegment).toHaveBeenCalledWith(stackName, 'us-east-1');
    expect(journal.deleteRollbackJournal).not.toHaveBeenCalled();
    expect(journal.appendRollbackJournalSegment).not.toHaveBeenCalled();
  });

  // go-to-k/cdkd#3338: a SKIPPED rollback op was never reverted, so the
  // segment recording it must survive the automatic rollback, as a failed one
  // does. D1 is deleted (a completed DELETE, which no rollback can undo), then
  // D2's delete fails.
  it('auto-rollback that SKIPS an op keeps the full segment and says so', async () => {
    const changes = new Map<string, ResourceChange>([
      ['D1', { logicalId: 'D1', changeType: 'DELETE', resourceType: 'AWS::S3::Bucket', propertyChanges: [] } as unknown as ResourceChange],
      ['D2', { logicalId: 'D2', changeType: 'DELETE', resourceType: 'AWS::S3::Bucket', propertyChanges: [] } as unknown as ResourceChange],
    ]);
    const record = (id: string, dependencies: string[]): ResourceState => ({
      physicalId: `phys-${id}`,
      resourceType: 'AWS::S3::Bucket',
      properties: {},
      attributes: {},
      dependencies,
    });
    const engine = buildEngine({
      changes,
      deps: {},
      noRollback: false,
      currentEtag: 'e0',
      // D1 depends on D2, so D1 is deleted FIRST and completes before D2 fails.
      currentResources: { D1: record('D1', ['D2']), D2: record('D2', []) },
    });
    const provider = (
      engine as unknown as {
        providerRegistry: { getProviderFor: () => { provider: { delete: ReturnType<typeof vi.fn> } } };
      }
    ).providerRegistry.getProviderFor().provider;
    provider.delete.mockImplementation((logicalId: string) =>
      logicalId === 'D2' ? Promise.reject(new Error('delete failed: D2')) : Promise.resolve(undefined)
    );

    await expect(engine.deploy(stackName, template)).rejects.toThrow();

    const started = journal.appendRollbackJournalSegment.mock.calls[0]![2];
    expect(started.reason).toBe('auto-rollback-started');
    expect(started.operations.map((o: { logicalId: string }) => o.logicalId)).toEqual(['D1']);
    // Not settled: no pop, no failed-only re-record.
    expect(journal.popRollbackJournalSegment).not.toHaveBeenCalled();
    expect(journal.appendRollbackJournalSegment).toHaveBeenCalledOnce();
    expect(journal.deleteRollbackJournal).not.toHaveBeenCalled();
    const warns = (getLogger().warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(warns.some((m) => m.includes('could not revert 1 operation(s)'))).toBe(true);
    expect(warns.some((m) => m.includes('The rollback journal keeps them.'))).toBe(true);
    // The failed op is a DELETE: nothing for `--revert-failed` to act on.
    expect(warns.some((m) => m.includes('--revert-failed'))).toBe(false);
  });

  it('auto-rollback that both FAILS and SKIPS an op keeps the segment without the skip warning', async () => {
    // The failure already keeps the segment and has its own lines; the skip
    // warning is for the case the failure count no longer covers.
    const changes = new Map<string, ResourceChange>([
      ['A', makeChange('A')],
      ['D1', { logicalId: 'D1', changeType: 'DELETE', resourceType: 'AWS::S3::Bucket', propertyChanges: [] } as unknown as ResourceChange],
      ['D2', { logicalId: 'D2', changeType: 'DELETE', resourceType: 'AWS::S3::Bucket', propertyChanges: [] } as unknown as ResourceChange],
    ]);
    const record = (id: string, dependencies: string[]): ResourceState => ({
      physicalId: `phys-${id}`,
      resourceType: 'AWS::S3::Bucket',
      properties: {},
      attributes: {},
      dependencies,
    });
    const engine = buildEngine({
      changes,
      deps: { A: [] },
      noRollback: false,
      currentEtag: 'e0',
      currentResources: { D1: record('D1', ['D2']), D2: record('D2', []) },
    });
    const provider = (
      engine as unknown as {
        providerRegistry: { getProviderFor: () => { provider: { delete: ReturnType<typeof vi.fn> } } };
      }
    ).providerRegistry.getProviderFor().provider;
    // D2's deploy-time delete fails; the rollback's delete of A (the created
    // resource) fails too, while D1's completed DELETE is skipped.
    provider.delete.mockImplementation((logicalId: string) =>
      logicalId === 'D2' || logicalId === 'A'
        ? Promise.reject(new Error(`delete failed: ${logicalId}`))
        : Promise.resolve(undefined)
    );

    await expect(engine.deploy(stackName, template)).rejects.toThrow();

    const started = journal.appendRollbackJournalSegment.mock.calls[0]![2];
    expect(started.operations.map((o: { logicalId: string }) => o.logicalId).sort()).toEqual(['A', 'D1']);
    expect(journal.popRollbackJournalSegment).not.toHaveBeenCalled();
    const warns = (getLogger().warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    // The run reached both outcomes: A's rollback failed and D1 was skipped.
    expect(warns.some((m) => m.includes('Rollback failed for A'))).toBe(true);
    expect(warns.some((m) => m.includes('Cannot restore deleted resource D1'))).toBe(true);
    expect(warns.some((m) => m.includes('could not revert'))).toBe(false);
  });

  it.each([
    ['a top-level stack names it', false],
    ['a nested child names no command (go-to-k/cdkd#3864)', true],
  ] as const)('auto-rollback that SKIPS an op with a failed CREATE / UPDATE: %s', async (_label, nested) => {
    // A's UPDATE completes over a record with no `properties` bag, so its
    // revert is skipped (issue #3203); B's CREATE fails, and its record is in
    // the kept segment, which the next deploy's generic note no longer names.
    const aChange = {
      logicalId: 'A',
      changeType: 'UPDATE',
      resourceType: 'AWS::S3::Bucket',
      desiredProperties: { p: 'new' },
      currentProperties: {},
      propertyChanges: [{ path: 'p', requiresReplacement: false }],
    } as unknown as ResourceChange;
    const prevA = {
      physicalId: 'phys-A',
      resourceType: 'AWS::S3::Bucket',
      properties: {},
      attributes: {},
      dependencies: [],
    } as unknown as ResourceState;
    const engine = buildEngine({
      changes: new Map([
        ['A', aChange],
        ['B', makeChange('B')],
      ]),
      deps: { A: [], B: ['A'] },
      failOn: new Set(['B']),
      noRollback: false,
      currentEtag: 'e0',
      currentResources: { A: prevA },
    });
    // The deploy refuses a record with no `properties` bag at its load
    // (go-to-k/cdkd#3211), so the bag is removed after it: what this case
    // needs is a completed op whose recorded previous state has none.
    (engine as unknown as { options: Record<string, unknown> }).options['onCurrentStateLoaded'] =
      async (_stack: string, state: StackState | undefined) => {
        delete (state!.resources['A'] as { properties?: unknown }).properties;
      };
    const provider = (
      engine as unknown as {
        providerRegistry: { getProviderFor: () => { provider: { update: ReturnType<typeof vi.fn> } } };
      }
    ).providerRegistry.getProviderFor().provider;
    provider.update.mockResolvedValue({ physicalId: 'phys-A', wasReplaced: false });
    if (nested) {
      // A nested child's stack-less `cdkd rollback` resolves to the top-level
      // stack, so the hint must not name one.
      (engine as unknown as { options: Record<string, unknown> }).options['parentStackInfo'] = {
        parentStack: 'Parent',
        parentLogicalId: 'Child',
        parentRegion: 'us-east-1',
      };
    }

    await expect(engine.deploy(stackName, template)).rejects.toThrow();

    expect(journal.popRollbackJournalSegment).not.toHaveBeenCalled();
    const warns = (getLogger().warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(warns.some((m) => m.includes('could not revert 1 operation(s)'))).toBe(true);
    const hint = warns.find((m) => m.includes('--revert-failed'));
    if (nested) {
      expect(hint).toBeUndefined();
    } else {
      expect(hint).toContain(`Revert it with: cdkd rollback ${stackName} --revert-failed`);
    }
  });

  it('auto-rollback that SKIPS an op after its segment write FAILED claims no kept record', async () => {
    // Same shape as the hint case: A's UPDATE revert is skipped, B's CREATE
    // fails. The `auto-rollback-started` write is rejected, so nothing of this
    // attempt is in the journal.
    const aChange = {
      logicalId: 'A',
      changeType: 'UPDATE',
      resourceType: 'AWS::S3::Bucket',
      desiredProperties: { p: 'new' },
      currentProperties: {},
      propertyChanges: [{ path: 'p', requiresReplacement: false }],
    } as unknown as ResourceChange;
    const prevA = {
      physicalId: 'phys-A',
      resourceType: 'AWS::S3::Bucket',
      properties: {},
      attributes: {},
      dependencies: [],
    } as unknown as ResourceState;
    const engine = buildEngine({
      changes: new Map([
        ['A', aChange],
        ['B', makeChange('B')],
      ]),
      deps: { A: [], B: ['A'] },
      failOn: new Set(['B']),
      noRollback: false,
      currentEtag: 'e0',
      currentResources: { A: prevA },
    });
    // The deploy refuses a record with no `properties` bag at its load
    // (go-to-k/cdkd#3211), so the bag is removed after it: what this case
    // needs is a completed op whose recorded previous state has none.
    (engine as unknown as { options: Record<string, unknown> }).options['onCurrentStateLoaded'] =
      async (_stack: string, state: StackState | undefined) => {
        delete (state!.resources['A'] as { properties?: unknown }).properties;
      };
    const provider = (
      engine as unknown as {
        providerRegistry: { getProviderFor: () => { provider: { update: ReturnType<typeof vi.fn> } } };
      }
    ).providerRegistry.getProviderFor().provider;
    provider.update.mockResolvedValue({ physicalId: 'phys-A', wasReplaced: false });
    journal.appendRollbackJournalSegment.mockRejectedValueOnce(new Error('S3 down'));

    await expect(engine.deploy(stackName, template)).rejects.toThrow();

    expect(journal.popRollbackJournalSegment).not.toHaveBeenCalled();
    const warns = (getLogger().warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    // It reached the skip warning, which then claims nothing was kept.
    expect(warns.some((m) => m.includes('could not revert 1 operation(s)'))).toBe(true);
    expect(warns.some((m) => m.includes('The rollback journal keeps them.'))).toBe(false);
    expect(warns.some((m) => m.includes('--revert-failed'))).toBe(false);
  });

  it('a pop failure during journal settling leaves the full segment in place (best-effort)', async () => {
    const changes = new Map([
      ['A', makeChange('A')],
      ['B', makeChange('B')],
    ]);
    const engine = buildEngine({ changes, deps: { A: [], B: [] }, failOn: new Set(['B']), noRollback: false, currentEtag: 'e0' });
    journal.popRollbackJournalSegment.mockRejectedValueOnce(new Error('S3 down'));
    await expect(engine.deploy(stackName, template)).rejects.toThrow();
    // The auto-rollback-started append happened; the failed-only re-record
    // did NOT (pop failed), and the journal was not deleted either — the
    // full segment stays for an idempotent `cdkd rollback` later.
    expect(journal.appendRollbackJournalSegment).toHaveBeenCalledOnce();
    expect(journal.deleteRollbackJournal).not.toHaveBeenCalled();
  });

  it('next deploy prints the --revert-failed note for a failed-only journal (issue #1208)', async () => {
    const changes = new Map([['A', makeChange('A')]]);
    const engine = buildEngine({ changes, deps: { A: [] }, currentEtag: 'e0' });
    journal.loadRollbackJournal.mockResolvedValue({
      journalVersion: 1,
      stackName,
      region: 'us-east-1',
      segments: [
        {
          timestamp: 1,
          reason: 'auto-rollback-clean',
          initialDeploy: false,
          operations: [],
          failedOperations: [{ logicalId: 'B', changeType: 'CREATE', resourceType: 'AWS::S3::Bucket' }],
        },
      ],
    });
    await engine.deploy(stackName, template);
    const infoCalls = vi.mocked(getLogger().info).mock.calls.map((c) => String(c[0]));
    expect(infoCalls.some((m) => m.includes('--revert-failed'))).toBe(true);
    expect(infoCalls.some((m) => m.includes('automatically rolled back'))).toBe(true);
  });

  it('next deploy keeps the generic note for a journal that still has completed ops', async () => {
    const changes = new Map([['A', makeChange('A')]]);
    const engine = buildEngine({ changes, deps: { A: [] }, currentEtag: 'e0' });
    journal.loadRollbackJournal.mockResolvedValue({
      journalVersion: 1,
      stackName,
      region: 'us-east-1',
      segments: [
        {
          timestamp: 1,
          reason: 'no-rollback-failure',
          initialDeploy: false,
          operations: [{ logicalId: 'A', changeType: 'CREATE', resourceType: 'AWS::S3::Bucket', physicalId: 'p' }],
          failedOperations: [{ logicalId: 'B', changeType: 'CREATE', resourceType: 'AWS::S3::Bucket' }],
        },
      ],
    });
    await engine.deploy(stackName, template);
    const infoCalls = vi.mocked(getLogger().info).mock.calls.map((c) => String(c[0]));
    expect(infoCalls.some((m) => m.includes('failed or was interrupted'))).toBe(true);
    expect(infoCalls.some((m) => m.includes('automatically rolled back'))).toBe(false);
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

  it.each([['UPDATE', 'update']] as const)(
    'journals a %s refused as belonging to someone else WITHOUT its attempted bag (go-to-k/cdkd#4355)',
    async (changeType, method) => {
      // The bag is what the next deploy reads as "this stack attempted that
      // resource", and what `--revert-failed` reverts an UPDATE from: kept, it
      // would make the next deploy adopt the resource the refusal declined.
      const change = {
        logicalId: 'B',
        changeType,
        resourceType: 'AWS::S3::Bucket',
        desiredProperties: { p: 'new' },
        currentProperties: { p: 'old' },
        propertyChanges: [{ path: 'p', requiresReplacement: false }],
      } as unknown as ResourceChange;
      const prevB: ResourceState = {
        physicalId: 'phys-B-old',
        resourceType: 'AWS::S3::Bucket',
        properties: { p: 'old' },
        attributes: {},
        dependencies: [],
      };
      const engine = buildEngine({
        changes: new Map([['B', change]]),
        deps: { B: [] },
        noRollback: true,
        currentEtag: 'e0',
        ...(changeType === 'UPDATE' && { currentResources: { B: prevB } }),
      });
      const provider = (
        engine as unknown as {
          providerRegistry: {
            getProviderFor: () => {
              provider: Record<'create' | 'update', ReturnType<typeof vi.fn>>;
            };
          };
        }
      ).providerRegistry.getProviderFor().provider;
      provider[method].mockRejectedValue(
        markRefusedBeforeApplying(new Error('B already exists and is not ours'))
      );

      await expect(engine.deploy(stackName, template)).rejects.toThrow();

      const seg = journal.appendRollbackJournalSegment.mock.calls[0]![2];
      expect(seg.failedOperations).toHaveLength(1);
      expect(seg.failedOperations[0].logicalId).toBe('B');
      expect(seg.failedOperations[0].changeType).toBe(changeType);
      expect(seg.failedOperations[0]).not.toHaveProperty('attemptedProperties');
    }
  );

  // go-to-k/cdkd#4356: a CREATE refused before anything was applied, with no
  // physical id, left nothing of this stack's to revert. Journaled, its only
  // effect was `--revert-failed` advising to delete the resource that refused
  // it -- another owner's -- and the clean auto-rollback keeping a failed-only
  // segment whose note says the failed resource "may be partially applied".
  describe('a CREATE refused before anything was applied (go-to-k/cdkd#4356)', () => {
    function refusedCreateEngine(noRollback: boolean, failure: Error) {
      const changes = new Map([
        ['A', makeChange('A')],
        ['B', { ...makeChange('B'), desiredProperties: { p: 'new' } } as ResourceChange],
      ]);
      // B waits for A so A's create COMPLETES first: the segment then has a
      // completed op, and the auto-rollback a clean replay to settle.
      const engine = buildEngine({ changes, deps: { A: [], B: ['A'] }, noRollback, currentEtag: 'e0' });
      const provider = (
        engine as unknown as {
          providerRegistry: { getProviderFor: () => { provider: { create: ReturnType<typeof vi.fn> } } };
        }
      ).providerRegistry.getProviderFor().provider;
      provider.create.mockImplementation((logicalId: string) =>
        logicalId === 'B'
          ? Promise.reject(failure)
          : Promise.resolve({ physicalId: `phys-${logicalId}`, attributes: {} })
      );
      return engine;
    }

    it('is not journaled as a failed op (--no-rollback)', async () => {
      const engine = refusedCreateEngine(true, markRefusedBeforeApplying(new Error('B is not ours')));
      await expect(engine.deploy(stackName, template)).rejects.toThrow();
      expect(journal.appendRollbackJournalSegment).toHaveBeenCalledOnce();
      const seg = journal.appendRollbackJournalSegment.mock.calls[0]![2];
      expect(seg.operations.map((o: { logicalId: string }) => o.logicalId)).toEqual(['A']);
      expect(seg).not.toHaveProperty('failedOperations');
    });

    it('leaves a clean auto-rollback with no failed-only segment to keep', async () => {
      const engine = refusedCreateEngine(false, markRefusedBeforeApplying(new Error('B is not ours')));
      await expect(engine.deploy(stackName, template)).rejects.toThrow();
      // Only the pre-rollback segment; the settle pops it and re-records none.
      expect(journal.appendRollbackJournalSegment).toHaveBeenCalledOnce();
      expect(journal.appendRollbackJournalSegment.mock.calls[0]![2]).not.toHaveProperty('failedOperations');
      expect(journal.popRollbackJournalSegment).toHaveBeenCalledWith(stackName, 'us-east-1');
    });

    // B1 of the #4522 review: an attempt whose only failure is a refused
    // CREATE, with nothing completed, writes NO segment. Its clean
    // auto-rollback must not then settle (pop) the newest segment, which is
    // an OLDER attempt's revert record.
    it('an attempt that wrote no segment leaves an older journal untouched', async () => {
      const changes = new Map([['B', makeChange('B')]]);
      const engine = buildEngine({ changes, deps: { B: [] }, noRollback: false, currentEtag: 'e0' });
      const provider = (
        engine as unknown as {
          providerRegistry: { getProviderFor: () => { provider: { create: ReturnType<typeof vi.fn> } } };
        }
      ).providerRegistry.getProviderFor().provider;
      provider.create.mockRejectedValue(markRefusedBeforeApplying(new Error('B is not ours')));

      await expect(engine.deploy(stackName, template)).rejects.toThrow();

      expect(journal.appendRollbackJournalSegment).not.toHaveBeenCalled();
      expect(journal.popRollbackJournalSegment).not.toHaveBeenCalled();
      expect(journal.deleteRollbackJournal).not.toHaveBeenCalled();
    });

    it('an attempt whose segment write FAILED does not pop an older segment either', async () => {
      const engine = refusedCreateEngine(false, new Error('B failed mid-create'));
      journal.appendRollbackJournalSegment.mockRejectedValueOnce(new Error('S3 down'));

      await expect(engine.deploy(stackName, template)).rejects.toThrow();

      expect(journal.popRollbackJournalSegment).not.toHaveBeenCalled();
      expect(journal.deleteRollbackJournal).not.toHaveBeenCalled();
    });

    it('control: a refused UPDATE is still journaled, even over a record with no physical id', async () => {
      // Only a CREATE has nothing of this stack's behind it. An UPDATE's
      // previous record is this stack's, whatever its id says.
      const change = {
        logicalId: 'B',
        changeType: 'UPDATE',
        resourceType: 'AWS::S3::Bucket',
        desiredProperties: { p: 'new' },
        currentProperties: { p: 'old' },
        propertyChanges: [{ path: 'p', requiresReplacement: false }],
      } as unknown as ResourceChange;
      const prevB = {
        resourceType: 'AWS::S3::Bucket',
        properties: { p: 'old' },
        attributes: {},
        dependencies: [],
      } as unknown as ResourceState;
      const engine = buildEngine({
        changes: new Map([['B', change]]),
        deps: { B: [] },
        noRollback: true,
        currentEtag: 'e0',
        currentResources: { B: prevB },
      });
      const provider = (
        engine as unknown as {
          providerRegistry: { getProviderFor: () => { provider: { update: ReturnType<typeof vi.fn> } } };
        }
      ).providerRegistry.getProviderFor().provider;
      provider.update.mockRejectedValue(markRefusedBeforeApplying(new Error('B is not ours')));
      await expect(engine.deploy(stackName, template)).rejects.toThrow();
      const seg = journal.appendRollbackJournalSegment.mock.calls[0]![2];
      expect(seg.failedOperations.map((o: { logicalId: string }) => o.logicalId)).toEqual(['B']);
      expect(seg.failedOperations[0].physicalId).toBeUndefined();
    });

    // go-to-k/cdkd#3211, through `deploy()`: the UPDATE of a record with no
    // usable physical id is refused before anything is sent, so it fails the
    // deploy and journals no attempted bag.
    it('an UPDATE over a record with a blank physical id fails the deploy with no attempted bag (go-to-k/cdkd#3211)', async () => {
      const change = {
        logicalId: 'B',
        changeType: 'UPDATE',
        resourceType: 'AWS::S3::Bucket',
        desiredProperties: { p: 'new' },
        currentProperties: { p: 'old' },
        propertyChanges: [{ path: 'p', requiresReplacement: false }],
      } as unknown as ResourceChange;
      const prevB = {
        physicalId: '  ',
        resourceType: 'AWS::S3::Bucket',
        properties: { p: 'old' },
        attributes: {},
        dependencies: [],
      } as unknown as ResourceState;
      const engine = buildEngine({
        changes: new Map([['B', change]]),
        deps: { B: [] },
        noRollback: true,
        currentEtag: 'e0',
        currentResources: { B: prevB },
      });
      const provider = (
        engine as unknown as {
          providerRegistry: { getProviderFor: () => { provider: { update: ReturnType<typeof vi.fn> } } };
        }
      ).providerRegistry.getProviderFor().provider;
      const error = await engine.deploy(stackName, template).then(
        () => undefined,
        (e: unknown) => e
      );
      let chain = '';
      for (let e: unknown = error; e instanceof Error; e = (e as { cause?: unknown }).cause) {
        chain += `${e.message} | `;
      }
      expect(chain).toContain('did not try to update it');
      expect(provider.update).not.toHaveBeenCalled();
      const seg = journal.appendRollbackJournalSegment.mock.calls[0]![2];
      expect(seg.failedOperations.map((o: { logicalId: string }) => o.logicalId)).toEqual(['B']);
      expect(seg.failedOperations[0]).not.toHaveProperty('attemptedProperties');
    });

    it('a template-removal DELETE over a blank physical id reports deleteSkipped (go-to-k/cdkd#3211)', async () => {
      const change = {
        logicalId: 'D',
        changeType: 'DELETE',
        resourceType: 'AWS::S3::Bucket',
        currentProperties: {},
      } as unknown as ResourceChange;
      const prevD = {
        physicalId: '',
        resourceType: 'AWS::S3::Bucket',
        properties: {},
        attributes: {},
        dependencies: [],
      } as unknown as ResourceState;
      const engine = buildEngine({
        changes: new Map([['D', change]]),
        deps: { D: [] },
        currentEtag: 'e0',
        currentResources: { D: prevD },
      });
      const provider = (
        engine as unknown as {
          providerRegistry: { getProviderFor: () => { provider: { delete: ReturnType<typeof vi.fn> } } };
        }
      ).providerRegistry.getProviderFor().provider;
      const result = await engine.deploy(stackName, template);
      expect(provider.delete).not.toHaveBeenCalled();
      // The count the CLI turns into exit 2 (`--allow-unaddressed`).
      expect(result.deleteSkipped).toBe(1);
      expect(result.deleted).toBe(0);
    });

    it('control: a refused CREATE that carries a physical id is still journaled', async () => {
      // A CREATE over a record state already holds (a re-create under the
      // same id) names a resource; dropping its record could lose it.
      const prevB: ResourceState = {
        physicalId: 'phys-B-old',
        resourceType: 'AWS::S3::Bucket',
        properties: { p: 'old' },
        attributes: {},
        dependencies: [],
      };
      const engine = buildEngine({
        changes: new Map([['B', { ...makeChange('B'), desiredProperties: { p: 'new' } } as ResourceChange]]),
        deps: { B: [] },
        noRollback: true,
        currentEtag: 'e0',
        currentResources: { B: prevB },
      });
      const provider = (
        engine as unknown as {
          providerRegistry: { getProviderFor: () => { provider: { create: ReturnType<typeof vi.fn> } } };
        }
      ).providerRegistry.getProviderFor().provider;
      provider.create.mockRejectedValue(markRefusedBeforeApplying(new Error('B is not ours')));
      await expect(engine.deploy(stackName, template)).rejects.toThrow();
      const seg = journal.appendRollbackJournalSegment.mock.calls[0]![2];
      expect(seg.failedOperations.map((o: { logicalId: string }) => o.logicalId)).toEqual(['B']);
      expect(seg.failedOperations[0].physicalId).toBe('phys-B-old');
      expect(seg.failedOperations[0]).not.toHaveProperty('attemptedProperties');
    });

    it('control: an UNMARKED failed CREATE is still journaled', async () => {
      const engine = refusedCreateEngine(true, new Error('B failed mid-create'));
      await expect(engine.deploy(stackName, template)).rejects.toThrow();
      const seg = journal.appendRollbackJournalSegment.mock.calls[0]![2];
      expect(seg.failedOperations.map((o: { logicalId: string }) => o.logicalId)).toEqual(['B']);
      expect(seg.failedOperations[0].attemptedProperties).toEqual({ p: 'new' });
    });
  });

  // go-to-k/cdkd#1710: a CREATE whose provider proved its create call returned
  // before the failure journals that resource, which no state record holds.
  describe('a CREATE that made its resource and then failed (go-to-k/cdkd#1710)', () => {
    function failingCreateEngine(failure: Error, tmpl: CloudFormationTemplate = template) {
      const changes = new Map([['B', { ...makeChange('B'), desiredProperties: { p: 'new' } } as ResourceChange]]);
      const engine = buildEngine({ changes, deps: { B: [] }, noRollback: true, currentEtag: 'e0' });
      const provider = (
        engine as unknown as {
          providerRegistry: { getProviderFor: () => { provider: { create: ReturnType<typeof vi.fn> } } };
        }
      ).providerRegistry.getProviderFor().provider;
      provider.create.mockRejectedValue(failure);
      return { engine, tmpl };
    }

    async function journaledB(failure: Error, tmpl?: CloudFormationTemplate) {
      const { engine, tmpl: t } = failingCreateEngine(failure, tmpl);
      await expect(engine.deploy(stackName, t)).rejects.toThrow();
      const seg = journal.appendRollbackJournalSegment.mock.calls[0]![2];
      return seg.failedOperations.find((o: { logicalId: string }) => o.logicalId === 'B');
    }

    it('journals the marked id with its provenance, the sdk route and the DeletionPolicy', async () => {
      const op = await journaledB(
        markCreatedBeforeFailure(new ProvisioningError('retention rejected', 'AWS::S3::Bucket', 'B', 'b-1'), 'B', 'AWS::S3::Bucket', 'b-1'),
        { Resources: { B: { Type: 'AWS::S3::Bucket', Properties: {}, DeletionPolicy: 'Retain' } } }
      );
      expect(op.physicalId).toBe('b-1');
      expect(op.physicalIdRecoveredFromError).toBe(true);
      expect(op.provisionedBy).toBe('sdk');
      expect(op.deletionPolicy).toBe('Retain');
      expect(op.attemptedProperties).toEqual({ p: 'new' });
    });

    // go-to-k/cdkd#4655: the provider's identity token, read once after the
    // failure, so a later settle can tell the resource from a name reuse.
    describe('the created resource identity (go-to-k/cdkd#4655)', () => {
      const marked = () =>
        markCreatedBeforeFailure(
          new ProvisioningError('retention rejected', 'AWS::S3::Bucket', 'B', 'b-1'),
          'B',
          'AWS::S3::Bucket',
          'b-1'
        );
      async function journaledWith(identity: (() => Promise<unknown>) | undefined) {
        const { engine, tmpl } = failingCreateEngine(marked());
        const internals = engine as unknown as {
          providerRegistry: {
            getProviderFor: ReturnType<typeof vi.fn> & (() => { provider: Record<string, unknown> });
          };
        };
        const provider = internals.providerRegistry.getProviderFor().provider;
        const read = vi.fn(identity ?? (async () => undefined));
        if (identity === undefined) delete provider['resourceIdentity'];
        else provider['resourceIdentity'] = read;
        internals.providerRegistry.getProviderFor.mockClear();
        await expect(engine.deploy(stackName, tmpl)).rejects.toThrow();
        const seg = journal.appendRollbackJournalSegment.mock.calls[0]![2];
        const op = seg.failedOperations.find((o: { logicalId: string }) => o.logicalId === 'B');
        return { op, read, getProviderFor: internals.providerRegistry.getProviderFor };
      }

      it('journals the token beside the proven id, read once through the sdk route', async () => {
        const { op, read, getProviderFor } = await journaledWith(async () => 'arn:x@1700000000000');
        expect(op.physicalIdRecoveredFromError).toBe(true);
        expect(op.createdResourceIdentity).toBe('arn:x@1700000000000');
        expect(read).toHaveBeenCalledTimes(1);
        expect(read).toHaveBeenCalledWith('b-1', 'AWS::S3::Bucket', { expectedRegion: 'us-east-1' });
        expect(getProviderFor).toHaveBeenCalledWith({ resourceType: 'AWS::S3::Bucket', provisionedBy: 'sdk' });
      });

      it.each([
        ['a read that throws', async (): Promise<unknown> => {
          throw new Error('AccessDenied');
        }],
        ['a resource AWS reports gone', async (): Promise<unknown> => RESOURCE_NOT_FOUND],
        ['no token', async (): Promise<unknown> => undefined],
        ['an empty token', async (): Promise<unknown> => ''],
      ] as const)('journals no token for %s, and still journals the proven id', async (_label, identity) => {
        const { op } = await journaledWith(identity);
        expect(op.physicalId).toBe('b-1');
        expect(op.physicalIdRecoveredFromError).toBe(true);
        expect(op).not.toHaveProperty('createdResourceIdentity');
      });

      async function journaledFor(
        type: string,
        id: string,
        opts: { policy?: 'Retain'; interruptByUser?: boolean; read?: () => Promise<unknown> } = {}
      ) {
        const failure = markCreatedBeforeFailure(new ProvisioningError('rejected', type, 'B', id), 'B', type, id);
        const tmpl: CloudFormationTemplate = {
          Resources: { B: { Type: type, Properties: {}, ...(opts.policy && { DeletionPolicy: opts.policy }) } },
        };
        const changes = new Map([
          ['B', { ...makeChange('B'), resourceType: type, desiredProperties: { p: 'new' } } as ResourceChange],
        ]);
        const engine = buildEngine({ changes, deps: { B: [] }, noRollback: true, currentEtag: 'e0' });
        const provider = (
          engine as unknown as { providerRegistry: { getProviderFor: () => { provider: Record<string, unknown> } } }
        ).providerRegistry.getProviderFor().provider;
        const read = vi.fn(opts.read ?? (async (): Promise<unknown> => 'tok'));
        provider['resourceIdentity'] = read;
        (provider['create'] as ReturnType<typeof vi.fn>).mockImplementation(async () => {
          // A Ctrl-C that lands while the create is in flight.
          if (opts.interruptByUser) (engine as unknown as { interruptCause: string }).interruptCause = 'user';
          throw failure;
        });
        await expect(engine.deploy(stackName, tmpl)).rejects.toThrow();
        const seg = journal.appendRollbackJournalSegment.mock.calls[0]![2];
        const op = seg.failedOperations.find((o: { logicalId: string }) => o.logicalId === 'B');
        return { op, read };
      }

      it('reads no token for a type that needs none, or a Retain orphan; reads one for a name-keyed Delete orphan', async () => {
        for (const [type, id, policy] of [
          ['AWS::EC2::VPC', 'vpc-0123456789abcdef0', undefined],
          ['AWS::SQS::QueuePolicy', 'https://sqs.us-east-1.amazonaws.com/1/q', undefined],
          ['AWS::S3::Bucket', 'b-1', 'Retain'],
        ] as const) {
          journal.appendRollbackJournalSegment.mockClear();
          const { op, read } = await journaledFor(type, id, policy ? { policy } : {});
          expect(op.physicalIdRecoveredFromError).toBe(true);
          expect(read).not.toHaveBeenCalled();
          expect(op).not.toHaveProperty('createdResourceIdentity');
        }
        journal.appendRollbackJournalSegment.mockClear();
        const named = await journaledFor('AWS::S3::Bucket', 'b-1');
        expect(named.read).toHaveBeenCalledTimes(1);
        expect(named.op.createdResourceIdentity).toBe('tok');
      });

      it('reads no token once the user has interrupted the deploy, and still journals the proven id', async () => {
        const { op, read } = await journaledFor('AWS::S3::Bucket', 'b-1', { interruptByUser: true });
        expect(op.physicalIdRecoveredFromError).toBe(true);
        expect(op.physicalId).toBe('b-1');
        expect(read).not.toHaveBeenCalled();
        expect(op).not.toHaveProperty('createdResourceIdentity');
      });

      it('gives up on a read that never answers, journaling the proven id without a token', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
          const pending = journaledFor('AWS::S3::Bucket', 'b-1', { read: () => new Promise<never>(() => {}) });
          // Advance past the read's bound; the deploy then journals and throws.
          for (let i = 0; i < 40 && journal.appendRollbackJournalSegment.mock.calls.length === 0; i++) {
            await vi.advanceTimersByTimeAsync(1_000);
          }
          const { op, read } = await pending;
          expect(read).toHaveBeenCalledTimes(1);
          expect(op.physicalIdRecoveredFromError).toBe(true);
          expect(op).not.toHaveProperty('createdResourceIdentity');
        } finally {
          vi.useRealTimers();
        }
      });

      it('journals no token for a provider without resourceIdentity', async () => {
        const { op } = await journaledWith(undefined);
        expect(op.physicalIdRecoveredFromError).toBe(true);
        expect(op).not.toHaveProperty('createdResourceIdentity');
      });

      it('reads nothing for a failed CREATE no provider proved', async () => {
        const { op, read } = await journaledWith(async () => 'tok');
        expect(op.createdResourceIdentity).toBe('tok');
        read.mockClear();
        journal.appendRollbackJournalSegment.mockClear();
        const { engine, tmpl } = failingCreateEngine(new Error('plain failure'));
        const provider = (
          engine as unknown as { providerRegistry: { getProviderFor: () => { provider: Record<string, unknown> } } }
        ).providerRegistry.getProviderFor().provider;
        const plainRead = vi.fn(async () => 'tok');
        provider['resourceIdentity'] = plainRead;
        await expect(engine.deploy(stackName, tmpl)).rejects.toThrow();
        const plain = journal.appendRollbackJournalSegment.mock.calls[0]![2].failedOperations.find(
          (o: { logicalId: string }) => o.logicalId === 'B'
        );
        expect(plain).not.toHaveProperty('createdResourceIdentity');
        expect(plainRead).not.toHaveBeenCalled();
      });
    });

    // go-to-k/cdkd#3869 review: the error is MASKED before it reaches the
    // journal (`printingSecretsFor`, now with the derived-name registry), and
    // the mark's id spells the secret-derived name. It must survive exact, or
    // `--revert-failed` gets `***` and cannot delete what the create made.
    it.each([
      ['a name equal to the resolved secret', 'AWS::S3::Bucket', 'BucketName', 'team-secret-bucket', 'team-secret-bucket'],
      ['a name its provider rewrote', 'AWS::IAM::Role', 'RoleName', 'alice@example.com', 'alice-example-com'],
    ] as const)('journals the marked id EXACT for %s', async (_label, type, nameKey, secret, id) => {
      const changes = new Map([
        ['B', { ...makeChange('B'), resourceType: type, desiredProperties: { p: 'new' } } as ResourceChange],
      ]);
      const engine = buildEngine({ changes, deps: { B: [] }, noRollback: true, currentEtag: 'e0' });
      (
        engine as unknown as {
          providerRegistry: { getProviderFor: () => { provider: { create: ReturnType<typeof vi.fn> } } };
        }
      ).providerRegistry
        .getProviderFor()
        .provider.create.mockRejectedValue(
          markCreatedBeforeFailure(
            new ProvisioningError(`failed after creating ${id}`, type, 'B', id),
            'B',
            type,
            id
          )
        );
      const tmpl: CloudFormationTemplate = {
        Resources: { B: { Type: type, Properties: { [nameKey]: 'ref' } } },
      };
      const resolver = (engine as unknown as { resolver: { resolve: ReturnType<typeof vi.fn> } }).resolver;
      resolver.resolve.mockImplementation(
        (value: unknown, ctx?: { recordedSecretValues?: Map<string, string> }) => {
          if (value && typeof value === 'object' && 'p' in (value as object)) {
            ctx?.recordedSecretValues?.set(secret, '{{resolve:secretsmanager:s:SecretString:n::}}');
            return Promise.resolve({ ...(value as object), [nameKey]: secret });
          }
          return Promise.resolve(value);
        }
      );
      const caught = await engine.deploy(stackName, tmpl).then(
        () => undefined,
        (e: unknown) => e
      );
      const op = journal.appendRollbackJournalSegment.mock.calls[0]![2].failedOperations.find(
        (o: { logicalId: string }) => o.logicalId === 'B'
      );
      expect(op.physicalId).toBe(id);
      expect(op.physicalIdRecoveredFromError).toBe(true);
      // Non-vacuity: the printed error text WAS masked.
      const chain: string[] = [];
      for (let e: unknown = caught; e instanceof Error; e = (e as { cause?: unknown }).cause) {
        chain.push(e.message);
      }
      expect(chain.join('\n')).toContain('failed after creating');
      expect(chain.join('\n')).not.toContain(id);
    });

    // The hazard the mark exists for: a provider names the resource it was
    // GOING to create on every failure, including a collision with another
    // owner's. That id must never reach a `--revert-failed` delete.
    it('ignores an UNMARKED ProvisioningError.physicalId', async () => {
      const op = await journaledB(
        new ProvisioningError('ResourceInUseException', 'AWS::S3::Bucket', 'B', 'someone-elses')
      );
      expect(op.physicalId).toBeUndefined();
      expect(op).not.toHaveProperty('physicalIdRecoveredFromError');
    });

    it("ignores a mark naming another logical id (a nested child's error)", async () => {
      const op = await journaledB(
        markCreatedBeforeFailure(new ProvisioningError('child', 'AWS::S3::Bucket', 'B', undefined), 'Child', 'AWS::S3::Bucket', 'c-1')
      );
      expect(op.physicalId).toBeUndefined();
    });

    // A nested child can share its parent row's logical id; the row's own
    // type is what tells the child's mark from the row's.
    it("ignores a same-id mark of another resource type (a nested child's)", async () => {
      const op = await journaledB(
        markCreatedBeforeFailure(new Error('child'), 'B', 'AWS::Kinesis::Stream', 'c-1')
      );
      expect(op.physicalId).toBeUndefined();
    });

    it.each([['Delete'], ['Snapshot'], ['RetainExceptOnCreate'], [undefined]] as const)(
      'journals a DeletionPolicy of %s as written',
      async (policy) => {
        const op = await journaledB(
          markCreatedBeforeFailure(new Error('x'), 'B', 'AWS::S3::Bucket', 'b-1'),
          {
            Resources: {
              B: (policy === undefined
                ? { Type: 'AWS::S3::Bucket', Properties: {} }
                : { Type: 'AWS::S3::Bucket', Properties: {}, DeletionPolicy: policy as 'Delete' }),
            },
          }
        );
        expect(op.physicalIdRecoveredFromError).toBe(true);
        expect(op.deletionPolicy).toBe(policy);
      }
    );

    // go-to-k/cdkd#4584: the default flow deletes the proven orphan the way
    // CloudFormation's rollback deletes a failed CREATE — per its journaled
    // DeletionPolicy, before the completed CREATEs it may depend on.
    function autoRollbackEngine(
      policy: 'Delete' | 'Retain' | undefined,
      opts: { deleteFails?: boolean; previousOrphans?: StackState['orphans'] } = {}
    ) {
      const changes = new Map([
        ['A', makeChange('A')],
        ['B', { ...makeChange('B'), desiredProperties: { p: 'new' } } as ResourceChange],
      ]);
      const engine = buildEngine({ changes, deps: { A: [], B: ['A'] }, noRollback: false, currentEtag: 'e0' });
      const registry = (
        engine as unknown as {
          stateBackend: { getState: ReturnType<typeof vi.fn> };
          providerRegistry: {
            getProviderFor: () => {
              provider: { create: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
            };
          };
        }
      );
      if (opts.previousOrphans) {
        registry.stateBackend.getState.mockResolvedValue({
          state: {
            version: 8,
            stackName,
            region: 'us-east-1',
            resources: {},
            outputs: {},
            orphans: opts.previousOrphans,
            lastModified: 1,
          },
          etag: 'e0',
        });
      }
      const provider = registry.providerRegistry.getProviderFor().provider;
      provider.create.mockImplementation((logicalId: string) =>
        logicalId === 'B'
          ? Promise.reject(markCreatedBeforeFailure(new Error('x'), 'B', 'AWS::S3::Bucket', 'b-1'))
          : Promise.resolve({ physicalId: `phys-${logicalId}`, attributes: {} })
      );
      if (opts.deleteFails) {
        provider.delete.mockImplementation((logicalId: string) =>
          logicalId === 'B' ? Promise.reject(new Error('AccessDenied')) : Promise.resolve(undefined)
        );
      }
      const tmpl: CloudFormationTemplate = {
        Resources: {
          A: { Type: 'AWS::S3::Bucket', Properties: {} },
          B: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
            ...(policy !== undefined && { DeletionPolicy: policy }),
          },
        },
      };
      return { engine, provider, tmpl };
    }

    it('deletes the orphan BEFORE the completed CREATE, and settles with no failed-only segment', async () => {
      const { engine, provider, tmpl } = autoRollbackEngine(undefined);
      await expect(engine.deploy(stackName, tmpl)).rejects.toThrow();
      expect(provider.delete.mock.calls.map((c: unknown[]) => [c[0], c[1]])).toEqual([
        ['B', 'b-1'],
        ['A', 'phys-A'],
      ]);
      // Only the auto-rollback-started segment: the handled orphan leaves
      // nothing for `--revert-failed`, so no failed-only one is re-recorded.
      expect(journal.appendRollbackJournalSegment.mock.calls.map((c) => c[2].reason)).toEqual([
        'auto-rollback-started',
      ]);
      expect(journal.popRollbackJournalSegment).toHaveBeenCalledOnce();
    });

    it('keeps the orphan in AWS under DeletionPolicy Retain, and drops its entry', async () => {
      const { engine, provider, tmpl } = autoRollbackEngine('Retain');
      await expect(engine.deploy(stackName, tmpl)).rejects.toThrow();
      expect(provider.delete.mock.calls.map((c: unknown[]) => c[0])).toEqual(['A']);
      expect(journal.appendRollbackJournalSegment.mock.calls.map((c) => c[2].reason)).toEqual([
        'auto-rollback-started',
      ]);
      expect(journal.popRollbackJournalSegment).toHaveBeenCalledOnce();
    });

    it('keeps the full segment, the orphan entry intact, when its delete fails', async () => {
      const { engine, provider, tmpl } = autoRollbackEngine(undefined, { deleteFails: true });
      await expect(engine.deploy(stackName, tmpl)).rejects.toThrow();
      expect(provider.delete.mock.calls.map((c: unknown[]) => c[0])).toEqual(['B', 'A']);
      expect(journal.popRollbackJournalSegment).not.toHaveBeenCalled();
      const segs = journal.appendRollbackJournalSegment.mock.calls.map((c) => c[2]);
      expect(segs.map((seg) => seg.reason)).toEqual(['auto-rollback-started']);
      expect(segs[0].failedOperations[0]).toMatchObject({
        logicalId: 'B',
        physicalId: 'b-1',
        physicalIdRecoveredFromError: true,
      });
    });

    // A rollback-orphan record holding its physical id may own the resource:
    // warned and skipped, never deleted — and the journaled flag is the
    // provider's proof, not the supersede pass's verdict.
    it('skips a superseded orphan and journals it unchanged', async () => {
      const { engine, provider, tmpl } = autoRollbackEngine(undefined, {
        previousOrphans: [
          {
            logicalId: 'Other',
            orphanedAt: 1,
            state: { physicalId: 'b-1', resourceType: 'AWS::S3::Bucket', properties: {} },
          } as never,
        ],
      });
      await expect(engine.deploy(stackName, tmpl)).rejects.toThrow();
      expect(provider.delete.mock.calls.map((c: unknown[]) => c[0])).toEqual(['A']);
      expect(journal.popRollbackJournalSegment).not.toHaveBeenCalled();
      const seg = journal.appendRollbackJournalSegment.mock.calls[0]![2];
      expect(seg.failedOperations[0].physicalIdRecoveredFromError).toBe(true);
      expect(vi.mocked(getLogger().warn).mock.calls.flat().join('\n')).toContain(
        'a later deploy or rollback may own a resource under that id now'
      );
    });

    // A failed-only attempt: `replayRollback` emits no envelope over zero
    // completed ops, so the orphan replay owns it — exactly one pair.
    it('frames a failed-only attempt with one ROLLBACK_STARTED / ROLLBACK_FINISHED pair', async () => {
      const events: Array<{ eventType: string }> = [];
      const engine = buildEngine({
        changes: new Map([['B', { ...makeChange('B'), desiredProperties: { p: 'new' } } as ResourceChange]]),
        deps: { B: [] },
        noRollback: false,
        currentEtag: 'e0',
        eventRecorder: { record: (e) => events.push(e as { eventType: string }), runId: 'r1' },
      });
      const provider = (
        engine as unknown as {
          providerRegistry: { getProviderFor: () => { provider: { create: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> } } };
        }
      ).providerRegistry.getProviderFor().provider;
      provider.create.mockRejectedValue(markCreatedBeforeFailure(new Error('x'), 'B', 'AWS::S3::Bucket', 'b-1'));
      await expect(engine.deploy(stackName, template)).rejects.toThrow();
      expect(provider.delete.mock.calls.map((c: unknown[]) => c[1])).toEqual(['b-1']);
      const types = events.map((e) => e.eventType).filter((t) => t === 'ROLLBACK_STARTED' || t === 'ROLLBACK_FINISHED');
      expect(types).toEqual(['ROLLBACK_STARTED', 'ROLLBACK_FINISHED']);
    });

    // The post-rollback save's ETag-retry arm settles the journal too, and must
    // settle with the same remaining failed ops.
    it('settles through the save-retry arm with the handled orphan dropped', async () => {
      const { engine, provider, tmpl } = autoRollbackEngine(undefined);
      const backend = (
        engine as unknown as {
          stateBackend: { saveState: ReturnType<typeof vi.fn>; getState: ReturnType<typeof vi.fn> };
        }
      ).stateBackend;
      let failedOnce = false;
      backend.saveState.mockImplementation(async (_n: string, _r: string, st: StackState) => {
        if (!failedOnce && Object.keys(st.resources).length === 0) {
          failedOnce = true;
          throw new Error('PreconditionFailed');
        }
        return 'etag-x';
      });
      await expect(engine.deploy(stackName, tmpl)).rejects.toThrow();
      expect(failedOnce).toBe(true);
      expect(provider.delete.mock.calls.map((c: unknown[]) => c[0])).toEqual(['B', 'A']);
      expect(journal.appendRollbackJournalSegment.mock.calls.map((c) => c[2].reason)).toEqual([
        'auto-rollback-started',
      ]);
      expect(journal.popRollbackJournalSegment).toHaveBeenCalledOnce();
    });

    // Direct call: the index mapping keeps an ordinary failed op (still owed to
    // `--revert-failed`) and drops only the handled orphan; the counts sum the
    // orphan replay with the completed-op replay.
    it('returns the ordinary failed ops as remaining and sums the two replays', async () => {
      const engine = buildEngine({ changes: new Map(), deps: {}, noRollback: false, currentEtag: 'e0' });
      const provider = (
        engine as unknown as {
          providerRegistry: { getProviderFor: () => { provider: { delete: ReturnType<typeof vi.fn> } } };
        }
      ).providerRegistry.getProviderFor().provider;
      const ordinary = { logicalId: 'U', changeType: 'UPDATE' as const, resourceType: 'AWS::S3::Bucket', physicalId: 'u-1' };
      const proven = {
        logicalId: 'P',
        changeType: 'CREATE' as const,
        resourceType: 'AWS::S3::Bucket',
        physicalId: 'p-1',
        provisionedBy: 'sdk' as const,
        physicalIdRecoveredFromError: true,
      };
      const superseded = { ...proven, logicalId: 'S', physicalId: 's-1' };
      // Its delete fails: it stays owed, so it must stay in the remaining list.
      const failing = { ...proven, logicalId: 'F', physicalId: 'f-1' };
      provider.delete.mockImplementation((logicalId: string) =>
        logicalId === 'F' ? Promise.reject(new Error('AccessDenied')) : Promise.resolve(undefined)
      );
      const prev: StackState = { version: 8, stackName, region: 'us-east-1', resources: {}, outputs: {}, lastModified: 1 };
      const run = (engine as unknown as {
        performRollback: (...a: unknown[]) => Promise<{
          warnings: number;
          skipped: number;
          failures: number;
          remainingFailedOps: unknown[];
        }>;
      }).performRollback.bind(engine);
      const out = await run([], {}, stackName, prev, [ordinary, proven, superseded, failing], [
        { logicalId: 'Other', orphanedAt: 1, state: { physicalId: 's-1', resourceType: 'AWS::S3::Bucket', properties: {} } },
      ]);
      expect(provider.delete.mock.calls.map((c: unknown[]) => c[1]).sort()).toEqual(['f-1', 'p-1']);
      expect(out.remainingFailedOps).toEqual([ordinary, failing]);
      expect(out.failures).toBe(1);
      expect(out.skipped).toBe(1);
      expect(out.warnings).toBe(1);
    });

    it('deletes nothing under --no-rollback', async () => {
      const { engine } = failingCreateEngine(
        markCreatedBeforeFailure(new Error('x'), 'B', 'AWS::S3::Bucket', 'b-1')
      );
      const provider = (
        engine as unknown as {
          providerRegistry: { getProviderFor: () => { provider: { delete: ReturnType<typeof vi.fn> } } };
        }
      ).providerRegistry.getProviderFor().provider;
      await expect(engine.deploy(stackName, template)).rejects.toThrow();
      expect(provider.delete).not.toHaveBeenCalled();
      const seg = journal.appendRollbackJournalSegment.mock.calls[0]![2];
      expect(seg.reason).toBe('no-rollback-failure');
      expect(seg.failedOperations[0].physicalIdRecoveredFromError).toBe(true);
    });

    it('journals an unknown DeletionPolicy as Retain, never a plain delete', async () => {
      const op = await journaledB(
        markCreatedBeforeFailure(new Error('x'), 'B', 'AWS::S3::Bucket', 'b-1'),
        { Resources: { B: { Type: 'AWS::S3::Bucket', Properties: {}, DeletionPolicy: 'retain' as never } } }
      );
      expect(op.deletionPolicy).toBe('Retain');
    });

    // A CREATE over a record state already holds names THAT resource; the
    // mark never overrides it.
    it('keeps a state-sourced physical id over a mark', async () => {
      const prevB: ResourceState = {
        physicalId: 'phys-B-old',
        resourceType: 'AWS::S3::Bucket',
        properties: {},
        attributes: {},
        dependencies: [],
      };
      const engine = buildEngine({
        changes: new Map([['B', { ...makeChange('B'), desiredProperties: { p: 'new' } } as ResourceChange]]),
        deps: { B: [] },
        noRollback: true,
        currentEtag: 'e0',
        currentResources: { B: prevB },
      });
      const provider = (
        engine as unknown as {
          providerRegistry: { getProviderFor: () => { provider: { create: ReturnType<typeof vi.fn> } } };
        }
      ).providerRegistry.getProviderFor().provider;
      provider.create.mockRejectedValue(
        markCreatedBeforeFailure(new Error('x'), 'B', 'AWS::S3::Bucket', 'b-new')
      );
      await expect(engine.deploy(stackName, template)).rejects.toThrow();
      const op = journal.appendRollbackJournalSegment.mock.calls[0]![2].failedOperations[0];
      expect(op.physicalId).toBe('phys-B-old');
      expect(op).not.toHaveProperty('physicalIdRecoveredFromError');
      expect(op).not.toHaveProperty('deletionPolicy');
    });

    it('ignores the mark on a refusal', async () => {
      const failure = markRefusedBeforeApplying(markCreatedBeforeFailure(new Error('refused'), 'B', 'AWS::S3::Bucket', 'b-1'));
      const { engine, tmpl } = failingCreateEngine(failure);
      await expect(engine.deploy(stackName, tmpl)).rejects.toThrow();
      expect(journal.appendRollbackJournalSegment).not.toHaveBeenCalled();
    });
  });

  // go-to-k/cdkd#4604: a replacement runs the same `create()`, journaled as an
  // UPDATE naming the OLD resource; the new one its create made is journaled
  // beside it as a proven orphan of the same logical id.
  describe('a replacement whose new resource was made and then failed (go-to-k/cdkd#4604)', () => {
    const prevB = (type = 'AWS::SQS::Queue'): ResourceState => ({
      physicalId: 'b-old',
      resourceType: type,
      properties: { p: 'old' },
      attributes: {},
      dependencies: [],
    });
    const replaceTemplate = (type = 'AWS::SQS::Queue', policy?: 'Retain'): CloudFormationTemplate => ({
      Resources: { B: { Type: type, Properties: { p: 'new' }, ...(policy && { DeletionPolicy: policy }) } },
    });

    function replacingEngine(
      failure: Error,
      opts: {
        noRollback?: boolean;
        type?: string;
        inPlace?: boolean;
        prevType?: string;
        prevPhysicalId?: string;
      } = {}
    ) {
      const type = opts.type ?? 'AWS::SQS::Queue';
      const change = {
        logicalId: 'B',
        changeType: 'UPDATE',
        resourceType: type,
        desiredProperties: { p: 'new' },
        propertyChanges: [
          { path: 'p', oldValue: 'old', newValue: 'new', requiresReplacement: opts.inPlace !== true },
        ],
      } as unknown as ResourceChange;
      const engine = buildEngine({
        changes: new Map([['B', change]]),
        deps: { B: [] },
        noRollback: opts.noRollback ?? true,
        currentEtag: 'e0',
        currentResources: {
          B: {
            ...prevB(opts.prevType ?? type),
            ...(opts.prevPhysicalId !== undefined && { physicalId: opts.prevPhysicalId }),
          },
        },
      });
      const internals = engine as unknown as {
        stateBackend: { saveState: ReturnType<typeof vi.fn> };
        providerRegistry: {
          getProviderFor: () => {
            provider: { create: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
          };
        };
      };
      const provider = internals.providerRegistry.getProviderFor().provider;
      provider.create.mockRejectedValue(failure);
      return { engine, provider, saveState: internals.stateBackend.saveState };
    }

    async function failedOpsOf(failure: Error, opts: { type?: string; policy?: 'Retain' } = {}) {
      const { engine } = replacingEngine(failure, opts);
      await expect(engine.deploy(stackName, replaceTemplate(opts.type, opts.policy))).rejects.toThrow();
      return journal.appendRollbackJournalSegment.mock.calls[0]![2].failedOperations as Array<
        Record<string, unknown>
      >;
    }

    // go-to-k/cdkd#4655: the replacement's new resource carries its token too;
    // the UPDATE naming the replaced record does not.
    it('journals the identity token on the replacement orphan only', async () => {
      const { engine, provider } = replacingEngine(
        markCreatedBeforeFailure(new Error('follow-up rejected'), 'B', 'AWS::SQS::Queue', 'b-new')
      );
      const read = vi.fn(async () => 'queue-token');
      (provider as unknown as Record<string, unknown>)['resourceIdentity'] = read;
      await expect(engine.deploy(stackName, replaceTemplate())).rejects.toThrow();
      const ops = journal.appendRollbackJournalSegment.mock.calls[0]![2].failedOperations as Array<
        Record<string, unknown>
      >;
      const orphan = ops.find((o) => o['changeType'] === 'CREATE')!;
      const update = ops.find((o) => o['changeType'] === 'UPDATE')!;
      expect(orphan['createdResourceIdentity']).toBe('queue-token');
      expect(update).not.toHaveProperty('createdResourceIdentity');
      expect(read).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledWith('b-new', 'AWS::SQS::Queue', { expectedRegion: 'us-east-1' });
    });

    it('journals the new resource beside the UPDATE, naming the replaced record', async () => {
      const ops = await failedOpsOf(
        markCreatedBeforeFailure(new Error('follow-up rejected'), 'B', 'AWS::SQS::Queue', 'b-new'),
        { policy: 'Retain' }
      );
      expect(ops).toHaveLength(2);
      const update = ops.find((o) => o['changeType'] === 'UPDATE')!;
      expect(update['physicalId']).toBe('b-old');
      // Self-contained: it never reads as a revert, even without the orphan.
      expect(update['replacementOrphaned']).toBe('create-first');
      expect(update).not.toHaveProperty('replacedPhysicalId');
      const orphan = ops.find((o) => o['changeType'] === 'CREATE')!;
      expect(orphan).toMatchObject({
        logicalId: 'B',
        resourceType: 'AWS::SQS::Queue',
        provisionedBy: 'sdk',
        physicalId: 'b-new',
        physicalIdRecoveredFromError: true,
        deletionPolicy: 'Retain',
        replacedPhysicalId: 'b-old',
        replacedResourceType: 'AWS::SQS::Queue',
      });
      expect(orphan).not.toHaveProperty('previousState');
      // What the replay's delete hands the provider for its guard opt-ins.
      expect(orphan['attemptedProperties']).toEqual({ p: 'new' });
    });

    // A Type change: the replaced record is the OLD type, which the classifier
    // compares against the record still under the id.
    it('names the replaced record by its own type across a Type change', async () => {
      const { engine } = replacingEngine(
        markCreatedBeforeFailure(new Error('x'), 'B', 'AWS::SQS::Queue', 'b-new'),
        { prevType: 'AWS::SNS::Topic' }
      );
      await expect(engine.deploy(stackName, replaceTemplate())).rejects.toThrow();
      const ops = journal.appendRollbackJournalSegment.mock.calls[0]![2].failedOperations as Array<
        Record<string, unknown>
      >;
      expect(ops.find((o) => o['changeType'] === 'CREATE')).toMatchObject({
        resourceType: 'AWS::SQS::Queue',
        replacedPhysicalId: 'b-old',
        replacedResourceType: 'AWS::SNS::Topic',
      });
    });

    it('control: an unmarked replacement failure journals the UPDATE alone', async () => {
      const ops = await failedOpsOf(
        new ProvisioningError('rejected', 'AWS::SQS::Queue', 'B', 'someone-elses')
      );
      expect(ops.map((o) => o['changeType'])).toEqual(['UPDATE']);
    });

    // An equal id names the resource state already records; deleting it from
    // a journal entry would destroy what the record tracks.
    it('journals nothing beside the UPDATE for a mark naming the replaced id', async () => {
      const ops = await failedOpsOf(
        markCreatedBeforeFailure(new Error('x'), 'B', 'AWS::SQS::Queue', 'b-old')
      );
      expect(ops.map((o) => o['changeType'])).toEqual(['UPDATE']);
    });

    // Delete-first (the update-unsupported fallback): the replacement deleted
    // the old resource before its create, which the orphan says.
    it('marks the orphan when the replacement deleted the old resource first', async () => {
      const { engine, provider } = replacingEngine(
        markCreatedBeforeFailure(new Error('x'), 'B', 'AWS::SQS::Queue', 'b-new'),
        { inPlace: true }
      );
      // Cloud Control's `UnsupportedActionException`: the auto-fallback that
      // deletes the old resource and then creates (no name change).
      (provider as unknown as { update: ReturnType<typeof vi.fn> }).update.mockRejectedValue(
        Object.assign(new Error('update not supported'), { name: 'UnsupportedActionException' })
      );
      await expect(engine.deploy(stackName, replaceTemplate())).rejects.toThrow();
      expect(provider.delete.mock.calls.map((c: unknown[]) => c[1])).toEqual(['b-old']);
      const ops = journal.appendRollbackJournalSegment.mock.calls[0]![2].failedOperations as Array<
        Record<string, unknown>
      >;
      expect(ops.find((o) => o['changeType'] === 'CREATE')).toMatchObject({
        physicalId: 'b-new',
        replacedPhysicalId: 'b-old',
        replacedResourceDeleted: true,
      });
      expect(ops.find((o) => o['changeType'] === 'UPDATE')).toMatchObject({
        replacementOrphaned: 'delete-first',
      });
    });

    // The automatic rollback warns about the delete-first UPDATE itself and
    // settles it with its orphan: no `--revert-failed` hint, which would only
    // repeat that warning.
    it('names no --revert-failed after warning about a delete-first replacement', async () => {
      const { engine, provider } = replacingEngine(
        markCreatedBeforeFailure(new Error('x'), 'B', 'AWS::SQS::Queue', 'b-new'),
        { inPlace: true, noRollback: false }
      );
      (provider as unknown as { update: ReturnType<typeof vi.fn> }).update.mockRejectedValue(
        Object.assign(new Error('update not supported'), { name: 'UnsupportedActionException' })
      );
      const warn = vi.mocked(getLogger().warn);
      warn.mockClear();
      await expect(engine.deploy(stackName, replaceTemplate())).rejects.toThrow();
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes('its replacement deleted the old resource'))).toBe(true);
      expect(lines.some((l) => l.includes('--revert-failed'))).toBe(false);
    });

    // A reused engine: the previous deploy's delete-first must not mark this
    // deploy's create-first orphan.
    it("does not carry a previous deploy's delete-first onto a reused engine", async () => {
      const { engine, provider } = replacingEngine(
        markCreatedBeforeFailure(new Error('x'), 'B', 'AWS::SQS::Queue', 'b-new'),
        { inPlace: true }
      );
      (provider as unknown as { update: ReturnType<typeof vi.fn> }).update.mockRejectedValue(
        Object.assign(new Error('update not supported'), { name: 'UnsupportedActionException' })
      );
      await expect(engine.deploy(stackName, replaceTemplate())).rejects.toThrow();
      const internals = engine as unknown as {
        diffCalculator: { calculateDiff: () => Promise<Map<string, ResourceChange>> };
      };
      const change = [...(await internals.diffCalculator.calculateDiff()).values()][0]!;
      (change.propertyChanges as Array<{ requiresReplacement: boolean }>)[0]!.requiresReplacement = true;
      await expect(engine.deploy(stackName, replaceTemplate())).rejects.toThrow();
      const ops = journal.appendRollbackJournalSegment.mock.calls.at(-1)![2].failedOperations as Array<
        Record<string, unknown>
      >;
      expect(ops.find((o) => o['changeType'] === 'CREATE')).not.toHaveProperty('replacedResourceDeleted');
      expect(ops.find((o) => o['changeType'] === 'UPDATE')).toMatchObject({
        replacementOrphaned: 'create-first',
      });
    });

    it('control: a create-first replacement does not mark it', async () => {
      const ops = await failedOpsOf(
        markCreatedBeforeFailure(new Error('x'), 'B', 'AWS::SQS::Queue', 'b-new')
      );
      expect(ops.find((o) => o['changeType'] === 'CREATE')).not.toHaveProperty(
        'replacedResourceDeleted'
      );
    });

    // A policy attachment's id is its comma-joined targets, which a new id
    // can share with the replaced record's.
    it('journals nothing beside a QueuePolicy or TopicPolicy replacement', async () => {
      for (const type of ['AWS::SQS::QueuePolicy', 'AWS::SNS::TopicPolicy']) {
        const ops = await failedOpsOf(markCreatedBeforeFailure(new Error('x'), 'B', type, 'q2'), { type });
        expect(ops.map((o) => o['changeType']), type).toEqual(['UPDATE']);
      }
    });

    // A record with an empty id names no resource; a replacedPhysicalId of ''
    // would also make the journal unreadable.
    it('journals nothing beside a replaced record with an empty physical id', async () => {
      const { engine } = replacingEngine(
        markCreatedBeforeFailure(new Error('x'), 'B', 'AWS::SQS::Queue', 'b-new'),
        { prevPhysicalId: '' }
      );
      await expect(engine.deploy(stackName, replaceTemplate())).rejects.toThrow();
      const ops = (journal.appendRollbackJournalSegment.mock.calls[0]?.[2].failedOperations ?? []) as Array<
        Record<string, unknown>
      >;
      expect(ops.some((o) => o['changeType'] === 'CREATE')).toBe(false);
    });

    // A grandchild stack can share a nested-stack row's logical id and type;
    // its mark rides the child deploy's failure out of the row's `update()`,
    // and is its own journal's, never this row's.
    it('journals nothing beside a nested-stack row', async () => {
      const type = 'AWS::CloudFormation::Stack';
      const failure = markCreatedBeforeFailure(new Error('x'), 'B', type, 'grandchild-arn');
      const { engine, provider } = replacingEngine(failure, { type, inPlace: true });
      (provider as unknown as { update: ReturnType<typeof vi.fn> }).update.mockRejectedValue(failure);
      await expect(engine.deploy(stackName, replaceTemplate(type))).rejects.toThrow();
      const segment = journal.appendRollbackJournalSegment.mock.calls[0]?.[2];
      const ops = (segment?.failedOperations ?? []) as Array<Record<string, unknown>>;
      expect(ops.some((o) => o['physicalId'] === 'grandchild-arn')).toBe(false);
    });

    // The automatic rollback deletes the new resource and leaves the replaced
    // record, which still names the live old resource, in state.
    it('the automatic rollback deletes the new resource and keeps the old record', async () => {
      const { engine, provider, saveState } = replacingEngine(
        markCreatedBeforeFailure(new Error('x'), 'B', 'AWS::SQS::Queue', 'b-new'),
        { noRollback: false }
      );
      await expect(engine.deploy(stackName, replaceTemplate())).rejects.toThrow();
      const deleted = provider.delete.mock.calls.map((c: unknown[]) => c[1]);
      expect(deleted).toEqual(['b-new']);
      const saved = saveState.mock.calls.at(-1)![2] as StackState;
      expect(saved.resources['B']?.physicalId).toBe('b-old');
      // The failed UPDATE settles with its orphan: no failed-only segment is
      // kept for a later `--revert-failed` to force-revert the old resource.
      expect(journal.appendRollbackJournalSegment.mock.calls.map((c) => c[2].reason)).toEqual([
        'auto-rollback-started',
      ]);
      expect(journal.popRollbackJournalSegment).toHaveBeenCalled();
    });
  });

  // go-to-k/cdkd#4615: the rollback reverts an in-place update in place even
  // when it changed the physical id, so the provider's answer is journaled.
  describe("journals the provider's wasReplaced on a completed UPDATE (go-to-k/cdkd#4615)", () => {
    async function completedA(opts: {
      wasReplaced?: boolean;
      replacement?: boolean;
      /** Deploy in place first on the SAME engine, then the given shape. */
      reuse?: boolean;
    }) {
      const changeA = {
        logicalId: 'A',
        changeType: 'UPDATE',
        resourceType: 'AWS::SQS::QueuePolicy',
        desiredProperties: { Queues: ['q2', 'q3'] },
        propertyChanges: [
          { path: 'Queues', oldValue: ['q1'], newValue: ['q2', 'q3'], requiresReplacement: opts.replacement === true },
        ],
      } as unknown as ResourceChange;
      const engine = buildEngine({
        changes: new Map([
          ['A', changeA],
          ['B', makeChange('B')],
        ]),
        deps: { A: [], B: ['A'] },
        failOn: new Set(['B']),
        noRollback: true,
        currentEtag: 'e0',
        currentResources: {
          A: {
            physicalId: 'q1',
            resourceType: 'AWS::SQS::QueuePolicy',
            properties: { Queues: ['q1', 'q2', 'q3'] },
            attributes: {},
            dependencies: [],
          },
        },
      });
      const provider = (
        engine as unknown as {
          providerRegistry: { getProviderFor: () => { provider: { update: ReturnType<typeof vi.fn> } } };
        }
      ).providerRegistry.getProviderFor().provider;
      provider.update.mockResolvedValue({
        physicalId: 'q2',
        ...(opts.wasReplaced !== undefined && { wasReplaced: opts.wasReplaced }),
      });
      const tmpl: CloudFormationTemplate = {
        Resources: {
          A: { Type: 'AWS::SQS::QueuePolicy', Properties: { Queues: ['q2', 'q3'] } },
          B: { Type: 'AWS::S3::Bucket', Properties: {} },
        },
      };
      if (opts.reuse) {
        const requested = opts.replacement === true;
        (changeA.propertyChanges as Array<{ requiresReplacement: boolean }>)[0]!.requiresReplacement = false;
        await expect(engine.deploy(stackName, tmpl)).rejects.toThrow();
        (changeA.propertyChanges as Array<{ requiresReplacement: boolean }>)[0]!.requiresReplacement = requested;
      }
      await expect(engine.deploy(stackName, tmpl)).rejects.toThrow();
      const seg = journal.appendRollbackJournalSegment.mock.calls.at(-1)![2];
      return seg.operations.find((o: { logicalId: string }) => o.logicalId === 'A');
    }

    it('records false for an in-place update that moved the physical id', async () => {
      const op = await completedA({ wasReplaced: false });
      expect(op.physicalId).toBe('q2');
      expect(op.wasReplaced).toBe(false);
    });

    it('records false when the provider left the answer out', async () => {
      expect((await completedA({})).wasReplaced).toBe(false);
    });

    it('records true when the provider replaced', async () => {
      expect((await completedA({ wasReplaced: true })).wasReplaced).toBe(true);
    });

    it('records nothing for the replacement arm, where the id change speaks', async () => {
      expect(await completedA({ replacement: true })).not.toHaveProperty('wasReplaced');
    });

    // A reused engine: the previous deploy's in-place answer must not ride
    // onto this deploy's replacement, which would then be reverted in place.
    it("does not carry a previous deploy's answer onto a reused engine's replacement", async () => {
      expect(
        await completedA({ wasReplaced: false, replacement: true, reuse: true })
      ).not.toHaveProperty('wasReplaced');
    });
  });

  it("keeps a nested-stack row's attempted bag when only a CHILD resource's error is marked (go-to-k/cdkd#4355)", async () => {
    // The parent AWS::CloudFormation::Stack row fails because a child resource
    // refused; the child's mark must not strip the parent row's evidence.
    const change = {
      logicalId: 'B',
      changeType: 'CREATE',
      resourceType: 'AWS::S3::Bucket',
      desiredProperties: { p: 'new' },
      propertyChanges: [],
    } as unknown as ResourceChange;
    const engine = buildEngine({ changes: new Map([['B', change]]), deps: { B: [] }, noRollback: true, currentEtag: 'e0' });
    const provider = (
      engine as unknown as {
        providerRegistry: { getProviderFor: () => { provider: { create: ReturnType<typeof vi.fn> } } };
      }
    ).providerRegistry.getProviderFor().provider;
    const child = Object.assign(markRefusedBeforeApplying(new Error('child refused')), { logicalId: 'ChildRule' });
    provider.create.mockRejectedValue(Object.assign(new Error('nested deploy failed', { cause: child }), { logicalId: 'ChildRule' }));

    await expect(engine.deploy(stackName, template)).rejects.toThrow();

    const seg = journal.appendRollbackJournalSegment.mock.calls[0]![2];
    expect(seg.failedOperations[0].logicalId).toBe('B');
    expect(seg.failedOperations[0].attemptedProperties).toEqual({ p: 'new' });
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

  describe('the replacement retain verdict the deploy ACTED ON (issue #2603)', () => {
    // `classifyRollbackOp` used to re-derive this from
    // `previousState.updateReplacePolicy` — a different source than the
    // TEMPLATE read every engine replacement path decides from. These two
    // cases pin the WRITE half: what the engine stamps onto the journal, in
    // the two configurations where the sources disagree. The READ half
    // (which arm each stamp selects) is
    // `rollback-executor-retain-verdict-source.test.ts`.
    //
    // A type with no data to lose, so the property-driven path's stateful
    // guard never fires on the non-Retain arm (the Retain arm skips that guard
    // by construction).
    const REPLACED_TYPE = 'AWS::Glue::SecurityConfiguration';

    function replacementScenario(updateReplacePolicy?: 'Retain'): {
      changes: Map<string, ResourceChange>;
      deps: Record<string, string[]>;
      currentResources: Record<string, ResourceState>;
      template: CloudFormationTemplate;
    } {
      // R is a property-driven replacement (an immutable property changed);
      // F is a CREATE that fails AFTER it, which is what makes the deploy
      // journal R as a completed op in the first place.
      const rChange = {
        logicalId: 'R',
        changeType: 'UPDATE',
        resourceType: REPLACED_TYPE,
        currentProperties: { Mode: 'a' },
        desiredProperties: { Mode: 'b' },
        propertyChanges: [
          { path: 'Mode', oldValue: 'a', newValue: 'b', requiresReplacement: true },
        ],
      } as unknown as ResourceChange;
      return {
        changes: new Map([
          ['R', rChange],
          ['F', makeChange('F')],
        ]),
        deps: { R: [], F: ['R'] },
        currentResources: {
          R: {
            physicalId: 'phys-R-old',
            resourceType: REPLACED_TYPE,
            properties: { Mode: 'a' },
            attributes: {},
            dependencies: [],
            // What the LAST deploy recorded — deliberately the OPPOSITE of the
            // template below in both cases, so a classifier still reading this
            // record answers wrongly and the stamp is the only thing that can
            // be right.
            ...(updateReplacePolicy === 'Retain'
              ? {}
              : { updateReplacePolicy: 'Retain' as const }),
          },
        },
        template: {
          Resources: {
            R: {
              Type: REPLACED_TYPE,
              Properties: { Mode: 'b' },
              ...(updateReplacePolicy && { UpdateReplacePolicy: updateReplacePolicy }),
            },
            F: { Type: 'AWS::S3::Bucket', Properties: {} },
          },
        },
      };
    }

    it('ADD direction: template newly declares Retain → the op records the old resource as retained', async () => {
      const scenario = replacementScenario('Retain');
      const engine = buildEngine({
        changes: scenario.changes,
        deps: scenario.deps,
        failOn: new Set(['F']),
        noRollback: true,
        currentEtag: 'e0',
        currentResources: scenario.currentResources,
      });
      await expect(engine.deploy(stackName, scenario.template)).rejects.toThrow();

      const seg = journal.appendRollbackJournalSegment.mock.calls[0]![2];
      const r = seg.operations.find((o: { logicalId: string }) => o.logicalId === 'R');
      expect(r).toBeDefined();
      expect(r.oldResourceRetained).toBe(true);
      // The disagreement is real in the fixture, not just asserted: the
      // previous record carries NO policy, so the pre-#2603 read would have
      // answered "not retained" for a resource that is still alive.
      expect(r.previousState.updateReplacePolicy).toBeUndefined();
    });

    it('DROP direction: template no longer declares Retain → the op records the old resource as deleted', async () => {
      const scenario = replacementScenario();
      const engine = buildEngine({
        changes: scenario.changes,
        deps: scenario.deps,
        failOn: new Set(['F']),
        noRollback: true,
        currentEtag: 'e0',
        currentResources: scenario.currentResources,
      });
      await expect(engine.deploy(stackName, scenario.template)).rejects.toThrow();

      const seg = journal.appendRollbackJournalSegment.mock.calls[0]![2];
      const r = seg.operations.find((o: { logicalId: string }) => o.logicalId === 'R');
      expect(r).toBeDefined();
      // Present and FALSE, not absent: an absent field is what a pre-#2603
      // journal looks like, and the classifier falls back to the stale record
      // for those — which is precisely the direction that leaves state naming
      // a deleted resource.
      expect(r.oldResourceRetained).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(r, 'oldResourceRetained')).toBe(true);
      expect(r.previousState.updateReplacePolicy).toBe('Retain');
    });

    it('a CREATE op carries NO verdict, so absent keeps meaning "older binary"', async () => {
      // The `change.changeType === 'UPDATE'` scoping on the stamp. Unfenced
      // until review: dropping the guard (stamping every op shape) was green.
      // It matters because the field's whole contract is that ABSENT means "a
      // binary that predates issue #2603 wrote this" -- stamping a CREATE
      // would put a meaningless `false` on ops the classifier never reads,
      // and a later reader could take the field's presence as a signal.
      const scenario = replacementScenario('Retain');
      // A CREATE that SUCCEEDS, so the segment actually contains a non-UPDATE
      // completed op -- `F` fails and therefore never reaches
      // `completedOperations` at all, which would make the negative half of
      // this case vacuous.
      scenario.changes.set('C', makeChange('C'));
      scenario.deps['C'] = [];
      scenario.deps['F'] = ['R', 'C'];
      scenario.template.Resources!['C'] = { Type: 'AWS::S3::Bucket', Properties: {} };
      const engine = buildEngine({
        changes: scenario.changes,
        deps: scenario.deps,
        failOn: new Set(['F']),
        noRollback: true,
        currentEtag: 'e0',
        currentResources: scenario.currentResources,
      });
      await expect(engine.deploy(stackName, scenario.template)).rejects.toThrow();

      const seg = journal.appendRollbackJournalSegment.mock.calls[0]![2];
      const r = seg.operations.find((o: { logicalId: string }) => o.logicalId === 'R');
      // Guard first: `hasOwnProperty.call(undefined, ...)` throws a TypeError
      // rather than failing this assertion cleanly.
      expect(r).toBeDefined();
      // The UPDATE carries it...
      expect(Object.prototype.hasOwnProperty.call(r, 'oldResourceRetained')).toBe(true);
      // ...and every non-UPDATE op in the same segment does not.
      const nonUpdates = seg.operations.filter(
        (o: { changeType: string }) => o.changeType !== 'UPDATE'
      );
      expect(nonUpdates.length).toBeGreaterThan(0);
      for (const o of nonUpdates) {
        expect(Object.prototype.hasOwnProperty.call(o, 'oldResourceRetained')).toBe(false);
      }
    });

    it('the verdict does NOT survive into a second deploy on the same engine', async () => {
      // The per-run `retainedOldOnReplacement` reset. An engine instance is
      // reusable, and a stale `true` would tell the NEXT run's rollback to
      // re-adopt a physical id THIS run deleted — the ADD direction's failure
      // mode, arriving from a completely different deploy. Nothing pinned the
      // reset until the test reviewer removed it and the suite stayed green.
      const retainScenario = replacementScenario('Retain');
      const engine = buildEngine({
        changes: retainScenario.changes,
        deps: retainScenario.deps,
        failOn: new Set(['F']),
        noRollback: true,
        currentEtag: 'e0',
        currentResources: retainScenario.currentResources,
      });
      await expect(engine.deploy(stackName, retainScenario.template)).rejects.toThrow();
      const first = journal.appendRollbackJournalSegment.mock.calls[0]![2];
      expect(
        first.operations.find((o: { logicalId: string }) => o.logicalId === 'R')
          .oldResourceRetained
      ).toBe(true);

      // Same ENGINE, second deploy, template no longer declaring Retain.
      const dropScenario = replacementScenario();
      journal.appendRollbackJournalSegment.mockClear();
      const backend = (
        engine as unknown as { stateBackend: { getState: ReturnType<typeof vi.fn> } }
      ).stateBackend;
      backend.getState.mockResolvedValue({
        state: {
          version: 8,
          stackName,
          region: 'us-east-1',
          resources: dropScenario.currentResources,
          outputs: {},
          lastModified: Date.now(),
        },
        etag: 'e1',
      });
      await expect(engine.deploy(stackName, dropScenario.template)).rejects.toThrow();
      const second = journal.appendRollbackJournalSegment.mock.calls[0]![2];
      expect(
        second.operations.find((o: { logicalId: string }) => o.logicalId === 'R')
          .oldResourceRetained
      ).toBe(false);
    });
  });

  // go-to-k/cdkd#4600: a proven failed-CREATE orphan lives only in the
  // journal, so a SUCCESSFUL deploy acts on it (CloudFormation parity, per its
  // journaled DeletionPolicy) before dropping the journal, and keeps the
  // journal, reduced to it, when the delete fails.
  describe('a successful deploy and a journaled proven orphan (go-to-k/cdkd#4600)', () => {
    const orphanOp = (extra: Record<string, unknown> = {}) => ({
      logicalId: 'Orphan',
      changeType: 'CREATE',
      resourceType: 'AWS::Kinesis::Stream',
      physicalId: 'orphan-stream',
      provisionedBy: 'sdk',
      physicalIdRecoveredFromError: true,
      // go-to-k/cdkd#4655: the provider's live read answers the same token.
      createdResourceIdentity: 'created-token',
      attemptedProperties: {},
      ...extra,
    });
    const journalWith = (op: Record<string, unknown>) => ({
      journalVersion: 1,
      stackName,
      region: 'us-east-1',
      segments: [
        { timestamp: 1, reason: 'no-rollback-failure', initialDeploy: false, operations: [], failedOperations: [op] },
      ],
    });
    function providerOf(engine: DeployEngine) {
      return (
        engine as unknown as {
          providerRegistry: {
            getProviderFor: () => { provider: { delete: ReturnType<typeof vi.fn> } };
          };
        }
      ).providerRegistry.getProviderFor().provider;
    }
    function noChangeEngine(currentResources: Record<string, ResourceState> = {}) {
      const engine = buildEngine({ changes: new Map(), deps: {}, currentEtag: 'e0', currentResources });
      (
        engine as unknown as { diffCalculator: { hasChanges: ReturnType<typeof vi.fn> } }
      ).diffCalculator.hasChanges.mockReturnValue(false);
      return engine;
    }
    const orphanDeletes = (engine: DeployEngine) =>
      providerOf(engine).delete.mock.calls.filter((c: unknown[]) => c[1] === 'orphan-stream');

    it('a no-change deploy deletes the orphan, then the journal', async () => {
      const engine = noChangeEngine();
      journal.loadRollbackJournal.mockResolvedValue(journalWith(orphanOp()));

      const result = await engine.deploy(stackName, template);

      expect(orphanDeletes(engine)).toHaveLength(1);
      expect(orphanDeletes(engine)[0]![0]).toBe('Orphan');
      expect(journal.deleteRollbackJournal).toHaveBeenCalledWith(stackName, 'us-east-1');
      expect(journal.reduceRollbackJournalToFailedOperations).not.toHaveBeenCalled();
      expect(result.deleteSkipped).toBe(0);
    });

    it('a deploy with changes deletes the orphan, then the journal', async () => {
      const engine = buildEngine({ changes: new Map([['A', makeChange('A')]]), deps: { A: [] }, currentEtag: 'e0' });
      journal.loadRollbackJournal.mockResolvedValue(journalWith(orphanOp()));

      const result = await engine.deploy(stackName, template);

      expect(orphanDeletes(engine)).toHaveLength(1);
      expect(journal.deleteRollbackJournal).toHaveBeenCalledWith(stackName, 'us-east-1');
      expect(result.deleteSkipped).toBe(0);
    });

    it('a failed orphan delete keeps the journal, reduced to it, and counts it as unaddressed', async () => {
      const engine = buildEngine({ changes: new Map([['A', makeChange('A')]]), deps: { A: [] }, currentEtag: 'e0' });
      journal.loadRollbackJournal.mockResolvedValue(journalWith(orphanOp()));
      providerOf(engine).delete.mockImplementation((_id: string, physicalId: string) =>
        physicalId === 'orphan-stream' ? Promise.reject(new Error('AccessDenied')) : Promise.resolve(undefined)
      );

      const result = await engine.deploy(stackName, template);

      expect(orphanDeletes(engine).length).toBeGreaterThan(0);
      expect(journal.deleteRollbackJournal).not.toHaveBeenCalled();
      expect(journal.reduceRollbackJournalToFailedOperations).toHaveBeenCalledTimes(1);
      const [stack, region, keep, superseded] = journal.reduceRollbackJournalToFailedOperations.mock.calls[0]!;
      expect([stack, region]).toEqual([stackName, 'us-east-1']);
      const seg = journalWith(orphanOp()).segments[0]!;
      expect(keep(orphanOp(), seg)).toBe(true);
      expect(keep({ ...orphanOp(), logicalId: 'Other' }, seg)).toBe(false);
      expect(superseded).toEqual(['A']);
      expect(result.deleteSkipped).toBe(1);
      const warned = vi.mocked(getLogger().warn).mock.calls.map((c) => String(c[0]));
      const kept = warned.find((w) => w.includes('were not deleted'));
      expect(kept).toContain('is kept with just them; the next successful deploy retries.');
      // A plain rollback has none of the deploy's ownership evidence.
      expect(warned.some((w) => w.includes('cdkd rollback'))).toBe(false);
    });

    it('a journal rewrite that fails keeps the whole journal, marks the deploy ids superseded, and names no rollback', async () => {
      const engine = buildEngine({ changes: new Map([['A', makeChange('A')]]), deps: { A: [] }, currentEtag: 'e0' });
      journal.loadRollbackJournal.mockResolvedValue(journalWith(orphanOp()));
      journal.reduceRollbackJournalToFailedOperations.mockRejectedValue(new Error('PutObject denied'));
      providerOf(engine).delete.mockImplementation((_id: string, physicalId: string) =>
        physicalId === 'orphan-stream' ? Promise.reject(new Error('AccessDenied')) : Promise.resolve(undefined)
      );

      const result = await engine.deploy(stackName, template);

      expect(journal.deleteRollbackJournal).not.toHaveBeenCalled();
      // Retried once before falling back.
      expect(journal.reduceRollbackJournalToFailedOperations).toHaveBeenCalledTimes(2);
      expect(journal.markRollbackJournalSuperseded).toHaveBeenCalledWith(stackName, 'us-east-1', ['A']);
      expect(result.deleteSkipped).toBe(1);
      const warned = vi.mocked(getLogger().warn).mock.calls.map((c) => String(c[0]));
      const kept = warned.find((w) => w.includes('were not deleted'));
      expect(kept).toContain('is kept; the next successful deploy retries.');
      expect(kept).not.toContain('with just them');
      expect(warned.some((w) => w.includes('cdkd rollback'))).toBe(false);
    });

    it('an unexpected failure acting on the journal keeps it and counts one entry', async () => {
      const engine = noChangeEngine();
      // Parsed but not walkable: the supersede pass throws.
      journal.loadRollbackJournal.mockResolvedValue({ journalVersion: 1, segments: 'x' });

      const result = await engine.deploy(stackName, template);

      expect(journal.deleteRollbackJournal).not.toHaveBeenCalled();
      expect(result.deleteSkipped).toBe(1);
    });

    it('that unexpected failure also marks the deploy ids superseded', async () => {
      const engine = buildEngine({ changes: new Map([['A', makeChange('A')]]), deps: { A: [] }, currentEtag: 'e0' });
      journal.loadRollbackJournal.mockResolvedValue({ journalVersion: 1, segments: 'x' });

      await engine.deploy(stackName, template);

      expect(journal.deleteRollbackJournal).not.toHaveBeenCalled();
      expect(journal.markRollbackJournalSuperseded).toHaveBeenCalledWith(stackName, 'us-east-1', ['A']);
    });

    it('a DeletionPolicy: Retain orphan is kept in AWS and the journal is still removed', async () => {
      const engine = noChangeEngine();
      journal.loadRollbackJournal.mockResolvedValue(journalWith(orphanOp({ deletionPolicy: 'Retain' })));

      const result = await engine.deploy(stackName, template);

      expect(orphanDeletes(engine)).toHaveLength(0);
      expect(journal.deleteRollbackJournal).toHaveBeenCalledWith(stackName, 'us-east-1');
      expect(result.deleteSkipped).toBe(0);
    });

    // Review C1: the deploy's own CREATEs are in the saved record, which the
    // classifier compares by physical id; the type rule is for journal entries.
    it("this deploy's CREATE of another resource of the type does not stop the delete", async () => {
      const kinesisA = { ...makeChange('A'), resourceType: 'AWS::Kinesis::Stream' } as ResourceChange;
      const engine = buildEngine({ changes: new Map([['A', kinesisA]]), deps: { A: [] }, currentEtag: 'e0' });
      journal.loadRollbackJournal.mockResolvedValue(journalWith(orphanOp()));

      const result = await engine.deploy(stackName, template);

      expect(orphanDeletes(engine)).toHaveLength(1);
      expect(journal.deleteRollbackJournal).toHaveBeenCalledWith(stackName, 'us-east-1');
      expect(result.deleteSkipped).toBe(0);
    });

    // The rule's (a)/(c) arms: a record under its logical id, or this deploy's
    // op under it, may own the resource. Warned with its physical id, cleared
    // with the journal, counted (exit 2) -- the fix-forward lands here.
    it('a fix-forward re-creating the same logical id under another name: warned, named, not deleted, cleared', async () => {
      const fixForward = { ...makeChange('Orphan'), resourceType: 'AWS::Kinesis::Stream' } as ResourceChange;
      const engine = buildEngine({ changes: new Map([['Orphan', fixForward]]), deps: { Orphan: [] }, currentEtag: 'e0' });
      journal.loadRollbackJournal.mockResolvedValue(journalWith(orphanOp()));

      const result = await engine.deploy(stackName, template);

      expect(orphanDeletes(engine)).toHaveLength(0);
      expect(providerOf(engine).delete).not.toHaveBeenCalled();
      expect(journal.deleteRollbackJournal).toHaveBeenCalledWith(stackName, 'us-east-1');
      expect(journal.reduceRollbackJournalToFailedOperations).not.toHaveBeenCalled();
      expect(result.deleteSkipped).toBe(1);
      const warned = vi.mocked(getLogger().warn).mock.calls.map((c) => String(c[0]));
      const skip = warned.find((w) => w.includes('Skipping failed CREATE of Orphan'));
      expect(skip).toContain('orphan-stream');
      expect(skip).toContain('delete it manually');
      expect(warned.some((w) => w.includes('--revert-failed') || w.includes('cdkd rollback'))).toBe(false);
    });

    // Review CODE-M1: the record tracks this very resource (an idempotent
    // create, an adoption) -- settled silently, never "delete it manually".
    it('a state record under its logical id holding the SAME resource: not deleted, silent, exit 0', async () => {
      const engine = noChangeEngine({
        Orphan: { physicalId: 'orphan-stream', resourceType: 'AWS::Kinesis::Stream', properties: {}, attributes: {}, dependencies: [] },
      });
      journal.loadRollbackJournal.mockResolvedValue(journalWith(orphanOp()));

      const result = await engine.deploy(stackName, template);

      expect(orphanDeletes(engine)).toHaveLength(0);
      expect(journal.deleteRollbackJournal).toHaveBeenCalledWith(stackName, 'us-east-1');
      expect(result.deleteSkipped).toBe(0);
      const warned = vi.mocked(getLogger().warn).mock.calls.map((c) => String(c[0]));
      expect(warned.some((w) => w.includes('delete it manually'))).toBe(false);
    });

    it("this deploy's completed DELETE under its logical id (no record left): not deleted, counted", async () => {
      const del = {
        ...makeChange('Orphan'),
        changeType: 'DELETE',
        resourceType: 'AWS::Kinesis::Stream',
      } as unknown as ResourceChange;
      const engine = buildEngine({
        changes: new Map([['Orphan', del]]),
        deps: { Orphan: [] },
        currentEtag: 'e0',
        currentResources: {
          Orphan: { physicalId: 'other-stream', resourceType: 'AWS::Kinesis::Stream', properties: {}, attributes: {}, dependencies: [] },
        },
      });
      journal.loadRollbackJournal.mockResolvedValue(journalWith(orphanOp()));

      const result = await engine.deploy(stackName, template);

      expect(orphanDeletes(engine)).toHaveLength(0);
      expect(providerOf(engine).delete.mock.calls.map((c: unknown[]) => c[1])).toEqual(['other-stream']);
      expect(result.deleteSkipped).toBe(1);
    });

    it('a NEWER journal segment completing a CREATE of the type still supersedes it: warned, not deleted, counted', async () => {
      const engine = noChangeEngine();
      const j = journalWith(orphanOp());
      (j.segments as unknown[]).push({
        timestamp: 2,
        reason: 'no-rollback-failure',
        initialDeploy: false,
        operations: [{ logicalId: 'Other', changeType: 'CREATE', resourceType: 'AWS::Kinesis::Stream', physicalId: 'x' }],
      });
      journal.loadRollbackJournal.mockResolvedValue(j);

      const result = await engine.deploy(stackName, template);

      expect(orphanDeletes(engine)).toHaveLength(0);
      expect(journal.deleteRollbackJournal).toHaveBeenCalledWith(stackName, 'us-east-1');
      expect(result.deleteSkipped).toBe(1);
    });

    it('a rollback-orphan record holding its logical id owns it: not deleted', async () => {
      const engine = buildEngine({ changes: new Map(), deps: {}, currentEtag: 'e0' });
      (
        engine as unknown as { diffCalculator: { hasChanges: ReturnType<typeof vi.fn> } }
      ).diffCalculator.hasChanges.mockReturnValue(false);
      const backend = (engine as unknown as { stateBackend: { getState: ReturnType<typeof vi.fn> } }).stateBackend;
      backend.getState.mockResolvedValue({
        state: {
          version: 8,
          stackName,
          region: 'us-east-1',
          resources: {},
          outputs: {},
          orphans: [
            {
              logicalId: 'Orphan',
              orphanedAt: 1,
              state: { physicalId: 'kept-elsewhere', resourceType: 'AWS::Kinesis::Stream', properties: {} },
            },
          ],
          lastModified: 0,
        },
        etag: 'e0',
      });
      journal.loadRollbackJournal.mockResolvedValue(journalWith(orphanOp()));

      await engine.deploy(stackName, template);

      expect(orphanDeletes(engine)).toHaveLength(0);
    });

    it('another stack record holding the same type and physical id: not deleted, warned, cleared, counted', async () => {
      const engine = noChangeEngine();
      const backend = (
        engine as unknown as {
          stateBackend: { getState: ReturnType<typeof vi.fn>; listStacks: ReturnType<typeof vi.fn> };
        }
      ).stateBackend;
      backend.listStacks.mockResolvedValue([
        { stackName, region: 'us-east-1' },
        { stackName: 'OtherStack', region: 'eu-west-1' },
      ]);
      const own = backend.getState.getMockImplementation() as ((...a: unknown[]) => Promise<unknown>) | undefined;
      backend.getState.mockImplementation((name: string, region: string) =>
        name === 'OtherStack'
          ? Promise.resolve({
              state: {
                resources: {
                  Recreated: { physicalId: 'orphan-stream', resourceType: 'AWS::Kinesis::Stream', properties: {} },
                },
              },
            })
          : own
            ? own(name, region)
            : Promise.resolve(null)
      );
      journal.loadRollbackJournal.mockResolvedValue(journalWith(orphanOp()));

      const result = await engine.deploy(stackName, template);

      expect(orphanDeletes(engine)).toHaveLength(0);
      // Demoted and cleared, never kept deletable.
      expect(journal.deleteRollbackJournal).toHaveBeenCalledWith(stackName, 'us-east-1');
      expect(journal.reduceRollbackJournalToFailedOperations).not.toHaveBeenCalled();
      expect(result.deleteSkipped).toBe(1);
      const warned = vi.mocked(getLogger().warn).mock.calls.map((c) => String(c[0]));
      expect(warned.some((w) => w.includes('is not deleted') && w.includes('OtherStack'))).toBe(true);
      expect(warned.some((w) => w.includes('Skipping failed CREATE of Orphan'))).toBe(true);
    });

    // Review SPEC-m4: a cleared entry's demotion lives in memory; a journal
    // that survives must not keep it as proven for a scan-less rollback.
    function foreignHeld(engine: DeployEngine) {
      const backend = (
        engine as unknown as {
          stateBackend: { getState: ReturnType<typeof vi.fn>; listStacks: ReturnType<typeof vi.fn> };
        }
      ).stateBackend;
      backend.listStacks.mockResolvedValue([{ stackName: 'OtherStack', region: 'us-east-1' }]);
      const own = backend.getState.getMockImplementation()! as (...a: unknown[]) => Promise<unknown>;
      backend.getState.mockImplementation((name: string, region: string) =>
        name === 'OtherStack'
          ? Promise.resolve({
              state: { resources: { R: { physicalId: 'orphan-stream', resourceType: 'AWS::Kinesis::Stream' } } },
            })
          : own(name, region)
      );
    }

    it('a journal delete that fails strips the cleared (demoted) entry from the surviving journal', async () => {
      const engine = noChangeEngine();
      foreignHeld(engine);
      journal.loadRollbackJournal.mockResolvedValue(journalWith(orphanOp()));
      journal.deleteRollbackJournal.mockResolvedValue(false);

      await engine.deploy(stackName, template);

      expect(orphanDeletes(engine)).toHaveLength(0);
      expect(journal.dropRollbackJournalFailedOperations).toHaveBeenCalledTimes(1);
      const [stack, region, drop] = journal.dropRollbackJournalFailedOperations.mock.calls[0]!;
      expect([stack, region]).toEqual([stackName, 'us-east-1']);
      const seg = journalWith(orphanOp()).segments[0]!;
      expect(drop(orphanOp(), seg)).toBe(true);
      expect(drop({ ...orphanOp(), logicalId: 'Other' }, seg)).toBe(false);
    });

    it('a strip that also fails names the remedy: a successful deploy before any rollback or destroy', async () => {
      const engine = noChangeEngine();
      foreignHeld(engine);
      journal.loadRollbackJournal.mockResolvedValue(journalWith(orphanOp()));
      journal.deleteRollbackJournal.mockResolvedValue(false);
      journal.dropRollbackJournalFailedOperations.mockRejectedValue(new Error('PutObject denied'));

      // The deploy itself still succeeds: the strip is best-effort.
      const result = await engine.deploy(stackName, template);

      expect(result.deleteSkipped).toBe(1);
      expect(journal.dropRollbackJournalFailedOperations).toHaveBeenCalledTimes(1);
      const warned = vi.mocked(getLogger().warn).mock.calls.map((c) => String(c[0]));
      const strip = warned.find((w) => w.includes('Failed to remove the settled entries'));
      expect(strip).toContain('run a successful cdkd deploy of the stack first');
    });

    // Review CODE-M1's type check: a record of ANOTHER type holding the same id
    // string is a different resource, so it neither tracks nor saves the orphan.
    it('a record of another type holding the same id string does not track it: the foreign holder still demotes', async () => {
      const engine = noChangeEngine({
        Queue: { physicalId: 'orphan-stream', resourceType: 'AWS::SQS::Queue', properties: {}, attributes: {}, dependencies: [] },
      });
      foreignHeld(engine);
      journal.loadRollbackJournal.mockResolvedValue(journalWith(orphanOp()));

      const result = await engine.deploy(stackName, template);

      expect(orphanDeletes(engine)).toHaveLength(0);
      expect(result.deleteSkipped).toBe(1);
      const warned = vi.mocked(getLogger().warn).mock.calls.map((c) => String(c[0]));
      expect(warned.some((w) => w.includes('Skipping failed CREATE of Orphan'))).toBe(true);
    });

    // Review CODE-N1: a record holding the orphan's very resource tracks it,
    // even when the record under its logical id holds another one.
    it('tracked under another logical id while its own id holds another resource: settled silently', async () => {
      const engine = noChangeEngine({
        Orphan: { physicalId: 'new-stream', resourceType: 'AWS::Kinesis::Stream', properties: {}, attributes: {}, dependencies: [] },
        Adopted: { physicalId: 'orphan-stream', resourceType: 'AWS::Kinesis::Stream', properties: {}, attributes: {}, dependencies: [] },
      });
      journal.loadRollbackJournal.mockResolvedValue(journalWith(orphanOp()));

      const result = await engine.deploy(stackName, template);

      expect(orphanDeletes(engine)).toHaveLength(0);
      expect(result.deleteSkipped).toBe(0);
      const warned = vi.mocked(getLogger().warn).mock.calls.map((c) => String(c[0]));
      expect(warned.some((w) => w.includes('manual attention') || w.includes('delete it manually'))).toBe(false);
      expect(journal.deleteRollbackJournal).toHaveBeenCalledWith(stackName, 'us-east-1');
    });

    it('a journal delete that succeeds strips nothing', async () => {
      const engine = noChangeEngine();
      foreignHeld(engine);
      journal.loadRollbackJournal.mockResolvedValue(journalWith(orphanOp()));
      journal.deleteRollbackJournal.mockResolvedValue(true);

      await engine.deploy(stackName, template);

      expect(journal.dropRollbackJournalFailedOperations).not.toHaveBeenCalled();
    });

    it('a reduce that fails twice strips the cleared entries from the whole journal it keeps', async () => {
      const engine = noChangeEngine();
      foreignHeld(engine);
      const j = journalWith(orphanOp());
      // A second entry whose delete fails, so the journal is kept.
      j.segments[0]!.failedOperations.push(
        orphanOp({ logicalId: 'Failing', physicalId: 'failing-stream' }) as never
      );
      journal.loadRollbackJournal.mockResolvedValue(j);
      journal.reduceRollbackJournalToFailedOperations.mockRejectedValue(new Error('PutObject denied'));
      providerOf(engine).delete.mockImplementation((_id: string, physicalId: string) =>
        physicalId === 'failing-stream' ? Promise.reject(new Error('AccessDenied')) : Promise.resolve(undefined)
      );

      const result = await engine.deploy(stackName, template);

      expect(journal.deleteRollbackJournal).not.toHaveBeenCalled();
      expect(journal.dropRollbackJournalFailedOperations).toHaveBeenCalledTimes(1);
      const drop = journal.dropRollbackJournalFailedOperations.mock.calls[0]![2];
      const seg = j.segments[0]!;
      expect(drop(orphanOp(), seg)).toBe(true);
      expect(drop(orphanOp({ logicalId: 'Failing', physicalId: 'failing-stream' }), seg)).toBe(false);
      expect(result.deleteSkipped).toBe(2);
    });

    it("the stack's own record in the listing is not another holder: the orphan is deleted", async () => {
      const engine = noChangeEngine();
      const backend = (
        engine as unknown as {
          stateBackend: { getState: ReturnType<typeof vi.fn>; listStacks: ReturnType<typeof vi.fn> };
        }
      ).stateBackend;
      backend.listStacks.mockResolvedValue([{ stackName, region: 'us-east-1' }]);
      const own = backend.getState.getMockImplementation()! as (...a: unknown[]) => Promise<unknown>;
      // A stale copy of this stack's own record naming the orphan's id: the
      // classifier judges this stack, the scan only the others.
      backend.getState.mockImplementation(async (name: string, region: string) => {
        const got = (await own(name, region)) as { state: Record<string, unknown> } | null;
        return got && backend.listStacks.mock.calls.length > 0
          ? {
              ...got,
              state: {
                ...got.state,
                resources: { Stale: { physicalId: 'orphan-stream', resourceType: 'AWS::Kinesis::Stream' } },
              },
            }
          : got;
      });
      journal.loadRollbackJournal.mockResolvedValue(journalWith(orphanOp()));

      const result = await engine.deploy(stackName, template);

      expect(backend.listStacks).toHaveBeenCalled();
      expect(orphanDeletes(engine)).toHaveLength(1);
      expect(result.deleteSkipped).toBe(0);
    });

    it('a state record the scan cannot read keeps the entry (fail closed)', async () => {
      const engine = noChangeEngine();
      const backend = (
        engine as unknown as {
          stateBackend: { getState: ReturnType<typeof vi.fn>; listStacks: ReturnType<typeof vi.fn> };
        }
      ).stateBackend;
      backend.listStacks.mockResolvedValue([{ stackName: 'Broken', region: 'us-east-1' }]);
      const own = backend.getState.getMockImplementation()! as (...a: unknown[]) => Promise<unknown>;
      backend.getState.mockImplementation((name: string, region: string) =>
        name === 'Broken' ? Promise.reject(new Error('parse error')) : own(name, region)
      );
      journal.loadRollbackJournal.mockResolvedValue(journalWith(orphanOp()));

      const result = await engine.deploy(stackName, template);

      expect(orphanDeletes(engine)).toHaveLength(0);
      expect(journal.deleteRollbackJournal).not.toHaveBeenCalled();
      expect(journal.reduceRollbackJournalToFailedOperations).toHaveBeenCalledTimes(1);
      expect(result.deleteSkipped).toBe(1);
    });

    it('a journal with no orphan never scans the bucket', async () => {
      const engine = noChangeEngine();
      journal.loadRollbackJournal.mockResolvedValue(journalWith({ ...orphanOp(), physicalIdRecoveredFromError: undefined }));

      await engine.deploy(stackName, template);

      const backend = (engine as unknown as { stateBackend: { listStacks: ReturnType<typeof vi.fn> } }).stateBackend;
      expect(backend.listStacks).not.toHaveBeenCalled();
    });

    it('DeletionPolicy: Snapshot on a type with no final snapshot is refused: kept and counted', async () => {
      const engine = noChangeEngine();
      journal.loadRollbackJournal.mockResolvedValue(journalWith(orphanOp({ deletionPolicy: 'Snapshot' })));

      const result = await engine.deploy(stackName, template);

      expect(orphanDeletes(engine)).toHaveLength(0);
      expect(journal.deleteRollbackJournal).not.toHaveBeenCalled();
      expect(result.deleteSkipped).toBe(1);
    });

    it('a state record holding the orphan id under another logical id owns it: not deleted, exit 0', async () => {
      const engine = noChangeEngine({
        Adopted: {
          physicalId: 'orphan-stream',
          resourceType: 'AWS::Kinesis::Stream',
          properties: {},
          attributes: {},
          dependencies: [],
        },
      });
      journal.loadRollbackJournal.mockResolvedValue(journalWith(orphanOp()));

      const result = await engine.deploy(stackName, template);
      expect(result.deleteSkipped).toBe(0);

      expect(orphanDeletes(engine)).toHaveLength(0);
      expect(journal.deleteRollbackJournal).toHaveBeenCalledWith(stackName, 'us-east-1');
    });

    it('an unreadable journal is still removed, with a warning', async () => {
      const engine = noChangeEngine();
      journal.loadRollbackJournal.mockRejectedValue(new Error('bad journalVersion'));

      const result = await engine.deploy(stackName, template);

      expect(journal.deleteRollbackJournal).toHaveBeenCalledWith(stackName, 'us-east-1');
      expect(result.deleteSkipped).toBe(0);
      const warned = vi.mocked(getLogger().warn).mock.calls.map((c) => String(c[0]));
      expect(warned.some((w) => w.includes('the successful deploy removes the journal'))).toBe(true);
    });
  });
});
