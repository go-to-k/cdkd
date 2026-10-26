import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  applyDefaultNameForFallback,
  explicitNamePropertyFor,
  fallbackNamePathFor,
  fallbackNamePropertyFor,
  fallbackNameRuleTypes,
  generateResourceName,
  generateResourceNameWithFallback,
  generatedNameFor,
  withStackScope,
  withoutGeneratedFallbackName,
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
const ZONE_SUFFIX = `--${ZONE}--x-s3`;
// CloudFormation logical ids are alphanumeric; the long one is truncated.
const IDS = ['Resource', `Resource${'X'.repeat(300)}`];

// As production opens a legacy stack's scope: no instance id, so no generations.
const legacy = <T>(fn: () => T): T =>
  withStackScope({ stackName: STACK, stackInstanceId: undefined, nameGenerations: undefined }, fn);
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
  type === 'AWS::S3Express::DirectoryBucket'
    ? { LocationName: ZONE }
    : type === 'AWS::Glue::Connection'
      ? { ConnectionInput: { ConnectionType: 'JDBC' } }
      : {};
/** The value at `path` (a Glue connection's name is `ConnectionInput.Name`). */
const at = (bag: Record<string, unknown>, path: readonly string[]): unknown =>
  path.reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], bag);
const ccName = (type: string, logicalId: string): unknown =>
  at(applyDefaultNameForFallback(logicalId, type, ccProps(type)), fallbackNamePathFor(type)!);
const sdkName = (type: string, logicalId: string): string =>
  generatedNameFor(type, logicalId, { zoneId: ZONE });

/** Types whose SDK provider sends `generateResourceNameWithFallback` (IAM, ELBv2). */
const rewritten = reverseReplacementRewrittenNameTypes();
/** No SDK provider: Cloud Control only. */
const CC_ONLY = ['AWS::Lambda::CapacityProvider'];

/**
 * The SDK providers' name expressions before go-to-k/cdkd#5064 / #5095,
 * transcribed from the providers at 7a0217eb6: a legacy stack's SDK names must
 * not move by one byte, except past a limit {@link SDK_LOWERED} names.
 */
const gen = (options: ResourceNameOptions) => (id: string) => generateResourceName(id, options);
const SECRET_LIKE = /[^a-zA-Z0-9-/_]/g;
const OLD_SDK: Record<string, (id: string) => string> = {
  'AWS::AutoScaling::AutoScalingGroup': gen({ maxLength: 255 }),
  'AWS::CloudWatch::Alarm': gen({ maxLength: 256 }),
  'AWS::CloudTrail::Trail': (id) => id,
  'AWS::CodeBuild::Project': (id) => id,
  'AWS::CodeCommit::Repository': gen({ maxLength: 100 }),
  'AWS::Cognito::UserPool': gen({ maxLength: 128 }),
  'AWS::DocDB::DBCluster': gen({ maxLength: 63, lowercase: true }),
  'AWS::DocDB::DBInstance': gen({ maxLength: 63, lowercase: true }),
  'AWS::DocDB::DBSubnetGroup': gen({ maxLength: 255, lowercase: true }),
  'AWS::DynamoDB::GlobalTable': gen({ maxLength: 255 }),
  'AWS::DynamoDB::Table': gen({ maxLength: 255 }),
  'AWS::EC2::SecurityGroup': (id) => id,
  'AWS::ECR::Repository': (id) => generateResourceName(id, { maxLength: 256 }).toLowerCase(),
  'AWS::ECS::Cluster': gen({ maxLength: 255 }),
  'AWS::ECS::Service': gen({ maxLength: 255 }),
  'AWS::ECS::TaskDefinition': gen({ maxLength: 255 }),
  'AWS::ElastiCache::CacheCluster': gen({ maxLength: 40, lowercase: true }),
  'AWS::ElastiCache::SubnetGroup': gen({ maxLength: 255, lowercase: true }),
  'AWS::Events::Rule': gen({ maxLength: 64 }),
  'AWS::IAM::Policy': gen({ maxLength: 64 }),
  'AWS::Glue::Connection': (id) => id,
  'AWS::Glue::Crawler': (id) => id,
  'AWS::Glue::Job': (id) => id,
  'AWS::Glue::Trigger': (id) => id,
  'AWS::Kinesis::Stream': gen({ maxLength: 128 }),
  'AWS::KinesisFirehose::DeliveryStream': (id) => id,
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
  'AWS::S3Express::DirectoryBucket': (id) =>
    `${generateResourceName(id, { maxLength: 64, lowercase: true })}${ZONE_SUFFIX}`,
  'AWS::Scheduler::Schedule': gen({ maxLength: 64 }),
  'AWS::SecretsManager::Secret': gen({ maxLength: 512, allowedPattern: SECRET_LIKE }),
  'AWS::SNS::Topic': gen({ maxLength: 256 }),
  'AWS::SQS::Queue': gen({ maxLength: 80 }),
  'AWS::SSM::Parameter': (id) =>
    `/${generateResourceName(id, { maxLength: 1023, allowedPattern: SECRET_LIKE })}`,
  'AWS::StepFunctions::StateMachine': gen({ maxLength: 80 }),
  'AWS::WAFv2::WebACL': gen({ maxLength: 128 }),
};

