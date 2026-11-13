import { describe, it, expect, afterEach } from 'vite-plus/test';
import {
  VERBOSE_POINTER,
  describeAwsErrorDiagnostics,
  describeAwsFailure,
  describeAwsStatusReason,
  registerVerboseRunProbe,
  verbosePointerSentence,
  verbosePointerTail,
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
    expect(verbosePointerTail()).toBe(` ${VERBOSE_POINTER}`);
  });

  it('is dropped from every summary when the run is verbose', () => {
    registerVerboseRunProbe(() => true);
    expect(describeAwsFailure(emptyBody413()).summary).toBe('Unknown.');
    expect(describeAwsFailure(42).summary).toBe('a non-Error value of type number.');
    expect(describeAwsStatusReason({ code: 'E1', message: 'm' }, 'f').summary).toBe('E1.');
    expect(describeAwsStatusReason({ message: 'm' }, 'f').summary).toBe(
      "AWS's reason is in the debug output above."
    );
    expect(verbosePointerSentence()).toBe('');
    expect(verbosePointerTail()).toBe('');
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
      'HTTP 413, fault client, attempts 1, response content-length 0, name Unknown, ' +
        'message "UnknownError". AWS returned no error message (the response body was empty).'
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
      'cause: name Error, message "inner"',
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
      'attempts 1, name Error, code EPIPE, message "write EPIPE". ' +
        'No AWS response was received: the request failed before AWS answered.'
    );
  });

  it("reads the SDK exchange off a cdkd wrap's cause chain (a stack node's shape)", () => {
    const wrap = new Error('Failed to create resource Bucket', { cause: emptyBody413() });
    expect(describeAwsErrorDiagnostics(wrap)).toBe(
      'name Error, message "Failed to create resource Bucket"; ' +
        'cause: HTTP 413, fault client, attempts 1, response content-length 0, name Unknown, ' +
        'message "UnknownError". AWS returned no error message (the response body was empty).'
    );
  });

  it("gives cdkd's own refusal no AWS verdict at all", () => {
    expect(describeAwsErrorDiagnostics(new Error('Stack S failed: boom'))).toBe(
      'name Error, message "Stack S failed: boom".'
    );
    const coded = Object.assign(new Error('refused'), { code: 'CDKD_REFUSED' });
    expect(describeAwsErrorDiagnostics(coded)).not.toContain('No AWS response');
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

describe('every user-facing pointer goes through the verbose-aware helpers', () => {
  /** `git grep -n` hits in src, comment lines dropped, as their FILE names. */
  async function codeFilesMatching(needle: string): Promise<string[]> {
    const { execFileSync } = await import('node:child_process');
    let out = '';
    try {
      out = execFileSync('git', ['grep', '-n', '-F', needle, '--', 'src'], { encoding: 'utf8' });
    } catch {
      out = ''; // git grep exits 1 on no match
    }
    const files = out
      .split('\n')
      .filter((l) => l !== '' && !/^[^:]+:\d+:\s*(\/\/|\*)/.test(l))
      .map((l) => l.slice(0, l.indexOf(':')));
    return [...new Set(files)].sort();
  }

  it('only the summary RECOGNISERS read VERBOSE_POINTER outside aws-failure-text.ts', async () => {
    // name-collision's class strip, the rollback / replay rewording and
    // iam-policy's tail strip READ the literal to recognise a summary; a new
    // file that prints it would ignore --verbose (go-to-k/cdkd#6162).
    expect(await codeFilesMatching('VERBOSE_POINTER')).toEqual([
      'src/deployment/retryable-errors/name-collision.ts',
      'src/deployment/rollback-executor/messages.ts',
      'src/deployment/rollback-executor/replay-reverse-replacement/failures.ts',
      'src/provisioning/providers/iam-policy/create.ts',
      'src/utils/aws-failure-text.ts',
    ]);
  });

  it('spells the pointer sentence only where it is verbose-aware', async () => {
    // dynamodb-index-busy-delete.ts words it mid-sentence, gated on
    // verbosePointerSentence().
    expect(await codeFilesMatching("with --verbose for AWS's own message")).toEqual([
      'src/provisioning/dynamodb-index-busy-delete.ts',
      'src/utils/aws-failure-text.ts',
    ]);
  });
});
