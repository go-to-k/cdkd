import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  dockerClientEnvCollisions,
  dockerSpawnEnvWithSensitive,
  formatDockerLoginError,
  getDockerCmd,
  runDockerStreaming,
  spawnForeground,
  spawnStreaming,
} from '../../../src/utils/docker-cmd.js';

describe('getDockerCmd', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env['CDK_DOCKER'];
    delete process.env['CDK_DOCKER'];
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env['CDK_DOCKER'];
    else process.env['CDK_DOCKER'] = originalEnv;
  });

  it("returns 'docker' when CDK_DOCKER is unset", () => {
    delete process.env['CDK_DOCKER'];
    expect(getDockerCmd()).toBe('docker');
  });

  it('returns the CDK_DOCKER override when set', () => {
    process.env['CDK_DOCKER'] = 'podman';
    expect(getDockerCmd()).toBe('podman');
  });

  it("treats an empty CDK_DOCKER as unset (falls back to 'docker')", () => {
    process.env['CDK_DOCKER'] = '';
    expect(getDockerCmd()).toBe('docker');
  });

  it('passes nerdctl / finch / lima paths through verbatim', () => {
    process.env['CDK_DOCKER'] = '/opt/homebrew/bin/finch';
    expect(getDockerCmd()).toBe('/opt/homebrew/bin/finch');
  });
});

// `runDockerStreaming` and `spawnStreaming` machinery — covers ENOENT,
// non-zero-exit `SpawnError` shape, stdin write-through, and env merge.
// These tests exercise the REAL `child_process.spawn` against tiny shell
// commands available on every supported platform (/bin/sh, /bin/cat),
// which keeps the test honest about the streaming + close-event +
// stdin-pipe semantics. Skips on Windows-only CI (`process.platform`
// guard) — cdkd's Node target is Linux/macOS for now.

describe('runDockerStreaming / spawnStreaming machinery', () => {
  const itPosix = process.platform === 'win32' ? it.skip : it;

  itPosix('captures stdout and stderr separately', async () => {
    const { stdout, stderr } = await spawnStreaming('/bin/sh', [
      '-c',
      'printf hi; printf err 1>&2',
    ]);
    expect(stdout).toBe('hi');
    expect(stderr).toBe('err');
  });

  itPosix('writes options.input to stdin and the child sees it on stdout', async () => {
    const { stdout } = await spawnStreaming('/bin/cat', [], { input: 'piped-input-token' });
    expect(stdout).toBe('piped-input-token');
  });

  itPosix('rejects on non-zero exit with a SpawnError carrying stderr + exitCode', async () => {
    let caught: unknown;
    try {
      await spawnStreaming('/bin/sh', ['-c', 'printf BOOM 1>&2; exit 7']);
    } catch (err) {
      caught = err;
    }
    const e = caught as { message: string; stderr: string; stdout: string; exitCode: number };
    expect(e.message).toMatch(/BOOM/);
    expect(e.stderr).toBe('BOOM');
    expect(e.stdout).toBe('');
    expect(e.exitCode).toBe(7);
  });

  itPosix(
    'rejects ENOENT with the install / CDK_DOCKER hint when the binary does not exist',
    async () => {
      await expect(
        spawnStreaming('/non/existent/binary/cdkd-test', [])
      ).rejects.toThrow(/Install Docker.*CDK_DOCKER/);
    }
  );

  itPosix('rejects ENOENT with a CDK_DOCKER-aware hint when CDK_DOCKER points at the missing binary', async () => {
    const original = process.env['CDK_DOCKER'];
    process.env['CDK_DOCKER'] = '/non/existent/binary/cdkd-podman-test';
    try {
      // runDockerStreaming uses getDockerCmd() which reads CDK_DOCKER on each call.
      await expect(runDockerStreaming([])).rejects.toThrow(
        /resolved via CDK_DOCKER.*unset CDK_DOCKER/
      );
    } finally {
      if (original === undefined) delete process.env['CDK_DOCKER'];
      else process.env['CDK_DOCKER'] = original;
    }
  });

  itPosix('options.env overlays process.env (and undefined entries are deleted)', async () => {
    const original = process.env['CDKD_TEST_BASE_VAR'];
    process.env['CDKD_TEST_BASE_VAR'] = 'inherited';
    try {
      const { stdout } = await spawnStreaming('/bin/sh', ['-c', 'printf "%s|%s" "$CDKD_TEST_BASE_VAR" "$CDKD_TEST_OVERLAY_VAR"'], {
        env: {
          CDKD_TEST_OVERLAY_VAR: 'overlay-value',
          // undefined → drop CDKD_TEST_BASE_VAR even though process.env has it
          CDKD_TEST_BASE_VAR: undefined,
        },
      });
      expect(stdout).toBe('|overlay-value');
    } finally {
      if (original === undefined) delete process.env['CDKD_TEST_BASE_VAR'];
      else process.env['CDKD_TEST_BASE_VAR'] = original;
    }
  });

  itPosix('options.cwd resolves the working directory', async () => {
    const { stdout } = await spawnStreaming('/bin/sh', ['-c', 'pwd'], { cwd: '/tmp' });
    // macOS aliases /tmp → /private/tmp; accept either to keep the test portable.
    expect(stdout.trim()).toMatch(/^(\/private)?\/tmp$/);
  });

  itPosix('runDockerStreaming routes via getDockerCmd() (CDK_DOCKER override propagates)', async () => {
    const original = process.env['CDK_DOCKER'];
    process.env['CDK_DOCKER'] = '/bin/sh';
    try {
      const { stdout } = await runDockerStreaming(['-c', 'printf via-cdk-docker']);
      expect(stdout).toBe('via-cdk-docker');
    } finally {
      if (original === undefined) delete process.env['CDK_DOCKER'];
      else process.env['CDK_DOCKER'] = original;
    }
  });
});

