import { describe, it, expect } from 'vite-plus/test';
import {
  apiGatewayAuthorizerSdkPhysicalId,
  apiGatewayStageSdkPhysicalId,
  ecsServiceSdkPhysicalId,
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
    ['the reverse order with an empty segment', 'yj4gsv|'],
    ['an empty rest API segment', '|yj4gsv'],
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
    ['the reverse <stageName>|<restApiId> order with an uppercase name', 'Prod|mm525t8176x'],
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
