import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vite-plus/test';
import { ccProtectionRegistryTypes } from '../../../src/provisioning/cc-protection-properties.js';
import { PROTECTION_PROPERTY_BY_TYPE } from '../../../src/cli/commands/destroy-runner.js';

const ROOT = join(import.meta.dirname, '../../..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

/**
 * Cross-site consistency guard for the CC protection registry (issues
 * #1312 / #1314 / #1315): every registered type must ALSO appear in the
 * destroy confirm-prompt count map, both `--remove-protection` help strings,
 * and the docs/cli-destroy.md type table. These five sites are hand-synced;
 * this test is what keeps a future registry entry from silently missing one
 * of them. (README.md used to carry a sixth copy of the table; the slimmed
 * README links to the cdkd.dev page rendered from docs/cli-destroy.md
 * instead, so that entry was dropped.)
 */
describe('CC protection registry cross-site consistency', () => {
  const types = ccProtectionRegistryTypes();

  it('registry is non-empty (guards the sweep below from passing vacuously)', () => {
    expect(types.length).toBeGreaterThanOrEqual(7);
  });

  it('every registry type is counted in the destroy confirm prompt', () => {
    const missing = types.filter((t) => !(t in PROTECTION_PROPERTY_BY_TYPE));
    expect(missing).toEqual([]);
  });

  for (const [label, rel] of [
    ['options.ts --remove-protection help', 'src/cli/options.ts'],
    ['state.ts state destroy --remove-protection help', 'src/cli/commands/state.ts'],
    ['docs/cli-destroy.md type table', 'docs/cli-destroy.md'],
  ] as const) {
    it(`every registry type appears in ${label}`, () => {
      const content = read(rel);
      const missing = types.filter((t) => !content.includes(t));
      expect(missing).toEqual([]);
    });
  }
});
