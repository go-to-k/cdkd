/**
 * Issue #6352 backfill: `AWS::Lambda::Function` `AcceleratorConfig` (GPU
 * memory for a function on a GPU Lambda Managed Instances capacity provider)
 * on the SDK route.
 *
 * `@aws-sdk/client-lambda` models the block on CreateFunctionRequest,
 * UpdateFunctionConfigurationRequest and the FunctionConfiguration response,
 * and the CFn schema does not list it create-only, so a size change applies in
 * place. Its one member is required, so no update payload removes it: a
 * removal is refused rather than reported as applied.
 *
 * AWS pairs it with a GPU capacity provider; these cases check the wire, not
 * that rule, so the props carry no CapacityProviderConfig.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateFunctionCommand,
  GetFunctionCommand,
  UpdateFunctionConfigurationCommand,
} from '@aws-sdk/client-lambda';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    ec2: { send: vi.fn() },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(function (this: unknown) { return this; }),
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

import { LambdaFunctionProvider } from '../../../src/provisioning/providers/lambda-function-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';

const GPU_PROPS = {
  FunctionName: 'fn',
  PackageType: 'Image',
  Code: { ImageUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/repo:tag' },
  Role: 'arn:aws:iam::123456789012:role/exec',
  AcceleratorConfig: { AcceleratorMemorySize: 12 },
};

const { AcceleratorConfig: _omitted, ...WITHOUT_ACCELERATOR } = GPU_PROPS;

function sentOfType<T>(ctor: new (...args: never[]) => T): T[] {
  return mockSend.mock.calls.map((c) => c[0]).filter((c): c is T => c instanceof ctor);
}

/** Every call answers with a settled function, so the update waiter returns. */
function mockSettledFunction(configuration: Record<string, unknown> = {}): void {
  mockSend.mockResolvedValue({
    FunctionName: 'fn',
    FunctionArn: 'arn:fn',
    Configuration: {
      FunctionArn: 'arn:fn',
      FunctionName: 'fn',
      PackageType: 'Image',
      State: 'Active',
      LastUpdateStatus: 'Successful',
      ...configuration,
    },
    Tags: {},
  });
}

