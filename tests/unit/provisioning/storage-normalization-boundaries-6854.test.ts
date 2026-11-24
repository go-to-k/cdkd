/**
 * go-to-k/cdkd#6854 (lane A, storage): the boundary of every normalization rule
 * the DynamoDB, S3, Kinesis and Cognito providers apply before `cdkd drift` /
 * `cdkd diff` compare. Each rule gets a pair it MUST equate (the AWS
 * equivalence recorded in docs/design/6854-a-storage-normalization-rules.md)
 * and a pair it must NOT equate (a value AWS treats differently).
 *
 * Every helper below runs the provider's hooks the way the drift command does
 * (`canonicalizeDriftProperties` on both sides, then the comparator with the
 * provider's unordered and unknown paths), or the way the diff does
 * (`canonicalizeDesiredProperties` on both bags, then a value comparison).
 */
import { describe, it, expect, vi } from 'vite-plus/test';

vi.mock('../../../src/utils/aws-clients.js', () => {
  const client = () => ({
    send: vi.fn(),
    config: { region: () => Promise.resolve('us-east-1') },
  });
  return {
    getAwsClients: () =>
      new Proxy(
        {},
        {
          get: () => client(),
        }
      ),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(function (this: unknown) { return this; }),
  };
  return {
    getLogger: () => ({ ...child, child: () => child }),
  };
});

import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';
import { DynamoDBTableProvider } from '../../../src/provisioning/providers/dynamodb-table-provider.js';
import { DynamoDBGlobalTableProvider } from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import { canonicalizeIndexWarmThroughput } from '../../../src/provisioning/providers/dynamodb-globaltable/drift.js';
import { KinesisStreamProvider } from '../../../src/provisioning/providers/kinesis-provider.js';
import { CognitoUserPoolProvider } from '../../../src/provisioning/providers/cognito-provider.js';
import { S3BucketProvider } from '../../../src/provisioning/providers/s3-bucket-provider.js';
import { S3DirectoryBucketProvider } from '../../../src/provisioning/providers/s3-directory-bucket-provider.js';
import type { ResourceProvider } from '../../../src/types/resource.js';

type Bag = Record<string, unknown>;

/**
 * The TOP-LEVEL properties reported drifted for `baseline` against `aws`, as
 * `cdkd drift` canonicalizes them (a nested path is reported by its root key).
 */
function driftPaths(
  provider: ResourceProvider,
  type: string,
  baseline: Bag,
  aws: Bag,
  properties?: Bag
): string[] {
  const side = (bag: Bag): Bag => provider.canonicalizeDriftProperties?.(type, bag) ?? bag;
  return calculateResourceDrift(side(baseline), side(aws), {
    unorderedPaths: provider.getDriftUnorderedPaths?.(type) ?? [],
    ignorePaths: provider.getDriftUnknownPaths?.(type, properties ?? baseline) ?? [],
    resourceType: type,
  }).map((d) => d.path.split('.')[0]!);
}

/** Whether `cdkd diff` sees two bags as the same, after `canonicalizeDesiredProperties`. */
function diffEqual(provider: ResourceProvider, type: string, a: Bag, b: Bag): boolean {
  const side = (bag: Bag): Bag => provider.canonicalizeDesiredProperties?.(type, bag) ?? bag;
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v as Bag)
              .sort()
              .map((k) => [k, sorted((v as Bag)[k])])
          )
        : v;
  return JSON.stringify(sorted(side(a))) === JSON.stringify(sorted(side(b)));
}

