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

/**
 * A REST API id as API Gateway mints it: 10 lowercase alphanumerics. AWS
 * documents no length; every id measured had 10 (three REST APIs, us-east-1,
 * 2026-11-17), while the five authorizer ids and the deployment and resource
 * ids measured beside them had 6. Anchoring the
 * FIRST segment to it is what refuses the reversed `<childId>|<restApiId>`
 * order, which a shape-only `[a-z0-9]+` on both sides would accept and answer
 * with the REST API id.
 */
const REST_API_ID = '[a-z0-9]{10}';

/**
 * `<restApiId>|<authorizerId>`: what Cloud Control records for an
 * `AWS::ApiGateway::Authorizer` (measured us-east-1, 2026-11-17: the live
 * schema's primaryIdentifier is `[RestApiId, AuthorizerId]`, the reverse of
 * the order the committed schema fixture lists). The authorizer id is a
 * lowercase alphanumeric; every one measured had 6 characters, but AWS
 * documents no length, so it is not pinned.
 */
const APIGW_AUTHORIZER_CC_ID = new RegExp(`^${REST_API_ID}\\|([a-z0-9]+)$`);

/**
 * The bare authorizer id `ApiGatewayProvider` stores as an
 * `AWS::ApiGateway::Authorizer` physicalId (it reads `RestApiId` from the
 * properties), from the `<restApiId>|<authorizerId>` id Cloud Control
 * recorded. Throws on any other shape. The id is not echoed: the caller names
 * the resource.
 */
export function apiGatewayAuthorizerSdkPhysicalId(ccPhysicalId: string): string {
  const match = APIGW_AUTHORIZER_CC_ID.exec(ccPhysicalId);
  if (match === null) {
    throw new Error(
      'its recorded physical id is not the `<restApiId>|<authorizerId>` form Cloud Control records for AWS::ApiGateway::Authorizer'
    );
  }
  return match[1]!;
}

/**
 * `<restApiId>|<stageName>`: what Cloud Control records for an
 * `AWS::ApiGateway::Stage` (schema primaryIdentifier `[RestApiId, StageName]`,
 * measured us-east-1, 2026-11-17). API Gateway allows only letters, digits,
 * hyphens and underscores in a stage name, so it cannot hold the `|`. A
 * reversed `<stageName>|<restApiId>` is refused only when the stage name is not
 * itself 10 lowercase alphanumerics (`production` is): no shape tells those
 * apart, and Cloud Control never wrote that order.
 */
const APIGW_STAGE_CC_ID = new RegExp(`^${REST_API_ID}\\|([A-Za-z0-9_-]+)$`);

/**
 * The bare stage name `ApiGatewayProvider` stores as an
 * `AWS::ApiGateway::Stage` physicalId (it reads `RestApiId` from the
 * properties), from the `<restApiId>|<stageName>` id Cloud Control recorded.
 * Throws on any other shape. The id is not echoed: the caller names the
 * resource.
 */
export function apiGatewayStageSdkPhysicalId(ccPhysicalId: string): string {
  const match = APIGW_STAGE_CC_ID.exec(ccPhysicalId);
  if (match === null) {
    throw new Error(
      'its recorded physical id is not the `<restApiId>|<stageName>` form Cloud Control records for AWS::ApiGateway::Stage'
    );
  }
  return match[1]!;
}
