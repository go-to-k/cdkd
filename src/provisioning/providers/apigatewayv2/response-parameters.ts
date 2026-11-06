import { maskDeep, type MaskedLogSinks } from '../../masked-retry-logger.js';
import type { SecretMasker } from '../../../types/resource.js';
import type { ApiGatewayV2Provider } from '../apigatewayv2-provider.js';

/**
 * `ResponseParameters` is the one `AWS::ApiGatewayV2::Integration` property
 * whose CFn shape does NOT match the SDK's, so forwarding it verbatim is not
 * an option (issue #609). CloudFormation models it as
 * `{ "<statusCode>": { ResponseParameters: [{ Destination, Source }, ...] } }`
 * while `CreateIntegration` / `UpdateIntegration` take the flattened
 * `{ "<statusCode>": { "<Destination>": "<Source>" } }`. The AWS SDK v3
 * serializer drops members it cannot model, so the un-converted CFn shape
 * would deliver an EMPTY map per status code — the silent-drop class one
 * level down.
 *
 * Anything that is not the expected object / array shape (an unresolved
 * intrinsic, a malformed block) passes through untouched so AWS surfaces the
 * real validation error instead of cdkd inventing one.
 *
 * `Source` is COERCED from a number / boolean rather than skipped. CFn types
 * `ResponseParameters` as free-form `object` and coerces scalars, cdkd does
 * not (the `coerceNumber` class in `.claude/rules/providers.md`), so an
 * unquoted `Source: 403` under the canonical `overwrite:statuscode`
 * destination is a perfectly legal template whose value arrives as a NUMBER.
 * Skipping it would re-introduce the silent drop this method exists to close.
 * A `Destination` is never coerced — it becomes an SDK map KEY, and a
 * non-string there is a malformed template, not a scalar shorthand.
 *
 * `log` is the calling `create()` / `update()`'s masked sink (issue #1932
 * item 3, adopted here by issue #1997; one sink per operation since issue
 * #2177), built from `CreateContext` / `UpdateContext` and passed down via
 * `createIntegration` / `updateIntegration`. The warning below names the
 * offending `Destination` / `Source`, which come out of the RESOLVED
 * `properties` bag — a `{{resolve:secretsmanager:...}}` scalar is plaintext by
 * the time a provider sees it, and neither the deploy engine's error text nor
 * the resolver's debug line covers a provider's own `logger.warn`.
 */
