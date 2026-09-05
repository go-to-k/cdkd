import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  DOCKER_CLIENT_ENV_KEYS,
  DOCKER_CLIENT_ENV_PREFIXES,
  dockerSpawnEnvWithSensitive,
  isDockerClientEnvKey,
  isMalformedEnvKey,
  describeDockerCapturedOutput,
  describeDockerExecFailure,
  describeDockerFailure,
  partitionSensitiveEnv,
  redactDockerArgvInText,
  redactDockerArgvValues,
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
    // Beyond [A-Za-z0-9_.-]: a rule tightened to `/^[\w.-]+$/` drops all of
    // these and left the suite green before they were listed. A Linux environ
    // NAME may hold any byte except `=` and NUL, and the JSDoc explicitly
    // promises the newline case -- which had no test behind it.
    'MY SECRET',
    'SECRET+PLUS',
    'SECRET:COLON',
    'SECRET@AT',
    'SECRET%PCT',
    'パスワード',
    'SECRET\nTRAILING_NEWLINE',
    // Every row above happens to start and end with a non-whitespace,
    // non-dash character and to be at least 2 chars long, so tightenings that
    // forbid outer whitespace, a leading dash, or a 1-char name all passed
    // with the suite green. Note the row above puts its newline INTERNALLY --
    // it does not exercise the anchor claim in WELL_FORMED_ENV_KEY's JSDoc,
    // which is only discriminated by a name ENDING in a newline.
    ' LEADING_SPACE',
    'TRAILING_SPACE ',
    'TRAILING_NEWLINE\n',
    '-DASH_LEADING',
    'X',
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

// =====================================================================
// issue #2440 — argv redaction for USER-VISIBLE error text
// =====================================================================
// `execFile` folds the WHOLE command line into `err.message`, so a docker
// failure with no stderr echoes every `-e KEY=value` pair back at the user.
// The MESSAGE SHAPE these fixtures encode was measured live on this repo's
// Node (24.15.0):
//   `Command failed: <file> <args.join(' ')>\n<stderr>`
// -- with a value containing whitespace (`-e CFG={"a": 1}`) reproduced
// verbatim, which is why the exact-substitution pass exists.
describe('redactDockerArgvValues', () => {
  it('masks the VALUE of -e / --env / --opt / --label and keeps the KEY', () => {
    expect(
      redactDockerArgvValues([
        'run',
        '-e',
        'DB_URL=postgres://u:pw@h/db',
        '--env',
        'API_TOKEN=t0ps3cret',
        '--opt',
        'o=addr=fs,password=hunter2',
        '--label',
        'owner=alice',
        'img',
      ])
    ).toEqual([
      'run',
      '-e',
      'DB_URL=***',
      '--env',
      'API_TOKEN=***',
      '--opt',
      'o=***',
      '--label',
      'owner=***',
      'img',
    ]);
  });

  it('masks an EMPTY key (`-e =value`) — a non-sensitive `` key reaches the argv verbatim', () => {
    // `partitionSensitiveEnv` fail-closes a malformed key only on its
    // SENSITIVE branch, so `{ Name: '', Value: <secret> }` in an ECS
    // `Environment` (or a `--env-vars` override) is emitted as `-e =<secret>`.
    // A `> 0` guard on the `=` index walks straight past it.
    expect(redactDockerArgvValues(['run', '-e', '=hunter2-empty-key', 'img'])).toEqual([
      'run',
      '-e',
      '=***',
      'img',
    ]);
  });

  it('leaves a value-less `-e KEY` alone (the form partitionSensitiveEnv emits)', () => {
    const args = ['run', '-e', 'AWS_SECRET_ACCESS_KEY', '-e', 'PLAIN=v', 'img'];
    expect(redactDockerArgvValues(args)).toEqual([
      'run',
      '-e',
      'AWS_SECRET_ACCESS_KEY',
      '-e',
      'PLAIN=***',
      'img',
    ]);
  });

  it('does not mutate the input array and tolerates a trailing bare flag', () => {
    const args = ['run', '-e', 'K=v'];
    const copy = [...args];
    redactDockerArgvValues(args);
    expect(args).toEqual(copy);
    expect(redactDockerArgvValues(['-e'])).toEqual(['-e']);
    expect(redactDockerArgvValues([])).toEqual([]);
  });

  it('leaves a non-value-bearing flag alone — a container id / image / CIDR is the diagnostic', () => {
    const args = ['network', 'create', '--subnet', '169.254.170.0/24', 'cdkd-local-task-x'];
    expect(redactDockerArgvValues(args)).toEqual(args);
  });
});

