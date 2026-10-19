import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-codebuild', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-codebuild')>();
  return {
    ...actual,
    CodeBuildClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({ child: () => childLogger, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  };
});

import { CodeBuildProvider } from '../../../../src/provisioning/providers/codebuild-provider.js';
import { CreateProjectCommand, UpdateProjectCommand } from '@aws-sdk/client-codebuild';
import {
  applyDefaultNameForFallback,
  stackInstanceNameSuffix,
  withStackScope,
  withStackScopeBeforeStateRead,
} from '../../../../src/provisioning/resource-name.js';

/**
 * go-to-k/cdkd#5095: an un-named CodeBuild project. A legacy stack keeps the
 * bare logical id its SDK provider always sent; a stack with an instance id
 * gets the generated name every type gets there, the one the Cloud Control
 * rule fills too.
 */
const TYPE = 'AWS::CodeBuild::Project';
const ID = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const PROPS = {
  Source: { Type: 'NO_SOURCE', BuildSpec: 'version: 0.2' },
  Environment: { Type: 'LINUX_CONTAINER', ComputeType: 'BUILD_GENERAL1_SMALL', Image: 'aws/codebuild/standard:7.0' },
  ServiceRole: 'arn:aws:iam::123456789012:role/codebuild-role',
  Artifacts: { Type: 'NO_ARTIFACTS' },
};

describe('CodeBuildProvider generated name (#5095)', () => {
  let provider: CodeBuildProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockImplementation(async (command: unknown) =>
      command instanceof CreateProjectCommand
        ? { project: { name: command.input.name, arn: `arn:aws:codebuild:us-east-1:1:project/${command.input.name}` } }
        : {}
    );
    provider = new CodeBuildProvider();
  });

  const sentName = (): unknown => (mockSend.mock.calls[0]![0] as CreateProjectCommand).input.name;

  it('a legacy stack sends the bare logical id, as before', async () => {
    const result = await withStackScope(
      { stackName: 'MyStack', stackInstanceId: undefined, nameGenerations: new Map() },
      () => provider.create('Build', TYPE, PROPS)
    );
    expect(sentName()).toBe('Build');
    expect(result.physicalId).toBe('Build');
  });

  it('a stack with an instance id sends the suffixed name the Cloud Control rule fills', async () => {
    const scope = { stackName: 'MyStack', stackInstanceId: ID, nameGenerations: new Map([['Build', 1]]) };
    await withStackScope(scope, () => provider.create('Build', TYPE, PROPS));
    expect(sentName()).toBe(`MyStack-Build-${stackInstanceNameSuffix(ID, 'Build', 1)}`);
    expect(sentName()).toBe(withStackScope(scope, () => applyDefaultNameForFallback('Build', TYPE, {}))['Name']);
  });

  it('before the state read, a legacy-shaped scope refuses rather than send the bare logical id', async () => {
    // The scope carries no id because the record is not read yet, not because
    // the stack is legacy: the generated name must not be derived there.
    await expect(
      withStackScopeBeforeStateRead('MyStack', () => provider.create('Build', TYPE, PROPS))
    ).rejects.toThrow(/derived before the state record/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('a declared name is sent as declared', async () => {
    await withStackScope({ stackName: 'MyStack', stackInstanceId: ID, nameGenerations: new Map() }, () =>
      provider.create('Build', TYPE, { ...PROPS, Name: 'mine' })
    );
    expect(sentName()).toBe('mine');
  });

  it('an update addresses the recorded project and derives no name', async () => {
    // A scope with an id but no generations: deriving a generated name throws.
    await withStackScope({ stackName: 'MyStack', stackInstanceId: ID, nameGenerations: undefined }, () =>
      provider.update('Build', 'Build', TYPE, PROPS, PROPS)
    );
    const command = mockSend.mock.calls[0]![0] as UpdateProjectCommand;
    expect(command).toBeInstanceOf(UpdateProjectCommand);
    expect(command.input.name).toBe('Build');
  });
});
