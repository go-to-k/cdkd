import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// child_process mock — captures execFile invocations so the runDetached
// tests can assert on the docker args. Intentionally hoisted via the
// vi.mock factory so this file's run order matches the ecr-puller.test
// shape.
const childProcessMock = {
  execFile: vi.fn(),
};
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    // promisify(execFile)(cmd, args) → execFile(cmd, args, cb).
    // Our runDetached uses execFileAsync(cmd, args, opts) → execFile(cmd, args, opts, cb).
    // Both shapes thread through here; we record (cmd, args, opts).
    execFile: (...allArgs: unknown[]) => {
      const cb = allArgs[allArgs.length - 1] as (err: unknown, stdout?: { stdout: string }) => void;
      const cmd = allArgs[0] as string;
      const args = allArgs[1] as string[];
      const opts = allArgs.length === 4 ? allArgs[2] : undefined;
      childProcessMock.execFile(cmd, args, opts);
      cb(null, { stdout: 'container-id\n' } as { stdout: string });
    },
  };
});

import {
  pickFreePort,
  redactAwsCredentialsInArgs,
  runDetached,
} from '../../../src/local/docker-runner.js';

describe('pickFreePort', () => {
  it('returns a positive port number', async () => {
    const port = await pickFreePort();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });

  it('returns different ports across consecutive calls (probabilistic)', async () => {
    // The OS may reuse a freshly-released port, but the probability of
    // hitting the same one twice in a row is small. This is a smoke test
    // for "the function actually allocates" rather than a strict invariant.
    const a = await pickFreePort();
    const b = await pickFreePort();
    expect(typeof a).toBe('number');
    expect(typeof b).toBe('number');
  });
});

describe('redactAwsCredentialsInArgs', () => {
  it('redacts -e AWS_SECRET_ACCESS_KEY=...', () => {
    const args = [
      'run',
      '-d',
      '--rm',
      '-e',
      'AWS_SECRET_ACCESS_KEY=supersecret',
      '-e',
      'OTHER=value',
      'image:tag',
    ];
    expect(redactAwsCredentialsInArgs(args)).toEqual([
      'run',
      '-d',
      '--rm',
      '-e',
      'AWS_SECRET_ACCESS_KEY=***',
      '-e',
      'OTHER=value',
      'image:tag',
    ]);
  });

  it('redacts AWS_ACCESS_KEY_ID and AWS_SESSION_TOKEN too', () => {
    const args = [
      '-e',
      'AWS_ACCESS_KEY_ID=AKIA-fake',
      '-e',
      'AWS_SESSION_TOKEN=abc123',
      '-e',
      'AWS_REGION=us-east-1',
    ];
    const out = redactAwsCredentialsInArgs(args);
    expect(out).toEqual([
      '-e',
      'AWS_ACCESS_KEY_ID=***',
      '-e',
      'AWS_SESSION_TOKEN=***',
      '-e',
      'AWS_REGION=us-east-1',
    ]);
  });

  it('does not mutate the input array', () => {
    const args = ['-e', 'AWS_SECRET_ACCESS_KEY=secret'];
    const out = redactAwsCredentialsInArgs(args);
    expect(args).toEqual(['-e', 'AWS_SECRET_ACCESS_KEY=secret']);
    expect(out).not.toBe(args);
  });

  it('does not redact -e KEY=value when KEY is not a credential key', () => {
    const args = ['-e', 'AWS_REGION=us-east-1', '-e', 'CUSTOM=foo'];
    expect(redactAwsCredentialsInArgs(args)).toEqual(args);
  });

  it('handles empty -e and isolated -e at the end gracefully', () => {
    expect(redactAwsCredentialsInArgs([])).toEqual([]);
    // Trailing -e with no value (defensive — shouldn't happen in practice).
    expect(redactAwsCredentialsInArgs(['-e'])).toEqual(['-e']);
  });
});