describe('AWS::DynamoDB::Table rules (#6854)', () => {
  const provider = new DynamoDBTableProvider();
  const T = 'AWS::DynamoDB::Table';

  it('AttributeDefinitions is a set keyed by AttributeName', () => {
    const a = [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'N' },
    ];
    expect(
      driftPaths(provider, T, { AttributeDefinitions: a }, { AttributeDefinitions: [a[1], a[0]] })
    ).toEqual([]);
    // Same names, a changed type: not equal.
    expect(
      driftPaths(
        provider,
        T,
        { AttributeDefinitions: a },
        { AttributeDefinitions: [a[0], { AttributeName: 'sk', AttributeType: 'S' }] }
      )
    ).toEqual(['AttributeDefinitions']);
  });

  it('the table KeySchema is ordered (HASH before RANGE)', () => {
    const ks = [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ];
    expect(driftPaths(provider, T, { KeySchema: ks }, { KeySchema: [ks[1], ks[0]] })).toEqual([
      'KeySchema',
    ]);
  });

  it('GlobalSecondaryIndexes is sorted as a list, but each KeySchema inside stays ordered', () => {
    const gsi = (name: string, hash: string, range: string): Bag => ({
      IndexName: name,
      KeySchema: [
        { AttributeName: hash, KeyType: 'HASH' },
        { AttributeName: range, KeyType: 'RANGE' },
      ],
      Projection: { ProjectionType: 'ALL' },
    });
    const declared = { GlobalSecondaryIndexes: [gsi('a', 'x', 'y'), gsi('b', 'y', 'x')] };
    expect(
      driftPaths(provider, T, declared, {
        GlobalSecondaryIndexes: [gsi('b', 'y', 'x'), gsi('a', 'x', 'y')],
      })
    ).toEqual([]);
    // Index `a` with its HASH and RANGE swapped is another index.
    expect(
      driftPaths(provider, T, declared, {
        GlobalSecondaryIndexes: [gsi('a', 'y', 'x'), gsi('b', 'y', 'x')],
      })
    ).toEqual(['GlobalSecondaryIndexes']);
  });

  it('VectorIndexes is a set and so are the SearchSchema and NonKeyAttributes inside it', () => {
    const vi1 = (dims: number, schema: string[]): Bag => ({
      IndexName: 'v',
      VectorAttribute: { AttributeName: 'emb', Dimensions: dims },
      SearchSchema: schema.map((n) => ({ AttributeName: n, SearchSchemaElementType: 'HASH' })),
      Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['p', 'q'] },
    });
    expect(
      driftPaths(
        provider,
        T,
        { VectorIndexes: [vi1(128, ['a', 'b'])] },
        { VectorIndexes: [vi1(128, ['b', 'a'])] }
      )
    ).toEqual([]);
    expect(
      driftPaths(
        provider,
        T,
        { VectorIndexes: [vi1(128, ['a', 'b'])] },
        { VectorIndexes: [vi1(256, ['a', 'b'])] }
      )
    ).toEqual(['VectorIndexes']);
    // A different member set is not a reorder.
    expect(
      driftPaths(
        provider,
        T,
        { VectorIndexes: [vi1(128, ['a', 'b'])] },
        { VectorIndexes: [vi1(128, ['a'])] }
      )
    ).toEqual(['VectorIndexes']);
  });

  it("DeletionProtectionEnabled: 'true' / 'false' equal the booleans create() sends; nothing else does", () => {
    expect(
      driftPaths(
        provider,
        T,
        { DeletionProtectionEnabled: 'true' },
        { DeletionProtectionEnabled: true }
      )
    ).toEqual([]);
    expect(
      driftPaths(
        provider,
        T,
        { DeletionProtectionEnabled: 'false' },
        { DeletionProtectionEnabled: true }
      )
    ).toEqual(['DeletionProtectionEnabled']);
    expect(
      driftPaths(provider, T, { DeletionProtectionEnabled: 'yes' }, { DeletionProtectionEnabled: true })
    ).toEqual(['DeletionProtectionEnabled']);
    expect(
      driftPaths(provider, T, { DeletionProtectionEnabled: 1 }, { DeletionProtectionEnabled: true })
    ).toEqual(['DeletionProtectionEnabled']);
  });

  describe('stale per-index SDK description (#1812)', () => {
    const current = {
      IndexName: 'g',
      KeySchema: [{ AttributeName: 'x', KeyType: 'HASH' }],
      Projection: { ProjectionType: 'ALL' },
      ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
    };

    it('drops the SDK-only members and the decrease counter', () => {
      const stale = {
        ...current,
        IndexStatus: 'ACTIVE',
        ItemCount: 3,
        IndexSizeBytes: 10,
        IndexArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/t/index/g',
        ProvisionedThroughput: {
          ReadCapacityUnits: 5,
          WriteCapacityUnits: 5,
          NumberOfDecreasesToday: 0,
        },
      };
      expect(
        driftPaths(
          provider,
          T,
          { GlobalSecondaryIndexes: [stale] },
          { GlobalSecondaryIndexes: [current] },
          { GlobalSecondaryIndexes: [current] }
        )
      ).toEqual([]);
    });

    it('still reports a capacity change inside a stale description', () => {
      const stale = {
        ...current,
        IndexStatus: 'ACTIVE',
        ProvisionedThroughput: {
          ReadCapacityUnits: 9,
          WriteCapacityUnits: 5,
          NumberOfDecreasesToday: 0,
        },
      };
      expect(
        driftPaths(
          provider,
          T,
          { GlobalSecondaryIndexes: [stale] },
          { GlobalSecondaryIndexes: [current] },
          { GlobalSecondaryIndexes: [current] }
        )
      ).toEqual(['GlobalSecondaryIndexes']);
    });

    it('never drops a 0/0 block or a WarmThroughput from a CURRENT-shape entry', () => {
      const withZero = {
        ...current,
        ProvisionedThroughput: { ReadCapacityUnits: 0, WriteCapacityUnits: 0 },
      };
      expect(
        driftPaths(
          provider,
          T,
          { GlobalSecondaryIndexes: [withZero] },
          { GlobalSecondaryIndexes: [current] },
          { GlobalSecondaryIndexes: [current] }
        )
      ).toEqual(['GlobalSecondaryIndexes']);
      const warm = (r: number): Bag => ({
        ...current,
        WarmThroughput: { ReadUnitsPerSecond: r, WriteUnitsPerSecond: 4000 },
      });
      expect(
        driftPaths(
          provider,
          T,
          { GlobalSecondaryIndexes: [warm(12000)] },
          { GlobalSecondaryIndexes: [warm(15000)] },
          { GlobalSecondaryIndexes: [warm(12000)] }
        )
      ).toEqual(['GlobalSecondaryIndexes']);
    });
  });

  it('WarmThroughput is skipped only when the template declares none', () => {
    const warm = (r: number): Bag => ({
      WarmThroughput: { ReadUnitsPerSecond: r, WriteUnitsPerSecond: 4000 },
    });
    expect(driftPaths(provider, T, warm(12000), warm(13000), { TableName: 't' })).toEqual([]);
    expect(driftPaths(provider, T, warm(12000), warm(13000), warm(12000))).toEqual([
      'WarmThroughput',
    ]);
  });
});

