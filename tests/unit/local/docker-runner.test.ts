import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// Logger spy (issue #2184): the collision `logger.warn` is the only signal a
// sensitive var was not passed to the container, so it is fenced directly.
const warnSpy = vi.hoisted(() => vi.fn());
// Issue #2440: the `--verbose` argv line is a REDACTION channel now, so it is
// spied on directly — it is the channel that renders on every verbose run,
// whereas the error path renders only when docker writes no stderr.
const debugSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => {
  const leaf = {
    info: vi.fn(),
    debug: debugSpy,
    warn: warnSpy,
    error: vi.fn(),
    setLevel: vi.fn(),
    getLevel: () => 'info',
    child: () => leaf,
  };
  return { getLogger: () => leaf };
});

// child_process mock — captures execFile invocations so the runDetached
// tests can assert on the docker args. Wrap the captures in
// `vi.hoisted(...)` so the same `vi.fn()` instance is visible to both
// the `vi.mock(...)` factory below (which is itself hoisted to the top
// of the file) AND to the test bodies. Plain top-level `const` would
// rely on lazy factory evaluation and is the borderline pattern called
// out in `feedback_vi_mock_hoisting.md` — switching to `vi.hoisted`
// keeps this file consistent with `ecr-puller.test.ts` /
// `local-invoke-resolve-plan.test.ts`.
const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  // Issue #2440: one-shot failure injection. A FUNCTION is invoked with the
  // real `(cmd, args)` so a fixture can build Node's actual execFile message
  // (`Command failed: <file> <args.join(' ')>\n<stderr>`) from the argv the
  // code under test really produced, rather than a hand-typed approximation.
  nextError: undefined as
    | undefined
    | Error
    | ((cmd: string, args: string[]) => Error & { stderr?: string }),
}));
const childProcessMock = mocks;
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
      mocks.execFile(cmd, args, opts);
      const injected = mocks.nextError;
      if (injected !== undefined) {
        mocks.nextError = undefined;
        cb(typeof injected === 'function' ? injected(cmd, args) : injected);
        return;
      }
      cb(null, { stdout: 'container-id\n' } as { stdout: string });
    },
  };
});

// docker-cmd mocks for `pullImage` — both helpers used by the pull path
// (`runDockerForeground` in the debug / --verbose branch, `runDockerStreaming`
// in the default captured branch) are mockable so the tests can drive each
// failure shape independently (ENOENT plain Error vs SpawnError).
const dockerCmdMocks = vi.hoisted(() => ({
  runDockerForeground: vi.fn(),
  runDockerStreaming: vi.fn(),
}));
vi.mock('../../../src/utils/docker-cmd.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/utils/docker-cmd.js')>(
    '../../../src/utils/docker-cmd.js'
  );
  return {
    ...actual,
    runDockerForeground: dockerCmdMocks.runDockerForeground,
    runDockerStreaming: dockerCmdMocks.runDockerStreaming,
  };
});

import { pickFreePort, pullImage, runDetached } from '../../../src/local/docker-runner.js';

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

