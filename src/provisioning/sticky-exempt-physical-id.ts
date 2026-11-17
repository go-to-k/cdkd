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
 *
 * A normalizer whose SDK id is not inside the Cloud Control id reads it from
 * {@link CcPhysicalIdContext}: the record's own properties, and the region,
 * account and partition the record lives in (go-to-k/cdkd#6490). It still
 * validates the Cloud Control id's measured shape, and where the id and the
 * properties both name a value, it refuses when they disagree.
 */

/**
 * What a normalizer may read beside the Cloud Control id. `properties` is the
 * RECORD's bag (the resolved desired bag of the last successful deploy, which
 * names the live resource), never the deploy's new desired side, which may
 * rename it. `region` is the stack's; `accountId` and `partition` are the
 * active credentials' account and the region's partition.
 */
export interface CcPhysicalIdContext {
  properties: Record<string, unknown>;
  region: string;
  accountId: string;
  partition: string;
}

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
 * documents no length, so it is not pinned. A reversed
 * `<authorizerId>|<restApiId>` is therefore refused only while the authorizer
 * id is not itself 10 characters long, as no measured one was.
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

/**
 * An HTTP / WebSocket API id as API Gateway v2 mints it: 10 lowercase
 * alphanumerics, like a REST API id. AWS documents no length; both measured
 * had 10 (us-east-1, 2026-11-17), while the integration and route ids
 * measured beside them had 7 and the authorizer id 6.
 */
const V2_API_ID = '[a-z0-9]{10}';

/**
 * `<apiId>|<integrationId>` and `<apiId>|<routeId>`: what Cloud Control
 * records for an `AWS::ApiGatewayV2::Integration` / `::Route` (measured
 * us-east-1, 2026-11-17; schema primaryIdentifier `[ApiId, <ChildId>]`). The
 * child id is a lowercase alphanumeric whose length AWS does not document, so
 * it is not pinned: a reversed `<childId>|<apiId>` is refused only while the
 * child id is not itself 10 characters long, as no measured one was.
 */
const V2_API_CHILD_CC_ID = new RegExp(`^${V2_API_ID}\\|([a-z0-9]+)$`);

function v2ApiChildSdkPhysicalId(ccPhysicalId: string, form: string, type: string): string {
  const match = V2_API_CHILD_CC_ID.exec(ccPhysicalId);
  if (match === null) {
    throw new Error(
      `its recorded physical id is not the \`${form}\` form Cloud Control records for ${type}`
    );
  }
  return match[1]!;
}

/**
 * The bare integration id `ApiGatewayV2Provider` stores as an
 * `AWS::ApiGatewayV2::Integration` physicalId (it reads `ApiId` from the
 * properties), from the `<apiId>|<integrationId>` id Cloud Control recorded.
 * Throws on any other shape. The id is not echoed: the caller names the
 * resource.
 */
export function apiGatewayV2IntegrationSdkPhysicalId(ccPhysicalId: string): string {
  return v2ApiChildSdkPhysicalId(
    ccPhysicalId,
    '<apiId>|<integrationId>',
    'AWS::ApiGatewayV2::Integration'
  );
}

/**
 * The bare route id `ApiGatewayV2Provider` stores as an
 * `AWS::ApiGatewayV2::Route` physicalId (it reads `ApiId` from the
 * properties), from the `<apiId>|<routeId>` id Cloud Control recorded. Throws
 * on any other shape. The id is not echoed.
 */
export function apiGatewayV2RouteSdkPhysicalId(ccPhysicalId: string): string {
  return v2ApiChildSdkPhysicalId(ccPhysicalId, '<apiId>|<routeId>', 'AWS::ApiGatewayV2::Route');
}

/**
 * `<authorizerId>|<apiId>`: what Cloud Control records for an
 * `AWS::ApiGatewayV2::Authorizer` (measured us-east-1, 2026-11-17: the live
 * schema's primaryIdentifier is `[AuthorizerId, ApiId]`, the REVERSE of both
 * the committed schema fixture and the v1 `AWS::ApiGateway::Authorizer`). The
 * API id is therefore anchored on the SECOND segment; a reversed
 * `<apiId>|<authorizerId>` is refused only while the authorizer id is not
 * itself 10 characters long, as the measured one (6) was not.
 */
const V2_AUTHORIZER_CC_ID = new RegExp(`^([a-z0-9]+)\\|${V2_API_ID}$`);

/**
 * The bare authorizer id `ApiGatewayV2Provider` stores as an
 * `AWS::ApiGatewayV2::Authorizer` physicalId (it reads `ApiId` from the
 * properties), from the `<authorizerId>|<apiId>` id Cloud Control recorded.
 * Throws on any other shape. The id is not echoed.
 */
export function apiGatewayV2AuthorizerSdkPhysicalId(ccPhysicalId: string): string {
  const match = V2_AUTHORIZER_CC_ID.exec(ccPhysicalId);
  if (match === null) {
    throw new Error(
      'its recorded physical id is not the `<authorizerId>|<apiId>` form Cloud Control records for AWS::ApiGatewayV2::Authorizer'
    );
  }
  return match[1]!;
}

/**
 * `<apiId>|<stageName>`: what Cloud Control records for an
 * `AWS::ApiGatewayV2::Stage` (measured us-east-1, 2026-11-17, for a named stage
 * and for `$default`; schema primaryIdentifier `[ApiId, StageName]`). A stage
 * name is letters, digits, hyphens and underscores, or the HTTP API's
 * `$default`, so it cannot hold the `|`. A reversed `<stageName>|<apiId>` is
 * refused only when the stage name is not itself 10 lowercase alphanumerics.
 */
const V2_STAGE_CC_ID = new RegExp(`^${V2_API_ID}\\|(\\$default|[A-Za-z0-9_-]+)$`);

/**
 * The bare stage name `ApiGatewayV2Provider` stores as an
 * `AWS::ApiGatewayV2::Stage` physicalId (it reads `ApiId` from the
 * properties), from the `<apiId>|<stageName>` id Cloud Control recorded.
 * Throws on any other shape. The id is not echoed.
 */
export function apiGatewayV2StageSdkPhysicalId(ccPhysicalId: string): string {
  const match = V2_STAGE_CC_ID.exec(ccPhysicalId);
  if (match === null) {
    throw new Error(
      'its recorded physical id is not the `<apiId>|<stageName>` form Cloud Control records for AWS::ApiGatewayV2::Stage'
    );
  }
  return match[1]!;
}

/**
 * The GraphQL API ARN Cloud Control records for an `AWS::AppSync::GraphQLApi`
 * (schema primaryIdentifier `[Arn]`, measured us-east-1, 2026-11-17:
 * `arn:aws:appsync:<region>:<account>:apis/<apiId>`). The API id is 26
 * lowercase alphanumerics, as measured; an ARN of any other resource kind
 * (`apis/<id>/types/...`, a merged-API source association) is refused.
 */
const APPSYNC_GRAPHQL_API_CC_ID =
  /^arn:aws(?:-[a-z]+)*:appsync:[a-z0-9-]+:\d{12}:apis\/([a-z0-9]{26})$/;

/**
 * The bare API id `AppSyncProvider` stores as an `AWS::AppSync::GraphQLApi`
 * physicalId, from the API ARN Cloud Control recorded. The record's `Arn`
 * attribute, which `Ref` returns, is carried across the flip unchanged.
 * Throws on any other shape. The id is not echoed.
 */
export function appSyncGraphQLApiSdkPhysicalId(ccPhysicalId: string): string {
  const match = APPSYNC_GRAPHQL_API_CC_ID.exec(ccPhysicalId);
  if (match === null) {
    throw new Error(
      'its recorded physical id is not the GraphQL API ARN Cloud Control records for AWS::AppSync::GraphQLApi'
    );
  }
  return match[1]!;
}

/**
 * The vector bucket ARN Cloud Control records for an
 * `AWS::S3Vectors::VectorBucket` (schema primaryIdentifier `[VectorBucketArn]`,
 * measured us-east-1, 2026-11-17:
 * `arn:aws:s3vectors:<region>:<account>:bucket/<name>`). A vector bucket name
 * is 3 to 63 lowercase letters, digits, hyphens and dots, starting and ending
 * with a letter or digit (a dotted name was measured accepted, us-east-1,
 * 2026-11-17: `cdkd-measure-6490.dot-11427`); an index ARN
 * (`bucket/<name>/index/<index>`) is refused.
 */
const S3VECTORS_BUCKET_CC_ID =
  /^arn:aws(?:-[a-z]+)*:s3vectors:[a-z0-9-]+:\d{12}:bucket\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])$/;

