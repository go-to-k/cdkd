import { describe, it, expect } from 'vitest';
import { countProtectedResources } from '../../../src/cli/commands/destroy-runner.js';
import type { StackState } from '../../../src/types/state.js';

function makeState(resources: StackState['resources']): StackState {
  return {
    version: 3,
    stackName: 'S',
    region: 'us-east-1',
    resources,
    outputs: {},
    lastModified: 0,
  };
}

describe('countProtectedResources', () => {
  it('returns 0 when no resource has a protection-bearing type', () => {
    const state = makeState({
      Bucket: {
        physicalId: 'b',
        resourceType: 'AWS::S3::Bucket',
        properties: {},
        attributes: {},
        dependencies: [],
      },
    });
    expect(countProtectedResources(state)).toBe(0);
  });

  it('counts a Logs::LogGroup with DeletionProtectionEnabled=true', () => {
    const state = makeState({
      LG: {
        physicalId: '/aws/lambda/x',
        resourceType: 'AWS::Logs::LogGroup',
        properties: { DeletionProtectionEnabled: true },
        attributes: {},
        dependencies: [],
      },
    });
    expect(countProtectedResources(state)).toBe(1);
  });

  it('counts an RDS DBInstance with DeletionProtection=true', () => {
    const state = makeState({
      DB: {
        physicalId: 'my-db',
        resourceType: 'AWS::RDS::DBInstance',
        properties: { DeletionProtection: true },
        attributes: {},
        dependencies: [],
      },
    });
    expect(countProtectedResources(state)).toBe(1);
  });

  it('counts an EC2 Instance with DisableApiTermination=true', () => {
    const state = makeState({
      I: {
        physicalId: 'i-abc',
        resourceType: 'AWS::EC2::Instance',
        properties: { DisableApiTermination: true },
        attributes: {},
        dependencies: [],
      },
    });
    expect(countProtectedResources(state)).toBe(1);
  });

  it('counts an ELBv2 LoadBalancer when LoadBalancerAttributes has deletion_protection.enabled=true', () => {
    const state = makeState({
      LB: {
        physicalId: 'arn:lb',
        resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
        properties: {
          LoadBalancerAttributes: [
            { Key: 'deletion_protection.enabled', Value: 'true' },
            { Key: 'idle_timeout.timeout_seconds', Value: '60' },
          ],
        },
        attributes: {},
        dependencies: [],
      },
    });
    expect(countProtectedResources(state)).toBe(1);
  });

  it('does not count protection-bearing resources whose flag is missing or false', () => {
    const state = makeState({
      DB: {
        physicalId: 'my-db',
        resourceType: 'AWS::RDS::DBInstance',
        properties: { DeletionProtection: false },
        attributes: {},
        dependencies: [],
      },
      LG: {
        physicalId: '/aws/lambda/x',
        resourceType: 'AWS::Logs::LogGroup',
        properties: {},
        attributes: {},
        dependencies: [],
      },
    });
    expect(countProtectedResources(state)).toBe(0);
  });

  it('falls back to observedProperties when properties does not carry the flag', () => {
    const state = makeState({
      T: {
        physicalId: 't',
        resourceType: 'AWS::DynamoDB::Table',
        properties: {},
        observedProperties: { DeletionProtectionEnabled: true },
        attributes: {},
        dependencies: [],
      },
    });
    expect(countProtectedResources(state)).toBe(1);
  });
});
