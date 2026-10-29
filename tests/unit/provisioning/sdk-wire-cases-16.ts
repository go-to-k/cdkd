import {
  ACCOUNT,

  TAG_THROWS,
  createOnlyOf,
  setOutputOverrides,
  type Bag,
  type Throw,
  type TypeCase,
} from './sdk-wire-harness.js';
import { DynamoDBTableProvider } from '../../../src/provisioning/providers/dynamodb-table-provider.js';

/**
 * The sixteenth batch of wire cases (#3723): `AWS::DynamoDB::Table`, the one
 * type `DynamoDBTableProvider` handles, run by `sdk-wire-coverage-16.test.ts`.
 * The TimeToLive rate-limit wait (go-to-k/cdkd#5459) and the name-less
 * `Enabled: false` disable (go-to-k/cdkd#5452) both sit on the TTL paths the
 * bags probe.
 */

/** A copy sharing no object with any other bag (see `sdk-wire-cases-14.ts`). */
const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const TABLE_SRC = 'dynamodb-table-provider.ts';
const TABLE = 'table';
const TABLE_ARN = `arn:aws:dynamodb:us-east-1:${ACCOUNT}:table/${TABLE}`;
const STREAM_ARN = `${TABLE_ARN}/stream/2026-01-01T00:00:00.000`;
const KINESIS_ARN = `arn:aws:kinesis:us-east-1:${ACCOUNT}:stream/s`;
const KMS_KEY = `arn:aws:kms:us-east-1:${ACCOUNT}:key/k`;
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

/**
 * The live table a bag describes, as the fake reads answer it: ACTIVE, every
 * index ACTIVE, the declared blocks echoed. Kinesis destinations are tracked
 * across the calls of one provider run, so the enable's settle wait reads the
 * destination it just enabled and the disable's reads it gone.
 */
