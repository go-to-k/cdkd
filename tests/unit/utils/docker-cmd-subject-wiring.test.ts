// The callers of `partitionSensitiveEnv` outside run-task pass a `subject`,
// so the win32 letter-case warnings (#2190) name the container they are
// about: `runDetached` (`cdkd local start-api` sets a name carrying the
// function's logical id) and the run-task metadata sidecar. `child_process`
// is mocked, so nothing is spawned.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/utils/logger.js')>(
    '../../../src/utils/logger.js'
  );
  const leaf = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    setLevel: vi.fn(),
    getLevel: () => 'info',
    child: () => leaf,
  };
  return { ...actual, getLogger: () => leaf };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: (...allArgs: unknown[]) => {
      const cb = allArgs[allArgs.length - 1] as (err: unknown, out?: { stdout: string }) => void;
      cb(null, { stdout: 'container-id\n' });
    },
  };
});

vi.mock('../../../src/local/docker-runner.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/local/docker-runner.js')>(
    '../../../src/local/docker-runner.js'
  );
  return { ...actual, pullImage: vi.fn(async () => undefined) };
});

import { runDetached } from '../../../src/local/docker-runner.js';
import { createTaskNetwork } from '../../../src/local/ecs-network.js';

describe('partitionSensitiveEnv subject wiring (issue #2190)', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const HOST = 'AWS_ACCEß_KEY_ID';
  const savedHost = process.env[HOST];

  beforeEach(() => {
    warnSpy.mockReset();
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', platformDescriptor);
    if (savedHost === undefined) delete process.env[HOST];
    else process.env[HOST] = savedHost;
  });

  function warnings(): string[] {
    return warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
  }

  it('runDetached names its container in the letter-case warning', async () => {
    await runDetached({
      image: 'img:latest',
      mounts: [],
      env: { my_2190_secret: 'a', MY_2190_SECRET: 'b' },
      cmd: [],
      hostPort: 9000,
      name: 'cdkd-local-MyFn-1-abc',
      sensitiveEnvKeys: new Set(['my_2190_secret', 'MY_2190_SECRET']),
    });
    expect(
      warnings().filter((m) => m.startsWith("Container 'cdkd-local-MyFn-1-abc': Sensitive env vars "))
    ).toHaveLength(1);
  });

  it('runDetached without a name warns with no subject', async () => {
    await runDetached({
      image: 'img:latest',
      mounts: [],
      env: { my_2190_secret: 'a', MY_2190_SECRET: 'b' },
      cmd: [],
      hostPort: 9000,
      sensitiveEnvKeys: new Set(['my_2190_secret', 'MY_2190_SECRET']),
    });
    expect(warnings().filter((m) => m.startsWith('Sensitive env vars '))).toHaveLength(1);
  });

  it('the metadata sidecar names itself in the warning', async () => {
    // A host name that matches the sidecar's AWS_ACCESS_KEY_ID beyond a-z case
    // makes that credential ambiguous, which is what warns here.
    process.env[HOST] = 'x';
    await createTaskNetwork({
      networkName: 'cdkd-local-task-2190',
      skipPull: true,
      credentials: { accessKeyId: 'AKID', secretAccessKey: 'SECRET' },
    });
    expect(
      warnings().filter((m) =>
        m.startsWith("Sidecar 'cdkd-local-task-2190-metadata': Sensitive env var(s) ")
      )
    ).toHaveLength(1);
  });
});