describe('AWS::DynamoDB::GlobalTable rules (#6854)', () => {
  const provider = new DynamoDBGlobalTableProvider();
  const T = 'AWS::DynamoDB::GlobalTable';

  it('Replicas is a set keyed by Region; a member of a replica is still compared', () => {
    const r = (region: string, cls = 'STANDARD'): Bag => ({ Region: region, TableClass: cls });
    expect(
      driftPaths(
        provider,
        T,
        { Replicas: [r('us-east-1'), r('eu-west-1')] },
        { Replicas: [r('eu-west-1'), r('us-east-1')] }
      )
    ).toEqual([]);
    expect(
      driftPaths(
        provider,
        T,
        { Replicas: [r('us-east-1'), r('eu-west-1')] },
        { Replicas: [r('eu-west-1', 'STANDARD_INFREQUENT_ACCESS'), r('us-east-1')] }
      )
    ).toEqual(['Replicas']);
    // A replica in another region is not a reorder.
    expect(
      driftPaths(
        provider,
        T,
        { Replicas: [r('us-east-1'), r('eu-west-1')] },
        { Replicas: [r('us-east-1'), r('ap-northeast-1')] }
      )
    ).toEqual(['Replicas']);
  });

  it('the per-index WarmThroughput strip (no declaration) leaves every other index member compared', () => {
    const gsi = (write: number): Bag => ({
      IndexName: 'g',
      KeySchema: [{ AttributeName: 'x', KeyType: 'HASH' }],
      Projection: { ProjectionType: 'ALL' },
      WriteProvisionedThroughputSettings: { WriteCapacityUnits: write },
    });
    // The pair hook's per-index rule (#6854); the template declares none.
    const declaresNone = { GlobalSecondaryIndexes: [gsi(5)] };
    const warm = (bag: Bag): Bag => canonicalizeIndexWarmThroughput(bag, declaresNone);
    expect(
      driftPaths(
        provider,
        T,
        warm({ GlobalSecondaryIndexes: [gsi(5)] }),
        warm({
          GlobalSecondaryIndexes: [
            { ...gsi(5), WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 } },
          ],
        })
      )
    ).toEqual([]);
    expect(
      driftPaths(
        provider,
        T,
        { GlobalSecondaryIndexes: [gsi(5)] },
        { GlobalSecondaryIndexes: [gsi(6)] }
      )
    ).toEqual(['GlobalSecondaryIndexes']);
  });

  it('the implied stream equals NEW_AND_OLD_IMAGES only; another view type differs', () => {
    const base = {
      TableName: 't',
      Replicas: [{ Region: 'us-east-1' }, { Region: 'eu-west-1' }],
    };
    expect(
      diffEqual(provider, T, base, {
        ...base,
        StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
      })
    ).toBe(true);
    expect(
      diffEqual(provider, T, base, { ...base, StreamSpecification: { StreamViewType: 'KEYS_ONLY' } })
    ).toBe(false);
    // One replica: create() enables no stream, so nothing is implied.
    const single = { TableName: 't', Replicas: [{ Region: 'us-east-1' }] };
    expect(
      diffEqual(provider, T, single, {
        ...single,
        StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
      })
    ).toBe(false);
  });
});

