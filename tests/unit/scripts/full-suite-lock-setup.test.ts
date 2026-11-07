import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import type { TestProject } from 'vite-plus/test/node';
import setup, {
  HOLDER_ENV,
  LARGE_RUN_FILES,
  bootTimeMs,
  isFullSuiteRun,
  release,
  tryAcquire,
} from '../../full-suite-lock-setup.js';

// A pid no live process holds: above the macOS / Linux pid ceilings.
const DEAD_PID = 99_999_999;
const owner = (pid: number, cwd: string) => ({ pid, cwd, bootMs: bootTimeMs() });

function fakeProject(opts: {
  filters?: string[];
  selected?: number;
  watch?: boolean;
  changed?: boolean;
  related?: string[];
  all?: number;
}): TestProject {
  const all = opts.all ?? 100;
  return {
    vitest: {
      config: { watch: opts.watch ?? false, changed: opts.changed ?? false, related: opts.related },
      filenamePattern: opts.filters,
      globTestSpecifications: async (f?: string[]) =>
        new Array(f?.length ? (opts.selected ?? 1) : all).fill(0),
    },
  } as unknown as TestProject;
}

describe('full-suite lock', () => {
  let root: string;
  let lockDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cdkd-suite-lock-'));
    lockDir = join(root, 'cdkd-full-suite.lock');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('takes a free lock and reports the live holder to a second run', () => {
    expect(tryAcquire(lockDir, owner(process.pid, 'a'))).toBeUndefined();
    expect(tryAcquire(lockDir, owner(DEAD_PID, 'b'))).toMatchObject({ pid: process.pid, cwd: 'a' });
  });

  it('takes over a lock whose holder died', () => {
    expect(tryAcquire(lockDir, owner(DEAD_PID, 'dead'))).toBeUndefined();
    expect(tryAcquire(lockDir, owner(process.pid, 'me'))).toBeUndefined();
    expect(tryAcquire(lockDir, owner(DEAD_PID, 'x'))?.cwd).toBe('me');
  });

  it('waits on a fresh ownerless lock but takes over a stale one', () => {
    mkdirSync(lockDir);
    expect(tryAcquire(lockDir, owner(process.pid, 'me'))?.pid).toBe(-1);
    const old = (Date.now() - 120_000) / 1000;
    utimesSync(lockDir, old, old);
    expect(tryAcquire(lockDir, owner(process.pid, 'me'))).toBeUndefined();
  });

  it('treats an unparseable owner file as ownerless', () => {
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'owner.json'), '{');
    expect(tryAcquire(lockDir, owner(process.pid, 'me'))?.pid).toBe(-1);
  });

  it('releases only for the pid that owns it', () => {
    tryAcquire(lockDir, owner(process.pid, 'me'));
    release(lockDir, DEAD_PID);
    expect(existsSync(lockDir)).toBe(true);
    release(lockDir, process.pid);
    expect(existsSync(lockDir)).toBe(false);
  });

  it('takes over a lock recorded before the last reboot, even when its pid is live', () => {
    tryAcquire(lockDir, { pid: process.pid, cwd: 'old-boot', bootMs: bootTimeMs() - 3_600_000 });
    expect(tryAcquire(lockDir, owner(process.pid, 'me'))).toBeUndefined();
    expect(tryAcquire(lockDir, owner(DEAD_PID, 'x'))?.cwd).toBe('me');
  });

  it('takes over a lock whose pid is live but not a node process', () => {
    tryAcquire(lockDir, owner(1, 'launchd'));
    expect(tryAcquire(lockDir, owner(process.pid, 'me'))).toBeUndefined();
  });
});

describe('isFullSuiteRun', () => {
  it('counts an unfiltered run, and a filter selecting more than LARGE_RUN_FILES files, as large', async () => {
    expect(await isFullSuiteRun(fakeProject({}))).toBe(true);
    expect(await isFullSuiteRun(fakeProject({ filters: ['tests/unit'], selected: 90 }))).toBe(true);
    // A directory run is a small share of the suite and still large (the crash this lock missed).
    expect(
      await isFullSuiteRun(fakeProject({ filters: ['tests/unit/deployment'], selected: 470, all: 2356 }))
    ).toBe(true);
    expect(
      await isFullSuiteRun(fakeProject({ filters: ['tests/unit/x'], selected: LARGE_RUN_FILES + 1, all: 2356 }))
    ).toBe(true);
  });

  it('does not count targeted, watch, changed or related runs', async () => {
    expect(await isFullSuiteRun(fakeProject({ filters: ['a.test.ts'], selected: 2 }))).toBe(false);
    expect(await isFullSuiteRun(fakeProject({ filters: ['tests/unit/x'], selected: LARGE_RUN_FILES }))).toBe(false);
    expect(await isFullSuiteRun(fakeProject({ watch: true }))).toBe(false);
    expect(await isFullSuiteRun(fakeProject({ changed: true }))).toBe(false);
    expect(await isFullSuiteRun(fakeProject({ related: ['src/x.ts'] }))).toBe(false);
  });
});

describe('setup', () => {
  afterEach(() => {
    delete process.env[HOLDER_ENV];
  });

  it('skips the lock for a run nested inside a holder', async () => {
    process.env[HOLDER_ENV] = '1';
    expect(await setup(fakeProject({}))).toBeUndefined();
  });

  it('skips the lock for a targeted run', async () => {
    expect(await setup(fakeProject({ filters: ['a.test.ts'] }))).toBeUndefined();
  });
});