describe('redactDockerArgvInText', () => {
  const args = [
    'run',
    '-d',
    '--rm',
    '-e',
    'DB_URL=postgres://u:pw@h/db',
    '-e',
    'CFG={"k": "s3cr3t-json"}',
    'my-image:1',
    'handler',
  ];
  const message = `Command failed: docker ${args.join(' ')}\n`;

  it('masks a value CONTAINING WHITESPACE — only the exact-argv pass can delimit it', () => {
    const out = redactDockerArgvInText(message, args);
    expect(out).not.toContain('s3cr3t-json');
    expect(out).not.toContain('postgres://u:pw@h/db');
    expect(out).toContain('-e CFG=***');
    expect(out).toContain('-e DB_URL=***');
    // The surrounding diagnostic survives — an assertion that only checked
    // for ABSENCE would pass against an empty string.
    expect(out).toContain('Command failed: docker run -d --rm');
    expect(out).toContain('my-image:1 handler');
  });

  it('masks a whitespace-free value with NO argv in hand (token-scan pass)', () => {
    const out = redactDockerArgvInText(message);
    expect(out).not.toContain('postgres://u:pw@h/db');
    expect(out).toContain('-e DB_URL=***');
    expect(out).toContain('Command failed: docker run -d --rm');
  });

  it('is keyed on the FLAG position, not on the value — a coinciding literal survives', () => {
    // `hunter2` is the secret AND, by coincidence, a container name in the
    // stderr. Value-based redaction would blank both.
    const argv = ['run', '-e', 'PW=hunter2', 'img'];
    const text = `Command failed: docker ${argv.join(' ')}\nError: container "hunter2" already exists`;
    const out = redactDockerArgvInText(text, argv);
    expect(out).toContain('-e PW=***');
    expect(out).toContain('container "hunter2" already exists');
  });

  it('does not match a flag that merely STARTS with -e / --env', () => {
    const text = 'docker: unknown flag --environment FOO=bar (did you mean -easy?)';
    expect(redactDockerArgvInText(text)).toBe(text);
  });

  it('masks an EMPTY key in TEXT too, on both passes', () => {
    const argv = ['run', '--rm', '-e', '=hunter2-empty-key', 'img'];
    const text = `Command failed: docker ${argv.join(' ')}\ndocker: invalid argument "=hunter2-empty-key"`;
    // With the argv in hand (pass 1)...
    const withArgs = redactDockerArgvInText(text, argv);
    expect(withArgs).toContain('-e =***');
    // ...and without it (pass 2). The stderr echo of the same token is
    // whitespace-free, so the token scan reaches it as well.
    const withoutArgs = redactDockerArgvInText(text);
    expect(withoutArgs).toContain('-e =***');
    expect(withoutArgs).not.toContain('-e =hunter2-empty-key');
  });

  it('token-scan-only leaves the TAIL of a whitespace value — the documented bound on pass 2', () => {
    // Pinning the limitation, not endorsing it: a space-joined command line
    // gives the scan no way to know where a value ends, which is exactly why
    // pass 1 exists. If this ever stops holding, pass 2 grew a delimiter and
    // the two-pass rationale needs re-reading.
    const out = redactDockerArgvInText(message);
    expect(out).toContain('-e CFG=***');
    expect(out).toContain('"s3cr3t-json"}');
    // ...and with the argv in hand the tail is gone.
    expect(redactDockerArgvInText(message, args)).not.toContain('s3cr3t-json');
  });

  it('leaves a value-less `-e KEY` intact in TEXT — the sensitive form must stay readable', () => {
    // The ONLY assertion pinning this for the TEXT redactor. It used to live
    // in `ecs-network.test.ts` as `toContain('-e AWS_SECRET_ACCESS_KEY')`,
    // which was removed for being a confluence point (the redacted form
    // `-e AWS_SECRET_ACCESS_KEY=***` contains that substring too) — and the
    // property it happened to be pinning went with it. It is exactly what the
    // `[^\s=]+` -> `[^\s=]*` widening could have broken.
    const argv = ['run', '-e', 'AWS_SECRET_ACCESS_KEY', '-e', 'PLAIN=v', 'img'];
    const text = `Command failed: docker ${argv.join(' ')}\n`;
    for (const out of [redactDockerArgvInText(text, argv), redactDockerArgvInText(text)]) {
      expect(out).toContain('-e AWS_SECRET_ACCESS_KEY -e PLAIN=***');
      expect(out).not.toContain('AWS_SECRET_ACCESS_KEY=');
    }
  });

  // Node refuses to spawn when any argv element contains a NUL, and the
  // TypeError quotes ONE element rather than the command line: neither the
  // joined-argv pass nor the `-e ` token scan can see it.
  //
  // The fixture text below is TRANSCRIBED FROM A REAL REJECTION (Node
  // 24.19.0, `execFileAsync('/bin/echo', argv)`), not built by interpolating
  // the argv element. That distinction is the bug this pair exists for: the
  // first cut built it by interpolation, so it carried a RAW NUL, while Node
  // emits the ESCAPED `\x00` -- the needle never matched and the test passed
  // against a live leak, because code and fixture shared the same wrong
  // premise about what Node writes.
  it.each([
    [
      'a NUL in the VALUE',
      ['run', '--rm', '-e', 'K=abc\u0000SUPERSECRET', 'img'],
      "The argument 'args[3]' must be a string without null bytes. " +
        String.raw`Received 'K=abc\x00SUPERSECRET'`,
      'SUPERSECRET',
      // The NUL is INSIDE the masked value, so the whole tail goes.
      String.raw`Received 'K=***'`,
    ],
    [
      // The realistic shape: a NUL rarely travels alone. Node uses a SHORT
      // escape for LF, so a hand-rolled `\xNN` table missed this entirely.
      'a NEWLINE alongside the NUL',
      ['run', '-e', 'K=a\u000ab\u0000SUPERSECRET', 'img'],
      "The argument 'args[2]' must be a string without null bytes. " +
        String.raw`Received 'K=a\nb\x00SUPERSECRET'`,
      'SUPERSECRET',
      String.raw`Received 'K=***'`,
    ],
    [
      // Node escapes a backslash; the hand-rolled table did not touch it.
      'a BACKSLASH alongside the NUL',
      ['run', '-e', 'K=a\u005cb\u0000SUPERSECRET', 'img'],
      "The argument 'args[2]' must be a string without null bytes. " +
        String.raw`Received 'K=a\\b\x00SUPERSECRET'`,
      'SUPERSECRET',
      String.raw`Received 'K=***'`,
    ],
    [
      'a NUL in the KEY',
      ['run', '-e', 'K\u0000X=SECRET2', 'img'],
      "The argument 'args[2]' must be a string without null bytes. " +
        String.raw`Received 'K\x00X=SECRET2'`,
      'SECRET2',
      String.raw`Received 'K\x00X=***'`,
    ],
  ])(
    'masks a value quoted as a SINGLE escaped argv element -- %s (pass 1b)',
    (_name, argv, text, secret, expected) => {
      const out = redactDockerArgvInText(text as string, argv as string[]);
      expect(out).not.toContain(secret as string);
      expect(out).toContain(expected as string);
      // The diagnostic half survives: an absence-only assertion would pass
      // against an empty string.
      expect(out).toContain('must be a string without null bytes.');
    }
  );

  it('does NOT substitute a token whose value is too short to be worth a substring match', () => {
    // `{ Name: '', Value: '1' }` is non-sensitive, so `partitionSensitiveEnv`
    // emits the two-character token `=1`. Substituting that everywhere would
    // rewrite every `=1` in the message -- `--cpus=1`, `status=1`, a path
    // segment -- destroying the diagnostic to hide one character.
    const argv = ['run', '-e', '=1', 'img'];
    const text = 'docker: invalid --cpus=1; container exited status=1 at /var/lib/x=1/y';
    expect(redactDockerArgvInText(text, argv)).toBe(text);
  });

  it('is idempotent — a double wrap re-masks to itself', () => {
    const once = redactDockerArgvInText(message, args);
    expect(redactDockerArgvInText(once, args)).toBe(once);
  });

  it('leaves text with no argv-borne value untouched', () => {
    const text = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.';
    expect(redactDockerArgvInText(text, ['version', '--format', '{{.Server.Version}}'])).toBe(text);
  });
});

