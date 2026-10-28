import {
  ACCOUNT,
  DECLARED_DEFAULT,
  createOnlyOf,
  paths,
  setOutputOverrides,
  type Bag,
  type Throw,
  type TypeCase,
} from './sdk-wire-harness.js';
import { DynamoDBGlobalTableProvider } from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';

/**
 * `AWS::DynamoDB::GlobalTable` (#3723), run by
 * `sdk-wire-coverage-18-globaltable.test.ts`. Its settle waits poll what the
 * last write left, so the fake is stateful across the calls of one provider
 * run: a ReplicaUpdates Create / Delete adds or removes the replica, a
 * DeletionProtectionEnabled write is what the next describe reads, and every
 * status reads ACTIVE, so each wait settles on its first poll.
 */

const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const TABLE = 'gt';
const TABLE_ARN = `arn:aws:dynamodb:us-east-1:${ACCOUNT}:table/${TABLE}`;
const STREAM_ARN = `${TABLE_ARN}/stream/2026-01-01T00:00:00.000`;

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v ?? {}) as Rec;
const DIMENSIONS = (scope: 'table' | 'index'): string[] => [
  `dynamodb:${scope}:ReadCapacityUnits`,
  `dynamodb:${scope}:WriteCapacityUnits`,
];

/**
 * The live global table a bag describes, as every DynamoDB / Application Auto
 * Scaling client reads it (the fake cannot tell regions apart, so the
 * deploy-region replica speaks for the table): ACTIVE, every index ACTIVE,
 * its table class, on-demand maxima, keys and deletion protection echoed, its
 * Kinesis destination and scaling targets registered.
 */
