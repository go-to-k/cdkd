import {
  ACCOUNT,
  DECLARED_DEFAULT,
  TAG_THROWS,
  createOnlyOf,
  setOutputOverrides,
  type Throw,
  type TypeCase,
} from './sdk-wire-harness.js';
import { LambdaPermissionProvider } from '../../../src/provisioning/providers/lambda-permission-provider.js';
import { LambdaUrlProvider } from '../../../src/provisioning/providers/lambda-url-provider.js';
import { LambdaEventInvokeConfigProvider } from '../../../src/provisioning/providers/lambda-event-invoke-config-provider.js';
import { ECRProvider } from '../../../src/provisioning/providers/ecr-provider.js';
import { CloudFrontOACProvider } from '../../../src/provisioning/providers/cloudfront-oac-provider.js';
import { CloudFrontOAIProvider } from '../../../src/provisioning/providers/cloudfront-oai-provider.js';
import { S3BucketPolicyProvider } from '../../../src/provisioning/providers/s3-bucket-policy-provider.js';
import { KinesisStreamConsumerProvider } from '../../../src/provisioning/providers/kinesis-streamconsumer-provider.js';

/**
 * The second batch of wire cases (#3723): Lambda permission / URL / event
 * invoke config, ECR repository, CloudFront OAC / OAI, S3 bucket policy and
 * Kinesis stream consumer. Run by `sdk-wire-coverage-2.test.ts`, which mocks
 * the clients these providers reach; the ledger in `sdk-wire-coverage.test.ts`
 * counts them as covered.
 */

const FUNCTION_ARN = `arn:aws:lambda:us-east-1:${ACCOUNT}:function:f`;
const QUEUE_ARN = (name: string) => `arn:aws:sqs:us-east-1:${ACCOUNT}:${name}`;
const ROLE = `arn:aws:iam::${ACCOUNT}:role/r`;
const STREAM_ARN = `arn:aws:kinesis:us-east-1:${ACCOUNT}:stream/s`;

/** `<Property> is required for <type> L`: refused when absent, before any call. */
const REQUIRED = (property: string): Throw => ({
  why: `${property} is refused when absent, before any call`,
  says: new RegExp(`${property} is required for`),
});
const REQUIRED_THROWS = (directions: string[], properties: string[]): Record<string, Throw> =>
  Object.fromEntries(
    directions.flatMap((d) => properties.map((p) => [`${d}:${p}`, REQUIRED(p)]))
  );

const OAC_FIELD_REQUIRED: Throw = {
  why: 'toSdkConfig refuses a config missing a required field, before any call',
  says: /OriginAccessControlConfig is missing required field/,
};

// Not a gap: the CloudFront / S3 setter replaces the whole value from
// `next`, so a member removed from a still-declared value is cleared by
// omission (the update-add probe of the same path observes delivery).
const WHOLE_FROM_NEXT = 'the setter replaces the whole value from next; prev is not read';

/**
 * `DescribeRepositories` answers the repository, so a tag change reaches
 * `TagResource` / `UntagResource`: a fake listing none leaves the update
 * without the ARN it tags by.
 */
function armRepository(physicalId: string): void {
  setOutputOverrides({
    DescribeRepositoriesCommand: () => ({
      repositories: [
        {
          repositoryName: physicalId,
          repositoryArn: `arn:aws:ecr:us-east-1:${ACCOUNT}:repository/${physicalId}`,
        },
      ],
    }),
  });
}

/**
 * The registered consumer answers a Kinesis ARN (the client's endpoint rules
 * refuse a generated one on the next call) and reads back ACTIVE, which
 * create() polls for.
 */
function armActiveConsumer(): void {
  const consumer = {
    ConsumerName: 'c',
    ConsumerARN: `${STREAM_ARN}/consumer/c:1`,
    ConsumerStatus: 'ACTIVE',
    ConsumerCreationTimestamp: new Date(0),
  };
  setOutputOverrides({
    RegisterStreamConsumerCommand: () => ({ Consumer: consumer }),
    DescribeStreamConsumerCommand: () => ({
      ConsumerDescription: { ...consumer, StreamARN: STREAM_ARN },
    }),
  });
}

