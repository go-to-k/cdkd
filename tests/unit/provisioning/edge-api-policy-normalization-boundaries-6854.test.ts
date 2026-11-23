/**
 * go-to-k/cdkd#6854 (lane C, edge / API / policy): every normalization rule
 * in the API Gateway, API Gateway V2, AppSync, CloudFront, CloudTrail,
 * Route 53, Budgets, SNS, Cloud Map and CodeCommit providers, with a pair it
 * must equate and a pair it must NOT. The rows and the AWS evidence are in
 * docs/design/6854-c-edge-api-policy-normalization-rules.md; the policy
 * document key (`policyContentKey`) is in policy-document-content-4612.test.ts.
 */
import { describe, it, expect } from 'vite-plus/test';
import type { ResourceRecordSet } from '@aws-sdk/client-route-53';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';
import { ApiGatewayProvider } from '../../../src/provisioning/providers/apigateway-provider.js';
import { ApiGatewayV2Provider } from '../../../src/provisioning/providers/apigatewayv2-provider.js';
import { AppSyncProvider } from '../../../src/provisioning/providers/appsync-provider.js';
import { CloudFrontDistributionProvider } from '../../../src/provisioning/providers/cloudfront-distribution-provider.js';
import { CloudTrailProvider } from '../../../src/provisioning/providers/cloudtrail-provider.js';
import { Route53Provider } from '../../../src/provisioning/providers/route53-provider.js';
import { BudgetsBudgetProvider } from '../../../src/provisioning/providers/budgets-budget-provider.js';
import { SNSTopicProvider } from '../../../src/provisioning/providers/sns-topic-provider.js';
import { normalizeRecordName } from '../../../src/provisioning/providers/route53/record-name.js';
import { sameRecordSet } from '../../../src/provisioning/providers/route53/record-set-group-shape.js';
import { setKey } from '../../../src/provisioning/providers/cloudtrail/shared.js';
import { normalizeDeliveryStatusProtocol } from '../../../src/provisioning/providers/sns-topic/shared.js';
import {
  tagMapsEqual,
  triggersEqual,
} from '../../../src/provisioning/providers/codecommit-repository/shared.js';

type Bag = Record<string, unknown>;
type Hooks = {
  canonicalizeDriftProperties?: (type: string, bag: Bag) => Bag;
  getDriftUnorderedPaths?: (type: string) => string[];
  getDriftUnknownPaths?: (type: string, properties?: Bag) => string[];
};

/** Drift between two bags through a provider's hooks, as `cdkd drift` compares them. */
function drifts(provider: Hooks, type: string, baseline: Bag, aws: Bag): string[] {
  const canon = (bag: Bag): Bag => provider.canonicalizeDriftProperties?.(type, bag) ?? bag;
  return calculateResourceDrift(canon(baseline), canon(aws), {
    ignorePaths: provider.getDriftUnknownPaths?.(type, baseline) ?? [],
    unorderedPaths: provider.getDriftUnorderedPaths?.(type) ?? [],
    resourceType: type,
  }).map((d) => d.path);
}