describe('describeDockerExecFailure', () => {
  // The structural half of issue #2440's answer: `args` is REQUIRED, so a
  // caller cannot get the text without handing over the argv to redact with.
  const args = ['run', '-e', 'TOKEN=live-abc123', 'img'];

  it('appends the captured stderr to the message, both redacted', () => {
    const err = Object.assign(new Error(`Command failed: docker ${args.join(' ')}`), {
      stderr: '  docker: no such image: img.\n',
    });
    const out = describeDockerExecFailure(err, args);
    expect(out).not.toContain('live-abc123');
    expect(out).toContain('-e TOKEN=***');
    // APPEND, not prefer: the exit status AND the diagnostic both survive.
    expect(out).toContain('Command failed: docker run');
    expect(out).toContain('docker: no such image: img.');
  });

  it('accepts a Buffer stderr (the encoding: buffer shape) and still redacts', () => {
    const err = Object.assign(new Error(`Command failed: docker ${args.join(' ')}`), {
      stderr: Buffer.from('  boom: -e TOKEN=live-abc123 rejected\n', 'utf-8'),
    });
    const out = describeDockerExecFailure(err, args);
    expect(out).not.toContain('live-abc123');
    expect(out).toContain('boom: -e TOKEN=*** rejected');
  });

  it('falls back to the message alone when no stderr was captured', () => {
    const err = Object.assign(new Error(`Command failed: docker ${args.join(' ')}`), {
      stderr: '',
    });
    const out = describeDockerExecFailure(err, args);
    expect(out).toBe('Command failed: docker run -e TOKEN=*** img');
  });

  it('stringifies a non-Error rejection rather than throwing', () => {
    expect(describeDockerExecFailure('plain string', args)).toBe('plain string');
  });

  it('REDACTS a non-Error rejection — the branch whose fail-open a mutant survived', () => {
    // `expect(...).toBe('plain string')` above passes whether or not the
    // branch redacts, because that fixture carries no argv. This one does.
    const thrown = `boom: docker ${args.join(' ')}`;
    const out = describeDockerExecFailure(thrown, args);
    expect(out).not.toContain('live-abc123');
    expect(out).toContain('-e TOKEN=***');
    expect(out).toContain('boom: docker run');
  });

  it('reads a Uint8Array stderr, not only a Buffer', () => {
    // `instanceof Buffer` silently drops a plain Uint8Array, losing the whole
    // diagnostic — a mutant of `ArrayBuffer.isView` survived without this.
    const err = Object.assign(new Error('Command failed'), {
      stderr: new Uint8Array(Buffer.from('boom -e TOKEN=live-abc123 rejected\n', 'utf-8')),
    });
    const out = describeDockerExecFailure(err, args);
    expect(out).toContain('boom -e TOKEN=*** rejected');
    expect(out).not.toContain('live-abc123');
  });
});

