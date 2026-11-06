import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * The split of `custom-resource-provider.ts` into `custom-resource/` (#5835)
 * left the class with one delegator per method,
 * `return fn.call(this, <own params>)`. A delegator that drops or blanks an
 * argument is a silent hand-off break. Replacing each delegator argument with
 * `undefined` left the hand-offs below green in every existing suite, because
 * the argument reaches only a request field, an error field, a log line or a
 * cache key. Each case pins one of those hand-offs by what the argument
 * reaches.
 */

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

const debugLines = vi.hoisted((): string[] => []);
vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: (line: string) => debugLines.push(String(line)),
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
import { WaiterRejections } from '../../../src/provisioning/providers/custom-resource/lambda-waiter.js';
import { withCurrentResourceSecrets } from '../../../src/deployment/resource-secrets-scope.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const TOKEN = 'arn:aws:lambda:us-east-1:123456789012:function:Probe-Handler';
const TOPIC = 'arn:aws:sns:us-east-1:123456789012:probe-topic';
const OTHER_FN = 'arn:aws:lambda:us-east-1:123456789012:function:Probe-Target';
const TYPE = 'Custom::Probe';

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

/** Every command the Lambda client was sent, by command class. */
function lambdaInputs(name: string): Record<string, unknown>[] {
  return mockLambdaSend.mock.calls
    .map((call) => call[0] as Cmd)
    .filter((cmd) => cmd.constructor.name === name)
    .map((cmd) => cmd.input);
}

const watch = {
  isInterrupted: () => false,
  onInterrupted: () => new Error('interrupted') as never,
  dispose: () => undefined,
};

// The private surface the delegators expose, as these cases call it.
interface Delegators {
  originalDescriptions: Map<string, string>;
  refuseResolvedSecret(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    physicalId?: string,
    previousProperties?: Record<string, unknown>
  ): void;
  recycleAndRestore(
    serviceToken: string,
    key: string,
    logicalId: string,
    mask: ((t: string) => string) | undefined
  ): Promise<void>;
  readOriginalDescription(
    serviceToken: string,
    key: string,
    logicalId: string,
    mask: ((t: string) => string) | undefined
  ): Promise<string | undefined>;
  waitForBackingFunctionUpdated(
    serviceToken: string,
    rejections: WaiterRejections,
    maxWaitTime?: number
  ): Promise<void>;
  describeRecycleFailure(error: unknown, rejections: WaiterRejections, mask: unknown): string;
  isTransientAuthzFailure(reason: string | undefined): boolean;
  isBackingLambdaGone(serviceToken: string): Promise<boolean>;
  invokeCustomResourceWithRetry(...args: unknown[]): Promise<unknown>;
  generateResponseURL(...args: unknown[]): Promise<string>;
  isTransientAuthzThrow(error: unknown): boolean;
  debugWaiterRejections(logicalId: string, rejections: WaiterRejections): void;
  sendRequest(
    serviceToken: string,
    request: Record<string, unknown>,
    responseKey: string,
    logicalId: string,
    operation: string,
    onDelivered: () => void,
    mask: ((t: string) => string) | undefined
  ): Promise<unknown>;
  waitForBackingLambdaReady(
    serviceToken: string,
    logicalId: string,
    mask: ((t: string) => string) | undefined
  ): Promise<void>;
  waitForReferencedLambdasActive(
    logicalId: string,
    serviceToken: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown> | undefined,
    w: typeof watch,
    mask: ((t: string) => string) | undefined
  ): Promise<void>;
  publishToSns(topicArn: string, request: Record<string, unknown>): Promise<void>;
  invokeLambda(serviceToken: string, request: Record<string, unknown>): Promise<unknown>;
  getCustomResourceResponse(
    lambdaResponse: Record<string, unknown>,
    responseKey: string,
    logicalId: string,
    operation: string,
    mask: ((t: string) => string) | undefined
  ): Promise<unknown>;
  prepareInvocation(
    logicalId: string,
    w: typeof watch,
    mask: ((t: string) => string) | undefined
  ): Promise<unknown>;
  pollS3Response(
    responseKey: string,
    logicalId: string,
    operation: string,
    timeoutMs?: number,
    useBackoff?: boolean
  ): Promise<unknown>;
}

let provider: CustomResourceProvider;
let p: Delegators;

beforeEach(() => {
  mockLambdaSend.mockReset();
  mockSnsSend.mockReset();
  mockS3Send.mockReset();
  debugLines.length = 0;
  provider = new CustomResourceProvider({ responseBucket: 'probe-bucket' });
  p = provider as unknown as Delegators;
});

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('create / update / delete hand their resourceType and physicalId on', () => {
  it('create: the refusal names the resource type', async () => {
    const error = await caught(() => provider.create('MyRes', TYPE, {}));
    expect(error).toBeInstanceOf(ProvisioningError);
    expect((error as ProvisioningError).resourceType).toBe(TYPE);
  });

  it('update: the refusal names the resource type', async () => {
    const error = await caught(() => provider.update('MyRes', 'phys-1', TYPE, {}, {}));
    expect(error).toBeInstanceOf(ProvisioningError);
    expect((error as ProvisioningError).resourceType).toBe(TYPE);
  });

  it('delete: the Delete request carries the physical id and the resource type', async () => {
    vi.spyOn(p, 'isBackingLambdaGone').mockResolvedValue(false as never);
    let request: Record<string, unknown> | undefined;
    vi.spyOn(p, 'invokeCustomResourceWithRetry').mockImplementation(((
      _token: string,
      _logicalId: string,
      _operation: string,
      build: (i: { requestId: string; responseURL: string; stackId: string }) => Record<
        string,
        unknown
      >
    ) => {
      request = build({ requestId: 'r', responseURL: 'u', stackId: 's' });
      return Promise.resolve({ Status: 'SUCCESS' });
    }) as never);
    await provider.delete('MyRes', 'phys-1', TYPE, { ServiceToken: TOKEN });
    expect(request?.['PhysicalResourceId']).toBe('phys-1');
    expect(request?.['ResourceType']).toBe(TYPE);
  });

  it('refuseResolvedSecret: the refusal names the resource type', () => {
    const secrets = new Map<string, string>([['plain-secret', '{{resolve:ssm:/p}}']]);
    let error: unknown;
    try {
      withCurrentResourceSecrets(secrets, () =>
        p.refuseResolvedSecret('MyRes', TYPE, { ServiceToken: TOKEN, Password: 'plain-secret' })
      );
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ProvisioningError);
    expect((error as ProvisioningError).resourceType).toBe(TYPE);
  });
});

describe('the recycle hands its function, cache key, logical id and masker on', () => {
  const settled = (cmd: Cmd): Promise<unknown> => {
    if (cmd.constructor.name === 'GetFunctionConfigurationCommand') {
      return Promise.resolve({ FunctionName: 'Probe-Handler', Description: 'original' });
    }
    if (cmd.constructor.name === 'UpdateFunctionConfigurationCommand') return Promise.resolve({});
    return Promise.resolve({ Configuration: { State: 'Active', LastUpdateStatus: 'Successful' } });
  };

  it('recycleAndRestore: reads and writes the backing function under the given key', async () => {
    mockLambdaSend.mockImplementation(settled);
    const read = vi.spyOn(p, 'readOriginalDescription');
    await p.recycleAndRestore(TOKEN, 'key-1', 'MyRes', undefined);
    expect(read).toHaveBeenCalledWith(TOKEN, 'key-1', 'MyRes', undefined);
    expect(lambdaInputs('UpdateFunctionConfigurationCommand').map((i) => i['FunctionName'])).toEqual(
      [TOKEN, TOKEN]
    );
  });

  it('readOriginalDescription: reads the given function and caches under the given key', async () => {
    mockLambdaSend.mockImplementation(settled);
    await expect(p.readOriginalDescription(TOKEN, 'key-1', 'MyRes', undefined)).resolves.toBe(
      'original'
    );
    expect(lambdaInputs('GetFunctionConfigurationCommand')).toEqual([{ FunctionName: TOKEN }]);
    expect(p.originalDescriptions.get('key-1')).toBe('original');
  });

  it('readOriginalDescription: a failed read is logged for the logical id, through the masker', async () => {
    mockLambdaSend.mockRejectedValue(
      Object.assign(new Error('denied'), { name: 'AccessDeniedException' })
    );
    const describe = vi.spyOn(p, 'describeRecycleFailure');
    const mask = (t: string): string => t;
    await p.readOriginalDescription(TOKEN, 'key-1', 'MyRes', mask);
    expect(describe.mock.calls[0]?.[2]).toBe(mask);
    expect(debugLines.join('\n')).toContain(
      "Could not read the backing function's Description for MyRes before recycling it"
    );
  });

  it('waitForBackingFunctionUpdated: polls the given function', async () => {
    mockLambdaSend.mockImplementation(settled);
    await p.waitForBackingFunctionUpdated(TOKEN, new WaiterRejections(), 5);
    const polled = mockLambdaSend.mock.calls.map((call) => (call[0] as Cmd).input['FunctionName']);
    expect(polled.length).toBeGreaterThan(0);
    expect(new Set(polled)).toEqual(new Set([TOKEN]));
  });

  it('debugWaiterRejections: names the logical id', () => {
    const rejections = new WaiterRejections();
    // An AWS denial naming the caller is the class withheld from the thrown
    // text and given at debug instead.
    rejections.record(
      Object.assign(
        new Error(
          'User: arn:aws:sts::123456789012:assumed-role/Deployer/s is not authorized to perform: lambda:GetFunction'
        ),
        { name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } }
      )
    );
    p.debugWaiterRejections('MyRes', rejections);
    expect(debugLines.some((line) => line.startsWith('Readiness waiter for MyRes observed'))).toBe(
      true
    );
  });
});

