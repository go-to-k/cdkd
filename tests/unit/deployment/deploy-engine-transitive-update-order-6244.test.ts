/**
 * go-to-k/cdkd#6244: on an update deploy, a changed resource that reads
 * another changed resource THROUGH an unchanged one waits for it. The
 * create/update phase used to keep only the direct dependencies that were
 * themselves provisioned, so `MyRes` → unchanged `cr.Provider` framework
 * function → changed `onEvent` function lost its only edge and `MyRes` ran
 * in parallel with (and before) the handler's update.
 *
 * Driven through `DeployEngine.deploy` with the REAL `DiffCalculator` and
 * `DagBuilder`, so the NO_CHANGE classification and the DAG are production's;
 * only the provider is a double that records when each update starts and ends.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { DagBuilder } from '../../../src/analyzer/dag-builder.js';
import { nearestMemberDependencies } from '../../../src/deployment/deploy-engine/dependencies.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

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

const renderer = {
  start: vi.fn(),
  stop: vi.fn(),
  addTask: vi.fn(),
  removeTask: vi.fn(),
  updateTaskLabel: vi.fn(),
  printAbove: (write: () => void) => write(),
};
vi.mock('../../../src/utils/live-renderer.js', () => ({ getLiveRenderer: () => renderer }));

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

const STACK = 'transitive-update-order-stack';
const REGION = 'us-east-1';
const PARAM = 'AWS::SSM::Parameter';

type Value = string | Record<string, unknown>;

/** An SSM parameter named after its logical id, holding `value`. */
const param = (name: string, value: Value): CloudFormationTemplate['Resources'][string] => ({
  Type: PARAM,
  Properties: { Name: name, Type: 'String', Value: value },
});

/** The prior record of `param(name, value)`, with `value` already resolved. */
const record = (name: string, value: string, deps: string[]): ResourceState => {
  const properties = { Name: name, Type: 'String', Value: value };
  return {
    physicalId: name,
    resourceType: PARAM,
    properties,
    observedProperties: properties,
    attributes: {},
    dependencies: deps,
    provisionedBy: 'sdk',
  } as ResourceState;
};

const join = (...parts: unknown[]): Record<string, unknown> => ({ 'Fn::Join': ['', parts] });

describe('DeployEngine - update order through unchanged resources (go-to-k/cdkd#6244)', () => {
  let events: string[];
  let provider: Record<'create' | 'update' | 'delete' | 'getAttribute', ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    events = [];
    provider = {
      create: vi.fn(),
      // Each update yields for a few ticks, so a reader dispatched in parallel
      // starts before its dependency ends — the bug's observable.
      update: vi.fn(async (logicalId: string, physicalId: string) => {
        events.push(`start:${logicalId}`);
        await new Promise((resolve) => setTimeout(resolve, 15));
        events.push(`end:${logicalId}`);
        return { physicalId, wasReplaced: false };
      }),
      delete: vi.fn(),
      getAttribute: vi.fn(),
    };
  });

  function makeEngine(state: StackState): DeployEngine {
    return new DeployEngine(
      {
        getState: vi.fn().mockResolvedValue({ state, etag: 'etag-old' }),
        saveState: vi.fn().mockResolvedValue('etag-new'),
      } as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      new DagBuilder(),
      new DiffCalculator(),
      {
        getProvider: vi.fn().mockReturnValue(provider),
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
        ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
      } as never,
      { dryRun: false, concurrency: 10 } as never,
      REGION,
      {
        updateForStack: vi.fn().mockResolvedValue(undefined),
        prefetch: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );
  }

  const stateOf = (resources: Record<string, ResourceState>): StackState => ({
    version: STATE_SCHEMA_VERSION_CURRENT,
    region: REGION,
    stackName: STACK,
    resources,
    outputs: {},
    lastModified: 0,
  });

  const at = (event: string): number => {
    const index = events.indexOf(event);
    expect(index, `${event} in ${events.join(', ')}`).toBeGreaterThanOrEqual(0);
    return index;
  };

  it('a changed reader waits for a changed resource behind ONE unchanged one', async () => {
    // Head (changed) <- Mid (unchanged: reads Head's name, which is fixed) <- Tail (changed)
    const template: CloudFormationTemplate = {
      Resources: {
        Head: param('head', 'v2'),
        Mid: param('mid', { Ref: 'Head' }),
        Tail: param('tail', join({ Ref: 'Mid' }, '-v2')),
      },
    };
    const state = stateOf({
      Head: record('head', 'v1', []),
      Mid: record('mid', 'head', ['Head']),
      Tail: record('tail', 'mid-v1', ['Mid']),
    });

    await makeEngine(state).deploy(STACK, template);

    // Mid is unchanged, so only the two ends are sent.
    expect(provider.update.mock.calls.map((c) => c[0]).sort()).toEqual(['Head', 'Tail']);
    expect(at('end:Head')).toBeLessThan(at('start:Tail'));
  });

  it('a chain through SEVERAL unchanged resources is still ordered, and an independent change stays parallel', async () => {
    // Head <- M1 <- M2 <- M3 <- Tail, with Free changed and reading nothing.
    const template: CloudFormationTemplate = {
      Resources: {
        Head: param('head', 'v2'),
        M1: param('m1', { Ref: 'Head' }),
        M2: param('m2', { Ref: 'M1' }),
        M3: param('m3', { Ref: 'M2' }),
        Tail: param('tail', join({ Ref: 'M3' }, '-v2')),
        Free: param('free', 'v2'),
      },
    };
    const state = stateOf({
      Head: record('head', 'v1', []),
      M1: record('m1', 'head', ['Head']),
      M2: record('m2', 'm1', ['M1']),
      M3: record('m3', 'm2', ['M2']),
      Tail: record('tail', 'm3-v1', ['M3']),
      Free: record('free', 'v1', []),
    });

    await makeEngine(state).deploy(STACK, template);

    expect(provider.update.mock.calls.map((c) => c[0]).sort()).toEqual(['Free', 'Head', 'Tail']);
    expect(at('end:Head')).toBeLessThan(at('start:Tail'));
    // Free has no dependency at all: it starts beside Head, not after it.
    expect(at('start:Free')).toBeLessThan(at('end:Head'));
  });
});

