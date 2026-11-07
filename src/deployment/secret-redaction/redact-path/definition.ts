import { type RecordedSecretValues, SECRET_MASK } from '../pairs.js';
import { isPlainObject, MIN_NEEDLE_LENGTH } from '../rules.js';
import { carriesSecretMask } from '../mask-only.js';
import { subtreeHasDynamicReference } from './subtree.js';
import { hasPlainPrototype } from './json-equality.js';

/**
 * The record keys a Step Functions definition is BUILT from: the body (inline
 * as a string or an object) and the `${name}` substitution map applied to it
 * (issue [#5315](https://github.com/go-to-k/cdkd/issues/5315)).
 * Among the schemas cdkd carries, `DefinitionSubstitutions` exists only on
 * `AWS::StepFunctions::StateMachine`; the arm keys on these NAMES, so another
 * type spelling them the same way is covered too.
 */
const DEFINITION_SOURCE_KEYS = ['DefinitionSubstitutions', 'DefinitionString', 'Definition'];

/** The readback keys that carry the RENDERED body (`readCurrentState` emits `Definition`). */
export const RENDERED_DEFINITION_KEYS: ReadonlySet<string> = new Set([
  'Definition',
  'DefinitionString',
]);

/**
 * Does a key the definition is built from carry a secret: a dynamic reference,
 * or a {@link SECRET_MASK} a `NoEcho` value left (a substitution value, or a
 * body the containment arm flattened whole)?
 *
 * A PUBLIC `{{resolve:ssm:...}}` counts too. Only a legacy record holds one
 * unresolved (a deploy persists a public parameter's value), and nothing on an
 * empty map can tell it from a `SecureString`, so its substituted leaves are
 * masked: phantom drift, not a disclosure — the module's "PUBLIC ssm MIXED leaf,
 * EMPTY map, no proof" row, one key over.
 */
export function definitionSourceCarriesSecret(source: Record<string, unknown>): boolean {
  return DEFINITION_SOURCE_KEYS.some(
    (k) =>
      Object.hasOwn(source, k) &&
      (subtreeHasDynamicReference(source[k]) || carriesSecretMask(source[k]))
  );
}

/**
 * Every NUMBER / BOOLEAN leaf whose spelling (`String(leaf)`) IS a recorded
 * plaintext, replaced by `***` (issue #5315; the expression until #5333, which
 * drift reported against the live number on every run). WHOLE value only, like the string arm's
 * first test, matched by spelling and by JSON value (so `1.50` read back as
 * `1.5` is named). A plain container is rebuilt null-prototype; anything else is
 * returned by identity. A record with no JSON-scalar plaintext returns the
 * value untouched.
 */
function nameScalarSecrets(value: unknown, secrets: RecordedSecretValues): unknown {
  // Each plaintext's JSON-SCALAR form too, compared by value: a body that
  // places `1.50` or `1e3` outside quotes reads back as `1.5` / `1000`, whose
  // `String()` is not the plaintext.
  const byValue = new Set<unknown>();
  for (const plaintext of secrets.keys()) {
    try {
      const parsed = JSON.parse(plaintext) as unknown;
      if ((typeof parsed === 'number' && Number.isFinite(parsed)) || typeof parsed === 'boolean') {
        byValue.add(parsed);
      }
    } catch {
      // Not a JSON scalar: no number or boolean can spell it.
    }
  }
  if (byValue.size === 0) return value;
  const walk = (node: unknown): unknown => {
    if (typeof node === 'number' || typeof node === 'boolean') {
      if (typeof node === 'number' && !Number.isFinite(node)) return node;
      // `***`, not the expression: a STRING where AWS holds a number would be
      // drift on every run, and `--revert` would send it into the definition.
      // A mask is what the uncertified-baseline partition owns.
      return secrets.has(String(node)) || byValue.has(node) ? SECRET_MASK : node;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (isPlainObject(node) && hasPlainPrototype(node)) {
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [k, v] of Object.entries(node)) out[k] = walk(v);
      return out;
    }
    return node;
  };
  return walk(value);
}

/** Marks a secret `${name}` INSIDE a JSON string of a sentinel-rendered body. */
const SENTINEL_IN_STRING = '';
/** Wraps the index of a secret `${name}` placed OUTSIDE quotes (rendered as a JSON string value). */
const SENTINEL_OUT_OF_STRING = '';

