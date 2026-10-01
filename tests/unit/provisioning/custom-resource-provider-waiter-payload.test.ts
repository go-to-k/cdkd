import { inspect } from 'node:util';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// Issue #4255: a failed backing-Lambda readiness waiter must not relay the
// `GetFunction` response it polled — `Configuration.Environment.Variables` in
// plaintext and the presigned `Code.Location` — into the thrown message, its
// `cause`, the persisted `deployments/*.jsonl` error, or the recycle path's
// debug line.
//
// The REAL `@smithy/util-waiter` runs here (`@aws-sdk/client-lambda` is NOT
// mocked): the subject is the message that waiter builds, so a hand-written
// copy of it would only test the copy. Only the client's `send` is faked, and
// fake timers carry the 600s budget to its TIMEOUT.
const mockLambdaSend = vi.fn();
const mockSnsSend = vi.fn();
const mockS3Send = vi.fn();
const mockStsSend = vi.fn(() => Promise.resolve({ Account: '123456789012' }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockLambdaSend },
    sns: { send: mockSnsSend },
    s3: { send: mockS3Send },
    sts: { send: mockStsSend },
  }),
}));

const debugSpy = vi.fn();
vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: (...args: unknown[]) => debugSpy(...args),
    info: vi.fn(),
    warn: vi.fn(),
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
import { extractDeploymentEventError } from '../../../src/types/deployment-events.js';
import { formatError, ProvisioningError } from '../../../src/utils/error-handler.js';

const SERVICE_TOKEN =
  'arn:aws:lambda:us-east-1:123456789012:function:Stack-ProviderframeworkonEvent';

/**
 * A secret carrying `"`, `\` and a newline: `JSON.stringify` rewrites every one
 * of them, so its escaped spellings are asserted absent too — a literal masker
 * would miss exactly those.
 */
const SECRET = 'hunter2"quote\\slash\nline';
const ESCAPED_ONCE = JSON.stringify(SECRET).slice(1, -1);
const ESCAPED_TWICE = JSON.stringify(ESCAPED_ONCE).slice(1, -1);
const PRESIGNED = 'https://awslambda-us-east-1-tasks.s3.amazonaws.com/snapshots/x?X-Amz-Signature=deadbeef';
const LEAK_NEEDLES = [SECRET, ESCAPED_ONCE, ESCAPED_TWICE, 'DB_PASSWORD', 'X-Amz-Signature', PRESIGNED];

/** A `GetFunction` output with the given status fields and the payload to withhold. */
function getFunctionOutput(
  config: Record<string, string>,
  metadata?: { httpStatusCode: number }
): Record<string, unknown> {
  return {
    Configuration: {
      FunctionName: 'Stack-ProviderframeworkonEvent',
      ...config,
      Environment: { Variables: { DB_PASSWORD: SECRET } },
    },
    Code: { RepositoryType: 'S3', Location: PRESIGNED },
    ...(metadata === undefined ? {} : { $metadata: metadata }),
  };
}

function causeChain(error: Error): Error[] {
  const out: Error[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current instanceof Error; depth++) {
    out.push(current);
    current = current.cause;
  }
  return out;
}

/** Every text a failure reaches: the message, each cause, and the renderers of each. */
function everyRendering(error: Error): string[] {
  const out: string[] = causeChain(error).flatMap((e) => [e.message, String(e.stack)]);
  // What the deploy engine builds around a provider throw, and its renderers:
  // `formatError`'s `Caused by:` line and the CLI's fatal `util.inspect`.
  const wrapped = new ProvisioningError(
    error.message,
    'Custom::CrResource',
    'CrResource',
    undefined,
    error
  );
  out.push(formatError(wrapped), inspect(wrapped, { depth: 10 }));
  out.push(JSON.stringify(extractDeploymentEventError(wrapped)));
  return out;
}

function expectNoLeak(texts: string[]): void {
  for (const text of texts) {
    for (const needle of LEAK_NEEDLES) {
      expect(text).not.toContain(needle);
    }
  }
}

/**
 * Lambda answers the readiness waiters through `getFunction`; the placeholder
 * `PutObject` succeeds. Nothing is ever invoked in the waiter cases.
 */
function wire(getFunction: () => Promise<unknown>): { invokes: () => number } {
  let invokes = 0;
  mockS3Send.mockImplementation(() => Promise.resolve({}));
  mockLambdaSend.mockImplementation((cmd: { constructor: { name: string } }) => {
    if (cmd.constructor.name === 'InvokeCommand') {
      invokes += 1;
      return Promise.resolve({ Payload: Buffer.from('null') });
    }
    return getFunction();
  });
  return { invokes: () => invokes };
}

function makeProvider(): CustomResourceProvider {
  return new CustomResourceProvider({
    responseBucket: 'test-bucket',
    asyncResponseTimeoutMs: 10_000,
  });
}

