import { describe, expect, it } from 'vite-plus/test';
import {
  ACCOUNT,
  createOnlyOf,
  record,
  setOutputOverrides,
  type Bag,
  type Throw,
  type TypeCase,
} from './sdk-wire-harness.js';
import type { ResourceProvider } from '../../../src/types/resource.js';
import {
  GlueConnectionProvider,
  GlueCrawlerProvider,
  GlueJobProvider,
  GlueProvider,
  GlueSecurityConfigurationProvider,
  GlueTriggerProvider,
  GlueWorkflowProvider,
} from '../../../src/provisioning/providers/glue-provider.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

/**
 * The ninth batch of wire cases (#3723): every Glue provider class, all in
 * `glue-provider.ts` and all on `@aws-sdk/client-glue` (plus STS for the
 * caller account a tag ARN or a catalog check needs). Run by
 * `sdk-wire-coverage-9.test.ts`, which mocks both clients and registers the
 * direct-call block below.
 */

const TAGS = { k1: 'v1', k2: 'v2' };
const ROLE = `arn:aws:iam::${ACCOUNT}:role/glue`;
const KMS = `arn:aws:kms:us-east-1:${ACCOUNT}:key/k1`;

/** Removing one key of the two-tag map must untag exactly that key. */
const TAG_TARGETS: TypeCase['targets'] = [
  { path: ['Tags', 'k1'], command: 'UntagResourceCommand', names: 'k1', notNames: 'k2' },
  { path: ['Tags', 'k2'], command: 'UntagResourceCommand', names: 'k2', notNames: 'k1' },
];

const REQUIRED = (why: string, says: RegExp): Throw => ({ why, says });

/**
 * The reason every Glue `update()` re-sends a top-level from `next` alone:
 * each Update* call takes the whole definition (`UpdateDatabase` /
 * `UpdateTable` the whole input block, `UpdateWorkflow` / `UpdateJob` /
 * `UpdateCrawler` / `UpdateConnection` / `UpdateTrigger` every member), built
 * from the desired bag with no `previousProperties` fallback for a valid
 * value. A member removed from the template is simply not sent, so an
 * update-remove probe compares two identical requests; the update-add probe
 * observes the delivery.
 */
const WHOLE_FROM_NEXT =
  'every Update* call is built from the desired bag alone, a removed member not sent (glue-provider.ts, each update())';

// --- AWS::Glue::Database ----------------------------------------------------------

/**
 * GetDatabase (the pre-update read of `readLiveDatabaseParameters`) answers
 * the PREVIOUS bag's `DatabaseInput.Parameters`: the live database holds
 * what the last deploy sent. A key the desired side dropped is then live, so
 * the read-merge-write either drops it (it was the template's) or carries it
 * (it was AWS-authored), and the update-remove probe observes which.
 */
function armDatabase(_physicalId: string, bag: Bag): void {
  const input = (bag['DatabaseInput'] ?? {}) as Record<string, unknown>;
  setOutputOverrides({
    GetDatabaseCommand: () => ({
      Database: { Name: 'db', Parameters: input['Parameters'] ?? {} },
    }),
  });
}

const DATABASE_INPUT_REQUIRED = REQUIRED(
  'DatabaseInput is required: create() and update() refuse a database without it before any call (glue-provider.ts:1250-1257, 1336-1344)',
  /DatabaseInput is required for Glue Database/
);
const DATABASE_NAME_REQUIRED = REQUIRED(
  'a database needs DatabaseInput.Name or the top-level DatabaseName: create() refuses one with neither (glue-provider.ts:1263-1272)',
  /DatabaseInput\.Name or top-level DatabaseName is required/
);
const PRINCIPAL_REFUSED = REQUIRED(
  'a default-permission Principal naming no DataLakePrincipalIdentifier is refused before any call rather than sent as an empty grant (usableDefaultPermissions, glue-provider.ts:2605-2631)',
  /CreateTableDefaultPermissions carries an entry cdkd cannot read/
);

