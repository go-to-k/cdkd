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

const {
  NAMESPACE_PORT_FORWARDER_SCRIPT,
  imageInLocalCache,
  removeContainersSync,
  startNamespacePortForwarder,
} = await import('../../../src/local/docker-runner.js');
const { spawn } = await import('node:child_process');
const { connect, createServer } = await import('node:net');
type AddressInfo = import('node:net').AddressInfo;
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

  it('names the sidecar when asked, so it can be removed before its id is known', async () => {
    docker.answer.mockImplementation((args) =>
      args[0] === 'run' ? 'sidecar-3\n' : args[0] === 'logs' ? 'ready\n' : ''
    );
    await startNamespacePortForwarder('ctr-1', 443, 9297, 1000, 'cdkd-cr-abc-443');
    expect(docker.calls[0]!.slice(0, 7)).toEqual([
      'run',
      '-d',
      '--rm',
      '--name',
      'cdkd-cr-abc-443',
      '--network',
      'container:ctr-1',
    ]);
  });

  it('removes the sidecar and throws when it never listens', async () => {
    docker.answer.mockImplementation((args) => (args[0] === 'run' ? 'sidecar-2\n' : ''));
    await expect(startNamespacePortForwarder('ctr-1', 443, 9297, 300)).rejects.toThrow(
      /443 -> 9297 did not listen/
    );
    expect(docker.calls).toContainEqual(['rm', '-f', 'sidecar-2']);
  });
});

describe('NAMESPACE_PORT_FORWARDER_SCRIPT (run for real)', () => {
  /** A TCP server on `host:port` (0 = any) answering `tag`; undefined when it cannot bind. */
  function answering(
    host: string,
    port: number,
    tag: string
  ): Promise<{ port: number; close(): void } | undefined> {
    return new Promise((resolve) => {
      const server = createServer((c) => c.end(tag));
      server.once('error', () => resolve(undefined));
      server.listen(port, host, () => {
        resolve({ port: (server.address() as AddressInfo).port, close: () => server.close() });
      });
    });
  }
  function read(host: string, port: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const s = connect(port, host);
      let out = '';
      s.on('data', (d) => (out += String(d)));
      s.on('end', () => resolve(out));
      s.on('error', reject);
    });
  }

  it('forwards IPv4 to 127.0.0.1 and, where IPv6 exists, ::1 to ::1', async () => {
    const v4 = (await answering('127.0.0.1', 0, 'v4'))!;
    const target = v4.port;
    // The same target port on ::1, where this host has IPv6.
    const v6b = await answering('::1', target, 'v6');
    const listen = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const p = (probe.address() as AddressInfo).port;
        probe.close(() => resolve(p));
      });
    });
    const child = spawn(
      process.execPath,
      ['-e', NAMESPACE_PORT_FORWARDER_SCRIPT, String(listen), String(target)],
      { stdio: ['ignore', 'pipe', 'inherit'] }
    );
    try {
      await new Promise<void>((resolve) => child.stdout!.once('data', () => resolve()));
      expect(await read('127.0.0.1', listen)).toBe('v4');
      if (v6b) expect(await read('::1', listen)).toBe('v6');
    } finally {
      child.kill();
      v4.close();
      v6b?.close();
    }
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
