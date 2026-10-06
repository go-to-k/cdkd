import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ResolvedEcsContainer, ResolvedEcsTask } from '../../../src/local/ecs-task-resolver.js';

/**
 * Issue [#2056](https://github.com/go-to-k/cdkd/issues/2056): `cdkd local
 * run-task` resolves CloudFormation dynamic references (`{{resolve:...}}`) in
 * container `Environment` values before boot, mirroring cdk-local's
 * `runEcsTask` (go-to-k/cdk-local#784) — cdkd runs its own ECS runner, so the
 * cdk-local bump alone does not reach it.
 *
 * The runner runs unmocked down to `execFile`, so each case reads the REAL
 * `docker run` argv and the spawn env the value-less `-e KEY` flags read
 * from. cdk-local's resolver runs for real too, with its AWS clients injected
 * through the client-factory seam.
 */

const PLAINTEXT = 'plain-2056-ecs-7f3a';
const TOKEN = '{{resolve:secretsmanager:task-secret:SecretString:password::}}';

const h = vi.hoisted(() => ({
  calls: [] as { args: string[]; opts: { env?: Record<string, string> } | undefined }[],
  smSend: vi.fn(),
  ssmSend: vi.fn(),
  destroy: vi.fn(),
  profiles: [] as Array<string | undefined>,
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: (...allArgs: unknown[]) => {
      const cb = allArgs[allArgs.length - 1] as (
        err: Error | null,
        res?: { stdout: string; stderr: string }
      ) => void;
      const args = allArgs[1] as string[];
      const opts = (allArgs.length === 4 ? allArgs[2] : undefined) as
        | { env?: Record<string, string> }
        | undefined;
      h.calls.push({ args, opts });
      cb(null, { stdout: args[0] === 'run' ? 'cid\n' : '', stderr: '' });
      return { kill: (): void => {} } as never;
    },
  };
});

// Only the caller-identity helper is doubled: a site that bypassed it would
// build real SDK clients and trip the AWS fence.
vi.mock('../../../src/local/dynamic-reference.js', async () =>
  (await import('../_caller-resolver-double.js')).callerResolverModule(h)
);

const net = vi.hoisted(() => ({ createTaskNetwork: vi.fn() }));
vi.mock('../../../src/local/ecs-network.js', () => ({
  createTaskNetwork: net.createTaskNetwork,
  destroyTaskNetwork: vi.fn(async () => undefined),
  buildMetadataEnv: vi.fn(() => ({})),
  METADATA_ENDPOINT_IMAGE: 'amazon/amazon-ecs-local-container-endpoints:latest-amd64',
  newTaskNetworkName: (prefix = 'cdkd-local') => `${prefix}-task-test`,
  taskSidecarName: (networkName: string) => `${networkName}-metadata`,
}));

vi.mock('../../../src/local/docker-runner.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/local/docker-runner.js')>(
    '../../../src/local/docker-runner.js'
  );
  return {
    ...actual,
    pullImage: vi.fn(async () => undefined),
    removeContainer: vi.fn(async () => undefined),
  };
});

vi.mock('../../../src/local/ecs-secrets-resolver.js', () => ({
  resolveEcsSecrets: vi.fn(
    async (entries: { containerName: string; name: string; valueFrom: string }[]) =>
      entries.map((e) => ({ ...e, value: `secret-${e.name}` }))
  ),
}));

import {
  createEcsRunState,
  runEcsTask,
  type RunEcsTaskOptions,
} from '../../../src/local/ecs-task-runner.js';
import { applyCrossStackResolverToTask } from '../../../src/local/ecs-task-resolver.js';

function makeContainer(over: Partial<ResolvedEcsContainer> = {}): ResolvedEcsContainer {
  return {
    name: 'app',
    image: { kind: 'public', uri: 'nginx:alpine' },
    environment: {},
    secrets: [],
    portMappings: [],
    mountPoints: [],
    dependsOn: [],
    links: [],
    essential: true,
    ulimits: [],
    warnings: [],
    ...over,
  };
}

function makeTask(container: ResolvedEcsContainer): ResolvedEcsTask {
  return {
    stack: {
      stackName: 'S1',
      displayName: 'S1',
      artifactId: 'S1',
      template: { Resources: {} },
      dependencyNames: [],
      region: 'us-east-1',
    },
    taskDefinitionLogicalId: 'TD',
    resource: { Type: 'AWS::ECS::TaskDefinition' },
    family: 'fam',
    networkMode: 'bridge',
    containers: [container],
    volumes: [],
    warnings: [],
  } as unknown as ResolvedEcsTask;
}

