/**
 * go-to-k/cdkd#5487: `previousWithLiveUnsettled` substitutes the live readback
 * for the unsettled keys of an update's previous side, and only for them.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import { previousWithLiveUnsettled } from '../../../src/provisioning/unsettled-previous.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const ID = { resourceType: 'AWS::X::Y', logicalId: 'R', physicalId: 'p' };

describe('previousWithLiveUnsettled', () => {
  it('returns the previous bag itself, with no read, when nothing is unsettled', async () => {
    const previous = { A: 1 };
    const read = vi.fn();
    expect(await previousWithLiveUnsettled(previous, undefined, read, ID)).toBe(previous);
    expect(await previousWithLiveUnsettled(previous, { unsettledProperties: new Set() }, read, ID)).toBe(previous);
    expect(read).not.toHaveBeenCalled();
  });

  it('takes the live value for an unsettled key, drops one the readback lacks, and leaves the rest', async () => {
    const out = await previousWithLiveUnsettled(
      { A: 1, B: 2, C: 3 },
      { unsettledProperties: new Set(['A', 'B']) },
      async () => ({ A: 10, C: 30 }),
      ID
    );
    expect(out).toEqual({ A: 10, C: 3 });
  });

  it('an override answers its key instead of the readback; an undefined answer drops it', async () => {
    const out = await previousWithLiveUnsettled(
      { A: 1, B: 2 },
      { unsettledProperties: new Set(['A', 'B']) },
      async () => ({ A: 10, B: 20 }),
      ID,
      { A: async () => 5, B: async () => undefined }
    );
    expect(out).toEqual({ A: 5 });
  });

  it.each([
    ['not found', RESOURCE_NOT_FOUND],
    ['no readback', undefined],
  ])('refuses when the readback is %s, naming the keys', async (_l, live) => {
    const caught = await previousWithLiveUnsettled(
      { A: 1 },
      { unsettledProperties: new Set(['A']) },
      async () => live as never,
      ID
    ).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(ProvisioningError);
    expect((caught as Error).message).toContain('left A unsettled');
    expect((caught as Error).message).toContain('nothing was updated');
  });
});
