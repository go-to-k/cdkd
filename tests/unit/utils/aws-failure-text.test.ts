import { describe, it, expect } from 'vite-plus/test';
import { describeAwsFailure, safeStringify } from '../../../src/utils/aws-failure-text.js';
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
function awsShaped(marker: '$metadata' | '$fault', name = 'AccessDenied'): Error {
  const e = new Error(AWS_TEXT);
  const value = marker === '$metadata' ? { httpStatusCode: 403 } : 'client';
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
  // Each signal ALONE must be enough. The predicate is an OR, so a fixture that
  // sets both cannot tell a working arm from a dead one -- which is the state
  // the two call-site suites left `$fault` in.
  //
  // `$response` is GONE from this list (issue
  // [#3297](https://github.com/go-to-k/cdkd/issues/3297)) and its removal costs
  // no coverage: it is only ever set on a `ServiceException`, which carries
  // `$fault` anyway, so the disjunct decided nothing on its own. `$metadata`
  // now means a NUMERIC `httpStatusCode`, not mere presence -- see the case
  // below for why.
  it.each(['$metadata', '$fault'] as const)(
    'redacts a failure whose ONLY service signal is %s',
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

  it('does NOT treat a $metadata without a status code as AWS-authored (issue #3297)', () => {
    // This case asserted the OPPOSITE until issue
    // [#3297](https://github.com/go-to-k/cdkd/issues/3297), under the title
    // "presence is the signal, not contents" -- a defect stated as a
    // specification, which is why it survived a review that read the code.
    //
    // `$metadata` PRESENCE is not a service signal. `@smithy/core`'s retry
    // middleware stamps `$metadata = {attempts, totalRetryDelay}` onto EVERY
    // error it gives up on, socket errors included, and CREATES the object when
    // it is absent. Measured against a real `CloudControlClient` pointed at a
    // closed port, a plain `ECONNREFUSED` arrives carrying one -- so the old
    // predicate reduced it to its `name`, which for a socket error is the bare
    // token `Error`. That deleted `connect ECONNREFUSED <ip>:443`, the exact
    // wording issue [#3236](https://github.com/go-to-k/cdkd/issues/3236) was
    // reported with, from the only durable record of the outage.
    //
    // The shape here is the RETRY stamp, not `{}`: `{}` is what the old comment
    // described and is strictly weaker, since it cannot exhibit the field the
    // new predicate reads.
    const e = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), {
      name: 'Error',
      code: 'ECONNREFUSED',
      $metadata: { attempts: 3, totalRetryDelay: 58 },
    });

    const failure = describeAwsFailure(e);

    expect(failure.redacted).toBe(false);
    // The diagnosis SURVIVES, which is the whole point of the change.
    expect(failure.summary).toBe('connect ECONNREFUSED 10.0.0.1:443');
    expect(failure.detail).toBe('connect ECONNREFUSED 10.0.0.1:443');
  });

  it('redacts a CredentialsProviderError, which carries neither service signal', () => {
    // The third arm, and the reason it is a NAME rather than a field: identity
    // is resolved by `httpAuthSchemeMiddleware` at step `serialize`, which
    // WRAPS retry's `finalizeRequest`, so an escaping credential error never
    // enters retry's catch and never gets the stamp. It is also the shape whose
    // message carries the most -- `@aws-sdk/credential-provider-process` wraps
    // EVERY exec failure in it, so the text interpolates the helper's ARGV and
    // its stderr.
    const e = Object.assign(
      new Error("Command failed: /bin/sh -c 'vault read'\nvault: token hvs.SECRET rejected"),
      { name: 'CredentialsProviderError' }
    );

    const failure = describeAwsFailure(e);

    expect(failure.redacted).toBe(true);
    expect(failure.summary).toContain('CredentialsProviderError');
    expect(failure.summary).not.toContain('hvs.SECRET');
    expect(failure.summary).not.toContain('/bin/sh');
    // Withheld, not deleted: `--verbose` still recovers it.
    expect(failure.detail).toContain('hvs.SECRET');
  });

  it('does NOT redact the *ProviderError siblings, whose text is the remedy', () => {
    // Both directions of the enumeration in `isAwsAuthoredFailure`'s doc: a
    // revision matching the whole `*ProviderError` suffix would reduce an SSO
    // expiry to a wire name and leave the user with no instruction.
    for (const [name, message] of [
      ['TokenProviderError', "Token is expired. To refresh this SSO session run 'aws sso login'."],
      ['ProviderError', 'Could not load credentials from any providers'],
      [
        'InstanceMetadataV1FallbackError',
        'AWS EC2 Metadata v1 fallback has been blocked by AWS SDK configuration',
      ],
    ] as const) {
      const failure = describeAwsFailure(Object.assign(new Error(message), { name }));

      expect(failure.redacted, `${name} must not be reduced`).toBe(false);
      expect(failure.summary).toBe(message);
    }
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

describe('the property cdkd prose matchers depend on (go-to-k/cdkd#3348)', () => {
  // `destroy-runner.ts` decides "this delete failed because the resource was
  // ALREADY GONE" by substring-matching the caught value's text, and on a match
  // it DROPS the state record. go-to-k/cdkd#3348 moved that read from a bare
  // ternary to `.detail`; the hazard a future edit will reach for is `.summary`,
  // which for an AWS-authored failure replaces the message with the wire class.
  //
  // Fencing the wiring at the runner turned out to cost more than it buys: an
  // `$fault`-carrying fixture lands on the retry classifier's transient path and
  // the case spends its budget in backoff rather than reaching the assertion.
  // So the PROPERTY is pinned here instead, and the runner's own suite is left
  // alone. What this does NOT prove is that the runner still reads `.detail` --
  // that is `msg`'s single reader, verified by review rather than by a test.
  it('keeps the needle in .detail and loses it from .summary', () => {
    // S3's real already-deleted shape. The NAME is the load-bearing half: it
    // carries none of the matcher's needles while the MESSAGE carries
    // `does not exist`. A first attempt used `ResourceNotFoundException`, whose
    // name contains `NotFoundException` -- so `.summary` matched too and the
    // probe passed against the substitution it existed to catch.
    const noSuchBucket = Object.assign(new Error('The specified bucket does not exist'), {
      name: 'NoSuchBucket',
      $fault: 'client',
    });

    const described = describeAwsFailure(noSuchBucket);

    expect(described.redacted, 'the fixture must be AWS-AUTHORED, or the two halves agree').toBe(
      true
    );
    expect(described.detail).toContain('does not exist');
    expect(described.summary).not.toContain('does not exist');
    // And the name alone carries no needle, which is what makes the pair differ.
    // All FIVE needles `destroy-runner.ts` matches on -- an earlier revision
    // listed four and omitted `No policy found`.
    for (const needle of [
      'does not exist',
      'not found',
      'No policy found',
      'NoSuchEntity',
      'NotFoundException',
    ]) {
      expect(described.summary, `\`.summary\` must not carry ${needle}`).not.toContain(needle);
    }
  });
});

describe('safeStringify: the guarded 1:1 replacement for a bare String(x)', () => {
  // WHY this exists rather than `describeAwsFailure(x).detail`. The sweep that
  // converted `src/provisioning/**` to `.detail` reached nine BARE `String(x)`
  // sites and substituted `.detail` there too, on a "byte-identical" claim that
  // holds only for the TERNARY form. It is false for the bare one, and four of
  // the nine build a persisted `outcome: 'partial'` orphanReason.
  it('keeps the wire code that `.detail` drops, which is the whole reason for the split', () => {
    const awsFailure = awsShaped('$metadata');

    // The discriminator an operator reads first is the NAME, and only
    // `String()` carries it.
    expect(safeStringify(awsFailure)).toBe(`AccessDenied: ${AWS_TEXT}`);
    expect(describeAwsFailure(awsFailure).detail).toBe(AWS_TEXT);
    expect(describeAwsFailure(awsFailure).detail).not.toContain('AccessDenied');
  });

  it('agrees with String() for every value String() can convert', () => {
    // One assertion per shape: the conversions differ from each other, so a
    // single `Error` case cannot tell a real pass-through from a hardcode.
    for (const value of [
      new Error('boom'),
      Object.assign(new Error('boom'), { name: 'ThrottlingException' }),
      new Error(''),
      'a bare string',
      42,
      0,
      null,
      undefined,
      true,
      { toString: () => 'a custom toString' },
      ['a', 'b'],
      Symbol('s'),
    ]) {
      expect(safeStringify(value)).toBe(String(value));
    }
  });

  it('returns a sentence instead of throwing for the shapes String() throws on', () => {
    // The point of the guard: every call site is INSIDE a catch, so a throw
    // here replaces the failure being reported -- which is the defect the
    // whole sweep exists to remove. Both shapes measured to throw under
    // `String()`.
    for (const hostile of [
      Object.create(null) as object,
      { toString: null },
      {
        toString() {
          throw new Error('hostile toString');
        },
      },
    ]) {
      expect(() => String(hostile)).toThrow();
      expect(safeStringify(hostile)).toBe('a value that could not be converted to text');
    }
  });
});
