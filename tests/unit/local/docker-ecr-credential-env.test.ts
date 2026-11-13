/**
 * go-to-k/cdkd#6187 (follows go-to-k/cdk-local#918): under --aws-emulator,
 * unless ECR is excepted, cdkd's own docker spawns (`runDocker*`, the
 * asset-build spawns) run with a per-run DOCKER_CONFIG holding no ECR
 * credential. Outside the flag the host's config is untouched.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { setAwsEmulatorServiceRouting, setAwsEndpointOverride } from 'cdk-local/internal';
import { buildDockerImage } from '../../../src/assets/docker-build.js';
import { runDockerForeground, runDockerStreaming } from '../../../src/utils/docker-cmd.js';

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
const configOf = (dir: string): unknown => JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8'));

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  root = mkdtempSync(join(tmpdir(), 'cdkd-6187-'));
  hostDir = join(root, 'host');
  mkdirSync(hostDir);
  writeFileSync(
    join(hostDir, 'config.json'),
    JSON.stringify({ auths: { [ECR]: { auth: 'ZWNyOnRvaw==' } }, credsStore: 'osxkeychain' })
  );
  log = join(root, 'log');
  writeFileSync(log, '');
  process.env['DOCKER_CONFIG'] = hostDir;
  delete process.env['REGISTRY_AUTH_FILE'];
  delete process.env['DOCKER_AUTH_CONFIG'];
  process.env['CDK_DOCKER'] = fakeDocker();
});

afterEach(() => {
  setAwsEmulatorServiceRouting(undefined);
  setAwsEndpointOverride(undefined);
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

describe('docker spawns under --aws-emulator', () => {
  it('runDockerStreaming and runDockerForeground use an ECR-free DOCKER_CONFIG', async () => {
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
    setAwsEmulatorServiceRouting({
      realServices: [],
      override: EMU,
      envOverrides: { Parameters: { AWS_ENDPOINT_URL_ECR: 'real-aws' } },
    });
    await runDockerStreaming(['pull', `${ECR}/a:1`], { streamLive: false });
    expect(seen()).toEqual([hostDir]);
  });

  it('outside --aws-emulator the host config is untouched', async () => {
    await runDockerStreaming(['pull', `${ECR}/a:1`], { streamLive: false });
    expect(seen()).toEqual([hostDir]);
  });
});