describe('the dispatch hands its logical id, operation and target on', () => {
  it('sendRequest (SNS): polls for the given logical id and operation', async () => {
    mockSnsSend.mockResolvedValue({});
    const poll = vi
      .spyOn(p, 'pollS3Response')
      .mockResolvedValue({ Status: 'SUCCESS' } as never);
    await p.sendRequest(TOPIC, { a: 1 }, 'key', 'MyRes', 'Create', () => undefined, undefined);
    expect(poll).toHaveBeenCalledWith('key', 'MyRes', 'Create');
  });

  it('sendRequest (Lambda): reads the response for the given logical id and operation', async () => {
    vi.spyOn(p, 'waitForBackingLambdaReady').mockResolvedValue(undefined as never);
    vi.spyOn(p, 'invokeLambda').mockResolvedValue({} as never);
    const read = vi
      .spyOn(p, 'getCustomResourceResponse')
      .mockResolvedValue({ Status: 'SUCCESS' } as never);
    await p.sendRequest(TOKEN, { a: 1 }, 'key', 'MyRes', 'Update', () => undefined, undefined);
    expect(read).toHaveBeenCalledWith({}, 'key', 'MyRes', 'Update', undefined);
  });

  it('waitForBackingLambdaReady: the failure names the logical id', async () => {
    mockLambdaSend.mockResolvedValue({ Configuration: { State: 'Failed' } });
    const error = await caught(() => p.waitForBackingLambdaReady(TOKEN, 'MyRes', undefined));
    expect((error as Error).message).toContain(`Lambda backing custom resource MyRes (${TOKEN})`);
  });

  it('waitForReferencedLambdasActive: an unreadable reference is logged for the logical id', async () => {
    mockLambdaSend.mockRejectedValue(
      Object.assign(new Error('gone'), { name: 'ResourceNotFoundException' })
    );
    await p.waitForReferencedLambdasActive(
      'MyRes',
      TOKEN,
      { Target: OTHER_FN },
      undefined,
      watch,
      undefined
    );
    expect(debugLines.join('\n')).toContain(`Not waiting for ${OTHER_FN} referenced by MyRes`);
  });

  it('publishToSns: publishes the request to the given topic', async () => {
    mockSnsSend.mockResolvedValue({});
    await p.publishToSns(TOPIC, { RequestType: 'Create' });
    const input = (mockSnsSend.mock.calls[0]?.[0] as Cmd).input;
    expect(input['TopicArn']).toBe(TOPIC);
    expect(input['Message']).toBe(JSON.stringify({ RequestType: 'Create' }));
  });

  it('invokeLambda: invokes the given function', async () => {
    mockLambdaSend.mockResolvedValue({});
    await p.invokeLambda(TOKEN, { RequestType: 'Create' });
    expect(lambdaInputs('InvokeCommand')[0]?.['FunctionName']).toBe(TOKEN);
  });
});

