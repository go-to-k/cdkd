import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

/**
 * Issue [#2410](https://github.com/go-to-k/cdkd/issues/2410), the fourth site:
 * `cdkd local invoke-agentcore` writes the AGENT'S RESPONSE to stdout with no
 * flag involved. It has more payload writers than any other command in the
 * issue — three terminal emitters (`emitResult` / `emitMcpResult` /
 * `emitA2aResult`) plus the SSE and WebSocket chunk sinks that write a body
 * incrementally as frames arrive — and interleaving is worse here than on a
 * buffered payload, because a status line can land BETWEEN two frames of one
 * document.
 *
 * THE LOGGER IS DELIBERATELY NOT MOCKED, for the reason
 * `tests/unit/cli/list-json-stream.test.ts` documents: the defect is which
 * `console` method `ConsoleLogger.emit` picks, so the real logger runs and the
 * console methods are spied into ONE ordered fd-1 / fd-2 transcript.
 *
 * Two levels are driven, and the split is deliberate:
 *  - the COMMAND cases run `localInvokeAgentCoreCommand` for real, with
 *    everything below its own logic mocked at the module boundary (Docker,
 *    the AgentCore HTTP / WS clients, synthesis, the STS hop). The ENTRY case
 *    proves the reservation is in effect before the synth whose chatter
 *    `app-executor.ts` re-emits at INFO — it runs through a synth that fails
 *    right after emitting, since the POSITION of the call is the whole fix.
 *    The HAPPY-PATH cases then prove the other half, which the entry case
 *    cannot: that a PAYLOAD lands on stdout while reserved (its own stdout
 *    assertion is `toBe('')`, so on its own no case here would show that).
 *    They drive the real payload sinks — the buffered `emitResult` write, the
 *    SSE `onChunk` closure, the `--ws` `onMessage` closure — and the real
 *    prose of `applyRoleArnIfSet`, which runs AFTER the reservation and
 *    before the synth.
 *  - the EMITTER cases exercise the four exported payload writers directly
 *    while the reservation is active, which is the over-tightening control:
 *    they must keep writing to stdout, byte-exact, while `emitResult`'s own
 *    HTTP >= 400 `logger.warn` goes to stderr exactly once.
 *
 * NOT covered, because a different mechanism produces it: the CONTAINER's own
 * stdout, which `streamLogs` (`src/local/docker-runner.ts`) pipes straight
 * into ours — [#2419](https://github.com/go-to-k/cdkd/issues/2419).
 */

const mocks = vi.hoisted(() => ({
  synthesize: vi.fn(),
  resolveApp: vi.fn(),
  ensureDockerAvailable: vi.fn(),
  pullImage: vi.fn(),
  pickFreePort: vi.fn(),
  runDetached: vi.fn(),
  streamLogs: vi.fn(),
  removeContainer: vi.fn(),
  waitForAgentCorePing: vi.fn(),
  invokeAgentCore: vi.fn(),
  invokeAgentCoreWs: vi.fn(),
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

vi.mock('../../../src/local/agentcore-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/local/agentcore-client.js')>();
  return {
    ...actual,
    waitForAgentCorePing: mocks.waitForAgentCorePing,
    invokeAgentCore: mocks.invokeAgentCore,
  };
});

vi.mock('../../../src/local/agentcore-ws-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/local/agentcore-ws-client.js')>();
  return { ...actual, invokeAgentCoreWs: mocks.invokeAgentCoreWs };
});

// Only the CLIENT is stubbed; `AssumeRoleCommand` and friends stay REAL, so a
// factory that forgot an export cannot surface as an `undefined()` call inside
// the command (the `feedback_mock_factory_missing_export_fails_as_undefined_call`
// shape). `applyRoleArnIfSet` is the only STS caller these cases reach.
vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sts')>();
  return {
    ...actual,
    STSClient: vi.fn().mockImplementation(() => ({ send: mocks.stsSend, destroy: vi.fn() })),
  };
});

import {
  createLocalInvokeAgentCoreCommand,
  emitResult,
  emitMcpResult,
  emitA2aResult,
  emitWsResult,
  WS_REPL_PROMPT,
} from '../../../src/cli/commands/local-invoke-agentcore.js';
import {
  getLogger,
  releaseStdoutForPayload,
  reserveStdoutForPayload,
} from '../../../src/utils/logger.js';

