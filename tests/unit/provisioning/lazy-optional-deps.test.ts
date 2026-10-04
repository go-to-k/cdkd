import { describe, expect, it, vi } from 'vite-plus/test';

/**
 * `registerAllProviders()` evaluates every provider module on every command,
 * so a dependency only one rarely-taken provider path needs must be imported
 * where it is used, not at module scope: graphql-js (AppSync schema drift
 * read) and adm-zip (CodeCommit `Code` seed). The mock factories run when a
 * module is first EVALUATED, which is what the flags record.
 */
const loaded = vi.hoisted(() => ({ graphql: false, admZip: false }));

vi.mock('graphql', async (importOriginal) => {
  loaded.graphql = true;
  return importOriginal();
});

vi.mock('adm-zip', async (importOriginal) => {
  loaded.admZip = true;
  return importOriginal();
});

describe('provider modules keep rarely-used dependencies off the startup path', () => {
  it('registering every provider evaluates neither graphql nor adm-zip', async () => {
    const { ProviderRegistry } = await import('../../../src/provisioning/provider-registry.js');
    const { loadProviderClasses, registerAllProviders } = await import(
      '../../../src/provisioning/register-providers.js'
    );
    const providerClasses = await loadProviderClasses();
    registerAllProviders(new ProviderRegistry(), providerClasses);
    expect(loaded).toEqual({ graphql: false, admZip: false });
    // Transforming every provider module takes several seconds.
  }, 120_000);
});
