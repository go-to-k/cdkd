import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, uptime } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vite-plus/test/node';

/**
 * Vitest `globalSetup`: lets only ONE large run proceed per machine at a
 * time; any other large run waits here until it ends.
 *
 * WHY. Every run starts up to `cpus - 1` forks, and many forks spawn child
 * processes of their own: script CLIs, and the paste harness's bash and zsh
 * per span (`tests/unit/utils/paste-harness.ts`). Parallel agent lanes each
 * running the full suite from their own worktree froze a 48 GB host; the
 * written rule "lanes do not run the full suite" did not hold. A lock on full
 * runs alone (more than 25% of the files) did not hold either: one lane's
 * `tests/unit` ran beside two lanes' `tests/unit/deployment` runs (~20% of the
 * files each, so never waiting), spawning ~5,000 processes a second, and the
 * host crashed again. So a run counts as large when its filters select more
 * than `LARGE_RUN_FILES` test files — any directory-sized run (a filter such
 * as `tests/unit` is a substring match over nearly everything). Targeted runs,
 * watch mode, `--changed` / `related`, and a run spawned by a suite that
 * already holds the lock (`HOLDER_ENV`) never wait.
 *
 * The lock is a directory under the user temp root, shared by every worktree.
 * A holder that died without teardown is taken over: its pid is gone, is no
 * longer a node process, or was recorded before the last reboot. Two waiters
 * seeing the same dead holder in the same instant may both take it; that rare
 * overlap is two suites, not the unbounded pile-up this prevents.
 */

export const HOLDER_ENV = 'CDKD_FULL_SUITE_LOCK_HOLDER';
const POLL_MS = 5_000;
/** An owner file not written this long after the directory was made means its writer died. */
const OWNERLESS_STALE_MS = 60_000;
/** Boot times computed from `uptime()` drift by a little; a reboot moves them by far more. */
const BOOT_TOLERANCE_MS = 60_000;
/**
 * Above any targeted run's file count, below every `tests/unit/<area>` directory with more than one
 * paste-harness caller; an area under it (`assets`, `local`, `synthesis`) holds one caller and runs unlocked.
 */
export const LARGE_RUN_FILES = 50;

export interface LockOwner {
  pid: number;
  cwd: string;
  bootMs: number;
}

export function bootTimeMs(): number {
  return Date.now() - uptime() * 1000;
}

export function defaultLockDir(): string {
  return join(tmpdir(), 'cdkd-full-suite.lock');
}

function isLiveHolder(owner: LockOwner): boolean {
  if (Math.abs(owner.bootMs - bootTimeMs()) > BOOT_TOLERANCE_MS) return false;
  // `args`, not `comm`: on Linux `comm` is the main thread's name, which node sets to `MainThread`.
  const ps = spawnSync('ps', ['-o', 'args=', '-p', String(owner.pid)], { encoding: 'utf8' });
  if (ps.error) {
    try {
      process.kill(owner.pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
  return ps.status === 0 && /node/.test(ps.stdout);
}

function readOwner(lockDir: string): LockOwner | undefined {
  try {
    return JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')) as LockOwner;
  } catch {
    return undefined;
  }
}

/** Takes the lock and returns undefined, or returns the live holder that has it. */
export function tryAcquire(lockDir: string, owner: LockOwner): LockOwner | undefined {
  try {
    mkdirSync(lockDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const holder = readOwner(lockDir);
    if (holder === undefined) {
      let age: number;
      try {
        age = Date.now() - statSync(lockDir).mtimeMs;
      } catch {
        return tryAcquire(lockDir, owner); // released between mkdir and stat
      }
      if (age < OWNERLESS_STALE_MS) return { pid: -1, cwd: '(starting)', bootMs: owner.bootMs };
    } else if (isLiveHolder(holder)) {
      return holder;
    }
    rmSync(lockDir, { recursive: true, force: true });
    return tryAcquire(lockDir, owner);
  }
  try {
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify(owner));
  } catch (e) {
    // A peer judged the lock stale and removed it between our mkdir and write.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return tryAcquire(lockDir, owner);
    throw e;
  }
  return undefined;
}

/** Removes the lock only when `pid` still owns it. */
export function release(lockDir: string, pid: number): void {
  if (readOwner(lockDir)?.pid === pid) rmSync(lockDir, { recursive: true, force: true });
}

export async function isFullSuiteRun(project: TestProject): Promise<boolean> {
  const { config } = project.vitest;
  if (config.watch || config.changed || (config.related?.length ?? 0) > 0) return false;
  const filters = (project.vitest as unknown as { filenamePattern?: string[] }).filenamePattern;
  if (!filters?.length) return true;
  const selected = await project.vitest.globTestSpecifications(filters);
  return selected.length > LARGE_RUN_FILES;
}

export default async function setup(project: TestProject): Promise<(() => void) | undefined> {
  if (process.env[HOLDER_ENV] !== undefined || !(await isFullSuiteRun(project))) return undefined;
  const lockDir = defaultLockDir();
  const self: LockOwner = { pid: process.pid, cwd: process.cwd(), bootMs: bootTimeMs() };
  let announced: number | undefined;
  for (;;) {
    const holder = tryAcquire(lockDir, self);
    if (holder === undefined) break;
    if (announced !== holder.pid) {
      announced = holder.pid;
      console.error(
        `[cdkd] waiting: a large test run is already running (pid ${holder.pid}, ${holder.cwd}). ` +
          `One run of more than ${LARGE_RUN_FILES} files runs per machine; run targeted files meanwhile (tests/full-suite-lock-setup.ts).`
      );
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  process.env[HOLDER_ENV] = String(process.pid);
  return () => {
    delete process.env[HOLDER_ENV];
    release(lockDir, process.pid);
  };
}
