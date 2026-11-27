/**
 * go-to-k/cdkd#7100: CloudFormation replaces an ElastiCache replication group on
 * a NumNodeGroups change (measured: new physical id, with and without
 * UseOnlineResharding). cdkd now plans the same replacement, and the type is
 * stateful, so the deploy refuses it before any call unless
 * --force-stateful-recreation is passed, saying CloudFormation also replaces.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { provisionResource } from '../../../src/deployment/deploy-engine/provision.js';
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
  IntrinsicFunctionResolver: vi.fn(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((value: unknown) => Promise.resolve(value)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('../../../src/deployment/resource-deadline.js', () => ({
  withResourceDeadline: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}));

const SHORT_ADVICE = 'Re-run with --force-stateful-recreation to confirm the data loss';

let provider: ResourceProvider;

beforeEach(() => {
  provider = {
    create: vi.fn().mockResolvedValue({ physicalId: 'new-pid', attributes: {} }),
    update: vi.fn().mockImplementation(async (logicalId: string, _p: string, rt: string) => {
      throw new ResourceUpdateNotSupportedError(rt, logicalId, 'immutable on AWS');
    }),
    delete: vi.fn().mockResolvedValue(undefined),
    getAttribute: vi.fn(),
  };
});

function makeEngine(opts: { replace?: boolean }): InstanceType<typeof DeployEngine> {
  const registry = {
    getProvider: vi.fn().mockReturnValue(provider),
    getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
    getRegisteredTypes: vi.fn().mockReturnValue([]),
    validateResourceTypes: vi.fn(),
    validateResourceProperties: vi.fn(),
  };
  return new DeployEngine(
    { getState: vi.fn(), saveState: vi.fn() } as unknown as never,
    { acquireLockWithRetry: vi.fn(), releaseLock: vi.fn() } as unknown as never,
    {
      buildGraph: vi.fn(),
      getExecutionLevels: vi.fn().mockReturnValue([]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    } as unknown as never,
    {
      calculateDiff: vi.fn(),
      hasChanges: vi.fn(),
      filterByType: vi.fn().mockReturnValue([]),
    } as unknown as never,
    registry as unknown as never,
    { ...(opts.replace !== undefined && { replace: opts.replace }) },
    'us-east-1'
  );
}

async function refusal(type: string, path: string, oldValue: unknown, newValue: unknown): Promise<string> {
  const recorded = { [path]: oldValue };
  const desired = { [path]: newValue };
  const change: ResourceChange = {
    logicalId: 'Rg',
    changeType: 'UPDATE',
    resourceType: type,
    currentProperties: recorded,
    desiredProperties: desired,
    propertyChanges: [{ path, oldValue, newValue, requiresReplacement: true }],
  };
  const stateResources = {
    Rg: {
      physicalId: 'old-id',
      resourceType: type,
      properties: recorded,
      attributes: {},
      dependencies: [],
      provisionedBy: 'cc-api' as const,
    },
  };
  const template: CloudFormationTemplate = { Resources: { Rg: { Type: type, Properties: desired } } };
  const err = await provisionResource(
    makeEngine({}),
    'Rg',
    change,
    stateResources as unknown as Record<string, never>,
    'MyStack',
    template
  ).then(
    () => null,
    (e: unknown) => e
  );
  expect(err).not.toBeNull();
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; cur instanceof Error && i < 10; i++) {
    parts.push(cur.message, String((cur as { code?: unknown }).code ?? ''));
    cur = (cur as { cause?: unknown }).cause;
  }
  const text = parts.join('\n');
  expect(text).toContain('STATEFUL_REPLACE_BLOCKED');
  expect(provider.delete).not.toHaveBeenCalled();
  expect(provider.create).not.toHaveBeenCalled();
  return text;
}

describe('ElastiCache replication group shard-count replacement (go-to-k/cdkd#7100)', () => {
  it('refuses a NumNodeGroups replacement without the flag, saying CloudFormation replaces too', async () => {
    const text = await refusal('AWS::ElastiCache::ReplicationGroup', 'NumNodeGroups', 1, 2);
    expect(text).toContain('Rg (AWS::ElastiCache::ReplicationGroup) requires replacement (immutable property changed: NumNodeGroups)');
    expect(text).toContain('CloudFormation replaces it for this change too, so the data is lost there as well.');
    expect(text).toContain(SHORT_ADVICE);
  });

  it('refuses a NodeGroupConfiguration replacement the same way', async () => {
    const text = await refusal(
      'AWS::ElastiCache::ReplicationGroup',
      'NodeGroupConfiguration',
      [{ NodeGroupId: '0001', ReplicaCount: 1 }],
      [{ NodeGroupId: '0001', ReplicaCount: 2 }]
    );
    expect(text).toContain('immutable property changed: NodeGroupConfiguration');
    expect(text).toContain('CloudFormation replaces it for this change too');
  });

  it('does not claim CloudFormation replaces for a schema create-only property', async () => {
    const text = await refusal('AWS::ElastiCache::ReplicationGroup', 'Port', 6379, 6380);
    expect(text).not.toContain('CloudFormation replaces it for this change too');
  });
});
