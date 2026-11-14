/**
 * A successful deploy writes the deployed template's `dependencies` onto every
 * record the template still declares, a NO_CHANGE one included
 * (go-to-k/cdkd#6308). The diff ignores `DependsOn`, so a record whose only
 * change was its explicit dependency is never provisioned; before the fix it
 * kept the list an older template wrote, and a reversed dependency left both
 * directions in state, which `cdkd destroy` refused as a cycle.
 *
 * Pinned on both save paths: the change path (one record updated, the other
 * NO_CHANGE) and the no-change path (every record NO_CHANGE, so the save
 * happens only because a list moved). A record already holding the template's
 * list, in any order, writes nothing on a no-change deploy.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import {
  hasDependencyCycle,
  withRecordedDependencies,
  withTemplateDependencies,
} from '../../../src/deployment/deploy-engine/record-shape.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { RollbackJournalSegment } from '../../../src/types/rollback-journal.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

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

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

const SSM = 'AWS::SSM::Parameter';
const STACK = 'DepFlip6308';

/** v2 of the repro: B now depends on A (v1 had A depend on B), B's value changed. */
const v2Template = (): CloudFormationTemplate => ({
  Resources: {
    A: { Type: SSM, Properties: { Type: 'String', Value: 'a' } },
    B: { Type: SSM, Properties: { Type: 'String', Value: 'b2' }, DependsOn: ['A'] },
  },
});

const record = (physicalId: string, value: string, dependencies?: string[]): ResourceState => ({
  physicalId,
  resourceType: SSM,
  properties: { Type: 'String', Value: value },
  observedProperties: { Type: 'String', Value: value },
  attributes: {},
  ...(dependencies && { dependencies }),
});

const stateWith = (resources: Record<string, ResourceState>): StackState => ({
  version: STATE_SCHEMA_VERSION_CURRENT,
  region: 'us-east-1',
  stackName: STACK,
  resources,
  outputs: {},
  exportNames: [],
  lastModified: 0,
});

