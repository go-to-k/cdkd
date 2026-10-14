/**
 * `cdkd deploy`'s stale-attribute heal reads a record through
 * `provider.import` under the healed record's printing bag (go-to-k/cdkd#3869),
 * judged over the records the deploy loaded: its own name spellings, and those
 * of each secret-named record it holds. Driven through `readStaleAttributes`
 * itself, so each half of the bag is pinned on its own.
 */
import { describe, it, expect } from 'vite-plus/test';
import { readStaleAttributes } from '../../../src/deployment/deploy-engine/heal.js';
import { currentLogLineMasker } from '../../../src/utils/log-line-masker.js';
import type { ResourceState } from '../../../src/types/state.js';

const ROLE_ID = 'App-team-secret-role';
const DB_ID = 'app-secret-db-instance';

const role = (roleName: string): ResourceState => ({
  physicalId: ROLE_ID,
  resourceType: 'AWS::IAM::Role',
  properties: { RoleName: roleName },
  attributes: {},
  dependencies: [],
});

/** A DB instance reading the role (its monitoring role ARN). */
const db = (identifier: string): ResourceState => ({
  physicalId: DB_ID,
  resourceType: 'AWS::RDS::DBInstance',
  properties: {
    DBInstanceIdentifier: identifier,
    MonitoringRoleArn: `arn:aws:iam::123456789012:role/${ROLE_ID}`,
  },
  attributes: {},
  dependencies: [],
});

/** The provider line the heal's read logs, as the logger sink renders it. */
async function healLine(
  healBaseline: Record<string, ResourceState>,
  healed: ResourceState
): Promise<string> {
  let line = '';
  const provider = {
    import: async (input: { knownPhysicalId?: string }) => {
      const text = `Describing DB instance ${input.knownPhysicalId} (monitoring role ${ROLE_ID})`;
      line = currentLogLineMasker()?.(text) ?? text;
      return { physicalId: input.knownPhysicalId!, attributes: {} };
    },
  };
  const engine = {
    providerRegistry: { getProviderFor: () => ({ provider }) },
    healBaseline,
    stackRegion: 'us-east-1',
    healedAttributes: new Map(),
    logger: { debug: () => undefined },
  };
  await readStaleAttributes.call(engine as never, 'Db', healed, 'App');
  // Premise: the read ran.
  expect(line).not.toBe('');
  return line;
}

const SECRET = '{{resolve:secretsmanager:team-name}}';

describe("cdkd deploy's heal masks names judged over the loaded records (go-to-k/cdkd#3869)", () => {
  it.each([
    ['a secret-named role', SECRET, `Describing DB instance ${DB_ID} (monitoring role ***)`],
    [
      'negative control, an ordinary role',
      'plain-role-name',
      `Describing DB instance ${DB_ID} (monitoring role ${ROLE_ID})`,
    ],
  ])('masks a sibling the healed record READS (%s)', async (_l, roleName, expected) => {
    const healed = db('plain-db');
    expect(await healLine({ Role: role(roleName), Db: healed }, healed)).toBe(expected);
  });

  it.each([
    ['a secret-named record', SECRET, `Describing DB instance *** (monitoring role ${ROLE_ID})`],
    [
      'negative control, an ordinary name',
      'plain-db',
      `Describing DB instance ${DB_ID} (monitoring role ${ROLE_ID})`,
    ],
  ])(
    "masks the healed record's own name though the loaded map lacks it (%s)",
    async (_l, identifier, expected) => {
      // The healed record is judged as itself, not only through the map.
      expect(await healLine({}, db(identifier))).toBe(expected);
    }
  );
});

describe("cdkd deploy's heal judges the loaded map once and follows replaced entries (go-to-k/cdkd#3869)", () => {
  it('a sibling REPLACED in the loaded map between two heals is judged afresh', async () => {
    const healed = db('plain-db');
    // One map object for the whole deploy, as `healBaseline` is.
    const baseline: Record<string, ResourceState> = { Role: role('plain-role-name'), Db: healed };
    expect(await healLine(baseline, healed)).toBe(
      `Describing DB instance ${DB_ID} (monitoring role ${ROLE_ID})`
    );
    // The deploy replaces the entry (it never mutates a record in place).
    baseline['Role'] = role(SECRET);
    expect(await healLine(baseline, healed)).toBe(
      `Describing DB instance ${DB_ID} (monitoring role ***)`
    );
  });
});

describe('a healed record other than the loaded one is judged against the loaded siblings (go-to-k/cdkd#3869)', () => {
  it.each([
    ['a secret-named role', SECRET, `Describing DB instance ${DB_ID} (monitoring role ***)`],
    [
      'negative control, an ordinary role',
      'plain-role-name',
      `Describing DB instance ${DB_ID} (monitoring role ${ROLE_ID})`,
    ],
  ])('masks the sibling it reads (%s)', async (_l, roleName, expected) => {
    // The map holds an older Db object under the id; the healed one differs.
    const baseline = { Role: role(roleName), Db: db('plain-db') };
    expect(await healLine(baseline, db('plain-db'))).toBe(expected);
  });
});
