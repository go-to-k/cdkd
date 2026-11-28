/**
 * go-to-k/cdkd#7194: the readers that told a present `noEchoLeaves` from an
 * absent one read the new EMPTY marker as absent, since no position is named.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import { buildReadCurrentStateContext } from '../../../src/deployment/read-current-state-context.js';
import { withRefreshedObservedBaseline } from '../../../src/deployment/rollback-executor/replay-observed-refresh.js';
import type { ResourceState } from '../../../src/types/state.js';

const TYPE = 'AWS::Test::Thing7194';

describe('readers of an empty noEchoLeaves (go-to-k/cdkd#7194)', () => {
  it('a read context carries no provenance for a record whose only field is the empty marker', () => {
    const own: ResourceState = {
      physicalId: 'p1',
      resourceType: TYPE,
      properties: { Name: 'n' },
      noEchoLeaves: [],
    };
    const context = buildReadCurrentStateContext({ resources: { Own: own } }, 'Other');
    expect(context.siblings?.['Own']).toBeDefined();
    const ownContext = buildReadCurrentStateContext({ resources: { Own: own } }, 'Own');
    expect(ownContext.provenance).toBeUndefined();
    const marked = buildReadCurrentStateContext(
      { resources: { Own: { ...own, noEchoLeaves: [['Name']] } } },
      'Own'
    );
    expect(marked.provenance).toEqual({ noEchoLeaves: [['Name']] });
  });

  it("a rollback's observed refresh still reads a restored record marked with the empty field", async () => {
    const restored: ResourceState = {
      physicalId: 'p2',
      resourceType: TYPE,
      properties: { Name: 'n' },
      observedProperties: { Name: 'old' },
      noEchoLeaves: [],
    };
    const readCurrentState = vi.fn().mockResolvedValue({ Name: 'now' });
    const out = await withRefreshedObservedBaseline(restored, {
      provider: { readCurrentState } as never,
      op: { logicalId: 'R', resourceType: TYPE },
      desiredProps: { Name: 'n' },
      restored,
      stateResources: {},
      secrets: new Map(),
      noEcho: { substituted: [] },
      mask: (text) => text,
      logger: { debug: () => undefined },
      inScope: (fn) => fn(),
      capture: true,
      publicTokens: new Set(),
    });
    expect(readCurrentState).toHaveBeenCalledTimes(1);
    expect(out.observedProperties).toEqual({ Name: 'now' });
  });
});
