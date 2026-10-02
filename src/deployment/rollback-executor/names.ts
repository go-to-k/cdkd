import type { ResourceState } from '../../types/state.js';
import type { Logger } from '../../types/config.js';
import {
  replayPrefixChoice,
  reverseReplacementRewrittenNameTypes,
  rewrittenNameSpellings,
} from '../replacement-name-holder.js';
import { explicitNamePropertyFor, withSkipPrefix } from '../../provisioning/resource-name.js';
// Issues #2038 / #4037: every `withRetry` site's `RetryLogger`, and the
// derived-name masks, run over one op's masker (`createOpMasker`) — the
// providers' shared module, not a second copy of that security contract.
import {
  createMaskedLogSinks,
  withDerivedNameMasks,
  type MaskerFn,
} from '../../provisioning/masked-retry-logger.js';
import {
  buildFinalSnapshotIdentifier,
  finalSnapshotNamePrefix,
  ccRoutedFinalSnapshotError,
  createPreDeleteFinalSnapshot,
  finalSnapshotMechanism,
  unsupportedFinalSnapshotError,
} from '../../provisioning/final-snapshot.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { CdkdError } from '../../utils/error-handler.js';
import { displayIdent } from '../../utils/display-safe.js';
import { maskSecretsInText, SECRET_MASK, type RecordedSecretValues } from '../secret-redaction.js';
import { safe, shownLogicalId, SKIP_FINAL_SNAPSHOT_FLAG } from './messages.js';
import { type RollbackExecutorContext, type CompletedOperation } from './types.js';

/**
 * What a replay arm may do with the desired bag it is about to restore TO
 * (issue #3203), and the one place the two dispositions are decided.
 *
 * Every arm coalesced its bag (`?? {}`), and `{}` is not a no-op: it is a
 * COMPLETE desired state saying "this resource has no properties". What that
 * costs depends on the ROUTE, so the caller passes the consequence rather than
 * this helper asserting one: a patch provider removes every property
 * (`JsonPatchGenerator.generatePatch`, called with no empty-desired guard);
 * an SDK provider may instead RESET a subset or, where the bag names the
 * resource (`IAMRoleProvider`'s `newRoleName`), create a replacement and
 * delete the live one.
 *
 * TWO dispositions, and the seam is what the record actually holds -- each
 * half follows an existing sibling rather than inventing a rule:
 *
 * - ABSENT (`undefined`): nothing was ever recorded, so there is nothing to
 *   preserve and nothing a retry could use. SKIPPED, like
 *   `skip-failed-absent`: the op is warned and the pass continues, the journal
 *   segment pops, and the operator re-converges with `cdkd deploy`.
 * - PRESENT but unusable (`null`, a string, an array): something was recorded
 *   and only its shape is wrong. REFUSED by throwing, like
 *   {@link refuseMaskedReplayBaseline}, whose case is the same class (a
 *   desired bag that exists and cannot be used): the op counts as a FAILURE,
 *   which keeps the segment from popping so a repaired record can be retried.
 *   "Repairable" is the conservative reading rather than a promise -- the
 *   security review measured that `null` and `[]` carry nothing to repair FROM,
 *   and only a JSON-stringified object really does -- but keeping a
 *   hand-edited artifact costs the user exit 2 and nothing else, while popping
 *   it is irreversible. The RETRY phrase is per-arm: the failed-op arm runs
 *   only under `--revert-failed`, so a plain `cdkd rollback` re-run there
 *   replays the completed ops, pops the whole segment and discards the very
 *   record this refusal preserved (measured by the code review).
 *
 * Reachability, because it decides what the message may promise, and it is NOT
 * uniform across the three arms:
 *
 * - The two {@link replaySingle} arms are reached from the AUTOMATIC rollback
 *   (`deploy-engine.ts` calls `replayRollback` directly), whose ops come from
 *   `state.json` and pass no parser. That is where the throw has a live
 *   producer. On the `cdkd rollback` path go-to-k/cdkd#3149 refuses the same
 *   record at `parseRollbackJournal` first, with its own remedy.
 * - The failed-op arm has NO such producer for its THROW.
 *   `replayFailedOperations` has ONE caller (`src/cli/commands/rollback.ts`),
 *   and that path is fed by `parseRollbackJournal`, whose
 *   `refuseMalformedOperation` runs over `failedOperations[]` as well and
 *   already rejects a non-object `previousState.properties`. So its throw, its
 *   `--revert-failed` retry phrase and the case pinning them are kept for
 *   PARITY -- the three arms answer one question and an arm that answered it
 *   differently would be the defect. Its SKIP half IS reachable: the parser
 *   TOLERATES an absent bag by an explicit decision, so only the present-
 *   but-unusable shapes are filtered upstream.
 *
 * Neither message offers `cdkd rollback --orphan <id>`, but the reason DIFFERS
 * by half and an earlier revision of this comment gave the throw's reason for
 * both under an "Either way" (caught in review):
 *
 * - THROW: the parser refusal precedes that remedy, so it names the JOURNAL
 *   record -- what `parseRollbackJournal` reads.
 * - SKIP: the parser tolerates this record, so nothing precedes anything. The
 *   omission is right for its own reason -- `--orphan` on an UPDATE op only
 *   logs "Leaving X at its new state" and returns, which is the outcome the
 *   skip already produces. Its message says "recorded previous state" rather
 *   than "JOURNAL record", which is the accurate wording for a path whose
 *   record is as often STATE-sourced.
 *
 * The two reviews of this change disagreed about which disposition applied,
 * one reading "state and AWS stay consistent" (true for both) and the other
 * "the skip deletes the only repairable copy" (true only for the present
 * half). The split is the answer to both.
 *
 * Returns `false` when the caller should skip; throws when it must refuse.
 *
 * The three message strings arrive as a NAMED BAG rather than positionally.
 * That is the round-2 BLOCKER's class removed at the type level rather than
 * patched: `remedy` and `retry` are both `string`, a swap between them
 * compiles, and on the `--revert-failed` arm a wrong `retry` tells the
 * operator to run the command that DESTROYS the record this refusal just
 * preserved. Review then measured that two of these positions were 0-red, so
 * assertions alone were not holding the line either.
 */