const DATABASE_CASE: TypeCase = {
  resourceType: 'AWS::Glue::Database',
  provider: () => new GlueProvider(),
  physicalId: 'db',
  createOnly: createOnlyOf('AWS::Glue::Database'),
  arm: armDatabase,
  // UpdateDatabase replaces `DatabaseInput` wholesale (glue-provider.ts:1378-1395):
  // `previousProperties` is read only as the fallback for a MALFORMED nested
  // block and for the AWS-authored `Parameters` keys the read-merge-write
  // keeps, a key live but declared by neither side, which the arm (live = the
  // previous bag) never holds.
  wholeFromNext: { keys: (key) => key === 'DatabaseInput', reason: WHOLE_FROM_NEXT },
  exempt: {},
  targets: [
    // The read-merge-write must not resurrect a key the template dropped: it
    // is live, but the previous template declared it.
    {
      path: ['DatabaseInput', 'Parameters', 'p1'],
      command: 'UpdateDatabaseCommand',
      names: '"p2":"v2"',
      notNames: '"p1"',
    },
  ],
  bags: [
    {
      name: 'every plain member, default permissions',
      bag: {
        CatalogId: ACCOUNT,
        DatabaseName: 'db',
        DatabaseInput: {
          Description: 'd',
          LocationUri: 's3://bucket/db',
          Parameters: { p1: 'v1', p2: 'v2' },
          CreateTableDefaultPermissions: [
            {
              Permissions: ['ALL', 'SELECT'],
              Principal: { DataLakePrincipalIdentifier: 'IAM_ALLOWED_PRINCIPALS' },
            },
          ],
        },
      },
      expectedSilent: {
        'update-remove:CatalogId':
          'update() sends updateCatalogId(next) and never reads the recorded CatalogId for the call (glue-provider.ts:1374, 1441), so a removal compares two requests that both omit it; the recorded side reaches only the catalog-move check',
        'update-vary:CatalogId':
          'a changed CatalogId moves the database to another catalog, which update() refuses before any call (refuseCatalogMove, glue-provider.ts:1360-1372)',
      },
      expectedRemovalThrows: {
        'create:DatabaseInput': DATABASE_INPUT_REQUIRED,
        'update-add:DatabaseInput': DATABASE_INPUT_REQUIRED,
        'update-remove:DatabaseInput': DATABASE_INPUT_REQUIRED,
        'create:DatabaseName': DATABASE_NAME_REQUIRED,
        ...Object.fromEntries(
          ['create', 'update-add', 'update-remove'].map((d) => [
            `${d}:DatabaseInput.CreateTableDefaultPermissions.0.Principal.DataLakePrincipalIdentifier`,
            PRINCIPAL_REFUSED,
          ])
        ),
      },
    },
    {
      name: 'nested name, resource link',
      bag: {
        DatabaseInput: {
          Name: 'db',
          TargetDatabase: { CatalogId: '210987654321', DatabaseName: 'src', Region: 'us-west-2' },
        },
      },
      expectedSilent: {
        'update-add:DatabaseInput.Name':
          'the name is the physical id: update() sends it as the fallback when the block omits it (buildDatabaseInput, glue-provider.ts:2461-2463)',
        'update-vary:DatabaseInput.Name':
          'a renamed database is refused before any call (refuseNestedRename, glue-provider.ts:1346-1359)',
      },
      expectedRemovalThrows: {
        'create:DatabaseInput': DATABASE_INPUT_REQUIRED,
        'update-add:DatabaseInput': DATABASE_INPUT_REQUIRED,
        'update-remove:DatabaseInput': DATABASE_INPUT_REQUIRED,
        'create:DatabaseInput.Name': DATABASE_NAME_REQUIRED,
      },
    },
    {
      name: 'federated',
      bag: {
        DatabaseName: 'db',
        DatabaseInput: {
          FederatedDatabase: { ConnectionName: 'conn', Identifier: 'ext-id' },
        },
      },
      expectedRemovalThrows: {
        'create:DatabaseInput': DATABASE_INPUT_REQUIRED,
        'update-add:DatabaseInput': DATABASE_INPUT_REQUIRED,
        'update-remove:DatabaseInput': DATABASE_INPUT_REQUIRED,
        'create:DatabaseName': DATABASE_NAME_REQUIRED,
      },
    },
  ],
};

// --- AWS::Glue::Table -------------------------------------------------------------

const TABLE_ID = 'db|tbl';

/**
 * GetTable (the pre-update read of `readLiveTableState`) answers the PREVIOUS
 * bag's `TableInput.Parameters` and `StorageDescriptor` (the CFn spelling of
 * both is the SDK's), with a fixed version: the live table holds what the
 * last deploy sent.
 */
function armTable(_physicalId: string, bag: Bag): void {
  const input = (bag['TableInput'] ?? {}) as Record<string, unknown>;
  setOutputOverrides({
    GetTableCommand: () => ({
      Table: {
        Name: 'tbl',
        DatabaseName: 'db',
        VersionId: '7',
        Parameters: input['Parameters'] ?? {},
        ...(input['StorageDescriptor'] !== undefined && {
          StorageDescriptor: input['StorageDescriptor'],
        }),
      },
    }),
  });
}

