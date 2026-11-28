import { isPlainObject } from './rules.js';
import { isWhollyMask, maskAtCoordinates, replaceAtCoordinates } from './noecho-leaves.js';
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
 * - otherwise every readback element that could hold the value (the
 *   corroborating ones, else all) is masked WHOLE, unless the readback list
 *   already holds the reference as often as the recorded list does (the record
 *   was redacted when it was written);
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
    const tokens = dynamicReferenceTokens(text).filter((token) => isSecretReference(token));
    const walk = (
      live: unknown,
      recorded: unknown,
      depth: number,
      path: (string | number)[]
    ): void => {
      if (live === undefined || live === null) return;
      if (depth === coordinate.length) {
        if (typeof live === 'string') {
          if (live === text || mentionsMask(live) || dynamicReferenceTokens(live).length > 0)
            return;
          if (plaintextFor(text, live) !== undefined) {
            restore.push({ coordinate: path, value: text });
            return;
          }
        }
        mask.push(path);
        return;
      }
      const segment = coordinate[depth]!;
      if (typeof segment === 'string') {
        if (!isPlainObject(live) || !Object.hasOwn(live, segment)) return;
        walk(live[segment], isPlainObject(recorded) ? recorded[segment] : undefined, depth + 1, [
          ...path,
          segment,
        ]);
        return;
      }
      if (!Array.isArray(live) || !Array.isArray(recorded)) return;
      const element = recorded[segment];
      const pairing = listPairing(live, recorded, isSecretReference);
      if (pairing !== undefined) {
        const index = pairing(segment);
        if (index !== undefined) walk(live[index], element, depth + 1, [...path, index]);
        return;
      }
      const corroborating = live.flatMap((item, i) =>
        corroborates(item, element, isSecretReference) ? [i] : []
      );
      if (corroborating.length === 1) {
        walk(live[corroborating[0]!], element, depth + 1, [...path, corroborating[0]!]);
        return;
      }
      // Ambiguous: the readback list already holding the reference as often
      // as the recorded one does is a record redacted when it was written.
      if (holdingCount(live, tokens) >= holdingCount(recorded, tokens)) return;
      const pool = corroborating.length > 0 ? corroborating : live.map((_, i) => i);
      for (const i of pool) {
        if (holdingCount(live[i], tokens) === 0 && !isWhollyMask(live[i])) mask.push([...path, i]);
      }
    };
    walk(observed, properties, 0, []);
  }
  if (restore.length === 0 && mask.length === 0) return record;
  return {
    ...record,
    observedProperties: maskAtCoordinates(replaceAtCoordinates(observed, restore), mask),
  };
}

/** How many string leaves of `node` hold one of `tokens`. */
function holdingCount(node: unknown, tokens: readonly string[]): number {
  if (typeof node === 'string') return tokens.some((token) => node.includes(token)) ? 1 : 0;
  if (Array.isArray(node))
    return node.reduce<number>((n, item) => n + holdingCount(item, tokens), 0);
  if (isPlainObject(node)) {
    return Object.values(node).reduce<number>((n, item) => n + holdingCount(item, tokens), 0);
  }
  return 0;
}
