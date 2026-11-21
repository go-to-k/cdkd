import { RemoveAutoScalingPolicyCommand, type EMRClient } from '@aws-sdk/client-emr';

/**
 * Remove a TASK group's automatic scaling policy before its delete scales it
 * to 0, as CloudFormation's handler does (go-to-k/cdkd#6751).
 *
 * The scale-to-0 succeeds with the policy attached, but the policy's
 * CloudWatch alarm and Application Auto Scaling target outlive it, so the
 * policy could scale a deleted group back out. Live probe (us-east-1): the
 * handler sent RemoveAutoScalingPolicy, then ModifyInstanceGroups to 0.
 *
 * Returns `false` when the group has no policy: AWS answers that with a
 * `ValidationException` "Auto Scaling policy was not found ...". Anything
 * else propagates.
 */
export async function removeScalingPolicyForDelete(
  client: EMRClient,
  clusterId: string,
  instanceGroupId: string
): Promise<boolean> {
  try {
    await client.send(
      new RemoveAutoScalingPolicyCommand({ ClusterId: clusterId, InstanceGroupId: instanceGroupId })
    );
    return true;
  } catch (error) {
    const e = error as { name?: unknown; message?: unknown } | null;
    if (
      e?.name === 'ValidationException' &&
      typeof e.message === 'string' &&
      /policy was not found/i.test(e.message)
    ) {
      return false;
    }
    throw error;
  }
}
