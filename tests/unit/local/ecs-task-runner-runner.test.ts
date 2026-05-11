import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ResolvedEcsContainer,
  ResolvedEcsTask,
  ResolvedEcsVolume,
} from '../../../src/local/ecs-task-resolver.js';

// =====================================================================
// Mocking strategy
// =====================================================================
// `runEcsTask` calls these helpers in order:
//   1. prepareImages → pullImage / pullEcrImage / buildDockerImage
//   2. resolveEcsSecrets (ecs-secrets-resolver)
//   3. createTaskNetwork (ecs-network)
//   4. realizeDockerVolumes → execFileAsync('docker', ['volume', 'create', ...])
//   5. Per-container start loop:
//        - awaitDependencies → execFileAsync('docker', ['wait', id])
//          OR execFileAsync('docker', ['inspect', '--format', '{{.State.Health.Status}}', id])
//        - execFileAsync('docker', args) → returns container id
//        - streamContainerLogs → spawn('docker', ['logs', '-f', id])
//   6. waitForContainerExit on the essential container
//   7. destroyTaskNetwork on cleanup
//
// child_process.execFile MUST support both 3-arg `execFile(cmd, args, cb)`
// (used by `promisify(execFile)(cmd, args)`) AND 4-arg
// `execFile(cmd, args, opts, cb)` shapes (used by `execFileAsync(cmd, args,
// { maxBuffer })`). See `feedback_mock_execfile_3and4arg.md`.
//
// Each test sets `execFileResponder` to a per-test callback that returns
// the stdout/stderr/err for one invocation. We capture every call in
// `captured.calls` for assertions.

const captured = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: string[]; opts: unknown }[],
  // Per-test responder; defaults to "return synthetic id".
  responder: undefined as
    | ((cmd: string, args: string[]) =>
        | { stdout?: string; stderr?: string; err?: Error }
        | Promise<{ stdout?: string; stderr?: string; err?: Error }>)
    | undefined,
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
      const cmd = allArgs[0] as string;
      const args = allArgs[1] as string[];
      const opts = allArgs.length === 4 ? allArgs[2] : undefined;
      captured.calls.push({ cmd, args, opts });
      const respond = (
        out: { stdout?: string; stderr?: string; err?: Error } | void
      ): void => {
        if (out?.err) {
          // Match the SDK shape — provider code reads `err.stderr` /
          // `err.message`. Tack the captured stderr on so the error path
          // surfaces useful text.
          const e = out.err as Error & { stderr?: string };
          if (out.stderr !== undefined) e.stderr = out.stderr;
          cb(e);
          return;
        }
        cb(null, { stdout: out?.stdout ?? 'fake-id\n', stderr: out?.stderr ?? '' });
      };
      const r = captured.responder?.(cmd, args);
      if (r && 'then' in r) {
        (r as Promise<{ stdout?: string; stderr?: string; err?: Error }>).then(respond);
      } else {
        respond(r as { stdout?: string; stderr?: string; err?: Error } | void);
      }
      return { kill: (): void => {} } as never;
    },
    spawn: (_cmd: string, _args: string[]) => {
      // streamContainerLogs uses this. Return a fake proc that registers
      // no-op handlers; the runner only `kill('SIGTERM')`s it on cleanup.
      const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
      const proc = {
        killed: false,
        stdout: {
          on: (e: string, h: (chunk: Buffer) => void): unknown => {
            (handlers['stdout-' + e] = handlers['stdout-' + e] || []).push(
              h as unknown as (arg?: unknown) => void
            );
            return proc;
          },
        },
        stderr: {
          on: (e: string, h: (chunk: Buffer) => void): unknown => {
            (handlers['stderr-' + e] = handlers['stderr-' + e] || []).push(
              h as unknown as (arg?: unknown) => void
            );
            return proc;
          },
        },
        on: (e: string, h: (arg?: unknown) => void): unknown => {
          (handlers[e] = handlers[e] || []).push(h);
          return proc;
        },
        kill: (_sig?: string): boolean => {
          proc.killed = true;
          return true;
        },
      };
      return proc as never;
    },
  };
});

