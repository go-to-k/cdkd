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

const prefetchSpy = vi.hoisted(() => vi.fn<(types: string[]) => void>());
vi.mock('../../../src/provisioning/create-only-properties.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/provisioning/create-only-properties.js')
  >('../../../src/provisioning/create-only-properties.js');
  return {
    ...actual,
    prefetchCreateOnlyPropertyPaths: (types: Iterable<string>) => {
      const list = [...types];
      prefetchSpy(list);
      actual.prefetchCreateOnlyPropertyPaths(list);
    },
  };
});

import { buildDiffTree } from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { clearCreateOnlyPropertiesCache } from '../../../src/provisioning/create-only-properties.js';
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

  it("prefetches the node's distinct types BEFORE its state read", async () => {
    const order: string[] = [];
    prefetchSpy.mockImplementation(() => order.push('prefetch'));
    const template: CloudFormationTemplate = {
      Resources: {
        A: { Type: 'AWS::SQS::Queue', Properties: {} },
        B: { Type: 'AWS::SQS::Queue', Properties: {} },
        C: { Type: 'AWS::SSM::Parameter', Properties: { Type: 'String', Value: 'v' } },
      },
    };

    await buildDiffTree({
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      template,
      nestedTemplates: {},
      recursive: false,
      stateBackend: fakeBackend({}, () => order.push('state')),
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });

    expect(prefetchSpy).toHaveBeenCalledTimes(1);
    expect(prefetchSpy.mock.calls[0]![0].sort()).toEqual(['AWS::SQS::Queue', 'AWS::SSM::Parameter']);
    expect(order[0]).toBe('prefetch');
    expect(order).toContain('state');
  });

  it("a --recursive walk prefetches the nested child's types too", async () => {
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
          'S~Child': st('S~Child', {}),
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

  it('with the live lookup failing, the diff still classifies from the snapshot — same answer as an inline lookup', async () => {
    // AWS::SQS::Queue's QueueName is create-only in the committed snapshot and
    // has no hand-authored replacement rule, so the classification can only
    // come from the create-only lookup the prefetch warmed.
    const template: CloudFormationTemplate = {
      Resources: { Q: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'new-name' } } },
    };

    const node = await buildDiffTree({
      stackName: 'S',
      displayName: 'S',
      region: 'us-east-1',
      template,
      nestedTemplates: {},
      recursive: false,
      stateBackend: fakeBackend({
        S: st('S', { Q: res('AWS::SQS::Queue', { QueueName: 'old-name' }) }),
      }),
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });

    const change = node.changes.get('Q')!;
    expect(change.changeType).toBe('UPDATE');
    expect(change.propertyChanges?.find((p) => p.path === 'QueueName')?.requiresReplacement).toBe(
      true
    );
    expect(prefetchSpy).toHaveBeenCalledWith(['AWS::SQS::Queue']);
  });
});