describe('API Gateway (go-to-k/cdkd#6854)', () => {
  const p = new ApiGatewayProvider() as unknown as Hooks;

  it('a RestApi Policy written as JSON text equals the parsed document, and only that document', () => {
    const doc = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'execute-api:Invoke' }] };
    const type = 'AWS::ApiGateway::RestApi';
    expect(drifts(p, type, { Policy: JSON.stringify(doc) }, { Policy: doc })).toEqual([]);
    expect(drifts(p, type, { Policy: JSON.stringify(doc) }, { Policy: { ...doc, Version: '2008-10-17' } })).not.toEqual([]);
    // Text that does not parse stays text and never equals a document.
    expect(drifts(p, type, { Policy: '{not json' }, { Policy: doc })).not.toEqual([]);
  });

  it('Method AuthorizationScopes: a repeat and an order are not drift; another scope or a case change is', () => {
    const type = 'AWS::ApiGateway::Method';
    expect(drifts(p, type, { AuthorizationScopes: ['a', 'a', 'b'] }, { AuthorizationScopes: ['b', 'a'] })).toEqual([]);
    expect(drifts(p, type, { AuthorizationScopes: ['a'] }, { AuthorizationScopes: ['a', 'b'] })).not.toEqual([]);
    expect(drifts(p, type, { AuthorizationScopes: ['a'] }, { AuthorizationScopes: ['A'] })).not.toEqual([]);
  });

  it.each([
    ['AWS::ApiGateway::Authorizer', 'ProviderARNs', ['arn:aws:cognito-idp:us-east-1:1:userpool/a', 'arn:aws:cognito-idp:us-east-1:1:userpool/b']],
    ['AWS::ApiGateway::RestApi', 'BinaryMediaTypes', ['image/png', 'application/octet-stream']],
  ])('%s %s is a multiset: order is not drift, a changed or repeated member is', (type, key, list) => {
    expect(drifts(p, type, { [key]: list }, { [key]: [...list].reverse() })).toEqual([]);
    expect(drifts(p, type, { [key]: list }, { [key]: [list[0], `${list[1]}x`] })).not.toEqual([]);
    expect(drifts(p, type, { [key]: list }, { [key]: [...list, list[0]] })).not.toEqual([]);
  });

  it('a list at a path outside the unordered set keeps its order', () => {
    expect(new ApiGatewayProvider().getDriftUnorderedPaths('AWS::ApiGateway::Stage')).toEqual([]);
  });
});

