import {
  ACCOUNT,
  createOnlyOf,
  paths,
  setOutputOverrides,
  type Bag,
  type Throw,
  type TypeCase,
} from './sdk-wire-harness.js';
import { EFSProvider } from '../../../src/provisioning/providers/efs-provider.js';
import { Route53Provider } from '../../../src/provisioning/providers/route53-provider.js';

/**
 * The seventeenth batch of wire cases (#3723), run by
 * `sdk-wire-coverage-17.test.ts`: `EFSProvider` (`AWS::EFS::FileSystem`,
 * `AWS::EFS::MountTarget`, `AWS::EFS::AccessPoint`) and `Route53Provider`
 * (`AWS::Route53::HostedZone`, `AWS::Route53::RecordSet`). The in-place
 * FileSystemTags / AccessPointTags retag (go-to-k/cdkd#5464) and the
 * HostedZoneFeatures.EnableAcceleratedRecovery send with its settle wait
 * (go-to-k/cdkd#5465) are the paths these bags probe.
 */

/** A copy sharing no object with any other bag (see `sdk-wire-cases-14.ts`). */
const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// =============================================================================
// EFSProvider
// =============================================================================

const EFS_SRC = 'efs-provider.ts';
const FS_ID = 'fs-12345678';
const MT_ID = 'fsmt-12345678';
const AP_ID = 'fsap-12345678';
const KMS_KEY = `arn:aws:kms:us-east-1:${ACCOUNT}:key/k`;
const TAGS = [
  { Key: 'k1', Value: 'v1' },
  { Key: 'k2', Value: 'v2' },
];

/**
 * The reads every EFS wait polls, answered settled so the first poll returns
 * (`waitForFileSystemAvailable`, `waitForMountTargetAvailable`).
 * `CreateFileSystem` answers a `CreationTime` of now: `sendCreateFileSystem`
 * refuses a file system created before its first send as one it did not make,
 * and the schema-generated answer is the epoch.
 */
const armEfs = (): void =>
  setOutputOverrides({
    CreateFileSystemCommand: () => ({ CreationTime: new Date() }),
    DescribeFileSystemsCommand: (input) => ({
      FileSystems: [{ FileSystemId: input['FileSystemId'], LifeCycleState: 'available' }],
    }),
    DescribeMountTargetsCommand: (input) => ({
      MountTargets: [{ MountTargetId: input['MountTargetId'], LifeCycleState: 'available' }],
    }),
  });

/**
 * A Key- or Value-less desired tag entry is refused on update before any call
 * (go-to-k/cdkd#5464). create() passes the list through for the API to judge,
 * so its create probes reach the wire.
 */
const efsTagsRefused = (top: string): Throw => ({
  why: `an ${top} entry without its Key or Value is refused before any call (${EFS_SRC}, refuseMalformedDesiredTags)`,
  says: new RegExp(`desired ${top} of AWS::EFS::\\w+ L is not a list of tags`),
});

const efsTagThrows = (top: string, directions: string[]): Record<string, Throw> =>
  Object.fromEntries(
    directions.flatMap((d) =>
      [0, 1].flatMap((i) => [
        [`${d}:${top}.${i}.Key`, efsTagsRefused(top)],
        [`${d}:${top}.${i}.Value`, efsTagsRefused(top)],
      ])
    )
  );

// --- AWS::EFS::FileSystem ----------------------------------------------------

const POLICY = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { AWS: '*' },
      Action: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'],
      Resource: '*',
    },
  ],
};

const PROVISIONED_BAG: Bag = {
  Encrypted: true,
  KmsKeyId: KMS_KEY,
  PerformanceMode: 'maxIO',
  ThroughputMode: 'provisioned',
  ProvisionedThroughputInMibps: 128,
  LifecyclePolicies: [
    { TransitionToIA: 'AFTER_30_DAYS' },
    { TransitionToPrimaryStorageClass: 'AFTER_1_ACCESS' },
    { TransitionToArchive: 'AFTER_90_DAYS' },
  ],
  BackupPolicy: { Status: 'ENABLED' },
  FileSystemPolicy: fresh(POLICY),
  BypassPolicyLockoutSafetyCheck: true,
  FileSystemProtection: { ReplicationOverwriteProtection: 'DISABLED' },
  FileSystemTags: fresh(TAGS),
};

