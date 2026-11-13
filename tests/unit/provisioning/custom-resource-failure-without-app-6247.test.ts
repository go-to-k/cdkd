import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * go-to-k/cdkd#6247: a custom resource's Create / Update that fails while the
 * `--aws-emulator` local runtime is on but the command read no app (so the
 * handler ran in AWS Emulator's own runtime) is recorded, so `cdkd rollback`
 * does not advise re-running itself. Nothing is recorded with an app, or off
 * the emulator.
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
vi.mock('../../../src/utils/logger.js', () => {
  const leaf = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => leaf,
  };
  return { getLogger: () => leaf };
});
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://s3.example.com/presigned-url'),
}));
const wiring = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock('cdk-local/internal', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getActiveWorkloadAwsWiring: () => wiring.value,
}));
const assembly = vi.hoisted(() => ({ stacks: [] as unknown[] }));
vi.mock('../../../src/synthesis/synthesized-stacks.js', () => ({
  synthesizedStacks: () => assembly.stacks,
}));
// The local runtime declines (as it does with no assembly): the event goes to
// the emulator's own `Invoke`, which fails the handler.
vi.mock('../../../src/local/custom-resource-runtime.js', () => ({
  invokeCustomResourceFunctionLocally: vi.fn(async () => undefined),
}));

const { CustomResourceProvider } =
  await import('../../../src/provisioning/providers/custom-resource-provider.js');
const {
  customResourcesFailedWithoutApp,
  resetCustomResourceFailuresForTest,
  setLocalCustomResourceRuntimeEnabled,
} = await import('../../../src/local/custom-resource-runtime-gate.js');

const TOKEN = 'arn:aws:lambda:us-east-1:000000000000:function:Handler';
const TYPE = 'Custom::AWS';

function provider() {
  return new CustomResourceProvider({ responseBucket: 'b', asyncResponseTimeoutMs: 1_000 });
}

async function failUpdate(): Promise<void> {
  await expect(
    provider().update(
      'PutParam',
      'phys',
      TYPE,
      { ServiceToken: TOKEN, V: '3' },
      { ServiceToken: TOKEN, V: '2' }
    )
  ).rejects.toThrow(/Failed to update custom resource PutParam/);
}

beforeEach(() => {
  resetCustomResourceFailuresForTest();
  setLocalCustomResourceRuntimeEnabled(true, 'rollback');
  wiring.value = { mode: 'emulator' };
  assembly.stacks = [];
  mockS3Send.mockReset().mockResolvedValue({});
  mockLambdaSend.mockReset().mockImplementation((command: { constructor: { name: string } }) =>
    command.constructor.name === 'InvokeCommand'
      ? Promise.resolve({
          FunctionError: 'Unhandled',
          Payload: Buffer.from(`{"errorMessage":"Error: Cannot find module 'zlib'"}`),
        })
      : Promise.resolve({ Configuration: { State: 'Active', LastUpdateStatus: 'Successful' } })
  );
});

describe('custom resource failures in the emulator runtime without an app (#6247)', () => {
  it('a failed Update is recorded', async () => {
    await failUpdate();
    expect(customResourcesFailedWithoutApp()).toEqual(['PutParam']);
  });

  it('a failed Create is recorded', async () => {
    await expect(provider().create('MyRes', TYPE, { ServiceToken: TOKEN })).rejects.toThrow(
      /Failed to create custom resource MyRes/
    );
    expect(customResourcesFailedWithoutApp()).toEqual(['MyRes']);
  });

  it('not with an app (the handler ran locally or its own fallback warned)', async () => {
    assembly.stacks = [{ stackName: 'S' }];
    await failUpdate();
    expect(customResourcesFailedWithoutApp()).toEqual([]);
  });

  it('not off the emulator', async () => {
    wiring.value = undefined;
    await failUpdate();
    expect(customResourcesFailedWithoutApp()).toEqual([]);
  });

  it('not with --no-local-custom-resources (the operator chose that runtime)', async () => {
    setLocalCustomResourceRuntimeEnabled(false, 'rollback');
    await failUpdate();
    expect(customResourcesFailedWithoutApp()).toEqual([]);
  });
});
