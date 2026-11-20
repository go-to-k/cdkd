/**
 * go-to-k/cdkd#6655: a rollback orphan's re-adoption compares the AWS-minted
 * id the record carries with the live holder's, instead of adopting on a name
 * match alone. The live id is the one the existence check's `import()`
 * already returned; `resourceIdentity` is read only when it did not return one.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import { planOrphanAdoption } from '../../../src/deployment/orphan-adoption.js';
import { explicitNamePropertyFor } from '../../../src/provisioning/resource-name.js';
import {
  RESOURCE_NOT_FOUND,
  type CloudFormationTemplate,
  type ResourceProvider,
} from '../../../src/types/resource.js';
import type { ResourceState, StackOrphanRecord } from '../../../src/types/state.js';

interface Case {
  logicalId: string;
  resourceType: string;
  physicalId: string;
  attribute: string;
}

const ROLE: Case = {
  logicalId: 'KeptRole',
  resourceType: 'AWS::IAM::Role',
  physicalId: 'cdkd-sandbox-KeptRole',
  attribute: 'RoleId',
};
const TABLE: Case = {
  logicalId: 'KeptTable',
  resourceType: 'AWS::DynamoDB::Table',
  physicalId: 'cdkd-sandbox-KeptTable',
  attribute: 'TableId',
};
const DB_INSTANCE: Case = {
  logicalId: 'KeptDb',
  resourceType: 'AWS::RDS::DBInstance',
  physicalId: 'cdkd-sandbox-keptdb',
  attribute: 'DbiResourceId',
};

const RECORDED = 'RECORDED-ID-0001';
const STRANGER = 'STRANGER-ID-9999';

function orphan(c: Case, attributes: Record<string, unknown> | undefined): StackOrphanRecord {
  const state: ResourceState = {
    physicalId: c.physicalId,
    resourceType: c.resourceType,
    properties: {},
    ...(attributes !== undefined && { attributes }),
    deletionPolicy: 'Retain',
  };
  return { logicalId: c.logicalId, orphanedAt: 1, state };
}

function plan(
  c: Case,
  params: {
    recorded: Record<string, unknown> | undefined;
    imported: Record<string, unknown> | undefined;
    resourceIdentity?: ResourceProvider['resourceIdentity'];
  }
) {
  const importFn = vi.fn(async () => ({
    physicalId: c.physicalId,
    ...(params.imported !== undefined && { attributes: params.imported }),
  }));
  const provider = {
    import: importFn,
    ...(params.resourceIdentity !== undefined && { resourceIdentity: params.resourceIdentity }),
  } as unknown as ResourceProvider;
  const template = {
    Resources: { [c.logicalId]: { Type: c.resourceType, Properties: {} } },
  } as CloudFormationTemplate;
  return planOrphanAdoption({
    records: [orphan(c, params.recorded)],
    managedLogicalIds: new Set(),
    template,
    stackName: 'MyStack',
    region: 'us-east-1',
    getProvider: () => provider,
    nameProperties: (t) => {
      const real = explicitNamePropertyFor(t);
      return real === undefined ? [] : [real];
    },
    readSiblingClaims: async () => new Set<string>(),
    logger: { debug: vi.fn() },
  });
}

describe('planOrphanAdoption identity compare (#6655)', () => {
  for (const c of [ROLE, TABLE, DB_INSTANCE]) {
    describe(c.resourceType, () => {
      it('adopts when import() returns the recorded id, with no identity read', async () => {
        const resourceIdentity = vi.fn(async () => STRANGER);
        const outcome = await plan(c, {
          recorded: { [c.attribute]: RECORDED },
          imported: { [c.attribute]: RECORDED },
          resourceIdentity,
        });
        expect(Object.keys(outcome.adopted)).toEqual([c.logicalId]);
        expect(outcome.refusals).toEqual([]);
        expect(outcome.warnings).toEqual([]);
        expect(outcome.remaining).toEqual([]);
        expect(resourceIdentity).not.toHaveBeenCalled();
      });

      it('refuses, keeping the record, when import() returns another id', async () => {
        const resourceIdentity = vi.fn(async () => RECORDED);
        const outcome = await plan(c, {
          recorded: { [c.attribute]: RECORDED },
          imported: { [c.attribute]: STRANGER },
          resourceIdentity,
        });
        expect(outcome.adopted).toEqual({});
        expect(outcome.remaining.map((r) => r.logicalId)).toEqual([c.logicalId]);
        expect(outcome.refusals).toHaveLength(1);
        const refusal = outcome.refusals[0]!;
        expect(refusal).toContain(`its ${c.attribute} differs from the recorded one`);
        expect(refusal).toContain('cdkd import');
        // Neither value is printed.
        expect(refusal).not.toContain(RECORDED);
        expect(refusal).not.toContain(STRANGER);
        // The import's answer decides: no second read.
        expect(resourceIdentity).not.toHaveBeenCalled();
      });
    });
  }

  it('a legacy record without the id adopts as before and acquires the imported one', async () => {
    const resourceIdentity = vi.fn(async () => STRANGER);
    const outcome = await plan(ROLE, {
      recorded: { Arn: 'arn:aws:iam::111122223333:role/cdkd-sandbox-KeptRole' },
      imported: { RoleId: STRANGER },
      resourceIdentity,
    });
    expect(outcome.adopted['KeptRole']?.attributes).toEqual({
      Arn: 'arn:aws:iam::111122223333:role/cdkd-sandbox-KeptRole',
      RoleId: STRANGER,
    });
    expect(outcome.refusals).toEqual([]);
    expect(outcome.warnings).toEqual([]);
    expect(resourceIdentity).not.toHaveBeenCalled();
  });

  it('a record with no attributes at all adopts as before', async () => {
    const outcome = await plan(TABLE, { recorded: undefined, imported: { TableId: STRANGER } });
    expect(Object.keys(outcome.adopted)).toEqual(['KeptTable']);
    expect(outcome.refusals).toEqual([]);
    expect(outcome.warnings).toEqual([]);
  });

  for (const masked of ['***', 'prefix-***', '{{resolve:secretsmanager:s:SecretString:k}}', '']) {
    it(`a recorded ${JSON.stringify(masked)} is no id: adopted as before, no read`, async () => {
      const resourceIdentity = vi.fn(async () => STRANGER);
      const outcome = await plan(ROLE, {
        recorded: { RoleId: masked },
        imported: { RoleId: STRANGER },
        resourceIdentity,
      });
      expect(Object.keys(outcome.adopted)).toEqual(['KeptRole']);
      expect(outcome.refusals).toEqual([]);
      expect(outcome.warnings).toEqual([]);
      expect(resourceIdentity).not.toHaveBeenCalled();
    });
  }

  it('a masked imported id falls back to ONE resourceIdentity read, which refuses a stranger', async () => {
    const resourceIdentity = vi.fn(async () => STRANGER);
    const outcome = await plan(ROLE, {
      recorded: { RoleId: RECORDED },
      imported: { RoleId: '***' },
      resourceIdentity,
    });
    expect(resourceIdentity).toHaveBeenCalledTimes(1);
    expect(resourceIdentity).toHaveBeenCalledWith('cdkd-sandbox-KeptRole', 'AWS::IAM::Role', {
      expectedRegion: 'us-east-1',
    });
    expect(outcome.adopted).toEqual({});
    expect(outcome.refusals).toHaveLength(1);
  });

  it('an import() without the id falls back to resourceIdentity, which adopts on a match', async () => {
    const resourceIdentity = vi.fn(async () => RECORDED);
    const outcome = await plan(TABLE, {
      recorded: { TableId: RECORDED },
      imported: undefined,
      resourceIdentity,
    });
    expect(resourceIdentity).toHaveBeenCalledTimes(1);
    expect(Object.keys(outcome.adopted)).toEqual(['KeptTable']);
    expect(outcome.refusals).toEqual([]);
    expect(outcome.warnings).toEqual([]);
  });

  const unverified: Array<[string, ResourceProvider['resourceIdentity'] | undefined]> = [
    ['no resourceIdentity', undefined],
    [
      'a throwing resourceIdentity',
      vi.fn(async () => {
        throw new Error('Rate exceeded');
      }),
    ],
    ['an undefined answer', vi.fn(async () => undefined)],
    ['RESOURCE_NOT_FOUND', vi.fn(async (): Promise<typeof RESOURCE_NOT_FOUND> => RESOURCE_NOT_FOUND)],
  ];
  for (const [label, resourceIdentity] of unverified) {
    it(`${label}: adopted with a warning naming the attribute and the next step`, async () => {
      const outcome = await plan(ROLE, {
        recorded: { RoleId: RECORDED },
        imported: {},
        ...(resourceIdentity !== undefined && { resourceIdentity }),
      });
      expect(Object.keys(outcome.adopted)).toEqual(['KeptRole']);
      expect(outcome.refusals).toEqual([]);
      expect(outcome.warnings).toHaveLength(1);
      expect(outcome.warnings[0]).toContain('could not read the RoleId');
      expect(outcome.warnings[0]).toContain('cdkd state orphan');
      expect(outcome.warnings[0]).toContain('--resource KeptRole');
      expect(outcome.warnings[0]).not.toContain(RECORDED);
      // The recorded id is kept.
      expect(outcome.adopted['KeptRole']?.attributes?.['RoleId']).toBe(RECORDED);
    });
  }

  it('a type without an identity entry is not compared', async () => {
    const topic: Case = {
      logicalId: 'KeptTopic',
      resourceType: 'AWS::SNS::Topic',
      physicalId: 'arn:aws:sns:us-east-1:111122223333:cdkd-sandbox-KeptTopic',
      attribute: 'TopicArn',
    };
    const resourceIdentity = vi.fn(async () => STRANGER);
    const outcome = await plan(topic, {
      recorded: { RoleId: RECORDED },
      imported: { RoleId: STRANGER },
      resourceIdentity,
    });
    expect(Object.keys(outcome.adopted)).toEqual(['KeptTopic']);
    expect(outcome.refusals).toEqual([]);
    expect(outcome.warnings).toEqual([]);
    expect(resourceIdentity).not.toHaveBeenCalled();
  });
});
