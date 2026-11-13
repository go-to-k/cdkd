import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { createHash, createHmac } from 'node:crypto';
import {
  Server as HttpServer,
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
} from 'node:http';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { SignatureV4 } from '@smithy/signature-v4';
import type { AddressInfo } from 'node:net';
import { InvokeCommand, LambdaClient, ListFunctionsCommand } from '@aws-sdk/client-lambda';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';

/**
 * go-to-k/cdkd#6213: the local endpoint a `cr.Provider` framework container
 * calls Lambda / Step Functions through. Requests here are sent by the real
 * AWS SDK clients, as the framework sends them, so the token path prefix and
 * the SigV4 check are exercised as they are in a container.
 */

const wiring = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock('cdk-local/internal', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getActiveWorkloadAwsWiring: () => wiring.value,
}));

const {
  callerReferencedLogicalId,
  forwardToEmulator,
  startSecondHopEndpoint,
  verifySignature,
} = await import('../../../src/local/custom-resource-second-hop.js');
type Deps = Parameters<typeof startSecondHopEndpoint>[0];
type LocalFunction = Parameters<typeof callerReferencedLogicalId>[0];

const CREDS = { accessKeyId: 'EMULATORKEY', secretAccessKey: 'emulator-secret' };
const USER_ARN = 'arn:aws:lambda:us-east-1:000000000000:function:App-UserFn-abc';
const OTHER_ARN = 'arn:aws:lambda:us-east-1:000000000000:function:Elsewhere';
const SM_ARN = 'arn:aws:states:us-east-1:000000000000:stateMachine:App-Waiter-abc';
const IS_COMPLETE_ARN = 'arn:aws:lambda:us-east-1:000000000000:function:App-IsComplete-abc';
const ON_TIMEOUT_ARN = 'arn:aws:lambda:us-east-1:000000000000:function:App-OnTimeout-abc';

const DEFINITION = (a: string, b: string) =>
  `{"StartAt":"check","States":{"check":{"End":true,"Retry":[{"ErrorEquals":["States.ALL"],"IntervalSeconds":1,"MaxAttempts":2,"BackoffRate":1}],"Catch":[{"ErrorEquals":["States.ALL"],"Next":"timeout"}],"Type":"Task","Resource":"${a}"},"timeout":{"End":true,"Type":"Task","Resource":"${b}"}}}`;

const fn = (logicalId: string) => ({
  Type: 'AWS::Lambda::Function',
  Properties: { Handler: 'index.handler', Runtime: 'nodejs22.x', Code: { ZipFile: 'x' } },
  logicalId,
});

function caller(): LocalFunction {
  const resources: Record<string, unknown> = {
    UserFn: fn('UserFn'),
    IsComplete: fn('IsComplete'),
    OnTimeout: fn('OnTimeout'),
    Waiter: {
      Type: 'AWS::StepFunctions::StateMachine',
      Properties: {
        DefinitionString: {
          'Fn::Join': [
            '',
            DEFINITION('@@A@@', '@@B@@')
              .split(/(@@[AB]@@)/)
              .map((part) =>
                part === '@@A@@'
                  ? { 'Fn::GetAtt': ['IsComplete', 'Arn'] }
                  : part === '@@B@@'
                    ? { 'Fn::GetAtt': ['OnTimeout', 'Arn'] }
                    : part
              ),
          ],
        },
      },
    },
    Framework: {
      Type: 'AWS::Lambda::Function',
      Properties: {
        Environment: {
          Variables: {
            USER_ON_EVENT_FUNCTION_ARN: { 'Fn::GetAtt': ['UserFn', 'Arn'] },
            WAITER_STATE_MACHINE_ARN: { Ref: 'Waiter' },
            PLAIN: 'x',
          },
        },
      },
    },
  };
  const stack = { stackName: 'App', region: 'us-east-1', template: { Resources: resources } };
  return {
    lambda: {
      kind: 'zip',
      stack,
      logicalId: 'Framework',
      resource: resources['Framework'],
      runtime: 'nodejs22.x',
    } as never,
    deployed: {
      FunctionArn: 'arn:aws:lambda:us-east-1:000000000000:function:App-Framework-abc',
      Environment: {
        Variables: {
          USER_ON_EVENT_FUNCTION_ARN: USER_ARN,
          WAITER_STATE_MACHINE_ARN: SM_ARN,
          PLAIN: OTHER_ARN,
        },
      },
    },
    forwardPort: 9297,
  };
}

