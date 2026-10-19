import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  applyDefaultNameForFallback,
  explicitNamePropertyFor,
  fallbackNamePropertyFor,
  fallbackNameRuleTypes,
  generateResourceName,
  generateResourceNameWithFallback,
  generatedNameFor,
  withStackScope,
  type ResourceNameOptions,
} from '../../../src/provisioning/resource-name.js';
import { reverseReplacementRewrittenNameTypes } from '../../../src/deployment/replacement-name-holder.js';

/**
 * go-to-k/cdkd#5095: an un-named resource gets the same name whether its SDK
 * provider or a Cloud Control create names it, and a legacy stack (no stack
 * instance id) keeps every name either route generated before.
 */

const STACK = 'MyStack';
const ID = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const ZONE = 'use1-az5';
// CloudFormation logical ids are alphanumeric; the long one is truncated.
const IDS = ['Resource', `Resource${'X'.repeat(300)}`];

const legacy = <T>(fn: () => T): T =>
  withStackScope({ stackName: STACK, stackInstanceId: undefined, nameGenerations: new Map() }, fn);
const v13 = <T>(fn: () => T, generation = 0): T =>
  withStackScope(
    {
      stackName: STACK,
      stackInstanceId: ID,
      nameGenerations: new Map(IDS.map((id) => [id, generation])),
    },
    fn
  );

const ccProps = (type: string): Record<string, unknown> =>
  type === 'AWS::S3Express::DirectoryBucket' ? { LocationName: ZONE } : {};
const ccName = (type: string, logicalId: string): unknown =>
  applyDefaultNameForFallback(logicalId, type, ccProps(type))[fallbackNamePropertyFor(type)!];
const sdkName = (type: string, logicalId: string): string =>
  generatedNameFor(type, logicalId, { zoneId: ZONE });

/** Types whose SDK provider sends `generateResourceNameWithFallback` (IAM, ELBv2). */
const rewritten = reverseReplacementRewrittenNameTypes();
/** No SDK provider: Cloud Control only. */
const CC_ONLY = ['AWS::Lambda::CapacityProvider'];

/**
 * The SDK providers' name expressions before go-to-k/cdkd#5095, transcribed:
 * a legacy stack's SDK names must not move by one byte.
 */
