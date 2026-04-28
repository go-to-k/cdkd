import { describe, it, expect } from 'vitest';
import { IMPLICIT_DELETE_DEPENDENCIES } from '../../../src/analyzer/implicit-delete-deps.js';

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
