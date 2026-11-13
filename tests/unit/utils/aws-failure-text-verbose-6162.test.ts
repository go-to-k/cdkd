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

  /**
   * The src-wide scan: every code line that names `--verbose` (any wording:
   * "re-run with --verbose", "--verbose for", "--verbose to see", "--verbose
   * shows", ...) must be GATED, in one of three exact shapes:
   *
   *  - the same line holds `verboseAwareText(` or `verbosePointerSentence() ?`
   *    BEFORE the hint (the hint is that call's argument / that ternary's arm);
   *  - the previous line ENDS in `verboseAwareText(` (the hint opens its
   *    argument list);
   *  - the previous line ends in `verbosePointerSentence()` and this one opens
   *    the ternary arm with `?`.
   *
   * So an unrelated gate call nearby cannot excuse a hint. The option's own
   * definition (`'--verbose'` as a whole string) is not a hint.
   */
  const HINT = /--verbose\b/;
  const OPTION_TOKEN = /['"`](?:-v, )?--verbose['"`]/;
  const SAME_LINE_GATE = /verboseAwareText\(|verbosePointerSentence\(\) \?/;
  function gated(lines: string[], i: number): boolean {
    const line = lines[i]!;
    const gate = SAME_LINE_GATE.exec(line);
    if (gate !== null && gate.index < line.search(HINT)) return true;
    const prev = (lines[i - 1] ?? '').trimEnd();
    if (/verboseAwareText\($/.test(prev)) return true;
    return /verbosePointerSentence\(\)$/.test(prev) && /^\s*\?/.test(line);
  }
  function isHintLine(line: string): boolean {
    return !/^\s*(\/\/|\*|\/\*)/.test(line) && HINT.test(line) && !OPTION_TOKEN.test(line);
  }
  function ungatedHints(file: string, text: string): string[] {
    const lines = text.split('\n');
    const out: string[] = [];
    lines.forEach((line, i) => {
      if (isHintLine(line) && !gated(lines, i)) out.push(`${file}: ${line.trim()}`);
    });
    return out;
  }
  // Exempt by EXACT line text, never by file: a new hint in the same file is
  // still caught. None of these asks to re-run THIS command with --verbose.
  const EXEMPT_LINES = new Set([
    // Another command's flag (`cdkd state show` with --verbose).
    'src/deployment/recreate-targets/probe.ts: `--verbose to see what the record claims, and repair it. Re-run with ` +',
    // A flag list in the resource-timeout remedy.
    "src/utils/error-handler/base-errors.ts: 'to bump the budget for this resource type only, or --verbose to see the\\n'",
    "src/utils/error-handler/base-errors.ts: 'or --verbose to see the\\n';",
    // PR #6160's file; a debug line, so it only ever prints under --verbose.
    'src/local/docker-runner.ts: logger.debug(`Pulling ${image} (silent — pass --verbose to stream progress)`);',
    // The pointer's own definition.
    `src/utils/aws-failure-text.ts: export const VERBOSE_POINTER = "Re-run with --verbose for AWS's own message.";`,
  ]);

  it('the scan flags a hard-coded hint and passes only a real gate (self-test)', () => {
    const scan = (text: string) => ungatedHints('x.ts', text);
    expect(scan("  logger.warn(`boom. Re-run with --verbose for AWS's own message.`);")).toHaveLength(1);
    expect(scan('  `retry later (--verbose shows when)`,')).toHaveLength(1);
    // An unrelated gate on a nearby line excuses nothing.
    expect(scan('  const a = verboseAwareText(x, y);\n  `retry later (--verbose shows when)`,')).toHaveLength(1);
    // A gate AFTER the hint on the same line excuses nothing.
    expect(scan('  `--verbose shows it` + verboseAwareText(x, y),')).toHaveLength(1);
    // The three gated shapes.
    expect(scan("  verboseAwareText(\n    'Re-run with --verbose for the cause.',")).toEqual([]);
    expect(scan('  safeMsg`it${verboseAwareText(\', re-run with --verbose\', \'\')}`')).toEqual([]);
    expect(
      scan("  return verbosePointerSentence()\n    ? `x; re-run with --verbose for the AWS error text`")
    ).toEqual([]);
    expect(scan("  new Option('--verbose', 'Enable verbose logging')")).toEqual([]);
    expect(scan('  // Re-run with --verbose for the details.')).toEqual([]);
  });

  it('no src line hard-codes a --verbose hint outside the gates', async () => {
    const { execFileSync } = await import('node:child_process');
    const { readFileSync } = await import('node:fs');
    const files = execFileSync('git', ['ls-files', 'src/**/*.ts', 'src/*.ts'], { encoding: 'utf8' })
      .split('\n')
      .filter((f) => f !== '');
    let hints = 0;
    const offenders: string[] = [];
    const exemptSeen = new Set<string>();
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      hints += text.split('\n').filter(isHintLine).length;
      for (const hit of ungatedHints(file, text)) {
        if (EXEMPT_LINES.has(hit)) exemptSeen.add(hit);
        else offenders.push(hit);
      }
    }
    expect(offenders).toEqual([]);
    // Every exemption still matches a line; drop it once it does not.
    expect([...exemptSeen].sort()).toEqual([...EXEMPT_LINES].sort());
    // Non-vacuity: the gated sites are really in the scanned population.
    expect(hints).toBeGreaterThanOrEqual(15);
  });
});
