import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * go-to-k/cdkd#6206: the docker plumbing of the `--aws-emulator`
 * custom-resource runtime — the 443 forwarder sidecar, the image-cache probe
 * that spares a pull per event, and the synchronous teardown for `exit`.
 */

vi.mock('../../../src/utils/logger.js', () => {
  const leaf = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    getLevel: () => 'info',
    child: () => leaf,
  };
  return { getLogger: () => leaf };
});

const docker = vi.hoisted(() => ({
  /** Answers one `execFile` call: stdout, or an Error to fail it. */
  answer: vi.fn((_args: string[]): string | Error => ''),
  calls: [] as string[][],
  syncCalls: [] as string[][],
}));
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: (...all: unknown[]) => {
      const cb = all[all.length - 1] as (err: unknown, out?: { stdout: string }) => void;
      const args = all[1] as string[];
      docker.calls.push(args);
      const out = docker.answer(args);
      if (out instanceof Error) cb(out);
      else cb(null, { stdout: out });
    },
    execFileSync: (_cmd: string, args: string[]) => {
      docker.syncCalls.push(args);
      return Buffer.from('');
    },
  };
});

const { imageInLocalCache, removeContainersSync, startNamespacePortForwarder } =
  await import('../../../src/local/docker-runner.js');
const { LOOPBACK_FORWARDER_IMAGE } = await import('cdk-local/internal');

beforeEach(() => {
  docker.calls.length = 0;
  docker.syncCalls.length = 0;
  docker.answer.mockReset().mockImplementation(() => '');
});

describe('startNamespacePortForwarder', () => {
  it("runs the sidecar in the container's network namespace: listen port, then target port", async () => {
    docker.answer.mockImplementation((args) =>
      args[0] === 'run' ? 'sidecar-1\n' : args[0] === 'logs' ? 'ready\n' : ''
    );
    const id = await startNamespacePortForwarder('ctr-1', 443, 9297);

    expect(id).toBe('sidecar-1');
    const run = docker.calls[0]!;
    expect(run.slice(0, 5)).toEqual(['run', '-d', '--rm', '--network', 'container:ctr-1']);
    expect(run).toContain(LOOPBACK_FORWARDER_IMAGE);
    expect(run.slice(-2)).toEqual(['443', '9297']);
    expect(docker.calls[1]).toEqual(['logs', 'sidecar-1']);
  });

  it('removes the sidecar and throws when it never listens', async () => {
    docker.answer.mockImplementation((args) => (args[0] === 'run' ? 'sidecar-2\n' : ''));
    await expect(startNamespacePortForwarder('ctr-1', 443, 9297, 300)).rejects.toThrow(
      /443 -> 9297 did not listen/
    );
    expect(docker.calls).toContainEqual(['rm', '-f', 'sidecar-2']);
  });
});

describe('imageInLocalCache', () => {
  it('is true when docker image inspect succeeds, false when it fails', async () => {
    expect(await imageInLocalCache('public.ecr.aws/lambda/nodejs:22')).toBe(true);
    expect(docker.calls[0]).toEqual([
      'image',
      'inspect',
      '--format',
      '{{.Id}}',
      'public.ecr.aws/lambda/nodejs:22',
    ]);
    docker.answer.mockImplementation(() => new Error('No such image'));
    expect(await imageInLocalCache('public.ecr.aws/lambda/nodejs:22')).toBe(false);
  });
});

describe('removeContainersSync', () => {
  it('removes every id in one synchronous docker rm -f, and nothing for none', () => {
    removeContainersSync(['a', 'b']);
    removeContainersSync([]);
    expect(docker.syncCalls).toEqual([['rm', '-f', 'a', 'b']]);
  });
});