describe('describeDockerFailure', () => {
  // The STANDARD composer. Its `args` parameter being REQUIRED is what makes
  // redaction unskippable at a call site — the guarantee issue #2440 settled
  // on after three review rounds showed a text fence over hand-composed sites
  // is evadable.
  const args = ['run', '-e', 'DB_URL=postgres://svc:p4ssw0rd@h/db', 'img'];

  it('prefers the captured stderr, redacted', () => {
    const err = Object.assign(new Error(`Command failed: docker ${args.join(' ')}`), {
      stderr: '  docker: daemon rejected -e DB_URL=postgres://svc:p4ssw0rd@h/db\n',
    });
    const out = describeDockerFailure(err, args);
    expect(out).not.toContain('p4ssw0rd');
    expect(out).toContain('-e DB_URL=***');
    expect(out).toContain('docker: daemon rejected');
  });

  it('falls back to the message — the argv-bearing half — and redacts it', () => {
    const err = Object.assign(new Error(`Command failed: docker ${args.join(' ')}`), {
      stderr: '',
    });
    expect(describeDockerFailure(err, args)).toBe('Command failed: docker run -e DB_URL=*** img');
  });

  it('reads a PLAIN OBJECT rejection — the shape most call sites actually throw', () => {
    // The call sites duck-type `{ stderr, message }`. An earlier revision
    // narrowed the reader to `Error` and wrapped a non-Error in a FRESH
    // `Error`, which has no `.stderr` — so this shape silently degraded to
    // `'[object Object]'`, losing the whole diagnostic.
    const thrown = { stderr: '  boom -e DB_URL=postgres://svc:p4ssw0rd@h/db\n', message: 'ignored' };
    const out = describeDockerFailure(thrown, args);
    expect(out).toBe('boom -e DB_URL=***');
    expect(out).not.toContain('p4ssw0rd');
    expect(out).not.toContain('[object Object]');
  });

  it('falls back to a plain object\'s message when it has no stderr', () => {
    const out = describeDockerFailure({ message: `Command failed: docker ${args.join(' ')}` }, args);
    expect(out).toBe('Command failed: docker run -e DB_URL=*** img');
  });

  it('redacts a NON-Error rejection too — the branch a refactor once left fail-open', () => {
    const out = describeDockerFailure(`boom while running docker ${args.join(' ')}`, args);
    expect(out).not.toContain('p4ssw0rd');
    expect(out).toContain('-e DB_URL=***');
    expect(out).toContain('boom while running docker run');
  });
});

