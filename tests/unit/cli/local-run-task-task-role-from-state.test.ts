import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * go-to-k/cdkd#6189, through the `local run-task` command body: the bare
 * `--assume-task-role` assumes the DEPLOYED task role a state source records,
 * not `role/<LogicalId>`, and says so when no record names it. The resolver
 * itself is real here; synthesis, the state provider and the runner are not.
 */

const runEcsTaskMock = vi.fn();
const stsSendMock = vi.fn();
const stateLoadMock = vi.fn();

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({ send: stsSendMock, destroy: vi.fn() })),
  AssumeRoleCommand: vi.fn().mockImplementation((input: unknown) => ({ kind: 'AssumeRole', input })),
  GetCallerIdentityCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ kind: 'GetCallerIdentity', input })),
}));

vi.mock('../../../src/local/local-aws-wiring.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  activateLocalAwsAndRoleArn: vi.fn(async () => {}),
}));
vi.mock('../../../src/local/docker-runner.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ensureDockerAvailable: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/local/docker-version.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveHostGatewayExtraHosts: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../src/cli/config-loader.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveApp: vi.fn().mockReturnValue('node app.js'),
}));

const STACK = {
  stackName: 'Cdkd6189Stack',
  displayName: 'Cdkd6189Stack',
  artifactId: 'Cdkd6189Stack',
  region: 'us-east-1',
  dependencyNames: [],
  template: {
    Resources: {
      TaskRole30FC0FBB: {
        Type: 'AWS::IAM::Role',
        Properties: { AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [] } },
      },
      TaskDef: {
        Type: 'AWS::ECS::TaskDefinition',
        Properties: {
          Family: 'cdkd-6189',
          NetworkMode: 'bridge',
          TaskRoleArn: { 'Fn::GetAtt': ['TaskRole30FC0FBB', 'Arn'] },
          ContainerDefinitions: [{ Name: 'app', Image: 'public.ecr.aws/nginx/nginx:alpine' }],
        },
      },
    },
  },
};

vi.mock('../../../src/synthesis/synthesizer.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: vi.fn().mockResolvedValue({ stacks: [STACK] }),
  })),
}));
const stateSourceGiven = vi.hoisted(() => ({ current: false }));
vi.mock('../../../src/cli/commands/local-state-source.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createLocalStateProvider: vi.fn(() =>
    stateSourceGiven.current
      ? {
          load: stateLoadMock,
          buildCrossStackResolver: vi.fn(),
          dispose: vi.fn(),
        }
      : undefined
  ),
}));
vi.mock('../../../src/local/ecs-task-runner.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createEcsRunState: vi.fn().mockReturnValue({ containers: [], entries: new Map() }),
  cleanupEcsRun: vi.fn().mockResolvedValue(undefined),
  runEcsTask: runEcsTaskMock,
}));

const { createLocalRunTaskCommand } = await import('../../../src/cli/commands/local-run-task.js');
const { taskRoleNameIsLogicalIdWarning } = await import(
  '../../../src/cli/commands/local-run-task/stack-account.js'
);
const { resetAwsClientDefaults } = await import('../../../src/utils/aws-client-defaults.js');
const { getLogger } = await import('../../../src/utils/logger.js');

const DEPLOYED_ARN = 'arn:aws:iam::000000000000:role/Cdkd6189Stack-TaskRole30FC0FBB-25c3bf832d6a';

async function runTask(args: string[]): Promise<void> {
  const cmd = createLocalRunTaskCommand();
  cmd.exitOverride();
  await cmd.parseAsync(['Cdkd6189Stack:TaskDef', ...args], { from: 'user' });
}

const assumedRoleArns = (): unknown[] =>
  stsSendMock.mock.calls
    .map((c) => c[0] as { kind: string; input: { RoleArn?: string } })
    .filter((c) => c.kind === 'AssumeRole')
    .map((c) => c.input.RoleArn);

let warnings: string[];

beforeEach(() => {
  stateSourceGiven.current = false;
  stateLoadMock.mockReset().mockResolvedValue({
    region: 'us-east-1',
    resources: {
      TaskRole30FC0FBB: {
        physicalId: 'Cdkd6189Stack-TaskRole30FC0FBB-25c3bf832d6a',
        resourceType: 'AWS::IAM::Role',
        properties: {},
        attributes: { Arn: DEPLOYED_ARN },
        dependencies: [],
      },
    },
  });
  runEcsTaskMock.mockReset().mockResolvedValue({
    state: { network: { networkName: 'cdkd-unit-net' } },
    exitCode: 0,
    essentialContainerName: undefined,
  });
  stsSendMock.mockReset().mockImplementation(async (cmd: { kind: string }) =>
    cmd.kind === 'GetCallerIdentity'
      ? { Account: '000000000000' }
      : {
          Credentials: {
            AccessKeyId: 'role-key',
            SecretAccessKey: 'role-secret',
            SessionToken: 'role-token',
          },
        }
  );
  warnings = [];
  vi.spyOn(getLogger(), 'warn').mockImplementation((m: unknown) => {
    warnings.push(String(m));
  });
  resetAwsClientDefaults();
  process.env['CDKD_APP'] = 'node app.js';
});

afterEach(() => {
  resetAwsClientDefaults();
  delete process.env['CDKD_APP'];
  vi.restoreAllMocks();
});

