import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  formatDockerLoginError,
  getDockerCmd,
  runDockerStreaming,
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
