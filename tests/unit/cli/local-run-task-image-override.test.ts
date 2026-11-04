import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * go-to-k/cdkd#5768: `cdkd local run-task` takes the `--image-override` flag
 * family (cdk-local's `addImageOverrideOptions`), rebuilds the task's
 * representative container from a local Dockerfile through cdk-local's
 * override engine, and refuses a same-stack ECR image no override covers
 * BEFORE the runner starts anything.
 *
 * `runImageOverrideBuilds` is the one engine primitive mocked: it runs
 * `docker build`. Flag parsing, key canonicalization, resolution and the
 * orphan check run for real.
 */
const h = vi.hoisted(() => ({
  runEcsTask: vi.fn(),
  runImageOverrideBuilds: vi.fn(),
  resolveImageOverridesArgs: [] as unknown[],
  stsSend: vi.fn(),
  task: undefined as unknown,
}));

vi.mock('cdk-local/internal', async (importOriginal) => {
  const real = await importOriginal<typeof import('cdk-local/internal')>();
  return {
    ...real,
    runImageOverrideBuilds: h.runImageOverrideBuilds,
    // Spied, not replaced: the real resolution runs, and the test reads what
    // the CLI asked of it (the boot prompt and the --no-interactive switch).
    resolveImageOverrides: vi.fn((args: Parameters<typeof real.resolveImageOverrides>[0]) => {
      h.resolveImageOverridesArgs.push(args);
      return real.resolveImageOverrides(args);
    }),
  };
});

vi.mock('@aws-sdk/client-sts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  STSClient: vi.fn().mockImplementation(() => ({ send: h.stsSend, destroy: vi.fn() })),
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
          stackName: 'S',
          displayName: 'S',
          artifactId: 'S',
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
  createLocalStateProvider: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../../../src/local/ecs-task-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  parseEcsTarget: vi.fn().mockReturnValue({ stackPattern: null, isPath: false, pathOrId: 'TD' }),
  resolveEcsTaskTarget: vi.fn(() => h.task),
  detectEcsImageResolutionNeeds: vi.fn().mockReturnValue({ needsCrossStackResolver: false }),
}));

vi.mock('../../../src/local/ecs-task-runner.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createEcsRunState: vi.fn().mockReturnValue({ containers: [], entries: new Map() }),
  cleanupEcsRun: vi.fn().mockResolvedValue(undefined),
  runEcsTask: h.runEcsTask,
}));

const { createLocalRunTaskCommand, resolveRunTaskImageOverride, buildEcsImageResolutionContext } =
  await import('../../../src/cli/commands/local-run-task.js');
const { getLogger } = await import('../../../src/utils/logger.js');
const { detectEcsImageResolutionNeeds } = await import('../../../src/local/ecs-task-resolver.js');
const { resolveImageOverrides } = await import('cdk-local/internal');

const SAME_STACK_REASON =
  "Container 'app' in task 'TD' references same-stack ECR repository 'Repo'. cdkd local run-task cannot resolve the repository URI without state — pass --from-state (cdkd-deployed) or --from-cfn-stack (cdk-deployed), build via ContainerImage.fromAsset, pin a public image, or pass --image-override to build it from a local Dockerfile.";

function makeTask(image: unknown, extra: Record<string, unknown> = {}): unknown {
  return {
    stack: { stackName: 'S', region: 'us-east-1' },
    taskDefinitionLogicalId: 'TD',
    resource: { Type: 'AWS::ECS::TaskDefinition', Metadata: { 'aws:cdk:path': 'S/Api/Resource' } },
    family: 'fam',
    containers: [{ name: 'app', essential: true, image }],
    ...extra,
  };
}

