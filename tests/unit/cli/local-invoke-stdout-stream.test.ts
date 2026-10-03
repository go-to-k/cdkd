import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { ResolvedZipLambda } from '../../../src/local/lambda-resolver.js';

/**
 * Issue [#2410](https://github.com/go-to-k/cdkd/issues/2410): `cdkd local
 * invoke` writes the function's response payload to stdout
 * (`local-invoke.ts`'s single `process.stdout.write(`${result.raw}\n`)`) with
 * NO flag involved, so the issue-#2280 reservation — keyed on `--json` —
 * could not cover it. Every status line the command prints (`Synthesizing CDK
 * app...`, `Target: ...`, `Starting container ...`, plus the CDK app's stderr
 * that `app-executor.ts` re-emits at INFO) preceded the payload on the SAME
 * stream, so `cdkd local invoke -f X | jq` corrupted on a default run.
 * `sam local invoke` routes its status lines to stderr for exactly this
 * reason.
 *
 * THE LOGGER IS DELIBERATELY NOT MOCKED, for the reason
 * `tests/unit/cli/list-json-stream.test.ts` documents: the defect is which
 * `console` method `ConsoleLogger.emit` picks, so the real logger runs and the
 * console methods are spied into ONE ordered fd-1 / fd-2 transcript.
 *
 * Everything below the command's own logic is mocked at the module boundary
 * (Docker, the RIE client, synthesis, target resolution) so the whole flow
 * from command entry to the payload write runs for real, in-process, with no
 * container involved. The prose asserted on is `local-invoke.ts`'s own
 * `logger.info` output plus the `AppExecutor` child-logger re-emission — never
 * a literal invented here.
 *
 * The CONTAINER's own stdout, which `followContainerLogs` (`src/local/docker-runner.ts`)
 * pipes into ours, is a raw child-process pipe the logger cannot route; since
 * [#2419](https://github.com/go-to-k/cdkd/issues/2419) it follows the
 * reservation instead. Its cases drive the REAL `followContainerLogs` against a fake
 * `docker` binary (`tests/unit/_fake-docker-logs.ts`), so what it proves is
 * the wiring: the command holds the reservation while the container's output
 * flows.
 */

const mocks = vi.hoisted(() => ({
  synthesize: vi.fn(),
  resolveApp: vi.fn(),
  resolveLambdaTarget: vi.fn(),
  ensureDockerAvailable: vi.fn(),
  pullImage: vi.fn(),
  pickFreePort: vi.fn(),
  runDetached: vi.fn(),
  followContainerLogs: vi.fn(),
  killAndDrainContainerLogs: vi.fn(),
  removeContainer: vi.fn(),
  resolveHostGatewayExtraHosts: vi.fn(),
  waitForRieReady: vi.fn(),
  invokeRie: vi.fn(),
  stsSend: vi.fn(),
}));

vi.mock('../../../src/synthesis/synthesizer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/synthesis/synthesizer.js')>();
  return {
    ...actual,
    Synthesizer: vi.fn().mockImplementation(() => ({ synthesize: mocks.synthesize })),
  };
});

vi.mock('../../../src/cli/config-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/cli/config-loader.js')>();
  return { ...actual, resolveApp: (cliApp?: string) => mocks.resolveApp(cliApp) };
});

vi.mock('../../../src/local/lambda-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/local/lambda-resolver.js')>();
  return { ...actual, resolveLambdaTarget: mocks.resolveLambdaTarget };
});

vi.mock('../../../src/local/docker-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/local/docker-runner.js')>();
  return {
    ...actual,
    ensureDockerAvailable: mocks.ensureDockerAvailable,
    pullImage: mocks.pullImage,
    pickFreePort: mocks.pickFreePort,
    runDetached: mocks.runDetached,
    followContainerLogs: mocks.followContainerLogs,
    killAndDrainContainerLogs: mocks.killAndDrainContainerLogs,
    removeContainer: mocks.removeContainer,
  };
});

vi.mock('../../../src/local/docker-version.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/local/docker-version.js')>();
  return { ...actual, resolveHostGatewayExtraHosts: mocks.resolveHostGatewayExtraHosts };
});