function armTable(_physicalId: string, bag: Bag): void {
  const kinesis = bag['KinesisStreamSpecification'] as Record<string, unknown> | undefined;
  const destinations = new Map<string, unknown>();
  if (kinesis?.['StreamArn']) {
    destinations.set(String(kinesis['StreamArn']), kinesis['ApproximateCreationDateTimePrecision']);
  }
  const gsis = (bag['GlobalSecondaryIndexes'] as Record<string, unknown>[] | undefined) ?? [];
  const ttl = bag['TimeToLiveSpecification'] as Record<string, unknown> | undefined;
  const pitr = bag['PointInTimeRecoverySpecification'] as Record<string, unknown> | undefined;
  const insights = bag['ContributorInsightsSpecification'] as Record<string, unknown> | undefined;
  const policy = bag['ResourcePolicy'] as Record<string, unknown> | undefined;
  setOutputOverrides({
    DescribeTableCommand: () => ({
      Table: {
        TableName: TABLE,
        TableArn: TABLE_ARN,
        TableId: 'table-id',
        TableStatus: 'ACTIVE',
        LatestStreamArn: STREAM_ARN,
        BillingModeSummary: { BillingMode: bag['BillingMode'] ?? 'PROVISIONED' },
        ...(bag['ProvisionedThroughput'] ? { ProvisionedThroughput: bag['ProvisionedThroughput'] } : {}),
        ...(bag['OnDemandThroughput'] ? { OnDemandThroughput: bag['OnDemandThroughput'] } : {}),
        ...(bag['WarmThroughput'] ? { WarmThroughput: { ...(bag['WarmThroughput'] as object), Status: 'ACTIVE' } } : {}),
        ...(bag['StreamSpecification']
          ? {
              StreamSpecification: {
                StreamEnabled: true,
                StreamViewType: (bag['StreamSpecification'] as Record<string, unknown>)['StreamViewType'],
              },
            }
          : {}),
        ...(bag['TableClass'] ? { TableClassSummary: { TableClass: bag['TableClass'] } } : {}),
        ...(bag['DeletionProtectionEnabled'] !== undefined
          ? { DeletionProtectionEnabled: bag['DeletionProtectionEnabled'] }
          : {}),
        GlobalSecondaryIndexes: gsis.map((g) => ({
          IndexName: g['IndexName'],
          IndexStatus: 'ACTIVE',
          KeySchema: g['KeySchema'],
          Projection: g['Projection'],
          ...(g['ProvisionedThroughput'] ? { ProvisionedThroughput: g['ProvisionedThroughput'] } : {}),
          ...(g['OnDemandThroughput'] ? { OnDemandThroughput: g['OnDemandThroughput'] } : {}),
          ...(g['WarmThroughput'] ? { WarmThroughput: { ...(g['WarmThroughput'] as object), Status: 'ACTIVE' } } : {}),
        })),
        ...(bag['LocalSecondaryIndexes'] ? { LocalSecondaryIndexes: bag['LocalSecondaryIndexes'] } : {}),
        ...(bag['SSESpecification'] ? { SSEDescription: { Status: 'ENABLED' } } : {}),
      },
    }),
    DescribeTimeToLiveCommand: () => ({
      TimeToLiveDescription:
        ttl?.['Enabled'] === true
          ? { TimeToLiveStatus: 'ENABLED', AttributeName: ttl['AttributeName'] }
          : { TimeToLiveStatus: 'DISABLED' },
    }),
    DescribeContinuousBackupsCommand: () => ({
      ContinuousBackupsDescription: {
        ContinuousBackupsStatus: 'ENABLED',
        PointInTimeRecoveryDescription: {
          PointInTimeRecoveryStatus: pitr?.['PointInTimeRecoveryEnabled'] === true ? 'ENABLED' : 'DISABLED',
        },
      },
    }),
    DescribeContributorInsightsCommand: () => ({
      ContributorInsightsStatus: insights?.['Enabled'] === true ? 'ENABLED' : 'DISABLED',
    }),
    GetResourcePolicyCommand: () =>
      policy ? { Policy: JSON.stringify(policy['PolicyDocument']) } : {},
    ListTagsOfResourceCommand: () => ({ Tags: (bag['Tags'] as unknown[] | undefined) ?? [] }),
    EnableKinesisStreamingDestinationCommand: (input) => {
      const config = input['EnableKinesisStreamingConfiguration'] as Record<string, unknown> | undefined;
      destinations.set(String(input['StreamArn']), config?.['ApproximateCreationDateTimePrecision']);
      return {};
    },
    UpdateKinesisStreamingDestinationCommand: (input) => {
      const config = input['UpdateKinesisStreamingConfiguration'] as Record<string, unknown> | undefined;
      destinations.set(String(input['StreamArn']), config?.['ApproximateCreationDateTimePrecision']);
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

const PROVISIONED_BAG: Bag = {
  TableName: TABLE,
  ...fresh(KEYS),
  BillingMode: 'PROVISIONED',
  ProvisionedThroughput: { ReadCapacityUnits: 7, WriteCapacityUnits: 6 },
  WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 },
  StreamSpecification: {
    StreamViewType: 'NEW_AND_OLD_IMAGES',
    ResourcePolicy: { PolicyDocument: POLICY('stream') },
  },
  GlobalSecondaryIndexes: [
    {
      IndexName: 'gsi',
      KeySchema: [{ AttributeName: 'g', KeyType: 'HASH' }],
      Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['a', 'b'] },
      ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 4 },
      WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 },
      ContributorInsightsSpecification: { Enabled: true, Mode: 'ACCESSED_AND_THROTTLED_KEYS' },
    },
  ],
  LocalSecondaryIndexes: [
    {
      IndexName: 'lsi',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'g', KeyType: 'RANGE' },
      ],
      Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['c'] },
    },
  ],
  SSESpecification: { SSEEnabled: true, SSEType: 'KMS', KMSMasterKeyId: KMS_KEY },
  Tags: [
    { Key: 'k1', Value: 'v1' },
    { Key: 'k2', Value: 'v2' },
  ],
  DeletionProtectionEnabled: true,
  TableClass: 'STANDARD_INFREQUENT_ACCESS',
  PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: 10 },
  TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
  ResourcePolicy: { PolicyDocument: POLICY('table') },
  KinesisStreamSpecification: {
    StreamArn: KINESIS_ARN,
    ApproximateCreationDateTimePrecision: 'MILLISECOND',
  },
  ContributorInsightsSpecification: { Enabled: true, Mode: 'THROTTLED_KEYS' },
};

