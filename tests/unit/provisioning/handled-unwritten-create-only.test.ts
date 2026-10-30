import { describe, it, expect } from 'vite-plus/test';
import { acceptedCreateOnlyDropsField } from '../../../src/deployment/deploy-engine/record-shape.js';
import { unwrittenCreateOnlyRefusal } from '../../../src/deployment/deploy-engine/update.js';
import { findUnwrittenCreateOnlyRefusals } from '../../../src/cli/commands/diff-recursive.js';
import {
  findHandledUnwrittenCreateOnly,
  findUnwrittenCreateOnlyDrops,
  getPropertyCoverage,
  unwrittenCreateOnlyReplacement,
  withoutUnwrittenSilentDropProperties,
} from '../../../src/provisioning/property-coverage.js';
import type { ResourceChange, ResourceState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#5572 — a create-only key an earlier cdkd accepted dropping
 * (`acceptedCreateOnlyDrops`, #2790) that a later release's SDK provider
 * WRITES (a #2762 backfill slice). Today's coverage map no longer lists it as
 * a drop, so before this fix both #2790 readers stopped seeing it: the
 * unchanged template diffed NO_CHANGE and the value never reached AWS.
 *
 * `AWS::S3Tables::Table` / `StorageClassConfiguration` is the pair
 * `tests/integration/s3-tables/` seeds.
 */
const TYPE = 'AWS::S3Tables::Table';
const KEY = 'StorageClassConfiguration';
const WRITTEN = {
  TableBucketARN: 'arn:aws:s3tables:us-east-1:123456789012:bucket/b',
  Namespace: 'ns',
  TableName: 't',
  OpenTableFormat: 'ICEBERG',
};
const RECORD = { ...WRITTEN, [KEY]: { StorageClass: 'INTELLIGENT_TIERING' } };
const EVIDENCE = new Set([KEY]);
const NONE = new Set<string>();

it('PREMISE: StorageClassConfiguration is HANDLED now, and the type has no create-only drop left', () => {
  const cov = getPropertyCoverage(TYPE);
  if (!cov) throw new Error(`${TYPE} lost its property-coverage record`);
  expect(cov.handled.has(KEY)).toBe(true);
  expect(cov.silentDrop.has(KEY)).toBe(false);
  // The early returns this fix removed keyed on this set being empty.
  expect(cov.createOnlyDrops.size).toBe(0);
});

it('PREMISE: on AWS::EC2::Subnet, CidrBlock is handled and top-level create-only, AvailabilityZoneId a create-only drop', () => {
  const cov = getPropertyCoverage('AWS::EC2::Subnet');
  if (!cov) throw new Error('AWS::EC2::Subnet lost its property-coverage record');
  expect(cov.handled.has('CidrBlock')).toBe(true);
  expect(cov.createOnlyDrops.has('AvailabilityZoneId')).toBe(true);
  expect(
    findHandledUnwrittenCreateOnly('AWS::EC2::Subnet', { CidrBlock: '10.0.0.0/24' }, new Set(['CidrBlock']))
  ).toEqual(['CidrBlock']);
});

describe('findHandledUnwrittenCreateOnly', () => {
  it('names an evidence key the record holds and the provider now writes', () => {
    expect(findHandledUnwrittenCreateOnly(TYPE, RECORD, EVIDENCE)).toEqual([KEY]);
  });

  it('ignores a key the record no longer holds', () => {
    expect(findHandledUnwrittenCreateOnly(TYPE, WRITTEN, EVIDENCE)).toEqual([]);
  });

  it('ignores a record with no evidence (an import, a Cloud Control create)', () => {
    expect(findHandledUnwrittenCreateOnly(TYPE, RECORD, NONE)).toEqual([]);
  });

  it('ignores a handled key the schema snapshot does not mark create-only: an update sends it', () => {
    // Compaction is handled and mutable (PutTableMaintenanceConfiguration).
    const record = { ...RECORD, Compaction: { Status: 'enabled' } };
    expect(findHandledUnwrittenCreateOnly(TYPE, record, new Set(['Compaction']))).toEqual([]);
    expect(
      acceptedCreateOnlyDropsField(record, TYPE, 'sdk', 'in-place', {
        acceptedCreateOnlyDrops: ['Compaction'],
      })
    ).toEqual({ acceptedCreateOnlyDrops: undefined });
  });

  it('ignores a key that is create-only only BELOW the top level: the writer never named one', () => {
    // AWS::Glue::Table's create-only path is TableInput/Name, not TableInput.
    const record = { DatabaseName: 'db', CatalogId: '1', TableInput: { Name: 't' } };
    expect(
      findHandledUnwrittenCreateOnly('AWS::Glue::Table', record, new Set(['TableInput']))
    ).toEqual([]);
  });

  it('ignores an evidence name the type does not handle, and a type with no coverage', () => {
    expect(findHandledUnwrittenCreateOnly(TYPE, { ...RECORD, Bogus: 1 }, new Set(['Bogus']))).toEqual([]);
    expect(findHandledUnwrittenCreateOnly('Custom::Thing', RECORD, EVIDENCE)).toEqual([]);
  });
});

describe('the comparison narrowing (withoutUnwrittenSilentDropProperties)', () => {
  it('removes the key from the record side, so an unchanged template reads it as an addition', () => {
    expect(withoutUnwrittenSilentDropProperties(TYPE, RECORD, RECORD, NONE, EVIDENCE)).toEqual(
      WRITTEN
    );
  });

  it('removes it under an allow set naming it too: no flag can accept a handled key', () => {
    const allowed = new Set([`${TYPE}:${KEY}`]);
    expect(withoutUnwrittenSilentDropProperties(TYPE, RECORD, RECORD, allowed, EVIDENCE)).toEqual(
      WRITTEN
    );
  });

  it('KEEPS a key whose template value differs from the record: the refusal would not cover it', () => {
    // Only a canonicalizer could call these equal (5 vs "5"); the refusal's
    // test is raw. Stripping it would make an added create-only key that the
    // refusal does not cover: a replacement with no opt-in.
    const record = { ...WRITTEN, [KEY]: { StorageClass: 5 } };
    const desired = { ...WRITTEN, [KEY]: { StorageClass: '5' } };
    expect(withoutUnwrittenSilentDropProperties(TYPE, record, desired, NONE, EVIDENCE)).toBe(
      record
    );
    expect(findUnwrittenCreateOnlyDrops(TYPE, record, desired, NONE, EVIDENCE)).toEqual([]);
  });

  it('removes a key the template no longer declares: AWS never held it', () => {
    expect(withoutUnwrittenSilentDropProperties(TYPE, RECORD, WRITTEN, NONE, EVIDENCE)).toEqual(
      WRITTEN
    );
  });

  it('keeps the record unchanged (by reference) without evidence', () => {
    expect(withoutUnwrittenSilentDropProperties(TYPE, RECORD, RECORD, NONE, NONE)).toBe(RECORD);
  });
});

describe('the refusal predicate (findUnwrittenCreateOnlyDrops / unwrittenCreateOnlyReplacement)', () => {
  it('fires for a handled key the template still asks for unchanged', () => {
    expect(findUnwrittenCreateOnlyDrops(TYPE, RECORD, RECORD, NONE, EVIDENCE)).toEqual([KEY]);
    expect(unwrittenCreateOnlyReplacement(TYPE, RECORD, RECORD, NONE, EVIDENCE, [KEY])).toEqual([
      KEY,
    ]);
  });

  it('does not fire when the template changed the value: that replacement happens anyway', () => {
    const changed = { ...WRITTEN, [KEY]: { StorageClass: 'STANDARD' } };
    expect(findUnwrittenCreateOnlyDrops(TYPE, RECORD, changed, NONE, EVIDENCE)).toEqual([]);
  });

  it('does not fire when the template removed the key', () => {
    expect(findUnwrittenCreateOnlyDrops(TYPE, RECORD, WRITTEN, NONE, EVIDENCE)).toEqual([]);
  });

  it('does not fire without evidence, or when another path also replaces', () => {
    expect(unwrittenCreateOnlyReplacement(TYPE, RECORD, RECORD, NONE, NONE, [KEY])).toEqual([]);
    expect(
      unwrittenCreateOnlyReplacement(TYPE, RECORD, RECORD, NONE, EVIDENCE, [KEY, 'OpenTableFormat'])
    ).toEqual([]);
  });

  it('returns a still-dropped key and a handled one together, sorted', () => {
    // AWS::EC2::Subnet still has AvailabilityZoneId as a create-only drop and
    // handles CidrBlock: a record naming both reports both.
    const subnet = { VpcId: 'vpc-1', CidrBlock: '10.0.0.0/24', AvailabilityZoneId: 'use1-az1' };
    expect(
      findUnwrittenCreateOnlyDrops(
        'AWS::EC2::Subnet',
        subnet,
        subnet,
        NONE,
        new Set(['AvailabilityZoneId', 'CidrBlock'])
      )
    ).toEqual(['AvailabilityZoneId', 'CidrBlock']);
  });
});

describe('the writer (acceptedCreateOnlyDropsField)', () => {
  it('an in-place update CARRIES a handled key the record still holds', () => {
    expect(
      acceptedCreateOnlyDropsField(RECORD, TYPE, 'sdk', 'in-place', {
        acceptedCreateOnlyDrops: [KEY],
      })
    ).toEqual({ acceptedCreateOnlyDrops: [KEY] });
  });

  it('an in-place update drops it once the record no longer holds it', () => {
    expect(
      acceptedCreateOnlyDropsField(WRITTEN, TYPE, 'sdk', 'in-place', {
        acceptedCreateOnlyDrops: [KEY],
      })
    ).toEqual({ acceptedCreateOnlyDrops: undefined });
  });

  it('a new resource drops it: the provider that built it sent the key', () => {
    expect(
      acceptedCreateOnlyDropsField(RECORD, TYPE, 'sdk', 'new-resource', {
        acceptedCreateOnlyDrops: [KEY],
      })
    ).toEqual({ acceptedCreateOnlyDrops: undefined });
  });

  it('an in-place update never asserts a handled key without previous evidence', () => {
    expect(acceptedCreateOnlyDropsField(RECORD, TYPE, 'sdk', 'in-place', {})).toEqual({
      acceptedCreateOnlyDrops: undefined,
    });
  });

  it('a Cloud Control write clears it', () => {
    expect(
      acceptedCreateOnlyDropsField(RECORD, TYPE, 'cc-api', 'in-place', {
        acceptedCreateOnlyDrops: [KEY],
      })
    ).toEqual({ acceptedCreateOnlyDrops: undefined });
  });
});

describe('the refusal text (unwrittenCreateOnlyRefusal)', () => {
  const base = { logicalId: 'IcebergTable', resourceType: TYPE, nested: false };

  it('says the provider now writes the key, names no route, and offers removing it', () => {
    const msg = unwrittenCreateOnlyRefusal({
      ...base,
      unwritten: [KEY],
      routeDriving: [],
      nowWritten: [KEY],
    });
    expect(msg).toContain(`IcebergTable (${TYPE}): ${KEY} is create-only`);
    expect(msg).toContain(`This cdkd version's SDK provider writes ${KEY}`);
    expect(msg).toContain('--recreate-via-cc-api IcebergTable');
    expect(msg).toContain(`To keep the resource as it is, remove ${KEY} from the template.`);
    // Neither false claim of the #2790 text: the route is the SDK provider, and
    // no flag keeps a handled key dropped.
    expect(msg).not.toContain('routes the resource through Cloud Control');
    expect(msg).not.toContain('never writes');
    expect(msg).not.toContain('--prefer-sdk-route AWS::');
  });

  it('with a still-dropped key too, names the route and keeps only the drops in --prefer-sdk-route', () => {
    const msg = unwrittenCreateOnlyRefusal({
      ...base,
      unwritten: ['AvailabilityZoneId', 'CidrBlock'],
      routeDriving: ['EnableDns64'],
      nowWritten: ['CidrBlock'],
    });
    expect(msg).toContain('AvailabilityZoneId, CidrBlock are create-only');
    expect(msg).toContain('--prefer-sdk-route does not cover EnableDns64');
    expect(msg).toContain(
      `remove CidrBlock from the template and re-run with --prefer-sdk-route ${TYPE}:AvailabilityZoneId,${TYPE}:EnableDns64.`
    );
    // The import would erase AvailabilityZoneId's evidence too, which AWS
    // really lacks, so it is not offered here.
    expect(msg).not.toContain('cdkd import');
  });

  it('names the cdkd import way out, unless inside a nested child', () => {
    const input = { ...base, unwritten: [KEY], routeDriving: [], nowWritten: [KEY] };
    const top = unwrittenCreateOnlyRefusal(input);
    expect(top).toContain("cdkd import with --resource 'IcebergTable=PHYSICAL_ID'");
    // A record whose evidence also names a key this deploy's flag accepts
    // (so not among `unwritten`): the import would erase that key's evidence.
    expect(
      unwrittenCreateOnlyRefusal({ ...input, evidence: [KEY, 'WithoutMetadata'] })
    ).not.toContain('cdkd import');
    expect(unwrittenCreateOnlyRefusal({ ...input, evidence: [KEY] })).toContain('cdkd import');
    const nested = unwrittenCreateOnlyRefusal({ ...input, nested: true });
    expect(nested).not.toContain('cdkd import');
    expect(nested).not.toContain('--recreate-via-cc-api');
    expect(nested).toContain('--replace (which creates the new resource before deleting');
  });

  it('adds the protection note only with evidence, naming the opt-in flags', () => {
    const input = { ...base, unwritten: [KEY], routeDriving: [], nowWritten: [KEY] };
    expect(unwrittenCreateOnlyRefusal(input)).not.toContain('AWS refuses to delete');
    const msg = unwrittenCreateOnlyRefusal({
      ...input,
      protectionEvidence: 'DeletionProtection: true',
    });
    expect(msg).toContain('DeletionProtection: true');
    expect(msg).toContain('--recreate-via-cc-api IcebergTable or --replace');
    // Inside a nested child only --replace reaches the resource, the note too.
    const nested = unwrittenCreateOnlyRefusal({
      ...input,
      nested: true,
      protectionEvidence: 'DeletionProtection: true',
    });
    expect(nested).toContain('DeletionProtection: true');
    expect(nested).not.toContain('--recreate-via-cc-api');
  });

  it('keeps the #2790 text byte-identical when nothing is handled', () => {
    const input = { ...base, unwritten: [KEY], routeDriving: [KEY] };
    expect(unwrittenCreateOnlyRefusal({ ...input, nowWritten: [] })).toBe(
      unwrittenCreateOnlyRefusal(input)
    );
    expect(unwrittenCreateOnlyRefusal(input)).toContain('To keep dropping it');
  });
});

describe('the `cdkd diff` preview (findUnwrittenCreateOnlyRefusals)', () => {
  const row: ResourceChange = {
    logicalId: 'IcebergTable',
    changeType: 'UPDATE',
    resourceType: TYPE,
    desiredProperties: RECORD,
    currentProperties: WRITTEN,
    propertyChanges: [
      { path: KEY, oldValue: undefined, newValue: RECORD[KEY], requiresReplacement: true },
    ],
  };
  const record: ResourceState = {
    physicalId: 'ns|t',
    resourceType: TYPE,
    properties: RECORD,
    attributes: {},
    dependencies: [],
    provisionedBy: 'sdk',
    acceptedCreateOnlyDrops: [KEY],
  };

  it('labels the row and says no --prefer-sdk-route keeps it', () => {
    const reasons = findUnwrittenCreateOnlyRefusals(new Map([['IcebergTable', row]]), {
      IcebergTable: record,
    });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('CREATE_ONLY_DROP_NEEDS_REPLACEMENT');
    expect(reasons[0]).toContain(`This cdkd version's SDK provider writes ${KEY}`);
    expect(reasons[0]).toContain(`a deploy with ${KEY} removed from the template changes nothing.`);
    expect(reasons[0]).not.toContain('a deploy passing --prefer-sdk-route');
  });

  it('with a still-dropped key too, keeps only the drops in --prefer-sdk-route', () => {
    const SUBNET = 'AWS::EC2::Subnet';
    const subnet = { VpcId: 'vpc-1', CidrBlock: '10.0.0.0/24', AvailabilityZoneId: 'use1-az1' };
    const reasons = findUnwrittenCreateOnlyRefusals(
      new Map([
        [
          'MySubnet',
          {
            logicalId: 'MySubnet',
            changeType: 'UPDATE',
            resourceType: SUBNET,
            desiredProperties: subnet,
            currentProperties: { VpcId: 'vpc-1' },
            propertyChanges: ['AvailabilityZoneId', 'CidrBlock'].map((path) => ({
              path,
              oldValue: undefined,
              newValue: subnet[path as keyof typeof subnet],
              requiresReplacement: true,
            })),
          } satisfies ResourceChange,
        ],
      ]),
      {
        MySubnet: {
          physicalId: 'subnet-1',
          resourceType: SUBNET,
          properties: subnet,
          attributes: {},
          dependencies: [],
          provisionedBy: 'sdk',
          acceptedCreateOnlyDrops: ['AvailabilityZoneId', 'CidrBlock'],
        },
      }
    );
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("This cdkd version's SDK provider writes CidrBlock");
    expect(reasons[0]).toContain(
      `a deploy with CidrBlock removed from the template and --prefer-sdk-route ${SUBNET}:AvailabilityZoneId changes nothing.`
    );
  });
});
