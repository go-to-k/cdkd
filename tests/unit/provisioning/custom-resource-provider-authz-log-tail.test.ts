import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// Log-tail fallback for the transient-IAM-authorization retry (issue #1674).
//
// Sibling of `custom-resource-provider-authz-retry.test.ts`, which covers the
// case where the FAILED *reason* carries the authz wording. This file covers
// the case it structurally cannot: a handler that wraps the SDK / CLI failure
// in its own message, so the reason reaching cdkd has no authz wording at all
// and only the backing function's invocation log does.
const mockLambdaSend = vi.fn();
const mockSnsSend = vi.fn();
const mockS3Send = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockLambdaSend },
    sns: { send: mockSnsSend },
    s3: { send: mockS3Send },
  }),
}));

const warnSpy = vi.fn();
vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => warnSpy(...args),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://s3.example.com/presigned-url'),
}));

import { CustomResourceProvider } from '../../../src/provisioning/providers/custom-resource-provider.js';

const SERVICE_TOKEN =
  'arn:aws:lambda:ap-northeast-1:123456789012:function:Stack-CustomCDKBucketDeployment';
const SNS_SERVICE_TOKEN = 'arn:aws:sns:ap-northeast-1:123456789012:Stack-Topic';

/**
 * The reason CDK's `BucketDeployment` handler actually produces for an asset
 * 403 — `subprocess.check_call` raises `CalledProcessError`, whose `str()` is
 * only the exit status, and the handler passes that to `cfn_error()`.
 *
 * Pinned verbatim: the classifier must be exercised against the shape the bug
 * REPORT carries, not against a paraphrase that happens to still match.
 */
const BUCKET_DEPLOYMENT_REASON =
  "Command '['/opt/awscli/aws', 's3', 'cp', " +
  "'s3://cdkd-assets-123456789012-ap-northeast-1/9f86d081884c.zip', " +
  "'/tmp/tmpab12cd/2f1a-4b']' returned non-zero exit status 1.";

/** The 403 as it appears in the backing function's own log, and nowhere else. */
const DENIAL_LINE =
  'fatal error: An error occurred (403) when calling the HeadObject operation: Forbidden';

const BUCKET_DEPLOYMENT_LOG_TAIL = [
  'START RequestId: 6d1f-4c2a Version: $LATEST',
  '[INFO] | aws s3 cp s3://cdkd-assets-123456789012-ap-northeast-1/9f86d081884c.zip /tmp/tmpab12cd/2f1a-4b',
  DENIAL_LINE,
  `[ERROR] cfn_error: b"${BUCKET_DEPLOYMENT_REASON}"`,
  'END RequestId: 6d1f-4c2a',
].join('\n');

/** A reason that DOES carry authz wording — the pre-#1674 (#756) signal. */
const AUTHZ_REASON =
  'User: arn:aws:sts::123456789012:assumed-role/Stack-Role/Stack-Fn is not authorized to perform: lambda:GetFunction';

/**
 * A denial line long enough to exercise the 200-char cap, carrying a distinctive
 * marker PAST that cap so a missing truncation is observable. Shaped like a real
 * handler line that dumps context after the error — which is exactly the
 * `print(event)` case the persisted-store rules exist for.
 */
const LONG_DENIAL_LINE =
  'fatal error: An error occurred (403) when calling the HeadObject operation: Forbidden ' +
  '- context: '.padEnd(160, 'x') +
  ' TAIL_MARKER_PAST_200';

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

interface LogTailProbe {
  findTransientAuthzLogLine(
    logTail: string | undefined
  ): { line: string; signal: string } | undefined;
}

/**
 * Wire the cfn-response-via-S3 flow (the handler returns None and PUTs the
 * response itself, which is what `BucketDeployment` does).
 *
 * `LogResult` is returned ONLY when the invoke actually asked for
 * `LogType: 'Tail'`, mirroring real Lambda. That is what makes dropping the
 * flag fail the positive cases rather than only the one assertion that reads
 * the invoke input.
 *
 * The response is returned on EVERY invoke (not just the first); from the
 * second invoke on, the S3 body flips to SUCCESS unless `neverSucceeds`, so a
 * retry is observable as a completion rather than as a repeat.
 */