function armGlobalTable(_physicalId: string, bag: Bag): void {
  const declared = (bag['Replicas'] as Rec[] | undefined) ?? [];
  const local = declared.find((r) => r['Region'] === 'us-east-1') ?? {};
  const replicas = new Set<string>(declared.map((r) => String(r['Region'])));
  let deletionProtection =
    (local['DeletionProtectionEnabled'] ?? bag['DeletionProtectionEnabled']) === true;
  const gsis = (bag['GlobalSecondaryIndexes'] as Rec[] | undefined) ?? [];
  const localGsi = (name: unknown): Rec =>
    ((local['GlobalSecondaryIndexes'] as Rec[] | undefined) ?? []).find(
      (g) => g['IndexName'] === name
    ) ?? {};
  const ttl = bag['TimeToLiveSpecification'] as Rec | undefined;
  const sse = rec(bag['SSESpecification']);
  const keyOf = (r: Rec): unknown => rec(r['SSESpecification'])['KMSMasterKeyId'];
  const onDemand = (read: unknown, write: unknown): Rec => ({
    ...(rec(read)['MaxReadRequestUnits'] !== undefined && {
      MaxReadRequestUnits: rec(read)['MaxReadRequestUnits'],
    }),
    ...(rec(write)['MaxWriteRequestUnits'] !== undefined && {
      MaxWriteRequestUnits: rec(write)['MaxWriteRequestUnits'],
    }),
  });
  const kinesis = rec(local['KinesisStreamSpecification']);
  const destinations = new Map<string, unknown>();
  if (kinesis['StreamArn']) {
    destinations.set(String(kinesis['StreamArn']), kinesis['ApproximateCreationDateTimePrecision']);
  }
  const policies = new Map<string, string>();
  const scalingIds = [
    `table/${TABLE}`,
    ...gsis.map((g) => `table/${TABLE}/index/${String(g['IndexName'])}`),
  ];
  const scope = (id: string): 'table' | 'index' => (id.includes('/index/') ? 'index' : 'table');
  setOutputOverrides({
    DescribeTableCommand: () => ({
      Table: {
        TableName: TABLE,
        TableArn: TABLE_ARN,
        TableStatus: 'ACTIVE',
        LatestStreamArn: STREAM_ARN,
        DeletionProtectionEnabled: deletionProtection,
        BillingModeSummary: { BillingMode: bag['BillingMode'] ?? 'PAY_PER_REQUEST' },
        TableClassSummary: { TableClass: local['TableClass'] ?? 'STANDARD' },
        OnDemandThroughput: onDemand(
          local['ReadOnDemandThroughputSettings'],
          bag['WriteOnDemandThroughputSettings']
        ),
        SSEDescription:
          sse['SSEEnabled'] === true
            ? { Status: 'ENABLED', SSEType: 'KMS', KMSMasterKeyArn: keyOf(local) }
            : { Status: 'DISABLED' },
        GlobalSecondaryIndexes: gsis.map((g) => ({
          IndexName: g['IndexName'],
          IndexStatus: 'ACTIVE',
          KeySchema: g['KeySchema'],
          Projection: g['Projection'],
          OnDemandThroughput: onDemand(
            localGsi(g['IndexName'])['ReadOnDemandThroughputSettings'],
            g['WriteOnDemandThroughputSettings']
          ),
          ...(g['WarmThroughput'] ? { WarmThroughput: { ...rec(g['WarmThroughput']), Status: 'ACTIVE' } } : {}),
        })),
        Replicas: [...replicas].map((RegionName) => {
          const key = keyOf(declared.find((r) => r['Region'] === RegionName) ?? {});
          return {
            RegionName,
            ReplicaStatus: 'ACTIVE',
            ...(key !== undefined && { KMSMasterKeyId: key }),
          };
        }),
      },
    }),
    CreateTableCommand: () => ({
      TableDescription: { TableName: TABLE, TableArn: TABLE_ARN, TableStatus: 'CREATING' },
    }),
    UpdateTableCommand: (input) => {
      for (const u of (input['ReplicaUpdates'] as Record<string, Rec>[] | undefined) ?? []) {
        if (u['Create']) replicas.add(String(u['Create']['RegionName']));
        if (u['Delete']) replicas.delete(String(u['Delete']['RegionName']));
      }
      if (typeof input['DeletionProtectionEnabled'] === 'boolean') {
        deletionProtection = input['DeletionProtectionEnabled'];
      }
      return {};
    },
    DescribeTimeToLiveCommand: () => ({
      TimeToLiveDescription:
        ttl?.['Enabled'] === true
          ? { TimeToLiveStatus: 'ENABLED', AttributeName: ttl['AttributeName'] }
          : { TimeToLiveStatus: 'DISABLED' },
    }),
    PutResourcePolicyCommand: (input) => {
      policies.set(String(input['ResourceArn']), String(input['Policy']));
      return {};
    },
    GetResourcePolicyCommand: (input) => {
      const policy = policies.get(String(input['ResourceArn']));
      return policy === undefined ? {} : { Policy: policy };
    },
    EnableKinesisStreamingDestinationCommand: (input) => {
      destinations.set(
        String(input['StreamArn']),
        rec(input['EnableKinesisStreamingConfiguration'])['ApproximateCreationDateTimePrecision']
      );
      return {};
    },
    UpdateKinesisStreamingDestinationCommand: (input) => {
      destinations.set(
        String(input['StreamArn']),
        rec(input['UpdateKinesisStreamingConfiguration'])['ApproximateCreationDateTimePrecision']
      );
      return {};
    },
    DisableKinesisStreamingDestinationCommand: (input) => {
      destinations.delete(String(input['StreamArn']));
      return {};
    },
    DescribeKinesisStreamingDestinationCommand: () => ({
      KinesisDataStreamDestinations: [...destinations].map(([StreamArn, precision]) => ({
        StreamArn,
        DestinationStatus: 'ACTIVE',
        ...(precision ? { ApproximateCreationDateTimePrecision: precision } : {}),
      })),
    }),
    // The live tags are what the previous deploy left on the deploy-region
    // replica. Only readCurrentState reads them (dynamodb-globaltable-provider.ts:7775):
    // create and update diff the recorded Tags, so no write path depends on it.
    ListTagsOfResourceCommand: () => ({ Tags: (local['Tags'] as unknown[] | undefined) ?? [] }),
    // Every target the provider asks after is registered with its policy: a
    // target the previous deploy did not declare is re-registered anyway,
    // since its previous settings differ (reconcile's registered && unchanged).
    DescribeScalableTargetsCommand: (input) => ({
      ScalableTargets: ((input['ResourceIds'] as string[] | undefined) ?? []).flatMap((ResourceId) =>
        DIMENSIONS(scope(ResourceId)).map((ScalableDimension) => ({
          ServiceNamespace: 'dynamodb',
          ResourceId,
          ScalableDimension,
          MinCapacity: 1,
          MaxCapacity: 10,
        }))
      ),
    }),
    DescribeScalingPoliciesCommand: () => ({
      ScalingPolicies: scalingIds.flatMap((ResourceId) =>
        DIMENSIONS(scope(ResourceId)).map((ScalableDimension) => ({
          PolicyName: `${ResourceId}-${ScalableDimension}`,
          ServiceNamespace: 'dynamodb',
          ResourceId,
          ScalableDimension,
          PolicyType: 'TargetTrackingScaling',
        }))
      ),
    }),
  });
}