const DEPLOYED_BY_ARN: Record<string, unknown> = {
  [USER_ARN]: { FunctionArn: USER_ARN, Handler: 'index.handler', Runtime: 'nodejs22.x' },
  [IS_COMPLETE_ARN]: { FunctionArn: IS_COMPLETE_ARN, Handler: 'index.handler', Runtime: 'nodejs22.x' },
  [ON_TIMEOUT_ARN]: { FunctionArn: ON_TIMEOUT_ARN, Handler: 'index.handler', Runtime: 'nodejs22.x' },
};

let deps: { [K in keyof Deps]-?: ReturnType<typeof vi.fn> } & { emulatorCredentials: typeof CREDS };
let endpoint: Awaited<ReturnType<typeof startSecondHopEndpoint>>;
let registration: { url: string; port: number; release(): void };

function lambdaClient(url = registration.url, credentials = CREDS) {
  return new LambdaClient({ region: 'us-east-1', endpoint: url, credentials, maxAttempts: 1 });
}

beforeEach(async () => {
  deps = {
    getFunctionConfiguration: vi.fn((name: string) => Promise.resolve(DEPLOYED_BY_ARN[name])),
    chooseFunction: vi.fn((c: LocalFunction, logicalId: string) => ({
      lambda: {
        ...c.lambda,
        logicalId,
        resource: (c.lambda.stack.template.Resources as Record<string, unknown>)[logicalId],
      },
    })),
    imageAvailable: vi.fn(() => Promise.resolve(true)),
    runLocally: vi.fn(() =>
      Promise.resolve({ StatusCode: 200, Payload: Buffer.from('{"ok":true}'), LogResult: 'bG9n' })
    ),
    forward: vi.fn(() =>
      Promise.resolve({ status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"Functions":[]}') })
    ),
    sleep: vi.fn(() => Promise.resolve()),
    containerGateway: vi.fn(() => Promise.resolve(undefined)),
    emulatorCredentials: CREDS,
  } as never;
  endpoint = await startSecondHopEndpoint(deps as unknown as Deps);
  registration = endpoint.register(caller());
});

afterEach(async () => {
  await endpoint.close();
});

describe('who may call it', () => {
  it('serves on the loopback with a per-container token in the path', () => {
    expect(registration.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${registration.port}/[0-9a-f]{64}$`));
    expect(endpoint.register(caller()).url).not.toBe(registration.url);
  });

  it('refuses an unknown token, and a released one', async () => {
    const bogus = registration.url.replace(/[0-9a-f]{64}$/, '0'.repeat(64));
    await expect(lambdaClient(bogus).send(new ListFunctionsCommand({}))).rejects.toMatchObject({
      $metadata: { httpStatusCode: 403 },
    });
    registration.release();
    await expect(lambdaClient().send(new ListFunctionsCommand({}))).rejects.toMatchObject({
      $metadata: { httpStatusCode: 403 },
    });
    expect(deps.forward).not.toHaveBeenCalled();
  });

  it('refuses a request not signed with the emulator key', async () => {
    const wrongKey = { accessKeyId: 'EMULATORKEY', secretAccessKey: 'not-the-secret' };
    await expect(
      lambdaClient(registration.url, wrongKey).send(
        new InvokeCommand({ FunctionName: USER_ARN, Payload: Buffer.from('{}') })
      )
    ).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
    const otherId = { accessKeyId: 'AKIAREALKEY', secretAccessKey: 'emulator-secret' };
    await expect(
      lambdaClient(registration.url, otherId).send(new ListFunctionsCommand({}))
    ).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
    expect(deps.runLocally).not.toHaveBeenCalled();
    expect(deps.forward).not.toHaveBeenCalled();
  });
});

describe('Invoke', () => {
  it('runs a function the caller references locally and answers like Lambda', async () => {
    const out = await lambdaClient().send(
      new InvokeCommand({ FunctionName: USER_ARN, Payload: Buffer.from('{"RequestType":"Create"}'), LogType: 'Tail' })
    );
    expect(Buffer.from(out.Payload!).toString()).toBe('{"ok":true}');
    expect(out.LogResult).toBe('bG9n');
    expect(out.FunctionError).toBeUndefined();
    expect(deps.runLocally).toHaveBeenCalledTimes(1);
    const [target, event] = deps.runLocally.mock.calls[0]! as [LocalFunction, unknown];
    expect(target.lambda.logicalId).toBe('UserFn');
    expect(target.deployed).toBe(DEPLOYED_BY_ARN[USER_ARN]);
    expect(target.forwardPort).toBe(9297);
    expect(event).toEqual({ RequestType: 'Create' });
    expect(deps.forward).not.toHaveBeenCalled();
  });

  it('reports the runtime error as FunctionError', async () => {
    deps.runLocally.mockResolvedValueOnce({
      StatusCode: 200,
      FunctionError: 'Unhandled',
      Payload: Buffer.from('{"errorType":"Error","errorMessage":"boom"}'),
    });
    const out = await lambdaClient().send(new InvokeCommand({ FunctionName: USER_ARN }));
    expect(out.FunctionError).toBe('Unhandled');
  });

  it('forwards a function the caller does not reference by Fn::GetAtt / Ref', async () => {
    await lambdaClient().send(new InvokeCommand({ FunctionName: OTHER_ARN }));
    expect(deps.runLocally).not.toHaveBeenCalled();
    expect(deps.forward).toHaveBeenCalledTimes(1);
  });

  it('forwards an asynchronous or qualified invoke, and every other Lambda call', async () => {
    await lambdaClient().send(new InvokeCommand({ FunctionName: USER_ARN, InvocationType: 'Event' }));
    await lambdaClient().send(new InvokeCommand({ FunctionName: USER_ARN, Qualifier: '3' }));
    await lambdaClient().send(new ListFunctionsCommand({}));
    expect(deps.runLocally).not.toHaveBeenCalled();
    expect(deps.forward).toHaveBeenCalledTimes(3);
    const listCall = deps.forward.mock.calls[2]![0] as { service: string; path: string; method: string };
    expect(listCall).toMatchObject({ service: 'lambda', method: 'GET', path: '/2015-03-31/functions' });
  });

  it('forwards when the deployed function does not match the assembly', async () => {
    deps.chooseFunction.mockReturnValueOnce({ reason: 'handler differs' });
    await lambdaClient().send(new InvokeCommand({ FunctionName: USER_ARN }));
    expect(deps.runLocally).not.toHaveBeenCalled();
    expect(deps.forward).toHaveBeenCalledTimes(1);
  });
});

describe('StartExecution of the cr.Provider waiter', () => {
  const sfn = () =>
    new SFNClient({ region: 'us-east-1', endpoint: registration.url, credentials: CREDS, maxAttempts: 1 });

  beforeEach(() => {
    deps.forward.mockImplementation((req: { headers: Record<string, string> }) =>
      Promise.resolve(
        req.headers['x-amz-target'] === 'AWSStepFunctions.DescribeStateMachine'
          ? {
              status: 200,
              headers: {},
              body: Buffer.from(JSON.stringify({ definition: DEFINITION(IS_COMPLETE_ARN, ON_TIMEOUT_ARN) })),
            }
          : { status: 400, headers: {}, body: Buffer.from('{}') }
      )
    );
  });

  it('runs the state machine locally: retries, then the timeout task with { Error, Cause }', async () => {
    const cause = '{"errorType":"Retry","errorMessage":"{}"}';
    deps.runLocally.mockImplementation((target: LocalFunction) =>
      Promise.resolve(
        target.lambda.logicalId === 'IsComplete'
          ? { StatusCode: 200, FunctionError: 'Unhandled', Payload: Buffer.from(cause) }
          : { StatusCode: 200, Payload: Buffer.from('null') }
      )
    );
    const out = await sfn().send(
      new StartExecutionCommand({ stateMachineArn: SM_ARN, input: '{"RequestType":"Create"}' })
    );
    expect(out.executionArn).toMatch(
      /^arn:aws:states:us-east-1:000000000000:execution:App-Waiter-abc:[0-9a-f-]{36}$/
    );
    await vi.waitFor(() => expect(deps.runLocally).toHaveBeenCalledTimes(4));
    const calls = deps.runLocally.mock.calls as [LocalFunction, unknown][];
    expect(calls.map(([t]) => t.lambda.logicalId)).toEqual(['IsComplete', 'IsComplete', 'IsComplete', 'OnTimeout']);
    expect(calls[0]![1]).toEqual({ RequestType: 'Create' });
    expect(calls[3]![1]).toEqual({ Error: 'Retry', Cause: cause });
    expect(calls.every(([t]) => t.forwardPort === 9297)).toBe(true);
    // Only DescribeStateMachine went to the emulator.
    expect(deps.forward).toHaveBeenCalledTimes(1);
  });

  it('starts it on the emulator when the deployed definition does not match', async () => {
    deps.forward.mockImplementationOnce(() =>
      Promise.resolve({
        status: 200,
        headers: {},
        body: Buffer.from(
          JSON.stringify({ definition: DEFINITION(IS_COMPLETE_ARN, ON_TIMEOUT_ARN).replace('"MaxAttempts":2', '"MaxAttempts":9') })
        ),
      })
    );
    await sfn()
      .send(new StartExecutionCommand({ stateMachineArn: SM_ARN, input: '{}' }))
      .catch(() => undefined);
    expect(deps.runLocally).not.toHaveBeenCalled();
    const targets = deps.forward.mock.calls.map((c) => (c[0] as { headers: Record<string, string> }).headers['x-amz-target']);
    expect(targets).toEqual(['AWSStepFunctions.DescribeStateMachine', 'AWSStepFunctions.StartExecution']);
  });
});

describe('callerReferencedLogicalId', () => {
  it('needs the deployed value AND a Fn::GetAtt / Ref of the right type in the template', () => {
    const c = caller();
    expect(callerReferencedLogicalId(c, USER_ARN, 'AWS::Lambda::Function')).toBe('UserFn');
    expect(callerReferencedLogicalId(c, `${USER_ARN}:$LATEST`, 'AWS::Lambda::Function')).toBe('UserFn');
    expect(callerReferencedLogicalId(c, SM_ARN, 'AWS::StepFunctions::StateMachine')).toBe('Waiter');
    // The right value under a variable that is a plain string in the template.
    expect(callerReferencedLogicalId(c, OTHER_ARN, 'AWS::Lambda::Function')).toBeUndefined();
    // A reference of another type.
    expect(callerReferencedLogicalId(c, SM_ARN, 'AWS::Lambda::Function')).toBeUndefined();
  });
});

describe('forwardToEmulator', () => {
  let emulator: Server;
  let received: { req: IncomingMessage; body: Buffer } | undefined;
  let emulatorUrl: string;

  beforeEach(async () => {
    received = undefined;
    emulator = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received = { req, body: Buffer.concat(chunks) };
        res.writeHead(201, { 'x-amzn-requestid': 'r1', connection: 'close' }).end('{"a":1}');
      });
    });
    await new Promise<void>((r) => emulator.listen(0, '127.0.0.1', r));
    emulatorUrl = `http://127.0.0.1:${(emulator.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => emulator.close(() => r()));
  });

  const request = () => ({
    service: 'lambda',
    region: 'us-east-1',
    method: 'POST',
    path: '/2015-03-31/functions/x%3Ay/invocations',
    query: { Qualifier: 'a b' },
    headers: {
      authorization: 'AWS4-HMAC-SHA256 Credential=CALLER/20260101/us-east-1/lambda/aws4_request, SignedHeaders=host, Signature=00',
      host: '127.0.0.1:1',
      'x-amz-date': '20260101T000000Z',
      'x-amz-invocation-type': 'RequestResponse',
    },
    body: Buffer.from('{"p":1}'),
  });

  it('signs again with the emulator key and sends to the emulator only', async () => {
    wiring.value = { mode: 'emulator', emulatorEndpoint: { url: emulatorUrl }, emulatorCredentials: CREDS };
    const out = await forwardToEmulator(request());
    expect(out.status).toBe(201);
    expect(out.headers['x-amzn-requestid']).toBe('r1');
    expect(out.headers['connection']).toBeUndefined();
    const { req, body } = received!;
    expect(req.headers.host).toBe(new URL(emulatorUrl).host);
    expect(req.headers.authorization).toContain('Credential=EMULATORKEY/');
    expect(req.headers['x-amz-invocation-type']).toBe('RequestResponse');
    expect(body.toString()).toBe('{"p":1}');
    const [path, qs] = req.url!.split('?');
    expect(qs).toBe('Qualifier=a%20b');
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
    await expect(
      verifySignature({ method: 'POST', path: path!, query: { Qualifier: 'a b' }, headers, body }, CREDS)
    ).resolves.toBe(true);
  });

  it('refuses without full emulator wiring and its credentials', async () => {
    wiring.value = { mode: 'forward', emulatorEndpoint: { url: emulatorUrl }, emulatorCredentials: CREDS };
    await expect(forwardToEmulator(request())).rejects.toThrow(/no AWS Emulator wiring/);
    wiring.value = { mode: 'emulator', emulatorEndpoint: { url: emulatorUrl } };
    await expect(forwardToEmulator(request())).rejects.toThrow(/no AWS Emulator wiring/);
    expect(received).toBeUndefined();
  });
});

class TestSha256 {
  private h: ReturnType<typeof createHash> | ReturnType<typeof createHmac>;
  private readonly secret: unknown;
  constructor(secret?: unknown) {
    this.secret = secret;
    this.h = this.fresh();
  }
  private fresh() {
    return this.secret === undefined
      ? createHash('sha256')
      : createHmac('sha256', Buffer.from(this.secret as Uint8Array | string));
  }
  update(d: string | Uint8Array): void {
    this.h.update(typeof d === 'string' ? Buffer.from(d) : Buffer.from(d));
  }
  digest(): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(this.h.digest()));
  }
  reset(): void {
    this.h = this.fresh();
  }
}