function wireFlow(options: {
  reason: string;
  logTail?: string;
  rawLogResult?: string;
  neverSucceeds?: boolean;
}): { invokes: () => number; updates: () => number; invokeInputs: () => unknown[] } {
  let invokeCount = 0;
  let updateCount = 0;
  const invokeInputs: unknown[] = [];

  mockS3Send.mockImplementation((cmd: { constructor: { name: string } }) => {
    if (cmd.constructor.name === 'GetObjectCommand') {
      const body =
        invokeCount >= 2 && options.neverSucceeds !== true
          ? { Status: 'SUCCESS', PhysicalResourceId: 'phys-123', Data: { Out: 'ok' } }
          : { Status: 'FAILED', Reason: options.reason };
      return Promise.resolve({
        Body: { transformToString: () => Promise.resolve(JSON.stringify(body)) },
      });
    }
    return Promise.resolve({}); // PutObject / DeleteObject
  });

  mockLambdaSend.mockImplementation(
    (cmd: { constructor: { name: string }; input?: { LogType?: string } }) => {
      const name = cmd.constructor.name;
      if (name === 'InvokeCommand') {
        invokeCount += 1;
        invokeInputs.push(cmd.input);
        // Real Lambda returns LogResult ONLY for LogType: 'Tail'.
        const wantsTail = cmd.input?.LogType === 'Tail';
        const logResult = options.rawLogResult ?? (options.logTail && b64(options.logTail));
        return Promise.resolve({
          Payload: Buffer.from('null'),
          ...(wantsTail && logResult ? { LogResult: logResult } : {}),
        });
      }
      if (name === 'UpdateFunctionConfigurationCommand') {
        updateCount += 1;
        return Promise.resolve({});
      }
      // GetFunction / GetFunctionConfiguration for the readiness + recycle waiters.
      return Promise.resolve({ Configuration: { State: 'Active', LastUpdateStatus: 'Successful' } });
    }
  );

  return {
    invokes: () => invokeCount,
    updates: () => updateCount,
    invokeInputs: () => invokeInputs,
  };
}

function makeProvider(): CustomResourceProvider {
  return new CustomResourceProvider({
    responseBucket: 'test-bucket',
    asyncResponseTimeoutMs: 10_000,
  });
}

const warnings = (): string => warnSpy.mock.calls.map((c) => String(c[0])).join('\n---\n');

/**
 * Await a promise that MUST reject and hand back the error, typed.
 *
 * `.catch(e => e as Error)` widens the awaited type to a union of the resolved
 * value and `Error` (which `vp run typecheck:test` rejects — `vp check` does not
 * type-check `tests/**`), and it silently yields the RESOLVED value when the
 * call unexpectedly succeeds, turning a real regression into a confusing
 * property-missing failure. This throws instead.
 */
async function captureError(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected the call to reject, but it resolved');
}

