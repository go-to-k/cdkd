import {
  ACCOUNT,
  TAG_THROWS,
  createOnlyOf,
  type Throw,
  type TypeCase,
} from './sdk-wire-harness.js';
import { LogsLogGroupProvider } from '../../../src/provisioning/providers/logs-loggroup-provider.js';
import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';
import { S3DirectoryBucketProvider } from '../../../src/provisioning/providers/s3-directory-bucket-provider.js';

/**
 * The fourth batch of wire cases (#3723): CloudWatch Logs log group, S3
 * Express directory bucket and IAM role. Run by `sdk-wire-coverage-4.test.ts`,
 * which mocks the clients these providers reach; the ledger in
 * `sdk-wire-coverage.test.ts` counts them as covered.
 */

const KEY_ARN = `arn:aws:kms:us-east-1:${ACCOUNT}:key/1234abcd-12ab-34cd-56ef-1234567890ab`;
const TAGS = [
  { Key: 'k1', Value: 'v1' },
  { Key: 'k2', Value: 'v2' },
];

/** `<Property> is required for <type> L`: refused when absent, before any call. */
const REQUIRED = (property: string): Throw => ({
  why: `${property} is refused when absent, before any call`,
  says: new RegExp(`${property} is required for`),
});

const ALL_DIRECTIONS = ['create', 'update-add', 'update-remove'];

// Not a gap: the schema requires the member, so no valid template removes it
// and the removal comparison observes a bag CloudFormation would refuse.
const REQUIRED_BY_SCHEMA = 'required by the schema: no valid template removes it';

/**
 * go-to-k/cdkd#2762: a directory bucket configuration missing a member the
 * schema requires, and which the provider cannot do without, is refused before
 * any call: the rule list of `BucketEncryption` / `LifecycleConfiguration`, an
 * inventory item's `Destination`, and the `Id` that names a metrics or
 * inventory item to its Put and its Delete.
 */
const DIRECTORY_BUCKET_CONFIG_THROWS: Record<string, Throw> = Object.fromEntries(
  ALL_DIRECTIONS.flatMap((d) =>
    (
      [
        ['BucketEncryption.ServerSideEncryptionConfiguration', /ServerSideEncryptionConfiguration of .* is not a list/],
        ['LifecycleConfiguration.Rules', /LifecycleConfiguration\.Rules of .* is not a list/],
        ['InventoryConfigurations.0.Destination', /Destination of .* is not an object/],
        ['InventoryConfigurations.1.Destination', /Destination of .* is not an object/],
        ['InventoryConfigurations.0.Id', /InventoryConfigurations\[0\]\.Id of .* is not a non-empty string/],
        ['InventoryConfigurations.1.Id', /InventoryConfigurations\[1\]\.Id of .* is not a non-empty string/],
        ['MetricsConfigurations.0.Id', /MetricsConfigurations\[0\]\.Id of .* is not a non-empty string/],
        ['MetricsConfigurations.1.Id', /MetricsConfigurations\[1\]\.Id of .* is not a non-empty string/],
      ] as const
    ).map(([path, says]) => [
      `${d}:${path}`,
      { why: `${path} is required by the schema and refused when absent, before any call`, says },
    ])
  )
);

const LOG_GROUP_CLASS: Throw = {
  why: 'LogGroupClass cannot change after creation; every change refuses before any call',
  says: /LogGroupClass \(from \S+ to \S+\) cannot be changed after creation/,
};

