/**
 * Does a replacement ask for a physical name the resource being replaced does
 * NOT hold? (issue [#3808](https://github.com/go-to-k/cdkd/issues/3808))
 *
 * The replacement name-collision refusals presume the colliding name is held by
 * the old resource, and prescribe deleting that resource first (`--replace`, or
 * dropping `UpdateReplacePolicy: Retain`). That holds only when the replacement
 * keeps the name. When it CHANGES it — the template's explicit name property now
 * says something the old resource was never called — the holder is some other
 * resource, deleting the old one frees nothing, and the advice ends with the
 * managed resource gone and the same collision.
 *
 * Answers only when the difference is KNOWN; `undefined` otherwise, which keeps
 * the callers' pre-existing wording and behaviour. The asymmetry is deliberate:
 * a positive answer REFUSES the delete-first retry, so it must not fire on a
 * replacement that keeps its name.
 *
 * - The desired name is the TEMPLATE's explicit name property
 *   ({@link explicitNamePropertyFor}). With none, the answer is `undefined`:
 *   a generated name is not compared, so a replacement that DROPS an explicit
 *   name keeps the pre-existing behaviour (go-to-k/cdkd#3931 carries it).
 * - The held name is the state record's recorded, then observed, value of the
 *   OLD type's name property. A recorded value is the TEMPLATE's, which a
 *   provider may normalise before AWS sees it (IAM's `_` to `-`), so a physical
 *   id that names the desired name overrides a differing recorded one.
 * - With no held name, the physical id alone decides, and only when it does
 *   NOT name the desired name: equal, or a final segment after `|`, or after
 *   `:` / `/` in an ARN or a URL (a name-shaped id may contain `/`), or, in a Secrets Manager ARN, that segment plus its
 *   6-character suffix. Anything else — an opaque id like `sg-…` included — counts as
 *   different, which refuses without deleting.
 * - Names compare case-insensitively: several services (IAM among them) treat
 *   two spellings differing only in case as one name. The cost, on a
 *   case-sensitive service, is keeping `--replace` for a case-only rename.
 * - A redacted value ({@link SECRET_MASK}) or an unresolved dynamic reference
 *   (`{{resolve:…}}`, which state keeps as written) is not a name: skipped.
 */

import { explicitNamePropertyFor } from '../provisioning/resource-name.js';
import { displaySafe } from '../utils/display-safe.js';
import { SECRET_MASK } from './secret-redaction.js';

export interface ReplacementNameChange {
  /** The template's name property, e.g. `FunctionName`. */
  property: string;
  /** The name the replacement asks for. */
  desiredName: string;
  /** The name the old resource holds, when state records it. */
  heldName: string | undefined;
  /** The OLD type's name property `heldName` was read from. */
  heldProperty: string | undefined;
  /** The old resource's physical id. */
  physicalId: string;
}

function nameValue(bag: Record<string, unknown> | undefined, property: string): string | undefined {
  const value = bag?.[property];
  if (typeof value !== 'string' || value === '' || value === SECRET_MASK) return undefined;
  if (value.includes('{{resolve:')) return undefined;
  return value;
}

/** Does `physicalId` name `desired` (both lower-cased)? See the module doc. */
function physicalIdNames(physicalId: string, desired: string): boolean {
  if (physicalId === desired) return true;
  // `:` and `/` separate segments only inside an ARN or a URL: a physical id
  // that IS the name may itself contain `/` (`/app/db`, `/aws/lambda/fn`).
  const separators = /^(arn:|https?:\/\/)/.test(physicalId) ? /[:/|]/ : /\|/;
  const cut = physicalId.length - desired.length - 1;
  if (cut >= 0 && physicalId.endsWith(desired) && separators.test(physicalId.charAt(cut))) {
    return true;
  }
  // Secrets Manager's ARN appends `-` and 6 random characters to the name.
  if (!physicalId.includes(':secret:')) return false;
  const last = physicalId.split(':').pop() ?? '';
  return last.length === desired.length + 7 && last.startsWith(`${desired}-`);
}

export function replacementRequestsDifferentName(input: {
  oldResourceType: string;
  newResourceType: string;
  desiredProperties: Record<string, unknown> | undefined;
  recorded: Record<string, unknown> | undefined;
  observed: Record<string, unknown> | undefined;
  physicalId: string;
}): ReplacementNameChange | undefined {
  const property = explicitNamePropertyFor(input.newResourceType);
  if (property === undefined) return undefined;
  const desiredName = nameValue(input.desiredProperties, property);
  if (desiredName === undefined) return undefined;
  const desired = desiredName.toLowerCase();

  const oldProperty = explicitNamePropertyFor(input.oldResourceType);
  const heldName =
    oldProperty === undefined
      ? undefined
      : (nameValue(input.recorded, oldProperty) ?? nameValue(input.observed, oldProperty));

  const physicalId = input.physicalId.toLowerCase();
  if (heldName !== undefined && heldName.toLowerCase() === desired) return undefined;
  if (heldName === undefined && physicalId === '') return undefined;
  if (physicalId !== '' && physicalIdNames(physicalId, desired)) return undefined;
  return {
    property,
    desiredName,
    heldName,
    heldProperty: heldName === undefined ? undefined : oldProperty,
    physicalId: input.physicalId,
  };
}

/**
 * The shared diagnosis sentence. Each caller appends its own remedy, since what
 * deleting the old resource first means differs per site (`--replace`, or
 * removing `UpdateReplacePolicy: Retain`).
 */
export function renderNameHeldElsewhere(change: ReplacementNameChange): string {
  const desired = displaySafe(change.desiredName);
  const held =
    change.heldName !== undefined
      ? `holds ${change.heldProperty ?? change.property} "${displaySafe(change.heldName)}"`
      : `does not hold that name`;
  return (
    `The replacement asks for ${change.property} "${desired}", but the resource being ` +
    `replaced (${displaySafe(change.physicalId)}) ${held} — so "${desired}" is held by ` +
    `ANOTHER existing resource, not by the one being replaced, and deleting the old ` +
    `resource first cannot free it`
  );
}