/** A substitution value that stands for a secret: a reference, or a `NoEcho` `***`, anywhere in it. */
function substitutionIsSecret(value: string): boolean {
  return subtreeHasDynamicReference(value) || value.includes(SECRET_MASK);
}

/**
 * What the record's own definition body SPELLS, read with each secret
 * `${name}` replaced by a SENTINEL (issue
 * [#5333](https://github.com/go-to-k/cdkd/issues/5333)).
 *
 * A small scan tracks the body's JSON string state (the provider's
 * substitution is a blind split / join, so where a placeholder sits in the
 * body is where its value lands): a secret placeholder inside a string becomes
 * a private-use marker, one outside quotes a JSON string value naming its
 * index. A non-secret scalar substitution is inserted verbatim and scanned like
 * the body; an unknown name is left as `${name}`. The result then parses even
 * where the substituted body does not (`"Seconds": ${pin}` with an expression
 * value).
 *
 * - `keys`: every object key holding no marker (a literal the record spells),
 *   plus the keys of the body as WRITTEN (a `${name}` key is a placeholder,
 *   which an unsubstituted readback still spells, and no secret);
 * - `strings` / `scalars`: every leaf holding no marker;
 * - `secretLeaves`: every leaf a secret lands in — inside a string or, with
 *   its `name`, outside quotes — with the SHAPE of each container on its path,
 *   so a reader can refuse a readback the secret itself reshaped.
 *
 * `undefined` when no body is held (`DefinitionS3Location`), none parses (a
 * `***` body, a placeholder glued to other tokens), or the body already holds a
 * marker character, which could then name the wrong substitution.
 */
export interface SentinelDefinition {
  readonly keys: Set<string>;
  readonly strings: Set<string>;
  readonly scalars: Set<unknown>;
  readonly secretLeaves: ReadonlyArray<SecretLeaf>;
}

/** One position of a sentinel body a secret lands in. */
export interface SecretLeaf {
  readonly path: ReadonlyArray<string | number>;
  /** The container at each depth of `path`: an array's length, or an object's keys as written. */
  readonly shapes: ReadonlyArray<number | ReadonlySet<string>>;
  /** The substitution placed OUTSIDE quotes, or `undefined` for one inside a string. */
  readonly outOfStringName: string | undefined;
  /** An in-string leaf as WRITTEN (`Bearer ${k}`), which an unsubstituted readback still holds. */
  readonly asWritten: string | undefined;
}

