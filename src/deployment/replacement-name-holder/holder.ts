import type { ProvisionedBy } from '../../provisioning/provider-registry.js';
import { generateResourceNameWithFallback } from '../../provisioning/resource-name.js';
import { displayIdent, STACK_REF_MAX_CODE_POINTS } from '../../utils/display-safe.js';
import {
  type Renderer,
  type Voice,
  type ReverseReplacementHolderVerdict,
  valueAt,
  heldAt,
  unproven,
  dnsFold,
  elsewhere,
  zoneIdFold,
  HOLDS,
  holderIdNames,
  ROLLBACK_VOICE,
  renderer,
  SHARED_NAME_SPACES,
  RECORD_SET,
  nameKeyFor,
  reverseReplacementNameKeyKind,
  sentIdentifierIs,
  unreadableAt,
  DERIVED_GENERATED_NAMES,
  isArn,
  DEPLOY_VOICE,
} from './holder-probe.js';
import { CASE_INSENSITIVE_NAME_TYPES, ownEntry, SENT_NAME_REWRITTEN } from './name-keys.js';
import { reverseReplacementTrustsGeneratedName } from './rewritten.js';
import { type ReplacementNameChange } from './deploy-name.js';

/** The Route 53 record-set rule: see {@link reverseReplacementNewHoldsName}. */
function recordSetHolds(
  requested: Record<string, unknown>,
  recorded: Record<string, unknown> | undefined,
  observed: Record<string, unknown> | undefined,
  newPhysicalId: string,
  r: Renderer,
  v: Voice
): ReverseReplacementHolderVerdict {
  const newRecord = `${v.holderRecord} (${r.shown(newPhysicalId)})`;
  const wantName = valueAt(requested, ['Name']);
  const wantType = valueAt(requested, ['Type']);
  const haveName = heldAt(recorded, observed, ['Name']).value;
  const haveType = heldAt(recorded, observed, ['Type']).value;
  if (wantName === undefined || wantType === undefined) {
    return unproven(`cdkd cannot read the Name and Type ${v.createdRecord} asked for`);
  }
  const wanted = `${v.create} asked for Name ${r.quoted(wantName)}`;
  if (haveName === undefined || haveType === undefined) {
    return unproven(`${wanted}, and cdkd cannot read the name ${newRecord} holds`);
  }
  if (dnsFold(wantName) !== dnsFold(haveName)) {
    // A `\ddd` escape spells one name two ways; decoding it is the provider's
    // business, so an escaped pair that differs is undecided, not different.
    return /\\[0-9]{3}/.test(wantName + haveName)
      ? unproven(`${wanted}, and cdkd cannot compare it with the escaped name ${newRecord} holds`)
      : elsewhere(`${wanted}, while ${newRecord} holds Name ${r.quoted(haveName)}`);
  }
  const wantZoneId = valueAt(requested, ['HostedZoneId']);
  const haveZoneId = heldAt(recorded, observed, ['HostedZoneId']).value;
  const wantZoneName = valueAt(requested, ['HostedZoneName']);
  const haveZoneName = heldAt(recorded, observed, ['HostedZoneName']).value;
  const sameZone =
    wantZoneId !== undefined && haveZoneId !== undefined
      ? zoneIdFold(wantZoneId) === zoneIdFold(haveZoneId)
      : wantZoneName !== undefined && haveZoneName !== undefined
        ? dnsFold(wantZoneName) === dnsFold(haveZoneName)
        : undefined;
  if (sameZone === false)
    return elsewhere(`${wanted}, while ${newRecord} is in another hosted zone`);
  if (sameZone === undefined) {
    return unproven(
      `${wanted}, and cdkd cannot tell whether ${newRecord} is in the same hosted zone`
    );
  }
  const wantSet = valueAt(requested, ['SetIdentifier']);
  const haveSet = heldAt(recorded, observed, ['SetIdentifier']).value;
  const wantCname = wantType.toUpperCase() === 'CNAME';
  const haveCname = haveType.toUpperCase() === 'CNAME';
  // A CNAME conflicts with every record of its name that is NOT a CNAME; two
  // CNAMEs of one name coexist under different SetIdentifiers.
  if (wantCname !== haveCname) return HOLDS;
  if (wantType.toUpperCase() !== haveType.toUpperCase()) {
    return elsewhere(
      `${wanted} of Type ${r.quoted(wantType)}, while ${newRecord} is a ${r.quoted(haveType)} ` +
        `record of that name`
    );
  }
  if ((wantSet === undefined) !== (haveSet === undefined)) {
    return unproven(
      `${wanted}, and only one of the two records carries a SetIdentifier, so cdkd cannot ` +
        `tell whether ${newRecord} holds it`
    );
  }
  return wantSet === haveSet
    ? HOLDS
    : elsewhere(`${wanted}, while ${newRecord} is a different record set of that name`);
}

