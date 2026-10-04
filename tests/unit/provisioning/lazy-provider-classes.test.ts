import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vite-plus/test';

/**
 * Provider modules import their `@aws-sdk/client-*` packages at module scope,
 * so they are loaded through `loadProviderClasses()` and never reached
 * statically from the command tree: otherwise every `cdkd` invocation —
 * `--help`, `synth`, `list` — evaluates them. Every module `provider-classes.ts`
 * re-exports is probed, plus that module itself; a mock factory runs when its
 * module is first EVALUATED, which is what the set records. The module list is
 * read off `provider-classes.ts` itself, so a new provider is covered without
 * touching this file.
 */
const PROVIDER_CLASSES_SRC = new URL(
  '../../../src/provisioning/provider-classes.ts',
  import.meta.url
);
const PROVIDER_MODULES = [
  ...readFileSync(PROVIDER_CLASSES_SRC, 'utf8').matchAll(
    /^export \{[^}]+\} from '\.\/(providers\/[a-z0-9-]+)\.js';$/gm
  ),
].map((m) => `../../../src/provisioning/${m[1] as string}.js`);
const PROVIDER_CLASSES = '../../../src/provisioning/provider-classes.js';

/**
 * Reached statically on purpose. `protection-flags.ts` imports
 * `extractLocalDeletionProtection` from this provider; moving that helper out
 * costs the provider file its `handledProperties` wiring evidence, and the
 * provider's SDK client (`@aws-sdk/client-dynamodb`) is on the startup path
 * anyway through `dynamodb-index-busy-delete.ts`.
 */
const STATICALLY_REACHED = new Set([
  '../../../src/provisioning/providers/dynamodb-globaltable-provider.js',
]);

const loaded = new Set<string>();
for (const path of [...PROVIDER_MODULES, PROVIDER_CLASSES]) {
  vi.doMock(path, async (importOriginal) => {
    loaded.add(path);
    return importOriginal();
  });
}

describe('provider classes stay off the command tree', () => {
  it('reads a plausible module list off provider-classes.ts', () => {
    // A floor, so a regex that stopped matching cannot pass vacuously.
    expect(PROVIDER_MODULES.length).toBeGreaterThan(70);
  });

  it('building the command tree evaluates no provider module; loading the classes evaluates all', async () => {
    const { buildProgram } = await import('../../../src/cli/program.js');
    buildProgram();
    expect([...loaded].filter((p) => !STATICALLY_REACHED.has(p))).toEqual([]);

    // Positive control: every probed module is reached through the classes.
    const { loadProviderClasses } = await import(
      '../../../src/provisioning/register-providers.js'
    );
    await loadProviderClasses();
    expect([...loaded].sort()).toEqual([...PROVIDER_MODULES, PROVIDER_CLASSES].sort());
    // Transforming the whole command tree and every provider takes a while.
  }, 180_000);
});