const gen = (options: ResourceNameOptions) => (id: string) => generateResourceName(id, options);
const SECRET_LIKE = /[^a-zA-Z0-9-/_]/g;
const OLD_SDK: Record<string, (id: string) => string> = {
  'AWS::AutoScaling::AutoScalingGroup': gen({ maxLength: 255 }),
  'AWS::CloudWatch::Alarm': gen({ maxLength: 255 }),
  'AWS::CodeBuild::Project': (id) => id,
  'AWS::CodeCommit::Repository': gen({ maxLength: 100 }),
  'AWS::Cognito::UserPool': gen({ maxLength: 128 }),
  'AWS::DocDB::DBCluster': gen({ maxLength: 63, lowercase: true }),
  'AWS::DocDB::DBInstance': gen({ maxLength: 63, lowercase: true }),
  'AWS::DocDB::DBSubnetGroup': gen({ maxLength: 255, lowercase: true }),
  'AWS::DynamoDB::GlobalTable': gen({ maxLength: 255 }),
  'AWS::DynamoDB::Table': gen({ maxLength: 255 }),
  'AWS::ECR::Repository': (id) => generateResourceName(id, { maxLength: 256 }).toLowerCase(),
  'AWS::ECS::Cluster': gen({ maxLength: 255 }),
  'AWS::ECS::Service': gen({ maxLength: 255 }),
  'AWS::ECS::TaskDefinition': gen({ maxLength: 255 }),
  'AWS::ElastiCache::CacheCluster': gen({ maxLength: 40, lowercase: true }),
  'AWS::ElastiCache::SubnetGroup': gen({ maxLength: 255, lowercase: true }),
  'AWS::Events::Rule': gen({ maxLength: 64 }),
  'AWS::IAM::Policy': gen({ maxLength: 64 }),
  'AWS::Kinesis::Stream': gen({ maxLength: 128 }),
  'AWS::Lambda::Function': gen({ maxLength: 64 }),
  'AWS::Lambda::LayerVersion': gen({ maxLength: 64 }),
  'AWS::Lambda::NetworkConnector': gen({ maxLength: 64 }),
  'AWS::Logs::LogGroup': (id) =>
    `/cdkd/${generateResourceName(id, { maxLength: 506, allowedPattern: SECRET_LIKE })}`,
  'AWS::Neptune::DBCluster': gen({ maxLength: 63, lowercase: true }),
  'AWS::Neptune::DBInstance': gen({ maxLength: 63, lowercase: true }),
  'AWS::Neptune::DBSubnetGroup': gen({ maxLength: 255, lowercase: true }),
  'AWS::Pipes::Pipe': gen({ maxLength: 64 }),
  'AWS::RDS::DBCluster': gen({ maxLength: 63, lowercase: true }),
  'AWS::RDS::DBInstance': gen({ maxLength: 63, lowercase: true }),
  'AWS::RDS::DBProxy': gen({ maxLength: 64 }),
  'AWS::RDS::DBProxyEndpoint': gen({ maxLength: 64 }),
  'AWS::RDS::DBSubnetGroup': gen({ maxLength: 255, lowercase: true }),
  'AWS::S3::Bucket': gen({ maxLength: 63, lowercase: true, allowedPattern: /[^a-z0-9.-]/g }),
  'AWS::S3Express::DirectoryBucket': (id) => {
    const suffix = `--${ZONE}--x-s3`;
    return `${generateResourceName(id, { maxLength: 63 - suffix.length, lowercase: true })}${suffix}`;
  },
  'AWS::Scheduler::Schedule': gen({ maxLength: 64 }),
  'AWS::SecretsManager::Secret': gen({ maxLength: 512, allowedPattern: SECRET_LIKE }),
  'AWS::SNS::Topic': gen({ maxLength: 256 }),
  'AWS::SQS::Queue': gen({ maxLength: 80 }),
  'AWS::SSM::Parameter': (id) =>
    `/${generateResourceName(id, { maxLength: 1023, allowedPattern: SECRET_LIKE })}`,
  'AWS::StepFunctions::StateMachine': gen({ maxLength: 80 }),
  'AWS::WAFv2::WebACL': gen({ maxLength: 128 }),
};