/** A raw request to the endpoint, signed over `signedBody` and sent with `sentBody`. */
async function rawInvoke(opts: {
  signedBody: string;
  sentBody?: string;
  date?: Date;
  contentSha?: string;
  dropHeader?: string;
  addHeaders?: Record<string, string>;
}): Promise<number> {
  const url = new URL(registration.url);
  const path = `${url.pathname}/2015-03-31/functions/${encodeURIComponent(USER_ARN)}/invocations`;
  const headers: Record<string, string> = {
    host: url.host,
    'content-type': 'application/json',
  };
  if (opts.contentSha !== undefined) {
    headers['x-amz-content-sha256'] =
      opts.contentSha === 'computed'
        ? createHash('sha256').update(opts.signedBody).digest('hex')
        : opts.contentSha;
  }
  const signer = new SignatureV4({
    credentials: CREDS,
    region: 'us-east-1',
    service: 'lambda',
    sha256: TestSha256 as never,
    applyChecksum: false,
  });
  const signed = await signer.sign(
    {
      method: 'POST',
      protocol: 'http:',
      hostname: url.hostname,
      port: Number(url.port),
      path,
      query: {},
      headers,
      body: opts.signedBody,
    },
    opts.date === undefined ? {} : { signingDate: opts.date }
  );
  const sent: Record<string, string> = { ...signed.headers };
  if (opts.dropHeader !== undefined) delete sent[opts.dropHeader];
  Object.assign(sent, opts.addHeaders);
  const body = opts.sentBody ?? opts.signedBody;
  return new Promise((resolveStatus, reject) => {
    const r = httpRequest(
      { host: url.hostname, port: Number(url.port), method: 'POST', path, headers: sent },
      (res) => {
        res.resume();
        resolveStatus(res.statusCode ?? 0);
      }
    );
    r.on('error', reject);
    r.end(body);
  });
}

