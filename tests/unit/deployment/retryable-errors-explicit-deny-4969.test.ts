import { describe, it, expect, vi } from 'vite-plus/test';
import {
  isIamPropagationError,
  isRetryableTransientError,
  markRedactedCause,
} from '../../../src/deployment/retryable-errors.js';
import {
  explicitDenyPolicyKind,
  isExplicitDenyError,
} from '../../../src/deployment/retryable-errors/transient.js';
import { withRetry } from '../../../src/deployment/retry.js';

// go-to-k/cdkd#4969: an explicit deny matched the `not authorized to perform`
// propagation pattern and was retried for the whole ~47.75s budget. The
// wordings are the IAM User Guide's ("Troubleshoot access denied error
// messages"), one per policy type it documents, plus S3's measured shape.

const USER = 'User: arn:aws:iam::123456789012:user/John is not authorized to perform:';

const EXPLICIT: Array<[string, string]> = [
  [
    'service control policy',
    `${USER} codecommit:ListRepositories with an explicit deny in a service control policy`,
  ],
  [
    'service control policy',
    `${USER} codecommit:ListRepositories with an explicit deny in a service control policy: arn:aws:organizations::777788889999:policy/o-x/service_control_policy/p-x`,
  ],
  [
    'resource control policy',
    `${USER} secretsmanager:GetSecretValue on resource: arn:aws:secretsmanager:us-east-1:123456789012:secret:* with an explicit deny in a resource control policy`,
  ],
  [
    'VPC endpoint policy',
    `${USER} codedeploy:ListDeployments on resource: x with an explicit deny in a VPC endpoint policy`,
  ],
  [
    'permissions boundary',
    `${USER} sagemaker:ListModels with an explicit deny in a permissions boundary`,
  ],
  [
    'session policy',
    `${USER} codedeploy:ListDeployments on resource: x with an explicit deny in a session policy`,
  ],
  [
    'resource-based policy',
    `${USER} s3:PutBucketTagging on resource: "arn:aws:s3:::b" with an explicit deny in a resource-based policy`,
  ],
  ['role trust policy', `${USER} sts:AssumeRole with an explicit deny in the role trust policy`],
  [
    'identity-based policy',
    `${USER} codedeploy:ListDeployments on resource: x with an explicit deny in an identity-based policy`,
  ],
];

const IMPLICIT = [
  `${USER} codecommit:ListRepositories because no service control policy allows the codecommit:ListRepositories action`,
  `${USER} s3:CreateBucket on resource: "arn:aws:s3:::b" because no identity-based policy allows the s3:CreateBucket action`,
  // The pre-2021 format carried no reason clause at all.
  `${USER} s3:CreateBucket on resource: arn:aws:s3:::b`,
];

describe('explicit deny is terminal (go-to-k/cdkd#4969)', () => {
  it.each(EXPLICIT)('%s: neither retryable nor propagation', (kind, message) => {
    expect(isExplicitDenyError(message)).toBe(true);
    expect(explicitDenyPolicyKind(message)).toBe(kind);
    expect(isRetryableTransientError(new Error(message), message)).toBe(false);
    expect(isIamPropagationError(message)).toBe(false);
  });

  it('the older sentence ending at "with an explicit deny" is terminal, with no kind named', () => {
    const message = `${USER} sts:AssumeRole on resource: x with an explicit deny`;
    expect(isExplicitDenyError(message)).toBe(true);
    expect(explicitDenyPolicyKind(message)).toBeUndefined();
    expect(isRetryableTransientError(new Error(message), message)).toBe(false);
  });

  it('an unknown policy type is still terminal, with no kind named', () => {
    const message = `${USER} x:Y with an explicit deny in a brand-new policy`;
    expect(isRetryableTransientError(new Error(message), message)).toBe(false);
    expect(explicitDenyPolicyKind(message)).toBeUndefined();
  });

  it.each(IMPLICIT)('an implicit deny keeps the propagation retry: %s', (message) => {
    expect(isExplicitDenyError(message)).toBe(false);
    expect(explicitDenyPolicyKind(message)).toBeUndefined();
    expect(isRetryableTransientError(new Error(message), message)).toBe(true);
    expect(isIamPropagationError(message)).toBe(true);
  });

  it('withRetry gives up on the first explicit deny, read off a redacted cause chain', async () => {
    const cause = new Error(EXPLICIT[0]![1]);
    const wrapped = markRedactedCause(
      new Error('Failed to create S3 bucket B: AccessDenied.', { cause })
    );
    const op = vi.fn().mockRejectedValue(wrapped);
    await expect(withRetry(op, 'B')).rejects.toBe(wrapped);
    expect(op).toHaveBeenCalledTimes(1);
  });
});
