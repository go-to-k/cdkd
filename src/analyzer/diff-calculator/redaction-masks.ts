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
 * A key whose inputs cannot prove it either way (an input kept as written or
 * unknown here, no input fingerprint recorded) is UNPROVABLE (#7050 review):
 * where the plan's own value holds a mask too (it cannot see the value
 * either), it compares masked, and is reported to `onUnprovable` (the plan
 * warns, naming the resource and the key); a plan value with no mask (a
 * `NoEcho` source's, which the engine settles by readback) is compared as is.
 * A hashed input or a passed-secret MAC that moved is never masked, and a key
 * the `NoEcho` comparison already masked wherever the record is needs nothing.
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
  publicReferences?: PublicReferenceOf,
  onUnprovable?: (key: string) => void
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
    // A desired side already masked wherever the record is (a `NoEcho`
    // comparison's `***` its value MAC proved) leaves nothing to mask, nor to
    // warn of (#7050 review).
    if (equalJson(maskedWhere(current[key], desired[key]), desired[key])) continue;
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
    let now: string | undefined;
    try {
      now = await fingerprinter(key);
    } catch {
      now = undefined;
    }
    const comparable = bound !== undefined && now !== undefined;
    // A hashed input that moved is a proven change: compared as is.
    if (comparable && splitInputFingerprint(now!).input !== splitInputFingerprint(bound!).input) {
      continue;
    }
    // An input kept AS WRITTEN (a secret-class or `NoEcho` parameter, a
    // tainted attribute) hashes the same whatever its value, and an unknown
    // one leaves no fingerprint: equal fingerprints prove nothing then. A
    // parameter the parent passed as `secret` is proven by its value MACs
    // instead (bound to today's inputs, every other one resolved and hashed);
    // `movedMaskedProperties` reports the key moved when they differ, and
    // reads no usable MAC unmoved and warns of it (#7050 review). Short of
    // any proof the key is UNPROVABLE (#7050 review): comparing the mask
    // with the plan's value would be a change on every deploy, a replacement
    // the stateful preflight refuses forever, so it reads unmoved, warned of.
    let concrete = false;
    try {
      concrete = (await fingerprinter.concrete?.(key)) === true;
    } catch {
      concrete = false;
    }
    let unprovable = false;
    if (concrete) {
      unprovable = !comparable;
    } else {
      const verdict = await passedSecretVerdictOf(fingerprinter, key, record);
      if (verdict === 'changed') continue;
      if (verdict === 'confirmed') {
        if (!comparable) continue;
      } else if (isUnverifiedPassedSecret(verdict)) {
        // As `movedMaskedProperties` reads it: unmoved with equal inputs, or
        // with none recorded (re-baselined there), and warned of there.
        if (now === undefined) continue;
      } else if (verdict === 'n/a') {
        unprovable = true;
      }
      // `'none'`: reported by `movedMaskedProperties` (`onUnverified`).
    }
    // Unprovable, with a value the plan holds (no mask text of its own): the
    // record's mask is then not the plan's blind spot. A `NoEcho` source's
    // (a parameter, one whose `NoEcho` was removed, a recovered masked
    // output) the engine settles by its readback, so it is compared as is.
    if (unprovable && !(JSON.stringify(desired[key]) ?? '').includes(SECRET_MASK)) continue;
    if (
      await publicReferencesMoved(record, key, rawDesired[key], publicReferences, fingerprinter)
    ) {
      continue;
    }
    if (unprovable) onUnprovable?.(key);
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

/** Equal as JSON (`maskedWhere` keeps the key order of the value it copies). */
function equalJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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
 * #4451 `rebaselined` precedent), when the run writes (`backfills`), has its
 * MACs, and the member binds to the input fingerprint the record holds or
 * this plan re-baselines; it is then compared from the next deploy on. Short
 * of that, the key is unmoved on every deploy, and said so.
 */
export async function reportUnverifiedPassedSecrets(args: {
  logicalId: string;
  record: ResourceState;
  unverified: ReadonlyArray<readonly [string, UnverifiedPassedSecret | 'none']>;
  fingerprinter: Partial<BindingFingerprinter> | undefined;
  /** `undefined`: nothing this run writes (a dry run), so nothing is backfilled. */
  backfills: Map<string, Record<string, PassedSecretBackfill>> | undefined;
  /** The input fingerprints this same plan re-baselines (key -> fingerprint). */
  rebaselined?: ReadonlyMap<string, string>;
  warn: (message: string) => void;
}): Promise<void> {
  const { logicalId, record, unverified, fingerprinter, backfills, rebaselined, warn } = args;
  if (unverified.length === 0) return;
  const inputs = maskedPropertyInputFingerprintsOf(record);
  const stamped: Array<[string, PassedSecretBackfill]> = [];
  for (const [key, verdict] of unverified) {
    let member: PassedSecretBackfill | undefined;
    if (verdict === 'absent' && backfills !== undefined) {
      member = await fingerprinter?.passedSecretMember?.(key).catch(() => undefined);
    }
    // Bound to the input fingerprint the record holds after this plan's save.
    const expected = inputs.get(key) ?? rebaselined?.get(key);
    if (verdict === 'absent' && backfills === undefined) {
      warn(
        safeMsg`${logicalId}: ${key} reads a parameter the parent stack passed as a secret, and its record holds no value fingerprint for it (written before cdkd recorded one), so its value is not compared and it is treated as unchanged. A deploy that can make one (kms:GenerateMac on alias/cdkd-noecho-mac) records it.`
      );
    } else if (member !== undefined && member.fingerprint === expected) {
      stamped.push([key, member]);
      warn(
        safeMsg`${logicalId}: ${key} reads a parameter the parent stack passed as a secret, and its record holds no value fingerprint for it (written before cdkd recorded one), so its value was not compared on this deploy and it is treated as unchanged. This deploy records one, and the key is compared from the next deploy on.`
      );
    } else if (member !== undefined) {
      warn(
        safeMsg`${logicalId}: ${key} reads a parameter the parent stack passed as a secret, and its record holds no value fingerprint for it nor an input fingerprint one could be bound to, so its value cannot be compared and it is treated as unchanged until the property is sent again. No replacement is planned over it.`
      );
    } else if (verdict === 'none') {
      warn(
        safeMsg`${logicalId}: ${key} reads a parameter the parent stack passed as a secret beside an input cdkd keeps as written or cannot resolve here, so its value cannot be proven unchanged and it is treated as unchanged on every deploy. No replacement is planned over it.`
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
