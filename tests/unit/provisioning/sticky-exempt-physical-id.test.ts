import { describe, it, expect } from 'vite-plus/test';
import {
  apiGatewayAuthorizerSdkPhysicalId,
  apiGatewayStageSdkPhysicalId,
  apiGatewayV2AuthorizerSdkPhysicalId,
  apiGatewayV2IntegrationSdkPhysicalId,
  apiGatewayV2RouteSdkPhysicalId,
  apiGatewayV2StageSdkPhysicalId,
  appSyncGraphQLApiSdkPhysicalId,
  ecsServiceSdkPhysicalId,
  s3VectorsVectorBucketSdkPhysicalId,
} from '../../../src/provisioning/sticky-exempt-physical-id.js';
import {
  STICKY_CC_MIGRATION_EXEMPT,
  sdkAddressedPhysicalId,
} from '../../../src/provisioning/provider-registry.js';

/**
 * The declared physicalId normalizers of the sticky-CC exemption
 * (go-to-k/cdkd#5654). Strict by contract: only the measured Cloud Control
 * form is accepted, and anything else throws rather than being handed to the
 * SDK provider under a guessed id.
 */
const LONG = 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service';
const SHORT = 'arn:aws:ecs:us-east-1:123456789012:service/my-service';
const CLUSTER_ARN = 'arn:aws:ecs:us-east-1:123456789012:cluster/my-cluster';

describe('ecsServiceSdkPhysicalId', () => {
  it.each([
    ['a long-format ARN with the cluster name', `${LONG}|my-cluster`, LONG],
    ['a long-format ARN with the cluster ARN', `${LONG}|${CLUSTER_ARN}`, LONG],
    ['a legacy short-format ARN', `${SHORT}|my-cluster`, SHORT],
    [
      'another partition',
      'arn:aws-us-gov:ecs:us-gov-west-1:123456789012:service/c/s|c',
      'arn:aws-us-gov:ecs:us-gov-west-1:123456789012:service/c/s',
    ],
  ])('accepts %s and keeps the ARN', (_label, ccId, sdkId) => {
    expect(ecsServiceSdkPhysicalId(ccId)).toBe(sdkId);
  });

  it.each([
    ['the bare ARN the SDK route records', LONG],
    ['the reverse <clusterArn>|<serviceName> order', `${CLUSTER_ARN}|my-service`],
    ['an empty cluster segment', `${LONG}|`],
    ['an extra segment', `${LONG}|my-cluster|x`],
    ['a bare service name', 'my-service|my-cluster'],
    ['another service ARN namespace', 'arn:aws:sns:us-east-1:123456789012:service/a/b|a'],
    ['a long-format ARN naming another cluster', `${LONG}|other-cluster`],
    ['a cluster ARN naming another cluster', `${LONG}|${CLUSTER_ARN.replace('my-cluster', 'x')}`],
    ['a cluster segment that is an ARN of another kind', `${LONG}|arn:aws:iam::123456789012:role/r`],
    ['an empty string', ''],
    ['a short-format ARN with a non-cluster ARN', `${SHORT}|arn:aws:iam::123456789012:role/r`],
    ['a short-format ARN with a cluster segment carrying a slash', `${SHORT}|a/b`],
    ['a four-segment service ARN', `${LONG}/extra|my-cluster`],
    ['a service name carrying a newline', `${LONG}\nx|my-cluster`],
  ])('refuses %s', (_label, ccId) => {
    expect(() => ecsServiceSdkPhysicalId(ccId)).toThrow();
  });

  it('does not echo the id it refuses', () => {
    const secretish = 'arn:aws:ecs:us-east-1:123456789012:service/c/supersecret';
    expect(() => ecsServiceSdkPhysicalId(secretish)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('supersecret') })
    );
  });
});

