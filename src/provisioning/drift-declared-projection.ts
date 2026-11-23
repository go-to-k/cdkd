/**
 * go-to-k/cdkd#6854: compare only the members a template DECLARES inside a
 * property AWS fills with defaults on read.
 *
 * Some readbacks return the declared configuration verbatim plus members the
 * template omitted, filled by the service (a DLM schedule's `CopyTags: false`
 * and `RetainRule.Interval: 0`). Comparing the whole value against the
 * template-born baseline reports those defaults as drift on every run; hiding
 * the whole property (the old `getDriftUnknownPaths` entry) also hides a real
 * out-of-band change to a declared member. Projecting each side onto the
 * declared shape keeps the declared members compared and drops an undeclared
 * member only where it holds a value the service is known to fill
 * ({@link FilledDefault}): any other undeclared member (one added out of band,
 * which the next whole-value update would wipe) stays and is reported.
 */
import { SECRET_MASK } from '../deployment/secret-redaction.js';

/**
 * Whether the undeclared member `key` holding `value` is a default the service
 * fills when the template omits it. Absent: no member is (every undeclared
 * member is kept).
 */
export type FilledDefault = (key: string, value: unknown) => boolean;

/**
 * A {@link FilledDefault} from a table of member name -> the values the
 * service fills it with. A plain object every member of which is itself a
 * filled default (an `Exclusions` holding only its defaults) is one too.
 * Values compare by JSON form; a name not in the table is never a default.
 */
export function filledDefaultsFrom(
  table: Readonly<Record<string, readonly unknown[]>>
): FilledDefault {
  const matches: FilledDefault = (key, value) => {
    if (Object.hasOwn(table, key)) {
      const json = JSON.stringify(value);
      if (table[key]!.some((d) => JSON.stringify(d) === json)) return true;
    }
    return (
      isPlainObject(value) &&
      Object.keys(value).length > 0 &&
      Object.entries(value).every(([k, v]) => matches(k, v))
    );
  };
  return matches;
}

const NO_FILLED_DEFAULTS: FilledDefault = () => false;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * `actual` restricted to the members `declared` names, recursively:
 *
 * - Two objects: `declared`'s keys, each projected, plus every undeclared key
 *   whose value `isFilled` does not call a filled default; a declared key the
 *   actual value lacks stays absent, so the comparison reports it removed.
 * - Two lists: element by element, by POSITION (the readbacks this serves
 *   return lists in the order they were sent, measured); an element past the
 *   declared length is kept whole, so an added element is reported.
 * - A declared scalar and an actual scalar of another type whose string forms
 *   are equal (a template's `"7"` and the API's `7`): the declared spelling,
 *   since the API stores one typed value for both. Anything else differing in
 *   string form (`"07"` and `7`) stays as read.
 * - Anything else (a shape mismatch, an object against a list): `actual`
 *   unchanged, so the difference stays visible.
 *
 * Pure and non-mutating; returns `actual` itself when nothing is removed.
 */
export function projectOntoDeclared(
  declared: unknown,
  actual: unknown,
  isFilled: FilledDefault = NO_FILLED_DEFAULTS
): unknown {
  if (isPlainObject(declared) && isPlainObject(actual)) {
    const out: Record<string, unknown> = {};
    let changed = false;
    for (const [key, value] of Object.entries(actual)) {
      if (!Object.hasOwn(declared, key)) {
        if (isFilled(key, value)) {
          changed = true;
        } else {
          out[key] = value;
        }
        continue;
      }
      const projected = projectOntoDeclared(declared[key], value, isFilled);
      if (projected !== value) changed = true;
      out[key] = projected;
    }
    return changed ? out : actual;
  }
  if (Array.isArray(declared) && Array.isArray(actual)) {
    let changed = false;
    const out = actual.map((element: unknown, i) => {
      if (i >= declared.length) return element;
      const projected = projectOntoDeclared(declared[i], element, isFilled);
      if (projected !== element) changed = true;
      return projected;
    });
    return changed ? out : actual;
  }
  if (
    isScalar(declared) &&
    isScalar(actual) &&
    typeof declared !== typeof actual &&
    String(declared) === String(actual)
  ) {
    return declared;
  }
  return actual;
}

