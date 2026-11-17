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
 * Cloud Control `update()` returns no `effectiveProperties`; one that did
 * would read each as narrowed in `collectNarrowedTopLevelKeys`.
 */
import { hasOwnKey, defineOwnKey } from '../../../utils/own-keys.js';
import { carriesSecretMask } from '../../../deployment/secret-redaction.js';
import { carriesDynamicReference } from '../../../deployment/intrinsic-resolver/context/log-twins.js';
import { getTopLevelKeysHoldingUnreadableCreateOnly } from '../../../provisioning/write-only-properties.js';
import { isPlainRecord } from './revert-merge.js';
import { pairedLiveItems } from './revert-live-values.js';

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
}

/**
 * `send` with each of `names`' write-only positions set to its value in
 * `resolvedProperties` (the record's `properties`, through the revert's
 * dynamic-reference resolution). `paths` are the type's write-only paths as
 * segments under `properties`, `*` for a list element.
 *
 * A key `send` lacks takes the template value whole. In a key `send` holds,
 * only the write-only positions are grafted in; a `*` pairs list elements with
 * `pairedLiveItems` (an identity field or corroborating literals, never the
 * index alone) and skips the key when the lists do not pair. Never mutates
 * `send`.
 */
export function withDeclaredWriteOnlyValues(
  send: Record<string, unknown>,
  resolvedProperties: Record<string, unknown> | undefined,
  names: readonly string[],
  paths: ReadonlyArray<readonly string[]>
): DeclaredWriteOnlyResult {
  const skipped: string[] = [];
  if (names.length === 0 || !isPlainRecord(resolvedProperties)) {
    return { properties: send, skipped };
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
      let ok = true;
      for (const rest of own) {
        const grafted = graftAt(value, declared, rest);
        if (!grafted.ok) ok = false;
        value = grafted.value;
      }
      if (!ok) {
        skipped.push(name);
        continue;
      }
      next = value;
    }
    if (carriesDynamicReference(next) || carriesSecretMask(next)) {
      skipped.push(name);
      continue;
    }
    if (out === send) out = { ...send };
    defineOwnKey(out, name, next);
  }
  return { properties: out, skipped };
}

/**
 * `send` with `declared`'s value at `path` copied in. A position the template
 * does not declare keeps `send`'s value. `ok: false` when a `*` list could not
 * be paired, or a template element has no partner.
 */
function graftAt(
  send: unknown,
  declared: unknown,
  path: readonly string[]
): { value: unknown; ok: boolean } {
  if (path.length === 0) return { value: declared, ok: true };
  const [segment, ...rest] = path;
  if (segment === '*') {
    if (!Array.isArray(declared)) return { value: send, ok: true };
    if (!Array.isArray(send)) return { value: declared, ok: true };
    const paired = pairedLiveItems(send, declared);
    if (!paired) return { value: send, ok: false };
    let ok = true;
    const value = send.map((element, index) => {
      const partner = paired[index];
      if (partner === undefined) {
        ok = false;
        return element;
      }
      const grafted = graftAt(element, partner, rest);
      if (!grafted.ok) ok = false;
      return grafted.value;
    });
    return { value, ok };
  }
  if (!isPlainRecord(declared) || !hasOwnKey(declared, segment!)) return { value: send, ok: true };
  const base: Record<string, unknown> = isPlainRecord(send) ? { ...send } : {};
  const grafted = graftAt(
    hasOwnKey(base, segment!) ? base[segment!] : undefined,
    declared[segment!],
    rest
  );
  defineOwnKey(base, segment!, grafted.value);
  return { value: base, ok: grafted.ok };
}

/** True when `value` holds a single-key `Ref` / `Fn::*` object at any depth. */
function carriesIntrinsicObject(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(carriesIntrinsicObject);
  if (value === null || typeof value !== 'object') return false;
  const keys = Object.keys(value);
  if (keys.length === 1 && (keys[0] === 'Ref' || keys[0]!.startsWith('Fn::'))) return true;
  return Object.values(value as Record<string, unknown>).some(carriesIntrinsicObject);
}
