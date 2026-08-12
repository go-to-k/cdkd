/// <reference types="node" />

import { afterEach, beforeEach, vi } from 'vite-plus/test';

/**
 * Runtime `*Once`-leak detector (issue #1618).
 *
 * ## The defect this detects
 *
 * `vi.clearAllMocks()` clears call RECORDS but does NOT drain the queue seeded
 * by `mockResolvedValueOnce` and friends (`@vitest/spy`: `mockReset` sets
 * `config.onceMockImplementations = []`, `mockClear` does not). So a test that
 * primes more responses than its code path consumes leaves the remainder
 * queued, and a LATER test receives that leftover as a response to one of its
 * own calls — every later call in that test shifted by the same offset.
 *
 * The shifted test does not error. It takes a different branch and then
 * satisfies its own assertions, because the assertions on that branch are
 * usually ABSENCE assertions (`toBeUndefined()`, `not.toHaveBeenCalled()`),
 * and an absence assertion is satisfied both by "the guard correctly declined"
 * and by "the code never got there". In issue #1588 the only symptom was one
 * `logger.warn` that was never called.
 *
 * ## What exactly is flagged
 *
 * A primed value CONSUMED BY A DIFFERENT TEST than the one that primed it.
 *
 * That is the defect, and flagging it has no false positives by construction.
 * The tempting alternative — "a queue that is still non-empty when the test
 * ends" — is a proxy, and a wrong one: a suite that drains with `mockReset()`
 * in `beforeEach` (exactly the remediation this repo prescribes) is still
 * non-empty at the END of each test, because a setup-file `afterEach` runs
 * BEFORE the next test's `beforeEach`. Measured, not reasoned about: the
 * pending-based version flagged such a suite on the first probe. An
 * over-priming that nothing ever consumes is likewise harmless, and is not
 * reported.
 *
 * ## How the count is exact
 *
 * Every `*Once` primer in `@vitest/spy` funnels through the single method
 * `mock.mockImplementationOnce` — `mockReturnValueOnce`, `mockResolvedValueOnce`,
 * `mockRejectedValueOnce` and `mockThrowOnce` are all thin wrappers over it
 * (verified in `@vitest/spy@4.1.10` dist, lines 90-141). So instrumenting that
 * one method covers all five spellings. Each queued implementation is wrapped
 * in a closure that remembers WHICH test primed it and compares that against
 * the test running when it is finally shifted off the queue (dist line 303
 * shifts exactly once per invocation while the queue is non-empty).
 *
 * A value primed outside any test — in `beforeAll` / `afterAll`, where there is
 * no owning test — is never flagged, because there is no cross-test boundary to
 * cross.
 *
 * ## Gating
 *
 * OFF unless `CDKD_ONCE_LEAK_DETECT=1`. When off, nothing is wrapped and no
 * hooks are registered, so the default test run is byte-for-byte unaffected —
 * which is what lets this land while other branches are mid-flight instead of
 * waiting for a quiet tree.
 *
 *   CDKD_ONCE_LEAK_DETECT=1     fail any test that consumes another test's
 *                               primed value, unless its file is allow-listed
 *   CDKD_ONCE_LEAK_SNAPSHOT=dir record findings as JSON files in `dir` instead
 *                               of failing (used to regenerate the allow-list)
 */

export interface OnceLeak {
  /** Test file the leak was observed in, repo-relative with forward slashes. */
  readonly file: string;
  /** The test that CONSUMED the stale value — the one whose result is corrupt. */
  readonly test: string;
  /** The test that PRIMED it — the one whose priming needs fixing. */
  readonly primedBy: string;
  /** `getMockName()` of the mock involved — `vi.fn()` when never named. */
  readonly mock: string;
}

export interface OnceLeakStats {
  /** Mocks that were instrumented (i.e. passed through `vi.fn` / `vi.spyOn`). */
  mocksInstrumented: number;
  /** Total `*Once` primings observed across the run. */
  primings: number;
  /** Total primed values actually consumed by a call. */
  consumptions: number;
  /** Consumptions that crossed a test boundary — the defect. */
  crossTestConsumptions: number;
}

