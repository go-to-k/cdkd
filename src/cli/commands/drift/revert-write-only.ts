/**
 * `cdkd drift --revert`: the template's write-only values a Cloud Control
 * routed update sends (go-to-k/cdkd#6498, #6499).
 *
 * The revert's send bag is the readback plus the baseline's drifted subtrees,
 * and no read returns a write-only value. Cloud Control applies the patch
 * read-modify-write, and `CloudControlProvider.update` re-adds each
 * write-only-bearing top-level key from the bag it is given (#809), so:
 * - a wholly write-only key was absent and the handler took its default: a
 *   rotation schedule's `RotateImmediatelyOnUpdate: false` became `true`, and
 *   the revert rotated the secret (#6498);
 * - a readable key holding a NESTED write-only member was re-added
 *   readback-shaped, without the member: an `AWS::Events::Connection`'s
 *   `AuthParameters` lost `ApiKeyValue`, and Cloud Control refused every
 *   revert of a connection (#6499).
 *
 * Only the write-only POSITIONS take the template's value. Everything else in
 * a container keeps the send bag's value, which is the baseline the revert
 * restores: an `--accept`ed `ApiKeyName` stays accepted.
 *
 * Coupling: nothing writes these values into state. That holds while the
 * Cloud Control `update()` returns no `effectiveProperties` on a revert. It
 * returns one only for a key it judged unapplied (`[cc-silent-noop]`,
 * go-to-k/cdkd#7099), and on a revert (`desiredFromAwsReadback`) that key
 * fails the update instead, so a revert never gets one. A revert path that
 * did would read each key as narrowed in `collectNarrowedTopLevelKeys`.
 */
import { hasOwnKey, defineOwnKey } from '../../../utils/own-keys.js';
import { carriesSecretMask } from '../../../deployment/secret-redaction.js';
import { carriesDynamicReference } from '../../../deployment/intrinsic-resolver/context/log-twins.js';
import { getTopLevelKeysHoldingUnreadableCreateOnly } from '../../../provisioning/write-only-properties.js';
import { isPlainRecord } from './revert-merge.js';
import { deepEqualUnordered } from './revert-payload.js';

/**
 * The top-level keys holding a write-only path that the template declares and
 * a Cloud Control routed revert sends, in schema order. Printed by the plan and
 * passed to {@link withDeclaredWriteOnlyValues}.
 *
 * Left out:
 * - a value holding a redaction mask or an unresolved intrinsic object: state
 *   holds neither in a form AWS can be sent. A dynamic reference IS named: the
 *   revert sends the value it resolved, under its masking;
 * - a key holding a create-only path the read cannot return
 *   (`getTopLevelKeysHoldingUnreadableCreateOnly`, #4416: an IoT certificate's
 *   `CertificateSigningRequest`): Cloud Control refuses any patch adding one,
 *   and a deploy's update skips it only because its previous side is the
 *   template, where a revert's is the readback.
 *
 * Pure: `runRevert` looks the type's write-only names up ONCE, on a Cloud
 * Control route only, and the plan and the update both read the result, so
 * the user confirms what is written. A failed lookup (`undefined`) names none.
 */
export function revertWriteOnlyResendNames(
  resourceType: string,
  properties: Record<string, unknown> | undefined,
  writeOnlyNames: ReadonlySet<string> | undefined
): string[] {
  if (!writeOnlyNames || writeOnlyNames.size === 0 || !isPlainRecord(properties)) return [];
  const unreadableCreateOnly = getTopLevelKeysHoldingUnreadableCreateOnly(resourceType, properties);
  const names: string[] = [];
  for (const name of writeOnlyNames) {
    if (!hasOwnKey(properties, name) || unreadableCreateOnly.has(name)) continue;
    const value = properties[name];
    if (value === undefined || value === null) continue;
    if (carriesSecretMask(value) || carriesIntrinsicObject(value)) continue;
    names.push(name);
  }
  return names;
}

