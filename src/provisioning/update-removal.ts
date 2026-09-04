/**
 * Shared clear-on-removal resolver for merge-semantics update APIs
 * (issue #1160 — the absent-field removal silent-drop bug class; reference
 * fix `LambdaFunctionProvider`, #1157; extracted from the per-provider
 * copies in #1223).
 *
 * CloudFormation resets a property REMOVED from the template to its default,
 * while most AWS `Update*` / `Modify*` APIs treat an absent input field as
 * "no change" (merge semantics). A provider `update()` that passes template
 * properties straight into the SDK input therefore silently keeps the old
 * live value on removal. Route every optional mutable field of a
 * merge-semantics API through this helper, with `clearValue` set to the
 * property's CFn default or the SDK-documented clear sentinel — see
 * docs/provider-rules.md "Update removal semantics" for the per-field checklist.
 *
 * Returns `newValue` when present, the `clearValue` when the field was
 * present before and is now absent (removal), and `undefined` when it was
 * never present (so a genuinely-absent field stays absent = no change).
 */
export function clearOnUpdateRemoval<T>(
  newValue: T | undefined,
  previousValue: T | undefined,
  clearValue: T
): T | undefined {
  if (newValue !== undefined) return newValue;
  if (previousValue !== undefined) return clearValue;
  return undefined;
}