// Only the CLIENT is stubbed; `AssumeRoleCommand` and friends stay REAL, so a
// factory that forgot an export cannot surface as an `undefined()` call inside
// the command. `applyRoleArnIfSet` is the only STS caller these cases reach —
// `local-invoke.ts`'s own `assumeExecutionRole` needs `--assume-role <arn>`
// plus resolvable state, which no case here supplies.
vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sts')>();
  return {
    ...actual,
    STSClient: vi.fn().mockImplementation(() => ({ send: mocks.stsSend, destroy: vi.fn() })),
  };
});

vi.mock('../../../src/local/rie-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/local/rie-client.js')>();
  return {
    ...actual,
    waitForRieReady: mocks.waitForRieReady,
    invokeRie: mocks.invokeRie,
  };
});

import { createLocalCommand } from '../../../src/cli/commands/local-invoke.js';
import {
  CONTAINER_LATE_TOKEN,
  CONTAINER_STDERR_TOKEN,
  CONTAINER_STDOUT_TOKEN,
  installFakeDockerLogs,
  waitForContainerOutput,
} from '../_fake-docker-logs.js';
import { getLogger, releaseStdoutForPayload } from '../../../src/utils/logger.js';
import { resetAwsClientDefaults } from '../../../src/utils/aws-client-defaults.js';

const CHATTER = 'Bundling asset LocalStack/EchoHandler/Code/Stage...';
const PAYLOAD = '{"statusCode":200,"body":"lane2410-local-invoke-response"}';
const ROLE_ARN = 'arn:aws:iam::111122223333:role/cdkd-local-invoke-stream-reader';
const ASSUMED_LINE = `Assumed role ${ROLE_ARN}`;

let codeDir: string;

function makeStack(): StackInfo {
  return {
    artifactId: 'LocalStack',
    stackName: 'LocalStack',
    displayName: 'LocalStack',
    template: { Resources: {} },
    dependencyNames: [],
    region: 'us-east-1',
    account: '111111111111',
  } as unknown as StackInfo;
}

function makeZipLambda(): ResolvedZipLambda {
  return {
    kind: 'zip',
    stack: makeStack(),
    logicalId: 'EchoHandler',
    resource: { Type: 'AWS::Lambda::Function', Properties: {} },
    memoryMb: 128,
    timeoutSec: 3,
    layers: [],
    runtime: 'nodejs20.x',
    handler: 'index.handler',
    codePath: codeDir,
    architecture: 'x86_64',
  } as unknown as ResolvedZipLambda;
}

interface Streams {
  stdout: string;
  stderr: string;
  error: unknown;
}

/** The in-flight run's two buffers, for a mock that must wait on delivery. */
let live: { out: string[]; err: string[]; seq: string[] } | undefined;
/** The ordered transcript of the last finished run. */
let lastSeq: string[] = [];

async function runInvoke(args: string[]): Promise<Streams> {
  const out: string[] = [];
  const err: string[] = [];
  // One ordered transcript across both fds, `out:` / `err:`-prefixed, plus a
  // `flush` / `flush-out` entry for `flushStdio`'s zero-length writes.
  const seq: string[] = [];
  live = { out, err, seq };
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    out.push(text);
    seq.push(text === '' ? 'flush-out' : `out:${text}`);
    const cb = rest.find((a): a is () => void => typeof a === 'function');
    if (cb) cb();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    err.push(text);
    seq.push(text === '' ? 'flush' : `err:${text}`);
    const cb = rest.find((a): a is () => void => typeof a === 'function');
    if (cb) cb();
    return true;
  }) as typeof process.stderr.write;
  const toFd1 = (line: unknown): void => void out.push(`${String(line)}\n`);
  const toFd2 = (line: unknown): void => void err.push(`${String(line)}\n`);
  const consoleSpies = [
    vi.spyOn(console, 'log').mockImplementation(toFd1),
    vi.spyOn(console, 'info').mockImplementation(toFd1),
    vi.spyOn(console, 'debug').mockImplementation(toFd1),
    vi.spyOn(console, 'warn').mockImplementation(toFd2),
    vi.spyOn(console, 'error').mockImplementation(toFd2),
  ];

  let error: unknown;
  try {
    const local = createLocalCommand();
    local.exitOverride();
    for (const sub of local.commands) sub.exitOverride();
    await local.parseAsync(['invoke', ...args], { from: 'user' });
  } catch (e) {
    error = e;
  } finally {
    for (const spy of consoleSpies) spy.mockRestore();
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    live = undefined;
    lastSeq = seq;
  }
  return { stdout: out.join(''), stderr: err.join(''), error };
}