export const CASES_2: TypeCase[] = [
  {
    resourceType: 'AWS::Lambda::Permission',
    provider: () => new LambdaPermissionProvider(),
    physicalId: 'L-stmt',
    createOnly: createOnlyOf('AWS::Lambda::Permission'),
    exempt: {},
    targets: [],
    bags: [
      {
        name: 'every declared property',
        bag: {
          FunctionName: FUNCTION_ARN,
          Action: 'lambda:InvokeFunctionUrl',
          Principal: '*',
          SourceArn: `arn:aws:s3:::b`,
          SourceAccount: ACCOUNT,
          PrincipalOrgID: 'o-abc',
          EventSourceToken: 'tok',
          FunctionUrlAuthType: 'AWS_IAM',
          InvokedViaFunctionUrl: true,
        },
        expectedRemovalThrows: REQUIRED_THROWS(['create'], ['FunctionName', 'Action', 'Principal']),
      },
      {
        name: 'falsy values',
        bag: {
          FunctionName: FUNCTION_ARN,
          Action: 'lambda:InvokeFunction',
          Principal: '*',
          InvokedViaFunctionUrl: false,
        },
        expectedRemovalThrows: REQUIRED_THROWS(['create'], ['FunctionName', 'Action', 'Principal']),
      },
    ],
  },
  {
    resourceType: 'AWS::Lambda::Url',
    provider: () => new LambdaUrlProvider(),
    physicalId: FUNCTION_ARN,
    createOnly: createOnlyOf('AWS::Lambda::Url'),
    exempt: {},
    targets: [],
    bags: [
      {
        name: 'every declared property',
        bag: {
          TargetFunctionArn: FUNCTION_ARN,
          AuthType: 'AWS_IAM',
          Qualifier: 'live',
          InvokeMode: 'RESPONSE_STREAM',
          Cors: {
            AllowCredentials: true,
            AllowHeaders: ['h1'],
            AllowMethods: ['GET'],
            AllowOrigins: ['https://a.example'],
            ExposeHeaders: ['x1'],
            MaxAge: 60,
          },
        },
        expectedRemovalThrows: REQUIRED_THROWS(['create'], ['TargetFunctionArn']),
      },
      {
        name: 'falsy values',
        bag: {
          TargetFunctionArn: FUNCTION_ARN,
          AuthType: 'NONE',
          Cors: { AllowCredentials: false, MaxAge: 0 },
        },
        expectedSilent: { 'create:AuthType': DECLARED_DEFAULT },
        expectedRemovalThrows: REQUIRED_THROWS(['create'], ['TargetFunctionArn']),
      },
    ],
  },
  {
    resourceType: 'AWS::Lambda::EventInvokeConfig',
    provider: () => new LambdaEventInvokeConfigProvider(),
    physicalId: `${FUNCTION_ARN}|live`,
    createOnly: createOnlyOf('AWS::Lambda::EventInvokeConfig'),
    exempt: {},
    targets: [],
    bags: [
      {
        name: 'every declared property',
        bag: {
          FunctionName: FUNCTION_ARN,
          Qualifier: 'live',
          MaximumEventAgeInSeconds: 120,
          MaximumRetryAttempts: 1,
          DestinationConfig: {
            OnSuccess: { Destination: QUEUE_ARN('ok') },
            OnFailure: { Destination: QUEUE_ARN('failed') },
          },
        },
        expectedRemovalThrows: REQUIRED_THROWS(['create'], ['FunctionName']),
      },
      {
        name: 'falsy values',
        bag: { FunctionName: FUNCTION_ARN, Qualifier: '$LATEST', MaximumRetryAttempts: 0 },
        expectedSilent: { 'create:Qualifier': DECLARED_DEFAULT },
        expectedRemovalThrows: REQUIRED_THROWS(['create'], ['FunctionName']),
      },
    ],
  },
  {
    resourceType: 'AWS::ECR::Repository',
    provider: () => new ECRProvider(),
    physicalId: 'r',
    createOnly: createOnlyOf('AWS::ECR::Repository'),
    arm: armRepository,
    exempt: {
      EmptyOnDelete:
        'read by delete() alone (DeleteRepository force); no create or update request carries it. Pinned by providers/ecr-provider-delete-data-guard.test.ts',
    },
    targets: [
      { path: ['Tags', 0], command: 'UntagResourceCommand', names: 'k1', notNames: 'k2' },
      { path: ['Tags', 1], command: 'UntagResourceCommand', names: 'k2', notNames: 'k1' },
    ],
    bags: [
      {
        name: 'every declared property',
        bag: {
          RepositoryName: 'r',
          ImageScanningConfiguration: { ScanOnPush: true },
          ImageTagMutability: 'IMMUTABLE_WITH_EXCLUSION',
          ImageTagMutabilityExclusionFilters: [
            {
              ImageTagMutabilityExclusionFilterType: 'WILDCARD',
              ImageTagMutabilityExclusionFilterValue: 'latest*',
            },
          ],
          EncryptionConfiguration: { EncryptionType: 'KMS', KmsKey: 'alias/k' },
          LifecyclePolicy: {
            LifecyclePolicyText: '{"rules":[]}',
            RegistryId: ACCOUNT,
          },
          RepositoryPolicyText: {
            Version: '2012-10-17',
            Statement: [{ Effect: 'Allow', Principal: { AWS: ROLE }, Action: 'ecr:BatchGetImage' }],
          },
          Tags: [
            { Key: 'k1', Value: 'v1' },
            { Key: 'k2', Value: 'v2' },
          ],
        },
        // Not sent on create or update: the repository is the one cdkd created
        // in the caller's own registry, which is PutLifecyclePolicy's default.
        expectedSilent: Object.fromEntries(
          ['create', 'create-vary', 'update-vary'].map((d) => [
            `${d}:LifecyclePolicy.RegistryId`,
            "the only registry holding this repository is the caller's own, PutLifecyclePolicy's default",
          ])
        ),
        expectedRemovalThrows: TAG_THROWS(['create', 'update-add', 'update-remove'], 2),
      },
      {
        name: 'falsy values',
        bag: { RepositoryName: 'r', ImageScanningConfiguration: { ScanOnPush: false } },
        expectedSilent: { 'create:ImageScanningConfiguration.ScanOnPush': DECLARED_DEFAULT },
      },
    ],
  },
  {
    resourceType: 'AWS::CloudFront::OriginAccessControl',
    provider: () => new CloudFrontOACProvider(),
    physicalId: 'E1OAC',
    createOnly: createOnlyOf('AWS::CloudFront::OriginAccessControl'),
    wholeFromNext: { keys: () => true, reason: WHOLE_FROM_NEXT },
    exempt: {},
    targets: [],
    bags: [
      {
        name: 'every declared property',
        bag: {
          OriginAccessControlConfig: {
            Name: 'oac',
            Description: 'd',
            OriginAccessControlOriginType: 's3',
            SigningBehavior: 'always',
            SigningProtocol: 'sigv4',
          },
        },
        expectedRemovalThrows: Object.fromEntries(
          ['create', 'update-add', 'update-remove'].flatMap((d) =>
            ['', '.Name', '.OriginAccessControlOriginType', '.SigningBehavior', '.SigningProtocol'].map(
              (p) => [`${d}:OriginAccessControlConfig${p}`, OAC_FIELD_REQUIRED]
            )
          )
        ),
      },
    ],
  },
  {
    resourceType: 'AWS::CloudFront::CloudFrontOriginAccessIdentity',
    provider: () => new CloudFrontOAIProvider(),
    physicalId: 'E1OAI',
    createOnly: createOnlyOf('AWS::CloudFront::CloudFrontOriginAccessIdentity'),
    // A removed Comment is sent as '', the cleared value.
    wholeFromNext: { keys: () => true, reason: WHOLE_FROM_NEXT },
    exempt: {},
    targets: [],
    bags: [
      {
        name: 'every declared property',
        bag: { CloudFrontOriginAccessIdentityConfig: { Comment: 'c' } },
      },
    ],
  },
  {
    resourceType: 'AWS::S3::BucketPolicy',
    provider: () => new S3BucketPolicyProvider(),
    physicalId: 'b',
    createOnly: createOnlyOf('AWS::S3::BucketPolicy'),
    wholeFromNext: { keys: (k) => k === 'PolicyDocument', reason: WHOLE_FROM_NEXT },
    exempt: {},
    targets: [],
    bags: [
      {
        name: 'every declared property',
        bag: {
          Bucket: 'b',
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Principal: { AWS: ROLE },
                Action: 's3:GetObject',
                Resource: 'arn:aws:s3:::b/*',
              },
            ],
          },
        },
        expectedRemovalThrows: {
          ...REQUIRED_THROWS(['create'], ['Bucket']),
          ...REQUIRED_THROWS(['create', 'update-add', 'update-remove'], ['PolicyDocument']),
        },
      },
    ],
  },
  {
    resourceType: 'AWS::Kinesis::StreamConsumer',
    provider: () => new KinesisStreamConsumerProvider(),
    physicalId: `${STREAM_ARN}/consumer/c:1`,
    createOnly: createOnlyOf('AWS::Kinesis::StreamConsumer'),
    arm: armActiveConsumer,
    // Every top-level (Tags too) is create-only in the schema fixture, so no
    // update probe runs: the provider's in-place tag diff (applyTagDiff, used
    // by update()) is not observed by this case.
    exempt: {},
    targets: [],
    bags: [
      {
        name: 'every declared property',
        bag: {
          ConsumerName: 'c',
          StreamARN: STREAM_ARN,
          Tags: [
            { Key: 'k1', Value: 'v1' },
            { Key: 'k2', Value: 'v2' },
          ],
        },
        expectedRemovalThrows: {
          ...Object.fromEntries(
            ['ConsumerName', 'StreamARN'].map((p) => [
              `create:${p}`,
              {
                why: `${p} is refused when absent, before RegisterStreamConsumer`,
                says: new RegExp(`requires ${p}`),
              },
            ])
          ),
          ...TAG_THROWS(['create'], 2),
        },
      },
    ],
  },
];