function options(over: Partial<RunEcsTaskOptions> = {}): RunEcsTaskOptions {
  return {
    cluster: 'cdkd-local',
    containerHost: '127.0.0.1',
    skipPull: true,
    keepRunning: false,
    detach: true,
    ...over,
  };
}

function dockerRun(): { args: string[]; env: Record<string, string> } {
  const run = h.calls.filter((c) => c.args[0] === 'run');
  expect(run).toHaveLength(1);
  return { args: run[0]!.args, env: run[0]!.opts?.env ?? {} };
}

/** The `-e` flag the argv carries for `key`, e.g. `KEY` or `KEY=value`. */
function envFlag(args: string[], key: string): string | undefined {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-e' && (args[i + 1] === key || args[i + 1]!.startsWith(`${key}=`))) {
      return args[i + 1];
    }
  }
  return undefined;
}

describe('runEcsTask resolves Environment dynamic references (#2056)', () => {
  beforeEach(() => {
    h.calls = [];
    h.smSend.mockReset();
    h.destroy.mockReset();
    h.profiles.length = 0;
    h.smSend.mockResolvedValue({ SecretString: JSON.stringify({ password: PLAINTEXT }) });
    net.createTaskNetwork.mockReset();
    net.createTaskNetwork.mockResolvedValue({
      networkName: 'cdkd-local-task-fake',
      sidecarContainerId: 'sidecar-fake',
      sidecarIp: '169.254.170.2',
    });
  });

  it('resolves the token and passes it value-less, off the argv', async () => {
    const c = makeContainer({ environment: { DB_PASSWORD: TOKEN, PLAIN: 'kept' } });
    await runEcsTask(makeTask(c), options(), createEcsRunState());

    const { args, env } = dockerRun();
    expect(envFlag(args, 'DB_PASSWORD')).toBe('DB_PASSWORD');
    expect(args.join(' ')).not.toContain(PLAINTEXT);
    expect(env['DB_PASSWORD']).toBe(PLAINTEXT);
    // A literal stays inline.
    expect(envFlag(args, 'PLAIN')).toBe('PLAIN=kept');
    // No --stack-region: the synth region of the task's stack.
    expect(h.smSend.mock.calls.map((x) => x[0])).toEqual(['us-east-1']);
  });

  it('--profile reaches the caller-identity resolver, which is disposed after the lookups', async () => {
    const c = makeContainer({ environment: { DB_PASSWORD: TOKEN } });
    await runEcsTask(makeTask(c), options({ profile: 'dev' }), createEcsRunState());
    expect(h.profiles).toEqual(['dev']);
    expect(h.destroy).toHaveBeenCalledWith('secretsmanager', 'us-east-1');
  });

  it('--stack-region wins over the synth region', async () => {
    const c = makeContainer({ environment: { DB_PASSWORD: TOKEN } });
    await runEcsTask(
      makeTask(c),
      options({ stackRegion: 'eu-west-1', region: 'ap-south-1' }),
      createEcsRunState()
    );
    expect(h.smSend.mock.calls.map((x) => x[0])).toEqual(['eu-west-1']);
  });

  it('a key an --env-vars override names is never looked up', async () => {
    const c = makeContainer({ environment: { DB_PASSWORD: TOKEN } });
    await runEcsTask(
      makeTask(c),
      options({ envOverrides: { Parameters: { DB_PASSWORD: 'local-literal' } } }),
      createEcsRunState()
    );
    expect(h.smSend).not.toHaveBeenCalled();
    expect(envFlag(dockerRun().args, 'DB_PASSWORD')).toBe('DB_PASSWORD=local-literal');
  });

  it('a key a same-name Secrets entry replaces is never looked up', async () => {
    const c = makeContainer({
      environment: { DB_PASSWORD: TOKEN },
      secrets: [{ name: 'DB_PASSWORD', valueFrom: 'arn:aws:ssm:us-east-1:1:parameter/x' }],
    });
    await runEcsTask(makeTask(c), options(), createEcsRunState());
    expect(h.smSend).not.toHaveBeenCalled();
    expect(dockerRun().env['DB_PASSWORD']).toBe('secret-DB_PASSWORD');
  });

  it('a value resolved at the cross-stack boundary is passed value-less and not re-scanned', async () => {
    // A plaintext that itself LOOKS like a token: re-scanning it would make a
    // lookup (and could quote a fragment of it in an error).
    const resolvedPlaintext = `${PLAINTEXT}-${TOKEN}`;
    const c = makeContainer({
      environment: { IMPORTED: resolvedPlaintext },
      resolvedDynamicReferenceKeys: ['IMPORTED'],
    });
    await runEcsTask(makeTask(c), options(), createEcsRunState());

    const { args, env } = dockerRun();
    expect(h.smSend).not.toHaveBeenCalled();
    expect(envFlag(args, 'IMPORTED')).toBe('IMPORTED');
    expect(args.join(' ')).not.toContain(PLAINTEXT);
    expect(env['IMPORTED']).toBe(resolvedPlaintext);
  });

  it.each([
    ['Command', { command: ['sh', '-c', `echo ${TOKEN}`] }],
    ['EntryPoint', { entryPoint: [TOKEN] }],
    ['HealthCheck.Command', { healthCheck: { command: ['CMD-SHELL', TOKEN] } }],
  ] as const)('a token in %s is refused before anything starts', async (field, over) => {
    const c = makeContainer(over as unknown as Partial<ResolvedEcsContainer>);
    await expect(runEcsTask(makeTask(c), options(), createEcsRunState())).rejects.toThrow(
      `${field} carries a CloudFormation dynamic reference`
    );
    expect(h.smSend).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(0);
  });

  it('a failed lookup fails before the network or any container exists, naming the reference', async () => {
    h.smSend.mockRejectedValue(
      Object.assign(new Error('not authorized'), {
        name: 'AccessDeniedException',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      })
    );
    const c = makeContainer({ environment: { DB_PASSWORD: TOKEN } });
    await expect(runEcsTask(makeTask(c), options(), createEcsRunState())).rejects.toThrow(
      /task-secret[\s\S]*Container app env var DB_PASSWORD/
    );
    expect(net.createTaskNetwork).not.toHaveBeenCalled();
    expect(h.destroy).toHaveBeenCalledWith('secretsmanager', 'us-east-1');
    expect(h.calls.filter((x) => x.args[0] === 'run')).toHaveLength(0);
  });
});