/**
 * The bare bucket name `S3VectorsProvider` stores as an
 * `AWS::S3Vectors::VectorBucket` physicalId, from the ARN Cloud Control
 * recorded. The record's `VectorBucketArn` attribute, which `Ref` returns, is
 * carried across the flip unchanged. Throws on any other shape. The id is not
 * echoed.
 */
export function s3VectorsVectorBucketSdkPhysicalId(ccPhysicalId: string): string {
  const match = S3VECTORS_BUCKET_CC_ID.exec(ccPhysicalId);
  if (match === null) {
    throw new Error(
      'its recorded physical id is not the vector bucket ARN Cloud Control records for AWS::S3Vectors::VectorBucket'
    );
  }
  return match[1]!;
}

/** The region, account and partition a derived ARN names, checked before use. */
function arnScope(ctx: CcPhysicalIdContext, type: string): CcPhysicalIdContext {
  if (!/^aws(?:-[a-z]+)*$/.test(ctx.partition)) {
    throw new Error(`the partition it would build the ${type} ARN in is not an AWS partition`);
  }
  if (!/^\d{12}$/.test(ctx.accountId)) {
    throw new Error(`the account it would build the ${type} ARN in is not a 12-digit account id`);
  }
  if (!/^[a-z0-9-]+$/.test(ctx.region)) {
    throw new Error(`the region it would build the ${type} ARN in is not a region name`);
  }
  return ctx;
}