interface RestorableBaselineRefusal {
  /** Logical id of the op being replayed; rendered through {@link safe}. */
  logicalId: string;
  /** What replaying an unusable bag would DO, in the arm's own terms. */
  consequence: string;
  /** What re-converges the resource after a SKIP. */
  remedy: string;
  /** Which command retries the op after a THROW -- arm-specific. */
  retry: string;
}

/**
 * Runs `fn` under the user-supplied-name prefix flag that CREATED the resource
 * an op replays (issue go-to-k/cdkd#4024; the choice is
 * {@link replayPrefixChoice}'s), and says so when that is not the failed
 * deploy's flag the replay's scope carries (#4018).
 *
 * `restoring` is the reverse-replacement re-create: there an old physical id
 * neither flag reproduces is WARNED about, once, since the resource may come
 * back under another name. An in-place revert (`restoring: false`) stays
 * silent on it: only some of these providers' `update()` re-derives the name
 * at all, and nothing is re-created. Advisory either way — not counted in
 * `result.warnings`, which maps to exit 2 while the op itself succeeds.
 *
 * Every value is masked with the op's masker ({@link createOpMasker}): the
 * names derive from the PLAINTEXT replay properties.
 */
export function replayPrefixScope(
  input: Parameters<typeof replayPrefixChoice>[0] & { logicalId: string },
  logger: Logger,
  mask: MaskerFn,
  restoring: boolean
): <T>(fn: () => T) => T {
  const choice = replayPrefixChoice(input);
  if (choice.kind === 'not-applicable') return (fn) => fn();
  const setting = (skip: boolean): string => (skip ? 'SKIPPED' : 'KEPT');
  const subject = `${safe(input.logicalId)} (${safe(input.resourceType)})`;
  // A declared name the op's secrets touch (a `{{resolve:...}}` the replay
  // resolved to plaintext) is REWRITTEN before it is sent (stack prefix,
  // charset folding, truncation), so the masker, which matches literally,
  // does not recognise its derived spellings — the gap `withDerivedNameMasks`
  // closes in the providers and `rewrittenNameHolds` in the holder diagnosis.
  // The physical id spells that name too, and not only as one of the two
  // derivations this op computes (another stack's prefix, another truncation,
  // another case under IAM's fold), so for such a name neither the
  // derivations NOR the physical id is shown.
  const declared = choice.declared;
  const secretDerived = declared !== undefined && mask(declared) !== declared;
  // A name the op declared but cdkd cannot read (a leftover mask or
  // `{{resolve:...}}`, a non-string) may be a secret this op never resolved:
  // its physical id is withheld the same way.
  const withheld = secretDerived || (choice.kind === 'unreproduced' && declared === undefined);
  // Masked BEFORE `displayIdent` escapes / cuts it, while the value still has
  // the spelling the masker matches (the holder diagnosis's own order), and
  // quoted only when `displayIdent` did not already quote it.
  const shown = (value: unknown): string => displayIdent(mask(String(value)));
  const quoted = (value: string): string => {
    const masked = mask(value);
    const rendered = displayIdent(masked);
    return rendered === masked ? `"${masked}"` : rendered;
  };
  if (choice.kind === 'reproduced' && choice.skipPrefix !== choice.recorded) {
    logger.info(
      mask(
        `  Rollback: ${restoring ? 're-creating' : 'reverting'} ${subject} under the ` +
          `user-supplied-name prefix setting that created ` +
          (withheld
            ? `it (its physical id is withheld, as its name is secret-derived): `
            : `${shown(input.physicalId)} (`) +
          `stack-name prefix ${setting(choice.skipPrefix)}; the failed deploy ran with it ` +
          `${setting(choice.recorded)}${withheld ? '' : ')'}`
      )
    );
  } else if (choice.kind === 'unreproduced' && restoring) {
    // Name only the half cdkd could not read (the #4035 review): the two
    // derivations are missing when the declared name, the old physical id, or
    // (for a journal that is not a string) the logical id they derive from is.
    const idUnreadable = typeof input.physicalId !== 'string' || input.physicalId === '';
    const prop = safe(choice.property);
    const unreadable =
      declared === undefined
        ? idUnreadable
          ? `its ${prop} or its physical id`
          : `its ${prop}`
        : idUnreadable
          ? `its physical id`
          : undefined;
    logger.warn(
      mask(
        `  ⚠ ${subject}: cdkd cannot tell which user-supplied-name prefix setting created the ` +
          `old resource (` +
          (withheld
            ? `its physical id is withheld, as its name is secret-derived or unreadable`
            : shown(input.physicalId)) +
          `) — ` +
          (choice.names === undefined
            ? unreadable !== undefined
              ? `cdkd cannot read ${unreadable} to compare`
              : `cdkd cannot derive the names its ${prop} takes to compare`
            : secretDerived
              ? `its ${prop} is secret-derived, and neither name it derives matches`
              : `its ${prop} derives to ${quoted(choice.names.skipped)} (prefix ` +
                `skipped) or ${quoted(choice.names.kept)} (prefix kept), and it is neither`) +
          `; re-creating it with the stack-name prefix ${setting(choice.skipPrefix)}, as the ` +
          `failed deploy ran, so it may come back under a different physical name.`
      )
    );
  }
  const skip = choice.skipPrefix;
  return (fn) => withSkipPrefix(skip, fn);
}