const CHATTER = 'Bundling asset AgentStack/EchoAgent/Code/Stage...';
/** A non-ECR image tag, so `resolveAgentCoreImage` takes the plain `pullImage` arm. */
const AGENT_IMAGE = 'lane2410-agent:local';
const AGENT_PAYLOAD = '{"result":"lane2410-agentcore-response"}';
const ROLE_ARN = 'arn:aws:iam::111122223333:role/cdkd-agentcore-stream-reader';
const ASSUMED_LINE = `Assumed role ${ROLE_ARN}`;

interface Streams {
  stdout: string;
  stderr: string;
  error: unknown;
}

function makeStack(): StackInfo {
  return {
    artifactId: 'AgentStack',
    stackName: 'AgentStack',
    displayName: 'AgentStack',
    template: { Resources: {} },
    dependencyNames: [],
    region: 'us-east-1',
    account: '111111111111',
  } as unknown as StackInfo;
}

/**
 * A stack carrying a REAL `AWS::BedrockAgentCore::Runtime` in the shape
 * cdk-local's resolver reads: a literal `ContainerUri` (so the image step is a
 * plain `pullImage`, not an ECR login or an asset build) and no
 * `AuthorizerConfiguration` (so no inbound-JWT verification runs). The
 * resolver is NOT mocked — `resolveAgentCoreTarget` runs for real against this
 * template, which is what makes the `Target: ...` status line the command
 * prints production prose rather than a literal invented here.
 */
function makeAgentStack(): StackInfo {
  return {
    artifactId: 'AgentStack',
    stackName: 'AgentStack',
    displayName: 'AgentStack',
    template: {
      Resources: {
        EchoAgent: {
          Type: 'AWS::BedrockAgentCore::Runtime',
          Properties: {
            AgentRuntimeArtifact: { ContainerConfiguration: { ContainerUri: AGENT_IMAGE } },
            EnvironmentVariables: {},
          },
        },
      },
    },
    dependencyNames: [],
    region: 'us-east-1',
    account: '111111111111',
  } as unknown as StackInfo;
}

/**
 * Capture fd-1 / fd-2 into one ordered transcript while `body` runs. Shared by
 * the command case and the emitter cases so both measure the same way.
 */
async function capture(body: () => Promise<void> | void): Promise<Streams> {
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
    await body();
  } catch (e) {
    error = e;
  } finally {
    for (const spy of consoleSpies) spy.mockRestore();
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { stdout: out.join(''), stderr: err.join(''), error };
}

/** Drive the real `invoke-agentcore` subcommand end to end under {@link capture}. */
async function runAgentCore(args: string[]): Promise<Streams> {
  return capture(async () => {
    const cmd = createLocalInvokeAgentCoreCommand();
    cmd.exitOverride();
    await cmd.parseAsync(args, { from: 'user' });
  });
}

