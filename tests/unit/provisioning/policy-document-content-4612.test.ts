/**
 * go-to-k/cdkd#4612: the failed-create delete's content key folds
 * IAM-equivalent spellings (both directions), and its resolution failures
 * are permanent only when known to be.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  attemptedPolicyDocument,
  isPermanentResolutionError,
  policyContentKey,
} from '../../../src/provisioning/policy-document-content.js';
import { markNonRetryable } from '../../../src/deployment/retryable-errors.js';

const doc = (statement: Record<string, unknown>): Record<string, unknown> => ({
  Version: '2012-10-17',
  Statement: [statement],
});

describe('policyContentKey (go-to-k/cdkd#4612)', () => {
  it.each([
    ['a bare account id and its root ARN', { Principal: { AWS: '123456789012' } }, { Principal: { AWS: 'arn:aws:iam::123456789012:root' } }],
    ['another partition', { Principal: { AWS: '123456789012' } }, { Principal: { AWS: 'arn:aws-cn:iam::123456789012:root' } }],
    ['the id inside a list', { Principal: { AWS: ['123456789012', 'arn:aws:iam::111111111111:role/r'] } }, { Principal: { AWS: ['arn:aws:iam::123456789012:root', 'arn:aws:iam::111111111111:role/r'] } }],
    ['a one-element principal list', { Principal: { Service: ['sns.amazonaws.com'] } }, { Principal: { Service: 'sns.amazonaws.com' } }],
    ['a one-element Action list', { Action: ['sqs:SendMessage'] }, { Action: 'sqs:SendMessage' }],
    ['a one-element NotAction list', { NotAction: ['sqs:SendMessage'] }, { NotAction: 'sqs:SendMessage' }],
    ['a one-element Resource list', { Resource: ['arn:aws:sqs:us-east-1:1:q'] }, { Resource: 'arn:aws:sqs:us-east-1:1:q' }],
    ['a one-element NotResource list', { NotResource: ['arn:aws:sqs:us-east-1:1:q'] }, { NotResource: 'arn:aws:sqs:us-east-1:1:q' }],
    ['a one-element NotPrincipal list', { NotPrincipal: { AWS: ['123456789012'] } }, { NotPrincipal: { AWS: 'arn:aws:iam::123456789012:root' } }],
    ['a "*" principal and {AWS: "*"}', { Principal: '*' }, { Principal: { AWS: '*' } }],
    ['a "*" principal and {AWS: ["*"]}', { Principal: '*' }, { Principal: { AWS: ['*'] } }],
    ['a "*" NotPrincipal and {AWS: "*"}', { NotPrincipal: '*' }, { NotPrincipal: { AWS: '*' } }],
  ])('folds %s, both directions', (_what, a, b) => {
    expect(policyContentKey(doc(a))).toBe(policyContentKey(doc(b)));
    expect(policyContentKey(JSON.stringify(doc(b)))).toBe(policyContentKey(doc(a)));
  });

  it('folds a single Statement object with a one-element list', () => {
    expect(policyContentKey({ Statement: { Sid: 'A' } })).toBe(policyContentKey({ Statement: [{ Sid: 'A' }] }));
  });

  it.each([
    ['a different account', { Principal: { AWS: '123456789012' } }, { Principal: { AWS: 'arn:aws:iam::210987654321:root' } }],
    ['a role is not the root', { Principal: { AWS: '123456789012' } }, { Principal: { AWS: 'arn:aws:iam::123456789012:role/r' } }],
    ['list order is kept', { Action: ['a', 'b'] }, { Action: ['b', 'a'] }],
    ['two elements are not one', { Action: ['a', 'a'] }, { Action: 'a' }],
    ['an id outside Principal.AWS is not folded', { Resource: '123456789012' }, { Resource: 'arn:aws:iam::123456789012:root' }],
    ['a Service principal is not an account', { Principal: { Service: '123456789012' } }, { Principal: { Service: 'arn:aws:iam::123456789012:root' } }],
    ['"*" is not {Service: "*"}', { Principal: '*' }, { Principal: { Service: '*' } }],
    ['"*" is not {AWS: "*", Service: "x"}', { Principal: '*' }, { Principal: { AWS: '*', Service: 'x' } }],
    ['"*" is not an account', { Principal: '*' }, { Principal: { AWS: '123456789012' } }],
  ])('does NOT fold %s', (_what, a, b) => {
    expect(policyContentKey(doc(a))).not.toBe(policyContentKey(doc(b)));
  });

  it('keys unparseable text as itself', () => {
    expect(policyContentKey('not json')).toBe('raw:not json');
    expect(policyContentKey('not json')).not.toBe(policyContentKey('"not json"'));
  });
});

describe('isPermanentResolutionError (go-to-k/cdkd#4612)', () => {
  const err = (props: Record<string, unknown>): Error => Object.assign(new Error(String(props['message'] ?? 'x')), props);
  it.each([
    ['ResourceNotFoundException', err({ name: 'ResourceNotFoundException' }), true],
    ['ParameterNotFound', err({ name: 'ParameterNotFound' }), true],
    ['a resolver refusal', err({ message: "Dynamic reference: key 'k' not found in secret 's'" }), true],
    ['a token-scan refusal', err({ code: 'ROLLBACK_SECRET_TOKEN_SCAN_MISMATCH' }), true],
    ['an unmarked nested-child region refusal (fixable from the parent)', err({ code: 'ROLLBACK_SECRET_REGION_AMBIGUOUS' }), false],
    ['a marked region refusal (the journaled bag cannot change)', markNonRetryable(err({ code: 'ROLLBACK_SECRET_REGION_AMBIGUOUS' })), true],
    ['a marked cross-account secret refusal', markNonRetryable(err({ name: 'CrossAccountSecretRefusalError', code: 'INTRINSIC_RESOLUTION_REFUSAL_CROSS_ACCOUNT_SECRET' })), true],
    ['an UNMARKED resolver refusal', err({ name: 'IntrinsicResolutionRefusalError', code: 'INTRINSIC_RESOLUTION_REFUSAL' }), false],
    ['a marked ssm-secure on a String parameter refusal', markNonRetryable(err({ name: 'IntrinsicResolutionRefusalError', code: 'INTRINSIC_RESOLUTION_REFUSAL' })), true],
    ['a marked wrapper around an unmarked nested-child region refusal', markNonRetryable(err({ cause: err({ code: 'ROLLBACK_SECRET_REGION_AMBIGUOUS' }) })), false],
    ['a wrapped marked resolver refusal', err({ cause: markNonRetryable(err({ code: 'INTRINSIC_RESOLUTION_REFUSAL_MALFORMED_PRODUCER_RECORD' })) }), true],
    ['a region-less reference (unreachable from replay; not listed)', markNonRetryable(err({ name: 'DynamicReferenceRegionAmbiguousError', code: 'DYNAMIC_REFERENCE_REGION_AMBIGUOUS' })), false],
    ['a ValidationException (malformed id; not listed)', err({ name: 'ValidationException' }), false],
    ['a wrapped not-found', err({ cause: err({ name: 'ResourceNotFoundException' }) }), true],
    ['ExpiredTokenException', err({ name: 'ExpiredTokenException' }), false],
    ['AccessDeniedException', err({ name: 'AccessDeniedException' }), false],
    ['ThrottlingException', err({ name: 'ThrottlingException' }), false],
    ['a network error', err({ code: 'EADDRNOTAVAIL' }), false],
    ['a 503', err({ $metadata: { httpStatusCode: 503 } }), false],
    ['a TimeoutError', err({ name: 'TimeoutError' }), false],
    ['a wrapped ECONNRESET', err({ cause: { code: 'ECONNRESET' } }), false],
    ['a deeply wrapped not-found', err({ cause: err({ cause: err({ name: 'ParameterNotFound' }) }) }), true],
    ['another cdkd code', err({ code: 'SOMETHING_ELSE' }), false],
    ['a message merely containing the phrase', err({ message: 'x Dynamic reference: y' }), false],
  ])('%s → %s', (_what, error, expected) => {
    expect(isPermanentResolutionError(error)).toBe(expected);
  });
});

describe('attemptedPolicyDocument classifies each resolution failure (go-to-k/cdkd#4612)', () => {
  const failing = (error: unknown) => async (): Promise<unknown> => {
    throw error;
  };
  const e = (props: Record<string, unknown>): Error => Object.assign(new Error('m'), props);
  it.each([
    ['ResourceNotFoundException', e({ name: 'ResourceNotFoundException' })],
    ['ParameterNotFound', e({ name: 'ParameterNotFound' })],
    ['ParameterVersionNotFound', e({ name: 'ParameterVersionNotFound' })],
    ['a resolver refusal', new Error("Dynamic reference: SSM parameter 'p' not found or has no value")],
    ['a token-scan refusal', e({ name: 'CdkdError', code: 'ROLLBACK_SECRET_TOKEN_SCAN_MISMATCH' })],
    ['a wrapped token-scan refusal', e({ cause: e({ code: 'ROLLBACK_SECRET_TOKEN_SCAN_MISMATCH' }) })],
    ['a marked cross-account secret refusal', markNonRetryable(e({ code: 'INTRINSIC_RESOLUTION_REFUSAL_CROSS_ACCOUNT_SECRET' }))],
    ['a marked region refusal', markNonRetryable(e({ code: 'ROLLBACK_SECRET_REGION_AMBIGUOUS' }))],

  ])('%s is unusable (settles)', async (_what, error) => {
    expect(await attemptedPolicyDocument({ a: 1 }, failing(error))).toEqual({
      kind: 'unusable',
      why: 'a secret it references does not exist or cannot be used',
    });
  });

  it.each([
    ['a 503', e({ name: 'ServiceUnavailable', $metadata: { httpStatusCode: 503 } }), 'ServiceUnavailable'],
    ['a TimeoutError', e({ name: 'TimeoutError' }), 'TimeoutError'],
    ['a wrapped ECONNRESET', e({ name: 'Error', cause: { code: 'ECONNRESET' } }), 'Error'],
    ['ExpiredTokenException', e({ name: 'ExpiredTokenException' }), 'ExpiredTokenException'],
    ['AccessDeniedException', e({ name: 'AccessDeniedException' }), 'AccessDeniedException'],
    ['an unmarked nested-child region refusal', e({ name: 'CdkdError', code: 'ROLLBACK_SECRET_REGION_AMBIGUOUS' }), 'CdkdError'],
    ['an unmarked resolver refusal', e({ name: 'IntrinsicResolutionRefusalError', code: 'INTRINSIC_RESOLUTION_REFUSAL' }), 'IntrinsicResolutionRefusalError'],
    ['a name that is not a plain identifier', e({ name: 'bad name\nline' }), 'error'],
  ])('%s is retry (entry kept), naming only the error name', async (_what, error, name) => {
    expect(await attemptedPolicyDocument({ a: 1 }, failing(error))).toEqual({ kind: 'retry', errorName: name });
  });

  it('a resolved usable document is returned; without a resolver the recorded one is', async () => {
    expect(await attemptedPolicyDocument({ old: 1 }, async () => ({ new: 1 }))).toEqual({ kind: 'document', document: { new: 1 } });
    expect(await attemptedPolicyDocument({ old: 1 }, undefined)).toEqual({ kind: 'document', document: { old: 1 } });
  });
});
