/**
 * go-to-k/cdkd#6187 (follows go-to-k/cdk-local#918): under --aws-emulator,
 * unless ECR is excepted, cdkd's own docker spawns (`runDocker*`, the
 * asset-build spawns) run with a per-run DOCKER_CONFIG holding no ECR
 * credential. Outside the flag the host's config is untouched.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// A pass-through spy on `spawn`, to see exactly what options a docker spawn got.
const spawnSpy = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      spawnSpy(...args);
      return actual.spawn(...args);
    },
  };
});

/**
 * cdk-local caches the stripped config dir per process (and it is external to
 * vitest, so `vi.resetModules()` does not reset it); the cache is dropped when
 * the dir no longer exists. `afterEach` removes the dirs a test used, so each
 * test builds its own from its own host config. The `marker` check proves it.
 */
async function load() {
  const internal = await import('cdk-local/internal');
  const build = await import('../../../src/assets/docker-build.js');
  const cmd = await import('../../../src/utils/docker-cmd.js');
  return {
    setAwsEmulatorServiceRouting: internal.setAwsEmulatorServiceRouting,
    setAwsEndpointOverride: internal.setAwsEndpointOverride,
    buildDockerImage: build.buildDockerImage,
    runDockerForeground: cmd.runDockerForeground,
    runDockerStreaming: cmd.runDockerStreaming,
  };
}

const EMU = {
  endpoint: 'https://127.0.0.1:9403',
  credentials: { accessKeyId: 'EMUKEY', secretAccessKey: 'x'.repeat(40) },
};
const ECR = '123456789012.dkr.ecr.us-east-1.amazonaws.com';

let root: string;
let hostDir: string;
let log: string;
const saved: Record<string, string | undefined> = {};
const KEYS = ['DOCKER_CONFIG', 'REGISTRY_AUTH_FILE', 'DOCKER_AUTH_CONFIG', 'CDK_DOCKER'];

/** A fake docker that records the DOCKER_CONFIG it was spawned with. */
function fakeDocker(): string {
  const bin = join(root, 'fake-docker');
  writeFileSync(bin, `#!/bin/sh\necho "$DOCKER_CONFIG" >> "${log}"\nexit 0\n`);
  chmodSync(bin, 0o755);
  return bin;
}
const seen = (): string[] => readFileSync(log, 'utf-8').trim().split('\n');
const configOf = (dir: string): unknown => {
  const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8')) as { marker?: string };
  // The stripped copy was made from THIS test's host config, not a cached one.
  expect(cfg.marker).toBe(root);
  return cfg;
};

let m: Awaited<ReturnType<typeof load>>;

beforeEach(async () => {
  m = await load();
  spawnSpy.mockClear();
  for (const k of KEYS) saved[k] = process.env[k];
  root = mkdtempSync(join(tmpdir(), 'cdkd-6187-'));
  hostDir = join(root, 'host');
  mkdirSync(hostDir);
  writeFileSync(
    join(hostDir, 'config.json'),
    JSON.stringify({ auths: { [ECR]: { auth: 'ZWNyOnRvaw==' } }, credsStore: 'osxkeychain' }).replace('{', `{"marker":"${root}",`)
  );
  log = join(root, 'log');
  writeFileSync(log, '');
  process.env['DOCKER_CONFIG'] = hostDir;
  delete process.env['REGISTRY_AUTH_FILE'];
  delete process.env['DOCKER_AUTH_CONFIG'];
  process.env['CDK_DOCKER'] = fakeDocker();
});

