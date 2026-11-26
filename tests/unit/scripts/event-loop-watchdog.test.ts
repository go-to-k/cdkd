/**
 * go-to-k/cdkd#7042: a provider wait that a test never satisfies, beside a
 * sleep double resolving at once, spins on microtasks and starves vitest's
 * timeout timer, so the run hung (an hour on a remote runner) instead of
 * failing. `tests/event-loop-watchdog.ts` kills such a worker. This test runs
 * vitest on `event-loop-watchdog-fixture.test.ts`, through the real setup
 * file, and asserts the hang now fails within its timeout plus the grace,
 * while a yielding wait still fails at vitest's own timeout and a satisfied
 * wait passes.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

import { CONTENDED_CASE_TIMEOUT_MS } from '../../contended-case-timeout.js';
import {
  HOOK_TIMEOUT_FLOOR_MS,
  WATCHDOG_GRACE_MS,
  WATCHDOG_MARKER,
} from '../../event-loop-watchdog.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const FIXTURE = 'tests/unit/scripts/event-loop-watchdog-fixture.test.ts';
// Without the watchdog the fixture's hang runs for the wait's 30-minute
// budget; this backstop stops it first, so a regression fails here instead.
const BACKSTOP_MS = 120_000;
const LEAK_BETWEEN_MS = 2_000;

function vitestBin(): string {
  const manifest = createRequire(import.meta.url).resolve('vite-plus/package.json');
  return join(dirname(manifest), 'dist', 'bin.js');
}

interface ChildRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  elapsedMs: number;
  backstopped: boolean;
}

function runFixture(namePattern: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<ChildRun> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // The parent's vitest worker variables would make the child believe it is a
  // worker of this run.
  for (const name of Object.keys(env)) if (name.startsWith('VITEST')) delete env[name];
  env.CDKD_EVENT_LOOP_WATCHDOG_FIXTURE = '1';
  env.NO_COLOR = '1';
  delete env.CDKD_TEST_WATCHDOG;
  delete env.CDKD_TEST_WATCHDOG_BETWEEN_MS;
  Object.assign(env, extraEnv);

  const started = Date.now();
  // `verbose` prints each case's verdict; `forks` is the pool the watchdog
  // needs (under `threads` its kill stops the whole run).
  const args = [
    vitestBin(),
    'test',
    'run',
    '--reporter=verbose',
    '--pool=forks',
    '-t',
    namePattern,
    FIXTURE,
  ];
  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    env,
    // Its own process group, so the backstop also stops the child's workers.
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  let backstopped = false;
  const killGroup = (): void => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    } catch {
      // The group is already gone.
    }
  };
  const backstop = setTimeout(() => {
    backstopped = true;
    killGroup();
  }, BACKSTOP_MS);
  return new Promise((resolvePromise, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(backstop);
      // A worker left behind by the child must not outlive this test.
      killGroup();
      resolvePromise({ code, signal, output, elapsedMs: Date.now() - started, backstopped });
    });
  });
}

describe('event-loop watchdog (go-to-k/cdkd#7042)', () => {
  it(
    'fails a never-satisfied wait on an instant sleep double within its timeout plus the grace',
    async () => {
      const run = await runFixture('control|hang');
      const context = `exit ${run.code} / ${run.signal}, ${run.elapsedMs} ms:\n${run.output}`;

      expect(run.backstopped, context).toBe(false);
      expect(run.code, context).not.toBe(0);
      // The hang case is the one killed, named in the watchdog's line.
      expect(run.output, context).toContain(
        `${WATCHDOG_MARKER} ${FIXTURE} > event-loop watchdog fixture > hang: a never-satisfied wait whose sleep resolves at once:`
      );
      expect(run.output, context).toMatch(/Worker exited unexpectedly with signal SIGKILL/);
      // The yielding control fails at vitest's own timeout, before any kill.
      expect(run.output, context).toMatch(
        /FAIL .*control: a never-satisfied wait whose sleep yields fails at the test timeout/
      );
      expect(run.output, context).toMatch(/Test timed out in 1000ms/);
      // The satisfied control passes.
      expect(run.output, context).toMatch(/✓ .*control: a wait the third read satisfies passes/);
      // The child's start-up is the rest of the time; the hang itself costs
      // its bound (never below the hook timeout) plus the grace.
      expect(run.elapsedMs, context).toBeLessThan(
        BACKSTOP_MS / 2 + HOOK_TIMEOUT_FLOOR_MS + WATCHDOG_GRACE_MS
      );
    },
    CONTENDED_CASE_TIMEOUT_MS
  );

  it(
    'kills a wait that a failed test left spinning, after the test',
    async () => {
      // The between-tests bound is the suite's hang ceiling; shortened here.
      const run = await runFixture('leak', {
        CDKD_TEST_WATCHDOG_BETWEEN_MS: String(LEAK_BETWEEN_MS),
      });
      const context = `exit ${run.code} / ${run.signal}, ${run.elapsedMs} ms:\n${run.output}`;

      expect(run.backstopped, context).toBe(false);
      expect(run.code, context).not.toBe(0);
      expect(run.output, context).toContain(
        `${WATCHDOG_MARKER} after ${FIXTURE} > event-loop watchdog fixture > leak: a never-satisfied wait the test throws before awaiting:`
      );
      expect(run.output, context).toMatch(/Worker exited unexpectedly with signal SIGKILL/);
      expect(run.elapsedMs, context).toBeLessThan(
        BACKSTOP_MS / 2 + LEAK_BETWEEN_MS + WATCHDOG_GRACE_MS
      );
    },
    CONTENDED_CASE_TIMEOUT_MS
  );
});
