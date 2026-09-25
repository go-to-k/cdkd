/**
 * `cdkd diff` prefetches each node's create-only DescribeType lookups before
 * the diff awaits them (issue #3718), as `cdkd deploy` does. Before, the diff
 * resolved each type inline, one resource at a time.
 *
 * Pins the WIRING: which types each `buildDiffTree` node hands the prefetch,
 * that a `--recursive` child's types are prefetched too, that the prefetch
 * starts before the state read, and that a failing lookup changes no answer.
 * The prefetch's own cap / priority / never-throw guarantees live in
 * `tests/unit/provisioning/create-only-properties.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

// Every DescribeType the diff issues REJECTS, so the no-answer-change case
// below runs with the live lookup unavailable.
const cfnSend = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/utils/aws-clients.js')>();
  return {
    ...original,
    getAwsClients: () => ({ cloudFormation: { send: cfnSend }, ssm: { send: vi.fn() } }),
  };
});

// The committed snapshot, mutable so the control case can empty one entry.
const snapshot = vi.hoisted(() => ({ map: new Map<string, ReadonlyArray<readonly string[]>>() }));
vi.mock('../../../src/provisioning/create-only-snapshot.generated.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/provisioning/create-only-snapshot.generated.js')
  >('../../../src/provisioning/create-only-snapshot.generated.js');
  for (const [type, paths] of actual.CREATE_ONLY_PATHS_SNAPSHOT) snapshot.map.set(type, paths);
  return { CREATE_ONLY_PATHS_SNAPSHOT: snapshot.map };
});

const prefetchSpy = vi.hoisted(() => vi.fn<(types: string[]) => void>());
const cancelSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/provisioning/create-only-properties.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/provisioning/create-only-properties.js')
  >('../../../src/provisioning/create-only-properties.js');
  return {
    ...actual,
    prefetchCreateOnlyPropertyPaths: (types: Iterable<string>) => {
      const list = [...types];
      prefetchSpy(list);
      const handle = actual.prefetchCreateOnlyPropertyPaths(list);
      return {
        cancel: () => {
          cancelSpy(list);
          handle.cancel();
        },
      };
    },
  };
});

import { buildDiffTree } from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { clearCreateOnlyPropertiesCache } from '../../../src/provisioning/create-only-properties.js';
import { describeTypeQueueDepth } from '../../../src/provisioning/describe-type.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const NESTED = 'AWS::CloudFormation::Stack';

function res(resourceType: string, properties: Record<string, unknown>): ResourceState {
  return { physicalId: 'pid', resourceType, properties, attributes: {}, dependencies: [] };
}

function st(stackName: string, resources: Record<string, ResourceState>): StackState {
  return { stackName, region: 'us-east-1', resources, outputs: {}, version: 6, lastModified: 0 };
}

function fakeBackend(
  states: Record<string, StackState>,
  onRead: (stackName: string) => void = () => {}
): S3StateBackend {
  return {
    getState: async (stackName: string) => {
      onRead(stackName);
      const state = states[stackName];
      return state ? { state, etag: 'fake' } : null;
    },
  } as unknown as S3StateBackend;
}

describe('cdkd diff — create-only prefetch (issue #3718)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cfnSend.mockRejectedValue(new Error('AccessDenied'));
    clearCreateOnlyPropertiesCache();
  });

  const flatTemplate: CloudFormationTemplate = {
    Resources: {
      A: { Type: 'AWS::SQS::Queue', Properties: {} },
      B: { Type: 'AWS::SQS::Queue', Properties: {} },
      C: { Type: 'AWS::SSM::Parameter', Properties: { Type: 'String', Value: 'v' } },
      D: { Type: 'AWS::SNS::Topic', Properties: {} },
    },
  };

  it('a first diff (every row a CREATE) issues NO DescribeType call', async () => {
    await buildDiffTree({
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      template: flatTemplate,
      nestedTemplates: {},
      recursive: false,
      stateBackend: fakeBackend({}),
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(prefetchSpy).toHaveBeenCalledWith([]);
    expect(cfnSend).not.toHaveBeenCalled();
  });

  it('prefetches only the types of rows the state already records, after the state read', async () => {
    const order: string[] = [];
    prefetchSpy.mockImplementation(() => order.push('prefetch'));

    await buildDiffTree({
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      template: flatTemplate,
      nestedTemplates: {},
      recursive: false,
      stateBackend: fakeBackend(
        {
          S: st('S', {
            A: res('AWS::SQS::Queue', {}),
            C: res('AWS::SSM::Parameter', { Type: 'String', Value: 'v' }),
            // In state only: a DELETE, which needs no create-only paths.
            Gone: res('AWS::Lambda::Function', {}),
          }),
        },
        () => order.push('state')
      ),
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });

    expect(prefetchSpy).toHaveBeenCalledTimes(1);
    expect(prefetchSpy.mock.calls[0]![0].sort()).toEqual(['AWS::SQS::Queue', 'AWS::SSM::Parameter']);
    expect(order).toEqual(['state', 'prefetch']);
  });

  it("cancels the node's prefetch once its diff is computed, on the failure path too", async () => {
    const state = { S: st('S', { A: res('AWS::SQS::Queue', {}) }) };
    await buildDiffTree({
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      template: flatTemplate,
      nestedTemplates: {},
      recursive: false,
      stateBackend: fakeBackend(state),
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });
    expect(cancelSpy).toHaveBeenCalledWith(['AWS::SQS::Queue']);

    cancelSpy.mockClear();
    const failing = new DiffCalculator();
    vi.spyOn(failing, 'calculateDiff').mockRejectedValue(new Error('diff boom'));
    await expect(
      buildDiffTree({
        stackName: 'S',
        displayName: 'S',
        region: 'us-east-1',
        template: flatTemplate,
        nestedTemplates: {},
        recursive: false,
        stateBackend: fakeBackend(state),
        diffCalculator: failing,
        isNestedChild: false,
      })
    ).rejects.toThrow('diff boom');
    expect(cancelSpy).toHaveBeenCalledWith(['AWS::SQS::Queue']);
  });

  it("a --recursive walk prefetches the nested child's recorded types too", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-3718-'));
    try {
      const childPath = join(dir, 'child.json');
      writeFileSync(
        childPath,
        JSON.stringify({ Resources: { Q: { Type: 'AWS::SNS::Topic', Properties: {} } } })
      );
      const parentTemplate: CloudFormationTemplate = {
        Resources: {
          Child: { Type: NESTED, Metadata: { 'aws:asset:path': 'child.json' }, Properties: {} },
        },
      };

      await buildDiffTree({
        stackName: 'S',
        displayName: 'S',
        region: 'us-east-1',
        template: parentTemplate,
        nestedTemplates: { Child: childPath },
        recursive: true,
        stateBackend: fakeBackend({
          S: st('S', { Child: res(NESTED, {}) }),
          'S~Child': st('S~Child', { Q: res('AWS::SNS::Topic', {}) }),
        }),
        diffCalculator: new DiffCalculator(),
        isNestedChild: false,
      });

      const prefetched = prefetchSpy.mock.calls.map(([types]) => types);
      expect(prefetched).toEqual([[NESTED], ['AWS::SNS::Topic']]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const clusterDiff = async (): Promise<boolean | undefined> => {
    // AWS::ECS::Cluster has NO hand-authored replacement rule, and its
    // ClusterName is create-only in the committed snapshot — so the verdict
    // can only come from the create-only lookup.
    const node = await buildDiffTree({
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      template: {
        Resources: { C: { Type: 'AWS::ECS::Cluster', Properties: { ClusterName: 'new' } } },
      },
      nestedTemplates: {},
      recursive: false,
      stateBackend: fakeBackend({
        S: st('S', { C: res('AWS::ECS::Cluster', { ClusterName: 'old' }) }),
      }),
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });
    const change = node.changes.get('C')!;
    expect(change.changeType).toBe('UPDATE');
    return change.propertyChanges?.find((p) => p.path === 'ClusterName')?.requiresReplacement;
  };

  it('with the live lookup failing, the replacement verdict comes from the snapshot fallback', async () => {
    expect(snapshot.map.get('AWS::ECS::Cluster')).toEqual([['ClusterName']]);
    expect(await clusterDiff()).toBe(true);
    expect(prefetchSpy).toHaveBeenCalledWith(['AWS::ECS::Cluster']);
  });

  it('control: with that snapshot entry removed, the same diff classifies in place', async () => {
    const saved = snapshot.map.get('AWS::ECS::Cluster')!;
    snapshot.map.delete('AWS::ECS::Cluster');
    try {
      expect(await clusterDiff()).toBe(false);
    } finally {
      snapshot.map.set('AWS::ECS::Cluster', saved);
    }
  });

  it('leaves nothing running or queued when the node finishes — success and throw paths', async () => {
    // Lookups that only ever end by abort, for rows the diff never awaits
    // (NO_CHANGE), so only the cancel can settle them.
    const signals: AbortSignal[] = [];
    cfnSend.mockImplementation(
      (_command: unknown, options?: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const signal = options!.abortSignal!;
          signals.push(signal);
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const unchanged = {
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      template: flatTemplate,
      nestedTemplates: {},
      recursive: false,
      stateBackend: fakeBackend({
        S: st('S', {
          A: res('AWS::SQS::Queue', {}),
          D: res('AWS::SNS::Topic', {}),
        }),
      }),
      isNestedChild: false,
    } as const;

    await buildDiffTree({ ...unchanged, diffCalculator: new DiffCalculator() });
    expect(signals.length).toBe(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(describeTypeQueueDepth()).toEqual({ active: 0, pending: 0 });

    clearCreateOnlyPropertiesCache();
    signals.length = 0;
    const failing = new DiffCalculator();
    vi.spyOn(failing, 'calculateDiff').mockRejectedValue(new Error('diff boom'));
    await expect(buildDiffTree({ ...unchanged, diffCalculator: failing })).rejects.toThrow(
      'diff boom'
    );
    expect(signals.length).toBe(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(describeTypeQueueDepth()).toEqual({ active: 0, pending: 0 });
  });
});