export function sentinelDefinitionOf(
  source: Record<string, unknown>
): SentinelDefinition | undefined {
  const subs = source['DefinitionSubstitutions'];
  const values = new Map<string, string>();
  if (isPlainObject(subs)) {
    for (const [name, value] of Object.entries(subs)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        values.set(name, String(value));
      }
    }
  }
  for (const key of ['DefinitionString', 'Definition']) {
    if (!Object.hasOwn(source, key)) continue;
    const raw = source[key];
    const body =
      typeof raw === 'string' ? raw : isPlainObject(raw) ? JSON.stringify(raw) : undefined;
    if (body === undefined) continue;
    // ...spelled raw, or as a JSON escape that `JSON.parse` would decode into one.
    if (
      body.includes(SENTINEL_IN_STRING) ||
      body.includes(SENTINEL_OUT_OF_STRING) ||
      /\\u[eE]00[01]/.test(body)
    ) {
      continue;
    }
    const names: string[] = [];
    let text = '';
    let inString = false;
    let escaped = false;
    const feed = (c: string): void => {
      text += c;
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
      } else if (c === '"') {
        inString = true;
      }
    };
    for (let i = 0; i < body.length; i++) {
      if (body.startsWith('${', i)) {
        const end = body.indexOf('}', i + 2);
        const name = end === -1 ? undefined : body.slice(i + 2, end);
        const value = name === undefined ? undefined : values.get(name);
        if (name !== undefined && value !== undefined) {
          if (substitutionIsSecret(value)) {
            const index = names.push(name) - 1;
            text += inString
              ? `${SENTINEL_IN_STRING}${index}${SENTINEL_IN_STRING}`
              : `"${SENTINEL_OUT_OF_STRING}${index}${SENTINEL_OUT_OF_STRING}"`;
          } else {
            for (const c of value) feed(c);
          }
          i = end;
          continue;
        }
      }
      feed(body[i]!);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      continue;
    }
    const keys = new Set<string>();
    const strings = new Set<string>();
    const scalars = new Set<unknown>();
    const secretLeaves: SecretLeaf[] = [];
    const marked = (t: string): boolean =>
      t.includes(SENTINEL_IN_STRING) || t.includes(SENTINEL_OUT_OF_STRING);
    const outOfString = new RegExp(`^${SENTINEL_OUT_OF_STRING}(\\d+)${SENTINEL_OUT_OF_STRING}$`);
    const inStringMarkers = new RegExp(`${SENTINEL_IN_STRING}(\\d+)${SENTINEL_IN_STRING}`, 'g');
    const written = (t: string): string =>
      t.replace(inStringMarkers, (_m, i: string) => `\${${names[Number(i)]}}`);
    const walk = (
      node: unknown,
      path: Array<string | number>,
      shapes: Array<number | ReadonlySet<string>>
    ): void => {
      if (typeof node === 'string') {
        const m = outOfString.exec(node);
        if (m !== null) {
          secretLeaves.push({
            path,
            shapes,
            outOfStringName: names[Number(m[1])],
            asWritten: undefined,
          });
        } else if (marked(node)) {
          secretLeaves.push({
            path,
            shapes,
            outOfStringName: undefined,
            asWritten: written(node),
          });
        } else {
          strings.add(node);
        }
        return;
      }
      if (typeof node === 'number' || typeof node === 'boolean') {
        scalars.add(node);
        return;
      }
      if (Array.isArray(node)) {
        node.forEach((item, i) => walk(item, [...path, i], [...shapes, node.length]));
        return;
      }
      if (isPlainObject(node)) {
        // A key a secret lands in is walked by its spelling AS WRITTEN
        // (`${name}`): the only readback that can still hold the key there is
        // an unsubstituted one, since a substituted key holds the plaintext,
        // which the key rule masks whole before any position is read.
        const own = new Set(Object.keys(node).map(written));
        for (const [k, v] of Object.entries(node)) {
          if (!marked(k)) keys.add(k);
          walk(v, [...path, written(k)], [...shapes, own]);
        }
      }
    };
    walk(parsed, [], []);
    try {
      collectObjectKeys(JSON.parse(body) as unknown, keys);
    } catch {
      // The body as written does not parse (a placeholder outside quotes).
    }
    return { keys, strings, scalars, secretLeaves };
  }
  return undefined;
}

/**
 * The read-back value at a sentinel {@link SecretLeaf}, or `undefined` when the
 * readback does not have the body's shape on the way: an array of another
 * length, or an object with another key set — a secret `1, 2` splices an
 * element in, a secret `1, "b": 2` adds a key, and a position in a misaligned
 * tree names the wrong leaf.
 */
export function alignedSecretLeaf(root: unknown, leaf: SecretLeaf): { value: unknown } | undefined {
  let cursor = root;
  for (const [depth, segment] of leaf.path.entries()) {
    const shape = leaf.shapes[depth]!;
    if (typeof shape === 'number') {
      if (!Array.isArray(cursor) || cursor.length !== shape) return undefined;
      cursor = cursor[segment as number];
    } else {
      if (!isPlainObject(cursor)) return undefined;
      // The same key set as the body (keys a secret lands in, as written).
      const own = Object.keys(cursor);
      if (own.length !== shape.size || own.some((k) => !shape.has(k))) return undefined;
      if (!Object.hasOwn(cursor, segment)) return undefined;
      cursor = cursor[segment as string];
    }
  }
  return { value: cursor };
}

/** Every object key of a parsed body (plain containers only). */
export function collectObjectKeys(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectObjectKeys(item, into);
  } else if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      collectObjectKeys(v, into);
    }
  }
}

/**
 * Every object KEY a resource record spells: the keys of its `properties`, plus
 * those of a Step Functions definition body read with and without its
 * substitutions ({@link sentinelDefinitionOf}). A key the record spells is not
 * a secret, so `cdkd drift --revert` registers only the OTHER keys of a live
 * value with the log masker (go-to-k/cdkd#5342) — registering `Type` or
 * `States` would mask those words wherever a persisted value equals them.
 */
