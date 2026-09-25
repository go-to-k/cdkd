import { describe, it, expect } from 'vite-plus/test';
import { crossStackReadsForPartialSave } from '../../../src/deployment/deploy-engine.js';
import type { StackState } from '../../../src/types/state.js';

/**
 * The cross-stack read union keys each entry by an INJECTIVE encoding of its
 * (source stack, region, name) triple (go-to-k/cdkd#3496).
 *
 * `state.imports` is what `cdkd destroy` refuses a destroy on, and the union
 * keeps one entry per key. The previous record reaches it through `parseState`,
 * which only casts, so nothing guarantees a half is free of the NUL the key
 * used to be joined with. Two DISTINCT entries whose separated keys coincide
 * made the union drop the second one: a strong reference silently gone from
 * the destroy guard's input. The pairs below are exactly such collisions under
 * the old `a<NUL>b<NUL>c` spelling.
 */
const NUL = String.fromCharCode(0);
const identity = (name: string): string => name;

function previousWith(fields: Partial<StackState>): StackState {
  return {
    version: 1,
    stackName: 'Consumer',
    region: 'us-east-1',
    resources: {},
    outputs: {},
    lastModified: 0,
    ...fields,
  } as StackState;
}

describe('crossStackReadsForPartialSave keys the union injectively (go-to-k/cdkd#3496)', () => {
  it('keeps two distinct imports whose NUL-separated keys would coincide', () => {
    const first = { sourceStack: 'A', sourceRegion: 'us-east-1', exportName: `x${NUL}Y` };
    const second = { sourceStack: `A${NUL}us-east-1`, sourceRegion: 'x', exportName: 'Y' };
    // The collision the old key had, spelled out: both join to one string.
    expect([first.sourceStack, first.sourceRegion, first.exportName].join(NUL)).toBe(
      [second.sourceStack, second.sourceRegion, second.exportName].join(NUL)
    );

    const result = crossStackReadsForPartialSave(
      previousWith({ imports: [first] as never }),
      [second] as never,
      [],
      identity
    );

    expect(result.imports).toEqual([first, second]);
  });

  it('keeps two distinct output reads whose NUL-separated keys would coincide', () => {
    const first = { sourceStack: 'A', sourceRegion: 'us-east-1', outputName: `x${NUL}Y` };
    const second = { sourceStack: `A${NUL}us-east-1`, sourceRegion: 'x', outputName: 'Y' };

    const result = crossStackReadsForPartialSave(
      previousWith({ outputReads: [first] as never }),
      [],
      [second] as never,
      identity
    );

    expect(result.outputReads).toEqual([first, second]);
  });

  it('still drops a genuine duplicate, region compared case-insensitively (the control)', () => {
    const stored = { sourceStack: 'Producer', sourceRegion: 'US-EAST-1', exportName: 'Token' };
    const again = { sourceStack: 'Producer', sourceRegion: 'us-east-1', exportName: 'Token' };

    const result = crossStackReadsForPartialSave(
      previousWith({ imports: [stored] as never }),
      [again] as never,
      [],
      identity
    );

    // First-seen wins, so the stored spelling survives.
    expect(result.imports).toEqual([stored]);
  });
});
