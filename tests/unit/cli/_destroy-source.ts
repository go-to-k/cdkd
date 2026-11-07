import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { entryAndModules } from './_scrub-source.js';

/**
 * The fewest files `cdkd destroy` is made of: `destroy.ts` plus the 3 modules
 * it was split into (go-to-k/cdkd#5835). A read that lists fewer has stopped
 * seeing the directory, and every fence reading through it would pass over
 * nothing.
 */
export const DESTROY_SOURCE_FILE_FLOOR = 4;

/**
 * The source files of `cdkd destroy`: `src/cli/commands/destroy.ts` and every
 * `.ts` module under `src/cli/commands/destroy/`, subdirectories included. The
 * directory is read recursively, so a new module or subdirectory is never
 * missed. Source fences that once read the single file read these. Throws
 * below {@link DESTROY_SOURCE_FILE_FLOOR}.
 */
export function destroySourceFiles(): string[] {
  const files = entryAndModules(
    fileURLToPath(new URL('../../../src/cli/commands/destroy.ts', import.meta.url)),
    fileURLToPath(new URL('../../../src/cli/commands/destroy/', import.meta.url))
  );
  if (files.length < DESTROY_SOURCE_FILE_FLOOR) {
    throw new Error(
      `the destroy source read listed ${files.length} file(s), fewer than ` +
        `${DESTROY_SOURCE_FILE_FLOOR}: it stopped seeing src/cli/commands/destroy/`
    );
  }
  return files;
}

/** Every `cdkd destroy` source file's text, joined in {@link destroySourceFiles} order. */
export function readDestroySource(): string {
  return destroySourceFiles()
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
}