export const CASES_4: TypeCase[] = [
  {
    resourceType: 'AWS::Logs::LogGroup',
    provider: () => new LogsLogGroupProvider(),
    physicalId: 'lg',
    createOnly: createOnlyOf('AWS::Logs::LogGroup'),
    exempt: {},
    targets: [
      { path: ['Tags', 0], command: 'UntagResourceCommand', names: 'k1', notNames: 'k2' },
      { path: ['Tags', 1], command: 'UntagResourceCommand', names: 'k2', notNames: 'k1' },
    ],
    bags: [
      {
        name: 'every declared property',
        bag: {
          LogGroupName: 'lg',
          KmsKeyId: KEY_ARN,
          RetentionInDays: 7,
          DataProtectionPolicy: { Name: 'p', Version: '2021-06-01', Statement: [] },
          LogGroupClass: 'INFREQUENT_ACCESS',
          FieldIndexPolicies: [{ Fields: ['f1'] }],
          DeletionProtectionEnabled: true,
          BearerTokenAuthenticationEnabled: true,
          Tags: TAGS,
        },
        expectedSilent: {
          // Varied with the class removed from `prev` (read as STANDARD), so
          // both sides are a class change and both refuse.
          'update-vary:LogGroupClass':
            'the class cannot change after creation: both varied updates refuse',
        },
        expectedRemovalThrows: {
          'update-add:LogGroupClass': LOG_GROUP_CLASS,
          'update-remove:LogGroupClass': LOG_GROUP_CLASS,
          ...TAG_THROWS(ALL_DIRECTIONS, 2),
        },
      },
      {
        name: 'falsy values',
        bag: {
          LogGroupName: 'lg',
          DeletionProtectionEnabled: false,
          BearerTokenAuthenticationEnabled: false,
        },
      },
    ],
  },
  {
    resourceType: 'AWS::S3Express::DirectoryBucket',
    provider: () => new S3DirectoryBucketProvider(),
    physicalId: 'b--use1-az4--x-s3',
    createOnly: createOnlyOf('AWS::S3Express::DirectoryBucket'),
    exempt: {},
    targets: [
      { path: ['Tags', 0], command: 'UntagResourceCommand', names: 'k1', notNames: 'k2' },
      { path: ['Tags', 1], command: 'UntagResourceCommand', names: 'k2', notNames: 'k1' },
      // go-to-k/cdkd#2762: a removed item's Delete names only its own Id.
      {
        path: ['MetricsConfigurations', 0],
        command: 'DeleteBucketMetricsConfigurationCommand',
        names: 'metrics-one',
        notNames: 'metrics-two',
      },
      {
        path: ['MetricsConfigurations', 1],
        command: 'DeleteBucketMetricsConfigurationCommand',
        names: 'metrics-two',
        notNames: 'metrics-one',
      },
      {
        path: ['InventoryConfigurations', 0],
        command: 'DeleteBucketInventoryConfigurationCommand',
        names: 'inventory-one',
        notNames: 'inventory-two',
      },
      {
        path: ['InventoryConfigurations', 1],
        command: 'DeleteBucketInventoryConfigurationCommand',
        names: 'inventory-two',
        notNames: 'inventory-one',
      },
    ],
    bags: [
      {
        name: 'every declared property',
        bag: {
          BucketName: 'b--use1-az4--x-s3',
          LocationName: 'use1-az4',
          DataRedundancy: 'SingleAvailabilityZone',
          Tags: TAGS,
          BucketEncryption: {
            ServerSideEncryptionConfiguration: [
              {
                ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: KEY_ARN },
                BucketKeyEnabled: true,
              },
            ],
          },
          LifecycleConfiguration: {
            Rules: [
              {
                Id: 'expire-logs',
                Status: 'Enabled',
                Prefix: 'logs/',
                ObjectSizeGreaterThan: '100',
                ObjectSizeLessThan: '5000',
                ExpirationInDays: 7,
                AbortIncompleteMultipartUpload: { DaysAfterInitiation: 3 },
              },
            ],
          },
          MetricsConfigurations: [
            {
              Id: 'metrics-one',
              Prefix: 'p/',
              AccessPointArn: `arn:aws:s3express:us-east-1:${ACCOUNT}:accesspoint/ap--use1-az4--xa-s3`,
            },
            { Id: 'metrics-two', Prefix: 'q/' },
          ],
          InventoryConfigurations: [
            {
              Id: 'inventory-one',
              Enabled: true,
              IncludedObjectVersions: 'Current',
              ScheduleFrequency: 'Daily',
              Prefix: 'inv/',
              OptionalFields: ['Size', 'ETag'],
              Destination: {
                BucketArn: 'arn:aws:s3:::inventory-dest',
                BucketAccountId: ACCOUNT,
                Format: 'CSV',
                Prefix: 'reports/',
              },
            },
            {
              Id: 'inventory-two',
              Enabled: false,
              IncludedObjectVersions: 'Current',
              ScheduleFrequency: 'Weekly',
              Destination: { BucketArn: 'arn:aws:s3:::inventory-dest', Format: 'Parquet' },
            },
          ],
        },
        variants: {
          // A size bound is a decimal string; `-alt` would be refused.
          'LifecycleConfiguration.Rules.0.ObjectSizeGreaterThan': '200',
          'LifecycleConfiguration.Rules.0.ObjectSizeLessThan': '6000',
        },
        expectedSilent: {
          // An absent DataRedundancy is filled with SingleAvailabilityZone,
          // so removing that value sends the same request. Its `create-vary`
          // probe reads the value itself.
          'create:DataRedundancy': REQUIRED_BY_SCHEMA,
        },
        expectedRemovalThrows: {
          ...TAG_THROWS(ALL_DIRECTIONS, 2),
          ...DIRECTORY_BUCKET_CONFIG_THROWS,
        },
      },
      {
        // Removing DataRedundancy here changes the wire through the
        // Location.Type derived from it; the `create-vary` probe reads the
        // value, and `sdk-wire-coverage-4.test.ts` the derived type.
        name: 'a local zone',
        bag: {
          BucketName: 'b--use1-mia2-az1--x-s3',
          LocationName: 'use1-mia2-az1',
          DataRedundancy: 'SingleLocalZone',
        },
      },
    ],
  },
  {
    resourceType: 'AWS::IAM::Role',
    provider: () => new IAMRoleProvider(),
    physicalId: 'r',
    createOnly: createOnlyOf('AWS::IAM::Role'),
    exempt: {},
    targets: [
      { path: ['ManagedPolicyArns', 0], command: 'DetachRolePolicyCommand', names: 'm1', notNames: 'm2' },
      { path: ['ManagedPolicyArns', 1], command: 'DetachRolePolicyCommand', names: 'm2', notNames: 'm1' },
      { path: ['Policies', 0], command: 'DeleteRolePolicyCommand', names: 'p1', notNames: 'p2' },
      { path: ['Policies', 1], command: 'DeleteRolePolicyCommand', names: 'p2', notNames: 'p1' },
      { path: ['Tags', 0], command: 'UntagRoleCommand', names: 'k1', notNames: 'k2' },
      { path: ['Tags', 1], command: 'UntagRoleCommand', names: 'k2', notNames: 'k1' },
    ],
    bags: [
      {
        name: 'every declared property',
        bag: {
          RoleName: 'r',
          Path: '/p/',
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              { Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' },
            ],
          },
          Description: 'd',
          MaxSessionDuration: 7200,
          PermissionsBoundary: `arn:aws:iam::${ACCOUNT}:policy/boundary`,
          ManagedPolicyArns: [
            `arn:aws:iam::${ACCOUNT}:policy/m1`,
            `arn:aws:iam::${ACCOUNT}:policy/m2`,
          ],
          Policies: [
            {
              PolicyName: 'p1',
              PolicyDocument: {
                Version: '2012-10-17',
                Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }],
              },
            },
            {
              PolicyName: 'p2',
              PolicyDocument: {
                Version: '2012-10-17',
                Statement: [{ Effect: 'Allow', Action: 'sqs:SendMessage', Resource: '*' }],
              },
            },
          ],
          Tags: TAGS,
        },
        expectedSilent: {
          'update-remove:AssumeRolePolicyDocument': REQUIRED_BY_SCHEMA,
          // CloudFormation keeps a removed MaxSessionDuration at its live
          // value (go-to-k/cdkd#5004 A/B), so no reset is sent.
          'update-remove:MaxSessionDuration':
            'CloudFormation keeps a removed MaxSessionDuration at its live value (#5004)',
          ...Object.fromEntries(
            [0, 1].flatMap((i) => [
              // A Policies entry requires its PolicyDocument.
              [`update-remove:Policies.${i}.PolicyDocument`, REQUIRED_BY_SCHEMA],
              // Each inline policy is put whole from `next` on every update.
              ...[
                '.Version',
                '.Statement',
                '.Statement.0',
                '.Statement.0.Effect',
                '.Statement.0.Action',
                '.Statement.0.Resource',
              ].map((p) => [
                `update-remove:Policies.${i}.PolicyDocument${p}`,
                'PutRolePolicy re-sends each policy document whole from next; prev is not read',
              ]),
            ])
          ),
        },
        expectedRemovalThrows: {
          'create:AssumeRolePolicyDocument': REQUIRED('AssumeRolePolicyDocument'),
          ...TAG_THROWS(ALL_DIRECTIONS, 2),
        },
      },
    ],
  },
];