describe('local invoke-agentcore keeps stdout to the agent response (issue #2410)', () => {
  let exitCodeBefore: typeof process.exitCode;
  let envBefore: Record<string, string | undefined>;
  let ttyBefore: { stdin: boolean | undefined; stdout: boolean | undefined };

  beforeEach(() => {
    exitCodeBefore = process.exitCode;
    envBefore = {
      AWS_ACCESS_KEY_ID: process.env['AWS_ACCESS_KEY_ID'],
      AWS_SECRET_ACCESS_KEY: process.env['AWS_SECRET_ACCESS_KEY'],
      AWS_SESSION_TOKEN: process.env['AWS_SESSION_TOKEN'],
    };
    ttyBefore = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };

    for (const m of Object.values(mocks)) m.mockReset();
    mocks.resolveApp.mockReturnValue('node app.js');
    mocks.ensureDockerAvailable.mockResolvedValue(undefined);

    // The happy-path scaffolding: everything below the command's own logic is
    // mocked at the module boundary (Docker, the AgentCore HTTP / WS clients,
    // synthesis) so the whole flow from command entry to the payload write
    // runs for real, in-process, with no container involved.
    mocks.synthesize.mockImplementation(async () => {
      // Models `app-executor.ts:165`'s `this.logger.info(line)` re-emission of
      // the CDK app's stderr — same logger, same level, same path through
      // `ConsoleLogger.emit`.
      getLogger().child('AppExecutor').info(CHATTER);
      return { stacks: [makeAgentStack()], assemblyDir: 'cdk.out' };
    });
    mocks.pullImage.mockResolvedValue(undefined);
    mocks.pickFreePort.mockResolvedValue(19411);
    mocks.runDetached.mockResolvedValue('cdkd-agentcore-lane2410');
    mocks.streamLogs.mockReturnValue(() => undefined);
    mocks.removeContainer.mockResolvedValue(undefined);
    mocks.waitForAgentCorePing.mockResolvedValue(undefined);
    // Shape matches the REAL `AgentCoreInvokeResult` (cdk-local's
    // `agentcore-client`): `{ status, contentType, raw, streamed }`.
    mocks.invokeAgentCore.mockResolvedValue({
      status: 200,
      contentType: 'application/json',
      raw: AGENT_PAYLOAD,
      streamed: false,
    });
    mocks.invokeAgentCoreWs.mockResolvedValue({ frames: 0 });
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
    process.exitCode = exitCodeBefore;
    for (const [k, v] of Object.entries(envBefore)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    process.stdin.isTTY = ttyBefore.stdin as boolean;
    process.stdout.isTTY = ttyBefore.stdout as boolean;
    releaseStdoutForPayload();
    getLogger().setLevel('info');
  });

  it('claims stdout at command ENTRY, so synth chatter never reaches it', async () => {
    mocks.synthesize.mockImplementation(async () => {
      // Models `app-executor.ts:165`'s re-emission of the CDK app's stderr.
      getLogger().child('AppExecutor').info(CHATTER);
      // The stack carries no AgentCore runtime, so target resolution fails
      // right after. What is under test is that the reservation was already
      // in effect when the line above was emitted.
      return { stacks: [makeStack()], assemblyDir: 'cdk.out' };
    });

    const { stdout, stderr, error } = await capture(async () => {
      const cmd = createLocalInvokeAgentCoreCommand();
      cmd.exitOverride();
      await cmd.parseAsync(['AgentStack/EchoAgent'], { from: 'user' });
    });

    // The run does not complete. `withErrorHandling` catches the resolution
    // failure and `handleError` prints it at ERROR, so nothing is thrown out
    // of `parseAsync` — the diagnostic on stderr is what says it failed.
    expect(error).toBeUndefined();
    expect(stderr).toContain(
      "AgentCoreResolutionError: Target 'AgentStack/EchoAgent' not found."
    );

    expect(stderr).toContain(CHATTER);
    expect(stdout).not.toContain(CHATTER);
    expect(stderr).toContain('Synthesizing CDK app...');
    expect(stdout).not.toContain('Synthesizing CDK app...');

    // Nothing at all should have reached stdout: no payload was produced.
    expect(stdout).toBe('');
  });

  /**
   * The COMMAND HAPPY PATH, and the case that makes the other command cases
   * mean something. The entry case above proves the reservation is in effect
   * before the synth, but its only stdout assertion is `toBe('')` — so with
   * that case alone, deleting `reserveStdoutForPayload()` from
   * `localInvokeAgentCoreCommand` reds exactly ONE case and NO case shows the
   * command putting a PAYLOAD on stdout while reserved. This one runs the
   * whole flow from command entry to `emitResult`, with everything below the
   * command's own logic mocked at the module boundary, and asserts both
   * halves of the contract at once: the agent response byte-exact on stdout,
   * and every real status line the command prints on stderr instead.
   *
   * The prose asserted on is production output — `local-invoke-agentcore.ts`'s
   * own `logger.info` calls plus the `AppExecutor` child-logger re-emission —
   * never a literal invented here.
   */
  it('puts the agent response on stdout and every status line on stderr', async () => {
    const { stdout, stderr, error } = await runAgentCore(['AgentStack:EchoAgent', '--no-pull']);

    expect(error).toBeUndefined();

    // Byte-exact, and it parses. `toContain` would pass with a status line
    // glued to the front, which is the whole defect.
    expect(stdout).toBe(`${AGENT_PAYLOAD}\n`);
    expect(JSON.parse(stdout)).toEqual({ result: 'lane2410-agentcore-response' });

    // MOVED, not dropped. `Target: ...` is the line that proves the
    // reservation still holds AFTER target resolution, and `Starting agent
    // container` that it holds through the Docker phase — a reservation
    // narrowed to just the synth would leave those two on stdout.
    for (const line of [
      CHATTER,
      'Synthesizing CDK app...',
      'Target: AgentStack/EchoAgent',
      'Starting agent container',
    ]) {
      expect(stderr).toContain(line);
      expect(stdout).not.toContain(line);
    }
  });

  /**
   * The REAL chunk sink. `onChunk` is a `process.stdout.write(text)` closure
   * built inside `localInvokeAgentCoreCommand`, so it is reachable only by
   * driving the command: the emitter case below writes its frames itself and
   * therefore never enters it. Here the mocked `invokeAgentCore` calls the
   * closure the command actually passed it, which is what makes "streamed
   * frames are stdout payload" — asserted by this suite's header and by
   * `docs/cli-reference.md` — a tested claim rather than an asserted one.
   */
  it('streams SSE chunks through the command\'s own sink to stdout, prose on stderr', async () => {
    const frame1 = '{"token":"lane2410-sse-1"}';
    const frame2 = '{"token":"lane2410-sse-2"}';
    mocks.invokeAgentCore.mockImplementation(
      async (_host: string, _port: number, _event: unknown, options: { onChunk?: (t: string) => void }) => {
        options.onChunk?.(frame1);
        options.onChunk?.(frame2);
        return { status: 200, contentType: 'text/event-stream', raw: '', streamed: true };
      }
    );

    const { stdout, stderr, error } = await runAgentCore(['AgentStack:EchoAgent', '--no-pull']);

    expect(error).toBeUndefined();
    // Both frames in order, then `emitResult({streamed:true})`'s lone
    // terminator — and nothing between them, which is the interleaving this
    // command is worst-affected by.
    expect(stdout).toBe(`${frame1}${frame2}\n`);
    expect(stderr).toContain('Target: AgentStack/EchoAgent');
    expect(stdout).not.toContain('Target: AgentStack/EchoAgent');
  });

  /**
   * `--role-arn` drives REAL production prose end to end: `applyRoleArnIfSet`
   * (`src/utils/role-arn.ts`) emits `Assumed role ...` at INFO with only STS
   * mocked. It runs from a DIFFERENT module than the command, and — the point
   * of the case — from a call site AFTER `reserveStdoutForPayload()` but
   * before the synth. Without it, a regression that moved the reservation
   * down to just-before-synth would leave this line on stdout with every
   * other case in this file green; `cdkd list` and `cdkd synth` each carry
   * the same case for the same reason.
   */
  it('--role-arn moves the real role-assumption notice to stderr, payload untouched', async () => {
    const { stdout, stderr, error } = await runAgentCore([
      'AgentStack:EchoAgent',
      '--no-pull',
      '--role-arn',
      ROLE_ARN,
    ]);

    expect(error).toBeUndefined();
    expect(stdout).toBe(`${AGENT_PAYLOAD}\n`);
    expect(stderr).toContain(ASSUMED_LINE);
    expect(stdout).not.toContain(ASSUMED_LINE);
  });

  it('the three payload emitters keep writing to stdout while reserved', async () => {
    const httpRaw = '{"agent":"lane2410-http"}';
    const mcpRaw = '{"jsonrpc":"2.0","result":{"marker":"lane2410-mcp"}}';
    const a2aRaw = '{"jsonrpc":"2.0","result":{"marker":"lane2410-a2a"}}';

    const { stdout, stderr, error } = await capture(() => {
      reserveStdoutForPayload();
      emitResult({ raw: httpRaw, status: 200, streamed: false } as Parameters<
        typeof emitResult
      >[0]);
      emitMcpResult({ raw: mcpRaw, ok: true } as Parameters<typeof emitMcpResult>[0]);
      emitA2aResult({ raw: a2aRaw, ok: true } as Parameters<typeof emitA2aResult>[0]);
    });

    expect(error).toBeUndefined();
    expect(stdout).toBe(`${httpRaw}\n${mcpRaw}\n${a2aRaw}\n`);
    expect(stderr).toBe('');
  });

  /**
   * The FOURTH exported emitter, plus the ORDERING around it. `--ws` and SSE
   * write the body incrementally and then call `emitWsResult` /
   * `emitResult({ streamed: true })`, each of which writes ONLY the
   * terminating newline — a shape no other case here reaches, since the
   * `raw`-writing arm of `emitResult` is what the HTTP cases exercise.
   *
   * What this case fences is exactly two things: that both terminator-only
   * emitters keep writing to stdout while reserved, and that frames ALREADY
   * on stdout stay byte-exact and in order with the terminators appended
   * after them. It does NOT reach the real chunk sinks: the frames below are
   * written by the test body, so `local-invoke-agentcore.ts`'s own `onChunk`
   * / `onMessage` closures are never entered and routing THEM to stderr would
   * red nothing here. Those are covered by the COMMAND cases instead: the SSE
   * case ABOVE drives the real `onChunk` through a mocked `invokeAgentCore`,
   * and the four `--ws` cases BELOW drive the real `onMessage` through a
   * mocked `invokeAgentCoreWs`.
   */
  it('the streamed shapes write their frames and terminator to stdout', async () => {
    const frame1 = '{"token":"lane2410-frame-1"}';
    const frame2 = '{"token":"lane2410-frame-2"}';

    const { stdout, stderr, error } = await capture(() => {
      reserveStdoutForPayload();
      // Written HERE, not by the command: this case is about what the
      // terminator-only emitters do to bytes already on stdout. The command's
      // own sinks are driven for real by the SSE / `--ws` cases above.
      process.stdout.write(frame1);
      process.stdout.write(frame2);
      emitWsResult({ frames: 2 } as Parameters<typeof emitWsResult>[0]);
      emitResult({ raw: '', status: 200, streamed: true } as Parameters<typeof emitResult>[0]);
    });

    expect(error).toBeUndefined();
    // Both frames, in order, plus one terminator newline per emitter.
    expect(stdout).toBe(`${frame1}${frame2}\n\n`);
    expect(stderr).toBe('');
  });

  /**
   * `--ws`'s `> ` REPL prompt is gated on `promptOnStdout` — stdin a TTY AND
   * stdout a TTY — and the second half is issue #2410's. Gated on stdin
   * alone, as it was, `cdkd local invoke-agentcore Agent --ws > frames.txt`
   * FROM A TERMINAL appended `\n> ` after every frame, so the `| tail -1`
   * this command's own docs prescribe returned `> ` instead of the last
   * frame: the documented workaround, broken by the thing it works around.
   *
   * All FOUR combinations are driven, because only one of them differs
   * between the two gates and a table missing it proves nothing. They run
   * through the COMMAND rather than through `wrapWsOnMessage` directly (which
   * `tests/unit/cli/local-invoke-agentcore-pure-helpers.test.ts` already
   * covers as a boolean): the expression `interactive && process.stdout.isTTY
   * === true` lives in the command, so passing the boolean in by hand would
   * mirror the gate rather than fence it. `invokeAgentCoreWs` is mocked at
   * the module boundary and calls back the `onMessage` the command actually
   * handed it.
   */
  describe.each([
    { stdinTty: true, stdoutTty: true, prompt: true },
    // The regression: a terminal stdin with a REDIRECTED stdout.
    { stdinTty: true, stdoutTty: false, prompt: false },
    { stdinTty: false, stdoutTty: true, prompt: false },
    { stdinTty: false, stdoutTty: false, prompt: false },
  ])('--ws with stdin TTY=$stdinTty, stdout TTY=$stdoutTty', ({ stdinTty, stdoutTty, prompt }) => {
    const FRAME = '{"token":"lane2410-ws-frame"}';

    const title = `writes the raw frame to stdout and ${
      prompt ? 'appends' : 'does NOT append'
    } the REPL prompt`;

    it(title, async () => {
      process.stdin.isTTY = stdinTty;
      process.stdout.isTTY = stdoutTty;
      mocks.invokeAgentCoreWs.mockImplementation(
        async (
          _host: string,
          _port: number,
          _event: unknown,
          options: { onMessage: (text: string) => void }
        ) => {
          options.onMessage(FRAME);
          return { frames: 1 };
        }
      );

      const { stdout, stderr, error } = await runAgentCore([
        'AgentStack:EchoAgent',
        '--no-pull',
        '--ws',
      ]);

      expect(error).toBeUndefined();
      // `emitWsResult` writes the lone stream terminator after the frames in
      // both shapes; only the `\n> ` in between is the prompt.
      expect(stdout).toBe(prompt ? `${FRAME}\n${WS_REPL_PROMPT}\n` : `${FRAME}\n`);
      // Whatever the prompt does, the payload contract holds: the frame is on
      // stdout and the command's prose is not.
      expect(stderr).toContain('Target: AgentStack/EchoAgent');
      expect(stdout).not.toContain('Target: AgentStack/EchoAgent');
    });
  });

  /**
   * The OVER-TIGHTENING control: `emitResult`'s own HTTP >= 400 `logger.warn`
   * must land on stderr exactly once while the payload stays on stdout
   * byte-exact. A fix that routed the payload away, or that duplicated the
   * warn onto stdout, reds here.
   */
  it('an HTTP-error warn goes to stderr exactly once, payload still on stdout', async () => {
    const raw = '{"error":"lane2410-agent-refused"}';

    const { stdout, stderr, error } = await capture(() => {
      reserveStdoutForPayload();
      emitResult({ raw, status: 500, streamed: false } as Parameters<typeof emitResult>[0]);
    });

    expect(error).toBeUndefined();
    expect(stdout).toBe(`${raw}\n`);
    expect(stderr).not.toContain('lane2410-agent-refused');

    const warnNeedle = 'Agent /invocations returned HTTP 500.';
    expect(stderr.split(warnNeedle).length - 1).toBe(1);
    expect(stdout).not.toContain(warnNeedle);
  });
});
