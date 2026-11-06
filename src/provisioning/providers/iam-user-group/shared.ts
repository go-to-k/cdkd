import { ProvisioningError } from '../../../utils/error-handler.js';
import { generateResourceNameWithFallback } from '../../resource-name.js';
import {
  onlySecretDerived,
  readPrincipalLists,
  recordedPrincipalsRepair,
} from '../../iam-policy-targets.js';

/** The two types whose identity this provider answers (go-to-k/cdkd#4606). */
export type UserOrGroupType = 'AWS::IAM::User' | 'AWS::IAM::Group';

/**
 * An IAM user NAME (1-64) or group NAME (1-128) of `A-Z a-z 0-9 + = , . @ _ -`,
 * IAM's `UserName` / `GroupName` pattern: the physical id this provider
 * records for each. The identity answers (`isSameResource`,
 * `resourceIdentity`) refuse anything else, an ARN included: this provider
 * never records one.
 */
export function isUserOrGroupName(resourceType: UserOrGroupType, id: string): boolean {
  return resourceType === 'AWS::IAM::User'
    ? /^[\w+=,.@-]{1,64}$/.test(id)
    : /^[\w+=,.@-]{1,128}$/.test(id);
}

export function isUserOrGroupType(resourceType: string): resourceType is UserOrGroupType {
  return resourceType === 'AWS::IAM::User' || resourceType === 'AWS::IAM::Group';
}

/**
 * go-to-k/cdkd#4606 / #4655: a user's or group's identity token is its
 * `UserId` (`AIDA…`) or `GroupId` (`AGPA…`). IAM assigns it at `CreateUser` /
 * `CreateGroup` and never changes it; one deleted and re-created under the
 * same name gets another (IAM User Guide, "IAM identifiers" → "Unique
 * identifiers"; the `iam-user-group-fix-forward-orphan` fixture measures the
 * re-create). The wiring calls a CREATE makes afterwards (boundary, login
 * profile, policies, group membership) do not touch it. `undefined` for a
 * missing or empty one.
 */