const TABLE_INPUT = {
  Name: 'tbl',
  Description: 'd',
  Owner: 'owner',
  Retention: 3,
  TableType: 'EXTERNAL_TABLE',
  Parameters: { classification: 'json', p2: 'v2' },
  PartitionKeys: [
    { Name: 'dt', Type: 'string', Comment: 'pc' },
    { Name: 'hr', Type: 'int' },
  ],
  StorageDescriptor: {
    Columns: [
      { Name: 'a', Type: 'string', Comment: 'ca' },
      { Name: 'b', Type: 'int' },
    ],
    Location: 's3://bucket/tbl/',
    InputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
    OutputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
    Compressed: false,
    NumberOfBuckets: 2,
    BucketColumns: ['a', 'b'],
    SortColumns: [
      { Column: 'a', SortOrder: 1 },
      { Column: 'b', SortOrder: 0 },
    ],
    Parameters: { sp1: 'x', sp2: 'y' },
    SerdeInfo: {
      Name: 'serde',
      SerializationLibrary: 'org.openx.data.jsonserde.JsonSerDe',
      Parameters: { 'serialization.format': '1', s2: 'z' },
    },
    SkewedInfo: {
      SkewedColumnNames: ['a'],
      SkewedColumnValues: ['v1'],
      SkewedColumnValueLocationMaps: { v1: 's3://bucket/tbl/v1/' },
    },
    StoredAsSubDirectories: false,
    SchemaReference: {
      SchemaId: { RegistryName: 'reg', SchemaName: 'sch' },
      SchemaVersionNumber: 1,
    },
  },
};

const TABLE_INPUT_REQUIRED = REQUIRED(
  'TableInput is required: create() and update() refuse a table without it before any call (glue-provider.ts:1572-1579, 1752-1760)',
  /TableInput is required for Glue Table/
);
const TABLE_NAME_REQUIRED = REQUIRED(
  'a table needs TableInput.Name or the top-level Name: create() refuses one with neither (glue-provider.ts:1585-1593)',
  /TableInput\.Name or top-level Name is required/
);
/** The create refusals every table bag carries, plus its table-name one. */
const TABLE_THROWS = (nameLabels: string[]): Record<string, Throw> => ({
  'create:DatabaseName': REQUIRED(
    'DatabaseName is required: create() refuses a table without it before any call (glue-provider.ts:1563-1570)',
    /DatabaseName is required for Glue Table/
  ),
  'create:TableInput': TABLE_INPUT_REQUIRED,
  ...Object.fromEntries(nameLabels.map((label) => [label, TABLE_NAME_REQUIRED])),
});
const OPEN_TABLE_FORMAT_CREATE_ONLY =
  'wired on create only: UpdateTable has no OpenTableFormatInput member, and IcebergInput is a create-time directive (glue-provider.ts:1602-1608)';

