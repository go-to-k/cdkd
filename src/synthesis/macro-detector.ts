/**
 * CloudFormation macro detection (Issue #463 Phase 1).
 *
 * Pure-functional helpers that determine whether a synth template uses
 * any CloudFormation transform (top-level `Transform: [...]` or
 * snippet-level `Fn::Transform: {...}` blocks). cdkd's analyzer /
 * provisioner pipeline does NOT understand `Fn::Transform` — the
 * resolver has no handler and the DAG builder cannot extract refs
 * buried inside an unexpanded macro snippet — so a template that
 * triggers `containsMacro` must be handed to CloudFormation for
 * server-side expansion via {@link import('./macro-expander.js')}
 * before the rest of the pipeline can safely consume it.
 *
 * Design: [docs/design/463-cfn-macros.md](../../docs/design/463-cfn-macros.md).
 */

/**
 * Returns true when the given template uses any CloudFormation
 * transform. Tolerates malformed inputs (null / non-object / missing
 * `Resources`) by returning `false` so the rest of the synthesis
 * pipeline surfaces the malformed-template error rather than the
 * detector silently throwing.
 *
 * Detection rule:
 * - `template.Transform` is set (string OR array form).
 * - OR a recursive walk over `Resources` / `Outputs` / `Mappings` /
 *   `Conditions` / `Rules` finds any `{Fn::Transform: {...}}` key.
 *
 * The walk does NOT descend into `Metadata` blocks: CloudFormation
 * does not expand transforms inside metadata (the field is preserved
 * verbatim to AWS), so a `Fn::Transform` literally appearing under
 * `Metadata` is not a real macro reference and we must not surface it
 * as such.
 */
export function containsMacro(template: unknown): boolean {
  if (!template || typeof template !== 'object' || Array.isArray(template)) {
    return false;
  }
  const t = template as Record<string, unknown>;
  if (hasTopLevelTransform(t)) {
    return true;
  }
  for (const section of ['Resources', 'Outputs', 'Mappings', 'Conditions', 'Rules'] as const) {
    const sub = t[section];
    if (sub && typeof sub === 'object' && hasFnTransformDeep(sub)) {
      return true;
    }
  }
  return false;
}

/**
 * Returns every transform name declared in `Transform` plus the names
 * referenced via `Fn::Transform`, deduplicated and in encounter order.
 * Used for telemetry / UX (e.g. logging which transforms are about to
 * be expanded). Malformed entries (non-string Transform names, missing
 * `Name` field on Fn::Transform) are skipped silently — they would be
 * surfaced as a clear error by CloudFormation at expansion time.
 *
 * The walk follows the same rules as {@link containsMacro}: it descends
 * into `Resources` / `Outputs` / `Mappings` / `Conditions` / `Rules`
 * but NOT into `Metadata`.
 */
export function enumerateMacros(template: unknown): string[] {
  if (!template || typeof template !== 'object' || Array.isArray(template)) {
    return [];
  }
  const t = template as Record<string, unknown>;
  const seen = new Set<string>();
  const result: string[] = [];

  // Top-level Transform
  const top = t['Transform'];
  if (typeof top === 'string') {
    pushName(top, seen, result);
  } else if (Array.isArray(top)) {
    for (const entry of top) {
      // Each entry may be a bare name string OR an object form
      // ({Name: '...', Parameters: {...}}).
      if (typeof entry === 'string') {
        pushName(entry, seen, result);
      } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const name = (entry as Record<string, unknown>)['Name'];
        if (typeof name === 'string') pushName(name, seen, result);
      }
    }
  } else if (top && typeof top === 'object' && !Array.isArray(top)) {
    // `Transform: { Name: '...', Parameters: {...} }` single-object form.
    const name = (top as Record<string, unknown>)['Name'];
    if (typeof name === 'string') pushName(name, seen, result);
  }

  // Snippet-level Fn::Transform anywhere under Resources / Outputs / etc.
  for (const section of ['Resources', 'Outputs', 'Mappings', 'Conditions', 'Rules'] as const) {
    const sub = t[section];
    if (sub && typeof sub === 'object') {
      collectFnTransformNames(sub, seen, result);
    }
  }
  return result;
}

function pushName(name: string, seen: Set<string>, out: string[]): void {
  if (seen.has(name)) return;
  seen.add(name);
  out.push(name);
}

function hasTopLevelTransform(t: Record<string, unknown>): boolean {
  const top = t['Transform'];
  if (top === undefined || top === null) return false;
  // Empty array → no transform actually requested. CFn permits this
  // (it is a no-op) and we treat it as "no macro" to keep cdkd from
  // doing a useless round-trip.
  if (Array.isArray(top) && top.length === 0) return false;
  return true;
}

/**
 * Recursively walk the given value and return true if any nested
 * object carries a `Fn::Transform` key (with a non-null value — a
 * literal `Fn::Transform: null` is not a real macro reference).
 *
 * Does NOT descend into `Metadata` keys at any depth (CFn does not
 * expand transforms inside metadata blocks, so a `Fn::Transform`
 * literally appearing there must not trigger expansion). The
 * `Metadata` exclusion mirrors the same rule applied at the
 * top-level section walk in {@link containsMacro}.
 */
function hasFnTransformDeep(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (hasFnTransformDeep(item)) return true;
    }
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (obj['Fn::Transform'] !== undefined && obj['Fn::Transform'] !== null) {
    return true;
  }
  for (const [key, sub] of Object.entries(obj)) {
    if (key === 'Metadata') continue;
    if (hasFnTransformDeep(sub)) return true;
  }
  return false;
}

/**
 * Recursively walk and collect every `Fn::Transform.Name` value into
 * the provided dedup set / order-preserving array. Sibling to
 * {@link hasFnTransformDeep}; same `Metadata` exclusion.
 */
function collectFnTransformNames(value: unknown, seen: Set<string>, out: string[]): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectFnTransformNames(item, seen, out);
    return;
  }
  const obj = value as Record<string, unknown>;
  const fnT = obj['Fn::Transform'];
  if (fnT && typeof fnT === 'object' && !Array.isArray(fnT)) {
    const name = (fnT as Record<string, unknown>)['Name'];
    if (typeof name === 'string') pushName(name, seen, out);
  }
  for (const [key, sub] of Object.entries(obj)) {
    if (key === 'Metadata') continue;
    collectFnTransformNames(sub, seen, out);
  }
}
