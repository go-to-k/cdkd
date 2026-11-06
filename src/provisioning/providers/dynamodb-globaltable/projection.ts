import { AsyncLocalStorage } from 'node:async_hooks';
import { isUsableAttemptedName } from '../../../state/unsettled-properties.js';
import { maskDeep } from '../../masked-retry-logger.js';
import type { SecretMasker } from '../../../types/resource.js';

/**
 * A DynamoDB table NAME (3-255 of `a-z A-Z 0-9 _ . -`), the physical id this
 * provider records. The identity answers (`isSameResource`,
 * `resourceIdentity`) refuse anything else: `DescribeTable` also takes a
 * table ARN, which this provider never records and would only be guessing
 * about.
 */
export function isTableName(id: string): boolean {
  return /^[A-Za-z0-9_.-]{3,255}$/.test(id);
}

/**
 * The CLOSED path table {@link DynamoDBGlobalTableProvider.canonicalizeDriftProperties}
 * strips from BOTH drift comparison sides (issue #1742).
 *
 * One entry today: the AWS-computed `GlobalSecondaryIndexes[].WarmThroughput`.
 * A table rather than an inline check so a second per-array-element member
 * lands as a row instead of a second walk — and so the scope is READABLE as a
 * list of paths, which is what "closed table" means here. Deliberately does
 * NOT include `LocalSecondaryIndexes` (this provider's readback assigns the
 * raw SDK descriptions there, a wider divergence than one member) or
 * `Replicas[].GlobalSecondaryIndexes` (whose entries carry only the read-half
 * throughput blocks — no `WarmThroughput` is emitted or accepted there).
 */
export const DRIFT_STRIPPED_INDEX_MEMBERS: ReadonlyArray<{ listKey: string; member: string }> = [
  { listKey: 'GlobalSecondaryIndexes', member: 'WarmThroughput' },
];

/**
 * AWS DynamoDB GlobalTable Provider
 *
 * Implements resource provisioning for AWS::DynamoDB::GlobalTable using the
 * standard DynamoDB SDK (2019.11.21 API generation, NOT the legacy
 * 2017.11.29 endpoints). CDK v2's `dynamodb.TableV2` construct synthesizes
 * as this type.
 *
 * WHY a dedicated SDK provider:
 *   - Pre-PR the type fell through to Cloud Control API which did not pass
 *     a `TableName` field, so AWS auto-generated random names like
 *     `yq2phLewTEUtzr4sy2gYFRU4I-1OGJ0UFLOKOOV` instead of the cdkd
 *     `${stackName}-X<hash>` shape (Issue #383).
 *   - Per memory rule `feedback_dedicated_provider_over_special_case.md`,
 *     the consistent fix is a dedicated SDK Provider rather than adding
 *     the type to `FALLBACK_NAME_RULES`.
 *
 * **CRITICAL**: do NOT use the legacy 2017.11.29 endpoints
 * (`CreateGlobalTableCommand` / `UpdateGlobalTableCommand` /
 * `DescribeGlobalTableCommand`). The CFn type `AWS::DynamoDB::GlobalTable`
 * is the 2019.11.21 generation, which uses the regular DynamoDB CRUD API
 * (`CreateTableCommand` + `UpdateTableCommand` with `ReplicaUpdates`).
 *
 * In-place update support (post-PR #384 follow-up):
 *  - `update()` covers every mutable surface — Tags, DeletionProtection,
 *    TableClass, SSE, StreamSpec, OnDemand throughput, BillingMode flip,
 *    Replica add / remove / modify, GSI add / remove / modify, TTL toggle.
 *  - The serialization is load-bearing: AWS's `UpdateTable` does not accept
 *    `ReplicaUpdates` alongside `BillingMode` / `GlobalSecondaryIndexUpdates`,
 *    so each category is its own SDK round-trip with a wait-for-ACTIVE in
 *    between. `BillingMode` and `GlobalSecondaryIndexUpdates` DO combine, and
 *    only in the `PAY_PER_REQUEST -> PROVISIONED` flip, where AWS REQUIRES
 *    per-GSI `ProvisionedThroughput` in the SAME call as `BillingMode` ("you
 *    must specify read and write capacity unit values for the table and for
 *    each global secondary index") — so that path deliberately sends both
 *    together (Issue #1387). Immutable property changes (TableName, KeySchema,
 *    AttributeDefinitions removal, LocalSecondaryIndexes) throw
 *    `ProvisioningError` naming the offending field — the deploy engine's
 *    diff classification should catch these as REPLACEMENT before ever
 *    calling `update()`, but the guard is defense-in-depth.
 *  - Per-replica drift (`ContributorInsightsSpecification` /
 *    `PointInTimeRecoverySpecification` / `KinesisStreamSpecification`)
 *    is surfaced for BOTH the LOCAL replica AND cross-region replicas
 *    via per-region SDK clients (cached in `regionalClientCache` for
 *    the deploy run). Issue #389 lifted the v1 LOCAL-only limitation.
 *  - Cross-region replica Tags propagation (Issue #389 / #441):
 *    BOTH `create()` and `update()` resolve each non-local replica's
 *    table ARN by swapping the region segment of the local ARN and
 *    issue `TagResource` / `UntagResource` against a per-region
 *    client. The shared helper `applyCrossRegionReplicaTagsDiff`
 *    centralizes the diff + best-effort WARN-on-failure contract.
 */
