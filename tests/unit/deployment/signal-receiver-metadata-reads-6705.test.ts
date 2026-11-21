import { describe, expect, it } from 'vite-plus/test';
import { bootstrapCallsOf, signalPlanOf } from '../../../src/deployment/deploy-engine/signal-receiver.js';
import { getAttReadsOf } from '../../../src/deployment/deploy-engine/signal-receiver-run.js';

describe('getAttReadsOf (go-to-k/cdkd#6705 receiver metadata refusal)', () => {
  it('finds GetAtt reads in both spellings and in Fn::Sub, at any depth', () => {
    const metadata = {
      'AWS::CloudFormation::Authentication': {
        S3Auth: {
          accessKeyId: { Ref: 'Key' },
          secretKey: { 'Fn::GetAtt': ['Key', 'SecretAccessKey'] },
        },
      },
      'AWS::CloudFormation::Init': {
        config: {
          files: {
            '/a': { content: { 'Fn::Sub': 'x=${Client.ClientSecret} y=${AWS::Region} z=${Plain}' } },
            '/b': { content: { 'Fn::Sub': ['${Api.ApiKey}', {}] } },
            '/c': { content: { 'Fn::GetAtt': 'Bucket.Arn' } },
          },
        },
      },
    };
    expect(getAttReadsOf(metadata)).toEqual([
      ['Key', 'SecretAccessKey'],
      ['Client', 'ClientSecret'],
      ['Api', 'ApiKey'],
      ['Bucket', 'Arn'],
    ]);
  });

  it('finds nothing in literal metadata', () => {
    expect(getAttReadsOf({ a: ['x', { b: 'Fn::GetAtt' }] })).toEqual([]);
  });
});


/** CDK's `applyCloudFormationInit` user data, as `cdk synth` writes it. */
function cdkUserData(logicalId: string, includeRole: boolean): unknown {
  const role = includeRole ? [' --role ', { Ref: 'InstanceRole' }] : [];
  return {
    'Fn::Base64': {
      'Fn::Join': [
        '',
        [
          '#!/bin/bash\n# fingerprint: f7496e39736dd724\n(\n  set +e\n  /opt/aws/bin/cfn-init -v --region ',
          { Ref: 'AWS::Region' },
          ' --stack ',
          { Ref: 'AWS::StackName' },
          ` --resource ${logicalId}`,
          ...role,
          ' -c default\n  /opt/aws/bin/cfn-signal -e $? --region ',
          { Ref: 'AWS::Region' },
          ' --stack ',
          { Ref: 'AWS::StackName' },
          ` --resource ${logicalId}`,
          ...role,
          '\n  cat /var/log/cfn-init.log >&2\n)',
        ],
      ],
    },
  };
}

const instance = (logicalId: string, includeRole: boolean) => ({
  Type: 'AWS::EC2::Instance',
  CreationPolicy: { ResourceSignal: { Count: 1, Timeout: 'PT10M' } },
  Metadata: { 'AWS::CloudFormation::Init': { config: {} } },
  Properties: { UserData: cdkUserData(logicalId, includeRole) },
});

describe('bootstrapCallsOf / signalPlanOf (go-to-k/cdkd#6705)', () => {
  it('reads CDK includeRole: true as signed and the default as unsigned', () => {
    const resources = { Signed: instance('Signed', true), Unsigned: instance('Unsigned', false) };
    expect(bootstrapCallsOf(resources, 'Signed')).toBe('signed');
    expect(bootstrapCallsOf(resources, 'Unsigned')).toBe('unsigned');
    const plan = signalPlanOf({ Resources: resources } as never);
    expect([...plan.candidates.keys()]).toEqual(['Signed']);
    expect(plan.unsigned).toEqual(['Unsigned']);
  });

  it('one unsigned call makes the resource unsigned', () => {
    const userData = { 'Fn::Join': ['', ['cfn-init --role r -c default\ncfn-signal -e 0 --resource X\n']] };
    expect(bootstrapCallsOf({ X: { Properties: { UserData: userData } } }, 'X')).toBe('unsigned');
  });

  it('follows a launch template, decodes a literal base64 body, and answers none without cfn-*', () => {
    const resources = {
      Lt: {
        Type: 'AWS::EC2::LaunchTemplate',
        Properties: {
          LaunchTemplateData: {
            UserData: Buffer.from('#!/bin/bash\ncfn-signal --access-key K --secret-key S -e 0\n').toString('base64'),
          },
        },
      },
      Group: { Properties: { LaunchTemplate: { LaunchTemplateId: { Ref: 'Lt' } } } },
      Plain: { Properties: { UserData: { 'Fn::Base64': 'aws cloudformation signal-resource ...' } } },
      Wait: { Type: 'AWS::CloudFormation::WaitCondition', CreationPolicy: { ResourceSignal: {} } },
    };
    expect(bootstrapCallsOf(resources, 'Group')).toBe('signed');
    expect(bootstrapCallsOf(resources, 'Plain')).toBe('none');
    expect(bootstrapCallsOf(resources, 'Wait')).toBe('none');
  });

  it('serves cfn-init metadata alone only when a signed cfn-init reads it', () => {
    const metadataOnly = (includeRole: boolean) => ({
      ...instance('M', includeRole),
      CreationPolicy: undefined,
    });
    expect(signalPlanOf({ Resources: { M: metadataOnly(true) } } as never).candidates.has('M')).toBe(true);
    expect(signalPlanOf({ Resources: { M: metadataOnly(false) } } as never).candidates.has('M')).toBe(false);
    expect(
      signalPlanOf({ Resources: { M: { Metadata: { 'AWS::CloudFormation::Init': {} } } } } as never).candidates.size
    ).toBe(0);
  });
});
