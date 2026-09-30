/**
 * A READ-ONLY {@link StaleAttributeHealer} for commands that preview a deploy
 * without writing state (issue
 * [#3456](https://github.com/go-to-k/cdkd/issues/3456)).
 *
 * `cdkd deploy` heals a stale attribute map (issue
 * [#1852](https://github.com/go-to-k/cdkd/issues/1852)): when a `Fn::GetAtt`
 * is about to take the resolver's physical-id fallback, the engine re-reads
 * the record through its provider's `import()` and serves the value from that
 * read. A preview that supplied no healer resolved the same reference to the
 * raw intrinsic or the physical id, so `cdkd diff` could print
 * `No changes detected` for an update the deploy then made.
 *
 * The healer built here issues the SAME read — the provider's `import()` with
 * `knownPhysicalId`, routed by the record's own `resourceType` +
 * `provisionedBy` — and hands the outcome to the resolver, which serves the
 * value for this run only. It has no state handle: nothing it reads is merged
 * into a record or saved.
 */
import type { ResourceState } from '../types/state.js';
import type { ResourceProvider } from '../types/resource.js';
import { injectiveKey } from '../state/record-keys.js';
import { displaySafe, safeMsg } from '../utils/display-safe.js';
import { getLogger } from '../utils/logger.js';
import { carriesSecretMask } from './secret-redaction.js';
import {
  isHealExcludedType,
  normalizeHealedAttributes,
  type StaleAttributeHealer,
  type StaleAttributeHealOutcome,
} from './stale-attribute-heal.js';

/**
 * Read `resource`'s attributes through `provider.import()` with
 * `knownPhysicalId`, the way `DeployEngine.readStaleAttributes` does, and
 * return what the read observed. REJECTS when `import()` does, and for a
 * provider that answered for a different physical id;
 * {@link createReadOnlyAttributeHealerFactory}'s healer turns both into a
 * `failed` outcome.
 */
export async function readRecordAttributes(input: {
  provider: ResourceProvider;
  logicalId: string;
  resource: ResourceState;
  stackName: string;
  region: string;
}): Promise<StaleAttributeHealOutcome> {
  const { provider, logicalId, resource, stackName, region } = input;
  if (!provider.import) return { kind: 'not-attempted' };
  const found = await provider.import({
    logicalId,
    resourceType: resource.resourceType,
    stackName,
    region,
    properties: resource.properties,
    knownPhysicalId: resource.physicalId,
  });
  if (found === null) return { kind: 'not-found' };
  if (found.physicalId !== resource.physicalId) {
    // The `orphan-adoption.ts` guard: nothing enforces a provider's contract to
    // treat `knownPhysicalId` as ground truth, and one that searches instead
    // can answer for a DIFFERENT resource, whose attributes must not be served.
    // not-in-class: the resolver renders this message at debug only, masked.
    throw new Error(
      `the provider answered for a different resource (${found.physicalId}) than the one asked about (${resource.physicalId})`
    );
  }
  // A value carrying `SECRET_MASK` is not a value: `CloudControlProvider.import`
  // masks every leaf it cannot certify as a read-only attribute. Dropped here,
  // and named in `withheldKeys` so a refusal does not claim the read reported
  // nothing.
  const reported = Object.entries(normalizeHealedAttributes(found.attributes));
  const attributes = Object.fromEntries(reported.filter(([, value]) => !carriesSecretMask(value)));
  const withheldKeys = reported.filter(([, value]) => carriesSecretMask(value)).map(([key]) => key);
  return { kind: 'read', attributes, ...(withheldKeys.length > 0 && { withheldKeys }) };
}

/**
 * Build a factory of read-only healers sharing ONE memo, so each record is
 * read at most once per command run however many resolver contexts ask (the
 * per-stack diff, its condition evaluation and outputs pass, and a nested
 * child's parameters resolved against the parent's state).
 *
 * Eligibility is the resource TYPE alone. The deploy engine also requires the
 * record to be the one it LOADED, because a record a provider rewrote
 * mid-deploy carries the provider's own answer, not a stale one. A preview runs
 * no provider create or update, so no record it resolves against was rewritten
 * that way: its records are the loaded ones (after the read-only repairs) and
 * the rollback orphans the adoption preview splices in, which the deploy's own
 * baseline holds too, since it splices them into the map it loaded.
 */
export function createReadOnlyAttributeHealerFactory(options: {
  /** Route a record to the provider its deploy would use. */
  getProvider: (resource: ResourceState, region: string) => ResourceProvider;
  /**
   * Run `fn` with AWS clients bound to `region`. A stack's resources live in
   * the STACK's region, which is not always the region the command's own
   * clients were built for.
   */
  inRegion: <T>(region: string, fn: () => Promise<T>) => Promise<T>;
}): (stackName: string, region: string) => StaleAttributeHealer {
  const logger = getLogger().child('ReadOnlyAttributeHealer');
  const memo = new Map<string, Promise<StaleAttributeHealOutcome>>();
  return (stackName, region) => (logicalId, resource) => {
    if (isHealExcludedType(resource.resourceType)) {
      return Promise.resolve({ kind: 'not-attempted' });
    }
    // Encoded, never joined (go-to-k/cdkd#3496): every part is unvalidated
    // text, and a joined key could let two records share one entry.
    const key = injectiveKey(stackName, region, logicalId, resource.physicalId);
    const inFlight = memo.get(key);
    if (inFlight) return inFlight;
    // An `async` wrapper so a SYNCHRONOUS throw — `getProvider` for a type this
    // build cannot route, or the scope refusing a region — becomes a rejection
    // the `catch` below turns into `failed`: a healer must never throw.
    const heal = (async () =>
      options.inRegion(region, () =>
        readRecordAttributes({
          provider: options.getProvider(resource, region),
          logicalId,
          resource,
          stackName,
          region,
        })
      ))()
      .then((outcome) => {
        if (outcome.kind === 'read') {
          // Logging must not turn a completed read into `failed`.
          try {
            logger.debug(
              safeMsg`Re-read the attributes of ${displaySafe(logicalId)} (${displaySafe(resource.resourceType)}) from AWS for this preview — its state record lacked one a Fn::GetAtt asked for (#1852); nothing is written: ${Object.keys(outcome.attributes).length} attribute(s) read`
            );
          } catch {
            // Diagnostic only.
          }
        }
        return outcome;
      })
      .catch((error: unknown): StaleAttributeHealOutcome => ({ kind: 'failed', error }));
    memo.set(key, heal);
    return heal;
  };
}