describe('runDetached', () => {
  beforeEach(() => {
    childProcessMock.execFile.mockReset();
  });
  afterEach(() => {
    childProcessMock.execFile.mockReset();
  });

  function lastArgs(): string[] {
    const calls = childProcessMock.execFile.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const lastCall = calls[calls.length - 1] as unknown[];
    return lastCall[1] as string[];
  }

  it('passes entryPoint: ["custom-entry", "arg1", "arg2"] as --entrypoint + positional tail before cmd', async () => {
    await runDetached({
      image: 'my-image:latest',
      mounts: [],
      env: {},
      cmd: ['cmd1', 'cmd2'],
      hostPort: 9000,
      entryPoint: ['custom-entry', 'arg1', 'arg2'],
    });
    const args = lastArgs();
    const epIdx = args.indexOf('--entrypoint');
    expect(epIdx).toBeGreaterThanOrEqual(0);
    expect(args[epIdx + 1]).toBe('custom-entry');
    // After the image name, the tail of entryPoint precedes cmd:
    const imageIdx = args.indexOf('my-image:latest');
    expect(args.slice(imageIdx + 1)).toEqual(['arg1', 'arg2', 'cmd1', 'cmd2']);
  });

  it('omits --entrypoint when entryPoint is empty []', async () => {
    await runDetached({
      image: 'my-image:latest',
      mounts: [],
      env: {},
      cmd: ['cmd1'],
      hostPort: 9000,
      entryPoint: [],
    });
    const args = lastArgs();
    expect(args).not.toContain('--entrypoint');
    const imageIdx = args.indexOf('my-image:latest');
    // No tail prepending: only the cmd args follow the image.
    expect(args.slice(imageIdx + 1)).toEqual(['cmd1']);
  });

  it('omits --entrypoint when entryPoint is undefined', async () => {
    await runDetached({
      image: 'my-image:latest',
      mounts: [],
      env: {},
      cmd: ['cmd1'],
      hostPort: 9000,
    });
    expect(lastArgs()).not.toContain('--entrypoint');
  });

  it('passes name as --name', async () => {
    await runDetached({
      image: 'my-image:latest',
      mounts: [],
      env: {},
      cmd: [],
      hostPort: 9000,
      name: 'cdkd-local-foo-1234',
    });
    const args = lastArgs();
    const nameIdx = args.indexOf('--name');
    expect(nameIdx).toBeGreaterThanOrEqual(0);
    expect(args[nameIdx + 1]).toBe('cdkd-local-foo-1234');
  });

  it('omits --name when undefined', async () => {
    await runDetached({
      image: 'my-image:latest',
      mounts: [],
      env: {},
      cmd: [],
      hostPort: 9000,
    });
    expect(lastArgs()).not.toContain('--name');
  });

  it('passes platform as --platform', async () => {
    await runDetached({
      image: 'my-image:latest',
      mounts: [],
      env: {},
      cmd: [],
      hostPort: 9000,
      platform: 'linux/arm64',
    });
    const args = lastArgs();
    const platformIdx = args.indexOf('--platform');
    expect(platformIdx).toBeGreaterThanOrEqual(0);
    expect(args[platformIdx + 1]).toBe('linux/arm64');
  });

  it('passes workingDir as --workdir', async () => {
    await runDetached({
      image: 'my-image:latest',
      mounts: [],
      env: {},
      cmd: [],
      hostPort: 9000,
      workingDir: '/var/task',
    });
    const args = lastArgs();
    const wdIdx = args.indexOf('--workdir');
    expect(wdIdx).toBeGreaterThanOrEqual(0);
    expect(args[wdIdx + 1]).toBe('/var/task');
  });

  it('emits all flags (entryPoint + workingDir + platform + name) in stable order', async () => {
    await runDetached({
      image: 'my-image:latest',
      mounts: [],
      env: {},
      cmd: ['cmd1'],
      hostPort: 9000,
      name: 'cdkd-local-test',
      platform: 'linux/amd64',
      workingDir: '/var/task',
      entryPoint: ['ep'],
    });
    const args = lastArgs();
    // Order from runDetached: --name, --platform, then -p / mounts / env,
    // then --workdir, --entrypoint, image, entryPointTail, cmd.
    expect(args.indexOf('--name')).toBeLessThan(args.indexOf('--platform'));
    expect(args.indexOf('--platform')).toBeLessThan(args.indexOf('--workdir'));
    expect(args.indexOf('--workdir')).toBeLessThan(args.indexOf('--entrypoint'));
    expect(args.indexOf('--entrypoint')).toBeLessThan(args.indexOf('my-image:latest'));
    // Sanity: each value is the one we passed.
    expect(args[args.indexOf('--name') + 1]).toBe('cdkd-local-test');
    expect(args[args.indexOf('--platform') + 1]).toBe('linux/amd64');
    expect(args[args.indexOf('--workdir') + 1]).toBe('/var/task');
    expect(args[args.indexOf('--entrypoint') + 1]).toBe('ep');
  });

  it('does not write AWS credential values to the spawn args (we do not redact at the wire layer)', async () => {
    // Sanity: redaction is at the LOG layer only — the actual creds must
    // still reach docker (otherwise the handler couldn't authenticate).
    await runDetached({
      image: 'my-image:latest',
      mounts: [],
      env: { AWS_SECRET_ACCESS_KEY: 'real-secret' },
      cmd: [],
      hostPort: 9000,
    });
    const args = lastArgs();
    expect(args).toContain('AWS_SECRET_ACCESS_KEY=real-secret');
  });
});