let dir: string;
let dockerfile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cdkd-5768-'));
  dockerfile = join(dir, 'Dockerfile');
  writeFileSync(dockerfile, 'FROM scratch\n');
  h.runEcsTask.mockReset();
  h.runEcsTask.mockResolvedValue({
    state: { network: { networkName: 'n' } },
    exitCode: 0,
    essentialContainerName: undefined,
  });
  h.resolveImageOverridesArgs.length = 0;
  h.stsSend.mockReset();
  h.runImageOverrideBuilds.mockReset();
  h.runImageOverrideBuilds.mockImplementation(
    async (overrides: Map<string, unknown>) =>
      new Map([...overrides.keys()].map((k) => [k, `cdkl-override-${k}:local`]))
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function run(args: string[]): Promise<void> {
  const cmd = createLocalRunTaskCommand();
  cmd.exitOverride();
  await cmd.parseAsync(['S/TD', '--no-interactive-overrides', ...args], { from: 'user' });
}

describe('createLocalRunTaskCommand — the --image-override flag family (go-to-k/cdkd#5768)', () => {
  it('registers every flag start-service / start-alb inherit from addImageOverrideOptions', () => {
    const longs = createLocalRunTaskCommand().options.map((o) => o.long);
    for (const flag of [
      '--image-override',
      '--image-build-arg',
      '--image-build-secret',
      '--image-target',
      '--image-context',
      '--no-interactive-overrides',
      '--strict-overrides',
    ]) {
      expect(longs).toContain(flag);
    }
  });

  it('parses the repeatable forms into arrays and the negated prompt flag into false', () => {
    const cmd = createLocalRunTaskCommand();
    cmd.action(() => {});
    cmd.parse(
      [
        'S/TD',
        '--image-override',
        'TD=./a/Dockerfile',
        '--image-context',
        'TD=.',
        '--image-target',
        'runtime',
        '--no-interactive-overrides',
        '--strict-overrides',
      ],
      { from: 'user' }
    );
    expect(cmd.opts()).toMatchObject({
      imageOverride: ['TD=./a/Dockerfile'],
      imageContext: ['TD=.'],
      interactiveOverrides: false,
      strictOverrides: true,
    });
  });
});

describe('localRunTaskCommand — same-stack ECR images (go-to-k/cdkd#5768)', () => {
  it('refuses an uncovered same-stack ECR image before the runner starts anything', async () => {
    h.task = makeTask({ kind: 'same-stack-ecr', repoLogicalId: 'Repo', unresolvedReason: SAME_STACK_REASON });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await run([]);
      expect(exit).toHaveBeenCalledWith(1);
      expect(errSpy.mock.calls.flat().join('\n')).toMatch(
        /references same-stack ECR repository 'Repo'.*--image-override/
      );
    } finally {
      exit.mockRestore();
      errSpy.mockRestore();
    }
    expect(h.runEcsTask).not.toHaveBeenCalled();
    expect(h.runImageOverrideBuilds).not.toHaveBeenCalled();
  });

  it('refuses before the --assume-task-role STS call when nothing can cover the image', async () => {
    h.task = makeTask({ kind: 'same-stack-ecr', repoLogicalId: 'Repo', unresolvedReason: SAME_STACK_REASON });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await run(['--assume-task-role', 'arn:aws:iam::123456789012:role/r']);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
      errSpy.mockRestore();
    }
    expect(h.stsSend).not.toHaveBeenCalled();
    expect(h.runEcsTask).not.toHaveBeenCalled();
  });

  it('in a terminal, defers the refusal to after the override pass (the boot prompt may cover it)', async () => {
    h.task = makeTask({ kind: 'same-stack-ecr', repoLogicalId: 'Repo', unresolvedReason: SAME_STACK_REASON });
    h.stsSend.mockResolvedValue({
      Credentials: { AccessKeyId: 'a', SecretAccessKey: 'b', SessionToken: 'c' },
    });
    // The prompt itself is the engine's; here it answers "no Dockerfile".
    vi.mocked(resolveImageOverrides).mockImplementationOnce(async () => new Map());
    const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const cmd = createLocalRunTaskCommand();
      cmd.exitOverride();
      await cmd.parseAsync(['S/TD', '--assume-task-role', 'arn:aws:iam::123456789012:role/r'], {
        from: 'user',
      });
      expect(exit).toHaveBeenCalledWith(1);
      expect(errSpy.mock.calls.flat().join('\n')).toMatch(/references same-stack ECR repository 'Repo'/);
    } finally {
      exit.mockRestore();
      errSpy.mockRestore();
      if (stdinTty) Object.defineProperty(process.stdin, 'isTTY', stdinTty);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
      if (stdoutTty) Object.defineProperty(process.stdout, 'isTTY', stdoutTty);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
    expect(h.stsSend).toHaveBeenCalledTimes(1);
    expect(h.runEcsTask).not.toHaveBeenCalled();
  });

  it('asks the engine for the boot prompt, switched off by --no-interactive-overrides', async () => {
    h.task = makeTask({ kind: 'public', uri: 'nginx' });
    await run([]);
    expect(h.resolveImageOverridesArgs).toEqual([
      expect.objectContaining({ interactiveBootPrompt: true, noInteractive: true }),
    ]);
    h.resolveImageOverridesArgs.length = 0;
    const cmd = createLocalRunTaskCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['S/TD'], { from: 'user' });
    expect(h.resolveImageOverridesArgs).toEqual([
      expect.objectContaining({ interactiveBootPrompt: true, noInteractive: false }),
    ]);
  });

  it('warns that local edits will not apply only while a registry image stays uncovered', async () => {
    const warn = vi.spyOn(getLogger(), 'warn');
    try {
      h.task = makeTask({ kind: 'public', uri: 'nginx' });
      await run([]);
      expect(warn.mock.calls.flat().join('\n')).toContain('local source edits will not take effect');
      warn.mockClear();
      await run(['--image-override', `S/TD=${dockerfile}`]);
      expect(warn.mock.calls.flat().join('\n')).not.toContain('local source edits will not take effect');
    } finally {
      warn.mockRestore();
    }
  });

  it('builds an --image-override for it and threads the tag to the runner', async () => {
    h.task = makeTask({ kind: 'same-stack-ecr', repoLogicalId: 'Repo', unresolvedReason: SAME_STACK_REASON });
    await run(['--image-override', `S/TD=${dockerfile}`]);
    expect(h.runImageOverrideBuilds).toHaveBeenCalledTimes(1);
    expect(h.runEcsTask).toHaveBeenCalledTimes(1);
    const runOpts = h.runEcsTask.mock.calls[0]![1] as {
      imageOverrideByContainer?: Map<string, string>;
    };
    expect([...(runOpts.imageOverrideByContainer ?? new Map())]).toEqual([
      ['app', 'cdkl-override-S/TD:local'],
    ]);
  });
});

