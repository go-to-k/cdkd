import { recordedProtectionNote } from '../../../provisioning/recorded-protection.js';
import { safeMsg } from '../../../utils/display-safe.js';

/**
 * The text of the issue #2790 refusal. Exported for its unit test.
 *
 * It states only what holds in every case it fires on: the record holds the
 * key, the SDK provider never writes it, and this deploy routes the resource
 * through Cloud Control. It does NOT claim this deploy's flags omit the key,
 * since a sibling drop the flags do not cover routes the resource just the
 * same.
 *
 * `routeDriving` is every key that sends the resource to Cloud Control on this
 * deploy. Keeping the resource on its SDK provider needs ALL of them, and the
 * unwritten ones, allow-listed, since the route is per resource, so the
 * keep-dropping remedy names the union. `nested` drops `--recreate-via-cc-api`,
 * which cannot address a resource inside a nested stack's child.
 * `protectionEvidence` is `recordedProtectionEvidence`'s answer for the record.
 *
 * `nowWritten` is the subset of `unwritten` this type's SDK provider has
 * started writing since the record was made (issue #5572). No flag can keep
 * such a key dropped, so when it is non-empty the message says the provider
 * now writes it, names the route only when something still drives it to
 * Cloud Control, and offers removing the key from the template as the
 * keep-as-is remedy, beside `--prefer-sdk-route` for the remaining drops.
 *
 * @internal
 */
export function unwrittenCreateOnlyRefusal(input: {
  logicalId: string;
  resourceType: string;
  unwritten: readonly string[];
  routeDriving: readonly string[];
  nested: boolean;
  protectionEvidence?: string | undefined;
  nowWritten?: readonly string[] | undefined;
  /** The record's whole `acceptedCreateOnlyDrops`, which `cdkd import` clears. */
  evidence?: readonly string[] | undefined;
}): string {
  const { logicalId, resourceType, unwritten, routeDriving, nested, protectionEvidence } = input;
  const nowWritten = (input.nowWritten ?? []).filter((property) => unwritten.includes(property));
  if (nowWritten.length > 0) {
    return nowWrittenCreateOnlyRefusal({ ...input, nowWritten });
  }
  const one = unwritten.length === 1;
  const list = unwritten.join(', ');
  const keep = [...new Set([...unwritten, ...routeDriving])]
    .sort((a, b) => a.localeCompare(b))
    .map((property) => `${resourceType}:${property}`)
    .join(',');
  const replaceFlags = unwrittenReplaceFlags(logicalId, nested);
  const routed = [...routeDriving].sort((a, b) => a.localeCompare(b)).join(', ');
  // Every id, type and property name is flattened to one line where it
  // enters the message, `replaceFlags` and the protection note whole
  // (go-to-k/cdkd#2676); the message has no line break of its own.
  return (
    safeMsg`${logicalId} (${resourceType}): ${list} ${one ? 'is' : 'are'} create-only, and the ` +
    `state record holds ${one ? 'it' : 'them'} although this type's SDK provider never ` +
    `writes ${one ? 'it' : 'them'}, so AWS does not. This deploy routes the resource through ` +
    safeMsg`Cloud Control (--prefer-sdk-route does not cover ${routed}), and applying a create-only ` +
    `property means replacing the resource, which cdkd does not do on its own. This ` +
    safeMsg`resource was not changed. To replace it and apply ${list}, re-run with ${replaceFlags}; a ` +
    `stateful resource also needs --force-stateful-recreation.` +
    (protectionEvidence !== undefined
      ? safeMsg` ${recordedProtectionNote(protectionEvidence, nested ? '--replace' : `--recreate-via-cc-api ${logicalId} or --replace`)}`
      : '') +
    safeMsg` To keep dropping ${one ? 'it' : 'them'}, re-run with --prefer-sdk-route ${keep}.`
  );
}

/**
 * The opt-in flags both #2790 refusal texts name.
 *
 * `--recreate-via-cc-api` deletes the old resource first; `--replace` takes
 * the property-driven path, which creates the new one first. A NAME collision
 * there is retried delete-first under `--replace`, but any other unique value
 * the old one still holds (a subnet's CIDR block) collides. Inside a nested
 * child only `--replace` reaches the resource.
 */