// `spawnForeground` machinery — covers exit-code-0 happy path, non-zero
// exit rejection, and ENOENT error rewriting. Inherit-mode means we can't
// capture stdout/stderr in-process (the parent's stdio IS the child's),
// so the assertions focus on the resolve / reject shape rather than
// captured streams.
describe('spawnForeground machinery', () => {
  const itPosix = process.platform === 'win32' ? it.skip : it;

  itPosix('resolves on exit code 0', async () => {
    await expect(spawnForeground('/bin/sh', ['-c', 'true'])).resolves.toBeUndefined();
  });

  itPosix('rejects on non-zero exit with `exited with code N` message', async () => {
    let caught: unknown;
    try {
      await spawnForeground('/bin/sh', ['-c', 'exit 9']);
    } catch (err) {
      caught = err;
    }
    const e = caught as Error;
    expect(e.message).toMatch(/exited with code 9/);
  });

  itPosix(
    'rejects ENOENT with the Install Docker / CDK_DOCKER hint when the binary does not exist',
    async () => {
      await expect(
        spawnForeground('/non/existent/binary/cdkd-test-foreground', [])
      ).rejects.toThrow(/Install Docker.*CDK_DOCKER/);
    }
  );

  itPosix('options.cwd resolves the working directory', async () => {
    // foreground/inherit can't capture pwd output, so we instead verify the
    // cwd is honored by checking exit code 0 against a path-sensitive check:
    // `test -f` against a known absolute path inside the cwd. /tmp on macOS
    // is a symlink to /private/tmp, both have ./.exists semantically anyway.
    await expect(
      spawnForeground('/bin/sh', ['-c', '[ "$PWD" = /tmp ] || [ "$PWD" = /private/tmp ]'], {
        cwd: '/tmp',
      })
    ).resolves.toBeUndefined();
  });
});

