/**
 * go-to-k/cdkd#6854: `policyDocumentMatchesDeclared`, the post-write capture's
 * "is this the declared policy" test, folds a bare account id to a root ARN
 * only within the caller's partition, and compares a `__proto__` condition
 * key instead of dropping it.
 */
import { describe, it, expect } from 'vite-plus/test';
import { policyDocumentMatchesDeclared } from '../../../src/provisioning/settle-after-own-write.js';

const ACCOUNT = '123456789012';
const doc = (principal: string, condition?: string): string =>
  JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { AWS: principal },
        Action: 's3:ListBucket',
        Resource: 'arn:aws:s3:::b',
        ...(condition !== undefined && { Condition: JSON.parse(condition) as unknown }),
      },
    ],
  });

describe('policyDocumentMatchesDeclared with a partition (#6854)', () => {
  it("equates a bare account id with that partition's root ARN", () => {
    expect(
      policyDocumentMatchesDeclared(doc(`arn:aws:iam::${ACCOUNT}:root`), doc(ACCOUNT), 'aws')
    ).toBe(true);
    expect(
      policyDocumentMatchesDeclared(
        doc(`arn:aws-cn:iam::${ACCOUNT}:root`),
        doc(ACCOUNT),
        'aws-cn'
      )
    ).toBe(true);
  });

  it("never equates it with another partition's root ARN", () => {
    expect(
      policyDocumentMatchesDeclared(doc(`arn:aws-cn:iam::${ACCOUNT}:root`), doc(ACCOUNT), 'aws')
    ).toBe(false);
    expect(
      policyDocumentMatchesDeclared(
        doc(`arn:aws-us-gov:iam::${ACCOUNT}:root`),
        doc(`arn:aws:iam::${ACCOUNT}:root`),
        'aws'
      )
    ).toBe(false);
  });

  it('never equates another account', () => {
    expect(
      policyDocumentMatchesDeclared(doc('arn:aws:iam::210987654321:root'), doc(ACCOUNT), 'aws')
    ).toBe(false);
  });
});

describe('policyDocumentMatchesDeclared and a __proto__ condition key (#6854)', () => {
  // JSON.parse keeps `__proto__` as an own key; the fold must too.
  it('compares a __proto__ condition key rather than dropping it', () => {
    const declared = doc(ACCOUNT, '{"StringEquals":{"__proto__":"a"}}');
    expect(
      policyDocumentMatchesDeclared(doc(ACCOUNT, '{"StringEquals":{"__proto__":"b"}}'), declared)
    ).toBe(false);
    expect(
      policyDocumentMatchesDeclared(doc(ACCOUNT, '{"StringEquals":{"__proto__":["a"]}}'), declared)
    ).toBe(true);
  });

  it('compares a __proto__ condition operator rather than dropping it', () => {
    const declared = doc(ACCOUNT, '{"__proto__":{"aws:SourceAccount":"1"}}');
    expect(
      policyDocumentMatchesDeclared(doc(ACCOUNT, '{"__proto__":{"aws:SourceAccount":"2"}}'), declared)
    ).toBe(false);
    expect(policyDocumentMatchesDeclared(doc(ACCOUNT), declared)).toBe(false);
  });
});