export function toSdkResponseParameters(
  this: ApiGatewayV2Provider,
  value: unknown,
  log: MaskedLogSinks
): Record<string, Record<string, string>> | undefined {
  // Every warning here goes through `log.warn`, the operation's ONE masked
  // sink: a warning added later is masked by construction instead of by the
  // author remembering. It is the OUTER of two layers — a finished message is
  // always longer than the value inside it, so it can only reach
  // `maskSecretsInText`'s SUBSTRING arm, which ignores needles below
  // `MIN_NEEDLE_LENGTH` (4). `maskLeaf` below is the inner layer, handing the
  // masker the raw string so it reaches the WHOLE-VALUE arm at any length;
  // the mask is idempotent, so both are free.
  const maskSecrets: SecretMasker = log.mask;
  // Mask every string LEAF (and KEY) BEFORE `JSON.stringify` escapes it: a
  // secret carrying a quote, a backslash or a newline no longer OCCURS in the
  // finished line, so the outer sink alone would miss it.
  //
  // A WALK, not a top-level `typeof v === 'string'` test. That distinction is
  // load-bearing precisely here: this arm fires BECAUSE `destination` is not a
  // string (or `source` is neither string, number nor boolean), so the
  // realistic shapes are an unresolved intrinsic like `{ Ref: '<secret>' }` or
  // a mis-nested array — i.e. the secret is a NESTED leaf every time, and a
  // scalar-only mask would decline exactly the values this warning prints.
  // Issue #2176: delegates to the shared walk in `../masked-retry-logger.js`.
  // This was one of SIX hand-rolled copies, and one of the FOUR that carried
  // no depth cap.
  const maskLeaf = (value: unknown): unknown => maskDeep(value, maskSecrets);
  if (value == null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    return value as Record<string, Record<string, string>>;
  }

  const out: Record<string, Record<string, string>> = {};
  for (const [statusCode, block] of Object.entries(value as Record<string, unknown>)) {
    if (block == null || typeof block !== 'object' || Array.isArray(block)) {
      out[statusCode] = block as Record<string, string>;
      continue;
    }
    const entries = (block as Record<string, unknown>)['ResponseParameters'];
    if (!Array.isArray(entries)) {
      // Already flat (`{ "<Destination>": "<Source>" }`) — a hand-written
      // template may use the SDK spelling directly; pass it through.
      out[statusCode] = block as Record<string, string>;
      continue;
    }
    const mapped: Record<string, string> = {};
    for (const entry of entries) {
      const destination =
        entry != null && typeof entry === 'object' && !Array.isArray(entry)
          ? (entry as Record<string, unknown>)['Destination']
          : undefined;
      const source =
        entry != null && typeof entry === 'object' && !Array.isArray(entry)
          ? (entry as Record<string, unknown>)['Source']
          : undefined;
      const coerced =
        typeof source === 'string'
          ? source
          : typeof source === 'number' || typeof source === 'boolean'
            ? String(source)
            : undefined;
      if (typeof destination !== 'string' || coerced === undefined) {
        // Never silent: an entry cdkd cannot deliver is the same class of
        // defect as the drop this whole method closes, so it is announced
        // rather than skipped quietly.
        log.warn(
          `AWS::ApiGatewayV2::Integration ResponseParameters['${maskSecrets(statusCode)}'] has ` +
            `an entry cdkd cannot deliver (Destination must be a string and Source a string / ` +
            `number / boolean; got ${JSON.stringify(maskLeaf(destination))} / ` +
            `${JSON.stringify(maskLeaf(source))}); skipping that entry.`
        );
        continue;
      }
      mapped[destination] = coerced;
    }
    out[statusCode] = mapped;
  }
  return out;
}

/**
 * Inverse of {@link toSdkResponseParameters}, for `readCurrentState`. Without
 * it the AWS-current side would carry the flat SDK map while the cdkd
 * baseline carries the CFn list-of-pairs, and every `cdkd drift` run would
 * report permanent phantom drift on a resource nobody touched.
 *
 * Order matters because this turns an UNORDERED SDK map into an ARRAY, and
 * `calculateResourceDrift` compares arrays POSITIONALLY — AWS does not
 * guarantee map readback order, so an arbitrary rebuild would trade the
 * shape-mismatch phantom drift for an ordering one (and `--revert` would
 * re-push an identical value forever). Declared destinations therefore keep
 * their DECLARED position and anything else is sorted; both are stable
 * across reads. Same reasoning as `src/analyzer/drift-normalize.ts`,
 * applied at the source instead.
 *
 * `declared` (the state-recorded desired `ResponseParameters` block, when
 * the caller has it) makes the inverse MIRROR the template's spelling per
 * status code (issue #1602): {@link toSdkResponseParameters} accepts an
 * ALREADY-FLAT block (`{ "<status>": { "<Destination>": "<Source>" } }` —
 * the SDK spelling a hand-written template may use) and passes it through,
 * which made the pair non-injective — this method always rebuilt the CFn
 * list shape, so a flat-spelled baseline could never compare equal to the
 * read-back and reported permanent phantom drift. For a status code whose
 * DECLARED block matches the flat-passthrough branch of
 * {@link toSdkResponseParameters} (an object without an array
 * `ResponseParameters` member), the read-back now stays flat too; every
 * other status code (declared CFn shape, declared absent, no `declared` at
 * all) keeps the CFn list shape. Object comparison is key-based, so the
 * flat map round-trips without the sort the list shape needs.
 *
 * The CFn arm mirrors the declared block too, in the two ways the
 * `properties`-fallback baseline is compared on: ENTRY ORDER (the
 * comparator walks arrays positionally, and the template's order is
 * whatever the author wrote — sorting only the read side is the mistake
 * `drift-normalize.ts`'s header records) and SCALAR TYPE (CFn types
 * `Source` as free-form and cdkd coerces a number to a string on the way
 * out, so re-emitting AWS's string against a numeric declaration is
 * permanent phantom drift). Declared destinations keep their declared
 * position and their declared scalar whenever the value still agrees with
 * AWS; a destination AWS returns that the template never declared is
 * appended in sorted order, so the result stays deterministic across reads.
 */
