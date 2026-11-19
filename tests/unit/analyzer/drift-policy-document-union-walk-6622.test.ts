import { describe, it, expect } from 'vite-plus/test';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';
import { verbatimEchoDriftKeys } from '../../../src/analyzer/drift-verbatim-paths.js';

/**
 * go-to-k/cdkd#6622: on the template-only `properties` baseline the comparator
 * walked only the template's keys inside an object, so a key added out of band
 * inside an IAM policy document's object-form `Statement` (a `Condition` that
 * narrows a `Deny`) read clean. `unionWalkPaths` union-walks the declared
 * verbatim-echo subtrees on that baseline too.
 */

const DENY = { Effect: 'Deny', Action: 's3:DeleteBucket', Resource: '*' };
const CONDITION = { StringEquals: { 'aws:PrincipalTag/team': 'ops' } };
const doc = (statement: unknown): Record<string, unknown> => ({
  Version: '2012-10-17',
  Statement: statement,
});

describe('verbatimEchoDriftKeys', () => {
  it('names the policy-document key of each IAM type that holds one at top level', () => {
    expect(verbatimEchoDriftKeys('AWS::IAM::Policy')).toEqual(['PolicyDocument']);
    expect(verbatimEchoDriftKeys('AWS::IAM::ManagedPolicy')).toEqual(['PolicyDocument']);
    expect(verbatimEchoDriftKeys('AWS::IAM::Role')).toEqual(['AssumeRolePolicyDocument']);
  });

  it('names nothing for a type whose readback is not measured verbatim', () => {
    for (const type of [
      'AWS::S3::BucketPolicy',
      'AWS::SQS::QueuePolicy',
      'AWS::SNS::TopicPolicy',
      'AWS::KMS::Key',
      'AWS::IAM::User',
      'AWS::IAM::Group',
      'AWS::Lambda::Function',
    ]) {
      expect(verbatimEchoDriftKeys(type)).toEqual([]);
    }
  });

  it('does not read an inherited Object.prototype member as a type', () => {
    expect(verbatimEchoDriftKeys('constructor')).toEqual([]);
    expect(verbatimEchoDriftKeys('__proto__')).toEqual([]);
  });
});

describe('calculateResourceDrift unionWalkPaths (go-to-k/cdkd#6622)', () => {
  const paths = ['PolicyDocument'];

  it('reports a Condition added to an object-form Statement on the template-only baseline', () => {
    const drift = calculateResourceDrift(
      { PolicyDocument: doc(DENY) },
      { PolicyDocument: doc({ ...DENY, Condition: CONDITION }) },
      { unionWalkPaths: paths }
    );
    expect(drift).toEqual([
      { path: 'PolicyDocument.Statement.Condition', stateValue: undefined, awsValue: CONDITION },
    ]);
  });

  it('without the path the same change reads clean (the pre-fix walk)', () => {
    expect(
      calculateResourceDrift(
        { PolicyDocument: doc(DENY) },
        { PolicyDocument: doc({ ...DENY, Condition: CONDITION }) }
      )
    ).toEqual([]);
  });

  it('reports a key added at the document root', () => {
    const drift = calculateResourceDrift(
      { PolicyDocument: doc(DENY) },
      { PolicyDocument: { ...doc(DENY), Id: 'added' } },
      { unionWalkPaths: paths }
    );
    expect(drift.map((d) => d.path)).toEqual(['PolicyDocument.Id']);
  });

  it('is clean when the live document is what was submitted', () => {
    expect(
      calculateResourceDrift(
        { PolicyDocument: doc(DENY) },
        { PolicyDocument: doc({ ...DENY }) },
        { unionWalkPaths: paths }
      )
    ).toEqual([]);
    expect(
      calculateResourceDrift(
        { PolicyDocument: doc([DENY, { Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }]) },
        {
          PolicyDocument: doc([DENY, { Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }]),
        },
        { unionWalkPaths: paths }
      )
    ).toEqual([]);
  });

  it('still reports a value change and a removed key', () => {
    const drift = calculateResourceDrift(
      { PolicyDocument: doc({ ...DENY, Condition: CONDITION }) },
      { PolicyDocument: doc({ ...DENY, Effect: 'Allow' }) },
      { unionWalkPaths: paths }
    );
    expect(drift.map((d) => d.path).sort()).toEqual([
      'PolicyDocument.Statement.Condition',
      'PolicyDocument.Statement.Effect',
    ]);
  });

  it('keeps a list-form Statement compared whole', () => {
    const drift = calculateResourceDrift(
      { PolicyDocument: doc([DENY]) },
      { PolicyDocument: doc([{ ...DENY, Condition: CONDITION }]) },
      { unionWalkPaths: paths }
    );
    expect(drift.map((d) => d.path)).toEqual(['PolicyDocument.Statement']);
  });

  it('does not union-walk outside the declared subtree', () => {
    // A sibling object keeps the state-keys-only walk: an AWS-side key there
    // is still not compared.
    expect(
      calculateResourceDrift(
        { PolicyDocument: doc(DENY), Other: { A: 1 } },
        { PolicyDocument: doc(DENY), Other: { A: 1, AwsDefault: true }, Arn: 'x' },
        { unionWalkPaths: paths }
      )
    ).toEqual([]);
    // A name sharing the prefix without the `.` boundary is not inside it.
    expect(
      calculateResourceDrift(
        { PolicyDocumentExtra: { A: 1 } },
        { PolicyDocumentExtra: { A: 1, B: 2 } },
        { unionWalkPaths: paths }
      )
    ).toEqual([]);
  });

  it('an ignored path inside the subtree stays ignored', () => {
    expect(
      calculateResourceDrift(
        { PolicyDocument: doc(DENY) },
        { PolicyDocument: doc({ ...DENY, Condition: CONDITION }) },
        { unionWalkPaths: paths, ignorePaths: ['PolicyDocument.Statement.Condition'] }
      )
    ).toEqual([]);
  });

  it('a `{{resolve:...}}` leaf inside the subtree is still skipped', () => {
    expect(
      calculateResourceDrift(
        { PolicyDocument: doc({ ...DENY, Resource: '{{resolve:ssm:/arn}}' }) },
        { PolicyDocument: doc({ ...DENY, Resource: 'arn:aws:s3:::b' }) },
        { unionWalkPaths: paths }
      )
    ).toEqual([]);
  });
});
