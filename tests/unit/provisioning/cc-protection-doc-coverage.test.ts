import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vite-plus/test';
import { ccProtectionRegistryTypes } from '../../../src/provisioning/cc-protection-properties.js';
import { PROTECTION_PROPERTY_BY_TYPE } from '../../../src/cli/commands/destroy-runner.js';
import {
  destroyRemoveProtectionHelp,
  stateDestroyRemoveProtectionHelp,
} from './remove-protection-help.js';

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

  // The two help strings render from `removeProtectionTypes()` since
  // go-to-k/cdkd#2660, so they are read as RENDERED help, not as source text.
  for (const [label, content] of [
    ['cdkd destroy --remove-protection help', destroyRemoveProtectionHelp()],
    ['cdkd state destroy --remove-protection help', stateDestroyRemoveProtectionHelp()],
    ['docs/cli-destroy.md type table', read('docs/cli-destroy.md')],
  ] as const) {
    it(`every registry type appears in ${label}`, () => {
      const missing = types.filter((t) => !content.includes(t));
      expect(missing).toEqual([]);
    });
  }
});
