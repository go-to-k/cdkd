/**
 * The pasteable-command shape fence skips `.d.ts` files (go-to-k/cdkd#3738).
 *
 * `sourceFiles` walks `.ts` files and excludes declaration files. No
 * self-probe and no file under the real `src/` is a declaration file carrying
 * a reportable shape, so dropping `!entry.endsWith('.d.ts')` left every other
 * case green. Both cases below plant a `quoted-command` literal in a `.d.ts`
 * next to a clean `.ts`: the walk must not list it, and a `--root=` run of the
 * binary must exit 0 with no finding. The mutant lists the file and the run
 * reports it, so each case reds on its own.
 *
 * A separate file rather than a case in `pasteable-command-shapes.test.ts` so
 * this lane does not edit a file another open PR may hold.
 */
import { describe, expect, it } from 'vite-plus/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceFiles } from '../../../scripts/check-pasteable-command-shapes.js';

/** The same bound the sibling suite gives each spawn of the fence binary. */
const SPAWN_TIMEOUT_MS = 90_000;
/** Resolved from this file, never from `process.cwd()`, as the sibling suite does. */
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** A literal the fence reports as `quoted-command` in a `.ts` file. */
const REPORTABLE = "export const m = `Run 'cdkd deploy ${name}' to migrate.`;\n";

function scratchTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'cdkd-pasteable-dts-'));
  writeFileSync(join(root, 'clean.ts'), 'export const m = `nothing to see`;\n', 'utf8');
  mkdirSync(join(root, 'nested'));
  // The fence never parses a file its walk skipped, so the content only has to
  // be a literal it WOULD report — the control case in the second test proves
  // that for the same text in a `.ts` file.
  writeFileSync(join(root, 'nested', 'types.d.ts'), REPORTABLE, 'utf8');
  return root;
}

describe('pasteable-command shape fence skips declaration files (go-to-k/cdkd#3738)', () => {
  it('sourceFiles lists the .ts file and not the .d.ts beside it', () => {
    const root = scratchTree();
    try {
      const listed = sourceFiles(root).map((f) => relative(root, f).split(sep).join('/'));
      expect(listed).toEqual(['clean.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a --root= run over a tree whose only reportable literal is in a .d.ts exits 0', () => {
    const script = fileURLToPath(
      new URL('../../../scripts/check-pasteable-command-shapes.ts', import.meta.url)
    );
    const root = scratchTree();
    try {
      // Premise: the same literal in a `.ts` file IS reported, so the exit 0
      // below comes from the exclusion and not from a literal the fence would
      // never flag.
      writeFileSync(join(root, 'control.ts'), REPORTABLE, 'utf8');
      const control = spawnSync(process.execPath, [script, `--root=${root}`], {
        encoding: 'utf8',
        timeout: SPAWN_TIMEOUT_MS,
        cwd: REPO_ROOT,
      });
      expect(control.status, control.stderr).toBe(1);
      expect(control.stderr).toContain('control.ts');

      rmSync(join(root, 'control.ts'));
      const run = spawnSync(process.execPath, [script, `--root=${root}`], {
        encoding: 'utf8',
        timeout: SPAWN_TIMEOUT_MS,
        cwd: REPO_ROOT,
      });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stderr).not.toContain('types.d.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 200_000);
});