/** One Zone, elastic throughput: the mode whose removal CloudFormation keeps. */
const ONE_ZONE_BAG: Bag = {
  AvailabilityZoneName: 'us-east-1a',
  PerformanceMode: 'generalPurpose',
  ThroughputMode: 'elastic',
};

/**
 * A REMOVED BackupPolicy / FileSystemPolicy / FileSystemProtection is reset as
 * CloudFormation does (go-to-k/cdkd#1160), so those removals reach the wire.
 * What stays silent is emptying the protection block while keeping it: the
 * apply helper returns before any call on a ReplicationOverwriteProtection-less
 * block, and CloudFormation REFUSES that shape (live CFn A/B, go-to-k/cdkd#1160:
 * the update fails "Provide a non-empty request body" and rolls back), so
 * there is no reset to mirror and the live value stays.
 */
const FILE_SYSTEM_CASE: TypeCase = {
  resourceType: 'AWS::EFS::FileSystem',
  provider: () => new EFSProvider(),
  physicalId: FS_ID,
  createOnly: createOnlyOf('AWS::EFS::FileSystem'),
  arm: armEfs,
  exempt: {},
  targets: [
    {
      path: ['FileSystemTags', 1],
      command: 'UntagResourceCommand',
      names: 'k2',
      notNames: 'k1',
    },
  ],
  bags: [
    {
      name: 'provisioned throughput, regional, every post-create block',
      bag: fresh(PROVISIONED_BAG),
      variants: {
        ThroughputMode: 'elastic',
        PerformanceMode: 'generalPurpose',
        'BackupPolicy.Status': 'DISABLED',
        'FileSystemProtection.ReplicationOverwriteProtection': 'ENABLED',
      },
      expectedSilent: {
        'update-remove:BackupPolicy.Status': `BackupPolicy.Status is required by the CloudFormation schema (nestedRequired), so no template drops it; a Status-less block is skipped before any call (${EFS_SRC}, applyBackupPolicy)`,
        'update-remove:FileSystemProtection.ReplicationOverwriteProtection': `CloudFormation refuses an emptied FileSystemProtection block (the update fails, live CFn A/B, go-to-k/cdkd#1160), so there is no reset to send; the apply helper skips it before any call (${EFS_SRC}, applyFileSystemProtection)`,
        'update-remove:ThroughputMode': `CFn parity: CloudFormation RETAINS a provisioned mode when only ThroughputMode is removed and ProvisionedThroughputInMibps stays (live CFn A/B, go-to-k/cdkd#5464), so nothing is sent`,
      },
      // The file system checks its desired tags only when they changed, so
      // update-add's baseline (the same Key-less list on both sides) passes.
      expectedRemovalThrows: {
        ...efsTagThrows('FileSystemTags', ['update-remove']),
        ...Object.fromEntries(
          ['update-remove', 'update-add'].map((d) => [
            `${d}:ProvisionedThroughputInMibps`,
            {
              // update-add's baseline is the same value-less bag on both sides.
              why: `CloudFormation rejects ThroughputMode: provisioned without ProvisionedThroughputInMibps (live CFn A/B, go-to-k/cdkd#5547: the update fails and rolls back), so it is refused before any call (${EFS_SRC}, updateFileSystem)`,
              says: /Throughput value must be specified for provisioned throughput mode/,
            },
          ])
        ),
      },
    },
    {
      name: 'elastic throughput, One Zone',
      bag: fresh(ONE_ZONE_BAG),
      variants: { ThroughputMode: 'bursting', PerformanceMode: 'maxIO' },
      expectedSilent: {
        'update-remove:ThroughputMode': `CFn parity: CloudFormation RETAINS the mode when ThroughputMode is removed from a non-provisioned file system (live CFn A/B, #1160), so nothing is sent`,
      },
    },
  ],
};