/**
 * One op's text masker (issue go-to-k/cdkd#4037), and the ONE masker every
 * line, error and event reason a replay arm renders goes through.
 *
 * `maskSecretsInText` over the op's `secrets` matches a plaintext LITERALLY,
 * so a physical id that spells a secret-derived name another way passes it:
 * a `SENT_NAME_REWRITTEN` provider sends `alice@example.com` as
 * `MyStack-alice-example-com`, and a record whose name is still a
 * `{{resolve:...}}` reference (the NEW resource's, or any record on an arm
 * that resolves nothing) has no plaintext in the bag at all. Each
 * {@link OpMasker.addNamed} call adds, through the providers' own
 * `withDerivedNameMasks` predicate, the record's physical ids and — for a
 * rewriting type — the name its provider derives under BOTH prefix settings,
 * whenever the record's name is secret-derived.
 *
 * `addNamed` evaluates that predicate when it is CALLED, against the bag as it
 * stands then, so an arm calls it again after `resolveReplayProps` has filled
 * `secrets` with the plaintext its resolved bag carries. `mask` reads the
 * latest needles and the bag by reference.
 */
interface OpMasker {
  readonly mask: MaskerFn;
  readonly addNamed: (record: {
    resourceType: unknown;
    properties: unknown;
    logicalId: unknown;
    physicalIds: readonly unknown[];
  }) => void;
}