const TABLE_CASE: TypeCase = {
  resourceType: 'AWS::Glue::Table',
  provider: () => new GlueProvider(),
  physicalId: TABLE_ID,
  createOnly: createOnlyOf('AWS::Glue::Table'),
  arm: armTable,
  // UpdateTable replaces `TableInput` wholesale (glue-provider.ts:1829-1870):
  // `previousProperties` is read only to tell a key the template dropped from
  // one AWS authored (`preserveAwsManagedParameters` /
  // `preserveAwsManagedStorageDescriptor`), and the arm (live = the previous
  // bag) holds no AWS-authored key.
  wholeFromNext: { keys: (key) => key === 'TableInput', reason: WHOLE_FROM_NEXT },
  exempt: {},
  nestedExempt: Object.fromEntries(
    [
      '',
      '.Location',
      '.PartitionSpec',
      '.PartitionSpec.Fields',
      '.PartitionSpec.Fields.FieldId',
      '.PartitionSpec.Fields.Name',
      '.PartitionSpec.Fields.SourceId',
      '.PartitionSpec.Fields.Transform',
      '.PartitionSpec.SpecId',
      '.Properties',
      '.Schema',
      '.Schema.Fields',
      '.Schema.Fields.Doc',
      '.Schema.Fields.Id',
      '.Schema.Fields.Name',
      '.Schema.Fields.Required',
      '.Schema.Fields.Type',
      '.Schema.IdentifierFieldIds',
      '.Schema.SchemaId',
      '.Schema.Type',
      '.WriteOrder',
      '.WriteOrder.Fields',
      '.WriteOrder.Fields.Direction',
      '.WriteOrder.Fields.NullOrder',
      '.WriteOrder.Fields.SourceId',
      '.WriteOrder.Fields.Transform',
      '.WriteOrder.OrderId',
    ].map((rest) => [
      `OpenTableFormatInput.IcebergInput.IcebergTableInput${rest}`,
      'create() refuses an IcebergTableInput before any call: the CFn spelling is not the SDK member, so no bag can deliver it (enforceIcebergTableInputAbsent, go-to-k/cdkd#1454)',
    ])
  ),
  targets: [
    // The removed element must not ride along in the wholesale TableInput.
    {
      path: ['TableInput', 'StorageDescriptor', 'Columns', 0],
      command: 'UpdateTableCommand',
      names: '"Name":"b","Type":"int"',
      notNames: '"Comment":"ca"',
    },
    {
      path: ['TableInput', 'PartitionKeys', 0],
      command: 'UpdateTableCommand',
      names: '"Name":"hr"',
      notNames: '"Comment":"pc"',
    },
    // The read-merge-write must not resurrect a key the template dropped.
    {
      path: ['TableInput', 'Parameters', 'classification'],
      command: 'UpdateTableCommand',
      names: '"p2":"v2"',
      notNames: '"classification"',
    },
    {
      path: ['TableInput', 'StorageDescriptor', 'Parameters', 'sp1'],
      command: 'UpdateTableCommand',
      names: '"sp2":"y"',
      notNames: '"sp1"',
    },
  ],
  bags: [
    {
      name: 'every storage member, Iceberg create',
      bag: {
        CatalogId: ACCOUNT,
        DatabaseName: 'db',
        TableInput: TABLE_INPUT,
        OpenTableFormatInput: { IcebergInput: { MetadataOperation: 'CREATE', Version: '2' } },
      },
      expectedSilent: Object.fromEntries([
        ...['update-add', 'update-remove'].flatMap((d) =>
          ['', '.IcebergInput', '.IcebergInput.MetadataOperation', '.IcebergInput.Version'].map(
            (rest) => [`${d}:OpenTableFormatInput${rest}`, OPEN_TABLE_FORMAT_CREATE_ONLY]
          )
        ),
        ...['MetadataOperation', 'Version'].map((m) => [
          `update-vary:OpenTableFormatInput.IcebergInput.${m}`,
          OPEN_TABLE_FORMAT_CREATE_ONLY,
        ]),
      ]),
      expectedRemovalThrows: TABLE_THROWS(['create:TableInput.Name']),
    },
    {
      name: 'top-level name, schema by ARN and version id',
      bag: {
        DatabaseName: 'db',
        Name: 'tbl',
        TableInput: {
          StorageDescriptor: {
            Columns: [{ Name: 'a', Type: 'string' }],
            SchemaReference: {
              SchemaId: { SchemaArn: `arn:aws:glue:us-east-1:${ACCOUNT}:schema/reg/sch` },
              SchemaVersionId: 'svid',
            },
          },
        },
      },
      expectedRemovalThrows: {
        ...TABLE_THROWS(['create:Name']),
        'update-add:TableInput': TABLE_INPUT_REQUIRED,
        'update-remove:TableInput': TABLE_INPUT_REQUIRED,
      },
    },
    {
      name: 'view',
      bag: {
        DatabaseName: 'db',
        TableInput: {
          Name: 'tbl',
          TableType: 'VIRTUAL_VIEW',
          ViewOriginalText: '/* Presto View */',
          ViewExpandedText: '/* Presto View */',
          ViewDefinition: {
            Definer: ROLE,
            IsProtected: true,
            SubObjects: ['arn:aws:glue:us-east-1:123456789012:table/db/src1', 'arn:2'],
            Representations: [
              {
                Dialect: 'ATHENA',
                DialectVersion: '3',
                ViewOriginalText: 'SELECT 1',
                ViewExpandedText: 'SELECT 1',
                ValidationConnection: 'vc',
              },
            ],
          },
        },
      },
      expectedRemovalThrows: TABLE_THROWS(['create:TableInput.Name']),
    },
    {
      name: 'resource link',
      bag: {
        DatabaseName: 'db',
        TableInput: {
          Name: 'tbl',
          TargetTable: {
            CatalogId: '210987654321',
            DatabaseName: 'src',
            Name: 'srct',
            Region: 'us-west-2',
          },
        },
      },
      expectedRemovalThrows: TABLE_THROWS(['create:TableInput.Name']),
    },
  ],
};

// --- AWS::Glue::Workflow ----------------------------------------------------------

