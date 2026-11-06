import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The fewest files `cdkd scrub` is made of: `scrub.ts` plus the 20 modules it
 * was split into (go-to-k/cdkd#5835). A read that lists fewer has stopped
 * seeing the directory, and every fence reading through it would pass over
 * nothing.
 */
export const SCRUB_SOURCE_FILE_FLOOR = 21;

/**
 * `entry` followed by every `.ts` file under `dir`, subdirectories included,
 * sorted. `dir` must end in `/`.
 */
export function entryAndModules(entry: string, dir: string): string[] {
  return [
    entry,
    ...readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts'))
      .map((name) => name.split('\\').join('/'))
      .sort()
      .map((name) => `${dir}${name}`),
  ];
}

/**
 * The source files of `cdkd scrub`: `src/cli/commands/scrub.ts` and every
 * `.ts` module under `src/cli/commands/scrub/`, subdirectories included. The
 * directory is read recursively, so a new module or subdirectory is never
 * missed. Source fences that once read the single file read these. Throws
 * below {@link SCRUB_SOURCE_FILE_FLOOR}.
 */
export function scrubSourceFiles(): string[] {
  const files = entryAndModules(
    fileURLToPath(new URL('../../../src/cli/commands/scrub.ts', import.meta.url)),
    fileURLToPath(new URL('../../../src/cli/commands/scrub/', import.meta.url))
  );
  if (files.length < SCRUB_SOURCE_FILE_FLOOR) {
    throw new Error(
      `the scrub source read listed ${files.length} file(s), fewer than ` +
        `${SCRUB_SOURCE_FILE_FLOOR}: it stopped seeing src/cli/commands/scrub/`
    );
  }
  return files;
}

/**
 * The same files as repo-relative paths (`src/cli/commands/scrub/stack.ts`),
 * for fences keyed by path.
 */
export function scrubSourcePaths(): string[] {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  return scrubSourceFiles().map((file) => file.slice(root.length));
}

/** Every `cdkd scrub` source file's text, joined in {@link scrubSourceFiles} order. */
export function readScrubSource(): string {
  return scrubSourceFiles()
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
}
