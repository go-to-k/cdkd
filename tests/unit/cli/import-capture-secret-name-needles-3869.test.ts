/**
 * `cdkd import`'s observed-baseline capture reads each imported record through
 * the provider's `readCurrentState` under the record's printing bag
 * (go-to-k/cdkd#3869 item 1), as `cdkd drift` does: a provider line naming
 * the physical id of a resource named from a secret, or of a reader of one,
 * prints `***`.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  captureObservedForImportedResources,
  ObservedBaselineRefusals,
} from '../../../src/cli/commands/import.js';
import { currentLogLineMasker } from '../../../src/utils/log-line-masker.js';
import { getLogger } from '../../../src/utils/logger.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';
import type { StackState } from '../../../src/types/state.js';

const ROLE_ID = 'App-team-secret-role';

async function capture(roleName: string): Promise<string[]> {
  const lines: string[] = [];
  const state: StackState = {
    version: STATE_SCHEMA_VERSION_CURRENT,
    stackName: 'App',
    region: 'us-east-1',
    resources: {
      Role: {
        physicalId: ROLE_ID,
        resourceType: 'AWS::IAM::Role',
        properties: { RoleName: roleName },
        attributes: {},
        dependencies: [],
      },
      Profile: {
        physicalId: 'App-profile',
        resourceType: 'AWS::IAM::InstanceProfile',
        properties: { Roles: [ROLE_ID] },
        attributes: {},
        dependencies: ['Role'],
      },
    },
    outputs: {},
    lastModified: 0,
  };
  const provider = {
    readCurrentState: async (physicalId: string) => {
      // What the logger sink prints for a provider's own line.
      const text = `Reading ${physicalId} (role ${ROLE_ID})`;
      lines.push(currentLogLineMasker()?.(text) ?? text);
      return {};
    },
  };
  const registry = { getProviderFor: () => ({ provider, provisionedBy: 'sdk' }) };
  await captureObservedForImportedResources(
    state,
    registry as unknown as Parameters<typeof captureObservedForImportedResources>[1],
    getLogger(),
    new ObservedBaselineRefusals(new Set<string>()),
    new Set(['Role', 'Profile'])
  );
  // Premise: both records were read.
  expect(lines).toHaveLength(2);
  return lines;
}

describe('cdkd import capture masks a name derived from a secret (go-to-k/cdkd#3869)', () => {
  it.each([
    ['a secret reference', '{{resolve:secretsmanager:team-name}}'],
    ['the redaction mask', '***'],
  ])("masks the secret-named record's read line and its reader's (%s)", async (_l, roleName) => {
    const lines = await capture(roleName);
    expect(lines).toContain('Reading *** (role ***)');
    expect(lines).toContain('Reading App-profile (role ***)');
  });

  it('negative control: an ordinary name prints as it is', async () => {
    const lines = await capture('plain-role-name');
    expect(lines).toContain(`Reading ${ROLE_ID} (role ${ROLE_ID})`);
    expect(lines).toContain(`Reading App-profile (role ${ROLE_ID})`);
  });
});
