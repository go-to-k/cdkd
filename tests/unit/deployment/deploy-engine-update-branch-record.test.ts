/**
 * The record each `provisionUpdate` branch writes keeps the template's policy
 * attributes and the resource's dependencies (go-to-k/cdkd#4350).
 *
 * `provisionUpdate` hands `template` and `dependencies` to `updateByReplacement`
 * and `updateInPlace` as parameters. A wrong handoff drops
 * `deletionPolicy` / `updateReplacePolicy` from the replaced record (a Retain
 * resource then deletes on destroy) or its `dependencies` (destroy ordering),
 * and no other case reads those fields back after a replacement.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState } from '../../../src/types/state.js';

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

vi.mock('../../../src/deployment/resource-deadline.js', () => ({
  withResourceDeadline: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}));

const TEMPLATE: CloudFormationTemplate = {
  Resources: {
    Other: { Type: 'AWS::SQS::Queue', Properties: {} },
    Target: {
      Type: 'AWS::SQS::Queue',
      Properties: { DelaySeconds: 5 },
      DependsOn: ['Other'],
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Delete',
    },
  },
} as unknown as CloudFormationTemplate;

describe('provisionUpdate branches keep policy attributes and dependencies (#4350)', () => {
  let provider: ResourceProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = {
      create: vi.fn().mockResolvedValue({ physicalId: 'phys-new', attributes: {} }),
      update: vi.fn().mockResolvedValue({ physicalId: 'phys-old', wasReplaced: false, attributes: {} }),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
    };
  });

  function makeEngine(): InstanceType<typeof DeployEngine> {
    const registry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };
    return new DeployEngine(
      { getState: vi.fn(), saveState: vi.fn().mockResolvedValue('etag') } as unknown as never,
      {} as unknown as never,
      {} as unknown as never,
      {} as unknown as never,
      registry as unknown as never,
      {},
      'us-east-1'
    );
  }

  async function update(requiresReplacement: boolean): Promise<ResourceState> {
    const change: ResourceChange = {
      logicalId: 'Target',
      changeType: 'UPDATE',
      resourceType: 'AWS::SQS::Queue',
      currentProperties: { DelaySeconds: 0 },
      desiredProperties: { DelaySeconds: 5 },
      propertyChanges: [
        { path: 'DelaySeconds', oldValue: 0, newValue: 5, requiresReplacement },
      ],
    } as unknown as ResourceChange;
    const stateResources: Record<string, ResourceState> = {
      Target: {
        physicalId: 'phys-old',
        resourceType: 'AWS::SQS::Queue',
        properties: { DelaySeconds: 0 },
        attributes: {},
        dependencies: [],
      },
    };
    const engine = makeEngine();
    await (
      engine as unknown as {
        provisionResource: (
          id: string,
          c: ResourceChange,
          s: Record<string, ResourceState>,
          stack: string,
          t: CloudFormationTemplate
        ) => Promise<void>;
      }
    ).provisionResource('Target', change, stateResources, 'MyStack', TEMPLATE);
    return stateResources['Target']!;
  }

  it.each([
    ['updateByReplacement', true],
    ['updateInPlace', false],
  ])('%s writes the template policies and the dependencies', async (_branch, replace) => {
    const record = await update(replace);
    // The branch really ran: a replacement creates, an in-place update updates.
    expect(replace ? provider.create : provider.update).toHaveBeenCalledTimes(1);
    expect(record.deletionPolicy).toBe('Retain');
    expect(record.updateReplacePolicy).toBe('Delete');
    expect(record.dependencies).toEqual(['Other']);
  });
});