// docker-runner: pullImage / removeContainer get stubbed so we never hit
// real docker. DockerRunnerError must come from the actual module so
// `instanceof` checks the runner depends on stay correct.
const dockerRunnerStubs = vi.hoisted(() => ({
  pullImage: vi.fn(async (_image: string, _skip: boolean): Promise<void> => undefined),
  removeContainer: vi.fn(async (_id: string): Promise<void> => undefined),
}));
vi.mock('../../../src/local/docker-runner.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/local/docker-runner.js')>(
    '../../../src/local/docker-runner.js'
  );
  return {
    ...actual,
    pullImage: dockerRunnerStubs.pullImage,
    removeContainer: dockerRunnerStubs.removeContainer,
  };
});

// ecr-puller
const ecrStubs = vi.hoisted(() => ({
  pullEcrImage: vi.fn(async (uri: string, _opts: unknown): Promise<string> => uri),
}));
vi.mock('../../../src/local/ecr-puller.js', () => ({
  pullEcrImage: ecrStubs.pullEcrImage,
}));

// docker-build (asset path)
const dockerBuildStubs = vi.hoisted(() => ({
  buildDockerImage: vi.fn(
    async (_asset: unknown, _ctx: string, _tag: string, _opts: unknown): Promise<void> => undefined
  ),
}));
vi.mock('../../../src/assets/docker-build.js', () => ({
  buildDockerImage: dockerBuildStubs.buildDockerImage,
}));

// ecs-network
const networkStubs = vi.hoisted(() => ({
  createTaskNetwork: vi.fn(async (_opts: unknown) => ({
    networkName: 'cdkd-local-task-fake',
    sidecarContainerId: 'sidecar-fake',
  })),
  destroyTaskNetwork: vi.fn(async (_net: unknown): Promise<void> => undefined),
  buildMetadataEnv: vi.fn((opts: { containerName: string; roleArn?: string; region?: string }) => {
    const env: Record<string, string> = {
      ECS_CONTAINER_METADATA_URI_V4: `http://169.254.170.2/v4/${opts.containerName}`,
    };
    if (opts.roleArn) env['AWS_CONTAINER_CREDENTIALS_RELATIVE_URI'] = `/role/${opts.roleArn}`;
    if (opts.region) env['AWS_REGION'] = opts.region;
    return env;
  }),
}));
vi.mock('../../../src/local/ecs-network.js', () => ({
  createTaskNetwork: networkStubs.createTaskNetwork,
  destroyTaskNetwork: networkStubs.destroyTaskNetwork,
  buildMetadataEnv: networkStubs.buildMetadataEnv,
}));

// ecs-secrets-resolver
const secretsStubs = vi.hoisted(() => ({
  resolveEcsSecrets: vi.fn(
    async (
      entries: { containerName: string; name: string; valueFrom: string }[]
    ): Promise<{ containerName: string; name: string; valueFrom: string; value: string }[]> =>
      entries.map((e) => ({ ...e, value: `resolved-${e.name}` }))
  ),
}));
vi.mock('../../../src/local/ecs-secrets-resolver.js', () => ({
  resolveEcsSecrets: secretsStubs.resolveEcsSecrets,
}));

// asset-manifest-loader: mock the class so the cdk-asset image branch
// doesn't try to read cdk.out from disk.
const manifestStubs = vi.hoisted(() => ({
  loadManifest: vi.fn(
    async (
      _cdkOut: string,
      _stack: string
    ): Promise<{
      dockerImages: Record<string, { source: { directory: string } }>;
    } | null> => ({
      dockerImages: {
        h0: { source: { directory: '/tmp/asset-h0' } },
        h1: { source: { directory: '/tmp/asset-h1' } },
      },
    })
  ),
}));
vi.mock('../../../src/assets/asset-manifest-loader.js', () => ({
  AssetManifestLoader: class {
    async loadManifest(cdkOut: string, stack: string): Promise<unknown> {
      return manifestStubs.loadManifest(cdkOut, stack);
    }
  },
}));

