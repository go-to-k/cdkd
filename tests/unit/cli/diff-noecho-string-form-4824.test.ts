/**
 * go-to-k/cdkd#4824 on `cdkd diff`: a parameter declared `NoEcho: "true"` (the
 * string form) is recorded up front like `NoEcho: true`, so a property that
 * STOPPED reading it masks its stored old value, and a stored `Fn::Split`
 * piece of it. End to end through `computeStackDiff` with the real resolver.
 */

import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

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

// The recursive walk warms the create-only `DescribeType` cache; answered
// with a refusal, which that best-effort lookup tolerates.
vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn().mockImplementation(() => ({
      send: async () => {
        throw Object.assign(new Error('not in this test'), { name: 'TypeNotFoundException' });
      },
    })),
  };
});

import {
  computeStackDiff,
  diffTreeToJson,
  renderChangeLines,
  renderOutputChangeLines,
  type DiffTreeNode,
} from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const FIRST = 'alpha-first-piece-4824';
const SECOND = 'bravo-second-piece-4824';
const NOECHO = `${FIRST},${SECOND}`;

function res(properties: Record<string, unknown>): ResourceState {
  return {
    physicalId: 'pid',
    resourceType: 'AWS::SSM::Parameter',
    properties,
    attributes: {},
    dependencies: [],
  };
}

function st(resources: Record<string, ResourceState>, stackName = 'S'): StackState {
  return { stackName, region: 'us-east-1', resources, outputs: {}, version: 6, lastModified: 0 };
}

function backendOf(states: Record<string, StackState> = {}): S3StateBackend {
  return {
    getState: async (stackName: string) => {
      const state = states[stackName];
      return state ? { state, etag: 'e' } : null;
    },
    saveState: vi.fn(),
    putState: vi.fn(),
    deleteState: vi.fn(),
  } as unknown as S3StateBackend;
}

function printed(node: DiffTreeNode): string {
  const lines: string[] = [];
  renderChangeLines(node.changes, (line) => lines.push(line));
  renderOutputChangeLines(node.outputChanges, (line) => lines.push(line));
  return `${lines.join('\n')}\n${JSON.stringify(diffTreeToJson(node))}`;
}

function nodeOf(result: Awaited<ReturnType<typeof computeStackDiff>>): DiffTreeNode {
  return {
    stackName: 'S',
    displayName: 'S',
    region: 'us-east-1',
    changes: result.changes,
    ccApiRoutes: new Map(),
    outputChanges: result.outputChanges,
    adoptedOrphans: [],
    blocking: [],
    unreadable: [],
    unreadableContainers: [],
    unreadableOrphans: [],
    destructiveChanges: [],
    children: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('cdkd diff honours NoEcho declared as the string "true" (go-to-k/cdkd#4824)', () => {
  /**
   * `A` stored a value that nothing reads any more; `B` holds the split behind
   * a condition that prunes it, so no resolution of this diff records the
   * value: only the up-front record of every `NoEcho` value can.
   */
  const stoppedReading = (noEcho: unknown): CloudFormationTemplate =>
    ({
      Parameters: { DbUser: { Type: 'String', NoEcho: noEcho, Default: NOECHO } },
      Conditions: { Never: { 'Fn::Equals': ['a', 'b'] } },
      Resources: {
        A: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'new-literal', Description: 'new' } },
        B: {
          Type: 'AWS::SSM::Parameter',
          Condition: 'Never',
          Properties: { Value: { 'Fn::Select': [0, { 'Fn::Split': [',', { Ref: 'DbUser' }] }] } },
        },
      },
    }) as unknown as CloudFormationTemplate;

  const diff = (stored: Record<string, unknown>, noEcho: unknown) =>
    computeStackDiff(
      st({ A: res(stored) }),
      stoppedReading(noEcho),
      'us-east-1',
      'S',
      backendOf(),
      new DiffCalculator()
    );

  it.each([
    ['the boolean', true],
    ['the string', 'true'],
  ])('masks the stored whole value (%s)', async (_l, noEcho) => {
    const out = printed(nodeOf(await diff({ Value: NOECHO, Description: 'old' }, noEcho)));
    expect(out).toContain('new-literal');
    expect(out).not.toContain(NOECHO);
  });

  it.each([
    ['the boolean', true],
    ['the string', 'true'],
  ])('masks a stored Fn::Split piece (%s)', async (_l, noEcho) => {
    const out = printed(nodeOf(await diff({ Value: SECOND, Description: 'old' }, noEcho)));
    expect(out).toContain('new-literal');
    expect(out).not.toContain(SECOND);
  });

  it.each([
    ['false', false],
    ['a case variant the persist arm never honoured', 'True'],
  ])('negative control: prints both when NoEcho is %s', async (_l, noEcho) => {
    expect(printed(nodeOf(await diff({ Value: NOECHO, Description: 'old' }, noEcho)))).toContain(NOECHO);
    expect(printed(nodeOf(await diff({ Value: SECOND, Description: 'old' }, noEcho)))).toContain(SECOND);
  });
});