describe('the signature check covers the body and the date (review S1)', () => {
  it('accepts a request signed over the body it carries', async () => {
    expect(await rawInvoke({ signedBody: '{"RequestType":"Create"}' })).toBe(200);
    expect(await rawInvoke({ signedBody: '{"a":1}', contentSha: 'computed' })).toBe(200);
  });

  it('refuses a captured signature replayed with another body', async () => {
    expect(
      await rawInvoke({
        signedBody: '{"RequestType":"Create"}',
        sentBody: '{"RequestType":"Delete"}',
        contentSha: 'computed',
      })
    ).toBe(403);
    expect(
      await rawInvoke({
        signedBody: '{"RequestType":"Create"}',
        sentBody: '{"RequestType":"Delete"}',
      })
    ).toBe(403);
    expect(deps.runLocally).not.toHaveBeenCalled();
  });

  it('refuses an unsigned x-amz-content-sha256 that is not the body hash', async () => {
    expect(
      await rawInvoke({
        signedBody: '{}',
        addHeaders: { 'x-amz-content-sha256': createHash('sha256').update('other').digest('hex') },
      })
    ).toBe(403);
  });

  it('refuses UNSIGNED-PAYLOAD', async () => {
    expect(await rawInvoke({ signedBody: '{}', contentSha: 'UNSIGNED-PAYLOAD' })).toBe(403);
  });

  it('refuses a date outside 15 minutes, and a missing x-amz-date', async () => {
    expect(await rawInvoke({ signedBody: '{}', date: new Date(Date.now() - 20 * 60_000) })).toBe(
      403
    );
    expect(await rawInvoke({ signedBody: '{}', date: new Date(Date.now() + 20 * 60_000) })).toBe(
      403
    );
    expect(await rawInvoke({ signedBody: '{}', date: new Date(Date.now() - 10 * 60_000) })).toBe(
      200
    );
    expect(await rawInvoke({ signedBody: '{}', dropHeader: 'x-amz-date' })).toBe(403);
  });

  it('refuses a valid signature that does not cover host', async () => {
    const signer = new SignatureV4({
      credentials: CREDS,
      region: 'us-east-1',
      service: 'lambda',
      sha256: TestSha256 as never,
      applyChecksum: false,
    });
    const signed = await signer.sign({
      method: 'POST',
      protocol: 'http:',
      hostname: '127.0.0.1',
      path: '/x',
      query: {},
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(signed.headers['authorization']).not.toContain('host');
    await expect(
      verifySignature(
        { method: 'POST', path: '/x', query: {}, headers: signed.headers, body: Buffer.from('{}') },
        CREDS
      )
    ).resolves.toBe(false);
  });
});

describe('where it listens and for how long', () => {
  it("only on 127.0.0.1, not on the machine's other addresses (T1)", async () => {
    const other = Object.values(networkInterfaces())
      .flat()
      .find((a) => a !== undefined && a.family === 'IPv4' && !a.internal)?.address;
    if (other === undefined) return;
    const refused = await new Promise<boolean>((r) => {
      const c = connect(registration.port, other);
      c.once('connect', () => {
        c.destroy();
        r(false);
      });
      c.once('error', () => r(true));
    });
    expect(refused).toBe(true);
  });

  it('also on the container gateway when there is one, on the same port (T2)', async () => {
    const e = await startSecondHopEndpoint({
      ...(deps as unknown as Deps),
      containerGateway: () => Promise.resolve('::1'),
    });
    try {
      const reg = e.register(caller());
      const v6 = reg.url.replace('127.0.0.1', '[::1]');
      await expect(lambdaClient(v6).send(new ListFunctionsCommand({}))).resolves.toBeDefined();
    } finally {
      await e.close();
    }
  });

  it('fails to start, and closes the loopback side, when the gateway cannot be bound (T2)', async () => {
    const closeSpy = vi.spyOn(HttpServer.prototype, 'close');
    try {
      await expect(
        startSecondHopEndpoint({
          ...(deps as unknown as Deps),
          containerGateway: () => Promise.resolve('192.0.2.1'),
        })
      ).rejects.toThrow();
      expect(closeSpy).toHaveBeenCalled();
    } finally {
      closeSpy.mockRestore();
    }
  });

  it('refuses connections once closed (T13)', async () => {
    const e = await startSecondHopEndpoint(deps as unknown as Deps);
    const reg = e.register(caller());
    await e.close();
    await expect(lambdaClient(reg.url).send(new ListFunctionsCommand({}))).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    });
  });
});