describe('a deploy refreshes recorded dependencies from the template (#6308)', () => {
  let mockProvider: Record<string, ReturnType<typeof vi.fn>>;
  let mockStateBackend: Record<string, ReturnType<typeof vi.fn>>;
  let mockDiffCalculator: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider = {
      create: vi.fn(),
      update: vi.fn().mockResolvedValue({ physicalId: 'b-phys', wasReplaced: false }),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(undefined),
    };
    mockDiffCalculator = {
      calculateDiff: vi.fn(),
      hasChanges: vi.fn(),
      filterByType: vi
        .fn()
        .mockImplementation((changes: Map<string, ResourceChange>, type: string) =>
          Array.from(changes.values()).filter((c) => c.changeType === type)
        ),
    };
    mockStateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-new'),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
      rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
      warmConnections: vi.fn().mockResolvedValue(undefined),
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
    };
  });

  function makeEngine(levels: string[][], nested = false): DeployEngine {
    return new DeployEngine(
      mockStateBackend as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue(levels),
        getDirectDependencies: vi.fn().mockReturnValue([]),
      } as never,
      mockDiffCalculator as never,
      {
        getProvider: vi.fn().mockReturnValue(mockProvider),
        getProviderFor: vi.fn().mockReturnValue({ provider: mockProvider, provisionedBy: 'sdk' }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
      } as never,
      {
        dryRun: false,
        ...(nested && {
          parentStackInfo: {
            parentStack: 'Parent',
            parentLogicalId: 'Child',
            parentRegion: 'us-east-1',
          },
        }),
      },
      'us-east-1'
    );
  }

  function prime(state: StackState, changes: ResourceChange[]): void {
    mockStateBackend.getState!.mockResolvedValue({ state, etag: 'etag-old' });
    mockDiffCalculator.hasChanges!.mockReturnValue(
      changes.some((c) => c.changeType !== 'NO_CHANGE')
    );
    mockDiffCalculator.calculateDiff!.mockResolvedValue(
      new Map(changes.map((c) => [c.logicalId, c]))
    );
  }

  const journaledSegment = (): RollbackJournalSegment => {
    expect(mockStateBackend.appendRollbackJournalSegment).toHaveBeenCalledOnce();
    return mockStateBackend.appendRollbackJournalSegment!.mock.calls[0]![2] as RollbackJournalSegment;
  };

  const lastSaved = (): StackState =>
    mockStateBackend.saveState!.mock.calls.at(-1)![2] as StackState;

  it('change path: the NO_CHANGE record drops the v1 edge the reversed dependency replaced', async () => {
    prime(stateWith({ A: record('a-phys', 'a', ['B']), B: record('b-phys', 'b') }), [
      { logicalId: 'A', changeType: 'NO_CHANGE', resourceType: SSM },
      {
        logicalId: 'B',
        changeType: 'UPDATE',
        resourceType: SSM,
        currentProperties: { Type: 'String', Value: 'b' },
        desiredProperties: { Type: 'String', Value: 'b2' },
        propertyChanges: [{ path: 'Value', oldValue: 'b', newValue: 'b2', requiresReplacement: false }],
      },
    ]);

    await makeEngine([['B']]).deploy(STACK, v2Template());

    expect(mockProvider.update).toHaveBeenCalledTimes(1);
    const saved = lastSaved();
    expect(saved.resources['B']?.dependencies).toEqual(['A']);
    // The stale v1 edge is gone: with it, A -> B and B -> A were both recorded.
    expect(saved.resources['A']?.dependencies).toBeUndefined();
    expect(saved.resources['A']?.physicalId).toBe('a-phys');
  });

  it('no-change path: a DependsOn-only difference saves the refreshed lists', async () => {
    // The state the pre-fix binary left behind: both directions recorded.
    prime(stateWith({ A: record('a-phys', 'a', ['B']), B: record('b-phys', 'b2', ['A']) }), [
      { logicalId: 'A', changeType: 'NO_CHANGE', resourceType: SSM },
      { logicalId: 'B', changeType: 'NO_CHANGE', resourceType: SSM },
    ]);

    await makeEngine([]).deploy(STACK, v2Template());

    expect(mockProvider.update).not.toHaveBeenCalled();
    expect(mockStateBackend.saveState).toHaveBeenCalledTimes(1);
    const saved = lastSaved();
    expect(saved.resources['A']?.dependencies).toBeUndefined();
    expect(saved.resources['B']?.dependencies).toEqual(['A']);
    expect(saved.resources['A']?.observedProperties).toEqual({ Type: 'String', Value: 'a' });
  });

  const updateB = (): ResourceChange => ({
    logicalId: 'B',
    changeType: 'UPDATE',
    resourceType: SSM,
    currentProperties: { Type: 'String', Value: 'b' },
    desiredProperties: { Type: 'String', Value: 'b2' },
    propertyChanges: [{ path: 'Value', oldValue: 'b', newValue: 'b2', requiresReplacement: false }],
  });

  it('a failed deploy keeps the unchanged record\'s list on every save', async () => {
    mockProvider.update!.mockRejectedValue(new Error('update refused'));
    prime(stateWith({ A: record('a-phys', 'a', ['B']), B: record('b-phys', 'b') }), [
      { logicalId: 'A', changeType: 'NO_CHANGE', resourceType: SSM },
      updateB(),
    ]);

    await expect(makeEngine([['B']]).deploy(STACK, v2Template())).rejects.toThrow();

    expect(mockStateBackend.saveState).toHaveBeenCalled();
    for (const call of mockStateBackend.saveState!.mock.calls) {
      expect((call[2] as StackState).resources['A']?.dependencies).toEqual(['B']);
    }
  });

  // Old U -> X, new X -> U with U updated: a failed parent reverts U to its
  // old record, so a child that gave X the new edge would record U <-> X.
  it('nested child: an unchanged record drops stale ids but gains none', async () => {
    const template: CloudFormationTemplate = {
      Resources: {
        A: { Type: SSM, Properties: { Type: 'String', Value: 'a' }, DependsOn: ['B'] },
        B: { Type: SSM, Properties: { Type: 'String', Value: 'b2' } },
        C: { Type: SSM, Properties: { Type: 'String', Value: 'c' } },
      },
    };
    // B (updated) listed A in the old template; A now lists B. C listed B, which it no longer does.
    prime(
      stateWith({
        A: record('a-phys', 'a'),
        B: record('b-phys', 'b', ['A']),
        C: record('c-phys', 'c', ['B']),
      }),
      [
        { logicalId: 'A', changeType: 'NO_CHANGE', resourceType: SSM },
        updateB(),
        { logicalId: 'C', changeType: 'NO_CHANGE', resourceType: SSM },
      ]
    );

    await makeEngine([['B']], true).deploy('Parent~Child', template);

    const saved = lastSaved();
    expect(saved.resources['A']?.dependencies).toBeUndefined();
    expect(saved.resources['C']?.dependencies).toBeUndefined();
    expect(saved.resources['B']?.dependencies).toBeUndefined();
     // go-to-k/cdkd#6314: the journaled halves of the trim. C's pre-deploy list
    // for a failed parent's revert (A had none, B was updated); A's template
    // list for the root's success.
    const segment = journaledSegment();
    expect(segment.previousDependencies).toEqual({ C: ['B'] });
    expect(segment.templateDependencies).toEqual({ A: ['B'] });
  });

  it('nested child, no-change path: the stale edge of a reversed dependency is dropped', async () => {
    prime(stateWith({ A: record('a-phys', 'a', ['B']), B: record('b-phys', 'b2') }), [
      { logicalId: 'A', changeType: 'NO_CHANGE', resourceType: SSM },
      { logicalId: 'B', changeType: 'NO_CHANGE', resourceType: SSM },
    ]);

    await makeEngine([], true).deploy('Parent~Child', v2Template());

    expect(mockStateBackend.saveState).toHaveBeenCalledTimes(1);
    const saved = lastSaved();
    expect(saved.resources['A']?.dependencies).toBeUndefined();
    // Gains nothing: B's new edge to A is not added to the unchanged record.
    expect(saved.resources['B']?.dependencies).toBeUndefined();
     const segment = journaledSegment();
    expect(segment.previousDependencies).toEqual({ A: ['B'] });
    expect(segment.templateDependencies).toEqual({ B: ['A'] });
  });

  it('nested child: lists already matching the template journal neither half', async () => {
    prime(stateWith({ A: record('a-phys', 'a'), B: record('b-phys', 'b2', ['A']) }), [
      { logicalId: 'A', changeType: 'NO_CHANGE', resourceType: SSM },
      { logicalId: 'B', changeType: 'NO_CHANGE', resourceType: SSM },
    ]);

    await makeEngine([], true).deploy('Parent~Child', v2Template());

    const segment = journaledSegment();
    expect(segment.reason).toBe('nested-pending-parent');
    expect('previousDependencies' in segment).toBe(false);
    expect('templateDependencies' in segment).toBe(false);
  });

  it('no-change path: lists already matching (any order) write nothing', async () => {
    const template: CloudFormationTemplate = {
      Resources: {
        A: { Type: SSM, Properties: { Type: 'String', Value: 'a' } },
        C: { Type: SSM, Properties: { Type: 'String', Value: 'c' } },
        B: { Type: SSM, Properties: { Type: 'String', Value: { Ref: 'C' } }, DependsOn: ['A'] },
      },
    };
    prime(
      stateWith({
        A: record('a-phys', 'a'),
        B: record('b-phys', 'c-phys', ['C', 'A']),
        C: record('c-phys', 'c'),
      }),
      ['A', 'B', 'C'].map((logicalId) => ({ logicalId, changeType: 'NO_CHANGE', resourceType: SSM }))
    );

    await makeEngine([]).deploy(STACK, template);

    expect(mockStateBackend.saveState).not.toHaveBeenCalled();
  });
});

