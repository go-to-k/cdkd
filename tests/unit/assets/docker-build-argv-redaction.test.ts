import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * Issue [#2623](https://github.com/go-to-k/cdkd/issues/2623): every argv
 * `src/assets/docker-build.ts` renders — the `--verbose` build line, the
 * `executable`-mode command line, the no-output throw, and both docker-failure
 * texts — must go through the shared redaction in `src/utils/docker-cmd.ts`.
 *
 * **Every case asserts BOTH directions.** A planted value must be ABSENT and
 * the surrounding diagnostic must SURVIVE: an absence-only assertion passes
 * trivially against an empty string, and a redaction that deletes the message
 * is not an improvement over one that leaks.
 *
 * The planted literals are unique per case and appear nowhere else in the
 * repo, so a needle cannot coincide with a fixture value someone else owns.
 */

const { mockRunDocker, mockSpawn, debugLines } = vi.hoisted(() => ({
  mockRunDocker: vi.fn(),
  mockSpawn: vi.fn(),
  debugLines: [] as string[],
}));

vi.mock('../../../src/utils/docker-cmd.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/utils/docker-cmd.js')>(
    '../../../src/utils/docker-cmd.js'
  );
  // Only the two SPAWN helpers are stubbed. The redaction under test is the
  // real implementation — stubbing it would make every case here vacuous.
  return { ...actual, runDockerStreaming: mockRunDocker, spawnStreaming: mockSpawn };
});

vi.mock('../../../src/utils/logger.js', async () => {
  // `importActual` keeps `isStdoutReservedForPayload`, which the real
  // `docker-cmd.ts` imports: a factory that returns only `getLogger` makes
  // that a call on `undefined` at spawn time.
  const actual = await vi.importActual<typeof import('../../../src/utils/logger.js')>(
    '../../../src/utils/logger.js'
  );
  const stub = {
    debug: (line: string) => void debugLines.push(line),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    getLevel: () => 'info',
    child: () => stub,
  };
  return { ...actual, getLogger: () => stub };
});

import { buildDockerImage } from '../../../src/assets/docker-build.js';
import type { DockerImageAssetSource } from '../../../src/types/assets.js';

const wrapError = (stderr: string): Error => new Error(`Docker build failed: ${stderr}`);

/** The single debug line the helper emitted, as one string. */
function debugText(): string {
  expect(debugLines.length).toBeGreaterThan(0);
  return debugLines.join('\n');
}

beforeEach(() => {
  debugLines.length = 0;
  mockRunDocker.mockReset();
  mockSpawn.mockReset();
  mockRunDocker.mockResolvedValue({ stdout: '', stderr: '' });
});

describe('directory source: --verbose build line (issue #2623)', () => {
  const SECRET = 'npm_2623DirModeRegistryToken';

  const source: DockerImageAssetSource = {
    directory: 'asset.2623',
    dockerBuildArgs: { NPM_TOKEN: SECRET, NODE_VERSION: '20' },
    dockerBuildSecrets: { npmrc: 'src=./.npmrc' },
    dockerBuildContexts: { sources: '../sources' },
  };

  it('masks every --build-arg VALUE and keeps the whole rest of the line', async () => {
    await buildDockerImage({ source }, '/cdk.out', { tag: 'cdkd-asset-2623', wrapError });

    const line = debugText();
    expect(line).not.toContain(SECRET);
    expect(line).toContain('--build-arg NPM_TOKEN=***');
    expect(line).toContain('--build-arg NODE_VERSION=***');
    // The diagnostic survives, all of it: the flag KEYS, the tag, the context
    // dir, and the two flags that are deliberately NOT masked.
    expect(line).toContain('--tag cdkd-asset-2623');
    expect(line).toContain('--secret id=npmrc,src=./.npmrc');
    expect(line).toContain('--build-context sources=../sources');
    expect(line).toContain('(cwd=/cdk.out/asset.2623)');
  });

  it('spawns docker with the RAW value — the redaction is display-only', async () => {
    await buildDockerImage({ source }, '/cdk.out', { tag: 'cdkd-asset-2623', wrapError });

    const args = mockRunDocker.mock.calls[0]![0] as string[];
    expect(args).toContain(`NPM_TOKEN=${SECRET}`);
    expect(args).not.toContain('NPM_TOKEN=***');
  });
});

