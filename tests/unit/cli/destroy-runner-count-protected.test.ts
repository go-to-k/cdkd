import { describe, it, expect } from 'vite-plus/test';
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

  it('counts a DSQL Cluster with DeletionProtectionEnabled=true (CC-routed generic flip, issue #1312)', () => {
    const state = makeState({
      Cluster: {
        physicalId: 'abc123',
        resourceType: 'AWS::DSQL::Cluster',
        properties: { DeletionProtectionEnabled: true },
        attributes: {},
        dependencies: [],
      },
    });
    expect(countProtectedResources(state)).toBe(1);
  });

  it('does NOT count a DSQL Cluster with DeletionProtectionEnabled=false', () => {
    const state = makeState({
      Cluster: {
        physicalId: 'abc123',
        resourceType: 'AWS::DSQL::Cluster',
        properties: { DeletionProtectionEnabled: false },
        attributes: {},
        dependencies: [],
      },
    });
    expect(countProtectedResources(state)).toBe(0);
  });

  it('counts a NeptuneGraph Graph with DeletionProtection=true (issue #1314)', () => {
    const state = makeState({
      Graph: {
        physicalId: 'g-abc',
        resourceType: 'AWS::NeptuneGraph::Graph',
        properties: { DeletionProtection: true },
        attributes: {},
        dependencies: [],
      },
    });
    expect(countProtectedResources(state)).toBe(1);
  });

  it('counts an SMSVOICE ProtectConfiguration with DeletionProtectionEnabled=true (issue #1314)', () => {
    const state = makeState({
      Prot: {
        physicalId: 'protect-abc',
        resourceType: 'AWS::SMSVOICE::ProtectConfiguration',
        properties: { DeletionProtectionEnabled: true },
        attributes: {},
        dependencies: [],
      },
    });
    expect(countProtectedResources(state)).toBe(1);
  });

  it('counts a VerifiedPermissions PolicyStore with DeletionProtection.Mode=ENABLED (object shape, issue #1314)', () => {
    const state = makeState({
      Store: {
        physicalId: 'ps-abc',
        resourceType: 'AWS::VerifiedPermissions::PolicyStore',
        properties: { DeletionProtection: { Mode: 'ENABLED' } },
        attributes: {},
        dependencies: [],
      },
    });
    expect(countProtectedResources(state)).toBe(1);
  });

  it('does NOT count a PolicyStore with DeletionProtection.Mode=DISABLED or a non-object value', () => {
    const state = makeState({
      Store: {
        physicalId: 'ps-abc',
        resourceType: 'AWS::VerifiedPermissions::PolicyStore',
        properties: { DeletionProtection: { Mode: 'DISABLED' } },
        attributes: {},
        dependencies: [],
      },
      StoreOdd: {
        physicalId: 'ps-def',
        resourceType: 'AWS::VerifiedPermissions::PolicyStore',
        properties: { DeletionProtection: true },
        attributes: {},
        dependencies: [],
      },
    });
    expect(countProtectedResources(state)).toBe(0);
  });

  it('counts EKS Cluster / RDS GlobalCluster / DocDB GlobalCluster with DeletionProtection=true (issue #1315)', () => {
    const state = makeState({
      Eks: {
        physicalId: 'cdkd-eks',
        resourceType: 'AWS::EKS::Cluster',
        properties: { DeletionProtection: true },
        attributes: {},
        dependencies: [],
      },
      RdsGlobal: {
        physicalId: 'cdkd-rds-global',
        resourceType: 'AWS::RDS::GlobalCluster',
        properties: { DeletionProtection: true },
        attributes: {},
        dependencies: [],
      },
      DocdbGlobal: {
        physicalId: 'cdkd-docdb-global',
        resourceType: 'AWS::DocDB::GlobalCluster',
        properties: { DeletionProtection: true },
        attributes: {},
        dependencies: [],
      },
    });
    expect(countProtectedResources(state)).toBe(3);
  });

  it('counts a Cognito UserPool with DeletionProtection=ACTIVE (string-valued enum)', () => {
    const state = makeState({
      P: {
        physicalId: 'us-east-1_abc',
        resourceType: 'AWS::Cognito::UserPool',
        properties: { DeletionProtection: 'ACTIVE' },
        attributes: {},
        dependencies: [],
      },
    });
    expect(countProtectedResources(state)).toBe(1);
  });

  it('does NOT count a Cognito UserPool with DeletionProtection=INACTIVE', () => {
    const state = makeState({
      P: {
        physicalId: 'us-east-1_abc',
        resourceType: 'AWS::Cognito::UserPool',
        properties: { DeletionProtection: 'INACTIVE' },
        attributes: {},
        dependencies: [],
      },
    });
    expect(countProtectedResources(state)).toBe(0);
  });

  it('counts an AutoScalingGroup with DeletionProtection=prevent-force-deletion', () => {
    const state = makeState({
      A: {
        physicalId: 'my-asg',
        resourceType: 'AWS::AutoScaling::AutoScalingGroup',
        properties: { DeletionProtection: 'prevent-force-deletion' },
        attributes: {},
        dependencies: [],
      },
    });
    expect(countProtectedResources(state)).toBe(1);
  });

  it('counts an AutoScalingGroup with DeletionProtection=prevent-all-deletion', () => {
    const state = makeState({
      A: {
        physicalId: 'my-asg',
        resourceType: 'AWS::AutoScaling::AutoScalingGroup',
        properties: { DeletionProtection: 'prevent-all-deletion' },
        attributes: {},
        dependencies: [],
      },
    });
    expect(countProtectedResources(state)).toBe(1);
  });

  it('does NOT count an AutoScalingGroup with DeletionProtection=none', () => {
    const state = makeState({
      A: {
        physicalId: 'my-asg',
        resourceType: 'AWS::AutoScaling::AutoScalingGroup',
        properties: { DeletionProtection: 'none' },
        attributes: {},
        dependencies: [],
      },
    });
    expect(countProtectedResources(state)).toBe(0);
  });

  it('counts a DocDB DBCluster with DeletionProtection=true', () => {
    const state = makeState({
      DC: {
        physicalId: 'my-docdb-cluster',
        resourceType: 'AWS::DocDB::DBCluster',
        properties: { DeletionProtection: true },
        attributes: {},
        dependencies: [],
      },
    });
    expect(countProtectedResources(state)).toBe(1);
  });

  it('does NOT track a DocDB DBInstance — the SDK shape lacks DeletionProtection', () => {
    // Architectural: DocDB CreateDBInstanceMessage has no DeletionProtection
    // field, so even a property carrying `true` (e.g. set by a confused
    // template) must not count toward the protected resources prompt.
    const state = makeState({
      DI: {
        physicalId: 'my-docdb-instance',
        resourceType: 'AWS::DocDB::DBInstance',
        properties: { DeletionProtection: true },
        attributes: {},
        dependencies: [],
      },
    });
    expect(countProtectedResources(state)).toBe(0);
  });

  it('counts a Neptune DBCluster with DeletionProtection=true', () => {
    const state = makeState({
      NC: {
        physicalId: 'my-neptune-cluster',
        resourceType: 'AWS::Neptune::DBCluster',
        properties: { DeletionProtection: true },
        attributes: {},
        dependencies: [],
      },
    });
    expect(countProtectedResources(state)).toBe(1);
  });

  it('counts a Neptune DBInstance with DeletionProtection=true', () => {
    const state = makeState({
      NI: {
        physicalId: 'my-neptune-instance',
        resourceType: 'AWS::Neptune::DBInstance',
        properties: { DeletionProtection: true },
        attributes: {},
        dependencies: [],
      },
    });
    expect(countProtectedResources(state)).toBe(1);
  });

  // go-to-k/cdkd#3676: EMR's flag is NESTED (`Instances.TerminationProtected`),
  // which the flat per-type property could not express.
  describe('AWS::EMR::Cluster (nested Instances.TerminationProtected)', () => {
    const emr = (
      properties: Record<string, unknown>,
      observedProperties?: Record<string, unknown>
    ): StackState =>
      makeState({
        Cluster: {
          physicalId: 'j-ABC',
          resourceType: 'AWS::EMR::Cluster',
          properties,
          ...(observedProperties && { observedProperties }),
          attributes: {},
          dependencies: [],
        },
      });

    it('counts a cluster whose template set it', () => {
      expect(countProtectedResources(emr({ Instances: { TerminationProtected: true } }))).toBe(1);
    });

    it('counts a cluster whose observed baseline set it', () => {
      expect(
        countProtectedResources(emr({ Instances: {} }, { Instances: { TerminationProtected: true } }))
      ).toBe(1);
    });

    it('does not count an unprotected cluster', () => {
      expect(countProtectedResources(emr({ Instances: { TerminationProtected: false } }))).toBe(0);
      expect(countProtectedResources(emr({ Instances: {} }))).toBe(0);
    });

    it('does not count, or throw on, a top-level flag or a torn Instances block', () => {
      // A top-level key is not where EMR keeps the flag.
      expect(countProtectedResources(emr({ TerminationProtected: true }))).toBe(0);
      expect(countProtectedResources(emr({ Instances: 'torn' }))).toBe(0);
      expect(countProtectedResources(emr({ Instances: null }))).toBe(0);
      expect(countProtectedResources(emr({ Instances: [true] }))).toBe(0);
    });
  });

  describe('AWS::DynamoDB::GlobalTable (flag on the local replica)', () => {
    const table = (
      properties: Record<string, unknown>,
      observedProperties?: Record<string, unknown>
    ): StackState =>
      makeState({
        Table: {
          physicalId: 't',
          resourceType: 'AWS::DynamoDB::GlobalTable',
          properties,
          ...(observedProperties && { observedProperties }),
          attributes: {},
          dependencies: [],
        },
      });

    it('counts the flag on the replica in the record region, with no observed baseline', () => {
      // What CDK synthesizes for `deletionProtection: true`. A deploy with the
      // observed capture off leaves nothing else to read.
      expect(
        countProtectedResources(
          table({ Replicas: [{ Region: 'us-east-1', DeletionProtectionEnabled: true }] })
        )
      ).toBe(1);
    });

    it("does not count another region's replica flag", () => {
      expect(
        countProtectedResources(
          table({
            Replicas: [
              { Region: 'us-east-1', DeletionProtectionEnabled: false },
              { Region: 'eu-west-1', DeletionProtectionEnabled: true },
            ],
          })
        )
      ).toBe(0);
    });

    it('counts protection enabled out of band over a template that says off', () => {
      // The delete flips what AWS has, so the prompt must count it even though
      // the template's replica flag is an explicit `false`.
      expect(
        countProtectedResources(
          table(
            { Replicas: [{ Region: 'us-east-1', DeletionProtectionEnabled: false }] },
            { DeletionProtectionEnabled: true }
          )
        )
      ).toBe(1);
    });

    it('still counts the top-level shape the observed baseline records', () => {
      expect(countProtectedResources(table({}, { DeletionProtectionEnabled: true }))).toBe(1);
    });

    it('does not throw on a torn Replicas list', () => {
      expect(countProtectedResources(table({ Replicas: 'torn' }))).toBe(0);
      expect(countProtectedResources(table({ Replicas: [null, 5] }))).toBe(0);
    });
  });

  it("counts a CFn boolean resolved to the string 'true'", () => {
    const state = makeState({
      Cluster: {
        physicalId: 'j-ABC',
        resourceType: 'AWS::EMR::Cluster',
        properties: { Instances: { TerminationProtected: 'true' } },
        attributes: {},
        dependencies: [],
      },
    });
    expect(countProtectedResources(state)).toBe(1);
  });

  it('neither throws nor counts on a resourceType naming an Object.prototype key', () => {
    // A plain-object map answers these with an INHERITED value: `for...of`
    // over a function threw before the prompt, and the predicate map's
    // inherited `Object` counted anything.
    for (const resourceType of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const state = makeState({
        R: {
          physicalId: 'p',
          resourceType,
          properties: { DeletionProtection: true },
          attributes: {},
          dependencies: [],
        },
      });
      expect(countProtectedResources(state), resourceType).toBe(0);
    }
  });

  describe('AWS::ElasticLoadBalancingV2::LoadBalancer (an entry of LoadBalancerAttributes)', () => {
    const lb = (
      properties: Record<string, unknown>,
      observedProperties?: Record<string, unknown>
    ): StackState =>
      makeState({
        LB: {
          physicalId: 'arn:lb',
          resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
          properties,
          ...(observedProperties && { observedProperties }),
          attributes: {},
          dependencies: [],
        },
      });
    const on = [{ Key: 'deletion_protection.enabled', Value: 'true' }];

    it('counts protection enabled out of band over a template that says off', () => {
      expect(
        countProtectedResources(
          lb(
            { LoadBalancerAttributes: [{ Key: 'deletion_protection.enabled', Value: 'false' }] },
            { LoadBalancerAttributes: on }
          )
        )
      ).toBe(1);
    });

    it('reads the observed baseline when the template lists other attributes only', () => {
      expect(
        countProtectedResources(
          lb(
            { LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '60' }] },
            { LoadBalancerAttributes: on }
          )
        )
      ).toBe(1);
    });

    it('does not throw on, or count, a torn attribute list', () => {
      expect(countProtectedResources(lb({ LoadBalancerAttributes: 'torn' }))).toBe(0);
      expect(countProtectedResources(lb({ LoadBalancerAttributes: { Key: 'x' } }))).toBe(0);
      expect(countProtectedResources(lb({ LoadBalancerAttributes: [null, 5, 'x'] }))).toBe(0);
    });
  });
});

