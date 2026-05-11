import { describe, expect, it } from 'vitest';
import {
  buildDependencyGraph,
  buildDockerRunArgs,
  cleanupEcsRun,
  createEcsRunState,
  EcsTaskRunnerError,
} from '../../../src/local/ecs-task-runner.js';
import type {
  ResolvedEcsContainer,
  ResolvedEcsTask,
  ResolvedEcsVolume,
} from '../../../src/local/ecs-task-resolver.js';

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

describe('buildDependencyGraph', () => {
  it('rejects cyclic dependsOn', () => {
    const a = makeContainer({
      name: 'a',
      dependsOn: [{ containerName: 'b', condition: 'START' }],
    });
    const b = makeContainer({
      name: 'b',
      dependsOn: [{ containerName: 'a', condition: 'START' }],
    });
    expect(() => buildDependencyGraph([a, b])).toThrow(EcsTaskRunnerError);
  });
  it('accepts a chain', () => {
    const a = makeContainer({ name: 'a' });
    const b = makeContainer({
      name: 'b',
      dependsOn: [{ containerName: 'a', condition: 'START' }],
    });
    expect(() => buildDependencyGraph([a, b])).not.toThrow();
  });
});

describe('buildDockerRunArgs', () => {
  it('emits --network --network-alias and port mapping with default host', () => {
    const c = makeContainer({
      portMappings: [{ containerPort: 80, hostPort: 8080, protocol: 'tcp' }],
    });
    const args = buildDockerRunArgs({
      task: makeTask({ containers: [c] }),
      container: c,
      image: 'nginx:alpine',
      network: 'cdkd-local-task-xx',
      volumeByName: new Map(),
      secrets: [],
      envOverrides: undefined,
      containerHost: '127.0.0.1',
      roleArn: undefined,
      platformOverride: undefined,
      region: undefined,
    });
    expect(args).toContain('--network');
    expect(args[args.indexOf('--network') + 1]).toBe('cdkd-local-task-xx');
    expect(args).toContain('--network-alias');
    expect(args[args.indexOf('--network-alias') + 1]).toBe('app');
    const pFlag = args.indexOf('-p');
    expect(pFlag).toBeGreaterThan(-1);
    expect(args[pFlag + 1]).toBe('127.0.0.1:8080:80/tcp');
  });

  it('uses containerPort as hostPort when HostPort not declared', () => {
    const c = makeContainer({
      portMappings: [{ containerPort: 80, protocol: 'tcp' }],
    });
    const args = buildDockerRunArgs({
      task: makeTask({ containers: [c] }),
      container: c,
      image: 'nginx',
      network: 'n',
      volumeByName: new Map(),
      secrets: [],
      envOverrides: undefined,
      containerHost: '127.0.0.1',
      roleArn: undefined,
      platformOverride: undefined,
      region: undefined,
    });
    expect(args.join(' ')).toContain('127.0.0.1:80:80/tcp');
  });

  it('threads metadata env + secrets + template env into the -e block', () => {
    const c = makeContainer({
      name: 'svc',
      environment: { LOG_LEVEL: 'debug' },
      secrets: [{ name: 'X', valueFrom: 'irrelevant' }],
    });
    const args = buildDockerRunArgs({
      task: makeTask({ containers: [c] }),
      container: c,
      image: 'nginx',
      network: 'n',
      volumeByName: new Map(),
      secrets: [{ name: 'X', value: 'resolved-value' }],
      envOverrides: { svc: { LOG_LEVEL: 'info' } },
      containerHost: '127.0.0.1',
      roleArn: 'arn:aws:iam::123:role/r',
      platformOverride: undefined,
      region: undefined,
    });
    const joined = args.join(' ');
    expect(joined).toContain('ECS_CONTAINER_METADATA_URI_V4=');
    expect(joined).toContain('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=');
    expect(joined).toContain('LOG_LEVEL=info'); // override beats template literal
    expect(joined).toContain('X=resolved-value');
  });

  it('uses Parameters global override when no container-specific override', () => {
    const c = makeContainer({ name: 'svc', environment: { K: 'orig' } });
    const args = buildDockerRunArgs({
      task: makeTask({ containers: [c] }),
      container: c,
      image: 'nginx',
      network: 'n',
      volumeByName: new Map(),
      secrets: [],
      envOverrides: { Parameters: { K: 'global' } },
      containerHost: '127.0.0.1',
      roleArn: undefined,
      platformOverride: undefined,
      region: undefined,
    });
    expect(args.join(' ')).toContain('K=global');
  });

  it('emits docker-volume bind-mount entries', () => {
    const c = makeContainer({
      mountPoints: [{ sourceVolume: 'data', containerPath: '/d', readOnly: true }],
    });
    const dockerVol: ResolvedEcsVolume & { dockerVolumeName?: string } = {
      name: 'data',
      kind: 'docker',
      dockerVolumeConfig: { scope: 'task' },
      dockerVolumeName: 'cdkd-local-data-xxxx',
    };
    const args = buildDockerRunArgs({
      task: makeTask({ containers: [c], volumes: [dockerVol] }),
      container: c,
      image: 'nginx',
      network: 'n',
      volumeByName: new Map([['data', dockerVol]]),
      secrets: [],
      envOverrides: undefined,
      containerHost: '127.0.0.1',
      roleArn: undefined,
      platformOverride: undefined,
      region: undefined,
    });
    expect(args.join(' ')).toContain('cdkd-local-data-xxxx:/d:ro');
  });

  it('honors RuntimePlatform.CpuArchitecture for --platform', () => {
    const c = makeContainer();
    const args = buildDockerRunArgs({
      task: makeTask({
        containers: [c],
        runtimePlatform: { cpuArchitecture: 'ARM64', operatingSystemFamily: 'LINUX' },
      }),
      container: c,
      image: 'nginx',
      network: 'n',
      volumeByName: new Map(),
      secrets: [],
      envOverrides: undefined,
      containerHost: '127.0.0.1',
      roleArn: undefined,
      platformOverride: undefined,
      region: undefined,
    });
    const idx = args.indexOf('--platform');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('linux/arm64');
  });

  it('platformOverride takes precedence over RuntimePlatform', () => {
    const c = makeContainer();
    const args = buildDockerRunArgs({
      task: makeTask({
        containers: [c],
        runtimePlatform: { cpuArchitecture: 'ARM64', operatingSystemFamily: 'LINUX' },
      }),
      container: c,
      image: 'nginx',
      network: 'n',
      volumeByName: new Map(),
      secrets: [],
      envOverrides: undefined,
      containerHost: '127.0.0.1',
      roleArn: undefined,
      platformOverride: 'linux/amd64',
      region: undefined,
    });
    expect(args[args.indexOf('--platform') + 1]).toBe('linux/amd64');
  });

  it('emits ulimit and healthcheck flags', () => {
    const c = makeContainer({
      ulimits: [{ name: 'nofile', softLimit: 1024, hardLimit: 2048 }],
      healthCheck: { command: ['CMD', 'curl', '-f', 'http://localhost/'], interval: 5, retries: 3 },
    });
    const args = buildDockerRunArgs({
      task: makeTask({ containers: [c] }),
      container: c,
      image: 'nginx',
      network: 'n',
      volumeByName: new Map(),
      secrets: [],
      envOverrides: undefined,
      containerHost: '127.0.0.1',
      roleArn: undefined,
      platformOverride: undefined,
      region: undefined,
    });
    expect(args).toContain('--ulimit');
    expect(args[args.indexOf('--ulimit') + 1]).toBe('nofile=1024:2048');
    expect(args).toContain('--health-cmd');
    expect(args[args.indexOf('--health-interval') + 1]).toBe('5s');
    expect(args[args.indexOf('--health-retries') + 1]).toBe('3');
  });

  it('handles EntryPoint by passing first arg via --entrypoint, rest before CMD', () => {
    const c = makeContainer({ entryPoint: ['/bin/sh', '-c'], command: ['echo hi'] });
    const args = buildDockerRunArgs({
      task: makeTask({ containers: [c] }),
      container: c,
      image: 'nginx',
      network: 'n',
      volumeByName: new Map(),
      secrets: [],
      envOverrides: undefined,
      containerHost: '127.0.0.1',
      roleArn: undefined,
      platformOverride: undefined,
      region: undefined,
    });
    const epIdx = args.indexOf('--entrypoint');
    expect(args[epIdx + 1]).toBe('/bin/sh');
    // Trailing args order: image, then '-c', then CMD 'echo hi'
    const imgIdx = args.indexOf('nginx');
    expect(args.slice(imgIdx)).toEqual(['nginx', '-c', 'echo hi']);
  });
});

