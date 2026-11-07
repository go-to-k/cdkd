import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * The source files of `cdkd deploy`, repo-relative and POSIX-separated:
 * `src/cli/commands/deploy.ts` and every `.ts` module under
 * `src/cli/commands/deploy/`, subdirectories included. The directory is read
 * recursively, so a new module or subdirectory is never missed. Source fences
 * that once read the single file read these (go-to-k/cdkd#5835).
 */
export function deploySourceFiles(): string[] {
  const dir = `${REPO_ROOT}src/cli/commands/deploy/`;
  return [
    'src/cli/commands/deploy.ts',
    ...readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts'))
      .map((name) => name.split('\\').join('/'))
      .sort()
      .map((name) => `src/cli/commands/deploy/${name}`),
  ];
}

/** Every `cdkd deploy` source file's text, joined in {@link deploySourceFiles} order. */
export function readDeploySource(): string {
  return deploySourceFiles()
    .map((file) => readFileSync(`${REPO_ROOT}${file}`, 'utf8'))
    .join('\n');
}

/**
 * One module of `cdkd deploy`, by its path under `src/cli/commands/deploy/`
 * (`'command.ts'`, `'stack-deploy.ts'`, ...). For a fence that checks an ORDER
 * or a proximity: within one file that is the order the code runs in, which a
 * concatenation of the family is not.
 */
export function readDeployModule(name: string): string {
  return readFileSync(`${REPO_ROOT}src/cli/commands/deploy/${name}`, 'utf8');
}