describe('API Gateway V2 (go-to-k/cdkd#6854)', () => {
  const p = new ApiGatewayV2Provider();

  it('the update-skip equality is strict: key order, undefined vs {} and list order all differ', () => {
    expect(p.deepEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
    expect(p.deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false);
    expect(p.deepEqual(undefined, {})).toBe(false);
    expect(p.deepEqual(['a', 'b'], ['b', 'a'])).toBe(false);
  });

  it('a legacy baseline is completed from the template, never folded into the readback', async () => {
    const out = await p.canonicalizeDriftPair(
      'AWS::ApiGatewayV2::Api',
      { Tags: [{ Key: 'k', Value: 'old' }] },
      { Tags: { k: 'live' } },
      { Tags: { k: 'declared' } }
    );
    expect(out.baseline['Tags']).toEqual({ k: 'declared' });
    expect(out.aws['Tags']).toEqual({ k: 'live' });
  });

  it('TlsConfig is skipped only on a non-VPC_LINK integration with a recorded bag', () => {
    const type = 'AWS::ApiGatewayV2::Integration';
    expect(p.getDriftUnknownPaths(type, { ConnectionType: 'INTERNET' })).toEqual(['TlsConfig']);
    expect(p.getDriftUnknownPaths(type, { ConnectionType: 'VPC_LINK' })).toEqual([]);
    expect(p.getDriftUnknownPaths(type, {})).toEqual([]);
  });
});

describe('AppSync SDL canonicalization (go-to-k/cdkd#6854)', () => {
  const p = new AppSyncProvider();
  const same = async (a: string, b: string): Promise<boolean> =>
    (await p.canonicalizeSdl(a, 'state')) === (await p.canonicalizeSdl(b, 'aws'));

  it('comments, whitespace and a default schema block are not drift', async () => {
    const declared = '# a comment\ntype Query {\n  a: String\n}\n';
    const read = 'schema {\n  query: Query\n}\n\ntype Query { a: String }';
    expect(await same(declared, read)).toBe(true);
  });

  it.each([
    ['a field order', 'type Query { a: String b: Int }', 'type Query { b: Int a: String }'],
    ['a description', '"""doc""" type Query { a: String }', 'type Query { a: String }'],
    ['a non-default root name', 'schema { query: Root } type Root { a: String }', 'type Root { a: String }'],
    ['a schema block listing fewer roots than the default-named types', 'schema { query: Query } type Query { a: String } type Mutation { m: String }', 'type Query { a: String } type Mutation { m: String }'],
    ['a directive on the schema block', 'schema @aws_api_key { query: Query } type Query { a: String }', 'type Query { a: String }'],
    ['a field type', 'type Query { a: String }', 'type Query { a: String! }'],
  ])('%s is drift', async (_what, a, b) => {
    expect(await same(a, b)).toBe(false);
  });

  it('only the write-only S3 locations are skipped', () => {
    expect(p.getDriftUnknownPaths('AWS::AppSync::GraphQLSchema')).toEqual(['DefinitionS3Location']);
    expect(p.getDriftUnknownPaths('AWS::AppSync::GraphQLApi')).toEqual([]);
  });
});

describe('CloudFront (go-to-k/cdkd#6854)', () => {
  const p = new CloudFrontDistributionProvider() as unknown as Hooks;
  const type = 'AWS::CloudFront::Distribution';
  const cfg = (bucket: string, locations: string[]): Bag => ({
    DistributionConfig: {
      Logging: { Bucket: bucket, Enabled: true },
      Restrictions: { GeoRestriction: { RestrictionType: 'whitelist', Locations: locations } },
    },
  });

  it('GeoRestriction.Locations order is not drift; a changed country is', () => {
    expect(drifts(p, type, cfg('b.s3.us-east-1.amazonaws.com', ['JP', 'US']), cfg('b.s3.us-east-1.amazonaws.com', ['US', 'JP']))).toEqual([]);
    expect(drifts(p, type, cfg('b.s3.us-east-1.amazonaws.com', ['JP', 'US']), cfg('b.s3.us-east-1.amazonaws.com', ['JP', 'GB']))).not.toEqual([]);
  });

  it('Logging.Bucket is compared: another bucket is drift, the verbatim echo is not', () => {
    expect(drifts(p, type, cfg('a.s3.us-east-1.amazonaws.com', ['JP']), cfg('a.s3.us-east-1.amazonaws.com', ['JP']))).toEqual([]);
    expect(drifts(p, type, cfg('a.s3.us-east-1.amazonaws.com', ['JP']), cfg('b.s3.us-east-1.amazonaws.com', ['JP']))).toEqual([
      'DistributionConfig.Logging.Bucket',
    ]);
  });
});

describe('CloudTrail (go-to-k/cdkd#6854)', () => {
  const p = new CloudTrailProvider() as unknown as Hooks;
  const type = 'AWS::CloudTrail::Trail';
  const selector = (name: string, values: string[]): Bag => ({
    Name: name,
    FieldSelectors: [
      { Field: 'eventCategory', Equals: ['Data'] },
      { Field: 'resources.type', Equals: values },
    ],
  });

  it('selector, field-selector and value order are not drift; a changed value or a dropped selector is', () => {
    const a = { AdvancedEventSelectors: [selector('s1', ['AWS::S3::Object', 'AWS::Lambda::Function']), selector('s2', ['AWS::DynamoDB::Table'])] };
    const reordered = {
      AdvancedEventSelectors: [
        { Name: 's2', FieldSelectors: [...(selector('s2', ['AWS::DynamoDB::Table'])['FieldSelectors'] as Bag[])].reverse() },
        selector('s1', ['AWS::Lambda::Function', 'AWS::S3::Object']),
      ],
    };
    expect(drifts(p, type, a, reordered)).toEqual([]);
    expect(drifts(p, type, a, { AdvancedEventSelectors: [selector('s1', ['AWS::S3::Object']), selector('s2', ['AWS::DynamoDB::Table'])] })).not.toEqual([]);
    expect(drifts(p, type, a, { AdvancedEventSelectors: [selector('s1', ['AWS::S3::Object', 'AWS::Lambda::Function'])] })).not.toEqual([]);
  });

  it('the update-skip set key folds order only: undefined is not [], a value is not another', () => {
    expect(setKey([{ b: ['y', 'x'], a: 1 }])).toBe(setKey([{ a: 1, b: ['x', 'y'] }]));
    expect(setKey(undefined)).not.toBe(setKey([]));
    expect(setKey([{ a: 1 }])).not.toBe(setKey([{ a: '1' }]));
    expect(setKey(['x', 'x'])).not.toBe(setKey(['x']));
  });
});

describe('Route 53 (go-to-k/cdkd#6854)', () => {
  it('a record name: trailing dot, letter case and a decoded octal escape are one name', () => {
    expect(normalizeRecordName('WWW.Example.com')).toBe(normalizeRecordName('www.example.com.'));
    expect(normalizeRecordName('*.example.com')).toBe(normalizeRecordName('\\052.example.com.'));
  });

  it.each([
    ['an escaped period inside a label is not a label separator', 'a\\056b.example.com.', 'a.b.example.com.'],
    ['an escaped backslash stays escaped', 'a\\134b.example.com.', 'a\\b.example.com.'],
    ['another label', 'www.example.com', 'ww.example.com'],
    ['a subdomain is not its parent', 'a.example.com', 'example.com'],
  ])('%s', (_what, a, b) => {
    expect(normalizeRecordName(a)).not.toBe(normalizeRecordName(b));
  });

  it('a record set: key order, name spelling and alias case are one; ResourceRecords order and TTL are not', () => {
    const base: ResourceRecordSet = { Name: 'www.example.com.', Type: 'A', TTL: 60, ResourceRecords: [{ Value: '1.1.1.1' }, { Value: '2.2.2.2' }] };
    expect(sameRecordSet({ ...base, Name: 'WWW.example.com' }, { TTL: 60, Type: 'A', Name: 'www.example.com.', ResourceRecords: [{ Value: '1.1.1.1' }, { Value: '2.2.2.2' }] })).toBe(true);
    expect(sameRecordSet(base, { ...base, ResourceRecords: [{ Value: '2.2.2.2' }, { Value: '1.1.1.1' }] })).toBe(false);
    expect(sameRecordSet(base, { ...base, TTL: 300 })).toBe(false);
    const aliasTarget = { HostedZoneId: 'Z1', DNSName: 'D.cloudfront.net', EvaluateTargetHealth: false };
    const alias: ResourceRecordSet = { Name: 'a.example.com.', Type: 'A', AliasTarget: aliasTarget };
    expect(sameRecordSet(alias, { ...alias, AliasTarget: { ...aliasTarget, DNSName: 'd.cloudfront.net.' } })).toBe(true);
    expect(sameRecordSet(alias, { ...alias, AliasTarget: { ...aliasTarget, DNSName: 'dualstack.d.cloudfront.net.' } })).toBe(false);
  });

  it('HostedZone VPCs are a multiset of {VPCId, VPCRegion}: order is not drift, another region is', () => {
    const p = new Route53Provider() as unknown as Hooks;
    const type = 'AWS::Route53::HostedZone';
    const a = { VPCs: [{ VPCId: 'vpc-1', VPCRegion: 'us-east-1' }, { VPCId: 'vpc-2', VPCRegion: 'us-west-2' }] };
    expect(drifts(p, type, a, { VPCs: [...a.VPCs].reverse() })).toEqual([]);
    expect(drifts(p, type, a, { VPCs: [{ VPCId: 'vpc-1', VPCRegion: 'us-east-1' }, { VPCId: 'vpc-2', VPCRegion: 'us-east-1' }] })).not.toEqual([]);
  });
});

describe('Budgets (go-to-k/cdkd#6854)', () => {
  const p = new BudgetsBudgetProvider() as unknown as Hooks;
  const type = 'AWS::Budgets::Budget';
  const budget = (amount: unknown, notifications: Bag[], start?: unknown): Bag => ({
    Budget: { BudgetLimit: { Amount: amount, Unit: 'USD' }, ...(start !== undefined && { TimePeriod: { Start: start } }) },
    NotificationsWithSubscribers: notifications,
  });
  const note = (threshold: unknown, type?: string, subscribers = ['a@example.com']): Bag => ({
    Notification: { NotificationType: 'ACTUAL', ComparisonOperator: 'GREATER_THAN', Threshold: threshold, ...(type && { ThresholdType: type }) },
    Subscribers: subscribers.map((Address) => ({ SubscriptionType: 'EMAIL', Address })),
  });

  it('an absent ThresholdType is PERCENTAGE (Budgets refuses a PERCENTAGE twin of it as a duplicate); ABSOLUTE_VALUE is not', () => {
    expect(drifts(p, type, budget('100', [note(80)]), budget('100.0', [note(80, 'PERCENTAGE')]))).toEqual([]);
    expect(drifts(p, type, budget('100', [note(80)]), budget('100', [note(80, 'ABSOLUTE_VALUE')]))).not.toEqual([]);
  });

  it('an amount or threshold in another spelling is the same number; another number is drift', () => {
    expect(drifts(p, type, budget(100, [note('80')]), budget('100.00', [note(80)]))).toEqual([]);
    expect(drifts(p, type, budget('100', [note(80)]), budget('100.01', [note(80)]))).not.toEqual([]);
    expect(drifts(p, type, budget('100', [note(80)]), budget('100', [note(81)]))).not.toEqual([]);
  });

  it('a TimePeriod date is compared as an instant', () => {
    expect(drifts(p, type, budget('1', [], '2026-01-01'), budget('1', [], '2026-01-01T00:00:00.000Z'))).toEqual([]);
    expect(drifts(p, type, budget('1', [], '2026-01-01'), budget('1', [], '2026-01-02T00:00:00.000Z'))).not.toEqual([]);
  });

  it('notifications and subscribers are multisets: order is not drift, a changed subscriber is', () => {
    const a = budget('1', [note(80, undefined, ['a@example.com', 'b@example.com']), note(90)]);
    const reordered = budget('1', [note(90), note(80, undefined, ['b@example.com', 'a@example.com'])]);
    expect(drifts(p, type, a, reordered)).toEqual([]);
    expect(drifts(p, type, a, budget('1', [note(90), note(80, undefined, ['b@example.com', 'c@example.com'])]))).not.toEqual([]);
  });
});

describe('SNS topic (go-to-k/cdkd#6854)', () => {
  const p = new SNSTopicProvider() as unknown as Hooks;
  const type = 'AWS::SNS::Topic';

  it("TracingConfig PassThrough is the unset '' (SNS's default); Active is not", () => {
    expect(drifts(p, type, { TracingConfig: 'PassThrough' }, { TracingConfig: '' })).toEqual([]);
    expect(drifts(p, type, { TracingConfig: '' }, { TracingConfig: 'Active' })).not.toEqual([]);
  });

  it('delivery-status protocol spellings fold onto the one attribute prefix AWS has per protocol, and only those', () => {
    expect(normalizeDeliveryStatusProtocol('http/s')).toBe('HTTP');
    expect(normalizeDeliveryStatusProtocol('HTTPS')).toBe('HTTP');
    expect(normalizeDeliveryStatusProtocol('lambda')).toBe('Lambda');
    expect(normalizeDeliveryStatusProtocol('sqs')).not.toBe(normalizeDeliveryStatusProtocol('lambda'));
    expect(normalizeDeliveryStatusProtocol('email')).toBeUndefined();
  });
});

describe('CodeCommit (go-to-k/cdkd#6854)', () => {
  it('tag maps compare as maps: key order is not a change, a value or an extra key is', () => {
    expect(tagMapsEqual({ a: '1', b: '2' }, { b: '2', a: '1' })).toBe(true);
    expect(tagMapsEqual({ a: '1' }, { a: '2' })).toBe(false);
    expect(tagMapsEqual({ a: '1' }, { a: '1', b: '2' })).toBe(false);
    expect(tagMapsEqual({ a: '1', b: '2' }, { a: '1' })).toBe(false);
  });

  it('triggers compare in order: a reordered branch list is a change', () => {
    const t = { name: 't', destinationArn: 'arn:aws:sns:us-east-1:1:t', events: ['all'], branches: ['main', 'dev'] };
    expect(triggersEqual([t] as never, [{ ...t }] as never)).toBe(true);
    expect(triggersEqual([t] as never, [{ ...t, branches: ['dev', 'main'] }] as never)).toBe(false);
  });
});
