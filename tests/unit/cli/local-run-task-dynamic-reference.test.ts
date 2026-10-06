import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * Issue [#2056](https://github.com/go-to-k/cdkd/issues/2056): the WIRING in
 * `cdkd local run-task`'s command body. The runner and the cross-stack
 * post-pass are unit-tested on their own (`ecs-task-runner-dynamic-reference`);
 * this file proves the command hands them what they need:
 *
 * - the `SubstitutionContext` the cross-stack post-pass receives carries a
 *   `resolveDynamicReferences` hook that resolves a producer's redacted output
 *   against the PRODUCER's region, and
 * - `--stack-region` / `--profile` reach the runner's options.
 *
 * The command body runs for real; docker, synth, the ECS target resolver, the
 * state provider and the runner are mocked, as in
 * `local-run-task-command-body.test.ts`. cdk-local's resolver runs for real
 * with its AWS client injected through the client-factory seam.
 */

const PLAINTEXT = 'plain-2056-runtask-c3d1';
const TOKEN = '{{resolve:secretsmanager:producer-secret:SecretString:password::}}';

const h = vi.hoisted(() => ({
  smSend: vi.fn(),
  ssmSend: vi.fn(),
  destroy: vi.fn(),
  profiles: [] as Array<string | undefined>,
  runEcsTask: vi.fn(),
  hookResults: [] as unknown[],
  hookErrors: [] as string[],
  hookPresent: [] as boolean[],
}));

// Only the caller-identity helper is doubled: a site that bypassed it would
// build real SDK clients and trip the AWS fence.
vi.mock('../../../src/local/dynamic-reference.js', async () =>
  (await import('../_caller-resolver-double.js')).callerResolverModule(h)
);

// `--profile` resolves credentials for the task sidecar; that path is covered
// elsewhere, so a fixed set keeps it off the network.
vi.mock('../../../src/cli/commands/local-start-api.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveProfileCredentials: vi
    .fn()
    .mockResolvedValue({ accessKeyId: 'unit-akid-2056', secretAccessKey: 'unit-secret-2056' }),
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

vi.mock('../../../src/synthesis/synthesizer.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: vi.fn().mockResolvedValue({
      stacks: [
        {
          stackName: 'ConsumerStack',
          displayName: 'ConsumerStack',
          artifactId: 'ConsumerStack',
          region: 'us-east-1',
          template: { Resources: {} },
          dependencyNames: [],
        },
      ],
    }),
  })),
}));

vi.mock('../../../src/cli/commands/local-state-source.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createLocalStateProvider: vi.fn().mockReturnValue({
    label: '--from-state',
    // The record the task's stack was loaded from lives in another region.
    load: vi.fn().mockResolvedValue({ region: 'ca-central-1', resources: {}, outputs: {} }),
    buildCrossStackResolver: vi.fn().mockResolvedValue({
      resolveImport: vi.fn().mockResolvedValue(TOKEN),
      resolveGetStackOutput: vi.fn().mockResolvedValue(TOKEN),
    }),
    dispose: vi.fn(),
  }),
}));

vi.mock('../../../src/local/ecs-task-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  parseEcsTarget: vi.fn().mockReturnValue({ stackPattern: null, isPath: false, pathOrId: 'TaskDef' }),
  resolveEcsTaskTarget: vi.fn().mockReturnValue({
    stack: { stackName: 'ConsumerStack', region: 'us-east-1' },
    taskDefinitionLogicalId: 'TaskDef',
    family: 'cdkd-unit-family',
    containers: [{ name: 'app' }],
    taskRoleArn: undefined,
  }),
  detectEcsImageResolutionNeeds: vi
    .fn()
    .mockReturnValue({ needsCrossStackResolver: true, needsStateResources: true }),
  // The capture point: call the hook the command installed, as the real
  // post-pass does for a cross-stack value carrying a token.
  applyCrossStackResolverToTask: vi.fn(
    async (
      _task: unknown,
      ctx: { resolveDynamicReferences?: (v: string, r: string) => Promise<string> }
    ) => {
      h.hookPresent.push(ctx.resolveDynamicReferences !== undefined);
      if (ctx.resolveDynamicReferences) {
        try {
          h.hookResults.push(await ctx.resolveDynamicReferences(TOKEN, 'ap-northeast-1'));
        } catch (err) {
          h.hookErrors.push(err instanceof Error ? err.message : String(err));
        }
      }
    }
  ),
}));

