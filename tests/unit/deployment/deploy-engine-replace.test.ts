/**
 * Unit coverage for the `--replace` engine wire-through.
 *
 * When a `provider.update()` hard-rejects an in-place update with a typed
 * `ResourceUpdateNotSupportedError` (an immutable property changed on a type
 * cdkd has no replacement rule for), the deploy engine's normal-update catch
 * block falls back to DELETE + CREATE — but ONLY when the user opted in via
 * `--replace`. Stateful types additionally require
 * `--force-stateful-recreation`.
 *
 * The happy path is verified end-to-end against real AWS by
 * `tests/integration/glue-securityconfig-replace/verify.sh` (a Glue
 * SecurityConfiguration whose EncryptionConfiguration change is immutable).
 * This file covers the branch logic a mocked test can assert cheaply:
 *   - replace=true + non-stateful type → DELETE then CREATE (in order).
 *   - replace unset → the ResourceUpdateNotSupportedError propagates (the
 *     pre-flag behavior: the deploy fails).
 *   - replace=true + stateful type WITHOUT forceStatefulRecreation → blocked
 *     with a STATEFUL_REPLACE_BLOCKED error, no delete/create issued.
 *   - replace=true + stateful type WITH forceStatefulRecreation → replaced.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    resolve: vi.fn().mockImplementation((value: unknown) => Promise.resolve(value)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('../../../src/deployment/resource-deadline.js', () => ({
  withResourceDeadline: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}));

type StateRecord = {
  physicalId: string;
  resourceType: string;
  properties: Record<string, unknown>;
  attributes: Record<string, unknown>;
  dependencies: string[];
  provisionedBy?: 'sdk' | 'cc-api';
};

describe('DeployEngine — --replace wire-through', () => {
  let callOrder: string[];
  let provider: ResourceProvider;

  beforeEach(() => {
    callOrder = [];
    provider = {
      create: vi.fn().mockImplementation(async () => {
        callOrder.push('create');
        return { physicalId: 'new-pid', attributes: {} };
      }),
      update: vi.fn().mockImplementation(async (logicalId: string, _p: string, rt: string) => {
        callOrder.push('update');
        throw new ResourceUpdateNotSupportedError(
          rt,
          logicalId,
          'immutable on AWS — there is no update API; replacement required'
        );
      }),
      delete: vi.fn().mockImplementation(async () => {
        callOrder.push('delete');
      }),
      getAttribute: vi.fn(),
    };
  });

  function makeEngine(opts: {
    replace?: boolean;
    forceStatefulRecreation?: boolean;
  }): InstanceType<typeof DeployEngine> {
    const mockStateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-2'),
    };
    const mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    const mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    };
    const mockDiffCalculator = {
      calculateDiff: vi.fn().mockResolvedValue(new Map<string, ResourceChange>()),
      hasChanges: vi.fn().mockReturnValue(false),
      filterByType: vi.fn().mockReturnValue([]),
    };
    const mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi
        .fn()
        .mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };

    return new DeployEngine(
      mockStateBackend as unknown as never,
      mockLockManager as unknown as never,
      mockDagBuilder as unknown as never,
      mockDiffCalculator as unknown as never,
      mockProviderRegistry as unknown as never,
      {
        ...(opts.replace !== undefined && { replace: opts.replace }),
        ...(opts.forceStatefulRecreation !== undefined && {
          forceStatefulRecreation: opts.forceStatefulRecreation,
        }),
      },
      'us-east-1'
    );
  }

  async function invokeProvision(
    engine: InstanceType<typeof DeployEngine>,
    resourceType: string
  ): Promise<void> {
    const change: ResourceChange = {
      logicalId: 'MyResource',
      changeType: 'UPDATE',
      resourceType,
      currentProperties: { Mode: 'a' },
      desiredProperties: { Mode: 'b' },
      // No requiresReplacement — the in-place update is attempted, throws,
      // and only --replace turns the typed rejection into a replacement.
      propertyChanges: [{ path: 'Mode', oldValue: 'a', newValue: 'b', requiresReplacement: false }],
    };
    const stateResources: Record<string, StateRecord> = {
      MyResource: {
        physicalId: 'old-pid',
        resourceType,
        properties: { Mode: 'a' },
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk',
      },
    };
    const template: CloudFormationTemplate = {
      Resources: { MyResource: { Type: resourceType, Properties: { Mode: 'a' } } },
    };
    const provisionResource = (
      engine as unknown as {
        provisionResource: (
          logicalId: string,
          change: ResourceChange,
          stateResources: Record<string, unknown>,
          stackName: string,
          template: CloudFormationTemplate
        ) => Promise<void>;
      }
    ).provisionResource.bind(engine);
    await provisionResource('MyResource', change, stateResources, 'MyStack', template);
  }

  it('replace=true on a non-stateful type falls back to DELETE then CREATE', async () => {
    const engine = makeEngine({ replace: true });
    await invokeProvision(engine, 'AWS::Glue::SecurityConfiguration');
    expect(callOrder).toEqual(['update', 'delete', 'create']);
  });

  it('without --replace the ResourceUpdateNotSupportedError propagates (deploy fails)', async () => {
    const engine = makeEngine({});
    // provisionResource wraps the provider failure in a ProvisioningError; the
    // original typed rejection survives on `.cause`.
    const err = await invokeProvision(engine, 'AWS::Glue::SecurityConfiguration').then(
      () => null,
      (e) => e as Error & { cause?: unknown }
    );
    expect(err).not.toBeNull();
    expect(err!.cause).toBeInstanceOf(ResourceUpdateNotSupportedError);
    // No delete/create attempted — only the failed update.
    expect(callOrder).toEqual(['update']);
  });

  it('replace=true on a STATEFUL type is blocked without --force-stateful-recreation', async () => {
    const engine = makeEngine({ replace: true });
    const err = await invokeProvision(engine, 'AWS::DynamoDB::Table').then(
      () => null,
      (e) => e as Error & { cause?: { message?: string } }
    );
    expect(err).not.toBeNull();
    // The block message (carried on `.cause`) names the escape-hatch flag.
    expect(err!.cause?.message).toMatch(/--force-stateful-recreation/);
    // The destructive delete/create must NOT run.
    expect(callOrder).toEqual(['update']);
  });

  it('replace=true + --force-stateful-recreation replaces a stateful type', async () => {
    const engine = makeEngine({ replace: true, forceStatefulRecreation: true });
    await invokeProvision(engine, 'AWS::DynamoDB::Table');
    expect(callOrder).toEqual(['update', 'delete', 'create']);
  });

  it('replace=true on an S3 bucket is blocked without --force-stateful-recreation (no mid-deploy probe)', async () => {
    // The --replace guard cannot run the async ListObjectVersions probe, so a
    // deferred S3 bucket is treated conservatively as data-bearing.
    const engine = makeEngine({ replace: true });
    const err = await invokeProvision(engine, 'AWS::S3::Bucket').then(
      () => null,
      (e) => e as Error & { cause?: { message?: string } }
    );
    expect(err).not.toBeNull();
    expect(err!.cause?.message).toMatch(/--force-stateful-recreation/);
    expect(callOrder).toEqual(['update']);
  });
});
