import { describe, it, expect, vi } from 'vite-plus/test';
import { buildResolvedParametersPerStack } from '../../../src/cli/commands/export/parameters.js';
import { IntrinsicFunctionResolver } from '../../../src/deployment/intrinsic-function-resolver.js';
import { stackIdTailFromInstanceId } from '../../../src/state/stack-id-tail.js';
import type { StackState } from '../../../src/types/state.js';
import type { CdkdStateStackTree } from '../../../src/cli/commands/export/render.js';

vi.mock('../../../src/utils/logger.js', () => {
  const l = { setLevel: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...l, child: () => l }) };
});

vi.mock('../../../src/deployment/intrinsic-resolver/account-drain.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/deployment/intrinsic-resolver/account-drain.js')>()),
  getAccountInfo: vi.fn(async () => ({
    accountId: '123456789012',
    partition: 'aws',
    region: 'us-east-1',
  })),
}));

/**
 * go-to-k/cdkd#6170: a child's IMPORT parameter built from the parent's row
 * resolves `AWS::StackId`'s tail the way the deploy did, from the PARENT's
 * record.
 */
const X = '0b5c6a1e-3f2d-4c8b-9a7e-1d2c3b4a5f60';
const TAIL_OF_STACK_ID = { 'Fn::Select': [2, { 'Fn::Split': ['/', { Ref: 'AWS::StackId' }] }] };

const rootTemplate = {
  Resources: {
    Child: {
      Type: 'AWS::CloudFormation::Stack',
      Properties: { Parameters: { P: TAIL_OF_STACK_ID } },
    },
  },
};

function stateOf(extra: Record<string, unknown>, parent?: object): StackState {
  return {
    version: 16,
    stackName: 'Root',
    region: 'us-east-1',
    resources: {},
    outputs: {},
    lastModified: 0,
    ...parent,
    ...extra,
  } as unknown as StackState;
}

async function childParam(rootExtra: Record<string, unknown>): Promise<unknown> {
  const tree: CdkdStateStackTree = {
    stackName: 'Root',
    region: 'us-east-1',
    state: {} as StackState,
    nestedChildren: new Map([
      [
        'Child',
        {
          stackName: 'Root~Child',
          region: 'us-east-1',
          state: {} as StackState,
          nestedChildren: new Map(),
        },
      ],
    ]),
  };
  const { paramsByCdkdName } = await buildResolvedParametersPerStack({
    rootStackName: 'Root',
    rootParameters: [],
    perStackNodes: [
      { cdkdName: 'Root', template: rootTemplate, state: stateOf(rootExtra) },
      {
        cdkdName: 'Root~Child',
        template: { Resources: {} },
        state: stateOf(
          {},
          { parentStack: 'Root', parentLogicalId: 'Child', parentRegion: 'us-east-1' }
        ),
      },
    ],
    tree,
    resolver: new IntrinsicFunctionResolver('us-east-1'),
  });
  return paramsByCdkdName.get('Root~Child')?.find((p) => p.ParameterKey === 'P')?.ParameterValue;
}

describe('export: the parent row resolves AWS::StackId from the parent record (go-to-k/cdkd#6170)', () => {
  it('a marked parent hands the child the instance-derived tail', async () => {
    const value = await childParam({ stackInstanceId: X, stackIdFromInstance: true });
    expect(value).toBe(stackIdTailFromInstanceId(X));
    expect(value).not.toBe('cdkd');
  });

  it('an unmarked parent keeps the legacy tail', async () => {
    expect(await childParam({ stackInstanceId: X })).toBe('cdkd');
  });
});