import {
  cleanupEcsRun,
  createEcsRunState,
  runEcsTask,
  type EcsRunState,
  type RunEcsTaskOptions,
} from '../../../src/local/ecs-task-runner.js';
import { DockerRunnerError } from '../../../src/local/docker-runner.js';

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

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

function makeTask(over: Partial<ResolvedEcsTask> = {}): ResolvedEcsTask {
  return {
    stack: {
      stackName: 'S1',
      displayName: 'S1',
      artifactId: 'S1',
      template: { Resources: {} },
      dependencyNames: [],
    },
    taskDefinitionLogicalId: 'TD',
    resource: { Type: 'AWS::ECS::TaskDefinition' },
    family: 'fam',
    networkMode: 'bridge',
    containers: [makeContainer()],
    volumes: [],
    warnings: [],
    ...over,
  };
}

function baseOptions(over: Partial<RunEcsTaskOptions> = {}): RunEcsTaskOptions {
  return {
    cluster: 'cdkd-local',
    containerHost: '127.0.0.1',
    skipPull: true,
    keepRunning: false,
    detach: false,
    ...over,
  };
}

// Track docker `run` calls (the actual container starts) — distinct from
// `volume create` / `wait` / `inspect` calls — so tests can assert order
// and per-container args.
function dockerRunCalls(): { cmd: string; args: string[]; opts: unknown }[] {
  return captured.calls.filter((c) => c.args[0] === 'run');
}

function counterByLeadArg(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of captured.calls) {
    const lead = c.args[0] ?? '';
    out[lead] = (out[lead] ?? 0) + 1;
  }
  return out;
}

// Neutralize any latent `process.exit` call so Node 24's stricter
// unhandled-rejection handler doesn't surface vitest's monkey-patched
// `process.exit unexpectedly called` as a worker error.
// Vitest's runtime wraps `process.exit` and throws on call; that throw
// propagates as an unhandled Promise rejection on Node 24 (Node 20/22
// swallow). The same trap was already fixed for the Commander-test
// shape (`feedback_cmd_parse_action_stub.md`); this is the non-Commander
// shape — any async path that ends up at handleError → process.exit
// gets neutralized here. Mirrors the pattern used by every
// tests/unit/cli/*.test.ts that exercises `withErrorHandling`.
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  captured.calls = [];
  captured.responder = undefined;
  dockerRunnerStubs.pullImage.mockClear();
  dockerRunnerStubs.removeContainer.mockClear();
  ecrStubs.pullEcrImage.mockClear();
  dockerBuildStubs.buildDockerImage.mockClear();
  networkStubs.createTaskNetwork.mockClear();
  networkStubs.destroyTaskNetwork.mockClear();
  secretsStubs.resolveEcsSecrets.mockClear();
  manifestStubs.loadManifest.mockClear();
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});

afterEach(() => {
  captured.responder = undefined;
  exitSpy.mockRestore();
});

// =====================================================================
// G1: runEcsTask end-to-end via mocks
// =====================================================================

