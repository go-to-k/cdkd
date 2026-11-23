import { substitutedSpellingOf, type RecordedSecretValues } from '../pairs.js';
import { isPlainObject } from '../rules.js';
import { rendersLiteralTo } from '../positions.js';
import { dynamicReferenceSpans } from '../redact-path.js';
import { NESTED_STACK_RESOURCE_TYPE } from './parameter-tables.js';

/**
 * A row tag value's certified SPELLING: the text holding the
 * `{{resolve:...}}` expression(s) the value was resolved from, beside the
 * value it renders to. `fromLiteral` is true when every non-token character
 * of the spelling is the TEMPLATE's own literal text (a string source), false
 * when it carries text a non-literal part resolved into it (an `Fn::Join` /
 * `Fn::Sub` source), which the reader still checks for a secret.
 */
export interface RowTagSpelling {
  readonly value: string;
  readonly spelling: string;
  readonly fromLiteral: boolean;
}

/**
 * Per pass bag: tag KEY -> its certified spelling, or `null` when the row
 * spells that key more than once. Keyed by the bag instance, like
 * `nestedStackParameterExpressions`, so the provider reads it off the bag
 * `withCurrentResourceSecrets` binds around its call.
 */
const rowTagSpellings = new WeakMap<RecordedSecretValues, Map<string, RowTagSpelling | null>>();

/**
 * Record, for a nested-stack row, the spelling each of its `Tags` values was
 * resolved FROM (go-to-k/cdkd#6893), so the provider can hand the child the
 * expression instead of the plaintext.
 *
 * `childRowTags` (`providers/nested-stack/row-tags.ts`) turns a secret in a
 * resolved tag value back into its expression by SUBSTRING, through the
 * plaintext-keyed bag. Below `MIN_NEEDLE_LENGTH` (4) that cannot be done
 * safely -- a two-character plaintext occurs in unrelated text (the #2087
 * splice) -- so `pin-{{resolve:...:pin::}}` resolving to `pin-q7` reached
 * the child as `pin-q7`, and the child persisted it. The same class #2745
 * closed for a row's `Parameters`: this recorder is the point holding the
 * row's TEMPLATE spelling beside the resolved value, so the spelling is
 * certified here, by position, at any length:
 *
 * - a STRING source is certified when, rendered with THIS pass's pairs, it
 *   IS the resolved value (`rendersLiteralTo`: every token paired, the render
 *   equal, the value scan silent on the spelling). A source with no token
 *   equal to the value is template text and certified as itself.
 * - an `Fn::Join` / `Fn::Sub` source is certified by its own resolution
 *   record (`substitutedSpellingOf`: one token, a SECRET verdict, the value
 *   produced by that one replacement), which refuses a spelling holding a
 *   plaintext of the map.
 *
 * Anything else (an `Fn::If` item, a non-literal `Key`, a value the
 * certificate refuses) records nothing for that key, and the reader falls
 * back to its substring carry plus a floorless refusal (it withholds the tag
 * rather than write a plaintext). No map entry, pair or pin is written: the
 * association is read only by the provider, by tag key.
 *
 * Never enumerate or log the bag's KEYS: they are secret plaintext.
 */
export function recordNestedStackRowTagSpellings(
  secrets: RecordedSecretValues,
  resourceType: string,
  resolvedProperties: unknown,
  sourceProperties: unknown
): void {
  if (resourceType !== NESTED_STACK_RESOURCE_TYPE) return;
  if (!isPlainObject(resolvedProperties) || !isPlainObject(sourceProperties)) return;
  if (!Object.hasOwn(resolvedProperties, 'Tags') || !Object.hasOwn(sourceProperties, 'Tags')) {
    return;
  }
  const resolvedTags = resolvedProperties['Tags'];
  const sourceTags = sourceProperties['Tags'];
  if (!Array.isArray(resolvedTags) || !Array.isArray(sourceTags)) return;
  // Every source item must name its key LITERALLY, or a resolved key could
  // come from an item this walk cannot see (an `Fn::If` element).
  const sourceByKey = new Map<string, unknown>();
  const repeated = new Set<string>();
  for (const item of sourceTags) {
    if (!isPlainObject(item)) return;
    const key = item['Key'];
    if (typeof key !== 'string') return;
    if (sourceByKey.has(key)) repeated.add(key);
    sourceByKey.set(key, item['Value']);
  }
  const table = new Map<string, RowTagSpelling | null>();
  for (const item of resolvedTags) {
    if (!isPlainObject(item)) continue;
    const key = item['Key'];
    const value = item['Value'];
    if (typeof key !== 'string' || typeof value !== 'string' || !sourceByKey.has(key)) continue;
    if (repeated.has(key) || table.has(key)) {
      table.set(key, null);
      continue;
    }
    const spelling = certifiedSpelling(secrets, sourceByKey.get(key), value);
    if (spelling !== undefined) table.set(key, spelling);
  }
  if (table.size > 0) rowTagSpellings.set(secrets, table);
  else rowTagSpellings.delete(secrets);
}

function certifiedSpelling(
  secrets: RecordedSecretValues,
  source: unknown,
  value: string
): RowTagSpelling | undefined {
  if (typeof source === 'string') {
    if (dynamicReferenceSpans(source).length === 0) {
      return source === value ? { value, spelling: source, fromLiteral: true } : undefined;
    }
    return rendersLiteralTo(source, secrets, value)
      ? { value, spelling: source, fromLiteral: true }
      : undefined;
  }
  if (!isPlainObject(source)) return undefined;
  const spelling = substitutedSpellingOf(secrets, source, value);
  return spelling === undefined ? undefined : { value, spelling, fromLiteral: false };
}

/**
 * The spelling recorded for tag `key` of the row whose bag is `secrets`, when
 * it was certified for exactly `value`; else `undefined`.
 */
export function nestedStackRowTagSpellingOf(
  secrets: RecordedSecretValues,
  key: string,
  value: string
): RowTagSpelling | undefined {
  const entry = rowTagSpellings.get(secrets)?.get(key);
  return entry !== undefined && entry !== null && entry.value === value ? entry : undefined;
}
