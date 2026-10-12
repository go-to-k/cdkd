import { describe, expect, it } from 'vite-plus/test';
import { fullDiff, formatSecurityChanges as cdkFormat } from '@aws-cdk/cloudformation-diff';
import { loadAwsServiceSpecSync } from '@aws-cdk/aws-service-spec';
import {
  formatSecurityChanges,
  PROPERTY_SCRUTINY,
  RESOURCE_SCRUTINY,
  SecurityChanges,
  type SecurityTemplate,
} from '../../../src/analyzer/security-changes.js';

/**
 * cdkd's security classifier against the AWS CDK CLI's (`@aws-cdk/cloudformation-diff`,
 * a devDependency for this file alone): the same verdict and the same table
 * for every pair below.
 */

type Resources = SecurityTemplate['Resources'];

function cdk(oldResources: Resources, newResources: Resources) {
  const diff = fullDiff(
    structuredClone({ Resources: oldResources }),
    structuredClone({ Resources: newResources })
  );
  let table = '';
  const stream = {
    write(chunk: unknown): boolean {
      table += String(chunk);
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  cdkFormat(stream, diff, { Role: '/Stack/MyRole/Resource' });
  return {
    broadened: diff.permissionsBroadened,
    any: diff.permissionsAnyChanges,
    // eslint-disable-next-line no-control-regex
    table: table.replace(/\u001b\[[0-9;]*m/g, ''),
  };
}

function ours(oldResources: Resources, newResources: Resources) {
  const changes = new SecurityChanges(
    structuredClone({ Resources: oldResources }),
    structuredClone({ Resources: newResources })
  );
  return {
    broadened: changes.permissionsBroadened,
    any: changes.permissionsAnyChanges,
    table: formatSecurityChanges(changes, { Role: '/Stack/MyRole/Resource' }),
  };
}

const policy = (statements: unknown[], extra: Record<string, unknown> = {}) => ({
  Type: 'AWS::IAM::Policy',
  Properties: {
    PolicyName: 'p',
    Roles: [{ Ref: 'Role' }],
    PolicyDocument: { Version: '2012-10-17', Statement: statements },
    ...extra,
  },
});
const allow = (action: unknown, resource: unknown = '*', extra: Record<string, unknown> = {}) => ({
  Effect: 'Allow',
  Action: action,
  Resource: resource,
  ...extra,
});
const role = (props: Record<string, unknown>) => ({
  Type: 'AWS::IAM::Role',
  Properties: {
    AssumeRolePolicyDocument: {
      Statement: [
        { Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' },
      ],
    },
    ...props,
  },
});
const sg = (props: Record<string, unknown>) => ({
  Type: 'AWS::EC2::SecurityGroup',
  Properties: { GroupDescription: 'g', ...props },
});

const CASES: Array<[string, Resources, Resources]> = [
  ['nothing changes', { P: policy([allow('s3:GetObject')]) }, { P: policy([allow('s3:GetObject')]) }],
  ['a statement added', { P: policy([allow('s3:GetObject')]) }, { P: policy([allow('s3:GetObject'), allow('s3:PutObject', { 'Fn::GetAtt': 'Bucket.Arn' })]) }],
  ['a statement removed', { P: policy([allow('s3:GetObject'), allow('s3:PutObject')]) }, { P: policy([allow('s3:GetObject')]) }],
  ['an action widened', { P: policy([allow(['s3:GetObject'])]) }, { P: policy([allow(['s3:GetObject', 's3:*'])]) }],
  ['a Deny removed', { P: policy([allow('s3:*'), { Effect: 'Deny', Action: 's3:DeleteObject', Resource: '*' }]) }, { P: policy([allow('s3:*')]) }],
  ['a Deny added', { P: policy([allow('s3:*')]) }, { P: policy([allow('s3:*'), { Effect: 'Deny', Action: 's3:DeleteObject', Resource: '*' }]) }],
  ['an Allow NotAction added', {}, { P: policy([{ Effect: 'Allow', NotAction: 'iam:*', Resource: '*' }]) }],
  ['a condition changed', { P: policy([allow('s3:GetObject', '*', { Condition: { StringEquals: { 'aws:PrincipalAccount': '111111111111' } } })]) }, { P: policy([allow('s3:GetObject', '*', { Condition: { StringEquals: { 'aws:PrincipalAccount': '222222222222' } } })]) }],
  ['a policy created', {}, { P: policy([allow('sqs:SendMessage', { 'Fn::Join': ['', ['arn:aws:sqs:', { Ref: 'AWS::Region' }, ':q']] })]) }],
  ['a policy deleted', { P: policy([allow('sqs:SendMessage')]) }, {}],
  ['a policy on two roles and a user', {}, { P: policy([allow('s3:GetObject')], { Roles: [{ Ref: 'Role' }, 'other'], Users: ['u'] }) }],
  ['a single statement object', {}, { P: { Type: 'AWS::IAM::Policy', Properties: { PolicyName: 'p', Roles: ['r'], PolicyDocument: { Statement: allow('s3:GetObject') } } } }],
  ['a statement that is an intrinsic', {}, { P: policy([{ 'Fn::If': ['C', allow('s3:GetObject'), { Ref: 'AWS::NoValue' }] }]) }],
  ['an AWS::NoValue statement dropped', { P: policy([allow('s3:GetObject')]) }, { P: policy([allow('s3:GetObject'), { Ref: 'AWS::NoValue' }]) }],
  ['a role inline policy added', { Role: role({}) }, { Role: role({ Policies: [{ PolicyName: 'i', PolicyDocument: { Statement: [allow('dynamodb:PutItem', { 'Fn::GetAtt': ['Table', 'Arn'] })] } }] }) }],
  ['a role managed policy attached', { Role: role({}) }, { Role: role({ ManagedPolicyArns: [{ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::aws:policy/AdministratorAccess']] }] }) }],
  ['a role managed policy detached', { Role: role({ ManagedPolicyArns: ['arn:aws:iam::aws:policy/ReadOnlyAccess'] }) }, { Role: role({}) }],
  ['a role trust policy widened', { Role: role({}) }, { Role: { Type: 'AWS::IAM::Role', Properties: { AssumeRolePolicyDocument: { Statement: [{ Effect: 'Allow', Principal: { AWS: '*' }, Action: 'sts:AssumeRole' }] } } } }],
  ['a role created', {}, { Role: role({ Policies: [{ PolicyName: 'i', PolicyDocument: { Statement: [allow('logs:*')] } }] }) }],
  ['a role deleted', { Role: role({ ManagedPolicyArns: ['arn:aws:iam::aws:policy/ReadOnlyAccess'] }) }, {}],
  ['a role property outside the security diff', { Role: role({ Description: 'a' }) }, { Role: role({ Description: 'b' }) }],
  ['a managed policy resource', {}, { M: { Type: 'AWS::IAM::ManagedPolicy', Properties: { Roles: [{ Ref: 'Role' }], PolicyDocument: { Statement: [allow('ec2:*')] } } } }],
  ['a lambda permission for a service', {}, { Perm: { Type: 'AWS::Lambda::Permission', Properties: { Action: 'lambda:InvokeFunction', FunctionName: { 'Fn::GetAtt': ['Fn', 'Arn'] }, Principal: 's3.amazonaws.com', SourceArn: { 'Fn::GetAtt': ['Bucket', 'Arn'] }, SourceAccount: { Ref: 'AWS::AccountId' } } } }],
  ['a lambda permission for an account', {}, { Perm: { Type: 'AWS::Lambda::Permission', Properties: { Action: 'lambda:InvokeFunction', FunctionName: 'fn', Principal: '123456789012' } } }],
  ['a lambda permission for everyone', {}, { Perm: { Type: 'AWS::Lambda::Permission', Properties: { Action: 'lambda:InvokeFunctionUrl', FunctionName: 'fn', Principal: '*', FunctionUrlAuthType: 'NONE' } } }],
  ['a lambda permission removed', { Perm: { Type: 'AWS::Lambda::Permission', Properties: { Action: 'lambda:InvokeFunction', FunctionName: 'fn', Principal: 'sns.amazonaws.com' } } }, {}],
  ['a bucket policy added', {}, { BP: { Type: 'AWS::S3::BucketPolicy', Properties: { Bucket: { Ref: 'Bucket' }, PolicyDocument: { Statement: [{ Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::123456789012:root' }, Action: 's3:GetObject', Resource: { 'Fn::Join': ['', [{ 'Fn::GetAtt': ['Bucket', 'Arn'] }, '/*']] } }] } } } }],
  ['a queue policy on two queues', {}, { QP: { Type: 'AWS::SQS::QueuePolicy', Properties: { Queues: [{ Ref: 'Q1' }, { Ref: 'Q2' }], PolicyDocument: { Statement: [{ Effect: 'Allow', Principal: { Service: 'sns.amazonaws.com' }, Action: 'sqs:SendMessage' }] } } } }],
  ['a KMS key policy', { K: { Type: 'AWS::KMS::Key', Properties: { KeyPolicy: { Statement: [{ Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::1:root' }, Action: 'kms:*', Resource: '*' }] } } } }, { K: { Type: 'AWS::KMS::Key', Properties: { KeyPolicy: { Statement: [{ Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::1:root' }, Action: 'kms:*', Resource: '*' }, { Effect: 'Allow', Principal: { Service: 'logs.amazonaws.com' }, Action: ['kms:Encrypt*', 'kms:Decrypt*'], Resource: '*' }] } } } }],
  ['an ingress rule added', { SG: sg({ SecurityGroupIngress: [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '10.0.0.0/8' }] }) }, { SG: sg({ SecurityGroupIngress: [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '10.0.0.0/8' }, { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIp: '0.0.0.0/0' }] }) }],
  ['an ingress rule removed', { SG: sg({ SecurityGroupIngress: [{ IpProtocol: '-1', CidrIpv6: '::/0' }] }) }, { SG: sg({}) }],
  ['an egress rule added', { SG: sg({}) }, { SG: sg({ SecurityGroupEgress: [{ IpProtocol: 'udp', FromPort: 1000, ToPort: 2000, DestinationPrefixListId: 'pl-1' }, { IpProtocol: 'icmp', FromPort: -1, ToPort: -1, DestinationSecurityGroupId: { 'Fn::GetAtt': ['Other', 'GroupId'] } }] }) }],
  ['a port written as a string', { SG: sg({ SecurityGroupIngress: [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '10.0.0.0/8' }] }) }, { SG: sg({ SecurityGroupIngress: [{ IpProtocol: 'tcp', FromPort: '443', ToPort: '443', CidrIp: '10.0.0.0/8' }] }) }],
  ['a standalone ingress rule', {}, { I: { Type: 'AWS::EC2::SecurityGroupIngress', Properties: { GroupId: { 'Fn::GetAtt': ['SG', 'GroupId'] }, IpProtocol: 'tcp', FromPort: 5432, ToPort: 5432, SourceSecurityGroupId: { Ref: 'Other' } } } }],
  ['a standalone egress rule removed', { E: { Type: 'AWS::EC2::SecurityGroupEgress', Properties: { GroupId: 'sg-1', IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: '0.0.0.0/0' } } }, {}],
  ['a type change', { X: { Type: 'AWS::SNS::TopicPolicy', Properties: { Topics: ['t'], PolicyDocument: { Statement: [allow('sns:Publish')] } } } }, { X: { Type: 'AWS::SQS::QueuePolicy', Properties: { Queues: ['q'], PolicyDocument: { Statement: [allow('sqs:SendMessage')] } } } }],
  ['an SSO permission set and assignment', {}, {
    PS: { Type: 'AWS::SSO::PermissionSet', Properties: { InstanceArn: 'arn:i', Name: 'ps', InlinePolicy: { Statement: [allow('s3:*')] }, ManagedPolicies: ['arn:aws:iam::aws:policy/ReadOnlyAccess'], PermissionsBoundary: { CustomerManagedPolicyReference: { Name: 'b', Path: '/' } }, CustomerManagedPolicyReferences: [{ Name: 'c' }] } },
    A: { Type: 'AWS::SSO::Assignment', Properties: { InstanceArn: 'arn:i', PermissionSetArn: { 'Fn::GetAtt': ['PS', 'PermissionSetArn'] }, PrincipalId: 'u', PrincipalType: 'USER', TargetId: '123456789012', TargetType: 'AWS_ACCOUNT' } },
    ACA: { Type: 'AWS::SSO::InstanceAccessControlAttributeConfiguration', Properties: { InstanceArn: 'arn:i', AccessControlAttributes: [{ Key: 'k', Value: { Source: ['a', 'b'] } }] } },
  }],
  ['an unknown type', {}, { U: { Type: 'Custom::Thing', Properties: { Policy: { Statement: [allow('*')] } } } }],
];

describe('security classifier parity with the AWS CDK CLI', () => {
  it.each(CASES)('%s', (_name, oldResources, newResources) => {
    expect(ours(oldResources, newResources)).toEqual(cdk(oldResources, newResources));
  });
});

describe('scrutiny tables', () => {
  it('match the service-spec database the AWS CDK CLI reads', () => {
    const db = loadAwsServiceSpecSync();
    const resources: Record<string, string> = {};
    const properties: Record<string, Record<string, string>> = {};
    for (const r of db.all('resource')) {
      if (r.scrutinizable && r.scrutinizable !== 'None') {
        resources[r.cloudFormationType] = r.scrutinizable;
      }
      for (const [name, p] of Object.entries(r.properties ?? {})) {
        if (p.scrutinizable && p.scrutinizable !== 'None') {
          (properties[r.cloudFormationType] ??= {})[name] = p.scrutinizable;
        }
      }
    }
    expect(RESOURCE_SCRUTINY).toEqual(resources);
    expect(PROPERTY_SCRUTINY).toEqual(properties);
  });
});