describe('withRecordedDependencies / hasDependencyCycle (go-to-k/cdkd#6314)', () => {
  it('sets the named lists on records it holds, copying only those, and never mutates the input', () => {
    const a = record('a-phys', 'a');
    const b = record('b-phys', 'b', ['A']);
    const input = { A: a, B: b };
    const out = withRecordedDependencies(input, { A: [], B: ['A', 'Gone'], Missing: ['A'] })!;
    expect(out['A']).toBe(a);
    expect(out['B']!.dependencies).toEqual(['A', 'Gone']);
    expect(out['B']!.properties).toBe(b.properties);
    expect(b.dependencies).toEqual(['A']);
    expect('Missing' in out).toBe(false);
    expect('dependencies' in withRecordedDependencies(input, { B: [] })!['B']!).toBe(false);
  });

  it('returns undefined when nothing changes, or when the result would hold a cycle', () => {
    const input = { A: record('a-phys', 'a'), B: record('b-phys', 'b', ['A']) };
    expect(withRecordedDependencies(input, { B: ['A'] })).toBeUndefined();
    expect(withRecordedDependencies(input, { A: ['B'] })).toBeUndefined();
  });

  it('finds a cycle through any length, ignoring ids the records do not hold', () => {
    const r = (deps: string[]) => record('p', 'v', deps);
    expect(hasDependencyCycle({ A: r(['B']), B: r(['C']), C: r(['A']) })).toBe(true);
    expect(hasDependencyCycle({ A: r(['A']) })).toBe(true);
    expect(hasDependencyCycle({ A: r(['B', 'X']), B: r(['C']), C: r([]), D: r(['A', 'C']) })).toBe(false);
  });
});