/**
 * Whether `value` holds a `{{resolve:` reference or the redaction mask (a leaf
 * that IS {@link SECRET_MASK}: state redaction replaces a secret leaf whole)
 * anywhere.
 */
function holdsUnsentValue(value: unknown): boolean {
  if (typeof value === 'string') return value === SECRET_MASK || value.includes('{{resolve:');
  if (Array.isArray(value)) return value.some(holdsUnsentValue);
  if (isPlainObject(value)) return Object.values(value).some(holdsUnsentValue);
  return false;
}

/**
 * The drift pair with each `keys` member the template declares (non-null in
 * `properties`) projected onto that declaration on both sides. A baseline
 * that lacks a declared key (an `observedProperties` record captured before
 * the readback emitted it) takes the declared value, which is what the deploy
 * sent, so the key is compared from the first drift after the upgrade rather
 * than only after the next capture; a declared value holding a `{{resolve:`
 * reference or a mask is not what was sent, so that baseline takes the
 * readback's value instead. With `fillUnread`, a readback without a declared
 * key (its read failed and the provider left the key out; a provider passing
 * it spells a removal some other way) takes the baseline's, so the key is not
 * compared on that read and `--accept` keeps the recorded value; without it a
 * missing key is a removal, reported as drift. Keys
 * the template does not declare are left alone (the provider's
 * `getDriftUnknownPaths` skips them). Returns both inputs by identity when
 * nothing applies.
 */
export function projectDeclaredDriftPair(
  keys: readonly string[],
  baseline: Record<string, unknown>,
  aws: Record<string, unknown>,
  properties: Record<string, unknown> | undefined,
  isFilled: FilledDefault = NO_FILLED_DEFAULTS,
  fillUnread = false
): { baseline: Record<string, unknown>; aws: Record<string, unknown> } {
  let nextBaseline = baseline;
  let nextAws = aws;
  for (const key of keys) {
    const declared = properties?.[key];
    if (declared === undefined || declared === null) continue;
    // A recorded value holding an unresolved `{{resolve:` reference or a
    // mask is not what the deploy sent, and `drift --revert` would send it
    // verbatim: such a legacy baseline is completed from the readback.
    const fallback = holdsUnsentValue(declared) ? aws[key] : declared;
    if (!Object.hasOwn(baseline, key) && fallback === undefined) continue;
    const baseValue = Object.hasOwn(baseline, key) ? baseline[key] : fallback;
    const projectedBase = projectOntoDeclared(declared, baseValue, isFilled);
    if (!Object.hasOwn(baseline, key) || projectedBase !== baseline[key]) {
      if (nextBaseline === baseline) nextBaseline = { ...baseline };
      nextBaseline[key] = projectedBase;
    }
    if (Object.hasOwn(aws, key)) {
      const projectedAws = projectOntoDeclared(declared, aws[key], isFilled);
      if (projectedAws !== aws[key]) {
        if (nextAws === aws) nextAws = { ...aws };
        nextAws[key] = projectedAws;
      }
    } else if (fillUnread && Object.hasOwn(nextBaseline, key)) {
      // The key's read failed: not compared on this read.
      if (nextAws === aws) nextAws = { ...aws };
      nextAws[key] = nextBaseline[key];
    }
  }
  return { baseline: nextBaseline, aws: nextAws };
}

/**
 * The `keys` a drift comparison skips for one resource: every key when the
 * caller has no recorded properties (an absent or empty bag, the type-level
 * answer), else each key the template does not declare.
 */
export function undeclaredDriftKeys(
  keys: readonly string[],
  properties: Record<string, unknown> | undefined
): string[] {
  if (properties === undefined || Object.keys(properties).length === 0) return [...keys];
  return keys.filter((key) => properties[key] === undefined || properties[key] === null);
}
