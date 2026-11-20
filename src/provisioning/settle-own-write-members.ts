/**
 * The post-write baseline capture (`ReadCurrentStateContext.afterOwnWrite`,
 * go-to-k/cdkd#6609) for a resource read that carries SEVERAL members a
 * separate call writes: an IAM principal's inline policies, attached managed
 * policies, groups and permissions boundary, a managed policy's attachments, a
 * security group's rule lists. Each declared member that disagrees is settled
 * on its own, by {@link settleDeclaredMember}, so one lagging member never
 * re-reads the rest.
 *
 * A LIST member is settled once every declared entry reads back. An entry the
 * template does not declare never holds the capture: it can be another
 * resource's (a sibling `AWS::IAM::ManagedPolicy` attaching itself, a
 * `UserToGroupAddition`, a standalone rule), which the capture does not always
 * strip and the drift compare does (go-to-k/cdkd#6614); or an out-of-band add;
 * or a removal not yet visible, the undeclared-member residual of the earlier
 * slices. A list still unsettled after the schedule keeps every read entry and
 * gains each declared entry still unmatched, at its declared position
 * ({@link mergeDeclaredEntries}; the read reconciles to declared order, then
 * its own extras): the write just succeeded, and recording the list without
 * it would let `drift --revert` remove it. Entries match on a key both
 * spellings share (names, ARNs, policy names, `sgSettleRuleKey`), so an entry
 * is never recorded twice; a declared entry that key cannot match is never
 * added.
 */
import {
  type MemberRead,
  policyDocumentMatchesDeclared,
  settleDeclaredMember,
} from './settle-after-own-write.js';

/** One declared member of a resource read, settled on the post-write capture. */
export interface OwnWriteMember<T> {
  /** The result key the member is recorded under. */
  key: string;
  /** The declared value, in the read's shape (what a kept-declared baseline records). */
  declared: T;
  /** Whether a read value is the declared one. */
  matches: (value: T) => boolean;
  /** Whether a read value means "none set yet" (the declared value is kept after the schedule). */
  isAbsent?: (value: T) => boolean;
  /** For a list: what to record when the schedule ends on `newest` without the declared value. */
  whenUnsettled?: (newest: T) => T;
  /** One read of the member alone; throws what the call throws. */
  read: () => Promise<MemberRead<T>>;
}

/**
 * Settle every member of `members` that the first read (`result`) shows
 * disagreeing, all at once, and write each outcome back into `result`. A
 * member the first read did not record is left as it is (its read failed, and
 * the resource read already decided what that records). A member that agrees
 * makes no call. `unsettled` names the member key once its schedule ends
 * without the declared value.
 */
export async function settleOwnWriteMembers(
  result: Record<string, unknown>,
  members: readonly OwnWriteMember<unknown>[],
  delaysMs: readonly number[],
  unsettled: (memberKey: string) => void
): Promise<void> {
  await Promise.all(
    members.map(async (member) => {
      if (!Object.prototype.hasOwnProperty.call(result, member.key)) return;
      const classify = (answer: MemberRead<unknown>): MemberRead<unknown> =>
        typeof answer === 'object' &&
        !member.matches(answer.value) &&
        member.isAbsent?.(answer.value) === true
          ? 'absent'
          : answer;
      let spent = false;
      const settled = await settleDeclaredMember(
        classify({ value: result[member.key] }),
        async () => classify(await member.read()),
        member.matches,
        member.declared,
        delaysMs,
        () => {
          spent = true;
          unsettled(member.key);
        }
      );
      if (typeof settled !== 'object') return;
      result[member.key] =
        spent && member.whenUnsettled !== undefined
          ? member.whenUnsettled(settled.value)
          : settled.value;
    })
  );
}

/** The declared list of strings (ARNs, names), or `undefined` when the member declares none. */
export function declaredStringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? (value as string[])
    : undefined;
}

/**
 * `read` with each declared entry no read entry matches inserted: declared
 * order first (a matched entry as READ, an unmatched one as `readbackOf`
 * gives it, or left out when that is `undefined`), then the read entries the
 * template does not declare, in read order.
 */
export function mergeDeclaredEntries<D>(
  read: unknown,
  declared: readonly D[],
  sameEntry: (readEntry: unknown, declaredEntry: D) => boolean,
  readbackOf: (declaredEntry: D) => unknown
): unknown[] {
  const entries = Array.isArray(read) ? [...(read as unknown[])] : [];
  const used = new Set<number>();
  const out: unknown[] = [];
  for (const entry of declared) {
    const index = entries.findIndex((value, i) => !used.has(i) && sameEntry(value, entry));
    if (index >= 0) {
      used.add(index);
      out.push(entries[index]);
      continue;
    }
    const added = readbackOf(entry);
    if (added !== undefined) out.push(added);
  }
  return [...out, ...entries.filter((_, i) => !used.has(i))];
}

/**
 * A declared list of strings as a member: settled once every declared entry
 * reads back (the module comment has the unsettled outcomes).
 */
export function stringListMember(
  key: string,
  declared: readonly string[],
  read: () => Promise<MemberRead<unknown>>
): OwnWriteMember<unknown> {
  const missing = (value: unknown): string[] => {
    const have = new Set(Array.isArray(value) ? (value as unknown[]) : []);
    return declared.filter((entry) => !have.has(entry));
  };
  return {
    key,
    declared,
    matches: (value) => Array.isArray(value) && missing(value).length === 0,
    whenUnsettled: (newest) =>
      mergeDeclaredEntries(
        newest,
        declared,
        (entry, want) => entry === want,
        (want) => want
      ),
    read,
  };
}

