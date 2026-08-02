import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Source-level ordering pins (issue #1348): every lock-taking interrupt-
// sensitive code path must register its SIGINT handler BEFORE acquiring the
// stack lock. A signal landing during the acquisition's S3 round-trip then
// flips the graceful-drain flag (lock released via the normal `finally`)
// instead of killing the process with the just-written lock stranded for its
// full TTL. Without these pins a refactor could silently reintroduce the
// acquire-then-register order this issue fixed.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function liveSource(relPath: string): string {
  const src = readFileSync(join(repoRoot, relPath), 'utf8');
  // Live lines only — a commented-out call must fail the pin.
  return src
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

describe('SIGINT handler registration precedes lock acquisition (issue #1348)', () => {
  const sites: Array<{ file: string; register: string; acquire: string }> = [
    {
      file: 'src/cli/commands/destroy-runner.ts',
      register: "process.on('SIGINT', sigintHandler)",
      acquire: '.acquireLock(',
    },
    {
      file: 'src/deployment/deploy-engine.ts',
      register: "process.on('SIGINT', sigintHandler)",
      acquire: '.acquireLockWithRetry(',
    },
    {
      file: 'src/cli/commands/rollback.ts',
      register: "process.on('SIGINT', sigintHandler)",
      acquire: '.acquireLockWithRetry(',
    },
  ];

  it.each(sites)('$file registers the handler before acquiring the lock', ({
    file,
    register,
    acquire,
  }) => {
    const live = liveSource(file);
    const registerIdx = live.indexOf(register);
    const acquireIdx = live.indexOf(acquire);
    expect(registerIdx, `${file}: SIGINT registration not found`).toBeGreaterThan(-1);
    expect(acquireIdx, `${file}: lock acquisition not found`).toBeGreaterThan(-1);
    expect(
      registerIdx,
      `${file}: SIGINT handler must be registered BEFORE the lock acquisition`
    ).toBeLessThan(acquireIdx);
  });

  it('each site cleans the listener up when the acquire itself fails', () => {
    // With registration moved before the acquire, an acquire failure (lock
    // conflict) happens before the try/finally that owns the listener
    // removal — each site must remove the handler in a catch around the
    // acquire so the listener does not leak.
    for (const file of [
      'src/cli/commands/destroy-runner.ts',
      'src/deployment/deploy-engine.ts',
      'src/cli/commands/rollback.ts',
    ]) {
      const live = liveSource(file);
      const acquireIdx = live.indexOf('.acquireLock');
      const window = live.slice(acquireIdx, acquireIdx + 600);
      expect(
        window.includes("process.removeListener('SIGINT', sigintHandler)"),
        `${file}: no listener cleanup in the acquire-failure catch`
      ).toBe(true);
    }
    // rollback registers the #1342 SIGTERM forwarder alongside its SIGINT
    // handler, so its acquire-failure catch must unregister BOTH.
    const rollbackLive = liveSource('src/cli/commands/rollback.ts');
    const rollbackAcquireIdx = rollbackLive.indexOf('.acquireLock');
    expect(
      rollbackLive.slice(rollbackAcquireIdx, rollbackAcquireIdx + 600).includes('unforwardSigterm()'),
      'rollback.ts: acquire-failure catch must also unregister the SIGTERM forwarder'
    ).toBe(true);
  });

  it("destroy-runner gates the force-quit best-effort release on lock ownership", () => {
    // `releaseLock` deletes the lock key unconditionally. Before OUR acquire
    // succeeds, the key may belong to another process (that is exactly what
    // a conflicting acquire is waiting on), so the second-signal force-quit
    // path must only fire the best-effort release once the lock is ours.
    const live = liveSource('src/cli/commands/destroy-runner.ts');
    expect(live.includes('let lockHeld = false')).toBe(true);
    expect(live.includes('lockHeld = true')).toBe(true);
    expect(live.includes('if (lockHeld) {')).toBe(true);
    // The gate must come before the best-effort release call in the handler.
    const gateIdx = live.indexOf('if (lockHeld) {');
    const releaseIdx = live.indexOf('void ctx.lockManager.releaseLock(');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(releaseIdx).toBeGreaterThan(gateIdx);
  });
});