describe('describeDockerCapturedOutput', () => {
  const args = ['pull', 'my-image:1'];

  it('prefers stderr, then stdout, then the caller fallback — all redacted', () => {
    expect(
      describeDockerCapturedOutput({ stderr: '  boom -e K=s3cretvalue \n' }, args, '(no output)')
    ).toBe('boom -e K=***');
    expect(
      describeDockerCapturedOutput(
        { stderr: '  ', stdout: ' pulled -e K=s3cretvalue ' },
        args,
        '(no output)'
      )
    ).toBe('pulled -e K=***');
    expect(describeDockerCapturedOutput({}, args, '(no output)')).toBe('(no output)');
  });

  it('prefers stderr when BOTH streams are non-empty — the precedence, pinned', () => {
    // With only one stream populated per fixture, swapping the precedence is
    // unobservable and a mutant survives.
    expect(
      describeDockerCapturedOutput(
        { stderr: 'from-stderr', stdout: 'from-stdout' },
        args,
        '(no output)'
      )
    ).toBe('from-stderr');
  });

  it('reads a Uint8Array stream too', () => {
    expect(
      describeDockerCapturedOutput(
        { stdout: new Uint8Array(Buffer.from(' pulled ', 'utf-8')) },
        args,
        '(no output)'
      )
    ).toBe('pulled');
  });

  it('does not throw on a rejection whose String() throws', () => {
    // Two call sites are inside `cleanupEcsRun`, where an exception aborts the
    // remaining volume / network teardown and leaks real Docker resources.
    const hostile = Object.create(null) as object;
    expect(() => describeDockerFailure(hostile, args)).not.toThrow();
    expect(describeDockerFailure(hostile, args)).toContain('unstringifiable');
  });
});

// =====================================================================
// LIVE probe of the spawn-refusal path (issue #2440)
// =====================================================================
// Every other case here encodes a message shape I BELIEVED Node produces,
// and twice that belief was wrong in a way the fixture could not reveal:
// first the raw-vs-escaped NUL, then truncation and chunk-splitting of a long
// value. This block asks NODE for the message instead, so the premise cannot
// drift away from reality. It spawns `/bin/echo`, which is refused before the
// child exists — no docker, no AWS, no network, microseconds.
const execFileAsync = promisify(execFile);
const NUL = String.fromCharCode(0);
const LIVE_SECRET = 'postgres://svc:P4SSW0RD@db.internal/app';