const KEYS = {
  KeySchema: [
    { AttributeName: 'pk', KeyType: 'HASH' },
    { AttributeName: 'sk', KeyType: 'RANGE' },
  ],
  AttributeDefinitions: [
    { AttributeName: 'pk', AttributeType: 'S' },
    { AttributeName: 'sk', AttributeType: 'S' },
    { AttributeName: 'g', AttributeType: 'S' },
  ],
};
const POLICY = (sid: string): Record<string, unknown> => ({
  Version: '2012-10-17',
  Statement: [
    {
      Sid: sid,
      Effect: 'Allow',
      Principal: { AWS: `arn:aws:iam::${ACCOUNT}:root` },
      Action: 'dynamodb:GetItem',
      Resource: '*',
    },
  ],
});
const SCALING = (min: number, max: number): Record<string, unknown> => ({
  MinCapacity: min,
  MaxCapacity: max,
  SeedCapacity: min + 1,
  TargetTrackingScalingPolicyConfiguration: {
    TargetValue: 70,
    ScaleInCooldown: 60,
    ScaleOutCooldown: 90,
    DisableScaleIn: true,
  },
});
const LSI = [
  {
    IndexName: 'lsi',
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'g', KeyType: 'RANGE' },
    ],
    Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['c'] },
  },
];

const PROVISIONED_BAG: Bag = {
  TableName: TABLE,
  ...fresh(KEYS),
  BillingMode: 'PROVISIONED',
  StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
  WriteProvisionedThroughputSettings: { WriteCapacityAutoScalingSettings: SCALING(5, 20) },
  GlobalSecondaryIndexes: [
    {
      IndexName: 'gsi',
      KeySchema: [{ AttributeName: 'g', KeyType: 'HASH' }],
      Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['a', 'b'] },
      WriteProvisionedThroughputSettings: { WriteCapacityAutoScalingSettings: SCALING(3, 9) },
      WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 },
      ReadProvisionedThroughputSettings: { ReadCapacityUnits: 6 },
    },
  ],
  LocalSecondaryIndexes: fresh(LSI),
  SSESpecification: { SSEEnabled: true, SSEType: 'KMS' },
  TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
  Replicas: [
    {
      Region: 'us-east-1',
      ReadProvisionedThroughputSettings: { ReadCapacityAutoScalingSettings: SCALING(4, 16) },
      GlobalSecondaryIndexes: [
        {
          IndexName: 'gsi',
          ReadProvisionedThroughputSettings: { ReadCapacityAutoScalingSettings: SCALING(2, 8) },
          ContributorInsightsSpecification: { Enabled: true, Mode: 'THROTTLED_KEYS' },
        },
      ],
      ContributorInsightsSpecification: { Enabled: true, Mode: 'ACCESSED_AND_THROTTLED_KEYS' },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: 10 },
      KinesisStreamSpecification: {
        StreamArn: `arn:aws:kinesis:us-east-1:${ACCOUNT}:stream/s`,
        ApproximateCreationDateTimePrecision: 'MICROSECOND',
      },
      SSESpecification: { KMSMasterKeyId: `arn:aws:kms:us-east-1:${ACCOUNT}:key/k` },
      DeletionProtectionEnabled: true,
      TableClass: 'STANDARD_INFREQUENT_ACCESS',
      Tags: [
        { Key: 'k1', Value: 'v1' },
        { Key: 'k2', Value: 'v2' },
      ],
    },
    {
      Region: 'us-west-2',
      ReadProvisionedThroughputSettings: { ReadCapacityUnits: 5 },
      SSESpecification: { KMSMasterKeyId: `arn:aws:kms:us-west-2:${ACCOUNT}:key/w` },
      GlobalSecondaryIndexes: [
        { IndexName: 'gsi', ReadProvisionedThroughputSettings: { ReadCapacityUnits: 3 } },
      ],
    },
  ],
};