// --- AWS::EFS::MountTarget ---------------------------------------------------

const MOUNT_TARGET_BAG: Bag = {
  FileSystemId: FS_ID,
  SubnetId: 'subnet-1',
  SecurityGroups: ['sg-1', 'sg-2'],
  IpAddress: '10.0.0.10',
  IpAddressType: 'DUAL_STACK',
  Ipv6Address: '2600:1f18::10',
};

const MT_REQUIRED = (member: string): Throw => ({
  why: `${member} is required: create() refuses a mount target without it before any call (${EFS_SRC}, createMountTarget)`,
  says: new RegExp(`${member} is required for EFS MountTarget`),
});

const MOUNT_TARGET_CASE: TypeCase = {
  resourceType: 'AWS::EFS::MountTarget',
  provider: () => new EFSProvider(),
  physicalId: MT_ID,
  createOnly: createOnlyOf('AWS::EFS::MountTarget'),
  arm: armEfs,
  wholeFromNext: {
    keys: (key) => key === 'SecurityGroups',
    reason: `update() sends SecurityGroups whole from the desired bag on every update (${EFS_SRC}, updateMountTarget) and never reads prev`,
  },
  exempt: {},
  // ModifyMountTargetSecurityGroups replaces the whole list; no per-key call.
  targets: [],
  bags: [
    {
      name: 'dual-stack, every property',
      bag: fresh(MOUNT_TARGET_BAG),
      variants: { IpAddressType: 'IPV4_ONLY' },
      expectedSilent: {
        'update-remove:SecurityGroups': `SecurityGroups is required by the CloudFormation schema, so no template drops it; an update with none declared is a no-op (${EFS_SRC}, updateMountTarget)`,
      },
      expectedRemovalThrows: {
        'create:FileSystemId': MT_REQUIRED('FileSystemId'),
        'create:SubnetId': MT_REQUIRED('SubnetId'),
      },
    },
  ],
};

// --- AWS::EFS::AccessPoint ---------------------------------------------------

const ACCESS_POINT_BAG: Bag = {
  FileSystemId: FS_ID,
  PosixUser: { Uid: 1000, Gid: 1000, SecondaryGids: [2000, 2001] },
  RootDirectory: {
    Path: '/data',
    CreationInfo: { OwnerUid: 1000, OwnerGid: 1000, Permissions: '0755' },
  },
  AccessPointTags: fresh(TAGS),
};

const ACCESS_POINT_CASE: TypeCase = {
  resourceType: 'AWS::EFS::AccessPoint',
  provider: () => new EFSProvider(),
  physicalId: AP_ID,
  createOnly: createOnlyOf('AWS::EFS::AccessPoint'),
  arm: armEfs,
  exempt: {},
  targets: [
    {
      path: ['AccessPointTags', 1],
      command: 'UntagResourceCommand',
      names: 'k2',
      notNames: 'k1',
    },
  ],
  bags: [
    {
      name: 'POSIX user, root directory with creation info, tags',
      bag: fresh(ACCESS_POINT_BAG),
      expectedRemovalThrows: {
        'create:FileSystemId': {
          why: `FileSystemId is required: create() refuses an access point without it before any call (${EFS_SRC}, createAccessPoint)`,
          says: /FileSystemId is required for EFS AccessPoint/,
        },
        // The access point checks its desired tags on every update, so
        // update-add's baseline (the Key-less list on both sides) is refused too.
        ...efsTagThrows('AccessPointTags', ['update-add', 'update-remove']),
      },
    },
  ],
};

// =============================================================================
// Route53Provider
// =============================================================================

const R53_SRC = 'route53-provider.ts';
const ZONE_ID = 'Z0123456789ABCDEFGHIJ';
const LOG_GROUP_ARN = `arn:aws:logs:us-east-1:${ACCOUNT}:log-group:/aws/route53/example.com`;

