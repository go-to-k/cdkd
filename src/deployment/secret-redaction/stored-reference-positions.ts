import { isPlainObject } from './rules.js';
import { maskAtCoordinates, replaceAtCoordinates } from './noecho-leaves.js';
import { mentionsMask } from './recorded-secrecy.js';
import { dynamicReferenceTokens } from './redact-path/reference-tokens.js';
import {
  corroborates,
  listPairing,
  plaintextFor,
  secretReferenceLeaves,
  secretReferenceTest,
  type OffTemplateEchoRecord,
} from './off-template-echo.js';

/**
 * go-to-k/cdkd#7167: an orphan or superseded record's `observedProperties`
 * leaf at the position its OWN `properties` hold a secret reference, put back
 * on that reference, or masked.
 *
 * The deploy save's walk over such a record has no needles (nothing resolved
 * it this run) and takes the #1900 fall-back with the record's own
 * `properties` as the position source. That walk does not enter an unkeyed
 * list by position, because AWS does not preserve list order, so a plaintext
 * an older binary wrote at `Users[0].Password` was kept. This pass enters the
 * list the way the off-template pass does ({@link listPairing}: a shared
 * identity field, else every element corroborating by position), and errs
 * toward masking where that refuses:
 *
 * - an element exactly one readback element corroborates ({@link corroborates})
 *   is paired with it;
 * - otherwise (an identity field that pairs nothing included) every readback
 *   element that could hold the value (the corroborating ones, else all) is
 *   entered along the rest of the coordinate and the leaf there is masked
 *   unless it already holds the reference or the mask. An element lacking
 *   that leaf holds no copy and is kept, and no element is kept because
 *   ANOTHER one holds the reference (an AWS-added element can hold the copy);
 * - at a paired leaf, a readback string that lines up with the recorded text
 *   gets that text back; any other value that is neither the reference, the
 *   mask nor `null` is masked.
 *
 * Both sides are the RECORD's own bags, one generation: no template is read,
 * so the live record (whose `properties` `cdkd scrub` repositions against
 * today's template) never takes this pass. A public `ssm` token a record
 * holds (`secretReferenceTest`) is over-masked here, in the safe direction.
 * Returns `record` by identity when nothing changed.
 */
export function withStoredReferencePositionsMasked<R extends OffTemplateEchoRecord>(record: R): R {
  const observed = record.observedProperties;
  const properties = record.properties;
  if (observed === undefined || properties === undefined) return record;
  const isSecretReference = secretReferenceTest();
  const restore: Array<{ coordinate: (string | number)[]; value: unknown }> = [];
  const mask: (string | number)[][] = [];
  for (const { coordinate, text } of secretReferenceLeaves(properties, isSecretReference)) {
    const walk = (
      live: unknown,
      recorded: unknown,
      depth: number,
      path: (string | number)[],
      ambiguous: boolean
    ): void => {
      if (live === undefined || live === null) return;
      if (depth === coordinate.length) {
        if (typeof live === 'string') {
          if (live === text || mentionsMask(live) || dynamicReferenceTokens(live).length > 0)
            return;
          if (!ambiguous && plaintextFor(text, live) !== undefined) {
            restore.push({ coordinate: path, value: text });
            return;
          }
        }
        mask.push(path);
        return;
      }
      const segment = coordinate[depth]!;
      if (typeof segment === 'string') {
        // A string standing where the record holds an object can be the
        // value itself; an object lacking the key holds no copy.
        if (
          typeof live === 'string' &&
          !mentionsMask(live) &&
          dynamicReferenceTokens(live).length === 0
        ) {
          mask.push(path);
          return;
        }
        if (!isPlainObject(live) || !Object.hasOwn(live, segment)) return;
        walk(
          live[segment],
          isPlainObject(recorded) ? recorded[segment] : undefined,
          depth + 1,
          [...path, segment],
          ambiguous
        );
        return;
      }
      if (!Array.isArray(live) || !Array.isArray(recorded)) return;
      const element = recorded[segment];
      const pairing = listPairing(live, recorded, isSecretReference);
      // An identity field that pairs no element (AWS normalised its value)
      // falls through to the corroboration below, never to a kept plaintext.
      const paired = pairing?.(segment);
      if (paired !== undefined) {
        walk(live[paired], element, depth + 1, [...path, paired], ambiguous);
        return;
      }
      // A readback element the identity field pairs with ANOTHER recorded
      // element is that element's, never a candidate for this one.
      const claimed = new Set(
        pairing === undefined
          ? []
          : recorded.flatMap((_, j) => {
              const index = j === segment ? undefined : pairing(j);
              return index === undefined ? [] : [index];
            })
      );
      const corroborating = live.flatMap((item, i) =>
        !claimed.has(i) && corroborates(item, element, isSecretReference) ? [i] : []
      );
      if (corroborating.length === 1) {
        const only = corroborating[0]!;
        walk(live[only], element, depth + 1, [...path, only], ambiguous);
        return;
      }
      // Each element that could hold the value is entered along the REST of
      // the coordinate, and only the leaf there is masked: an element lacking
      // that leaf (AWS omits a write-only secret from its readback) holds no
      // copy, and masking it whole would replace a correct baseline.
      const pool =
        corroborating.length > 0
          ? corroborating
          : live.flatMap((_, i) => (claimed.has(i) ? [] : [i]));
      for (const i of pool) walk(live[i], element, depth + 1, [...path, i], true);
    };
    walk(observed, properties, 0, [], false);
  }
  if (restore.length === 0 && mask.length === 0) return record;
  return {
    ...record,
    observedProperties: maskAtCoordinates(replaceAtCoordinates(observed, restore), mask),
  };
}