describe('withTemplateDependencies (#6308)', () => {
  const template = v2Template();

  it('removalsOnly keeps the ids the template still lists and adds none', () => {
    const out = withTemplateDependencies(
      { A: record('a-phys', 'a', ['B', 'Gone']), B: record('b-phys', 'b2') },
      { Resources: { ...template.Resources, A: { Type: SSM, DependsOn: ['B'] } } },
      { removalsOnly: true }
    )!;
    expect(out['A']!.dependencies).toEqual(['B']);
    expect(out['B']!.dependencies).toBeUndefined();
  });

  it('leaves a record the template no longer declares as it is', () => {
    const kept = record('gone-phys', 'x', ['A']);
    expect(withTemplateDependencies({ Gone: kept }, template)).toBeUndefined();
  });

  it('copies only the record it changes, keeping its bags by identity, and never mutates the input', () => {
    const a = record('a-phys', 'a', ['B']);
    const b = record('b-phys', 'b2', ['A']);
    const input = { A: a, B: b };
    const out = withTemplateDependencies(input, template)!;
    expect(out).not.toBe(input);
    expect(a.dependencies).toEqual(['B']);
    expect(out['B']).toBe(b);
    expect(out['A']).not.toBe(a);
    expect(out['A']!.properties).toBe(a.properties);
    expect(out['A']!.observedProperties).toBe(a.observedProperties);
    expect(out['A']!.attributes).toBe(a.attributes);
    expect('dependencies' in out['A']!).toBe(false);
  });

  it('adds a list to a record that had none', () => {
    const out = withTemplateDependencies(
      { A: record('a-phys', 'a'), B: record('b-phys', 'b2') },
      template
    )!;
    expect(out['B']!.dependencies).toEqual(['A']);
  });

  it('filters template Parameters out, like a create does (#1032)', () => {
    const withParam: CloudFormationTemplate = {
      Parameters: { Stage: { Type: 'String' } },
      Resources: { A: { Type: SSM, Properties: { Type: 'String', Value: { Ref: 'Stage' } } } },
    };
    expect(withTemplateDependencies({ A: record('a-phys', 'a', ['Stage']) }, withParam)).toEqual({
      A: record('a-phys', 'a'),
    });
  });
});
