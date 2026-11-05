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
const synthMock = vi.hoisted(() => ({
  failedLookups: undefined as Array<{ key: string; error: string }> | undefined,
  options: [] as unknown[],
}));

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
const stacks: Array<Record<string, unknown>> = [
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
    synthesize: vi.fn().mockImplementation((opts: unknown) => {
      synthMock.options.push(opts);
      return Promise.resolve({ stacks, failedLookups: synthMock.failedLookups });
    }),
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

const { getLogger } = await import('../../../src/utils/logger.js');
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

// go-to-k/cdkd#5807: a failed context lookup blocks only the stack the task runs from.
describe('cdkd local run-task and a failed context lookup (go-to-k/cdkd#5807)', () => {
  const asking = stacks[1]!;
  const savedMessages = asking['messages'];

  beforeEach(() => {
    createLocalStateProviderMock.mockClear();
    runEcsTaskMock.mockReset();
    runEcsTaskMock.mockResolvedValue({
      state: { network: { networkName: 'cdkd-unit-net' } },
      exitCode: 0,
      essentialContainerName: undefined,
    });
    process.env['CDKD_APP'] = 'node app.js';
    synthMock.options = [];
    synthMock.failedLookups = [{ key: 'ssm:k', error: 'AccessDenied' }];
    asking['messages'] = [{ level: 'error', path: '/MyStage/Api', message: 'AccessDenied' }];
  });

  afterEach(() => {
    synthMock.failedLookups = undefined;
    asking['messages'] = savedMessages;
  });

  it('refuses a task in the stack that asked, before the run', async () => {
    const errorSpy = vi.spyOn(getLogger(), 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit-mock');
    }) as never);
    try {
      await expect(runTask('MyStage/Api/TD')).rejects.toThrow('process.exit-mock');
      expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
        'Context lookup failed: ssm:k: AccessDenied'
      );
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }

    expect(synthMock.options[0]).toMatchObject({ failedLookupsCheckedByCaller: true });
    expect(runEcsTaskMock).not.toHaveBeenCalled();
  });

  it('runs a task in a stack that did not ask', async () => {
    await runTask('Top/TD');

    expect(runEcsTaskMock).toHaveBeenCalledTimes(1);
  });
});