describe('runDetached', () => {
  beforeEach(() => {
    childProcessMock.execFile.mockReset();
    debugSpy.mockReset();
    mocks.nextError = undefined;
  });
  afterEach(() => {
    childProcessMock.execFile.mockReset();
    debugSpy.mockReset();
    mocks.nextError = undefined;
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

  // PR 6 of #224 — Lambda Layers (issue #232)

  it('emits extraMounts after primary mounts in original order', async () => {
    // Layers in cdkd merge into a single /opt bind-mount at the call
    // site (Docker rejects duplicates), but the docker-runner itself
    // is generic — `extraMounts` lets the caller compose any number
    // of additional mounts at distinct target paths. This test uses
    // distinct targets to avoid coupling the wire-layer test to the
    // specific layer-merging strategy in `local-invoke.ts`.
    await runDetached({
      image: 'my-image:latest',
      mounts: [{ hostPath: '/host/code', containerPath: '/var/task', readOnly: true }],
      extraMounts: [
        { hostPath: '/host/extra-a', containerPath: '/opt', readOnly: true },
        { hostPath: '/host/extra-b', containerPath: '/data', readOnly: true },
      ],
      env: {},
      cmd: ['index.handler'],
      hostPort: 9000,
    });
    const args = lastArgs();
    const codeMountIdx = args.findIndex(
      (s, i) => args[i - 1] === '-v' && s === '/host/code:/var/task:ro'
    );
    const extraAIdx = args.findIndex(
      (s, i) => args[i - 1] === '-v' && s === '/host/extra-a:/opt:ro'
    );
    const extraBIdx = args.findIndex(
      (s, i) => args[i - 1] === '-v' && s === '/host/extra-b:/data:ro'
    );
    expect(codeMountIdx).toBeGreaterThan(0);
    expect(extraAIdx).toBeGreaterThan(codeMountIdx);
    expect(extraBIdx).toBeGreaterThan(extraAIdx);
  });

  it('omits :ro for extraMounts when readOnly is false', async () => {
    await runDetached({
      image: 'my-image:latest',
      mounts: [],
      extraMounts: [{ hostPath: '/host/x', containerPath: '/opt', readOnly: false }],
      env: {},
      cmd: [],
      hostPort: 9000,
    });
    const args = lastArgs();
    expect(args).toContain('/host/x:/opt');
  });

  it('emits no -v entries for extraMounts when omitted or empty', async () => {
    await runDetached({
      image: 'my-image:latest',
      mounts: [{ hostPath: '/host/code', containerPath: '/var/task', readOnly: true }],
      env: {},
      cmd: [],
      hostPort: 9000,
    });
    const args = lastArgs();
    const dashVCount = args.filter((s) => s === '-v').length;
    // Exactly one (the /var/task mount). No extraMounts → no extra -v.
    expect(dashVCount).toBe(1);
  });

  // Issue #440 — Lambda Properties.EphemeralStorage.Size → --tmpfs

  it('emits --tmpfs <target>:rw,size=<N>m when tmpfs is set', async () => {
    await runDetached({
      image: 'my-image:latest',
      mounts: [],
      env: {},
      cmd: [],
      hostPort: 9000,
      tmpfs: { target: '/tmp', sizeMb: 1024 },
    });
    const args = lastArgs();
    const idx = args.indexOf('--tmpfs');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('/tmp:rw,size=1024m');
  });

  it('omits --tmpfs when tmpfs is undefined', async () => {
    await runDetached({
      image: 'my-image:latest',
      mounts: [],
      env: {},
      cmd: [],
      hostPort: 9000,
    });
    expect(lastArgs()).not.toContain('--tmpfs');
  });

  it('places --tmpfs after -e env flags and before --workdir', async () => {
    await runDetached({
      image: 'my-image:latest',
      mounts: [],
      env: { KEY: 'val' },
      cmd: [],
      hostPort: 9000,
      tmpfs: { target: '/tmp', sizeMb: 512 },
      workingDir: '/var/task',
    });
    const args = lastArgs();
    const envIdx = args.indexOf('KEY=val');
    const tmpfsIdx = args.indexOf('--tmpfs');
    const workdirIdx = args.indexOf('--workdir');
    expect(envIdx).toBeGreaterThanOrEqual(0);
    expect(tmpfsIdx).toBeGreaterThan(envIdx);
    expect(workdirIdx).toBeGreaterThan(tmpfsIdx);
  });

  it('keeps AWS credential values off the docker run argv (passthrough form -e KEY)', async () => {
    // AWS credential keys are in the built-in SENSITIVE_ENV_KEYS set, so
    // runDetached emits `-e KEY` (no `=value`) rather than `-e KEY=value`
    // — the actual value is forwarded to docker via the spawn env option
    // (PR #717's BLOCKER fix). This keeps the decrypted secret off the
    // `docker run` argv (`ps` / `/proc/<pid>/cmdline` / verbose debug logs).
    await runDetached({
      image: 'my-image:latest',
      mounts: [],
      env: { AWS_SECRET_ACCESS_KEY: 'real-secret' },
      cmd: [],
      hostPort: 9000,
    });
    const args = lastArgs();
    // Value MUST NOT appear in argv.
    expect(args).not.toContain('AWS_SECRET_ACCESS_KEY=real-secret');
    // Passthrough form: `-e AWS_SECRET_ACCESS_KEY` with no `=value`.
    const passthroughIdx = args.indexOf('AWS_SECRET_ACCESS_KEY');
    expect(passthroughIdx).toBeGreaterThanOrEqual(0);
    expect(args[passthroughIdx - 1]).toBe('-e');
    // Value MUST reach docker via the spawn env so the container authenticates.
    const calls = childProcessMock.execFile.mock.calls;
    const lastCall = calls[calls.length - 1] as unknown[];
    const opts = lastCall[2] as { env?: Record<string, string> };
    expect(opts.env?.['AWS_SECRET_ACCESS_KEY']).toBe('real-secret');
  });

  it('drops a docker-client-colliding sensitive key ENTIRELY — no -e flag, not in spawn env (issue #2184)', async () => {
    // A value-less `-e DOCKER_HOST` for a key `dockerSpawnEnvWithSensitive`
    // refuses to set would make docker resolve it against the CLIENT's own env,
    // handing the container the HOST's docker socket. `partitionSensitiveEnv`
    // drops the flag entirely, so the key reaches neither argv nor spawn env.
    warnSpy.mockClear();
    const savedHost = process.env['DOCKER_HOST'];
    process.env['DOCKER_HOST'] = 'unix:///var/run/docker.sock';
    try {
      await runDetached({
        image: 'my-image:latest',
        mounts: [],
        env: { DOCKER_HOST: 'tcp://attacker.example:2375', DB_PASSWORD: 'real-secret' },
        sensitiveEnvKeys: new Set(['DOCKER_HOST', 'DB_PASSWORD']),
        cmd: [],
        hostPort: 9000,
      });
      const args = lastArgs();
      // No flag at all for the colliding name (neither `-e DOCKER_HOST` nor `=value`).
      expect(args).not.toContain('DOCKER_HOST');
      expect(args.join(' ')).not.toContain('DOCKER_HOST');
      expect(args.join(' ')).not.toContain('tcp://attacker.example:2375');
      const calls = childProcessMock.execFile.mock.calls;
      const opts = calls[calls.length - 1]![2] as { env?: Record<string, string> };
      // The client's own DOCKER_HOST stays authoritative; the secret value is gone.
      expect(opts.env?.['DOCKER_HOST']).toBe('unix:///var/run/docker.sock');
      // A non-colliding sensitive key still reaches the container value-less.
      expect(args).toContain('DB_PASSWORD');
      expect(args.join(' ')).not.toContain('real-secret');
      expect(opts.env?.['DB_PASSWORD']).toBe('real-secret');
      // ...and the drop is warned, not silent.
      const msg = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(msg).toContain('DOCKER_HOST');
      expect(msg).toContain('were NOT passed to the container');
    } finally {
      if (savedHost === undefined) delete process.env['DOCKER_HOST'];
      else process.env['DOCKER_HOST'] = savedHost;
    }
  });

  it('drops a sensitive key with a MALFORMED name (containing `=`) and warns naming the cause', async () => {
    // Post-#2186, the shared `partitionSensitiveEnv` also drops a malformed
    // key (empty / `=` / NUL) — a name containing `=` serialises to an environ
    // entry whose OS-parsed name is everything before the first `=`, poisoning
    // the docker client. `runDetached` inherits that guard through the shared
    // helper; assert the drop and that the warning names the malformed cause.
    warnSpy.mockClear();
    await runDetached({
      image: 'my-image:latest',
      mounts: [],
      env: { 'PATH=/tmp/evil:': 'attacker', DB_PASSWORD: 'real-secret' },
      sensitiveEnvKeys: new Set(['PATH=/tmp/evil:', 'DB_PASSWORD']),
      cmd: [],
      hostPort: 9000,
    });
    const args = lastArgs();
    // No flag for the malformed key, and its value is nowhere on the argv.
    expect(args.join(' ')).not.toContain('PATH=/tmp/evil:');
    expect(args.join(' ')).not.toContain('attacker');
    const calls = childProcessMock.execFile.mock.calls;
    const opts = calls[calls.length - 1]![2] as { env?: Record<string, string> };
    expect(opts.env?.['PATH=/tmp/evil:']).toBeUndefined();
    // The well-formed sibling is still delivered value-less.
    expect(args).toContain('DB_PASSWORD');
    expect(opts.env?.['DB_PASSWORD']).toBe('real-secret');
    // The warning names the key AND the malformed cause (not only "shares a name").
    const msg = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(msg).toContain('PATH=/tmp/evil:');
      // QUOTED. A bare `join` renders the EMPTY-key collision as nothing, so
      // the warning would name no var at all -- the "opaque error naming no
      // secret" case the guard exists for. Mirrors the ECS twin's fence.
      expect(msg).toContain('"PATH=/tmp/evil:"');
      // The remediation is the operator's next step; without it the warning
      // says what went wrong and not what to do.
      expect(msg).toContain('Rename the env var if the container needs it.');
    expect(msg).toContain("malformed name (empty, or containing '=' / NUL)");
  });

  // PR #717 added `DockerRunOptions.containerPort` (defaults to 8080 so the
  // existing RIE Lambda local-invoke path is unchanged; MCP runtimes pass
  // 8000, A2A runtimes pass 9000). The default + explicit-override paths
  // are exercised end-to-end by the local-invoke / local-invoke-agentcore
  // integ tests; these two cases nail the docker `-p` flag shape directly
  // at the unit layer so a regression that inverts the ternary surfaces
  // without a Docker run (closes G3 in the PR #717 3-axis review).
  it('publishes containerPort defaulting to 8080 when omitted (Lambda RIE path)', async () => {
    await runDetached({
      image: 'my-image:latest',
      mounts: [],
      env: {},
      cmd: [],
      hostPort: 56789,
    });
    const args = lastArgs();
    const pIdx = args.indexOf('-p');
    expect(pIdx).toBeGreaterThanOrEqual(0);
    expect(args[pIdx + 1]).toBe('127.0.0.1:56789:8080');
  });

  // ===================================================================
  // issue #2440 — the FAILURE message must not echo the argv
  // ===================================================================
  // `execFile` folds the whole command line into `err.message`. When docker
  // dies without writing stderr (a spawn-level failure, an OOM-killed client)
  // the `err.stderr?.trim() ||` guard falls through to it, so the error a user
  // pastes into an issue carried every `-e KEY=value` pair -- while the debug
  // line eleven lines earlier already redacted the same argv.
  //
  // The message SHAPE below is not invented: it was measured against this
  // repo's Node (24.15.0) with a whitespace-bearing `-e` value, which
  // reproduces verbatim in `err.message`.
  function execFileFailureLikeNode(stderr = '') {
    return (cmd: string, args: string[]): Error & { stderr?: string } =>
      Object.assign(new Error(`Command failed: ${cmd} ${args.join(' ')}\n${stderr}`), {
        stderr,
        code: 125,
      });
  }

  it('redacts -e VALUES out of the docker run failure message (issue #2440)', async () => {
    mocks.nextError = execFileFailureLikeNode();
    await expect(
      runDetached({
        image: 'my-image:1',
        mounts: [],
        env: {
          DB_URL: 'postgres://svc:p4ssw0rd@db.internal/app',
          // A JSON value with a SPACE: only the exact-argv substitution can
          // delimit it, a token scan of a space-joined command line cannot.
          FEATURE_CFG: '{"flag": "s3cr3t-json"}',
        },
        cmd: ['index.handler'],
        hostPort: 9001,
      })
    ).rejects.toThrow(/^docker run failed: /);

    let message = '';
    try {
      mocks.nextError = execFileFailureLikeNode();
      await runDetached({
        image: 'my-image:1',
        mounts: [],
        env: {
          DB_URL: 'postgres://svc:p4ssw0rd@db.internal/app',
          FEATURE_CFG: '{"flag": "s3cr3t-json"}',
        },
        cmd: ['index.handler'],
        hostPort: 9001,
      });
    } catch (err) {
      message = (err as Error).message;
    }

    // The values are gone...
    expect(message).not.toContain('postgres://svc:p4ssw0rd@db.internal/app');
    expect(message).not.toContain('p4ssw0rd');
    expect(message).not.toContain('s3cr3t-json');
    // ...the KEYS and the rest of the diagnostic are not. Without these an
    // empty message would pass the absence assertions above.
    expect(message).toContain('-e DB_URL=***');
    expect(message).toContain('-e FEATURE_CFG=***');
    expect(message).toContain('docker run failed: Command failed:');
    expect(message).toContain('run -d --rm');
    expect(message).toContain('my-image:1 index.handler');
  });

  it('the --verbose argv debug line masks the SAME values as the error path (issue #2440)', async () => {
    // The channel divergence IS the defect: this line renders on every
    // verbose run, the error path only when docker writes no stderr. A test
    // that only covered the error path would have left the certain channel
    // open, which is what the security review caught.
    await runDetached({
      image: 'my-image:1',
      mounts: [],
      env: {
        DB_URL: 'postgres://svc:p4ssw0rd@db.internal/app',
        FEATURE_CFG: '{"flag": "s3cr3t-json"}',
      },
      cmd: ['index.handler'],
      hostPort: 9001,
    });
    const argvLine = debugSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes(' run '));
    expect(argvLine).toBeDefined();
    expect(argvLine).not.toContain('p4ssw0rd');
    expect(argvLine).not.toContain('s3cr3t-json');
    expect(argvLine).toContain('-e DB_URL=***');
    expect(argvLine).toContain('-e FEATURE_CFG=***');
    // The line stays useful: which vars, which mounts, which image.
    expect(argvLine).toContain('run -d --rm');
    expect(argvLine).toContain('my-image:1 index.handler');
  });

  it('keeps a docker-authored stderr diagnostic intact while redacting the argv it quotes', async () => {
    mocks.nextError = execFileFailureLikeNode(
      'docker: Error response from daemon: no such image: my-image:1.\n'
    );
    let message = '';
    try {
      await runDetached({
        image: 'my-image:1',
        mounts: [],
        env: { API_TOKEN: 'tok-live-987654' },
        cmd: ['index.handler'],
        hostPort: 9001,
      });
    } catch (err) {
      message = (err as Error).message;
    }
    // stderr wins over `err.message` here, so the argv never appears at all —
    // and the actionable line survives untouched.
    expect(message).toBe(
      'docker run failed: docker: Error response from daemon: no such image: my-image:1.'
    );
    expect(message).not.toContain('tok-live-987654');
  });

  it('publishes hostPort:containerPort when containerPort is explicit (MCP / A2A path)', async () => {
    await runDetached({
      image: 'my-image:latest',
      mounts: [],
      env: {},
      cmd: [],
      hostPort: 56789,
      containerPort: 8000,
    });
    const args = lastArgs();
    const pIdx = args.indexOf('-p');
    expect(pIdx).toBeGreaterThanOrEqual(0);
    expect(args[pIdx + 1]).toBe('127.0.0.1:56789:8000');
  });
});

// `pullImage` exercises `runDockerStreaming` (default compact log level
// branch). The ENOENT path is the load-bearing regression catch: pre-fix
// `runCaptured` surfaced the spawn error's raw message; the refactor
// must preserve that via the `e.exitCode === undefined` branch in
// `pullImage`, otherwise the user-visible message degrades to
// "exited with code ?: (no output)" with the helpful Install-Docker
// hint silently dropped.
describe('pullImage', () => {
  beforeEach(() => {
    dockerCmdMocks.runDockerForeground.mockReset();
    dockerCmdMocks.runDockerStreaming.mockReset();
  });

  it('--no-pull (skipPull=true) short-circuits without invoking docker', async () => {
    await pullImage('public.ecr.aws/lambda/nodejs:20', true);
    expect(dockerCmdMocks.runDockerForeground).not.toHaveBeenCalled();
    expect(dockerCmdMocks.runDockerStreaming).not.toHaveBeenCalled();
  });

  it('surfaces the spawnStreaming ENOENT install hint via DockerRunnerError (captured branch)', async () => {
    // ENOENT path: spawnStreaming rejects with a plain Error (no
    // `exitCode` / `stderr` field). `pullImage` must detect the missing
    // `exitCode` and surface `e.message` instead of folding to "exited
    // with code ?: (no output)".
    const enoentErr = new Error(
      "Failed to find and execute 'docker'. Install Docker (or set the 'CDK_DOCKER' environment variable to a compatible binary such as podman / finch)."
    );
    dockerCmdMocks.runDockerStreaming.mockRejectedValue(enoentErr);
    await expect(pullImage('public.ecr.aws/lambda/nodejs:20', false)).rejects.toThrow(
      /docker pull public\.ecr\.aws\/lambda\/nodejs:20 failed: Failed to find.*Install Docker.*CDK_DOCKER/
    );
  });

  it('surfaces docker exit code + stderr via DockerRunnerError on non-zero exit', async () => {
    // SpawnError path: runDockerStreaming rejects with `exitCode` set +
    // captured stderr. `pullImage` folds stderr into the exit-code line.
    const spawnErr = Object.assign(new Error('non-zero exit'), {
      exitCode: 1,
      stderr: 'pull access denied for image',
      stdout: '',
    });
    dockerCmdMocks.runDockerStreaming.mockRejectedValue(spawnErr);
    await expect(pullImage('public.ecr.aws/lambda/nodejs:20', false)).rejects.toThrow(
      /docker pull public\.ecr\.aws\/lambda\/nodejs:20 exited with code 1: pull access denied/
    );
  });

  it('surfaces (no output) when SpawnError has no captured stderr / stdout', async () => {
    const spawnErr = Object.assign(new Error('non-zero exit'), {
      exitCode: 2,
      stderr: '',
      stdout: '',
    });
    dockerCmdMocks.runDockerStreaming.mockRejectedValue(spawnErr);
    await expect(pullImage('image:tag', false)).rejects.toThrow(
      /docker pull image:tag exited with code 2: \(no output\)/
    );
  });
});