/**
 * Mask every string LEAF (and every KEY) of a value before it is stringified
 * into a log line (issue #1932 item 3, adopted here by issue #1997).
 *
 * The INNER of the two masking layers `SecretMaskingContext` prescribes, and
 * neither layer subsumes the other. The outer one — routing the assembled
 * message through the masker — can only reach `maskSecretsInText`'s SUBSTRING
 * arm, which ignores needles below `MIN_NEEDLE_LENGTH` (4) and, more
 * importantly, never matches at all once `JSON.stringify` has escaped a `"`, a
 * `\` or a newline inside the value: the secret no longer OCCURS in the
 * finished line. Handing the masker each raw string reaches the WHOLE-VALUE arm
 * at any length and runs BEFORE any escaping. The mask is idempotent and matches
 * by value rather than by position, so the two layers compose.
 *
 * Walks rather than testing the top level, because a secret nested in an object
 * or array leaf is stringified — and escaped — identically.
 *
 * Issue #2176 hoisted the walk into `../masked-retry-logger.js`. The previous
 * note here said the helper was "duplicated rather than shared because these two
 * files deliberately hold no common module today" — that rationale expired the
 * moment a shared LEAF module existed for exactly this, and it had already cost
 * something: this copy carried NO depth cap, so it was one of SIX copies that
 * had drifted apart on the one property that matters.
 */
export function maskLeafValue(value: unknown, maskSecrets: SecretMasker): unknown {
  return maskDeep(value, maskSecrets);
}

/**
 * go-to-k/cdkd#5487: the running update's `UpdateContext.markUnsettled` and
 * `unsettledProperties`, for the helpers that make its sends. Absent outside
 * an update (create, delete, a read), where marking does nothing.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * go-to-k/cdkd#5487: the identities a collection's entries are keyed by. A list
 * whose every entry (live, recorded and declared) is an object carrying one of
 * these is projected entry by entry; any other list is an ordinary value.
 */
const IDENTITY_KEYS = ['Region', 'IndexName', 'AttributeName'] as const;

/**
 * The identity a collection is keyed by: `{ key }` when every entry carries
 * it; `'ambiguous'` when some entry carries a candidate identity but not every
 * entry does (the projection cannot tell named entries apart, so it fails
 * CLOSED); `undefined` for an ordinary list (no entry carries one).
 */
function identityKeyOf(...lists: unknown[][]): { key: string } | 'ambiguous' | undefined {
  const entries = lists.flat();
  if (entries.length === 0) return undefined;
  const key = IDENTITY_KEYS.find((candidate) =>
    entries.every((entry) => isPlainObject(entry) && typeof entry[candidate] === 'string')
  );
  if (key !== undefined) return { key };
  const partial = entries.some(
    (entry) =>
      isPlainObject(entry) &&
      IDENTITY_KEYS.some((candidate) => typeof entry[candidate] === 'string')
  );
  return partial ? 'ambiguous' : undefined;
}

/** Positional lists whose entries happen to carry an `AttributeName`, never collections. */
const POSITIONAL_LIST_KEYS: ReadonlySet<string> = new Set(['KeySchema']);

/** A live entry the projection left out: no record or template names it. */
export interface UnnamedLiveEntry {
  /** The identity key (`Region`, `IndexName`, ...) and its value. */
  identity: string;
  value: string;
  /** Where it sits, as a member path (`Replicas`, `Replicas[us-east-1].GlobalSecondaryIndexes`). */
  path: string;
  /** The whole list was left at the record's value: its entries could not be keyed. */
  ambiguous?: true;
}