// --- AWS::Route53::HostedZone ------------------------------------------------

/**
 * The live zone the previous bag describes: its VPC associations (what
 * `syncVPCAssociations` diffs against), its query logging config, which a
 * `DeleteQueryLoggingConfig` removes so the removal path's verify-listing reads
 * it gone, and its Accelerated Recovery status, which an
 * `UpdateHostedZoneFeatures` settles at once so the settle wait's first poll
 * returns. The `CallerReference` token is the fixed one
 * `sdk-wire-coverage-17.test.ts` mocks in, so two identical creates send the
 * same request.
 */
const armHostedZone = (physicalId: string, bag: Bag): void => {
  const qlc = bag['QueryLoggingConfig'] as Record<string, unknown> | undefined;
  let liveConfigs =
    typeof qlc?.['CloudWatchLogsLogGroupArn'] === 'string'
      ? [
          {
            Id: 'qlc-1',
            HostedZoneId: physicalId,
            CloudWatchLogsLogGroupArn: qlc['CloudWatchLogsLogGroupArn'],
          },
        ]
      : [];
  const vpcs = Array.isArray(bag['VPCs']) ? (bag['VPCs'] as Record<string, unknown>[]) : [];
  const features = bag['HostedZoneFeatures'] as Record<string, unknown> | undefined;
  let recovery: string | undefined =
    features?.['EnableAcceleratedRecovery'] === true ? 'ENABLED' : undefined;
  setOutputOverrides({
    GetHostedZoneCommand: () => ({
      HostedZone: {
        Id: `/hostedzone/${physicalId}`,
        Name: 'example.com.',
        CallerReference: 'ref',
        ...(recovery !== undefined ? { Features: { AcceleratedRecoveryStatus: recovery } } : {}),
      },
      DelegationSet: { NameServers: ['ns-1.example.net'] },
      VPCs: vpcs.map((v) => ({ VPCId: v['VPCId'], VPCRegion: v['VPCRegion'] })),
    }),
    UpdateHostedZoneFeaturesCommand: (input) => {
      // A test device, not measured Route 53 behaviour (the SDK model marks
      // the member optional): a mutation dropping the boolean would leave
      // the status DISABLED and the settle wait polling real timers until
      // its deadline, so refusing turns that probe red at once.
      if (typeof input['EnableAcceleratedRecovery'] !== 'boolean') {
        throw new Error('InvalidInput: EnableAcceleratedRecovery is required');
      }
      recovery = input['EnableAcceleratedRecovery'] ? 'ENABLED' : 'DISABLED';
      return {};
    },
    ListQueryLoggingConfigsCommand: () => ({ QueryLoggingConfigs: liveConfigs }),
    DeleteQueryLoggingConfigCommand: () => {
      liveConfigs = [];
      return {};
    },
  });
};

const PUBLIC_ZONE_BAG: Bag = {
  Name: 'example.com',
  DelegationSetId: 'N0123456789ABCDEFGHIJ',
  HostedZoneConfig: { Comment: 'public zone' },
  HostedZoneTags: [
    { Key: 'k1', Value: 'v1' },
    { Key: 'k2', Value: 'v2' },
  ],
  QueryLoggingConfig: { CloudWatchLogsLogGroupArn: LOG_GROUP_ARN },
  HostedZoneFeatures: { EnableAcceleratedRecovery: true },
};

const PRIVATE_ZONE_BAG: Bag = {
  Name: 'internal.example.com',
  HostedZoneConfig: { Comment: 'private zone' },
  VPCs: [
    { VPCId: 'vpc-11111111', VPCRegion: 'us-east-1' },
    { VPCId: 'vpc-22222222', VPCRegion: 'us-west-2' },
  ],
};