describe('AWS::Kinesis::Stream rules (#6854)', () => {
  const provider = new KinesisStreamProvider();
  const T = 'AWS::Kinesis::Stream';
  const ALL_SEVEN = [
    'IncomingBytes',
    'IncomingRecords',
    'OutgoingBytes',
    'OutgoingRecords',
    'WriteProvisionedThroughputExceeded',
    'ReadProvisionedThroughputExceeded',
    'IteratorAgeMilliseconds',
  ];

  it('DesiredShardLevelMetrics is a set: order is equal, membership is not', () => {
    expect(
      driftPaths(
        provider,
        T,
        { DesiredShardLevelMetrics: ['IncomingBytes', 'OutgoingBytes'] },
        { DesiredShardLevelMetrics: ['OutgoingBytes', 'IncomingBytes'] }
      )
    ).toEqual([]);
    expect(
      driftPaths(
        provider,
        T,
        { DesiredShardLevelMetrics: ['IncomingBytes', 'OutgoingBytes'] },
        { DesiredShardLevelMetrics: ['IncomingBytes'] }
      )
    ).toEqual(['DesiredShardLevelMetrics']);
  });

  it("'ALL' equals the seven metrics AWS reports for it, and nothing fewer", () => {
    expect(
      diffEqual(
        provider,
        T,
        { DesiredShardLevelMetrics: ['ALL'] },
        { DesiredShardLevelMetrics: ALL_SEVEN }
      )
    ).toBe(true);
    expect(
      diffEqual(
        provider,
        T,
        { DesiredShardLevelMetrics: ['ALL'] },
        { DesiredShardLevelMetrics: ALL_SEVEN.slice(1) }
      )
    ).toBe(false);
  });
});

describe('AWS::Cognito::UserPool rules (#6854)', () => {
  const provider = new CognitoUserPoolProvider();
  const T = 'AWS::Cognito::UserPool';

  it('a blank MfaConfiguration equals the value cdkd sends for it; a declared value is never rewritten', () => {
    const rp = { WebAuthnRelyingPartyID: 'auth.example.com' };
    expect(
      diffEqual(provider, T, { ...rp, MfaConfiguration: '  ' }, { ...rp, MfaConfiguration: 'OFF' })
    ).toBe(true);
    expect(
      diffEqual(provider, T, { ...rp, MfaConfiguration: '' }, { ...rp, MfaConfiguration: 'ON' })
    ).toBe(false);
    for (const declared of ['ON', 'OPTIONAL']) {
      expect(
        diffEqual(
          provider,
          T,
          { MfaConfiguration: declared, EnabledMfas: ['SOFTWARE_TOKEN_MFA'] },
          { MfaConfiguration: 'OFF', EnabledMfas: ['SOFTWARE_TOKEN_MFA'] }
        )
      ).toBe(false);
    }
    expect(
      diffEqual(
        provider,
        T,
        { MfaConfiguration: 'ON', EnabledMfas: ['SOFTWARE_TOKEN_MFA'] },
        { MfaConfiguration: 'OPTIONAL', EnabledMfas: ['SOFTWARE_TOKEN_MFA'] }
      )
    ).toBe(false);
  });

  it('declares no unordered path: a reordered list attribute is compared as written', () => {
    expect((provider as ResourceProvider).getDriftUnorderedPaths?.(T) ?? []).toEqual([]);
  });
});

