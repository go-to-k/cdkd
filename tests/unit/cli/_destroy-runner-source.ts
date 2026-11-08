import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * The source files of the shared per-stack destroy runner, repo-relative and
 * POSIX-separated: `src/cli/commands/destroy-runner.ts` and every `.ts` module
 * under `src/cli/commands/destroy-runner/`, subdirectories included. The
 * directory is read recursively, so a new module or subdirectory is never
 * missed. Source fences that once read the single file read these
 * (go-to-k/cdkd#5835).
 */
export function destroyRunnerSourceFiles(): string[] {
  const dir = `${REPO_ROOT}src/cli/commands/destroy-runner/`;
  return [
    'src/cli/commands/destroy-runner.ts',
    ...readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts'))
      .map((name) => name.split('\\').join('/'))
      .sort()
      .map((name) => `src/cli/commands/destroy-runner/${name}`),
  ];
}

/** Every destroy-runner source file's text, joined in {@link destroyRunnerSourceFiles} order. */
export function readDestroyRunnerSource(): string {
  return destroyRunnerSourceFiles()
    .map((file) => readFileSync(`${REPO_ROOT}${file}`, 'utf8'))
    .join('\n');
}

/**
 * One module of the destroy runner, by its path under
 * `src/cli/commands/destroy-runner/` (`'under-lock.ts'`, ...). For a fence that
 * checks an ORDER or a proximity: within one file that is the order the code
 * runs in, which a concatenation of the family is not.
 */
export function readDestroyRunnerModule(name: string): string {
  return readFileSync(`${REPO_ROOT}src/cli/commands/destroy-runner/${name}`, 'utf8');
}
