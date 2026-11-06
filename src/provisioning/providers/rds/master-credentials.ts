import { isDeepStrictEqual } from 'node:util';
import { type MasterUserAuthenticationType } from '@aws-sdk/client-rds';
import type { UpdateContext } from '../../../types/resource.js';
import { dynamicReferenceTokens, SECRET_MASK } from '../../../deployment/secret-redaction.js';
import { instanceValueChanged } from './instance-members.js';

/**
 * go-to-k/cdkd#5153: whether an update changes top-level `key`, as
 * CloudFormation decides it. The deploy's in-place update answers from
 * `changedProperties`, which compares the templates as written: the record
 * holds a secret as its `{{resolve:...}}` token or `***`, never the plaintext
 * the desired bag holds. A changed reference and a `NoEcho` value count as
 * changed there; a secret rotated under a reference the template spells
 * literally does not, as in CloudFormation (one built by `Fn::Join` counts a
 * newer read version). These types are deliberately NOT in
 * `CHANGED_PROPERTIES_CONSUMER_TYPES`: RDS never returns the password on a
 * Describe, so the readback that opt-in buys could not confirm it.
 *
 * Without that set the two bags are compared. A rollback revert hands both
 * re-resolved, so an equal value is unchanged. Under `drift --revert` both
 * sides are AWS readbacks (the desired one with the drifted keys overlaid),
 * which never hold the password, so it is not sent. A recorded
 * `{{resolve:` token or whole `***` mask is never read as equal. Compared in
 * memory only; no value is logged.
 */
function propertyChangedForUpdate(
  key: string,
  desired: unknown,
  recorded: unknown,
  context: UpdateContext | undefined
): boolean {
  const changedProperties = context?.changedProperties;
  if (changedProperties !== undefined) return changedProperties.has(key);
  return holdsRecordedStandIn(recorded) || !isDeepStrictEqual(desired, recorded);
}

/** A recorded leaf standing in for a secret: a dynamic reference, or the whole mask. */
function holdsRecordedStandIn(value: unknown): boolean {
  if (typeof value === 'string') {
    return value === SECRET_MASK || dynamicReferenceTokens(value).length > 0;
  }
  if (Array.isArray(value)) return value.some(holdsRecordedStandIn);
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some(holdsRecordedStandIn);
  }
  return false;
}

/**
 * go-to-k/cdkd#5153: the `MasterUserPassword` a `ModifyDBCluster` /
 * `ModifyDBInstance` carries, or `undefined` to leave the live password alone.
 * RDS treats ANY supplied password as a master-credential reset, so it is sent
 * only when the template changed it, as CloudFormation does. A removed
 * password sends nothing.
 */
export function masterUserPasswordToSend(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined
): string | undefined {
  const desired = properties['MasterUserPassword'];
  if (desired === undefined || desired === null) return undefined;
  return propertyChangedForUpdate(
    'MasterUserPassword',
    desired,
    previousProperties['MasterUserPassword'],
    context
  )
    ? (desired as string)
    : undefined;
}

/**
 * go-to-k/cdkd#5153: whether `ManageMasterUserPassword` / `MasterUserSecret`
 * ride the Modify* call. They are sent, as before, when any of the three
 * master-credential properties changed: turning the managed password off
 * needs the (newly declared) `MasterUserPassword` beside it, and a KMS key is
 * accepted only while turning management on. Nothing changed sends neither,
 * as CloudFormation sends nothing for unchanged properties; otherwise a
 * declared `ManageMasterUserPassword: false` would travel alone once the
 * unchanged password is left out.
 */
export function masterCredentialSettingsChanged(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined
): boolean {
  return (
    propertyChangedForUpdate(
      'MasterUserPassword',
      properties['MasterUserPassword'],
      previousProperties['MasterUserPassword'],
      context
    ) ||
    propertyChangedForUpdate(
      'ManageMasterUserPassword',
      properties['ManageMasterUserPassword'],
      previousProperties['ManageMasterUserPassword'],
      context
    ) ||
    propertyChangedForUpdate(
      'MasterUserSecret',
      properties['MasterUserSecret'],
      previousProperties['MasterUserSecret'],
      context
    )
  );
}

/**
 * go-to-k/cdkd#5639 / #5640: whether `ManageMasterUserPassword` rides the
 * Modify* call: a master-credential change (`masterCredentialSettingsChanged`)
 * or a `MasterUserAuthenticationType` the call sends, which RDS refuses unless the
 * same call sets the managed password (below). The `MasterUserSecret` KMS
 * key rides a type change only when it switches to `password` with the managed
 * password declared, the call that turns it on
 * (`passwordAuthenticationCompanion`): RDS takes a key only then, so
 * re-sending it on a resource already managed would be refused.
 *
 * RDS refuses `iam-db-auth` beside a managed password unless the same
 * call turns it off (`ManageMasterUserPassword: false`), and refuses
 * `password` unless the same call carries a password or turns the managed one
 * on (measured with ModifyDBCluster / ModifyDBInstance, us-east-1, 2026-11-04).
 * CloudFormation's DBCluster handler sends `ManageMasterUserPassword` on every
 * update, so a switch declaring the managed password succeeds there too.
 */
