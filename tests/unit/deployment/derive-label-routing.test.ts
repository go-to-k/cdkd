/**
 * Unit tests for the #614 §9 live-progress label routing inference.
 *
 * `deriveLabelRouting` is the pure-functional helper called from
 * `DeployEngine.peekRoutingForLabel` to decide whether a resource's
 * live-progress task label should carry the `[CC API]` tag.
 * Cosmetic-only — errors here never surface, so the helper swallows
 * exceptions and returns `undefined` (label stays untagged).
 */

import { describe, it, expect, vi } from 'vite-plus/test';
import { deriveLabelRouting } from '../../../src/deployment/deploy-engine.js';
import type { ResourceChange, ResourceState } from '../../../src/types/state.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { ResourceProvider } from '../../../src/types/resource.js';

function res(
  resourceType: string,
  partial: Partial<ResourceState> = {}
): ResourceState {
  return {
    physicalId: 'pid',
    resourceType,
    properties: {},
    attributes: {},
    dependencies: [],
    ...partial,
  };
}

function makeRegistry(
  result: { provider: ResourceProvider; provisionedBy: 'sdk' | 'cc-api' } | (() => never)
): Pick<ProviderRegistry, 'getProviderFor'> {
  return {
    getProviderFor:
      typeof result === 'function'
        ? vi.fn().mockImplementation(result)
        : vi.fn().mockReturnValue(result),
  };
}

const noopProvider: ResourceProvider = {
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  getAttribute: vi.fn(),
};

describe('deriveLabelRouting (#614 §9)', () => {
  it('CREATE: returns cc-api when getProviderFor routes via Cloud Control', () => {
    const change: ResourceChange = {
      logicalId: 'MyLambda',
      changeType: 'CREATE',
      resourceType: 'AWS::Lambda::Function',
      desiredProperties: { RuntimeManagementConfig: { UpdateRuntimeOn: 'FunctionUpdate' } },
    };
    const registry = makeRegistry({ provider: noopProvider, provisionedBy: 'cc-api' });
    expect(deriveLabelRouting(change, undefined, registry)).toBe('cc-api');
  });

  it('CREATE: returns sdk when getProviderFor routes via SDK provider', () => {
    const change: ResourceChange = {
      logicalId: 'MyQueue',
      changeType: 'CREATE',
      resourceType: 'AWS::SQS::Queue',
      desiredProperties: { QueueName: 'foo' },
    };
    const registry = makeRegistry({ provider: noopProvider, provisionedBy: 'sdk' });
    expect(deriveLabelRouting(change, undefined, registry)).toBe('sdk');
  });

  it('UPDATE: threads the recorded sticky `provisionedBy` so an already-CC resource stays tagged on update', () => {
    const change: ResourceChange = {
      logicalId: 'MyLambda',
      changeType: 'UPDATE',
      resourceType: 'AWS::Lambda::Function',
      desiredProperties: { Runtime: 'nodejs20.x' },
    };
    const state = res('AWS::Lambda::Function', { provisionedBy: 'cc-api' });
    const registry = makeRegistry({ provider: noopProvider, provisionedBy: 'cc-api' });
    expect(deriveLabelRouting(change, state, registry)).toBe('cc-api');

    // The threaded `provisionedBy` reached the registry — important so
    // sticky CC routing is honored on the live-progress label even when
    // the update payload has no silent-drop property of its own.
    expect(registry.getProviderFor).toHaveBeenCalledWith(
      expect.objectContaining({ provisionedBy: 'cc-api' })
    );
  });

  it('DELETE: short-circuits and returns the recorded provisionedBy without calling the registry', () => {
    const change: ResourceChange = {
      logicalId: 'MyLambda',
      changeType: 'DELETE',
      resourceType: 'AWS::Lambda::Function',
    };
    const state = res('AWS::Lambda::Function', { provisionedBy: 'cc-api' });
    const registry = makeRegistry({ provider: noopProvider, provisionedBy: 'sdk' });

    expect(deriveLabelRouting(change, state, registry)).toBe('cc-api');
    // No registry call — DELETE routing is fully driven by recorded state.
    expect(registry.getProviderFor).not.toHaveBeenCalled();
  });

  it('DELETE on a legacy state record (no provisionedBy field) returns undefined → label stays untagged', () => {
    const change: ResourceChange = {
      logicalId: 'OldLambda',
      changeType: 'DELETE',
      resourceType: 'AWS::Lambda::Function',
    };
    const state = res('AWS::Lambda::Function'); // no provisionedBy
    const registry = makeRegistry({ provider: noopProvider, provisionedBy: 'sdk' });
    expect(deriveLabelRouting(change, state, registry)).toBeUndefined();
  });

  it('swallows registry exceptions and returns undefined (label stays untagged)', () => {
    const change: ResourceChange = {
      logicalId: 'WeirdType',
      changeType: 'CREATE',
      resourceType: 'AWS::Unknown::Thing',
      desiredProperties: {},
    };
    const registry = makeRegistry(() => {
      throw new Error('no provider for AWS::Unknown::Thing');
    });
    // Pure cosmetic helper — must never throw; the real `getProviderFor`
    // call inside provisionResourceBody is the load-bearing dispatch and
    // surfaces the same error there.
    expect(deriveLabelRouting(change, undefined, registry)).toBeUndefined();
  });
});
