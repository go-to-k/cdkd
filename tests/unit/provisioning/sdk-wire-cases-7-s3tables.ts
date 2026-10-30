import { describe, expect, it } from 'vite-plus/test';
import {
  ACCOUNT,
  TAG_THROWS,
  armFor,
  createOnlyOf,
  record,
  type Bag,
  type Throw,
  type TypeCase,
} from './sdk-wire-harness.js';
import { S3TablesProvider } from '../../../src/provisioning/providers/s3-tables-provider.js';

/**
 * The S3 Tables wire cases of the seventh batch (#3723): the table bucket, the
 * namespace and the table, all served by `S3TablesProvider`.
 */

const BUCKET_ARN = `arn:aws:s3tables:us-east-1:${ACCOUNT}:bucket/tb`;

const TAGS = [
  { Key: 'k1', Value: 'v1' },
  { Key: 'k2', Value: 'v2' },
];

const ALL_DIRECTIONS = ['create', 'update-add', 'update-remove'];

const DEST_BUCKET_ARN = `arn:aws:s3tables:us-east-1:${ACCOUNT}:bucket/dest`;

// Not a gap: a configuration property with a declarable default whose
// CloudFormation removal reset is unmeasured is left at its AWS value, with a
// warning (s3-tables-provider.ts, applyTableBucketConfigUpdate /
// applyTableMaintenanceUpdate; go-to-k/cdkd#2762).
const KEPT_ON_REMOVAL =
  'a removed configuration property with a declarable default is left at its AWS value and warned about';

// Not a gap: `WithoutMetadata: Yes` asks for a table with no schema, which is
// CreateTable without `metadata`; it is create-only, so no update reads it.
const NO_METADATA = 'WithoutMetadata declares a table with no schema: CreateTable without metadata';

const required = (name: string): Throw => ({
  why: `create() refuses a missing ${name} before any call (s3-tables-provider.ts)`,
  says: new RegExp(`${name} is required`),
});

/**
 * The table the record names. It differs from every bag's Namespace and
 * TableName on purpose: `planTableRename` compares the desired names with the
 * PHYSICAL ID, not `previousProperties` (s3-tables-provider.ts:1612-1622), so
 * only an id naming another table makes an update owe a RenameTable whose
 * `newNamespaceName` / `newName` the probes can read (go-to-k/cdkd#5319).
 */
export const TABLE_PHYSICAL_ID = `${BUCKET_ARN}|ns_live|tbl_live`;

// Not a gap: the rename is planned from `next` against the physical id, and a
// key the template omits keeps the table's current name
// (s3-tables-provider.ts:1651-1668); `prev` is never read for it. A removal
// from `prev` alone sends the same request; its update-add probe observes
// delivery. (Namespace and TableName are required by CloudFormation, so their
// removal is not a template that deploys anyway.)
const RENAME_FROM_NEXT =
  'RenameTable is planned from next against the physical id; prev is not read for Namespace / TableName / Name';

// Not a gap: `Format` is cdkd's legacy alias of `OpenTableFormat`
// (s3-tables-provider.ts:212-216), read only by create (:857-859). There is no
// UpdateTable API (:356), the SDK's `OpenTableFormat` enum has the single
// member `ICEBERG`, and the CFn-canonical `OpenTableFormat` is create-only, so
// the engine replaces on any change the schema can spell.
const FORMAT_CREATE_ONLY =
  'Format (legacy OpenTableFormat alias) is read only by create; no UpdateTable API exists';

