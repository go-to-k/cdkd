import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * Issue [#3361](https://github.com/go-to-k/cdkd/issues/3361), the
 * `src/local/invoke-agentcore-watch-loop.ts` slice: the reload handlers
 * stringified their caught value with `x instanceof Error ? x.message :
 * String(x)`, and `String(Object.create(null))` throws
 * `TypeError: Cannot convert object to primitive value` -- so the handler threw
 * from inside itself and the degradation it implements was lost.
 *
 * Each case fails one step with exactly that value and asserts the DEGRADATION
 * still happens (the rebuild fallback, the loop's exit, the next reload, the
 * loop's return), never merely "it did not throw". The placeholder is asserted
 * too, so a fix that swallowed the failure without reporting it would not pass.
 */

import {
  runAgentCoreWatchLoop,
  type AgentCoreWatchInvokeOutcome,
  type RunAgentCoreWatchLoopArgs,
} from '../../../src/local/invoke-agentcore-watch-loop.js';
import { ConsoleLogger } from '../../../src/utils/logger.js';
import type { FileWatcher, ResolvedAgentCoreRuntime } from 'cdk-local/internal';
import type { Synthesizer } from '../../../src/synthesis/synthesizer.js';

type InvokeOnceFn = RunAgentCoreWatchLoopArgs['invokeOnce'];
type RebuildFn = RunAgentCoreWatchLoopArgs['rebuild'];

/** What `describeAwsFailure(x).detail` renders for a value `String()` cannot convert. */
const PLACEHOLDER = 'a value that could not be converted to text';

/** A value whose `String()` throws. */
const unconvertible = (): unknown => Object.create(null) as unknown;

/**
 * An `invokeOnce` whose first session calls `fire` (the watcher firings), then
 * ends on its abort -- or, so a reload that never aborts it cannot hang the
 * case, after a short bound. Later sessions end at once.
 */
function invokeFiring(
  fire: () => void
): ReturnType<typeof vi.fn<InvokeOnceFn>> {
  return vi
    .fn<InvokeOnceFn>()
    .mockImplementationOnce(async ({ abortSignal }): Promise<AgentCoreWatchInvokeOutcome> => {
      process.nextTick(fire);
      await new Promise<void>((res) => {
        const bound = setTimeout(res, 300);
        abortSignal.addEventListener('abort', () => {
          clearTimeout(bound);
          res();
        });
      });
      return { pendingReload: abortSignal.aborted };
    })
    .mockImplementation(async (): Promise<AgentCoreWatchInvokeOutcome> => ({ pendingReload: false }));
}

describe('runAgentCoreWatchLoop with an unconvertible failure (#3361)', () => {
  let onChange: ((paths: readonly string[]) => void) | undefined;
  let watcher: FileWatcher;
  let rebuild: ReturnType<typeof vi.fn<RebuildFn>>;
  let waitForPing: ReturnType<typeof vi.fn<(host: string, port: number) => Promise<void>>>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  const logged = (spy: ReturnType<typeof vi.spyOn>): string[] =>
    spy.mock.calls.map((c: unknown[]) => String(c[0]));

  const args = (
    invokeOnce: InvokeOnceFn,
    classifierContext: RunAgentCoreWatchLoopArgs['__classifierContext'] = async () => undefined
  ): RunAgentCoreWatchLoopArgs => ({
    containerHost: '127.0.0.1',
    hostPort: 9001,
    options: { output: 'cdk.out' },
    resolvedTarget: 'ChatAgent',
    resolved: {} as ResolvedAgentCoreRuntime,
    synthesizer: {} as Synthesizer,
    synthOpts: {} as never,
    stacks: [],
    invokeOnce,
    rebuild,
    softReload: vi.fn(),
    __waitForPing: waitForPing,
    __watcherFactory: (cb) => {
      onChange = cb;
      return watcher;
    },
    __classifierContext: classifierContext,
  });

  beforeEach(() => {
    onChange = undefined;
    watcher = { close: vi.fn(async () => undefined) };
    rebuild = vi.fn<RebuildFn>(async () => ({ containerId: 'new', hostPort: 9002, stacks: [] }));
    waitForPing = vi.fn(async () => undefined);
    warnSpy = vi.spyOn(ConsoleLogger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(ConsoleLogger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(ConsoleLogger.prototype, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('still falls back to rebuild when the classifier context rejects with one', async () => {
    const invokeOnce = invokeFiring(() => onChange?.(['/abs/app.py']));

    await runAgentCoreWatchLoop(
      args(invokeOnce, async () => {
        throw unconvertible();
      })
    );

    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(logged(warnSpy)).toContainEqual(
      `Reload: classifier context unavailable (${PLACEHOLDER}); falling back to rebuild.`
    );
  });

  it('still exits the loop when the rebuild rejects with one', async () => {
    rebuild.mockImplementation(async () => {
      throw unconvertible();
    });
    const invokeOnce = invokeFiring(() => onChange?.(['/abs/app.py']));

    await runAgentCoreWatchLoop(args(invokeOnce));

    // No second ping against the container the failed rebuild tore down.
    expect(waitForPing).toHaveBeenCalledTimes(1);
    expect(invokeOnce).toHaveBeenCalledTimes(1);
    expect(logged(errorSpy)).toContainEqual(expect.stringContaining(`Reload failed: ${PLACEHOLDER}. `));
  });

  it('keeps the reload chain alive after a reload throws one', async () => {
    // The first firing's body throws the value from outside its two guarded
    // steps, so it reaches the chain's own catch.
    let thrown = false;
    warnSpy.mockImplementation((message: unknown) => {
      if (!thrown && String(message).includes('source change detected')) {
        thrown = true;
        throw unconvertible();
      }
    });
    const invokeOnce = invokeFiring(() => {
      onChange?.(['/abs/a.py']);
      onChange?.(['/abs/b.py']);
    });

    await runAgentCoreWatchLoop(args(invokeOnce));

    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(logged(errorSpy)).toContainEqual(`Reload chain threw: ${PLACEHOLDER}`);
  });

  it('still returns when closing the watcher rejects with one', async () => {
    watcher = {
      close: vi.fn(async () => {
        throw unconvertible();
      }),
    };
    const invokeOnce = vi.fn<InvokeOnceFn>(async () => ({ pendingReload: false }));

    await expect(runAgentCoreWatchLoop(args(invokeOnce))).resolves.toBeUndefined();

    expect(logged(warnSpy)).toContainEqual(`Watcher close failed: ${PLACEHOLDER}`);
  });
});