// The measured Cloud Control forms (us-east-1, 2026-11-17): `mm525t8176|yj4gsv`
// for an authorizer and `mm525t8176|cdkdmeasure` for a stage.
describe('apiGatewayAuthorizerSdkPhysicalId', () => {
  it('keeps the authorizer id of the measured <restApiId>|<authorizerId> form', () => {
    expect(apiGatewayAuthorizerSdkPhysicalId('mm525t8176|yj4gsv')).toBe('yj4gsv');
  });

  it.each([
    ['the bare id the SDK route records', 'yj4gsv'],
    // The committed schema fixture lists AuthorizerId first.
    ['the reversed <authorizerId>|<restApiId> order', 'yj4gsv|mm525t8176'],
    ['an empty authorizer segment', 'mm525t8176|'],
    ['an empty rest API segment', '|yj4gsv'],
    ['a rest API id one character short', 'mm525t817|yj4gsv'],
    ['a rest API id one character long', 'mm525t8176x|yj4gsv'],
    ['an extra segment', 'mm525t8176|yj4gsv|x'],
    ['an uppercase id', 'mm525t8176|YJ4GSV'],
    ['an ARN', 'arn:aws:apigateway:us-east-1::/restapis/mm525t8176/authorizers/yj4gsv'],
    ['an id carrying a newline', 'mm525t8176|yj4gsv\nx'],
    ['an empty string', ''],
  ])('refuses %s', (_label, ccId) => {
    expect(() => apiGatewayAuthorizerSdkPhysicalId(ccId)).toThrow();
  });

  it('does not echo the id it refuses', () => {
    expect(() => apiGatewayAuthorizerSdkPhysicalId('supersecret')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('supersecret') })
    );
  });
});

describe('apiGatewayStageSdkPhysicalId', () => {
  it.each([
    ['the measured form', 'mm525t8176|cdkdmeasure', 'cdkdmeasure'],
    ['a name with hyphens, underscores and capitals', 'mm525t8176|Prod_v-2', 'Prod_v-2'],
  ])('keeps the stage name of %s', (_label, ccId, sdkId) => {
    expect(apiGatewayStageSdkPhysicalId(ccId)).toBe(sdkId);
  });

  it.each([
    ['the bare name the SDK route records', 'prod'],
    ['an empty stage segment', 'mm525t8176|'],
    ['an empty rest API segment', '|prod'],
    ['an extra segment', 'mm525t8176|prod|x'],
    ['the reversed <stageName>|<restApiId> order', 'reroute|mm525t8176'],
    ['the reversed order with a capitalized stage name', 'Prod|mm525t8176'],
    ['a rest API id one character short', 'mm525t817|prod'],
    ['an uppercase rest API id', 'MM525T8176|prod'],
    ['a stage name with a slash', 'mm525t8176|a/b'],
    ['a stage name carrying a newline', 'mm525t8176|prod\nx'],
    ['an empty string', ''],
  ])('refuses %s', (_label, ccId) => {
    expect(() => apiGatewayStageSdkPhysicalId(ccId)).toThrow();
  });

  it('does not echo the id it refuses', () => {
    expect(() => apiGatewayStageSdkPhysicalId('supersecret')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('supersecret') })
    );
  });
});

// The measured Cloud Control forms (us-east-1, 2026-11-17), all under the
// HTTP API `9qyhc572r8`: integration `9qyhc572r8|c1m2ghk`, route
// `9qyhc572r8|m036gwk`, stage `9qyhc572r8|cdkdmeasure` (and
// `j4qslfc9hj|$default`), and authorizer `fhvgo9|9qyhc572r8` -- API id LAST.
const V2_API = '9qyhc572r8';

