/**
 * go-to-k/cdkd#5637: Lambda Managed Instances on the SDK route. Every semantic
 * here was measured on CloudFormation and the SDK (us-east-1, 2026-11-02):
 *
 * - `Function.FunctionScalingConfig` applies to `$LATEST.PUBLISHED`; CFn makes
 *   no numbered version.
 * - CFn's CreateFunction carries `Publish` + `PublishTo: LATEST_PUBLISHED` even
 *   with `PublishToLatestPublished: false`.
 * - On update CFn publishes unless that flag is false.
 * - Removing the scaling block resets it (`Put` with `{}`).
 * - Removing `CapacityProviderConfig` fails, and scaling without one fails.
 * - `$LATEST` stops at `ActiveNonInvocable`, so the settle reads the qualifier.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateFunctionCommand,
  DeleteFunctionCommand,
  GetFunctionCommand,
  GetFunctionConfigurationCommand,
  GetFunctionScalingConfigCommand,
  PublishVersionCommand,
  PutFunctionScalingConfigCommand,
  PutRuntimeManagementConfigCommand,
  ResourceNotFoundException,
  UpdateFunctionConfigurationCommand,
} from '@aws-sdk/client-lambda';

const mockSend = vi.fn();
const warn = vi.hoisted(() => vi.fn());

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
    warn,
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

import { LambdaFunctionProvider } from '../../../src/provisioning/providers/lambda-function-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const TYPE = 'AWS::Lambda::Function';
const QUALIFIER = '$LATEST.PUBLISHED';
const CAPACITY = {
  LambdaManagedInstancesCapacityProviderConfig: {
    CapacityProviderArn: 'arn:aws:lambda:us-east-1:123456789012:capacity-provider:cp',
  },
};
const SCALING = { MinExecutionEnvironments: 1, MaxExecutionEnvironments: 2 };
const BASE = {
  FunctionName: 'fn',
  Code: { S3Bucket: 'b', S3Key: 'k' },
  Role: 'arn:aws:iam::123456789012:role/exec',
  Runtime: 'python3.13',
  Handler: 'index.handler',
};
const MANAGED = { ...BASE, CapacityProviderConfig: CAPACITY };

type Handler = (command: unknown) => unknown;

/** Answers every call as a settled function, unless `override` answers first. */
function arm(override?: Handler): void {
  mockSend.mockImplementation(async (command: unknown) => {
    const answer = override?.(command);
    if (answer !== undefined) return answer;
    if (command instanceof CreateFunctionCommand) {
      return { FunctionName: 'fn', FunctionArn: 'arn:fn', LastModified: 't' };
    }
    if (command instanceof GetFunctionConfigurationCommand) {
      return { State: 'Active', LastUpdateStatus: 'Successful' };
    }
    if (command instanceof GetFunctionCommand) {
      return {
        Configuration: {
          FunctionArn: 'arn:fn',
          FunctionName: 'fn',
          LastUpdateStatus: 'Successful',
        },
      };
    }
    return {};
  });
}

function sent<T>(ctor: new (...args: never[]) => T): T[] {
  return mockSend.mock.calls.map((c) => c[0]).filter((c): c is T => c instanceof ctor);
}

/** The constructor name of each call, in order, for the given commands. */
function order(...ctors: (new (...args: never[]) => unknown)[]): string[] {
  return mockSend.mock.calls
    .map((c) => c[0] as object)
    .filter((c) => ctors.some((ctor) => c instanceof ctor))
    .map((c) => c.constructor.name);
}

