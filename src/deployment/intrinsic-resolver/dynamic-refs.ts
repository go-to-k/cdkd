import type { IntrinsicFunctionResolver } from '../intrinsic-function-resolver.js';
import type { CachedDynamicReference, ResolverContext } from './support.js';
import { resolveDynamicReferencesWithLogTwin } from './dynamic-refs/log-twin-pass.js';

// The log-twin pass and its scope / provenance helpers live in `dynamic-refs/`
// (#5835); this module re-exports it so every importer keeps its path.
export { resolveDynamicReferencesWithLogTwin };

/**
 * The dynamic-reference memos of ONE resolver. Created once in the resolver's
 * constructor and never replaced or cleared, so both live exactly as long as
 * that resolver, as the resolver fields they replace did. A producer-region
 * guest (`resolverForProducerRegion`) is a separate resolver and so owns its
 * own: nothing is shared between a resolver and its guests.
 */
export class DynamicReferenceCache {
  /**
   * Resolved `{{resolve:secretsmanager:...}}` / `{{resolve:ssm:...}}` values,
   * keyed by the full expression and the credential identity that read it
   * (`injectiveKey(credentialFingerprint, expression)`, issue
   * [#3660](https://github.com/go-to-k/cdkd/issues/3660): a library caller can
   * drive one resolver under two `AwsClients` identities, and the same NAME
   * read by two accounts is two values) — INSTANCE-scoped, which closes the CACHE half
   * of issue [#1933](https://github.com/go-to-k/cdkd/issues/1933). The issue is
   * only PARTIALLY addressed by this field: see "what this does NOT settle"
   * below.
   *
   * It used to be a module-global map keyed by the expression ALONE, and both
   * halves of that were wrong for the same reason: the key and the lifetime
   * were narrower than the value they stood for.
   *
   * - REGION. Secrets Manager secrets and SSM parameters are regional and
   *   independent — the same NAME in `us-east-1` and `ap-northeast-1` is two
   *   different values, routinely two different credentials — so the first
   *   region to resolve an expression won it for the whole process, and every
   *   later stack in every other region silently reused that value.
   * - STACK. Nothing reset the map between stacks, so a second stack's
   *   resolution cache-HIT and skipped the lookup that re-records the value as
   *   a secret. `cdkd scrub --all` then found an empty secrets map for that
   *   stack and reported it clean.
   *
   * Instance scope settles both at once because a region boundary and a stack
   * boundary are BOTH resolver boundaries in cdkd: the resolver's
   * `resolverRegion` is fixed at construction, and every caller builds one
   * resolver per stack (`DeployEngine` per deploy, `scrub` / `import` /
   * `diff-recursive` / `rollback-executor` per stack). Re-keying by region
   * alone would have left the stack half open, which is why the lifetime — not
   * the key — is what moved.
   *
   * ONE caller is a known EXCEPTION to that invariant, and it is written down
   * here because an invariant recorded without its exception is how the next
   * change breaks it: `cdkd export` builds a single `paramResolver`
   * (`src/cli/commands/export.ts`, the `buildResolvedParametersPerStack`
   * pre-pass) and shares it across every node of a nested-stack tree, while the
   * nodes carry a per-node `region`. It is safe TODAY for two independent
   * reasons — the resolver is constructed with the tree's single `rootRegion`
   * and nested children do not yet diverge from it, and that pre-pass passes no
   * `recordedSecretValues` bag, so neither the region nor the secrets-recording
   * dimension has anything to cross. Both stop holding the moment cross-region
   * nested stacks ship or that pass starts recording secrets; a resolver per
   * node is the fix then, not a wider key here.
   *
   * The OTHER half of the same outcome — the lookups themselves reading the
   * process-ambient `getAwsClients()` singleton, whose region is whichever the
   * process installed last — was issue
   * [#1957](https://github.com/go-to-k/cdkd/issues/1957) and is now closed by
   * `ResolverClients.clientsForRegion`: a resolver whose region differs from the ambient
   * one builds its own region-pinned clients (carrying the ambient profile /
   * credentials) instead of reading whatever the singleton currently holds.
   * The two halves remain SEPARATE mechanisms and both are needed — this field
   * stops a resolved value from travelling between regions or stacks, while
   * the scoped clients stop the FIRST resolution from reading the wrong region
   * (no cache involved, so nothing here could ever have prevented it).
   */
  readonly cachedDynamicReferences = new Map<string, CachedDynamicReference>();

  /**
   * `(parameter name, reported Type)` pairs this resolver has already
   * warned about (issue #1933 review).
   *
   * Keyed on the PAIR rather than the name alone: two different anomalous types
   * for one parameter are two different facts — the line REPORTS the type, so
   * suppressing the second would hide a `Type` nobody has seen yet behind one
   * that was already explained. The volume problem this set exists for is N
   * IDENTICAL lines for N occurrences of one reference, which the pair still
   * bounds, because the type is a property of the parameter rather than of the
   * occurrence.
   *
   * The warning is per LOOKUP, and a parameter with an anomalous `Type` is
   * deliberately never cached (see `cacheable` in `resolveDynamicReferences`),
   * so it is re-looked-up for every occurrence of the reference in the stack —
   * which without this set means one identical warn line per occurrence per
   * pass, on the exact template that most needs the line to be READ. Scoped to
   * the resolver, like the value cache: a different stack genuinely deserves
   * its own warning, since the parameter it names may be a different region's.
   */
  readonly warnedUnrecognizedSsmTypes = new Set<string>();
}

/**
 * Resolve the dynamic references of a PERSISTED string leaf: text read back
 * out of a state record, a rollback journal or a producer stack's outputs.
 * That is what every caller of this method hands it (`cdkd drift`, the
 * rollback replay, `cdkd scrub`'s per-token delegation, the cross-stack
 * re-resolution); a TEMPLATE leaf goes through `resolve`, which takes
 * {@link resolveTemplateLeafReferences}.
 *
 * The distinction is load-bearing for two refusals. A token of a
 * service cdkd does not resolve is REFUSED on the template route when it
 * holds a secret, because leaving it would send that secret to AWS for the
 * first time. Persisted text is different on both counts: AWS already holds
 * it, so refusing buys no confidentiality, and the refusal is DETERMINISTIC
 * there -- a journal `previousState` holding `{{resolve:<plaintext>}}` beside
 * the reference that resolves to it would fail its rollback op on every
 * retry, where replaying the literal is a correct no-op. So this entry point
 * keeps the warn-and-leave for every such token, and the value scan redacts
 * whatever is persisted afterwards (issue #2743). A resolvable token
 * assembled from a secret (a twin mask in it, or a secret a parent passed
 * in) that resolves to a secret is REFUSED on the template route, since recording it would persist the other secret inside
 * the reference (issue #4166); here it resolves, for the same two reasons.
 */
export async function resolveDynamicReferences(
  resolver: IntrinsicFunctionResolver,
  value: string,
  context?: ResolverContext
): Promise<string> {
  return (
    await resolveDynamicReferencesWithLogTwin(resolver, value, value, context, undefined, true)
  ).result;
}

/** A TEMPLATE string leaf: the refusing route (see {@link resolveDynamicReferences}). */
export async function resolveTemplateLeafReferences(
  resolver: IntrinsicFunctionResolver,
  value: string,
  context?: ResolverContext
): Promise<string> {
  return (await resolveDynamicReferencesWithLogTwin(resolver, value, value, context)).result;
}
