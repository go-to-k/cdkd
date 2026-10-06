/**
 * The derived-name judge (go-to-k/cdkd#3869): is a resource NAMED from a
 * secret, and which spellings does its id print as. ONE implementation for
 * every reader that resolves against a resource record: the deploy engine's
 * registry (`deploy-engine/masking.ts`), and the commands that resolve against
 * STATE (`cdkd diff`, `import`, `scrub`, `export`) or delete from it
 * (`cdkd destroy`).
 *
 * Every needle it yields is LOG-ONLY: it masks what PRINTS, never what is
 * persisted, diffed or sent, since a physical id is the record's identity.
 */
import type { ResourceState } from '../types/state.js';
import { isSecretDerivedValue } from '../provisioning/masked-retry-logger.js';
import { secretDerivedNamePairs } from './rollback-executor/names.js';
import { currentLogLineMasker } from '../utils/log-line-masker.js';
import {
  type RecordedSecretValues,
  hasMaskableValues,
  maskSecretsInText,
  MIN_NEEDLE_LENGTH,
  printingCorpusOf,
  recordLogOnlyValue,
  SECRET_MASK,
  wholeStringLeavesOf,
} from './secret-redaction.js';

/**
 * The needles of a resource NAMED from a secret (go-to-k/cdkd#3869), or
 * `undefined` when nothing says it is.
 *
 * A physical name a provider DERIVES from a secret (`generateResourceNameWithFallback`
 * prefixes, folds and truncates it), or one minted from a value since rotated,
 * no longer occurs as any recorded plaintext, so no masker recognises it. The
 * name keys and spellings are the rollback's (`secretDerivedNamePairs`,
 * go-to-k/cdkd#4037), judged with `secrets` (the resource's own bag) by
 * `isSecretDerivedValue`, so a deploy and its rollback withhold the same
 * names. Per name value:
 *
 *  - one this deploy RESOLVED (in memory): the value, its lower-cased
 *    spelling (a service that folds case) and the names a rewriting provider
 *    derives from it. Those are what the id spells, so the rest of the id
 *    (an ARN's account, a hash) stays readable;
 *  - one still spelling a `{{resolve:` reference or the mask (a record read
 *    from state, where a secret leaf persists as its reference and a public
 *    ssm value is stored resolved): its plaintext is not in hand, so the id's
 *    own spellings stand in, the whole id and its name segments.
 *
 * Two more arms: an IAM `Path` (the ARN carries it, and the rollback's keys
 * omit it) adds the whole id, and a needle of `secrets` the id embeds as it
 * is (a queue URL ending in the resolved name) is added for a READER's bag,
 * which does not hold the resource's plaintext.
 *
 * LOG-ONLY wherever they are recorded: they mask what PRINTS and never what
 * is persisted, diffed or sent, since a physical id is the record's identity.
 */