const NO_ZONE_NAME: Record<string, Throw> = {
  'create:Name': {
    why: `create() refuses a hosted zone with no Name before any call (${R53_SRC}, createHostedZone)`,
    says: /Name is required for hosted zone/,
  },
};

/**
 * A Key- or Value-less desired tag makes the whole desired list unusable, and
 * update() then leaves the live tags untouched rather than untagging on a
 * possibly unresolved intrinsic (issues #1471 / #1493). The reduced next is
 * that list on both sides, so neither sends a tagging call.
 */
const LOSSY_TAGS_KEPT = `a HostedZoneTags entry without its Key or Value makes the desired list unusable, and the live tags are left untouched (${R53_SRC}, updateHostedZone; issues #1471 / #1493)`;

const COMMENT_FROM_NEXT = `UpdateHostedZoneComment is sent on every update with the desired Comment ('' when absent; ${R53_SRC}, updateHostedZone), so the removal reaches the wire through next, which update-add observes; prev is never read for it`;

const VPC_REGION_REQUIRED = `VPCRegion is required on every VPCs entry by the CloudFormation schema, so no template drops it; an association is keyed by VPCId alone (${R53_SRC}, syncVPCAssociations), and one VPC id names one VPC in one region`;

const VPCS_KEPT = `a VPCs removed whole changes nothing, as in CloudFormation, and a warning names it (${R53_SRC}, VPCS_KEPT_ON_REMOVAL_NOTE; issue #1160)`;

const HOSTED_ZONE_CASE: TypeCase = {
  resourceType: 'AWS::Route53::HostedZone',
  provider: () => new Route53Provider(),
  physicalId: ZONE_ID,
  createOnly: createOnlyOf('AWS::Route53::HostedZone'),
  arm: armHostedZone,
  exempt: {},
  // ChangeTagsForResource re-sends every kept tag in AddTags beside the
  // removed key, so no request names the removed key alone.
  targets: [],
  bags: [
    {
      name: 'public zone',
      bag: fresh(PUBLIC_ZONE_BAG),
      expectedSilent: {
        'update-remove:HostedZoneConfig': COMMENT_FROM_NEXT,
        'update-remove:HostedZoneConfig.Comment': COMMENT_FROM_NEXT,
        'update-remove:HostedZoneTags.0.Key': LOSSY_TAGS_KEPT,
        'update-remove:HostedZoneTags.0.Value': LOSSY_TAGS_KEPT,
        'update-remove:HostedZoneTags.1.Key': LOSSY_TAGS_KEPT,
        'update-remove:HostedZoneTags.1.Value': LOSSY_TAGS_KEPT,
      },
      expectedRemovalThrows: NO_ZONE_NAME,
    },
    {
      name: 'private zone',
      bag: fresh(PRIVATE_ZONE_BAG),
      expectedSilent: {
        'update-remove:HostedZoneConfig': COMMENT_FROM_NEXT,
        'update-remove:HostedZoneConfig.Comment': COMMENT_FROM_NEXT,
        'update-remove:VPCs': VPCS_KEPT,
        'update-add:VPCs.0.VPCRegion': VPC_REGION_REQUIRED,
        'update-remove:VPCs.0.VPCRegion': VPC_REGION_REQUIRED,
        'update-add:VPCs.1.VPCRegion': VPC_REGION_REQUIRED,
        'update-remove:VPCs.1.VPCRegion': VPC_REGION_REQUIRED,
      },
      expectedRemovalThrows: NO_ZONE_NAME,
    },
  ],
};

// --- AWS::Route53::RecordSet -------------------------------------------------

/**
 * A `HostedZoneName` resolves to a zone whose id is drawn from the name, so a
 * varied name lands in a different zone; the live record is the one the
 * previous bag names, which a changed name / type / SetIdentifier deletes in
 * the same ChangeBatch (issue #3741).
 */