// `formatDockerLoginError` — pattern-detect the macOS osxkeychain
// credential-helper bug and surface an actionable `docker logout
// <endpoint>` workaround instead of the raw cryptic docker stderr.
describe('formatDockerLoginError', () => {
  const endpoint = 'https://123456789012.dkr.ecr.us-east-1.amazonaws.com';

  it("rewrites the 'already exists in the keychain' osxkeychain collision", () => {
    const stderr =
      'Error saving credentials: error storing credentials - err: exit status 1, ' +
      'out: `The specified item already exists in the keychain.`';
    const out = formatDockerLoginError(stderr, endpoint);
    expect(out).toMatch(/Quick fix: run `docker logout https:\/\/123456789012\.dkr\.ecr\.us-east-1\.amazonaws\.com`/);
    // Platform-agnostic wording (osxkeychain / wincred / pass / secretservice all hit
    // the same class) — the user-facing message must NOT pin the diagnosis to macOS
    // when the same workaround applies on Windows + Linux too.
    expect(out).toMatch(/docker-credential-helpers issue/);
    expect(out).toMatch(/osxkeychain on macOS \/ wincred on Windows \/ pass \/ secretservice on Linux/);
    expect(out).toMatch(/credsStore/); // permanent-fix hint
    expect(out).toContain(stderr); // original stderr preserved for diagnosis
  });

  it("also catches the bare 'Error saving credentials' shape without the keychain string", () => {
    // Some docker-credential-* helpers (pass-store, secretservice) emit
    // the saving-credentials prefix but a different out-line — same root
    // cause (the credential helper can't persist), so route to the same
    // workaround.
    const stderr = 'Error saving credentials: pass not initialized for user';
    const out = formatDockerLoginError(stderr, endpoint);
    expect(out).toMatch(/docker logout /);
  });

  it('passes a non-credential-helper error through verbatim (trimmed)', () => {
    const stderr =
      '\n  Error response from daemon: Get "https://123456789012.dkr.ecr.us-east-1.amazonaws.com/v2/": net/http: TLS handshake timeout  \n';
    const out = formatDockerLoginError(stderr, endpoint);
    expect(out).toBe(
      'Error response from daemon: Get "https://123456789012.dkr.ecr.us-east-1.amazonaws.com/v2/": net/http: TLS handshake timeout'
    );
    expect(out).not.toMatch(/docker logout /);
  });

  it('handles an empty stderr cleanly', () => {
    expect(formatDockerLoginError('', endpoint)).toBe('');
  });
});


describe('dockerSpawnEnvWithSensitive (issue #2183)', () => {
  it('passes an ordinary secret value through to the child env, newlines intact', () => {
    const env = dockerSpawnEnvWithSensitive({ MY_DB_PASSWORD: 'p@ss\nword' });
    // Multi-line values (PEM keys etc.) survive — the reason this uses the env
    // channel rather than a line-based --env-file.
    expect(env['MY_DB_PASSWORD']).toBe('p@ss\nword');
  });

  it('does NOT let a secret named after a docker-client var hijack the client env', () => {
    const savedHost = process.env['DOCKER_HOST'];
    const savedPath = process.env['PATH'];
    process.env['DOCKER_HOST'] = 'unix:///var/run/docker.sock';
    try {
      const env = dockerSpawnEnvWithSensitive({
        DOCKER_HOST: 'tcp://attacker.example:2375',
        PATH: '/tmp/evil',
        REAL_SECRET: 'ok',
      });
      // The docker client's own critical vars stay authoritative...
      expect(env['DOCKER_HOST']).toBe('unix:///var/run/docker.sock');
      expect(env['PATH']).toBe(savedPath);
      expect(env['PATH']).not.toBe('/tmp/evil');
      // ...while an ordinary secret still passes through.
      expect(env['REAL_SECRET']).toBe('ok');
    } finally {
      if (savedHost === undefined) delete process.env['DOCKER_HOST'];
      else process.env['DOCKER_HOST'] = savedHost;
    }
  });

  it('protects docker-client vars case-insensitively (Windows env keys are case-insensitive)', () => {
    const savedHost = process.env['DOCKER_HOST'];
    delete process.env['DOCKER_HOST'];
    try {
      const env = dockerSpawnEnvWithSensitive({ docker_host: 'tcp://attacker.example:2375' });
      // A lowercase collision must not define the client's DOCKER_HOST in any case.
      expect(env['docker_host']).toBeUndefined();
      expect(env['DOCKER_HOST']).toBeUndefined();
    } finally {
      if (savedHost !== undefined) process.env['DOCKER_HOST'] = savedHost;
    }
  });

  it('dockerClientEnvCollisions reports colliding names case-insensitively', () => {
    expect(
      dockerClientEnvCollisions({ docker_host: 'x', MY_SECRET: 'y', PATH: 'z' }).sort()
    ).toEqual(['PATH', 'docker_host']);
    expect(dockerClientEnvCollisions({ ONLY_SAFE: 'v' })).toEqual([]);
  });

  it('drops a docker-client var the host never set, even if a secret defines it', () => {
    const saved = process.env['DOCKER_CONTEXT'];
    delete process.env['DOCKER_CONTEXT'];
    try {
      const env = dockerSpawnEnvWithSensitive({ DOCKER_CONTEXT: 'evil-context' });
      expect(env['DOCKER_CONTEXT']).toBeUndefined();
    } finally {
      if (saved !== undefined) process.env['DOCKER_CONTEXT'] = saved;
    }
  });
});