const WORKFLOW_CASE: TypeCase = {
  resourceType: 'AWS::Glue::Workflow',
  provider: () => new GlueWorkflowProvider(),
  physicalId: 'wf',
  createOnly: createOnlyOf('AWS::Glue::Workflow'),
  wholeFromNext: { keys: (key) => key !== 'Tags', reason: WHOLE_FROM_NEXT },
  exempt: {},
  targets: [
    ...TAG_TARGETS,
    {
      path: ['DefaultRunProperties', 'a'],
      command: 'UpdateWorkflowCommand',
      names: '"b":"2"',
      notNames: '"a":"1"',
    },
  ],
  bags: [
    {
      name: 'every property',
      bag: {
        Name: 'wf',
        Description: 'd',
        DefaultRunProperties: { a: '1', b: '2' },
        MaxConcurrentRuns: 2,
        Tags: TAGS,
      },
      expectedRemovalThrows: {
        'create:Name': REQUIRED(
          'Name is required: create() refuses a workflow without it before any call (glue-provider.ts:3379-3386)',
          /Name is required for Glue Workflow/
        ),
      },
    },
  ],
};

// --- AWS::Glue::SecurityConfiguration ---------------------------------------------

/**
 * A security configuration has no update API: `update()` always refuses
 * (glue-provider.ts:3811-3845), and the case marks `EncryptionConfiguration`
 * create-only beside the schema's `Name` (the schema lists only `Name`, but no
 * in-place path exists for the rest). The refusal is CloudFormation parity,
 * measured by a CFn A/B (us-east-1): an `EncryptionConfiguration` change shows
 * `Replacement: False` in the change set, then fails `UPDATE_FAILED` ("cannot
 * update a stack when a custom-named resource requires replacing") and rolls
 * back, and `Name` is required for this type, so CloudFormation always fails
 * there too. The
 * bag probes then skip every update comparison; only the harness's no-op
 * `settled` update would reach `update()`, which this provider answers in
 * place, and `describeGlueExtras` pins the real refusal with nothing on the
 * wire.
 */
function securityConfigurationProvider(): ResourceProvider {
  const real = new GlueSecurityConfigurationProvider();
  return Object.assign(Object.create(real) as ResourceProvider, {
    update: async (_logicalId: string, physicalId: string) => ({ physicalId, wasReplaced: false }),
  });
}

const SECURITY_CONFIGURATION_BAG: Bag = {
  Name: 'sc',
  EncryptionConfiguration: {
    S3Encryptions: [{ S3EncryptionMode: 'SSE-KMS', KmsKeyArn: KMS }],
    CloudWatchEncryption: { CloudWatchEncryptionMode: 'SSE-KMS', KmsKeyArn: KMS },
    JobBookmarksEncryption: { JobBookmarksEncryptionMode: 'CSE-KMS', KmsKeyArn: KMS },
  },
};

const SECURITY_CONFIGURATION_CASE: TypeCase = {
  resourceType: 'AWS::Glue::SecurityConfiguration',
  provider: securityConfigurationProvider,
  physicalId: 'sc',
  createOnly: new Set([
    ...createOnlyOf('AWS::Glue::SecurityConfiguration'),
    'EncryptionConfiguration',
  ]),
  exempt: {},
  targets: [],
  bags: [
    {
      name: 'every property',
      bag: SECURITY_CONFIGURATION_BAG,
      expectedRemovalThrows: {
        'create:Name': REQUIRED(
          'Name is required: create() refuses a security configuration without it before any call (glue-provider.ts:3764-3771)',
          /Name is required for Glue SecurityConfiguration/
        ),
        'create:EncryptionConfiguration': REQUIRED(
          'EncryptionConfiguration is required: create() refuses a security configuration without it before any call (glue-provider.ts:3773-3782)',
          /EncryptionConfiguration is required for Glue SecurityConfiguration/
        ),
      },
    },
  ],
};

// --- AWS::Glue::Job ---------------------------------------------------------------

