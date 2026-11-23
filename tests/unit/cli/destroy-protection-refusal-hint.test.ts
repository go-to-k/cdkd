import { describe, expect, it } from 'vite-plus/test';
import {
  isProtectionRefusal,
  protectionRefusalHint,
} from '../../../src/cli/commands/destroy-runner/protection-refusal-hint.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { CloudControlOperationFailedError } from '../../../src/provisioning/cloud-control/shared.js';

/** An SDK service error: `$metadata.httpStatusCode` is what marks AWS-authored text. */
function awsError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  (error as Error & { $metadata: unknown }).$metadata = { httpStatusCode: 400 };
  return error;
}

/** The shape a provider throws: cdkd's wrapper around the SDK error, as `cause`. */
function wrapped(resourceType: string, logicalId: string, cause: Error): ProvisioningError {
  return new ProvisioningError(
    `Failed to delete ${logicalId}: ${cause.name}. Re-run with --verbose for AWS's own message.`,
    resourceType,
    logicalId,
    'phys',
    cause
  );
}

// AWS's own texts, as measured on real AWS (issue #6855's hunt and the
// `remove-protection` integ).
const COGNITO = awsError(
  'InvalidParameterException',
  'The user pool cannot be deleted because deletion protection is activated. Deletion protection must be inactivated first.'
);
const ALB = awsError(
  'OperationNotPermittedException',
  "Load balancer 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/x/y' cannot be deleted because deletion protection is enabled"
);
const EC2 = awsError(
  'OperationNotPermitted',
  "The instance 'i-0123456789abcdef0' may not be terminated. Modify its 'disableApiTermination' instance attribute and try again."
);
const DDB = awsError(
  'ResourceInUseException',
  'Resource cannot be deleted as it is currently protected against deletion. Disable deletion protection first.'
);
// Measured: DeleteLogGroup on a protected log group.
const LOG_GROUP = awsError(
  'InvalidParameterException',
  'LogGroup has delete protection enabled. Disable delete protection before attempting to delete the resource.'
);
// EMR's TerminateJobFlows refusal (a ValidationException, per the provider).
const EMR = awsError(
  'ValidationException',
  'Could not shut down one or more job flows since they are termination protected.'
);
// A reason code spelled with underscores.
const UNDERSCORED = awsError('ConflictException', 'DELETION_PROTECTION_ENABLED');

describe('protectionRefusalHint (issue #6855)', () => {
  it.each([
    ['AWS::Cognito::UserPool', COGNITO],
    ['AWS::ElasticLoadBalancingV2::LoadBalancer', ALB],
    ['AWS::EC2::Instance', EC2],
    ['AWS::DynamoDB::Table', DDB],
    ['AWS::Logs::LogGroup', LOG_GROUP],
    ['AWS::EMR::Cluster', EMR],
    ['AWS::SMSVOICE::ProtectConfiguration', UNDERSCORED],
  ])('names the protection and --remove-protection for a refused %s delete', (type, cause) => {
    const hint = protectionRefusalHint(wrapped(type, 'R', cause), type, undefined);
    expect(hint).toContain('deletion protection is on');
    expect(hint).toContain('--remove-protection');
  });

  it('is silent when --remove-protection was already passed', () => {
    const type = 'AWS::Cognito::UserPool';
    expect(protectionRefusalHint(wrapped(type, 'R', COGNITO), type, true)).toBeUndefined();
  });

  it('is silent for a type the flag does not cover', () => {
    const type = 'AWS::S3::Bucket';
    expect(protectionRefusalHint(wrapped(type, 'R', COGNITO), type, undefined)).toBeUndefined();
  });

  it('is silent for a failure of a covered type that is not a protection refusal', () => {
    const type = 'AWS::ElasticLoadBalancingV2::LoadBalancer';
    const other = awsError('ResourceInUseException', 'Load balancer is currently in use by a listener');
    expect(protectionRefusalHint(wrapped(type, 'R', other), type, undefined)).toBeUndefined();
  });

  it('reads a Cloud Control handler failure, whose message carries the StatusMessage', () => {
    const type = 'AWS::DSQL::Cluster';
    const cc = new CloudControlOperationFailedError(
      'DELETE R failed: Cluster cannot be deleted while deletion protection is enabled',
      type,
      'R',
      'phys',
      'InvalidRequest',
      'DELETE'
    );
    expect(protectionRefusalHint(cc, type, undefined)).toContain('--remove-protection');
  });
});

describe('isProtectionRefusal (issue #6855)', () => {
  it('never reads cdkd-authored text, which can echo a template value', () => {
    // The logical id spells the phrase, but no AWS-written link does.
    const notProtection = awsError('ValidationException', 'Something else went wrong');
    const error = new ProvisioningError(
      'Failed to delete My deletion protection test pool',
      'AWS::Cognito::UserPool',
      'My deletion protection test pool',
      'phys',
      notProtection
    );
    expect(isProtectionRefusal(error)).toBe(false);
  });

  it('needs the separator, so a joined identifier echoed by AWS does not match', () => {
    expect(isProtectionRefusal(awsError('ValidationException', 'Table DeletionProtectionTable failed'))).toBe(false);
  });

  it('ignores the resource name AWS echoes back, in the physical id or an ARN', () => {
    const table = awsError(
      'ResourceInUseException',
      'Table is being updated: deletion-protection-demo'
    );
    expect(isProtectionRefusal(table, 'deletion-protection-demo')).toBe(false);
    const alb = awsError(
      'ResourceInUseException',
      "Load balancer 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/deletion-protection-alb/abc' is in use"
    );
    expect(isProtectionRefusal(alb)).toBe(false);
    // The ARN is removed, the refusal phrase around it is still read.
    expect(isProtectionRefusal(ALB)).toBe(true);
  });

  it('is false for a non-Error value', () => {
    expect(isProtectionRefusal('deletion protection')).toBe(false);
    expect(isProtectionRefusal(undefined)).toBe(false);
  });
});
