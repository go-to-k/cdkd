import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

/**
 * Issue [#2410](https://github.com/go-to-k/cdkd/issues/2410), the line every
 * one of the four stdout-stream suites depends on: `app-executor.ts` re-emits
 * the CDK app's STDERR at `this.logger.info(line)`, so on a DEFAULT run any CDK
 * app that prints to stderr (bundling progress, a construct warning) used to
 * land on the payload stream with no `--verbose` involved. It is the worst
 * spelling of the class because no flag summons it.
 *
 * The four command suites MODEL that line — they call
 * `getLogger().child('AppExecutor').info(...)` from a mocked synthesizer. That
 * is the right shape there (they are about the COMMAND claiming stdout early
 * enough), but it means all four would stay green if this re-emission ever
 * became a `console.log` or a raw `process.stdout.write`. This file closes
 * that: real `AppExecutor`, real logger, real stderr data through the real
 * `proc.stderr.on('data')` handler.
 *
 * A SEPARATE FILE rather than a case in `app-executor.test.ts`, which is the
 * suite that otherwise owns this path: that file mocks
 * `src/utils/logger.js` wholesale, and `AppExecutor`'s `logger` is a FIELD
 * INITIALIZER (`private logger = getLogger().child('AppExecutor')`), bound at
 * construction. So inside that file no instance can ever reach the real
 * `ConsoleLogger.emit` — which is the exact function under test here.
 *
 * Only `node:child_process` is mocked, so the emission path is production code
 * end to end.
 */

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';
import { AppExecutor } from '../../../src/synthesis/app-executor.js';
import {
  getLogger,
  releaseStdoutForPayload,
  reserveStdoutForPayload,
} from '../../../src/utils/logger.js';

const APP_STDERR_LINE = 'Bundling asset Lane2410Stack/Fn/Code/Stage...';

/** The `ChildProcess` shape `AppExecutor.spawn` drives, matching the sibling suite's. */
function createMockProcess(): ChildProcess & { _stdout: EventEmitter; _stderr: EventEmitter } {
  const proc = new EventEmitter() as ChildProcess & {
    _stdout: EventEmitter;
    _stderr: EventEmitter;
  };
  proc._stdout = new EventEmitter();
  proc._stderr = new EventEmitter();
  (proc as unknown as Record<string, unknown>).stdout = proc._stdout;
  (proc as unknown as Record<string, unknown>).stderr = proc._stderr;
  return proc;
}

interface Routed {
  /** Lines the real logger sent to a stdout-bound `console` method. */
  toStdout: string[];
  /** Lines it sent to a stderr-bound one. */
  toStderr: string[];
}

/**
 * Run one `AppExecutor.execute` that receives `APP_STDERR_LINE` on the child's
 * stderr, and report which `console` method the re-emission reached. The
 * console methods are spied rather than `process.stdout.write`, because the
 * routing decision under test IS the method `ConsoleLogger.emit` picks.
 */
async function runWithAppStderr(): Promise<Routed> {
  const toStdout: string[] = [];
  const toStderr: string[] = [];
  const spies = [
    vi.spyOn(console, 'log').mockImplementation((l: unknown) => void toStdout.push(String(l))),
    vi.spyOn(console, 'info').mockImplementation((l: unknown) => void toStdout.push(String(l))),
    vi.spyOn(console, 'debug').mockImplementation((l: unknown) => void toStdout.push(String(l))),
    vi.spyOn(console, 'warn').mockImplementation((l: unknown) => void toStderr.push(String(l))),
    vi.spyOn(console, 'error').mockImplementation((l: unknown) => void toStderr.push(String(l))),
  ];

  try {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc);

    const promise = new AppExecutor().execute({
      app: 'node bin/app.js',
      outputDir: '/tmp/cdk.out',
      context: {},
    });

    mockProc._stderr.emit('data', Buffer.from(`${APP_STDERR_LINE}\n`));
    mockProc.emit('close', 0);
    await promise;
  } finally {
    for (const spy of spies) spy.mockRestore();
  }

  return { toStdout, toStderr };
}

describe("AppExecutor's stderr re-emission follows the stdout reservation (issue #2410)", () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
    releaseStdoutForPayload();
  });

  afterEach(() => {
    releaseStdoutForPayload();
    getLogger().setLevel('info');
  });

  it('re-emits the CDK app stderr to console.error while stdout is reserved', async () => {
    reserveStdoutForPayload();

    const { toStdout, toStderr } = await runWithAppStderr();

    expect(toStderr).toContain(APP_STDERR_LINE);
    expect(toStdout).not.toContain(APP_STDERR_LINE);
  });

  it('re-emits it to console.info when nothing is reserved (unchanged default)', async () => {
    // The counter-case, and the one that keeps the assertion above from
    // passing for the wrong reason: without it, a change that dropped the
    // re-emission entirely, or moved it to `warn` for every run, would still
    // satisfy "not on stdout".
    const { toStdout, toStderr } = await runWithAppStderr();

    expect(toStdout).toContain(APP_STDERR_LINE);
    expect(toStderr).not.toContain(APP_STDERR_LINE);
  });
});
