import { readPrincipalLists, recordedPrincipalsRepair } from '../../iam-policy-targets.js';

/**
 * The short `ResourceDeleteResult.reason` the no-policy-name DELETE arm
 * reports (issue [#1770](https://github.com/go-to-k/cdkd/issues/1770)).
 *
 * Rendered inline on the destroy status line, so it is the SHORT form; the full
 * remediation sentence goes out as the `logger.warn` beside it. It says "in
 * state" rather than "in physicalId" because the arm is only reached once BOTH
 * sources have been exhausted — the physicalId and `properties['PolicyName']`.
 */
export const POLICY_NAME_SKIP_REASON = 'no policy name in state — no delete issued';

/**
 * The short `ResourceDeleteResult.reason` for a record that names no principal
 * to detach the inline policy from (issue
 * [#1770](https://github.com/go-to-k/cdkd/issues/1770) review).
 *
 * Distinct from {@link POLICY_NAME_SKIP_REASON}: the policy may be perfectly
 * well named and it is the ATTACHMENT that is unknown, so pointing the user at
 * the physicalId would send them to the wrong half of the record.
 */
export const POLICY_NO_TARGET_SKIP_REASON = 'no Roles/Groups/Users in state — no delete issued';

/**
 * The short `ResourceDeleteResult.reason` for a record whose `Roles` /
 * `Groups` / `Users` is present but not a list of IAM names (go-to-k/cdkd#3878).
 * Such a value used to be cast and iterated: a string was walked character by
 * character, removing a same-named inline policy from one-letter principals
 * the record never named. It is refused before ANY call, not per kind, so a
 * record cannot be half-detached.
 */
export const POLICY_MALFORMED_TARGET_SKIP_REASON =
  'malformed Roles/Groups/Users in state — no delete issued';

/**
 * The short `ResourceDeleteResult.reason` for a destroy that resolved a
 * secret-derived principal list and found a principal the CURRENT value names
 * without this inline policy (go-to-k/cdkd#4150). The value may have rotated,
 * so the grant may still sit on a principal only the OLD value named: the
 * record is kept rather than read as deleted, which would drop the last trace
 * of it.
 */
export const POLICY_SECRET_PRINCIPAL_LACKS_GRANT_SKIP_REASON =
  // Plain prose (no `'`, no `;`): `deleteSkippedMessage` shows only such a
  // reason (go-to-k/cdkd#4265).
  'the current value of the secret names a principal that lacks this grant — the value may have rotated';

/**
 * The deploy-side caveat the skip warning in this file carries (issue
 * [#1762](https://github.com/go-to-k/cdkd/issues/1762)).
 *
 * "Repair state.json and re-run" is only true on DESTROY, where the skip KEEPS
 * the record. The same arm is ALSO reached from `deploy-engine.ts` and
 * `rollback-executor.ts`, which discard the delete result and DROP the record —
 * there the id is gone, so re-running cannot help and the resource has to be
 * removed by hand. Mirrors the caveat `compositeIdFormatMessage` already
 * carries for the composite-id family.
 */
export const DEPLOY_SKIP_CAVEAT =
  `NOTE this arm is ALSO reached from cdkd deploy. Since issue 1762 the DELETE of a resource ` +
  `removed from the template behaves like destroy — the record is KEPT and the next deploy ` +
  `re-attempts it — but a REPLACEMENT / rollback delete FAILS the resource instead ` +
  `(https://github.com/go-to-k/cdkd/issues/1762), leaving the old one untracked; there, remove the resource by hand.`;

/** An inline policy name: IAM's own character set, at most 128 characters. */
export const IAM_POLICY_NAME = /^[\w+=,.@-]{1,128}$/;

/** The three principal lists of one `AWS::IAM::Policy` bag, each ABSENT as `undefined`. */
export interface PolicyTargetLists {
  roles: string[] | undefined;
  groups: string[] | undefined;
  users: string[] | undefined;
}

export type PolicyTargetKind = 'Roles' | 'Groups' | 'Users';

/** The principals a `create()` put the inline policy on, per kind. */
export interface AttachedPrincipals {
  roles: string[];
  groups: string[];
  users: string[];
}

/** The kinds of one bag that are present but not a list of IAM names. */
export interface MalformedPolicyTargets {
  malformed: PolicyTargetKind[];
  /** The malformed kinds holding a dynamic reference or its mask (go-to-k/cdkd#3907). */
  secretDerived: PolicyTargetKind[];
  /** The well-formed kinds, as `PolicyTargetLists` would hold them. */
  wellFormed: PolicyTargetLists;
}

/**
 * Read a bag's `Roles` / `Groups` / `Users` through the shared reader
 * (go-to-k/cdkd#3878), or return the kinds that are present but not a list of
 * IAM names. Every method here that sends a `Put*Policy`, `Delete*Policy` or
 * `Get*Policy` per name reads through this, because each used to cast and
 * iterate the value: a string was walked character by character, addressing
 * one-letter principals the bag never named — a GRANT on the create / update
 * put paths (a rollback replays `update()` with a recorded bag as the desired
 * side), a detach on delete and update, and a read of another principal's
 * policy on drift.
 */