/**
 * A lowercase UUID: how AWS mints a WAFv2 web ACL id and a CodeCommit
 * RepositoryId (every one measured, us-east-1, 2026-11-17, and a re-created
 * web ACL or repository of the same name got a new one).
 */
const LOWERCASE_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * `<Name>|<Id>|<Scope>`: what Cloud Control records for an
 * `AWS::WAFv2::WebACL` (schema primaryIdentifier `[Name, Id, Scope]`, in that
 * order, measured us-east-1, 2026-11-17 for both scopes). A web ACL name is 1
 * to 128 letters, digits, underscores and hyphens (the WAFv2 API's own
 * pattern), so it cannot hold the `|`; the id is anchored to the UUID, which
 * refuses any reordering of the three segments.
 */
const WAFV2_WEB_ACL_CC_ID = new RegExp(
  `^([\\w-]{1,128})\\|(${LOWERCASE_UUID})\\|(REGIONAL|CLOUDFRONT)$`
);

/**
 * The web ACL ARN `WAFv2Provider` stores as an `AWS::WAFv2::WebACL`
 * physicalId, built from the `<Name>|<Id>|<Scope>` id Cloud Control recorded:
 * `arn:<partition>:wafv2:<region>:<account>:<regional|global>/webacl/<Name>/<Id>`
 * (measured, us-east-1, 2026-11-17). Throws when the id is not that form, when
 * the record's `Scope` (required) or `Name` (when declared) differs from the
 * id's segment, or when a CLOUDFRONT web ACL is not in us-east-1, the only
 * region AWS serves that scope from. `Ref` is `<Name>|<Id>|<Scope>` on both
 * layers: the Cloud Control id itself, then the compound cdkd rebuilds from
 * the ARN. The id is not echoed.
 */
export function wafv2WebAclSdkPhysicalId(ccPhysicalId: string, ctx: CcPhysicalIdContext): string {
  const match = WAFV2_WEB_ACL_CC_ID.exec(ccPhysicalId);
  if (match === null) {
    throw new Error(
      'its recorded physical id is not the `<Name>|<Id>|<Scope>` form Cloud Control records for AWS::WAFv2::WebACL'
    );
  }
  const [, name, id, scope] = match;
  if (ctx.properties['Scope'] !== scope) {
    throw new Error(
      'the scope in its recorded physical id is not the Scope its recorded properties declare'
    );
  }
  const declaredName = ctx.properties['Name'];
  if (declaredName !== undefined && declaredName !== name) {
    throw new Error(
      'the name in its recorded physical id is not the Name its recorded properties declare'
    );
  }
  const { partition, region, accountId } = arnScope(ctx, 'AWS::WAFv2::WebACL');
  if (scope === 'CLOUDFRONT' && region !== 'us-east-1') {
    throw new Error(
      `it is a CLOUDFRONT web ACL recorded in ${region}, while AWS serves that scope only from us-east-1`
    );
  }
  const kind = scope === 'CLOUDFRONT' ? 'global' : 'regional';
  return `arn:${partition}:wafv2:${region}:${accountId}:${kind}/webacl/${name}/${id}`;
}

/**
 * The repository id Cloud Control records for an `AWS::CodeCommit::Repository`
 * (schema primaryIdentifier `[RepositoryId]`): a lowercase UUID (measured
 * us-east-1, 2026-11-17; a repository re-created under the same name got a new
 * one).
 */
const CODECOMMIT_REPOSITORY_CC_ID = new RegExp(`^${LOWERCASE_UUID}$`);

/**
 * A repository name as CodeCommit accepts it: 1 to 100 letters, digits,
 * periods, underscores and hyphens. Refuses a `{{resolve:...}}` reference or
 * cdkd's `***` mask, which a record may hold in place of a secret-derived name.
 */
const CODECOMMIT_REPOSITORY_NAME = /^[\w.-]{1,100}$/;

/**
 * The repository name `CodeCommitRepositoryProvider` stores as an
 * `AWS::CodeCommit::Repository` physicalId (every CodeCommit API is
 * name-addressed), from the RepositoryId Cloud Control recorded and the
 * record's own `RepositoryName`. The id holds no name, so nothing in it can be
 * compared with the property: the id's shape and the name's are each checked,
 * and the fixture witnesses the pair by reading the live repository's id
 * through the name. `Ref` is the RepositoryId on both layers: the Cloud
 * Control id itself, then the recorded `RepositoryId` attribute the flip
 * carries over. The id is not echoed.
 */
export function codeCommitRepositorySdkPhysicalId(
  ccPhysicalId: string,
  ctx: CcPhysicalIdContext
): string {
  if (!CODECOMMIT_REPOSITORY_CC_ID.test(ccPhysicalId)) {
    throw new Error(
      'its recorded physical id is not the RepositoryId Cloud Control records for AWS::CodeCommit::Repository'
    );
  }
  const name = ctx.properties['RepositoryName'];
  if (typeof name !== 'string' || !CODECOMMIT_REPOSITORY_NAME.test(name)) {
    throw new Error('its recorded properties hold no plain RepositoryName to address it by');
  }
  return name;
}
