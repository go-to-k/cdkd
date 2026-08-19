import { describe, it, expectTypeOf } from 'vite-plus/test';
import type { ResourceUpdateResult } from '../../../src/types/resource.js';

/**
 * Issue #1819: the twin of `resource-delete-result.test-d.ts`, and needed for
 * the same reason that file states — this is the one guarantee in the change a
 * RUNTIME test cannot fence.
 *
 * Relaxing `reason` back to optional, or dropping the `reason?: never` guard on
 * the clean arm, changes no behavior: the mutation probes for both came back
 * green against the entire unit suite. The PR's headline claim is that "reason
 * required on partial" is COMPILER-enforced rather than asserted in a doc
 * comment, so it takes a compile-time test to be a claim at all.
 */
const BASE = { physicalId: 'pid', wasReplaced: false } as const;

describe('ResourceUpdateResult (issue #1819)', () => {
  it("requires `reason` on 'partial'", () => {
    // @ts-expect-error — a partial MUST say what survived; without this the
    // union collapses to the optional-`reason` shape, and a row reading a bare
    // `partial` is barely better than the `updated` it replaced.
    const missingReason: ResourceUpdateResult = { ...BASE, outcome: 'partial' };
    void missingReason;

    expectTypeOf<{
      physicalId: string;
      wasReplaced: boolean;
      outcome: 'partial';
      reason: string;
    }>().toExtend<ResourceUpdateResult>();
  });

  it('rejects a `reason` handed in WITHOUT an outcome', () => {
    // @ts-expect-error — this is what `reason?: never` on the clean arm buys:
    // a reason with no `outcome: 'partial'` is a silently ignored field, which
    // reads at the call site exactly like a reported one.
    const strayReason: ResourceUpdateResult = { ...BASE, reason: 'orphaned x' };
    void strayReason;
  });

  it('accepts a bare result — the ~80 providers returning one must stay valid', () => {
    const clean: ResourceUpdateResult = { ...BASE };
    void clean;

    expectTypeOf<{ physicalId: string; wasReplaced: boolean }>().toExtend<ResourceUpdateResult>();
  });

  it("accepts an explicit 'updated'", () => {
    const updated: ResourceUpdateResult = { ...BASE, outcome: 'updated' };
    void updated;
  });

  it('rejects an outcome outside the union', () => {
    // @ts-expect-error — `'skipped'` was deliberately NOT included: an update
    // that cannot touch the resource at all THROWS, so it would be an
    // unreachable member. Adding one must be a conscious change.
    const bogus: ResourceUpdateResult = { ...BASE, outcome: 'skipped', reason: 'x' };
    void bogus;
  });
});