const ON_DEMAND_BAG: Bag = {
  TableName: TABLE,
  ...fresh(KEYS),
  BillingMode: 'PAY_PER_REQUEST',
  OnDemandThroughput: { MaxReadRequestUnits: 100, MaxWriteRequestUnits: 50 },
  StreamSpecification: {
    StreamViewType: 'KEYS_ONLY',
    Tags: [
      { Key: 's1', Value: 'v1' },
      { Key: 's2', Value: 'v2' },
    ],
  },
  GlobalSecondaryIndexes: [
    {
      IndexName: 'gsi',
      KeySchema: [{ AttributeName: 'g', KeyType: 'HASH' }],
      Projection: { ProjectionType: 'KEYS_ONLY' },
      OnDemandThroughput: { MaxReadRequestUnits: 20, MaxWriteRequestUnits: 10 },
    },
  ],
};

const S = TABLE_SRC;

/** `<direction>:<path>` -> `value` for each direction. */
const each = <T>(directions: string[], path: string, value: T): Record<string, T> =>
  Object.fromEntries(directions.map((d) => [`${d}:${path}`, value]));
const UPDATE = ['update-add', 'update-remove'];

const REQUIRED_ON_CREATE: Record<string, Throw> = {
  'create:KeySchema': {
    why: `create() refuses a table with no KeySchema before any call (${S}:2124-2130)`,
    says: /KeySchema is required/,
  },
  'create:AttributeDefinitions': {
    why: `create() refuses a table with no AttributeDefinitions before any call (${S}:2132-2138)`,
    says: /AttributeDefinitions is required/,
  },
};

/**
 * `GlobalSecondaryIndexes.0.<path>` and every path beneath it, as the probe
 * labels them, for a bag's index.
 */
const gsiPaths = (index: Record<string, unknown>, member: string): string[] => {
  const out: string[] = [`GlobalSecondaryIndexes.0.${member}`];
  const walk = (v: unknown, prefix: string): void => {
    if (Array.isArray(v)) v.forEach((x, i) => (out.push(`${prefix}.${i}`), walk(x, `${prefix}.${i}`)));
    else if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) (out.push(`${prefix}.${k}`), walk(x, `${prefix}.${k}`));
    }
  };
  walk(index[member], `GlobalSecondaryIndexes.0.${member}`);
  return out;
};
const isLeafPath = (index: Record<string, unknown>, label: string): boolean => {
  let v: unknown = { GlobalSecondaryIndexes: [index] };
  for (const seg of label.split('.')) v = (v as Record<string, unknown>)[seg];
  return v === null || typeof v !== 'object';
};

const GSI_SHAPE_REFUSED: Throw = {
  why: `update() refuses a changed index KeySchema / Projection before any GSI call: DynamoDB cannot modify either in place (${S}:6345-6356)`,
  says: /changed its KeySchema or Projection, which DynamoDB cannot modify in place/,
};
const GSI_SHAPE_VARY =
  `the varied index KeySchema / Projection is refused like its removal (${S}:6345-6356), so the vary sees no wire`;