describe('AWS::S3::Bucket diff folds (#6854)', () => {
  const provider = new S3BucketProvider();
  const T = 'AWS::S3::Bucket';

  const inventory = (extra: Bag): Bag => ({
    InventoryConfigurations: [
      {
        Id: 'inv',
        Destination: { BucketArn: 'arn:aws:s3:::dest', Format: 'CSV' },
        ScheduleFrequency: 'Daily',
        Enabled: true,
        ...extra,
      },
    ],
  });

  it("an inventory with no IncludedObjectVersions equals 'All', not 'Current'", () => {
    expect(diffEqual(provider, T, inventory({}), inventory({ IncludedObjectVersions: 'All' }))).toBe(
      true
    );
    expect(
      diffEqual(provider, T, inventory({}), inventory({ IncludedObjectVersions: 'Current' }))
    ).toBe(false);
  });

  it("a lifecycle rule with no Status equals 'Enabled', not 'Disabled'", () => {
    const rule = (extra: Bag): Bag => ({
      LifecycleConfiguration: { Rules: [{ Id: 'r', ExpirationInDays: 30, Prefix: 'a/', ...extra }] },
    });
    expect(diffEqual(provider, T, rule({}), rule({ Status: 'Enabled' }))).toBe(true);
    expect(diffEqual(provider, T, rule({}), rule({ Status: 'Disabled' }))).toBe(false);
  });

  it('a one-event Events list equals its Event scalar; a two-event list does not', () => {
    const notif = (cfg: Bag): Bag => ({
      NotificationConfiguration: {
        QueueConfigurations: [{ Queue: 'arn:aws:sqs:us-east-1:123456789012:q', ...cfg }],
      },
    });
    expect(
      diffEqual(
        provider,
        T,
        notif({ Events: ['s3:ObjectCreated:*'] }),
        notif({ Event: 's3:ObjectCreated:*' })
      )
    ).toBe(true);
    expect(
      diffEqual(
        provider,
        T,
        notif({ Events: ['s3:ObjectCreated:*', 's3:ObjectRemoved:*'] }),
        notif({ Event: 's3:ObjectCreated:*' })
      )
    ).toBe(false);
  });
});

describe('AWS::S3Express::DirectoryBucket rules (#6854)', () => {
  const provider = new S3DirectoryBucketProvider();
  const T = 'AWS::S3Express::DirectoryBucket';
  const enc = (algorithm: string, bucketKey?: unknown): Bag => ({
    BucketEncryption: {
      ServerSideEncryptionConfiguration: [
        {
          ServerSideEncryptionByDefault: { SSEAlgorithm: algorithm },
          ...(bucketKey !== undefined && { BucketKeyEnabled: bucketKey }),
        },
      ],
    },
  });

  it('BucketKeyEnabled at the value its algorithm implies equals absent; the other value does not', () => {
    expect(driftPaths(provider, T, enc('aws:kms', true), enc('aws:kms'))).toEqual([]);
    expect(driftPaths(provider, T, enc('aws:kms', 'true'), enc('aws:kms'))).toEqual([]);
    expect(driftPaths(provider, T, enc('AES256', false), enc('AES256'))).toEqual([]);
    expect(driftPaths(provider, T, enc('aws:kms', false), enc('aws:kms'))).toEqual([
      'BucketEncryption',
    ]);
    expect(driftPaths(provider, T, enc('AES256', true), enc('AES256'))).toEqual([
      'BucketEncryption',
    ]);
  });

  it("a lifecycle rule's empty Prefix equals no Prefix; a non-empty one does not", () => {
    const rule = (extra: Bag): Bag => ({
      LifecycleConfiguration: { Rules: [{ Status: 'Enabled', ExpirationInDays: 7, ...extra }] },
    });
    expect(driftPaths(provider, T, rule({ Prefix: '' }), rule({}))).toEqual([]);
    expect(driftPaths(provider, T, rule({ Prefix: 'logs/' }), rule({}))).toEqual([
      'LifecycleConfiguration',
    ]);
  });

  it('lifecycle rules stay ordered; metrics configurations are an Id-keyed set', () => {
    const rules = [
      { Id: 'a', Status: 'Enabled', ExpirationInDays: 7 },
      { Id: 'b', Status: 'Enabled', ExpirationInDays: 9 },
    ];
    expect(
      driftPaths(
        provider,
        T,
        { LifecycleConfiguration: { Rules: rules } },
        { LifecycleConfiguration: { Rules: [rules[1], rules[0]] } }
      )
    ).toEqual(['LifecycleConfiguration']);
    const m = [{ Id: 'a' }, { Id: 'b', Prefix: 'p/' }];
    expect(
      driftPaths(provider, T, { MetricsConfigurations: m }, { MetricsConfigurations: [m[1], m[0]] })
    ).toEqual([]);
    expect(
      driftPaths(
        provider,
        T,
        { MetricsConfigurations: m },
        { MetricsConfigurations: [m[0], { Id: 'b', Prefix: 'q/' }] }
      )
    ).toEqual(['MetricsConfigurations']);
  });
});