describe('local run-task bare --assume-task-role reads the deployed role (go-to-k/cdkd#6189)', () => {
  it('with a state source: assumes the recorded ARN, not role/<LogicalId>, and warns nothing about it', async () => {
    stateSourceGiven.current = true;
    await runTask(['--from-state', '--assume-task-role']);
    expect(stateLoadMock).toHaveBeenCalledTimes(1);
    expect(assumedRoleArns()).toEqual([DEPLOYED_ARN]);
    expect(warnings.join('\n')).not.toContain('assumes a role named');
  });

  it('with a state source whose record lacks the role: keeps role/<LogicalId> and names the gap', async () => {
    stateSourceGiven.current = true;
    stateLoadMock.mockResolvedValue({ region: 'us-east-1', resources: {} });
    await runTask(['--from-state', '--assume-task-role']);
    expect(assumedRoleArns()).toEqual(['arn:aws:iam::000000000000:role/TaskRole30FC0FBB']);
    expect(warnings).toContain(taskRoleNameIsLogicalIdWarning('TaskRole30FC0FBB', 'no-record'));
  });

  it('without a state source: keeps role/<LogicalId> and says a state source fixes it', async () => {
    await runTask(['--assume-task-role']);
    expect(assumedRoleArns()).toEqual(['arn:aws:iam::000000000000:role/TaskRole30FC0FBB']);
    expect(warnings).toContain(taskRoleNameIsLogicalIdWarning('TaskRole30FC0FBB', 'no-state-source'));
  });

  it('with a state source that loads nothing: says no record was read', async () => {
    stateSourceGiven.current = true;
    stateLoadMock.mockResolvedValue(undefined);
    await runTask(['--from-state', '--assume-task-role']);
    expect(assumedRoleArns()).toEqual(['arn:aws:iam::000000000000:role/TaskRole30FC0FBB']);
    expect(warnings).toContain(taskRoleNameIsLogicalIdWarning('TaskRole30FC0FBB', 'state-not-read'));
  });

  it('--from-cfn-stack shape (name only): builds the ARN, partition and account from the caller', async () => {
    stateSourceGiven.current = true;
    stateLoadMock.mockResolvedValue({
      region: 'cn-north-1',
      resources: {
        TaskRole30FC0FBB: {
          physicalId: 'Cdkd6189Stack-TaskRole30FC0FBB-25c3bf832d6a',
          resourceType: 'AWS::IAM::Role',
          properties: {},
          attributes: {},
          dependencies: [],
        },
      },
    });
    stsSendMock.mockImplementation(async (cmd: { kind: string }) =>
      cmd.kind === 'GetCallerIdentity'
        ? { Account: '111111111111', Arn: 'arn:aws-cn:iam::111111111111:user/dev' }
        : { Credentials: { AccessKeyId: 'k', SecretAccessKey: 's', SessionToken: 't' } }
    );
    await runTask(['--from-cfn-stack', '--assume-task-role']);
    expect(assumedRoleArns()).toEqual([
      'arn:aws-cn:iam::111111111111:role/Cdkd6189Stack-TaskRole30FC0FBB-25c3bf832d6a',
    ]);
    expect(warnings.join('\n')).not.toContain('assumes a role named');
  });

  it('an explicit ARN reads no state and warns nothing about the role name', async () => {
    stateSourceGiven.current = true;
    await runTask(['--from-state', '--assume-task-role=arn:aws:iam::000000000000:role/Explicit']);
    expect(stateLoadMock).not.toHaveBeenCalled();
    expect(assumedRoleArns()).toEqual(['arn:aws:iam::000000000000:role/Explicit']);
    expect(warnings.join('\n')).not.toContain('assumes a role named');
  });

  it('no --assume-task-role: reads no state for the task role', async () => {
    stateSourceGiven.current = true;
    await runTask(['--from-state']);
    expect(stateLoadMock).not.toHaveBeenCalled();
    expect(assumedRoleArns()).toEqual([]);
  });
});

describe('taskRoleNameIsLogicalIdWarning', () => {
  it('without a state source names both state flags and the explicit-ARN form', () => {
    const text = taskRoleNameIsLogicalIdWarning('TaskRole30FC0FBB', 'no-state-source');
    expect(text).toContain('--from-state');
    expect(text).toContain('--from-cfn-stack');
    expect(text).toContain("--assume-task-role '<arn>'");
    expect(text).toContain("'<Stack>-<LogicalId>-<suffix>'");
  });

  it('with a state source says the record lacks the role', () => {
    const text = taskRoleNameIsLogicalIdWarning('TaskRole30FC0FBB', 'no-record');
    expect(text).toContain('the state source has no record of the task role');
    expect(text).toContain("--assume-task-role '<arn>'");
  });

  it.each([
    ['state-not-read', 'read no state record'],
    ['mixed-mode-emulator-iam', 'AWS_ENDPOINT_URL_IAM'],
    ['path-not-literal', 'not a literal IAM path'],
  ] as const)('%s names its own cause', (reason, needle) => {
    const text = taskRoleNameIsLogicalIdWarning('TaskRole30FC0FBB', reason);
    expect(text).toContain(needle);
    expect(text).toContain("--assume-task-role '<arn>'");
  });

  it('renders a control character in the logical id inert', () => {
    expect(taskRoleNameIsLogicalIdWarning('Bad\u001bId', 'no-state-source')).not.toContain('\u001b');
  });
});
