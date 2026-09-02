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
 *  - the COMMAND case proves `localInvokeAgentCoreCommand` claims stdout at
 *    ENTRY, before the synth whose chatter `app-executor.ts` re-emits at INFO.
 *    It runs the real command through a synth that fails after emitting, since
 *    the reservation must already be in effect by then — the position of the
 *    call is the whole fix, and a run that got as far as Docker would prove
 *    less about it, not more.
 *  - the EMITTER cases exercise the three exported payload writers directly
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
  return { ...actual, ensureDockerAvailable: mocks.ensureDockerAvailable };
});

import {
  createLocalInvokeAgentCoreCommand,
  emitResult,
  emitMcpResult,
  emitA2aResult,
  emitWsResult,
} from '../../../src/cli/commands/local-invoke-agentcore.js';
import {
  getLogger,
  releaseStdoutForPayload,
  reserveStdoutForPayload,
} from '../../../src/utils/logger.js';

const CHATTER = 'Bundling asset AgentStack/EchoAgent/Code/Stage...';

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

describe('local invoke-agentcore keeps stdout to the agent response (issue #2410)', () => {
  let exitCodeBefore: typeof process.exitCode;

  beforeEach(() => {
    exitCodeBefore = process.exitCode;
    for (const m of Object.values(mocks)) m.mockReset();
    mocks.resolveApp.mockReturnValue('node app.js');
    mocks.ensureDockerAvailable.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.exitCode = exitCodeBefore;
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
   * The FOURTH exported emitter, and the streamed shape generally. `--ws` and
   * SSE write the body incrementally through chunk sinks and then call
   * `emitWsResult` / `emitResult({ streamed: true })`, which write only the
   * terminating newline. Both the suite header and `docs/cli-reference.md`
   * state that streamed frames are stdout payload, so this is the case that
   * makes that claim testable rather than asserted — without it, routing the
   * chunk sinks to stderr reds nothing.
   */
  it('the streamed shapes write their frames and terminator to stdout', async () => {
    const frame1 = '{"token":"lane2410-frame-1"}';
    const frame2 = '{"token":"lane2410-frame-2"}';

    const { stdout, stderr, error } = await capture(() => {
      reserveStdoutForPayload();
      // Models the `onChunk` / `onMessage` sinks, which are plain
      // `process.stdout.write(text)` closures in the command.
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