describe('buildEcsImageResolutionContext — the no-state warning (go-to-k/cdkd#5768)', () => {
  const candidate = {
    stackName: 'S',
    region: 'us-east-1',
    template: {
      Resources: {
        Repo: { Type: 'AWS::ECR::Repository' },
        TD: {
          Type: 'AWS::ECS::TaskDefinition',
          Properties: {
            ContainerDefinitions: [{ Name: 'app', Image: { 'Fn::Sub': 'x/${Repo}:t' } }],
          },
        },
      },
    },
  };

  it.each([
    ['without --image-override, names it as a way out', [], true],
    ['with --image-override, stays quiet', ['TD=./Dockerfile'], false],
  ])('%s', async (_label, imageOverride, expected) => {
    // The command-level mock answers "nothing needed"; this case needs state.
    vi.mocked(detectEcsImageResolutionNeeds).mockReturnValueOnce({
      needsPseudoParameters: false,
      needsStateResources: true,
      needsEnvOrSecretSubstitution: false,
      needsCrossStackResolver: false,
      needsAssetRepoMarker: false,
    } as never);
    const warn = vi.spyOn(getLogger(), 'warn');
    try {
      await buildEcsImageResolutionContext(candidate as never, undefined, {
        imageOverride,
      } as never).catch(() => undefined);
      const text = warn.mock.calls.flat().join('\n');
      expect(text.includes('or --image-override to build it from a local Dockerfile')).toBe(expected);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('resolveRunTaskImageOverride (go-to-k/cdkd#5768)', () => {
  const opts = { interactiveOverrides: false };

  it('is a no-op for a local CDK asset image with no flag', async () => {
    const r = await resolveRunTaskImageOverride({
      task: makeTask({ kind: 'cdk-asset' }) as never,
      target: 'S/TD',
      options: opts,
      cwd: dir,
    });
    expect(r).toEqual({});
    expect(h.runImageOverrideBuilds).not.toHaveBeenCalled();
  });

  it('reports a deployed-registry pin with no override as pinnedUncovered', async () => {
    const r = await resolveRunTaskImageOverride({
      task: makeTask({ kind: 'ecr', uri: 'x', account: '1', region: 'us-east-1' }) as never,
      target: 'S/TD',
      options: opts,
      cwd: dir,
    });
    expect(r).toEqual({ pinnedUncovered: true });
  });

  it.each([['TD'], ['S:TD'], ['Api']])(
    'accepts the alias %s as the <key> of the explicit form',
    async (key) => {
      const r = await resolveRunTaskImageOverride({
        task: makeTask({ kind: 'public', uri: 'nginx' }) as never,
        target: 'S/TD',
        options: { ...opts, imageOverride: [`${key}=${dockerfile}`] },
        cwd: dir,
      });
      expect([...(r.imageOverrideByContainer ?? new Map())]).toEqual([
        ['app', 'cdkl-override-S/TD:local'],
      ]);
    }
  );

  it('takes the construct id above a trailing Service / Resource segment as an alias', async () => {
    const task = makeTask({ kind: 'public', uri: 'nginx' }) as { resource: { Metadata: object } };
    task.resource.Metadata = { 'aws:cdk:path': 'S/Worker/Service/Resource' };
    const r = await resolveRunTaskImageOverride({
      task: task as never,
      target: 'S/TD',
      options: { ...opts, imageOverride: [`Worker=${dockerfile}`] },
      cwd: dir,
    });
    expect(r.imageOverrideByContainer?.get('app')).toBe('cdkl-override-S/TD:local');
  });

  it('skips the bare <dockerfile> picker form without a TTY, leaving the pin uncovered', async () => {
    const r = await resolveRunTaskImageOverride({
      task: makeTask({ kind: 'public', uri: 'nginx' }) as never,
      target: 'S/TD',
      options: { ...opts, imageOverride: [dockerfile] },
      cwd: dir,
    });
    expect(r).toEqual({ pinnedUncovered: true });
    expect(h.runImageOverrideBuilds).not.toHaveBeenCalled();
  });

  it('passes --image-context through to the build entry', async () => {
    await resolveRunTaskImageOverride({
      task: makeTask({ kind: 'public', uri: 'nginx' }) as never,
      target: 'S/TD',
      options: { ...opts, imageOverride: [`TD=${dockerfile}`], imageContext: [dir] },
      cwd: dir,
    });
    const overrides = h.runImageOverrideBuilds.mock.calls[0]![0] as Map<string, { contextDir?: string }>;
    expect(overrides.get('S/TD')?.contextDir).toBe(dir);
  });

  it('refuses under --strict-overrides when the pin stays uncovered', async () => {
    await expect(
      resolveRunTaskImageOverride({
        task: makeTask({ kind: 'public', uri: 'nginx' }) as never,
        target: 'S/TD',
        options: { ...opts, strictOverrides: true },
        cwd: dir,
      })
    ).rejects.toThrow(/--strict-overrides set/);
    expect(h.runImageOverrideBuilds).not.toHaveBeenCalled();
  });

  it('refuses a per-service build input whose service has no override (orphan)', async () => {
    await expect(
      resolveRunTaskImageOverride({
        task: makeTask({ kind: 'cdk-asset' }) as never,
        target: 'S/TD',
        options: { ...opts, imageTarget: ['TD=runtime'] },
        cwd: dir,
      })
    ).rejects.toThrow();
  });
});