/** The removal throws and the vary entries of an index's KeySchema and Projection. */
function gsiShape(bag: Bag): { throws: Record<string, Throw>; silent: Record<string, string> } {
  const index = (bag['GlobalSecondaryIndexes'] as Record<string, unknown>[])[0]!;
  const labels = [...gsiPaths(index, 'KeySchema'), ...gsiPaths(index, 'Projection')];
  return {
    throws: Object.fromEntries(labels.flatMap((l) => UPDATE.map((d) => [`${d}:${l}`, GSI_SHAPE_REFUSED]))),
    silent: Object.fromEntries(
      labels.filter((l) => isLeafPath(index, l)).map((l) => [`update-vary:${l}`, GSI_SHAPE_VARY])
    ),
  };
}

/** Every AttributeDefinitions label the update probes make for a bag. */
function attributeDefinitionsSilent(bag: Bag): Record<string, string> {
  const why =
    `UpdateTable carries AttributeDefinitions only beside a GSI Create (${S}:7571-7573), so an ` +
    `attribute added or removed with no index change has nothing to send, as CloudFormation's ` +
    `"No interruption" for the property reads; a changed AttributeType of a shared attribute ` +
    `replaces the table (replacement-rules.ts, attributeTypeChangedForSharedAttribute)`;
  const defs = bag['AttributeDefinitions'] as Record<string, unknown>[];
  const labels = ['AttributeDefinitions'];
  defs.forEach((_, i) =>
    labels.push(`AttributeDefinitions.${i}`, `AttributeDefinitions.${i}.AttributeName`, `AttributeDefinitions.${i}.AttributeType`)
  );
  const out: Record<string, string> = {};
  for (const l of labels) {
    for (const d of UPDATE) out[`${d}:${l}`] = why;
    if (/\.(AttributeName|AttributeType)$/.test(l)) out[`update-vary:${l}`] = why;
  }
  return out;
}

const PROVISIONED_SHAPE = gsiShape(PROVISIONED_BAG);
const ON_DEMAND_SHAPE = gsiShape(ON_DEMAND_BAG);

const BILLING_MODE_DEFAULT =
  `an absent BillingMode is PROVISIONED on create (${S}:2167-2172) and on update (${S}:3017-3019), the reset CloudFormation applies (measured, issue #1553), so removing a declared PROVISIONED sends the same requests`;

const WARM_KEPT =
  `a removed WarmThroughput sends nothing (${S}:3745-3770, and per index ${S}:7440-7470): DynamoDB refuses a decrease ("decreasing WarmThroughput is not supported", measured, issue #1768) and has no unset, so the live value stays; CFn unmeasured`;

