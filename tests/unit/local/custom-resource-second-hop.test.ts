import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { createServer, type IncomingMessage, type Server } from 'node:http';
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

const { callerReferencedLogicalId, forwardToEmulator, startSecondHopEndpoint, verifySignature } =
  await import('../../../src/local/custom-resource-second-hop.js');
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
    await Promise.all(endpoint.pendingExecutions());
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