afterEach(() => {
  for (const dir of readFileSync(log, 'utf-8').split('\n')) {
    if (dir && dir !== hostDir) rmSync(dir, { recursive: true, force: true });
  }
  m.setAwsEmulatorServiceRouting(undefined);
  m.setAwsEndpointOverride(undefined);
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

describe('docker spawns under --aws-emulator', () => {
  it('runDockerStreaming and runDockerForeground use an ECR-free DOCKER_CONFIG', async () => {
    const { setAwsEmulatorServiceRouting, setAwsEndpointOverride, buildDockerImage, runDockerForeground, runDockerStreaming } = m;
    setAwsEndpointOverride(EMU);
    await runDockerStreaming(['pull', `${ECR}/a:1`], { streamLive: false });
    await runDockerForeground(['pull', `${ECR}/a:1`]);
    expect(seen()).toHaveLength(2);
    for (const dir of seen()) {
      expect(dir).not.toBe(hostDir);
      expect(JSON.stringify(configOf(dir))).not.toContain('ecr');
      expect(JSON.stringify(configOf(dir))).not.toContain('osxkeychain');
    }
  });

  it('a directory-mode asset build holds no ECR credential', async () => {
    const { setAwsEmulatorServiceRouting, setAwsEndpointOverride, buildDockerImage, runDockerForeground, runDockerStreaming } = m;
    setAwsEndpointOverride(EMU);
    mkdirSync(join(root, 'asset.x'));
    await buildDockerImage({ source: { directory: 'asset.x' } }, root, {
      tag: 't',
      assetOutdir: root,
      wrapError: (m) => new Error(m),
    });
    const dir = seen()[0]!;
    expect(dir).not.toBe(hostDir);
    expect(JSON.stringify(configOf(dir))).not.toContain(ECR);
  });

  it('an executable-mode asset build holds no ECR credential', async () => {
    const { setAwsEmulatorServiceRouting, setAwsEndpointOverride, buildDockerImage, runDockerForeground, runDockerStreaming } = m;
    setAwsEndpointOverride(EMU);
    const script = join(root, 'build.sh');
    writeFileSync(script, `#!/bin/sh\necho "$DOCKER_CONFIG" >> "${log}"\necho built-tag\n`);
    chmodSync(script, 0o755);
    await buildDockerImage({ source: { executable: [script] } }, root, {
      assetOutdir: root,
      wrapError: (m) => new Error(m),
    });
    const dir = seen()[0]!;
    expect(dir).not.toBe(hostDir);
    expect(JSON.stringify(configOf(dir))).not.toContain(ECR);
  });

  it("a directory-mode build routes by its workload's own ECR exception", async () => {
    const { setAwsEmulatorServiceRouting, setAwsEndpointOverride, buildDockerImage, runDockerForeground, runDockerStreaming } = m;
    setAwsEmulatorServiceRouting({
      realServices: [],
      override: EMU,
      envOverrides: { Parameters: {}, web: { AWS_ENDPOINT_URL_ECR: 'real-aws' } },
    });
    mkdirSync(join(root, 'asset.x'));
    const build = (workload: { containerName: string }): Promise<string> =>
      buildDockerImage({ source: { directory: 'asset.x' } }, root, {
        tag: 't',
        assetOutdir: root,
        workload,
        wrapError: (m) => new Error(m),
      });
    await build({ containerName: 'web' });
    await build({ containerName: 'worker' });
    const [web, worker] = seen();
    expect(web).toBe(hostDir);
    expect(worker).not.toBe(hostDir);
  });

  it('a "real-aws" ECR exception keeps the host config', async () => {
    const { setAwsEmulatorServiceRouting, setAwsEndpointOverride, buildDockerImage, runDockerForeground, runDockerStreaming } = m;
    setAwsEmulatorServiceRouting({
      realServices: [],
      override: EMU,
      envOverrides: { Parameters: { AWS_ENDPOINT_URL_ECR: 'real-aws' } },
    });
    await runDockerStreaming(['pull', `${ECR}/a:1`], { streamLive: false });
    expect(seen()).toEqual([hostDir]);
  });

  it('outside --aws-emulator the host config is untouched', async () => {
    const { setAwsEmulatorServiceRouting, setAwsEndpointOverride, buildDockerImage, runDockerForeground, runDockerStreaming } = m;
    await runDockerStreaming(['pull', `${ECR}/a:1`], { streamLive: false });
    expect(seen()).toEqual([hostDir]);
  });

  it('DOCKER_CONFIG unset on the host stays unset, and the spawn options are passed through unchanged', async () => {
    const { runDockerStreaming } = m;
    delete process.env['DOCKER_CONFIG'];
    await runDockerStreaming(['pull', `${ECR}/a:1`], { streamLive: false });
    expect(seen()).toEqual(['']);
    // No env was injected: an implementation that always adds the registry
    // env would hand `spawn` an env object here.
    const opts = spawnSpy.mock.calls.at(-1)![2] as { env?: unknown };
    expect(opts.env).toBeUndefined();
  });

  it('each test reflects its own host config (no stripped dir carried across tests)', async () => {
    m.setAwsEndpointOverride(EMU);
    await m.runDockerStreaming(['pull', `${ECR}/a:1`], { streamLive: false });
    configOf(seen()[0]!);
  });
});
