/**
 * Issue #609 backfill: the four `AWS::Lambda::Function` silent-drop properties
 * wired in this slice — `CodeSigningConfigArn`, `RuntimeManagementConfig`,
 * `DurableConfig`, `TenancyConfig`.
 *
 * Every semantic pinned here was established by live probe against real AWS
 * (us-east-1, 2026-08-11) rather than read off the docs; the probe results are
 * quoted at each assertion so a future reader can tell a measured contract from
 * an assumed one.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateFunctionCommand,
  DeleteFunctionCommand,
  UpdateFunctionConfigurationCommand,
  PutFunctionCodeSigningConfigCommand,
  DeleteFunctionCodeSigningConfigCommand,
  PutRuntimeManagementConfigCommand,
  GetRuntimeManagementConfigCommand,
  GetFunctionCodeSigningConfigCommand,
  GetFunctionCommand,
  ResourceNotFoundException,
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

const BASE_PROPS = {
  FunctionName: 'fn',
  Code: { S3Bucket: 'b', S3Key: 'k' },
  Role: 'arn:aws:iam::123456789012:role/exec',
  Runtime: 'nodejs22.x',
  Handler: 'index.handler',
};

/** Commands of the given type sent through the mocked client, in order. */
function sentOfType<T>(ctor: new (...args: never[]) => T): T[] {
  return mockSend.mock.calls.map((c) => c[0]).filter((c): c is T => c instanceof ctor);
}

