import { describe, it, expectTypeOf } from 'vite-plus/test';
import type { ResourceDeleteResult } from '../../../src/types/resource.js';

/**
 * Issue #1752: `ResourceDeleteResult` is a DISCRIMINATED union specifically so
 * that `reason` is required on `'skipped'` — a skip whose status line reads a
 * bare `skipped` with no cause is barely better than the `deleted` it replaced.
 *
 * This is the one guarantee in the change that a runtime test cannot fence:
 * relaxing `reason` back to optional changes no behavior at all (the mutation
 * probe for it came back green against the whole unit suite). It is a
 * compile-time contract, so it needs a compile-time test — the first
 * `*.test-d.ts` in the repo, run by `vp run test`'s "Type Errors" pass via the
 * `typecheck.include` glob already configured in `vite.config.ts`.
 */
describe('ResourceDeleteResult (issue #1752)', () => {
  it("requires `reason` on 'skipped'", () => {
    // @ts-expect-error — a skip MUST say why; without this the union collapses
    // back to the optional-`reason` shape the PR review rejected.
    const missingReason: ResourceDeleteResult = { outcome: 'skipped' };
    void missingReason;

    expectTypeOf<{ outcome: 'skipped'; reason: string }>().toExtend<ResourceDeleteResult>();
  });

  it("accepts a bare 'deleted' — the ~80 void-returning providers must stay valid", () => {
    const deleted: ResourceDeleteResult = { outcome: 'deleted' };
    void deleted;

    expectTypeOf<{ outcome: 'deleted' }>().toExtend<ResourceDeleteResult>();
  });

  it('rejects an outcome outside the union', () => {
    // @ts-expect-error — `'already-absent'` was deliberately NOT included (no
    // producer, no distinct consumer); adding it must be a conscious change.
    const bogus: ResourceDeleteResult = { outcome: 'already-absent' };
    void bogus;
  });
});
