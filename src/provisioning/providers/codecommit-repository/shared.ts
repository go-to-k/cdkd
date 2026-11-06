import type { RepositoryTrigger, RepositoryTriggerEventEnum } from '@aws-sdk/client-codecommit';
import { holdsSecretDerivedEntry } from '../../iam-policy-targets.js';

/**
 * CFn `Tags` entry shape (`[{Key, Value}]`). CodeCommit's SDK tag APIs use a
 * flat `Record<string, string>` map instead, so the provider converts on
 * every write.
 */
export interface CfnTag {
  Key?: unknown;
  Value?: unknown;
}

/**
 * Convert the CFn `Tags` list shape to CodeCommit's `Record<string, string>`
 * map. Entries without a string `Key` are skipped; non-string values are
 * stringified (post-intrinsic-resolution values can be numbers/booleans).
 * Returns `undefined` for an absent/empty list so callers can omit the field.
 */
export function toSdkTagMap(tags: CfnTag[] | undefined): Record<string, string> | undefined {
  if (!tags || tags.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const tag of tags) {
    if (typeof tag?.Key !== 'string' || tag.Key.length === 0) continue;
    const value = tag.Value;
    out[tag.Key] =
      typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : '';
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Order-independent equality for two SDK tag maps. */
export function tagMapsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((k) => b[k] === a[k]);
}

/**
 * CFn `Code` property shape (create-only seed content). CFn unpacks the S3
 * ZIP into the repository's first commit on `BranchName` (default `main`).
 */
export interface CfnCode {
  BranchName?: unknown;
  S3?: {
    Bucket?: unknown;
    Key?: unknown;
    ObjectVersion?: unknown;
  };
}

/** CFn `Triggers[]` entry shape (PascalCase); mapped to the SDK's camelCase. */
export interface CfnTrigger {
  Name?: unknown;
  DestinationArn?: unknown;
  CustomData?: unknown;
  Branches?: unknown;
  Events?: unknown;
}

/** Default branch for the `Code` seed commit when `BranchName` is omitted. */
export const DEFAULT_SEED_BRANCH = 'main';

/**
 * Coerce a CFn scalar value to a string. Post-intrinsic-resolution values are
 * strings in practice; numbers / booleans are stringified and any other shape
 * (object / null / undefined) collapses to `''` — avoids stringifying an
 * object to the useless `'[object Object]'`.
 */
function scalarToString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/**
 * Convert the CFn `Triggers` list shape to the CodeCommit SDK's
 * `RepositoryTrigger[]` (PascalCase → camelCase). `Branches` is ALWAYS
 * emitted (defaulting to `[]` when the template omits it) — CodeCommit's
 * `PutRepositoryTriggers` rejects a trigger whose `branches` is null with
 * "Repository trigger branch name list cannot be null", and an empty array
 * means "all branches" (matching CFn's default when `Branches` is absent).
 * `CustomData` is truly optional (emitted only when present) so a re-order /
 * equality comparison stays stable. `Events` / `Branches` are coerced to
 * string arrays.
 */
export function toSdkTriggers(triggers: CfnTrigger[] | undefined): RepositoryTrigger[] {
  // Every caller passes a list `readRepoList` accepted (go-to-k/cdkd#3989).
  if (!Array.isArray(triggers) || triggers.length === 0) return [];
  return triggers.map((t) => {
    const events: unknown[] = Array.isArray(t?.Events) ? t.Events : [];
    const branches: unknown[] = Array.isArray(t?.Branches) ? t.Branches : [];
    const trigger: RepositoryTrigger = {
      name: scalarToString(t?.Name),
      destinationArn: scalarToString(t?.DestinationArn),
      // The SDK types `events` as a string-literal enum union; the CFn values
      // are the same wire strings (`all` / `createReference` / ...), so the
      // coerced strings are cast to the enum type.
      events: events.map((e) => scalarToString(e)) as RepositoryTriggerEventEnum[],
      branches: branches.map((b) => scalarToString(b)),
    };
    if (t?.CustomData !== undefined && t.CustomData !== null) {
      trigger.customData = scalarToString(t.CustomData);
    }
    return trigger;
  });
}

/**
 * Order-sensitive structural equality for two mapped SDK trigger lists, used
 * to skip a redundant `PutRepositoryTriggers` when the template `Triggers`
 * block is unchanged. Compared as canonical JSON so `undefined` optional
 * fields (`customData` / `branches`) collapse identically on both sides.
 */
export function triggersEqual(a: RepositoryTrigger[], b: RepositoryTrigger[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The guard id a delete reports when it could not read the live resource's id
 * to compare with the recorded one (go-to-k/cdkd#4157), and deleted anyway.
 * Names the guard, not the type: another name-addressed provider making the
 * same comparison reuses it.
 */
export const RECORDED_IDENTITY_DELETE_GUARD = 'delete-recorded-identity';

/**
 * The `RepositoryId` cdkd recorded for the resource, or `undefined` for a
 * record that holds none (one from before the attribute existed) or holds it
 * MASKED: a mask is no id, and comparing it would refuse the resource's own
 * repository.
 */
export function recordedRepositoryId(
  attributes: Readonly<Record<string, unknown>> | undefined
): string | undefined {
  const value = attributes?.['RepositoryId'];
  return typeof value === 'string' && value.length > 0 && !holdsSecretDerivedEntry(value)
    ? value
    : undefined;
}

/** A recorded `RepositoryId` that is present but masked (go-to-k/cdkd#4157). */
export function recordedRepositoryIdMasked(
  attributes: Readonly<Record<string, unknown>> | undefined
): boolean {
  const value = attributes?.['RepositoryId'];
  return typeof value === 'string' && holdsSecretDerivedEntry(value);
}

// ─── List reads (go-to-k/cdkd#3989) ─────────────────────────────────
//
// `PutRepositoryTriggers` REPLACES the whole trigger set, and the tag diff
// untags every recorded key the desired map lacks. Reading a present-but-
// malformed desired value (or dropping a malformed entry) as empty therefore
// cleared every trigger / untagged every key: on a rollback or
// `drift --revert`, where the desired side is a recorded bag, `Triggers: {}`
// sent `triggers: []`. So `undefined` / `null` is ABSENT (an empty list), and
// anything else that is not a list of well-formed entries is MALFORMED. A
// malformed DESIRED side is refused before any call; a malformed RECORDED side
// is applied ADD-only (see `update`).

export type RepoListKind = 'Triggers' | 'Tags';
export type RepoListSide = 'desired' | 'recorded';

export type RepoListRead =
  | { kind: 'list'; items: Record<string, unknown>[] }
  // `onlySecret`: well-shaped, and malformed ONLY because an identity member
  // holds a dynamic reference or its mask.
  | { kind: 'malformed'; onlySecret: boolean };

export const REPO_LIST_WHAT: Record<RepoListKind, string> = {
  Triggers: 'triggers with a Name, a string DestinationArn and list-valued Events / Branches',
  Tags: 'tags with a string Key',
};

function isScalar(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Absent, or a list of scalars (coerced to strings on the wire). */
function isScalarList(value: unknown): boolean {
  return value == null || (Array.isArray(value) && value.every(isScalar));
}

/**
 * An entry is checked for what a removal or an empty reading turns on: its
 * identity (a trigger's `Name` and `DestinationArn`, a tag's `Key`) and a
 * trigger's `Events` / `Branches`, whose empty reading means ALL branches.
 * Scalar values (`CustomData`, a tag `Value`) keep their existing coercion.
 *
 * `side` matters for identity members only. A DESIRED one holding a dynamic
 * reference or its mask names nothing CodeCommit holds, so it is malformed. A
 * RECORDED one is what cdkd writes for a value that came from a secret (cdkd
 * keeps the reference in state): it is read, and only differs from the desired
 * side.
 */
function isWellFormedRepoEntry(
  kind: RepoListKind,
  entry: unknown,
  side: RepoListSide,
  ignoreSecrets = false
): boolean {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
  const e = entry as Record<string, unknown>;
  // A trigger `Name` is coerced like the rest (`scalarToString`), so a number
  // names a trigger too.
  const identity = kind === 'Tags' ? [e['Key']] : [scalarToString(e['Name']), e['DestinationArn']];
  if (!identity.every(isNonEmptyString)) return false;
  if (side === 'desired' && !ignoreSecrets && identity.some((v) => holdsSecretDerivedEntry(v))) {
    return false;
  }
  return kind === 'Tags' || (isScalarList(e['Events']) && isScalarList(e['Branches']));
}

/** Read one list property; ABSENT (`undefined` / `null`) reads as the empty list. */
export function readRepoList(kind: RepoListKind, value: unknown, side: RepoListSide): RepoListRead {
  if (value === undefined || value === null) return { kind: 'list', items: [] };
  if (Array.isArray(value) && value.every((e) => isWellFormedRepoEntry(kind, e, side))) {
    return { kind: 'list', items: value as Record<string, unknown>[] };
  }
  return {
    kind: 'malformed',
    onlySecret:
      Array.isArray(value) && value.every((e) => isWellFormedRepoEntry(kind, e, side, true)),
  };
}
