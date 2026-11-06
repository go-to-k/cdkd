import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The source files of `cdkd export`: `src/cli/commands/export.ts` and every
 * module under `src/cli/commands/export/`, the directory read so a new module
 * is never missed. Source fences that once read the single file read these.
 */
export function exportSourceFiles(): string[] {
  const dir = fileURLToPath(new URL('../../../src/cli/commands/export/', import.meta.url));
  return [
    fileURLToPath(new URL('../../../src/cli/commands/export.ts', import.meta.url)),
    ...readdirSync(dir)
      .filter((name) => name.endsWith('.ts'))
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