export function toCfnResponseParameters(
  this: ApiGatewayV2Provider,
  value: Record<string, Record<string, string>> | undefined,
  declared?: unknown
): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  const declaredBlocks =
    declared != null && typeof declared === 'object' && !Array.isArray(declared)
      ? (declared as Record<string, unknown>)
      : undefined;
  const out: Record<string, unknown> = {};
  for (const [statusCode, flat] of Object.entries(value)) {
    if (flat == null || typeof flat !== 'object' || Array.isArray(flat)) continue;
    const declaredBlock = declaredBlocks?.[statusCode];
    const declaredIsBlock =
      declaredBlock != null && typeof declaredBlock === 'object' && !Array.isArray(declaredBlock);
    const declaredEntries = declaredIsBlock
      ? (declaredBlock as Record<string, unknown>)['ResponseParameters']
      : undefined;
    if (declaredIsBlock && !Array.isArray(declaredEntries)) {
      // Declared in the flat SDK spelling (the pass-through branch of
      // `toSdkResponseParameters`) — keep the read-back flat so the two
      // sides compare equal.
      out[statusCode] = flat;
      continue;
    }
    out[statusCode] = {
      ResponseParameters: this.mirrorDeclaredResponsePairs(flat, declaredEntries),
    };
  }
  return out;
}

/**
 * Rebuild one status code's CFn list-of-pairs from AWS's flat map, keeping
 * the DECLARED entries' order and scalar types where they still agree with
 * AWS. See {@link toCfnResponseParameters} for why both matter.
 */
export function mirrorDeclaredResponsePairs(
  this: ApiGatewayV2Provider,
  flat: Record<string, string>,
  declaredEntries: unknown
): Array<{ Destination: string; Source: unknown }> {
  const remaining = new Map(Object.entries(flat));
  const pairs: Array<{ Destination: string; Source: unknown }> = [];
  if (Array.isArray(declaredEntries)) {
    for (const entry of declaredEntries) {
      if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const destination = (entry as Record<string, unknown>)['Destination'];
      if (typeof destination !== 'string' || !remaining.has(destination)) continue;
      const awsSource = remaining.get(destination)!;
      remaining.delete(destination);
      // Re-emit the DECLARED scalar when it denotes the same value AWS
      // returned (`Source: 404` vs `'404'`); a genuinely changed value
      // takes AWS's string, which is the drift the user wants to see.
      const declaredSource = (entry as Record<string, unknown>)['Source'];
      const declaredDenotesSame =
        (typeof declaredSource === 'number' || typeof declaredSource === 'boolean') &&
        String(declaredSource) === awsSource;
      pairs.push({
        Destination: destination,
        Source: declaredDenotesSame ? declaredSource : awsSource,
      });
    }
  }
  // Anything AWS returned that the template did not declare is appended in
  // a stable order — AWS does not guarantee map readback order, so an
  // unsorted tail would trade the shape mismatch for an ordering one. (A
  // declared destination whose VALUE no longer matches is not here: it kept
  // its declared position above and carries AWS's value, which is the drift
  // the user wants to see.)
  for (const [destination, source] of [...remaining.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  )) {
    pairs.push({ Destination: destination, Source: source });
  }
  return pairs;
}
