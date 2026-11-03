/**
 * Declared physicalId normalizers for `STICKY_CC_MIGRATION_EXEMPT` entries
 * whose Cloud Control identifier differs from what the SDK provider stores
 * (go-to-k/cdkd#5654).
 *
 * A normalizer maps the id a Cloud Control record carries to the id the SDK
 * provider would have recorded for the same live resource. It is STRICT: it
 * accepts only the exact shape the Cloud Control handler was measured to mint
 * and throws on anything else, so a hand-edited or legacy record is refused
 * rather than handed to the SDK provider under a guessed id. Each one's output
 * must have been observed equal to the SDK form by the entry's integ fixture.
 */

/**
 * `<serviceArn>|<cluster>`: what Cloud Control records for an
 * `AWS::ECS::Service` (schema primaryIdentifier `[ServiceArn, Cluster]`,
 * measured us-east-1, 2026-11-03). The ARN is the long format
 * `service/<clusterName>/<serviceName>` or the legacy short format
 * `service/<serviceName>`; the cluster segment is the name or ARN the
 * template's `Cluster` gave.
 */
const ECS_SERVICE_CC_ID =
  /^(arn:aws[-a-z]*:ecs:[a-z0-9-]+:\d{12}:service\/([A-Za-z0-9_-]+)(?:\/([A-Za-z0-9_-]+))?)\|([^|\s]+)$/;

/** ECS cluster and service names: up to 255 letters, digits, hyphens and underscores. */
const CLUSTER_ARN = /^arn:aws[-a-z]*:ecs:[a-z0-9-]+:\d{12}:cluster\/([A-Za-z0-9_-]+)$/;
const CLUSTER_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * The service ARN `ECSProvider` stores as an `AWS::ECS::Service` physicalId,
 * from the `<serviceArn>|<cluster>` id Cloud Control recorded. Throws when the
 * input is not that form, or when a long-format ARN names a different cluster
 * than the cluster segment: either means the record is not one Cloud Control
 * wrote, and the SDK provider's own `|` readers parse a `|` id as
 * `<clusterArn>|<serviceName>`, which would swap the two. The id is not
 * echoed: the caller names the resource.
 */
export function ecsServiceSdkPhysicalId(ccPhysicalId: string): string {
  const match = ECS_SERVICE_CC_ID.exec(ccPhysicalId);
  if (match === null) {
    throw new Error(
      'its recorded physical id is not the `<serviceArn>|<cluster>` form Cloud Control records for AWS::ECS::Service'
    );
  }
  const [, serviceArn, first, second, clusterSegment] = match;
  const clusterArn = CLUSTER_ARN.exec(clusterSegment!);
  if (clusterArn === null && !CLUSTER_NAME.test(clusterSegment!)) {
    throw new Error(
      'the cluster segment of its recorded physical id is neither a cluster name nor a cluster ARN'
    );
  }
  const clusterName = clusterArn === null ? clusterSegment! : clusterArn[1]!;
  // A long-format ARN embeds the cluster name; the short format does not.
  if (second !== undefined && first !== clusterName) {
    throw new Error(
      'its recorded physical id names one cluster in the service ARN and another after the `|`'
    );
  }
  return serviceArn!;
}
