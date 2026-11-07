import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stripModuleWiring } from './_state-source.js';

/**
 * The source files of `cdkd local run-task`:
 * `src/cli/commands/local-run-task.ts` and every `.ts` module under
 * `src/cli/commands/local-run-task/`, subdirectories included. The directory
 * is read recursively, so a new module or subdirectory is never missed. Source
 * fences that once read the single file read these.
 */
export function localRunTaskSourceFiles(): string[] {
  const dir = fileURLToPath(new URL('../../../src/cli/commands/local-run-task/', import.meta.url));
  return [
    fileURLToPath(new URL('../../../src/cli/commands/local-run-task.ts', import.meta.url)),
    ...readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts'))
      .map((name) => name.split('\\').join('/'))
      .sort()
      .map((name) => `${dir}${name}`),
  ];
}

/**
 * {@link localRunTaskSourceFiles} as repo-relative paths with `/` separators
 * (`src/cli/commands/local-run-task.ts`,
 * `src/cli/commands/local-run-task/command.ts`, ...), the form the per-file
 * population tables key on.
 */
export function localRunTaskSourceRelPaths(): string[] {
  const root = fileURLToPath(new URL('../../../', import.meta.url)).split('\\').join('/');
  return localRunTaskSourceFiles().map((file) => file.split('\\').join('/').slice(root.length));
}

/**
 * Every `cdkd local run-task` source file's text, joined in
 * {@link localRunTaskSourceFiles} order. For PRESENCE checks only: the join
 * order is not run order.
 */
export function readLocalRunTaskSource(): string {
  return localRunTaskSourceFiles()
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
}

/**
 * {@link readLocalRunTaskSource} without the module wiring the split added
 * (see {@link stripModuleWiring}), so a fence counting bare references to a
 * helper does not count each sibling's import of it, or the entry file's
 * re-export, as a call site.
 */
export function readLocalRunTaskSourceWithoutWiring(): string {
  return stripModuleWiring(readLocalRunTaskSource());
}
