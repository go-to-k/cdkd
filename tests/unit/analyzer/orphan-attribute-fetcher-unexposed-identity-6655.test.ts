import { describe, it, expect, vi } from 'vite-plus/test';
import { AttributeFetcher } from '../../../src/analyzer/orphan-rewriter/attribute-fetcher.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { ResourceState } from '../../../src/types/state.js';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => fns };
  return { getLogger: () => fns };
});

/**
 * go-to-k/cdkd#6655: `cdkd orphan` substitutes a sibling's `Fn::GetAtt` to the
 * orphan outside the resolver, so the unexposed-identity refusal is applied at
 * the fetcher too: neither the live read, the record nor the `--force` cache
 * fallback may write an id CloudFormation would not have resolved.
 */
const record = (resourceType: string, attributes: Record<string, unknown>): ResourceState => ({
  physicalId: 'phys-x',
  resourceType,
  properties: {},
  attributes,
  dependencies: [],
});

const fetcherWith = (orphan: ResourceState, force: boolean) => {
  const getAttribute = vi.fn(async (_p: string, _t: string, attr: string) => `live-${attr}`);
  const registry = {
    getProviderFor: () => ({ provider: { getAttribute } }),
  } as unknown as ProviderRegistry;
  return { fetcher: new AttributeFetcher({ X: orphan }, registry, { force }), getAttribute };
};

describe('cdkd orphan: GetAtt of an unexposed recorded identity id (#6655)', () => {
  it.each([false, true])(
    'TableId is refused without a live read (force=%s)',
    async (force) => {
      const { fetcher, getAttribute } = fetcherWith(
        record('AWS::DynamoDB::Table', { TableId: 'tid', Arn: 'arn:t' }),
        force
      );
      await expect(fetcher.getAtt('X', 'TableId')).resolves.toEqual({
        ok: false,
        reason:
          'CloudFormation does not expose TableId as an attribute of AWS::DynamoDB::Table; ' +
          'cdkd records it for its own identity checks only',
      });
      expect(getAttribute).not.toHaveBeenCalled();
    }
  );

  it('an exposed identity id (RoleId) still resolves through the live read', async () => {
    const { fetcher, getAttribute } = fetcherWith(
      record('AWS::IAM::Role', { RoleId: 'AROAEXAMPLE' }),
      false
    );
    const result = await fetcher.getAtt('X', 'RoleId');
    expect(result.ok).toBe(true);
    expect(getAttribute).toHaveBeenCalledOnce();
  });

  it('a non-identity attribute of the same type is unchanged', async () => {
    const { fetcher, getAttribute } = fetcherWith(
      record('AWS::DynamoDB::Table', { TableId: 'tid', StreamArn: 'arn:s' }),
      false
    );
    const result = await fetcher.getAtt('X', 'StreamArn');
    expect(result.ok).toBe(true);
    expect(getAttribute).toHaveBeenCalledOnce();
  });
});