/** See {@link OpMasker}. */
export function createOpMasker(logger: Logger, secrets: RecordedSecretValues): OpMasker {
  const base = createMaskedLogSinks(logger, (text) => maskSecretsInText(text, secrets));
  const pairs: Array<readonly [unknown, string | undefined]> = [];
  let sinks = base;
  return {
    // TOTAL (review of #4099): a state or journal record can carry a
    // non-string physical id, which the sites below pass straight in, and the
    // derived-name arm calls `.split` on its input. A non-string is returned
    // as it came, for the render around it to stringify as before.
    mask: (text) => (typeof text === 'string' ? sinks.mask(text) : text),
    addNamed: (record) => {
      // Rebuilt over EVERY pair so far, never layered. A layer's base would
      // be the earlier layers, whose needles then look to its crossing check
      // like recorded secrets: an earlier name that contains an occurrence
      // of a later one (the id `MyStack-alice-example-com` around
      // the derived `alice-example-com`) would withhold the WHOLE line as
      // `***`, an over-mask, where a single helper call masks the longer
      // name and keeps the rest of the line (go-to-k/cdkd#4193).
      // Re-evaluating the earlier pairs against the grown bag is safe too:
      // `secrets` only ever gains entries.
      pairs.push(...secretDerivedNamePairs(record));
      sinks = withDerivedNameMasks(logger, base, pairs);
    },
  };
}

/**
 * Top-level name keys spelled neither `...Name` nor `...Identifier`, which that
 * rule misses (the #4099 reviews measured `ReplicationGroupId`,
 * `EmailIdentity`, `Domain`, `Family` and `Username` printing; `Username`'s
 * lowercase `n` is outside the case-sensitive rule). An allow-list, never a blanket
 * `Id$` or "every key": `ApiId`, `RestApiId`, `UserPoolId`, `VpcId` and the
 * like are AWS-generated SCOPE ids, and a secret-valued non-name property
 * (`MasterUserPassword`) would mask an id that is not derived from it. Nested
 * names (`Budget.BudgetName`, `TableInput.Name`) and a top-level name key this
 * table does not list are not read: a known bound, recorded on #4099.
 */
const OTHER_SPELLED_NAME_KEYS: Readonly<Record<string, readonly string[]>> = {
  'AWS::Cognito::UserPoolDomain': ['Domain'],
  'AWS::Cognito::UserPoolUser': ['Username'],
  'AWS::ECS::TaskDefinition': ['Family'],
  'AWS::ElastiCache::ReplicationGroup': ['ReplicationGroupId'],
  'AWS::ElastiCache::User': ['UserId'],
  'AWS::ElastiCache::UserGroup': ['UserGroupId'],
  'AWS::SES::EmailIdentity': ['EmailIdentity'],
};

/**
 * The two POSITIONS in a `|` composite that are certainly not a chosen name,
 * each tested only there (#4141 review): a Cloud Control WAF id ends in its
 * upper-case scope word (`<Name>|<Id>|REGIONAL`), and a Cognito id starts with
 * its user pool id (`<region>_<id>|<Username>`). No shape is excluded anywhere
 * else: a secret-derived name is often a UUID or hex token, and masking an
 * AWS-generated segment only over-masks.
 */
