/**
 * The half of `S3StateBackend.getState`'s contract a hand-rolled test double
 * must not omit.
 *
 * Since issue [go-to-k/cdkd#3328](https://github.com/go-to-k/cdkd/issues/3328)
 * the record `getState` returns carries the region of the KEY it was read
 * from, whatever the body said, and a body that named a different one comes
 * back BESIDE it as `divergentBodyRegion` — raw, because it is unvalidated
 * body content. `adoptKeyRegion` in `src/state/s3-state-backend.ts` is the
 * authority; this mirrors it.
 *
 * Shared rather than copied because two suites hand-roll that double
 * (`tests/unit/cli/export.test.ts`, `tests/unit/cli/export-nested-loop.test.ts`)
 * and both drive `walkCdkdStateStackTree`, whose nested-child refusal reads
 * exactly that field. A double returning the stored record verbatim reports NO
 * divergence, so those refusal cases go green against a walker that has
 * stopped refusing — a mock that does not fail the way production fails.
 *
 * It is a MIRROR, never the subject. The contract itself is fenced against the
 * REAL backend over a mocked S3 client in
 * `tests/unit/state/state-key-region-authority.test.ts`; nothing here can
 * prove the production read does any of this.
 */
import type { StackState } from '../../src/types/state.js';

/** What a `getState` double should answer for a record stored under `region`. */
export function readAtKeyRegion(
  state: StackState,
  region: string
): {
  state: StackState;
  etag: string;
  migrationPending: undefined;
  divergentBodyRegion?: unknown;
} {
  const raw = (state as { region?: unknown }).region;
  // ABSENT is not a divergence — it contradicts nothing — but it IS normalized,
  // exactly as in production.
  const diverged = raw !== undefined && raw !== region;
  return {
    // Identity is preserved on the agreeing path, which several callers assert
    // with `toBe`.
    state: raw === region ? state : { ...state, region },
    etag: '"mock"',
    migrationPending: undefined,
    ...(diverged && { divergentBodyRegion: raw }),
  };
}
