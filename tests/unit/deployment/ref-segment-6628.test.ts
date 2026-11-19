import { describe, it, expect } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
  cfnRefValueFromPhysicalId,
} from '../../../src/deployment/intrinsic-function-resolver.js';

/**
 * Issue #6628 — measured against real CloudFormation: these Cloud Control
 * compound-id types return the trailing segment from `Ref`, not the joined id.
 * Each physical id is the Cloud Control identifier the probe stack echoed.
 */
const CASES: ReadonlyArray<readonly [type: string, physicalId: string, ref: string]> = [
  [
    'AWS::EC2::ClientVpnTargetNetworkAssociation',
    'cvpn-endpoint-006cf9ddccae54299|cvpn-assoc-05a779f7b4ef5bd74',
    'cvpn-assoc-05a779f7b4ef5bd74',
  ],
  [
    'AWS::GuardDuty::PublishingDestination',
    '4c25c55650b74fc2a4d7061c2b030a37|f4d0fa47eacfe9690b44051cd4b03b82',
    'f4d0fa47eacfe9690b44051cd4b03b82',
  ],
];

describe('Ref of a measured trailing-segment type (issue #6628)', () => {
  it.each(CASES)('%s: %s -> %s', (type, physicalId, ref) => {
    expect(cfnRefValueFromPhysicalId(type, physicalId)).toBe(ref);
  });

  it.each(CASES)('%s through the resolver (Ref)', async (type, physicalId, ref) => {
    const resolver = new IntrinsicFunctionResolver();
    const context: ResolverContext = {
      template: { Resources: { R: { Type: type, Properties: {} } } },
      resources: { R: { physicalId, resourceType: type, properties: {}, attributes: {}, dependencies: [] } },
    };
    expect(await resolver.resolve({ Ref: 'R' }, context)).toBe(ref);
  });

  // Measured as the joined id: the same Set must not swallow a sibling.
  it.each([
    ['AWS::GuardDuty::ThreatEntitySet', 'be5a07d1278f40858ff8590c78b5b9b2|4c25c55650b74fc2a4d7061c2b030a37'],
    ['AWS::EKS::AccessEntry', 'arn:aws:iam::123456789012:role/r|my-cluster'],
  ])('%s keeps its joined id %s', (type, physicalId) => {
    expect(cfnRefValueFromPhysicalId(type, physicalId)).toBe(physicalId);
  });
});