const JOB_CASE: TypeCase = {
  resourceType: 'AWS::Glue::Job',
  provider: () => new GlueJobProvider(),
  physicalId: 'job',
  createOnly: createOnlyOf('AWS::Glue::Job'),
  wholeFromNext: { keys: (key) => key !== 'Tags', reason: WHOLE_FROM_NEXT },
  exempt: {},
  targets: [
    ...TAG_TARGETS,
    {
      path: ['Connections', 'Connections', 0],
      command: 'UpdateJobCommand',
      names: '"c2"',
      notNames: '"c1"',
    },
    {
      path: ['DefaultArguments', '--a'],
      command: 'UpdateJobCommand',
      names: '"--b":"2"',
      notNames: '"--a"',
    },
  ],
  bags: [
    {
      name: 'every property',
      bag: {
        Name: 'job',
        Role: ROLE,
        Command: {
          Name: 'glueetl',
          ScriptLocation: 's3://bucket/script.py',
          PythonVersion: '3',
          Runtime: 'Ray2.4',
        },
        Description: 'd',
        MaxCapacity: 2,
        MaxRetries: 1,
        Timeout: 60,
        ExecutionProperty: { MaxConcurrentRuns: 2 },
        GlueVersion: '4.0',
        NumberOfWorkers: 2,
        WorkerType: 'G.1X',
        DefaultArguments: { '--a': '1', '--b': '2' },
        NonOverridableArguments: { '--c': '3', '--d': '4' },
        Connections: { Connections: ['c1', 'c2'] },
        LogUri: 's3://bucket/logs/',
        SecurityConfiguration: 'sc',
        NotificationProperty: { NotifyDelayAfter: 5 },
        ExecutionClass: 'STANDARD',
        JobMode: 'SCRIPT',
        JobRunQueuingEnabled: true,
        MaintenanceWindow: 'Sun:12',
        AllocatedCapacity: 2,
        SourceControlDetails: {
          Provider: 'GITHUB',
          Repository: 'repo',
          Owner: 'owner',
          Branch: 'main',
          Folder: 'jobs',
          LastCommitId: 'abc',
          AuthStrategy: 'PERSONAL_ACCESS_TOKEN',
          AuthToken: 'tok',
        },
        Tags: TAGS,
      },
      expectedRemovalThrows: {
        'create:Role': REQUIRED(
          'Role is required: create() refuses a job without it before any call (glue-provider.ts:4469-4475)',
          /Role is required for Glue Job/
        ),
        'create:Command': REQUIRED(
          'Command is required: create() refuses a job without it before any call (glue-provider.ts:4476-4482)',
          /Command is required for Glue Job/
        ),
      },
    },
  ],
};

// --- AWS::Glue::Crawler -----------------------------------------------------------

const CRAWLER_CASE: TypeCase = {
  resourceType: 'AWS::Glue::Crawler',
  provider: () => new GlueCrawlerProvider(),
  physicalId: 'crawler',
  createOnly: createOnlyOf('AWS::Glue::Crawler'),
  // Beside the shared reason: the ten settings in
  // CRAWLER_LEFT_IN_PLACE_ON_REMOVAL keep their live value when removed, as
  // CloudFormation keeps them (CFn A/B, glue-provider.ts:5029-5052), and
  // `Targets` is re-sent whole.
  wholeFromNext: { keys: (key) => key !== 'Tags', reason: WHOLE_FROM_NEXT },
  exempt: {},
  targets: [
    ...TAG_TARGETS,
    {
      path: ['Classifiers', 0],
      command: 'UpdateCrawlerCommand',
      names: '"c2"',
      notNames: '"c1"',
    },
    {
      path: ['Targets', 'S3Targets', 0, 'Exclusions', 0],
      command: 'UpdateCrawlerCommand',
      names: '"*.bak"',
      notNames: '"*.tmp"',
    },
  ],
  bags: [
    {
      name: 'every property',
      bag: {
        Name: 'crawler',
        Role: ROLE,
        DatabaseName: 'db',
        Description: 'd',
        Schedule: { ScheduleExpression: 'cron(0 12 * * ? *)' },
        Classifiers: ['c1', 'c2'],
        TablePrefix: 'p_',
        SchemaChangePolicy: { UpdateBehavior: 'LOG', DeleteBehavior: 'LOG' },
        RecrawlPolicy: { RecrawlBehavior: 'CRAWL_EVERYTHING' },
        LineageConfiguration: { CrawlerLineageSettings: 'ENABLE' },
        LakeFormationConfiguration: { AccountId: ACCOUNT, UseLakeFormationCredentials: true },
        Configuration: '{"Version":1.0}',
        CrawlerSecurityConfiguration: 'sc',
        Tags: TAGS,
        Targets: {
          S3Targets: [
            {
              Path: 's3://bucket/data/',
              Exclusions: ['*.tmp', '*.bak'],
              ConnectionName: 'conn',
              SampleSize: 5,
              EventQueueArn: `arn:aws:sqs:us-east-1:${ACCOUNT}:q`,
              DlqEventQueueArn: `arn:aws:sqs:us-east-1:${ACCOUNT}:dlq`,
            },
          ],
          JdbcTargets: [
            {
              ConnectionName: 'jdbc',
              Path: 'db/%',
              Exclusions: ['x'],
              EnableAdditionalMetadata: ['COMMENTS'],
            },
          ],
          MongoDBTargets: [{ ConnectionName: 'mongo', Path: 'db/coll' }],
          DynamoDBTargets: [{ Path: 'ddb-table', ScanAll: true, ScanRate: 0.5 }],
          CatalogTargets: [
            {
              DatabaseName: 'cat-db',
              Tables: ['t1', 't2'],
              ConnectionName: 'cat-conn',
              EventQueueArn: `arn:aws:sqs:us-east-1:${ACCOUNT}:cq`,
              DlqEventQueueArn: `arn:aws:sqs:us-east-1:${ACCOUNT}:cdlq`,
            },
          ],
          DeltaTargets: [
            {
              DeltaTables: ['s3://bucket/delta/'],
              ConnectionName: 'delta',
              WriteManifest: true,
              CreateNativeDeltaTable: true,
            },
          ],
          IcebergTargets: [
            {
              Paths: ['s3://bucket/iceberg/'],
              ConnectionName: 'ice',
              Exclusions: ['y'],
              MaximumTraversalDepth: 3,
            },
          ],
          HudiTargets: [
            {
              Paths: ['s3://bucket/hudi/'],
              ConnectionName: 'hudi',
              Exclusions: ['z'],
              MaximumTraversalDepth: 4,
            },
          ],
        },
      },
      expectedRemovalThrows: {
        'create:Role': REQUIRED(
          'Role is required: create() refuses a crawler without it before any call (glue-provider.ts:5197-5203)',
          /Role is required for Glue Crawler/
        ),
        'create:Targets': REQUIRED(
          'Targets is required: create() refuses a crawler without it before any call (glue-provider.ts:5204-5210)',
          /Targets is required for Glue Crawler/
        ),
      },
    },
  ],
};