interface TestToken {
  readonly file: string;
  readonly name: string;
}

interface MockLike {
  mockImplementationOnce: (implementation: (...args: any[]) => any) => MockLike;
  getMockName: () => string;
}

const INSTRUMENTED = Symbol.for('cdkd.onceLeak.instrumented');

/**
 * The test currently executing, or null between tests. Identity comparison
 * against this is what distinguishes "consumed by its owner" from "consumed by
 * a later test"; a fresh object per test means two tests with the same name
 * still compare as different.
 */
let currentTest: TestToken | null = null;

/** Findings accumulated during the current test, keyed by nothing — order only. */
let findings: OnceLeak[] = [];

const stats: OnceLeakStats = {
  mocksInstrumented: 0,
  primings: 0,
  consumptions: 0,
  crossTestConsumptions: 0,
};

/** Test-only accessor for the instrumentation counters. */
export const getOnceLeakStats = (): OnceLeakStats => stats;

/** Test-only reset of the counters and any in-flight state. */
export const resetOnceLeakStats = (): void => {
  stats.mocksInstrumented = 0;
  stats.primings = 0;
  stats.consumptions = 0;
  stats.crossTestConsumptions = 0;
  findings = [];
  currentTest = null;
};

const toRepoRelative = (file: string): string => {
  const normalized = file.replaceAll('\\', '/');
  const marker = normalized.lastIndexOf('/tests/');
  return marker === -1 ? normalized : normalized.slice(marker + 1);
};

/** Mark the start of a test. Exported so the unit tests can drive it directly. */
export const beginTest = (file: string, name: string): void => {
  currentTest = { file: toRepoRelative(file), name };
  findings = [];
};

/** Mark the end of a test and take whatever it accumulated. */
export const endTest = (): OnceLeak[] => {
  const collected = findings;
  findings = [];
  currentTest = null;
  return collected;
};

/**
 * Wrap a mock's `mockImplementationOnce` so each queued value remembers the
 * test that primed it.
 *
 * Idempotent: a mock handed to `vi.fn(existingMock)` (which returns it
 * unchanged) or spied twice is only instrumented once.
 */
export const instrumentMock = <T>(candidate: T): T => {
  const mock = candidate as unknown as MockLike & { [INSTRUMENTED]?: boolean };

  if (
    mock == null ||
    typeof mock.mockImplementationOnce !== 'function' ||
    mock[INSTRUMENTED] === true
  ) {
    return candidate;
  }

  mock[INSTRUMENTED] = true;
  stats.mocksInstrumented += 1;

  const primeOnce = mock.mockImplementationOnce.bind(mock);
  mock.mockImplementationOnce = ((implementation: (...args: any[]) => any) => {
    stats.primings += 1;
    const owner = currentTest;

    // `new.target` is forwarded through `Reflect.construct` rather than
    // swallowed by an `.apply`, because the primers' own bodies branch on it
    // (`mockResolvedValueOnce` throws when constructed) and constructor mocks
    // rely on it. An arrow implementation stays non-constructable exactly as it
    // was before this wrapper.
    function consumeOnce(this: unknown, ...args: unknown[]) {
      stats.consumptions += 1;

      // `owner === null` means the value was primed outside any test
      // (`beforeAll` / `afterAll`), which no test can be blamed for and which
      // crosses no boundary. `currentTest === null` means it is being consumed
      // outside a test, likewise unattributable.
      if (owner !== null && currentTest !== null && owner !== currentTest) {
        stats.crossTestConsumptions += 1;
        findings.push({
          file: currentTest.file,
          test: currentTest.name,
          primedBy: owner.name,
          mock: typeof mock.getMockName === 'function' ? mock.getMockName() : 'vi.fn()',
        });
      }

      if (new.target) {
        return Reflect.construct(implementation, args, new.target);
      }
      return implementation.apply(this, args);
    }

    return primeOnce(consumeOnce);
  }) as MockLike['mockImplementationOnce'];

  return candidate;
};

