import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stripModuleWiring } from './_state-source.js';

/**
 * The source files of `cdkd local start-api`:
 * `src/cli/commands/local-start-api.ts` and every `.ts` module under
 * `src/cli/commands/local-start-api/`, subdirectories included. The directory
 * is read recursively, so a new module or subdirectory is never missed. Source
 * fences that once read the single file read these.
 */
export function localStartApiSourceFiles(): string[] {
  const dir = fileURLToPath(new URL('../../../src/cli/commands/local-start-api/', import.meta.url));
  return [
    fileURLToPath(new URL('../../../src/cli/commands/local-start-api.ts', import.meta.url)),
    ...readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts'))
      .map((name) => name.split('\\').join('/'))
      .sort()
      .map((name) => `${dir}${name}`),
  ];
}

/**
 * {@link localStartApiSourceFiles} as repo-relative paths with `/` separators
 * (`src/cli/commands/local-start-api.ts`,
 * `src/cli/commands/local-start-api/command.ts`, ...), the form the per-file
 * population tables key on.
 */
export function localStartApiSourceRelPaths(): string[] {
  const root = fileURLToPath(new URL('../../../', import.meta.url)).split('\\').join('/');
  return localStartApiSourceFiles().map((file) => file.split('\\').join('/').slice(root.length));
}

/** Every `cdkd local start-api` source file's text, joined in {@link localStartApiSourceFiles} order. */
export function readLocalStartApiSource(): string {
  return localStartApiSourceFiles()
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
}

/**
 * {@link readLocalStartApiSource} without the module wiring the split added
 * (see {@link stripModuleWiring}), so a fence counting bare references to a
 * helper does not count each sibling's import of it, or the entry file's
 * re-export, as a call site.
 */
export function readLocalStartApiSourceWithoutWiring(): string {
  return stripModuleWiring(readLocalStartApiSource());
}