export const S3TABLES_CASES: TypeCase[] = [
  {
    resourceType: 'AWS::S3Tables::TableBucket',
    provider: () => new S3TablesProvider(),
    physicalId: BUCKET_ARN,
    createOnly: createOnlyOf('AWS::S3Tables::TableBucket'),
    exempt: {},
    targets: [
      { path: ['Tags', 0], command: 'UntagResourceCommand', names: 'k1', notNames: 'k2' },
      { path: ['Tags', 1], command: 'UntagResourceCommand', names: 'k2', notNames: 'k1' },
    ],
    bags: [
      {
        name: 'every declared property',
        bag: {
          TableBucketName: 'tb',
          Tags: TAGS,
          EncryptionConfiguration: {
            SSEAlgorithm: 'aws:kms',
            KMSKeyArn: `arn:aws:kms:us-east-1:${ACCOUNT}:key/k`,
          },
          StorageClassConfiguration: { StorageClass: 'INTELLIGENT_TIERING' },
          MetricsConfiguration: { Status: 'Enabled' },
          UnreferencedFileRemoval: { Status: 'Enabled', UnreferencedDays: 5, NoncurrentDays: 7 },
          ReplicationConfiguration: {
            Role: `arn:aws:iam::${ACCOUNT}:role/r`,
            Rules: [{ Destinations: [{ DestinationTableBucketARN: DEST_BUCKET_ARN }] }],
          },
        },
        variants: { 'MetricsConfiguration.Status': 'Disabled' },
        expectedSilent: {
          'update-remove:EncryptionConfiguration': KEPT_ON_REMOVAL,
          'update-remove:StorageClassConfiguration': KEPT_ON_REMOVAL,
          'update-remove:UnreferencedFileRemoval': KEPT_ON_REMOVAL,
        },
        expectedRemovalThrows: {
          'create:TableBucketName': required('TableBucketName'),
          ...TAG_THROWS(ALL_DIRECTIONS, 2),
        },
      },
    ],
  },
  {
    resourceType: 'AWS::S3Tables::Namespace',
    provider: () => new S3TablesProvider(),
    physicalId: `${BUCKET_ARN}|ns`,
    // Both properties are create-only, so no update probe runs: update() is a
    // documented no-op for a namespace (s3-tables-provider.ts:414-416).
    createOnly: createOnlyOf('AWS::S3Tables::Namespace'),
    exempt: {},
    targets: [],
    bags: [
      {
        name: 'every declared property',
        bag: { TableBucketARN: BUCKET_ARN, Namespace: 'ns' },
        expectedRemovalThrows: {
          'create:TableBucketARN': required('TableBucketARN'),
          'create:Namespace': required('Namespace'),
        },
      },
      {
        // A singleton list is accepted too (`addPropertyOverride`,
        // s3-tables-provider.ts:674-680); its emptied form is refused.
        name: 'namespace as a singleton list',
        bag: { TableBucketARN: BUCKET_ARN, Namespace: ['ns'] },
        expectedRemovalThrows: {
          'create:TableBucketARN': required('TableBucketARN'),
          'create:Namespace': required('Namespace'),
          'create:Namespace.0': required('Namespace'),
        },
      },
    ],
  },
  {
    resourceType: 'AWS::S3Tables::Table',
    provider: () => new S3TablesProvider(),
    physicalId: TABLE_PHYSICAL_ID,
    createOnly: createOnlyOf('AWS::S3Tables::Table'),
    wholeFromNext: {
      keys: (key) => key === 'Namespace' || key === 'TableName' || key === 'Name',
      reason: RENAME_FROM_NEXT,
    },
    exempt: {},
    targets: [
      { path: ['Tags', 0], command: 'UntagResourceCommand', names: 'k1', notNames: 'k2' },
      { path: ['Tags', 1], command: 'UntagResourceCommand', names: 'k2', notNames: 'k1' },
    ],
    bags: [
      {
        name: 'the CFn-canonical spellings',
        bag: {
          TableBucketARN: BUCKET_ARN,
          Namespace: 'ns',
          TableName: 'tbl',
          OpenTableFormat: 'ICEBERG',
          Tags: TAGS,
          StorageClassConfiguration: { StorageClass: 'INTELLIGENT_TIERING' },
          Compaction: { Status: 'enabled', TargetFileSizeMB: 256 },
          SnapshotManagement: { Status: 'enabled', MinSnapshotsToKeep: 2, MaxSnapshotAgeHours: 200 },
          IcebergMetadata: {
            IcebergSchema: {
              SchemaFieldList: [{ Id: 1, Name: 'c1', Type: 'int', Required: true }],
            },
            IcebergSchemaV2: {
              SchemaV2FieldType: 'struct',
              SchemaId: 3,
              IdentifierFieldIds: [1],
              SchemaV2FieldList: [{ Id: 1, Name: 'c1', Type: 'long', Required: true, Doc: 'd' }],
            },
            IcebergPartitionSpec: {
              SpecId: 4,
              Fields: [{ SourceId: 1, Transform: 'identity', Name: 'p1', FieldId: 1000 }],
            },
            IcebergSortOrder: {
              OrderId: 5,
              Fields: [{ SourceId: 1, Transform: 'identity', Direction: 'asc', NullOrder: 'nulls-first' }],
            },
            TableProperties: { 'write.format.default': 'parquet' },
          },
        },
        variants: {
          'IcebergMetadata.IcebergSortOrder.Fields.0.Direction': 'desc',
          'IcebergMetadata.IcebergSortOrder.Fields.0.NullOrder': 'nulls-last',
        },
        expectedSilent: {
          'update-remove:Compaction': KEPT_ON_REMOVAL,
          'update-remove:SnapshotManagement': KEPT_ON_REMOVAL,
        },
        expectedRemovalThrows: {
          'create:TableBucketARN': required('TableBucketARN'),
          'create:Namespace': required('Namespace'),
          'create:TableName': required('TableName'),
          'create:OpenTableFormat': required('OpenTableFormat'),
          ...TAG_THROWS(ALL_DIRECTIONS, 2),
        },
      },
      {
        name: 'a table with no schema',
        bag: {
          TableBucketARN: BUCKET_ARN,
          Namespace: 'ns',
          TableName: 'tbl',
          OpenTableFormat: 'ICEBERG',
          WithoutMetadata: 'Yes',
        },
        expectedSilent: {
          'create:WithoutMetadata': NO_METADATA,
          'create-vary:WithoutMetadata': NO_METADATA,
        },
        expectedRemovalThrows: {
          'create:TableBucketARN': required('TableBucketARN'),
          'create:Namespace': required('Namespace'),
          'create:TableName': required('TableName'),
          'create:OpenTableFormat': required('OpenTableFormat'),
        },
      },
      {
        name: 'the legacy Name / Format aliases',
        bag: {
          TableBucketARN: BUCKET_ARN,
          Namespace: 'ns',
          Name: 'tbl',
          Format: 'ICEBERG',
        },
        expectedSilent: {
          'update-add:Format': FORMAT_CREATE_ONLY,
          'update-remove:Format': FORMAT_CREATE_ONLY,
          'update-vary:Format': FORMAT_CREATE_ONLY,
        },
        expectedRemovalThrows: {
          'create:TableBucketARN': required('TableBucketARN'),
          'create:Namespace': required('Namespace'),
          'create:Name': required('TableName'),
          'create:Format': required('OpenTableFormat'),
        },
      },
    ],
  },
];

