import { describe, it, expect } from 'vite-plus/test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

/**
 * A line cap on `src/**` files.
 *
 * A large file costs every editor twice: an edit has to read far more of it
 * into context, and two lanes touching the same file collide in review and
 * rebase. No `src/**` file (tests and `*.generated.ts` excluded) may exceed
 * `MAX_SRC_FILE_LINES`. The files that did when the cap was introduced were
 * split in go-to-k/cdkd#5835, which emptied and retired the shrink-only
 * allowlist that exempted them; there is no exemption list now.
 *
 * WHAT TO DO WHEN THIS REDS: split the file into a companion directory (the
 * `<stem>.ts` entry plus `<stem>/` modules, see the #5835 splits). Do not add
 * an exemption.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

const MAX_SRC_FILE_LINES = 1000;

function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...srcFiles(path));
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.generated.ts')
    ) {
      out.push(relative(repoRoot, path).split('\\').join('/'));
    }
  }
  return out;
}

// Same count as `wc -l`: the number of newline characters.
function lineCount(file: string): number {
  return readFileSync(join(repoRoot, file), 'utf8').split('\n').length - 1;
}


describe('src file size cap', () => {
  it('no src file exceeds the cap', () => {
    const files = srcFiles(join(repoRoot, 'src'));
    // Floor: the walk must actually see the tree, or "0 offenders" is vacuous.
    expect(files.length).toBeGreaterThan(500);
    const offenders = files
      .map((file) => ({ file, lines: lineCount(file) }))
      .filter(({ lines }) => lines > MAX_SRC_FILE_LINES)
      .map(({ file, lines }) => `${file} (${lines} lines)`);
    expect(
      offenders,
      `split these files to ${MAX_SRC_FILE_LINES} lines or fewer`
    ).toEqual([]);
  });


});