/**
 * go-to-k/cdkd#5487: the ONE projection every value `readUnsettled` returns
 * goes through, so convergence never removes or resets what neither the record
 * (`own`) nor the template (`wanted`) names:
 *
 * - a plain object keeps only the members `own` or `wanted` names, each
 *   projected in turn; a member neither names keeps the record's value, absent
 *   staying absent; `Tags` always keep the record's (tags merge);
 * - a list keyed by an identity (`IDENTITY_KEYS`: replicas by `Region`,
 *   indexes by `IndexName`, ...) keeps only the live entries whose identity
 *   `own` or `wanted` names, each projected against its named counterparts; an
 *   entry only the template names is ADOPTED (on the previous side, so it is
 *   not created again); a live entry neither names is left out (never removed)
 *   and reported in `unnamed`;
 * - anything else is the live value.
 */
export function projectNamed(
  live: unknown,
  own: unknown,
  wanted: unknown,
  path: string,
  unnamed: UnnamedLiveEntry[],
  // go-to-k/cdkd#5498: the names an earlier failed update's accepted calls
  // added, per member path. A live entry (or replica tag) named here EXACTLY,
  // not redacted, joins the previous side, so the template's omission removes
  // it; nothing else does.
  attempted: ReadonlyMap<string, ReadonlySet<string>> = new Map()
): unknown {
  const attemptedAt = (at: string): ReadonlySet<string> =>
    new Set([...(attempted.get(at) ?? [])].filter(isUsableAttemptedName));
  if (isPlainObject(live) && (isPlainObject(own) || isPlainObject(wanted))) {
    const ownBag = isPlainObject(own) ? own : undefined;
    const wantedBag = isPlainObject(wanted) ? wanted : undefined;
    const out: Record<string, unknown> = {};
    for (const key of IDENTITY_KEYS) if (Object.hasOwn(live, key)) out[key] = live[key];
    const named = new Set([...Object.keys(ownBag ?? {}), ...Object.keys(wantedBag ?? {})]);
    for (const key of named) {
      if ((IDENTITY_KEYS as readonly string[]).includes(key)) continue;
      if (key === 'Tags') {
        if (ownBag !== undefined && Object.hasOwn(ownBag, 'Tags')) out['Tags'] = ownBag['Tags'];
        const withAttempted = withAttemptedReplicaTags(
          ownBag?.['Tags'],
          wantedBag?.['Tags'],
          live['Tags'],
          attemptedAt(`${path}.Tags`)
        );
        if (withAttempted !== undefined) out['Tags'] = withAttempted;
        continue;
      }
      if (!Object.hasOwn(live, key) || live[key] === undefined) continue;
      out[key] = POSITIONAL_LIST_KEYS.has(key)
        ? live[key]
        : projectNamed(
            live[key],
            ownBag?.[key],
            wantedBag?.[key],
            `${path}.${key}`,
            unnamed,
            attempted
          );
    }
    return out;
  }
  if (Array.isArray(live)) {
    const ownList = Array.isArray(own) ? own : [];
    const wantedList = Array.isArray(wanted) ? wanted : [];
    const identity = identityKeyOf(live, ownList, wantedList);
    if (identity === undefined) return live;
    if (identity === 'ambiguous') {
      // Fail CLOSED: some entry has no identity, so a live-only entry cannot be
      // told from a named one. The record's value stands (nothing removed).
      unnamed.push({ identity: 'unkeyed entries', value: 'some', path, ambiguous: true });
      return own;
    }
    const id = identity.key;
    const byId = (list: unknown[]): Map<string, Record<string, unknown>> =>
      new Map(
        list.map((entry) => [
          (entry as Record<string, string>)[id]!,
          entry as Record<string, unknown>,
        ])
      );
    const ownById = byId(ownList);
    const wantedById = byId(wantedList);
    return live.flatMap((entry) => {
      const value = (entry as Record<string, string>)[id]!;
      const ownEntry = ownById.get(value);
      const wantedEntry = wantedById.get(value);
      if (ownEntry === undefined && wantedEntry === undefined) {
        // go-to-k/cdkd#5498: an entry a failed update's accepted call added is
        // the previous side's, whole, so the template's omission removes it.
        if (attemptedAt(path).has(value)) return [entry];
        unnamed.push({ identity: id, value, path });
        return [];
      }
      return [projectNamed(entry, ownEntry, wantedEntry, `${path}[${value}]`, unnamed, attempted)];
    });
  }
  return live;
}

