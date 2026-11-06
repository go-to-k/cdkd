import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * The source files of `cdkd import`, repo-relative and POSIX-separated:
 * `src/cli/commands/import.ts` and every `.ts` module under
 * `src/cli/commands/import/`, subdirectories included. The directory is read
 * recursively, so a new module or subdirectory is never missed. Source fences
 * that once read the single file read these.
 */
export function importSourceFiles(): string[] {
  const dir = `${REPO_ROOT}src/cli/commands/import/`;
  return [
    'src/cli/commands/import.ts',
    ...readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts'))
      .map((name) => name.split('\\').join('/'))
      .sort()
      .map((name) => `src/cli/commands/import/${name}`),
  ];
}

/** Every `cdkd import` source file's text, joined in {@link importSourceFiles} order. */
export function readImportSource(): string {
  return importSourceFiles()
    .map((file) => readFileSync(`${REPO_ROOT}${file}`, 'utf8'))
    .join('\n');
}
