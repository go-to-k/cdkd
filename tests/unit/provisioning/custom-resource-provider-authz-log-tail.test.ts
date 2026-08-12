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

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

interface LogTailProbe {
  findTransientAuthzLogLine(logTail: string | undefined): string | undefined;
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

  it('folds the denial INTO the thrown reason when retries are exhausted', async () => {
    // The post-mortem record (`deployments/*.jsonl`, replayed by `cdkd events`)
    // carries the thrown message — a warn-only surface would still send the
    // user to CloudWatch, which is the complaint the issue filed.
    process.env['CDKD_CR_AUTHZ_MAX_RETRIES'] = '0';
    const counts = wireFlow({
      reason: BUCKET_DEPLOYMENT_REASON,
      logTail: BUCKET_DEPLOYMENT_LOG_TAIL,
      neverSucceeds: true,
    });

    await expect(
      makeProvider().create('Website', 'Custom::CDKBucketDeployment', {
        ServiceToken: SERVICE_TOKEN,
      })
    ).rejects.toThrow(/An error occurred \(403\) when calling the HeadObject operation/);

    expect(counts.invokes()).toBe(1);
  });

  it('keeps the original reason alongside the folded denial', async () => {
    process.env['CDKD_CR_AUTHZ_MAX_RETRIES'] = '0';
    wireFlow({
      reason: BUCKET_DEPLOYMENT_REASON,
      logTail: BUCKET_DEPLOYMENT_LOG_TAIL,
      neverSucceeds: true,
    });

    await expect(
      makeProvider().create('Website', 'Custom::CDKBucketDeployment', {
        ServiceToken: SERVICE_TOKEN,
      })
    ).rejects.toThrow(/returned non-zero exit status 1/);
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

    // Delete is lenient by policy: it warns rather than throwing.
    await makeProvider().delete('Website', 'phys-123', 'Custom::CDKBucketDeployment', {
      ServiceToken: SERVICE_TOKEN,
    });

    expect(warnings()).toContain('An error occurred (403) when calling the HeadObject operation');
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

    await expect(
      makeProvider().create('Website', 'Custom::CDKBucketDeployment', {
        ServiceToken: SERVICE_TOKEN,
      })
    ).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('SECRET_TOKEN') })
    );

    // ...but the diagnostic is still available, ephemerally.
    expect(warnings()).toContain('Backing function log tail');
    expect(warnings()).toContain(DENIAL_LINE);
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

  it('returns the matching LINE, not merely a boolean', () => {
    expect(probe.findTransientAuthzLogLine(BUCKET_DEPLOYMENT_LOG_TAIL)).toBe(DENIAL_LINE);
  });

  it('strips a CRLF line ending from the returned line', () => {
    expect(probe.findTransientAuthzLogLine(`START\r\n${DENIAL_LINE}\r\nEND`)).toBe(DENIAL_LINE);
  });

  it.each([
    DENIAL_LINE,
    'An error occurred (AccessDenied) when calling the GetObject operation: Access Denied',
    'AccessDeniedException: User: arn:aws:sts::1:assumed-role/r/s is not authorized to perform: s3:GetObject',
    'botocore.exceptions.ClientError: ... no identity-based policy allows the s3:GetObject action',
  ])('matches the CLI / SDK spellings of a denial: %s', (line) => {
    expect(probe.findTransientAuthzLogLine(line)).toBe(line);
  });

  it.each([
    undefined,
    '',
    'START RequestId: 6d1f-4c2a Version: $LATEST',
    "[ERROR] KeyError: 'Bucket'",
    '[INFO] downloading 403 objects from the source bucket',
    'HTTP/1.1 403 (upstream service rejected the request)',
    'REPORT Duration: 1500.00 ms Billed Duration: 1500 ms',
  ])('does NOT match non-denial log noise: %s', (tail) => {
    expect(probe.findTransientAuthzLogLine(tail)).toBeUndefined();
  });
});