describe('directory source: docker failure text (issue #2623)', () => {
  // Long enough that Node TRUNCATES it in a spawn refusal — see the fixture
  // comment below for why that is the whole point of the case.
  const SECRET = `npm_2623SpawnRefusal${'Token'.repeat(30)}`;

  it('composes the failure text, repairing a Node spawn refusal that quotes the pair', async () => {
    const source: DockerImageAssetSource = {
      directory: 'asset.2623',
      dockerBuildArgs: { NPM_TOKEN: SECRET },
    };
    // Node validates argv SYNCHRONOUSLY inside `spawn`, so a NUL in a value
    // rejects with a TypeError that QUOTES the offending element and names its
    // index — the one message shape that carries a build-arg value with no
    // stderr to prefer over it. The argv here is
    // `['build', '--tag', 'tag', '--build-arg', 'NPM_TOKEN=…', '.']`, so the
    // pair is at index 4.
    //
    // The value is LONG on purpose, and the fixture is Node's own TRUNCATED
    // rendering (measured on Node 24.19.0: it cuts near 128 characters of the
    // quoted element and appends `...` with NO closing quote). That is what
    // makes the case discriminate. With a short value, pass 1b — which
    // substitutes the whole `KEY=VALUE` token wherever it occurs — already
    // masks it, so the index-directed `repairSpawnRefusal` never decides the
    // outcome and mis-indexing the composer leaves the test GREEN. Review
    // round 1 measured exactly that: `describeDockerFailure(err, ['x',
    // ...buildArgs])` passed all nine cases. Truncated, no needle can match
    // and only the index repair can mask it.
    mockRunDocker.mockRejectedValue(
      new TypeError(
        `The argument 'args[4]' must be a string without null bytes. ` +
          `Received 'NPM_TOKEN=${SECRET.slice(0, 118)}...`
      )
    );

    const message = await buildDockerImage({ source }, '/cdk.out', { tag: 'tag', wrapError }).then(
      () => '',
      (e: Error) => e.message
    );
    expect(message).not.toContain(SECRET);
    // The truncated PREFIX must be gone too: a needle-based pass cannot match
    // a cut token, so its survival is exactly the leak this fixture exists for.
    expect(message).not.toContain(SECRET.slice(0, 60));
    expect(message).toContain('NPM_TOKEN=***');
    expect(message).toContain('must be a string without null bytes');
  });

  it('still prefers stderr — the composer did not change what a normal failure says', async () => {
    mockRunDocker.mockRejectedValue(
      Object.assign(new Error('docker build exited 1'), { stderr: '  BOOM: no such file\n' })
    );
    await expect(
      buildDockerImage({ source: { directory: 'asset.2623' } }, '/cdk.out', {
        tag: 'tag',
        wrapError,
      })
    ).rejects.toThrow('Docker build failed: BOOM: no such file');
  });

  it('masks the build arg but keeps --secret / --build-context in an ERROR text too', async () => {
    // The other direction, on the ERROR channel rather than the log line. A
    // docker failure often echoes the command line back in its own stderr, and
    // pass 1 substitutes the whole joined argv there — so an over-tightening
    // change to the flag set is visible here as well.
    const planted = 'npm_2623ErrorChannelSurvival';
    const source: DockerImageAssetSource = {
      directory: 'asset.2623',
      dockerBuildArgs: { NPM_TOKEN: planted },
      dockerBuildSecrets: { npmrc: 'src=./.npmrc' },
      dockerBuildContexts: { sources: '../sources' },
    };
    let spawned: string[] = [];
    mockRunDocker.mockImplementation((args: string[]) => {
      spawned = args;
      const err = new Error('exited 1') as Error & { stderr: string };
      err.stderr = `failed to solve: docker ${args.join(' ')}`;
      return Promise.reject(err);
    });

    const message = await buildDockerImage({ source }, '/cdk.out', {
      tag: 'tag',
      wrapError,
    }).then(
      () => '',
      (e: Error) => e.message
    );
    expect(spawned).toContain(`NPM_TOKEN=${planted}`);
    expect(message).not.toContain(planted);
    expect(message).toContain('--build-arg NPM_TOKEN=***');
    expect(message).toContain('--secret id=npmrc,src=./.npmrc');
    expect(message).toContain('--build-context sources=../sources');
    expect(message).toContain('failed to solve');
  });
});