const ON_DEMAND_BAG: Bag = {
  TableName: TABLE,
  ...fresh(KEYS),
  BillingMode: 'PAY_PER_REQUEST',
  StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
  WriteOnDemandThroughputSettings: { MaxWriteRequestUnits: 50 },
  DeletionProtectionEnabled: true,
  GlobalSecondaryIndexes: [
    {
      IndexName: 'gsi',
      KeySchema: [{ AttributeName: 'g', KeyType: 'HASH' }],
      Projection: { ProjectionType: 'KEYS_ONLY' },
      WriteOnDemandThroughputSettings: { MaxWriteRequestUnits: 10 },
      ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 30 },
    },
  ],
  Replicas: [
    {
      Region: 'us-east-1',
      ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 100 },
      GlobalSecondaryIndexes: [
        { IndexName: 'gsi', ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 20 } },
      ],
      ReplicaStreamSpecification: {
        Tags: [
          { Key: 's1', Value: 'v1' },
          { Key: 's2', Value: 'v2' },
        ],
      },
    },
    { Region: 'us-west-2' },
  ],
};

/**
 * A replica resource policy is refused in the deploy that creates the replica
 * whenever the table has a cross-region replica (CloudFormation refuses it
 * too), so the policies ride on a single-region table, where create sends
 * them. `GlobalTableSettingsReplicationMode` rides here for the same reason:
 * CloudFormation refuses it unless the table has exactly one replica
 * (go-to-k/cdkd#5489).
 */
const SINGLE_REGION_BAG: Bag = {
  TableName: TABLE,
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
  BillingMode: 'PAY_PER_REQUEST',
  StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
  Replicas: [
    {
      Region: 'us-east-1',
      ResourcePolicy: { PolicyDocument: POLICY('table') },
      ReplicaStreamSpecification: { ResourcePolicy: { PolicyDocument: POLICY('stream') } },
      GlobalTableSettingsReplicationMode: 'ENABLED',
    },
  ],
};

const S = 'dynamodb-globaltable-provider.ts';
const RS = 'dynamodb-replica-settings.ts';

/**
 * Every probe label the harness makes for `bag`: the three removal directions
 * for each path, and the two varies for each scalar leaf.
 */
function labelsOf(bag: Bag): string[] {
  const out: string[] = [];
  for (const p of paths(bag)) {
    let v: unknown = bag;
    for (const seg of p) v = (v as Record<string | number, unknown>)[seg];
    const label = p.join('.');
    out.push(`create:${label}`, `update-add:${label}`, `update-remove:${label}`);
    if (v === null || typeof v !== 'object') out.push(`create-vary:${label}`, `update-vary:${label}`);
  }
  return out;
}

/** `[directions, path pattern, value]`: every label of `bag` both match. */
type Rule<T> = [RegExp, RegExp, T];
function pick<T>(bag: Bag, rules: Rule<T>[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const label of labelsOf(bag)) {
    const [direction, path] = [label.slice(0, label.indexOf(':')), label.slice(label.indexOf(':') + 1)];
    const rule = rules.find(([d, pth]) => d.test(direction) && pth.test(path));
    if (rule && !(label in out)) out[label] = rule[2];
  }
  return out;
}

const ANY = /./;
const UPD = /^update-(add|remove)$/;
const REMOVE = /^update-remove$/;
const VARY_ON_UPDATE = /^update-vary$/;