const COMPOSITE_SCOPE_LAST = /^(?:REGIONAL|CLOUDFRONT|GLOBAL)$/;
const COMPOSITE_POOL_FIRST = /^[a-z]{2}(?:-gov)?-[a-z]+-\d+_[A-Za-z0-9]+$/;

/**
 * The NAME parts of an id an AWS message may quote on their own (#4099,
 * #4135, #4138), for a record whose name is secret-derived. Every choice errs
 * toward over-masking, never toward skipping a segment that may be the name:
 *
 * - every segment of an ARN's resource part (split on `/` and `:`), except the
 *   leading resource-type word when there is more than one and a TRAILING
 *   number (a version or revision) when another is left. So the name is taken
 *   wherever the service puts it: last (SNS `...:<topic>`), before a hash
 *   (ELBv2 `loadbalancer/app/<name>/<hash>`, AppRunner, MSK), mid-path (EKS
 *   `nodegroup/<cluster>/<name>/<uuid>`). A sibling segment (EKS's cluster
 *   name, an IAM path word, a hash) is masked too;
 * - Lambda's segment after `function:` / `layer:` AND a non-numeric qualifier
 *   after it: an alias name may be the secret-derived one (#4141 review), so a
 *   word like `production` is masked when the function's name is;
 * - Secrets Manager's name without its random `-XXXXXX` suffix;
 * - any id's last `/` segment, with and without a `:<revision>` (ECS's
 *   `task-definition/<Family>:<rev>` is quoted whole);
 * - every segment of a `|` composite but {@link COMPOSITE_SCOPE_LAST} /
 *   {@link COMPOSITE_POOL_FIRST} in their own positions (WAFv2's name is
 *   FIRST).
 *
 * Derived spellings, so each clears the literal masker's substring floor (4)
 * and differs from the id itself.
 */
function idNameSegments(id: string): string[] {
  const segments = new Set<string>();
  const arn = /^arn:[^:]*:([^:]*):[^:]*:[^:]*:(.+)$/.exec(id);
  if (arn !== null) {
    const service = arn[1]!;
    const resource = arn[2]!;
    const lambda =
      service === 'lambda' ? /^(?:function|layer):([^:]+)(?::([^:]+))?/.exec(resource) : null;
    if (lambda !== null) {
      segments.add(lambda[1]!);
      const qualifier = lambda[2];
      if (qualifier !== undefined && !/^\d+$/.test(qualifier)) segments.add(qualifier);
    } else {
      const parts = resource.split(/[/:]/).filter((part) => part !== '');
      let body = parts.length > 1 ? parts.slice(1) : parts;
      if (body.length > 1 && /^\d+$/.test(body[body.length - 1]!)) body = body.slice(0, -1);
      for (const part of body) {
        segments.add(part);
        if (service === 'secretsmanager') segments.add(part.replace(/-[A-Za-z0-9]{6}$/, ''));
      }
    }
  }
  if (id.includes('/')) {
    const afterSlash = id.slice(id.lastIndexOf('/') + 1);
    segments.add(afterSlash);
    segments.add(afterSlash.replace(/:\d+$/, ''));
  }
  if (id.includes('|')) {
    const parts = id.split('|');
    parts.forEach((part, index) => {
      if (part === '') return;
      if (index === parts.length - 1 && parts.length > 1 && COMPOSITE_SCOPE_LAST.test(part)) return;
      if (index === 0 && parts.length > 1 && COMPOSITE_POOL_FIRST.test(part)) return;
      segments.add(part);
    });
  }
  return [...segments].filter((segment) => segment.length >= 4 && segment !== id);
}

