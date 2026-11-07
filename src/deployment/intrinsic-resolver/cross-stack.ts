import type { IntrinsicFunctionResolver } from '../intrinsic-function-resolver.js';
import { pinScopedSecretVerdict } from '../secret-redaction/mask-only.js';

export { reresolveCrossStackValue } from './cross-stack/reresolve.js';
export { resolveImportValue, recordImport } from './cross-stack/import-value.js';
export { readProducerStateOnce } from './cross-stack/producer-state.js';

/**
 * The resolver that must answer for a PRODUCER region — `this` when the
 * producer shares this resolver's own region, otherwise the pinned sibling
 * from {@link producerRegionResolvers}.
 *
 * The comparison is against {@link explicitRegion}, NOT {@link
 * resolverRegion}: the latter substitutes `AWS_REGION` and then a hard-coded
 * `us-east-1`, so comparing against it would answer "same region" on the
 * strength of a guess and resolve the producer's expression against whatever
 * the ambient clients happen to point at. When no region was named, a producer
 * region that IS named still binds — "unknown means SCOPE, not skip", the same
 * rule `ResolverClients.clientsForRegion` applies, and the same one `Fn::GetAZs` already
 * follows for its template-named region.
 */
/**
 * Pin (or retract) a `{{resolve:...}}` secret verdict in the process-wide
 * store, filed under `scope` ({@link secretVerdictScope}) — unless this
 * resolver is a producer-region GUEST, which writes nothing there.
 *
 * SCOPED SINCE ISSUE #4105. The store was keyed by the expression STRING
 * alone, so one region's `SecureString` verdict made another region's resolver
 * SKIP its lookup on the `skipDynamicReferences` (diff / no-op) path and
 * compare a plain `String` parameter as an expression — a phantom change on
 * every run, and since issue #4056 a refused `Export.Name` alias and withheld
 * previous values too. The verdict is now also filed under `scope`, and the
 * resolver's `isKnownSecret` reads only its OWN scope's entry. The bare set
 * the redaction path reads is written exactly as before.
 *
 * The guest suppression predates the scope and is kept. The review of issue
 * #1934 added it because a producer-region resolution pinned a FOREIGN region's
 * answer under a key the consumer reads. The scoped read keeps that answer away
 * from the consumer's skip arm, but the bare set still reaches the redaction
 * path with no region attached, so suppressing the WRITE stays the
 * conservative half.
 *
 * READS are deliberately NOT suppressed. A guest reading its own scope can
 * only seed `isKnownSecret`, which for `ssm` is OVERWRITTEN by the fresh
 * `GetParameter` response, and on the skip path it produces the unresolved
 * expression the diff wants anyway.
 *
 * The cost of suppressing is one `GetParameter` per foreign expression per
 * later pass, since the guest's OWN instance cache still carries the verdict
 * alongside the value (issue #1933's design) and answers every repeat within
 * the deploy.
 */
export function pinSecretVerdict(
  resolver: IntrinsicFunctionResolver,
  expression: string,
  secret: boolean,
  scope: string
): void {
  if (resolver.producerRegionGuest) return;
  pinScopedSecretVerdict(scope, expression, secret);
}
