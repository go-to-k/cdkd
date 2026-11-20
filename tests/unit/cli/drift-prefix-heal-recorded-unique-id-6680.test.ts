import { describe, it, expect } from 'vite-plus/test';
import { preFixBaselineUncomparedDriftKeys } from '../../../src/cli/commands/drift/baseline-keys.js';
import { holdsPrincipalUniqueId } from '../../../src/analyzer/drift-principal-normalize.js';

/**
 * go-to-k/cdkd#6680: a pre-fix-baseline heal skipped a policy key whenever the
 * live value was the declared one, whatever the baseline held, so a recorded
 * IAM unique-id principal (`AROA…`) that belongs to nobody was never compared.
 * Every rule of `preFixBaselineUncomparedDriftKeys` that skips a document key
 * now keeps it compared when the recorded value holds a unique-id principal
 * (the issue #1515 canonicalization decides it), and still skips it when the
 * recorded value is another document spelled with ARNs (the go-to-k/cdkd#6629
 * heal). Both polarities per rule.
 */

const ROLE_ARN = 'arn:aws:iam::123456789012:role/app-role';
// Built at runtime: a literal matches git-secrets' AWS key-id pattern.
const BOGUS = ['AROA', 'Z'.repeat(17)].join('');
const USER_ID = ['AIDA', 'XXXJN2LNV2SMSFATO'].join('');

const doc = (principal: string, action = 's3:GetObject') => ({
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Principal: { AWS: principal }, Action: action, Resource: '*' }],
});

type Case = {
  type: string;
  key: string;
  /** The member's value (template / live / recorded) for a principal and an action. */
  member: (principal: string, action?: string) => unknown;
};

const cases: Case[] = [
  { type: 'AWS::S3::BucketPolicy', key: 'PolicyDocument', member: doc },
  { type: 'AWS::SQS::QueuePolicy', key: 'PolicyDocument', member: doc },
  { type: 'AWS::SNS::TopicPolicy', key: 'PolicyDocument', member: doc },
  { type: 'AWS::KMS::Key', key: 'KeyPolicy', member: doc },
  { type: 'AWS::ApiGateway::RestApi', key: 'Policy', member: doc },
  { type: 'AWS::EFS::FileSystem', key: 'FileSystemPolicy', member: doc },
  { type: 'AWS::IAM::Role', key: 'AssumeRolePolicyDocument', member: doc },
  // A document carried as a JSON string.
  { type: 'AWS::Events::EventBus', key: 'Policy', member: (p, a) => JSON.stringify(doc(p, a)) },
  {
    type: 'AWS::Logs::DeliveryDestination',
    key: 'DeliveryDestinationPolicy',
    member: (p, a) => ({ DeliveryDestinationPolicy: doc(p, a) }),
  },
  {
    // A JSON string nested in an object.
    type: 'AWS::DynamoDB::Table',
    key: 'ResourcePolicy',
    member: (p, a) => ({ PolicyDocument: JSON.stringify(doc(p, a)) }),
  },
];

describe('preFixBaselineUncomparedDriftKeys: a recorded unique-id principal (go-to-k/cdkd#6680)', () => {
  describe.each(cases)('$type $key', ({ type, key, member }) => {
    const declared = { [key]: member(ROLE_ARN) };
    const live = { [key]: member(ROLE_ARN) };

    it('recorded with a unique-id principal, live the declared value: compared', () => {
      expect(preFixBaselineUncomparedDriftKeys(type, { [key]: member(BOGUS) }, declared, live)).toEqual(
        []
      );
    });

    it('recorded as another document spelled with ARNs, live the declared value: skipped', () => {
      expect(
        preFixBaselineUncomparedDriftKeys(type, { [key]: member(ROLE_ARN, 's3:*') }, declared, live)
      ).toEqual([key]);
    });
  });

  it('an AWS::Lambda::Permission recorded with a unique-id Principal keeps only Principal compared', () => {
    const declared = { Action: 'lambda:InvokeFunction', Principal: ROLE_ARN, FunctionName: 'fn' };
    const live = { Action: 'lambda:InvokeFunction', Principal: ROLE_ARN };
    const keys = preFixBaselineUncomparedDriftKeys(
      'AWS::Lambda::Permission',
      { Action: 'lambda:InvokeFunctionUrl', Principal: BOGUS },
      declared,
      live
    );
    expect(keys).toContain('Action');
    expect(keys).not.toContain('Principal');
  });

  it('another member of the same resource still heals on its own', () => {
    const declared = { AssumeRolePolicyDocument: doc(ROLE_ARN), ManagedPolicyArns: [ROLE_ARN] };
    expect(
      preFixBaselineUncomparedDriftKeys(
        'AWS::IAM::Role',
        { AssumeRolePolicyDocument: doc(USER_ID), ManagedPolicyArns: [] },
        declared,
        { AssumeRolePolicyDocument: doc(ROLE_ARN), ManagedPolicyArns: [ROLE_ARN] }
      )
    ).toEqual(['ManagedPolicyArns']);
  });
});

describe('holdsPrincipalUniqueId', () => {
  it.each([
    ['an object document', doc(BOGUS)],
    ['a user id in a NotPrincipal array', { Statement: [{ NotPrincipal: { AWS: [ROLE_ARN, USER_ID] } }] }],
    ['a JSON-string document', JSON.stringify(doc(BOGUS))],
    ['a JSON string nested in an object', { PolicyDocument: JSON.stringify(doc(BOGUS)) }],
    ['a JSON string nested in an array', [JSON.stringify(doc(BOGUS))]],
    ['a top-level Principal string', { Principal: BOGUS }],
  ])('%s: true', (_label, value) => {
    expect(holdsPrincipalUniqueId(value)).toBe(true);
  });

  it.each([
    ['ARN principals only', doc(ROLE_ARN)],
    ['a unique id outside a principal position', { Statement: [{ Condition: { StringEquals: { 'aws:userid': BOGUS } } }] }],
    ['a bare unique-id string with no Principal key', BOGUS],
    ['a string that is not JSON', '{not json'],
    ['undefined', undefined],
  ])('%s: false', (_label, value) => {
    expect(holdsPrincipalUniqueId(value)).toBe(false);
  });
});