const formatLeaks = (leaks: readonly OnceLeak[]): string => {
  const primers = [...new Set(leaks.map((leak) => leak.primedBy))];

  return [
    `This test consumed ${leaks.length === 1 ? 'a mock response' : `${leaks.length} mock responses`} ` +
      'primed by an EARLIER test.',
    '',
    ...primers.map((primer) => `  - primed by: ${primer}`),
    ...[...new Set(leaks.map((leak) => leak.mock))].map((mock) => `  - mock: ${mock}`),
    '',
    'The earlier test primed more `*Once` values than its code path consumed, and',
    '`vi.clearAllMocks()` does NOT drain that queue (only `mockReset()` does). So',
    'this test received the leftover as one of its own responses, and every later',
    'call it makes is shifted by the same offset — which usually still PASSES,',
    'because absence assertions are satisfied by "never got there" too.',
    '',
    'Fix the EARLIER test: prime exactly what its code path consumes. If the extra',
    'priming is deliberate, drain it with `mockReset()` in `beforeEach`.',
    'See issue #1618.',
  ].join('\n');
};

let allowList: ReadonlySet<string> | undefined;

const loadAllowList = async (): Promise<ReadonlySet<string>> => {
  if (allowList) {
    return allowList;
  }

  try {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(resolve(here, 'once-leak-allowlist.json'), 'utf8');
    const parsed = JSON.parse(raw) as { files?: string[] };
    allowList = new Set(parsed.files ?? []);
  } catch {
    // A missing or unreadable allow-list must not silently disable the
    // detector — an empty set means "nothing is grandfathered", which fails
    // loudly rather than passing vacuously.
    allowList = new Set<string>();
  }

  return allowList;
};

const recordSnapshot = async (leaks: readonly OnceLeak[], dir: string): Promise<void> => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');

  mkdirSync(dir, { recursive: true });

  // One file per report, named from the content, so the parallel workers never
  // race on a shared file and a re-run overwrites rather than duplicates.
  const key = `${leaks[0]?.file ?? 'unknown'}::${leaks[0]?.test ?? ''}`;
  const safe = key.replaceAll(/[^a-zA-Z0-9]+/g, '_').slice(0, 180);
  writeFileSync(resolve(dir, `${safe}.json`), JSON.stringify(leaks), 'utf8');
};

/**
 * Install the detector. A no-op unless `CDKD_ONCE_LEAK_DETECT=1`, which is what
 * keeps the default run and every in-flight branch unaffected.
 */
export const installOnceLeakDetector = (): void => {
  if (process.env.CDKD_ONCE_LEAK_DETECT !== '1') {
    return;
  }

  const originalFn = vi.fn.bind(vi);
  vi.fn = ((implementation?: never) => instrumentMock(originalFn(implementation))) as typeof vi.fn;

  const originalSpyOn = vi.spyOn.bind(vi) as (...args: unknown[]) => unknown;
  vi.spyOn = ((...args: unknown[]) =>
    instrumentMock(originalSpyOn(...args))) as unknown as typeof vi.spyOn;

  // Registered from the setup file, so this `beforeEach` runs BEFORE any
  // suite-level one (outer-to-inner) and this `afterEach` runs AFTER any
  // suite-level one (inner-to-outer). That ordering is deliberate: it means a
  // value primed by a suite's own `beforeEach` is owned by the test it runs
  // for, and a suite that tears down in `afterEach` has already done so before
  // the report is taken.
  beforeEach((context) => {
    beginTest(context.task.file?.filepath ?? '<unknown>', context.task.name);
  });

  afterEach(async () => {
    const leaks = endTest();

    if (leaks.length === 0) {
      return;
    }

    const snapshotDir = process.env.CDKD_ONCE_LEAK_SNAPSHOT;
    if (snapshotDir) {
      await recordSnapshot(leaks, snapshotDir);
      return;
    }

    const allowed = await loadAllowList();
    if (allowed.has(leaks[0].file)) {
      return;
    }

    throw new Error(formatLeaks(leaks));
  });
};