// --- AWS::Glue::Connection --------------------------------------------------------

const CONNECTION_CASE: TypeCase = {
  resourceType: 'AWS::Glue::Connection',
  provider: () => new GlueConnectionProvider(),
  physicalId: 'conn',
  createOnly: createOnlyOf('AWS::Glue::Connection'),
  wholeFromNext: { keys: (key) => key !== 'Tags', reason: WHOLE_FROM_NEXT },
  exempt: {},
  targets: [
    ...TAG_TARGETS,
    {
      path: ['ConnectionInput', 'MatchCriteria', 0],
      command: 'UpdateConnectionCommand',
      names: '"m2"',
      notNames: '"m1"',
    },
    {
      path: ['ConnectionInput', 'PhysicalConnectionRequirements', 'SecurityGroupIdList', 0],
      command: 'UpdateConnectionCommand',
      names: '"sg-2"',
      notNames: '"sg-1"',
    },
  ],
  bags: [
    {
      name: 'every property',
      bag: {
        CatalogId: ACCOUNT,
        Tags: TAGS,
        ConnectionInput: {
          Name: 'conn',
          ConnectionType: 'JDBC',
          Description: 'd',
          MatchCriteria: ['m1', 'm2'],
          ConnectionProperties: { JDBC_CONNECTION_URL: 'jdbc:mysql://h:3306/db', USERNAME: 'u' },
          PhysicalConnectionRequirements: {
            AvailabilityZone: 'us-east-1a',
            SecurityGroupIdList: ['sg-1', 'sg-2'],
            SubnetId: 'subnet-1',
          },
          SparkProperties: { s: '1' },
          AthenaProperties: { a: '2' },
          PythonProperties: { p: '3' },
          AuthenticationConfiguration: {
            AuthenticationType: 'OAUTH2',
            SecretArn: `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:s`,
            KmsKeyArn: KMS,
            BasicAuthenticationCredentials: { Username: 'bu', Password: 'bp' },
            CustomAuthenticationCredentials: { ck: 'cv' },
            OAuth2Properties: {
              OAuth2GrantType: 'AUTHORIZATION_CODE',
              TokenUrl: 'https://auth.example.com/token',
              TokenUrlParametersMap: { tk: 'tv' },
              OAuth2ClientApplication: {
                UserManagedClientApplicationClientId: 'client',
                AWSManagedClientApplicationReference: 'ref',
              },
              AuthorizationCodeProperties: {
                AuthorizationCode: 'code',
                RedirectUri: 'https://app.example.com/cb',
              },
              OAuth2Credentials: {
                UserManagedClientApplicationClientSecret: 'secret',
                AccessToken: 'at',
                RefreshToken: 'rt',
                JwtToken: 'jwt',
              },
            },
          },
          ValidateCredentials: true,
          ValidateForComputeEnvironments: ['SPARK', 'PYTHON'],
        },
      },
      expectedRemovalThrows: {
        'create:ConnectionInput': REQUIRED(
          'ConnectionInput is required: create() refuses a connection without it before any call (glue-provider.ts:5813-5820)',
          /ConnectionInput is required for Glue Connection/
        ),
      },
    },
  ],
};