describe('runEcsTask — image preparation (G1)', () => {
  // Default responder: every docker call succeeds; container ids cycle
  // c1, c2, ...; `docker wait` returns exit 0.
  function happyDockerResponder() {
    let containerIdSeq = 0;
    return (_cmd: string, args: string[]) => {
      if (args[0] === 'run') return { stdout: `c${++containerIdSeq}\n` };
      if (args[0] === 'wait') return { stdout: '0\n' };
      return { stdout: '' };
    };
  }

  it('public image kind → calls pullImage and uses image.uri unchanged', async () => {
    captured.responder = happyDockerResponder();
    const c = makeContainer({ image: { kind: 'public', uri: 'busybox:latest' } });
    const state = createEcsRunState();
    const result = await runEcsTask(makeTask({ containers: [c] }), baseOptions(), state);

    expect(result.exitCode).toBe(0);
    expect(dockerRunnerStubs.pullImage).toHaveBeenCalledWith('busybox:latest', true);
    // Container's docker run got the public image URI verbatim.
    const runCall = dockerRunCalls()[0]!;
    expect(runCall.args).toContain('busybox:latest');
  });

  it('ecr image kind → routes through pullEcrImage and propagates region', async () => {
    captured.responder = happyDockerResponder();
    ecrStubs.pullEcrImage.mockImplementationOnce(async (uri) => `${uri}-pulled-tag`);
    const c = makeContainer({
      image: {
        kind: 'ecr',
        uri: '123.dkr.ecr.us-east-1.amazonaws.com/repo:tag',
        account: '123',
        region: 'us-east-1',
      },
    });
    const state = createEcsRunState();
    await runEcsTask(
      makeTask({ containers: [c] }),
      baseOptions({ region: 'us-east-1' }),
      state
    );
    expect(ecrStubs.pullEcrImage).toHaveBeenCalledTimes(1);
    const [uri, opts] = ecrStubs.pullEcrImage.mock.calls[0]!;
    expect(uri).toBe('123.dkr.ecr.us-east-1.amazonaws.com/repo:tag');
    expect(opts).toMatchObject({ skipPull: true, region: 'us-east-1' });
  });

  it('cdk-asset image kind → loadManifest + buildDockerImage with stable tag', async () => {
    captured.responder = happyDockerResponder();
    const c = makeContainer({ image: { kind: 'cdk-asset', assetHash: 'h0' } });
    const task = makeTask({
      containers: [c],
      stack: {
        stackName: 'S1',
        displayName: 'S1',
        artifactId: 'S1',
        template: { Resources: {} },
        dependencyNames: [],
        assetManifestPath: '/tmp/cdk.out/S1.assets.json',
      },
    });
    const state = createEcsRunState();
    await runEcsTask(task, baseOptions(), state);
    expect(manifestStubs.loadManifest).toHaveBeenCalledWith('/tmp/cdk.out', 'S1');
    expect(dockerBuildStubs.buildDockerImage).toHaveBeenCalledTimes(1);
    const [asset, ctx, tag] = dockerBuildStubs.buildDockerImage.mock.calls[0]!;
    expect(asset).toEqual({ source: { directory: '/tmp/asset-h0' } });
    expect(ctx).toBe('/tmp/cdk.out');
    expect(typeof tag).toBe('string');
    expect((tag as string).startsWith('cdkd-local-run-task-')).toBe(true);
  });

  it('cdk-asset with no asset manifest path → throws EcsTaskRunnerError', async () => {
    captured.responder = happyDockerResponder();
    const c = makeContainer({ image: { kind: 'cdk-asset', assetHash: 'h0' } });
    // Task with no assetManifestPath — the cdk-asset branch demands it.
    const state = createEcsRunState();
    await expect(runEcsTask(makeTask({ containers: [c] }), baseOptions(), state)).rejects.toThrow(
      /asset manifest/i
    );
  });
});

describe('runEcsTask — docker volume realization (G1)', () => {
  function happyDockerResponder() {
    let seq = 0;
    return (_cmd: string, args: string[]) => {
      if (args[0] === 'run') return { stdout: `c${++seq}\n` };
      if (args[0] === 'wait') return { stdout: '0\n' };
      return { stdout: '' };
    };
  }

  it('happy path: docker volume create with driver/opts/labels + recorded in state.dockerVolumeNames', async () => {
    captured.responder = happyDockerResponder();
    const dockerVol: ResolvedEcsVolume = {
      name: 'data',
      kind: 'docker',
      dockerVolumeConfig: {
        scope: 'task',
        driver: 'local',
        driverOpts: { type: 'tmpfs' },
        labels: { foo: 'bar' },
      },
    };
    const c = makeContainer({
      mountPoints: [{ sourceVolume: 'data', containerPath: '/d', readOnly: false }],
    });
    const state = createEcsRunState();
    await runEcsTask(makeTask({ containers: [c], volumes: [dockerVol] }), baseOptions(), state);
    const volCreate = captured.calls.find(
      (call) => call.args[0] === 'volume' && call.args[1] === 'create'
    );
    expect(volCreate).toBeDefined();
    expect(volCreate!.args).toContain('--driver');
    expect(volCreate!.args).toContain('local');
    expect(volCreate!.args).toContain('--opt');
    expect(volCreate!.args).toContain('type=tmpfs');
    expect(volCreate!.args).toContain('--label');
    expect(volCreate!.args).toContain('foo=bar');
    expect(state.dockerVolumeNames).toHaveLength(1);
    expect(state.dockerVolumeNames[0]!).toMatch(/^cdkd-local-data-/);
  });

  it('docker volume create failure → throws DockerRunnerError, no container starts', async () => {
    let seq = 0;
    captured.responder = (_cmd: string, args: string[]) => {
      if (args[0] === 'volume' && args[1] === 'create') {
        return { err: new Error('rejected'), stderr: 'docker: volume name in use' };
      }
      if (args[0] === 'run') return { stdout: `c${++seq}\n` };
      return { stdout: '' };
    };
    const dockerVol: ResolvedEcsVolume = {
      name: 'data',
      kind: 'docker',
      dockerVolumeConfig: { scope: 'task' },
    };
    const c = makeContainer({
      mountPoints: [{ sourceVolume: 'data', containerPath: '/d', readOnly: false }],
    });
    const state = createEcsRunState();
    await expect(
      runEcsTask(makeTask({ containers: [c], volumes: [dockerVol] }), baseOptions(), state)
    ).rejects.toBeInstanceOf(DockerRunnerError);
    // No `docker run` should have fired.
    expect(dockerRunCalls()).toHaveLength(0);
  });
});