/** A per-type table's OWN entry: an inherited key (`constructor`) is absent. */
function ownEntry<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * The `[declared name, spelling derived from it]` pairs one record implies
 * (see {@link OpMasker}).
 *
 * The NAME keys: the rewriting provider's property, the type's explicit name
 * property, and every other top-level key spelled `...Name` / `...Identifier`
 * (the security review of #4099 measured an `AWS::Redshift::Cluster`, whose
 * `ClusterIdentifier` neither table names, printing its id). A key that is not
 * the resource's name only costs over-masking, and only when its value is
 * secret-derived. With no such key declared (a logical-id name is no secret),
 * there is nothing to add.
 *
 * The SPELLINGS of each id: itself, lowercased, and the final-snapshot name
 * prefix built from it (`finalSnapshotNamePrefix`, which a `DeletionPolicy:
 * Snapshot` rollback logs and quotes), then, for a rewriting type, the names
 * its provider sends under either flag in the replay's own scope, which an AWS
 * message quotes back. A reference's "derivations" would spell the
 * reference, not the secret.
 */
function secretDerivedNamePairs(record: {
  resourceType: unknown;
  properties: unknown;
  logicalId: unknown;
  physicalIds: readonly unknown[];
}): Array<readonly [unknown, string | undefined]> {
  const { resourceType, properties, logicalId } = record;
  if (typeof resourceType !== 'string' || !isRestorableBag(properties)) return [];
  const rewritten = reverseReplacementRewrittenNameTypes();
  const named = new Set<string>();
  const primary = Object.hasOwn(rewritten, resourceType)
    ? rewritten[resourceType]!.property
    : explicitNamePropertyFor(resourceType);
  if (typeof primary === 'string') named.add(primary);
  for (const key of Object.keys(properties)) {
    if (/(?:Name|Identifier)$/.test(key)) named.add(key);
  }
  for (const key of ownEntry(OTHER_SPELLED_NAME_KEYS, resourceType) ?? []) named.add(key);
  const ids = record.physicalIds.filter((id): id is string => typeof id === 'string' && id !== '');
  // The lowercased spelling only where it differs and clears the literal
  // masker's substring floor (4): it is a DERIVED spelling, and a short one
  // (`r` from `R`) masks nearly every word of the op's text (#4099 review).
  const idSpellings = ids.flatMap((id) => [
    id,
    ...(id.toLowerCase() === id || id.length < 4 ? [] : [id.toLowerCase()]),
    finalSnapshotNamePrefix(id, resourceType),
    ...idNameSegments(id),
  ]);
  const pairs: Array<readonly [unknown, string | undefined]> = [];
  for (const key of named) {
    if (!Object.hasOwn(properties, key)) continue;
    // A NON-STRING name is not treated as secret-derived here, unlike
    // `replayPrefixScope`'s withholding: that one drops one value from one
    // line, while a needle is replaced everywhere, and a short id (`b`) would
    // then mask every `b` in the op's text. A name that is the whole mask
    // (`***`) IS, per the shared predicate (`isSecretDerivedValue`, #4069).
    const value = properties[key];
    if (typeof value !== 'string' || value === '') continue;
    const derived =
      // Nor a value that IS the mask (`***`, a NoEcho-recorded name): its
      // "derivation" is `MyStack-***` -> `MyStack`, a needle that would mask
      // every `MyStack` in the op's text. Its ids stay needles above.
      key === primary && !value.includes('{{resolve:') && value !== SECRET_MASK
        ? rewrittenNameSpellings(resourceType, value, logicalId)
        : [];
    for (const spelling of [...idSpellings, ...derived]) pairs.push([value, spelling]);
  }
  return pairs;
}

/**
 * {@link OpMasker.addNamed} for the three records an op can render an id of:
 * the op's own bag and id, its previous state, and the live record. Each
 * record's name derives its OWN ids only.
 */
export function addRecordNames(
  opMasker: OpMasker,
  op: {
    logicalId: unknown;
    resourceType: unknown;
    physicalId?: unknown;
    properties?: unknown;
    attemptedProperties?: unknown;
    previousState?: ResourceState | undefined;
  },
  current: ResourceState | undefined
): void {
  const { logicalId } = op;
  for (const properties of [op.properties, op.attemptedProperties]) {
    opMasker.addNamed({
      resourceType: op.resourceType,
      properties,
      logicalId,
      physicalIds: [op.physicalId],
    });
  }
  for (const record of [op.previousState, current]) {
    if (record === null || typeof record !== 'object') continue;
    opMasker.addNamed({
      resourceType: record.resourceType ?? op.resourceType,
      properties: record.properties,
      logicalId,
      physicalIds: [record.physicalId],
    });
  }
}

