import { describe, it, expect } from 'vite-plus/test';
import {
  calculateResourceDrift,
  undeclaredEmptyObservedKeys,
} from '../../../src/analyzer/drift-calculator.js';

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

  it('skips a state leaf holding an unresolved dynamic reference (GHSA fix)', () => {
    // State stores the {{resolve:...}} expression; AWS returns the resolved
    // plaintext (or nothing). Comparing would be permanent phantom drift.
    const state = {
      ProviderDetails: { client_secret: '{{resolve:secretsmanager:oidc:SecretString:cs::}}' },
    };
    const aws = { ProviderDetails: { client_secret: 'the-real-plaintext-secret' } };
    expect(calculateResourceDrift(state, aws)).toEqual([]);
  });

  it('still detects drift on a NON-secret sibling of a dynamic reference', () => {
    const state = {
      ProviderDetails: {
        client_secret: '{{resolve:secretsmanager:oidc:SecretString:cs::}}',
        client_id: 'id-v1',
      },
    };
    const aws = { ProviderDetails: { client_secret: 'plaintext', client_id: 'id-v2' } };
    expect(calculateResourceDrift(state, aws)).toEqual([
      { path: 'ProviderDetails.client_id', stateValue: 'id-v1', awsValue: 'id-v2' },
    ]);
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

  describe('order normalization (tags + id arrays)', () => {
    it('reports NO drift when only tag order differs between baseline and AWS', () => {
      // AWS does not guarantee tag ordering across reads; a reorder must
      // not surface as phantom drift.
      const state = {
        Tags: [
          { Key: 'env', Value: 'prod' },
          { Key: 'team', Value: 'core' },
        ],
      };
      const aws = {
        Tags: [
          { Key: 'team', Value: 'core' },
          { Key: 'env', Value: 'prod' },
        ],
      };
      expect(calculateResourceDrift(state, aws)).toEqual([]);
    });

    it('reports NO drift when only SubnetIds order differs', () => {
      const state = { SubnetIds: ['subnet-0aaa111bbb', 'subnet-0ccc222ddd'] };
      const aws = { SubnetIds: ['subnet-0ccc222ddd', 'subnet-0aaa111bbb'] };
      expect(calculateResourceDrift(state, aws)).toEqual([]);
    });

    it('reports NO drift when an id array order differs nested under VpcConfig', () => {
      const state = {
        VpcConfig: { SubnetIds: ['subnet-0aaa111bbb', 'subnet-0ccc222ddd'] },
      };
      const aws = {
        VpcConfig: { SubnetIds: ['subnet-0ccc222ddd', 'subnet-0aaa111bbb'] },
      };
      expect(calculateResourceDrift(state, aws)).toEqual([]);
    });

    it('STILL reports drift when a tag VALUE actually changes (order norm must not hide real drift)', () => {
      const state = {
        Tags: [
          { Key: 'env', Value: 'prod' },
          { Key: 'team', Value: 'core' },
        ],
      };
      const aws = {
        Tags: [
          { Key: 'team', Value: 'core' },
          { Key: 'env', Value: 'staging' },
        ],
      };
      const drifts = calculateResourceDrift(state, aws);
      expect(drifts).toHaveLength(1);
      expect(drifts[0]?.path).toBe('Tags');
    });

    it('STILL reports drift when a subnet id actually changes (order norm must not hide real drift)', () => {
      const state = { SubnetIds: ['subnet-0aaa111bbb', 'subnet-0ccc222ddd'] };
      const aws = { SubnetIds: ['subnet-0ccc222ddd', 'subnet-0eee333fff'] };
      const drifts = calculateResourceDrift(state, aws);
      expect(drifts).toHaveLength(1);
      expect(drifts[0]?.path).toBe('SubnetIds');
    });
  });

  describe('unorderedPaths (provider-declared plain-string sets)', () => {
    // Illustrative paths for exercising the generic mechanism (a leaf and a
    // deeper nested one) -- NOT FSxFileSystemProvider's actual declaration,
    // which is Aliases only. The provider's real list is asserted in
    // tests/unit/provisioning/providers/fsx-filesystem-provider.test.ts.
    const UNORDERED_PATHS = [
      'WindowsConfiguration.Aliases',
      'WindowsConfiguration.SelfManagedActiveDirectoryConfiguration.DnsIps',
    ];

    it('reports no drift on an AWS-side reorder with the observedProperties baseline', () => {
      // observedProperties baseline => unionWalkObjects: true (see drift.ts).
      const observed = {
        WindowsConfiguration: {
          ThroughputCapacity: 8,
          Aliases: ['a.example.com', 'b.example.com'],
          SelfManagedActiveDirectoryConfiguration: { DnsIps: ['10.0.0.1', '10.0.0.2'] },
        },
      };
      const aws = {
        WindowsConfiguration: {
          ThroughputCapacity: 8,
          Aliases: ['b.example.com', 'a.example.com'],
          SelfManagedActiveDirectoryConfiguration: { DnsIps: ['10.0.0.2', '10.0.0.1'] },
        },
      };
      expect(
        calculateResourceDrift(observed, aws, {
          unionWalkObjects: true,
          unorderedPaths: UNORDERED_PATHS,
        })
      ).toEqual([]);
    });

    it('reports no drift on an AWS-side reorder with the properties-fallback baseline', () => {
      // The whole reason the fix lives in the shared normalizer: for a resource
      // deployed before observed-capture the baseline is the user's TEMPLATE
      // order, so only normalizing both sides keeps this clean.
      const templateProperties = {
        WindowsConfiguration: {
          Aliases: ['b.example.com', 'a.example.com'],
          SelfManagedActiveDirectoryConfiguration: { DnsIps: ['10.0.0.2', '10.0.0.1'] },
        },
      };
      const aws = {
        WindowsConfiguration: {
          Aliases: ['a.example.com', 'b.example.com'],
          SelfManagedActiveDirectoryConfiguration: { DnsIps: ['10.0.0.1', '10.0.0.2'] },
        },
      };
      expect(
        calculateResourceDrift(templateProperties, aws, {
          unionWalkObjects: false,
          unorderedPaths: UNORDERED_PATHS,
        })
      ).toEqual([]);
    });

    it('still reports drift on a real membership change at a declared path', () => {
      const state = { WindowsConfiguration: { Aliases: ['a.example.com', 'b.example.com'] } };
      const aws = { WindowsConfiguration: { Aliases: ['a.example.com', 'c.example.com'] } };
      const drifts = calculateResourceDrift(state, aws, { unorderedPaths: UNORDERED_PATHS });
      expect(drifts).toHaveLength(1);
      expect(drifts[0]?.path).toBe('WindowsConfiguration.Aliases');
    });

    it('still reports drift when an undeclared plain-string array is reordered', () => {
      // Guard against over-normalizing an order-significant scalar list.
      const state = { OrderedList: ['first', 'second'] };
      const aws = { OrderedList: ['second', 'first'] };
      const drifts = calculateResourceDrift(state, aws, { unorderedPaths: UNORDERED_PATHS });
      expect(drifts).toHaveLength(1);
      expect(drifts[0]?.path).toBe('OrderedList');
    });

    it('reports drift on a reorder when no unorderedPaths are supplied at all', () => {
      const state = { WindowsConfiguration: { Aliases: ['a.example.com', 'b.example.com'] } };
      const aws = { WindowsConfiguration: { Aliases: ['b.example.com', 'a.example.com'] } };
      expect(calculateResourceDrift(state, aws)).toHaveLength(1);
    });
  });

  describe('unorderedPaths — OBJECT arrays (issue #1620)', () => {
    // The real ELBv2 `TargetGroup.Targets` shape. The provider's own
    // declaration is asserted in
    // tests/unit/provisioning/elbv2-lb-targetgroup-props.test.ts; this block
    // proves the mechanism end-to-end through the comparator, which the
    // plain-string cases above cannot.
    const TARGETS = ['Targets'];

    it('reports NO drift on an AWS-side reorder of an object array', () => {
      const state = {
        Targets: [
          { Id: '10.0.0.10', Port: 80 },
          { Id: '10.0.0.11', Port: 80 },
          { Id: '10.0.0.12', Port: 80 },
        ],
      };
      const aws = {
        Targets: [
          { Id: '10.0.0.12', Port: 80 },
          { Id: '10.0.0.10', Port: 80 },
          { Id: '10.0.0.11', Port: 80 },
        ],
      };
      expect(calculateResourceDrift(state, aws, { unorderedPaths: TARGETS })).toEqual([]);
    });

    it('still reports drift when a member is ADDED (the opposite polarity)', () => {
      // Without this the test above is satisfied by a pass that absorbs
      // everything, not just reorders.
      const state = { Targets: [{ Id: '10.0.0.10', Port: 80 }] };
      const aws = {
        Targets: [
          { Id: '10.0.0.99', Port: 80 },
          { Id: '10.0.0.10', Port: 80 },
        ],
      };
      const drifts = calculateResourceDrift(state, aws, { unorderedPaths: TARGETS });
      expect(drifts).toHaveLength(1);
      expect(drifts[0]?.path).toBe('Targets');
    });

    it('still reports drift when a member VALUE changes under a reorder', () => {
      const state = {
        Targets: [
          { Id: '10.0.0.10', Port: 80 },
          { Id: '10.0.0.11', Port: 80 },
        ],
      };
      const aws = {
        Targets: [
          { Id: '10.0.0.11', Port: 8080 },
          { Id: '10.0.0.10', Port: 80 },
        ],
      };
      expect(calculateResourceDrift(state, aws, { unorderedPaths: TARGETS })).toHaveLength(1);
    });

    it('absorbs a reorder whose two sides also disagree on element KEY order', () => {
      // The raw-JSON.stringify trap: same targets, but each side spells the
      // members in its own order. Only a key-order-independent sort key
      // canonicalizes both to the same sequence.
      const state = {
        Targets: [
          { Port: 80, Id: '10.0.0.11' },
          { Id: '10.0.0.10', Port: 80 },
        ],
      };
      const aws = {
        Targets: [
          { Id: '10.0.0.10', Port: 80 },
          { Id: '10.0.0.11', Port: 80 },
        ],
      };
      expect(calculateResourceDrift(state, aws, { unorderedPaths: TARGETS })).toEqual([]);
    });

    it('is inert on an object array at an UNDECLARED path', () => {
      const state = { Targets: [{ Id: 'a' }, { Id: 'b' }] };
      const aws = { Targets: [{ Id: 'b' }, { Id: 'a' }] };
      expect(calculateResourceDrift(state, aws, { unorderedPaths: ['Other'] })).toHaveLength(1);
    });

    it('an ignorePaths entry wins over an unorderedPaths one (the ECS/ASG-managed case)', () => {
      // What the ELBv2 provider's per-resource `getDriftUnknownPaths` arm
      // produces for a target group whose template declares no Targets: the
      // sibling resource owns the list, so a scale event must not read as
      // drift (and `--revert` must not deregister the live tasks).
      const state = { Targets: [{ Id: '10.0.0.10', Port: 80 }] };
      const aws = {
        Targets: [
          { Id: '10.0.0.10', Port: 80 },
          { Id: '10.0.0.77', Port: 80 },
        ],
      };
      expect(
        calculateResourceDrift(state, aws, { unorderedPaths: TARGETS, ignorePaths: TARGETS })
      ).toEqual([]);
      // ...and without the ignore entry the same change IS drift, so the
      // assertion above is not vacuous.
      expect(calculateResourceDrift(state, aws, { unorderedPaths: TARGETS })).toHaveLength(1);
    });
  });
});