/** The raw value at `path`, whatever it is. */
function pathValue(bag: Record<string, unknown> | undefined, path: readonly string[]): unknown {
  let node: unknown = bag;
  for (const segment of path) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/**
 * The `SENT_NAME_REWRITTEN` rule: see {@link reverseReplacementNewHoldsName}.
 * Called in the re-create's own async scope, so the generator reads the same
 * stack name and prefix flag the provider's create just read. On EITHER route
 * the records' names are never compared: the NEW resource may have been made
 * through the SDK provider (a replacement routes afresh, so an old
 * `cc-api` record can sit beside a new SDK one), whose rewritten name its
 * template-valued record does not show. A Cloud Control re-create sends its
 * bag verbatim, so there the sent name is the requested one.
 */
function rewrittenNameHolds(
  input: {
    requested: Record<string, unknown>;
    physicalId: string;
    logicalId?: unknown;
    oldResourceType: string;
    mask?: ((value: string) => string) | undefined;
  },
  rewrite: { readonly property: string; readonly maxLength: number },
  viaCloudControl: boolean,
  labels: string,
  newResource: string,
  r: Renderer,
  v: Voice
): ReverseReplacementHolderVerdict {
  const declared = valueAt(input.requested, [rewrite.property]);
  const logicalId =
    typeof input.logicalId === 'string' && input.logicalId !== '' ? input.logicalId : undefined;
  if (declared === undefined && (viaCloudControl || logicalId === undefined)) {
    return unproven(
      `${v.create} named no ${labels}, and cdkd cannot derive the name its provider generates, ` +
        `so it cannot show that ${newResource} holds it`
    );
  }
  const sent = viaCloudControl
    ? (declared as string)
    : generateResourceNameWithFallback(declared, logicalId ?? '', {
        maxLength: rewrite.maxLength,
      });
  if (sent === '') {
    return unproven(
      `the name ${v.create} sends for ${labels} is empty, so cdkd cannot show that ` +
        `${newResource} holds it`
    );
  }
  // The provider rewrites the name (prefix, charset, truncation), so a masker
  // matching the declared value may not match what it became: a declared
  // value the mask touches is never followed by its derived spelling.
  const secretDerived =
    declared !== undefined && (input.mask ?? ((value) => value))(declared) !== declared;
  const prop = r.shown(rewrite.property);
  const wanted =
    declared === undefined
      ? `${v.create} named no ${labels}, and its provider generates ${prop} ${r.quoted(sent)} here`
      : viaCloudControl
        ? `${v.create} asked for ${prop} ${r.quoted(declared)}`
        : secretDerived
          ? `${v.create} asked for ${prop} ${r.quoted(declared)}, which its provider rewrites before ` +
            `sending it`
          : `${v.create} asked for ${prop} ${r.quoted(declared)}, which its provider sends as ` +
            `${r.quoted(sent)} here`;
  const fold = CASE_INSENSITIVE_NAME_TYPES.has(input.oldResourceType)
    ? (value: string): string => value.toLowerCase()
    : (value: string): string => value;
  if (input.physicalId !== '' && holderIdNames(fold(input.physicalId), fold(sent))) return HOLDS;
  return unproven(
    // No apostrophe in a diagnosis: it is printed on the rollback refusal's
    // `Collision diagnosis:` line beside JSON-quoted names, and an odd `'`
    // pairs with one inside them when pasted (go-to-k/cdkd#4265).
    `${wanted}, and cdkd cannot show that ${newResource} holds that name (the provider of this ` +
      `type rewrites the names it sends, so a recorded name is no proof)`
  );
}

/**
 * Does the NEW resource of a replacement hold the name the rollback's re-create
 * of the OLD resource collided on? (issue
 * [#3979](https://github.com/go-to-k/cdkd/issues/3979))
 *
 * The reverse-replacement arm deletes the new resource first to free that
 * name. That is right only when the new resource holds it; a collision with
 * anything else — an orphan an earlier failed create left, a replayed create,
 * a resource made outside the stack — would delete a live resource that never
 * held the name, and the re-create would collide again. The collision
 * classifier cannot tell these apart, so this answers from the two records.
 *
 * The inverse polarity of {@link replacementRequestsDifferentName}: that one
 * answers only a KNOWN difference, because its positive answer refuses a
 * delete the user opted into; this one must PROVE the holder, because its
 * negative answer is what keeps an unasked delete from running. Anything it
 * cannot decide is `holds: false`, so nothing here may fold two values that
 * could name two resources (case, an ARN against a bare name).
 *
 * - The name the re-create asked for is read from `requested`, by the OLD
 *   type's name key: the generic rule is {@link explicitNamePropertyFor}'s
 *   property, overridden per type in `REVERSE_REPLACEMENT_NAME_KEYS` for a
 *   nested name or a name placed by a parent (`scope`). With none there, the
 *   `generated` bag's name counts — cdkd's own generation, which some SDK
 *   providers do not mint verbatim (a prefix, or no rule at all), so a
 *   mismatch on a generated name is undecided, never "elsewhere".
 * - The new resource holds it when its recorded (then observed) value of the
 *   same key is the same name, or — for the name alone — when its physical id
 *   names it (the deploy side's rule: equal, a final segment after `|`, or
 *   after `:` / `/` in an ARN or URL; plus the ELBv2 ARN's name segment), the
 *   proof for a generated name, which a recorded bag never holds. Names
 *   compare exactly, except for `CASE_INSENSITIVE_NAME_TYPES`. Every scope
 *   value must be exactly equal (absent on both sides counts as equal, and an
 *   ARN against a bare value is undecided).
 * - `AWS::Route53::RecordSet` compares the zone and the DNS name; then a CNAME
 *   beside a non-CNAME holds, and two records of one kind need the same type
 *   and SetIdentifier.
 * - A type in `SENT_NAME_REWRITTEN`: its SDK provider derives the name it
 *   sends (stack prefix, charset folding, truncation), so the records' names
 *   are never compared, on either route. The sent name is derived here, in the
 *   caller's scope, with the provider's own generator (on a Cloud Control
 *   route it is the requested one), and only the new resource's physical id
 *   naming it proves a holder.
 * - A `Type` change holds only between types that share one name space
 *   (`SHARED_NAME_SPACES`); any other pair is undecided. A type in
 *   `NOT_NAME_KEYED_TYPES`, or one with no name key at all, never holds.
 * - A redacted value or an unresolved dynamic reference is not a name.
 */
export function reverseReplacementNewHoldsName(
  input: ReverseReplacementHolderInput
): ReverseReplacementHolderVerdict {
  return holderVerdict(input, ROLLBACK_VOICE);
}

/** The input of {@link reverseReplacementNewHoldsName}. */
export interface ReverseReplacementHolderInput {
  oldResourceType: string;
  newResourceType: string;
  /** The bag the re-create of the OLD resource was built from. */
  requested: Record<string, unknown>;
  /** `requested` with the name cdkd generates filled in, for a nameless bag. */
  generated?: Record<string, unknown> | undefined;
  /** The NEW resource's recorded properties. */
  recorded: Record<string, unknown> | undefined;
  /** The NEW resource's observed properties. */
  observed: Record<string, unknown> | undefined;
  /** The NEW resource's physical id. */
  physicalId: string;
  /** The op's logical id: a `SENT_NAME_REWRITTEN` provider derives a nameless create's name from it. */
  logicalId?: unknown;
  /**
   * The route the re-create took. Absent reads as an SDK route, the one
   * that REWRITES names — the side that refuses more.
   */
  createdVia?: ProvisionedBy | undefined;
  /** The route the holder was created through (its record's `provisionedBy`). */
  holderVia?: ProvisionedBy | undefined;
  /**
   * Masks a value before it is rendered (the replay bag is plaintext). The
   * caller still masks the whole message; this runs first, on the raw value.
   */
  mask?: ((value: string) => string) | undefined;
}

/**
 * The one rule behind both directions. Named for the rollback's direction:
 * `oldResourceType` / `requested` / `generated` / `createdVia` describe the
 * CREATE that collided, `newResourceType` / `recorded` / `observed` /
 * `physicalId` the HOLDER; `v` says who they are in the diagnosis.
 */
function holderVerdict(
  input: ReverseReplacementHolderInput,
  v: Voice
): ReverseReplacementHolderVerdict {
  const { oldResourceType, newResourceType, requested, recorded, observed, physicalId } = input;
  const r = renderer(input.mask ?? ((value) => value));
  const newResource = `${v.holder} (${r.shown(physicalId)})`;
  if (
    oldResourceType !== newResourceType &&
    !SHARED_NAME_SPACES.some((s) => s.has(oldResourceType) && s.has(newResourceType))
  ) {
    return unproven(
      `${newResource} is of type ${r.shown(newResourceType)}, which cdkd does not know to share ` +
        `a name space with ${r.shown(oldResourceType)}`
    );
  }
  if (oldResourceType === RECORD_SET) {
    return recordSetHolds(requested, recorded, observed, physicalId, r, v);
  }
  const oldKey = nameKeyFor(oldResourceType);
  const newKey = nameKeyFor(newResourceType);
  if (oldKey === undefined || newKey === undefined) {
    if (
      // A Type change never reaches here: the check above refuses every pair
      // outside `SHARED_NAME_SPACES`, whose types all have name keys.
      v.identityFallback &&
      input.createdVia === 'cc-api' &&
      input.holderVia === 'cc-api' &&
      reverseReplacementNameKeyKind(oldResourceType) === 'unknown' &&
      sentIdentifierIs(requested, recorded, observed, physicalId)
    ) {
      return HOLDS;
    }
    // The one shape the identity rule would have proven but for a record
    // that predates cdkd recording its route: still refused, with the reason.
    const legacyRecord =
      v.identityFallback &&
      input.createdVia === 'cc-api' &&
      input.holderVia === undefined &&
      reverseReplacementNameKeyKind(oldResourceType) === 'unknown' &&
      sentIdentifierIs(requested, recorded, observed, physicalId);
    return unproven(
      `cdkd has no name property to compare for a ${r.shown(oldResourceType)}, so it cannot ` +
        `show that ${newResource} holds the colliding name` +
        (legacyRecord
          ? ` (its state record, written by an older cdkd, does not say it was created through ` +
            `Cloud Control, which is what would let its identifier prove it)`
          : '')
    );
  }
  const labels = oldKey.name.map((p) => r.shown(p.join('.'))).join(' / ');
  const unreadable = oldKey.name.find((path) => unreadableAt(requested, path));
  if (unreadable !== undefined) {
    return unproven(
      `the name ${v.create} asked for is ` +
        (pathValue(requested, unreadable) === ''
          ? `empty`
          : `redacted, unresolved or not a string`) +
        `, so cdkd cannot compare it with ${newResource}`
    );
  }
  const rewrite = ownEntry(SENT_NAME_REWRITTEN, oldResourceType);
  if (rewrite !== undefined) {
    return rewrittenNameHolds(
      input,
      rewrite,
      input.createdVia === 'cc-api',
      labels,
      newResource,
      r,
      v
    );
  }
  let generatedName = false;
  let namePath = oldKey.name.find((path) => valueAt(requested, path) !== undefined);
  let wantName = namePath === undefined ? undefined : valueAt(requested, namePath);
  if (
    namePath === undefined &&
    input.generated !== undefined &&
    reverseReplacementTrustsGeneratedName(oldResourceType)
  ) {
    namePath = oldKey.name.find((path) => valueAt(input.generated, path) !== undefined);
    wantName = namePath === undefined ? undefined : valueAt(input.generated, namePath);
    generatedName = wantName !== undefined;
  }
  const derived = ownEntry(DERIVED_GENERATED_NAMES, oldResourceType);
  const derivedName =
    namePath === undefined &&
    v.derivedNames &&
    derived !== undefined &&
    input.createdVia !== 'cc-api' &&
    typeof input.logicalId === 'string' &&
    input.logicalId !== ''
      ? derived.derive(input.logicalId)
      : '';
  if (derivedName !== '') {
    namePath = oldKey.name[0];
    wantName = derivedName;
    generatedName = true;
  }
  if (namePath === undefined || wantName === undefined) {
    return unproven(
      `${v.create} named no ${labels} (its provider picks one), so cdkd cannot show that ` +
        `${newResource} holds it`
    );
  }
  const wanted = generatedName
    ? `${v.create} named no ${labels}, and the cdkd naming rule generates ` +
      `${r.shown(namePath.join('.'))} ${r.quoted(wantName)} for it`
    : `${v.create} asked for ${r.shown(namePath.join('.'))} ${r.quoted(wantName)}`;
  const same = CASE_INSENSITIVE_NAME_TYPES.has(oldResourceType)
    ? (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
    : (a: string, b: string): boolean => a === b;
  const inCase = CASE_INSENSITIVE_NAME_TYPES.has(oldResourceType)
    ? (value: string): string => value.toLowerCase()
    : (value: string): string => value;
  // A record and a read-back that name the holder DIFFERENTLY (renamed out
  // of band, or a drifted record) cannot say which name it holds now: the
  // physical id would still name the recorded one. Undecided, in both
  // directions.
  const drifted = newKey.name.find((path) => {
    const recordedName = valueAt(recorded, path);
    const observedName = valueAt(observed, path);
    return (
      recordedName !== undefined && observedName !== undefined && !same(recordedName, observedName)
    );
  });
  if (drifted !== undefined) {
    return unproven(
      `${wanted}, and the records of ${newResource} disagree on its ` +
        `${r.shown(drifted.join('.'))} (recorded ${r.quoted(valueAt(recorded, drifted) ?? '')}, ` +
        `read back ${r.quoted(valueAt(observed, drifted) ?? '')}), so cdkd cannot show which name ` +
        `it holds`
    );
  }
  const held = newKey.name.map((path) => heldAt(recorded, observed, path));
  const haveName = held.find((h) => h.value !== undefined)?.value;
  const nameHeld =
    (haveName !== undefined && same(haveName, wantName)) ||
    (physicalId !== '' && holderIdNames(inCase(physicalId), inCase(wantName)));
  if (!nameHeld) {
    return haveName !== undefined && !generatedName
      ? elsewhere(`${wanted}, while ${newResource} holds ${r.quoted(haveName)}`)
      : unproven(`${wanted}, and cdkd cannot show that ${newResource} holds that name`);
  }
  for (const [i, path] of (oldKey.scope ?? []).entries()) {
    const label = r.shown(path.join('.'));
    const wantRaw = valueAt(requested, path);
    const have = heldAt(recorded, observed, path);
    if ((wantRaw === undefined && unreadableAt(requested, path)) || have.unreadable) {
      return unproven(`${wanted}, and cdkd cannot read the ${label} that places it`);
    }
    const fallback = oldKey.scopeDefaults?.[i];
    const want = wantRaw ?? fallback;
    const got = have.value ?? fallback;
    if (want === undefined && got === undefined) continue;
    if (want === undefined || got === undefined) {
      return unproven(`${wanted}, and cdkd cannot show that ${newResource} shares its ${label}`);
    }
    if (want === got) continue;
    // One scope spelled as an ARN on one side and a bare name on the other
    // may be the same parent: undecided rather than "elsewhere".
    if (isArn(want) !== isArn(got)) {
      return unproven(
        `${wanted}, and cdkd cannot tell whether ${label} ${r.quoted(got)} is ${r.quoted(want)}`
      );
    }
    return elsewhere(
      `${wanted}, while ${newResource} is under ${label} ${r.quoted(got)}, not ${r.quoted(want)}`
    );
  }
  return HOLDS;
}

/**
 * Does the OLD resource of a replacement hold the name the replacement's
 * create-first attempt collided on? The deploy-direction twin of
 * {@link reverseReplacementNewHoldsName} (issue
 * [#3979](https://github.com/go-to-k/cdkd/issues/3979)), with the same rule,
 * tables and sent-name derivation, the two resources swapped.
 *
 * `cdkd deploy --replace` deletes the old resource first to free that name.
 * {@link replacementRequestsDifferentName} refuses only a KNOWN different
 * explicit name, so a template naming no name — or one a `SENT_NAME_REWRITTEN`
 * provider rewrites under the current stack scope and prefix flag — used to
 * delete the old resource on the classifier's word alone, though an orphan of
 * an earlier attempt, a replayed create or a squatter collides identically.
 * The delete-first runs only on `holds: true`; anything else refuses.
 *
 * Call it in the create's own async scope, like the rollback twin.
 */
export function replacementOldHoldsSentName(input: {
  /** The template's type: what the create routed on. */
  createType: string;
  /** The state record's type: the old resource's. */
  holderType: string;
  /** The bag the create was SENT (the Cloud Control one carries the generated name). */
  requested: Record<string, unknown>;
  /** `requested` with the name cdkd generates filled in, for a nameless bag. */
  generated?: Record<string, unknown> | undefined;
  /** The OLD resource's recorded properties. */
  recorded: Record<string, unknown> | undefined;
  /** The OLD resource's observed properties. */
  observed: Record<string, unknown> | undefined;
  /** The OLD resource's physical id. */
  physicalId: string;
  logicalId?: unknown;
  /** The route the create took. */
  createdVia?: ProvisionedBy | undefined;
  /** The old resource's recorded `provisionedBy`. */
  holderVia?: ProvisionedBy | undefined;
  mask?: ((value: string) => string) | undefined;
}): ReverseReplacementHolderVerdict {
  return holderVerdict(
    {
      oldResourceType: input.createType,
      newResourceType: input.holderType,
      requested: input.requested,
      generated: input.generated,
      recorded: input.recorded,
      observed: input.observed,
      physicalId: input.physicalId,
      logicalId: input.logicalId,
      createdVia: input.createdVia,
      holderVia: input.holderVia,
      mask: input.mask,
    },
    DEPLOY_VOICE
  );
}

/**
 * The shared diagnosis sentence. Each caller appends its own remedy, since what
 * deleting the old resource first means differs per site (`--replace`, or
 * removing `UpdateReplacePolicy: Retain`).
 *
 * The names are template text and `state.json` values, and the remedy names
 * `cdkd deploy --replace`, so none goes inside cdkd's own `"..."` unless it is
 * a plain identifier (go-to-k/cdkd#3950): a `"` in it closed the quote, and
 * `$( )` or a backtick runs inside double quotes regardless. Any other value
 * is described.
 */
export function renderNameHeldElsewhere(change: ReplacementNameChange): string {
  const property = change.property;
  const desiredPlain = isPlainName(change.desiredName);
  const asksFor = desiredPlain
    ? `asks for ${property} "${change.desiredName}"`
    : `asks for a name (${property}) that is not a plain identifier`;
  const heldProperty = change.heldProperty ?? property;
  const held =
    change.heldName === undefined
      ? `does not hold that name`
      : isPlainName(change.heldName)
        ? `holds ${heldProperty} "${change.heldName}"`
        : `holds a name (${heldProperty}) that is not a plain identifier`;
  const replaced =
    change.physicalId === ''
      ? 'the resource being replaced, which has no recorded id,'
      : isPlainName(change.physicalId)
        ? `the resource being replaced (${change.physicalId})`
        : 'the resource being replaced, whose recorded id is not a plain identifier,';
  // The desired name's second mention: `"name"` when plain, else `the
  // requested name`, which cannot bind to a described held name nearer to it.
  return (
    `The replacement ${asksFor}, but ${replaced} ${held} — so ` +
    `${desiredPlain ? `"${change.desiredName}"` : 'the requested name'} is held by ANOTHER existing ` +
    `resource, not by the one being replaced, and deleting the old resource first cannot free it`
  );
}

/**
 * True when `value` has no whitespace and `displayIdent` renders it unchanged:
 * only characters that are literal inside double quotes. The whitespace test
 * comes FIRST because the round-trip alone admits a value that ends in
 * `displayIdent`'s own cut marker (`<1152 plain characters> [cut: N more
 * characters withheld]` renders as itself). The cap is the stack-ref one, so a
 * long ARN physical id is not cut.
 */
export function isPlainName(value: string): boolean {
  return (
    !/\s/.test(value) && displayIdent(value, { maxCodePoints: STACK_REF_MAX_CODE_POINTS }) === value
  );
}
