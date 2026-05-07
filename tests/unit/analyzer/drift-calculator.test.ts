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

  it('skips top-level paths in ignorePaths so unreadable state keys do not fire false drift', () => {
    // Mirrors Lambda Code: state holds the asset key, AWS-current snapshot
    // omits it entirely. With ignorePaths the comparator must report no
    // drift for that subtree.
    const state = {
      Code: { S3Bucket: 'b', S3Key: 'k.zip' },
      MemorySize: 128,
    };
    const aws = { MemorySize: 128 };
    expect(
      calculateResourceDrift(state, aws, { ignorePaths: ['Code'] })
    ).toEqual([]);
  });

  it('skips nested paths in ignorePaths but still reports sibling drift', () => {
    const state = {
      VpcConfig: { SubnetIds: ['s-1'], SecurityGroupIds: ['sg-1'] },
    };
    const aws = {
      VpcConfig: { SubnetIds: ['s-2'], SecurityGroupIds: ['sg-1'] },
    };
    expect(
      calculateResourceDrift(state, aws, { ignorePaths: ['VpcConfig.SubnetIds'] })
    ).toEqual([]);
  });

  it('still reports drift on sibling keys even when one path is ignored', () => {
    const state = { Code: { S3Key: 'k1' }, MemorySize: 128 };
    const aws = { MemorySize: 256 };
    expect(
      calculateResourceDrift(state, aws, { ignorePaths: ['Code'] })
    ).toEqual([{ path: 'MemorySize', stateValue: 128, awsValue: 256 }]);
  });

  describe('unionWalkObjects', () => {
    it('default (off) ignores keys present only in AWS-current — preserves the v2 fallback baseline behavior', () => {
      // The default (state-keys-only walk) protects the v2-state
      // fallback path: when the baseline is the user-templated
      // `properties` field, AWS-managed defaults the user did not
      // template would otherwise fire false positives every run.
      const state = { Environment: { Variables: { FOO: 'bar' } } };
      const aws = { Environment: { Variables: { FOO: 'bar', AWS_INTERNAL: 'x' } } };
      expect(calculateResourceDrift(state, aws)).toEqual([]);
    });

    it('on: detects a console-side key add inside a map-shaped property', () => {
      // The headline case for the observed-baseline path: Lambda's
      // `Environment.Variables` started with `{FOO: 'bar'}` at deploy
      // time; the user added `EXTRA: 'hacked'` via the console; drift
      // must surface that add.
      const state = { Environment: { Variables: { FOO: 'bar' } } };
      const aws = { Environment: { Variables: { FOO: 'bar', EXTRA: 'hacked' } } };
      const drifts = calculateResourceDrift(state, aws, { unionWalkObjects: true });
      expect(drifts).toHaveLength(1);
      expect(drifts[0]).toEqual({
        path: 'Environment.Variables.EXTRA',
        stateValue: undefined,
        awsValue: 'hacked',
      });
    });

    it('on: detects a console-side key remove inside a map-shaped property', () => {
      // Symmetric: AWS no longer has a key the baseline did. With
      // state-keys-only walk this would have been picked up at the
      // value comparison (baseline=value vs aws=undefined); union
      // walk preserves that semantic.
      const state = { Environment: { Variables: { FOO: 'bar', KEEP: 'k' } } };
      const aws = { Environment: { Variables: { KEEP: 'k' } } };
      const drifts = calculateResourceDrift(state, aws, { unionWalkObjects: true });
      expect(drifts).toEqual([
        { path: 'Environment.Variables.FOO', stateValue: 'bar', awsValue: undefined },
      ]);
    });

    it('on: still skips top-level keys not present in state', () => {
      // Union-walk only kicks in one level deeper. The top-level walk
      // stays state-keys-only so AWS top-level fields cdkd never set
      // (FunctionArn, RevisionId, ...) don't fire false drift even on
      // the observed-baseline path.
      const state = { MemorySize: 128 };
      const aws = { MemorySize: 128, RevisionId: 'rev-1', FunctionArn: 'arn:...' };
      expect(calculateResourceDrift(state, aws, { unionWalkObjects: true })).toEqual([]);
    });

    it('on: ignorePaths still wins for nested map keys', () => {
      // ignorePaths is provider-declared "drift unknown" — must keep
      // its short-circuit even when union-walk would otherwise descend.
      const state = { Environment: { Variables: { FOO: 'bar' } } };
      const aws = { Environment: { Variables: { FOO: 'bar', SECRET: 'leaked' } } };
      expect(
        calculateResourceDrift(state, aws, {
          unionWalkObjects: true,
          ignorePaths: ['Environment.Variables'],
        })
      ).toEqual([]);
    });

    it('on: arrays inside the descended object are still compared by structural equality', () => {
      // Union-walk affects only object-vs-object descent. Arrays and
      // scalars take the same diff path as before; this test guards
      // against a regression where union-walk accidentally mishandles
      // arrays nested inside maps.
      const state = { Mapped: { Subnets: ['s-1', 's-2'] } };
      const aws = { Mapped: { Subnets: ['s-1'] } };
      const drifts = calculateResourceDrift(state, aws, { unionWalkObjects: true });
      expect(drifts).toEqual([
        { path: 'Mapped.Subnets', stateValue: ['s-1', 's-2'], awsValue: ['s-1'] },
      ]);
    });
  });
});