/** `FALLBACK_NAME_RULES` before go-to-k/cdkd#5095, transcribed. */
const OLD_CC: Record<string, ResourceNameOptions> = {
  'AWS::S3::Bucket': { maxLength: 63, lowercase: true },
  'AWS::SQS::Queue': { maxLength: 80 },
  'AWS::SNS::Topic': { maxLength: 256 },
  'AWS::Lambda::Function': { maxLength: 64 },
  'AWS::Lambda::LayerVersion': { maxLength: 64 },
  'AWS::Lambda::CapacityProvider': { maxLength: 64 },
  'AWS::IAM::Role': { maxLength: 64 },
  'AWS::IAM::Policy': { maxLength: 64 },
  'AWS::IAM::ManagedPolicy': { maxLength: 128 },
  'AWS::IAM::User': { maxLength: 64 },
  'AWS::IAM::Group': { maxLength: 128 },
  'AWS::IAM::InstanceProfile': { maxLength: 128 },
  'AWS::DynamoDB::Table': { maxLength: 255 },
  'AWS::ECR::Repository': { maxLength: 256, lowercase: true },
  'AWS::ECS::Cluster': { maxLength: 255 },
  'AWS::ECS::Service': { maxLength: 255 },
  'AWS::Logs::LogGroup': { maxLength: 512 },
  'AWS::CloudWatch::Alarm': { maxLength: 255 },
  'AWS::Events::Rule': { maxLength: 64 },
  'AWS::Kinesis::Stream': { maxLength: 128 },
  'AWS::StepFunctions::StateMachine': { maxLength: 80 },
  'AWS::SecretsManager::Secret': { maxLength: 512, allowedPattern: SECRET_LIKE },
  'AWS::SSM::Parameter': { maxLength: 2048 },
  'AWS::Cognito::UserPool': { maxLength: 128 },
  'AWS::ElastiCache::SubnetGroup': { maxLength: 255, lowercase: true },
  'AWS::ElastiCache::CacheCluster': { maxLength: 40, lowercase: true },
  'AWS::RDS::DBSubnetGroup': { maxLength: 255, lowercase: true },
  'AWS::RDS::DBCluster': { maxLength: 63, lowercase: true },
  'AWS::RDS::DBInstance': { maxLength: 63, lowercase: true },
  'AWS::DocDB::DBSubnetGroup': { maxLength: 255, lowercase: true },
  'AWS::DocDB::DBCluster': { maxLength: 63, lowercase: true },
  'AWS::DocDB::DBInstance': { maxLength: 63, lowercase: true },
  'AWS::Neptune::DBSubnetGroup': { maxLength: 255, lowercase: true },
  'AWS::Neptune::DBCluster': { maxLength: 63, lowercase: true },
  'AWS::Neptune::DBInstance': { maxLength: 63, lowercase: true },
  'AWS::ElasticLoadBalancingV2::LoadBalancer': { maxLength: 32 },
  'AWS::ElasticLoadBalancingV2::TargetGroup': { maxLength: 32 },
  'AWS::WAFv2::WebACL': { maxLength: 128 },
  'AWS::CodeBuild::Project': { maxLength: 150 },
  'AWS::Events::EventBus': { maxLength: 256 },
  'AWS::S3Express::DirectoryBucket': { maxLength: 63, lowercase: true },
};

/** Where a legacy stack's two routes differ, kept from before go-to-k/cdkd#5095. */
const LEGACY_DIVERGENT: Record<string, { sdk: string; cc: string | undefined }> = {
  'AWS::Logs::LogGroup': { sdk: '/cdkd/MyStack-Resource', cc: 'MyStack-Resource' },
  'AWS::SSM::Parameter': { sdk: '/MyStack-Resource', cc: 'MyStack-Resource' },
  'AWS::CodeBuild::Project': { sdk: 'Resource', cc: 'MyStack-Resource' },
  'AWS::AutoScaling::AutoScalingGroup': { sdk: 'MyStack-Resource', cc: undefined },
  'AWS::DynamoDB::GlobalTable': { sdk: 'MyStack-Resource', cc: undefined },
  'AWS::ECS::TaskDefinition': { sdk: 'MyStack-Resource', cc: undefined },
  'AWS::Lambda::NetworkConnector': { sdk: 'MyStack-Resource', cc: undefined },
  'AWS::Pipes::Pipe': { sdk: 'MyStack-Resource', cc: undefined },
  'AWS::Scheduler::Schedule': { sdk: 'MyStack-Resource', cc: undefined },
};

const sdkGeneratedTypes = Object.keys(OLD_SDK);

