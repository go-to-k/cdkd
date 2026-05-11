import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  METADATA_ENDPOINT_IMAGE,
  METADATA_ENDPOINT_IP,
  buildMetadataEnv,
  createTaskNetwork,
  destroyTaskNetwork,
} from '../../../src/local/ecs-network.js';

// The mock must handle BOTH 3-arg (execFile(cmd, args, cb)) AND 4-arg
// (execFile(cmd, args, opts, cb)) forms because promisify(execFile) uses
// the 3-arg form internally. See memory: mock_execfile_3and4arg.
const captured = vi.hoisted<{ calls: { cmd: string; args: string[] }[] }>(() => ({ calls: [] }));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: string[],
      a3: unknown,
      a4?: (err: Error | null, res: { stdout: string; stderr: string }) => void
    ) => {
      captured.calls.push({ cmd, args });
      const cb = typeof a3 === 'function' ? (a3 as typeof a4)! : a4!;
      // docker network create / docker run / docker rm / docker network rm /
      // docker pull all succeed with a synthetic id when applicable.
      const isRun = args[0] === 'run';
      const stdout = isRun ? 'sidecar-id-fake\n' : '';
      cb(null, { stdout, stderr: '' });
      return { kill: (): void => {} } as unknown as ReturnType<typeof actual.execFile>;
    },
    spawn: (_cmd: string, _args: string[]) => {
      // pullImage falls through to spawn for runCaptured. Return a fake
      // proc that fires close(0) on next tick.
      const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
      const proc = {
        stdout: { on: (e: string, h: (chunk: Buffer) => void) => { (handlers['stdout-' + e] = handlers['stdout-' + e] || []).push(h as unknown as typeof handlers[string][number]); } },
        stderr: { on: (e: string, h: (chunk: Buffer) => void) => { (handlers['stderr-' + e] = handlers['stderr-' + e] || []).push(h as unknown as typeof handlers[string][number]); } },
        on: (e: string, h: (arg?: unknown) => void) => { (handlers[e] = handlers[e] || []).push(h); },
      };
      setImmediate(() => handlers['close']?.forEach((h) => h(0)));
      return proc as never;
    },
  };
});

beforeEach(() => {
  captured.calls = [];
});

describe('buildMetadataEnv', () => {
  it('emits ECS_CONTAINER_METADATA_URI_V4 and v3 at the well-known IP', () => {
    const env = buildMetadataEnv({ containerName: 'app' });
    expect(env.ECS_CONTAINER_METADATA_URI_V4).toBe(`http://${METADATA_ENDPOINT_IP}/v4/app`);
    expect(env.ECS_CONTAINER_METADATA_URI).toBe(`http://${METADATA_ENDPOINT_IP}/v3/app`);
    expect(env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI).toBeUndefined();
  });

  it('embeds the role-arn path when roleArn is set', () => {
    const env = buildMetadataEnv({
      containerName: 'app',
      roleArn: 'arn:aws:iam::123:role/Foo',
    });
    expect(env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI).toContain('arn%3Aaws%3Aiam');
  });

  it('forwards region when supplied', () => {
    expect(buildMetadataEnv({ containerName: 'a', region: 'us-east-2' }).AWS_REGION).toBe('us-east-2');
  });
});

describe('createTaskNetwork / destroyTaskNetwork', () => {
  it('creates the network and starts the sidecar with cred env vars', async () => {
    const net = await createTaskNetwork({
      cluster: 'cdkd-local',
      credentials: { accessKeyId: 'A', secretAccessKey: 'B', sessionToken: 'C' },
      skipPull: true,
    });
    expect(net.networkName).toMatch(/^cdkd-local-task-/);
    expect(net.sidecarContainerId).toBe('sidecar-id-fake');

    // Find the docker network create call:
    const networkCreate = captured.calls.find(
      (c) => c.args[0] === 'network' && c.args[1] === 'create'
    );
    expect(networkCreate?.args).toContain('--subnet');

    // Find the sidecar docker run call:
    const runCall = captured.calls.find((c) => c.args[0] === 'run');
    expect(runCall).toBeDefined();
    expect(runCall!.args.join(' ')).toContain(METADATA_ENDPOINT_IMAGE);
    expect(runCall!.args.join(' ')).toContain('--ip');
    expect(runCall!.args.join(' ')).toContain(METADATA_ENDPOINT_IP);
    // Credentials forwarded to the sidecar env block:
    expect(runCall!.args.join(' ')).toContain('AWS_ACCESS_KEY_ID=A');
    expect(runCall!.args.join(' ')).toContain('AWS_SECRET_ACCESS_KEY=B');
    expect(runCall!.args.join(' ')).toContain('AWS_SESSION_TOKEN=C');
  });

  it('destroyTaskNetwork is idempotent on undefined', async () => {
    await expect(destroyTaskNetwork(undefined)).resolves.toBeUndefined();
  });

  it('destroyTaskNetwork runs docker rm and docker network rm', async () => {
    captured.calls = [];
    await destroyTaskNetwork({ networkName: 'cdkd-local-task-abc', sidecarContainerId: 'sid' });
    const rmCalls = captured.calls.filter((c) => c.args[0] === 'rm' || c.args[0] === 'network');
    expect(rmCalls.length).toBeGreaterThanOrEqual(2);
  });
});