/** A declared inline policy, its document in the read's (parsed) shape. */
export interface DeclaredInlinePolicy {
  PolicyName: string;
  PolicyDocument: unknown;
}

/**
 * The declared inline `Policies` in the read's shape (each document parsed
 * when it is a JSON string), or `undefined` when the member declares none or
 * an entry is not a named policy.
 */
export function declaredInlinePolicies(value: unknown): DeclaredInlinePolicy[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: DeclaredInlinePolicy[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const name = (entry as Record<string, unknown>)['PolicyName'];
    let document = (entry as Record<string, unknown>)['PolicyDocument'];
    if (typeof name !== 'string' || name === '') return undefined;
    if (typeof document === 'string') {
      try {
        document = JSON.parse(document) as unknown;
      } catch {
        // kept as declared
      }
    }
    out.push({ PolicyName: name, PolicyDocument: document });
  }
  return out;
}

/**
 * The declared inline `Policies` as a member: settled once every declared
 * policy reads back under its name with its document (IAM spellings folded).
 */
export function inlinePoliciesMember(
  declared: readonly DeclaredInlinePolicy[],
  read: () => Promise<MemberRead<unknown>>
): OwnWriteMember<unknown> {
  const entries = (value: unknown): Array<Record<string, unknown>> =>
    Array.isArray(value)
      ? (value as unknown[]).filter(
          (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null
        )
      : [];
  const byName = (value: unknown, name: string): Record<string, unknown> | undefined =>
    entries(value).find((entry) => entry['PolicyName'] === name);
  return {
    key: 'Policies',
    declared,
    matches: (value) =>
      Array.isArray(value) &&
      declared.every((policy) => {
        const entry = byName(value, policy.PolicyName);
        return (
          entry !== undefined &&
          policyDocumentMatchesDeclared(entry['PolicyDocument'], policy.PolicyDocument)
        );
      }),
    // A declared name read with another document stays as read.
    whenUnsettled: (newest) =>
      mergeDeclaredEntries(
        newest,
        declared,
        (entry, want) =>
          typeof entry === 'object' &&
          entry !== null &&
          (entry as Record<string, unknown>)['PolicyName'] === want.PolicyName,
        (want) => ({ PolicyName: want.PolicyName, PolicyDocument: want.PolicyDocument })
      ),
    read,
  };
}

/**
 * The drift heal's STRICT test for a string list (go-to-k/cdkd#6609): the
 * live list holds exactly the declared entries, as a set. A superset (an
 * out-of-band attach) or a subset (an out-of-band detach) is not.
 */
export function stringListIsDeclared(live: unknown, declared: readonly string[]): boolean {
  if (!Array.isArray(live) || !live.every((entry) => typeof entry === 'string')) return false;
  const have = new Set(live as string[]);
  const want = new Set(declared);
  return have.size === want.size && [...want].every((entry) => have.has(entry));
}

/**
 * The drift heal's STRICT test for inline `Policies`: the live policy names
 * are exactly the declared ones, each with its declared document (IAM
 * spellings folded, as the settle compares).
 */
export function inlinePoliciesAreDeclared(
  live: unknown,
  declared: readonly DeclaredInlinePolicy[]
): boolean {
  if (!Array.isArray(live)) return false;
  const names = (live as unknown[]).map((entry) =>
    typeof entry === 'object' && entry !== null
      ? (entry as Record<string, unknown>)['PolicyName']
      : undefined
  );
  if (!names.every((name): name is string => typeof name === 'string')) return false;
  if (
    !stringListIsDeclared(
      names,
      declared.map((policy) => policy.PolicyName)
    )
  )
    return false;
  return declared.every((policy) =>
    (live as Array<Record<string, unknown>>).some(
      (entry) =>
        entry['PolicyName'] === policy.PolicyName &&
        policyDocumentMatchesDeclared(entry['PolicyDocument'], policy.PolicyDocument)
    )
  );
}

/** The member re-reads {@link principalOwnWriteMembers} settles with, each the member's own call. */
export interface PrincipalMemberReads {
  boundary?: () => Promise<MemberRead<unknown>>;
  managedPolicyArns: () => Promise<MemberRead<unknown>>;
  policies: () => Promise<MemberRead<unknown>>;
  groups?: () => Promise<MemberRead<unknown>>;
}

/**
 * The IAM principal members (role, user, group) a post-write capture settles:
 * `PermissionsBoundary` (read as `''` when none is set), `ManagedPolicyArns`,
 * inline `Policies` and, for a user, `Groups` — each only when the template
 * declares it, and each from its own re-read.
 */
export function principalOwnWriteMembers(
  properties: Record<string, unknown>,
  reads: PrincipalMemberReads
): OwnWriteMember<unknown>[] {
  const members: OwnWriteMember<unknown>[] = [];
  const boundary = properties['PermissionsBoundary'];
  if (reads.boundary !== undefined && typeof boundary === 'string' && boundary !== '') {
    members.push({
      key: 'PermissionsBoundary',
      declared: boundary,
      matches: (value) => value === boundary,
      isAbsent: (value) => value === '',
      read: reads.boundary,
    });
  }
  const lists: Array<[string, (() => Promise<MemberRead<unknown>>) | undefined]> = [
    ['ManagedPolicyArns', reads.managedPolicyArns],
    ['Groups', reads.groups],
  ];
  for (const [key, read] of lists) {
    const declared = declaredStringList(properties[key]);
    if (read !== undefined && declared !== undefined) {
      members.push(stringListMember(key, declared, read));
    }
  }
  const policies = declaredInlinePolicies(properties['Policies']);
  if (policies !== undefined) members.push(inlinePoliciesMember(policies, reads.policies));
  return members;
}
