import {
  type PathSourceRules,
  TEMPLATE_DERIVED_RULES,
  TEMPLATE_SOURCED_RULES,
  STATE_SOURCED_READBACK_RULES,
  STATE_SOURCED_BASELINE_RULES,
  STATE_SOURCED_CROSS_GENERATION_RULES,
  STATE_DERIVED_RULES,
} from './rules.js';
import { type RecordedSecretValues, markSameGenerationBag } from './pairs.js';
import { redactSecretsForState } from './redact-state.js';

/**
 * What a writer KNOWS about the bag it is about to persist, stated once, as one
 * value (go-to-k/cdkd#1940).
 *
 * {@link redactSecretsForState} takes the same facts as four loose arguments —
 * the secrets map, an optional source, a {@link PathSourceRules} constant, and a
 * generation claim made by marking the bag beforehand — and every caller
 * re-derived the right combination by hand. Here each variant names a
 * PROVENANCE, and the variant decides the rest:
 *
 * - the rules constant is implied by the variant, never passed;
 * - a variant whose rules walk a source REQUIRES one, so a positional pass
 *   cannot silently degrade into a value scan by a dropped argument;
 * - the generation claim is a REQUIRED field where it is a real choice
 *   (`template-derived`), and absent where the variant already fixes it.
 *
 * | provenance | rules | who |
 * | --- | --- | --- |
 * | `value-scan` | none (no source) | a value with no source to position against |
 * | `template-derived` | `TEMPLATE_DERIVED_RULES` | a bag resolved from the template `source` |
 * | `template-sourced` | `TEMPLATE_SOURCED_RULES` | a readback or state bag projected from the template |
 * | `state-readback` | `STATE_SOURCED_READBACK_RULES` | a readback against the record's own bag, landing in `properties` |
 * | `state-baseline` | `STATE_SOURCED_BASELINE_RULES` | the same, landing in a drift BASELINE (fails closed) |
 * | `state-cross-generation` | `STATE_SOURCED_CROSS_GENERATION_RULES` | a state source one generation behind the bag |
 * | `state-derived` | `STATE_DERIVED_RULES` | a bag resolved from a persisted record (`source`) |
 *
 * The rules constants document what each flag means; this type only decides
 * which one a writer gets.
 */
export type RedactionContext =
  | { readonly provenance: 'value-scan'; readonly secrets: RecordedSecretValues }
  | {
      readonly provenance: 'template-derived';
      readonly secrets: RecordedSecretValues;
      readonly source: object;
      /**
       * `same-generation`: the bag is THIS pass's resolution of `source` by the
       * resolver that recorded `secrets` (see `markSameGenerationBag` for what
       * the claim licenses). `unproven`: anything else — a record the pass did
       * not rewrite, or a bag of unknown age.
       */
      readonly generation: 'same-generation' | 'unproven';
    }
  | {
      readonly provenance:
        | 'template-sourced'
        | 'state-readback'
        | 'state-baseline'
        | 'state-cross-generation'
        | 'state-derived';
      readonly secrets: RecordedSecretValues;
      readonly source: object;
    };

export type RedactionProvenance = RedactionContext['provenance'];

const RULES_BY_PROVENANCE: Readonly<
  Record<Exclude<RedactionProvenance, 'value-scan'>, PathSourceRules>
> = {
  'template-derived': TEMPLATE_DERIVED_RULES,
  'template-sourced': TEMPLATE_SOURCED_RULES,
  'state-readback': STATE_SOURCED_READBACK_RULES,
  'state-baseline': STATE_SOURCED_BASELINE_RULES,
  'state-cross-generation': STATE_SOURCED_CROSS_GENERATION_RULES,
  'state-derived': STATE_DERIVED_RULES,
};

/** The rules constant a provenance selects; exported for the choke-point test. */
export function rulesForProvenance(
  provenance: Exclude<RedactionProvenance, 'value-scan'>
): PathSourceRules {
  return RULES_BY_PROVENANCE[provenance];
}

/**
 * Redact `bag` for persistence under what `context` says about it — the
 * choke point every migrated writer goes through.
 *
 * `source` is an `object`, so a possibly-`undefined` value cannot slip a
 * positional provenance into the value scan the walk takes without a source.
 *
 * A `same-generation` claim marks a SHALLOW COPY, never the caller's object,
 * and the mark must not reach a stored record, where it would carry the claim
 * into a later pass it was not made for. The walk usually rebuilds the bag,
 * but where it falls back to the value scan (a root shape the source does not
 * share, on an empty map) it returns its input -- the marked copy -- by
 * identity, so that result is copied again, unmarked. Only a plain object or
 * an array is marked: a spread would drop any other prototype.
 */
export function redactForState<T>(bag: T, context: RedactionContext): T {
  if (context.provenance === 'value-scan') {
    return redactSecretsForState(bag, context.secrets);
  }
  const rules = RULES_BY_PROVENANCE[context.provenance];
  if (
    context.provenance !== 'template-derived' ||
    context.generation !== 'same-generation' ||
    !isPlainBag(bag)
  ) {
    return redactSecretsForState(bag, context.secrets, context.source, rules);
  }
  const marked = markSameGenerationBag(shallowCopy(bag));
  const redacted = redactSecretsForState(marked, context.secrets, context.source, rules);
  return redacted === marked ? shallowCopy(marked) : redacted;
}

function isPlainBag(bag: unknown): bag is object {
  if (Array.isArray(bag)) return true;
  if (bag === null || typeof bag !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(bag);
  return proto === Object.prototype || proto === null;
}

function shallowCopy<T extends object>(bag: T): T {
  return (Array.isArray(bag) ? [...bag] : { ...bag }) as T;
}