function unwrittenReplaceFlags(logicalId: string, nested: boolean): string {
  return nested
    ? '--replace (which creates the new resource before deleting the old one, so a ' +
        'resource holding a unique value other than its name, such as a CIDR block, collides)'
    : `--recreate-via-cc-api ${logicalId}, which deletes the old resource first ` +
        '(--replace also works, but creates the new one first, so a resource holding a ' +
        'unique value other than its name, such as a CIDR block, collides)';
}

/**
 * {@link unwrittenCreateOnlyRefusal}'s text when some unwritten key is one
 * the SDK provider now writes (issue #5572). It claims only what holds then:
 * an earlier cdkd's SDK provider did not write the keys, AWS does not hold
 * them, and this cdkd would send `nowWritten` but cannot without a
 * replacement. The route clause appears only when a still-dropped key or a
 * sibling drives the resource to Cloud Control. Outside a nested child it
 * also names the non-destructive way out when AWS does hold the value: a
 * selective `cdkd import --force` re-records the resource without evidence.
 */
function nowWrittenCreateOnlyRefusal(input: {
  logicalId: string;
  resourceType: string;
  unwritten: readonly string[];
  routeDriving: readonly string[];
  nested: boolean;
  protectionEvidence?: string | undefined;
  nowWritten: readonly string[];
  evidence?: readonly string[] | undefined;
}): string {
  const { logicalId, resourceType, unwritten, routeDriving, nested, protectionEvidence } = input;
  const nowWritten = input.nowWritten;
  const one = unwritten.length === 1;
  const list = unwritten.join(', ');
  const written = nowWritten.join(', ');
  const writtenOne = nowWritten.length === 1;
  const stillDropped = unwritten.filter((property) => !nowWritten.includes(property));
  const keep = [...new Set([...stillDropped, ...routeDriving])]
    .filter((property) => !nowWritten.includes(property))
    .sort((a, b) => a.localeCompare(b))
    .map((property) => `${resourceType}:${property}`)
    .join(',');
  const routed = [...routeDriving].sort((a, b) => a.localeCompare(b)).join(', ');
  const replaceFlags = unwrittenReplaceFlags(logicalId, nested);
  return (
    safeMsg`${logicalId} (${resourceType}): ${list} ${one ? 'is' : 'are'} create-only, and the ` +
    `state record holds ${one ? 'it' : 'them'} although the SDK provider that built the ` +
    `resource did not write ${one ? 'it' : 'them'} (an earlier deploy accepted dropping ` +
    `${one ? 'it' : 'them'} with --prefer-sdk-route), so AWS does not. ` +
    safeMsg`This cdkd version's SDK provider writes ${written}, so no flag keeps ` +
    `${writtenOne ? 'it' : 'them'} dropped any more` +
    (routed.length > 0
      ? safeMsg`, and this deploy routes the resource through Cloud Control (--prefer-sdk-route does not cover ${routed})`
      : '') +
    `; applying a create-only property means replacing the resource, which cdkd does not ` +
    `do on its own. This ` +
    safeMsg`resource was not changed. To replace it and apply ${list}, re-run with ${replaceFlags}; a ` +
    `stateful resource also needs --force-stateful-recreation.` +
    (protectionEvidence !== undefined
      ? safeMsg` ${recordedProtectionNote(protectionEvidence, nested ? '--replace' : `--recreate-via-cc-api ${logicalId} or --replace`)}`
      : '') +
    safeMsg` To keep the resource as it is, remove ${written} from the template` +
    (keep.length > 0 ? safeMsg` and re-run with --prefer-sdk-route ${keep}.` : '.') +
    // The record's evidence is what refuses; it can be wrong when AWS got the
    // value another way (a default, an out-of-band change). A selective
    // `cdkd import` rewrites the record with none, and no AWS write. Not
    // offered inside a nested child, which `cdkd import` does not address.
    // Only when every evidence name is one the provider now writes: the
    // import drops ALL of the record's evidence, so it would also erase that
    // of a still-dropped key AWS really lacks, refused here or accepted by
    // this deploy's flag.
    (nested ||
    stillDropped.length > 0 ||
    (input.evidence ?? []).some((property) => !nowWritten.includes(property))
      ? ''
      : safeMsg` If AWS already holds ${written} (cdkd drift compares it), re-record the ` +
        safeMsg`resource instead: cdkd import with --resource '${logicalId}=PHYSICAL_ID' (its physical ` +
        `id, quoted) and --force writes a record without this evidence and changes nothing in AWS.`)
  );
}
