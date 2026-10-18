import {
  type PathSourceRules,
  TEMPLATE_DERIVED_RULES,
  TEMPLATE_SOURCED_RULES,
  STATE_SOURCED_READBACK_RULES,
  STATE_SOURCED_BASELINE_RULES,
  STATE_SOURCED_CROSS_GENERATION_RULES,
  STATE_DERIVED_RULES,
} from './rules.js';
import { type RecordedSecretValues } from './pairs.js';
import { redactSecretsForState } from './redact-state.js';
import { isRecordingScope } from './recording.js';

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
 *   (`template-derived`; `template-sourced`, whose deploy outputs bag is
 *   this pass's own resolution; `state-derived`, whose rollback restore can
 *   be the replay's own resolution, go-to-k/cdkd#5056), and absent elsewhere:
 *   no caller of those variants holds a bag this pass produced
 *   (go-to-k/cdkd#5047).
 *
 * The walk reads the claim from this field alone, never from a mark on the
 * bag. `markSameGenerationBag` is a TRANSPORT between a producer and a writer
 * that builds the context later (the deploy engine's persist choke point);
 * such a writer states what the mark says here, or in
 * `scrubResourceRecord`'s `claims`.
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
 *
 * `secrets` is the PASS map: what the resolver recorded, and every map that
 * recorded on its behalf through a live scope (go-to-k/cdkd#5048,
 * `recording.ts`), whose entries and log-only needles land there as they are
 * recorded, so the bag persisted and every masker reading the pass see one
 * recording. A scope's own map is refused here.
 */
export type RedactionContext =
  | { readonly provenance: 'value-scan'; readonly secrets: RecordedSecretValues }
  | {
      readonly provenance: 'template-derived' | 'template-sourced';
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
      readonly provenance: 'state-derived';
      readonly secrets: RecordedSecretValues;
      readonly source: object;
      /**
       * `same-generation`: the bag is THIS pass's resolution of `source` (a
       * rollback replay's restore of the journaled record, from a bag its
       * producer marked; go-to-k/cdkd#5056). `unproven` otherwise.
       */
      readonly generation: 'same-generation' | 'unproven';
    }
  | {
      readonly provenance: 'state-readback' | 'state-baseline' | 'state-cross-generation';
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
 * choke point every writer outside the family goes through.
 *
 * `source` is an `object`, so a possibly-`undefined` value cannot slip a
 * positional provenance into the value scan the walk takes without a source.
 *
 * A `same-generation` claim reaches the walk only for a plain object or an
 * array (a primitive bag never carried one), and the walk is handed a SHALLOW
 * COPY, as when the claim was a mark on that copy: where the walk falls back
 * to the value scan (a root shape the source does not share, on an empty map)
 * it returns its input by identity, so that result is copied again and a
 * claimed result is never the caller's object.
 */
export function redactForState<T>(bag: T, context: RedactionContext): T {
  refuseScopeAsPass(context.secrets);
  if (context.provenance === 'value-scan') {
    return redactSecretsForState(bag, context.secrets);
  }
  const { secrets, source, provenance } = context;
  // Narrowed by PROVENANCE, never by the field's presence: a `state-*`
  // context built by spreading another object could carry a stray
  // `generation` at runtime, and only the variants that declare it may claim.
  const claimed =
    (context.provenance === 'template-derived' ||
      context.provenance === 'template-sourced' ||
      context.provenance === 'state-derived') &&
    context.generation === 'same-generation';
  if (!claimed || !isPlainBag(bag)) {
    return redactAtProvenance(bag, secrets, source, provenance, false);
  }
  const copy = shallowCopy(bag);
  const redacted = redactAtProvenance(copy, secrets, source, provenance, true);
  return redacted === copy ? shallowCopy(copy) : redacted;
}

/**
 * The positional walk under `provenance`'s rules, with the generation claim
 * as an explicit argument (go-to-k/cdkd#5047) and the bag walked as given.
 * Family-internal, for the writers inside `secret-redaction/` whose claim the
 * context type does not offer for their provenance: `scrubResourceRecord`,
 * whose caller states a claim per bag of a record, and
 * `recordNestedStackParameterExpressions`, whose replay arm is a
 * `state-derived` resolution this pass produced. Not re-exported by the
 * barrel.
 */
export function redactAtProvenance<T>(
  bag: T,
  secrets: RecordedSecretValues,
  source: object,
  provenance: Exclude<RedactionProvenance, 'value-scan'>,
  sameGeneration: boolean
): T {
  refuseScopeAsPass(secrets);
  return redactSecretsForState(
    bag,
    secrets,
    source,
    RULES_BY_PROVENANCE[provenance],
    sameGeneration
  );
}

/**
 * A live recording scope's map holds only what was recorded THROUGH it, a
 * subset of its pass by design (`secret-redaction/recording.ts`), so
 * persisting with it would keep in plaintext what the pass recorded elsewhere
 * (go-to-k/cdkd#5048). A programming error, never a user's input.
 */
function refuseScopeAsPass(secrets: RecordedSecretValues): void {
  if (isRecordingScope(secrets)) {
    throw new Error(
      "Internal error: a bag was redacted for persistence with a recording scope; pass the scope's pass map instead."
    );
  }
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
