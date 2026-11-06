/**
 * The read every `cdkd scrub` source fence goes through
 * (`tests/unit/cli/_scrub-source.ts`, go-to-k/cdkd#5835). A read that missed a
 * module, or a subdirectory, would let each of those fences pass over code it
 * never saw.
 */
import { describe, it, expect } from 'vite-plus/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SCRUB_SOURCE_FILE_FLOOR,
  entryAndModules,
  readScrubSource,
  scrubSourcePaths,
} from './_scrub-source.js';

describe('the cdkd scrub source read', () => {
  it('lists at least the split modules, the scrubStack family among them', () => {
    const paths = scrubSourcePaths();
    expect(paths.length).toBeGreaterThanOrEqual(SCRUB_SOURCE_FILE_FLOOR);
    expect(paths[0]).toBe('src/cli/commands/scrub.ts');
    for (const module of ['stack', 'stack-resolve', 'stack-rewrite', 'command', 'command-loop']) {
      expect(paths).toContain(`src/cli/commands/scrub/${module}.ts`);
    }
    // The text is every file's, not the entry's alone.
    expect(readScrubSource()).toContain('async function scrubStackResolvePass(');
  });

  it('reads a module planted in a SUBDIRECTORY, and only .ts files', () => {
    const root = mkdtempSync(join(tmpdir(), 'cdkd-scrub-source-'));
    try {
      const dir = join(root, 'scrub') + '/';
      mkdirSync(join(dir, 'nested', 'deeper'), { recursive: true });
      writeFileSync(join(root, 'scrub.ts'), '');
      writeFileSync(join(dir, 'a.ts'), '');
      writeFileSync(join(dir, 'nested', 'b.ts'), '');
      writeFileSync(join(dir, 'nested', 'deeper', 'c.ts'), '');
      writeFileSync(join(dir, 'nested', 'notes.md'), '');

      expect(entryAndModules(join(root, 'scrub.ts'), dir)).toEqual([
        join(root, 'scrub.ts'),
        `${dir}a.ts`,
        `${dir}nested/b.ts`,
        `${dir}nested/deeper/c.ts`,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
