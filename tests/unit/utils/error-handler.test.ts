import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  handleError,
  normalizeAwsError,
  PartialFailureError,
  withErrorHandling,
} from '../../../src/utils/error-handler.js';

/**
 * Build the AWS SDK v3 synthetic Unknown error shape that this helper is
 * designed to translate.
 */
function makeUnknownError(
  status: number | undefined,
  extra: Record<string, unknown> = {}
): Error {
  return Object.assign(new Error('UnknownError'), {
    name: 'Unknown',
    $metadata: status !== undefined ? { httpStatusCode: status } : undefined,
    ...extra,
  }) as Error;
}

describe('normalizeAwsError', () => {
  it('passes a regular AWS error through unchanged', () => {
    const err = Object.assign(new Error('Access Denied'), {
      name: 'AccessDenied',
      $metadata: { httpStatusCode: 403 },
    });

    const result = normalizeAwsError(err, { bucket: 'b', operation: 'op' });

    // Same reference: untouched.
    expect(result).toBe(err);
  });

  it('passes a non-Error value through wrapped in Error', () => {
    const result = normalizeAwsError('boom');

    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('boom');
  });

  it('detects via err.name === "Unknown"', () => {
    const err = Object.assign(new Error('something else'), {
      name: 'Unknown',
      $metadata: { httpStatusCode: 404 },
    });

    const result = normalizeAwsError(err, { bucket: 'b' });

    expect(result.message).toMatch(/does not exist/);
  });

  it('detects via err.message === "UnknownError"', () => {
    const err = Object.assign(new Error('UnknownError'), {
      name: 'SomeOtherName',
      $metadata: { httpStatusCode: 404 },
    });

    const result = normalizeAwsError(err, { bucket: 'b' });

    expect(result.message).toMatch(/does not exist/);
  });

  it('301 → different-region message including the region from response headers', () => {
    const err = makeUnknownError(301, {
      $response: { headers: { 'x-amz-bucket-region': 'us-west-2' } },
    });

    const result = normalizeAwsError(err, { bucket: 'cross-region', operation: 'HeadBucket' });

    expect(result.message).toMatch(/Bucket 'cross-region'/);
    expect(result.message).toMatch(/different region/);
    expect(result.message).toMatch(/us-west-2/);
  });

  it('301 → different-region message even when the region header is missing', () => {
    const err = makeUnknownError(301);

    const result = normalizeAwsError(err, { bucket: 'cross-region' });

    expect(result.message).toMatch(/different region/);
    // No "(in <region>)" parenthetical when the header is absent.
    expect(result.message).not.toMatch(/\(in /);
  });

  it('403 → access denied message naming the bucket', () => {
    const err = makeUnknownError(403);

    const result = normalizeAwsError(err, { bucket: 'forbidden' });

    expect(result.message).toMatch(/Access denied/);
    expect(result.message).toMatch(/'forbidden'/);
  });

  it('404 → bucket does not exist', () => {
    const err = makeUnknownError(404);

    const result = normalizeAwsError(err, { bucket: 'missing' });

    expect(result.message).toMatch(/Bucket 'missing' does not exist/);
  });

  it('500 → fallback HTTP status message', () => {
    const err = makeUnknownError(500);

    const result = normalizeAwsError(err, { bucket: 'b', operation: 'GetObject' });

    expect(result.message).toMatch(/S3 error during GetObject/);
    expect(result.message).toMatch(/HTTP 500/);
  });

  it('missing $metadata → uses "unknown HTTP status"', () => {
    const err = makeUnknownError(undefined);

    const result = normalizeAwsError(err, { bucket: 'b', operation: 'PutObject' });

    expect(result.message).toMatch(/unknown HTTP status/);
    expect(result.message).toMatch(/PutObject/);
  });

  it("uses '<unknown bucket>' when no bucket context is provided", () => {
    const err = makeUnknownError(404);

    const result = normalizeAwsError(err);

    expect(result.message).toMatch(/'<unknown bucket>'/);
  });
});

describe('PartialFailureError + handleError exit code mapping', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // process.exit is wrapped to throw so handleError's `: never` return
    // type doesn't actually terminate the test process.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit-mock');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('PartialFailureError carries exitCode === 2 and the right name/code', () => {
    const err = new PartialFailureError('2 resource error(s). State preserved');

    expect(err).toBeInstanceOf(PartialFailureError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PartialFailureError');
    expect(err.code).toBe('PARTIAL_FAILURE');
    expect(err.exitCode).toBe(2);
  });

  it('handleError exits with code 2 when given a PartialFailureError', () => {
    const err = new PartialFailureError('partial failure');

    expect(() => handleError(err)).toThrow('process.exit-mock');
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('handleError exits with code 1 for any other error type (regression guard)', () => {
    expect(() => handleError(new Error('regular error'))).toThrow('process.exit-mock');
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockClear();

    expect(() => handleError('non-Error value')).toThrow('process.exit-mock');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('withErrorHandling preserves the PartialFailureError → exit 2 mapping when wrapping a command', async () => {
    // The CLI commands route through withErrorHandling; verify the
    // wrapper does not lose the PartialFailureError class on its way
    // to handleError.
    const wrapped = withErrorHandling(async () => {
      throw new PartialFailureError('wrapped partial failure');
    });

    await expect(wrapped()).rejects.toThrow('process.exit-mock');
    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});