describe('cleanupEcsRun', () => {
  it('is a no-op on a freshly-created empty state', async () => {
    const state = createEcsRunState();
    await expect(cleanupEcsRun(state, { keepRunning: false })).resolves.toBeUndefined();
    expect(state.startedContainers).toEqual([]);
    expect(state.dockerVolumeNames).toEqual([]);
    expect(state.logStoppers).toEqual([]);
    expect(state.network).toBeUndefined();
  });

  it('is idempotent — second call after empty-state cleanup is also a no-op', async () => {
    const state = createEcsRunState();
    await cleanupEcsRun(state, { keepRunning: false });
    await expect(cleanupEcsRun(state, { keepRunning: false })).resolves.toBeUndefined();
  });

  it('clears logStoppers even when keepRunning is true', async () => {
    const state = createEcsRunState();
    let stoppedCount = 0;
    state.logStoppers.push(() => {
      stoppedCount += 1;
    });
    await cleanupEcsRun(state, { keepRunning: true });
    expect(stoppedCount).toBe(1);
    expect(state.logStoppers).toEqual([]);
  });

  it('swallows log-stopper throws so cleanup completes regardless', async () => {
    const state = createEcsRunState();
    state.logStoppers.push(() => {
      throw new Error('stop failed');
    });
    await expect(cleanupEcsRun(state, { keepRunning: false })).resolves.toBeUndefined();
    expect(state.logStoppers).toEqual([]);
  });
});
