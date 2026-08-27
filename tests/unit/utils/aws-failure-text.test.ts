import { describe, it, expect } from 'vite-plus/test';
import { describeAwsFailure } from '../../../src/utils/aws-failure-text.js';
import { CdkdError, ProvisioningError } from '../../../src/utils/error-handler.js';

/**
 * Direct cover for the predicate the whole #2302 redaction rests on.
 *
 * `describeAwsFailure` splits a caught failure into a throw-safe `summary` and
 * a debug-only `detail`, and it decides which by asking whether AWS AUTHORED
 * the message -- keyed on the smithy marker fields `$metadata` / `$fault` /
 * `$response`. Both call-site suites drive it only through errors carrying
 * `$metadata`, so before this file the `$fault` and `$response` arms -- i.e.
 * two thirds of the safety argument for that predicate -- were never executed,
 * and neither was the empty-`name` fallback.
 *
 * The identity fragments below are S3's real `AccessDenied` wording. A fixture
 * reading `Access Denied` cannot tell a summary that prints the CLASS from one
 * that prints the MESSAGE.
 */

const ACCOUNT = '123456789012';
const ROLE = 'cdkd-deploy-role';
const SESSION = 'cdkd-session-8f21';
const ARN = `arn:aws:sts::${ACCOUNT}:assumed-role/${ROLE}/${SESSION}`;
const AWS_TEXT =
  `User: ${ARN} is not authorized to perform: s3:GetBucketLocation on resource: ` +
  `"arn:aws:s3:::my-bucket" because no identity-based policy allows it`;

/** Build an AWS-shaped failure carrying exactly ONE of the three marker fields. */
function awsShaped(marker: '$metadata' | '$fault' | '$response', name = 'AccessDenied'): Error {
  const e = new Error(AWS_TEXT);
  const value =
    marker === '$metadata'
      ? { httpStatusCode: 403 }
      : marker === '$fault'
        ? 'client'
        : { statusCode: 403, headers: {} };
  return Object.assign(e, { name, [marker]: value });
}

function expectWithheld(summary: string): void {
  // One assertion per fragment: a PARTIAL redaction must not pass on the
  // strength of the others.
  expect(summary).not.toContain(ARN);
  expect(summary).not.toContain(ACCOUNT);
  expect(summary).not.toContain(ROLE);
  expect(summary).not.toContain(SESSION);
  expect(summary).not.toContain('assumed-role');
  expect(summary).not.toContain('is not authorized to perform');
}

describe('describeAwsFailure: which failures are AWS-authored (issue #2302)', () => {
  // Each marker ALONE must be enough. The predicate is an OR, so a fixture that
  // sets all three cannot tell a working arm from a dead one -- which is the
  // state the two call-site suites left `$fault` and `$response` in.
  it.each(['$metadata', '$fault', '$response'] as const)(
    'redacts a failure whose ONLY smithy marker is %s',
    (marker) => {
      const failure = describeAwsFailure(awsShaped(marker));

      expect(failure.redacted).toBe(true);
      expect(failure.summary).toContain('AccessDenied');
      expect(failure.summary).toContain('--verbose');
      expectWithheld(failure.summary);
      // The other half: nothing is DISCARDED. AWS's wording is what separates a
      // missing IAM grant from a bucket-policy Deny.
      expect(failure.detail).toBe(AWS_TEXT);
    }
  );

  it('treats an EMPTY $metadata as AWS-authored — presence is the signal, not contents', () => {
    // `$metadata: {}` is what a failure that never reached error deserialization
    // carries. Keying on a nested field instead of on presence would let it
    // through unredacted.
    const e = Object.assign(new Error(AWS_TEXT), { name: 'AccessDenied', $metadata: {} });

    const failure = describeAwsFailure(e);

    expect(failure.redacted).toBe(true);
    expectWithheld(failure.summary);
  });

  it('falls back to `Error` when the SDK nulled the name out', () => {
    // Without the fallback the summary opens with `. Re-run with --verbose`,
    // an empty clause where the discriminator should be.
    const e = Object.assign(new Error(AWS_TEXT), { name: '', $metadata: { httpStatusCode: 500 } });

    const failure = describeAwsFailure(e);

    expect(failure.summary).toBe("Error. Re-run with --verbose for AWS's own message.");
    expectWithheld(failure.summary);
  });

  it('prints the ACTUAL class, so the summary cannot be a literal', () => {
    const failure = describeAwsFailure(awsShaped('$metadata', 'ThrottlingException'));
    expect(failure.summary).toContain('ThrottlingException');
    expect(failure.summary).not.toContain('AccessDenied');
  });
});

describe('describeAwsFailure: what must pass through UNTOUCHED (issue #2302)', () => {
  // The narrow predicate exists for these. A polarity of "redact anything cdkd
  // did not author" was measured to destroy six cdkd-authored refusals in
  // `s3-bucket-provider.ts` alone, so every case here is a negative control.

  it('passes a cdkd-authored PLAIN Error through verbatim', () => {
    // The shape that forced the narrow predicate: `deleteBucketWithEmptyRetry`'s
    // non-empty-bucket refusal is a bare `new Error(...)` whose text IS the
    // CloudFormation-parity remediation, and it carries no smithy marker.
    const text =
      'bucket my-bucket is not empty. Matching CloudFormation, cdkd does not delete a ' +
      'non-empty bucket unless it opted into automatic emptying.';

    const failure = describeAwsFailure(new Error(text));

    expect(failure.redacted).toBe(false);
    expect(failure.summary).toBe(text);
    expect(failure.detail).toBe(text);
    expect(failure.summary).not.toContain('--verbose');
  });

  it('passes a CdkdError and a ProvisioningError through verbatim', () => {
    const refusal = new CdkdError('Refusing to adopt it.', 'ASSET_STORAGE_FOREIGN_REGION_BUCKET');
    const provisioning = new ProvisioningError(
      'Refusing to delete S3 bucket b: the bucket lives in ap-northeast-1.',
      'AWS::S3::Bucket',
      'MyBucket'
    );

    for (const e of [refusal, provisioning]) {
      const failure = describeAwsFailure(e);
      expect(failure.redacted).toBe(false);
      expect(failure.summary).toBe(e.message);
    }
  });

  it('withholds a NON-Error throw entirely, and still routes it to detail', () => {
    // No class to fall back to, and the value is the whole payload -- the shape
    // with the fewest guarantees about what is inside it, not the most.
    const failure = describeAwsFailure(`denied for ${ARN}`);

    expect(failure.redacted).toBe(true);
    expect(failure.summary).toBe(
      "a non-Error value of type string. Re-run with --verbose for AWS's own message."
    );
    expect(failure.summary).not.toContain(ARN);
    expect(failure.detail).toBe(`denied for ${ARN}`);
  });
});