describe('Invoke edge cases', () => {
  it('runs a $LATEST-qualified invoke locally (T4)', async () => {
    await lambdaClient().send(new InvokeCommand({ FunctionName: USER_ARN, Qualifier: '$LATEST' }));
    expect(deps.runLocally).toHaveBeenCalledTimes(1);
    expect(deps.forward).not.toHaveBeenCalled();
  });

  it('forwards when the emulator does not describe it or the image is missing (T5)', async () => {
    deps.getFunctionConfiguration.mockResolvedValueOnce(undefined);
    await lambdaClient().send(new InvokeCommand({ FunctionName: USER_ARN }));
    deps.imageAvailable.mockResolvedValueOnce(false);
    await lambdaClient().send(new InvokeCommand({ FunctionName: USER_ARN }));
    expect(deps.runLocally).not.toHaveBeenCalled();
    expect(deps.forward).toHaveBeenCalledTimes(2);
  });

  it('forwards a payload that is not JSON (T6)', async () => {
    await lambdaClient().send(
      new InvokeCommand({ FunctionName: USER_ARN, Payload: Buffer.from('not json') })
    );
    expect(deps.runLocally).not.toHaveBeenCalled();
    expect(deps.forward).toHaveBeenCalledTimes(1);
  });

  it('carries LogResult only when the caller asked for the tail (T6)', async () => {
    const out = await lambdaClient().send(new InvokeCommand({ FunctionName: USER_ARN }));
    expect(out.LogResult).toBeUndefined();
  });

  it('answers a local run that throws as a function error, never a retried 5xx (C3)', async () => {
    deps.runLocally.mockRejectedValue(new Error('docker died'));
    const retrying = new LambdaClient({
      region: 'us-east-1',
      endpoint: registration.url,
      credentials: CREDS,
    });
    const out = await retrying.send(new InvokeCommand({ FunctionName: USER_ARN }));
    expect(out.FunctionError).toBe('Unhandled');
    expect(JSON.parse(Buffer.from(out.Payload!).toString())).toMatchObject({
      errorType: 'LocalRuntimeError',
    });
    expect(deps.runLocally).toHaveBeenCalledTimes(1);
  });
});