describe('applyCrossStackResolverToTask: the cross-stack boundary (#2056)', () => {
  function taskWith(raw: Record<string, unknown>): ResolvedEcsTask {
    return {
      ...makeTask(makeContainer()),
      resource: {
        Type: 'AWS::ECS::TaskDefinition',
        Properties: { ContainerDefinitions: [{ Name: 'app', ...raw }] },
      },
    } as unknown as ResolvedEcsTask;
  }

  it('an Environment value resolved by the hook is recorded as plaintext', async () => {
    const task = taskWith({
      Environment: [
        { Name: 'IMPORTED', Value: { 'Fn::ImportValue': 'SecretExport' } },
        { Name: 'PLAIN_IMPORT', Value: { 'Fn::ImportValue': 'PlainExport' } },
      ],
    });
    const hook = vi.fn(async () => PLAINTEXT);
    await applyCrossStackResolverToTask(task, {
      resources: {},
      consumerRegion: 'eu-west-1',
      crossStackResolver: {
        resolveImport: async (name: string) => (name === 'SecretExport' ? TOKEN : 'plain-value'),
        resolveGetStackOutput: async () => undefined,
      },
      resolveDynamicReferences: hook,
    });
    const c = task.containers[0]!;
    expect(c.environment).toEqual({ IMPORTED: PLAINTEXT, PLAIN_IMPORT: 'plain-value' });
    expect(c.resolvedDynamicReferenceKeys).toEqual(['IMPORTED']);
    expect(hook).toHaveBeenCalledWith(TOKEN, 'eu-west-1');
  });

  it('a Secrets ValueFrom never reaches the hook: it is an ARN, echoed as one', async () => {
    const task = taskWith({
      Secrets: [{ Name: 'S', ValueFrom: { 'Fn::ImportValue': 'SecretArnExport' } }],
    });
    const hook = vi.fn(async () => PLAINTEXT);
    await applyCrossStackResolverToTask(task, {
      resources: {},
      consumerRegion: 'eu-west-1',
      crossStackResolver: {
        resolveImport: async () => TOKEN,
        resolveGetStackOutput: async () => undefined,
      },
      resolveDynamicReferences: hook,
    });
    expect(hook).not.toHaveBeenCalled();
    expect(task.containers[0]!.secrets).toEqual([{ name: 'S', valueFrom: TOKEN }]);
  });
});