describe('AWS::Lambda::Function #609 property backfill', () => {
  let provider: LambdaFunctionProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new LambdaFunctionProvider();
  });

  describe('declaration', () => {
    it('declares the four wired properties as handled', () => {
      const handled = provider.handledProperties.get('AWS::Lambda::Function');
      expect(handled?.has('CodeSigningConfigArn')).toBe(true);
      expect(handled?.has('RuntimeManagementConfig')).toBe(true);
      expect(handled?.has('DurableConfig')).toBe(true);
      expect(handled?.has('TenancyConfig')).toBe(true);
    });

    it('declares PublishToLatestPublished unhandled-by-design with a rationale', () => {
      // No member on ANY @aws-sdk/client-lambda request shape — it is a
      // CloudFormation-orchestration directive, so there is nothing to send.
      const rationale = provider.unhandledByDesign
        ?.get('AWS::Lambda::Function')
        ?.get('PublishToLatestPublished');
      expect(rationale).toBeTruthy();
      expect(rationale).toMatch(/CloudFormation-only/i);
    });

    it('does NOT claim the two Lambda-managed-instances properties', () => {
      // FunctionScalingConfig is rejected by AWS unless the function carries a
      // CapacityProviderConfig ("The function provided by the arn does not
      // contain a capacity provider configuration"), so the pair is deferred
      // together rather than half-wired.
      const handled = provider.handledProperties.get('AWS::Lambda::Function');
      expect(handled?.has('CapacityProviderConfig')).toBe(false);
      expect(handled?.has('FunctionScalingConfig')).toBe(false);
    });
  });

  describe('create', () => {
    it('sends DurableConfig / TenancyConfig / CodeSigningConfigArn on CreateFunction', async () => {
      mockSend.mockResolvedValueOnce({ FunctionName: 'fn', FunctionArn: 'arn:fn' });

      await provider.create('Fn', 'AWS::Lambda::Function', {
        ...BASE_PROPS,
        DurableConfig: { ExecutionTimeout: 3600, RetentionPeriodInDays: 14 },
        TenancyConfig: { TenantIsolationMode: 'PER_TENANT' },
        CodeSigningConfigArn: 'arn:aws:lambda:us-east-1:123456789012:code-signing-config:csc-1',
      });

      const create = sentOfType(CreateFunctionCommand)[0];
      expect(create?.input.DurableConfig).toEqual({
        ExecutionTimeout: 3600,
        RetentionPeriodInDays: 14,
      });
      expect(create?.input.TenancyConfig).toEqual({ TenantIsolationMode: 'PER_TENANT' });
      expect(create?.input.CodeSigningConfigArn).toBe(
        'arn:aws:lambda:us-east-1:123456789012:code-signing-config:csc-1'
      );
    });

    it('sets RuntimeManagementConfig via a post-create PutRuntimeManagementConfig', async () => {
      // Not a CreateFunction member: the SDK declares no such field on any
      // create/update request shape, only the separate Put API.
      mockSend.mockResolvedValueOnce({ FunctionName: 'fn', FunctionArn: 'arn:fn' });
      mockSend.mockResolvedValueOnce({ Configuration: { State: 'Active' } }); // waiter poll
      mockSend.mockResolvedValueOnce({});

      await provider.create('Fn', 'AWS::Lambda::Function', {
        ...BASE_PROPS,
        RuntimeManagementConfig: {
          UpdateRuntimeOn: 'Manual',
          RuntimeVersionArn: 'arn:aws:lambda:us-east-1::runtime:abc',
        },
      });

      expect(sentOfType(CreateFunctionCommand)[0]?.input).not.toHaveProperty(
        'RuntimeManagementConfig'
      );
      expect(sentOfType(PutRuntimeManagementConfigCommand)[0]?.input).toEqual({
        FunctionName: 'fn',
        UpdateRuntimeOn: 'Manual',
        RuntimeVersionArn: 'arn:aws:lambda:us-east-1::runtime:abc',
      });
    });

    it('waits for the function to leave Pending before PutRuntimeManagementConfig', async () => {
      // Regression pin for a bug the unit tests could NOT see and the integ
      // caught (2026-08-11): CreateFunction returns while the function is
      // `Pending`, and unlike PutFunctionRecursionConfig / PutFunctionConcurrency
      // this API rejects that state outright ("The operation cannot be performed
      // at this time... currently in the following state: 'Pending'"), which
      // then tripped the atomicity contract and deleted the function.
      mockSend.mockResolvedValueOnce({ FunctionName: 'fn', FunctionArn: 'arn:fn' });
      // The waiter's GetFunction poll: still Pending once, then Active.
      mockSend.mockResolvedValueOnce({ Configuration: { State: 'Pending' } });
      mockSend.mockResolvedValueOnce({ Configuration: { State: 'Active' } });
      mockSend.mockResolvedValueOnce({});

      await provider.create('Fn', 'AWS::Lambda::Function', {
        ...BASE_PROPS,
        RuntimeManagementConfig: { UpdateRuntimeOn: 'FunctionUpdate' },
      });

      // The Put must be sent, and only AFTER the polling.
      const order = mockSend.mock.calls.map((c) => c[0].constructor.name);
      const putIndex = order.indexOf('PutRuntimeManagementConfigCommand');
      const firstGetIndex = order.indexOf('GetFunctionCommand');
      expect(putIndex).toBeGreaterThan(-1);
      expect(firstGetIndex).toBeGreaterThan(-1);
      expect(putIndex).toBeGreaterThan(firstGetIndex);
      // TWO polls, not one. Ordering alone is satisfied by a single probe that
      // never inspects `State`, so a regression to "probe once, proceed while
      // Pending" would ship silently — the mock deliberately answers Pending
      // then Active, so a real waiter must poll twice to get past the first.
      expect(sentOfType(GetFunctionCommand).length).toBeGreaterThanOrEqual(2);
    });

    it('does NOT wait when the template omits RuntimeManagementConfig', async () => {
      // The wait is scoped to the opt-in property: a plain Lambda must not pay
      // the Active-transition cost the provider deliberately avoids.
      mockSend.mockResolvedValueOnce({ FunctionName: 'fn', FunctionArn: 'arn:fn' });

      await provider.create('Fn', 'AWS::Lambda::Function', { ...BASE_PROPS });

      expect(sentOfType(GetFunctionCommand)).toHaveLength(0);
    });

    it('omits the four properties entirely when the template does not declare them', async () => {
      mockSend.mockResolvedValueOnce({ FunctionName: 'fn', FunctionArn: 'arn:fn' });

      await provider.create('Fn', 'AWS::Lambda::Function', { ...BASE_PROPS });

      const input = sentOfType(CreateFunctionCommand)[0]?.input;
      expect(input?.DurableConfig).toBeUndefined();
      expect(input?.TenancyConfig).toBeUndefined();
      expect(input?.CodeSigningConfigArn).toBeUndefined();
      expect(sentOfType(PutRuntimeManagementConfigCommand)).toHaveLength(0);
    });

    it('deletes the partially-created function when PutRuntimeManagementConfig fails', async () => {
      // Same atomicity contract as RecursiveLoop / ReservedConcurrentExecutions:
      // the function exists on AWS without the requested config, so it is torn
      // down and the next deploy retry sees a fresh slate.
      mockSend.mockResolvedValueOnce({ FunctionName: 'fn', FunctionArn: 'arn:fn' });
      mockSend.mockResolvedValueOnce({ Configuration: { State: 'Active' } }); // waiter poll
      mockSend.mockRejectedValueOnce(new Error('runtime version not found'));
      mockSend.mockResolvedValueOnce({});

      await expect(
        provider.create('Fn', 'AWS::Lambda::Function', {
          ...BASE_PROPS,
          RuntimeManagementConfig: { UpdateRuntimeOn: 'Manual' },
        })
      ).rejects.toThrow(ProvisioningError);

      const deletes = sentOfType(DeleteFunctionCommand);
      expect(deletes).toHaveLength(1);
      expect(deletes[0]?.input.FunctionName).toBe('fn');
    });

    it('retries the atomicity cleanup when DeleteFunction hits a state conflict', async () => {
      // An Active-wait TIMEOUT leaves the function `Pending`, and DeleteFunction
      // refuses a Pending function — so a single-shot cleanup would genuinely
      // orphan it. (The non-timeout arms self-heal via the outer withRetry,
      // whose table carries the Pending message; a waiter-timeout message does
      // not, which is the case that must clean up after itself.)
      Object.defineProperty(provider, 'cleanupDeleteRetryDelayMs', { value: 0 });
      mockSend.mockResolvedValueOnce({ FunctionName: 'fn', FunctionArn: 'arn:fn' });
      mockSend.mockResolvedValueOnce({ Configuration: { State: 'Active' } }); // waiter poll
      mockSend.mockRejectedValueOnce(new Error('runtime version not found')); // the Put
      mockSend.mockRejectedValueOnce(
        new Error(
          'The operation cannot be performed at this time. The function is currently in the following state: Pending'
        )
      );
      mockSend.mockResolvedValueOnce({}); // second delete attempt succeeds

      await expect(
        provider.create('Fn', 'AWS::Lambda::Function', {
          ...BASE_PROPS,
          RuntimeManagementConfig: { UpdateRuntimeOn: 'Manual' },
        })
      ).rejects.toThrow(ProvisioningError);

      expect(sentOfType(DeleteFunctionCommand)).toHaveLength(2);
    });

    it('does NOT retry the cleanup on a non-conflict delete failure', async () => {
      // Auth / already-deleted will not change on a retry, so burning the
      // budget there just slows a failed deploy down.
      Object.defineProperty(provider, 'cleanupDeleteRetryDelayMs', { value: 0 });
      mockSend.mockResolvedValueOnce({ FunctionName: 'fn', FunctionArn: 'arn:fn' });
      mockSend.mockResolvedValueOnce({ Configuration: { State: 'Active' } });
      mockSend.mockRejectedValueOnce(new Error('runtime version not found'));
      mockSend.mockRejectedValueOnce(new Error('AccessDeniedException: not authorized'));

      await expect(
        provider.create('Fn', 'AWS::Lambda::Function', {
          ...BASE_PROPS,
          RuntimeManagementConfig: { UpdateRuntimeOn: 'Manual' },
        })
      ).rejects.toThrow(ProvisioningError);

      expect(sentOfType(DeleteFunctionCommand)).toHaveLength(1);
    });

    it('names the property in the thrown error so the user can tell which call failed', async () => {
      mockSend.mockResolvedValueOnce({ FunctionName: 'fn', FunctionArn: 'arn:fn' });
      mockSend.mockResolvedValueOnce({ Configuration: { State: 'Active' } }); // waiter poll
      mockSend.mockRejectedValueOnce(new Error('boom'));
      mockSend.mockResolvedValueOnce({});

      await expect(
        provider.create('Fn', 'AWS::Lambda::Function', {
          ...BASE_PROPS,
          RuntimeManagementConfig: { UpdateRuntimeOn: 'Manual' },
        })
      ).rejects.toThrow(/Failed to set RuntimeManagementConfig on Lambda function Fn/);
    });
  });

  describe('update — DurableConfig', () => {
    /** GetFunction + the tag readback the update path issues after the mutation. */
    function mockUpdateTail() {
      // LastUpdateStatus satisfies waitUntilFunctionUpdatedV2, which the
      // provider awaits after any UpdateFunctionConfiguration call.
      mockSend.mockResolvedValue({
        Configuration: {
          FunctionArn: 'arn:fn',
          FunctionName: 'fn',
          State: 'Active',
          LastUpdateStatus: 'Successful',
        },
      });
    }

    it('passes a both-sides-present change through UpdateFunctionConfiguration', async () => {
      // Live-probed: an in-place edit IS accepted when the function was created
      // with a durable config (3600 -> 7200 readback confirmed).
      mockUpdateTail();

      await provider.update(
        'Fn',
        'fn',
        'AWS::Lambda::Function',
        { ...BASE_PROPS, DurableConfig: { ExecutionTimeout: 7200, RetentionPeriodInDays: 21 } },
        { ...BASE_PROPS, DurableConfig: { ExecutionTimeout: 3600, RetentionPeriodInDays: 14 } }
      );

      const cfg = sentOfType(UpdateFunctionConfigurationCommand)[0];
      expect(cfg?.input.DurableConfig).toEqual({
        ExecutionTimeout: 7200,
        RetentionPeriodInDays: 21,
      });
    });

    it('does NOT synthesize a reset value when the property is dropped', async () => {
      // Unlike every other field in that request block, DurableConfig has NO
      // reset payload: omitting it keeps the live value and an empty object is
      // rejected for the required ExecutionTimeout. The removal is routed to
      // replacement instead (see the replacement-rule test below), so the
      // update path must not invent a clear value.
      mockUpdateTail();

      await provider.update(
        'Fn',
        'fn',
        'AWS::Lambda::Function',
        { ...BASE_PROPS, Description: 'changed' },
        { ...BASE_PROPS, DurableConfig: { ExecutionTimeout: 3600 } }
      );

      const cfg = sentOfType(UpdateFunctionConfigurationCommand)[0];
      expect(cfg?.input.DurableConfig).toBeUndefined();
    });
  });

  describe('update — CodeSigningConfigArn', () => {
    function mockUpdateTail() {
      // LastUpdateStatus satisfies waitUntilFunctionUpdatedV2, which the
      // provider awaits after any UpdateFunctionConfiguration call.
      mockSend.mockResolvedValue({
        Configuration: {
          FunctionArn: 'arn:fn',
          FunctionName: 'fn',
          State: 'Active',
          LastUpdateStatus: 'Successful',
        },
      });
    }

    it('attaches via PutFunctionCodeSigningConfig when added', async () => {
      mockUpdateTail();

      await provider.update(
        'Fn',
        'fn',
        'AWS::Lambda::Function',
        { ...BASE_PROPS, CodeSigningConfigArn: 'arn:csc:new' },
        { ...BASE_PROPS }
      );

      expect(sentOfType(PutFunctionCodeSigningConfigCommand)[0]?.input).toEqual({
        FunctionName: 'fn',
        CodeSigningConfigArn: 'arn:csc:new',
      });
      expect(sentOfType(DeleteFunctionCodeSigningConfigCommand)).toHaveLength(0);
    });

    it('DETACHES via DeleteFunctionCodeSigningConfig when the template drops it', async () => {
      // The #1160 absent-field-removal class. Leaving the old config attached
      // would keep enforcing code signing the template no longer declares —
      // for a security control, the direction that matters.
      mockUpdateTail();

      await provider.update(
        'Fn',
        'fn',
        'AWS::Lambda::Function',
        { ...BASE_PROPS },
        { ...BASE_PROPS, CodeSigningConfigArn: 'arn:csc:old' }
      );

      expect(sentOfType(DeleteFunctionCodeSigningConfigCommand)[0]?.input).toEqual({
        FunctionName: 'fn',
      });
      expect(sentOfType(PutFunctionCodeSigningConfigCommand)).toHaveLength(0);
    });

    it('DETACHES BEFORE the code update, so an unsigned redeploy is not refused', async () => {
      // `UpdateFunctionCode` is validated against the config attached AT THE
      // TIME OF THE CALL, so dropping an enforcing code-signing config and
      // shipping an unsigned artifact in one change fails with
      // CodeVerificationFailedException if the detach runs afterwards.
      mockUpdateTail();

      await provider.update(
        'Fn',
        'fn',
        'AWS::Lambda::Function',
        { ...BASE_PROPS, Code: { S3Bucket: 'b', S3Key: 'new-key' } },
        { ...BASE_PROPS, CodeSigningConfigArn: 'arn:csc:old' }
      );

      const order = mockSend.mock.calls.map((c) => c[0].constructor.name);
      const detachIndex = order.indexOf('DeleteFunctionCodeSigningConfigCommand');
      const codeIndex = order.indexOf('UpdateFunctionCodeCommand');
      expect(detachIndex).toBeGreaterThan(-1);
      expect(codeIndex).toBeGreaterThan(-1);
      expect(detachIndex).toBeLessThan(codeIndex);
    });

    it('ATTACHES AFTER the code update, so enforcement follows the signed artifact', async () => {
      mockUpdateTail();

      await provider.update(
        'Fn',
        'fn',
        'AWS::Lambda::Function',
        {
          ...BASE_PROPS,
          Code: { S3Bucket: 'b', S3Key: 'new-key' },
          CodeSigningConfigArn: 'arn:csc:new',
        },
        { ...BASE_PROPS }
      );

      const order = mockSend.mock.calls.map((c) => c[0].constructor.name);
      const attachIndex = order.indexOf('PutFunctionCodeSigningConfigCommand');
      const codeIndex = order.indexOf('UpdateFunctionCodeCommand');
      expect(attachIndex).toBeGreaterThan(-1);
      expect(codeIndex).toBeGreaterThan(-1);
      expect(attachIndex).toBeGreaterThan(codeIndex);
    });

    it('issues no code-signing call when the ARN is unchanged', async () => {
      mockUpdateTail();

      await provider.update(
        'Fn',
        'fn',
        'AWS::Lambda::Function',
        { ...BASE_PROPS, Description: 'changed', CodeSigningConfigArn: 'arn:csc:same' },
        { ...BASE_PROPS, CodeSigningConfigArn: 'arn:csc:same' }
      );

      expect(sentOfType(PutFunctionCodeSigningConfigCommand)).toHaveLength(0);
      expect(sentOfType(DeleteFunctionCodeSigningConfigCommand)).toHaveLength(0);
    });

    it('is not carried on UpdateFunctionConfiguration (no such member)', async () => {
      mockUpdateTail();

      await provider.update(
        'Fn',
        'fn',
        'AWS::Lambda::Function',
        { ...BASE_PROPS, Description: 'changed', CodeSigningConfigArn: 'arn:csc:new' },
        { ...BASE_PROPS, Description: 'old' }
      );

      // The double cast is the assertion's whole point: the SDK request type
      // declares no `CodeSigningConfigArn` member, so this checks the provider
      // does not smuggle one in at runtime.
      const cfg = sentOfType(UpdateFunctionConfigurationCommand)[0]?.input as unknown as
        | Record<string, unknown>
        | undefined;
      expect(cfg?.['CodeSigningConfigArn']).toBeUndefined();
    });
  });

  describe('update — RuntimeManagementConfig', () => {
    function mockUpdateTail() {
      // LastUpdateStatus satisfies waitUntilFunctionUpdatedV2, which the
      // provider awaits after any UpdateFunctionConfiguration call.
      mockSend.mockResolvedValue({
        Configuration: {
          FunctionArn: 'arn:fn',
          FunctionName: 'fn',
          State: 'Active',
          LastUpdateStatus: 'Successful',
        },
      });
    }

    it('re-sends the block on change', async () => {
      mockUpdateTail();

      await provider.update(
        'Fn',
        'fn',
        'AWS::Lambda::Function',
        { ...BASE_PROPS, RuntimeManagementConfig: { UpdateRuntimeOn: 'FunctionUpdate' } },
        { ...BASE_PROPS, RuntimeManagementConfig: { UpdateRuntimeOn: 'Auto' } }
      );

      expect(sentOfType(PutRuntimeManagementConfigCommand)[0]?.input).toEqual({
        FunctionName: 'fn',
        UpdateRuntimeOn: 'FunctionUpdate',
        RuntimeVersionArn: undefined,
      });
    });

    it('resets to the AWS default Auto when the template drops the block', async () => {
      // There is no delete counterpart for this API, so removal is expressed
      // as the reset-to-default value — the same idiom clearOnUpdateRemoval
      // applies to the UpdateFunctionConfiguration fields.
      mockUpdateTail();

      await provider.update(
        'Fn',
        'fn',
        'AWS::Lambda::Function',
        { ...BASE_PROPS },
        {
          ...BASE_PROPS,
          RuntimeManagementConfig: {
            UpdateRuntimeOn: 'Manual',
            RuntimeVersionArn: 'arn:aws:lambda:us-east-1::runtime:abc',
          },
        }
      );

      expect(sentOfType(PutRuntimeManagementConfigCommand)[0]?.input).toEqual({
        FunctionName: 'fn',
        UpdateRuntimeOn: 'Auto',
        RuntimeVersionArn: undefined,
      });
    });

    it('issues no call when the block is merely REORDERED', async () => {
      // The comparison is member-by-member, not JSON.stringify — a stringify
      // compare is key-order sensitive and would fire a redundant Put.
      mockUpdateTail();

      await provider.update(
        'Fn',
        'fn',
        'AWS::Lambda::Function',
        {
          ...BASE_PROPS,
          Description: 'changed',
          RuntimeManagementConfig: {
            RuntimeVersionArn: 'arn:aws:lambda:us-east-1::runtime:abc',
            UpdateRuntimeOn: 'Manual',
          },
        },
        {
          ...BASE_PROPS,
          RuntimeManagementConfig: {
            UpdateRuntimeOn: 'Manual',
            RuntimeVersionArn: 'arn:aws:lambda:us-east-1::runtime:abc',
          },
        }
      );

      expect(sentOfType(PutRuntimeManagementConfigCommand)).toHaveLength(0);
    });

    it('issues no call when the block is unchanged', async () => {
      mockUpdateTail();

      await provider.update(
        'Fn',
        'fn',
        'AWS::Lambda::Function',
        {
          ...BASE_PROPS,
          Description: 'changed',
          RuntimeManagementConfig: { UpdateRuntimeOn: 'Auto' },
        },
        { ...BASE_PROPS, RuntimeManagementConfig: { UpdateRuntimeOn: 'Auto' } }
      );

      expect(sentOfType(PutRuntimeManagementConfigCommand)).toHaveLength(0);
    });
  });

  describe('readCurrentState', () => {
    /**
     * GetFunction, then the four secondary control-plane reads the method
     * issues in order: recursion config, concurrency, runtime management,
     * code signing.
     */
    function mockReadback(opts: {
      configuration: Record<string, unknown>;
      runtimeManagement?: Record<string, unknown> | Error;
      codeSigning?: Record<string, unknown> | Error;
    }) {
      mockSend.mockResolvedValueOnce({ Configuration: opts.configuration, Tags: {} });
      mockSend.mockResolvedValueOnce({}); // GetFunctionRecursionConfig
      mockSend.mockResolvedValueOnce({}); // GetFunctionConcurrency
      const rm = opts.runtimeManagement;
      if (rm instanceof Error) mockSend.mockRejectedValueOnce(rm);
      else mockSend.mockResolvedValueOnce(rm ?? {});
      const cs = opts.codeSigning;
      if (cs instanceof Error) mockSend.mockRejectedValueOnce(cs);
      else mockSend.mockResolvedValueOnce(cs ?? {});
    }

    it('reads DurableConfig and TenancyConfig off the GetFunction response', async () => {
      // Both are members of FunctionConfiguration, so no extra call is needed.
      mockReadback({
        configuration: {
          FunctionName: 'fn',
          DurableConfig: { RetentionPeriodInDays: 21, ExecutionTimeout: 7200 },
          TenancyConfig: { TenantIsolationMode: 'PER_TENANT' },
        },
      });

      const state = await provider.readCurrentState('fn', 'Fn', 'AWS::Lambda::Function');

      expect(state?.['DurableConfig']).toEqual({
        ExecutionTimeout: 7200,
        RetentionPeriodInDays: 21,
      });
      expect(state?.['TenancyConfig']).toEqual({ TenantIsolationMode: 'PER_TENANT' });
    });

    it('reads RuntimeManagementConfig and CodeSigningConfigArn via their own APIs', async () => {
      mockReadback({
        configuration: { FunctionName: 'fn' },
        runtimeManagement: {
          UpdateRuntimeOn: 'Manual',
          RuntimeVersionArn: 'arn:aws:lambda:us-east-1::runtime:abc',
        },
        codeSigning: { CodeSigningConfigArn: 'arn:csc:1' },
      });

      const state = await provider.readCurrentState('fn', 'Fn', 'AWS::Lambda::Function');

      expect(sentOfType(GetRuntimeManagementConfigCommand)).toHaveLength(1);
      expect(sentOfType(GetFunctionCodeSigningConfigCommand)).toHaveLength(1);
      expect(state?.['RuntimeManagementConfig']).toEqual({
        UpdateRuntimeOn: 'Manual',
        RuntimeVersionArn: 'arn:aws:lambda:us-east-1::runtime:abc',
      });
      expect(state?.['CodeSigningConfigArn']).toBe('arn:csc:1');
    });

    it('skips ZIP-only runtime-management and code-signing reads for image functions', async () => {
      mockSend.mockResolvedValueOnce({
        Configuration: { FunctionName: 'fn', PackageType: 'Image' },
        Code: { ImageUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/fn:latest' },
        Tags: {},
      });
      mockSend.mockResolvedValueOnce({}); // GetFunctionRecursionConfig
      mockSend.mockResolvedValueOnce({}); // GetFunctionConcurrency

      const state = await provider.readCurrentState('fn', 'Fn', 'AWS::Lambda::Function');

      expect(sentOfType(GetRuntimeManagementConfigCommand)).toHaveLength(0);
      expect(sentOfType(GetFunctionCodeSigningConfigCommand)).toHaveLength(0);
      expect(state?.['PackageType']).toBe('Image');
      expect(state?.['Code']).toEqual({
        ImageUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/fn:latest',
      });
      expect(state).not.toHaveProperty('RuntimeManagementConfig');
      expect(state).not.toHaveProperty('CodeSigningConfigArn');
    });

    it('omits the keys when AWS reports no value (no phantom drift)', async () => {
      mockReadback({ configuration: { FunctionName: 'fn' } });

      const state = await provider.readCurrentState('fn', 'Fn', 'AWS::Lambda::Function');

      expect(state).not.toHaveProperty('DurableConfig');
      expect(state).not.toHaveProperty('TenancyConfig');
      expect(state).not.toHaveProperty('RuntimeManagementConfig');
      expect(state).not.toHaveProperty('CodeSigningConfigArn');
    });

    it('omits CodeSigningConfigArn when the function has none attached', async () => {
      // AWS raises ResourceNotFoundException rather than returning an empty
      // response for an unsigned function — the common case, so it must not
      // fail the whole snapshot.
      mockReadback({
        configuration: { FunctionName: 'fn' },
        codeSigning: new ResourceNotFoundException({
          message: 'not found',
          $metadata: {},
        }),
      });

      const state = await provider.readCurrentState('fn', 'Fn', 'AWS::Lambda::Function');

      expect(state).toBeDefined();
      expect(state).not.toHaveProperty('CodeSigningConfigArn');
      expect(state?.['FunctionName']).toBe('fn');
    });

    it('still returns a usable snapshot when a secondary read fails outright', async () => {
      mockReadback({
        configuration: { FunctionName: 'fn' },
        runtimeManagement: new Error('AccessDenied'),
      });

      const state = await provider.readCurrentState('fn', 'Fn', 'AWS::Lambda::Function');

      expect(state?.['FunctionName']).toBe('fn');
      expect(state).not.toHaveProperty('RuntimeManagementConfig');
    });

    it('tolerates a non-not-found failure of the code-signing read', async () => {
      // The RNFE arm above is the common case (no config attached); this is the
      // AccessDenied / throttle arm, which must also leave the snapshot usable
      // rather than failing the whole drift read.
      mockReadback({
        configuration: { FunctionName: 'fn' },
        codeSigning: new Error('AccessDeniedException: not authorized'),
      });

      const state = await provider.readCurrentState('fn', 'Fn', 'AWS::Lambda::Function');

      expect(state?.['FunctionName']).toBe('fn');
      expect(state).not.toHaveProperty('CodeSigningConfigArn');
    });

    it('still issues the primary GetFunction read', async () => {
      mockReadback({ configuration: { FunctionName: 'fn' } });
      await provider.readCurrentState('fn', 'Fn', 'AWS::Lambda::Function');
      expect(sentOfType(GetFunctionCommand)).toHaveLength(1);
    });
  });
});