describe('runEcsTask — awaitDependencies (G1)', () => {
  it('START condition is a no-op — no docker wait/inspect calls for the dep', async () => {
    let seq = 0;
    captured.responder = (_cmd: string, args: string[]) => {
      if (args[0] === 'run') return { stdout: `c${++seq}\n` };
      if (args[0] === 'wait') return { stdout: '0\n' };
      return { stdout: '' };
    };
    const a = makeContainer({ name: 'a' });
    const b = makeContainer({
      name: 'b',
      dependsOn: [{ containerName: 'a', condition: 'START' }],
    });
    const state = createEcsRunState();
    await runEcsTask(makeTask({ containers: [a, b] }), baseOptions(), state);
    // Exactly one `docker wait` for the essential container's exit (b is
    // essential here because both containers default `essential: true`
    // and `b` is at task.containers[1] — selection picks first
    // `essential` match, so `a` is essential. The wait is on `a`'s id.)
    const counts = counterByLeadArg();
    expect(counts.run).toBe(2);
    // Only the final exit wait, no per-dep waits for START.
    expect(counts.wait).toBe(1);
  });

  it('COMPLETE condition awaits docker wait on the dep before starting dependent', async () => {
    let seq = 0;
    const callOrder: string[] = [];
    captured.responder = (_cmd: string, args: string[]) => {
      callOrder.push(args.join(' '));
      if (args[0] === 'run') return { stdout: `c${++seq}\n` };
      if (args[0] === 'wait') return { stdout: '0\n' };
      return { stdout: '' };
    };
    const a = makeContainer({ name: 'a', essential: false });
    const b = makeContainer({
      name: 'b',
      essential: true,
      dependsOn: [{ containerName: 'a', condition: 'COMPLETE' }],
    });
    const state = createEcsRunState();
    await runEcsTask(makeTask({ containers: [a, b] }), baseOptions(), state);

    // Order observed:
    //   run (start a) → wait c1 (COMPLETE for a) → run (start b) → wait c2 (essential exit)
    const runIdx = callOrder.findIndex((s) => s.startsWith('run'));
    const waitDepIdx = callOrder.findIndex(
      (s, i) => i > runIdx && s.startsWith('wait')
    );
    const run2Idx = callOrder.findIndex((s, i) => i > waitDepIdx && s.startsWith('run'));
    expect(runIdx).toBeGreaterThanOrEqual(0);
    expect(waitDepIdx).toBeGreaterThan(runIdx);
    expect(run2Idx).toBeGreaterThan(waitDepIdx);
  });

  it('SUCCESS condition rejects when dep exits non-zero', async () => {
    let seq = 0;
    captured.responder = (_cmd: string, args: string[]) => {
      if (args[0] === 'run') return { stdout: `c${++seq}\n` };
      // The dependency container's wait returns exit 7.
      if (args[0] === 'wait') return { stdout: '7\n' };
      return { stdout: '' };
    };
    const a = makeContainer({ name: 'a', essential: false });
    const b = makeContainer({
      name: 'b',
      dependsOn: [{ containerName: 'a', condition: 'SUCCESS' }],
    });
    const state = createEcsRunState();
    await expect(
      runEcsTask(makeTask({ containers: [a, b] }), baseOptions(), state)
    ).rejects.toThrow(/exited 7/);
  });

  it('HEALTHY condition polls docker inspect until status=healthy', async () => {
    let seq = 0;
    let healthCalls = 0;
    captured.responder = (_cmd: string, args: string[]) => {
      if (args[0] === 'run') return { stdout: `c${++seq}\n` };
      if (args[0] === 'wait') return { stdout: '0\n' };
      if (args[0] === 'inspect') {
        healthCalls += 1;
        return { stdout: healthCalls < 3 ? 'starting\n' : 'healthy\n' };
      }
      return { stdout: '' };
    };
    const a = makeContainer({ name: 'a', essential: false });
    const b = makeContainer({
      name: 'b',
      dependsOn: [{ containerName: 'a', condition: 'HEALTHY' }],
    });
    const state = createEcsRunState();
    await runEcsTask(makeTask({ containers: [a, b] }), baseOptions(), state);
    expect(healthCalls).toBeGreaterThanOrEqual(3);
  }, 15_000);

  it('HEALTHY: status=unhealthy → rejects without further polling', async () => {
    let seq = 0;
    captured.responder = (_cmd: string, args: string[]) => {
      if (args[0] === 'run') return { stdout: `c${++seq}\n` };
      if (args[0] === 'wait') return { stdout: '0\n' };
      if (args[0] === 'inspect') return { stdout: 'unhealthy\n' };
      return { stdout: '' };
    };
    const a = makeContainer({ name: 'a', essential: false });
    const b = makeContainer({
      name: 'b',
      dependsOn: [{ containerName: 'a', condition: 'HEALTHY' }],
    });
    const state = createEcsRunState();
    await expect(
      runEcsTask(makeTask({ containers: [a, b] }), baseOptions(), state)
    ).rejects.toThrow(/unhealthy/);
  });

  it('HEALTHY: transient docker inspect failure is retried, then recovers', async () => {
    let seq = 0;
    let inspectCalls = 0;
    captured.responder = (_cmd: string, args: string[]) => {
      if (args[0] === 'run') return { stdout: `c${++seq}\n` };
      if (args[0] === 'wait') return { stdout: '0\n' };
      if (args[0] === 'inspect') {
        inspectCalls += 1;
        if (inspectCalls === 1) return { err: new Error('transient'), stderr: 'no such container' };
        return { stdout: 'healthy\n' };
      }
      return { stdout: '' };
    };
    const a = makeContainer({ name: 'a', essential: false });
    const b = makeContainer({
      name: 'b',
      dependsOn: [{ containerName: 'a', condition: 'HEALTHY' }],
    });
    const state = createEcsRunState();
    await runEcsTask(makeTask({ containers: [a, b] }), baseOptions(), state);
    expect(inspectCalls).toBeGreaterThanOrEqual(2);
  }, 15_000);
});

