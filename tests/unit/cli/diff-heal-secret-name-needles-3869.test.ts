/**
 * `cdkd diff`'s read-only stale-attribute heal reads a record through
 * `provider.import` under the record's printing bag (go-to-k/cdkd#3869 item
 * 1): the provider's lines name the physical id, which for a resource named
 * from a secret no recorded plaintext spells.
 */
import { describe, it, expect } from 'vite-plus/test';
import { healerUnderRecordPrintingBag } from '../../../src/cli/commands/diff-recursive.js';
import { currentLogLineMasker } from '../../../src/utils/log-line-masker.js';
import type { StaleAttributeHealer } from '../../../src/deployment/stale-attribute-heal.js';
import type { ResourceState } from '../../../src/types/state.js';

const ROLE_ID = 'App-team-secret-role';

function role(roleName: string): ResourceState {
  return {
    physicalId: ROLE_ID,
    resourceType: 'AWS::IAM::Role',
    properties: { RoleName: roleName },
    attributes: {},
    dependencies: [],
  };
}

async function heal(roleName: string): Promise<{ line: string; healer: StaleAttributeHealer }> {
  let line = '';
  const inner: StaleAttributeHealer = Object.assign(
    async (_logicalId: string, resource: ResourceState) => {
      const text = `Importing role ${resource.physicalId}`;
      line = currentLogLineMasker()?.(text) ?? text;
      return { kind: 'not-found' as const };
    },
    { readOnly: true as const }
  );
  const healer = healerUnderRecordPrintingBag(inner, () => ({ Role: role(roleName) }));
  await healer('Role', role(roleName));
  return { line, healer };
}

describe("cdkd diff's stale-attribute heal masks a name derived from a secret (go-to-k/cdkd#3869)", () => {
  it.each([
    ['a secret reference', '{{resolve:secretsmanager:team-name}}'],
    ['the redaction mask', '***'],
  ])("masks the provider's line about the healed record (%s)", async (_l, roleName) => {
    const { line, healer } = await heal(roleName);
    expect(line).toBe('Importing role ***');
    // The read-only flag the resolver words its remedy from is kept.
    expect(healer.readOnly).toBe(true);
  });

  it.each([
    ['a secret-named sibling', '***', 'Reading profile of role ***'],
    ['negative control, an ordinary sibling', 'plain-role-name', `Reading profile of role ${ROLE_ID}`],
  ])("masks a sibling's name the healed record holds (%s)", async (_l, roleName, expected) => {
    let line = '';
    const inner: StaleAttributeHealer = async () => {
      const text = `Reading profile of role ${ROLE_ID}`;
      line = currentLogLineMasker()?.(text) ?? text;
      return { kind: 'not-found' as const };
    };
    const profile: ResourceState = {
      physicalId: 'App-profile',
      resourceType: 'AWS::IAM::InstanceProfile',
      properties: { Roles: [ROLE_ID] },
      attributes: {},
      dependencies: [],
    };
    await healerUnderRecordPrintingBag(inner, () => ({ Role: role(roleName), Profile: profile }))(
      'Profile',
      profile
    );
    expect(line).toBe(expected);
  });

  it.each([
    ['a secret-named record', '***', 'Importing role ***'],
    ['negative control, an ordinary name', 'plain-role-name', `Importing role ${ROLE_ID}`],
  ])('falls back to the record alone when the stack map lacks it (%s)', async (_l, roleName, expected) => {
    let line = '';
    const inner: StaleAttributeHealer = async (_id: string, resource: ResourceState) => {
      const text = `Importing role ${resource.physicalId}`;
      line = currentLogLineMasker()?.(text) ?? text;
      return { kind: 'not-found' as const };
    };
    await healerUnderRecordPrintingBag(inner, () => ({}))('Role', role(roleName));
    expect(line).toBe(expected);
    // A DIFFERENT record under an id the map holds (an adopted one) is judged
    // as itself, not as the loaded record.
    line = '';
    await healerUnderRecordPrintingBag(inner, () => ({ Role: role('plain-loaded-name') }))(
      'Role',
      role(roleName)
    );
    expect(line).toBe(expected);
  });

  it('an ordinary record under the id of a secret-named loaded one is not masked with its spellings', async () => {
    let line = '';
    const inner: StaleAttributeHealer = async (_id: string, resource: ResourceState) => {
      const text = `Importing role ${resource.physicalId}`;
      line = currentLogLineMasker()?.(text) ?? text;
      return { kind: 'not-found' as const };
    };
    const loaded = { ...role('***'), physicalId: 'App-loaded-secret-role' };
    const swapped = { ...role('plain-role-name'), physicalId: 'App-loaded-secret-role-2' };
    await healerUnderRecordPrintingBag(inner, () => ({ Role: loaded }))('Role', swapped);
    expect(line).toBe('Importing role App-loaded-secret-role-2');
  });

  it("a record judged on the fallback path still masks a secret-named sibling it holds", async () => {
    let line = '';
    const inner: StaleAttributeHealer = async () => {
      const text = `Reading profile of role ${ROLE_ID}`;
      line = currentLogLineMasker()?.(text) ?? text;
      return { kind: 'not-found' as const };
    };
    const profile = (roles: string[]): ResourceState => ({
      physicalId: 'App-profile',
      resourceType: 'AWS::IAM::InstanceProfile',
      properties: { Roles: roles },
      attributes: {},
      dependencies: [],
    });
    // The map holds an older Profile record; the healed one is a different object.
    await healerUnderRecordPrintingBag(inner, () => ({ Role: role('***'), Profile: profile([]) }))(
      'Profile',
      profile([ROLE_ID])
    );
    expect(line).toBe('Reading profile of role ***');
  });

  it('negative control: an ordinary name prints as it is', async () => {
    const { line } = await heal('plain-role-name');
    expect(line).toBe(`Importing role ${ROLE_ID}`);
  });
});

describe('the heal re-judges when the map the diff reads changes (go-to-k/cdkd#3869)', () => {
  it('a heal after the map is swapped (the adoption splice) uses the new map', async () => {
    const profile: ResourceState = {
      physicalId: 'App-profile',
      resourceType: 'AWS::IAM::InstanceProfile',
      properties: { Roles: [ROLE_ID] },
      attributes: {},
      dependencies: [],
    };
    const lines: string[] = [];
    const inner: StaleAttributeHealer = async () => {
      const text = `Reading profile of role ${ROLE_ID}`;
      lines.push(currentLogLineMasker()?.(text) ?? text);
      return { kind: 'not-found' as const };
    };
    // Before the splice the role is not in the map; after it, the adopted
    // secret-named role is (a NEW map object, as the splice builds).
    let current: Record<string, ResourceState> = { Profile: profile };
    const healer = healerUnderRecordPrintingBag(inner, () => current);
    await healer('Profile', profile);
    current = { ...current, Role: role('***') };
    await healer('Profile', profile);
    expect(lines).toEqual([
      `Reading profile of role ${ROLE_ID}`,
      'Reading profile of role ***',
    ]);
  });
});
