import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  DOCKER_CLIENT_ENV_KEYS,
  DOCKER_CLIENT_ENV_PREFIXES,
  dockerSpawnEnvWithSensitive,
  isDockerClientEnvKey,
  isMalformedEnvKey,
  partitionSensitiveEnv,
  formatDockerLoginError,
  getDockerCmd,
  runDockerStreaming,
  spawnForeground,
  spawnStreaming,
} from '../../../src/utils/docker-cmd.js';
import { SENSITIVE_ENV_KEYS } from '../../../src/local/docker-runner.js';

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
      const env = dockerSpawnEnvWithSensitive({
        docker_host: 'tcp://attacker.example:2375',
        CONTROL_SECRET: 'arrived',
      });
      // A lowercase collision must not define the client's DOCKER_HOST in any case.
      expect(env['docker_host']).toBeUndefined();
      expect(env['DOCKER_HOST']).toBeUndefined();
      // Positive control: without this the assertions above also pass when the
      // passthrough is broken outright (e.g. the helper returning `{}`).
      expect(env['CONTROL_SECRET']).toBe('arrived');
    } finally {
      if (savedHost !== undefined) process.env['DOCKER_HOST'] = savedHost;
    }
  });

  // The expected membership is spelled out as LITERALS, deliberately not
  // derived from DOCKER_CLIENT_ENV_KEYS. Driving `it.each` off the set itself
  // cannot detect a deletion — removing an entry just stops generating that
  // case, and the suite stays green (verified by mutation probe: deleting
  // 'HTTP_PROXY' left a set-driven table 53/53 passing).
  const EXPECTED_CLIENT_ENV_KEYS = [
    'PATH',
    'PATHEXT',
    'HOME',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'DOCKER_CONFIG',
    'DOCKER_CERT_PATH',
    'DOCKER_TLS',
    'DOCKER_TLS_VERIFY',
    'DOCKER_API_VERSION',
    'DOCKER_DEFAULT_PLATFORM',
    'DOCKER_CUSTOM_HEADERS',
    'DOCKER_CONTENT_TRUST',
    'DOCKER_CONTENT_TRUST_SERVER',
    'DOCKER_HIDE_LEGACY_COMMANDS',
    'BUILDKIT_PROGRESS',
    // Only the upper-case proxy spellings are members — matching is
    // case-insensitive, so the former lower-case duplicates were unreachable.
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'FTP_PROXY',
    'ALL_PROXY',
    'DOCKER_AUTH_CONFIG',
    // The prefixed families (`LD_*` / `DYLD_*` loader) are matched by PREFIX in
    // `isDockerClientEnvKey`, not enumerated in DOCKER_CLIENT_ENV_KEYS, so they
    // are deliberately absent from this exact-membership list — the prefix
    // cases below cover them. The non-prefixed loader vars are set members.
    'GLIBC_TUNABLES',
    'GCONV_PATH',
    'BASH_ENV',
    // SSH is an EXACT enumeration, not a prefix (#2186 review round 3): the
    // client-side exec/trust set is closed, and an `SSH_` prefix broke
    // realistic secrets like GitLab CI's `SSH_PRIVATE_KEY`.
    'SSH_AUTH_SOCK',
    'SSH_ASKPASS',
    'SSH_ASKPASS_REQUIRE',
    'SSH_SK_HELPER',
    'SSH_SK_PROVIDER',
    'SSH_PKCS11_HELPER',
    'SSH_AGENT_PID',
    // The AWS credential-helper family (#2186 review round 3): the client execs
    // `docker-credential-ecr-login`, whose SDK reads these with the OPERATOR's
    // real credentials in scope.
    'AWS_ENDPOINT_URL',
    'AWS_CA_BUNDLE',
    'AWS_PROFILE',
    'AWS_CONFIG_FILE',
    'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    'AWS_ROLE_ARN',
    'AWS_EC2_METADATA_SERVICE_ENDPOINT',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'GODEBUG',
  ];

  it('keeps SENSITIVE_ENV_KEYS disjoint from the docker-client denylist (case-insensitive)', () => {
    // The ECS sidecar (ecs-network.ts) partitions its fixed credential set and
    // warns on any collision, but a collision there is expected to be dead code:
    // this invariant is what makes that so. Fence it here so adding a
    // docker-client-named key to EITHER set fails loudly rather than quietly
    // dropping the sidecar credential (issue #2183 review). Case-insensitive
    // because production collision detection is (Windows env lookups).
    expect([...SENSITIVE_ENV_KEYS].filter(isDockerClientEnvKey)).toEqual([]);
  });

  it('fences exactly the documented docker-client vars — no silent removals', () => {
    // This is the assertion that a DELETION trips. Adding a key trips it too,
    // which is intended: widening the denylist should be a deliberate edit in
    // two places, not a drive-by.
    expect([...DOCKER_CLIENT_ENV_KEYS].sort()).toEqual([...EXPECTED_CLIENT_ENV_KEYS].sort());
  });

  it.each(EXPECTED_CLIENT_ENV_KEYS)(
    'never lets a secret named %s reach the docker client env',
    (key) => {
      // Behaviour half: every listed key must actually be refused. Before
      // this, only DOCKER_HOST / PATH / DOCKER_CONTEXT discriminated and the
      // rest of the then-28-entry set was decorative. Asserting the HOST value
      // is preserved (rather than `not 'evil'`) is both stronger and immune to
      // a host env that legitimately holds the probe literal (Codex review).
      expect(dockerSpawnEnvWithSensitive({ [key]: 'evil' })[key]).toBe(process.env[key]);
      expect(partitionSensitiveEnv({ [key]: 'evil' }, new Set([key])).flags).toEqual([]);
    }
  );

  // The prefixed families are matched by PREFIX, so an UNLISTED member — one no
  // release-specific enumeration would carry — is still refused. This is the
  // structural half of finding (1): a named list is always one release behind
  // (a new `LD_*` / `DYLD_*` loader var). SSH is deliberately NOT here any
  // more — it is an exact enumeration (covered by the membership table above),
  // with a lowercase spelling exercised below.
  it.each([
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'LD_AUDIT',
    'DYLD_INSERT_LIBRARIES',
    'DYLD_ROOT_PATH', // unlisted — caught only by the DYLD_ prefix
    'DYLD_IMAGE_SUFFIX', // unlisted
    'dyld_root_path', // lowercase, since detection is case-insensitive
    'ld_preload',
    'ssh_askpass', // lowercase spelling of an EXACT ssh entry (case-insensitive)
    'AWS_ENDPOINT_URL_ECR', // per-service endpoint form aws-sdk-go-v2 honours
    'AWS_ENDPOINT_URL_STS', // worse still: redirects where the OIDC token is posted
    'aws_endpoint_url_ecr', // lowercase
  ])('treats prefixed client var %s as a docker-client var and drops it', (key) => {
    expect(isDockerClientEnvKey(key)).toBe(true);
    expect(dockerSpawnEnvWithSensitive({ [key]: 'evil' })[key]).toBe(process.env[key]);
    expect(partitionSensitiveEnv({ [key]: 'evil' }, new Set([key])).flags).toEqual([]);
  });

  it('fences exactly the documented prefix families — no silent removals or additions', () => {
    // The prefix table is fenced as LITERALS for the same reason the exact
    // membership table is: a deletion (or a drive-by widening) must be a
    // deliberate two-place edit. This is also what makes the anti-shadowing
    // fence below TWO-directional (#2186 round 4 finding 2): iterating a
    // hardcoded copy caught a new exact entry under an existing prefix but not
    // a new prefix swallowing existing exact entries.
    expect([...DOCKER_CLIENT_ENV_PREFIXES].sort()).toEqual(
      ['LD_', 'DYLD_', 'AWS_ENDPOINT_URL_'].sort()
    );
  });

  it('no exact denylist entry is shadowed by a prefix family', () => {
    // If an exact entry starts with a listed prefix, its behavioural `it.each`
    // case above goes vacuous (the prefix would catch it even after the exact
    // entry is deleted) and only the literal-membership test discriminates.
    // Keep the two mechanisms disjoint — iterating the REAL prefix const so a
    // newly added prefix that swallows existing exact entries (e.g. 'SSL_')
    // fails here too, not only a new exact entry under an existing prefix.
    for (const key of DOCKER_CLIENT_ENV_KEYS) {
      for (const prefix of DOCKER_CLIENT_ENV_PREFIXES) {
        expect(key.toUpperCase().startsWith(prefix)).toBe(false);
      }
    }
  });

  it("refuses a sensitive key containing '=' — the environ NAME differs from the checked key (#2186 round 4)", () => {
    // Node serialises env as `key=value`, so a secret named `PATH=/tmp/evil:`
    // produces the environ entry `PATH=/tmp/evil:=<secret>` whose OS-parsed
    // NAME is `PATH` — a denylist member the whole-key check cannot see. The
    // poisoned duplicate WINS (measured), and the docker CLI execs
    // `docker-credential-*` helpers off PATH: code execution as the operator.
    const key = 'PATH=/tmp/evil:';
    const { flags, sensitiveEnv, collisions } = partitionSensitiveEnv(
      { [key]: 'evil' },
      new Set([key])
    );
    expect(collisions).toEqual([key]);
    expect(flags).toEqual([]);
    expect(sensitiveEnv[key]).toBeUndefined();
    // Belt-and-braces: the exported spawn-env builder refuses the raw key even
    // when handed one directly (#2187 is set to route runDetached through it).
    const env = dockerSpawnEnvWithSensitive({ [key]: 'evil', CONTROL_SECRET: 'arrived' });
    expect(env[key]).toBeUndefined();
    expect(env['PATH']).toBe(process.env['PATH']);
    expect(env['CONTROL_SECRET']).toBe('arrived');
    // An innocuous spelling is refused too — no valid POSIX env name carries
    // '=', so nothing legitimate is lost by failing closed.
    expect(
      partitionSensitiveEnv({ 'FOO=BAR': 'v' }, new Set(['FOO=BAR'])).collisions
    ).toEqual(['FOO=BAR']);
  });

  it('refuses a malformed sensitive key defined by the positive good-shape rule (#2186 round 5)', () => {
    // The good shape is "non-empty, no `=`, no NUL"; every complement takes the
    // fail-closed collision path in ONE predicate rather than being closed one
    // spelling at a time. The empty key would emit `-e ''` (docker rejects it
    // with an opaque error naming no secret); a NUL-bearing key makes Node
    // refuse to spawn at all (ERR_INVALID_ARG_VALUE) rather than truncating.
    for (const key of ['', 'FOO\0BAR', 'A=B', 'PATH=x:']) {
      expect(isMalformedEnvKey(key)).toBe(true);
      const { flags, sensitiveEnv, collisions } = partitionSensitiveEnv(
        { [key]: 'v' },
        new Set([key])
      );
      expect(collisions).toEqual([key]);
      expect(flags).toEqual([]);
      expect(sensitiveEnv[key]).toBeUndefined();
      expect(dockerSpawnEnvWithSensitive({ [key]: 'v' })[key]).toBeUndefined();
    }
    // A well-formed name is delivered — the rule refuses only the bad shapes.
    expect(isMalformedEnvKey('MY_SECRET')).toBe(false);
    const ok = partitionSensitiveEnv({ MY_SECRET: 'v' }, new Set(['MY_SECRET']));
    expect(ok.flags).toEqual(['-e', 'MY_SECRET']);
    expect(ok.sensitiveEnv['MY_SECRET']).toBe('v');
    expect(ok.collisions).toEqual([]);
  });

  // OVER-refusal is the direction the positive rule newly makes possible, and
  // the direction the old `||`-ed bad-shape clauses structurally could not fail
  // in. Asserting one all-caps good name (`MY_SECRET` above) does not cover it:
  // a tightened rule such as `/^[A-Z_][A-Z0-9_]*$/` silently fail-closed-drops
  // every lowercase / dotted / hyphenated secret name and leaves the whole
  // suite green (measured). These names are all legal ECS secret names.
  it.each([
    'my_secret',
    'db.password',
    'my-secret',
    'Mixed_Case',
    'SECRET1',
    '1LEADING_DIGIT',
    'trailing_underscore_',
    'ssh_private_key', // lowercase twin of a delivered SSH_* name
  ])('delivers the well-formed name %s rather than refusing it', (key) => {
    expect(isMalformedEnvKey(key)).toBe(false);
    const { flags, sensitiveEnv, collisions } = partitionSensitiveEnv(
      { [key]: 'v' },
      new Set([key])
    );
    expect(collisions).toEqual([]);
    expect(flags).toEqual(['-e', key]);
    expect(sensitiveEnv[key]).toBe('v');
    expect(dockerSpawnEnvWithSensitive({ [key]: 'v' })[key]).toBe('v');
  });

  it.each([
    'SSH_PRIVATE_KEY', // GitLab CI's canonical deploy-key spelling
    'SSH_KEY',
    'SSH_PASSPHRASE',
    'SSH_DEPLOY_KEY',
    'SSH_CONNECTION', // sshd-SET, never client-read
  ])('delivers the realistic ssh-named secret %s to the container (#2186 blocker)', (key) => {
    // The SSH_ prefix rule broke these on this branch while they work on main.
    // Assert DELIVERY, not just the predicate: the value-less `-e KEY` flag is
    // emitted and the value travels through the spawn env.
    expect(isDockerClientEnvKey(key)).toBe(false);
    const { flags, sensitiveEnv, collisions } = partitionSensitiveEnv(
      { [key]: 'deploy-key-material' },
      new Set([key])
    );
    expect(flags).toEqual(['-e', key]);
    expect(sensitiveEnv[key]).toBe('deploy-key-material');
    expect(collisions).toEqual([]);
    expect(dockerSpawnEnvWithSensitive({ [key]: 'deploy-key-material' })[key]).toBe(
      'deploy-key-material'
    );
  });

  it('does not treat a name that merely contains a prefix as a client var', () => {
    // The prefix is anchored at the START — `PAYLOAD_KEY` / `MY_LD_THING` /
    // `MY_SSH_KEY` are ordinary secrets and must still be delivered, and a
    // prefix without its underscore (`DYLDISH` / `SSHFOO`) is not a match.
    // Assert DELIVERY for the near-misses too, not only the predicate.
    // `AWS_ENDPOINT_URLX` lacks the prefix's trailing underscore and is not the
    // exact entry either.
    for (const key of [
      'PAYLOAD_KEY',
      'MY_LD_THING',
      'MY_SSH_KEY',
      'DYLDISH',
      'SSHFOO',
      'AWS_ENDPOINT_URLX',
    ]) {
      expect(isDockerClientEnvKey(key)).toBe(false);
      const { flags, sensitiveEnv } = partitionSensitiveEnv({ [key]: 'v' }, new Set([key]));
      expect(flags).toEqual(['-e', key]);
      expect(sensitiveEnv[key]).toBe('v');
    }
  });

  it('reports a colliding name case-insensitively and emits NO -e flag for it', () => {
    const { flags, sensitiveEnv, collisions } = partitionSensitiveEnv(
      { docker_host: 'x', MY_SECRET: 'y', PATH: 'z', PLAIN: 'p' },
      new Set(['docker_host', 'MY_SECRET', 'PATH'])
    );
    expect(collisions.sort()).toEqual(['PATH', 'docker_host']);
    // The colliding keys must appear on NEITHER side. Emitting `-e PATH` while
    // dockerSpawnEnvWithSensitive refuses to set it would make docker resolve
    // the flag against the CLIENT's env, handing the container the HOST's
    // value (issue #2183).
    expect(flags).not.toContain('PATH');
    expect(flags).not.toContain('docker_host');
    expect(sensitiveEnv['PATH']).toBeUndefined();
    expect(sensitiveEnv['docker_host']).toBeUndefined();
    // ...while the ordinary sensitive key is still value-less on argv with its
    // value carried in sensitiveEnv, and a non-sensitive key is unchanged.
    expect(flags).toContain('MY_SECRET');
    expect(flags.join(' ')).not.toContain('MY_SECRET=y');
    expect(sensitiveEnv['MY_SECRET']).toBe('y');
    expect(flags.join(' ')).toContain('PLAIN=p');
  });

  it('reports no collision for an ordinary secret set', () => {
    expect(partitionSensitiveEnv({ ONLY_SAFE: 'v' }, new Set(['ONLY_SAFE'])).collisions).toEqual(
      []
    );
  });

  it('drops a docker-client var the host never set, even if a secret defines it', () => {
    const saved = process.env['DOCKER_CONTEXT'];
    delete process.env['DOCKER_CONTEXT'];
    try {
      const env = dockerSpawnEnvWithSensitive({
        DOCKER_CONTEXT: 'evil-context',
        CONTROL_SECRET: 'arrived',
      });
      expect(env['DOCKER_CONTEXT']).toBeUndefined();
      expect(env['CONTROL_SECRET']).toBe('arrived');
    } finally {
      if (saved !== undefined) process.env['DOCKER_CONTEXT'] = saved;
    }
  });
});
