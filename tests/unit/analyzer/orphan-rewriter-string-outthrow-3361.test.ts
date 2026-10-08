import { describe, it, expect, vi } from 'vite-plus/test';

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

import { rewriteResourceReferences } from '../../../src/analyzer/orphan-rewriter.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { ResourceProvider } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

/**
 * Issue [#3361](https://github.com/go-to-k/cdkd/issues/3361), the
 * `src/analyzer` slice: the live `getAttribute` read's catch degrades a failed
 * read to an UNRESOLVABLE reference (collected, so the caller can list every
 * one at once) or, under `--force`, to the recorded `state.attributes` value.
 * Its reason was `err instanceof Error ? err.message : String(err)`, and
 * `String(Object.create(null))` throws, so a provider rejecting with such a
 * value rejected the whole rewrite instead of taking either arm.
 */

/** What `describeAwsFailure(x).detail` renders for a value `String()` cannot convert. */
const PLACEHOLDER = 'a value that could not be converted to text';

function registryRejectingWith(value: unknown): ProviderRegistry {
  const provider: Partial<ResourceProvider> = {
    getAttribute: vi.fn(() => Promise.reject(value)),
  };
  return {
    getProvider: vi.fn(() => provider as ResourceProvider),
    getProviderFor: vi.fn(() => ({ provider: provider as ResourceProvider, provisionedBy: 'sdk' })),
  } as unknown as ProviderRegistry;
}

function state(): StackState {
  return {
    version: 2,
    stackName: 'TestStack',
    region: 'us-east-1',
    resources: {
      Vpc: {
        physicalId: 'vpc-1',
        resourceType: 'AWS::EC2::VPC',
        properties: {},
        attributes: { Ipv6CidrBlocks: ['2600:1f18::/56'] },
      },
      Other: {
        physicalId: 'o',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Value: { 'Fn::GetAtt': ['Vpc', 'Ipv6CidrBlocks'] } },
      },
    },
    outputs: {},
    lastModified: 0,
  };
}

describe('rewriteResourceReferences live-read failure (#3361)', () => {
  it('reports an unconvertible rejection as unresolvable instead of rejecting', async () => {
    const result = await rewriteResourceReferences(
      state(),
      ['Vpc'],
      registryRejectingWith(Object.create(null))
    );

    expect(result.unresolvable.map((u) => u.reason)).toEqual([PLACEHOLDER]);
    expect(result.state.resources['Other']?.properties).toEqual({
      Value: { 'Fn::GetAtt': ['Vpc', 'Ipv6CidrBlocks'] },
    });
  });

  it('--force still falls back to the recorded attribute after an unconvertible rejection', async () => {
    const result = await rewriteResourceReferences(
      state(),
      ['Vpc'],
      registryRejectingWith(Object.create(null)),
      { force: true }
    );

    expect(result.unresolvable).toEqual([]);
    expect(result.state.resources['Other']?.properties).toEqual({ Value: ['2600:1f18::/56'] });
  });
});