describe('runEcsTask — exit propagation + essential selection (G1)', () => {
  it('exit code of essential container becomes RunEcsTaskResult.exitCode', async () => {
    let seq = 0;
    captured.responder = (_cmd: string, args: string[]) => {
      if (args[0] === 'run') return { stdout: `c${++seq}\n` };
      if (args[0] === 'wait') return { stdout: '42\n' };
      return { stdout: '' };
    };
    const c = makeContainer({ name: 'svc', essential: true });
    const state = createEcsRunState();
    const r = await runEcsTask(makeTask({ containers: [c] }), baseOptions(), state);
    expect(r.exitCode).toBe(42);
    expect(r.essentialContainerName).toBe('svc');
  });

  it('when every container has essential: false, the first container drives the result (find ?? fallback)', async () => {
    let seq = 0;
    captured.responder = (_cmd: string, args: string[]) => {
      if (args[0] === 'run') return { stdout: `c${++seq}\n` };
      if (args[0] === 'wait') return { stdout: '0\n' };
      return { stdout: '' };
    };
    // Both essential: false — falsy. The orchestrator's `find(c.essential) ?? containers[0]` picks first.
    const a = makeContainer({ name: 'first', essential: false });
    const b = makeContainer({ name: 'second', essential: false });
    const state = createEcsRunState();
    const r = await runEcsTask(makeTask({ containers: [a, b] }), baseOptions(), state);
    expect(r.essentialContainerName).toBe('first');
  });

  it('--detach short-circuits — every container starts, no essential wait, exitCode=0', async () => {
    let seq = 0;
    captured.responder = (_cmd: string, args: string[]) => {
      if (args[0] === 'run') return { stdout: `c${++seq}\n` };
      // If docker wait is called, return exit 99 so we can detect it in
      // the result.exitCode — when --detach works correctly we never call
      // wait at all, so exitCode stays 0.
      if (args[0] === 'wait') return { stdout: '99\n' };
      return { stdout: '' };
    };
    const a = makeContainer({ name: 'a' });
    const b = makeContainer({ name: 'b' });
    const state = createEcsRunState();
    const r = await runEcsTask(
      makeTask({ containers: [a, b] }),
      baseOptions({ detach: true }),
      state
    );
    expect(r.exitCode).toBe(0);
    expect(r.essentialContainerName).toBeUndefined();
    expect(counterByLeadArg().wait).toBeUndefined();
    expect(state.startedContainers).toHaveLength(2);
    // No log streams should have been added in detach mode.
    expect(state.logStoppers).toHaveLength(0);
  });

  it('startedContainers is recorded in start order so cleanup can roll back', async () => {
    let seq = 0;
    captured.responder = (_cmd: string, args: string[]) => {
      if (args[0] === 'run') return { stdout: `c${++seq}\n` };
      if (args[0] === 'wait') return { stdout: '0\n' };
      return { stdout: '' };
    };
    const a = makeContainer({ name: 'alpha' });
    const b = makeContainer({
      name: 'beta',
      dependsOn: [{ containerName: 'alpha', condition: 'START' }],
    });
    const state = createEcsRunState();
    await runEcsTask(makeTask({ containers: [a, b] }), baseOptions(), state);
    expect(state.startedContainers.map((c) => c.name)).toEqual(['alpha', 'beta']);
  });
});

