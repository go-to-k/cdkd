import { describe, it, expect } from 'vite-plus/test';
import {
  computeImplicitDeleteEdges,
  type DeleteOrderingResource,
} from '../../../src/analyzer/implicit-delete-deps.js';

/**
 * go-to-k/cdkd#7208: a custom resource is deleted BEFORE each IAM policy on
 * its ServiceToken Lambda's role, so the handler's Delete still holds its
 * grants. The level walk got this order by accident (the custom resource sat
 * a level above the policy); an event-driven walk needs the edge.
 */
function stack(extra: Record<string, DeleteOrderingResource> = {}) {
  return {
    Role: { resourceType: 'AWS::IAM::Role', physicalId: 'role' },
    Handler: {
      resourceType: 'AWS::Lambda::Function',
      physicalId: 'fn',
      dependencies: ['Role'],
    },
    Grants: { resourceType: 'AWS::IAM::Policy', physicalId: 'p', dependencies: ['Role'] },
    Cr: { resourceType: 'Custom::Thing', physicalId: 'cr', dependencies: ['Handler'] },
    ...extra,
  } satisfies Record<string, DeleteOrderingResource>;
}

describe('computeImplicitDeleteEdges: custom resource before its handler policy (#7208)', () => {
  it('orders the custom resource before every policy on its handler role', () => {
    const edges = computeImplicitDeleteEdges(
      stack({
        Managed: {
          resourceType: 'AWS::IAM::ManagedPolicy',
          physicalId: 'm',
          dependencies: ['Role'],
        },
        Inline: { resourceType: 'AWS::IAM::RolePolicy', physicalId: 'i', dependencies: ['Role'] },
      })
    );
    expect(edges).toEqual(
      expect.arrayContaining([
        { before: 'Cr', after: 'Grants' },
        { before: 'Cr', after: 'Managed' },
        { before: 'Cr', after: 'Inline' },
      ])
    );
    expect(edges).toHaveLength(3);
  });

  it('covers AWS::CloudFormation::CustomResource too', () => {
    const resources = stack();
    resources.Cr = { ...resources.Cr, resourceType: 'AWS::CloudFormation::CustomResource' };
    expect(computeImplicitDeleteEdges(resources)).toEqual([{ before: 'Cr', after: 'Grants' }]);
  });

  it('adds nothing for a policy on another role', () => {
    expect(
      computeImplicitDeleteEdges(
        stack({
          Other: { resourceType: 'AWS::IAM::Role', physicalId: 'other' },
          Grants: { resourceType: 'AWS::IAM::Policy', physicalId: 'p', dependencies: ['Other'] },
        })
      )
    ).toEqual([]);
  });

  it('adds nothing when the dependency is not a Lambda function', () => {
    const resources = stack();
    resources.Handler = { ...resources.Handler, resourceType: 'AWS::SNS::Topic' };
    expect(computeImplicitDeleteEdges(resources)).toEqual([]);
  });

  it('adds nothing when the custom resource already depends on the policy', () => {
    const resources = stack();
    resources.Cr = { ...resources.Cr, dependencies: ['Handler', 'Grants'] };
    expect(computeImplicitDeleteEdges(resources)).toEqual([]);
  });

  it('skips an edge that would close a cycle (the policy goes before the custom resource)', () => {
    const resources = stack();
    // The policy's document names the custom resource's output.
    resources.Grants = { ...resources.Grants, dependencies: ['Role', 'Cr'] };
    expect(computeImplicitDeleteEdges(resources)).toEqual([]);
  });

  it('skips an edge closing a cycle through a type-pair rule', () => {
    // The policy names a subnet (recorded), every subnet goes before every
    // VPC (type pair), and a VPC names the custom resource's output
    // (recorded): the policy is already deleted before the custom resource.
    const resources = stack({
      Subnet: { resourceType: 'AWS::EC2::Subnet', physicalId: 's' },
      Vpc: { resourceType: 'AWS::EC2::VPC', physicalId: 'v', dependencies: ['Cr'] },
    });
    resources.Grants = { ...resources.Grants, dependencies: ['Role', 'Subnet'] };
    expect(computeImplicitDeleteEdges(resources)).toEqual([]);
    // Without the VPC's reference there is no path, so the edge is added.
    resources.Vpc = { ...resources.Vpc, dependencies: [] };
    expect(computeImplicitDeleteEdges(resources)).toEqual([{ before: 'Cr', after: 'Grants' }]);
  });

  it('skips an edge closing a cycle through a composite-alarm edge', () => {
    // The policy names a composite alarm, which goes before the alarm its
    // rule names, which names the custom resource's output.
    const resources = stack({
      Composite: {
        resourceType: 'AWS::CloudWatch::CompositeAlarm',
        physicalId: 'composite',
        properties: { AlarmRule: 'ALARM("child")' },
      },
      Child: { resourceType: 'AWS::CloudWatch::Alarm', physicalId: 'child', dependencies: ['Cr'] },
    });
    resources.Grants = { ...resources.Grants, dependencies: ['Role', 'Composite'] };
    expect(computeImplicitDeleteEdges(resources)).toEqual([{ before: 'Composite', after: 'Child' }]);
  });

  it('resolves the chain through `context` when the Lambda and role are not deleted', () => {
    const all = stack();
    const deleted = { Cr: all.Cr, Grants: all.Grants };
    expect(computeImplicitDeleteEdges(deleted)).toEqual([]);
    expect(computeImplicitDeleteEdges(deleted, all)).toEqual([{ before: 'Cr', after: 'Grants' }]);
  });

  it('never names a resource outside the participating set', () => {
    const all = stack();
    const deleted = { Cr: all.Cr };
    expect(computeImplicitDeleteEdges(deleted, all)).toEqual([]);
  });

  it('reads a malformed dependencies field as none', () => {
    const resources = stack();
    (resources.Cr as { dependencies: unknown }).dependencies = 'Handler';
    expect(computeImplicitDeleteEdges(resources)).toEqual([]);
  });
});
