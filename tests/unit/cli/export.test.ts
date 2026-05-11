import { describe, it, expect } from 'vitest';
import {
  filterTemplateForImport,
  isNeverImportableType,
  refuseTransientContextIfUnsafe,
} from '../../../src/cli/commands/export.js';

describe('refuseTransientContextIfUnsafe', () => {
  it('passes through when no context overrides are supplied', () => {
    expect(() =>
      refuseTransientContextIfUnsafe({ acceptTransientContext: false })
    ).not.toThrow();
    expect(() =>
      refuseTransientContextIfUnsafe({ context: [], acceptTransientContext: false })
    ).not.toThrow();
  });

  it('refuses when CLI -c overrides are supplied without the escape hatch', () => {
    expect(() =>
      refuseTransientContextIfUnsafe({
        context: ['env=prod'],
        acceptTransientContext: false,
      })
    ).toThrow(/Refusing to export/);
  });

  it('includes every override in the refusal message', () => {
    let thrown: Error | undefined;
    try {
      refuseTransientContextIfUnsafe({
        context: ['env=prod', 'region=us-east-1'],
        acceptTransientContext: false,
      });
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toContain('-c env=prod');
    expect(thrown!.message).toContain('-c region=us-east-1');
  });

  it('proceeds with --accept-transient-context (does not throw)', () => {
    expect(() =>
      refuseTransientContextIfUnsafe({
        context: ['env=prod'],
        acceptTransientContext: true,
      })
    ).not.toThrow();
  });
});

describe('isNeverImportableType', () => {
  it('flags AWS::CDK::Metadata', () => {
    expect(isNeverImportableType('AWS::CDK::Metadata')).toBe(true);
  });

  it('flags nested stacks', () => {
    expect(isNeverImportableType('AWS::CloudFormation::Stack')).toBe(true);
  });

  it('flags every Custom::* type', () => {
    expect(isNeverImportableType('Custom::MyHandler')).toBe(true);
    expect(isNeverImportableType('Custom::SomethingElse')).toBe(true);
  });

  it('does NOT flag common importable types', () => {
    expect(isNeverImportableType('AWS::S3::Bucket')).toBe(false);
    expect(isNeverImportableType('AWS::IAM::Role')).toBe(false);
    expect(isNeverImportableType('AWS::Lambda::Function')).toBe(false);
    expect(isNeverImportableType('AWS::DynamoDB::Table')).toBe(false);
  });
});

describe('filterTemplateForImport', () => {
  it('keeps only resources in the plan', () => {
    const template = {
      AWSTemplateFormatVersion: '2010-09-09',
      Resources: {
        KeepMe: { Type: 'AWS::S3::Bucket', Properties: {} },
        DropMe: { Type: 'AWS::CDK::Metadata', Properties: {} },
      },
    };
    const result = filterTemplateForImport(template, [
      { logicalId: 'KeepMe', resourceType: 'AWS::S3::Bucket', physicalId: 'b', identifierKey: 'BucketName' },
    ]);
    expect(result['Resources']).toEqual({
      KeepMe: { Type: 'AWS::S3::Bucket', Properties: {} },
    });
  });

  it('preserves top-level keys other than Resources/Outputs', () => {
    const template = {
      AWSTemplateFormatVersion: '2010-09-09',
      Description: 'test',
      Parameters: { P: { Type: 'String' } },
      Resources: {
        A: { Type: 'AWS::S3::Bucket' },
      },
    };
    const result = filterTemplateForImport(template, [
      { logicalId: 'A', resourceType: 'AWS::S3::Bucket', physicalId: 'b', identifierKey: 'BucketName' },
    ]);
    expect(result['AWSTemplateFormatVersion']).toBe('2010-09-09');
    expect(result['Description']).toBe('test');
    expect(result['Parameters']).toEqual({ P: { Type: 'String' } });
  });

  it('drops Outputs that Ref-reference excluded resources', () => {
    const template = {
      Resources: {
        Keep: { Type: 'AWS::S3::Bucket' },
        Drop: { Type: 'Custom::Foo' },
      },
      Outputs: {
        KeepOut: { Value: { Ref: 'Keep' } },
        DropOut: { Value: { Ref: 'Drop' } },
      },
    };
    const result = filterTemplateForImport(template, [
      { logicalId: 'Keep', resourceType: 'AWS::S3::Bucket', physicalId: 'b', identifierKey: 'BucketName' },
    ]);
    expect(result['Outputs']).toEqual({ KeepOut: { Value: { Ref: 'Keep' } } });
  });

  it('drops Outputs that Fn::GetAtt-reference excluded resources', () => {
    const template = {
      Resources: {
        Keep: { Type: 'AWS::S3::Bucket' },
        Drop: { Type: 'Custom::Foo' },
      },
      Outputs: {
        KeepOut: { Value: { 'Fn::GetAtt': ['Keep', 'Arn'] } },
        DropOut: { Value: { 'Fn::GetAtt': ['Drop', 'Arn'] } },
      },
    };
    const result = filterTemplateForImport(template, [
      { logicalId: 'Keep', resourceType: 'AWS::S3::Bucket', physicalId: 'b', identifierKey: 'BucketName' },
    ]);
    expect(result['Outputs']).toEqual({
      KeepOut: { Value: { 'Fn::GetAtt': ['Keep', 'Arn'] } },
    });
  });

  it('handles the string form of Fn::GetAtt ("Logical.Attr")', () => {
    const template = {
      Resources: {
        Keep: { Type: 'AWS::S3::Bucket' },
      },
      Outputs: {
        DropOut: { Value: { 'Fn::GetAtt': 'Excluded.Arn' } },
      },
    };
    const result = filterTemplateForImport(template, [
      { logicalId: 'Keep', resourceType: 'AWS::S3::Bucket', physicalId: 'b', identifierKey: 'BucketName' },
    ]);
    expect(result['Outputs']).toBeUndefined();
  });

  it('drops the Outputs key entirely when all outputs are filtered out', () => {
    const template = {
      Resources: { Keep: { Type: 'AWS::S3::Bucket' } },
      Outputs: { DropOut: { Value: { Ref: 'Excluded' } } },
    };
    const result = filterTemplateForImport(template, [
      { logicalId: 'Keep', resourceType: 'AWS::S3::Bucket', physicalId: 'b', identifierKey: 'BucketName' },
    ]);
    expect('Outputs' in result).toBe(false);
  });

  it('handles nested intrinsics inside Outputs', () => {
    const template = {
      Resources: {
        Keep: { Type: 'AWS::S3::Bucket' },
      },
      Outputs: {
        DropOut: {
          Value: { 'Fn::Join': ['', ['prefix-', { Ref: 'Excluded' }]] },
        },
        KeepOut: {
          Value: { 'Fn::Join': ['', ['prefix-', { Ref: 'Keep' }]] },
        },
      },
    };
    const result = filterTemplateForImport(template, [
      { logicalId: 'Keep', resourceType: 'AWS::S3::Bucket', physicalId: 'b', identifierKey: 'BucketName' },
    ]);
    expect(result['Outputs']).toEqual({
      KeepOut: { Value: { 'Fn::Join': ['', ['prefix-', { Ref: 'Keep' }]] } },
    });
  });
});
