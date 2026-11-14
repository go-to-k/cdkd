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
import { withTemplateDependencies } from '../../../src/deployment/deploy-engine/record-shape.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
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

  function makeEngine(levels: string[][]): DeployEngine {
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
      { dryRun: false },
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

describe('withTemplateDependencies (#6308)', () => {
  const template = v2Template();

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
