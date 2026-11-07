import { holdsSecretDerivedEntry } from '../../iam-policy-targets.js';

/**
 * A SUPERSET of an RDS DB cluster or DB instance identifier: a letter, then up
 * to 62 letters, digits or hyphens, at RDS's 63-character cap. RDS also forbids
 * a trailing hyphen and `--`, which this admits (AWS rejects those itself). An
 * entry outside it names no proxy target.
 */
const RDS_TARGET_IDENTIFIER = /^[A-Za-z][A-Za-z0-9-]{0,62}$/;

/** The two target lists, each passed as the caller's own read of its bag. */
type TargetListValues = {
  DBClusterIdentifiers: unknown;
  DBInstanceIdentifiers: unknown;
};
export type TargetListKind = keyof TargetListValues;

/** What {@link readTargetLists} found: every well-formed list, and which were not. */
interface TargetLists {
  /** A well-formed list as its identifiers; an absent or malformed one as `[]`. */
  lists: Record<TargetListKind, string[]>;
  malformed: TargetListKind[];
  /** The malformed kinds holding a dynamic reference or cdkd's mask. */
  secretDerived: TargetListKind[];
}

/**
 * Read `DBClusterIdentifiers` / `DBInstanceIdentifiers` before any call names a
 * target (go-to-k/cdkd#3945). `undefined` / `null` is absent (no targets); a
 * list whose every entry is an {@link RDS_TARGET_IDENTIFIER} is itself; ANY
 * other value is malformed. The lists used to be cast to `string[]`, so a
 * string was walked character by character: `new Set("prod-cluster")` made
 * `update()` deregister the real target and register `p`, `r`, `o`, ... —
 * one-letter identifiers an unrelated DB instance can carry. `create()` and
 * `delete()` handed the value to the SDK, whose serializer sends NO list for a
 * string, so the call named no target at all. A caller refuses a malformed
 * list before any AWS call.
 */
export function readTargetLists(values: TargetListValues): TargetLists {
  const lists: Record<TargetListKind, string[]> = {
    DBClusterIdentifiers: [],
    DBInstanceIdentifiers: [],
  };
  const malformed: TargetListKind[] = [];
  const secretDerived: TargetListKind[] = [];
  for (const kind of ['DBClusterIdentifiers', 'DBInstanceIdentifiers'] as const) {
    const value = values[kind];
    if (value === undefined || value === null) continue;
    if (
      Array.isArray(value) &&
      value.every((v) => typeof v === 'string' && RDS_TARGET_IDENTIFIER.test(v))
    ) {
      lists[kind] = value as string[];
      continue;
    }
    malformed.push(kind);
    if (holdsSecretDerivedEntry(value)) secretDerived.push(kind);
  }
  return { lists, malformed, secretDerived };
}

/**
 * What an `update()` refusal says about a secret-derived recorded list: it is
 * refused only while a DESIRED list is malformed too, since otherwise
 * `update()` reads the recorded side from the proxy instead.
 */
export const SECRET_DERIVED_TARGETS_REPAIR =
  'cdkd reads it from the proxy instead once the desired lists are well-formed';

/**
 * A recorded or desired `DBProxyName`, or `undefined` when it is not a
 * non-empty string. Never cast: the SDK sends `{}` as `[object Object]`, whose
 * NotFound a delete would read as "already gone".
 */
export function readProxyName(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * The entries of `from` absent from `against`, compared case-insensitively:
 * RDS stores identifiers lowercased, so `MyCluster` and `mycluster` name one
 * target, and a case-only difference must not deregister and re-register it.
 */
export function missingIdentifiers(from: readonly string[], against: readonly string[]): string[] {
  const seen = new Set(against.map((id) => id.toLowerCase()));
  const out: string[] = [];
  for (const id of from) {
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

/**
 * The `ResourceDeleteResult.reason` for a delete whose recorded target list is
 * malformed. Fixed wording: a reason is classified by SUBSTRING
 * (`.claude/rules/provider-delete-path.md`).
 */
export const MALFORMED_TARGETS_SKIP_REASON =
  'malformed target list in state — no target deregistered';

/** The same, for a recorded `TargetGroupName` other than `default`. */
export const NON_DEFAULT_GROUP_SKIP_REASON =
  'target group name other than default in state — no target deregistered';

export function withoutKey(bag: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _dropped, ...rest } = bag;
  return rest;
}