// --- AWS::Glue::Trigger -----------------------------------------------------------

const TRIGGER_THROWS: Record<string, Throw> = {
  'create:Type': REQUIRED(
    'Type is required: create() refuses a trigger without it before any call (glue-provider.ts:6297-6303)',
    /Type is required for Glue Trigger/
  ),
  'create:Actions': REQUIRED(
    'Actions is required: create() refuses a trigger without it before any call (glue-provider.ts:6304-6310)',
    /Actions is required for Glue Trigger/
  ),
};

const TRIGGER_CASE: TypeCase = {
  resourceType: 'AWS::Glue::Trigger',
  provider: () => new GlueTriggerProvider(),
  physicalId: 'trig',
  createOnly: createOnlyOf('AWS::Glue::Trigger'),
  wholeFromNext: {
    keys: (key) => key !== 'Tags' && key !== 'StartOnCreation',
    reason: WHOLE_FROM_NEXT,
  },
  exempt: {},
  targets: [
    ...TAG_TARGETS,
    // `TriggerAction` serializes JobName first, CrawlerName last: the kept
    // crawler action alone, without the removed job action's arguments.
    {
      path: ['Actions', 0],
      command: 'UpdateTriggerCommand',
      names: '"Actions":[{"CrawlerName":"crawler"}]',
      notNames: '"--a"',
    },
  ],
  bags: [
    {
      name: 'conditional, every member',
      bag: {
        Name: 'trig',
        Type: 'CONDITIONAL',
        WorkflowName: 'wf',
        Description: 'd',
        StartOnCreation: true,
        Actions: [
          {
            JobName: 'job',
            Arguments: { '--a': '1', '--b': '2' },
            Timeout: 10,
            SecurityConfiguration: 'sc',
            NotificationProperty: { NotifyDelayAfter: 3 },
          },
          { CrawlerName: 'crawler' },
        ],
        Predicate: {
          Logical: 'AND',
          Conditions: [
            { LogicalOperator: 'EQUALS', JobName: 'job', State: 'SUCCEEDED' },
            { LogicalOperator: 'EQUALS', CrawlerName: 'crawler', CrawlState: 'SUCCEEDED' },
          ],
        },
        EventBatchingCondition: { BatchSize: 5, BatchWindow: 60 },
        Tags: TAGS,
      },
      expectedSilent: Object.fromEntries(
        ['update-add', 'update-remove', 'update-vary'].map((d) => [
          `${d}:StartOnCreation`,
          'read at create only: TriggerUpdate has no StartOnCreation member, and a trigger is started or stopped by StartTrigger / StopTrigger, never by its definition (glue-provider.ts:6244-6245, 6407-6423)',
        ])
      ),
      expectedRemovalThrows: TRIGGER_THROWS,
    },
    {
      name: 'scheduled',
      bag: {
        Name: 'trig',
        Type: 'SCHEDULED',
        Schedule: 'cron(0 12 * * ? *)',
        Actions: [{ JobName: 'job' }],
      },
      expectedRemovalThrows: TRIGGER_THROWS,
    },
  ],
};

export const CASES_9: TypeCase[] = [
  DATABASE_CASE,
  TABLE_CASE,
  WORKFLOW_CASE,
  SECURITY_CONFIGURATION_CASE,
  JOB_CASE,
  CRAWLER_CASE,
  CONNECTION_CASE,
  TRIGGER_CASE,
];

/** Direct-call checks the bag probes cannot make. */
export function describeGlueExtras(): void {
  describe('AWS::Glue::SecurityConfiguration update', () => {
    it('refuses an in-place update and sends nothing', async () => {
      let thrown: unknown;
      const outcome = await record(async () => {
        try {
          await new GlueSecurityConfigurationProvider().update(
            'L',
            'sc',
            'AWS::Glue::SecurityConfiguration',
            { ...SECURITY_CONFIGURATION_BAG, EncryptionConfiguration: {} },
            SECURITY_CONFIGURATION_BAG
          );
        } catch (error) {
          thrown = error;
        }
      });
      expect(outcome).toEqual({ threw: false, wire: '' });
      expect(thrown).toBeInstanceOf(ResourceUpdateNotSupportedError);
    });
  });
}