const KEY_SCHEMA_REFUSED: Throw = {
  why: `update() refuses a KeySchema change before any call: DynamoDB cannot change a table's key, and the refusal names the replace flags (${S}:3554-3565)`,
  says: /KeySchema is immutable on AWS::DynamoDB::GlobalTable/,
};
const LSI_REFUSED: Throw = {
  why: `update() refuses a changed LocalSecondaryIndexes list before any call: DynamoDB has no API to change one (${S}:3566-3578)`,
  says: /LocalSecondaryIndexes is immutable on AWS::DynamoDB::GlobalTable/,
};
const ATTRIBUTE_REMOVAL_REFUSED: Throw = {
  why: `update() refuses removing an attribute a key schema still references (${S}:3606)`,
  says: /AttributeDefinitions removals are immutable .*key schema still references/,
};
const REPLICA_TAGS_REFUSED: Throw = {
  why: `a replica Tags entry without its Key or Value is refused before any call (${S}, refuseMalformedReplicaTags)`,
  says: /is not a list of tags with a non-empty string Key/,
};
const REPLICA_POLICY_ON_CREATE: Throw = {
  why: `a replica resource policy is refused in the deploy that creates the replica, as CloudFormation refuses it (measured 2026-10-27, ${S}:9346-9359); a previous template with no deploy-region replica is not one a deploy can leave`,
  says: /cannot be set in the deploy that creates the replica/,
};
const NO_KEY_FOR_REPLICA: Throw = {
  why: `a previous template without the deploy-region replica (or its SSESpecification) is not one a deploy can leave, and the update then finds no key for the replicas it re-keys (${S}:2382-2394)`,
  says: /no key is declared or reported for/,
};

const REQUIRED_ON_CREATE: Record<string, Throw> = {
  'create:KeySchema': {
    why: `create() refuses a table with no KeySchema before any call (${S}:699)`,
    says: /KeySchema is required for DynamoDB GlobalTable/,
  },
  'create:AttributeDefinitions': {
    why: `create() refuses a table with no AttributeDefinitions before any call (${S}:706)`,
    says: /AttributeDefinitions is required for DynamoDB GlobalTable/,
  },
};

/** The key-schema and attribute probes every bag makes alike. */
function keyThrows(bag: Bag): Record<string, Throw> {
  return {
    ...REQUIRED_ON_CREATE,
    ...pick(bag, [
      [UPD, /^KeySchema\./, KEY_SCHEMA_REFUSED],
      [REMOVE, /^AttributeDefinitions(\.\d+(\.AttributeName)?)?$/, ATTRIBUTE_REMOVAL_REFUSED],
    ]),
  };
}
const KEYS_SILENT =
  `KeySchema and AttributeDefinitions are required by the CloudFormation schema; UpdateTable carries AttributeDefinitions only beside a GSI Create (${S}:5438-5460), and the KeySchema guard needs both sides (${S}:3555-3557), so these probes have nothing to send`;
function keySilent(bag: Bag): Record<string, string> {
  return pick(bag, [
    [/^update-add$/, /^(KeySchema|AttributeDefinitions(\..*)?)$/, KEYS_SILENT],
    [REMOVE, /^KeySchema$/, KEYS_SILENT],
    [REMOVE, /^AttributeDefinitions\.\d+\.AttributeType$/, KEYS_SILENT],
    [VARY_ON_UPDATE, /^(KeySchema|AttributeDefinitions)\./, KEYS_SILENT],
  ]);
}

const BILLING_DEFAULT = `an absent BillingMode is PAY_PER_REQUEST on create and update (${S}:741-745, requireConfigString's default), the declared value; CFn unmeasured`;
const STREAM_FORCED = `a table with more than one replica needs a NEW_AND_OLD_IMAGES stream, so create() enables it without the block and update() cannot turn it off (go-to-k/cdkd#1723, ${S}:999-1030)`;
const STREAM_VIEW_DEFAULT = `an absent StreamViewType is NEW_AND_OLD_IMAGES (${S}:952-993), the declared value`;
const GSI_READ_SHADOWED = `the index-level read throughput is only the fallback of the deploy-region replica's own GlobalSecondaryIndexes entry, which this bag declares and which wins (${S}:10612-10618, 10770-10772, 10856); CFn precedence unmeasured`;
const GSI_SHAPE_WARNED = `a changed index KeySchema / Projection is warned about ("recreate the index") with no call (${S}:5632-5644); CFn unmeasured`;
const SEED = `SeedCapacity is the initial capacity of a PAY_PER_REQUEST -> PROVISIONED switch only; a create starts at MinCapacity, as CloudFormation does (live-measured, go-to-k/cdkd#1427 / #1435, ${S}:10528-10557), and RegisterScalableTarget has no seed member`;
const LSI_VARY = `the varied LocalSecondaryIndexes entry is refused like its removal (${S}:3566-3578), so the vary sees no wire`;
const SSE_KEY_PASS = `the table's customer managed key goes through the replica-key pass on a table with cross-region replicas (measured, ${S}:4664-4676), which sends nothing while the declared key is the live one; SSEEnabled / SSEType with that key only re-spell the same encryption (an absent SSEEnabled is true, an absent SSEType with SSEEnabled is KMS, ${S}:9506-9520)`;

