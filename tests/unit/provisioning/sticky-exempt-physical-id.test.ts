import { describe, it, expect } from 'vite-plus/test';
import { ecsServiceSdkPhysicalId } from '../../../src/provisioning/sticky-exempt-physical-id.js';
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

describe('sdkAddressedPhysicalId', () => {
  it('is the ECS::Service entry normalizer', () => {
    expect(STICKY_CC_MIGRATION_EXEMPT.get('AWS::ECS::Service')?.normalizeCcPhysicalId).toBe(
      ecsServiceSdkPhysicalId
    );
    expect(sdkAddressedPhysicalId('AWS::ECS::Service', `${LONG}|my-cluster`, 'Svc')).toBe(LONG);
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
