import { describe, it, expect } from 'vitest';
import {
  extractLambdaVpcDeleteDeps,
  type ResourceLike,
} from '../../../src/analyzer/lambda-vpc-deps.js';

describe('extractLambdaVpcDeleteDeps', () => {
  it('returns no edges when there are no Lambda functions', () => {
    const resources: Record<string, ResourceLike> = {
      Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
    };
    expect(extractLambdaVpcDeleteDeps(resources)).toEqual([]);
  });

  it('returns no edges for Lambda without VpcConfig', () => {
    const resources: Record<string, ResourceLike> = {
      Fn: {
        Type: 'AWS::Lambda::Function',
        Properties: { Role: { 'Fn::GetAtt': ['Role', 'Arn'] } },
      },
      Role: { Type: 'AWS::IAM::Role', Properties: {} },
    };
    expect(extractLambdaVpcDeleteDeps(resources)).toEqual([]);
  });

  it('extracts edges from VpcConfig.SubnetIds Refs', () => {
    const resources: Record<string, ResourceLike> = {
      Fn: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          VpcConfig: {
            SubnetIds: [{ Ref: 'SubnetA' }, { Ref: 'SubnetB' }],
          },
        },
      },
      SubnetA: { Type: 'AWS::EC2::Subnet', Properties: {} },
      SubnetB: { Type: 'AWS::EC2::Subnet', Properties: {} },
    };

    const edges = extractLambdaVpcDeleteDeps(resources);
    expect(edges).toEqual([
      { before: 'Fn', after: 'SubnetA' },
      { before: 'Fn', after: 'SubnetB' },
    ]);
  });

  it('extracts edges from VpcConfig.SecurityGroupIds via Ref and Fn::GetAtt', () => {
    const resources: Record<string, ResourceLike> = {
      Fn: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          VpcConfig: {
            SecurityGroupIds: [
              { Ref: 'SgA' },
              { 'Fn::GetAtt': ['SgB', 'GroupId'] },
            ],
          },
        },
      },
      SgA: { Type: 'AWS::EC2::SecurityGroup', Properties: {} },
      SgB: { Type: 'AWS::EC2::SecurityGroup', Properties: {} },
    };

    const edges = extractLambdaVpcDeleteDeps(resources);
    expect(edges).toEqual([
      { before: 'Fn', after: 'SgA' },
      { before: 'Fn', after: 'SgB' },
    ]);
  });

  it('combines SubnetIds and SecurityGroupIds in a single VpcConfig', () => {
    const resources: Record<string, ResourceLike> = {
      Fn: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          VpcConfig: {
            SubnetIds: [{ Ref: 'Subnet1' }],
            SecurityGroupIds: [{ Ref: 'Sg1' }],
          },
        },
      },
      Subnet1: { Type: 'AWS::EC2::Subnet', Properties: {} },
      Sg1: { Type: 'AWS::EC2::SecurityGroup', Properties: {} },
    };

    const edges = extractLambdaVpcDeleteDeps(resources);
    const targets = edges.map((e) => e.after).sort();
    expect(targets).toEqual(['Sg1', 'Subnet1']);
    expect(edges.every((e) => e.before === 'Fn')).toBe(true);
  });

  it('skips refs to logical IDs that are not in the resource map', () => {
    const resources: Record<string, ResourceLike> = {
      Fn: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          VpcConfig: {
            SubnetIds: [{ Ref: 'MissingSubnet' }],
          },
        },
      },
    };
    expect(extractLambdaVpcDeleteDeps(resources)).toEqual([]);
  });

  it('skips pseudo parameters (Refs starting with AWS::)', () => {
    const resources: Record<string, ResourceLike> = {
      Fn: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          VpcConfig: {
            SubnetIds: [{ Ref: 'AWS::Region' }],
          },
        },
      },
    };
    expect(extractLambdaVpcDeleteDeps(resources)).toEqual([]);
  });

  it('skips resolved physical IDs (no Ref / Fn::GetAtt wrapper)', () => {
    // After deploy, VpcConfig.SubnetIds is a flat array of physical subnet
    // IDs. The extractor should produce zero edges in that case — the
    // caller is expected to fall back to state.dependencies.
    const resources: Record<string, ResourceLike> = {
      Fn: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          VpcConfig: {
            SubnetIds: ['subnet-0123456789abcdef0'],
            SecurityGroupIds: ['sg-0123456789abcdef0'],
          },
        },
      },
      SubnetA: { Type: 'AWS::EC2::Subnet', Properties: {} },
      SgA: { Type: 'AWS::EC2::SecurityGroup', Properties: {} },
    };
    expect(extractLambdaVpcDeleteDeps(resources)).toEqual([]);
  });

  it('de-duplicates repeated refs to the same target', () => {
    const resources: Record<string, ResourceLike> = {
      Fn: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          VpcConfig: {
            SubnetIds: [{ Ref: 'SubnetA' }, { Ref: 'SubnetA' }],
            SecurityGroupIds: [{ Ref: 'SubnetA' }],
          },
        },
      },
      SubnetA: { Type: 'AWS::EC2::Subnet', Properties: {} },
    };
    const edges = extractLambdaVpcDeleteDeps(resources);
    expect(edges).toEqual([{ before: 'Fn', after: 'SubnetA' }]);
  });

  it('filters self-edges (a Lambda referencing itself, defensive)', () => {
    const resources: Record<string, ResourceLike> = {
      Fn: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          VpcConfig: {
            SubnetIds: [{ Ref: 'Fn' }],
          },
        },
      },
    };
    expect(extractLambdaVpcDeleteDeps(resources)).toEqual([]);
  });

  it('handles multiple Lambdas independently', () => {
    const resources: Record<string, ResourceLike> = {
      FnA: {
        Type: 'AWS::Lambda::Function',
        Properties: { VpcConfig: { SubnetIds: [{ Ref: 'Subnet1' }] } },
      },
      FnB: {
        Type: 'AWS::Lambda::Function',
        Properties: { VpcConfig: { SubnetIds: [{ Ref: 'Subnet2' }] } },
      },
      Subnet1: { Type: 'AWS::EC2::Subnet', Properties: {} },
      Subnet2: { Type: 'AWS::EC2::Subnet', Properties: {} },
    };

    const edges = extractLambdaVpcDeleteDeps(resources);
    expect(edges).toContainEqual({ before: 'FnA', after: 'Subnet1' });
    expect(edges).toContainEqual({ before: 'FnB', after: 'Subnet2' });
    expect(edges).toHaveLength(2);
  });

  it('ignores non-array SubnetIds / SecurityGroupIds gracefully', () => {
    const resources: Record<string, ResourceLike> = {
      Fn: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          VpcConfig: {
            SubnetIds: { Ref: 'NotAList' },
            SecurityGroupIds: 'sg-bad',
          },
        },
      },
    };
    // The extractor walks any object value, so a single Ref object is still
    // collected — but only if the target exists. Here the target does not
    // exist as a logical ID, so we expect zero edges.
    expect(extractLambdaVpcDeleteDeps(resources)).toEqual([]);
  });
});