/** {@link withDeclaredWriteOnlyValues}'s result. */
export interface DeclaredWriteOnlyResult {
  /** The send bag, `send` by identity when nothing changed. */
  properties: Record<string, unknown>;
  /**
   * Named keys left as `send` holds them: a value still carrying a
   * `{{resolve:...}}` (a reference the run could not resolve) or a mask, or a
   * list whose elements could not be paired with the template's. The caller
   * warns: Cloud Control may refuse the update, or apply defaults there.
   */
  skipped: string[];
  /**
   * Named keys sent at the template's WHOLE value because a list on a
   * write-only path could not be matched item by item: a deploy sends the
   * same. The caller warns, since list items `--accept` changed revert to the
   * template there.
   */
  wholesale: string[];
}

/**
 * `send` with each of `names`' write-only positions set to its value in
 * `resolvedProperties` (the record's `properties`, through the revert's
 * dynamic-reference resolution). `paths` are the type's write-only paths as
 * segments under `properties`, `*` for a list element.
 *
 * A key `send` lacks takes the template value whole, and so does any position
 * on the way to a write-only leaf that `send` lacks. In a key `send` holds,
 * only the write-only positions are grafted in. A `*` matches list items
 * with {@link pairListItems}; when the lists do not match, the key goes at
 * the template's whole value (`wholesale`), as a deploy sends it. Never
 * mutates `send`.
 */
export function withDeclaredWriteOnlyValues(
  send: Record<string, unknown>,
  resolvedProperties: Record<string, unknown> | undefined,
  names: readonly string[],
  paths: ReadonlyArray<readonly string[]>
): DeclaredWriteOnlyResult {
  const skipped: string[] = [];
  const wholesale: string[] = [];
  if (names.length === 0 || !isPlainRecord(resolvedProperties)) {
    return { properties: send, skipped, wholesale };
  }
  let out = send;
  for (const name of names) {
    if (!hasOwnKey(resolvedProperties, name)) continue;
    const declared = resolvedProperties[name];
    if (declared === undefined || declared === null) continue;
    let next: unknown;
    if (!hasOwnKey(send, name)) {
      next = declared;
    } else {
      const own = paths.filter((p) => p[0] === name).map((p) => p.slice(1));
      let value: unknown = send[name];
      let matched = true;
      for (const rest of own) {
        const grafted = graftAt(value, declared, rest, own);
        if (!grafted.ok) matched = false;
        value = grafted.value;
      }
      if (matched) {
        next = value;
      } else {
        next = declared;
        wholesale.push(name);
      }
    }
    if (carriesDynamicReference(next) || carriesSecretMask(next)) {
      skipped.push(name);
      const at = wholesale.indexOf(name);
      if (at !== -1) wholesale.splice(at, 1);
      continue;
    }
    if (out === send) out = { ...send };
    defineOwnKey(out, name, next);
  }
  return { properties: out, skipped, wholesale };
}

/**
 * `send` with `declared`'s value at `path` copied in. A position the template
 * does not declare keeps `send`'s value; one `send` lacks takes the template's
 * whole. `ok: false` when a `*` list could not be matched item by item, or the
 * bag holds another shape (a string, a list) where the template has a
 * container.
 * `writeOnly` is every write-only path under the same top-level key, relative
 * to where the walk started, so a list match ignores those leaves.
 */
