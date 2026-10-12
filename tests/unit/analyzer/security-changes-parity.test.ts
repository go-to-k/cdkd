import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vite-plus/test';

// Colors change the AWS CDK CLI's row order (removals sort first), so each pair
// is compared both ways: chalk on (a terminal) and off (a CI log or a pipe).
vi.hoisted(() => {
  process.env['FORCE_COLOR'] = '1';
});
const cdkChalk = createRequire(require.resolve('@aws-cdk/cloudformation-diff'))('chalk') as {
  level: number;
};
import { fullDiff, formatSecurityChanges as cdkFormat } from '@aws-cdk/cloudformation-diff';
import { loadAwsServiceSpecSync } from '@aws-cdk/aws-service-spec';
import {
  formatSecurityChanges,
  PROPERTY_SCRUTINY,
  RESOURCE_SCRUTINY,
  SecurityChanges,
  stdoutSupportsColor,
  type SecurityTemplate,
} from '../../../src/analyzer/security-changes.js';

/**
 * cdkd's security classifier against the AWS CDK CLI's (`@aws-cdk/cloudformation-diff`,
 * a devDependency for this file alone): the same verdict and the same table
 * for every pair below.
 */

type Resources = SecurityTemplate['Resources'];

function cdk(oldResources: Resources, newResources: Resources, color = true) {
  cdkChalk.level = color ? 1 : 0;
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

function ours(oldResources: Resources, newResources: Resources, color = true) {
  const changes = new SecurityChanges(
    structuredClone({ Resources: oldResources }),
    structuredClone({ Resources: newResources })
  );
  return {
    broadened: changes.permissionsBroadened,
    any: changes.permissionsAnyChanges,
    // eslint-disable-next-line no-control-regex
    table: formatSecurityChanges(changes, { Role: '/Stack/MyRole/Resource' }, color).replace(/\u001b\[[0-9;]*m/g, ''),
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


const pol = (statements: unknown[], extra: Record<string, unknown> = {}) => ({
  Type: 'AWS::IAM::Policy',
  Properties: { PolicyName: 'p', Roles: ['r'], PolicyDocument: { Statement: statements }, ...extra },
});
const A = (action: unknown, extra: Record<string, unknown> = {}) => ({
  Effect: 'Allow',
  Action: action,
  Resource: '*',
  ...extra,
});

/** Branches the first list leaves unreached: one SSO type alone, `Groups`, `Sid`, ordering, edge intrinsics. */
const EDGE_CASES: Array<[string, Resources, Resources]> = [
  ['type change Role->User with Policies', { X: { Type: 'AWS::IAM::Role', Properties: { AssumeRolePolicyDocument: { Statement: [] }, Policies: [{ PolicyName: 'i', PolicyDocument: { Statement: [A('s3:*')] } }] } } }, { X: { Type: 'AWS::IAM::User', Properties: { Policies: [{ PolicyName: 'i', PolicyDocument: { Statement: [A('s3:*')] } }] } } }],
  ['type change scrutinized->unscrutinized', { X: pol([A('s3:*')]) }, { X: { Type: 'AWS::SQS::Queue', Properties: {} } }],
  ['SG desc change + string port', { SG: sg({ SecurityGroupIngress: [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '10.0.0.0/8' }] }) }, { SG: sg({ GroupDescription: 'h', SecurityGroupIngress: [{ IpProtocol: 'tcp', FromPort: '443', ToPort: '443', CidrIp: '10.0.0.0/8' }] }) }],
  ['Sid change', { P: pol([A('s3:GetObject', { Sid: 'a' })]) }, { P: pol([A('s3:GetObject', { Sid: 'b' })]) }],
  ['action reorder', { P: pol([A(['s3:GetObject', 's3:PutObject'])]) }, { P: pol([A(['s3:PutObject', 's3:GetObject'])]) }],
  ['logs resource policy (???)', {}, { L: { Type: 'AWS::Logs::ResourcePolicy', Properties: { PolicyName: 'n', PolicyDocument: { Statement: [{ Effect: 'Allow', Principal: { Service: 'es.amazonaws.com' }, Action: 'logs:PutLogEvents', Resource: '*' }] } } } }],
  ['lambda EventSourceToken+SourceAccount', {}, { P: { Type: 'AWS::Lambda::Permission', Properties: { Action: 'lambda:InvokeFunction', FunctionName: 'f', Principal: 'alexa-appkit.amazon.com', SourceAccount: '1', EventSourceToken: 't' } } }],
  ['lambda principal Ref', {}, { P: { Type: 'AWS::Lambda::Permission', Properties: { Action: 'lambda:InvokeFunction', FunctionName: 'f', Principal: { Ref: 'AWS::AccountId' } } } }],
  ['managed arns Fn::If', { R: { Type: 'AWS::IAM::Role', Properties: { AssumeRolePolicyDocument: {} } } }, { R: { Type: 'AWS::IAM::Role', Properties: { AssumeRolePolicyDocument: {}, ManagedPolicyArns: { 'Fn::If': ['C', ['arn:a'], { Ref: 'AWS::NoValue' }] } } } }],
  ['inline policy element Fn::If', { R: { Type: 'AWS::IAM::Role', Properties: { AssumeRolePolicyDocument: {} } } }, { R: { Type: 'AWS::IAM::Role', Properties: { AssumeRolePolicyDocument: {}, Policies: [{ 'Fn::If': ['C', { PolicyName: 'i', PolicyDocument: { Statement: [A('s3:*')] } }, { Ref: 'AWS::NoValue' }] }] } } }],
  ['SG rule element Fn::If', { SG: sg({}) }, { SG: sg({ SecurityGroupIngress: [{ 'Fn::If': ['C', { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIp: '0.0.0.0/0' }, { Ref: 'AWS::NoValue' }] }] }) }],
  ['SSO assignment only', {}, { A: { Type: 'AWS::SSO::Assignment', Properties: { InstanceArn: 'i', PermissionSetArn: 'p', PrincipalId: 'u', PrincipalType: 'USER', TargetId: '1', TargetType: 'AWS_ACCOUNT' } } }],
  ['SSO ACA only', {}, { A: { Type: 'AWS::SSO::InstanceAccessControlAttributeConfiguration', Properties: { InstanceArn: 'i', AccessControlAttributes: [{ Key: 'k', Value: { Source: ['a'] } }] } } }],
  ['SSO permset only (no inline)', {}, { A: { Type: 'AWS::SSO::PermissionSet', Properties: { InstanceArn: 'i', Name: 'n', PermissionsBoundary: { ManagedPolicyArn: 'arn:b' } } } }],
  ['SSO assignment removed', { A: { Type: 'AWS::SSO::Assignment', Properties: { InstanceArn: 'i', PermissionSetArn: 'p', PrincipalId: 'u', PrincipalType: 'USER', TargetId: '1', TargetType: 'AWS_ACCOUNT' } } }, {}],
  ['Effect intrinsic', {}, { P: pol([{ Effect: { Ref: 'E' }, Action: 's3:*', Resource: '*' }]) }],
  ['Groups', {}, { P: pol([A('s3:*')], { Roles: undefined, Groups: ['g'] }) }],
  ['Deny NotAction added', { P: pol([A('s3:*')]) }, { P: pol([A('s3:*'), { Effect: 'Deny', NotAction: 's3:Get*', Resource: '*' }]) }],
  ['NotPrincipal/NotResource', {}, { BP: { Type: 'AWS::S3::BucketPolicy', Properties: { Bucket: 'b', PolicyDocument: { Statement: [{ Effect: 'Allow', NotPrincipal: { AWS: ['arn:x', 'arn:y'] }, Action: 's3:*', NotResource: 'arn:z' }] } } } }],
  ['DependsOn only', { P: { ...pol([A('s3:*')]), DependsOn: ['a', 'b'] } }, { P: { ...pol([A('s3:*')]), DependsOn: ['b', 'c'] } }],
  ['GetAtt 3-part', {}, { P: pol([A('s3:*', { 'Fn::GetAtt': 'Db.Endpoint.Address' })]) }],
  ['Fn::Sub resource', {}, { P: pol([A('s3:*', { 'Fn::Sub': 'arn:${AWS::Partition}:s3:::b/*' })]) }],
  ['SG standalone no GroupId', {}, { I: { Type: 'AWS::EC2::SecurityGroupIngress', Properties: { GroupName: 'default', IpProtocol: 'tcp', FromPort: 1, ToPort: 1 } } }],
  ['SG rule moved between groups', { I: { Type: 'AWS::EC2::SecurityGroupIngress', Properties: { GroupId: 'sg-1', IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIp: '0.0.0.0/0' } } }, { I: { Type: 'AWS::EC2::SecurityGroupIngress', Properties: { GroupId: 'sg-2', IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIp: '0.0.0.0/0' } } }],
  ['In+Out same group', { SG: sg({}) }, { SG: sg({ SecurityGroupIngress: [{ IpProtocol: 'tcp', FromPort: 1, ToPort: 1, CidrIp: '1.1.1.1/32' }], SecurityGroupEgress: [{ IpProtocol: 'tcp', FromPort: 2, ToPort: 2, CidrIp: '2.2.2.2/32' }] }) }],
  ['bool vs string prop', { P: pol([A('s3:*', { Condition: { Bool: { 'aws:SecureTransport': true } } })]) }, { P: pol([A('s3:*', { Condition: { Bool: { 'aws:SecureTransport': 'true' } } })]) }],
  ['bool vs string prop + other change', { P: pol([A('s3:*', { Condition: { Bool: { 'aws:SecureTransport': true } } })]) }, { P: pol([A('s3:*', { Condition: { Bool: { 'aws:SecureTransport': 'true' } } })], { PolicyName: 'q' }) }],
  ['Join non-array', {}, { P: pol([A('s3:*', { 'Fn::Join': ['', { Ref: 'L' }] })]) }],
  ['Policies is intrinsic', { R: { Type: 'AWS::IAM::Role', Properties: { AssumeRolePolicyDocument: {} } } }, { R: { Type: 'AWS::IAM::Role', Properties: { AssumeRolePolicyDocument: {}, Policies: { 'Fn::If': ['C', [], []] } } } }],
  ['intrinsic statement removed', { P: pol([{ 'Fn::If': ['C', A('s3:*'), { Ref: 'AWS::NoValue' }] }]) }, { P: pol([]) }],
  ['no peer', {}, { I: { Type: 'AWS::EC2::SecurityGroupIngress', Properties: { GroupId: 'sg', IpProtocol: 'tcp', FromPort: 1, ToPort: 1 } } }],
  ['a removal and an addition on one resource', { P: policy([allow('s3:GetObject', 'arn:aws:s3:::a')]) }, { P: policy([allow('s3:PutObject', 'arn:aws:s3:::a')]) }],
  ['a removal and an addition on two resources', { P: policy([allow('s3:GetObject', 'arn:aws:s3:::b')]) }, { P: policy([allow('s3:PutObject', 'arn:aws:s3:::a')]) }],
  ['two ingress rules removed and one added', { SG: sg({ SecurityGroupIngress: [{ IpProtocol: 'tcp', FromPort: 1, ToPort: 1, CidrIp: '1.1.1.1/32' }, { IpProtocol: 'tcp', FromPort: 2, ToPort: 2, CidrIp: '2.2.2.2/32' }] }) }, { SG: sg({ SecurityGroupIngress: [{ IpProtocol: 'tcp', FromPort: 3, ToPort: 3, CidrIp: '3.3.3.3/32' }] }) }],
  ['a multi-line resource cell on both sides', { P: policy([allow('s3:GetObject', ['arn:aws:s3:::a', 'arn:aws:s3:::b'])]) }, { P: policy([allow('s3:PutObject', ['arn:aws:s3:::a', 'arn:aws:s3:::c'])]) }],
  ['an SNS topic with both policies', { T: { Type: 'AWS::SNS::Topic', Properties: {} } }, { T: { Type: 'AWS::SNS::Topic', Properties: { ArchivePolicy: { Statement: [{ Effect: 'Allow', Action: 'a:Z' }] }, DataProtectionPolicy: { Statement: [{ Effect: 'Allow', Action: 'a:A' }] } } } }],
  ['a wide-character condition value', {}, { P: policy([allow('s3:GetObject', '*', { Condition: { StringEquals: { 'aws:PrincipalTag/team': '\u958b\u767a\u30c1\u30fc\u30e0' } } })]) }],
  ['an emoji in a resource', {}, { P: policy([allow('s3:GetObject', 'arn:aws:s3:::🚀')]) }],
  ['an empty-string statement', {}, { P: policy(['']) }],
  ['a resource cell that is a line-prefix of another', {}, { P: policy([allow('s3:GetObject', ['arn:a', 'arn:b']), allow('s3:PutObject', 'arn:a')]) }],
  ['an emoji with a variation selector', {}, { P: policy([allow('x:Y', 'arn:aws:s3:::❤️')]) }],
  ['Hangul', {}, { P: policy([allow('x:Y', 'arn:aws:s3:::\ud55c\uad6d')]) }],
  ['a flag emoji', {}, { P: policy([allow('x:Y', 'r🇯🇵r')]) }],
  ['fullwidth Latin', {}, { P: policy([allow('x:Y', 'arn:aws:s3:::ＡＢＣ')]) }],
  ['text-presentation pictographs', {}, { P: policy([allow('x:Y', 'r©r™↔‼☺')]) }],
  ['emoji with a variation selector and a skin tone', {}, { P: policy([allow('x:Y', 'a☺️b🏻c👍🏽d')]) }],
  ['an added statement with no Resource beside a removal', { P: policy([allow('a:A', 'z')]) }, { P: policy([{ Effect: 'Allow', Action: 'x:Y' }]) }],
];

describe('security classifier parity with the AWS CDK CLI', () => {
  it.each([...CASES, ...EDGE_CASES])('%s', (_name, oldResources, newResources) => {
    expect(ours(oldResources, newResources)).toEqual(cdk(oldResources, newResources));
    expect(ours(oldResources, newResources, false)).toEqual(cdk(oldResources, newResources, false));
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
    // In order: the classifier reads a type's properties in this order.
    expect(Object.entries(PROPERTY_SCRUTINY).map(([t, p]) => [t, Object.entries(p)])).toEqual(
      Object.entries(properties)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([t, p]) => [t, Object.entries(p)])
    );
  });
});

describe('a statement that is neither an object nor a string', () => {
  it('throws, as the AWS CDK CLI does, without naming the value', () => {
    const resources = { P: policy([4242]) };
    expect(() => cdk({}, resources)).toThrow();
    let message = '';
    try {
      ours({}, resources);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('An IAM policy statement is neither an object nor a string');
    expect(message).not.toContain('4242');
  });
});

describe('the table colors', () => {
  it('shows an added row green, a removed row red, borders gray, the heading bold and the note yellow', () => {
    const changes = new SecurityChanges(
      { Resources: { P: policy([allow('s3:GetObject')]) } },
      { Resources: { P: policy([allow('s3:PutObject')]) } }
    );
    const table = formatSecurityChanges(changes, {}, true);
    expect(table).toContain('\u001b[32ms3:PutObject\u001b[0m');
    expect(table).toContain('\u001b[31ms3:GetObject\u001b[0m');
    expect(table).toContain('\u001b[90m│\u001b[0m');
    expect(table).toContain('\u001b[1mIAM Statement Changes\u001b[0m');
    expect(table).toContain('\u001b[33m(NOTE: There may be');
    // The header row is not colored.
    expect(table).toMatch(/│\u001b\[0m Resource +\u001b\[90m│/);
  });
});

describe('text the AWS CDK CLI cannot lay out', () => {
  // Its `table` drops a combining mark and a control character, and throws on a
  // ZWJ emoji; cdkd prints each as given, every line one width wide.
  it.each([
    ['a combining mark', 'café'],
    ['a control character', 'a\u0007b'],
    ['a ZWJ emoji', 'x👨‍👩‍👧y'],
  ])('%s keeps every line of the table one width', (_name, resource) => {
    const changes = new SecurityChanges(
      { Resources: {} },
      { Resources: { P: policy([allow('s3:GetObject', resource), allow('s3:PutObject', 'arn:a')]) } }
    );
    const lines = formatSecurityChanges(changes, {}, false)
      .split('\n')
      .filter((line) => /^[┌├│└]/.test(line));
    const widths = new Set(lines.map((line) => displayWidthForTest(line)));
    expect(lines.length).toBeGreaterThan(4);
    expect(widths.size).toBe(1);
    expect(lines.some((line) => line.includes(resource))).toBe(true);
  });
});

describe('stdoutSupportsColor (chalk 4 on stdout)', () => {
  it.each([
    ['a terminal', {}, [], true, true],
    ['a pipe', {}, [], false, false],
    ['a pipe with FORCE_COLOR=1', { FORCE_COLOR: '1' }, [], false, true],
    ['a terminal with FORCE_COLOR=0', { FORCE_COLOR: '0' }, [], true, false],
    ['a terminal with --no-color', {}, ['node', 'cdkd', '--no-color'], true, false],
    ['a pipe with --color', {}, ['node', 'cdkd', '--color'], false, true],
    ['a terminal on TERM=dumb', { TERM: 'dumb' }, [], true, false],
    ['a truecolor terminal on TERM=dumb', { TERM: 'dumb', COLORTERM: 'truecolor' }, [], true, false],
    ['a GitHub Actions terminal', { CI: 'true', GITHUB_ACTIONS: 'true' }, [], true, true],
    ['another CI terminal', { CI: 'true' }, [], true, false],
    ['a pipe in GitHub Actions', { CI: 'true', GITHUB_ACTIONS: 'true' }, [], false, false],
    ['a terminal with no TERM', {}, [], true, false],
  ] as Array<[string, Record<string, string>, string[], boolean, boolean]>)(
    '%s',
    (_name, env, argv, isTTY, expected) => {
      const term = _name === 'a terminal' ? { TERM: 'xterm-256color', ...env } : env;
      expect(stdoutSupportsColor(term, argv, isTTY, 'darwin')).toBe(expected);
    }
  );

  it('colors a plain terminal on Windows', () => {
    expect(stdoutSupportsColor({}, [], true, 'win32')).toBe(true);
  });

  it('matches supports-color 7 on the same inputs', () => {
    const term = { TERM: 'xterm-256color' };
    const cases: Array<[Record<string, string>, string[], boolean]> = [
      [term, [], true],
      [term, [], false],
      [{ TERM: 'dumb', FORCE_COLOR: '1' }, [], true],
      [{ TERM: 'dumb', COLORTERM: 'truecolor' }, [], true],
      [{ COLORTERM: 'truecolor' }, [], true],
      [{ TERM_PROGRAM: 'Apple_Terminal' }, [], true],
      [{ TERM_PROGRAM: 'iTerm.app' }, [], true],
      [{ CI: 'true', BUILDKITE: '1' }, [], true],
      [{ CI: 'true', GITLAB_CI: '1' }, [], true],
      [{ CI: 'true', CI_NAME: 'codeship' }, [], true],
      [{ CI: 'true', FORCE_COLOR: '1' }, [], true],
      [{ CI: 'true', ...term }, [], true],
      [{ TEAMCITY_VERSION: '9.1.0' }, [], true],
      [{ TEAMCITY_VERSION: '8.0.0' }, [], true],
      [{ FORCE_COLOR: 'true' }, [], false],
      [{ FORCE_COLOR: 'false', ...term }, [], true],
      [{ FORCE_COLOR: '' }, [], false],
      [{ FORCE_COLOR: 'x' }, [], false],
      [{ TERM: 'screen' }, [], true],
      [{ TERM: 'linux' }, [], true],
      [{ TERM: 'vt100' }, [], true],
      [{ TERM: 'rxvt' }, [], true],
      [{ TERM: 'cygwin' }, [], true],
      [{ TERM: 'ansi' }, [], true],
      [{ TERM: 'other-256' }, [], true],
      [{ TERM: 'unknown' }, [], true],
      [{ COLORTERM: '1' }, [], true],
      [{}, [], true],
      [term, ['--no-color'], true],
      [term, ['--no-colors'], true],
      [term, ['--color=false'], true],
      [term, ['--color=never'], true],
      [{}, ['--color'], false],
      [{}, ['--colors'], false],
      [{}, ['--color=true'], false],
      [{}, ['--color=always'], false],
      [{}, ['--', '--color'], false],
      [{}, ['--color=256'], false],
      [{}, ['--color=16m'], false],
      [{ FORCE_COLOR: '0' }, ['--color=256'], false],
    ];
    const require = createRequire(require_resolve_chalk());
    const savedArgv = process.argv;
    for (const [env, flags, isTTY] of cases) {
      const argv = ['node', 'cdkd', ...flags];
      const saved = { ...process.env };
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, env);
      process.argv = argv;
      const modulePath = require.resolve('supports-color');
      delete require.cache[modulePath];
      try {
        const { supportsColor } = require('supports-color') as {
          supportsColor: (stream: { isTTY: boolean }) => false | { level: number };
        };
        const level = supportsColor({ isTTY });
        const theirs = level !== false && level.level > 0;
        expect([env, flags, isTTY, stdoutSupportsColor(env, argv, isTTY, 'darwin')]).toEqual([
          env,
          flags,
          isTTY,
          theirs,
        ]);
      } finally {
        for (const key of Object.keys(process.env)) delete process.env[key];
        Object.assign(process.env, saved);
        process.argv = savedArgv;
        delete require.cache[modulePath];
      }
    }
  });
});

function require_resolve_chalk(): string {
  return createRequire(require.resolve('@aws-cdk/cloudformation-diff')).resolve('chalk');
}

/** Terminal columns, ANSI and zero-width characters aside, for the table-width cases. */
function displayWidthForTest(line: string): number {
  // eslint-disable-next-line no-control-regex
  const plain = line.replace(/\u001b\[[0-9;]*m/g, '');
  let width = 0;
  const segmenter = new Intl.Segmenter();
  for (const { segment } of segmenter.segment(plain)) {
    const code = segment.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
    width += /\p{Extended_Pictographic}/u.test(segment) ? 2 : 1;
  }
  return width;
}
