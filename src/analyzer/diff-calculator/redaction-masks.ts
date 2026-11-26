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
  isUnverifiedPassedSecret,
  maskedPropertyFingerprintsOf,
  maskedPropertyInputFingerprintsOf,
  passedSecretVerdictOf,
  type BindingFingerprinter,
  type InputFingerprinter,
  type UnverifiedPassedSecret,
} from '../../deployment/masked-property-fingerprints/records.js';
import { safeMsg } from '../../utils/display-safe.js';
import {
  publicReferencesMoved,
  type PublicReferenceOf,
} from '../../deployment/masked-property-fingerprints/public-references.js';
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
 *   equal to today's;
 * - every input other than `{{resolve:...}}` text was resolved and hashed,
 *   or, where the key reads a parameter a nested child's parent passed as
 *   `secret`, the record's keyed MACs of those values equal today's
 *   (`cdkd:passed`, bound to the same proven input fingerprint);
 * - every plain `{{resolve:ssm:...}}` reference the template value spells
 *   resolved to the public value the record hashed (`publicReferences`;
 *   absent, unknown or unrecorded reads as moved). A secret's value is not
 *   compared, as in CloudFormation.
 * Only the positions holding the mask are masked on the desired side; every
 * other leaf of the key is compared as before.
 */
export async function maskUnmovedRedactionMasks(
  record: ResourceState,
  rawDesired: Record<string, unknown>,
  current: Record<string, unknown>,
  desired: Record<string, unknown>,
  fingerprinter:
    | (InputFingerprinter & { concrete?: (key: string) => Promise<boolean> })
    | undefined,
  publicReferences?: PublicReferenceOf
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
    // fingerprints prove nothing then, so the key is compared as is. A
    // parameter the parent passed as `secret` is proven by its value MACs
    // instead (bound to today's inputs, every other one resolved and hashed);
    // `movedMaskedProperties` reports the key moved on anything less, except
    // no usable MAC at all, which it reads unmoved and warns of (#7050 review).
    let concrete = false;
    try {
      concrete = (await fingerprinter.concrete?.(key)) === true;
    } catch {
      concrete = false;
    }
    if (!concrete) {
      const verdict = await passedSecretVerdictOf(fingerprinter, key, record);
      if (verdict !== 'confirmed' && !isUnverifiedPassedSecret(verdict)) continue;
    }
    if (
      await publicReferencesMoved(record, key, rawDesired[key], publicReferences, fingerprinter)
    ) {
      continue;
    }
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

/** A passed-secret member the plan backfills (go-to-k/cdkd#7050 review). */
export type PassedSecretBackfill = { fingerprint: string; macs: Record<string, string> };

/**
 * go-to-k/cdkd#7050 review: the plan's side of the keys `movedMaskedProperties`
 * read unmoved with no usable passed-secret MAC (`unverified`). Each is
 * warned of, naming the resource and the key, never a value. A key whose
 * record never held a member (`'absent'`) gets today's member in `backfills`
 * (logical id -> key -> member), which the deploy stamps on the record (the
 * #4451 `rebaselined` precedent), when the run has its MACs and it binds to
 * the input fingerprint the record holds; it is then compared from the next
 * deploy on. Short of that, the key is unmoved on every deploy, and said so.
 */
export async function reportUnverifiedPassedSecrets(args: {
  logicalId: string;
  record: ResourceState;
  unverified: ReadonlyArray<readonly [string, UnverifiedPassedSecret]>;
  fingerprinter: Partial<BindingFingerprinter> | undefined;
  backfills: Map<string, Record<string, PassedSecretBackfill>> | undefined;
  warn: (message: string) => void;
}): Promise<void> {
  const { logicalId, record, unverified, fingerprinter, backfills, warn } = args;
  if (unverified.length === 0) return;
  const inputs = maskedPropertyInputFingerprintsOf(record);
  const stamped: Array<[string, PassedSecretBackfill]> = [];
  for (const [key, verdict] of unverified) {
    let member: PassedSecretBackfill | undefined;
    if (verdict === 'absent' && backfills !== undefined) {
      member = await fingerprinter?.passedSecretMember?.(key).catch(() => undefined);
    }
    if (member !== undefined && member.fingerprint === inputs.get(key)) {
      stamped.push([key, member]);
      warn(
        safeMsg`${logicalId}: ${key} reads a parameter the parent stack passed as a secret, and its record holds no value fingerprint for it (written before cdkd recorded one), so its value was not compared on this deploy and it is treated as unchanged. It is fingerprinted from now on.`
      );
    } else if (verdict === 'unusable') {
      warn(
        safeMsg`${logicalId}: ${key} reads a parameter the parent stack passed as a secret, and the value fingerprint its record holds is unusable (malformed, or made under another MAC key), so its value cannot be compared and it is treated as unchanged on every deploy until the property is sent again. No replacement is planned over it.`
      );
    } else {
      warn(
        safeMsg`${logicalId}: ${key} reads a parameter the parent stack passed as a secret, and its value cannot be compared without the NoEcho value MAC key (kms:GenerateMac on alias/cdkd-noecho-mac), so it is treated as unchanged on every deploy until a value fingerprint can be recorded. No replacement is planned over it.`
      );
    }
  }
  if (stamped.length > 0) backfills!.set(logicalId, Object.fromEntries(stamped));
}
