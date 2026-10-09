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
import {
  ATOMIC_FINAL_SNAPSHOT_TYPES,
  finalSnapshotNameCut,
  PRE_DELETE_SNAPSHOT_TYPES,
} from '../provisioning/final-snapshot.js';
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
 * which does not hold the resource's plaintext. Last, the spellings a
 * final-snapshot name of the id needs ({@link finalSnapshotSpellingsOf}).
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
  if (physicalId !== undefined) {
    for (const spelling of finalSnapshotSpellingsOf(physicalId, record?.resourceType, needles)) {
      add(spelling);
    }
  }
  return needles.size > 0 ? needles : undefined;
}

/**
 * The needles a final-snapshot name of this resource needs beyond `needles`
 * (go-to-k/cdkd#3869), for a type that takes one (the atomic and pre-delete
 * sets). The name is `<base>-final-<timestamp>`, where the base
 * is the physical id LOWERCASED and, for ElastiCache, cut to 28 characters
 * (`finalSnapshotNameCut`). Two spellings of a needle can miss it:
 *
 *  - one the cut SPLITS: the name carries only a fragment, which no literal
 *    masker matches. The `<base>-final-` prefix stands in for it;
 *  - one the base FOLDS (mixed case, or a character outside its charset)
 *    wholly inside the kept part: its folded spelling stands in for it.
 *
 * Both reach the printed snapshot id and AWS's `SnapshotAlreadyExistsFault`
 * text quoting it. The `{{resolve:` arm's id spellings already carry the
 * prefix; the plaintext arms (a resolved name, a `NoEcho` value, an embedded
 * needle) did not. A needle wholly past the cut is not in the name, so it adds
 * nothing.
 */
function finalSnapshotSpellingsOf(
  physicalId: string,
  resourceType: unknown,
  needles: ReadonlySet<string>
): string[] {
  // Only a type that takes a final snapshot ever prints such a name.
  if (
    typeof resourceType !== 'string' ||
    !(ATOMIC_FINAL_SNAPSHOT_TYPES.has(resourceType) || PRE_DELETE_SNAPSHOT_TYPES.has(resourceType))
  ) {
    return [];
  }
  const { prefix, sanitized, kept } = finalSnapshotNameCut(physicalId, resourceType);
  const spellings: string[] = [];
  for (const needle of needles) {
    // Folded as the base is: lowercased, and every character outside the
    // snapshot charset mapped to `-` with runs collapsed (`sanitizeSnapshotBase`,
    // minus its edge trim and `r` prefix, which only the whole id takes).
    const folded = needle
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-{2,}/g, '-');
    // A shorter spelling masks only a whole string, which a snapshot name
    // never is; judged on the FOLDED one, the spelling the name carries.
    if (folded.length < MIN_NEEDLE_LENGTH) continue;
    for (let at = sanitized.indexOf(folded); at !== -1; at = sanitized.indexOf(folded, at + 1)) {
      if (at >= kept) break;
      if (at + folded.length > kept) spellings.push(prefix);
      else if (folded !== needle) spellings.push(folded);
    }
  }
  return spellings;
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
 * The records a completed op's revert names (go-to-k/cdkd#3869), as entries a
 * printing-bag judge reads: the op's own (the resource it made or wrote, its
 * properties) and the one it replaced (`previousState`, which an UPDATE or
 * DELETE revert writes back and whose id it prints).
 */
export function completedReplayEntries(
  ops: readonly {
    logicalId: string;
    resourceType: string;
    physicalId?: string | undefined;
    properties?: Record<string, unknown> | undefined;
    previousState?: ResourceState | undefined;
  }[]
): Array<{
  logicalId: string;
  resourceType: string;
  physicalId?: string | undefined;
  properties?: Record<string, unknown> | undefined;
  attemptedProperties?: Record<string, unknown> | undefined;
}> {
  return ops.flatMap((op) => [
    {
      logicalId: op.logicalId,
      resourceType: op.resourceType,
      physicalId: op.physicalId,
      properties: op.properties,
      attemptedProperties: op.properties,
    },
    ...(op.previousState === undefined
      ? []
      : [
          {
            logicalId: op.logicalId,
            resourceType: op.previousState.resourceType,
            physicalId: op.previousState.physicalId,
            properties: op.previousState.properties,
            attemptedProperties: op.previousState.properties,
          },
        ]),
  ]);
}

/**
 * The log-only bag over a stack's orphan records (`state.orphans`, what an
 * earlier rollback kept in AWS; go-to-k/cdkd#3869): each record's own name
 * spellings, judged from the record, which still spells a secret-derived name
 * as its `{{resolve:` reference. One bag for every record: a line names one
 * record, and a sibling's needle only over-masks. Malformed entries are
 * skipped (their own refusal reports them). For the adoption pre-pass's lines
 * and refusal, on `cdkd deploy` and `cdkd diff` alike.
 */
export function orphanRecordsPrintingBag(records: readonly unknown[]): RecordedSecretValues {
  const bag: RecordedSecretValues = new Map();
  for (const entry of records) {
    if (entry === null || typeof entry !== 'object') continue;
    const { logicalId, state } = entry as { logicalId?: unknown; state?: unknown };
    if (typeof logicalId !== 'string' || state === null || typeof state !== 'object') continue;
    for (const needle of secretNameNeedlesOf(logicalId, state, undefined) ?? []) {
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
 * A message marked `ownLines` (a replay refusal from the completed-op arms,
 * masked at construction by the op masker, which holds no name the entry READ
 * from a sibling) is masked LINE BY LINE, except its labelled `To orphan it:`
 * command line: that line carries only the vetted logical id and the run's own
 * stack, region and option values, none derived from a secret, and a short
 * needle would cut the pasteable command. The completed-op replay now runs
 * under a bound bag, so these events reach this masker with needles in it.
 * The terminal line of the same refusal is masked WHOLE by the logger's sink,
 * its command line too: an over-mask a needle equal to a stack name, region or
 * vetted logical id can cause there, accepted rather than special-cased in the
 * sink.
 */
/** The label of `orphanRemedy`'s pasteable command line. */
export const ORPHAN_COMMAND_LABEL = 'To orphan it: ';

export function maskEventTextWithBoundBags<
  T extends { error?: { message?: string; ownLines?: boolean }; reason?: string },
>(event: T): T {
  if (event.reason === undefined && event.error === undefined) return event;
  const mask = currentLogLineMasker();
  if (mask === undefined) return event;
  const masked: T = { ...event };
  if (masked.error?.message) {
    const message =
      masked.error.ownLines === true
        ? masked.error.message
            .split('\n')
            .map((line) => (line.startsWith(ORPHAN_COMMAND_LABEL) ? line : mask(line)))
            .join('\n')
        : mask(masked.error.message);
    masked.error = { ...masked.error, message };
  }
  if (masked.reason) masked.reason = mask(masked.reason);
  return masked;
}
