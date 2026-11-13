/**
 * go-to-k/cdkd#6170: `cdkd diff` resolves `AWS::StackId` with the tail the
 * deploy resolves it with, read from the stack's record -- the UUID derived
 * from its instance id when the record is marked `stackIdFromInstance`, else
 * `cdkd`. A diff resolving the other tail would show a change (or, for a name,
 * a replacement) the deploy never makes. Run through `computeStackDiff` with
 * the real resolver.
 */

import { describe, expect, it, vi } from 'vite-plus/test';

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

vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sts')>();
  return {
    ...actual,
    STSClient: vi.fn().mockImplementation(() => ({
      send: vi.fn().mockResolvedValue({
        Account: '123456789012',
        Arn: 'arn:aws:iam::123456789012:user/test',
      }),
      destroy: vi.fn(),
    })),
  };
});

import { computeStackDiff } from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';
import { stackIdTailFromInstanceId } from '../../../src/state/stack-id-tail.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const INSTANCE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const DERIVED = stackIdTailFromInstanceId(INSTANCE_ID);

const backend = {
  getState: async () => null,
  saveState: vi.fn(),
  putState: vi.fn(),
  deleteState: vi.fn(),
} as unknown as S3StateBackend;

const template = {
  Resources: {
    P: {
      Type: 'AWS::SSM::Parameter',
      Properties: {
        Type: 'String',
        Value: { 'Fn::Select': [2, { 'Fn::Split': ['/', { Ref: 'AWS::StackId' }] }] },
      },
    },
  },
} as unknown as CloudFormationTemplate;

function stateOf(recorded: string, marker: Partial<StackState>): StackState {
  return {
    stackName: 'S',
    region: 'us-east-1',
    version: 16,
    lastModified: 0,
    outputs: {},
    resources: {
      P: {
        physicalId: 'pid',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Type: 'String', Value: recorded },
        attributes: {},
        dependencies: [],
      },
    },
    ...marker,
  };
}

async function changeTypeOf(state: StackState): Promise<string | undefined> {
  resetAccountInfoCache();
  const result = await computeStackDiff(state, template, 'us-east-1', 'S', backend, new DiffCalculator());
  return result.changes.get('P')?.changeType;
}

describe('cdkd diff resolves AWS::StackId with the record\'s tail (go-to-k/cdkd#6170)', () => {
  it('a marked record compares the derived UUID: no change, and a recorded cdkd is an update', async () => {
    const marked = { stackInstanceId: INSTANCE_ID, stackIdFromInstance: true as const };
    expect(await changeTypeOf(stateOf(DERIVED, marked))).toBe('NO_CHANGE');
    expect(await changeTypeOf(stateOf('cdkd', marked))).toBe('UPDATE');
  });

  it('a record without the marker compares cdkd, instance id or not', async () => {
    expect(await changeTypeOf(stateOf('cdkd', { stackInstanceId: INSTANCE_ID }))).toBe('NO_CHANGE');
    expect(await changeTypeOf(stateOf('cdkd', {}))).toBe('NO_CHANGE');
    expect(await changeTypeOf(stateOf(DERIVED, { stackInstanceId: INSTANCE_ID }))).toBe('UPDATE');
  });
});

describe('cdkd diff evaluates a Condition on AWS::StackId with the record\'s tail (go-to-k/cdkd#6170)', () => {
  const conditioned = {
    Conditions: {
      IsDerived: {
        'Fn::Not': [
          {
            'Fn::Equals': [
              { 'Fn::Select': [2, { 'Fn::Split': ['/', { Ref: 'AWS::StackId' }] }] },
              'cdkd',
            ],
          },
        ],
      },
    },
    Resources: {
      ...(template as unknown as { Resources: Record<string, unknown> }).Resources,
      G: { Type: 'AWS::SSM::Parameter', Condition: 'IsDerived', Properties: { Type: 'String', Value: 'g' } },
    },
  } as unknown as CloudFormationTemplate;

  async function diffOf(state: StackState) {
    resetAccountInfoCache();
    return computeStackDiff(state, conditioned, 'us-east-1', 'S', backend, new DiffCalculator());
  }

  it('a marked record: the gated resource is a CREATE', async () => {
    const result = await diffOf(
      stateOf(DERIVED, { stackInstanceId: INSTANCE_ID, stackIdFromInstance: true })
    );
    expect(result.changes.get('G')?.changeType).toBe('CREATE');
    expect(result.changes.get('P')?.changeType).toBe('NO_CHANGE');
  });

  it('a record without the marker: the gated resource is pruned', async () => {
    const result = await diffOf(stateOf('cdkd', { stackInstanceId: INSTANCE_ID }));
    expect(result.changes.has('G')).toBe(false);
    expect(result.changes.get('P')?.changeType).toBe('NO_CHANGE');
  });
});

