/**
 * go-to-k/cdkd#6150: in AWS Emulator mixed mode, `local run-task` resolves
 * names PER CONTAINER. Container `web` excepts DynamoDB (`"real-aws"`) in its
 * own `--env-vars` section, `worker` does not: `web` gets the real table's
 * name, `worker` keeps the emulator's.
 */
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  createLocalStateProvider: vi.fn(),
  buildEcsImageResolutionContext: vi.fn(),
  resolveEcsTaskTarget: vi.fn(),
}));
vi.mock('../../../src/cli/commands/local-state-source.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createLocalStateProvider: mocks.createLocalStateProvider,
}));
vi.mock('../../../src/cli/commands/local-run-task/image-context.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  buildEcsImageResolutionContext: mocks.buildEcsImageResolutionContext,
}));
vi.mock('../../../src/local/ecs-task-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveEcsTaskTarget: mocks.resolveEcsTaskTarget,
}));

import { setActiveWorkloadAwsWiring, setAwsEmulatorServiceRouting, type WorkloadAwsWiring } from 'cdk-local/internal';
import { applyPerContainerNames } from '../../../src/cli/commands/local-run-task/command.js';

const MIXED = {
  mode: 'forward',
  env: {},
  scrubEnvKeys: [],
  mounts: [],
  loopbackPorts: [],
  probeHealth: true,
  dispose: () => {},
  mixed: {
    realServices: ['DYNAMODB'],
    emulatorCredentials: { accessKeyId: 'EMULATORKEY000000000', secretAccessKey: 'e' },
    emulatorEndpoint: { url: 'https://127.0.0.1:9381', hostname: '127.0.0.1', port: 9381, loopback: true },
    resignPort: 47297,
    resignEndpoint: 'https://127.0.0.1:47297',
    resignConfigHostPath: '/tmp/x/resign.json',
    emulatorClientOverride: { endpoint: 'https://127.0.0.1:9381' },
  },
} as WorkloadAwsWiring;

const task = (table: string) => ({
  containers: [
    { name: 'web', environment: { TABLE: table }, secrets: [] },
    { name: 'worker', environment: { TABLE: table }, secrets: [] },
  ],
});

afterEach(() => {
  setActiveWorkloadAwsWiring(undefined);
  setAwsEmulatorServiceRouting(undefined);
  for (const m of Object.values(mocks)) m.mockReset();
});