describe('runEcsTask: override shapes and the state-record region (#2056)', () => {
  beforeEach(() => {
    h.calls = [];
    h.smSend.mockReset();
    h.destroy.mockReset();
    h.profiles.length = 0;
    h.smSend.mockResolvedValue({ SecretString: JSON.stringify({ password: PLAINTEXT }) });
    net.createTaskNetwork.mockReset();
    net.createTaskNetwork.mockResolvedValue({
      networkName: 'cdkd-local-task-fake',
      sidecarContainerId: 'sidecar-fake',
      sidecarIp: '169.254.170.2',
    });
  });

  it('a container-scoped --env-vars override skips the lookup too', async () => {
    const c = makeContainer({ environment: { DB_PASSWORD: TOKEN } });
    await runEcsTask(
      makeTask(c),
      options({ envOverrides: { app: { DB_PASSWORD: 'local-literal' } } }),
      createEcsRunState()
    );
    expect(h.smSend).not.toHaveBeenCalled();
    expect(envFlag(dockerRun().args, 'DB_PASSWORD')).toBe('DB_PASSWORD=local-literal');
  });

  it('an override value the runner does NOT apply (an object) does not skip the lookup', async () => {
    const c = makeContainer({ environment: { DB_PASSWORD: TOKEN } });
    await runEcsTask(
      makeTask(c),
      options({
        envOverrides: { Parameters: { DB_PASSWORD: {} as unknown as string } },
      }),
      createEcsRunState()
    );
    const { args, env } = dockerRun();
    expect(h.smSend).toHaveBeenCalledTimes(1);
    expect(envFlag(args, 'DB_PASSWORD')).toBe('DB_PASSWORD');
    expect(env['DB_PASSWORD']).toBe(PLAINTEXT);
  });

  it('the loaded state record region comes first', async () => {
    const c = makeContainer({ environment: { DB_PASSWORD: TOKEN } });
    await runEcsTask(
      makeTask(c),
      options({ stateRecordRegion: 'ca-central-1', stackRegion: 'eu-west-1' }),
      createEcsRunState()
    );
    expect(h.smSend.mock.calls.map((x) => x[0])).toEqual(['ca-central-1']);
  });
});

describe('runEcsTask under finch on macOS refuses a dynamic-reference env var (#2056)', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let savedDocker: string | undefined;
  let savedOptIn: string | undefined;

  beforeEach(() => {
    h.calls = [];
    h.smSend.mockReset();
    h.destroy.mockReset();
    h.profiles.length = 0;
    h.smSend.mockResolvedValue({ SecretString: JSON.stringify({ password: PLAINTEXT }) });
    net.createTaskNetwork.mockReset();
    net.createTaskNetwork.mockResolvedValue({
      networkName: 'cdkd-local-task-fake',
      sidecarContainerId: 'sidecar-fake',
      sidecarIp: '169.254.170.2',
    });
    savedDocker = process.env['CDK_DOCKER'];
    savedOptIn = process.env['CDKD_ALLOW_SECRETS_ON_ARGV'];
    delete process.env['CDKD_ALLOW_SECRETS_ON_ARGV'];
    process.env['CDK_DOCKER'] = 'finch';
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'darwin' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', platformDescriptor);
    if (savedDocker === undefined) delete process.env['CDK_DOCKER'];
    else process.env['CDK_DOCKER'] = savedDocker;
    if (savedOptIn === undefined) delete process.env['CDKD_ALLOW_SECRETS_ON_ARGV'];
    else process.env['CDKD_ALLOW_SECRETS_ON_ARGV'] = savedOptIn;
  });

  it('a same-stack token: refused before its fetch and before anything starts', async () => {
    const c = makeContainer({ environment: { DB_PASSWORD: TOKEN } });
    await expect(runEcsTask(makeTask(c), options(), createEcsRunState())).rejects.toThrow(
      /refusing to forward secret\(s\) DB_PASSWORD under CDK_DOCKER=finch/
    );
    expect(h.smSend).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(0);
  });

  it('a value resolved at the cross-stack boundary: refused before anything starts', async () => {
    const c = makeContainer({
      environment: { IMPORTED: PLAINTEXT },
      resolvedDynamicReferenceKeys: ['IMPORTED'],
    });
    await expect(runEcsTask(makeTask(c), options(), createEcsRunState())).rejects.toThrow(
      /refusing to forward secret\(s\) IMPORTED under CDK_DOCKER=finch/
    );
    expect(h.calls).toHaveLength(0);
  });

  it('CDKD_ALLOW_SECRETS_ON_ARGV=1 lets it through, still value-less', async () => {
    process.env['CDKD_ALLOW_SECRETS_ON_ARGV'] = '1';
    const c = makeContainer({ environment: { DB_PASSWORD: TOKEN } });
    await runEcsTask(makeTask(c), options(), createEcsRunState());
    expect(envFlag(dockerRun().args, 'DB_PASSWORD')).toBe('DB_PASSWORD');
  });
});