describe('CustomResourceProvider authz retry via the invocation log tail (issue #1674)', () => {
  beforeEach(() => {
    mockLambdaSend.mockReset();
    mockSnsSend.mockReset();
    mockS3Send.mockReset();
    warnSpy.mockReset();
    process.env['CDKD_CR_AUTHZ_MAX_RETRIES'] = '2';
  });
  afterEach(() => {
    delete process.env['CDKD_CR_AUTHZ_MAX_RETRIES'];
  });

  it('retries the BucketDeployment 403 whose reason carries NO authz wording', async () => {
    const counts = wireFlow({
      reason: BUCKET_DEPLOYMENT_REASON,
      logTail: BUCKET_DEPLOYMENT_LOG_TAIL,
    });

    const result = await makeProvider().create('Website', 'Custom::CDKBucketDeployment', {
      ServiceToken: SERVICE_TOKEN,
    });

    expect(result.physicalId).toBe('phys-123');
    expect(counts.invokes()).toBe(2); // first attempt 403'd, second succeeded
    expect(counts.updates()).toBe(1); // exec env recycled between attempts
  });

  it('names the swallowed denial in the retry warning, so the user need not open CloudWatch', async () => {
    wireFlow({ reason: BUCKET_DEPLOYMENT_REASON, logTail: BUCKET_DEPLOYMENT_LOG_TAIL });
    await makeProvider().create('Website', 'Custom::CDKBucketDeployment', {
      ServiceToken: SERVICE_TOKEN,
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnings()).toContain('carried no authorization wording');
    expect(warnings()).toContain('An error occurred (403) when calling the HeadObject operation');
  });

  it('requests the log tail on every invoke (without it the whole fallback is dead)', async () => {
    const counts = wireFlow({
      reason: BUCKET_DEPLOYMENT_REASON,
      logTail: BUCKET_DEPLOYMENT_LOG_TAIL,
    });
    await makeProvider().create('Website', 'Custom::CDKBucketDeployment', {
      ServiceToken: SERVICE_TOKEN,
    });

    expect(counts.invokeInputs()).toHaveLength(2);
    for (const input of counts.invokeInputs()) {
      expect(input).toMatchObject({ InvocationType: 'RequestResponse', LogType: 'Tail' });
    }
  });

  it('annotates the thrown reason with the SIGNAL, and never the handler log line', async () => {
    // The post-mortem record (`deployments/*.jsonl`, replayed by `cdkd events`)
    // carries the thrown message — a warn-only surface would still send the
    // user to CloudWatch, which is the complaint the issue filed. But that
    // store is contractually secret-free, so only the cdkd-authored SIGNAL
    // PHRASE may be folded in; the verbatim handler line must not be.
    process.env['CDKD_CR_AUTHZ_MAX_RETRIES'] = '0';
    const counts = wireFlow({
      reason: BUCKET_DEPLOYMENT_REASON,
      logTail: BUCKET_DEPLOYMENT_LOG_TAIL,
      neverSucceeds: true,
    });

    const err = await captureError(
      makeProvider().create('Website', 'Custom::CDKBucketDeployment', { ServiceToken: SERVICE_TOKEN })
    );

    // ONE message carries BOTH the original reason and the finding.
    expect(err.message).toContain('returned non-zero exit status 1');
    expect(err.message).toContain('an error occurred (403)');
    // ...and nothing the HANDLER wrote. `HeadObject` appears only in the log
    // line, so a regression that folds the verbatim line back in fails here.
    expect(err.message).not.toContain('HeadObject');
    expect(err.message).not.toContain('fatal error');
    expect(counts.invokes()).toBe(1);
  });

  it('keeps a LONG handler line out of the thrown reason entirely', async () => {
    // The 200-char cap bounds VOLUME, not CLASS — 200 chars is precisely where
    // a dumped `ResourceProperties` begins. So the assertion is absence, not
    // truncation: no part of the handler's line may reach the persisted record.
    process.env['CDKD_CR_AUTHZ_MAX_RETRIES'] = '0';
    wireFlow({
      reason: BUCKET_DEPLOYMENT_REASON,
      logTail: `START RequestId: 1\n${LONG_DENIAL_LINE}\nEND RequestId: 1`,
      neverSucceeds: true,
    });

    const err = await captureError(
      makeProvider().create('Website', 'Custom::CDKBucketDeployment', { ServiceToken: SERVICE_TOKEN })
    );

    expect(err.message).toContain('an error occurred (403)');
    expect(err.message).not.toContain('TAIL_MARKER_PAST_200');
    expect(err.message).not.toContain('xxxxx');
    expect(err.message).not.toContain('HeadObject');
  });

  it('still gives the operator the verbatim line, ephemerally', async () => {
    process.env['CDKD_CR_AUTHZ_MAX_RETRIES'] = '0';
    wireFlow({
      reason: BUCKET_DEPLOYMENT_REASON,
      logTail: BUCKET_DEPLOYMENT_LOG_TAIL,
      neverSucceeds: true,
    });

    await makeProvider()
      .create('Website', 'Custom::CDKBucketDeployment', { ServiceToken: SERVICE_TOKEN })
      .catch(() => undefined);

    // Retries are disabled, so the only surface left is the terminal path's
    // reason annotation; the warn carrying the verbatim line belongs to the
    // RETRY arm, which is what the next test exercises.
    expect(warnings()).not.toContain('HeadObject');
  });

  it('puts the verbatim line in the ephemeral retry warning', async () => {
    wireFlow({ reason: BUCKET_DEPLOYMENT_REASON, logTail: BUCKET_DEPLOYMENT_LOG_TAIL });

    await makeProvider().create('Website', 'Custom::CDKBucketDeployment', {
      ServiceToken: SERVICE_TOKEN,
    });

    expect(warnings()).toContain('HeadObject');
  });

  it('does NOT claim the reason lacked authz wording when it did carry it (#756 path)', async () => {
    // Regression guard: a change that always computes / appends the log-tail
    // clause would pass every other case in this file.
    const counts = wireFlow({ reason: AUTHZ_REASON, logTail: BUCKET_DEPLOYMENT_LOG_TAIL });

    await makeProvider().create('Website', 'Custom::CDKBucketDeployment', {
      ServiceToken: SERVICE_TOKEN,
    });

    expect(counts.invokes()).toBe(2); // retried on the reason, as #756 always did
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnings()).toContain('transient IAM-authorization FAILED');
    expect(warnings()).not.toContain('carried no authorization wording');
  });

  it('does NOT retry a genuine handler bug whose log tail carries no denial', async () => {
    const logTail = [
      'START RequestId: 6d1f-4c2a Version: $LATEST',
      "[ERROR] KeyError: 'Bucket'",
      "[ERROR] cfn_error: b\"Command '[...]' returned non-zero exit status 1.\"",
      'END RequestId: 6d1f-4c2a',
    ].join('\n');
    const counts = wireFlow({
      reason: BUCKET_DEPLOYMENT_REASON,
      logTail,
      neverSucceeds: true,
    });

    await expect(
      makeProvider().create('Website', 'Custom::CDKBucketDeployment', {
        ServiceToken: SERVICE_TOKEN,
      })
    ).rejects.toThrow(/returned non-zero exit status 1/);

    expect(counts.invokes()).toBe(1); // no retry
    expect(counts.updates()).toBe(0); // no recycle
  });

  it('does NOT retry when the invoke returned no log tail at all', async () => {
    const counts = wireFlow({ reason: BUCKET_DEPLOYMENT_REASON, neverSucceeds: true });

    await expect(
      makeProvider().create('Website', 'Custom::CDKBucketDeployment', {
        ServiceToken: SERVICE_TOKEN,
      })
    ).rejects.toThrow(/returned non-zero exit status 1/);

    expect(counts.invokes()).toBe(1);
    expect(counts.updates()).toBe(0);
  });

  it('tolerates a LogResult that decodes to nothing', async () => {
    // '!!!' carries no base64 alphabet characters, so Node's lenient decoder
    // yields an EMPTY string — the `decoded.length > 0` arm.
    const counts = wireFlow({
      reason: BUCKET_DEPLOYMENT_REASON,
      rawLogResult: '!!!',
      neverSucceeds: true,
    });

    await expect(
      makeProvider().create('Website', 'Custom::CDKBucketDeployment', {
        ServiceToken: SERVICE_TOKEN,
      })
    ).rejects.toThrow(/returned non-zero exit status 1/);

    expect(counts.invokes()).toBe(1);
    expect(counts.updates()).toBe(0);
  });

  it('tolerates a LogResult that decodes to garbage', async () => {
    const counts = wireFlow({
      reason: BUCKET_DEPLOYMENT_REASON,
      rawLogResult: 'not-valid-base64-at-all',
      neverSucceeds: true,
    });

    await expect(
      makeProvider().create('Website', 'Custom::CDKBucketDeployment', {
        ServiceToken: SERVICE_TOKEN,
      })
    ).rejects.toThrow(/returned non-zero exit status 1/);

    expect(counts.invokes()).toBe(1);
    expect(counts.updates()).toBe(0);
  });

  it('ACCEPTED TRADE-OFF: a handler logging a permanent AccessDenied is retried, not masked', async () => {
    // A log surface is noisier than a handler-authored reason, so a genuine,
    // non-propagation denial buys the bounded retries. Pinned deliberately: the
    // failure is DELAYED, never hidden — the original reason still throws.
    const logTail = [
      'START RequestId: 6d1f-4c2a Version: $LATEST',
      'botocore.exceptions.ClientError: An error occurred (AccessDenied) when calling the PutItem operation: Access Denied',
      'END RequestId: 6d1f-4c2a',
    ].join('\n');
    const counts = wireFlow({
      reason: BUCKET_DEPLOYMENT_REASON,
      logTail,
      neverSucceeds: true,
    });

    await expect(
      makeProvider().create('Website', 'Custom::CDKBucketDeployment', {
        ServiceToken: SERVICE_TOKEN,
      })
    ).rejects.toThrow(/returned non-zero exit status 1/);

    expect(counts.invokes()).toBe(3); // 1 + CDKD_CR_AUTHZ_MAX_RETRIES
    expect(counts.updates()).toBe(2);
  });

  it('update() routes through the same fallback', async () => {
    const counts = wireFlow({
      reason: BUCKET_DEPLOYMENT_REASON,
      logTail: BUCKET_DEPLOYMENT_LOG_TAIL,
    });

    const result = await makeProvider().update(
      'Website',
      'phys-old',
      'Custom::CDKBucketDeployment',
      { ServiceToken: SERVICE_TOKEN, Prune: 'true' },
      { ServiceToken: SERVICE_TOKEN, Prune: 'false' }
    );

    expect(result.physicalId).toBe('phys-123');
    expect(counts.invokes()).toBe(2);
    expect(counts.updates()).toBe(1);
  });

  it("delete()'s warn-and-continue arm reports the folded denial", async () => {
    process.env['CDKD_CR_AUTHZ_MAX_RETRIES'] = '0';
    wireFlow({
      reason: BUCKET_DEPLOYMENT_REASON,
      logTail: BUCKET_DEPLOYMENT_LOG_TAIL,
      neverSucceeds: true,
    });

    // Delete is lenient by policy: it warns rather than throwing. The warn
    // prints the annotated REASON, so it carries the signal and not the line.
    await makeProvider().delete('Website', 'phys-123', 'Custom::CDKBucketDeployment', {
      ServiceToken: SERVICE_TOKEN,
    });

    expect(warnings()).toContain('delete handler returned FAILED');
    expect(warnings()).toContain('an error occurred (403)');
    expect(warnings()).not.toContain('HeadObject');
  });

  it('annotates a FAILED with no Reason at all', async () => {
    process.env['CDKD_CR_AUTHZ_MAX_RETRIES'] = '0';
    mockS3Send.mockImplementation((cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'GetObjectCommand') {
        return Promise.resolve({
          Body: { transformToString: () => Promise.resolve(JSON.stringify({ Status: 'FAILED' })) },
        });
      }
      return Promise.resolve({});
    });
    mockLambdaSend.mockImplementation(
      (cmd: { constructor: { name: string }; input?: { LogType?: string } }) => {
        if (cmd.constructor.name === 'InvokeCommand') {
          return Promise.resolve({
            Payload: Buffer.from('null'),
            ...(cmd.input?.LogType === 'Tail'
              ? { LogResult: b64(BUCKET_DEPLOYMENT_LOG_TAIL) }
              : {}),
          });
        }
        return Promise.resolve({
          Configuration: { State: 'Active', LastUpdateStatus: 'Successful' },
        });
      }
    );

    const err = await captureError(
      makeProvider().create('Website', 'Custom::CDKBucketDeployment', { ServiceToken: SERVICE_TOKEN })
    );

    expect(err.message).toContain('Unknown reason');
    expect(err.message).toContain('an error occurred (403)');
  });

  it('keeps the UNBOUNDED log tail out of a FunctionError throw (it would be persisted)', async () => {
    // A thrown message is captured by `extractDeploymentEventError` into
    // `deployments/{runId}.jsonl`, which OUTLIVES `cdkd destroy`. That store is
    // contractually error + metadata only, so an arbitrary handler stdout dump
    // must not reach it — it goes to an ephemeral warning instead.
    mockS3Send.mockImplementation(() => Promise.resolve({}));
    mockLambdaSend.mockImplementation(
      (cmd: { constructor: { name: string }; input?: { LogType?: string } }) => {
        if (cmd.constructor.name === 'InvokeCommand') {
          return Promise.resolve({
            FunctionError: 'Unhandled',
            Payload: Buffer.from(JSON.stringify({ errorType: 'ClientError' })),
            ...(cmd.input?.LogType === 'Tail'
              ? { LogResult: b64(`${BUCKET_DEPLOYMENT_LOG_TAIL}\nSECRET_TOKEN=hunter2`) }
              : {}),
          });
        }
        return Promise.resolve({
          Configuration: { State: 'Active', LastUpdateStatus: 'Successful' },
        });
      }
    );

    const err = await captureError(
      makeProvider().create('Website', 'Custom::CDKBucketDeployment', { ServiceToken: SERVICE_TOKEN })
    );

    // Anchor at END of message. `not.stringContaining('SECRET_TOKEN')` alone is
    // not enough: `truncateReason` keeps the FIRST 200 chars, so a regression
    // that folds a TRUNCATED tail into the throw — the shape that leaks a
    // `print(event)` dump, since 200 chars is where the properties begin —
    // would sail past a marker placed at the END of the tail. The anchor
    // catches ANY appended content, truncated or not. (The message itself is
    // wrapped by `create()`'s error handling, hence the match rather than an
    // equality assertion.)
    expect(err.message).toMatch(/Lambda function error \(Unhandled\): \{"errorType":"ClientError"\}$/);
    expect(err.message).not.toContain('START RequestId');
    expect(err.message).not.toContain('SECRET_TOKEN');

    // ...but the diagnostic is still available, ephemerally.
    expect(warnings()).toContain('Backing function log tail');
    expect(warnings()).toContain(DENIAL_LINE);
  });

  it('caps the ephemeral FunctionError tail so CI logs stay bounded', async () => {
    const huge = `START RequestId: 1\n${'y'.repeat(4000)}\nEND RequestId: 1`;
    mockS3Send.mockImplementation(() => Promise.resolve({}));
    mockLambdaSend.mockImplementation(
      (cmd: { constructor: { name: string }; input?: { LogType?: string } }) => {
        if (cmd.constructor.name === 'InvokeCommand') {
          return Promise.resolve({
            FunctionError: 'Unhandled',
            Payload: Buffer.from('{}'),
            ...(cmd.input?.LogType === 'Tail' ? { LogResult: b64(huge) } : {}),
          });
        }
        return Promise.resolve({
          Configuration: { State: 'Active', LastUpdateStatus: 'Successful' },
        });
      }
    );

    await makeProvider()
      .create('Website', 'Custom::CDKBucketDeployment', { ServiceToken: SERVICE_TOKEN })
      .catch(() => undefined);

    const w = warnings();
    expect(w).toContain('Backing function log tail');
    expect(w).toContain('...');
    expect(w.length).toBeLessThan(huge.length);
  });

  it('does not emit an empty tail warning when LogResult decodes to nothing', async () => {
    // Pins `decodeInvokeLogTail`'s `decoded.length > 0` arm, which the retry
    // path cannot pin (its caller rejects '' anyway).
    mockS3Send.mockImplementation(() => Promise.resolve({}));
    mockLambdaSend.mockImplementation(
      (cmd: { constructor: { name: string }; input?: { LogType?: string } }) => {
        if (cmd.constructor.name === 'InvokeCommand') {
          return Promise.resolve({
            FunctionError: 'Unhandled',
            Payload: Buffer.from('{}'),
            ...(cmd.input?.LogType === 'Tail' ? { LogResult: '!!!' } : {}),
          });
        }
        return Promise.resolve({
          Configuration: { State: 'Active', LastUpdateStatus: 'Successful' },
        });
      }
    );

    await makeProvider()
      .create('Website', 'Custom::CDKBucketDeployment', { ServiceToken: SERVICE_TOKEN })
      .catch(() => undefined);

    expect(warnings()).not.toContain('Backing function log tail');
  });

  it('leaves a FunctionError with no log tail reporting exactly as before', async () => {
    mockS3Send.mockImplementation(() => Promise.resolve({}));
    mockLambdaSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'InvokeCommand') {
        return Promise.resolve({
          FunctionError: 'Unhandled',
          Payload: Buffer.from(JSON.stringify({ errorType: 'ClientError' })),
        });
      }
      return Promise.resolve({
        Configuration: { State: 'Active', LastUpdateStatus: 'Successful' },
      });
    });

    await expect(
      makeProvider().create('Website', 'Custom::CDKBucketDeployment', {
        ServiceToken: SERVICE_TOKEN,
      })
    ).rejects.toThrow('Lambda function error (Unhandled): {"errorType":"ClientError"}');
    expect(warnings()).not.toContain('Backing function log tail');
  });

  it('surfaces the tail for a terminal FAILED that nothing explained (issue #1687)', async () => {
    // The 404 / traceback class: reason says only `exit status 1`, and the log
    // matches no authz signal — so before #1687 cdkd decoded the tail and threw
    // it away, sending the user to CloudWatch.
    process.env['CDKD_CR_AUTHZ_MAX_RETRIES'] = '0';
    const logTail = [
      'START RequestId: 6d1f-4c2a Version: $LATEST',
      'Traceback (most recent call last):',
      '  File "/var/task/index.py", line 91, in handler',
      "KeyError: 'DestinationBucketName'",
      'END RequestId: 6d1f-4c2a',
    ].join('\n');
    const counts = wireFlow({
      reason: BUCKET_DEPLOYMENT_REASON,
      logTail,
      neverSucceeds: true,
    });

    const err = await captureError(
      makeProvider().create('Website', 'Custom::CDKBucketDeployment', {
        ServiceToken: SERVICE_TOKEN,
      })
    );

    expect(warnings()).toContain('could not classify the reason');
    expect(warnings()).toContain("KeyError: 'DestinationBucketName'");
    expect(counts.invokes()).toBe(1); // diagnostics only — still no retry
    expect(counts.updates()).toBe(0);
    // ...and the tail stays OUT of the persisted reason.
    expect(err.message).not.toContain('KeyError');
    expect(err.message).not.toContain('Traceback');
  });

  it('discloses that the tail is from the DISPATCH invoke, not necessarily the failing one', async () => {
    // For the CDK Provider framework's async pattern the FAILED arrives from the
    // S3 poll and was authored by a later Step-Functions-driven execution, whose
    // log this is not. The message must not present it as THE explanation.
    process.env['CDKD_CR_AUTHZ_MAX_RETRIES'] = '0';
    wireFlow({
      reason: BUCKET_DEPLOYMENT_REASON,
      logTail: 'START RequestId: 1\n[ERROR] something\nEND RequestId: 1',
      neverSucceeds: true,
    });

    await captureError(
      makeProvider().create('Website', 'Custom::CDKBucketDeployment', {
        ServiceToken: SERVICE_TOKEN,
      })
    );

    expect(warnings()).toContain('DISPATCH invocation');
    expect(warnings()).toContain('may have occurred in a later execution');
  });

  it('does NOT dump a tail that is only Lambda boilerplate', async () => {
    // `LogResult` is never absent on a LogType:'Tail' invoke — Lambda always
    // emits START / END / REPORT — so a bare presence check filters nothing and
    // would dump zero-value boilerplate on every unexplained failure.
    process.env['CDKD_CR_AUTHZ_MAX_RETRIES'] = '0';
    const boilerplate = [
      'START RequestId: 6d1f-4c2a Version: $LATEST',
      'END RequestId: 6d1f-4c2a',
      'REPORT RequestId: 6d1f-4c2a\tDuration: 12.34 ms\tBilled Duration: 13 ms\tMemory Size: 128 MB',
      '',
    ].join('\n');
    wireFlow({ reason: BUCKET_DEPLOYMENT_REASON, logTail: boilerplate, neverSucceeds: true });

    await captureError(
      makeProvider().create('Website', 'Custom::CDKBucketDeployment', {
        ServiceToken: SERVICE_TOKEN,
      })
    );

    expect(warnings()).not.toContain('could not classify the reason');
  });

  it('caps the unexplained-failure tail as well', async () => {
    process.env['CDKD_CR_AUTHZ_MAX_RETRIES'] = '0';
    const huge = `START RequestId: 1\n${'z'.repeat(4000)} TAIL_MARKER_PAST_CAP\nEND RequestId: 1`;
    wireFlow({ reason: BUCKET_DEPLOYMENT_REASON, logTail: huge, neverSucceeds: true });

    await captureError(
      makeProvider().create('Website', 'Custom::CDKBucketDeployment', {
        ServiceToken: SERVICE_TOKEN,
      })
    );

    const w = warnings();
    expect(w).toContain('could not classify the reason');
    expect(w).not.toContain('TAIL_MARKER_PAST_CAP');
    expect(w.length).toBeLessThan(huge.length);
  });

  it('does NOT dump the tail when the reason already named the cause (#756 path)', async () => {
    // Noise guard: the reason explains the failure, so the tail adds nothing.
    process.env['CDKD_CR_AUTHZ_MAX_RETRIES'] = '0';
    wireFlow({ reason: AUTHZ_REASON, logTail: BUCKET_DEPLOYMENT_LOG_TAIL, neverSucceeds: true });

    await captureError(
      makeProvider().create('Website', 'Custom::CDKBucketDeployment', {
        ServiceToken: SERVICE_TOKEN,
      })
    );

    expect(warnings()).not.toContain('could not classify the reason');
  });

  it('does NOT dump the tail beside the signal annotation either', async () => {
    process.env['CDKD_CR_AUTHZ_MAX_RETRIES'] = '0';
    wireFlow({
      reason: BUCKET_DEPLOYMENT_REASON,
      logTail: BUCKET_DEPLOYMENT_LOG_TAIL,
      neverSucceeds: true,
    });

    await captureError(
      makeProvider().create('Website', 'Custom::CDKBucketDeployment', {
        ServiceToken: SERVICE_TOKEN,
      })
    );

    expect(warnings()).not.toContain('could not classify the reason');
  });

  it('does NOT dump a tail on SUCCESS', async () => {
    mockS3Send.mockImplementation((cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'GetObjectCommand') {
        return Promise.resolve({
          Body: {
            transformToString: () =>
              Promise.resolve(JSON.stringify({ Status: 'SUCCESS', PhysicalResourceId: 'ok' })),
          },
        });
      }
      return Promise.resolve({});
    });
    mockLambdaSend.mockImplementation(
      (cmd: { constructor: { name: string }; input?: { LogType?: string } }) => {
        if (cmd.constructor.name === 'InvokeCommand') {
          return Promise.resolve({
            Payload: Buffer.from('null'),
            ...(cmd.input?.LogType === 'Tail'
              ? { LogResult: b64(BUCKET_DEPLOYMENT_LOG_TAIL) }
              : {}),
          });
        }
        return Promise.resolve({
          Configuration: { State: 'Active', LastUpdateStatus: 'Successful' },
        });
      }
    );

    const result = await makeProvider().create('Website', 'Custom::CDKBucketDeployment', {
      ServiceToken: SERVICE_TOKEN,
    });

    expect(result.physicalId).toBe('ok');
    expect(warnings()).not.toContain('could not classify the reason');
  });

  it('leaves the SNS-backed path (no Lambda invoke, no log tail) working', async () => {
    mockSnsSend.mockImplementation(() => Promise.resolve({}));
    mockS3Send.mockImplementation((cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'GetObjectCommand') {
        return Promise.resolve({
          Body: {
            transformToString: () =>
              Promise.resolve(
                JSON.stringify({ Status: 'SUCCESS', PhysicalResourceId: 'sns-phys', Data: {} })
              ),
          },
        });
      }
      return Promise.resolve({});
    });

    const result = await makeProvider().create('SnsResource', 'Custom::SnsResource', {
      ServiceToken: SNS_SERVICE_TOKEN,
    });

    expect(result.physicalId).toBe('sns-phys');
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });
});