const TABLE_CASE: TypeCase = {
  resourceType: 'AWS::DynamoDB::Table',
  provider: () => new DynamoDBTableProvider(),
  physicalId: TABLE,
  // The schema fixture marks only TableName / ImportSourceSpecification.
  // `replacement-rules.ts` replaces on a KeySchema change. A
  // LocalSecondaryIndexes change is refused by update() before any call
  // (${S}:2827-2845): DynamoDB has no API for it and CloudFormation fails the
  // same update (measured, go-to-k/cdkd#5354, pinned by
  // dynamodb-table-provider-update-5354.test.ts), so it is marked create-only
  // here and its update probes are skipped.
  createOnly: new Set([...createOnlyOf('AWS::DynamoDB::Table'), 'KeySchema', 'LocalSecondaryIndexes']),
  arm: armTable,
  // The table's and the stream's resource policy and tags go out on the same
  // commands; the ARN says which subtree a request carries, so the
  // wrong-member trace tells them apart (go-to-k/cdkd#3723).
  roots: Object.fromEntries(
    ['PutResourcePolicyCommand', 'TagResourceCommand'].map((command) => [
      command,
      (input: Record<string, unknown>) =>
        String(input['ResourceArn']).includes('/stream/') ? 'stream' : 'table',
    ])
  ),
  exempt: {},
  targets: [
    { path: ['Tags', 0], command: 'UntagResourceCommand', names: '"k1"', notNames: '"k2"' },
    { path: ['Tags', 1], command: 'UntagResourceCommand', names: '"k2"', notNames: '"k1"' },
  ],
  bags: [
    {
      name: 'provisioned',
      bag: fresh(PROVISIONED_BAG),
      expectedSilent: {
        'create:BillingMode': BILLING_MODE_DEFAULT,
        ...each(UPDATE, 'BillingMode', BILLING_MODE_DEFAULT),
        ...attributeDefinitionsSilent(PROVISIONED_BAG),
        ...PROVISIONED_SHAPE.silent,
        'create:TimeToLiveSpecification.Enabled': `Enabled is required by the CloudFormation schema; an absent one reads as true (dynamodb-ttl.ts:30-36), so the reduced create sends the same enable`,
        'update-remove:TimeToLiveSpecification.AttributeName': `a TTL declared enabled with no AttributeName has nothing UpdateTimeToLive can name, so planTimeToLive sends no call whatever prev holds (dynamodb-ttl.ts:72-76); CFn unmeasured`,
        'update-remove:WarmThroughput': WARM_KEPT,
        'update-remove:GlobalSecondaryIndexes.0.WarmThroughput': WARM_KEPT,
        'update-remove:GlobalSecondaryIndexes.0.WarmThroughput.ReadUnitsPerSecond': WARM_KEPT,
        'update-remove:GlobalSecondaryIndexes.0.WarmThroughput.WriteUnitsPerSecond': WARM_KEPT,
        'update-remove:GlobalSecondaryIndexes.0.ProvisionedThroughput': `an index of a PROVISIONED table must carry ProvisionedThroughput, and UpdateTable has no unset for it, so a removed one sends no index update (applyGsiUpdates); CFn unmeasured`,
        'update-remove:KinesisStreamSpecification.ApproximateCreationDateTimePrecision': `a removed precision leaves the live one as it is, which is what CloudFormation does (measured us-east-1 2026-10-27, ${S}:5185-5198)`,
      },
      expectedRemovalThrows: {
        ...REQUIRED_ON_CREATE,
        ...PROVISIONED_SHAPE.throws,
        ...TAG_THROWS(['create', 'update-add', 'update-remove'], 2),
        ...each(['create', 'update-remove'], 'StreamSpecification.ResourcePolicy.PolicyDocument', {
          why: 'a StreamSpecification.ResourcePolicy without its PolicyDocument is refused before any call (dynamodb-stream-members.ts:85-90)',
          says: /PolicyDocument is required when StreamSpecification\.ResourcePolicy is declared/,
        }),
      },
    },
    {
      name: 'on-demand',
      bag: fresh(ON_DEMAND_BAG),
      expectedSilent: {
        ...attributeDefinitionsSilent(ON_DEMAND_BAG),
        ...ON_DEMAND_SHAPE.silent,
      },
      expectedRemovalThrows: {
        ...REQUIRED_ON_CREATE,
        ...ON_DEMAND_SHAPE.throws,
        'update-add:BillingMode': {
          why: `an index OnDemandThroughput on a table that stays PROVISIONED is refused before any call (${S}:3172-3270)`,
          says: /declare OnDemandThroughput while the table's billing mode is PROVISIONED/,
        },
        'update-remove:BillingMode': {
          why: `a flip to PROVISIONED that keeps OnDemandThroughput is refused before any call (${S}:3108-3133)`,
          says: /flips BillingMode to PROVISIONED .* while still declaring OnDemandThroughput/,
        },
        ...Object.fromEntries(
          [0, 1].flatMap((i) =>
            ['create', 'update-remove'].map((d) => [
              `${d}:StreamSpecification.Tags.${i}.Key`,
              {
                why: 'a StreamSpecification.Tags entry without its Key is refused before any call (dynamodb-stream-members.ts:120-126)',
                says: new RegExp(`StreamSpecification\\.Tags\\[${i}\\]\\.Key is required`),
              },
            ])
          )
        ),
      },
    },
  ],
};

export const CASES_16: TypeCase[] = [TABLE_CASE];