/** `FALLBACK_NAME_RULES` at 7a0217eb6 (before go-to-k/cdkd#5064 / #5095), transcribed. */
const OLD_CC: Record<string, ResourceNameOptions> = {
  'AWS::S3::Bucket': { maxLength: 63, lowercase: true },
  'AWS::SQS::Queue': { maxLength: 80 },
  'AWS::SNS::Topic': { maxLength: 256 },
  'AWS::Lambda::Function': { maxLength: 64 },
  'AWS::Lambda::LayerVersion': { maxLength: 64 },
  'AWS::Lambda::CapacityProvider': { maxLength: 140 },
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
  'AWS::CloudWatch::Alarm': { maxLength: 256 },
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
  'AWS::CodeBuild::Project': { maxLength: 255 },
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
  // go-to-k/cdkd#5095's second set: the SDK provider sent the bare logical id,
  // and a Cloud Control create left the name to the handler.
  'AWS::EC2::SecurityGroup': { sdk: 'Resource', cc: undefined },
  'AWS::CloudTrail::Trail': { sdk: 'Resource', cc: undefined },
  'AWS::Glue::Job': { sdk: 'Resource', cc: undefined },
  'AWS::Glue::Crawler': { sdk: 'Resource', cc: undefined },
  'AWS::Glue::Connection': { sdk: 'Resource', cc: undefined },
  'AWS::Glue::Trigger': { sdk: 'Resource', cc: undefined },
  'AWS::KinesisFirehose::DeliveryStream': { sdk: 'Resource', cc: undefined },
  // go-to-k/cdkd#5309: the SDK provider refused it; the handler named it.
  'AWS::S3Vectors::VectorBucket': { sdk: 'mystack-resource', cc: undefined },
};

/**
 * Types whose SDK provider refused a missing name before it generated one, so
 * no old SDK name exists to keep: an S3 vector bucket (go-to-k/cdkd#5309).
 */
const SDK_NAMED_SINCE: readonly string[] = ['AWS::S3Vectors::VectorBucket'];

const sdkGeneratedTypes = [...Object.keys(OLD_SDK), ...SDK_NAMED_SINCE];

/**
 * The rows whose limit go-to-k/cdkd#5064 lowered to the service's own: a long
 * stack name used to produce a name AWS refuses. `parts` is the length of
 * `{stackName}-{logicalId}` up to which the old and new names agree, `max` the
 * service's limit on the whole name (a directory bucket's includes its zone
 * suffix, so the two differ there).
 */
type Lowered = Record<string, { parts: number; max: number }>;
const SDK_LOWERED: Lowered = {
  'AWS::CloudWatch::Alarm': { parts: 255, max: 255 },
  'AWS::S3Express::DirectoryBucket': { parts: 63 - ZONE_SUFFIX.length, max: 63 },
};
const CC_LOWERED: Lowered = {
  'AWS::CloudWatch::Alarm': { parts: 255, max: 255 },
  'AWS::CodeBuild::Project': { parts: 150, max: 150 },
  'AWS::Lambda::CapacityProvider': { parts: 64, max: 64 },
};
/** A logical id whose `{stackName}-{logicalId}` is `length` characters. */
const idOfFullLength = (length: number): string =>
  `Resource${'X'.repeat(length - `${STACK}-Resource`.length)}`;