const armRecordSet = (_physicalId: string, bag: Bag): void => {
  const named = typeof bag['Name'] === 'string' && typeof bag['Type'] === 'string';
  setOutputOverrides({
    ListHostedZonesByNameCommand: (input) => ({
      HostedZones: [
        {
          Id: `/hostedzone/Z-${String(input['DNSName'])}`,
          Name: input['DNSName'],
          CallerReference: 'ref',
          Config: { PrivateZone: false },
        },
      ],
      IsTruncated: false,
    }),
    ListResourceRecordSetsCommand: () => ({
      ResourceRecordSets: named
        ? [
            {
              Name: bag['Name'],
              Type: bag['Type'],
              ...(bag['SetIdentifier'] !== undefined ? { SetIdentifier: bag['SetIdentifier'] } : {}),
              TTL: 60,
              ResourceRecords: [{ Value: 'live' }],
            },
          ]
        : [],
      IsTruncated: false,
    }),
  });
};

const NAME_TYPE_REQUIRED = `Name and Type are required by the CloudFormation schema, so no template drops them; update() writes the record from the desired bag alone (${R53_SRC}, updateRecordSet)`;

const NO_ZONE_NEEDLE = /Either HostedZoneId or HostedZoneName is required/;
const NO_ZONE: Record<string, Throw> = {
  'create:HostedZoneId': {
    why: `create() refuses a record with neither HostedZoneId nor HostedZoneName before any write (${R53_SRC}, createRecordSet)`,
    says: NO_ZONE_NEEDLE,
  },
};

/**
 * `AliasTarget.HostedZoneId` is required by the CloudFormation schema; an
 * alias with none is copied as `undefined`, and the Route 53 client's own
 * hosted-zone-id normalizer throws on it before any request is serialized.
 */
const ALIAS_ZONE_REQUIRED: Throw = {
  why: `AliasTarget.HostedZoneId is required by the CloudFormation schema; an absent one reaches the Route 53 client's id normalizer as undefined (${R53_SRC}, buildResourceRecordSet), which throws before any request is sent; the needle is that SDK-internal TypeError, so an SDK update may reword it`,
  says: /Cannot read properties of undefined \(reading 'replace'\)/,
};

const RECORD_NAME = 'www.example.com';

const record = (extra: Bag): Bag => ({
  HostedZoneId: ZONE_ID,
  Name: RECORD_NAME,
  Type: 'A',
  ...extra,
});

