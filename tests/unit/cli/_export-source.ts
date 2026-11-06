import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The source files of `cdkd export`: `src/cli/commands/export.ts` and every
 * `.ts` module under `src/cli/commands/export/`, subdirectories included. The
 * directory is read recursively, so a new module or subdirectory is never
 * missed. Source fences that once read the single file read these.
 */
export function exportSourceFiles(): string[] {
  const dir = fileURLToPath(new URL('../../../src/cli/commands/export/', import.meta.url));
  return [
    fileURLToPath(new URL('../../../src/cli/commands/export.ts', import.meta.url)),
    ...readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts'))
      .map((name) => name.split('\\').join('/'))
      .sort()
      .map((name) => `${dir}${name}`),
  ];
}

/** Every `cdkd export` source file's text, joined in {@link exportSourceFiles} order. */
export function readExportSource(): string {
  return exportSourceFiles()
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
}