export function secretNameNeedlesOf(
  logicalId: string,
  record: { resourceType?: unknown; physicalId?: unknown; properties?: unknown } | undefined,
  secrets: RecordedSecretValues | undefined,
  /**
   * `embedded`: the bag the EMBEDDED arm reads, when it must be narrower than
   * the one a name is judged with: a stack-wide `NoEcho` value embedded by
   * chance in an id (`prod`) is no evidence the id came from it. The KEY's
   * presence decides (an explicit `undefined` reads no bag); absent means
   * `secrets`.
   */
  options?: { readonly embedded: RecordedSecretValues | undefined }
): Set<string> | undefined {
  // No id yet (a CREATE judged right after it resolved): the NAME spellings
  // only, which the provider is about to print as it creates.
  const physicalId =
    typeof record?.physicalId === 'string' && record.physicalId !== ''
      ? record.physicalId
      : undefined;
  const bag = secrets !== undefined && hasMaskableValues(secrets) ? secrets : undefined;
  const mask = (text: string): string => (bag === undefined ? text : maskSecretsInText(text, bag));
  const unresolved = (value: string): boolean =>
    value.includes('{{resolve:') || value === SECRET_MASK;
  const named = {
    resourceType: record?.resourceType,
    properties: record?.properties,
    logicalId,
  };
  const needles = new Set<string>();
  const add = (needle: unknown): void => {
    if (typeof needle === 'string' && needle !== '') needles.add(needle);
  };
  // The names a rewriting provider derives from a resolved value: the pairs
  // with no id to spell carry only those.
  for (const [raw, derived] of secretDerivedNamePairs({ ...named, physicalIds: [] })) {
    if (typeof raw === 'string' && !unresolved(raw) && isSecretDerivedValue(raw, mask))
      add(derived);
  }
  for (const [raw, spelling] of secretDerivedNamePairs({
    ...named,
    // A stand-in id so an id-less record still yields a pair per name key;
    // only the RAW name is read off those pairs, never a spelling of it.
    physicalIds: [physicalId ?? 'cdkd-no-physical-id-yet'],
  })) {
    if (!isSecretDerivedValue(raw, mask)) continue;
    if (unresolved(raw)) {
      if (physicalId === undefined) continue;
      add(spelling);
    } else {
      add(raw);
      if (raw.toLowerCase() !== raw && raw.length >= MIN_NEEDLE_LENGTH) add(raw.toLowerCase());
    }
  }
  const properties = record?.properties;
  const path =
    properties !== null && typeof properties === 'object' && Object.hasOwn(properties, 'Path')
      ? (properties as Record<string, unknown>)['Path']
      : undefined;
  if (physicalId !== undefined && isSecretDerivedValue(path, mask)) add(physicalId);
  const embedded = options === undefined ? secrets : options.embedded;
  const embeddedBag = embedded !== undefined && hasMaskableValues(embedded) ? embedded : undefined;
  if (embeddedBag !== undefined && physicalId !== undefined) {
    for (const needle of printingCorpusOf(embeddedBag).keys()) {
      if (
        needle !== '' &&
        (needle === physicalId ||
          (needle.length >= MIN_NEEDLE_LENGTH && physicalId.includes(needle)))
      ) {
        add(needle);
      }
    }
  }
  return needles.size > 0 ? needles : undefined;
}

/** The bags a resource's name is judged with (see {@link secretNameNeedlesOf}). */
export interface SecretNameJudgingBags {
  readonly secrets: RecordedSecretValues | undefined;
  readonly embedded: RecordedSecretValues | undefined;
}

/**
 * The needles of every OTHER resource named from a secret that `record`
 * embeds in a property leaf: what a reader that resolves nothing (a DELETE)
 * once read from it, an instance profile's `Roles`, an access key's
 * `UserName`. A reader that resolves records the same needles as it reads.
 */
export function secretNamesReadBy(
  logicalId: string,
  record: { properties?: unknown } | undefined,
  resources: Readonly<Record<string, ResourceState>>,
  judge: (logicalId: string) => SecretNameJudgingBags = () => ({
    secrets: undefined,
    embedded: undefined,
  })
): Set<string> {
  const read = new Set<string>();
  const leaves = [...wholeStringLeavesOf(record?.properties)].filter((leaf) => leaf !== '');
  if (leaves.length === 0) return read;
  for (const [otherId, other] of Object.entries(resources)) {
    if (otherId === logicalId) continue;
    const bags = judge(otherId);
    const needles = secretNameNeedlesOf(otherId, other, bags.secrets, {
      embedded: bags.embedded,
    });
    if (needles === undefined) continue;
    for (const needle of needles) {
      if (
        leaves.some(
          (leaf) => leaf === needle || (needle.length >= MIN_NEEDLE_LENGTH && leaf.includes(needle))
        )
      ) {
        read.add(needle);
      }
    }
  }
  return read;
}

/**
 * The `ResolverContext.secretNameNeedles` callback for a command resolving
 * against STATE records (`cdkd diff`, `import`, `scrub`, `export`). A record
 * read from state spells a secret name as its `{{resolve:` reference (or the
 * mask), which is the evidence it judges; `secrets` adds a bag the command
 * holds for the whole stack (`cdkd diff`'s `NoEcho` values). Resolved per
 * call, so a record the command rewrites mid-pass is judged as it stands.
 */
export function stateSecretNameNeedles(
  resources: Readonly<Record<string, ResourceState>>,
  secrets?: RecordedSecretValues
): (logicalId: string) => ReadonlySet<string> | undefined {
  return (logicalId) =>
    secretNameNeedlesOf(
      logicalId,
      Object.hasOwn(resources, logicalId) ? resources[logicalId] : undefined,
      secrets,
      { embedded: undefined }
    );
}