describe('runEcsTask — empty task and pre-network failures (G1)', () => {
  it('empty containers list throws EcsTaskRunnerError before any docker call', async () => {
    const state = createEcsRunState();
    await expect(
      runEcsTask(makeTask({ containers: [] }), baseOptions(), state)
    ).rejects.toThrow(/no containers/);
    expect(captured.calls).toHaveLength(0);
    expect(networkStubs.createTaskNetwork).not.toHaveBeenCalled();
  });

  it('docker run failure for a container surfaces as DockerRunnerError', async () => {
    captured.responder = (_cmd: string, args: string[]) => {
      if (args[0] === 'run') return { err: new Error('boom'), stderr: 'image not found' };
      return { stdout: '' };
    };
    const c = makeContainer();
    const state = createEcsRunState();
    await expect(runEcsTask(makeTask({ containers: [c] }), baseOptions(), state)).rejects.toThrow(
      DockerRunnerError
    );
  });
});

// =====================================================================
// G2: cleanupEcsRun expanded coverage
// =====================================================================

describe('cleanupEcsRun — keepRunning + ordering (G2)', () => {
  it('keepRunning=true skips docker stop / rm on user containers but tears down sidecar+network', async () => {
    captured.responder = () => ({ stdout: '' });
    const state: EcsRunState = {
      network: { networkName: 'cdkd-local-task-x', sidecarContainerId: 'sidecar-x' },
      dockerVolumeNames: [],
      startedContainers: [
        { name: 'a', id: 'cid-a' },
        { name: 'b', id: 'cid-b' },
      ],
      logStoppers: [],
    };
    await cleanupEcsRun(state, { keepRunning: true });
    // No `docker stop` / `docker rm` invocations.
    const stops = captured.calls.filter((c) => c.args[0] === 'stop');
    expect(stops).toHaveLength(0);
    expect(dockerRunnerStubs.removeContainer).not.toHaveBeenCalled();
    // Network teardown ran.
    expect(networkStubs.destroyTaskNetwork).toHaveBeenCalledTimes(1);
    // state.startedContainers is intentionally left in place when keepRunning.
    expect(state.startedContainers).toHaveLength(2);
    expect(state.network).toBeUndefined();
  });

  it('keepRunning=false: per-container stop/rm errors are swallowed and cleanup continues', async () => {
    // docker stop fails on the FIRST container, rm fails on the SECOND.
    let stopCalls = 0;
    captured.responder = (_cmd: string, args: string[]) => {
      if (args[0] === 'stop') {
        stopCalls += 1;
        if (stopCalls === 1)
          return { err: new Error('stop failed'), stderr: 'container in invalid state' };
      }
      return { stdout: '' };
    };
    let rmCalls = 0;
    dockerRunnerStubs.removeContainer.mockImplementation(async () => {
      rmCalls += 1;
      if (rmCalls === 2) throw new Error('rm failed');
    });
    const state: EcsRunState = {
      network: { networkName: 'n', sidecarContainerId: 's' },
      dockerVolumeNames: [],
      startedContainers: [
        { name: 'a', id: 'cid-a' },
        { name: 'b', id: 'cid-b' },
      ],
      logStoppers: [],
    };
    await expect(cleanupEcsRun(state, { keepRunning: false })).resolves.toBeUndefined();
    // Both containers were attempted (errors swallowed):
    expect(rmCalls).toBe(2);
    // Network teardown still runs.
    expect(networkStubs.destroyTaskNetwork).toHaveBeenCalledTimes(1);
    expect(state.startedContainers).toEqual([]);
  });

  it('docker volume rm runs AFTER container teardown (volumes drained last)', async () => {
    const order: string[] = [];
    captured.responder = (_cmd: string, args: string[]) => {
      if (args[0] === 'stop') order.push('stop:' + args[args.length - 1]);
      if (args[0] === 'volume' && args[1] === 'rm') order.push('volume-rm:' + args[2]);
      return { stdout: '' };
    };
    dockerRunnerStubs.removeContainer.mockImplementation(async (id: string) => {
      order.push('rm:' + id);
    });
    networkStubs.destroyTaskNetwork.mockImplementation(async () => {
      order.push('destroy-network');
    });
    const state: EcsRunState = {
      network: { networkName: 'n', sidecarContainerId: 's' },
      dockerVolumeNames: ['vol-1', 'vol-2'],
      startedContainers: [{ name: 'a', id: 'cid-a' }],
      logStoppers: [],
    };
    await cleanupEcsRun(state, { keepRunning: false });

    // Expected ordering: container stop/rm → destroy-network → volume rm.
    const idxRm = order.findIndex((o) => o.startsWith('rm:'));
    const idxNet = order.indexOf('destroy-network');
    const idxVol = order.findIndex((o) => o.startsWith('volume-rm:'));
    expect(idxRm).toBeGreaterThanOrEqual(0);
    expect(idxNet).toBeGreaterThan(idxRm);
    expect(idxVol).toBeGreaterThan(idxNet);
    expect(state.dockerVolumeNames).toEqual([]);
  });

  it('docker volume rm failure is swallowed and remaining volumes still attempted', async () => {
    const volRms: string[] = [];
    captured.responder = (_cmd: string, args: string[]) => {
      if (args[0] === 'volume' && args[1] === 'rm') {
        volRms.push(args[2]!);
        if (args[2] === 'vol-1') return { err: new Error('in use'), stderr: 'volume in use' };
      }
      return { stdout: '' };
    };
    const state: EcsRunState = {
      network: undefined,
      dockerVolumeNames: ['vol-1', 'vol-2'],
      startedContainers: [],
      logStoppers: [],
    };
    await cleanupEcsRun(state, { keepRunning: false });
    expect(volRms).toEqual(['vol-1', 'vol-2']);
    expect(state.dockerVolumeNames).toEqual([]);
  });
});
