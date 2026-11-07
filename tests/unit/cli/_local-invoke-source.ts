import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The source files of `cdkd local invoke`: `src/cli/commands/local-invoke.ts`
 * and every `.ts` module under `src/cli/commands/local-invoke/`, subdirectories
 * included. The directory is read recursively, so a new module or subdirectory
 * is never missed. Source fences that once read the single file read these
 * (go-to-k/cdkd#5835).
 */
export function localInvokeSourceFiles(): string[] {
  const dir = fileURLToPath(new URL('../../../src/cli/commands/local-invoke/', import.meta.url));
  return [
    fileURLToPath(new URL('../../../src/cli/commands/local-invoke.ts', import.meta.url)),
    ...readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts'))
      .map((name) => name.split('\\').join('/'))
      .sort()
      .map((name) => `${dir}${name}`),
  ];
}

/** Every `cdkd local invoke` source file's text, joined in {@link localInvokeSourceFiles} order. */
export function readLocalInvokeSource(): string {
  return localInvokeSourceFiles()
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
}