describe('the response path hands its logical id and operation on', () => {
  it('getCustomResourceResponse: polls for the given logical id and operation', async () => {
    const poll = vi
      .spyOn(p, 'pollS3Response')
      .mockResolvedValue({ Status: 'SUCCESS' } as never);
    await p.getCustomResourceResponse({}, 'key', 'MyRes', 'Delete', undefined);
    expect(poll.mock.calls[0]?.slice(0, 3)).toEqual(['key', 'MyRes', 'Delete']);
  });

  it('prepareInvocation: signs the response URL for the given logical id', async () => {
    const sign = vi
      .spyOn(p, 'generateResponseURL')
      .mockResolvedValue('https://signed' as never);
    await p.prepareInvocation('MyRes', watch, undefined);
    expect(sign.mock.calls[0]?.[1]).toBe('MyRes');
  });

  it('pollS3Response: the timeout names the operation', async () => {
    const error = await caught(() => p.pollS3Response('key', 'MyRes', 'Create', 0, false));
    expect((error as Error).message).toContain(
      'Timeout waiting for custom resource response for MyRes (Create)'
    );
  });
});

describe('the two authz classifiers stay distinct', () => {
  // A FAILED reason is the user's handler's text about a call IT made, and a
  // retry re-runs the user's handler, so its classifier is the NARROW one. The
  // thrown-error classifier is deliberately wider. A delegator wired to the
  // other classifier would widen the FAILED arm without a type error.
  const WIDE_ONLY = 'Role validation failed: check the execution role';

  it('a reason only the thrown classifier admits is not a transient FAILED reason', () => {
    expect(p.isTransientAuthzThrow(new Error(WIDE_ONLY))).toBe(true);
    expect(p.isTransientAuthzFailure(WIDE_ONLY)).toBe(false);
  });

  it('a reason both admit is a transient FAILED reason', () => {
    expect(p.isTransientAuthzFailure('User x is not authorized to perform: s3:PutObject')).toBe(
      true
    );
  });
});
