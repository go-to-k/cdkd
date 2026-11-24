/**
 * Issue #6352 backfill: `AWS::Lambda::Function` `RuntimeConfig` (a
 * customer-managed runtime + alias) on the SDK route.
 *
 * The AWS rules pinned here were live-probed in us-east-1 (go-to-k/cdkd#6352):
 * CreateFunction requires the block with Runtime 'custom' and refuses it with
 * any other runtime; an alias change applies in place; switching Runtime away
 * from 'custom' clears it; and an update omitting it under 'custom' keeps the
 * live value.
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

const RUNTIME_ARN = 'arn:aws:lambda:us-east-1:123456789012:runtime/rt1';

const CUSTOM_PROPS = {
  FunctionName: 'fn',
  Code: { S3Bucket: 'b', S3Key: 'k' },
  Role: 'arn:aws:iam::123456789012:role/exec',
  Runtime: 'custom',
  Handler: 'index.handler',
  RuntimeConfig: { RuntimeArn: RUNTIME_ARN, RuntimeAlias: 'a' },
};

const { RuntimeConfig: _omitted, ...WITHOUT_RUNTIME_CONFIG } = CUSTOM_PROPS;

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
      State: 'Active',
      LastUpdateStatus: 'Successful',
      ...configuration,
    },
    Tags: {},
  });
}

describe('AWS::Lambda::Function RuntimeConfig (#6352)', () => {
  let provider: LambdaFunctionProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new LambdaFunctionProvider();
  });

  it('declares RuntimeConfig as handled and its removal as handled in update()', () => {
    expect(provider.handledProperties.get('AWS::Lambda::Function')?.has('RuntimeConfig')).toBe(
      true
    );
    expect(
      provider.removalHandledInUpdate.get('AWS::Lambda::Function')?.has('RuntimeConfig')
    ).toBe(true);
  });

  describe('create', () => {
    it('sends RuntimeConfig on CreateFunction beside Runtime custom', async () => {
      mockSettledFunction();

      await provider.create('Fn', 'AWS::Lambda::Function', CUSTOM_PROPS);

      const create = sentOfType(CreateFunctionCommand)[0];
      expect(create?.input.Runtime).toBe('custom');
      expect(create?.input.RuntimeConfig).toEqual({ RuntimeArn: RUNTIME_ARN, RuntimeAlias: 'a' });
    });

    it('sends no RuntimeConfig when the template omits it', async () => {
      mockSettledFunction();

      await provider.create('Fn', 'AWS::Lambda::Function', {
        ...WITHOUT_RUNTIME_CONFIG,
        Runtime: 'nodejs22.x',
      });

      const create = sentOfType(CreateFunctionCommand)[0];
      expect(create).toBeDefined();
      expect(create?.input).not.toHaveProperty('RuntimeConfig', expect.anything());
    });
  });

  describe('update', () => {
    it('re-sends the block on an alias change', async () => {
      mockSettledFunction();

      await provider.update(
        'Fn',
        'fn',
        'AWS::Lambda::Function',
        { ...CUSTOM_PROPS, RuntimeConfig: { RuntimeArn: RUNTIME_ARN, RuntimeAlias: 'b' } },
        CUSTOM_PROPS
      );

      const cfg = sentOfType(UpdateFunctionConfigurationCommand);
      expect(cfg).toHaveLength(1);
      expect(cfg[0]?.input.RuntimeConfig).toEqual({ RuntimeArn: RUNTIME_ARN, RuntimeAlias: 'b' });
    });

    it('removes it by the Runtime change alone, which clears it on AWS', async () => {
      mockSettledFunction();

      await provider.update(
        'Fn',
        'fn',
        'AWS::Lambda::Function',
        { ...WITHOUT_RUNTIME_CONFIG, Runtime: 'nodejs22.x' },
        CUSTOM_PROPS
      );

      const cfg = sentOfType(UpdateFunctionConfigurationCommand);
      expect(cfg).toHaveLength(1);
      expect(cfg[0]?.input.Runtime).toBe('nodejs22.x');
      expect(cfg[0]?.input.RuntimeConfig).toBeUndefined();
    });

    it('sends Runtime custom and the block together when both are added', async () => {
      mockSettledFunction();

      await provider.update('Fn', 'fn', 'AWS::Lambda::Function', CUSTOM_PROPS, {
        ...WITHOUT_RUNTIME_CONFIG,
        Runtime: 'nodejs22.x',
      });

      const cfg = sentOfType(UpdateFunctionConfigurationCommand);
      expect(cfg).toHaveLength(1);
      expect(cfg[0]?.input.Runtime).toBe('custom');
      expect(cfg[0]?.input.RuntimeConfig).toEqual({ RuntimeArn: RUNTIME_ARN, RuntimeAlias: 'a' });
    });

    it('refuses dropping it under Runtime custom before any AWS call', async () => {
      mockSettledFunction();

      const result = provider.update(
        'Fn',
        'fn',
        'AWS::Lambda::Function',
        WITHOUT_RUNTIME_CONFIG,
        CUSTOM_PROPS
      );

      await expect(result).rejects.toBeInstanceOf(ProvisioningError);
      await expect(result).rejects.toThrow(/keeps Runtime 'custom' without RuntimeConfig/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('does not refuse when the record never held it', async () => {
      mockSettledFunction();

      await provider.update(
        'Fn',
        'fn',
        'AWS::Lambda::Function',
        { ...WITHOUT_RUNTIME_CONFIG, Description: 'x' },
        WITHOUT_RUNTIME_CONFIG
      );

      expect(sentOfType(UpdateFunctionConfigurationCommand)).toHaveLength(1);
    });

    it('warns instead of refusing on a state replay', async () => {
      mockSettledFunction();

      await provider.update(
        'Fn',
        'fn',
        'AWS::Lambda::Function',
        { ...WITHOUT_RUNTIME_CONFIG, Description: 'x' },
        CUSTOM_PROPS,
        { replayingState: true }
      );

      expect(sentOfType(UpdateFunctionConfigurationCommand)).toHaveLength(1);
      const warn = vi.mocked(provider.logger.warn);
      const line = warn.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.includes("keeps Runtime 'custom' without RuntimeConfig"));
      // A replay user has no template to edit: the warn names the outcome.
      expect(line).toMatch(/stays on AWS/);
      expect(line).not.toMatch(/Keep the property/);
    });
  });

  describe('readCurrentState', () => {
    it('reads RuntimeConfig off the GetFunction response in the CFn shape', async () => {
      mockSettledFunction({
        Runtime: 'custom',
        RuntimeConfig: { RuntimeArn: RUNTIME_ARN, RuntimeAlias: 'a' },
      });

      const state = await provider.readCurrentState('fn', 'Fn', 'AWS::Lambda::Function');

      expect(state).not.toBe(RESOURCE_NOT_FOUND);
      expect((state as Record<string, unknown>)['RuntimeConfig']).toEqual({
        RuntimeArn: RUNTIME_ARN,
        RuntimeAlias: 'a',
      });
      expect(sentOfType(GetFunctionCommand).length).toBeGreaterThan(0);
    });

    it('keeps the member AWS reported when the other is missing', async () => {
      mockSettledFunction({ Runtime: 'custom', RuntimeConfig: { RuntimeArn: RUNTIME_ARN } });

      const state = await provider.readCurrentState('fn', 'Fn', 'AWS::Lambda::Function');

      expect((state as Record<string, unknown>)['RuntimeConfig']).toEqual({
        RuntimeArn: RUNTIME_ARN,
      });
    });

    it('omits the key when AWS reports an empty block', async () => {
      mockSettledFunction({ Runtime: 'custom', RuntimeConfig: {} });

      const state = await provider.readCurrentState('fn', 'Fn', 'AWS::Lambda::Function');

      expect(state as Record<string, unknown>).not.toHaveProperty('RuntimeConfig');
    });

    it('omits the key when AWS reports none', async () => {
      mockSettledFunction({ Runtime: 'nodejs22.x' });

      const state = await provider.readCurrentState('fn', 'Fn', 'AWS::Lambda::Function');

      expect(state).not.toBe(RESOURCE_NOT_FOUND);
      expect(state as Record<string, unknown>).not.toHaveProperty('RuntimeConfig');
    });
  });
});