const PROVISIONED_THROWS: Record<string, Throw> = {
  ...keyThrows(PROVISIONED_BAG),
  ...pick(PROVISIONED_BAG, [
    [UPD, /^LocalSecondaryIndexes(\..*)?$/, LSI_REFUSED],
    [/^(create|update-remove)$/, /^Replicas\.0\.KinesisStreamSpecification\.StreamArn$/, {
      why: `a replica Kinesis destination without its StreamArn is refused before any call (${RS}:105)`,
      says: /KinesisStreamSpecification\.StreamArn is required/,
    }],
    [/^(create|update-add|update-remove)$/, /^Replicas\.0\.Tags\.\d+\.(Key|Value)$/, REPLICA_TAGS_REFUSED],
    [/^update-add$/, /^Replicas\.0\.Region$/, NO_KEY_FOR_REPLICA],
  ]),
};
const PROVISIONED_SILENT: Record<string, string> = {
  ...keySilent(PROVISIONED_BAG),
  ...pick(PROVISIONED_BAG, [
    [VARY_ON_UPDATE, /^LocalSecondaryIndexes\./, LSI_VARY],
    [/^(create|create-vary|update-vary)$/, /SeedCapacity$/, SEED],
    [ANY, /^GlobalSecondaryIndexes\.0\.ReadProvisionedThroughputSettings/, GSI_READ_SHADOWED],
    [/^create$/, /^SSESpecification\.SSEEnabled$/, `an absent SSEEnabled is true (${S}:9514), the declared value`],
    [/^update-add$/, /^SSESpecification\.(SSEEnabled|SSEType)$/, SSE_KEY_PASS],
    [/^update-(remove|vary)$/, /^SSESpecification\.SSEType$/, SSE_KEY_PASS],
    [/^create$/, /^StreamSpecification$/, STREAM_FORCED],
    [REMOVE, /^StreamSpecification$/, STREAM_FORCED],
    [/^create$/, /^StreamSpecification\.StreamViewType$/, STREAM_VIEW_DEFAULT],
    [/^create$/, /^TimeToLiveSpecification\.Enabled$/, `Enabled is required by the CloudFormation schema; an absent one reads as true (dynamodb-ttl.ts:30-36), so the reduced create sends the same enable`],
    [REMOVE, /^TimeToLiveSpecification\.AttributeName$/, `a TTL declared enabled with no AttributeName has nothing UpdateTimeToLive can name (dynamodb-ttl.ts:72-76); CFn unmeasured`],
    [VARY_ON_UPDATE, /^GlobalSecondaryIndexes\.0\.(KeySchema|Projection)\./, GSI_SHAPE_WARNED],
  ]),
};

const ON_DEMAND_THROWS: Record<string, Throw> = {
  ...keyThrows(ON_DEMAND_BAG),
  ...pick(ON_DEMAND_BAG, [
    [/^(create|update-remove)$/, /^Replicas\.0\.ReplicaStreamSpecification\.Tags\.\d+\.(Key|Value)$/, {
      why: `a replica stream tag without its Key or Value is refused before any call (${RS}, readStreamTags; go-to-k/cdkd#5489)`,
      says: /ReplicaStreamSpecification\.Tags must be a list of tags/,
    }],
  ]),
};
const ON_DEMAND_SILENT: Record<string, string> = {
  ...keySilent(ON_DEMAND_BAG),
  ...pick(ON_DEMAND_BAG, [
    [/^(create|update-add|update-remove)$/, /^BillingMode$/, BILLING_DEFAULT],
    [/^create$/, /^StreamSpecification$/, STREAM_FORCED],
    [REMOVE, /^StreamSpecification$/, STREAM_FORCED],
    [/^create$/, /^StreamSpecification\.StreamViewType$/, STREAM_VIEW_DEFAULT],
    [ANY, /^GlobalSecondaryIndexes\.0\.ReadOnDemandThroughputSettings/, GSI_READ_SHADOWED],
    [VARY_ON_UPDATE, /^GlobalSecondaryIndexes\.0\.(KeySchema|Projection)\./, GSI_SHAPE_WARNED],
  ]),
};