export function userOrGroupIdentityToken(id: string | undefined): string | undefined {
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/**
 * What `UpdateLoginProfile` throws while IAM cannot modify the profile yet, the
 * SDK's documented case. Not observed on real IAM (2026-11-03): 15 updates
 * within 5 `CreateLoginProfile` rounds all succeeded.
 */
export const PROFILE_SETTLING_ERROR = 'EntityTemporarilyUnmodifiableException';

/**
 * Carries `concurrent update operation`, a phrase of the retryable table, so
 * the engine replays the create (go-to-k/cdkd#5660).
 */
export const LOGIN_PROFILE_SETTLING_MESSAGE =
  'IAM cannot modify the login profile yet: a concurrent update operation has not settled';

/**
 * The short `ResourceDeleteResult.reason` the no-properties
 * `AWS::IAM::UserToGroupAddition` DELETE arm reports (issue
 * [#1770](https://github.com/go-to-k/cdkd/issues/1770)).
 *
 * Rendered inline on the destroy status line, so it is the SHORT form; the full
 * remediation sentence goes out as the `logger.warn` beside it. It names the
 * MEMBERSHIP rather than the resource because that is what survives — the
 * resource itself is metadata, the users staying in the group is the residue.
 */
export const MEMBERSHIP_NO_PROPERTIES_SKIP_REASON =
  'no properties in state — group membership not removed';

/**
 * Sibling of {@link MEMBERSHIP_NO_PROPERTIES_SKIP_REASON} for the arm where the
 * record has properties but is missing `GroupName` or `Users` — both REQUIRED
 * by the CloudFormation schema, so their absence is corruption, not an
 * empty-but-valid membership list.
 */
export const MEMBERSHIP_MISSING_FIELDS_SKIP_REASON =
  'GroupName/Users missing from state — membership not removed';

/**
 * Sibling of {@link MEMBERSHIP_MISSING_FIELDS_SKIP_REASON} for a record whose
 * `Users` is present but not a list of IAM user names (go-to-k/cdkd#3888). A
 * cast iterated a string by character, removing one-letter users from the
 * group and never the recorded one; it is refused before any call.
 */
export const MEMBERSHIP_MALFORMED_USERS_SKIP_REASON =
  'malformed Users in state — membership not removed';

/**
 * Sibling of {@link MEMBERSHIP_MALFORMED_USERS_SKIP_REASON} for a destroy that
 * resolved a secret-derived `Users` and found a user the CURRENT value names
 * outside the group (go-to-k/cdkd#4150). The value may have rotated, so a user
 * only the OLD value named may still be a member: the record is kept rather
 * than read as deleted, which would drop the last trace of that membership.
 */
export const MEMBERSHIP_SECRET_USER_NOT_MEMBER_SKIP_REASON =
  // Plain prose (no `'`, no `;`): `deleteSkippedMessage` shows only such a
  // reason (go-to-k/cdkd#4265).
  'the current value of the secret names a user outside the group — the value may have rotated';

/**
 * What an `AWS::IAM::UserToGroupAddition` update or delete says about a
 * secret-derived recorded `Users`: it has no live source (IAM lists a group's
 * members, not which of them this resource added), so cdkd cannot diff it, and
 * editing state is not the repair. `cdkd orphan` drops just this record, and
 * the next deploy re-creates it from the template (`AddUserToGroup` is
 * idempotent). An unchanged reference never reaches this: the engine drops
 * it from the previous side (go-to-k/cdkd#4064).
 */
export const MEMBERSHIP_SECRET_DERIVED_REPAIR =
  'cdkd cannot diff it, so make the membership change by hand, then drop this record with ' +
  "'cdkd orphan <constructPath>' so the next deploy re-creates it from the template. A " +
  'later update proceeds only while the template spells the same reference and GroupName, so ' +
  'a changed reference, another group or a mask is refused this way again';

/**
 * Read a desired and a recorded principal list, refusing either when it is not
 * a list of IAM names, before any write (go-to-k/cdkd#3888). The previous side
 * is the state record, and a rollback revert or `drift --revert` replays
 * `update()` with a recorded bag as the desired side. With `readLive`, a
 * recorded list cdkd redacted (a dynamic reference or its mask) is read from
 * IAM instead when the desired side is well-formed (go-to-k/cdkd#3906) — ADD-
 * only: IAM's list also holds memberships made elsewhere (a
 * `UserToGroupAddition`, another stack, by hand), so the returned previous side
 * is IAM's list narrowed to the desired names, and nothing is removed on its
 * evidence. `unmatchedKinds` names the kinds read that way where IAM holds a
 * name the desired side does not, for the caller's warning.
 */
export async function readPrincipalSides<K extends string>(opts: {
  desired: Record<K, unknown>;
  recorded: Record<K, unknown>;
  subject: string;
  nothingDone: string;
  names: string;
  secretDerivedRepair: string;
  readLive?: () => Promise<Record<K, string[]>>;
  resourceType: string;
  logicalId: string;
  physicalId: string;
}): Promise<{
  next: Record<K, string[] | undefined>;
  prev: Record<K, string[] | undefined>;
  unmatchedKinds: K[];
}> {
  const { subject, nothingDone, names, resourceType, logicalId, physicalId } = opts;
  const next = readPrincipalLists(opts.desired);
  let prev = readPrincipalLists(opts.recorded);
  const unmatchedKinds: K[] = [];
  if (opts.readLive && !('malformed' in next) && onlySecretDerived(prev)) {
    const kinds = prev.malformed.join(' / ');
    let live: Record<K, string[]>;
    try {
      live = await opts.readLive();
    } catch (error) {
      throw new ProvisioningError(
        `the recorded ${kinds} of ${subject} ${logicalId} is secret-derived and could not be ` +
          `read from IAM — ${nothingDone}`,
        resourceType,
        logicalId,
        physicalId,
        error instanceof Error ? error : undefined
      );
    }
    const lists = { ...prev.lists };
    for (const kind of prev.malformed) {
      const desired = next.lists[kind] ?? [];
      lists[kind] = live[kind].filter((name) => desired.includes(name));
      if (live[kind].some((name) => !desired.includes(name))) unmatchedKinds.push(kind);
    }
    prev = { lists };
  }
  if ('malformed' in next || 'malformed' in prev) {
    const which = [
      ...('malformed' in next ? next.malformed.map((k) => `desired ${k}`) : []),
      ...('malformed' in prev ? prev.malformed.map((k) => `recorded ${k}`) : []),
    ];
    throw new ProvisioningError(
      `${which.join(' / ')} of ${subject} ${logicalId} is not a list of ${names} — ` +
        nothingDone +
        ('malformed' in prev
          ? `: ${recordedPrincipalsRepair(
              prev.malformed,
              prev.secretDerived,
              names,
              opts.secretDerivedRepair
            )}`
          : ''),
      resourceType,
      logicalId,
      physicalId
    );
  }
  return { next: next.lists, prev: prev.lists, unmatchedKinds };
}

/**
 * The deploy-side caveat both `UserToGroupAddition` skip warnings carry (issue
 * [#1762](https://github.com/go-to-k/cdkd/issues/1762)).
 *
 * "Repair state.json and re-run" is only true on DESTROY, where the skip KEEPS
 * the record. The same arms are ALSO reached from `deploy-engine.ts` and
 * `rollback-executor.ts`, which discard the delete result and DROP the record —
 * there the id is gone, so re-running cannot help and the memberships have to
 * be removed by hand. Mirrors the caveat `compositeIdFormatMessage` already
 * carries for the composite-id family.
 */
export const DEPLOY_SKIP_CAVEAT =
  `NOTE this arm is ALSO reached from cdkd deploy. Since issue 1762 the DELETE of a resource ` +
  `removed from the template behaves like destroy — the record is KEPT and the next deploy ` +
  `re-attempts it — but a REPLACEMENT / rollback delete FAILS the resource instead ` +
  `(https://github.com/go-to-k/cdkd/issues/1762), leaving the old one untracked; there, remove the memberships by hand.`;

/**
 * `generateResourceNameWithFallback`'s `maxLength` for a User / Group name:
 * ONE spelling, shared by the create arms and {@link derivedNamePairs}, so the
 * name a needle is built from cannot drift from the name the create sends.
 */
export const USER_NAME_MAX_LENGTH = 64;
export const GROUP_NAME_MAX_LENGTH = 128;

/**
 * The IAM path a user or group bag declares, read as `createUser` /
 * `createGroup` send it: an unset or empty `Path` is IAM's default `/`.
 */
export function iamPathOf(value: unknown): string {
  return (value as string | undefined) || '/';
}

/**
 * `[template value, physical name derived from it]` for the types whose name
 * `generateResourceNameWithFallback` rewrites (issue #2177), with the SAME
 * options `createUser` / `createGroup` use (the constants above).
 * `UserToGroupAddition` names nothing.
 */
export function derivedNamePairs(
  resourceType: string,
  logicalId: string,
  properties: Record<string, unknown>
): Array<readonly [unknown, string]> {
  const spec =
    resourceType === 'AWS::IAM::User'
      ? { key: 'UserName', maxLength: USER_NAME_MAX_LENGTH }
      : resourceType === 'AWS::IAM::Group'
        ? { key: 'GroupName', maxLength: GROUP_NAME_MAX_LENGTH }
        : undefined;
  if (!spec) return [];
  const raw = properties[spec.key];
  // Only a string can be a recorded secret, and deriving from anything else
  // could throw inside the generator on a path (`update()`) that never derived
  // a name before.
  if (typeof raw !== 'string') return [];
  return [[raw, generateResourceNameWithFallback(raw, logicalId, { maxLength: spec.maxLength })]];
}