describe('local invoke keeps stdout to the response payload (issue #2410)', () => {
  let envBefore: Record<string, string | undefined>;

  beforeEach(() => {
    envBefore = {
      AWS_ACCESS_KEY_ID: process.env['AWS_ACCESS_KEY_ID'],
      AWS_SECRET_ACCESS_KEY: process.env['AWS_SECRET_ACCESS_KEY'],
      AWS_SESSION_TOKEN: process.env['AWS_SESSION_TOKEN'],
    };
    codeDir = mkdtempSync(join(tmpdir(), 'cdkd-lane2410-code-'));
    writeFileSync(join(codeDir, 'index.js'), 'exports.handler = async () => ({});\n');

    for (const m of Object.values(mocks)) m.mockReset();
    mocks.resolveApp.mockReturnValue('node app.js');
    mocks.synthesize.mockImplementation(async () => {
      // Models `app-executor.ts:165`'s `this.logger.info(line)` re-emission of
      // the CDK app's stderr — same logger, same level, same path through
      // `ConsoleLogger.emit`.
      getLogger().child('AppExecutor').info(CHATTER);
      return { stacks: [makeStack()], assemblyDir: 'cdk.out' };
    });
    mocks.resolveLambdaTarget.mockImplementation(() => makeZipLambda());
    mocks.ensureDockerAvailable.mockResolvedValue(undefined);
    mocks.pullImage.mockResolvedValue(undefined);
    mocks.pickFreePort.mockResolvedValue(19410);
    mocks.runDetached.mockResolvedValue('cdkd-local-lane2410');
    mocks.followContainerLogs.mockReturnValue({
      stop: () => undefined,
      drain: async () => true,
    });
    mocks.killAndDrainContainerLogs.mockResolvedValue(undefined);
    mocks.removeContainer.mockResolvedValue(undefined);
    mocks.resolveHostGatewayExtraHosts.mockResolvedValue([]);
    mocks.waitForRieReady.mockResolvedValue(undefined);
    // Shape matches the REAL `InvokeResult` (`src/local/rie-client.ts`):
    // `{ payload, raw }`. An earlier cut returned `{ raw, status }` — `status`
    // does not exist on that type and `payload` was missing, which is inert
    // today (`local-invoke.ts` reads only `.raw`) but would let a future
    // branch that reads `.payload` get `undefined` and pass silently.
    mocks.invokeRie.mockResolvedValue({ payload: JSON.parse(PAYLOAD), raw: PAYLOAD });
    mocks.stsSend.mockResolvedValue({
      Credentials: {
        AccessKeyId: 'AKIA_LANE2410_TEST',
        SecretAccessKey: 'secret-lane2410-test',
        SessionToken: 'token-lane2410-test',
        Expiration: new Date('2030-01-01T00:00:00.000Z'),
      },
    });
  });

  afterEach(() => {
    // This file drives the REAL `applyRoleArnIfSet`, which publishes the
    // assumed credentials process-wide. Without this, they persist into every
    // later case in the file and decide which identity its clients resolve.
    resetAwsClientDefaults();
    rmSync(codeDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(envBefore)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    releaseStdoutForPayload();
    getLogger().setLevel('info');
  });

  it('leaves stdout to the response payload alone, every status line on stderr', async () => {
    const { stdout, stderr, error } = await runInvoke(['LocalStack/EchoHandler', '--no-pull']);

    expect(error).toBeUndefined();

    // The payload: byte-exact, and it parses. `toContain` would pass with a
    // status line glued to the front, which is the whole defect.
    expect(stdout).toBe(`${PAYLOAD}\n`);
    expect(JSON.parse(stdout)).toEqual({
      statusCode: 200,
      body: 'lane2410-local-invoke-response',
    });

    // MOVED, not dropped — each of these is a real `logger.info` from the
    // command (or, for CHATTER, the AppExecutor child logger).
    for (const line of [
      CHATTER,
      'Synthesizing CDK app...',
      'Target: LocalStack/EchoHandler (nodejs20.x)',
      'Starting container',
    ]) {
      expect(stderr).toContain(line);
      expect(stdout).not.toContain(line);
    }
  });

  /**
   * `--role-arn` drives REAL production prose end to end: `applyRoleArnIfSet`
   * (`src/utils/role-arn.ts`) emits `Assumed role ...` at INFO with only STS
   * mocked. It runs from a DIFFERENT module than the command, and — the point
   * of the case — from a call site AFTER `reserveStdoutForPayload()` but
   * before the synth. Without it, a regression that moved the reservation
   * down to just-before-synth would leave this line on stdout with every
   * other case in this file green; `cdkd list` and `cdkd synth` each carry
   * the same case for the same reason, and `cdkd local invoke-agentcore` now
   * does too.
   */
  it('--role-arn moves the real role-assumption notice to stderr, payload untouched', async () => {
    const { stdout, stderr, error } = await runInvoke([
      'LocalStack/EchoHandler',
      '--no-pull',
      '--role-arn',
      ROLE_ARN,
    ]);

    expect(error).toBeUndefined();
    expect(stdout).toBe(`${PAYLOAD}\n`);
    expect(stderr).toContain(ASSUMED_LINE);
    expect(stdout).not.toContain(ASSUMED_LINE);
  });

  /**
   * The OVER-TIGHTENING control. #2410 moves the DEFAULT contract, so #2280's
   * "no flag ⇒ prose stays on stdout" negative control is gone; this replaces
   * it. It reds if the payload is routed off stdout too (or partly leaks onto
   * stderr), and if a diagnostic is duplicated onto both streams.
   *
   * The warn is real production prose: `local-invoke.ts` warns when
   * `--assume-role` is passed as a bare flag with no `--from-state` to resolve
   * the execution role from.
   */
  it('an --assume-role warning lands on stderr exactly once, payload untouched', async () => {
    const { stdout, stderr, error } = await runInvoke([
      'LocalStack/EchoHandler',
      '--no-pull',
      '--assume-role',
    ]);

    expect(error).toBeUndefined();

    // Payload still on stdout, byte-exact; no part of it on stderr.
    expect(stdout).toBe(`${PAYLOAD}\n`);
    expect(stderr).not.toContain('lane2410-local-invoke-response');

    const warnNeedle = '--assume-role passed without an ARN';
    expect(stderr.split(warnNeedle).length - 1).toBe(1);
    expect(stdout).not.toContain(warnNeedle);
    // The remedy's hole is quoted (go-to-k/cdkd#4295).
    expect(stderr).toContain("pass the ARN explicitly: --assume-role '<arn>'.");
  });
  /**
   * Issue #2419. The Lambda RIE puts `START` / `END` / `REPORT` and every
   * handler log line on the CONTAINER's stdout, and `followContainerLogs` pipes that
   * into ours — a raw write the logger never sees. Here the REAL `followContainerLogs`
   * runs against a fake `docker` binary, and the RIE call waits until the fake
   * container's output has actually been DELIVERED (to either stream) before
   * returning the response, so the assertion is about routing, not timing.
   * Reverting the routing puts the container token ahead of the payload.
   */
  it.skipIf(process.platform === 'win32')(
    "moves the container's own stdout to stderr, payload alone on stdout",
    async () => {
      const actual = await vi.importActual<typeof import('../../../src/local/docker-runner.js')>(
        '../../../src/local/docker-runner.js'
      );
      mocks.followContainerLogs.mockImplementation(actual.followContainerLogs);
      mocks.killAndDrainContainerLogs.mockImplementation(actual.killAndDrainContainerLogs);
      mocks.invokeRie.mockImplementation(async () => {
        await waitForContainerOutput(() =>
          live ? live.out.join('') + live.err.join('') : ''
        );
        return { payload: JSON.parse(PAYLOAD), raw: PAYLOAD };
      });
      const fake = installFakeDockerLogs();
      let streams: Streams;
      try {
        streams = await runInvoke(['LocalStack/EchoHandler', '--no-pull']);
      } finally {
        fake.restore();
      }
      const { stdout, stderr, error } = streams;

      expect(error).toBeUndefined();
      expect(stdout).toBe(`${PAYLOAD}\n`);
      // MOVED, not dropped: the container id reached `docker logs -f`, and
      // both of the container's streams are on ours-stderr.
      expect(stderr).toContain(`${CONTAINER_STDOUT_TOKEN}logs -f cdkd-local-lane2410`);
      expect(stderr).toContain(CONTAINER_STDERR_TOKEN);
    },
    20_000
  );

  /**
   * Issue #4480. A loaded daemon relays the container's last lines to
   * `docker logs -f` only AFTER the invocation returned; the fake models it
   * by relaying {@link CONTAINER_LATE_TOKEN} only once `docker kill` stopped
   * the container. The teardown used to SIGTERM the follower and `docker rm
   * -f` straight away, so that line never arrived. Now the container is
   * killed and the follower drained BEFORE the payload is written and before
   * the container is removed.
   */
  it.skipIf(process.platform === 'win32')(
    "relays the container's late log line before the payload and before docker rm",
    async () => {
      const actual = await vi.importActual<typeof import('../../../src/local/docker-runner.js')>(
        '../../../src/local/docker-runner.js'
      );
      mocks.followContainerLogs.mockImplementation(actual.followContainerLogs);
      mocks.killAndDrainContainerLogs.mockImplementation(actual.killAndDrainContainerLogs);
      let seqAtRemove: string[] | undefined;
      mocks.removeContainer.mockImplementation(async () => {
        seqAtRemove = live ? [...live.seq] : undefined;
      });
      mocks.invokeRie.mockImplementation(async () => {
        await waitForContainerOutput(() =>
          live ? live.out.join('') + live.err.join('') : ''
        );
        return { payload: JSON.parse(PAYLOAD), raw: PAYLOAD };
      });
      const fake = installFakeDockerLogs();
      let streams: Streams;
      let seq: string[] = [];
      try {
        streams = await runInvoke(['LocalStack/EchoHandler', '--no-pull']);
        seq = lastSeq;
      } finally {
        fake.restore();
      }
      const { stdout, stderr, error } = streams;

      expect(error).toBeUndefined();
      expect(stdout).toBe(`${PAYLOAD}\n`);
      expect(stderr).toContain(CONTAINER_LATE_TOKEN);
      const late = seq.findIndex((e) => e.startsWith('err:') && e.includes(CONTAINER_LATE_TOKEN));
      const payload = seq.indexOf(`out:${PAYLOAD}\n`);
      expect(late).toBeGreaterThanOrEqual(0);
      expect(payload).toBeGreaterThan(late);
      // Drained before removal, not merely before the process ended.
      expect(mocks.removeContainer).toHaveBeenCalledWith('cdkd-local-lane2410');
      expect(seqAtRemove?.some((e) => e.includes(CONTAINER_LATE_TOKEN))).toBe(true);
    },
    20_000
  );

  /**
   * Issue #4480, the ^C arm: the SIGINT handler runs the same cleanup and then
   * `process.exit(130)`, which drops writes still queued on a pipe. The
   * late line must be relayed AND stderr flushed before the exit.
   */
  it.skipIf(process.platform === 'win32')(
    'on SIGINT, relays the late log line before docker rm, and flushes stdio before process.exit(130)',
    async () => {
      const actual = await vi.importActual<typeof import('../../../src/local/docker-runner.js')>(
        '../../../src/local/docker-runner.js'
      );
      mocks.followContainerLogs.mockImplementation(actual.followContainerLogs);
      mocks.killAndDrainContainerLogs.mockImplementation(actual.killAndDrainContainerLogs);
      let seqAtRemove: string[] | undefined;
      mocks.removeContainer.mockImplementation(async () => {
        seqAtRemove = live ? [...live.seq] : undefined;
      });
      const onSpy = vi.spyOn(process, 'on');
      let seqAtExit: string[] | undefined;
      let exited!: () => void;
      const exitCalled = new Promise<void>((r) => {
        exited = r;
      });
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        seqAtExit = live ? [...live.seq, `exit:${String(code)}`] : undefined;
        exited();
        return undefined as never;
      }) as typeof process.exit);
      mocks.invokeRie.mockImplementation(async () => {
        await waitForContainerOutput(() =>
          live ? live.out.join('') + live.err.join('') : ''
        );
        const call = onSpy.mock.calls.find(([event]) => event === 'SIGINT');
        expect(call).toBeDefined();
        (call![1] as () => void)();
        await exitCalled;
        return { payload: JSON.parse(PAYLOAD), raw: PAYLOAD };
      });
      const fake = installFakeDockerLogs();
      try {
        await runInvoke(['LocalStack/EchoHandler', '--no-pull']);
      } finally {
        fake.restore();
        onSpy.mockRestore();
        exitSpy.mockRestore();
      }

      // `mockRestore` clears the spy's calls, so the exit is read from the
      // transcript it appended to.
      const seq = seqAtExit ?? [];
      const late = seq.findIndex((e) => e.startsWith('err:') && e.includes(CONTAINER_LATE_TOKEN));
      const flush = seq.lastIndexOf('flush');
      expect(late).toBeGreaterThanOrEqual(0);
      expect(flush).toBeGreaterThan(late);
      expect(seq[seq.length - 1]).toBe('exit:130');
      // The ^C teardown drains BEFORE it removes the container, too.
      expect(seqAtRemove?.some((e) => e.includes(CONTAINER_LATE_TOKEN))).toBe(true);
    },
    20_000
  );
  /**
   * Issue #4480 on the FAILED-invoke exit (a hung handler's invoke timeout is
   * where its last lines matter most): the `finally`'s cleanup drains the late
   * line and flushes stdio before `handleError`'s `process.exit(1)`, and the
   * SIGINT handler stays installed while that teardown runs.
   */
  it.skipIf(process.platform === 'win32')(
    'on a failed invoke, relays the late line and flushes stdio before exit(1), handler kept',
    async () => {
      const actual = await vi.importActual<typeof import('../../../src/local/docker-runner.js')>(
        '../../../src/local/docker-runner.js'
      );
      mocks.followContainerLogs.mockImplementation(actual.followContainerLogs);
      mocks.killAndDrainContainerLogs.mockImplementation(actual.killAndDrainContainerLogs);
      const sigintBefore = process.listeners('SIGINT').length;
      let sigintAtRemove: number | undefined;
      mocks.removeContainer.mockImplementation(async () => {
        sigintAtRemove = process.listeners('SIGINT').length;
      });
      let seqAtExit: string[] | undefined;
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        seqAtExit = live ? [...live.seq, `exit:${String(code)}`] : undefined;
        return undefined as never;
      }) as typeof process.exit);
      mocks.invokeRie.mockImplementation(async () => {
        await waitForContainerOutput(() =>
          live ? live.out.join('') + live.err.join('') : ''
        );
        throw new Error('lane4480 invoke timed out');
      });
      const fake = installFakeDockerLogs();
      try {
        await runInvoke(['LocalStack/EchoHandler', '--no-pull']);
      } finally {
        fake.restore();
        exitSpy.mockRestore();
      }

      const seq = seqAtExit ?? [];
      const late = seq.findIndex((e) => e.startsWith('err:') && e.includes(CONTAINER_LATE_TOKEN));
      expect(late).toBeGreaterThanOrEqual(0);
      expect(seq.lastIndexOf('flush')).toBeGreaterThan(late);
      expect(seq.lastIndexOf('flush-out')).toBeGreaterThan(late);
      expect(seq[seq.length - 1]).toBe('exit:1');
      expect(sigintAtRemove).toBe(sigintBefore + 1);
      expect(process.listeners('SIGINT').length).toBe(sigintBefore);
    },
    20_000
  );
});