describe('undeclaredEmptyObservedKeys (issue #1498)', () => {
  it('returns undeclared keys whose observed value is an empty container', () => {
    // The live #1498 shape: ECS Cluster observed at create time, BEFORE the
    // sibling ClusterCapacityProviderAssociations resource ran.
    const observed = {
      ClusterName: 'MyCluster',
      CapacityProviders: [],
      ClusterSettings: [],
      DefaultCapacityProviderStrategy: [],
      Tags: [],
    };
    const declared = { ClusterName: 'MyCluster' };
    expect(undeclaredEmptyObservedKeys(observed, declared).sort()).toEqual([
      'CapacityProviders',
      'ClusterSettings',
      'DefaultCapacityProviderStrategy',
      'Tags',
    ]);
  });

  it('returns undeclared keys captured as null / undefined / {}', () => {
    const observed = { A: null, B: undefined, C: {}, Name: 'n' };
    expect(undeclaredEmptyObservedKeys(observed, { Name: 'n' }).sort()).toEqual(['A', 'B', 'C']);
  });

  it('keeps undeclared keys captured with a REAL value (AWS-side defaults stay comparable)', () => {
    const observed = {
      ClusterSettings: [{ Name: 'containerInsights', Value: 'disabled' }],
      HealthCheckType: 'EC2',
    };
    expect(undeclaredEmptyObservedKeys(observed, {})).toEqual([]);
  });

  it('keeps DECLARED keys even when captured empty (template intent is compared, CFn parity)', () => {
    // A template that explicitly declares CapacityProviders: [] means "no
    // capacity providers" — an out-of-band attach IS drift there.
    const observed = { CapacityProviders: [] };
    const declared = { CapacityProviders: [] };
    expect(undeclaredEmptyObservedKeys(observed, declared)).toEqual([]);
  });

  it('does not treat empty strings or zero as empty containers', () => {
    const observed = { Description: '', Count: 0, Flag: false };
    expect(undeclaredEmptyObservedKeys(observed, {})).toEqual([]);
  });

  it('feeds ignorePaths so the #1498 phantom produces no drift end-to-end', () => {
    // ASG shape from the live repro: LifecycleHookSpecificationList captured
    // [] (the sibling AWS::AutoScaling::LifecycleHook had not run yet) and
    // later populated by the sibling + ECS's managed draining hook.
    const observed = {
      AutoScalingGroupName: 'asg',
      DesiredCapacity: '0',
      LifecycleHookSpecificationList: [],
    };
    const declared = { DesiredCapacity: '0' };
    const aws = {
      AutoScalingGroupName: 'asg',
      DesiredCapacity: '0',
      LifecycleHookSpecificationList: [
        { LifecycleHookName: 'ecs-managed-draining-termination-hook' },
        { LifecycleHookName: 'the-stacks-own-lifecycle-hook-resource' },
      ],
    };
    const ignorePaths = undeclaredEmptyObservedKeys(observed, declared);
    expect(
      calculateResourceDrift(observed, aws, { ignorePaths, unionWalkObjects: true })
    ).toEqual([]);
    // Without the fix's ignorePaths the same comparison DOES report the
    // phantom — pins that the helper is load-bearing, not vacuous.
    expect(
      calculateResourceDrift(observed, aws, { unionWalkObjects: true })
    ).toHaveLength(1);
  });
});