describe('executable source (issue #2623)', () => {
  const SECRET = 'ghp_2623ExecutableModeToken';
  /** Long enough for Node to truncate — used only by the spawn-refusal case. */
  const LONG_EXEC_SECRET = `ghp_2623Executable${'Mode'.repeat(35)}`;
  const source: DockerImageAssetSource = {
    directory: 'asset.2623',
    executable: ['docker', 'build', '--build-arg', `GH_TOKEN=${SECRET}`, '.'],
  };
  const longSource: DockerImageAssetSource = {
    directory: 'asset.2623',
    executable: ['docker', 'build', '--build-arg', `GH_TOKEN=${LONG_EXEC_SECRET}`, '.'],
  };

  it('masks the build script command line in the --verbose log', async () => {
    mockSpawn.mockResolvedValue({ stdout: 'local-tag:1\n', stderr: '' });

    await buildDockerImage({ source }, '/cdk.out', { tag: 'unused', wrapError });

    const line = debugText();
    expect(line).not.toContain(SECRET);
    expect(line).toContain('--build-arg GH_TOKEN=***');
    expect(line).toContain('Building Docker image via executable: docker build');
    expect(line).toContain('(cwd=/cdk.out/asset.2623)');
  });

  it('masks the JOINED `--build-arg=K=V` spelling a wrapper script may use', async () => {
    // `source.executable` is USER-authored, so it is not restricted to the
    // two-token form every argv cdkd builds emits. This is the shape review
    // round 1 found unmasked.
    const joined = 'ghp_2623JoinedInExecutable';
    mockSpawn.mockResolvedValue({ stdout: 'local-tag:1\n', stderr: '' });

    await buildDockerImage(
      {
        source: {
          directory: 'asset.2623',
          executable: ['./build.sh', `--build-arg=GH_TOKEN=${joined}`, '.'],
        },
      },
      '/cdk.out',
      { tag: 'unused', wrapError }
    );

    const line = debugText();
    expect(line).not.toContain(joined);
    expect(line).toContain('--build-arg=GH_TOKEN=***');
    expect(line).toContain('./build.sh');
  });

  it('masks it in the "produced no output" throw — an ERROR path, not behind --verbose', async () => {
    mockSpawn.mockResolvedValue({ stdout: '   \n', stderr: '' });

    const message = await buildDockerImage({ source }, '/cdk.out', {
      tag: 'unused',
      wrapError,
    }).then(
      () => '',
      (e: Error) => e.message
    );
    expect(message).not.toContain(SECRET);
    expect(message).toContain('--build-arg GH_TOKEN=***');
    expect(message).toContain('produced no output');
    // The command itself is the diagnostic and must still be readable.
    expect(message).toContain('docker build');
  });

  it('composes the spawn failure against the array actually handed to spawn', async () => {
    // `spawnStreaming(cmd, args)` receives `executable.slice(1)`, so Node's
    // `args[N]` indexes THAT array — index 2, not the 3 that
    // `source.executable` would give. Passing the executable whole resolves
    // every index one element early and repairs the wrong token.
    //
    // Node's TRUNCATED rendering again (measured, Node 24.19.0), for the same
    // reason as the directory case: an untruncated token is masked by pass 1b
    // regardless of the index, so a short fixture cannot see the off-by-one.
    mockSpawn.mockRejectedValue(
      new TypeError(
        `The argument 'args[2]' must be a string without null bytes. ` +
          `Received 'GH_TOKEN=${LONG_EXEC_SECRET.slice(0, 118)}...`
      )
    );

    const message = await buildDockerImage({ source: longSource }, '/cdk.out', {
      tag: 'unused',
      wrapError,
    }).then(
      () => '',
      (e: Error) => e.message
    );
    expect(message).not.toContain(LONG_EXEC_SECRET);
    // The truncated prefix must not survive either — a partial token is still
    // a disclosure, and it is what a needle-based pass would leave behind.
    expect(message).not.toContain(LONG_EXEC_SECRET.slice(0, 60));
    expect(message).toContain('GH_TOKEN=***');
    expect(message).toContain('must be a string without null bytes');
  });
});