export function readPolicyTargetLists(
  bag: Record<string, unknown> | undefined
): PolicyTargetLists | MalformedPolicyTargets {
  const read = readPrincipalLists({
    Roles: bag?.['Roles'],
    Groups: bag?.['Groups'],
    Users: bag?.['Users'],
  });
  const lists = { roles: read.lists.Roles, groups: read.lists.Groups, users: read.lists.Users };
  if ('malformed' in read) {
    return { malformed: read.malformed, secretDerived: read.secretDerived, wellFormed: lists };
  }
  return lists;
}

/** The note a secret-derived kind carries: it is never repaired in state.json. */
export const SECRET_DERIVED_NOTE =
  'is secret-derived (cdkd keeps the dynamic reference or its mask in state), so do not ' +
  'write the name into state.json';

/**
 * The way out of an update refused over a secret-derived RECORDED principal
 * list (go-to-k/cdkd#3907). Writing the name into state is not it, and unlike
 * `AWS::IAM::ManagedPolicy` there is no live source to read the old side from:
 * IAM has no call listing the principals that hold one INLINE policy by name.
 * `cdkd orphan` drops just this record, and the next deploy re-attaches the
 * policy from the template (`Put*Policy` is idempotent) under the DESIRED
 * name only, so a rename (`renamed`) also leaves the old-named policy behind.
 * A record whose reference the template still spells the same way never
 * reaches this: the engine drops it from the previous side
 * (go-to-k/cdkd#4064, `withUnchangedSecretPrincipalLists`).
 */
export function policySecretDerivedRepair(renamed: boolean): string {
  return (
    'IAM has no call that lists the principals holding an inline policy, so cdkd cannot ' +
    'diff it: detach the inline policy by hand from every principal it should no longer be ' +
    'on' +
    (renamed
      ? ', and since this change renames the policy, also remove the OLD-named inline policy ' +
        'from every principal that holds it (the re-created record names only the new one)'
      : '') +
    ", then drop this record with 'cdkd orphan <constructPath>' so the next deploy " +
    're-attaches it from the template (an attachment left in place across the orphan is no ' +
    'longer tracked by cdkd). A later update proceeds only while the template spells the ' +
    'same reference and PolicyName, so a changed reference, a rename or a mask is refused ' +
    'this way again'
  );
}

/**
 * The repair clause for a malformed RECORDED side. When any kind is
 * secret-derived, the orphan route is the ONLY repair: it drops the whole
 * record, and a state.json repair of a plain kind alone would still be refused
 * over the secret-derived one. (The shared `recordedPrincipalsRepair` joins
 * both repairs, which is right for its other callers, whose secret-derived
 * route is a live read that NEEDS every other kind well-formed.)
 */
export function recordedSideRepair(targets: MalformedPolicyTargets, renamed: boolean): string {
  const { malformed, secretDerived } = targets;
  if (secretDerived.length === 0) {
    return recordedPrincipalsRepair(malformed, [], 'role / group / user names', '');
  }
  const plain = malformed.filter((k) => !secretDerived.includes(k));
  return (
    `the recorded ${secretDerived.join(' / ')} ${SECRET_DERIVED_NOTE}` +
    (plain.length > 0
      ? `, and the recorded ${plain.join(' / ')} need not be repaired there either: the ` +
        `route below drops the whole record`
      : '') +
    `; ${policySecretDerivedRepair(renamed)}`
  );
}

/**
 * The repair clauses of an `update()` refused over a malformed side, in the
 * order they must be done (go-to-k/cdkd#3907). The desired side comes FIRST:
 * both the state.json repair and the orphan route re-apply it.
 *
 * A desired side reaches this holding a dynamic reference or cdkd's mask only
 * when the TEMPLATE itself holds it: a deploy refuses a masked attribute read
 * (a `NoEcho` custom resource's `Data`) in `refuseRedactedAttributeReads`
 * before any provider call, a rollback replay re-resolves every reference and
 * refuses a masked bag in `refuseMaskedReplayBaseline`, and `drift --revert`
 * never gets here.
 */
export function refusalRepair(
  desired: PolicyTargetLists | MalformedPolicyTargets,
  recorded: PolicyTargetLists | MalformedPolicyTargets,
  renamed: boolean
): string {
  const clauses: string[] = [];
  const recordedMalformed = 'malformed' in recorded;
  if ('malformed' in desired) {
    if (desired.secretDerived.length > 0) {
      clauses.push(
        `the desired ${desired.secretDerived.join(' / ')} holds a dynamic reference or cdkd's ` +
          `mask that resolved to no names; fix that value in the template` +
          (recordedMalformed ? ' first, since the repair below re-applies it' : '')
      );
    } else if (recordedMalformed) {
      clauses.push('fix the desired side first, since the repair below re-applies it');
    }
  }
  if (recordedMalformed) {
    const repair = recordedSideRepair(recorded, renamed);
    clauses.push('malformed' in desired ? `then ${repair}` : repair);
  }
  return clauses.length > 0 ? `: ${clauses.join('; ')}` : '';
}
