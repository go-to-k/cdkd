/**
 * Unit coverage for the issue #1002 PR 2 post-resolution asset-reference
 * audit (design §7 step 3).
 *
 * In cdkd-assets mode the deploy engine receives the §6 mapping table via
 * `DeployEngineOptions.assetRedirect`. After the intrinsic resolver produces
 * final literal properties, any value still naming a mapped SOURCE (CDK
 * bootstrap) bucket / repo means a template shape the §7 rewrite missed —
 * the resource must fail loudly BEFORE any provider call instead of
 * deploying a split-brain reference. In legacy mode (`assetRedirect` unset)
 * the audit is a no-op and such values deploy verbatim (pre-#1002 behavior).
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { buildAssetRedirectMap } from '../../../src/assets/asset-redirect.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';
import type { AssetManifest } from '../../../src/types/assets.js';

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

const ACCOUNT = '123456789012';
const REGION = 'us-east-1';
const CDK_BUCKET = `cdk-hnb659fds-assets-${ACCOUNT}-${REGION}`;
const CDKD_BUCKET = `cdkd-assets-${ACCOUNT}-${REGION}`;

function redirectMap() {
  const manifest: AssetManifest = {
    version: '38.0.0',
    files: {
      aaaa1111: {
        displayName: 'Code',
        source: { path: 'asset.aaaa1111', packaging: 'zip' },
        destinations: {
          d1: {
            bucketName: 'cdk-hnb659fds-assets-${AWS::AccountId}-${AWS::Region}',
            objectKey: 'aaaa1111.zip',
          },
        },
      },
    },
    dockerImages: {},
  };
  return buildAssetRedirectMap(
    manifest,
    {
      assetBucket: CDKD_BUCKET,
      containerRepo: `cdkd-container-assets-${ACCOUNT}-${REGION}`,
      assetSupportVersion: 1,
      createdAt: '2026-07-15T00:00:00.000Z',
    },
    ACCOUNT,
    REGION
  );
}

describe('DeployEngine — post-resolution asset-reference audit (#1002 PR 2)', () => {
  let provider: ResourceProvider;

  beforeEach(() => {
    provider = {
      create: vi.fn().mockResolvedValue({ physicalId: 'pid-1', attributes: {} }),
      update: vi.fn().mockResolvedValue({ physicalId: 'pid-1', wasReplaced: false }),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
    };
  });

  function makeEngine(withRedirect: boolean): InstanceType<typeof DeployEngine> {
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
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
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
      { ...(withRedirect && { assetRedirect: redirectMap() }) },
      REGION
    );
  }

  async function invokeCreate(
    engine: InstanceType<typeof DeployEngine>,
    properties: Record<string, unknown>
  ): Promise<Error | null> {
    const change: ResourceChange = {
      logicalId: 'Fn',
      changeType: 'CREATE',
      resourceType: 'AWS::Lambda::Function',
      desiredProperties: properties,
    };
    const template: CloudFormationTemplate = {
      Resources: { Fn: { Type: 'AWS::Lambda::Function', Properties: properties } },
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
    return provisionResource('Fn', change, {}, 'MyStack', template).then(
      () => null,
      (e) => e as Error
    );
  }

  it('fails a resource whose resolved properties still name a mapped source, before any provider call', async () => {
    const engine = makeEngine(true);
    const err = await invokeCreate(engine, {
      Code: { S3Bucket: CDK_BUCKET, S3Key: 'aaaa1111.zip' },
    });
    expect(err).not.toBeNull();
    // provisionResource wraps failures; the audit's ProvisioningError
    // survives on `.cause`.
    const cause = (err as Error & { cause?: Error }).cause;
    expect(cause?.message).toMatch(/Unrewritten asset reference/);
    expect(cause?.message).toContain('Code.S3Bucket');
    expect(cause?.message).toContain('--use-cdk-bootstrap-assets');
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('passes cleanly rewritten properties through to the provider', async () => {
    const engine = makeEngine(true);
    const err = await invokeCreate(engine, {
      Code: { S3Bucket: CDKD_BUCKET, S3Key: 'aaaa1111.zip' },
    });
    expect(err).toBeNull();
    expect(provider.create).toHaveBeenCalled();
  });

  it('fails an UPDATE whose resolved properties still name a mapped source (audit runs before the no-change short-circuit)', async () => {
    const engine = makeEngine(true);
    const properties = { Code: { S3Bucket: CDK_BUCKET, S3Key: 'aaaa1111.zip' } };
    const change: ResourceChange = {
      logicalId: 'Fn',
      changeType: 'UPDATE',
      resourceType: 'AWS::Lambda::Function',
      currentProperties: properties,
      desiredProperties: properties,
    };
    const template: CloudFormationTemplate = {
      Resources: { Fn: { Type: 'AWS::Lambda::Function', Properties: properties } },
    };
    const stateResources = {
      Fn: {
        physicalId: 'pid-1',
        resourceType: 'AWS::Lambda::Function',
        properties,
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk' as const,
      },
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
    const err = await provisionResource('Fn', change, stateResources, 'MyStack', template).then(
      () => null,
      (e) => e as Error & { cause?: Error }
    );
    expect(err).not.toBeNull();
    expect(err!.cause?.message).toMatch(/Unrewritten asset reference/);
    expect(provider.update).not.toHaveBeenCalled();
  });

  it('is a no-op in legacy mode (no assetRedirect): CDK bucket references deploy verbatim', async () => {
    const engine = makeEngine(false);
    const err = await invokeCreate(engine, {
      Code: { S3Bucket: CDK_BUCKET, S3Key: 'aaaa1111.zip' },
    });
    expect(err).toBeNull();
    expect(provider.create).toHaveBeenCalled();
  });
});