describe('malformed source error (issue #2623)', () => {
  const SECRET = 'npm_2623MalformedSourceDump';

  it('names the FIELDS present, never their values', async () => {
    // This used to be `JSON.stringify(source)` — a strictly WIDER disclosure
    // than the log line the issue was filed about: every build-arg value plus
    // every build secret, in a thrown error rather than behind --verbose.
    const source = {
      dockerBuildArgs: { NPM_TOKEN: SECRET },
      dockerBuildSecrets: { npmrc: 'src=/home/me/.npmrc' },
    } as DockerImageAssetSource;

    const message = await buildDockerImage({ source }, '/cdk.out', { tag: 'tag', wrapError }).then(
      () => '',
      (e: Error) => e.message
    );
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain('/home/me/.npmrc');
    // The diagnostic — which fields WERE set, given neither required one is —
    // survives in full.
    expect(message).toContain("must set either 'directory' or 'executable'");
    expect(message).toContain('fields present: dockerBuildArgs, dockerBuildSecrets');
  });

  it('does not list a field that is PRESENT but EMPTY — it would contradict the sentence', async () => {
    // `{ directory: '' }` takes this branch precisely because `directory` is
    // not set; listing it as "present" reads as a contradiction on the one
    // line the user gets. `JSON.stringify` disambiguated it by printing `""`.
    const source = {
      directory: '',
      executable: [],
      // An empty OBJECT is the same statement as an empty ARRAY. Round 2 of
      // review found the first cut answered them differently: `{}` was listed
      // as present while `[]` was not, from one predicate.
      dockerBuildContexts: {},
      dockerBuildArgs: { NODE_VERSION: '20' },
    } as unknown as DockerImageAssetSource;

    const message = await buildDockerImage({ source }, '/cdk.out', { tag: 'tag', wrapError }).then(
      () => '',
      (e: Error) => e.message
    );
    // Assert on the LIST, not the whole message: the fixed prose names
    // 'directory' and 'executable' itself, so a whole-message `not.toContain`
    // is unsatisfiable and would fail against correct output.
    const list = message.slice(message.indexOf('fields present: '));
    expect(list).toBe("fields present: dockerBuildArgs)");
  });

  it('sanitizes a field NAME before printing it — the terminal is the reader', async () => {
    // `JSON.stringify` escaped control characters; a bare key list does not,
    // and a manifest key carrying a newline or a CSI byte would forge lines in
    // a thrown error.
    const source = {
      'dockerBuildArgs\u001b[2K\nFORGED: all clear': { A: '1' },
    } as unknown as DockerImageAssetSource;

    const message = await buildDockerImage({ source }, '/cdk.out', { tag: 'tag', wrapError }).then(
      () => '',
      (e: Error) => e.message
    );
    expect(message).not.toContain('\u001b');
    expect(message).not.toContain('\n');
    // The readable part of the name survives, so the diagnostic is not lost.
    expect(message).toContain('dockerBuildArgs');
  });

  it('says so explicitly when the source is empty', async () => {
    const message = await buildDockerImage({ source: {} as DockerImageAssetSource }, '/cdk.out', {
      tag: 'tag',
      wrapError,
    }).then(
      () => '',
      (e: Error) => e.message
    );
    expect(message).toContain('fields present: <no fields set>');
  });
});
