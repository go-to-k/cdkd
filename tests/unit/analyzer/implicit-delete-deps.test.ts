import { describe, it, expect } from 'vite-plus/test';
import {
  IMPLICIT_DELETE_DEPENDENCIES,
  computeImplicitDeleteEdges,
  extractReferencedAlarmNames,
  type DeleteOrderingResource,
} from '../../../src/analyzer/implicit-delete-deps.js';

describe('IMPLICIT_DELETE_DEPENDENCIES', () => {
  it('Subnet must be deleted after Lambda::Function (ENI detach race)', () => {
    expect(IMPLICIT_DELETE_DEPENDENCIES['AWS::EC2::Subnet']).toContain(
      'AWS::Lambda::Function'
    );
  });

  it('SecurityGroup must be deleted after Lambda::Function (ENI detach race)', () => {
    expect(IMPLICIT_DELETE_DEPENDENCIES['AWS::EC2::SecurityGroup']).toContain(
      'AWS::Lambda::Function'
    );
  });

  it('VPC must be deleted after every VPC-attached resource type', () => {
    const deps = IMPLICIT_DELETE_DEPENDENCIES['AWS::EC2::VPC'] ?? [];
    expect(deps).toEqual(
      expect.arrayContaining([
        'AWS::EC2::Subnet',
        'AWS::EC2::SecurityGroup',
        'AWS::EC2::InternetGateway',
        'AWS::EC2::EgressOnlyInternetGateway',
        'AWS::EC2::VPCGatewayAttachment',
        'AWS::EC2::RouteTable',
      ])
    );
  });

  it('IGW must be deleted after VPCGatewayAttachment', () => {
    expect(IMPLICIT_DELETE_DEPENDENCIES['AWS::EC2::InternetGateway']).toContain(
      'AWS::EC2::VPCGatewayAttachment'
    );
  });

  it('IGW must be deleted after NatGateway (EIP mapped-address release)', () => {
    expect(IMPLICIT_DELETE_DEPENDENCIES['AWS::EC2::InternetGateway']).toContain(
      'AWS::EC2::NatGateway'
    );
  });

  it('VPCGatewayAttachment must be detached after NatGateway (EIP mapped-address release)', () => {
    expect(
      IMPLICIT_DELETE_DEPENDENCIES['AWS::EC2::VPCGatewayAttachment']
    ).toContain('AWS::EC2::NatGateway');
  });

  it('does not register a NatGateway implicit-delete key (EIP handled by Ref edge)', () => {
    // The NAT Ref's its EIP via `AllocationId`, so the reversed delete
    // traversal already deletes the NAT before the EIP is released. NatGateway
    // is only ever a dependee here, never a KEY, so no EIP type-based rule is
    // needed (and there is no need to add one for AWS::EC2::EIP either).
    expect(IMPLICIT_DELETE_DEPENDENCIES['AWS::EC2::NatGateway']).toBeUndefined();
    expect(IMPLICIT_DELETE_DEPENDENCIES['AWS::EC2::EIP']).toBeUndefined();
  });

  it('CloudFront OAC must be deleted after Distribution', () => {
    expect(
      IMPLICIT_DELETE_DEPENDENCIES['AWS::CloudFront::OriginAccessControl']
    ).toContain('AWS::CloudFront::Distribution');
  });

  it('Subnet still requires SubnetRouteTableAssociation to be deleted first', () => {
    // Pre-existing rule must not regress when adding the Lambda dep.
    expect(IMPLICIT_DELETE_DEPENDENCIES['AWS::EC2::Subnet']).toContain(
      'AWS::EC2::SubnetRouteTableAssociation'
    );
  });

  it('SecurityGroup still requires Ingress/Egress to be deleted first', () => {
    const deps = IMPLICIT_DELETE_DEPENDENCIES['AWS::EC2::SecurityGroup'] ?? [];
    expect(deps).toContain('AWS::EC2::SecurityGroupIngress');
    expect(deps).toContain('AWS::EC2::SecurityGroupEgress');
  });

  it('does not introduce a self-cycle for any type', () => {
    for (const [key, values] of Object.entries(IMPLICIT_DELETE_DEPENDENCIES)) {
      expect(values).not.toContain(key);
    }
  });
});

describe('extractReferencedAlarmNames', () => {
  it('extracts a bare-name ALARM() reference', () => {
    expect(extractReferencedAlarmNames('ALARM(cdkd-getatt-chain-alarm)')).toEqual([
      'cdkd-getatt-chain-alarm',
    ]);
  });

  it('extracts quoted names (single and double quotes)', () => {
    expect(extractReferencedAlarmNames('ALARM("my-alarm")')).toEqual(['my-alarm']);
    expect(extractReferencedAlarmNames("OK('other-alarm')")).toEqual(['other-alarm']);
  });

  it('extracts all three alarm-state functions', () => {
    const rule = 'ALARM(a) OR (OK(b) AND INSUFFICIENT_DATA(c))';
    expect(extractReferencedAlarmNames(rule).sort()).toEqual(['a', 'b', 'c']);
  });

  it('reduces an ARN argument to the trailing alarm name', () => {
    const rule = 'ALARM("arn:aws:cloudwatch:us-east-1:123456789012:alarm:my-alarm")';
    expect(extractReferencedAlarmNames(rule)).toEqual(['my-alarm']);
  });

  it('deduplicates repeated references', () => {
    expect(extractReferencedAlarmNames('ALARM(a) OR OK(a)')).toEqual(['a']);
  });

  it('ignores TRUE / FALSE boolean literals (no argument)', () => {
    expect(extractReferencedAlarmNames('TRUE OR FALSE')).toEqual([]);
  });

  it('returns empty for a rule with no alarm references', () => {
    expect(extractReferencedAlarmNames('')).toEqual([]);
  });
});