/**
 * The PRINTING bag one resource's operation runs under when a command
 * provisions from STATE (go-to-k/cdkd#3869): `cdkd destroy`'s delete and
 * `cdkd drift --revert`'s update. An empty map whose LOG-ONLY needles are the
 * resource's own name spellings and those of each secret-named sibling its
 * record holds. Bound by `withPrintingSecrets` around the call, so the
 * provider's lines, a reader's warnings and the final-snapshot lines mask
 * them. Judged from the state records alone.
 */
export function secretNamePrintingBag(
  logicalId: string,
  resources: Readonly<Record<string, ResourceState>>
): RecordedSecretValues {
  const bag: RecordedSecretValues = new Map();
  const record = Object.hasOwn(resources, logicalId) ? resources[logicalId] : undefined;
  for (const needle of secretNameNeedlesOf(logicalId, record, undefined) ?? []) {
    recordLogOnlyValue(bag, needle);
  }
  for (const needle of secretNamesReadBy(logicalId, record, resources)) {
    recordLogOnlyValue(bag, needle);
  }
  return bag;
}

/**
 * The PRINTING bag a batch of journaled failed-CREATE orphans is deleted under
 * (`deleteJournaledOrphans`, go-to-k/cdkd#3869): no state record holds such a
 * resource, so each is judged from its OWN journal entry, its type, recovered
 * physical id and the properties it attempted (a secret leaf journaled as its
 * `{{resolve:` reference or the mask). Also the names each entry read from a
 * state record, and the state record under the same logical id (the resource
 * a replacement orphan's replacement was replacing). ONE bag per batch, so a
 * name an entry read from a sibling entry is that sibling's own needle, and a
 * sibling's name masked on another's line only over-masks.
 */
export function journaledOrphanPrintingBag(
  ops: readonly {
    logicalId: string;
    resourceType: string;
    physicalId?: string | undefined;
    attemptedProperties?: Record<string, unknown> | undefined;
  }[],
  stateResources: Readonly<Record<string, ResourceState>>
): RecordedSecretValues {
  const bag: RecordedSecretValues = new Map();
  for (const op of ops) {
    const record = {
      resourceType: op.resourceType,
      physicalId: op.physicalId,
      properties: op.attemptedProperties,
    };
    const replaced = Object.hasOwn(stateResources, op.logicalId)
      ? stateResources[op.logicalId]
      : undefined;
    for (const needle of [
      ...(secretNameNeedlesOf(op.logicalId, record, undefined) ?? []),
      ...(secretNameNeedlesOf(op.logicalId, replaced, undefined) ?? []),
      ...secretNamesReadBy(op.logicalId, record, stateResources),
    ]) {
      recordLogOnlyValue(bag, needle);
    }
  }
  return bag;
}

/**
 * An event with its human-authored text (`error.message`, `reason`) masked by
 * the printing bags bound where it is recorded (go-to-k/cdkd#3869): the events
 * store is DURABLE, so a name the log lines beside it withhold must not land
 * there one statement later. The `physicalId` FIELD stays exact: it is the
 * identity a cleanup needs, and `state.json` records it too. Identity when
 * nothing is bound.
 *
 * The `ownLines` exemption is DEFENSIVE: no path this masker serves can carry
 * such a message today. Own-remedy refusals come only from the completed-op
 * arms, and the failed-op replay and the destroy runner raise none. It keeps
 * a replay refusal's pasteable commands, masked at construction, from being
 * cut by a short needle. Wiring one through here must re-evaluate it: the op
 * masker that built the message does not hold a name the entry READ from a
 * sibling, which this exemption would then let through.
 */
export function maskEventTextWithBoundBags<
  T extends { error?: { message?: string; ownLines?: boolean }; reason?: string },
>(event: T): T {
  if (event.reason === undefined && event.error === undefined) return event;
  const mask = currentLogLineMasker();
  if (mask === undefined) return event;
  const masked: T = { ...event };
  if (masked.error?.message && masked.error.ownLines !== true) {
    masked.error = { ...masked.error, message: mask(masked.error.message) };
  }
  if (masked.reason) masked.reason = mask(masked.reason);
  return masked;
}