const TABLE = S3TABLES_CASES.find((t) => t.resourceType === 'AWS::S3Tables::Table')!;

/** The one write of `command` an update sent, its body parsed, and the result. */
async function updateTable(
  next: Bag,
  prev: Bag
): Promise<{ result: unknown; writes: { command: string; body: Record<string, unknown> }[] }> {
  armFor(TABLE, prev);
  let result: unknown;
  const outcome = await record(async () => {
    result = await TABLE.provider().update('L', TABLE.physicalId, TABLE.resourceType, next, prev);
  });
  expect(outcome).toMatchObject({ threw: false });
  const writes = (outcome as { wire: string }).wire
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as unknown[])
    .map((entry) => ({
      command: entry[0] as string,
      body: JSON.parse(entry[entry.length - 1] as string) as Record<string, unknown>,
    }));
  return { result, writes };
}

/**
 * What the bag probes cannot read: the bodies of the RenameTable a Table update
 * sends (the probes see only that the wire changed), the physical id the
 * update hands back, and what create() records for `Ref` (go-to-k/cdkd#5346).
 */
export function describeS3tablesExtras(): void {
  describe('AWS::S3Tables::Table rename in place (go-to-k/cdkd#5319)', () => {
    const base = { TableBucketARN: BUCKET_ARN, OpenTableFormat: 'ICEBERG' };

    it('a TableName change renames the recorded table and keeps it in place', async () => {
      const bag = { ...base, Namespace: 'ns_live', TableName: 'tbl_new' };
      const { result, writes } = await updateTable(bag, { ...bag, TableName: 'tbl_live' });
      expect(writes).toEqual([
        {
          command: 'RenameTableCommand',
          body: { newName: 'tbl_new' },
        },
      ]);
      expect(result).toEqual({
        physicalId: `${BUCKET_ARN}|ns_live|tbl_new`,
        wasReplaced: false,
      });
    });

    it('a Namespace change moves the recorded table and keeps it in place', async () => {
      const bag = { ...base, Namespace: 'ns_new', TableName: 'tbl_live' };
      const { result, writes } = await updateTable(bag, { ...bag, Namespace: 'ns_live' });
      expect(writes).toEqual([
        {
          command: 'RenameTableCommand',
          body: { newNamespaceName: 'ns_new' },
        },
      ]);
      expect(result).toEqual({
        physicalId: `${BUCKET_ARN}|ns_new|tbl_live`,
        wasReplaced: false,
      });
    });

    it('addresses the RenameTable by the table the physical id names', async () => {
      // The table is addressed in the REST path, not the body.
      const bag = { ...base, Namespace: 'ns_new', TableName: 'tbl_new' };
      armFor(TABLE, bag);
      const outcome = await record(() =>
        TABLE.provider().update('L', TABLE.physicalId, TABLE.resourceType, bag, bag)
      );
      expect(outcome).toMatchObject({ threw: false });
      const [entry] = (outcome as { wire: string }).wire
        .split('\n')
        .map((line) => JSON.parse(line) as unknown[]);
      expect(entry![0]).toBe('RenameTableCommand');
      expect(decodeURIComponent(entry![2] as string)).toContain(`/ns_live/tbl_live/rename`);
      expect(JSON.parse(entry![5] as string)).toEqual({
        newNamespaceName: 'ns_new',
        newName: 'tbl_new',
      });
    });

    it('sends no RenameTable when the names match the recorded table', async () => {
      const bag = { ...base, Namespace: 'ns_live', TableName: 'tbl_live' };
      const { result, writes } = await updateTable(bag, bag);
      expect(writes).toEqual([]);
      expect(result).toEqual({ physicalId: TABLE.physicalId, wasReplaced: false });
    });
  });

  // go-to-k/cdkd#5346 lives in the intrinsic resolver (refs.ts), not here: no
  // request this provider sends changed. What the resolver reads is the
  // `TableARN` attribute create() records from CreateTable's answer, never
  // the composite physical id, which carries no segment of it.
  describe('AWS::S3Tables::Table records the TableARN its Ref resolves to (go-to-k/cdkd#5346)', () => {
    it('records CreateTable tableARN as the TableARN attribute beside the composite id', async () => {
      armFor(TABLE, {});
      let created: unknown;
      const outcome = await record(async () => {
        created = await TABLE.provider().create('L', TABLE.resourceType, {
          TableBucketARN: BUCKET_ARN,
          Namespace: 'ns',
          TableName: 'tbl',
          OpenTableFormat: 'ICEBERG',
        });
      });
      expect(outcome).toMatchObject({ threw: false });
      expect(created).toEqual({
        physicalId: `${BUCKET_ARN}|ns|tbl`,
        attributes: { TableARN: `arn:aws:svc:us-east-1:${ACCOUNT}:fake-tableARN` },
      });
    });
  });
}
