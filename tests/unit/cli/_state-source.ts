import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The source files of `cdkd state`: `src/cli/commands/state.ts` and every
 * `.ts` module under `src/cli/commands/state/`, subdirectories included. The
 * directory is read recursively, so a new module or subdirectory is never
 * missed. Source fences that once read the single file read these.
 */
export function stateSourceFiles(): string[] {
  const dir = fileURLToPath(new URL('../../../src/cli/commands/state/', import.meta.url));
  return [
    fileURLToPath(new URL('../../../src/cli/commands/state.ts', import.meta.url)),
    ...readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts'))
      .map((name) => name.split('\\').join('/'))
      .sort()
      .map((name) => `${dir}${name}`),
  ];
}

/**
 * {@link stateSourceFiles} as repo-relative paths with `/` separators
 * (`src/cli/commands/state.ts`, `src/cli/commands/state/setup.ts`, ...), the
 * form the per-file population tables key on.
 */
export function stateSourceRelPaths(): string[] {
  const root = fileURLToPath(new URL('../../../', import.meta.url)).split('\\').join('/');
  return stateSourceFiles().map((file) => file.split('\\').join('/').slice(root.length));
}

/** Every `cdkd state` source file's text, joined in {@link stateSourceFiles} order. */
export function readStateSource(): string {
  return stateSourceFiles()
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
}

/**
 * {@link readStateSource} without the module wiring the split added: every
 * `import ... from '...';` and `export { ... } from '...';` statement is
 * removed. A fence that counts bare references to a helper would otherwise
 * count each sibling module's import of it, and `state.ts`'s re-export, as a
 * call site.
 */
export function readStateSourceWithoutWiring(): string {
  return stripModuleWiring(readStateSource());
}

/** Removes `import ... from '...';` and `export { ... } from '...';` statements. */
export function stripModuleWiring(source: string): string {
  return source.replace(
    /^(?:import\s|export\s+(?:type\s+)?\{)[^;]*?\sfrom\s+'[^'\n]+';[ \t]*\n/gm,
    ''
  );
}
