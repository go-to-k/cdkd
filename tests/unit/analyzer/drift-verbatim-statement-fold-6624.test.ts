import { describe, it, expect } from 'vite-plus/test';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';
import {
  isVerbatimStatementPath,
  verbatimEchoDriftKeys,
} from '../../../src/analyzer/drift-verbatim-paths.js';

/**
 * go-to-k/cdkd#6624: the resource policies measured by the
 * `drift-verbatim-readback` integ fixture. Each service returns the submitted
 * document with no key of its own; S3, SQS, SNS, KMS, Secrets Manager and
 * IAM's role trust policy return a single-OBJECT `Statement` as a one-element
 * list, which the comparator reads as the same value. The readbacks below are
 * the measured ones (us-east-1), account id replaced.
 */

const ROOT = { AWS: 'arn:aws:iam::123456789012:root' };
const doc = (statement: unknown): Record<string, unknown> => ({
  Version: '2012-10-17',
  Statement: statement,
});
const S3_DENY = {
  Effect: 'Deny',
  Principal: ROOT,
  Action: 's3:PutObjectLegalHold',
  Resource: 'arn:aws:s3:::cdkd-dvr-123456789012-us-east-1/*',
};
const CONDITION = { Bool: { 'aws:SecureTransport': 'false' } };

describe('verbatimEchoDriftKeys (go-to-k/cdkd#6624)', () => {
  it.each([
    ['AWS::IAM::RolePolicy', 'PolicyDocument'],
    ['AWS::IAM::UserPolicy', 'PolicyDocument'],
    ['AWS::IAM::GroupPolicy', 'PolicyDocument'],
    ['AWS::S3::BucketPolicy', 'PolicyDocument'],
    ['AWS::SQS::QueuePolicy', 'PolicyDocument'],
    ['AWS::SNS::TopicPolicy', 'PolicyDocument'],
    ['AWS::KMS::Key', 'KeyPolicy'],
    ['AWS::SecretsManager::ResourcePolicy', 'ResourcePolicy'],
  ])('lists %s %s, measured to add no key', (type, key) => {
    expect(verbatimEchoDriftKeys(type)).toEqual([key]);
  });

  it('leaves out ECR, whose readback carries no RepositoryPolicyText', () => {
    expect(verbatimEchoDriftKeys('AWS::ECR::Repository')).toEqual([]);
  });
});

describe('isVerbatimStatementPath', () => {
  it('matches only `<key>.Statement` of a listed key', () => {
    expect(isVerbatimStatementPath('PolicyDocument.Statement', ['PolicyDocument'])).toBe(true);
    expect(isVerbatimStatementPath('PolicyDocument', ['PolicyDocument'])).toBe(false);
    expect(isVerbatimStatementPath('PolicyDocument.Statement.Condition', ['PolicyDocument'])).toBe(
      false
    );
    expect(isVerbatimStatementPath('Other.Statement', ['PolicyDocument'])).toBe(false);
    expect(isVerbatimStatementPath('PolicyDocument.Statement', [])).toBe(false);
  });
});

describe('calculateResourceDrift: a Statement object against its one-element list', () => {
  const paths = ['PolicyDocument'];

  it('is clean for the measured S3 readback of an object-form Statement', () => {
    expect(
      calculateResourceDrift(
        { Bucket: 'b', PolicyDocument: doc(S3_DENY) },
        { Bucket: 'b', PolicyDocument: doc([S3_DENY]) },
        { unionWalkPaths: paths }
      )
    ).toEqual([]);
  });

  it('is clean in the other direction too (list template, object readback)', () => {
    expect(
      calculateResourceDrift(
        { PolicyDocument: doc([S3_DENY]) },
        { PolicyDocument: doc(S3_DENY) },
        { unionWalkPaths: paths }
      )
    ).toEqual([]);
  });

  it('without the listed key the same pair is drift (the pre-fix phantom)', () => {
    const drift = calculateResourceDrift(
      { PolicyDocument: doc(S3_DENY) },
      { PolicyDocument: doc([S3_DENY]) }
    );
    expect(drift.map((d) => d.path)).toEqual(['PolicyDocument.Statement']);
  });

  it('reports a Condition added inside the live one-element list, with the original values', () => {
    const live = [{ ...S3_DENY, Condition: CONDITION }];
    const drift = calculateResourceDrift(
      { PolicyDocument: doc(S3_DENY) },
      { PolicyDocument: doc(live) },
      { unionWalkPaths: paths }
    );
    expect(drift).toEqual([
      { path: 'PolicyDocument.Statement', stateValue: S3_DENY, awsValue: live },
    ]);
  });

  it('reports a second statement added beside the object (no fold past one element)', () => {
    const allow = { Effect: 'Allow', Principal: ROOT, Action: 's3:GetObject', Resource: '*' };
    const drift = calculateResourceDrift(
      { PolicyDocument: doc(S3_DENY) },
      { PolicyDocument: doc([S3_DENY, allow]) },
      { unionWalkPaths: paths }
    );
    expect(drift.map((d) => d.path)).toEqual(['PolicyDocument.Statement']);
  });

  it('does not fold a Statement nested below the document', () => {
    const drift = calculateResourceDrift(
      { PolicyDocument: { Nested: { Statement: S3_DENY } } },
      { PolicyDocument: { Nested: { Statement: [S3_DENY] } } },
      { unionWalkPaths: paths }
    );
    expect(drift.map((d) => d.path)).toEqual(['PolicyDocument.Nested.Statement']);
  });

  it('reads the measured Secrets Manager readback (keys reordered, list) as clean', () => {
    const submitted = {
      Effect: 'Deny',
      Principal: ROOT,
      Action: 'secretsmanager:RestoreSecret',
      Resource: '*',
    };
    const measured = {
      Action: 'secretsmanager:RestoreSecret',
      Resource: '*',
      Effect: 'Deny',
      Principal: ROOT,
    };
    expect(
      calculateResourceDrift(
        { SecretId: 's', ResourcePolicy: doc(submitted) },
        { Id: 'arn', SecretId: 's', ResourcePolicy: doc([measured]) },
        { unionWalkPaths: verbatimEchoDriftKeys('AWS::SecretsManager::ResourcePolicy') }
      )
    ).toEqual([]);
  });

  it('reads the measured IAM role trust readback (list) as clean', () => {
    const trust = {
      Effect: 'Allow',
      Principal: { Service: 'lambda.amazonaws.com' },
      Action: 'sts:AssumeRole',
    };
    expect(
      calculateResourceDrift(
        { AssumeRolePolicyDocument: doc(trust) },
        { AssumeRolePolicyDocument: doc([trust]), Path: '/', MaxSessionDuration: 3600 },
        { unionWalkPaths: verbatimEchoDriftKeys('AWS::IAM::Role') }
      )
    ).toEqual([]);
  });
});
