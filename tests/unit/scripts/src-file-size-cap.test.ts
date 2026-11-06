import { describe, it, expect } from 'vite-plus/test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

/**
 * A DOWN-ONLY line cap on `src/**` files.
 *
 * A large file costs every editor twice: an edit has to read far more of it
 * into context, and two lanes touching the same file collide in review and
 * rebase. New files may not exceed `MAX_SRC_FILE_LINES`; the files that already
 * did when the cap was introduced are listed by NAME in
 * `scripts/src-file-size-allowlist.txt`.
 *
 * No line count is recorded per file, deliberately: a recorded count would turn
 * every feature PR that touches a large file into an allowlist edit. The list
 * only names WHICH files are exempt, so ordinary edits never touch it.
 *
 * WHAT TO DO WHEN THIS REDS:
 *   - "not on the allowlist": split the file. Never add it to the list.
 *   - "stale allowlist entry": the file was split (or deleted) to the cap or
 *     below — remove its line from the allowlist in the same change.
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

function allowlist(): string[] {
  return readFileSync(join(repoRoot, 'scripts', 'src-file-size-allowlist.txt'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

describe('src file size cap', () => {
  it('no unlisted src file exceeds the cap', () => {
    const files = srcFiles(join(repoRoot, 'src'));
    // Floor: the walk must actually see the tree, or "0 offenders" is vacuous.
    expect(files.length).toBeGreaterThan(500);
    const listed = new Set(allowlist());
    const offenders = files
      .filter((file) => !listed.has(file))
      .map((file) => ({ file, lines: lineCount(file) }))
      .filter(({ lines }) => lines > MAX_SRC_FILE_LINES)
      .map(({ file, lines }) => `${file} (${lines} lines)`);
    expect(
      offenders,
      `split these files to ${MAX_SRC_FILE_LINES} lines or fewer; do not add them to the allowlist`
    ).toEqual([]);
  });

  it('every allowlist entry still exists and still exceeds the cap', () => {
    const entries = allowlist();
    expect(entries.length).toBeGreaterThan(0);
    const existing = new Set(srcFiles(join(repoRoot, 'src')));
    const stale = entries.filter(
      (file) => !existing.has(file) || lineCount(file) <= MAX_SRC_FILE_LINES
    );
    expect(stale, 'remove these stale entries from scripts/src-file-size-allowlist.txt').toEqual(
      []
    );
  });

  it('the allowlist has no duplicate entries', () => {
    const entries = allowlist();
    const duplicates = entries.filter((entry, i) => entries.indexOf(entry) !== i);
    expect(duplicates, 'remove the duplicate allowlist entries').toEqual([]);
  });
});