describe('Lambda Managed Instances (go-to-k/cdkd#5637)', () => {
  let provider: LambdaFunctionProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new LambdaFunctionProvider();
    Object.assign(provider, { latestPublishedPollMs: 0, cleanupDeleteRetryDelayMs: 0 });
    arm();
  });

  describe('create', () => {
    it.each([
      ['absent', undefined],
      ['true', true],
      ['false', false],
    ])('publishes whatever the flag says (%s)', async (_name, flag) => {
      await provider.create('Fn', TYPE, {
        ...MANAGED,
        ...(flag !== undefined && { PublishToLatestPublished: flag }),
      });
      const input = sent(CreateFunctionCommand)[0]!.input;
      expect(input.CapacityProviderConfig).toEqual(CAPACITY);
      expect(input.Publish).toBe(true);
      expect(input.PublishTo).toBe('LATEST_PUBLISHED');
    });

    it('waits on the published version, then applies scaling to it, then waits again', async () => {
      let reads = 0;
      arm((command) => {
        if (command instanceof GetFunctionConfigurationCommand && ++reads === 1) {
          return { State: 'Pending', LastUpdateStatus: 'Successful' };
        }
        return undefined;
      });
      await provider.create('Fn', TYPE, { ...MANAGED, FunctionScalingConfig: SCALING });

      expect(sent(GetFunctionConfigurationCommand)[0]!.input).toEqual({
        FunctionName: 'fn',
        Qualifier: QUALIFIER,
      });
      expect(sent(PutFunctionScalingConfigCommand)[0]!.input).toEqual({
        FunctionName: 'fn',
        Qualifier: QUALIFIER,
        FunctionScalingConfig: SCALING,
      });
      const steps = order(
        CreateFunctionCommand,
        GetFunctionConfigurationCommand,
        PutFunctionScalingConfigCommand
      );
      expect(steps[0]).toBe('CreateFunctionCommand');
      // Pending, then settled, before the Put; then the Put's own settle.
      expect(steps.indexOf('PutFunctionScalingConfigCommand')).toBeGreaterThanOrEqual(3);
      expect(steps.at(-1)).toBe('GetFunctionConfigurationCommand');
    });

    it('waits while the version is Active with an update in progress', async () => {
      let reads = 0;
      arm((command) => {
        if (command instanceof GetFunctionConfigurationCommand && ++reads === 1) {
          return { State: 'Active', LastUpdateStatus: 'InProgress' };
        }
        return undefined;
      });
      await provider.create('Fn', TYPE, MANAGED);
      expect(reads).toBe(2);
    });

    it('leaves a plain function alone, even one carrying the flag', async () => {
      await provider.create('Fn', TYPE, { ...BASE, PublishToLatestPublished: true });
      const input = sent(CreateFunctionCommand)[0]!.input;
      expect(input.Publish).toBeUndefined();
      expect(input.PublishTo).toBeUndefined();
      expect(sent(GetFunctionConfigurationCommand)).toHaveLength(0);
    });

    it('refuses scaling without a capacity provider before any call', async () => {
      await expect(
        provider.create('Fn', TYPE, { ...BASE, FunctionScalingConfig: SCALING })
      ).rejects.toThrow(/FunctionScalingConfig without CapacityProviderConfig/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('deletes the function when the published version fails', async () => {
      arm((command) =>
        command instanceof GetFunctionConfigurationCommand
          ? {
              State: 'Failed',
              StateReasonCode: 'InternalError',
              StateReason: 'denied for arn:aws:iam::123456789012:role/caller',
            }
          : undefined
      );
      const error = await provider.create('Fn', TYPE, MANAGED).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProvisioningError);
      // A status reason can name the account: the persisted message has its
      // code and the pointer, never its text (go-to-k/cdkd#2319).
      expect(String(error)).toMatch(/Failed to set CapacityProviderConfig.*InternalError/);
      expect(String(error)).toMatch(/--verbose/);
      expect(String(error)).not.toContain('123456789012');
      expect(sent(DeleteFunctionCommand)).toHaveLength(1);
    });

    it('deletes the function when the scaling call fails', async () => {
      arm((command) => {
        if (command instanceof PutFunctionScalingConfigCommand) {
          throw new Error('refused');
        }
        return undefined;
      });
      await expect(
        provider.create('Fn', TYPE, { ...MANAGED, FunctionScalingConfig: SCALING })
      ).rejects.toThrow(/Failed to set FunctionScalingConfig/);
      expect(sent(DeleteFunctionCommand)).toHaveLength(1);
    });

    it('does not wait on $LATEST for RuntimeManagementConfig: it never reads Active', async () => {
      await provider.create('Fn', TYPE, {
        ...MANAGED,
        RuntimeManagementConfig: { UpdateRuntimeOn: 'Auto' },
      });
      expect(sent(GetFunctionCommand)).toHaveLength(0);
      expect(sent(PutRuntimeManagementConfigCommand)).toHaveLength(1);
    });
  });

  describe('update', () => {
    const update = (
      next: Record<string, unknown>,
      previous: Record<string, unknown>,
      context?: Parameters<LambdaFunctionProvider['update']>[5]
    ) => provider.update('Fn', 'fn', TYPE, next, previous, context);

    it.each([
      ['absent', undefined],
      ['true', true],
    ])('publishes after the configuration change with the flag %s', async (_name, flag) => {
      await update(
        {
          ...MANAGED,
          Description: 'new',
          ...(flag !== undefined && { PublishToLatestPublished: flag }),
        },
        { ...MANAGED, Description: 'old' }
      );
      expect(sent(PublishVersionCommand)[0]!.input).toEqual({
        FunctionName: 'fn',
        Description: 'new',
        PublishTo: 'LATEST_PUBLISHED',
      });
      expect(order(UpdateFunctionConfigurationCommand, PublishVersionCommand)).toEqual([
        'UpdateFunctionConfigurationCommand',
        'PublishVersionCommand',
      ]);
    });

    it('does not publish with the flag false, and still applies scaling', async () => {
      await update(
        { ...MANAGED, PublishToLatestPublished: false, FunctionScalingConfig: SCALING },
        { ...MANAGED, PublishToLatestPublished: false }
      );
      expect(sent(PublishVersionCommand)).toHaveLength(0);
      expect(sent(PutFunctionScalingConfigCommand)[0]!.input.FunctionScalingConfig).toEqual(
        SCALING
      );
    });

    it('resends the capacity provider on any configuration change, as CloudFormation does', async () => {
      await update({ ...MANAGED, Timeout: 9 }, { ...MANAGED, Timeout: 3 });
      expect(sent(UpdateFunctionConfigurationCommand)[0]!.input.CapacityProviderConfig).toEqual({
        LambdaManagedInstancesCapacityProviderConfig: {
          ...CAPACITY.LambdaManagedInstancesCapacityProviderConfig,
          ExecutionEnvironmentMemoryGiBPerVCpu: 2,
        },
      });
    });

    it('resets an absent memory ratio and leaves an absent concurrency out, as CloudFormation does', async () => {
      await update(
        { ...BASE, CapacityProviderConfig: CAPACITY, Timeout: 9 },
        {
          ...BASE,
          Timeout: 3,
          CapacityProviderConfig: {
            LambdaManagedInstancesCapacityProviderConfig: {
              ...CAPACITY.LambdaManagedInstancesCapacityProviderConfig,
              PerExecutionEnvironmentMaxConcurrency: 8,
              ExecutionEnvironmentMemoryGiBPerVCpu: 4,
            },
          },
        }
      );
      const sentConfig = sent(UpdateFunctionConfigurationCommand)[0]!.input.CapacityProviderConfig;
      expect(sentConfig?.LambdaManagedInstancesCapacityProviderConfig).toEqual({
        ...CAPACITY.LambdaManagedInstancesCapacityProviderConfig,
        ExecutionEnvironmentMemoryGiBPerVCpu: 2,
      });
    });

    it('sends a changed capacity provider', async () => {
      const moved = {
        LambdaManagedInstancesCapacityProviderConfig: {
          CapacityProviderArn: 'arn:aws:lambda:us-east-1:123456789012:capacity-provider:other',
        },
      };
      await update({ ...BASE, CapacityProviderConfig: moved }, MANAGED);
      expect(
        sent(UpdateFunctionConfigurationCommand)[0]!.input.CapacityProviderConfig
          ?.LambdaManagedInstancesCapacityProviderConfig?.CapacityProviderArn
      ).toBe(moved.LambdaManagedInstancesCapacityProviderConfig.CapacityProviderArn);
    });

    it('resets a removed scaling block with an empty one', async () => {
      await update(MANAGED, { ...MANAGED, FunctionScalingConfig: SCALING });
      expect(sent(PutFunctionScalingConfigCommand)[0]!.input).toEqual({
        FunctionName: 'fn',
        Qualifier: QUALIFIER,
        FunctionScalingConfig: {},
      });
    });

    it('sends no scaling call for an unchanged block, whatever its key order', async () => {
      await update(
        {
          ...MANAGED,
          FunctionScalingConfig: { MaxExecutionEnvironments: 2, MinExecutionEnvironments: 1 },
        },
        { ...MANAGED, FunctionScalingConfig: SCALING }
      );
      expect(sent(PutFunctionScalingConfigCommand)).toHaveLength(0);
    });

    it('resends an unsettled scaling block', async () => {
      await update(
        { ...MANAGED, FunctionScalingConfig: SCALING },
        { ...MANAGED, FunctionScalingConfig: SCALING },
        { unsettledProperties: new Set(['FunctionScalingConfig']) }
      );
      expect(sent(PutFunctionScalingConfigCommand)).toHaveLength(1);
    });

    it('marks scaling unsettled before the call', async () => {
      const markUnsettled = vi.fn();
      arm((command) => {
        if (command instanceof PutFunctionScalingConfigCommand) throw new Error('refused');
        return undefined;
      });
      await expect(
        update({ ...MANAGED, FunctionScalingConfig: SCALING }, MANAGED, { markUnsettled })
      ).rejects.toThrow(/refused/);
      expect(markUnsettled).toHaveBeenCalledWith('FunctionScalingConfig');
    });

    it('refuses a removed capacity provider before any call', async () => {
      await expect(update(BASE, MANAGED)).rejects.toThrow(/cannot lose its CapacityProviderConfig/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuses scaling without a capacity provider before any call', async () => {
      await expect(update({ ...BASE, FunctionScalingConfig: SCALING }, BASE)).rejects.toThrow(
        /FunctionScalingConfig without CapacityProviderConfig/
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('makes no Managed Instances call for a plain function', async () => {
      await update({ ...BASE, Timeout: 9 }, { ...BASE, Timeout: 3 });
      expect(sent(PublishVersionCommand)).toHaveLength(0);
      expect(sent(GetFunctionConfigurationCommand)).toHaveLength(0);
      expect(sent(PutFunctionScalingConfigCommand)).toHaveLength(0);
    });

    it('fails the update when the publish fails, withholding the reason', async () => {
      let reads = 0;
      arm((command) => {
        if (command instanceof GetFunctionConfigurationCommand && ++reads === 2) {
          return { State: 'Active', LastUpdateStatus: 'Failed', LastUpdateStatusReason: 'boom' };
        }
        return undefined;
      });
      const error = await update(MANAGED, { ...MANAGED, Timeout: 3 }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProvisioningError);
      expect(String(error)).toMatch(/\$LATEST\.PUBLISHED failed/);
      expect(String(error)).not.toContain('boom');
    });

    it('keeps cdkd\'s fallback when a failure carries no reason', async () => {
      let reads = 0;
      arm((command) => {
        if (command instanceof GetFunctionConfigurationCommand && ++reads === 2) {
          return { State: 'Failed' };
        }
        return undefined;
      });
      await expect(update(MANAGED, { ...MANAGED, Timeout: 3 })).rejects.toThrow(/no reason given/);
    });

    it('lets a fixed template past a Failed version left by an earlier attempt', async () => {
      let reads = 0;
      arm((command) => {
        if (command instanceof GetFunctionConfigurationCommand && ++reads === 1) {
          return { State: 'Failed', StateReason: 'earlier attempt' };
        }
        return undefined;
      });
      await update(MANAGED, { ...MANAGED, Timeout: 3 });
      expect(sent(PublishVersionCommand)).toHaveLength(1);
    });

    it('applies a scaling change to a Deactivated version', async () => {
      arm((command) =>
        command instanceof GetFunctionConfigurationCommand
          ? { State: 'Deactivated', LastUpdateStatus: 'Successful' }
          : undefined
      );
      await update(
        { ...MANAGED, PublishToLatestPublished: false, FunctionScalingConfig: SCALING },
        {
          ...MANAGED,
          PublishToLatestPublished: false,
          FunctionScalingConfig: { MinExecutionEnvironments: 0, MaxExecutionEnvironments: 0 },
        }
      );
      expect(sent(PutFunctionScalingConfigCommand)).toHaveLength(1);
    });

    it('waits through Deactivating', async () => {
      let reads = 0;
      arm((command) => {
        if (command instanceof GetFunctionConfigurationCommand && ++reads === 2) {
          return { State: 'Deactivating', LastUpdateStatus: 'Successful' };
        }
        return undefined;
      });
      await update(
        { ...MANAGED, PublishToLatestPublished: false, FunctionScalingConfig: SCALING },
        { ...MANAGED, PublishToLatestPublished: false }
      );
      expect(reads).toBe(3);
    });

    it('stops at the enclosing resource deadline, not the 10 minute budget', async () => {
      const deadline = await import('../../../src/deployment/resource-deadline.js');
      const spy = vi.spyOn(deadline, 'enclosingDeadlineRemainingMs').mockReturnValue(0);
      try {
        arm((command) =>
          command instanceof GetFunctionConfigurationCommand
            ? { State: 'Pending', LastUpdateStatus: 'Successful' }
            : undefined
        );
        await expect(update(MANAGED, { ...MANAGED, Timeout: 3 })).rejects.toThrow(
          /did not settle within 0s/
        );
      } finally {
        spy.mockRestore();
      }
    });

    it('gives up on a version that never settles, naming its state', async () => {
      Object.assign(provider, { functionUpdateMaxWaitSeconds: 0 });
      arm((command) =>
        command instanceof GetFunctionConfigurationCommand
          ? { State: 'Pending', LastUpdateStatus: 'Successful' }
          : undefined
      );
      await expect(update(MANAGED, { ...MANAGED, Timeout: 3 })).rejects.toThrow(
        /did not settle within 0s \(State Pending/
      );
    });
  });

  describe('delete', () => {
    const gone = (): ResourceNotFoundException =>
      new ResourceNotFoundException({ message: 'gone', $metadata: {} });

    it('waits until the function is gone: its capacity provider is deleted next', async () => {
      let reads = 0;
      arm((command) => {
        if (command instanceof GetFunctionCommand && ++reads === 3) throw gone();
        return undefined;
      });
      await provider.delete('Fn', 'fn', TYPE, MANAGED);
      expect(reads).toBe(3);
    });

    it('does not fail a landed delete when the read fails, and warns', async () => {
      arm((command) => {
        if (command instanceof GetFunctionCommand) throw new Error('throttled');
        return undefined;
      });
      await provider.delete('Fn', 'fn', TYPE, MANAGED);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Waiting for Lambda function/));
    });

    it('warns and returns at the budget', async () => {
      Object.assign(provider, { functionUpdateMaxWaitSeconds: 0 });
      await provider.delete('Fn', 'fn', TYPE, MANAGED);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/still being deleted/));
    });

    it('does not wait for a plain function', async () => {
      await provider.delete('Fn', 'fn', TYPE, BASE);
      expect(sent(GetFunctionCommand)).toHaveLength(0);
    });
  });

  describe('readCurrentState', () => {
    const armRead = (scaling: Handler): void =>
      arm((command) => {
        if (command instanceof GetFunctionCommand) {
          return {
            Configuration: { FunctionName: 'fn', CapacityProviderConfig: CAPACITY },
          };
        }
        if (command instanceof GetFunctionScalingConfigCommand) return scaling(command);
        return undefined;
      });

    it('reads both, the scaling from the published version', async () => {
      armRead(() => ({ AppliedFunctionScalingConfig: SCALING }));
      const live = (await provider.readCurrentState('fn', 'Fn', TYPE)) as Record<string, unknown>;
      expect(live['CapacityProviderConfig']).toEqual(CAPACITY);
      expect(live['FunctionScalingConfig']).toEqual(SCALING);
      expect(sent(GetFunctionScalingConfigCommand)[0]!.input).toEqual({
        FunctionName: 'fn',
        Qualifier: QUALIFIER,
      });
    });

    it('prefers the requested block while AWS is applying it', async () => {
      armRead(() => ({
        AppliedFunctionScalingConfig: { MinExecutionEnvironments: 3 },
        RequestedFunctionScalingConfig: SCALING,
      }));
      const live = (await provider.readCurrentState('fn', 'Fn', TYPE)) as Record<string, unknown>;
      expect(live['FunctionScalingConfig']).toEqual(SCALING);
    });

    it('omits scaling with no warning when nothing is published', async () => {
      armRead(() => {
        throw new ResourceNotFoundException({ message: 'gone', $metadata: {} });
      });
      const live = (await provider.readCurrentState('fn', 'Fn', TYPE)) as Record<string, unknown>;
      expect(live).not.toHaveProperty('FunctionScalingConfig');
      expect(warn).not.toHaveBeenCalled();
    });

    it('warns when the scaling read fails, since that reads as a removal', async () => {
      armRead(() => {
        throw new Error('throttled');
      });
      const live = (await provider.readCurrentState('fn', 'Fn', TYPE)) as Record<string, unknown>;
      expect(live).not.toHaveProperty('FunctionScalingConfig');
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/GetFunctionScalingConfig failed/));
    });

    it('makes no scaling read for a plain function', async () => {
      await provider.readCurrentState('fn', 'Fn', TYPE);
      expect(sent(GetFunctionScalingConfigCommand)).toHaveLength(0);
    });
  });

  describe('unsettled', () => {
    it('reads an unsettled scaling block strictly', async () => {
      arm((command) => {
        if (command instanceof GetFunctionCommand) {
          return { Configuration: { FunctionName: 'fn', CapacityProviderConfig: CAPACITY } };
        }
        if (command instanceof GetFunctionScalingConfigCommand) throw new Error('throttled');
        return undefined;
      });
      await expect(
        provider.readUnsettled('fn', 'Fn', TYPE, new Set(['FunctionScalingConfig']))
      ).rejects.toThrow(/throttled/);
    });

    it('treats scaling as applied by its own call, not by the function transition', async () => {
      arm((command) =>
        command instanceof GetFunctionCommand
          ? { Configuration: { State: 'Pending' } }
          : undefined
      );
      const left = await provider.unsettledInTransition(
        'fn',
        'Fn',
        TYPE,
        new Set(['FunctionScalingConfig', 'Timeout'])
      );
      expect([...left]).toEqual(['Timeout']);
    });
  });
});