describe.each([
  ['apiGatewayV2IntegrationSdkPhysicalId', apiGatewayV2IntegrationSdkPhysicalId, 'c1m2ghk'],
  ['apiGatewayV2RouteSdkPhysicalId', apiGatewayV2RouteSdkPhysicalId, 'm036gwk'],
])('%s', (_name, normalize, childId) => {
  it('keeps the child id of the measured <apiId>|<childId> form', () => {
    expect(normalize(`${V2_API}|${childId}`)).toBe(childId);
  });

  it.each([
    ['the bare id the SDK route records', childId],
    // The real measured ids, swapped.
    ['the reversed <childId>|<apiId> order', `${childId}|${V2_API}`],
    ['an empty child segment', `${V2_API}|`],
    ['an empty API segment', `|${childId}`],
    ['an API id one character short', `${V2_API.slice(1)}|${childId}`],
    ['an API id one character long', `${V2_API}x|${childId}`],
    ['an extra segment', `${V2_API}|${childId}|x`],
    ['an uppercase child id', `${V2_API}|${childId.toUpperCase()}`],
    ['an id carrying a newline', `${V2_API}|${childId}\nx`],
    ['an empty string', ''],
  ])('refuses %s', (_label, ccId) => {
    expect(() => normalize(ccId)).toThrow();
  });

  it('does not echo the id it refuses', () => {
    expect(() => normalize('supersecret')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('supersecret') })
    );
  });
});

describe('apiGatewayV2AuthorizerSdkPhysicalId', () => {
  it('keeps the authorizer id of the measured <authorizerId>|<apiId> form', () => {
    expect(apiGatewayV2AuthorizerSdkPhysicalId(`fhvgo9|${V2_API}`)).toBe('fhvgo9');
  });

  it.each([
    ['the bare id the SDK route records', 'fhvgo9'],
    // The order its siblings and the committed schema fixture use.
    ['the reversed <apiId>|<authorizerId> order', `${V2_API}|fhvgo9`],
    ['an empty authorizer segment', `|${V2_API}`],
    ['an empty API segment', 'fhvgo9|'],
    ['an API id one character short', `fhvgo9|${V2_API.slice(1)}`],
    ['an API id one character long', `fhvgo9|${V2_API}x`],
    ['an extra segment', `fhvgo9|${V2_API}|x`],
    ['an uppercase id', `FHVGO9|${V2_API}`],
    ['an id carrying a newline', `fhvgo9|${V2_API}\nx`],
    ['an empty string', ''],
  ])('refuses %s', (_label, ccId) => {
    expect(() => apiGatewayV2AuthorizerSdkPhysicalId(ccId)).toThrow();
  });

  it('does not echo the id it refuses', () => {
    expect(() => apiGatewayV2AuthorizerSdkPhysicalId('supersecret')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('supersecret') })
    );
  });
});

describe('apiGatewayV2StageSdkPhysicalId', () => {
  it.each([
    ['the measured form', `${V2_API}|cdkdmeasure`, 'cdkdmeasure'],
    ['the measured $default stage', 'j4qslfc9hj|$default', '$default'],
    ['a name with hyphens, underscores and capitals', `${V2_API}|Prod_v-2`, 'Prod_v-2'],
  ])('keeps the stage name of %s', (_label, ccId, sdkId) => {
    expect(apiGatewayV2StageSdkPhysicalId(ccId)).toBe(sdkId);
  });

  it.each([
    ['the bare name the SDK route records', 'cdkdmeasure'],
    ['the reversed <stageName>|<apiId> order', `reroute|${V2_API}`],
    ['the reversed order with $default', `$default|${V2_API}`],
    ['an empty stage segment', `${V2_API}|`],
    ['an empty API segment', '|prod'],
    ['an extra segment', `${V2_API}|prod|x`],
    ['an API id one character short', `${V2_API.slice(1)}|prod`],
    ['an uppercase API id', `${V2_API.toUpperCase()}|prod`],
    ['a dollar sign other than $default', `${V2_API}|$prod`],
    ['a stage name with a slash', `${V2_API}|a/b`],
    ['a stage name carrying a newline', `${V2_API}|prod\nx`],
    ['an empty string', ''],
  ])('refuses %s', (_label, ccId) => {
    expect(() => apiGatewayV2StageSdkPhysicalId(ccId)).toThrow();
  });

  it('does not echo the id it refuses', () => {
    expect(() => apiGatewayV2StageSdkPhysicalId('supersecret')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('supersecret') })
    );
  });
});

// Measured (us-east-1, 2026-11-17).
const GQL_ID = 'bebeljql55ecvbv2bfs4vg3wha';
const GQL_ARN = `arn:aws:appsync:us-east-1:123456789012:apis/${GQL_ID}`;