describe('findTransientAuthzLogLine classification', () => {
  const probe = new CustomResourceProvider({ responseBucket: 't' }) as unknown as LogTailProbe;

  it('returns the matching LINE and the cdkd-authored SIGNAL that matched', () => {
    expect(probe.findTransientAuthzLogLine(BUCKET_DEPLOYMENT_LOG_TAIL)).toEqual({
      line: DENIAL_LINE,
      signal: 'an error occurred (403)',
    });
  });

  it('strips a CRLF line ending from the returned line', () => {
    expect(probe.findTransientAuthzLogLine(`START\r\n${DENIAL_LINE}\r\nEND`)?.line).toBe(
      DENIAL_LINE
    );
  });

  it('returns the FIRST matching line when several match', () => {
    const tail = [
      'START RequestId: 1',
      DENIAL_LINE,
      'AccessDeniedException: a later, different denial',
      'END RequestId: 1',
    ].join('\n');
    expect(probe.findTransientAuthzLogLine(tail)?.line).toBe(DENIAL_LINE);
  });

  it.each([
    [DENIAL_LINE, 'an error occurred (403)'],
    [
      'An error occurred (AccessDenied) when calling the GetObject operation: Access Denied',
      'accessdenied',
    ],
    [
      'AccessDeniedException: User: arn:aws:sts::1:assumed-role/r/s is not authorized to perform: s3:GetObject',
      'not authorized to perform',
    ],
    [
      'botocore.exceptions.ClientError: ... no identity-based policy allows the s3:GetObject action',
      'no identity-based policy allows',
    ],
  ])('matches the CLI / SDK spellings of a denial: %s', (line, signal) => {
    expect(probe.findTransientAuthzLogLine(line)).toEqual({ line, signal });
  });

  it.each([
    undefined,
    '',
    'START RequestId: 6d1f-4c2a Version: $LATEST',
    "[ERROR] KeyError: 'Bucket'",
    '[INFO] downloading 403 objects from the source bucket',
    'HTTP/1.1 403 (upstream service rejected the request)',
    // Bare `forbidden` is deliberately NOT a signal — it would match a handler
    // logging an unrelated downstream refusal. Without this case, ADDING it to
    // CR_TRANSIENT_AUTHZ_LOG_SIGNALS would be caught by nothing, since the
    // canonical denial line happens to end in ': Forbidden'.
    'PermissionError: the upstream API replied Forbidden',
    'REPORT Duration: 1500.00 ms Billed Duration: 1500 ms',
  ])('does NOT match non-denial log noise: %s', (tail) => {
    expect(probe.findTransientAuthzLogLine(tail)).toBeUndefined();
  });
});
