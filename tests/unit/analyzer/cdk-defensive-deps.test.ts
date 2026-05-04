import { describe, it, expect } from 'vitest';
import { defensiveDependsOnToSkip } from '../../../src/analyzer/cdk-defensive-deps.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

function tpl(
  resources: Record<string, { Type: string; DependsOn?: string | string[] }>,
): CloudFormationTemplate {
  return { Resources: resources } as CloudFormationTemplate;
}

describe('defensiveDependsOnToSkip', () => {
  it('returns empty when resource has no DependsOn', () => {
    const template = tpl({
      Fn: { Type: 'AWS::Lambda::Function' },
    });
    expect(defensiveDependsOnToSkip(template.Resources['Fn']!, template)).toEqual(new Set());
  });

  it('flags VPC Lambda DependsOn on a private DefaultRoute as defensive', () => {
    const template = tpl({
      Fn: {
        Type: 'AWS::Lambda::Function',
        DependsOn: ['Role', 'PrivateRoute'],
      },
      Role: { Type: 'AWS::IAM::Role' },
      PrivateRoute: { Type: 'AWS::EC2::Route' },
    });
    const skip = defensiveDependsOnToSkip(template.Resources['Fn']!, template);
    expect(skip).toEqual(new Set(['PrivateRoute']));
    expect(skip.has('Role')).toBe(false); // IAM Role is a real prerequisite
  });

  it('flags VPC Lambda DependsOn on SubnetRouteTableAssociation as defensive', () => {
    const template = tpl({
      Fn: {
        Type: 'AWS::Lambda::Function',
        DependsOn: ['SubnetA', 'PrivateRouteAssoc'],
      },
      SubnetA: { Type: 'AWS::EC2::Subnet' },
      PrivateRouteAssoc: { Type: 'AWS::EC2::SubnetRouteTableAssociation' },
    });
    const skip = defensiveDependsOnToSkip(template.Resources['Fn']!, template);
    expect(skip).toEqual(new Set(['PrivateRouteAssoc']));
    // Subnet -> Lambda is a real edge (Subnet must exist before CreateFunction
    // accepts the VpcConfig).
    expect(skip.has('SubnetA')).toBe(false);
  });

  it('flags Role / Policy / Lambda::Url / EventSourceMapping defensive deps too', () => {
    const targets = [
      ['AWS::IAM::Role', 'AWS::EC2::Route'],
      ['AWS::IAM::Policy', 'AWS::EC2::Route'],
      ['AWS::Lambda::Url', 'AWS::EC2::Route'],
      ['AWS::Lambda::EventSourceMapping', 'AWS::EC2::Route'],
      ['AWS::IAM::Role', 'AWS::EC2::SubnetRouteTableAssociation'],
    ] as const;
    for (const [from, to] of targets) {
      const template = tpl({
        Source: { Type: from, DependsOn: 'Target' },
        Target: { Type: to },
      });
      const skip = defensiveDependsOnToSkip(template.Resources['Source']!, template);
      expect(skip, `${from} -> ${to}`).toEqual(new Set(['Target']));
    }
  });

  it('does NOT flag DependsOn between unrelated type pairs', () => {
    const template = tpl({
      Fn: {
        Type: 'AWS::Lambda::Function',
        DependsOn: ['Bucket', 'Vpc'],
      },
      Bucket: { Type: 'AWS::S3::Bucket' },
      Vpc: { Type: 'AWS::EC2::VPC' },
    });
    expect(defensiveDependsOnToSkip(template.Resources['Fn']!, template)).toEqual(new Set());
  });

  it('does NOT flag DependsOn from a non-VPC-Lambda type onto a Route', () => {
    // CloudFront Distribution doesn't get a defensive route DependsOn from
    // CDK in practice, but assert the type-pair allowlist is precise rather
    // than broad — only the listed `from` types skip route DependsOns.
    const template = tpl({
      Distribution: {
        Type: 'AWS::CloudFront::Distribution',
        DependsOn: 'PrivateRoute',
      },
      PrivateRoute: { Type: 'AWS::EC2::Route' },
    });
    expect(defensiveDependsOnToSkip(template.Resources['Distribution']!, template)).toEqual(
      new Set(),
    );
  });

  it('skips DependsOn entries pointing to resources missing from the template', () => {
    const template = tpl({
      Fn: {
        Type: 'AWS::Lambda::Function',
        DependsOn: 'GhostRoute',
      },
    });
    // The dep target doesn't exist; can't classify it. Leave it for the
    // DAG builder to surface as a "not found" warning.
    expect(defensiveDependsOnToSkip(template.Resources['Fn']!, template)).toEqual(new Set());
  });

  it('handles a single-string DependsOn the same as an array', () => {
    const template = tpl({
      Fn: { Type: 'AWS::Lambda::Function', DependsOn: 'PrivateRoute' },
      PrivateRoute: { Type: 'AWS::EC2::Route' },
    });
    expect(defensiveDependsOnToSkip(template.Resources['Fn']!, template)).toEqual(
      new Set(['PrivateRoute']),
    );
  });
});
