/**
 * `cdkd local run-task`'s COMMAND BODY hands the state source the Stage stack
 * a path-form target names (issue [#3953](https://github.com/go-to-k/cdkd/issues/3953)).
 *
 * `pickCandidateStack` is unit-tested on its own; this file drives the body so
 * the CALL SITE is fenced too -- the line that passes the target through. With
 * it wrong, the resolver still finds the task (so nothing fails) while
 * `createLocalStateProvider` receives an empty stack name, which is how the
 * run went ahead with no state source.
 *
 * REAL: `parseEcsTarget`, `pickCandidateStack`, `resolveEcsTaskTarget`.
 * MOCKED: docker, synth (returns a Stage stack), the state provider factory
 * (the capture point) and the runner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const createLocalStateProviderMock = vi.fn().mockReturnValue(undefined);
const runEcsTaskMock = vi.fn();

vi.mock('../../../src/local/docker-runner.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ensureDockerAvailable: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/local/docker-version.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveHostGatewayExtraHosts: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../src/utils/role-arn.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  applyRoleArnIfSet: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/cli/config-loader.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveApp: vi.fn().mockReturnValue('node app.js'),
}));

const taskDef = (cdkPath: string) => ({
  Type: 'AWS::ECS::TaskDefinition',
  Properties: { Family: 'fam', ContainerDefinitions: [{ Name: 'app', Image: 'nginx' }] },
  Metadata: { 'aws:cdk:path': cdkPath },
});
const stacks = [
  {
    stackName: 'Top',
    displayName: 'Top',
    artifactId: 'Top',
    dependencyNames: [],
    region: 'us-east-1',
    template: { Resources: { TopTD: taskDef('Top/TD/Resource') } },
  },
  {
    stackName: 'MyStage-Api',
    displayName: 'MyStage/Api',
    artifactId: 'MyStageApi',
    dependencyNames: [],
    region: 'eu-west-1',
    template: { Resources: { ApiTD: taskDef('MyStage/Api/TD/Resource') } },
  },
];

vi.mock('../../../src/synthesis/synthesizer.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: vi.fn().mockResolvedValue({ stacks }),
  })),
}));
vi.mock('../../../src/cli/commands/local-state-source.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createLocalStateProvider: createLocalStateProviderMock,
}));
vi.mock('../../../src/local/ecs-task-runner.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createEcsRunState: vi.fn().mockReturnValue({ containers: [], entries: new Map() }),
  cleanupEcsRun: vi.fn().mockResolvedValue(undefined),
  runEcsTask: runEcsTaskMock,
}));

const { createLocalRunTaskCommand } = await import(
  '../../../src/cli/commands/local-run-task.js'
);

async function runTask(target: string): Promise<void> {
  const cmd = createLocalRunTaskCommand();
  cmd.exitOverride();
  await cmd.parseAsync([target, '--no-pull'], { from: 'user' });
}

describe('cdkd local run-task: the state source follows a Stage target (go-to-k/cdkd#3953)', () => {
  const savedApp = process.env['CDKD_APP'];

  afterEach(() => {
    if (savedApp === undefined) delete process.env['CDKD_APP'];
    else process.env['CDKD_APP'] = savedApp;
  });

  beforeEach(() => {
    createLocalStateProviderMock.mockClear();
    runEcsTaskMock.mockReset();
    runEcsTaskMock.mockResolvedValue({
      state: { network: { networkName: 'cdkd-unit-net' } },
      exitCode: 0,
      essentialContainerName: undefined,
    });
    process.env['CDKD_APP'] = 'node app.js';
  });

  it('passes the Stage stack a path-form target names, with its region', async () => {
    await runTask('MyStage/Api/TD');

    expect(createLocalStateProviderMock).toHaveBeenCalledTimes(1);
    expect(createLocalStateProviderMock.mock.calls[0]?.slice(1)).toEqual([
      'MyStage-Api',
      'eu-west-1',
    ]);
    expect(runEcsTaskMock).toHaveBeenCalledTimes(1);
    expect(
      (runEcsTaskMock.mock.calls[0]?.[0] as { taskDefinitionLogicalId: string })
        .taskDefinitionLogicalId
    ).toBe('ApiTD');
  });

  it('control: a top-level target reaches its own stack', async () => {
    await runTask('Top/TD');

    expect(createLocalStateProviderMock.mock.calls[0]?.slice(1)).toEqual(['Top', 'us-east-1']);
  });
});
