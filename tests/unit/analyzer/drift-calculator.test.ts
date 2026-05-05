import { describe, it, expect } from 'vitest';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';

describe('calculateResourceDrift', () => {
  it('returns no drift when state matches AWS exactly', () => {
    const state = { BucketName: 'b', VersioningConfiguration: { Status: 'Enabled' } };
    const aws = { BucketName: 'b', VersioningConfiguration: { Status: 'Enabled' } };
    expect(calculateResourceDrift(state, aws)).toEqual([]);
  });

  it('detects scalar drift at the top level', () => {
    const state = { MemorySize: 128 };
    const aws = { MemorySize: 256 };
    expect(calculateResourceDrift(state, aws)).toEqual([
      { path: 'MemorySize', stateValue: 128, awsValue: 256 },
    ]);
  });

  it('reports nested drift with a dotted path', () => {
    const state = { VersioningConfiguration: { Status: 'Enabled' } };
    const aws = { VersioningConfiguration: { Status: 'Suspended' } };
    expect(calculateResourceDrift(state, aws)).toEqual([
      {
        path: 'VersioningConfiguration.Status',
        stateValue: 'Enabled',
        awsValue: 'Suspended',
      },
    ]);
  });

  it('ignores AWS-only keys not present in state', () => {
    // AWS reports many managed-by-AWS fields cdkd never set; treating
    // those as drift would fire false positives on every resource.
    const state = { BucketName: 'b' };
    const aws = {
      BucketName: 'b',
      CreationDate: '2024-01-01T00:00:00Z',
      RegionalDomainName: 'b.s3.us-east-1.amazonaws.com',
    };
    expect(calculateResourceDrift(state, aws)).toEqual([]);
  });

  it('detects drift when an AWS-current value is missing for a state key', () => {
    const state = { Tags: [{ Key: 'env', Value: 'prod' }] };
    const aws = {};
    expect(calculateResourceDrift(state, aws)).toEqual([
      { path: 'Tags', stateValue: [{ Key: 'env', Value: 'prod' }], awsValue: undefined },
    ]);
  });

  it('detects array drift at the parent path (no per-index entries)', () => {
    const state = { SecurityGroupIds: ['sg-1', 'sg-2'] };
    const aws = { SecurityGroupIds: ['sg-1'] };
    const drifts = calculateResourceDrift(state, aws);
    expect(drifts).toHaveLength(1);
    expect(drifts[0]?.path).toBe('SecurityGroupIds');
  });

  it('reports multiple sibling drifts on the same resource', () => {
    const state = { MemorySize: 128, Timeout: 30 };
    const aws = { MemorySize: 256, Timeout: 60 };
    const drifts = calculateResourceDrift(state, aws);
    expect(drifts).toHaveLength(2);
    expect(drifts.map((d) => d.path).sort()).toEqual(['MemorySize', 'Timeout']);
  });

  it('handles empty state (no managed properties => no drift possible)', () => {
    expect(calculateResourceDrift({}, { Anything: 'goes' })).toEqual([]);
  });

  it('treats null vs missing as drift when state declares null', () => {
    const state = { LogConfiguration: null };
    const aws = {};
    expect(calculateResourceDrift(state, aws)).toEqual([
      { path: 'LogConfiguration', stateValue: null, awsValue: undefined },
    ]);
  });
});
