import {
  SECRET_MASK,
  carriesSecretMask,
  dynamicReferenceTokens,
} from '../../deployment/secret-redaction.js';
import {
  REFUSED_FINGERPRINT,
  maskedPropertyFingerprint,
  splitInputFingerprint,
} from '../../deployment/masked-property-fingerprints/core.js';
import {
  maskedPropertyFingerprintsOf,
  maskedPropertyInputFingerprintsOf,
  type InputFingerprinter,
} from '../../deployment/masked-property-fingerprints/records.js';
import type { ResourceState } from '../../types/state.js';

/**
 * `desired` with each position the RECORD holds `***` masked too, for every
 * top-level key the persist walk masked as a redaction (go-to-k/cdkd#7050)
 * and whose template has provably not moved since (go-to-k/cdkd#4451's
 * fingerprints), so the plan does not read the mask as a change on every
 * deploy. The persist walk masks a leaf it cannot attribute (a secret under
 * the value scan's floor beside a value-bearing part), which the plan side,
 * holding no secret, cannot reproduce: without this the leaf is a perpetual
 * UPDATE, a REPLACEMENT on a create-only property, which the stateful
 * preflight refuses forever.
 *
 * Only where EVERY test holds, so a real change is never hidden:
 * - the record holds the mask in that key, and the desired value does not
 *   (a desired mask is the `NoEcho` comparison's, already equal or not);
 * - the template's value there spells a `{{resolve:...}}` reference (the
 *   precondition of a redaction mask);
 * - the record's fingerprint of the UNRESOLVED template value is present, not
 *   refused, and equal to today's;
 * - the record's fingerprint of the value's resolved INPUTS (parameters,
 *   referenced attributes, conditions; go-to-k/cdkd#4543) is present and
 *   equal to today's.
 * Only the positions holding the mask are masked on the desired side; every
 * other leaf of the key is compared as before.
 */
export async function maskUnmovedRedactionMasks(
  record: ResourceState,
  rawDesired: Record<string, unknown>,
  current: Record<string, unknown>,
  desired: Record<string, unknown>,
  fingerprinter: (InputFingerprinter & { concrete?: (key: string) => Promise<boolean> }) | undefined
): Promise<Record<string, unknown>> {
  if (fingerprinter === undefined) return desired;
  const fingerprints = maskedPropertyFingerprintsOf(record);
  if (fingerprints.size === 0) return desired;
  const inputs = maskedPropertyInputFingerprintsOf(record);
  let out: Record<string, unknown> | undefined;
  for (const key of Object.keys(current)) {
    if (!Object.hasOwn(desired, key) || !Object.hasOwn(rawDesired, key)) continue;
    if (!carriesSecretMask(current[key])) continue;
    // A desired value already carrying a mask is the `NoEcho` comparison's,
    // unless the record masked the key WHOLE: a nested child's read of a
    // masked parameter plans as `a-***` against a stored `***` (#7050 review).
    if (carriesSecretMask(desired[key]) && current[key] !== SECRET_MASK) continue;
    // The template's value spells a reference, or reads one through a
    // parameter or attribute: either way the fingerprints below are the proof.
    if (
      dynamicReferenceTokens(JSON.stringify(rawDesired[key]) ?? '').length === 0 &&
      !readsAnyInput(rawDesired[key])
    ) {
      continue;
    }
    const fingerprint = fingerprints.get(key);
    if (fingerprint === undefined || fingerprint === REFUSED_FINGERPRINT) continue;
    if (maskedPropertyFingerprint(rawDesired[key]) !== fingerprint) continue;
    const bound = inputs.get(key);
    if (bound === undefined) continue;
    let now: string | undefined;
    try {
      now = await fingerprinter(key);
    } catch {
      continue;
    }
    if (
      now === undefined ||
      splitInputFingerprint(now).input !== splitInputFingerprint(bound).input
    ) {
      continue;
    }
    // An input kept AS WRITTEN (a secret-class or `NoEcho` parameter, a
    // tainted attribute) hashes the same whatever its value: equal
    // fingerprints prove nothing then, so the key is compared as is.
    let concrete = false;
    try {
      concrete = (await fingerprinter.concrete?.(key)) === true;
    } catch {
      concrete = false;
    }
    if (!concrete) continue;
    (out ??= { ...desired })[key] = maskedWhere(current[key], desired[key]);
  }
  return out ?? desired;
}

/** Does the template value read a parameter, an attribute or an import (an intrinsic call)? */
function readsAnyInput(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(readsAnyInput);
  if (value === null || typeof value !== 'object') return false;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'Ref' || k.startsWith('Fn::') || readsAnyInput(v)) return true;
  }
  return false;
}

/** `desired` with `SECRET_MASK` at every position `recorded` holds it; shape mismatches mask whole. */
function maskedWhere(recorded: unknown, desired: unknown): unknown {
  if (recorded === SECRET_MASK) return SECRET_MASK;
  if (Array.isArray(recorded)) {
    if (!Array.isArray(desired) || desired.length !== recorded.length) return desired;
    return desired.map((item, i) => maskedWhere(recorded[i], item));
  }
  if (recorded !== null && typeof recorded === 'object') {
    if (desired === null || typeof desired !== 'object' || Array.isArray(desired)) return desired;
    const out: Record<string, unknown> = { ...(desired as Record<string, unknown>) };
    for (const [k, v] of Object.entries(recorded as Record<string, unknown>)) {
      if (Object.hasOwn(out, k)) out[k] = maskedWhere(v, out[k]);
    }
    return out;
  }
  return desired;
}