describe('appSyncGraphQLApiSdkPhysicalId', () => {
  it.each([
    ['the measured ARN', GQL_ARN, GQL_ID],
    ['a GovCloud ARN', `arn:aws-us-gov:appsync:us-gov-west-1:123456789012:apis/${GQL_ID}`, GQL_ID],
  ])('keeps the API id of %s', (_label, ccId, sdkId) => {
    expect(appSyncGraphQLApiSdkPhysicalId(ccId)).toBe(sdkId);
  });

  it.each([
    ['the bare id the SDK route records', GQL_ID],
    ['a child type ARN', `${GQL_ARN}/types/Query`],
    ['an API id one character short', GQL_ARN.slice(0, -1)],
    ['an API id one character long', `${GQL_ARN}x`],
    ['an uppercase API id', GQL_ARN.toUpperCase()],
    ['another service', GQL_ARN.replace(':appsync:', ':s3vectors:')],
    ['a partition that is not one', GQL_ARN.replace('arn:aws:', 'arn:awsfoo:')],
    ['a partition with an empty suffix', GQL_ARN.replace('arn:aws:', 'arn:aws-:')],
    ['an endpoint ARN', 'arn:aws:appsync:us-east-1:123456789012:endpoints/graphql-api/5yvlgolsc5bgvkmbp546coh2j4'],
    ['a short account id', GQL_ARN.replace('123456789012', '12345678901')],
    ['a composite', `${GQL_ARN}|x`],
    ['an ARN carrying a newline', `${GQL_ARN}\nx`],
    ['an empty string', ''],
  ])('refuses %s', (_label, ccId) => {
    expect(() => appSyncGraphQLApiSdkPhysicalId(ccId)).toThrow();
  });

  it('does not echo the id it refuses', () => {
    expect(() => appSyncGraphQLApiSdkPhysicalId('supersecret')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('supersecret') })
    );
  });
});

const VB_ARN = 'arn:aws:s3vectors:us-east-1:123456789012:bucket/cdkd-measure-6490-b8-vb';

describe('s3VectorsVectorBucketSdkPhysicalId', () => {
  it.each([
    ['the measured ARN', VB_ARN, 'cdkd-measure-6490-b8-vb'],
    ['a three-character name', 'arn:aws:s3vectors:us-east-1:123456789012:bucket/a1b', 'a1b'],
    ['a China-partition ARN', 'arn:aws-cn:s3vectors:cn-north-1:123456789012:bucket/a1b', 'a1b'],
    // Measured accepted by CreateVectorBucket (us-east-1, 2026-11-17).
    [
      'a dotted name',
      'arn:aws:s3vectors:us-east-1:123456789012:bucket/cdkd-measure-6490.dot-11427',
      'cdkd-measure-6490.dot-11427',
    ],
  ])('keeps the bucket name of %s', (_label, ccId, sdkId) => {
    expect(s3VectorsVectorBucketSdkPhysicalId(ccId)).toBe(sdkId);
  });

  it.each([
    ['the bare name the SDK route records', 'cdkd-measure-6490-b8-vb'],
    ['an index ARN', `${VB_ARN}/index/idx`],
    ['a two-character name', 'arn:aws:s3vectors:us-east-1:123456789012:bucket/ab'],
    ['a name ending in a hyphen', 'arn:aws:s3vectors:us-east-1:123456789012:bucket/abc-'],
    ['an uppercase name', 'arn:aws:s3vectors:us-east-1:123456789012:bucket/ABC'],
    ['an empty name', 'arn:aws:s3vectors:us-east-1:123456789012:bucket/'],
    ['a name with a slash', 'arn:aws:s3vectors:us-east-1:123456789012:bucket/ab/c'],
    ['a name ending in a dot', 'arn:aws:s3vectors:us-east-1:123456789012:bucket/abc.'],
    ['a sixty-four-character name', `arn:aws:s3vectors:us-east-1:123456789012:bucket/${'a'.repeat(64)}`],
    ['an S3 bucket ARN', 'arn:aws:s3:::cdkd-measure-6490-b8-vb'],
    ['a partition that is not one', VB_ARN.replace('arn:aws:', 'arn:awsfoo:')],
    ['a composite', `${VB_ARN}|x`],
    ['an ARN carrying a newline', `${VB_ARN}\nx`],
    ['an empty string', ''],
  ])('refuses %s', (_label, ccId) => {
    expect(() => s3VectorsVectorBucketSdkPhysicalId(ccId)).toThrow();
  });

  it('does not echo the id it refuses', () => {
    expect(() => s3VectorsVectorBucketSdkPhysicalId('supersecret')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('supersecret') })
    );
  });
});