describe('StartExecution declines (T7) and task failures (T8)', () => {
  const sfn = () =>
    new SFNClient({
      region: 'us-east-1',
      endpoint: registration.url,
      credentials: CREDS,
      maxAttempts: 1,
    });
  const described = (definition: string, status = 200) =>
    deps.forward.mockImplementation((req: { headers: Record<string, string> }) =>
      Promise.resolve(
        req.headers['x-amz-target'] === 'AWSStepFunctions.DescribeStateMachine'
          ? { status, headers: {}, body: Buffer.from(JSON.stringify({ definition })) }
          : { status: 400, headers: {}, body: Buffer.from('{}') }
      )
    );
  const start = () =>
    sfn()
      .send(new StartExecutionCommand({ stateMachineArn: SM_ARN, input: '{}' }))
      .catch(() => undefined);
  const forwardedStart = () =>
    deps.forward.mock.calls.some(
      (c) =>
        (c[0] as { headers: Record<string, string> }).headers['x-amz-target'] ===
        'AWSStepFunctions.StartExecution'
    );

  async function declinedWith(setup: (c: LocalFunction) => void): Promise<void> {
    registration.release();
    const c = caller();
    setup(c);
    registration = endpoint.register(c);
    await start();
    expect(deps.runLocally).not.toHaveBeenCalled();
    expect(forwardedStart()).toBe(true);
  }

  type Res = Record<string, { Type: string; Properties: Record<string, unknown> }>;

  beforeEach(() => {
    described(DEFINITION(IS_COMPLETE_ARN, ON_TIMEOUT_ARN));
  });

  it('a definition that is not plain JSON text', async () => {
    await declinedWith((c) => {
      (c.lambda.stack.template.Resources as unknown as Res)['Waiter']!.Properties[
        'DefinitionString'
      ] = { 'Fn::Sub': '{}' };
    });
    // Declined from the template alone: the emulator is not even asked.
    expect(
      deps.forward.mock.calls.map(
        (c) => (c[0] as { headers: Record<string, string> }).headers['x-amz-target']
      )
    ).toEqual(['AWSStepFunctions.StartExecution']);
  });

  it('the emulator does not describe it', async () => {
    described(DEFINITION(IS_COMPLETE_ARN, ON_TIMEOUT_ARN), 400);
    await declinedWith(() => undefined);
  });

  it('a task whose target is not a function of the stack', async () => {
    await declinedWith((c) => {
      (c.lambda.stack.template.Resources as unknown as Res)['IsComplete']!.Type = 'AWS::SNS::Topic';
    });
  });

  it("the emulator does not describe a task's function", async () => {
    deps.getFunctionConfiguration.mockResolvedValue(undefined);
    await declinedWith(() => undefined);
  });

  it('a task function the assembly does not match', async () => {
    deps.chooseFunction.mockReturnValue({ reason: 'handler differs' });
    await declinedWith(() => undefined);
  });

  it("a task's runtime image is not available", async () => {
    deps.imageAvailable.mockResolvedValue(false);
    await declinedWith(() => undefined);
  });

  it('a task whose local run throws fails with Lambda.ServiceException into the Catch (T8)', async () => {
    deps.runLocally.mockImplementation((target: LocalFunction) =>
      target.lambda.logicalId === 'IsComplete'
        ? Promise.reject(new Error('docker died'))
        : Promise.resolve({ StatusCode: 200, Payload: Buffer.from('null') })
    );
    await start();
    const calls = () => deps.runLocally.mock.calls as [LocalFunction, unknown][];
    await vi.waitFor(() =>
      expect(calls().some(([t]) => t.lambda.logicalId === 'OnTimeout')).toBe(true)
    );
    const onTimeout = calls().find(([t]) => t.lambda.logicalId === 'OnTimeout')!;
    expect(onTimeout[1]).toEqual({ Error: 'Lambda.ServiceException', Cause: 'docker died' });
  });
});

describe("forwardToEmulator strips the caller's session token (T9)", () => {
  it('sends no x-amz-security-token the caller signed with', async () => {
    let seen: IncomingMessage | undefined;
    const emu = createServer((req, res) => {
      seen = req;
      req.resume();
      req.on('end', () => res.end('{}'));
    });
    await new Promise<void>((r) => emu.listen(0, '127.0.0.1', r));
    try {
      const port = (emu.address() as AddressInfo).port;
      wiring.value = {
        mode: 'emulator',
        emulatorEndpoint: { url: `http://127.0.0.1:${port}` },
        emulatorCredentials: CREDS,
      };
      await forwardToEmulator({
        service: 'lambda',
        region: 'us-east-1',
        method: 'GET',
        path: '/2015-03-31/functions',
        query: {},
        headers: { 'x-amz-security-token': 'CALLER-TOKEN', 'x-amz-date': '20260101T000000Z' },
        body: Buffer.alloc(0),
      });
      expect(seen!.headers['x-amz-security-token']).toBeUndefined();
      expect(JSON.stringify(seen!.headers)).not.toContain('CALLER-TOKEN');
    } finally {
      await new Promise<void>((r) => emu.close(() => r()));
    }
  });
});