describe('local run-task names per container in mixed mode', () => {
  const BASE_CONTEXT = { stateResources: { Table: { physicalId: 'Emu-Table' } }, pseudoParameters: { region: 'us-east-1' } };
  const run = (base: ReturnType<typeof task>, ctx: unknown) =>
    applyPerContainerNames(
      base as never,
      'Svc/Task',
      [],
      { stackName: 'Svc', region: 'us-east-1' } as never,
      {} as never,
      ctx as never
    );

  it('web (own DynamoDB exception) gets the real name; worker keeps the emulator one', async () => {
    setActiveWorkloadAwsWiring(MIXED);
    setAwsEmulatorServiceRouting({
      realServices: ['DYNAMODB'],
      override: { endpoint: 'https://127.0.0.1:9381' },
      envOverrides: { web: { AWS_ENDPOINT_URL_DYNAMODB: 'real-aws' } },
    });
    const load = vi.fn(async () => ({ region: 'us-east-1', outputs: {}, resources: { Table: { physicalId: 'Real-Table' } } }));
    mocks.createLocalStateProvider.mockReturnValue({ load, dispose: vi.fn() });
    mocks.resolveEcsTaskTarget.mockReturnValue(task('Real-Table'));
    const base = task('Emu-Table');

    await run(base, BASE_CONTEXT);

    expect(base.containers.find((c) => c.name === 'web')?.environment['TABLE']).toBe('Real-Table');
    expect(base.containers.find((c) => c.name === 'worker')?.environment['TABLE']).toBe('Emu-Table');
    // The re-resolution's record was built for web's own routing...
    expect(mocks.createLocalStateProvider).toHaveBeenCalledTimes(1);
    expect(mocks.createLocalStateProvider.mock.calls[0]![3]).toEqual({ workload: { containerName: 'web' } });
    // ...and the base context is reused: only the state record differs.
    expect(mocks.buildEcsImageResolutionContext).not.toHaveBeenCalled();
    expect(mocks.resolveEcsTaskTarget.mock.calls[0]![2]).toEqual({
      ...BASE_CONTEXT,
      stateResources: { Table: { physicalId: 'Real-Table' } },
    });
  });

  it('a Command element naming the table follows the container routing too (go-to-k/cdkd#6271)', async () => {
    setActiveWorkloadAwsWiring(MIXED);
    setAwsEmulatorServiceRouting({
      realServices: ['DYNAMODB'],
      override: { endpoint: 'https://127.0.0.1:9381' },
      envOverrides: { web: { AWS_ENDPOINT_URL_DYNAMODB: 'real-aws' } },
    });
    const load = vi.fn(async () => ({ region: 'us-east-1', outputs: {}, resources: {} }));
    mocks.createLocalStateProvider.mockReturnValue({ load, dispose: vi.fn() });
    const withArgv = (table: string, unresolved?: unknown[]) => ({
      containers: task(table).containers.map((c) => ({
        ...c,
        command: ['scan', table],
        ...(unresolved && { unresolvedCommandElements: unresolved }),
      })),
    });
    const ownUnresolved = [{ field: 'Command', index: 1, reason: 'not in state' }];
    mocks.resolveEcsTaskTarget.mockReturnValue(withArgv('Real-Table', ownUnresolved));
    const base = withArgv('Emu-Table');

    await run(base as never, BASE_CONTEXT);

    const web = base.containers.find((c) => c.name === 'web')!;
    expect(web.command).toEqual(['scan', 'Real-Table']);
    expect(web.unresolvedCommandElements).toEqual(ownUnresolved);
    const worker = base.containers.find((c) => c.name === 'worker')!;
    expect(worker.command).toEqual(['scan', 'Emu-Table']);
    expect(worker.unresolvedCommandElements).toBeUndefined();
  });

  it('containers sharing a routed set share ONE load (its warnings are not repeated)', async () => {
    setActiveWorkloadAwsWiring(MIXED);
    setAwsEmulatorServiceRouting({
      realServices: ['DYNAMODB'],
      override: { endpoint: 'https://127.0.0.1:9381' },
      envOverrides: {
        web: { AWS_ENDPOINT_URL_DYNAMODB: 'real-aws' },
        worker: { AWS_ENDPOINT_URL_DYNAMODB: 'real-aws' },
      },
    });
    const warn = vi.fn();
    // A load that warns once, as an emulator miss does.
    const load = vi.fn(async () => {
      warn('--from-state: stack Svc could not be read from AWS Emulator');
      return { region: 'us-east-1', outputs: {}, resources: {} };
    });
    mocks.createLocalStateProvider.mockReturnValue({ load, dispose: vi.fn() });
    mocks.resolveEcsTaskTarget.mockReturnValue(task('Real-Table'));

    await run(task('Emu-Table'), BASE_CONTEXT);

    expect(mocks.createLocalStateProvider).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('nothing to do outside mixed mode, when every container shares the base routing, or with no state context', async () => {
    const base = task('Emu-Table');
    await run(base, BASE_CONTEXT);
    setActiveWorkloadAwsWiring(MIXED);
    setAwsEmulatorServiceRouting({
      realServices: ['DYNAMODB'],
      override: { endpoint: 'https://127.0.0.1:9381' },
      envOverrides: { Parameters: { AWS_ENDPOINT_URL_DYNAMODB: 'real-aws' } },
    });
    await run(base, BASE_CONTEXT);
    setAwsEmulatorServiceRouting({
      realServices: ['DYNAMODB'],
      override: { endpoint: 'https://127.0.0.1:9381' },
      envOverrides: { web: { AWS_ENDPOINT_URL_DYNAMODB: 'real-aws' } },
    });
    await run(base, undefined);
    expect(mocks.createLocalStateProvider).not.toHaveBeenCalled();
    expect(base.containers[0]!.environment['TABLE']).toBe('Emu-Table');
  });
});