export function requireRestorableBaseline(
  bag: unknown,
  logger: RollbackExecutorContext['logger'],
  { logicalId, consequence, remedy, retry }: RestorableBaselineRefusal
): bag is Record<string, unknown> {
  if (isRestorableBag(bag)) return true;
  if (bag === undefined) {
    logger.warn(
      // The id is described when not plain: `remedy` names a `cdkd`
      // command on this line (go-to-k/cdkd#4214).
      `  Rollback: Cannot restore ${shownLogicalId(logicalId)} \u2014 its recorded previous state has no ` +
        `\`properties\` bag, so there is nothing to restore it to. An empty desired state ` +
        `would ${consequence}. The resource is therefore left exactly as it is. ${remedy}`
    );
    return false;
  }
  // Article included on every arm: this renders inside `(...)` beside the two
  // literals, and `(an array)` next to `(string)` was inconsistent (the test's
  // own row LABEL already said `a string` while its expectation said `string`).
  const shape = bag === null ? 'null' : Array.isArray(bag) ? 'an array' : `a ${typeof bag}`;
  // The clause is framed to hold for ALL THREE refused shapes, which a bare
  // `Replaying it would ${consequence}` does not (caught in review):
  // `consequence` describes the EMPTY-bag outcome, and only `null` coalesces to
  // `{}` -- a string or an array would reach the provider VERBATIM instead. So
  // the empty-bag outcome is named as ONE of the two things a replay could do,
  // not as the thing it would do. `consequence` stays rendered and per-arm:
  // deleting it from this throw measured 0 red in round 2, and the refuse-side
  // rows now pin it.
  throw new CdkdError(
    // Described when not plain: the message names `cdkd deploy` and
    // `cdkd destroy` (go-to-k/cdkd#4214).
    `Cannot roll ${shownLogicalId(logicalId)} back: its recorded previous state has a \`properties\` ` +
      `field that is not a property bag (${shape}), so cdkd cannot tell what to restore it to. ` +
      `Replaying it would do one of two things, and cdkd does neither: send the malformed ` +
      `value to the provider as-is, or send an empty desired state (which would ` +
      `${consequence}). ` +
      // `once ...` binds to `${retry}`, so it leads rather than trails: on the
      // `--revert-failed` arm that value carries a 20-word parenthetical, and
      // trailing the clause put it between the verb and its own condition.
      `The rollback JOURNAL record is kept: once that record holds a property bag again, ` +
      `${retry}. Otherwise fix forward with \`cdkd deploy\`, or remove the stack with ` +
      `\`cdkd destroy\`.`,
    'ROLLBACK_UNUSABLE_BASELINE'
  );
}

/**
 * Is this a desired bag a replay can actually restore TO?
 *
 * Absent is the shape issue #3203 started from, but `=== undefined` is the
 * WRONG test and a 0-red mutation row is what said so: `null ?? {}` is `{}`,
 * so a `null` bag reaches the provider as an empty desired state exactly as an
 * absent one does. A non-object bag (`"abc"`, `[]`) is worse still -- it goes
 * to the provider VERBATIM. go-to-k/cdkd#3149 refuses those shapes for a
 * JOURNAL-sourced record at the parser, but `previousState` is equally often
 * STATE-sourced, and `parseStateBody` deliberately validates no inner shape
 * (go-to-k/cdkd#2947's placement decision), so this is the only boundary that
 * sees them on that path.
 *
 * A PRESENT but empty `{}` is restorable and must pass: the operator recorded
 * a resource that really has no properties. Only "no usable bag" is refused.
 */
function isRestorableBag(bag: unknown): bag is Record<string, unknown> {
  return typeof bag === 'object' && bag !== null && !Array.isArray(bag);
}

