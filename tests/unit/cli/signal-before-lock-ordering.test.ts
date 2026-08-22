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
//
// Issue #2171 widened the unit from FILE to SITE. `destroy-runner.ts` now
// takes the lock in TWO places — the main destroy and the 0-resource
// state-cleanup branch — each with its own handler, and a file-level
// `indexOf` pinned the FIRST registration against the FIRST acquire, which
// after that change were from different sites. The pin still fired (loudly,
// and correctly: the first cut of #2171 really had added an unguarded
// acquire), but for the wrong reason, and it would have gone quiet again the
// moment the two happened to be ordered coincidentally. Pairing each acquire
// with its own handler is what makes the pin mean what it says.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function liveSource(relPath: string): string {
  const src = readFileSync(join(repoRoot, relPath), 'utf8');
  // Live lines only — a commented-out call must fail the pin.
  return src
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/**
 * One lock-taking site: the handler IDENTIFIER it registers, the acquire call
 * it makes, and how many times that acquire is expected to appear.
 *
 * The handler name is what pairs the two — a site must register and unregister
 * the SAME identifier, so a second site copying the first's handler name would
 * fail the "registers before acquiring" pin rather than silently inheriting a
 * handler that is not its own.
 */
interface LockSite {
  file: string;
  label: string;
  handler: string;
  acquire: string;
  /** Extra symbols the acquire-failure path must also clean up. */
  alsoUnregisters?: string[];
}

const sites: LockSite[] = [
  {
    file: 'src/cli/commands/destroy-runner.ts',
    label: 'empty-state cleanup (issue #2171)',
    handler: 'emptySigintHandler',
    acquire: 'ctx.lockManager.acquireLock(',
  },
  {
    file: 'src/cli/commands/destroy-runner.ts',
    label: 'main destroy',
    handler: 'sigintHandler',
    acquire: 'ctx.lockManager.acquireLock(',
  },
  {
    file: 'src/deployment/deploy-engine.ts',
    label: 'deploy',
    handler: 'sigintHandler',
    acquire: '.acquireLockWithRetry(',
  },
  {
    file: 'src/cli/commands/rollback.ts',
    label: 'rollback',
    handler: 'sigintHandler',
    acquire: '.acquireLockWithRetry(',
    // The #1342 SIGTERM forwarder is registered alongside, so the
    // acquire-failure path must unregister BOTH.
    alsoUnregisters: ['unforwardSigterm()'],
  },
];

describe('SIGINT handler registration precedes lock acquisition (issue #1348)', () => {
  it.each(sites)('$file / $label registers its handler before acquiring', (site) => {
    const live = liveSource(site.file);
    const registerIdx = live.indexOf(`process.on('SIGINT', ${site.handler})`);
    expect(
      registerIdx,
      `${site.file} / ${site.label}: registration of ${site.handler} not found`
    ).toBeGreaterThan(-1);

    // The acquire this site OWNS is the first one at or after its own
    // registration — that pairing is what the file-level indexOf could not do.
    const acquireIdx = live.indexOf(site.acquire, registerIdx);
    expect(
      acquireIdx,
      `${site.file} / ${site.label}: no lock acquisition after the ${site.handler} registration — ` +
        `either the handler is registered AFTER the acquire (the issue #1348 defect) or the site is gone`
    ).toBeGreaterThan(-1);
  });

  it.each(sites)('$file / $label cleans its listener up when the acquire fails', (site) => {
    // The acquire happens BEFORE the try/finally that owns the listener
    // removal, so an acquire failure (a held lock) must remove the handler
    // explicitly or the listener leaks.
    const live = liveSource(site.file);
    const registerIdx = live.indexOf(`process.on('SIGINT', ${site.handler})`);
    const acquireIdx = live.indexOf(site.acquire, registerIdx);
    const window = live.slice(acquireIdx, acquireIdx + 900);
    expect(
      window.includes(`process.removeListener('SIGINT', ${site.handler})`),
      `${site.file} / ${site.label}: no ${site.handler} cleanup on the acquire-failure path`
    ).toBe(true);
    for (const also of site.alsoUnregisters ?? []) {
      expect(
        window.includes(also),
        `${site.file} / ${site.label}: acquire-failure path must also run ${also}`
      ).toBe(true);
    }
  });

  it('covers every acquire site in the pinned files', () => {
    // Non-vacuity: a NEW lock-taking site added to one of these files must be
    // added to `sites` too, or it inherits no pin at all — which is exactly
    // how issue #2171's first cut shipped an acquire with no handler.
    const perFile = new Map<string, number>();
    for (const site of sites) perFile.set(site.file, (perFile.get(site.file) ?? 0) + 1);

    for (const [file, expected] of perFile) {
      const live = liveSource(file);
      const acquires = live.split(/\.acquireLock(?:WithRetry)?\(/).length - 1;
      expect(
        acquires,
        `${file}: ${acquires} lock acquisition(s) in source but ${expected} pinned — ` +
          `add the new site to \`sites\` (with its own SIGINT handler)`
      ).toBe(expected);
    }
  });

  it('destroy-runner gates every force-quit best-effort release on lock ownership', () => {
    // `releaseLock` deletes the lock key unconditionally. Before OUR acquire
    // succeeds the key may belong to another process (that is exactly what a
    // conflicting acquire is waiting on), so each force-quit path must only
    // fire the best-effort release once ITS lock is ours.
    const live = liveSource('src/cli/commands/destroy-runner.ts');
    for (const flag of ['lockHeld', 'emptyLockHeld']) {
      expect(live.includes(`let ${flag} = false`), `${flag} not declared false`).toBe(true);
      expect(live.includes(`${flag} = true`), `${flag} never set`).toBe(true);
      const gateIdx = live.indexOf(`if (${flag}) {`);
      expect(gateIdx, `${flag}: no ownership gate in a force-quit handler`).toBeGreaterThan(-1);
      const releaseIdx = live.indexOf('void ctx.lockManager.releaseLock(', gateIdx);
      expect(
        releaseIdx,
        `${flag}: best-effort release must come AFTER the ownership gate`
      ).toBeGreaterThan(gateIdx);
    }
  });
});