/** Below a lowered limit only: past it the names part on purpose (tested apart). */
const idsBelow = (lowered: Lowered, type: string): string[] =>
  type in lowered ? ['Resource', idOfFullLength(lowered[type]!.parts)] : IDS;

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
  it.each(Object.keys(OLD_SDK))('the SDK provider: %s', (type) => {
    // The SDK provider's own pattern kept `_`, `.` and `/`: not CloudFormation
    // logical ids, but byte-identical anyway.
    for (const id of [...idsBelow(SDK_LOWERED, type), 'Lg_A.b/C']) {
      expect(legacy(() => sdkName(type, id)), `${type} ${id}`).toBe(legacy(() => OLD_SDK[type]!(id)));
    }
  });

  // A directory bucket's old Cloud Control name lacked the required zone
  // suffix, so AWS refused it; an event bus is no longer named (below).
  const CHANGED_CC = ['AWS::S3Express::DirectoryBucket', 'AWS::Events::EventBus'];
  it.each(Object.keys(OLD_CC).filter((t) => !CHANGED_CC.includes(t)))(
    'the Cloud Control fill: %s',
    (type) => {
      for (const id of idsBelow(CC_LOWERED, type)) {
        expect(legacy(() => ccName(type, id)), `${type} ${id}`).toBe(
          legacy(() => generateResourceName(id, OLD_CC[type]!))
        );
      }
    }
  );

  // One character past where they part: the old name broke the service's
  // limit, the new one fits it.
  it.each([
    ...Object.entries(SDK_LOWERED).map(([type, l]) => ['the SDK provider', type, l] as const),
    ...Object.entries(CC_LOWERED).map(([type, l]) => ['the Cloud Control fill', type, l] as const),
  ])('%s: %s now fits the limit it used to break', (route, type, { parts, max }) => {
    const id = idOfFullLength(parts + 1);
    const [now, before] =
      route === 'the SDK provider'
        ? [legacy(() => sdkName(type, id)), legacy(() => OLD_SDK[type]!(id))]
        : [legacy(() => ccName(type, id)) as string, legacy(() => generateResourceName(id, OLD_CC[type]!))];
    expect(before.length, before).toBeGreaterThan(max);
    expect(now.length, now).toBeLessThanOrEqual(max);
  });

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
    for (const type of [
      'AWS::ECS::TaskDefinition',
      'AWS::Lambda::NetworkConnector',
      'AWS::Pipes::Pipe',
      'AWS::EC2::SecurityGroup',
      'AWS::CloudTrail::Trail',
      'AWS::Glue::Job',
      'AWS::Glue::Crawler',
      'AWS::Glue::Connection',
      'AWS::Glue::Trigger',
      'AWS::KinesisFirehose::DeliveryStream',
      'AWS::S3Vectors::VectorBucket',
    ]) {
      expect(fallbackNamePathFor(type), type).toBeDefined();
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

  it('the refusal says which: no LocationName, or one that is not a zone id', () => {
    expect(() => v13(() => applyDefaultNameForFallback('Bucket', TYPE, {}))).toThrow(
      /the resource declares no LocationName\./
    );
    expect(() => v13(() => applyDefaultNameForFallback('Bucket', TYPE, { LocationName: 'us-east-1a' }))).toThrow(
      /its LocationName is not a zone id such as use1-az5\./
    );
  });

  it('a declared name is kept, whatever LocationName holds', () => {
    const props = { LocationName: 'us-east-1a', BucketName: 'mine--use1-az5--x-s3' };
    expect(v13(() => applyDefaultNameForFallback('Bucket', TYPE, props))).toBe(props);
  });
});

