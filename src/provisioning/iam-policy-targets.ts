/**
 * How an IAM principal list (`Roles`, `Users`, `Groups`) is read before cdkd
 * addresses each name (go-to-k/cdkd#3878). A LEAF with no imports, shared by
 * every `IAMPolicyProvider` method that addresses a principal by name, by
 * `cdkd export`'s IAM::Policy pre-delete, and by the `AWS::IAM::ManagedPolicy`,
 * `AWS::IAM::InstanceProfile`, `AWS::IAM::User` (`Groups`) and
 * `AWS::IAM::UserToGroupAddition` (`Users`) arms (go-to-k/cdkd#3906,
 * go-to-k/cdkd#3888), so they agree on which list values are well-formed.
 * (What each does with a well-formed EMPTY list, or a legacy
 * `<policyName>:<roleName>` id with no list, is still its own call.)
 *
 * The record is read unvalidated. Both deletes used to cast the value to
 * `string[]` and iterate it, so a string was walked character by character —
 * `Roles: "AdminRole"` issued `DeleteRolePolicy` for roles `A`, `d`, `m`, ...,
 * removing a same-named inline policy from any one-letter role and never
 * touching `AdminRole` — and a `{}` threw mid-loop after earlier targets were
 * already detached. A caller refuses a `malformed` list before any AWS call.
 */

/**
 * An IAM role, user or group NAME: IAM's own character set, and at most 128
 * characters (AWS caps a group name at 128, a role or user name at 64). A
 * recorded entry outside it is not a principal name, so the list holding it is
 * `malformed` rather than handed to `Delete*Policy`.
 */
export const IAM_PRINCIPAL_NAME = /^[\w+=,.@-]{1,128}$/;

/** What {@link readRecordedPrincipals} found for one kind. */
export type RecordedPrincipals =
  | { kind: 'absent' }
  | { kind: 'names'; names: string[] }
  | { kind: 'malformed'; detail: string };

/**
 * Read one recorded principal list.
 *
 * - `undefined` or `null` is ABSENT: `null` is what a hand-edited or pre-v7
 *   state file can carry, and the provider has always treated it as no list.
 *   Any OTHER falsy value (`''`, `0`, `false`) is malformed, not absent: it
 *   names no principal, and reading it as absent would hand a legacy
 *   `<policyName>:<roleName>` id's role the delete instead.
 * - A list whose every entry is an {@link IAM_PRINCIPAL_NAME} is `names`,
 *   including the EMPTY list, which a caller may read as "nothing attached".
 * - Anything else is `malformed`. `detail` names only the value's SHAPE, never
 *   its content, so a message built from it cannot echo record content.
 */
export function readRecordedPrincipals(value: unknown): RecordedPrincipals {
  if (value === undefined || value === null) return { kind: 'absent' };
  if (!Array.isArray(value)) return { kind: 'malformed', detail: `found ${typeof value}` };
  if (!value.every((v) => typeof v === 'string' && IAM_PRINCIPAL_NAME.test(v))) {
    return {
      kind: 'malformed',
      detail: `a ${value.length}-element list holding a non-name entry`,
    };
  }
  return { kind: 'names', names: value as string[] };
}

/** What {@link readPrincipalLists} found: every well-formed kind, and which kinds were not. */
export type PrincipalLists<K extends string> =
  | { lists: Record<K, string[] | undefined> }
  | { lists: Record<K, string[] | undefined>; malformed: K[]; secretDerived: K[] };

/**
 * Read several principal lists of one bag (go-to-k/cdkd#3906,
 * go-to-k/cdkd#3888), each passed as the caller's own literal read of the bag
 * (`{ Roles: properties['Roles'] }`) so the handled-property wiring walk still
 * sees which property feeds the calls. `lists` holds each well-formed kind as
 * its names (an absent one as `undefined`); when any kind is `malformed`, the
 * result also names them, and `secretDerived` names the malformed kinds holding
 * a dynamic reference or its mask anywhere in the value: cdkd keeps
 * `{{resolve:...}}` (or `***`) in state by design, so a state edit is not the
 * repair for those, and a message must not tell the user to write the name.
 */