describe('computeImplicitDeleteEdges', () => {
  it('orders a CompositeAlarm before the metric Alarm its AlarmRule references by name', () => {
    const resources: Record<string, DeleteOrderingResource> = {
      ChainAlarm: {
        resourceType: 'AWS::CloudWatch::Alarm',
        physicalId: 'cdkd-getatt-chain-alarm',
        properties: { AlarmName: 'cdkd-getatt-chain-alarm' },
      },
      ChainComposite: {
        resourceType: 'AWS::CloudWatch::CompositeAlarm',
        physicalId: 'cdkd-getatt-chain-composite',
        properties: {
          AlarmName: 'cdkd-getatt-chain-composite',
          AlarmRule: 'ALARM(cdkd-getatt-chain-alarm)',
        },
      },
    };
    expect(computeImplicitDeleteEdges(resources)).toEqual([
      { before: 'ChainComposite', after: 'ChainAlarm' },
    ]);
  });

  it('matches the referenced alarm by physicalId when AlarmName property is absent', () => {
    const resources: Record<string, DeleteOrderingResource> = {
      MetricAlarm: {
        resourceType: 'AWS::CloudWatch::Alarm',
        physicalId: 'metric-alarm-name',
      },
      Composite: {
        resourceType: 'AWS::CloudWatch::CompositeAlarm',
        properties: { AlarmRule: 'ALARM("metric-alarm-name")' },
      },
    };
    expect(computeImplicitDeleteEdges(resources)).toEqual([
      { before: 'Composite', after: 'MetricAlarm' },
    ]);
  });

  it('handles composite-of-composite (one CompositeAlarm referencing another)', () => {
    const resources: Record<string, DeleteOrderingResource> = {
      Inner: {
        resourceType: 'AWS::CloudWatch::CompositeAlarm',
        properties: { AlarmName: 'inner', AlarmRule: 'ALARM(metric)' },
      },
      MetricAlarm: {
        resourceType: 'AWS::CloudWatch::Alarm',
        properties: { AlarmName: 'metric' },
      },
      Outer: {
        resourceType: 'AWS::CloudWatch::CompositeAlarm',
        properties: { AlarmName: 'outer', AlarmRule: 'ALARM(inner)' },
      },
    };
    const edges = computeImplicitDeleteEdges(resources);
    expect(edges).toContainEqual({ before: 'Inner', after: 'MetricAlarm' });
    expect(edges).toContainEqual({ before: 'Outer', after: 'Inner' });
    expect(edges).toHaveLength(2);
  });

  it('emits an edge per referenced alarm when the rule references several', () => {
    const resources: Record<string, DeleteOrderingResource> = {
      A: { resourceType: 'AWS::CloudWatch::Alarm', properties: { AlarmName: 'a' } },
      B: { resourceType: 'AWS::CloudWatch::Alarm', properties: { AlarmName: 'b' } },
      Composite: {
        resourceType: 'AWS::CloudWatch::CompositeAlarm',
        properties: { AlarmName: 'c', AlarmRule: 'ALARM(a) AND OK(b)' },
      },
    };
    const edges = computeImplicitDeleteEdges(resources);
    expect(edges).toContainEqual({ before: 'Composite', after: 'A' });
    expect(edges).toContainEqual({ before: 'Composite', after: 'B' });
    expect(edges).toHaveLength(2);
  });

  it('skips references to alarms not present in the delete set', () => {
    const resources: Record<string, DeleteOrderingResource> = {
      Composite: {
        resourceType: 'AWS::CloudWatch::CompositeAlarm',
        properties: { AlarmName: 'c', AlarmRule: 'ALARM(external-alarm-not-in-stack)' },
      },
    };
    expect(computeImplicitDeleteEdges(resources)).toEqual([]);
  });

  it('never emits a self-cycle edge', () => {
    const resources: Record<string, DeleteOrderingResource> = {
      // Pathological: a composite whose rule names itself.
      Composite: {
        resourceType: 'AWS::CloudWatch::CompositeAlarm',
        properties: { AlarmName: 'self', AlarmRule: 'ALARM(self)' },
      },
    };
    expect(computeImplicitDeleteEdges(resources)).toEqual([]);
  });

  it('returns no edges when there are no composite alarms', () => {
    const resources: Record<string, DeleteOrderingResource> = {
      Alarm: { resourceType: 'AWS::CloudWatch::Alarm', properties: { AlarmName: 'a' } },
      Bucket: { resourceType: 'AWS::S3::Bucket', physicalId: 'my-bucket' },
    };
    expect(computeImplicitDeleteEdges(resources)).toEqual([]);
  });
});