function graftAt(
  send: unknown,
  declared: unknown,
  path: readonly string[],
  writeOnly: ReadonlyArray<readonly string[]>
): { value: unknown; ok: boolean } {
  if (path.length === 0 || send === undefined || send === null) {
    return { value: declared, ok: true };
  }
  const [segment, ...rest] = path;
  const below = writeOnly.filter((p) => p[0] === segment).map((p) => p.slice(1));
  if (segment === '*') {
    if (!Array.isArray(declared)) return { value: send, ok: true };
    // A bag holding another shape here cannot take a graft: send the
    // template whole, reported.
    if (!Array.isArray(send)) return { value: send, ok: false };
    const partners = pairListItems(send, declared, below);
    if (!partners) return { value: send, ok: false };
    let ok = true;
    const value = send.map((element, index) => {
      const grafted = graftAt(element, partners[index], rest, below);
      if (!grafted.ok) ok = false;
      return grafted.value;
    });
    return { value, ok };
  }
  if (!isPlainRecord(declared) || !hasOwnKey(declared, segment!)) return { value: send, ok: true };
  if (!isPlainRecord(send)) return { value: send, ok: false };
  const base: Record<string, unknown> = { ...send };
  const grafted = graftAt(
    hasOwnKey(base, segment!) ? base[segment!] : undefined,
    declared[segment!],
    rest,
    below
  );
  defineOwnKey(base, segment!, grafted.value);
  return { value: base, ok: grafted.ok };
}

/**
 * For each item of `send`, its partner in `declared`, or `undefined` when the
 * lists do not match one to one. A template item partners a bag item when
 * every template leaf outside the write-only paths (`writeOnly`, relative to
 * an item) equals the bag's value there; keys only the bag holds (AWS
 * defaults such as a ListenerRule action's `Order`) are ignored. Equal
 * lengths and a UNIQUE partner on both sides are required: an ambiguous or
 * missing match is no match, never a guess by index.
 */
function pairListItems(
  send: readonly unknown[],
  declared: readonly unknown[],
  writeOnly: ReadonlyArray<readonly string[]>
): unknown[] | undefined {
  if (send.length !== declared.length) return undefined;
  const templates = declared.map((item) => withoutPaths(item, writeOnly));
  const partners: unknown[] = [];
  const used = new Set<number>();
  for (const item of send) {
    const candidates = templates
      .map((t, index) => (covers(t, item) ? index : -1))
      .filter((index) => index !== -1);
    if (candidates.length !== 1 || used.has(candidates[0]!)) return undefined;
    used.add(candidates[0]!);
    partners.push(declared[candidates[0]!]);
  }
  return partners;
}

/** `value` without the leaves at `paths` (`*` for every list item). */
function withoutPaths(value: unknown, paths: ReadonlyArray<readonly string[]>): unknown {
  if (paths.length === 0) return value;
  if (Array.isArray(value)) {
    const inner = paths.filter((p) => p[0] === '*').map((p) => p.slice(1));
    return value.map((item) => withoutPaths(item, inner));
  }
  if (!isPlainRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const inner = paths.filter((p) => p[0] === key).map((p) => p.slice(1));
    if (inner.some((p) => p.length === 0)) continue;
    defineOwnKey(out, key, withoutPaths(child, inner));
  }
  return out;
}

/** Every leaf of `template` equals `actual`'s value there; extra keys in `actual` are ignored. */
function covers(template: unknown, actual: unknown): boolean {
  if (isPlainRecord(template)) {
    if (!isPlainRecord(actual)) return false;
    return Object.entries(template).every(
      ([key, child]) => hasOwnKey(actual, key) && covers(child, actual[key])
    );
  }
  if (Array.isArray(template)) {
    return (
      Array.isArray(actual) &&
      template.length === actual.length &&
      template.every((child, index) => covers(child, actual[index]))
    );
  }
  return deepEqualUnordered(template, actual);
}

/** True when `value` holds a single-key `Ref` / `Fn::*` object at any depth. */
function carriesIntrinsicObject(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(carriesIntrinsicObject);
  if (value === null || typeof value !== 'object') return false;
  const keys = Object.keys(value);
  if (keys.length === 1 && (keys[0] === 'Ref' || keys[0]!.startsWith('Fn::'))) return true;
  return Object.values(value as Record<string, unknown>).some(carriesIntrinsicObject);
}