export function managedPasswordSettingRides(
  credentialSettingsChanged: boolean,
  authenticationType: MasterUserAuthenticationType | undefined
): boolean {
  // `authenticationType` is what the call SENDS: a rollback replay that drops
  // the type (no password declared) passes `undefined`, so no lone
  // `ManageMasterUserPassword` goes out, which RDS refuses.
  return credentialSettingsChanged || authenticationType !== undefined;
}

/**
 * go-to-k/cdkd#5639 / #5640: what a ModifyDBCluster / ModifyDBInstance that
 * switches `MasterUserAuthenticationType` to `password` must carry beside it.
 * RDS refuses `password` unless the same call carries a master password or
 * turns the managed password on ("You must specify a master password ...",
 * measured us-east-1, 2026-11-04), whichever direction the switch takes (a
 * rollback replay of a forward `password` -> `iam-db-auth` included).
 *
 * - `managed`: the template declares `ManageMasterUserPassword: true`, which
 *   rides the call (`managedPasswordSettingRides`). That call creates the
 *   managed secret, so the declared `MasterUserSecret` KMS key rides it too,
 *   or the secret would land on `aws/secretsmanager` unnoticed.
 * - `password`: the declared `MasterUserPassword` rides the call, even when
 *   unchanged. Never logged.
 * - `missing`: neither is declared; the caller refuses before any call. This
 *   includes an explicit ADD of the default `password` (the record lacks the
 *   type), e.g. on a snapshot-restored cluster: whether RDS accepts a type
 *   equal to the live one without a password is unmeasured, so cdkd refuses
 *   rather than guess. A
 *   rollback replay instead drops the type (with a warning) and reverts the
 *   other members, since RDS would reject the whole call.
 * - `undefined`: the call does not switch to `password`.
 */
export function passwordAuthenticationCompanion(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  authenticationType: MasterUserAuthenticationType | undefined
): { kind: 'managed' } | { kind: 'password'; password: string } | { kind: 'missing' } | undefined {
  if (authenticationType !== 'password') return undefined;
  if (String(properties['ManageMasterUserPassword']) === 'true') {
    // Only a switch FROM another recorded type turns the managed secret on. An
    // added `password` (the record lacks the type) on a resource already
    // managed must not re-send the key, which RDS refuses there.
    const previous = previousProperties['MasterUserAuthenticationType'];
    return previous != null && previous !== '' && previous !== 'password'
      ? { kind: 'managed' }
      : undefined;
  }
  // An added `password` on a literal-password resource re-sends the unchanged
  // declared password once; RDS needs it beside the type either way.
  const password = properties['MasterUserPassword'];
  return typeof password === 'string' && password !== ''
    ? { kind: 'password', password }
    : { kind: 'missing' };
}

/** The refusal text of a switch to `password` with no password (`passwordAuthenticationCompanion`). */
export function passwordAuthenticationMissingText(resourceType: string, logicalId: string): string {
  return (
    `${resourceType} ${logicalId}: MasterUserAuthenticationType changes to password, which RDS ` +
    `accepts only beside a master password or the managed one in the same call, and the ` +
    `template declares neither MasterUserPassword nor ManageMasterUserPassword: true. ` +
    `Nothing was applied. Declare one of them.`
  );
}

/**
 * go-to-k/cdkd#5639 / #5640: the `MasterUserAuthenticationType` a
 * ModifyDBCluster / ModifyDBInstance carries: the declared value when the
 * template changed it, else `undefined`. A removal sends nothing and RDS keeps
 * the live type. Measured against CloudFormation (us-east-1, 2026-11-04,
 * CloudTrail): both handlers send a changed value and nothing for a removal.
 * The property is write-only in the registry schema and absent from the
 * Describe shapes, so no readback can confirm it.
 */
export function masterUserAuthenticationTypeToSend(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined
): MasterUserAuthenticationType | undefined {
  return instanceValueChanged(
    properties,
    previousProperties,
    'MasterUserAuthenticationType',
    context
  )
    ? (properties['MasterUserAuthenticationType'] as MasterUserAuthenticationType)
    : undefined;
}

/**
 * Issue #1160: whether a removed `ManageMasterUserPassword` goes out as
 * `false`. The previous template declared `true` and the desired one declares
 * nothing. A real CloudFormation A/B (#1160 comment 6401151077) showed
 * CloudFormation sends `false` there on both DBCluster and DBInstance: with a
 * `MasterUserPassword` added in the same update the managed password is turned
 * off, and without one RDS refuses the update. Leaving it unsent instead kept
 * the managed password on without a word.
 */
export function managedPasswordOnRemoval(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>
): boolean {
  const previous = previousProperties['ManageMasterUserPassword'];
  return (
    properties['ManageMasterUserPassword'] === undefined &&
    (previous === true || previous === 'true')
  );
}