describe("a Glue connection's nested name on the Cloud Control route (#5095)", () => {
  const TYPE = 'AWS::Glue::Connection';
  const input = { ConnectionType: 'JDBC', ConnectionProperties: { A: 'b' } };

  it('a create fills ConnectionInput.Name, never a top-level Name', () => {
    const props = { CatalogId: '123456789012', ConnectionInput: input };
    const filled = v13(() => applyDefaultNameForFallback('Resource', TYPE, props));
    expect(filled).toEqual({
      CatalogId: '123456789012',
      ConnectionInput: { ...input, Name: v13(() => generatedNameFor(TYPE, 'Resource')) },
    });
    expect(props.ConnectionInput).toEqual(input);
    // The top-level `Name` is read-only in the schema: no reader takes one.
    expect(fallbackNamePropertyFor(TYPE)).toBeUndefined();
    expect(explicitNamePropertyFor(TYPE)).toBeUndefined();
  });

  it('a declared name, or no ConnectionInput, is left as is', () => {
    const declared = { ConnectionInput: { ...input, Name: 'mine' } };
    expect(v13(() => applyDefaultNameForFallback('Resource', TYPE, declared))).toBe(declared);
    for (const props of [{}, { ConnectionInput: 'x' }, { ConnectionInput: [input] }]) {
      expect(v13(() => applyDefaultNameForFallback('Resource', TYPE, props))).toBe(props);
    }
  });

  it('an update takes the generated nested name back out', () => {
    const resolved = { ConnectionInput: input };
    const prepared = v13(() => applyDefaultNameForFallback('Resource', TYPE, resolved, 'omit'));
    expect(withoutGeneratedFallbackName(TYPE, resolved, prepared)).toEqual({ ConnectionInput: input });
    // The template's own falsy value comes back, as at the top level.
    const empty = { ConnectionInput: { ...input, Name: '' } };
    const preparedEmpty = v13(() => applyDefaultNameForFallback('Resource', TYPE, empty, 'omit'));
    expect((preparedEmpty['ConnectionInput'] as Record<string, unknown>)['Name']).not.toBe('');
    expect(withoutGeneratedFallbackName(TYPE, empty, preparedEmpty)).toEqual(empty);
    // A declared name is kept, by identity.
    const declared = { ConnectionInput: { ...input, Name: 'mine' } };
    expect(withoutGeneratedFallbackName(TYPE, declared, declared)).toBe(declared);
    // No container on either side: nothing was filled, nothing to take out.
    for (const [resolvedBag, preparedBag] of [
      [{}, {}],
      [{ ConnectionInput: 'x' }, { ConnectionInput: 'x' }],
      [{}, { ConnectionInput: { ...input, Name: 'n' } }],
      [{ ConnectionInput: input }, {}],
    ] as const) {
      expect(withoutGeneratedFallbackName(TYPE, resolvedBag, preparedBag)).toBe(preparedBag);
    }
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
    // Cloud Control route in cdkd, so it has no rule. A Lambda permission has
    // no name property: its statement id is generated (go-to-k/cdkd#5137),
    // and Cloud Control's handler picks its own, so there is no rule to share.
    expect(own).toEqual(['budgets-budget-provider.ts', 'lambda-permission-provider.ts']);
  });

  it("each generatedNameFor call is the fallback of its own type's name property", () => {
    // A file serving several types (RDS, Neptune, DocDB, ElastiCache, ECS)
    // could swap two calls' types and keep every type called: the nearest
    // `properties['X']` read before each call must be that type's property.
    // CodeBuild reads its `Name` inside `mapProperties` (its provider test pins it).
    // Three read the name into a variable (or a nested object) first: each is
    // pinned to its exact read and fallback below instead.
    const VIA_VARIABLE: Record<string, { file: string; read: RegExp; fallback: RegExp }> = {
      'AWS::CloudTrail::Trail': {
        file: 'cloudtrail-provider.ts',
        read: /const trailName = properties\['TrailName'\] as string \| undefined;/,
        fallback: /Name: trailName \?\? generatedNameFor\('AWS::CloudTrail::Trail', logicalId\)/,
      },
      'AWS::KinesisFirehose::DeliveryStream': {
        file: 'firehose-provider.ts',
        read: /const deliveryStreamName = properties\['DeliveryStreamName'\] as string \| undefined;/,
        fallback:
          /DeliveryStreamName:\s+deliveryStreamName \|\| generatedNameFor\('AWS::KinesisFirehose::DeliveryStream', logicalId\)/,
      },
      'AWS::Glue::Connection': {
        file: 'glue-provider.ts',
        read: /const connectionInput = properties\['ConnectionInput'\] as Record<string, unknown> \| undefined;/,
        fallback:
          /const name =\s+\(connectionInput\['Name'\] as string \| undefined\) \?\?\s+generatedNameFor\('AWS::Glue::Connection', logicalId\);/,
      },
    };
    for (const [type, pin] of Object.entries(VIA_VARIABLE)) {
      const src = readFileSync(join(dir, pin.file), 'utf-8');
      expect(src, type).toMatch(pin.read);
      expect(src, type).toMatch(pin.fallback);
    }
    const mismatched: string[] = [];
    let checked = 0;
    for (const f of files) {
      const src = readFileSync(join(dir, f), 'utf-8');
      for (const m of src.matchAll(/generatedNameFor\(\s*'([^']+)'/g)) {
        if (m[1] === 'AWS::CodeBuild::Project' || m[1]! in VIA_VARIABLE) continue;
        const reads = [...src.slice(Math.max(0, m.index - 400), m.index).matchAll(/properties\['(\w+)'\]/g)];
        checked++;
        if (reads.at(-1)?.[1] !== fallbackNamePropertyFor(m[1]!)) mismatched.push(`${f}: ${m[1]}`);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(40);
    expect(mismatched).toEqual([]);
  });

  it('each generatedNameFor call names a rule type, and each SDK-named type is called', () => {
    const called = [...text.matchAll(/generatedNameFor\(\s*'([^']+)'/g)].map((m) => m[1]!);
    expect(called.filter((t) => !fallbackNameRuleTypes().includes(t))).toEqual([]);
    expect(sdkGeneratedTypes.filter((t) => !called.includes(t))).toEqual([]);
  });
});