/**
 * go-to-k/cdkd#5498: a replica's recorded tags plus each live tag whose key an
 * earlier failed update's accepted tag call added and neither the record nor
 * the template declares, so the tag diff removes exactly those. List shape
 * (`[{Key, Value}]`) only; `undefined` (the record's tags stand) otherwise.
 */
function withAttemptedReplicaTags(
  recorded: unknown,
  desired: unknown,
  live: unknown,
  attempted: ReadonlySet<string>
): unknown[] | undefined {
  if (attempted.size === 0 || !Array.isArray(live)) return undefined;
  const keysOf = (value: unknown): Set<string> | undefined => {
    if (value === undefined || value === null) return new Set();
    if (!Array.isArray(value)) return undefined;
    const keys = new Set<string>();
    for (const entry of value) {
      const key = (entry as { Key?: unknown } | null)?.Key;
      if (typeof key !== 'string') return undefined;
      keys.add(key);
    }
    return keys;
  };
  const recordedKeys = keysOf(recorded);
  const desiredKeys = keysOf(desired);
  if (recordedKeys === undefined || desiredKeys === undefined) return undefined;
  const removable = live.filter((entry) => {
    const key = (entry as { Key?: unknown } | null)?.Key;
    return (
      typeof key === 'string' &&
      attempted.has(key) &&
      !recordedKeys.has(key) &&
      !desiredKeys.has(key)
    );
  });
  if (removable.length === 0) return undefined;
  return [...((recorded as unknown[] | undefined) ?? []), ...removable];
}

/**
 * go-to-k/cdkd#5487: set while `readUnsettled` reads, so each best-effort read
 * of `readCurrentState` throws instead of omitting a key (an omitted key would
 * converge the setting to "not set").
 */
export const strictReadScope = new AsyncLocalStorage<ReadonlySet<string>>();

/**
 * Whether a read feeding `key` must throw rather than omit (go-to-k/cdkd#5487):
 * only when `readUnsettled` reads and `key` is one of the unsettled names, so a
 * read feeding a settled key keeps `readCurrentState`'s tolerance.
 */
export function strictFor(key: string): boolean {
  return strictReadScope.getStore()?.has(key) === true;
}

/**
 * The strict set for one replica's reads: a replica AWS is not serving
 * (CREATION_FAILED, REGION_DISABLED, an inaccessible key, ...) keeps the
 * tolerant reads, so its regional not-found or region error never blocks the
 * deploy that recovers it.
 */
export function replicaStrictness(status: string | undefined): ReadonlySet<string> {
  const current = strictReadScope.getStore() ?? new Set<string>();
  if (status === undefined || status === 'ACTIVE' || status === 'UPDATING') return current;
  return new Set([...current].filter((key) => key !== 'Replicas'));
}

export const unsettledScope = new AsyncLocalStorage<{
  mark: (key: string) => void;
  unsettled: ReadonlySet<string>;
  /** go-to-k/cdkd#5498: `UpdateContext.markAttempted`. */
  attempted?: (path: string, items: readonly string[]) => void;
}>();

/** A Region usable as a path segment (`Replicas[<region>].Tags`): AWS's shape only. */
export const REGION_SEGMENT = /^[a-z]{2}(-[a-z]+)+-\d+$/;

/**
 * go-to-k/cdkd#5498: record `items` as added by a call AWS has just ACCEPTED
 * (call it after the send resolves, never before; a send that throws added
 * nothing). Outside an update it does nothing.
 */
export function markAttemptedItems(path: string, items: readonly string[]): void {
  const scope = unsettledScope.getStore();
  if (scope?.attempted === undefined || items.length === 0) return;
  scope.attempted(path, items);
}

/** Mark `keys` unsettled, immediately before the send that changes them. */
export function markUnsettled(...keys: string[]): void {
  const scope = unsettledScope.getStore();
  if (scope === undefined) return;
  for (const key of keys) scope.mark(key);
}

/** Whether the running update converges `key` (an earlier failure left it unsettled). */
export function isUnsettled(key: string): boolean {
  return unsettledScope.getStore()?.unsettled.has(key) === true;
}

/** `text` closed as a sentence, for a wrap that continues after it. */
export function sentence(text: string): string {
  return text.endsWith('.') ? text : `${text}.`;
}
