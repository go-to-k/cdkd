import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * The source files of the malformed-container guards, repo-relative:
 * `src/state/malformed-resources-bag.ts` (which now only re-exports) and every
 * `.ts` module under `src/state/malformed-resources-bag/`, subdirectories
 * included. The directory is read recursively, so a new module or
 * subdirectory is never missed. Source fences that once read the single file
 * read these.
 */
export function malformedBagSourceFiles(): string[] {
  const dir = 'src/state/malformed-resources-bag';
  return [
    `${dir}.ts`,
    ...readdirSync(`${REPO_ROOT}${dir}`, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts'))
      .map((name) => name.split('\\').join('/'))
      .sort()
      .map((name) => `${dir}/${name}`),
  ];
}

/** True for any file of {@link malformedBagSourceFiles}' family, by path. */
export function isMalformedBagSourceFile(relPath: string): boolean {
  return (
    relPath === 'src/state/malformed-resources-bag.ts' || relPath.startsWith('src/state/malformed-resources-bag/')
  );
}
