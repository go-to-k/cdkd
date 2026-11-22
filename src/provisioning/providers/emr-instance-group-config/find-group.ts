import type { EMRInstanceGroupConfigProvider } from '../emr-instance-group-config-provider.js';
import { ListInstanceGroupsCommand, type InstanceGroup } from '@aws-sdk/client-emr';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { safeMsg } from '../../../utils/display-safe.js';

/**
 * `ListInstanceGroups` (paginated) for the cluster, returning the single
 * group whose `Id` matches. Absorbs up to `maxConsecutiveTransient`
 * consecutive transient errors (throttle / 5xx / reset) so a single blip
 * during a 10-minute poll does not spuriously fail the create.
 */
export async function findGroupForPoll(
  this: EMRInstanceGroupConfigProvider,
  clusterId: string,
  groupId: string,
  transientState: { count: number },
  maxConsecutiveTransient = 5
): Promise<InstanceGroup | undefined> {
  try {
    let marker: string | undefined;
    do {
      const resp = await this.getClient().send(
        new ListInstanceGroupsCommand({
          ClusterId: clusterId,
          ...(marker && { Marker: marker }),
        })
      );
      const found = (resp.InstanceGroups ?? []).find((g) => g.Id === groupId);
      if (found) {
        transientState.count = 0;
        return found;
      }
      marker = resp.Marker;
    } while (marker);
    transientState.count = 0;
    return undefined;
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    // `.detail`, never `.summary`: the substring test below is what keeps this
    // degradation alive, and it matches AWS's OWN wording. Byte-identical to
    // the ternary it replaced, minus that ternary's throw.
    const msg = describeAwsFailure(error).detail;
    const transient =
      name === 'ThrottlingException' ||
      name === 'InternalServerException' ||
      name === 'InternalServerError' ||
      name === 'TimeoutError' ||
      /rate exceeded|too many requests|throttl|timed? ?out|ECONNRESET|EPIPE|socket hang up/i.test(
        msg
      );
    if (transient && transientState.count < maxConsecutiveTransient) {
      transientState.count += 1;
      this.logger.debug(
        safeMsg`Transient ListInstanceGroups error while polling ${groupId} (${transientState.count}/${maxConsecutiveTransient}): ${msg} — retrying`
      );
      return undefined;
    }
    throw error;
  }
}