/** Run `create()` to its rejection, advancing fake time past the 600s waiter budget. */
async function createRejection(): Promise<Error> {
  const provider = makeProvider();
  const settled = provider
    .create('CrResource', 'Custom::CrResource', { ServiceToken: SERVICE_TOKEN })
    .then(
      () => undefined,
      (e: unknown) => e
    );
  await vi.advanceTimersByTimeAsync(700_000);
  const error = await settled;
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

describe('CustomResourceProvider readiness-waiter payload withholding (issue #4255)', () => {
  beforeEach(() => {
    mockLambdaSend.mockReset();
    mockSnsSend.mockReset();
    mockS3Send.mockReset();
    debugSpy.mockReset();
  });

  describe('real waiter, fake time', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('a TIMEOUT whose observed key is the serialized response withholds it, keeping the status fields', async () => {
      // A response without `$metadata.httpStatusCode` is keyed by
      // `JSON.stringify(response)` — the whole payload, one escape deeper.
      // Two distinct observed keys: the FIRST-SEEN latest one must win, so the
      // key order is pinned (`Creating` first, `Restoring` on every later poll).
      let polls = 0;
      const counts = wire(() => {
        polls += 1;
        return Promise.resolve(
          getFunctionOutput({
            State: 'Pending',
            StateReasonCode: polls === 1 ? 'Creating' : 'Restoring',
          })
        );
      });

      const error = await createRejection();

      expect(error.message).toContain('did not reach a ready state for Invoke');
      expect(error.message).toContain('TimeoutError (waiter TIMEOUT: Waiter has timed out');
      expect(error.message).toContain('State=Pending');
      expect(error.message).toContain('StateReasonCode=Restoring');
      expect(error.message).not.toContain('StateReasonCode=Creating');
      expect(error.message).toContain('2 observed response(s) withheld');
      expectNoLeak(everyRendering(error));
      // The caught waiter error stays in the cause chain, rewritten in place.
      const waiterError = causeChain(error).find((e) => e.name === 'TimeoutError');
      expect(waiterError?.message).toMatch(/^TimeoutError \(waiter TIMEOUT/);
      expect(waiterError?.message).toContain('StateReasonCode=Restoring');
      expect(counts.invokes()).toBe(0);
    });

    it('a TIMEOUT reports a 403 by status and class, and AWS\'s identity-bearing sentence only at debug', async () => {
      // `aws-failure-text.ts` (issue #2302): an AWS `AccessDenied` names the
      // caller's account, role and session, so the thrown (persisted) text
      // carries its class and the sentence goes to `logger.debug`.
      const denial =
        'User: arn:aws:sts::123456789012:assumed-role/DeployRole/session is not authorized ' +
        `to perform: lambda:GetFunction on resource: ${SERVICE_TOKEN}`;
      const counts = wire(() =>
        Promise.reject(
          Object.assign(new Error(denial), {
            name: 'AccessDeniedException',
            $metadata: { httpStatusCode: 403 },
          })
        )
      );

      const error = await createRejection();

      expect(error.message).toMatch(
        /observed: \(x\d+\) 403: AccessDeniedException\. Re-run with --verbose/
      );
      for (const text of everyRendering(error)) {
        expect(text).not.toContain('assumed-role/DeployRole/session');
        expect(text).not.toContain('123456789012:assumed-role');
      }
      const debugged = debugSpy.mock.calls.map((c) => c.map(String).join(' '));
      expect(debugged.some((line) => line.includes(denial))).toBe(true);
      // Not replayed: the waiter already spent its budget (issue #2033).
      expect(counts.invokes()).toBe(0);
    });

    it('a TIMEOUT keeps the `200: OK` line the real Lambda client produces, withholding nothing else', async () => {
      // Measured: the real `LambdaClient` stamps `$metadata.httpStatusCode` on
      // every output, so a Pending poll is keyed `200: OK`.
      wire(() => Promise.resolve(getFunctionOutput({ State: 'Pending' }, { httpStatusCode: 200 })));

      const error = await createRejection();

      expect(error.message).toMatch(/observed: \(x\d+\) 200: OK/);
      expect(error.message).not.toContain('observed response(s) withheld');
      expectNoLeak(everyRendering(error));
    });

    /**
     * The rejection the SDK raises for a truncated `GetFunction` body: V8's
     * `JSON.parse` `SyntaxError`, whose message quotes ~10 characters either
     * side of the error position — here the tail of the secret.
     */
    function truncatedBodyRejection(metadata: boolean): { error: Error; message: string } {
      const body = '{"Configuration":{"Environment":{"Variables":{"DB_PASSWORD":"tailsecretvalue","X":@}}}}';
      let parseError: Error = new Error('unreachable');
      try {
        JSON.parse(body);
      } catch (e) {
        parseError = e as Error;
      }
      const message = parseError.message;
      Object.assign(parseError, {
        $responseBodyText: body,
        ...(metadata ? { $metadata: { httpStatusCode: 200 } } : {}),
      });
      return { error: parseError, message };
    }

    for (const metadata of [true, false]) {
      it(`a TIMEOUT reports a deserialization failure by status and name only (${metadata ? 'with' : 'without'} $metadata)`, async () => {
        // With `$metadata` it is AWS-authored and `describeAwsFailure` would
        // put the parse message at debug; without, it would pass the message
        // through into the thrown text. Either way the message quotes the body.
        const { error: rejection, message } = truncatedBodyRejection(metadata);
        // The fragment V8 quotes: the secret's last characters.
        const fragment = 'alue","X":@';
        expect(message).toContain(fragment);
        wire(() => Promise.reject(rejection));

        const error = await createRejection();

        expect(error.message).toMatch(
          metadata
            ? /observed: \(x\d+\) 200: SyntaxError \(response body withheld\)/
            : /observed: \(x\d+\) SyntaxError \(response body withheld\)/
        );
        const debugged = debugSpy.mock.calls.map((c) => c.map(String).join(' '));
        for (const text of [...everyRendering(error), ...debugged]) {
          expect(text).not.toContain(fragment);
          expect(text).not.toContain(message);
          expect(text).not.toContain('DB_PASSWORD');
        }
      });
    }

    it('a TIMEOUT counts a non-Error rejection it cannot classify', async () => {
      wire(() => Promise.reject('DB_PASSWORD=plain-string-rejection'));

      const error = await createRejection();

      expect(error.message).toMatch(/\d+ non-Error rejection\(s\) withheld/);
      expect(error.message).not.toContain('plain-string-rejection');
    });

    it('a TIMEOUT keeps a transport failure\'s own wording', async () => {
      // A rejection with no HTTP status (no deserialized response) is not
      // AWS-authored, so `describeAwsFailure` passes it through: on a 600s
      // wait, `socket hang up` is the diagnosis. (A credential failure is
      // AWS-authored there, as `CredentialsProviderError`, and summarized.)
      wire(() => Promise.reject(new Error('socket hang up')));

      const error = await createRejection();

      expect(error.message).toMatch(/observed: \(x\d+\) socket hang up/);
      expect(error.message).not.toContain('observed error message(s) withheld');
    });

    it('a TIMEOUT summarizes a credential failure by class, its text only at debug', async () => {
      // `CredentialsProviderError` is AWS-authored by name (`aws-failure-text.ts`):
      // its message can interpolate a credential_process helper's argv and stderr.
      const body = 'Could not load credentials: helper --token=cred-body-marker exited 1';
      wire(() =>
        Promise.reject(Object.assign(new Error(body), { name: 'CredentialsProviderError' }))
      );

      const error = await createRejection();

      expect(error.message).toMatch(
        /observed: \(x\d+\) CredentialsProviderError\. Re-run with --verbose for AWS's own message\./
      );
      for (const text of everyRendering(error)) expect(text).not.toContain('cred-body-marker');
      const debugged = debugSpy.mock.calls.map((c) => c.map(String).join(' '));
      expect(debugged.some((line) => line.includes(body))).toBe(true);
    });

    it('a TIMEOUT flattens a multi-line transport message to one line', async () => {
      // A pass-through summary is free text; a newline in it must not start a
      // line of its own in the thrown (persisted) message.
      wire(() => Promise.reject(new Error('socket hang up\n2026-01-01 ERROR forged row')));

      const error = await createRejection();

      expect(error.message).toContain('socket hang up');
      expect(error.message).toContain('forged row');
      expect(error.message).not.toContain('\n');
    });

    it('a FAILURE (State: Failed) withholds the response and its cause, keeping the status fields', async () => {
      wire(() =>
        Promise.resolve(
          getFunctionOutput(
            {
              State: 'Failed',
              StateReasonCode: 'SubnetOutOfIPAddresses',
              StateReason: 'The function could not create an ENI',
            },
            { httpStatusCode: 200 }
          )
        )
      );

      const error = await createRejection();

      expect(error.message).toContain('Error (waiter FAILURE;');
      expect(error.message).toContain('State=Failed');
      expect(error.message).toContain('StateReasonCode=SubnetOutOfIPAddresses');
      expect(error.message).toContain('StateReason=The function could not create an ENI');
      expectNoLeak(everyRendering(error));
    });
  });

  describe('the recycle path', () => {
    let savedRetries: string | undefined;
    beforeEach(() => {
      savedRetries = process.env['CDKD_CR_AUTHZ_MAX_RETRIES'];
      process.env['CDKD_CR_AUTHZ_MAX_RETRIES'] = '1';
    });
    afterEach(() => {
      if (savedRetries === undefined) delete process.env['CDKD_CR_AUTHZ_MAX_RETRIES'];
      else process.env['CDKD_CR_AUTHZ_MAX_RETRIES'] = savedRetries;
    });

    /** The recycle debug lines of one create whose first answer is a transient-authz FAILED. */
    async function recycleLines(
      update: () => Promise<unknown>,
      afterUpdate: () => unknown
    ): Promise<string[]> {
      let invokes = 0;
      let updated = false;
      let served = false;
      mockS3Send.mockImplementation((cmd: { constructor: { name: string } }) => {
        if (cmd.constructor.name === 'GetObjectCommand') {
          const body =
            invokes >= 2
              ? { Status: 'SUCCESS', PhysicalResourceId: 'phys-123', Data: {} }
              : {
                  Status: 'FAILED',
                  Reason:
                    'User: arn:aws:sts::123456789012:assumed-role/R/S is not authorized to perform: ' +
                    's3:GetObject on resource: arn:aws:s3:::b/k because no identity-based policy allows the s3:GetObject action',
                };
          return Promise.resolve({
            Body: { transformToString: () => Promise.resolve(JSON.stringify(body)) },
          });
        }
        return Promise.resolve({});
      });
      mockLambdaSend.mockImplementation((cmd: { constructor: { name: string } }) => {
        const name = cmd.constructor.name;
        if (name === 'InvokeCommand') {
          invokes += 1;
          return Promise.resolve({ Payload: Buffer.from('null') });
        }
        if (name === 'UpdateFunctionConfigurationCommand') {
          updated = true;
          return update();
        }
        if (updated && !served) {
          served = true;
          return Promise.resolve(afterUpdate());
        }
        return Promise.resolve({
          Configuration: { State: 'Active', LastUpdateStatus: 'Successful' },
        });
      });

      const result = await makeProvider().create('CrResource', 'Custom::CrResource', {
        ServiceToken: SERVICE_TOKEN,
      });

      expect(result.physicalId).toBe('phys-123');
      return debugSpy.mock.calls
        .map((c) => c.map(String).join(' '))
        .filter((line) => line.includes('Could not recycle backing function'));
    }

    it('does not debug-log a failed update-wait payload', async () => {
      // A transient-authz FAILED recycles the execution environment:
      // `UpdateFunctionConfiguration`, then `waitUntilFunctionUpdatedV2`. That
      // wait answering `LastUpdateStatus: Failed` is a FAILURE whose message is
      // the whole response, and the provider's own logger masks nothing.
      const lines = await recycleLines(
        () => Promise.resolve({}),
        () =>
          getFunctionOutput({
            State: 'Active',
            LastUpdateStatus: 'Failed',
            LastUpdateStatusReasonCode: 'EniLimitExceeded',
          })
      );

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('LastUpdateStatus=Failed');
      expect(lines[0]).toContain('LastUpdateStatusReasonCode=EniLimitExceeded');
      expectNoLeak(lines);
    });

    it('withholds the body fragment of an UpdateFunctionConfiguration that failed to deserialize', async () => {
      // Its response is a `FunctionConfiguration`, environment included, and
      // V8's `JSON.parse` message quotes ~10 characters of it.
      const body = '{"FunctionName":"f","Environment":{"Variables":{"DB_PASSWORD":"tailsecretvalue","X":@}}}';
      let parseError: Error = new Error('unreachable');
      try {
        JSON.parse(body);
      } catch (e) {
        parseError = e as Error;
      }
      const fragment = 'alue","X":@';
      expect(parseError.message).toContain(fragment);
      Object.assign(parseError, { $metadata: { httpStatusCode: 200 }, $responseBodyText: body });

      const lines = await recycleLines(
        () => Promise.reject(parseError),
        () => ({ Configuration: { State: 'Active', LastUpdateStatus: 'Successful' } })
      );

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('SyntaxError (response body withheld)');
      expect(lines[0]).not.toContain(fragment);
    });

    it('keeps the AWS detail of a failed UpdateFunctionConfiguration, even a JSON-shaped one', async () => {
      // Not a waiter error: a JSON message WITHOUT a `state` must not be read
      // as one, so its detail reaches the debug line unchanged.
      const detail = '{"Message":"update-denied-marker"}';
      const lines = await recycleLines(
        () =>
          Promise.reject(
            Object.assign(new Error(detail), {
              name: 'AccessDeniedException',
              $metadata: { httpStatusCode: 403 },
            })
          ),
        () => ({ Configuration: { State: 'Active', LastUpdateStatus: 'Successful' } })
      );

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(detail);
      expect(lines[0]).not.toContain('withheld');
    });
  });
});