describe('AWS::Lambda::Function AcceleratorConfig (#6352)', () => {
  let provider: LambdaFunctionProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new LambdaFunctionProvider();
  });

  it('declares AcceleratorConfig as handled and its removal as handled in update()', () => {
    expect(provider.handledProperties.get('AWS::Lambda::Function')?.has('AcceleratorConfig')).toBe(
      true
    );
    expect(
      provider.removalHandledInUpdate.get('AWS::Lambda::Function')?.has('AcceleratorConfig')
    ).toBe(true);
    expect(
      provider.removalDefaults.get('AWS::Lambda::Function')?.has('AcceleratorConfig')
    ).toBe(false);
  });

  describe('create', () => {
    it('sends AcceleratorConfig on CreateFunction', async () => {
      mockSettledFunction();

      await provider.create('Fn', 'AWS::Lambda::Function', GPU_PROPS);

      const create = sentOfType(CreateFunctionCommand)[0];
      expect(create?.input.AcceleratorConfig).toEqual({ AcceleratorMemorySize: 12 });
    });

    it('sends no AcceleratorConfig when the template omits it', async () => {
      mockSettledFunction();

      await provider.create('Fn', 'AWS::Lambda::Function', WITHOUT_ACCELERATOR);

      const create = sentOfType(CreateFunctionCommand)[0];
      expect(create).toBeDefined();
      expect(create?.input).not.toHaveProperty('AcceleratorConfig', expect.anything());
    });
  });

  describe('update', () => {
    it('applies a size change in place on UpdateFunctionConfiguration', async () => {
      mockSettledFunction();

      await provider.update(
        'Fn',
        'fn',
        'AWS::Lambda::Function',
        { ...GPU_PROPS, AcceleratorConfig: { AcceleratorMemorySize: 6 } },
        GPU_PROPS
      );

      const cfg = sentOfType(UpdateFunctionConfigurationCommand);
      expect(cfg).toHaveLength(1);
      expect(cfg[0]?.input.AcceleratorConfig).toEqual({ AcceleratorMemorySize: 6 });
    });

    it('sends the block when it is added', async () => {
      mockSettledFunction();

      await provider.update('Fn', 'fn', 'AWS::Lambda::Function', GPU_PROPS, WITHOUT_ACCELERATOR);

      const cfg = sentOfType(UpdateFunctionConfigurationCommand);
      expect(cfg).toHaveLength(1);
      expect(cfg[0]?.input.AcceleratorConfig).toEqual({ AcceleratorMemorySize: 12 });
    });

    it('re-sends the unchanged block beside another configuration change', async () => {
      mockSettledFunction();

      await provider.update(
        'Fn',
        'fn',
        'AWS::Lambda::Function',
        { ...GPU_PROPS, Description: 'x' },
        GPU_PROPS
      );

      const cfg = sentOfType(UpdateFunctionConfigurationCommand);
      expect(cfg).toHaveLength(1);
      expect(cfg[0]?.input.Description).toBe('x');
      expect(cfg[0]?.input.AcceleratorConfig).toEqual({ AcceleratorMemorySize: 12 });
    });

    it('makes no configuration call when nothing changed', async () => {
      mockSettledFunction();

      await provider.update('Fn', 'fn', 'AWS::Lambda::Function', GPU_PROPS, GPU_PROPS);

      expect(sentOfType(UpdateFunctionConfigurationCommand)).toHaveLength(0);
    });

    it('refuses a removal before any AWS call', async () => {
      mockSettledFunction();

      const result = provider.update(
        'Fn',
        'fn',
        'AWS::Lambda::Function',
        WITHOUT_ACCELERATOR,
        GPU_PROPS
      );

      await expect(result).rejects.toBeInstanceOf(ProvisioningError);
      await expect(result).rejects.toThrow(/cannot lose its AcceleratorConfig/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('does not refuse when the record never held it', async () => {
      mockSettledFunction();

      await provider.update(
        'Fn',
        'fn',
        'AWS::Lambda::Function',
        { ...WITHOUT_ACCELERATOR, Description: 'x' },
        WITHOUT_ACCELERATOR
      );

      const cfg = sentOfType(UpdateFunctionConfigurationCommand);
      expect(cfg).toHaveLength(1);
      expect(cfg[0]?.input.AcceleratorConfig).toBeUndefined();
    });

    it('warns instead of refusing on a state replay', async () => {
      mockSettledFunction();

      await provider.update(
        'Fn',
        'fn',
        'AWS::Lambda::Function',
        { ...WITHOUT_ACCELERATOR, Description: 'x' },
        GPU_PROPS,
        { replayingState: true }
      );

      expect(sentOfType(UpdateFunctionConfigurationCommand)).toHaveLength(1);
      const warn = vi.mocked(provider.logger.warn);
      const line = warn.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.includes('cannot lose its AcceleratorConfig'));
      // A replay user has no template to edit: the warn names the outcome.
      expect(line).toMatch(/stays on AWS/);
      expect(line).not.toMatch(/Keep the property/);
    });
  });

  describe('readCurrentState', () => {
    it('reads AcceleratorConfig off the GetFunction response in the CFn shape', async () => {
      mockSettledFunction({ AcceleratorConfig: { AcceleratorMemorySize: 12 } });

      const state = await provider.readCurrentState('fn', 'Fn', 'AWS::Lambda::Function');

      expect(state).not.toBe(RESOURCE_NOT_FOUND);
      expect((state as Record<string, unknown>)['AcceleratorConfig']).toEqual({
        AcceleratorMemorySize: 12,
      });
      expect(sentOfType(GetFunctionCommand).length).toBeGreaterThan(0);
    });

    it('omits the key when AWS reports an empty block', async () => {
      mockSettledFunction({ AcceleratorConfig: {} });

      const state = await provider.readCurrentState('fn', 'Fn', 'AWS::Lambda::Function');

      expect(state as Record<string, unknown>).not.toHaveProperty('AcceleratorConfig');
    });

    it('omits the key when AWS reports none', async () => {
      mockSettledFunction();

      const state = await provider.readCurrentState('fn', 'Fn', 'AWS::Lambda::Function');

      expect(state).not.toBe(RESOURCE_NOT_FOUND);
      expect(state as Record<string, unknown>).not.toHaveProperty('AcceleratorConfig');
    });
  });
});
