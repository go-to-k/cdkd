/**
 * Issue #3939 sweep — `withResourceDeadline`'s timeout is the one guaranteed
 * way the wrapper settles, and the deploy / destroy engines await it. An
 * operation stuck with nothing else holding the event loop must therefore
 * TIME OUT, not let the loop drain: unref'd, the timer let Node exit 0
 * mid-command with the stack lock held. Only a child process shows the exit.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import { isolatedChildEnv, writeSourceLoaderHooks } from '../source-loader-hooks.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const SPAWN_TIMEOUT_MS = 30_000;

const scratchDirs: string[] = [];
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('withResourceDeadline in a real process (issue #3939)', () => {
  it(
    'an operation that never settles is timed out; the process does not drain and exit 0',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'cdkd-3939-deadline-'));
      scratchDirs.push(dir);
      const hooks = writeSourceLoaderHooks(dir);
      const script = join(dir, 'child.ts');
      const subject = pathToFileURL(join(REPO_ROOT, 'src/deployment/resource-deadline.ts')).href;
      writeFileSync(
        script,
        `import { withResourceDeadline } from ${JSON.stringify(subject)};
async function main() {
  try {
    await withResourceDeadline(() => new Promise(() => {}), {
      warnAfterMs: 10,
      timeoutMs: 50,
      onWarn: () => console.log('warned'),
      onTimeout: (ms) => new Error('timed out'),
    });
  } catch (error) {
    console.log('caught ' + error.message);
    process.exit(3);
  }
}
main();
`
      );
      const proc = spawnSync(
        process.execPath,
        ['--experimental-strip-types', '--no-warnings', '--import', pathToFileURL(hooks).href, script],
        { encoding: 'utf8', cwd: REPO_ROOT, timeout: SPAWN_TIMEOUT_MS, env: isolatedChildEnv() }
      );
      const context = `status ${String(proc.status)}, stderr:\n${proc.stderr}`;
      // Before the fix: status 0 and no output — the loop drained at once.
      expect(proc.stdout, context).toBe('warned\ncaught timed out\n');
      expect(proc.status, context).toBe(3);
    },
    SPAWN_TIMEOUT_MS + 5_000
  );
});
