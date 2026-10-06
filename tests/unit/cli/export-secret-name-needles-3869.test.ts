/**
 * `cdkd export` masks a physical name derived from a secret on its resolver's
 * lines (go-to-k/cdkd#3869). Its pre-pass resolves each child's `Parameters`
 * against the PARENT's state, so a parent row passing a resource whose
 * recorded name is a secret's (`{ Ref: User }`) printed the name. The read
 * goes to a print-only sink; the parameter value submitted is the real one.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';

const debugLines: string[] = [];
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: (...args: unknown[]) => void debugLines.push(args.map(String).join(' ')),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

const { buildResolvedParametersPerStack } = await import('../../../src/cli/commands/export.js');
const { IntrinsicFunctionResolver } = await import(
  '../../../src/deployment/intrinsic-function-resolver.js'
);

type Tree = Parameters<typeof buildResolvedParametersPerStack>[0]['tree'];

const USER_ID = 'team-secret-export-user';

function treeNode(stackName: string, children: Map<string, Tree>): Tree {
  return { stackName, region: 'us-east-1', state: {} as StackState, nestedChildren: children };
}

function node(
  cdkdName: string,
  template: Record<string, unknown>,
  resources: StackState['resources'],
  parent?: { stack: string; logicalId: string }
): { cdkdName: string; template: Record<string, unknown>; state: StackState } {
  const state = {
    version: 6,
    stackName: cdkdName,
    region: 'us-east-1',
    resources,
    outputs: {},
    lastModified: 0,
    ...(parent && {
      parentStack: parent.stack,
      parentLogicalId: parent.logicalId,
      parentRegion: 'us-east-1',
    }),
  } as StackState;
  return { cdkdName, template, state };
}

async function exportRun(userName: string) {
  debugLines.length = 0;
  const rootTemplate = {
    Resources: {
      User: { Type: 'AWS::IAM::User', Properties: {} },
      Child: {
        Type: 'AWS::CloudFormation::Stack',
        Properties: { Parameters: { UserNameParam: { Ref: 'User' } } },
      },
    },
  };
  const rootResources = {
    User: {
      physicalId: USER_ID,
      resourceType: 'AWS::IAM::User',
      properties: { UserName: userName },
      attributes: {},
      dependencies: [],
    },
  } as unknown as StackState['resources'];
  const { paramsByCdkdName } = await buildResolvedParametersPerStack({
    rootStackName: 'Root',
    rootParameters: [],
    perStackNodes: [
      node('Root', rootTemplate, rootResources),
      node('Root~Child', { Resources: {} }, {}, { stack: 'Root', logicalId: 'Child' }),
    ],
    tree: treeNode('Root', new Map([['Child', treeNode('Root~Child', new Map())]])),
    resolver: new IntrinsicFunctionResolver('us-east-1'),
  });
  return { lines: debugLines.join('\n'), params: paramsByCdkdName.get('Root~Child') };
}

describe('cdkd export masks a name derived from a secret (go-to-k/cdkd#3869)', () => {
  beforeEach(() => {
    debugLines.length = 0;
  });

  it("masks the parent's Ref on the resolver's line and submits the real value", async () => {
    const { lines, params } = await exportRun('{{resolve:secretsmanager:team:SecretString:user::}}');
    expect(lines).toContain('Ref to resource: User resolved to');
    expect(lines).not.toContain(USER_ID);
    expect(params).toEqual([{ ParameterKey: 'UserNameParam', ParameterValue: USER_ID }]);
  });

  it('negative control: an ordinary name prints as it is', async () => {
    const { lines } = await exportRun('plain-user-name');
    expect(lines).toContain(USER_ID);
  });
});