export function readPrincipalLists<K extends string>(
  values: Record<K, unknown>
): PrincipalLists<K> {
  const lists = {} as Record<K, string[] | undefined>;
  const malformed: K[] = [];
  const secretDerived: K[] = [];
  for (const key of Object.keys(values) as K[]) {
    const value = values[key];
    const recorded = readRecordedPrincipals(value);
    if (recorded.kind === 'malformed') {
      malformed.push(key);
      if (holdsSecretDerivedEntry(value)) secretDerived.push(key);
    } else {
      lists[key] = recorded.kind === 'names' ? recorded.names : undefined;
    }
  }
  return malformed.length > 0 ? { lists, malformed, secretDerived } : { lists };
}

/** cdkd's mask (`SECRET_MASK` in `src/deployment/secret-redaction.ts`); this file is a LEAF. */
const SECRET_MASK = '***';

/**
 * A value holding a dynamic reference or cdkd's mask at ANY depth: a bare
 * string, a list entry, or a nested object or list (keys included). Also read
 * by the Auto Scaling group, Firehose, ELBv2 `Targets`, Budgets and CodeCommit
 * list reads (go-to-k/cdkd#3948, go-to-k/cdkd#3989).
 *
 * A reference is spotted anywhere in a string (`{{resolve:` cannot occur in a
 * name AWS holds). The mask is matched only as a WHOLE string, which is how
 * cdkd writes it into a record (`SECRET_MASK` replaces a leaf, it is never
 * spliced into one): a legitimate `a***b` tag key is not secret-derived.
 */
export function holdsSecretDerivedEntry(value: unknown): boolean {
  const seen = new Set<object>();
  const walk = (v: unknown, depth: number): boolean => {
    if (typeof v === 'string') return v === SECRET_MASK || v.includes('{{resolve:');
    if (typeof v !== 'object' || v === null || depth > 64 || seen.has(v)) return false;
    seen.add(v);
    if (Array.isArray(v)) return v.some((e) => walk(e, depth + 1));
    return Object.entries(v).some(([k, e]) => walk(k, depth + 1) || walk(e, depth + 1));
  };
  return walk(value, 0);
}

/**
 * `true` when every malformed kind is secret-derived, i.e. the record is
 * well-formed apart from values cdkd redacted: a provider with a LIVE source
 * for the list reads the old side from AWS instead of refusing
 * (go-to-k/cdkd#3906).
 */
export function onlySecretDerived<K extends string>(
  read: PrincipalLists<K>
): read is Extract<PrincipalLists<K>, { malformed: K[] }> {
  return 'malformed' in read && read.malformed.every((k) => read.secretDerived.includes(k));
}

/**
 * The repair sentence for a RECORDED (state-side) principal list that is not a
 * list of IAM names, without echoing any of its content. `what` is the plural
 * the kinds name, e.g. `role / group / user names`. `secretDerivedRepair` is
 * what to say about the secret-derived kinds: the provider knows whether it can
 * read them from AWS instead.
 */
export function recordedPrincipalsRepair(
  malformed: readonly string[],
  secretDerived: readonly string[],
  what: string,
  secretDerivedRepair: string
): string {
  const plain = malformed.filter((k) => !secretDerived.includes(k));
  const parts: string[] = [];
  if (plain.length > 0) {
    parts.push(
      `repair the recorded ${plain.join(' / ')} in state.json to a list of ${what} and re-run`
    );
  }
  if (secretDerived.length > 0) {
    parts.push(
      `the recorded ${secretDerived.join(' / ')} is secret-derived (cdkd keeps the dynamic ` +
        `reference or its mask in state), so do not write the name into state.json; ` +
        secretDerivedRepair
    );
  }
  return parts.join('; ');
}

/** For a provider that reads a secret-derived recorded list from AWS instead. */
export const SECRET_DERIVED_READ_LIVE =
  'cdkd reads it from IAM instead once every other list is well-formed';
