import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { InvokeCommand } from '@aws-sdk/client-lambda';

/**
 * go-to-k/cdkd#6206: the ONE decision point that moves a custom resource's
 * `ServiceToken` invoke to the local Lambda runtime under `--aws-emulator`.
 * Off the emulator the `Invoke` must be exactly what it was, and the local
 * runtime must not even be asked.
 */

const mockLambdaSend = vi.fn();
const mockS3Send = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockLambdaSend },
    sns: { send: vi.fn() },
    s3: { send: mockS3Send },
    sts: { send: vi.fn(() => Promise.resolve({ Account: '123456789012' })) },
  }),
}));

const runtime = vi.hoisted(() => ({
  active: vi.fn((): boolean => false),
  invoke: vi.fn(),
}));
vi.mock('../../../src/local/custom-resource-runtime-gate.js', () => ({
  localCustomResourceRuntimeActive: runtime.active,
}));
vi.mock('../../../src/local/custom-resource-runtime.js', () => ({
  invokeCustomResourceFunctionLocally: runtime.invoke,
}));

const { CustomResourceProvider } =
  await import('../../../src/provisioning/providers/custom-resource-provider.js');

const TOKEN = 'arn:aws:lambda:us-east-1:123456789012:function:handler';
const REQUEST = { RequestType: 'Create', LogicalResourceId: 'MyRes', ResponseURL: 'https://x' };

type Invoker = { invokeLambda(t: string, r: Record<string, unknown>): Promise<unknown> };

let provider: Invoker;

beforeEach(() => {
  mockLambdaSend.mockReset();
  runtime.active.mockReset().mockReturnValue(false);
  runtime.invoke.mockReset();
  provider = new CustomResourceProvider({ responseBucket: 'b' }) as unknown as Invoker;
});

describe('invokeLambda: the local custom-resource runtime seam (#6206)', () => {
  it('off the emulator: sends the same Invoke as before and never asks the local runtime', async () => {
    mockLambdaSend.mockResolvedValue({ StatusCode: 200 });
    const result = await provider.invokeLambda(TOKEN, REQUEST);

    expect(runtime.invoke).not.toHaveBeenCalled();
    expect(mockLambdaSend).toHaveBeenCalledTimes(1);
    const command = mockLambdaSend.mock.calls[0]![0] as InvokeCommand;
    expect(command).toBeInstanceOf(InvokeCommand);
    expect(command.input).toEqual({
      FunctionName: TOKEN,
      InvocationType: 'RequestResponse',
      LogType: 'Tail',
      Payload: Buffer.from(JSON.stringify(REQUEST)),
    });
    expect(result).toEqual({ StatusCode: 200 });
  });

  it('under the emulator: returns the local answer and sends no Invoke', async () => {
    runtime.active.mockReturnValue(true);
    const local = { StatusCode: 200, Payload: Buffer.from('null') };
    runtime.invoke.mockResolvedValue(local);

    const result = await provider.invokeLambda(TOKEN, REQUEST);

    expect(result).toBe(local);
    expect(mockLambdaSend).not.toHaveBeenCalled();
    expect(runtime.invoke).toHaveBeenCalledWith(
      { lambda: expect.objectContaining({ send: mockLambdaSend }), s3: expect.anything() },
      TOKEN,
      REQUEST
    );
  });

  it('under the emulator: a local runtime that declines falls back to the emulator Invoke', async () => {
    runtime.active.mockReturnValue(true);
    runtime.invoke.mockResolvedValue(undefined);
    mockLambdaSend.mockResolvedValue({ StatusCode: 200 });

    const result = await provider.invokeLambda(TOKEN, REQUEST);

    expect(runtime.invoke).toHaveBeenCalledTimes(1);
    expect(mockLambdaSend).toHaveBeenCalledTimes(1);
    expect((mockLambdaSend.mock.calls[0]![0] as InvokeCommand).input.FunctionName).toBe(TOKEN);
    expect(result).toEqual({ StatusCode: 200 });
  });
});
