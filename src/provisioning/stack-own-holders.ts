import { getStackRecords, type JournaledWrite } from '../deployment/stack-records-scope.js';
import { isUsableIdentityValue } from '../deployment/recorded-identity-attributes.js';

/**
 * go-to-k/cdkd#6808: one holder of an IAM role or group that the stack itself
 * holds it through: an `AWS::IAM::InstanceProfile` holding a role, or a user
 * the stack makes a member of a group (an `AWS::IAM::User`'s `Groups`, or an
 * `AWS::IAM::UserToGroupAddition`'s `Users`).
 */
export interface StackOwnHolder {
  /** The holder's name: the profile's or the user's physical id. */
  readonly name: string;
  /**
   * The AWS-minted id recorded for it (`InstanceProfileId` / `UserId`,
   * go-to-k/cdkd#6655), or `undefined` where none is recorded (a record
   * written before cdkd recorded it, a journaled write, a user a
   * `UserToGroupAddition` names). A holder with one recorded is the stack's
   * only while the live holder of the name carries the same id.
   */
  readonly id?: string | undefined;
}

/**
 * The stack's own holders of the role or group `physicalId` names
 * (go-to-k/cdkd#6808), read from the records bound around this delete
 * (`getStackRecords()`: its live records, plus the writes of the journal a
 * rollback replays). A role's are the instance profiles whose `Roles` name
 * it; a group's, the users whose `Groups` name it and those a
 * `UserToGroupAddition` naming it adds.
 *
 * Only these are removed by a delete that may strip
 * (`DeleteContext.stackHoldersStillAttached`); every other holder is refused
 * as on any delete (go-to-k/cdkd#6750), as CloudFormation's `DeleteConflict`
 * does. Fails safe: no view bound, or a name that is not a plain string (a
 * mask, an unresolved token), yields no holder, so the delete refuses rather
 * than strips. Names compare ignoring case, as IAM holds them unique.
 */
export function stackOwnHolders(resourceType: string, physicalId: string): StackOwnHolder[] {
  const view = getStackRecords();
  if (view === undefined) return [];
  const sources: JournaledWrite[] = [];
  for (const [, record] of view.live()) sources.push(record);
  for (const write of view.journaledWrites?.() ?? []) sources.push(write);
  const target = physicalId.toLowerCase();
  const names = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  const holders: StackOwnHolder[] = [];
  const add = (name: unknown, id: unknown): void => {
    if (!isUsableIdentityValue(name)) return;
    holders.push({ name, ...(isUsableIdentityValue(id) && { id }) });
  };
  for (const source of sources) {
    const properties = source.properties ?? {};
    if (resourceType === 'AWS::IAM::Role' && source.resourceType === 'AWS::IAM::InstanceProfile') {
      if (names(properties['Roles']).some((role) => role.toLowerCase() === target)) {
        add(source.physicalId, source.attributes?.['InstanceProfileId']);
      }
    } else if (resourceType === 'AWS::IAM::Group' && source.resourceType === 'AWS::IAM::User') {
      if (names(properties['Groups']).some((group) => group.toLowerCase() === target)) {
        add(source.physicalId, source.attributes?.['UserId']);
      }
    } else if (
      resourceType === 'AWS::IAM::Group' &&
      source.resourceType === 'AWS::IAM::UserToGroupAddition'
    ) {
      const group = properties['GroupName'];
      if (typeof group === 'string' && group.toLowerCase() === target) {
        for (const user of names(properties['Users'])) add(user, undefined);
      }
    }
  }
  return holders;
}

/**
 * Is the live holder `name` (with the AWS-minted `liveId` its listing
 * answered) one of `holders`? A holder with a recorded id matches only that
 * id: another holder under the name is not the stack's.
 */
export function isStackOwnHolder(
  holders: readonly StackOwnHolder[],
  name: string,
  liveId: string | undefined
): boolean {
  const key = name.toLowerCase();
  return holders.some(
    (holder) =>
      holder.name.toLowerCase() === key && (holder.id === undefined || holder.id === liveId)
  );
}