/**
 * `DeletionPolicy: Snapshot` on a rolled-back CREATE (issue #1358) — the
 * executor's copy of the deploy engine's `prepareFinalSnapshotForDelete`
 * mechanism matrix, run BEFORE the delete. Shared with the FAILED in-flight
 * CREATE's delete (`--revert-failed`, issue #1362) so the two sibling paths
 * cannot drift; that caller's op is a {@link FailedOperation}, hence the
 * structural parameter type:
 *
 *   - atomic type, SDK-routed → returns the generated identifier for the
 *     provider's atomic final-snapshot delete parameter.
 *   - atomic type, cc-api-routed → refuses (Cloud Control's DeleteResource
 *     has no final-snapshot parameter; `CloudControlProvider.delete` also
 *     fail-closes on the context field as defense-in-depth).
 *   - `PRE_DELETE_SNAPSHOT_TYPES` → creates the snapshot and waits for it
 *     here, then returns undefined (the subsequent delete is plain).
 *   - anything else Snapshot-tagged → refuses.
 *
 * Refusals are plain throws so `replaySingle`'s per-op catch counts them as
 * a failure (which blocks the segment pop and keeps the journal for a
 * re-run) — deliberately NOT a silent fall-back to orphaning, which is the
 * very leak #1358 fixes.
 */
export async function prepareCreateRollbackFinalSnapshot(
  op: Pick<CompletedOperation, 'logicalId' | 'resourceType' | 'physicalId'>,
  provisionedBy: 'sdk' | 'cc-api' | undefined,
  ctx: RollbackExecutorContext,
  /**
   * The op's masker (issue #4037): the snapshot lines name the physical id and
   * a snapshot id built from it, at INFO.
   */
  mask: MaskerFn
): Promise<string | undefined> {
  const { logicalId, resourceType } = op;
  // Callers reach this only past the SAME falsy physical-id guard:
  // `replaySingle`'s `!op.physicalId` early return, or `classifyFailedOp`'s
  // `skip-failed-unknown` arm on the `--revert-failed` path.
  const physicalId = op.physicalId!;
  // ONE matrix, shared with the plan preview (issue #1366) so the label the
  // user confirms cannot promise a snapshot this function is about to refuse.
  switch (finalSnapshotMechanism(resourceType, provisionedBy)) {
    case 'atomic-delete-parameter':
      return buildFinalSnapshotIdentifier(physicalId, resourceType);
    case 'pre-delete-snapshot':
      // Region-pinned clients: `getAwsClients()` is a process-global that a
      // concurrent stack's deploy can repoint at ANOTHER region
      // (`--stack-concurrency > 1` + multi-region apps); a wrong-region
      // snapshot call 404s as a NotFound, which would be read as "source
      // gone" and skip the snapshot. Prefer the caller-scoped clients on the
      // context (mirrors `DeployEngineOptions.finalSnapshotClients`).
      await createPreDeleteFinalSnapshot(
        resourceType,
        physicalId,
        logicalId,
        ctx.finalSnapshotClients ?? getAwsClients(),
        {
          info: (message) => ctx.logger.info(mask(message)),
          debug: (message) => ctx.logger.debug(mask(message)),
        }
      );
      return undefined;
    // Raw values: both builders describe a non-plain id or type themselves
    // (go-to-k/cdkd#4265), so a value described here would be described twice.
    case 'refuse-cc-routed':
      throw ccRoutedFinalSnapshotError(logicalId, resourceType, SKIP_FINAL_SNAPSHOT_FLAG);
    case 'refuse-unsupported-type':
      throw unsupportedFinalSnapshotError(logicalId, resourceType, SKIP_FINAL_SNAPSHOT_FLAG);
  }
}

/**
 * Retry schedule for a re-create that must wait out a name-release delay:
 * an async delete's late name release ("already exists") or the SQS 60s
 * same-name cooldown (issue #1206). 2s/4s/8s then capped at 10s over 8
 * retries ≈ 64s of total sleep — enough to cover the full cooldown window.
 */
export const RECREATE_RETRY_SCHEDULE = {
  maxRetries: 8,
  initialDelayMs: 2_000,
  maxDelayMs: 10_000,
} as const;