vi.mock('../../../src/local/ecs-task-runner.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createEcsRunState: vi.fn().mockReturnValue({ containers: [], entries: new Map() }),
  cleanupEcsRun: vi.fn().mockResolvedValue(undefined),
  runEcsTask: h.runEcsTask,
}));

const { createLocalRunTaskCommand, buildRunEcsTaskOptions } = await import(
  '../../../src/cli/commands/local-run-task.js'
);

const savedRegion = process.env['AWS_REGION'];

beforeEach(() => {
  h.smSend.mockReset();
  h.smSend.mockResolvedValue({ SecretString: JSON.stringify({ password: PLAINTEXT }) });
  h.runEcsTask.mockReset();
  h.runEcsTask.mockResolvedValue({
    state: { network: { networkName: 'cdkd-unit-net' } },
    exitCode: 0,
    essentialContainerName: undefined,
  });
  h.hookResults.length = 0;
  h.hookPresent.length = 0;
  h.hookErrors.length = 0;
  h.profiles.length = 0;
  h.destroy.mockReset();
  process.env['AWS_REGION'] = 'us-east-1';
});

afterEach(() => {
  if (savedRegion === undefined) delete process.env['AWS_REGION'];
  else process.env['AWS_REGION'] = savedRegion;
});

describe('local run-task wires dynamic-reference resolution (#2056)', () => {
  it('the cross-stack post-pass gets a hook that resolves in the producer region', async () => {
    const cmd = createLocalRunTaskCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['ConsumerStack/TaskDef', '--from-state', '--stack-region', 'eu-west-1', '--profile', 'dev'], {
      from: 'user',
    });

    expect(h.hookPresent).toEqual([true]);
    expect(h.hookResults).toEqual([PLAINTEXT]);
    expect(h.smSend.mock.calls.map((c) => c[0])).toEqual(['ap-northeast-1']);
    expect(h.smSend.mock.calls[0]![1]).toMatchObject({ SecretId: 'producer-secret' });
    // `--stack-region` reaches the runner, which resolves same-stack tokens.
    expect(h.runEcsTask).toHaveBeenCalledTimes(1);
    // So do --profile and the loaded record's region.
    expect(h.runEcsTask.mock.calls[0]![1]).toMatchObject({
      stackRegion: 'eu-west-1',
      profile: 'dev',
      stateRecordRegion: 'ca-central-1',
    });
    // The boundary resolver is the caller-identity helper, with --profile,
    // and it is disposed once the post-pass is done.
    expect(h.profiles).toEqual(['dev']);
    expect(h.destroy).toHaveBeenCalledWith('secretsmanager', 'ap-northeast-1');
  });

  it('a failed boundary lookup names the reference and does NOT offer --env-vars, which applies only later', async () => {
    h.smSend.mockRejectedValue(
      Object.assign(new Error('not authorized'), {
        name: 'AccessDeniedException',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      })
    );
    const cmd = createLocalRunTaskCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['ConsumerStack/TaskDef', '--from-state'], { from: 'user' });

    expect(h.hookErrors).toHaveLength(1);
    expect(h.hookErrors[0]).toContain('producer-secret');
    expect(h.hookErrors[0]).toContain('Task TaskDef cross-stack env value');
    expect(h.hookErrors[0]).not.toContain('--env-vars');
    expect(h.destroy).toHaveBeenCalledWith('secretsmanager', 'ap-northeast-1');
  });

  it('buildRunEcsTaskOptions carries --stack-region and --profile to the runner', () => {
    const runOpts = buildRunEcsTaskOptions(
      {
        cluster: 'cdkd-local',
        containerHost: '127.0.0.1',
        pull: true,
        keepRunning: false,
        detach: false,
        stackRegion: 'eu-west-1',
        profile: 'dev',
      },
      { sidecarCredentials: undefined, profileCredsFile: undefined },
      { stateRecordRegion: 'ca-central-1' }
    );
    expect(runOpts.stateRecordRegion).toBe('ca-central-1');
    expect(runOpts.stackRegion).toBe('eu-west-1');
    expect(runOpts.profile).toBe('dev');
  });
});