describe('nearestMemberDependencies (go-to-k/cdkd#6244)', () => {
  const graph = (edges: Record<string, string[]>) => (id: string) => edges[id] ?? [];

  it('walks through non-members to the nearest members only', () => {
    // C -> u1 -> u2 -> A ; C -> B (member) -> u3 -> A ; D -> u4 (no members behind)
    const deps = graph({
      C: ['u1', 'B'],
      u1: ['u2'],
      u2: ['A'],
      B: ['u3'],
      u3: ['A'],
      D: ['u4'],
    });
    const members = new Set(['A', 'B', 'C', 'D']);
    const result = nearestMemberDependencies(['A', 'B', 'C', 'D'], deps, (id) => members.has(id));

    expect([...result.get('C')!].sort()).toEqual(['A', 'B']);
    expect([...result.get('B')!]).toEqual(['A']);
    expect([...result.get('A')!]).toEqual([]);
    expect([...result.get('D')!]).toEqual([]);
  });

  it('reads each non-member once, however many members sit behind it', () => {
    const edges: Record<string, string[]> = { shared: ['A'] };
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      edges[`R${i}`] = ['shared'];
      ids.push(`R${i}`);
    }
    const reads = new Map<string, number>();
    const deps = (id: string): string[] => {
      reads.set(id, (reads.get(id) ?? 0) + 1);
      return edges[id] ?? [];
    };
    const result = nearestMemberDependencies(ids, deps, (id) => id === 'A' || id.startsWith('R'));

    expect([...result.get('R7')!]).toEqual(['A']);
    expect(reads.get('shared')).toBe(1);
  });

  it('does not memoize a set the cycle guard cut short', () => {
    // u1 <-> u2, u1 -> B, u2 -> A. Walking C first visits u2 while u1 is on the
    // stack, so u2's own walk misses B; D, read afterwards, must still see B.
    const deps = graph({ C: ['u1'], D: ['u2'], u1: ['u2', 'B'], u2: ['u1', 'A'] });
    const members = new Set(['A', 'B', 'C', 'D']);
    const result = nearestMemberDependencies(['C', 'D'], deps, (id) => members.has(id));
    expect([...result.get('C')!].sort()).toEqual(['A', 'B']);
    expect([...result.get('D')!].sort()).toEqual(['A', 'B']);
  });

  it('survives a cycle among non-members', () => {
    const deps = graph({ C: ['u1'], u1: ['u2'], u2: ['u1', 'A'] });
    const result = nearestMemberDependencies(['C'], deps, (id) => id === 'A' || id === 'C');
    expect([...result.get('C')!]).toEqual(['A']);
  });
});