describe('the SDK and Cloud Control routes generate the same name (#5095)', () => {
  it('every rule type is named by its SDK provider through the rule, or has no SDK provider', () => {
    expect(
      [...sdkGeneratedTypes, ...Object.keys(rewritten), ...CC_ONLY].sort()
    ).toEqual(fallbackNameRuleTypes().sort());
  });

  describe.each([
    ['generation 0', 0],
    ['a later generation', 2],
  ])('a stack with an instance id, %s', (_label, generation) => {
    it.each(sdkGeneratedTypes)('%s', (type) => {
      for (const id of IDS) {
        const sdk = v13(() => sdkName(type, id), generation);
        expect(sdk, `${type} ${id}`).toMatch(/-[0-9a-f]{12}(--use1-az5--x-s3)?$/);
        expect(v13(() => ccName(type, id), generation), `${type} ${id}`).toBe(sdk);
      }
    });

    it.each(Object.entries(rewritten))('%s (rewriting provider)', (type, { maxLength }) => {
      for (const id of IDS) {
        const sdk = v13(() => generateResourceNameWithFallback(undefined, id, { maxLength }), generation);
        expect(v13(() => ccName(type, id), generation), `${type} ${id}`).toBe(sdk);
      }
    });
  });

  describe('a legacy stack', () => {
    it.each(sdkGeneratedTypes.filter((t) => !(t in LEGACY_DIVERGENT)))('%s', (type) => {
      for (const id of IDS) {
        expect(legacy(() => ccName(type, id)), `${type} ${id}`).toBe(legacy(() => sdkName(type, id)));
      }
    });

    it.each(Object.entries(rewritten))('%s (rewriting provider)', (type, { maxLength }) => {
      for (const id of IDS) {
        expect(legacy(() => ccName(type, id))).toBe(
          legacy(() => generateResourceNameWithFallback(undefined, id, { maxLength }))
        );
      }
    });

    it.each(Object.entries(LEGACY_DIVERGENT))('%s keeps each route its own name', (type, want) => {
      expect(legacy(() => sdkName(type, 'Resource'))).toBe(want.sdk);
      expect(legacy(() => ccName(type, 'Resource'))).toBe(want.cc);
    });
  });
});

describe("a legacy stack's names do not move (#5095)", () => {
  it.each(sdkGeneratedTypes)('the SDK provider: %s', (type) => {
    // The SDK provider's own pattern kept `_`, `.` and `/`: not CloudFormation
    // logical ids, but byte-identical anyway.
    for (const id of [...IDS, 'Lg_A.b/C']) {
      expect(legacy(() => sdkName(type, id)), `${type} ${id}`).toBe(legacy(() => OLD_SDK[type]!(id)));
    }
  });

  // A directory bucket's old Cloud Control name lacked the required zone
  // suffix, so AWS refused it; an event bus is no longer named (below).
  const CHANGED_CC = ['AWS::S3Express::DirectoryBucket', 'AWS::Events::EventBus'];
  it.each(Object.keys(OLD_CC).filter((t) => !CHANGED_CC.includes(t)))(
    'the Cloud Control fill: %s',
    (type) => {
      for (const id of IDS) {
        expect(legacy(() => ccName(type, id)), `${type} ${id}`).toBe(
          legacy(() => generateResourceName(id, OLD_CC[type]!))
        );
      }
    }
  );

  it('changes only where the create failed: the required names and the directory bucket', () => {
    for (const type of ['AWS::CodeCommit::Repository', 'AWS::RDS::DBProxy', 'AWS::RDS::DBProxyEndpoint']) {
      expect(legacy(() => ccName(type, 'Resource')), type).toBe('MyStack-Resource');
    }
    // Before: `mystack-resource`, which AWS refuses (no zone suffix).
    expect(legacy(() => generateResourceName('Resource', OLD_CC['AWS::S3Express::DirectoryBucket']!))).toBe(
      'mystack-resource'
    );
    expect(legacy(() => ccName('AWS::S3Express::DirectoryBucket', 'Resource'))).toBe(
      'mystack-resource--use1-az5--x-s3'
    );
  });

  it('an event bus is named by neither route: its Name is required', () => {
    for (const scope of [legacy, v13]) {
      expect(scope(() => applyDefaultNameForFallback('Bus', 'AWS::Events::EventBus', {}))).toEqual({});
    }
    expect(() => generatedNameFor('AWS::Events::EventBus', 'Bus')).toThrow(/no generated-name rule/);
  });

  it('the orphan-adoption allow-list is unchanged', () => {
    // Before #5095: every old rule's property (no rule changed its property),
    // then the adoption-only table.
    const OLD_ADOPTION: Record<string, string> = {
      ...Object.fromEntries(
        Object.keys(OLD_CC)
          .filter((t) => t !== 'AWS::Events::EventBus')
          .map((t) => [t, fallbackNamePropertyFor(t)!])
      ),
      'AWS::Events::EventBus': 'Name',
      'AWS::AutoScaling::AutoScalingGroup': 'AutoScalingGroupName',
      'AWS::CodeCommit::Repository': 'RepositoryName',
      'AWS::DynamoDB::GlobalTable': 'TableName',
      'AWS::RDS::DBProxy': 'DBProxyName',
      'AWS::RDS::DBProxyEndpoint': 'DBProxyEndpointName',
      'AWS::Scheduler::Schedule': 'Name',
    };
    for (const [type, property] of Object.entries(OLD_ADOPTION)) {
      expect(property, type).toBeDefined();
      expect(explicitNamePropertyFor(type), type).toBe(property);
    }
    // Newly named, never admitted to adoption.
    for (const type of ['AWS::ECS::TaskDefinition', 'AWS::Lambda::NetworkConnector', 'AWS::Pipes::Pipe']) {
      expect(fallbackNamePropertyFor(type), type).toBeDefined();
      expect(explicitNamePropertyFor(type), type).toBeUndefined();
    }
  });
});

