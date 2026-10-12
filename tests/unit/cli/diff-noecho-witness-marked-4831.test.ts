/**
 * go-to-k/cdkd#4831 on `cdkd diff`: the migration witness covers a MARKED
 * record. A parameter declared `NoEcho` only since the record's write still
 * stores its plaintext beside leaves another `NoEcho` source marked: an equal
 * value reads as unchanged (no create-only replacement row), and a different
 * one as a change whose old side never shows the stored plaintext. End to end
 * through `computeStackDiff` with the real resolver.
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
import { PREVIOUS_NOECHO_VALUE } from '../../../src/deployment/secret-redaction.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const TOKEN = 'tok-4831-diff-distinctive';
const TOPIC = 'topic-4831-diff-distinctive';

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

describe('cdkd diff reads a MARKED record through the migration witness (go-to-k/cdkd#4831)', () => {
  const template = (topicValue: string): CloudFormationTemplate =>
    ({
      Parameters: {
        Token: { Type: 'String', NoEcho: true, Default: TOKEN },
        TopicName: { Type: 'String', NoEcho: true, Default: topicValue },
      },
      Resources: {
        A: {
          Type: 'AWS::SNS::Topic',
          Properties: { TopicName: { Ref: 'TopicName' }, DisplayName: { Ref: 'Token' } },
        },
      },
    }) as unknown as CloudFormationTemplate;

  /** Written while `TopicName` was an ordinary parameter. */
  const marked = (): StackState =>
    st({
      A: {
        ...res({ TopicName: TOPIC, DisplayName: '***' }),
        resourceType: 'AWS::SNS::Topic',
        noEchoLeaves: [['DisplayName']],
      } as ResourceState,
    });

  const diff = (topicValue: string) =>
    computeStackDiff(marked(), template(topicValue), 'us-east-1', 'S', backendOf(), new DiffCalculator());

  it('an unchanged value newly declared NoEcho is no change', async () => {
    const result = await diff(TOPIC);
    expect(result.changes.get('A')?.changeType).toBe('NO_CHANGE');
    expect(printed(nodeOf(result))).not.toContain(TOPIC);
  });

  it('a different value is a create-only change whose old side withholds the stored plaintext', async () => {
    const result = await diff('topic-4831-diff-renamed');
    const change = result.changes.get('A')?.propertyChanges?.find((pc) => pc.path === 'TopicName');
    expect(change?.requiresReplacement).toBe(true);
    expect(change?.oldValue).toBe(PREVIOUS_NOECHO_VALUE);
    expect(printed(nodeOf(result))).not.toContain(TOPIC);
    expect(printed(nodeOf(result))).not.toContain('topic-4831-diff-renamed');
  });
});