describe('sdkAddressedPhysicalId', () => {
  it('is the ECS::Service entry normalizer', () => {
    expect(STICKY_CC_MIGRATION_EXEMPT.get('AWS::ECS::Service')?.normalizeCcPhysicalId).toBe(
      ecsServiceSdkPhysicalId
    );
    expect(sdkAddressedPhysicalId('AWS::ECS::Service', `${LONG}|my-cluster`, 'Svc')).toBe(LONG);
  });

  it.each([
    ['AWS::ApiGateway::Authorizer', apiGatewayAuthorizerSdkPhysicalId, 'mm525t8176|yj4gsv', 'yj4gsv'],
    ['AWS::ApiGateway::Stage', apiGatewayStageSdkPhysicalId, 'mm525t8176|prod', 'prod'],
    ['AWS::ApiGatewayV2::Stage', apiGatewayV2StageSdkPhysicalId, `${V2_API}|cdkdmeasure`, 'cdkdmeasure'],
    ['AWS::ApiGatewayV2::Integration', apiGatewayV2IntegrationSdkPhysicalId, `${V2_API}|c1m2ghk`, 'c1m2ghk'],
    ['AWS::ApiGatewayV2::Route', apiGatewayV2RouteSdkPhysicalId, `${V2_API}|m036gwk`, 'm036gwk'],
    ['AWS::ApiGatewayV2::Authorizer', apiGatewayV2AuthorizerSdkPhysicalId, `fhvgo9|${V2_API}`, 'fhvgo9'],
    ['AWS::AppSync::GraphQLApi', appSyncGraphQLApiSdkPhysicalId, GQL_ARN, GQL_ID],
    ['AWS::S3Vectors::VectorBucket', s3VectorsVectorBucketSdkPhysicalId, VB_ARN, 'cdkd-measure-6490-b8-vb'],
  ])('is the %s entry normalizer', (type, normalizer, ccId, sdkId) => {
    expect(STICKY_CC_MIGRATION_EXEMPT.get(type)?.normalizeCcPhysicalId).toBe(normalizer);
    expect(sdkAddressedPhysicalId(type, ccId, 'R')).toBe(sdkId);
  });

  it('passes the parity AWS::ApiGateway::Method composite through unchanged', () => {
    expect(STICKY_CC_MIGRATION_EXEMPT.get('AWS::ApiGateway::Method')?.normalizeCcPhysicalId).toBeUndefined();
    expect(sdkAddressedPhysicalId('AWS::ApiGateway::Method', 'mm525t8176|0gqhttf0ej|GET', 'M')).toBe(
      'mm525t8176|0gqhttf0ej|GET'
    );
  });

  it('passes a parity type through unchanged, whatever its shape', () => {
    expect(sdkAddressedPhysicalId('AWS::SNS::Topic', 'a|b', 'T')).toBe('a|b');
    expect(sdkAddressedPhysicalId('AWS::S3::Bucket', 'not-exempt', 'B')).toBe('not-exempt');
  });

  it('names the resource and the --pin-cc-api remedy on a refusal', () => {
    expect(() =>
      sdkAddressedPhysicalId('AWS::ECS::Service', `${CLUSTER_ARN}|my-service`, 'Svc')
    ).toThrow(
      /^Svc \(AWS::ECS::Service\) cannot move from Cloud Control to its SDK provider: .*Pass --pin-cc-api Svc to keep it on Cloud Control\.$/
    );
  });
});