describe('a directory bucket on the Cloud Control route (#5095)', () => {
  const TYPE = 'AWS::S3Express::DirectoryBucket';

  it.each([
    ['an Availability Zone id', 'use1-az5', 'use1-az5'],
    ['a Local Zone id', 'usw2-lax1-az1', 'usw2-lax1-az1'],
    ['a zone id with the --x-s3 tail', 'use1-az5--x-s3', 'use1-az5'],
  ])('%s: the SDK provider name for that zone', (_label, location, zone) => {
    for (const scope of [legacy, v13]) {
      expect(scope(() => applyDefaultNameForFallback('Bucket', TYPE, { LocationName: location }))).toEqual({
        LocationName: location,
        BucketName: scope(() => generatedNameFor(TYPE, 'Bucket', { zoneId: zone })),
      });
    }
  });

  it.each([
    ['an Availability Zone NAME', { LocationName: 'us-east-1a' }],
    ['no LocationName', {}],
    ['a non-string LocationName', { LocationName: { Ref: 'Zone' } }],
  ])('%s: a create is refused, naming the fix; a reader gets no name', (_label, props) => {
    expect(() => v13(() => applyDefaultNameForFallback('Bucket', TYPE, props))).toThrow(
      /Bucket \(AWS::S3Express::DirectoryBucket\): cdkd cannot generate a BucketName .*Set LocationName to the zone id, or declare BucketName/
    );
    expect(v13(() => applyDefaultNameForFallback('Bucket', TYPE, props, 'omit'))).toBe(props);
  });

  it('a declared name is kept, whatever LocationName holds', () => {
    const props = { LocationName: 'us-east-1a', BucketName: 'mine--use1-az5--x-s3' };
    expect(v13(() => applyDefaultNameForFallback('Bucket', TYPE, props))).toBe(props);
  });
});

describe('every SDK provider names an un-named resource through the rule (#5095)', () => {
  const dir = join(process.cwd(), 'src/provisioning/providers');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  const text = files.map((f) => readFileSync(join(dir, f), 'utf-8')).join('\n');

  it('no provider generates a logical-id name of its own', () => {
    const own = files.filter((f) =>
      /\bgenerateResourceName\(\s*logicalId\b/.test(readFileSync(join(dir, f), 'utf-8'))
    );
    // A budget's name is nested (`Budget.BudgetName`) and the type has no
    // Cloud Control route in cdkd, so it has no rule.
    expect(own).toEqual(['budgets-budget-provider.ts']);
  });

  it('each generatedNameFor call names a rule type, and each SDK-named type is called', () => {
    const called = [...text.matchAll(/generatedNameFor\(\s*'([^']+)'/g)].map((m) => m[1]!);
    expect(called.filter((t) => !fallbackNameRuleTypes().includes(t))).toEqual([]);
    expect(sdkGeneratedTypes.filter((t) => !called.includes(t))).toEqual([]);
  });
});