async function realNodeRejection(value: string): Promise<string> {
  try {
    await execFileAsync('/bin/echo', ['run', '-e', value, 'img']);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected /bin/echo to be refused; the premise of this block is gone');
}

describe.skipIf(process.platform === 'win32')(
  'spawn refusal, against a REAL Node rejection',
  () => {
    it.each([
      ['short value', 'DB_URL=' + LIVE_SECRET + NUL + 'tail'],
      // TRUNCATION: Node caps the message near 200 chars, so a long value is
      // quoted as a PREFIX and no whole-token needle can match.
      ['1 KB value, secret first', 'DB_URL=' + LIVE_SECRET + 'x'.repeat(1024) + NUL + 'tail'],
      ['200 KB value', 'DB_URL=' + LIVE_SECRET + 'x'.repeat(200000) + NUL + 'tail'],
      // CHUNKING: a value with newlines is rendered as concatenated chunks,
      // so the token is not one contiguous string in the message at all.
      ['multiline value', 'DB_URL=' + LIVE_SECRET + '\n'.repeat(60) + NUL + 'tail'],
      ['NUL in the key', 'DB' + NUL + 'URL=' + LIVE_SECRET],
    ])('masks the quoted argv element — %s', async (_name, value) => {
      const argv = ['run', '-e', value, 'img'];
      const message = await realNodeRejection(value);
      // Premise check: if Node ever stops echoing the element, this block is
      // asserting nothing and should be re-read rather than trusted.
      expect(message).toContain('P4SSW0RD');

      const out = redactDockerArgvInText(message, argv);
      expect(out).not.toContain(LIVE_SECRET);
      expect(out).not.toContain('P4SSW0RD');
      // ...and the actionable half survives.
      expect(out).toContain('must be a string without null bytes');
      expect(out).toMatch(/args\[\d\]/);
    });

    it('ignores a FORGED refusal clause inside an attacker-controlled value', () => {
      // The clause is pinned to Node's literal prefix (`The argument '…`). It
      // is deliberately NOT `^`-anchored — anchoring made a refusal anywhere
      // but position 0 unrepairable, which is a leak — so the prefix is what
      // stops a lookalike in an env value from truncating a real diagnostic.
      // The forged index MUST name a value-bearing element (here `args[2]`,
      // the `-e` pair). Naming a non-value-bearing one makes the repair a
      // no-op for an unrelated reason, and the case would pass unanchored too
      // — a probe of an earlier draft of this very test caught exactly that.
      const argv = ['run', '-e', 'K=harmless-value', 'img'];
      const text =
        "docker: Error response from daemon: rejected 'args[2]' must be a " +
        "string without null bytes. Received 'x' -- and the REAL diagnostic follows";
      const out = redactDockerArgvInText(text, argv);
      expect(out).toContain('and the REAL diagnostic follows');
    });

    it('masks the TRUNCATED TAIL chunk, not just the complete ones', async () => {
      // The shape that made bounding the replacement a REGRESSION rather than
      // a hardening. `inspect` splits a newline-bearing value into chunks
      // joined by ` +`, then Node slices the rendering at 128 characters — so
      // the LAST chunk has no closing quote. A pattern accepting only complete
      // chunks stopped after the second `'` and re-emitted that tail verbatim.
      // Measured: 272 of 288 probe shapes leaked, and the end-of-string
      // version this replaced did not.
      const LF = String.fromCharCode(10);
      const value = 'DB_URL=' + 'A'.repeat(60) + LF + LIVE_SECRET + 'C'.repeat(200) + NUL;
      // The argv MUST be the one `realNodeRejection` spawned: the repair keys
      // on the index Node names, so a mismatched array resolves to a different
      // element and the value survives in full. That alignment is load-bearing
      // at every production call site too.
      const argv = ['run', '-e', value, 'img'];
      const message = await realNodeRejection(value);
      expect(message).toContain('P4SSW0RD'); // premise: the tail really is echoed

      const out = redactDockerArgvInText(message, argv);
      expect(out).not.toContain('P4SSW0RD');
      expect(out).not.toContain(LIVE_SECRET);
      expect(out).toContain("Received 'DB_URL=***'");
    });

    it('masks a PEM-shaped value whose truncation lands mid-chunk', async () => {
      // Node slices the INSPECTED string at 128 characters, an arbitrary cut
      // that lands wherever it lands — so the surviving fragment is a partial
      // chunk, and a pattern accepting only complete ones re-emitted it. A PEM
      // in an env var is the ordinary way to meet this, not a contrived one.
      const LF = String.fromCharCode(10);
      // The secret sits just after the FIRST newline: Node's 128-character
      // slice has to actually reach it, or the case is vacuous.
      const value =
        'KEY=-----BEGIN PRIVATE KEY-----' +
        LF +
        LIVE_SECRET +
        'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw'.repeat(6) +
        LF +
        '-----END PRIVATE KEY-----' +
        NUL;
      const argv = ['run', '-e', value, 'img'];
      const message = await realNodeRejection(value);
      expect(message).toContain('P4SSW0RD'); // premise
      expect(redactDockerArgvInText(message, argv)).not.toContain('P4SSW0RD');
    });

    it('repairs EVERY refusal clause, not just the first', async () => {
      // Returning after the first repair left a second clause leaking whole.
      // Both values sit at index 2 of the same argv shape.
      const LF = String.fromCharCode(10);
      const first = 'DB=' + 'A'.repeat(150) + NUL;
      const second = 'API=' + 'B'.repeat(40) + LIVE_SECRET + 'y'.repeat(160) + NUL;
      const text = (await realNodeRejection(first)) + LF + (await realNodeRejection(second));
      expect(text).toContain('P4SSW0RD'); // premise
      const out = redactDockerArgvInText(text, ['run', '-e', second, 'img']);
      expect(out).not.toContain('P4SSW0RD');
    });

    it('an unterminated element does not eat the line after it', async () => {
      // `[^'\\]` matched a newline, so a truncated element ran to the next
      // quote ANYWHERE — swallowing the operator hint that followed.
      const LF = String.fromCharCode(10);
      const value = 'DB=' + 'A'.repeat(200) + LIVE_SECRET + NUL;
      const argv = ['run', '-e', value, 'img'];
      const message =
        (await realNodeRejection(value)) + LF + "Hint: docker's env file may be malformed";
      const out = redactDockerArgvInText(message, argv);
      expect(out).toContain('Hint: docker');
    });

    it('a forged clause in an env KEY does not delete the real diagnostics', () => {
      // An env KEY survives redaction by design, so a template author needs no
      // NUL at all to plant Node's wording. The previous version deleted to
      // end-of-string whenever the element did not parse, turning the repair
      // into a diagnostic-destruction primitive.
      const LF = String.fromCharCode(10);
      const key = "X The argument 'args[9999]' must be a string. Received Y";
      const argv = ['run', '--rm', '-e', `${key}=s3cretvalue`, 'alpine:3'];
      const text =
        `Command failed: docker ${argv.join(' ')}${LF}` +
        `docker: Error response from daemon: no such image${LF}` +
        "OPERATOR HINT: run 'docker login'";
      const out = redactDockerArgvInText(text, argv);
      expect(out).toContain('no such image');
      expect(out).toContain('OPERATOR HINT');
      expect(out).not.toContain('s3cretvalue');
    });

    it('a crafted value cannot swallow the lines after the clause', () => {
      // `\s*\+\s*` crossed newlines, so a value shaped like Node's own chunk
      // join absorbed every following diagnostic line. The separator is now
      // horizontal space plus at most one newline, and an open chunk is bounded
      // to its own line.
      const LF = String.fromCharCode(10);
      const argv = ['run', '-e', 'K=v', 'img'];
      const text =
        "The argument 'args[2]' must be a string without null bytes. Received 'a'" +
        `${LF} + 'REAL DIAGNOSTIC${LF}second line' + 'b'${LF}survivor`;
      const out = redactDockerArgvInText(text, argv);
      // Asserting only on the LAST line does not discriminate: the loose
      // separator still leaves it, because it stops at the final complete
      // chunk. The swallowed content is what has to be asserted — a probe of
      // the first draft of this test came back green for exactly that reason.
      expect(out).toContain('REAL DIAGNOSTIC');
      expect(out).toContain('second line');
      expect(out).toContain('survivor');
    });

    it('preserves what FOLLOWS the quoted element — a stack trace, a hint line', () => {
      // The replacement used to run to end-of-string on the premise that a
      // refusal carries no stderr. True of today's Node, and not something
      // this module can enforce, so the element is delimited instead.
      const argv = ['run', '-e', 'DB=' + LIVE_SECRET, 'img'];
      const text =
        "The argument 'args[2]' must be a string without null bytes. " +
        `Received 'DB=${LIVE_SECRET}'\n    at ChildProcess (node:internal)\nHint: check your env vars`;
      const out = redactDockerArgvInText(text, argv);
      expect(out).not.toContain('P4SSW0RD');
      expect(out).toContain("Received 'DB=***'");
      expect(out).toContain('at ChildProcess (node:internal)');
      expect(out).toContain('Hint: check your env vars');
    });

    it('repairs a refusal that is NOT the first thing in the text', () => {
      // Anchoring at `^` made this unrepairable — a leak, traded for the
      // forgery protection the literal prefix already provides.
      const argv = ['run', '-e', 'DB=' + LIVE_SECRET, 'img'];
      const text =
        'prelude line\n' +
        "The argument 'args[2]' must be a string without null bytes. " +
        `Received 'DB=${LIVE_SECRET}'`;
      const out = redactDockerArgvInText(text, argv);
      expect(out).not.toContain('P4SSW0RD');
      expect(out).toContain('prelude line');
      expect(out).toContain("Received 'DB=***'");
    });

    it('scans PAST a clause that does not resolve to reach a real one', async () => {
      // The discriminator for scanning-vs-first-match. The earlier version of
      // this pair had only ONE clause, so iterating changed nothing and the
      // probe came back green — the first clause has to be a decoy that is
      // resolvable but NOT value-bearing (`args[0]` is `run`).
      // The real clause must come from a REAL rejection: a hand-written one
      // carries the token CONTIGUOUSLY, which pass 1b masks before this repair
      // ever runs, and the case is then vacuous whatever the repair does. Only
      // Node's TRUNCATED rendering isolates this pass — the second half of the
      // same lesson the probe of the previous draft taught.
      const value = 'DB=' + LIVE_SECRET + 'x'.repeat(1024) + NUL + 'tail';
      const argv = ['run', '-e', value, 'img'];
      const text =
        "The argument 'args[0]' must be a string without null bytes. Received 'run'\n" +
        (await realNodeRejection(value));
      expect(text).toContain('P4SSW0RD'); // premise

      const out = redactDockerArgvInText(text, argv);
      expect(out).not.toContain('P4SSW0RD');
      expect(out).toContain("Received 'DB=***'");
      // The decoy is untouched: it names a non-value-bearing element.
      expect(out).toContain("Received 'run'");
    });

    it('fails CLOSED on an index that does not resolve', () => {
      // The clause matched Node's own wording, so SOMETHING is quoting an
      // argv element; leaving it verbatim is the wrong direction.
      const argv = ['run', '-e', 'DB=' + LIVE_SECRET, 'img'];
      const text =
        "The argument 'args[99999999999999999999]' must be a string without null bytes. " +
        `Received 'DB=${LIVE_SECRET}'`;
      const out = redactDockerArgvInText(text, argv);
      expect(out).not.toContain('P4SSW0RD');
      expect(out).toContain("Received '***'");
    });

    it('leaves a refusal naming a NON value-bearing element alone', () => {
      // Rewriting it would REPLACE a truncated prefix with the full value —
      // the redactor making the disclosure worse.
      const argv = ['run', '-v', '/host/path' + NUL + '/x:/var/task', 'img'];
      const text =
        "The argument 'args[2]' must be a string without null bytes. Received '/host/path...'";
      expect(redactDockerArgvInText(text, argv)).toBe(text);
    });
  }
);
