import type { JsonPatchOp } from './json-patch-generator.js';

/**
 * Extend a non-empty Cloud Control update patch with `add /<key>` (which
 * replaces an existing member, RFC 6902) for every top-level key `desired`
 * declares that the patch has no op on, so the update handler receives each
 * declared key as declared (go-to-k/cdkd#6676).
 *
 * Cloud Control applies the patch on top of the model its read handler
 * returns, so a key the patch leaves alone reaches the update API in the
 * read handler's spelling, and some services refuse that spelling: a listener
 * rule's duplicate `Values` (#6663), a detector's read-back `Features`
 * (#4910). CloudFormation's update handler is given the template's model, so
 * sending the declared value is CloudFormation parity. On `cdkd drift
 * --revert` `desired` is the read-back snapshot, so the added values are the
 * ones the model already holds.
 *
 * `excluded` ({@link getSettledDeclaredResendExclusions}) names the keys that
 * keep their own handling: one holding a create-only, read-only or write-only
 * path at any depth. `undefined` (the schema is not known) adds nothing. A key
 * `desired` does not declare is never touched (#6569 handles a measured few).
 * No AWS call is added.
 */
export function withDeclaredKeysResent(
  patch: JsonPatchOp[],
  desired: Record<string, unknown>,
  excluded: ReadonlySet<string> | undefined
): JsonPatchOp[] {
  if (patch.length === 0 || excluded === undefined) return patch;
  const touched = new Set(patch.map((op) => op.path));
  const extra: JsonPatchOp[] = [];
  for (const [key, value] of Object.entries(desired)) {
    if (excluded.has(key) || value === undefined) continue;
    const path = `/${escapeJsonPointer(key)}`;
    if (touched.has(path)) continue;
    extra.push({ op: 'add', path, value });
  }
  return extra.length === 0 ? patch : [...patch, ...extra];
}

/** RFC 6901, as `json-patch-generator.ts` spells the paths it emits. */
function escapeJsonPointer(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}
