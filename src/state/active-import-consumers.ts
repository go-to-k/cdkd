import { canonicalizeRegion } from '../utils/aws-partition.js';
import type { ActiveImportConsumer } from '../utils/error-handler.js';
import type { S3StateBackend } from './s3-state-backend.js';

/**
 * Strong-reference scan: read every other stack's state.json from the
 * state bucket and check whether any of its `imports[]` entries names
 * `producerStack`. Returns the list of offending consumers (possibly
 * empty).
 *
 * NEVER trusts the persistent exports index — a stale index could miss
 * a freshly-recorded consumer and let a destructive destroy through.
 * The cost is one `listStacks` + N parallel GETs. Destroy pays it on every
 * run (Issue #343); a deploy pays it only when its plan changes or removes
 * one of the stack's exports (go-to-k/cdkd#6088), never on the everyday path.
 */
export async function scanActiveConsumers(
  producerStack: string,
  producerRegion: string,
  ctx: { stateBackend: Pick<S3StateBackend, 'listStacks' | 'getState'>; baseRegion: string }
): Promise<ActiveImportConsumer[]> {
  const refs = await ctx.stateBackend.listStacks();
  const results = await Promise.all(
    refs.map(async (ref) => {
      // Region missing on legacy v1 records — fall back to caller's
      // baseRegion to match the deploy-side resolver's behavior.
      const region = ref.region ?? ctx.baseRegion;
      // Skip self (a stack importing its own export is invalid in CFn).
      // Match on BOTH name AND region — the v2 layout supports the
      // same stackName deployed to multiple regions, and an unrelated
      // same-name stack in a different region is NOT self.
      if (ref.stackName === producerStack && region === producerRegion) return null;
      try {
        const got = await ctx.stateBackend.getState(ref.stackName, region);
        const imports = got?.state.imports;
        if (!imports || imports.length === 0) return null;
        // The region is compared CANONICALIZED (go-to-k/cdkd#3746), the rule
        // the deploy side keys and dedups these entries by: an entry stored
        // in another case was kept there as the same reference, and a strict
        // `===` here let a destroy through over it.
        const matches = imports.filter(
          (entry) =>
            entry.sourceStack === producerStack &&
            canonicalizeRegion(entry.sourceRegion) === canonicalizeRegion(producerRegion)
        );
        if (matches.length === 0) return null;
        return matches.map<ActiveImportConsumer>((entry) => ({
          consumerStack: ref.stackName,
          consumerRegion: region,
          exportName: entry.exportName,
        }));
      } catch {
        // A single unreadable state shouldn't tank the safety scan —
        // skip and log nothing here; the destroy is going to refuse
        // or proceed based on what we CAN read. The caller will see
        // any persistent listStacks-level issue separately.
        return null;
      }
    })
  );
  return results.filter((r) => r !== null).flat();
}
