import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The source files of `cdkd local invoke-agentcore`:
 * `src/cli/commands/local-invoke-agentcore.ts` and every `.ts` module under
 * `src/cli/commands/local-invoke-agentcore/`, subdirectories included. The
 * directory is read recursively, so a new module or subdirectory is never
 * missed. Source fences that once read the single file read these.
 */
export function localInvokeAgentCoreSourceFiles(): string[] {
  const dir = fileURLToPath(
    new URL('../../../src/cli/commands/local-invoke-agentcore/', import.meta.url)
  );
  return [
    fileURLToPath(new URL('../../../src/cli/commands/local-invoke-agentcore.ts', import.meta.url)),
    ...readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts'))
      .map((name) => name.split('\\').join('/'))
      .sort()
      .map((name) => `${dir}${name}`),
  ];
}

/**
 * Every `cdkd local invoke-agentcore` source file's text, joined in
 * {@link localInvokeAgentCoreSourceFiles} order. For PRESENCE checks only: the
 * join order is alphabetical, not run order.
 */
export function readLocalInvokeAgentCoreSource(): string {
  return localInvokeAgentCoreSourceFiles()
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
}
