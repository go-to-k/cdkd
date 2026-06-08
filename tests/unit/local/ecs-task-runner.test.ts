import { describe, expect, it } from 'vite-plus/test';
import {
  buildDependencyGraph,
  buildDockerRunArgs,
  cleanupEcsRun,
  createEcsRunState,
  EcsTaskRunnerError,
  mergeHostGatewayAddHostFlags,
  topoSort,
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

  it('omits ALL -p flags when skipHostPortPublish is true (Issue #585 multi-replica)', () => {
    const c = makeContainer({
      portMappings: [
        { name: 'api', containerPort: 80, hostPort: 8081, protocol: 'tcp' },
        { name: 'admin', containerPort: 9000, protocol: 'tcp' },
      ],
    });
    const args = buildDockerRunArgs({
      task: makeTask({ containers: [c] }),
      container: c,
      image: 'nginx',
      network: 'cdkd-local-svc-shared',
      volumeByName: new Map(),
      secrets: [],
      envOverrides: undefined,
      containerHost: '127.0.0.1',
      roleArn: undefined,
      platformOverride: undefined,
      region: undefined,
      skipHostPortPublish: true,
    });
    // No `-p` at all — both the explicit-hostPort and the
    // defaulted-hostPort mappings are dropped.
    expect(args).not.toContain('-p');
    // The container still joins the network so peer comms works.
    expect(args).toContain('--network');
    expect(args).toContain('--network-alias');
  });

  it('emits -p normally when skipHostPortPublish is false (single-replica default)', () => {
    const c = makeContainer({
      portMappings: [{ name: 'api', containerPort: 80, hostPort: 8081, protocol: 'tcp' }],
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
      skipHostPortPublish: false,
    });
    const pFlag = args.indexOf('-p');
    expect(pFlag).toBeGreaterThan(-1);
    expect(args[pFlag + 1]).toBe('127.0.0.1:8081:80/tcp');
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

describe('mergeHostGatewayAddHostFlags (issue #784 / cdk-local #483)', () => {
  const gw = { host: 'host.docker.internal', ip: 'host-gateway' };

  it('returns empty when neither source is provided', () => {
    expect(mergeHostGatewayAddHostFlags(undefined, undefined)).toEqual([]);
  });

  it('emits only the host-gateway --add-host pair when no Cloud Map flags', () => {
    expect(mergeHostGatewayAddHostFlags(undefined, [gw])).toEqual([
      '--add-host',
      'host.docker.internal:host-gateway',
    ]);
  });

  it('passes the Cloud Map peer flags through unchanged when no host-gateway mapping', () => {
    const peer = ['--add-host', 'svc.ns:169.254.170.5'];
    expect(mergeHostGatewayAddHostFlags(peer, undefined)).toEqual(peer);
    expect(mergeHostGatewayAddHostFlags(peer, [])).toEqual(peer);
  });

  it('appends the host-gateway pair after the Cloud Map peer flags', () => {
    const peer = ['--add-host', 'svc.ns:169.254.170.5', '--add-host', 'api.ns:169.254.170.6'];
    expect(mergeHostGatewayAddHostFlags(peer, [gw])).toEqual([
      ...peer,
      '--add-host',
      'host.docker.internal:host-gateway',
    ]);
  });
});

describe('buildDockerRunArgs Service Connect aliases', () => {
  it('emits extra --network-alias for each entry in networkAliases', () => {
    const c = makeContainer();
    const args = buildDockerRunArgs({
      task: makeTask({ containers: [c] }),
      container: c,
      image: 'nginx',
      network: 'cdkd-local-svc-shared',
      volumeByName: new Map(),
      secrets: [],
      envOverrides: undefined,
      containerHost: '127.0.0.1',
      roleArn: undefined,
      platformOverride: undefined,
      region: undefined,
      networkAliases: ['orders', 'orders.cdkd-sc.local'],
    });
    // The first --network-alias (line 813) is the container.name; extra
    // aliases follow. Walk every --network-alias and confirm presence.
    const aliasValues: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '--network-alias') aliasValues.push(args[i + 1]!);
    }
    expect(aliasValues).toContain('app');
    expect(aliasValues).toContain('orders.cdkd-sc.local');
  });

  it('de-duplicates a networkAlias that matches container.name (already added by line 813)', () => {
    const c = makeContainer({ name: 'orders' });
    const args = buildDockerRunArgs({
      task: makeTask({ containers: [c] }),
      container: c,
      image: 'nginx',
      network: 'cdkd-local-svc-shared',
      volumeByName: new Map(),
      secrets: [],
      envOverrides: undefined,
      containerHost: '127.0.0.1',
      roleArn: undefined,
      platformOverride: undefined,
      region: undefined,
      networkAliases: ['orders', 'orders.cdkd-sc.local'],
    });
    const aliasValues: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '--network-alias') aliasValues.push(args[i + 1]!);
    }
    // 'orders' appears once (the line 813 default), NOT twice.
    expect(aliasValues.filter((v) => v === 'orders').length).toBe(1);
    expect(aliasValues).toContain('orders.cdkd-sc.local');
  });

  it('emits no extra --network-alias when networkAliases is empty / undefined', () => {
    const c = makeContainer();
    const args = buildDockerRunArgs({
      task: makeTask({ containers: [c] }),
      container: c,
      image: 'nginx',
      network: 'cdkd-local-task-xx',
      volumeByName: new Map(),
      secrets: [],
      envOverrides: undefined,
      containerHost: '127.0.0.1',
      roleArn: undefined,
      platformOverride: undefined,
      region: undefined,
    });
    const aliasValues: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '--network-alias') aliasValues.push(args[i + 1]!);
    }
    // Only the default container.name alias from line 813.
    expect(aliasValues).toEqual(['app']);
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

describe('topoSort (G3)', () => {
  it('preserves template order for two independent containers', () => {
    const a = makeContainer({ name: 'a' });
    const b = makeContainer({ name: 'b' });
    const g = buildDependencyGraph([a, b]);
    expect(topoSort(g, [a, b])).toEqual(['a', 'b']);
    // Reversed input still respects template order in the input array
    // — the tiebreak key is the array index of `containers`, not name.
    const g2 = buildDependencyGraph([b, a]);
    expect(topoSort(g2, [b, a])).toEqual(['b', 'a']);
  });

  it('diamond: D depends on B+C, both depend on A → A first, B/C in template order, D last', () => {
    const A = makeContainer({ name: 'A' });
    const B = makeContainer({
      name: 'B',
      dependsOn: [{ containerName: 'A', condition: 'START' }],
    });
    const C = makeContainer({
      name: 'C',
      dependsOn: [{ containerName: 'A', condition: 'START' }],
    });
    const D = makeContainer({
      name: 'D',
      dependsOn: [
        { containerName: 'B', condition: 'START' },
        { containerName: 'C', condition: 'START' },
      ],
    });
    const containers = [A, B, C, D];
    const g = buildDependencyGraph(containers);
    const order = topoSort(g, containers);
    // A must be before B / C; B / C must be before D.
    expect(order.indexOf('A')).toBeLessThan(order.indexOf('B'));
    expect(order.indexOf('A')).toBeLessThan(order.indexOf('C'));
    expect(order.indexOf('B')).toBeLessThan(order.indexOf('D'));
    expect(order.indexOf('C')).toBeLessThan(order.indexOf('D'));
    expect(order.indexOf('A')).toBe(0);
    expect(order.indexOf('D')).toBe(3);
    // Template-order tiebreak: B (index 1) comes before C (index 2).
    expect(order.indexOf('B')).toBeLessThan(order.indexOf('C'));
  });

  it('multiple independent roots come out in template order', () => {
    const r1 = makeContainer({ name: 'r1' });
    const r2 = makeContainer({ name: 'r2' });
    const r3 = makeContainer({ name: 'r3' });
    const containers = [r1, r2, r3];
    const g = buildDependencyGraph(containers);
    expect(topoSort(g, containers)).toEqual(['r1', 'r2', 'r3']);
  });

  it('chain A->B->C in template order keeps deps before dependents', () => {
    const A = makeContainer({ name: 'A' });
    const B = makeContainer({
      name: 'B',
      dependsOn: [{ containerName: 'A', condition: 'START' }],
    });
    const C = makeContainer({
      name: 'C',
      dependsOn: [{ containerName: 'B', condition: 'START' }],
    });
    const containers = [A, B, C];
    const g = buildDependencyGraph(containers);
    const order = topoSort(g, containers);
    expect(order.indexOf('A')).toBeLessThan(order.indexOf('B'));
    expect(order.indexOf('B')).toBeLessThan(order.indexOf('C'));
  });

  it('cyclic graph rejection lives in buildDependencyGraph (not topoSort)', () => {
    // Sanity check: cycle rejection happens BEFORE topoSort is ever
    // called, so cyclic graphs never reach this function. This documents
    // the contract — a defensive test inside topoSort would never fire.
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

  it('adversarial template order [C, B, A] with C->B->A still yields a valid topo order', () => {
    // Template lists dependent BEFORE its dependency. CDK-synthesized
    // output never does this, but hand-written CFn or future CDK
    // customizations could. The pre-fix double-sort re-ranked globally
    // by template index and produced [C, B, A] — violating the
    // dependsOn contract (C would start before A had even launched).
    const A = makeContainer({ name: 'A' });
    const B = makeContainer({
      name: 'B',
      dependsOn: [{ containerName: 'A', condition: 'START' }],
    });
    const C = makeContainer({
      name: 'C',
      dependsOn: [{ containerName: 'B', condition: 'START' }],
    });
    const containers = [C, B, A];
    const g = buildDependencyGraph(containers);
    const order = topoSort(g, containers);
    expect(order).toEqual(['A', 'B', 'C']);
  });
});

describe('buildDockerRunArgs profile credentials file (ECS analogue of PR #670)', () => {
  it('emits read-only bind-mount + AWS_SHARED_CREDENTIALS_FILE + AWS_PROFILE when profileCredentialsFile is set', () => {
    const c = makeContainer({ name: 'app' });
    const args = buildDockerRunArgs({
      task: makeTask({ containers: [c] }),
      container: c,
      image: 'nginx:alpine',
      network: 'cdkd-local-svc-shared',
      volumeByName: new Map(),
      secrets: [],
      envOverrides: undefined,
      containerHost: '127.0.0.1',
      roleArn: undefined,
      platformOverride: undefined,
      region: undefined,
      profileCredentialsFile: {
        hostPath: '/tmp/cdkd-profile-creds-abc/credentials',
        containerPath: '/cdkd-aws/credentials',
        profileName: 'dev-sso',
      },
    });
    // Read-only bind-mount: the `:ro` flag is load-bearing — a
    // compromised handler must not tamper with the host-side
    // creds file.
    const mountIdx = args.findIndex(
      (a) => a === '/tmp/cdkd-profile-creds-abc/credentials:/cdkd-aws/credentials:ro'
    );
    expect(mountIdx).toBeGreaterThan(-1);
    expect(args[mountIdx - 1]).toBe('-v');
    // SDK env-vars: container path (NOT host path) for the file,
    // and the original `--profile <name>` for the section header.
    const joined = args.join(' ');
    expect(joined).toContain('AWS_SHARED_CREDENTIALS_FILE=/cdkd-aws/credentials');
    expect(joined).toContain('AWS_PROFILE=dev-sso');
  });

  it('omits the mount and env vars when profileCredentialsFile is undefined (no --profile)', () => {
    const c = makeContainer({ name: 'app' });
    const args = buildDockerRunArgs({
      task: makeTask({ containers: [c] }),
      container: c,
      image: 'nginx:alpine',
      network: 'n',
      volumeByName: new Map(),
      secrets: [],
      envOverrides: undefined,
      containerHost: '127.0.0.1',
      roleArn: undefined,
      platformOverride: undefined,
      region: undefined,
    });
    const joined = args.join(' ');
    expect(joined).not.toContain('/cdkd-aws/credentials');
    expect(joined).not.toContain('AWS_SHARED_CREDENTIALS_FILE');
    expect(joined).not.toContain('AWS_PROFILE');
  });

  it('user template AWS_PROFILE override beats the profile-file injection', () => {
    // Env precedence (per the build comment): template literal env
    // sits ABOVE the profile-file env vars, so a user template that
    // explicitly sets `AWS_PROFILE` to a different value (e.g. for
    // an alternative in-container chain) still wins. This documents
    // the deliberate ordering — file vars are a default, not a
    // forced override.
    const c = makeContainer({ name: 'app', environment: { AWS_PROFILE: 'in-container' } });
    const args = buildDockerRunArgs({
      task: makeTask({ containers: [c] }),
      container: c,
      image: 'nginx:alpine',
      network: 'n',
      volumeByName: new Map(),
      secrets: [],
      envOverrides: undefined,
      containerHost: '127.0.0.1',
      roleArn: undefined,
      platformOverride: undefined,
      region: undefined,
      profileCredentialsFile: {
        hostPath: '/tmp/cdkd-profile-creds-abc/credentials',
        containerPath: '/cdkd-aws/credentials',
        profileName: 'dev-sso',
      },
    });
    const joined = args.join(' ');
    expect(joined).toContain('AWS_PROFILE=in-container');
    expect(joined).not.toContain('AWS_PROFILE=dev-sso');
    // The credentials-file env var stays at the file-defaulted path
    // (the user template did not override it).
    expect(joined).toContain('AWS_SHARED_CREDENTIALS_FILE=/cdkd-aws/credentials');
  });

  it('profile-file mount precedes user MountPoints so user mount cannot shadow /cdkd-aws/credentials', () => {
    const c = makeContainer({
      name: 'app',
      mountPoints: [{ sourceVolume: 'data', containerPath: '/d', readOnly: false }],
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
      image: 'nginx:alpine',
      network: 'n',
      volumeByName: new Map([['data', dockerVol]]),
      secrets: [],
      envOverrides: undefined,
      containerHost: '127.0.0.1',
      roleArn: undefined,
      platformOverride: undefined,
      region: undefined,
      profileCredentialsFile: {
        hostPath: '/tmp/cdkd-profile-creds-abc/credentials',
        containerPath: '/cdkd-aws/credentials',
        profileName: 'dev-sso',
      },
    });
    const credsIdx = args.indexOf('/tmp/cdkd-profile-creds-abc/credentials:/cdkd-aws/credentials:ro');
    const userVolIdx = args.indexOf('cdkd-local-data-xxxx:/d');
    expect(credsIdx).toBeGreaterThan(-1);
    expect(userVolIdx).toBeGreaterThan(-1);
    expect(credsIdx).toBeLessThan(userVolIdx);
  });
});
