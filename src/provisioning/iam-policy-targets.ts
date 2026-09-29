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
 * A value holding a dynamic reference or cdkd's mask, up to 64 levels deep (a
 * deeper value reads as NOT secret-derived; no CloudFormation list property
 * nests near that): a bare string, a list entry, or a nested object or list
 * (keys included). Also read
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

/**
 * The principal lists, per type, whose provider has NO live source for the
 * recorded side (IAM lists neither the principals holding an inline policy nor
 * which members a `UserToGroupAddition` added), so a secret-derived record
 * refuses the update unless the engine drops an unchanged reference from it
 * (go-to-k/cdkd#4064). The types with a live read (ManagedPolicy,
 * InstanceProfile, User `Groups`) keep their ADD-only live path.
 */
export const RESOLVED_PREVIOUS_PRINCIPAL_KEYS: Readonly<Record<string, readonly string[]>> = {
  'AWS::IAM::Policy': ['Roles', 'Groups', 'Users'],
  'AWS::IAM::UserToGroupAddition': ['Users'],
};

/**
 * The property that NAMES what a principal is attached to, per type. A drop is
 * only sound while it is unchanged: the provider removes the attachment from
 * the OLD target only for principals the recorded side still lists, so a
 * dropped principal would keep a membership in the old group, or the
 * old-named inline policy, untracked. A change there keeps the refusal, and
 * so does a SECRET-DERIVED target, whose recorded reference or mask cannot
 * show whether it changed.
 */
const ATTACHMENT_TARGET_KEY: Readonly<Record<string, string>> = {
  'AWS::IAM::Policy': 'PolicyName',
  'AWS::IAM::UserToGroupAddition': 'GroupName',
};

/** A value holding cdkd's mask anywhere (a mask says nothing about the value it hides). */
function holdsMask(value: unknown): boolean {
  if (typeof value === 'string') return value === SECRET_MASK;
  if (Array.isArray(value)) return value.some(holdsMask);
  if (typeof value === 'object' && value !== null) return Object.values(value).some(holdsMask);
  return false;
}

/**
 * The attachment target the PROVIDER derives for the recorded side, where it
 * does not read it from the recorded property: `IAMPolicyProvider.update`
 * takes the old policy name from the physical id (`<name>` or the legacy
 * `<name>:<role>`). `undefined` means the provider reads the recorded property,
 * which the target comparison already covers. A record with no `PolicyName`
 * (a generated name) never equals it and stays refused: the fail-safe side,
 * and CloudFormation requires `PolicyName` on this type.
 */
function providerRecordedTarget(resourceType: string, physicalId: string): string | undefined {
  if (resourceType !== 'AWS::IAM::Policy') return undefined;
  return physicalId.includes(':') ? physicalId.split(':')[0]! : physicalId;
}

/**
 * The previous side an `update()` of one of {@link RESOLVED_PREVIOUS_PRINCIPAL_KEYS}'
 * types is handed (go-to-k/cdkd#4064). State keeps a secret-derived principal
 * list entry as its `{{resolve:...}}` expression, which is not an IAM name, so
 * the provider refused every in-place update after the first deploy.
 *
 * A recorded entry that is an expression the desired side's REDACTED list also
 * holds is a reference the template has not changed, and the desired side
 * names that principal too, so the provider never removes it. The entry is
 * DROPPED from the recorded list: both providers then treat it as newly
 * desired, and `Put*Policy` / `AddUserToGroup` are idempotent. Dropping rather
 * than substituting the resolved name matters after a ROTATION: a substituted
 * name reads as already attached, and the UserToGroupAddition provider adds
 * only users the previous side lacks, so the user the new value names was
 * never added. And no plaintext enters the previous side at all.
 *
 * ALL OR NOTHING: when any secret-derived entry of any principal list cannot
 * be dropped, nothing is, so the provider's refusal and the caller's warning
 * never disagree. What stays refused, deliberately: a reference the template
 * RE-POINTED or removed (its principal would never be detached); a changed,
 * secret-derived or physical-id-disagreeing attachment target (`GroupName` /
 * `PolicyName`: the dropped principal would keep the OLD one); and a recorded
 * MASK (`***` equal to `***` says nothing about the value, go-to-k/cdkd#3662).
 *
 * The residual is a rotation under an unchanged reference: a principal only
 * the OLD value named keeps the policy or membership, and has to be removed by
 * hand (before this, the same principal kept it too, behind a refusal).
 * `dropped` names the keys rewritten, so the caller can say so (kinds only,
 * never names). The returned bag is in memory only.
 */
export function withUnchangedSecretPrincipalLists(
  resourceType: string,
  physicalId: string,
  previous: Record<string, unknown>,
  desiredRedacted: Record<string, unknown>
): { previous: Record<string, unknown>; dropped: string[] } {
  const untouched = { previous, dropped: [] as string[] };
  const keys = Object.prototype.hasOwnProperty.call(RESOLVED_PREVIOUS_PRINCIPAL_KEYS, resourceType)
    ? RESOLVED_PREVIOUS_PRINCIPAL_KEYS[resourceType]!
    : [];
  if (keys.length === 0) return untouched;
  const target = ATTACHMENT_TARGET_KEY[resourceType]!;
  const recordedTarget = previous[target];
  const derivedTarget = providerRecordedTarget(resourceType, physicalId);
  if (
    // A secret-derived target (a reference, or the mask) redacts to the same
    // string whatever it names, so equality proves nothing about it.
    holdsSecretDerivedEntry(recordedTarget) ||
    JSON.stringify(recordedTarget) !== JSON.stringify(desiredRedacted[target]) ||
    // The provider's own reading of the old target must be the same one.
    (derivedTarget !== undefined && recordedTarget !== derivedTarget)
  ) {
    return untouched;
  }
  const rewritten: Array<[string, unknown[]]> = [];
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(previous, key)) continue;
    const recorded = previous[key];
    if (!holdsSecretDerivedEntry(recorded)) continue;
    const redacted = desiredRedacted[key];
    if (!Array.isArray(recorded) || !Array.isArray(redacted) || holdsMask(recorded)) {
      return untouched;
    }
    const kept: unknown[] = [];
    for (const entry of recorded) {
      if (!holdsSecretDerivedEntry(entry)) {
        kept.push(entry);
        continue;
      }
      if (typeof entry !== 'string' || !redacted.includes(entry)) return untouched;
    }
    rewritten.push([key, kept]);
  }
  if (rewritten.length === 0) return untouched;
  const out: Record<string, unknown> = { ...previous };
  for (const [key, kept] of rewritten) out[key] = kept;
  return { previous: out, dropped: rewritten.map(([key]) => key) };
}