export function spelledKeysOf(properties: Record<string, unknown>): Set<string> {
  const keys = new Set<string>();
  collectObjectKeys(properties, keys);
  for (const key of sentinelDefinitionOf(properties)?.keys ?? []) keys.add(key);
  return keys;
}

/** Does any object key anywhere in `value` fail `spelled`? */
export function someKeyIsUnspelled(value: unknown, spelled: (key: string) => boolean): boolean {
  if (Array.isArray(value)) return value.some((item) => someKeyIsUnspelled(item, spelled));
  if (isPlainObject(value)) {
    return Object.entries(value).some(([k, v]) => !spelled(k) || someKeyIsUnspelled(v, spelled));
  }
  return false;
}

/**
 * The populated-map half of the rendered-definition rule (issues #5315,
 * #5333), applied to the value the path pass and value scan produced for a
 * `Definition` / `DefinitionString` key.
 *
 * WITH a sentinel body ({@link sentinelDefinitionOf}):
 * - any read-back KEY the record does not spell (a secret in a state name, or
 *   one whose value broke out of its string and reshaped the keys) makes the
 *   WHOLE value `***` — the representation the maintainer chose on #5333, which
 *   `cdkd drift` classifies as an uncertified baseline;
 * - every position a secret lands in must sit in a readback of the body's
 *   shape ({@link alignedSecretLeaf}), else the whole value is `***`: a secret
 *   holding a `"` or a `,` can splice fragments the value scan has no needle
 *   for;
 * - at an OUT-OF-QUOTES position the read-back value becomes `***`, whatever
 *   it parsed to (a number, a boolean, a JSON-string or JSON-document secret).
 *   Only THAT position: a literal `Seconds: 3` beside a secret `3` stays a
 *   number.
 *
 * WITHOUT one (no body held, none parses) the record says nothing about
 * positions, so the map decides: a key holding a recorded plaintext (whole, or
 * a substring at least {@link MIN_NEEDLE_LENGTH} long) makes the whole value
 * `***`, and every number / boolean whose spelling is a recorded plaintext is
 * named ({@link nameScalarSecrets}) — #5327's rule, kept as the fallback.
 */
export function nameDefinitionSecrets(
  value: unknown,
  source: Record<string, unknown>,
  secrets: RecordedSecretValues
): unknown {
  if (value === null || typeof value !== 'object') return value;
  const sentinel = sentinelDefinitionOf(source);
  if (sentinel === undefined) {
    const plaintexts = [...secrets.keys()].filter((p) => p !== '');
    const keyHoldsSecret = (key: string): boolean =>
      plaintexts.some((p) => key === p || (p.length >= MIN_NEEDLE_LENGTH && key.includes(p)));
    if (someKeyIsUnspelled(value, (key) => !keyHoldsSecret(key))) return SECRET_MASK;
    return nameScalarSecrets(value, secrets);
  }
  if (someKeyIsUnspelled(value, (key) => sentinel.keys.has(key))) {
    return SECRET_MASK;
  }
  let out: unknown = value;
  for (const leaf of sentinel.secretLeaves) {
    if (alignedSecretLeaf(out, leaf) === undefined) return SECRET_MASK;
    if (leaf.outOfStringName !== undefined) {
      // `***`, whatever AWS holds there. The expression re-resolves to the
      // value's JSON TEXT (a number's digits, a JSON-string secret WITH its
      // quotes), never what AWS decoded it into, so an expression here is drift
      // on every run and a `--revert` would write the wrong value. A mask is
      // what the uncertified-baseline partition owns.
      out = replaceAtPath(out, leaf.path, SECRET_MASK);
    }
  }
  return out;
}

/** `root` with the leaf at `path` replaced, containers on the way copied. */
export function replaceAtPath(
  root: unknown,
  path: ReadonlyArray<string | number>,
  leaf: unknown
): unknown {
  if (path.length === 0) return leaf;
  const [head, ...rest] = path;
  if (Array.isArray(root)) {
    const copy = [...root];
    copy[head as number] = replaceAtPath(root[head as number], rest, leaf);
    return copy;
  }
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  Object.assign(copy, root as Record<string, unknown>);
  copy[head as string] = replaceAtPath(
    (root as Record<string, unknown>)[head as string],
    rest,
    leaf
  );
  return copy;
}