const RECORD_BAGS: { name: string; bag: Bag; throws?: Record<string, Throw> }[] = [
  {
    name: 'plain',
    bag: record({ TTL: 300, ResourceRecords: ['192.0.2.1', '192.0.2.2'], Comment: 'plain record' }),
  },
  {
    name: 'plain, by HostedZoneName',
    bag: {
      HostedZoneName: 'example.com.',
      Name: RECORD_NAME,
      Type: 'TXT',
      TTL: 60,
      ResourceRecords: ['"v=spf1 -all"'],
    },
    throws: {
      'create:HostedZoneName': {
        why: `create() refuses a record with neither HostedZoneId nor HostedZoneName before any write (${R53_SRC}, createRecordSet)`,
        says: NO_ZONE_NEEDLE,
      },
    },
  },
  {
    name: 'alias',
    bag: record({
      AliasTarget: {
        HostedZoneId: 'Z2FDTNDATAQYW2',
        DNSName: 'd111111abcdef8.cloudfront.net',
        EvaluateTargetHealth: true,
      },
    }),
    throws: {
      ...NO_ZONE,
      ...Object.fromEntries(
        ['create', 'update-add', 'update-remove'].map((d) => [
          `${d}:AliasTarget.HostedZoneId`,
          ALIAS_ZONE_REQUIRED,
        ])
      ),
    },
  },
  {
    name: 'weighted',
    bag: record({
      TTL: 60,
      ResourceRecords: ['192.0.2.1'],
      SetIdentifier: 'blue',
      Weight: 10,
      HealthCheckId: 'hc-1',
    }),
  },
  {
    name: 'latency',
    bag: record({ TTL: 60, ResourceRecords: ['192.0.2.1'], SetIdentifier: 'use1', Region: 'us-east-1' }),
  },
  {
    name: 'failover',
    bag: record({
      TTL: 60,
      ResourceRecords: ['192.0.2.1'],
      SetIdentifier: 'primary',
      Failover: 'PRIMARY',
      HealthCheckId: 'hc-1',
    }),
  },
  {
    name: 'geolocation, country',
    bag: record({
      TTL: 60,
      ResourceRecords: ['192.0.2.1'],
      SetIdentifier: 'us-wa',
      GeoLocation: { CountryCode: 'US', SubdivisionCode: 'WA' },
    }),
  },
  {
    name: 'geolocation, continent',
    bag: record({
      TTL: 60,
      ResourceRecords: ['192.0.2.1'],
      SetIdentifier: 'eu',
      GeoLocation: { ContinentCode: 'EU' },
    }),
  },
  {
    name: 'geoproximity, AWS Region',
    bag: record({
      TTL: 60,
      ResourceRecords: ['192.0.2.1'],
      SetIdentifier: 'gp-region',
      GeoProximityLocation: { AWSRegion: 'us-east-1', Bias: 10 },
    }),
  },
  {
    name: 'geoproximity, coordinates',
    bag: record({
      TTL: 60,
      ResourceRecords: ['192.0.2.1'],
      SetIdentifier: 'gp-coords',
      GeoProximityLocation: { Coordinates: { Latitude: '49.22', Longitude: '-74.01' } },
    }),
  },
  {
    name: 'geoproximity, local zone group',
    bag: record({
      TTL: 60,
      ResourceRecords: ['192.0.2.1'],
      SetIdentifier: 'gp-lz',
      GeoProximityLocation: { LocalZoneGroup: 'us-east-1-bos-1' },
    }),
  },
  {
    name: 'cidr',
    bag: record({
      TTL: 60,
      ResourceRecords: ['192.0.2.1'],
      SetIdentifier: 'cidr-1',
      CidrRoutingConfig: { CollectionId: 'c0000000-0000-0000-0000-000000000000', LocationName: 'loc' },
    }),
  },
  {
    name: 'multivalue',
    bag: record({
      TTL: 60,
      ResourceRecords: ['192.0.2.1'],
      SetIdentifier: 'mv-1',
      MultiValueAnswer: true,
      HealthCheckId: 'hc-1',
    }),
  },
];

const RECORD_SET_CASE: TypeCase = {
  resourceType: 'AWS::Route53::RecordSet',
  provider: () => new Route53Provider(),
  physicalId: `${ZONE_ID}|${RECORD_NAME}|A`,
  createOnly: createOnlyOf('AWS::Route53::RecordSet'),
  arm: armRecordSet,
  // A SetIdentifier dropped from the desired bag changes the record's identity,
  // so update() deletes the live old record in the same batch: prev IS read.
  wholeFromNext: {
    keys: (key) => key !== 'SetIdentifier',
    reason: `update() UPSERTs the record built from the desired bag alone (${R53_SRC}, updateRecordSet), so a removal reaches the wire through next, which update-add observes; prev is read only for the record's identity (Name / Type / SetIdentifier)`,
  },
  exempt: {},
  // UPSERT writes the whole record built from next; no per-key call.
  targets: [],
  bags: RECORD_BAGS.map(({ name, bag, throws }) => ({
    name,
    bag: fresh(bag),
    expectedSilent: Object.fromEntries(
      paths(bag)
        .map((p) => p.join('.'))
        .filter((label) => label === 'Name' || label === 'Type')
        .map((label) => [`update-remove:${label}`, NAME_TYPE_REQUIRED])
    ),
    expectedRemovalThrows: throws ?? NO_ZONE,
  })),
};

export const CASES_17: TypeCase[] = [
  FILE_SYSTEM_CASE,
  MOUNT_TARGET_CASE,
  ACCESS_POINT_CASE,
  HOSTED_ZONE_CASE,
  RECORD_SET_CASE,
];
