import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * Issue [#3361](https://github.com/go-to-k/cdkd/issues/3361), the
 * `src/local/ecs-task-runner.ts` slice: `cleanupEcsRun`'s per-step handlers
 * stringified their caught value with `x instanceof Error ? x.message :
 * String(x)`, and `String(Object.create(null))` throws
 * `TypeError: Cannot convert object to primitive value` -- so the handler threw
 * from inside itself and the rest of the teardown never ran.
 *
 * Each case fails one step with exactly that value and asserts the DEGRADATION
 * still happens (cleanup resolves and reaches its last step, the docker volume
 * removal), never merely "it did not throw". The placeholder is asserted too,
 * so a fix that swallowed the failure without reporting it would not pass.
 */

const execFileCalls = vi.hoisted(() => [] as string[][]);

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: (...allArgs: unknown[]) => {
      const cb = allArgs[allArgs.length - 1] as (
        err: Error | null,
        res?: { stdout: string; stderr: string }
      ) => void;
      execFileCalls.push(allArgs[1] as string[]);
      cb(null, { stdout: '', stderr: '' });
    },
  };
});

import {
  cleanupEcsRun,
  createEcsRunState,
  IN_FLIGHT_STEP_TIMEOUT_MS,
  type EcsRunState,
} from '../../../src/local/ecs-task-runner.js';
import { ConsoleLogger } from '../../../src/utils/logger.js';

/** What `describeAwsFailure(x).detail` renders for a value `String()` cannot convert. */
const PLACEHOLDER = 'a value that could not be converted to text';

/** A value whose `String()` throws. */
const unconvertible = (): unknown => Object.create(null) as unknown;

/** A state whose last cleanup step, the volume removal, is observable. */
function stateWithVolume(): EcsRunState {
  const state = createEcsRunState();
  state.dockerVolumeNames.push('cdkd-vol');
  return state;
}

const removedVolume = (): boolean =>
  execFileCalls.some((a) => a.join(' ') === 'volume rm cdkd-vol');

describe('cleanupEcsRun with an unconvertible failure (#3361)', () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const debugs = (): string[] => debugSpy.mock.calls.map((c: unknown[]) => String(c[0]));

  beforeEach(() => {
    execFileCalls.length = 0;
    debugSpy = vi.spyOn(ConsoleLogger.prototype, 'debug').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(ConsoleLogger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(ConsoleLogger.prototype, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('finishes the teardown when the afterContainersStopped hook rejects with one', async () => {
    const state = stateWithVolume();

    await expect(
      cleanupEcsRun(state, {
        keepRunning: true,
        afterContainersStopped: async () => {
          throw unconvertible();
        },
      })
    ).resolves.toBeUndefined();

    expect(removedVolume()).toBe(true);
    expect(debugs()).toContainEqual(
      expect.stringContaining(`afterContainersStopped hook failed: ${PLACEHOLDER}`)
    );
  });

  it('finishes the teardown when removing an unsettled in-flight step rejects with one', async () => {
    vi.useFakeTimers();
    const state = stateWithVolume();
    state.inFlight = {
      settled: new Promise<void>(() => undefined),
      abandon: async () => {
        throw unconvertible();
      },
      subject: { what: 'container x', remedy: 'docker rm -f x' },
    };

    // Settled into a value up front, so a rejection while the timers advance is
    // this case's failure rather than an unhandled one.
    const outcome = cleanupEcsRun(state, { keepRunning: false }).then(
      () => 'resolved',
      (err: unknown) => err
    );
    await vi.advanceTimersByTimeAsync(IN_FLIGHT_STEP_TIMEOUT_MS);

    expect(await outcome).toBe('resolved');
    expect(removedVolume()).toBe(true);
    expect(debugs()).toContainEqual(
      expect.stringContaining(`in-flight step removal failed: ${PLACEHOLDER}`)
    );
    expect(warnSpy.mock.calls.map((c: unknown[]) => String(c[0]))).toContainEqual(
      expect.stringContaining('The in-flight docker command did not finish within')
    );
  });

  it('finishes the teardown when stopping a log stream throws one', async () => {
    const state = stateWithVolume();
    let hookRan = false;
    state.logStreams.push({
      containerId: 'cid-a',
      stream: {
        stop: () => {
          throw unconvertible();
        },
        drain: async () => true,
      },
    });

    await expect(
      cleanupEcsRun(state, {
        keepRunning: true,
        afterContainersStopped: async () => {
          hookRan = true;
        },
      })
    ).resolves.toBeUndefined();

    expect(hookRan).toBe(true);
    expect(removedVolume()).toBe(true);
    expect(debugs()).toContainEqual(
      expect.stringContaining(`log stream stop failed: ${PLACEHOLDER}`)
    );
  });

  it('finishes the teardown when draining a log stream rejects with one', async () => {
    const state = stateWithVolume();
    state.logStreams.push({
      containerId: 'cid-a',
      stream: {
        stop: () => undefined,
        drain: async () => {
          throw unconvertible();
        },
      },
    });

    await expect(cleanupEcsRun(state, { keepRunning: false })).resolves.toBeUndefined();

    expect(removedVolume()).toBe(true);
    expect(debugs()).toContainEqual(
      expect.stringContaining(`log stream drain failed: ${PLACEHOLDER}`)
    );
  });
});
