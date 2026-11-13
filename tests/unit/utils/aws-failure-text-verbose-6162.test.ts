import { describe, it, expect, afterEach } from 'vite-plus/test';
import {
  VERBOSE_POINTER,
  describeAwsErrorDiagnostics,
  describeAwsFailure,
  describeAwsStatusReason,
  registerVerboseRunProbe,
  verbosePointerSentence,
} from '../../../src/utils/aws-failure-text.js';

/**
 * go-to-k/cdkd#6162: a `--verbose` run still said "Re-run with --verbose for
 * AWS's own message." and showed nothing but the SDK's `UnknownError`
 * placeholder for an empty-bodied 413.
 */

/** What the SDK threw for AWS Emulator's oversized PutObject (measured). */
function emptyBody413(): Error {
  const error = new Error('UnknownError');
  error.name = 'Unknown';
  Object.assign(error, {
    $fault: 'client',
    $retryable: undefined,
    $metadata: { httpStatusCode: 413, attempts: 1, totalRetryDelay: 0 },
    $response: {
      statusCode: 413,
      headers: { connection: 'close', 'content-length': '0' },
    },
  });
  return error;
}

afterEach(() => {
  registerVerboseRunProbe(() => false);
});

describe('the --verbose pointer on a run that is already verbose', () => {
  it('is present on a run that is not verbose', () => {
    registerVerboseRunProbe(() => false);
    expect(describeAwsFailure(emptyBody413()).summary).toBe(`Unknown. ${VERBOSE_POINTER}`);
    expect(verbosePointerSentence()).toBe(`${VERBOSE_POINTER} `);
  });

  it('is dropped from every summary when the run is verbose', () => {
    registerVerboseRunProbe(() => true);
    expect(describeAwsFailure(emptyBody413()).summary).toBe('Unknown.');
    expect(describeAwsFailure(42).summary).toBe('a non-Error value of type number.');
    expect(describeAwsStatusReason({ code: 'E1', message: 'm' }, 'f').summary).toBe('E1.');
    expect(describeAwsStatusReason({ message: 'm' }, 'f').summary).not.toContain('--verbose');
    expect(verbosePointerSentence()).toBe('');
  });

  it('treats a throwing probe as not verbose', () => {
    registerVerboseRunProbe(() => {
      throw new Error('probe broke');
    });
    expect(describeAwsFailure(emptyBody413()).summary).toBe(`Unknown. ${VERBOSE_POINTER}`);
  });
});

describe('describeAwsErrorDiagnostics', () => {
  it('names the status and says plainly that AWS sent no message (empty-bodied 413)', () => {
    expect(describeAwsErrorDiagnostics(emptyBody413())).toBe(
      'HTTP 413, name Unknown, message "UnknownError", fault client, attempts 1, ' +
        'response content-length 0. AWS returned no error message (the response body was empty).'
    );
  });

  it('prints every field an AWS error carries, Code and cause included', () => {
    const error = new Error('Access Denied', { cause: new Error('inner') });
    error.name = 'AccessDenied';
    Object.assign(error, {
      Code: 'AccessDeniedCode',
      $fault: 'client',
      $metadata: {
        httpStatusCode: 403,
        requestId: 'REQ1',
        extendedRequestId: 'EXT1',
        attempts: 1,
      },
    });
    const text = describeAwsErrorDiagnostics(error);
    for (const part of [
      'HTTP 403',
      'name AccessDenied',
      'Code AccessDeniedCode',
      'message "Access Denied"',
      'request id REQ1',
      'extended request id EXT1',
      'cause Error: "inner"',
    ]) {
      expect(text).toContain(part);
    }
    expect(text).not.toContain('no error message');
  });

  it('says no response arrived for a socket failure', () => {
    const epipe = Object.assign(new Error('write EPIPE'), {
      code: 'EPIPE',
      $metadata: { attempts: 1 },
    });
    expect(describeAwsErrorDiagnostics(epipe)).toBe(
      'name Error, code EPIPE, message "write EPIPE", attempts 1. ' +
        'No AWS response was received: the request failed before AWS answered.'
    );
  });

  it('never throws, whatever it is handed', () => {
    const hostile = new Error('x');
    Object.defineProperty(hostile, '$metadata', {
      get() {
        throw new Error('boom');
      },
    });
    expect(describeAwsErrorDiagnostics(hostile)).toBe('the failure could not be inspected');
    expect(describeAwsErrorDiagnostics(Object.create(null))).toContain('a non-Error value');
  });
});
