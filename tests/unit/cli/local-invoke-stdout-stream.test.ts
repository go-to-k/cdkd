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
 * NOT covered, because a different mechanism produces it: the CONTAINER's own
 * stdout, which `streamLogs` (`src/local/docker-runner.ts`) pipes straight
 * into ours. The reservation cannot reach a raw child-process pipe; that is
 * [#2419](https://github.com/go-to-k/cdkd/issues/2419).
 */

const mocks = vi.hoisted(() => ({
  synthesize: vi.fn(),
  resolveApp: vi.fn(),
  resolveLambdaTarget: vi.fn(),
  ensureDockerAvailable: vi.fn(),
  pullImage: vi.fn(),
  pickFreePort: vi.fn(),
  runDetached: vi.fn(),
  streamLogs: vi.fn(),
  removeContainer: vi.fn(),
  resolveHostGatewayExtraHosts: vi.fn(),
  waitForRieReady: vi.fn(),
  invokeRie: vi.fn(),
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
    streamLogs: mocks.streamLogs,
    removeContainer: mocks.removeContainer,
  };
});

vi.mock('../../../src/local/docker-version.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/local/docker-version.js')>();
  return { ...actual, resolveHostGatewayExtraHosts: mocks.resolveHostGatewayExtraHosts };
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
import { getLogger, releaseStdoutForPayload } from '../../../src/utils/logger.js';

const CHATTER = 'Bundling asset LocalStack/EchoHandler/Code/Stage...';
const PAYLOAD = '{"statusCode":200,"body":"lane2410-local-invoke-response"}';

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

async function runInvoke(args: string[]): Promise<Streams> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    out.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    err.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
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
  }
  return { stdout: out.join(''), stderr: err.join(''), error };
}

describe('local invoke keeps stdout to the response payload (issue #2410)', () => {
  beforeEach(() => {
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
    mocks.streamLogs.mockReturnValue(() => undefined);
    mocks.removeContainer.mockResolvedValue(undefined);
    mocks.resolveHostGatewayExtraHosts.mockResolvedValue([]);
    mocks.waitForRieReady.mockResolvedValue(undefined);
    mocks.invokeRie.mockResolvedValue({ raw: PAYLOAD, status: 200 });
  });

  afterEach(() => {
    rmSync(codeDir, { recursive: true, force: true });
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
  });
});