const SINGLE_REGION_THROWS: Record<string, Throw> = {
  ...keyThrows(SINGLE_REGION_BAG),
  ...pick(SINGLE_REGION_BAG, [
    [/^(create|update-remove)$/, /PolicyDocument$/, {
      why: `a replica ResourcePolicy without its PolicyDocument is refused before any call (${RS}:132)`,
      says: /PolicyDocument must be a policy object or a JSON string/,
    }],
    [/^update-add$/, /^Replicas(\.0(\.Region)?)?$/, REPLICA_POLICY_ON_CREATE],
  ]),
};
const SINGLE_REGION_SILENT: Record<string, string> = {
  ...keySilent(SINGLE_REGION_BAG),
  ...pick(SINGLE_REGION_BAG, [
    [/^(create|update-add|update-remove)$/, /^BillingMode$/, BILLING_DEFAULT],
    [/^create$/, /^StreamSpecification\.StreamViewType$/, STREAM_VIEW_DEFAULT],
    // A removed whole entry still sends one call: the recorded replication
    // mode is reset to DISABLED (go-to-k/cdkd#5489).
    [REMOVE, /^Replicas\.0\.Region$/, `Replicas is required by the CloudFormation schema, and the deploy-region replica is the table itself: no deployable template drops it`],
    [/vary$/, /^Replicas\.0\.Region$/, `any other Region makes the replica cross-region, whose ResourcePolicy is refused in the deploy that creates it (${S}:9346-9359), so the vary sees no wire`],
    [VARY_ON_UPDATE, /^Replicas\.0\.GlobalTableSettingsReplicationMode$/, `the update-vary base drops the whole replica entry, so the update re-creates the deploy-region replica, whose ResourcePolicy is refused in the deploy that creates it; the create-vary shows the varied mode reaching CreateTable, and the unit suite pins the UpdateTable (go-to-k/cdkd#5489)`],
  ]),
};

const GLOBAL_TABLE_CASE: TypeCase = {
  resourceType: 'AWS::DynamoDB::GlobalTable',
  provider: () => new DynamoDBGlobalTableProvider(),
  physicalId: TABLE,
  createOnly: createOnlyOf('AWS::DynamoDB::GlobalTable'),
  arm: armGlobalTable,
  exempt: {
    TableClass:
      'not an AWS::DynamoDB::GlobalTable property (CloudFormation refuses it, measured on go-to-k/cdkd#5355): the provider reads it only as the fallback of the deploy-region Replicas[].TableClass, which the provisioned bag carries (dynamodb-globaltable-provider.ts, 9524-9541)',
  },
  targets: [
    { path: ['Replicas', 0, 'Tags', 0], command: 'UntagResourceCommand', names: '"k1"', notNames: '"k2"' },
    { path: ['Replicas', 0, 'Tags', 1], command: 'UntagResourceCommand', names: '"k2"', notNames: '"k1"' },
  ],
  bags: [
    {
      name: 'provisioned',
      bag: fresh(PROVISIONED_BAG),
      expectedSilent: PROVISIONED_SILENT,
      expectedRemovalThrows: PROVISIONED_THROWS,
    },
    {
      name: 'on-demand',
      bag: fresh(ON_DEMAND_BAG),
      expectedSilent: ON_DEMAND_SILENT,
      expectedRemovalThrows: ON_DEMAND_THROWS,
    },
    {
      name: 'single-region',
      bag: fresh(SINGLE_REGION_BAG),
      expectedSilent: SINGLE_REGION_SILENT,
      expectedRemovalThrows: SINGLE_REGION_THROWS,
    },
  ],
};

export const CASES_18_GLOBAL_TABLE: TypeCase[] = [GLOBAL_TABLE_CASE];
