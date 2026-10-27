import { describe, expect, it } from 'vite-plus/test';
import {
  ACCOUNT,
  TAG_THROWS,
  createOnlyOf,
  paths,
  record,
  setOutputOverrides,
  wire,
  type Bag,
  type BagCase,
  type Throw,
  type TypeCase,
} from './sdk-wire-harness.js';
import { ApiGatewayV2Provider } from '../../../src/provisioning/providers/apigatewayv2-provider.js';
import { ECSProvider } from '../../../src/provisioning/providers/ecs-provider.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';
import { ELBv2Provider } from '../../../src/provisioning/providers/elbv2-provider.js';
import { FirehoseProvider } from '../../../src/provisioning/providers/firehose-provider.js';
import { ASGProvider } from '../../../src/provisioning/providers/asg-provider.js';

/**
 * The twelfth batch of wire cases (#3723): every type `ApiGatewayV2Provider`,
 * `ECSProvider`, `ELBv2Provider`, `FirehoseProvider` and `ASGProvider`
 * handle. Each provider builds its own SDK clients (a create client among them),
 * so `sdk-wire-coverage-12.test.ts` mocks their packages; API Gateway v2 also
 * reads STS through `getAwsClients()` to build `ExecuteApiArn`.
 */

/**
 * A copy sharing no object with any other bag: the harness's `without` is a
 * `structuredClone`, which KEEPS shared references, so a block reused in two
 * places would lose a path in both at once.
 */
const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// === ApiGatewayV2Provider ==================================================

/**
 * The twelfth batch's API Gateway v2 cases (#3723): every type
 * `ApiGatewayV2Provider` handles (`@aws-sdk/client-apigatewayv2`, a client the
 * provider builds itself, a create client among them). `CreateApi` / `UpdateApi`
 * build `ExecuteApiArn` through `getAccountInfo` (STS, a read).
 *
 * Every API Gateway v2 `Update*` MERGES: an omitted member is "unchanged". So
 * most `update-remove` probes are silent by design, each a property a real
 * CloudFormation A/B measured CloudFormation KEEPS on removal (#1160, #5004),
 * as the provider states beside each field. The ones CloudFormation RESETS
 * reach the wire: Api `CorsConfiguration` (`DeleteCorsConfiguration`), Stage
 * `AutoDeploy` / `AccessLogSettings` / `RouteSettings`, Route
 * `AuthorizationScopes` / `ApiKeyRequired`, Authorizer `IdentitySource`, and
 * the Api / Stage `Tags` (`UntagResource`, go-to-k/cdkd#5390).
 */

const APIGWV2_SRC = 'apigatewayv2-provider.ts';
const APIGWV2_REQUIRED = (why: string, says: RegExp): Throw => ({ why, says });
const APIGWV2_TAG_MAP = { k1: 'v1', k2: 'v2' };
const APIGWV2_API_ID = 'api-1';


/** A property CloudFormation KEEPS on removal: `update()` sends nothing for it. */
const apigwv2Kept = (at: string, ab: string): string =>
  `left in place on removal: CloudFormation keeps the live value (real CloudFormation A/B, ${ab}), and an omitted Update member is "unchanged" (${APIGWV2_SRC}:${at})`;

/** A CloudFormation-required property: no deployable template removes it. */
const apigwv2Required = (prop: string, at: string): string =>
  `${prop} is CloudFormation-required, so no deployable template removes it; create() refuses a resource without it (${APIGWV2_SRC}:${at})`;

/**
 * A member of a keyed map: carried under its key (`RequestParameters.<key>.Required`),
 * where every probe reaches it, but the nested-path check reads the map key as a path segment.
 */
const APIGWV2_MAP_KEYED =
  'a member of a keyed map: carried under its key, where the probes reach it';

// --- AWS::ApiGatewayV2::Api ------------------------------------------------------

const API_CASE: TypeCase = {
  resourceType: 'AWS::ApiGatewayV2::Api',
  provider: () => new ApiGatewayV2Provider(),
  physicalId: APIGWV2_API_ID,
  createOnly: createOnlyOf('AWS::ApiGatewayV2::Api'),
  // Body / BodyS3Location / FailOnWarnings / DisableSchemaValidation /
  // BasePath / RouteKey / Target / CredentialsArn are `unhandledByDesign`, so
  // no bag carries them; the nested-path check reads carried top-levels only.
  exempt: {},
  targets: [
    // UntagResource takes the removed key only (go-to-k/cdkd#5390).
    {
      path: ['Tags', 'k1'],
      command: 'UntagResourceCommand',
      names: 'k1',
      notNames: 'k2',
    },
    {
      path: ['Tags', 'k2'],
      command: 'UntagResourceCommand',
      names: 'k2',
      notNames: 'k1',
    },
  ],
  bags: [
    {
      name: 'every property',
      bag: {
        Name: 'api',
        ProtocolType: 'HTTP',
        Description: 'd',
        CorsConfiguration: {
          AllowCredentials: true,
          AllowHeaders: ['h1', 'h2'],
          AllowMethods: ['GET', 'POST'],
          AllowOrigins: ['https://a.example', 'https://b.example'],
          ExposeHeaders: ['e1', 'e2'],
          MaxAge: 300,
        },
        Tags: fresh(APIGWV2_TAG_MAP),
        DisableExecuteApiEndpoint: true,
        Version: 'v1',
        RouteSelectionExpression: '$request.method $request.path',
        ApiKeySelectionExpression: '$request.header.x-api-key',
        IpAddressType: 'ipv4',
      },
      variants: { IpAddressType: 'dualstack' },
      expectedSilent: {
        'update-remove:Name': apigwv2Required('Name', '665-674'),
        'update-remove:Description': apigwv2Kept('2105-2114', '#5004'),
        'update-remove:DisableExecuteApiEndpoint': apigwv2Kept('2131-2140', '#5004'),
        'update-remove:Version': apigwv2Kept('2141-2150', '#5004'),
        'update-remove:RouteSelectionExpression': apigwv2Kept('2151-2160', '#1160'),
        'update-remove:ApiKeySelectionExpression': apigwv2Kept('2161-2170', '#5004'),
        'update-remove:IpAddressType': apigwv2Kept('2171-2180', '#5004'),
      },
      expectedRemovalThrows: {
        'create:Name': APIGWV2_REQUIRED(
          'Name is required: create() refuses an API without it before any call (apigatewayv2-provider.ts:665-674)',
          /Name and ProtocolType are required/
        ),
        'create:ProtocolType': APIGWV2_REQUIRED(
          'ProtocolType is required: create() refuses an API without it before any call (apigatewayv2-provider.ts:665-674)',
          /Name and ProtocolType are required/
        ),
      },
    },
  ],
};

// --- AWS::ApiGatewayV2::Stage ----------------------------------------------------

const STAGE_NAME = 'stage';

const STAGE_ROUTE_SETTING = {
  DataTraceEnabled: true,
  DetailedMetricsEnabled: true,
  LoggingLevel: 'INFO',
  ThrottlingBurstLimit: 10,
  ThrottlingRateLimit: 5,
};

const STAGE_CASE: TypeCase = {
  resourceType: 'AWS::ApiGatewayV2::Stage',
  provider: () => new ApiGatewayV2Provider(),
  physicalId: STAGE_NAME,
  createOnly: createOnlyOf('AWS::ApiGatewayV2::Stage'),
  exempt: {},
  targets: [
    // UntagResource takes the removed key only (go-to-k/cdkd#5390).
    {
      path: ['Tags', 'k1'],
      command: 'UntagResourceCommand',
      names: 'k1',
      notNames: 'k2',
    },
    {
      path: ['Tags', 'k2'],
      command: 'UntagResourceCommand',
      names: 'k2',
      notNames: 'k1',
    },
    // A removed RouteSettings key's DeleteRouteSettings names it in the URL
    // PATH, which a target does not read; its `update-remove` probes compare
    // the whole request, path included.
  ],
  bags: [
    {
      name: 'every property',
      bag: {
        ApiId: APIGWV2_API_ID,
        StageName: STAGE_NAME,
        AutoDeploy: true,
        Description: 'd',
        Tags: fresh(APIGWV2_TAG_MAP),
        StageVariables: { a: '1', b: '2' },
        DefaultRouteSettings: fresh(STAGE_ROUTE_SETTING),
        AccessLogSettings: {
          DestinationArn: `arn:aws:logs:us-east-1:${ACCOUNT}:log-group:access`,
          Format: '$context.requestId',
        },
        ClientCertificateId: 'cert-1',
        DeploymentId: 'dep-1',
        RouteSettings: {
          'GET /a': fresh(STAGE_ROUTE_SETTING),
          'GET /b': { ThrottlingBurstLimit: 20 },
        },
      },
      variants: { 'DefaultRouteSettings.LoggingLevel': 'ERROR' },
      expectedSilent: {
        'update-remove:Description': apigwv2Kept('2357-2366', '#1160'),
        ...Object.fromEntries(
          ['StageVariables', 'StageVariables.a', 'StageVariables.b'].map((label) => [
            `update-remove:${label}`,
            apigwv2Kept(
              '2367-2390',
              '#5004; StageVariables merges per key, and a dropped key stays live'
            ),
          ])
        ),
        'update-remove:DefaultRouteSettings': apigwv2Kept('2391-2403', '#1160'),
        'update-remove:ClientCertificateId': apigwv2Kept('2434-2443', '#5004'),
        'update-remove:DeploymentId':
          'DeploymentId has no "no deployment" sentinel, so a removed one is passed through and the live deployment stays (apigatewayv2-provider.ts:2444-2453); an API constraint, not a CloudFormation A/B measurement',
      },
      expectedRemovalThrows: {
        'create:ApiId': APIGWV2_REQUIRED(
          'ApiId is required: create() refuses a stage without it before any call (apigatewayv2-provider.ts:934-943)',
          /ApiId and StageName are required/
        ),
        'create:StageName': APIGWV2_REQUIRED(
          'StageName is required: create() refuses a stage without it before any call (apigatewayv2-provider.ts:934-943)',
          /ApiId and StageName are required/
        ),
      },
    },
  ],
};

// --- AWS::ApiGatewayV2::Integration ----------------------------------------------

const INTEGRATION_REQUIRED: Record<string, Throw> = {
  'create:ApiId': APIGWV2_REQUIRED(
    'ApiId is required: create() refuses an integration without it before any call (apigatewayv2-provider.ts:1060-1069)',
    /ApiId and IntegrationType are required/
  ),
  'create:IntegrationType': APIGWV2_REQUIRED(
    'IntegrationType is required: create() refuses an integration without it before any call (apigatewayv2-provider.ts:1060-1069)',
    /ApiId and IntegrationType are required/
  ),
};

const INTEGRATION_TYPE_SILENT = apigwv2Required('IntegrationType', '1060-1069');

const INTEGRATION_CASE: TypeCase = {
  resourceType: 'AWS::ApiGatewayV2::Integration',
  provider: () => new ApiGatewayV2Provider(),
  physicalId: 'int-1',
  createOnly: createOnlyOf('AWS::ApiGatewayV2::Integration'),
  exempt: {},
  nestedExempt: {
    'ResponseParameters.ResponseParameters': APIGWV2_MAP_KEYED,
    'ResponseParameters.ResponseParameters.Destination': APIGWV2_MAP_KEYED,
    'ResponseParameters.ResponseParameters.Source': APIGWV2_MAP_KEYED,
  },
  targets: [],
  bags: [
    {
      name: 'URI-based, every property but the subtype',
      bag: {
        ApiId: APIGWV2_API_ID,
        IntegrationType: 'HTTP_PROXY',
        IntegrationUri: 'https://backend.example/path',
        IntegrationMethod: 'GET',
        PayloadFormatVersion: '1.0',
        TimeoutInMillis: 3000,
        RequestParameters: { 'append:header.a': 'x', 'append:header.b': 'y' },
        Description: 'd',
        ConnectionId: 'vpclink-1',
        ConnectionType: 'VPC_LINK',
        ContentHandlingStrategy: 'CONVERT_TO_TEXT',
        CredentialsArn: `arn:aws:iam::${ACCOUNT}:role/integration`,
        PassthroughBehavior: 'WHEN_NO_MATCH',
        RequestTemplates: { 'application/json': '{}', 'text/plain': 'x' },
        ResponseParameters: {
          '200': {
            ResponseParameters: [
              { Destination: 'append:header.a', Source: 'x' },
              { Destination: 'overwrite:statuscode', Source: '204' },
            ],
          },
          '404': {
            ResponseParameters: [{ Destination: 'append:header.b', Source: 'y' }],
          },
        },
        TemplateSelectionExpression: '$request.body.action',
        TlsConfig: { ServerNameToVerify: 'backend.example' },
      },
      expectedSilent: {
        'update-remove:IntegrationType': INTEGRATION_TYPE_SILENT,
        ...Object.fromEntries(
          ['IntegrationUri', 'IntegrationMethod', 'PayloadFormatVersion', 'TimeoutInMillis'].map(
            (key) => [`update-remove:${key}`, apigwv2Kept('2592-2596', '#1160')]
          )
        ),
        ...Object.fromEntries(
          [
            'RequestParameters',
            'RequestParameters.append:header.a',
            'RequestParameters.append:header.b',
          ].map((label) => [
            `update-remove:${label}`,
            apigwv2Kept(
              '2597-2619',
              '#5004; RequestParameters merges per key, and a dropped key stays live'
            ),
          ])
        ),
        'update-remove:Description': apigwv2Kept('2620-2629', '#5004'),
        ...Object.fromEntries(
          [
            'ConnectionId',
            'ConnectionType',
            'ContentHandlingStrategy',
            'CredentialsArn',
            'PassthroughBehavior',
            'RequestTemplates',
            'ResponseParameters',
            'TemplateSelectionExpression',
            'TlsConfig',
          ].map((key) => [`update-remove:${key}`, apigwv2Kept('2635-2640', '#1160')])
        ),
      },
      expectedRemovalThrows: INTEGRATION_REQUIRED,
    },
    {
      name: 'service integration',
      bag: {
        ApiId: APIGWV2_API_ID,
        IntegrationType: 'AWS_PROXY',
        IntegrationSubtype: 'EventBridge-PutEvents',
        PayloadFormatVersion: '1.0',
        CredentialsArn: `arn:aws:iam::${ACCOUNT}:role/integration`,
        RequestParameters: {
          Detail: '$request.body',
          DetailType: 't',
          Source: 's',
        },
      },
      expectedSilent: {
        'update-remove:IntegrationType': INTEGRATION_TYPE_SILENT,
        'update-remove:PayloadFormatVersion': apigwv2Kept('2592-2596', '#1160'),
        'update-remove:CredentialsArn': apigwv2Kept('2635-2640', '#1160'),
        ...Object.fromEntries(
          [
            'RequestParameters',
            'RequestParameters.Detail',
            'RequestParameters.DetailType',
            'RequestParameters.Source',
          ].map((label) => [
            `update-remove:${label}`,
            apigwv2Kept(
              '2597-2619',
              '#5004; a dropped key alone is no change, and CloudFormation fails an update that drops a required one beside another change (3284-3287)'
            ),
          ])
        ),
      },
      expectedRemovalThrows: {
        ...INTEGRATION_REQUIRED,
        'update-remove:IntegrationSubtype': APIGWV2_REQUIRED(
          'a removed IntegrationSubtype without a declared IntegrationUri is refused before any call, as CloudFormation fails that update (real CloudFormation A/B, #1160; apigatewayv2-provider.ts:2696-2731)',
          /previous deploy recorded IntegrationSubtype/
        ),
      },
    },
  ],
};

// --- AWS::ApiGatewayV2::Route ----------------------------------------------------

const ROUTE_CASE: TypeCase = {
  resourceType: 'AWS::ApiGatewayV2::Route',
  provider: () => new ApiGatewayV2Provider(),
  physicalId: 'route-1',
  createOnly: createOnlyOf('AWS::ApiGatewayV2::Route'),
  exempt: {},
  nestedExempt: { 'RequestParameters.Required': APIGWV2_MAP_KEYED },
  targets: [],
  bags: [
    {
      name: 'every property',
      bag: {
        ApiId: APIGWV2_API_ID,
        RouteKey: 'GET /a',
        Target: 'integrations/int-1',
        AuthorizationType: 'JWT',
        AuthorizerId: 'auth-1',
        AuthorizationScopes: ['s1', 's2'],
        OperationName: 'op',
        ApiKeyRequired: true,
        ModelSelectionExpression: '$request.body.action',
        RequestModels: { 'application/json': 'm1', 'text/plain': 'm2' },
        RequestParameters: {
          'route.request.querystring.a': { Required: true },
          'route.request.querystring.b': { Required: false },
        },
        RouteResponseSelectionExpression: '$default',
      },
      expectedSilent: {
        'update-remove:RouteKey': apigwv2Required('RouteKey', '1262-1271'),
        'update-remove:Target': apigwv2Kept('2905-2922', '#1160'),
        'update-remove:AuthorizationType': apigwv2Kept('2923-2932', '#5004'),
        'update-remove:AuthorizerId': apigwv2Kept('2933-2942', '#5004'),
        'update-remove:OperationName': apigwv2Kept('2956-2965', '#5004'),
        ...Object.fromEntries(
          ['RequestModels', 'RequestModels.application/json', 'RequestModels.text/plain'].map(
            (label) => [
              `update-remove:${label}`,
              apigwv2Kept(
                '2978-2996',
                '#5004; RequestModels merges per key, and a dropped key stays live'
              ),
            ]
          )
        ),
        ...Object.fromEntries(
          [
            'RequestParameters',
            'RequestParameters.route.request.querystring.a',
            'RequestParameters.route.request.querystring.b',
          ].map((label) => [
            `update-remove:${label}`,
            apigwv2Kept(
              '2997-3018',
              '#5004; RequestParameters merges per key, and a dropped key stays live'
            ),
          ])
        ),
        'update-remove:ModelSelectionExpression': apigwv2Kept('3019-3029', '#1160'),
        'update-remove:RouteResponseSelectionExpression': apigwv2Kept('3030-3039', '#1160'),
      },
      expectedRemovalThrows: {
        'create:ApiId': APIGWV2_REQUIRED(
          'ApiId is required: create() refuses a route without it before any call (apigatewayv2-provider.ts:1262-1271)',
          /ApiId and RouteKey are required/
        ),
        'create:RouteKey': APIGWV2_REQUIRED(
          'RouteKey is required: create() refuses a route without it before any call (apigatewayv2-provider.ts:1262-1271)',
          /ApiId and RouteKey are required/
        ),
      },
    },
  ],
};

// --- AWS::ApiGatewayV2::Authorizer -----------------------------------------------

const AUTHORIZER_SILENT_REQUIRED = {
  'update-remove:AuthorizerType': apigwv2Required('AuthorizerType', '1394-1403'),
  'update-remove:Name':
    'Name is CloudFormation-required, so no deployable template removes it; create() falls back to the logical id for a missing one (apigatewayv2-provider.ts:1396)',
};

const AUTHORIZER_REQUIRED: Record<string, Throw> = {
  'create:ApiId': APIGWV2_REQUIRED(
    'ApiId is required: create() refuses an authorizer without it before any call (apigatewayv2-provider.ts:1394-1403)',
    /ApiId and AuthorizerType are required/
  ),
  'create:AuthorizerType': APIGWV2_REQUIRED(
    'AuthorizerType is required: create() refuses an authorizer without it before any call (apigatewayv2-provider.ts:1394-1403)',
    /ApiId and AuthorizerType are required/
  ),
};

const AUTHORIZER_CASE: TypeCase = {
  resourceType: 'AWS::ApiGatewayV2::Authorizer',
  provider: () => new ApiGatewayV2Provider(),
  physicalId: 'auth-1',
  createOnly: createOnlyOf('AWS::ApiGatewayV2::Authorizer'),
  exempt: {},
  targets: [],
  bags: [
    {
      name: 'JWT',
      bag: {
        ApiId: APIGWV2_API_ID,
        AuthorizerType: 'JWT',
        Name: 'auth',
        IdentitySource: ['$request.header.Authorization', '$request.header.X-Alt'],
        JwtConfiguration: {
          Audience: ['a1', 'a2'],
          Issuer: 'https://issuer.example',
        },
      },
      expectedSilent: {
        ...AUTHORIZER_SILENT_REQUIRED,
        'update-remove:JwtConfiguration': apigwv2Kept('3170-3181', '#1160'),
      },
      expectedRemovalThrows: AUTHORIZER_REQUIRED,
    },
    {
      name: 'REQUEST',
      bag: {
        ApiId: APIGWV2_API_ID,
        AuthorizerType: 'REQUEST',
        Name: 'auth',
        IdentitySource: ['$request.header.A', '$request.querystring.b'],
        AuthorizerUri: `arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:${ACCOUNT}:function:authz/invocations`,
        AuthorizerCredentialsArn: `arn:aws:iam::${ACCOUNT}:role/authz`,
        AuthorizerPayloadFormatVersion: '2.0',
        AuthorizerResultTtlInSeconds: 300,
        EnableSimpleResponses: true,
        IdentityValidationExpression: '.*',
      },
      expectedSilent: {
        ...AUTHORIZER_SILENT_REQUIRED,
        'update-remove:AuthorizerUri': apigwv2Kept('3182-3191', '#1160'),
        'update-remove:AuthorizerCredentialsArn': apigwv2Kept('3192-3201', '#5004'),
        'update-remove:AuthorizerPayloadFormatVersion': apigwv2Kept('3202-3212', '#5004'),
        'update-remove:AuthorizerResultTtlInSeconds': apigwv2Kept('3213-3223', '#5004'),
        'update-remove:EnableSimpleResponses': apigwv2Kept('3224-3233', '#1160'),
        'update-remove:IdentityValidationExpression': apigwv2Kept('3234-3244', '#5004'),
      },
      expectedRemovalThrows: AUTHORIZER_REQUIRED,
    },
  ],
};

const CASES_12_APIGWV2: TypeCase[] = [
  API_CASE,
  STAGE_CASE,
  INTEGRATION_CASE,
  ROUTE_CASE,
  AUTHORIZER_CASE,
];

// === ECSProvider ===========================================================

/**
 * The twelfth batch's ECS wire cases (#3723): the cluster, task definition and
 * service (`@aws-sdk/client-ecs`). The provider builds its own clients (a
 * `RegisterTaskDefinition` create client among them), so
 * `sdk-wire-coverage-12.test.ts` mocks the package.
 */

const ECS_ALL_DIRECTIONS = ['create', 'update-add', 'update-remove'];
const ECS_TAG_LIST = [
  { Key: 'k1', Value: 'v1' },
  { Key: 'k2', Value: 'v2' },
];
const ECS_KMS = `arn:aws:kms:us-east-1:${ACCOUNT}:key/k1`;
const ECS_ROLE = (name: string): string => `arn:aws:iam::${ACCOUNT}:role/${name}`;
const ECS_TG = (name: string): string =>
  `arn:aws:elasticloadbalancing:us-east-1:${ACCOUNT}:targetgroup/${name}/1`;
const ECS_RULE = (name: string): string =>
  `arn:aws:elasticloadbalancing:us-east-1:${ACCOUNT}:listener-rule/app/lb/1/2/${name}`;


/** The Untag targets: `UntagResource` names the removed key only. */
const ECS_TAG_TARGETS: TypeCase['targets'] = [
  { path: ['Tags', 0], command: 'UntagResourceCommand', names: '"k1"', notNames: '"k2"' },
  { path: ['Tags', 1], command: 'UntagResourceCommand', names: '"k2"', notNames: '"k1"' },
];

// --- AWS::ECS::Cluster -------------------------------------------------------------

const CLUSTER_NAME = 'cluster';
const CLUSTER_ARN = `arn:aws:ecs:us-east-1:${ACCOUNT}:cluster/${CLUSTER_NAME}`;

/**
 * `DescribeClusters` answers the cluster: `updateCluster` applies the tag diff
 * to the ARN it reads there and skips it on an empty answer
 * (ecs-provider.ts:1099-1115).
 */
const armCluster = (): void =>
  setOutputOverrides({
    DescribeClustersCommand: () => ({
      clusters: [{ clusterArn: CLUSTER_ARN, clusterName: CLUSTER_NAME }],
    }),
  });

const CLUSTER_CASE: TypeCase = {
  resourceType: 'AWS::ECS::Cluster',
  provider: () => new ECSProvider(),
  physicalId: CLUSTER_NAME,
  createOnly: createOnlyOf('AWS::ECS::Cluster'),
  arm: armCluster,
  wholeFromNext: {
    keys: (key) => key === 'CapacityProviders' || key === 'DefaultCapacityProviderStrategy',
    reason:
      'PutClusterCapacityProviders replaces BOTH lists from the desired bag whenever either is declared, a removed one as `[]` (ecs-provider.ts:1026-1040): the previous side is never read',
  },
  exempt: {},
  targets: ECS_TAG_TARGETS,
  bags: [
    {
      name: 'every property',
      bag: {
        ClusterName: CLUSTER_NAME,
        CapacityProviders: ['FARGATE', 'FARGATE_SPOT'],
        DefaultCapacityProviderStrategy: [
          { CapacityProvider: 'FARGATE', Weight: 1, Base: 1 },
          { CapacityProvider: 'FARGATE_SPOT', Weight: 2 },
        ],
        Configuration: {
          ExecuteCommandConfiguration: {
            KmsKeyId: ECS_KMS,
            Logging: 'OVERRIDE',
            LogConfiguration: {
              CloudWatchEncryptionEnabled: true,
              CloudWatchLogGroupName: 'exec-logs',
              S3BucketName: 'exec-bucket',
              S3EncryptionEnabled: true,
              S3KeyPrefix: 'exec',
            },
          },
          ManagedStorageConfiguration: {
            FargateEphemeralStorageKmsKeyId: `arn:aws:kms:us-east-1:${ACCOUNT}:key/k2`,
            KmsKeyId: ECS_KMS,
          },
        },
        ClusterSettings: [{ Name: 'containerInsights', Value: 'enabled' }],
        ServiceConnectDefaults: {
          Namespace: `arn:aws:servicediscovery:us-east-1:${ACCOUNT}:namespace/ns-1`,
        },
        Tags: fresh(ECS_TAG_LIST),
      },
      expectedRemovalThrows: TAG_THROWS(ECS_ALL_DIRECTIONS, 2),
    },
  ],
};

// --- AWS::ECS::TaskDefinition ------------------------------------------------------

const TASK_DEFINITION_ARN = `arn:aws:ecs:us-east-1:${ACCOUNT}:task-definition/family:1`;

const ECS_APP_CONTAINER = {
  Name: 'app',
  Image: `${ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/app:1`,
  Cpu: 256,
  Memory: 512,
  MemoryReservation: 256,
  Essential: true,
  Command: ['serve', '--port'],
  EntryPoint: ['sh', '-c'],
  Environment: [
    { Name: 'A', Value: '1' },
    { Name: 'B', Value: '2' },
  ],
  EnvironmentFiles: [{ Type: 's3', Value: 'arn:aws:s3:::bucket/app.env' }],
  Secrets: [
    { Name: 'S1', ValueFrom: `arn:aws:ssm:us-east-1:${ACCOUNT}:parameter/s1` },
    { Name: 'S2', ValueFrom: `arn:aws:ssm:us-east-1:${ACCOUNT}:parameter/s2` },
  ],
  PortMappings: [
    { ContainerPort: 80, HostPort: 80, Protocol: 'tcp', AppProtocol: 'http', Name: 'web' },
    { ContainerPortRange: '8000-8010', Protocol: 'udp' },
  ],
  MountPoints: [{ SourceVolume: 'host', ContainerPath: '/data', ReadOnly: true }],
  VolumesFrom: [{ SourceContainer: 'side', ReadOnly: false }],
  DependsOn: [{ ContainerName: 'side', Condition: 'START' }],
  Links: ['side'],
  WorkingDirectory: '/srv',
  DisableNetworking: false,
  Privileged: false,
  ReadonlyRootFilesystem: true,
  User: '1000',
  Ulimits: [{ Name: 'nofile', SoftLimit: 1024, HardLimit: 2048 }],
  LogConfiguration: {
    LogDriver: 'awslogs',
    Options: { 'awslogs-group': 'g', 'awslogs-region': 'us-east-1' },
    SecretOptions: [{ Name: 'token', ValueFrom: `arn:aws:ssm:us-east-1:${ACCOUNT}:parameter/t` }],
  },
  HealthCheck: {
    Command: ['CMD-SHELL', 'true'],
    Interval: 30,
    Timeout: 5,
    Retries: 3,
    StartPeriod: 10,
  },
  LinuxParameters: {
    Capabilities: { Add: ['NET_ADMIN', 'SYS_PTRACE'], Drop: ['MKNOD', 'CHOWN'] },
    Devices: [{ HostPath: '/dev/fuse', ContainerPath: '/dev/fuse', Permissions: ['read'] }],
    InitProcessEnabled: true,
    MaxSwap: 100,
    SharedMemorySize: 64,
    Swappiness: 10,
    Tmpfs: [{ ContainerPath: '/tmp', Size: 64, MountOptions: ['rw', 'noexec'] }],
  },
  DockerLabels: { team: 'a', tier: 'web' },
  StartTimeout: 30,
  StopTimeout: 20,
  Interactive: true,
  PseudoTerminal: true,
  RepositoryCredentials: {
    CredentialsParameter: `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:creds`,
  },
  FirelensConfiguration: {
    Type: 'fluentbit',
    Options: { 'enable-ecs-log-metadata': 'true', 'config-file-type': 'file' },
  },
  ResourceRequirements: [{ Type: 'GPU', Value: '1' }],
  SystemControls: [{ Namespace: 'net.core.somaxconn', Value: '1024' }],
  ExtraHosts: [{ Hostname: 'db', IpAddress: '10.0.0.1' }],
  RestartPolicy: { Enabled: true, IgnoredExitCodes: [0, 1], RestartAttemptPeriod: 60 },
  DnsServers: ['10.0.0.2', '10.0.0.3'],
  DnsSearchDomains: ['example.com', 'example.org'],
  DockerSecurityOptions: ['no-new-privileges', 'label:type:t'],
  CredentialSpecs: [`credentialspecdomainless:arn:aws:s3:::bucket/spec.json`],
  Hostname: 'app-host',
  VersionConsistency: 'enabled',
};

const ECS_VOLUMES = [
  {
    Name: 'host',
    Host: { SourcePath: '/var/data' },
    ConfiguredAtLaunch: false,
  },
  {
    Name: 'docker',
    DockerVolumeConfiguration: {
      Scope: 'shared',
      Autoprovision: true,
      Driver: 'local',
      DriverOpts: { type: 'nfs', device: ':/x' },
      Labels: { a: '1', b: '2' },
    },
  },
  {
    Name: 'efs',
    EFSVolumeConfiguration: {
      FilesystemId: 'fs-1',
      RootDirectory: '/root',
      TransitEncryption: 'ENABLED',
      TransitEncryptionPort: 2049,
      AuthorizationConfig: { AccessPointId: 'fsap-1', IAM: 'ENABLED' },
    },
  },
  {
    Name: 'fsx',
    FSxWindowsFileServerVolumeConfiguration: {
      FileSystemId: 'fs-2',
      RootDirectory: '\\share',
      AuthorizationConfig: {
        CredentialsParameter: `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:fsx`,
        Domain: 'corp.example',
      },
    },
  },
  {
    Name: 's3files',
    S3FilesVolumeConfiguration: {
      FileSystemArn: `arn:aws:s3files:us-east-1:${ACCOUNT}:file-system/fs-3`,
      AccessPointArn: `arn:aws:s3files:us-east-1:${ACCOUNT}:access-point/ap-3`,
      RootDirectory: '/s3',
      TransitEncryptionPort: 2050,
    },
  },
  {
    Name: 'ebs',
    ConfiguredAtLaunch: true,
  },
];

const TASK_DEFINITION_CASE: TypeCase = {
  resourceType: 'AWS::ECS::TaskDefinition',
  provider: () => new ECSProvider(),
  physicalId: TASK_DEFINITION_ARN,
  // Every handled key but Tags is create-only in the schema, so their update
  // probes are skipped (the engine replaces); the create and create-vary
  // probes are what read them.
  createOnly: createOnlyOf('AWS::ECS::TaskDefinition'),
  exempt: {},
  // InferenceAccelerators is unhandled by design (ecs-provider.ts:561-571), so
  // no bag carries it; the nested-path check reads carried top-levels only.
  targets: ECS_TAG_TARGETS,
  bags: [
    {
      name: 'every property',
      bag: {
        Family: 'family',
        ContainerDefinitions: [
          fresh(ECS_APP_CONTAINER),
          { Name: 'side', Image: `${ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/side:1` },
        ],
        Cpu: '256',
        Memory: '512',
        NetworkMode: 'awsvpc',
        RequiresCompatibilities: ['FARGATE', 'EC2'],
        ExecutionRoleArn: ECS_ROLE('exec'),
        TaskRoleArn: ECS_ROLE('task'),
        Volumes: fresh(ECS_VOLUMES),
        PlacementConstraints: [
          { Type: 'memberOf', Expression: 'attribute:ecs.instance-type =~ t3.*' },
        ],
        RuntimePlatform: { CpuArchitecture: 'ARM64', OperatingSystemFamily: 'LINUX' },
        ProxyConfiguration: {
          Type: 'APPMESH',
          ContainerName: 'side',
          ProxyConfigurationProperties: [
            { Name: 'IgnoredUID', Value: '1337' },
            { Name: 'ProxyIngressPort', Value: '15000' },
          ],
        },
        PidMode: 'task',
        IpcMode: 'task',
        EphemeralStorage: { SizeInGiB: 30 },
        EnableFaultInjection: true,
        Tags: fresh(ECS_TAG_LIST),
      },
      expectedRemovalThrows: TAG_THROWS(ECS_ALL_DIRECTIONS, 2),
    },
  ],
};

// --- AWS::ECS::Service -------------------------------------------------------------

const SERVICE_ARN = `arn:aws:ecs:us-east-1:${ACCOUNT}:service/${CLUSTER_NAME}/svc`;

/**
 * Keys `updateService` sends from the desired bag on EVERY update, never
 * reading the previous side, so a removal sends nothing (ecs-provider.ts:
 * 2256-2273, 2394-2416). CloudFormation keeps the live value on the removal
 * of the eight measured in a real A/B (#5004, ecs-provider.ts:476-489,
 * 2251-2255); DesiredCount follows CloudFormation's documented rule that an
 * existing service's absent desired count is omitted from the operation;
 * TaskDefinition / NetworkConfiguration are the provider's "always-carried"
 * pass-throughs (ecs-provider.ts:2247-2250): UpdateService keeps an absent one.
 */
const SERVICE_FROM_NEXT = new Set([
  'TaskDefinition',
  'DesiredCount',
  'NetworkConfiguration',
  'CapacityProviderStrategy',
  'PlacementConstraints',
  'PlacementStrategies',
  'PlatformVersion',
  'HealthCheckGracePeriodSeconds',
  'EnableECSManagedTags',
  'PropagateTags',
  'EnableExecuteCommand',
]);

const SERVICE_DEPLOYMENT_CONFIGURATION = {
  MaximumPercent: 200,
  MinimumHealthyPercent: 50,
  DeploymentCircuitBreaker: {
    Enable: true,
    Rollback: true,
    ResetOnHealthyTask: false,
    ThresholdConfiguration: { Type: 'COUNT', Value: 7 },
  },
  Alarms: { AlarmNames: ['a1', 'a2'], Enable: true, Rollback: true },
  Strategy: 'ROLLING',
  BakeTimeInMinutes: 5,
  LifecycleHooks: [
    {
      HookTargetArn: `arn:aws:lambda:us-east-1:${ACCOUNT}:function:hook`,
      RoleArn: ECS_ROLE('hook'),
      LifecycleStages: ['PRE_SCALE_UP', 'POST_SCALE_UP'],
      TargetType: 'AWS_LAMBDA',
      HookDetails: { mode: 'strict' },
      TimeoutConfiguration: { Action: 'ROLLBACK', TimeoutInMinutes: 30 },
    },
  ],
  LinearConfiguration: { StepPercent: 33, StepBakeTimeInMinutes: 9 },
  CanaryConfiguration: { CanaryPercent: 21, CanaryBakeTimeInMinutes: 9 },
  EarlySuccessCriteria: { Enable: true, HealthyPercent: 90, SourceServiceRevisionCleanup: 'ENABLED' },
};

/**
 * `update-remove` under DeploymentConfiguration: the block is sent whole from
 * the desired bag (ecs-provider.ts:2387-2409), and only the circuit breaker's
 * two optional members reset on removal (ecs-provider.ts:3504-3573).
 */
const DEPLOYMENT_CONFIGURATION_SILENT: Record<string, string> = Object.fromEntries([
  [
    'update-remove:DeploymentConfiguration',
    'a whole-block removal resets nothing: CloudFormation kept the live configuration too (CFn A/B us-east-1 2026-08-13, ecs-provider.ts:2092-2095)',
  ],
  ...paths(SERVICE_DEPLOYMENT_CONFIGURATION)
    .map((p) => p.join('.'))
    .filter(
      (p) =>
        p !== 'DeploymentCircuitBreaker.ResetOnHealthyTask' &&
        p !== 'DeploymentCircuitBreaker.ThresholdConfiguration'
    )
    .map((p) => [
      `update-remove:DeploymentConfiguration.${p}`,
      'a member dropped from a still-declared DeploymentConfiguration is sent as the desired block; UpdateService merges the top level and replaces / default-fills the nested blocks, the end state CloudFormation reached for the same template (CFn A/B us-east-1 2026-08-13, ecs-provider.ts:2083-2154, 2233-2235); a required member it drops is refused by CloudFormation and by the nested-required pre-flight (ecs-provider.ts:2096-2117, 2163-2183)',
    ]),
  [
    'update-remove:DeploymentConfiguration.DeploymentCircuitBreaker',
    'the whole circuit breaker dropped from a still-declared DeploymentConfiguration resets nothing: the provider passes it through by design, and CloudFormation is unmeasured for this removal (ecs-provider.ts:3456-3460)',
  ],
]);

const SERVICE_TOP = {
  Cluster: CLUSTER_NAME,
  ServiceName: 'svc',
  TaskDefinition: TASK_DEFINITION_ARN,
  DesiredCount: 2,
  NetworkConfiguration: {
    AwsvpcConfiguration: {
      Subnets: ['subnet-1', 'subnet-2'],
      SecurityGroups: ['sg-1', 'sg-2'],
      AssignPublicIp: 'DISABLED',
    },
  },
  LoadBalancers: [
    {
      TargetGroupArn: ECS_TG('blue'),
      ContainerName: 'app',
      ContainerPort: 80,
      AdvancedConfiguration: {
        AlternateTargetGroupArn: ECS_TG('green'),
        ProductionListenerRule: ECS_RULE('prod'),
        TestListenerRule: ECS_RULE('test'),
        RoleArn: ECS_ROLE('bluegreen'),
      },
    },
    { LoadBalancerName: 'classic', ContainerName: 'app', ContainerPort: 81 },
  ],
  DeploymentConfiguration: fresh(SERVICE_DEPLOYMENT_CONFIGURATION),
  PlacementConstraints: [{ Type: 'memberOf', Expression: 'attribute:ecs.os-type == linux' }],
  PlacementStrategies: [
    { Type: 'spread', Field: 'attribute:ecs.availability-zone' },
    { Type: 'binpack', Field: 'memory' },
  ],
  PlatformVersion: '1.4.0',
  HealthCheckGracePeriodSeconds: 60,
  SchedulingStrategy: 'REPLICA',
  EnableECSManagedTags: true,
  PropagateTags: 'SERVICE',
  EnableExecuteCommand: true,
  ServiceRegistries: [
    {
      RegistryArn: `arn:aws:servicediscovery:us-east-1:${ACCOUNT}:service/srv-1`,
      Port: 80,
      ContainerName: 'app',
      ContainerPort: 80,
    },
  ],
  Tags: fresh(ECS_TAG_LIST),
  AvailabilityZoneRebalancing: 'ENABLED',
  DeploymentController: { Type: 'ECS' },
  Monitoring: { MetricConfigurations: [{ MetricNames: ['m1', 'm2'], ResolutionSeconds: 20 }] },
  Role: ECS_ROLE('ecs-service'),
  ServiceConnectConfiguration: {
    Enabled: true,
    Namespace: 'ns',
    Services: [
      {
        PortName: 'web',
        DiscoveryName: 'web-d',
        IngressPortOverride: 8080,
        ClientAliases: [
          {
            DnsName: 'web.local',
            Port: 80,
            TestTrafficRules: { Header: { Name: 'x-canary', Value: { Exact: 'yes' } } },
          },
        ],
        Timeout: { IdleTimeoutSeconds: 10, PerRequestTimeoutSeconds: 5 },
        Tls: {
          IssuerCertificateAuthority: {
            AwsPcaAuthorityArn: `arn:aws:acm-pca:us-east-1:${ACCOUNT}:certificate-authority/ca`,
          },
          KmsKey: ECS_KMS,
          RoleArn: ECS_ROLE('tls'),
        },
      },
    ],
    LogConfiguration: {
      LogDriver: 'awslogs',
      Options: { 'awslogs-group': 'sc' },
      SecretOptions: [{ Name: 'n', ValueFrom: `arn:aws:ssm:us-east-1:${ACCOUNT}:parameter/n` }],
    },
    AccessLogConfiguration: { Format: 'TEXT', IncludeQueryParameters: 'ENABLED' },
  },
  VolumeConfigurations: [
    {
      Name: 'ebs',
      ManagedEBSVolume: {
        Encrypted: true,
        FilesystemType: 'ext4',
        Iops: 3000,
        KmsKeyId: ECS_KMS,
        RoleArn: ECS_ROLE('ebs'),
        SizeInGiB: 10,
        SnapshotId: 'snap-1',
        Throughput: 125,
        VolumeInitializationRate: 100,
        VolumeType: 'gp3',
        TagSpecifications: [
          { ResourceType: 'volume', PropagateTags: 'SERVICE', Tags: [{ Key: 'v', Value: '1' }] },
        ],
      },
    },
  ],
  VpcLatticeConfigurations: [
    {
      RoleArn: ECS_ROLE('lattice'),
      TargetGroupArn: `arn:aws:vpc-lattice:us-east-1:${ACCOUNT}:targetgroup/tg-1`,
      PortName: 'web',
      AdvancedConfiguration: {
        AlternateTargetGroupArn: `arn:aws:vpc-lattice:us-east-1:${ACCOUNT}:targetgroup/tg-2`,
        ProductionListenerRule: `arn:aws:vpc-lattice:us-east-1:${ACCOUNT}:service/s/listener/l/rule/p`,
        TestListenerRule: `arn:aws:vpc-lattice:us-east-1:${ACCOUNT}:service/s/listener/l/rule/t`,
      },
    },
  ],
};

/** ForceNewDeployment: a one-shot trigger CreateService has no member for. */
const FORCE_NEW_DEPLOYMENT_CREATE =
  'ForceNewDeployment is an UpdateService-only trigger: CreateService has no such member, and the initial deployment is a fresh rollout (ecs-provider.ts:1532-1536, 3711-3712)';
const FORCE_NEW_DEPLOYMENT_REMOVED =
  'an absent ForceNewDeployment (or member) forces nothing: the SDK member is a one-shot boolean, never persisted state, so a removal has nothing to reset (ecs-provider.ts:3723-3745)';

const forceNewDeploymentSilent = (members: string[]): Record<string, string> => ({
  'create:ForceNewDeployment': FORCE_NEW_DEPLOYMENT_CREATE,
  'update-remove:ForceNewDeployment': FORCE_NEW_DEPLOYMENT_REMOVED,
  ...Object.fromEntries(
    members.flatMap((m) => [
      [`create:ForceNewDeployment.${m}`, FORCE_NEW_DEPLOYMENT_CREATE],
      [`create-vary:ForceNewDeployment.${m}`, FORCE_NEW_DEPLOYMENT_CREATE],
      [`update-remove:ForceNewDeployment.${m}`, FORCE_NEW_DEPLOYMENT_REMOVED],
    ])
  ),
});

const LAUNCH_TYPE_SILENT: Record<string, string> = {
  'update-add:LaunchType':
    'an added LaunchType replaces the service (replacement-rules.ts:221-242, 1045-1048, measured against CloudFormation), so a deploy never brings one to update(); the rollback revert that can passes and sends nothing, as UpdateService has no launchType member (ecs-provider.ts:1914-1941); `describeEcsExtras` pins the refusals',
  'update-remove:LaunchType':
    'a removed LaunchType updates in place and CloudFormation KEEPS the live launch type (replacement-rules.ts:221-239), so sending nothing is parity (ecs-provider.ts:1914-1917)',
  'update-vary:LaunchType':
    'a changed LaunchType replaces the service (replacement-rules.ts:221-242); the vary base lacks it, so this is the add above. `describeEcsExtras` pins that update() refuses a change and sends nothing',
};

const SERVICE_CASE: TypeCase = {
  resourceType: 'AWS::ECS::Service',
  provider: () => new ECSProvider(),
  physicalId: SERVICE_ARN,
  createOnly: createOnlyOf('AWS::ECS::Service'),
  wholeFromNext: {
    keys: (key) => SERVICE_FROM_NEXT.has(key),
    reason:
      'sent from the desired bag on every UpdateService, so a removal sends nothing and the live value stays: for the eight keys a CloudFormation A/B measured, as CloudFormation keeps it (#5004, ecs-provider.ts:476-489); DesiredCount by CloudFormation\'s documented omit-on-update rule; TaskDefinition / NetworkConfiguration as the provider\'s always-carried pass-throughs, unmeasured against CloudFormation (ecs-provider.ts:2247-2250; see SERVICE_FROM_NEXT)',
  },
  exempt: {},
  targets: ECS_TAG_TARGETS,
  bags: [
    {
      name: 'launch type, every other property',
      bag: {
        ...fresh(SERVICE_TOP),
        LaunchType: 'FARGATE',
        ForceNewDeployment: { ForceNewDeploymentNonce: 'n1' },
      },
      expectedSilent: {
        ...LAUNCH_TYPE_SILENT,
        ...DEPLOYMENT_CONFIGURATION_SILENT,
        ...forceNewDeploymentSilent(['ForceNewDeploymentNonce']),
        'update-vary:ForceNewDeployment.ForceNewDeploymentNonce':
          'the nonce is read only as changed-or-not against the previous one; any changed value sends the same `forceNewDeployment: true` (ecs-provider.ts:3739-3745)',
        'update-remove:AvailabilityZoneRebalancing':
          'left in place on removal: CloudFormation KEEPS the live value (DISABLED stayed DISABLED, CFn A/B #5004/#1160), and UpdateService keeps an absent member (ecs-provider.ts:2288-2290)',
        'update-remove:DeploymentController':
          'absent means the default ECS controller, and sending nothing keeps the live one; a controller change is sent only when declared and changed (ecs-provider.ts:2294-2298, 2310-2318). The provider does not reset by design; CloudFormation is unmeasured for this removal',
      },
      expectedRemovalThrows: TAG_THROWS(ECS_ALL_DIRECTIONS, 2),
    },
    {
      // The capacity provider route (no LaunchType, which AWS refuses beside a
      // strategy) and the enable arm of ForceNewDeployment.
      name: 'capacity provider strategy, forced deployment',
      bag: {
        Cluster: CLUSTER_NAME,
        ServiceName: 'svc',
        TaskDefinition: TASK_DEFINITION_ARN,
        CapacityProviderStrategy: [
          { CapacityProvider: 'FARGATE', Weight: 1, Base: 1 },
          { CapacityProvider: 'FARGATE_SPOT', Weight: 2 },
        ],
        ForceNewDeployment: { EnableForceNewDeployment: true },
      },
      expectedSilent: forceNewDeploymentSilent(['EnableForceNewDeployment']),
    },
  ],
};

const CASES_12_ECS: TypeCase[] = [CLUSTER_CASE, TASK_DEFINITION_CASE, SERVICE_CASE];

/** Direct-call checks the bag probes cannot make. */
export function describeEcsExtras(): void {
  describe('AWS::ECS::Service LaunchType on update', () => {
    const bag = SERVICE_CASE.bags[0]!.bag;
    const run = (next: Bag, prev: Bag, desiredFromAwsReadback = false) => {
      let thrown: unknown;
      setOutputOverrides(undefined);
      return record(async () => {
        try {
          await new ECSProvider().update(
            'L',
            SERVICE_ARN,
            'AWS::ECS::Service',
            structuredClone(next),
            structuredClone(prev),
            desiredFromAwsReadback ? { desiredFromAwsReadback } : undefined
          );
        } catch (error) {
          thrown = error;
        }
      }).then((outcome) => ({ outcome, thrown }));
    };

    it('refuses a changed LaunchType and sends nothing', async () => {
      const { outcome, thrown } = await run({ ...bag, LaunchType: 'EC2' }, bag);
      expect(outcome).toEqual({ threw: false, wire: '' });
      expect(thrown).toBeInstanceOf(ResourceUpdateNotSupportedError);
      expect((thrown as Error).message).toContain('cannot change a service launch type');
    });

    it('refuses an added LaunchType under drift --revert and sends nothing', async () => {
      const { LaunchType: _omit, ...prev } = bag;
      const { outcome, thrown } = await run(bag, prev, true);
      expect(outcome).toEqual({ threw: false, wire: '' });
      expect(thrown).toBeInstanceOf(ResourceUpdateNotSupportedError);
      expect((thrown as Error).message).toContain('drift --revert cannot restore it');
    });
  });
}

// === ELBv2Provider =========================================================

/**
 * The ELBv2 provider's wire cases (#3723, batch 12): the load balancer, the
 * target group and the listener (`@aws-sdk/client-elastic-load-balancing-v2`,
 * whose client the provider builds itself). The test that runs them mocks that
 * package.
 */

const ELBV2_ALL_DIRECTIONS = ['create', 'update-add', 'update-remove'];
const ELBV2_REQUIRED = (why: string, says: RegExp): Throw => ({ why, says });
const ELBV2_TAG_LIST = [
  { Key: 'k1', Value: 'v1' },
  { Key: 'k2', Value: 'v2' },
];
const ELBV2_TAG_TARGETS = [
  // RemoveTags names the removed key only.
  { path: ['Tags', 0], command: 'RemoveTagsCommand', names: 'k1', notNames: 'k2' },
  { path: ['Tags', 1], command: 'RemoveTagsCommand', names: 'k2', notNames: 'k1' },
];


const ELBV2_PREFIX = `arn:aws:elasticloadbalancing:us-east-1:${ACCOUNT}`;
const ELBV2_LB_ARN = `${ELBV2_PREFIX}:loadbalancer/net/lb/0123456789abcdef`;
const ELBV2_TG_ARN = `${ELBV2_PREFIX}:targetgroup/tg/0123456789abcdef`;
const ELBV2_LISTENER_ARN = `${ELBV2_PREFIX}:listener/app/lb/0123456789abcdef/fedcba9876543210`;

/**
 * A removed attribute key is never sent: it keeps its live value, as
 * CloudFormation leaves it (CFn A/B us-east-1 2026-10-17,
 * elbv2-provider.ts:385-397).
 */
const ELBV2_ATTRIBUTE_RETAINED =
  'a removed attribute key keeps its live value, as CloudFormation leaves it (CFn A/B 2026-10-17, RETAIN_REMOVED_ATTRIBUTE, elbv2-provider.ts:385-397)';

/** `update-remove` labels of a two-entry attribute list whose removal sends nothing. */
const elbv2AttributeRemovals = (bag: string): Record<string, string> =>
  Object.fromEntries(
    [bag, `${bag}.0`, `${bag}.0.Key`, `${bag}.1`, `${bag}.1.Key`].map((label) => [
      `update-remove:${label}`,
      ELBV2_ATTRIBUTE_RETAINED,
    ])
  );

// --- AWS::ElasticLoadBalancingV2::LoadBalancer -----------------------------------

/**
 * CreateLoadBalancer answers the ARN, and the active wait's first
 * DescribeLoadBalancers reads `active`.
 */
function armElbv2LoadBalancer(): void {
  setOutputOverrides({
    CreateLoadBalancerCommand: () => ({
      LoadBalancers: [{ LoadBalancerArn: ELBV2_LB_ARN, LoadBalancerName: 'lb' }],
    }),
    DescribeLoadBalancersCommand: () => ({
      LoadBalancers: [{ LoadBalancerArn: ELBV2_LB_ARN, State: { Code: 'active' } }],
    }),
  });
}

const ELBV2_LB_FLAG_RETAINED = (key: string): string =>
  `${key} rides on a Set* call and a removed flag is left in place, as CloudFormation leaves it (CFn A/B 2026-10-17; AWS retains it when the Set* call omits it, A/B 2026-08-12; elbv2-provider.ts:1707-1723, 1753-1764, 763-766)`;

const LOAD_BALANCER_CASE: TypeCase = {
  resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
  provider: () => new ELBv2Provider(),
  physicalId: ELBV2_LB_ARN,
  createOnly: createOnlyOf('AWS::ElasticLoadBalancingV2::LoadBalancer'),
  arm: () => armElbv2LoadBalancer(),
  exempt: {
    EnableCapacityReservationProvisionStabilize:
      'a CloudFormation-only wait flag with no SDK member: it only gates a DescribeCapacityReservation poll (a read, which the wire capture leaves out) after ModifyCapacityReservation (elbv2-provider.ts:1422-1451, 1881-1887)',
  },
  targets: ELBV2_TAG_TARGETS,
  bags: [
    {
      name: 'network load balancer, subnet mappings, every other property',
      bag: fresh({
        Name: 'lb',
        Scheme: 'internal',
        Type: 'network',
        IpAddressType: 'dualstack',
        SubnetMappings: [
          {
            SubnetId: 'subnet-1',
            AllocationId: 'eipalloc-1',
            PrivateIPv4Address: '10.0.0.10',
            IPv6Address: '2600:1f18::10',
            SourceNatIpv6Prefix: '2600:1f18:0:1::/80',
          },
          { SubnetId: 'subnet-2' },
        ],
        SecurityGroups: ['sg-1', 'sg-2'],
        EnablePrefixForIpv6SourceNat: 'on',
        EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic: 'off',
        Ipv4IpamPoolId: 'ipam-pool-1',
        MinimumLoadBalancerCapacity: { CapacityUnits: 100 },
        LoadBalancerAttributes: [
          { Key: 'deletion_protection.enabled', Value: 'false' },
          { Key: 'load_balancing.cross_zone.enabled', Value: 'true' },
        ],
        Tags: ELBV2_TAG_LIST,
      }),
      expectedSilent: {
        'update-remove:EnablePrefixForIpv6SourceNat': ELBV2_LB_FLAG_RETAINED(
          'EnablePrefixForIpv6SourceNat'
        ),
        'update-remove:EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic': ELBV2_LB_FLAG_RETAINED(
          'EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic'
        ),
        ...elbv2AttributeRemovals('LoadBalancerAttributes'),
      },
      expectedRemovalThrows: TAG_THROWS(ELBV2_ALL_DIRECTIONS, 2),
    },
    {
      // The SetSubnets arm that sends `Subnets` (SubnetMappings wins when both
      // are declared, elbv2-provider.ts:1724-1735).
      name: 'application load balancer, subnets',
      bag: { Subnets: ['subnet-1', 'subnet-2'] },
    },
  ],
};

// --- AWS::ElasticLoadBalancingV2::TargetGroup ------------------------------------

function armElbv2TargetGroup(): void {
  setOutputOverrides({
    CreateTargetGroupCommand: () => ({
      TargetGroups: [{ TargetGroupArn: ELBV2_TG_ARN, TargetGroupName: 'tg' }],
    }),
  });
}

/**
 * ModifyTargetGroup is built from the desired bag, and a removed health-check
 * member is passed through: CloudFormation keeps every one but HealthCheckPort
 * (CFn A/B 2026-08-10, re-run 2026-10-17, elbv2-provider.ts:2388-2399).
 */
const ELBV2_HEALTH_CHECK_RETAINED =
  'a removed health-check member is left in place, as CloudFormation leaves it (CFn A/B 2026-08-10 and 2026-10-17; only HealthCheckPort is reset, elbv2-provider.ts:2388-2404)';

const ELBV2_TARGETS_REFUSED = ELBV2_REQUIRED(
  'a Targets entry without its Id is refused before any call (go-to-k/cdkd#3989, elbv2-provider.ts:2116-2128, 3259-3270)',
  /is not a list of targets/
);

const ELBV2_TARGET_CONTROL_PORT_REFUSED = ELBV2_REQUIRED(
  'TargetControlPort has no modify API: a change is refused with ResourceUpdateNotSupportedError, which the engine turns into a replacement (elbv2-provider.ts:2330-2359)',
  /TargetControlPort is immutable/
);

const TARGET_GROUP_CASE: TypeCase = {
  resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup',
  provider: () => new ELBv2Provider(),
  physicalId: ELBV2_TG_ARN,
  createOnly: createOnlyOf('AWS::ElasticLoadBalancingV2::TargetGroup'),
  arm: () => armElbv2TargetGroup(),
  exempt: {},
  targets: [
    ...ELBV2_TAG_TARGETS,
    // DeregisterTargets names the removed target only.
    { path: ['Targets', 0], command: 'DeregisterTargetsCommand', names: 'i-1', notNames: 'i-2' },
    { path: ['Targets', 1], command: 'DeregisterTargetsCommand', names: 'i-2', notNames: 'i-1' },
  ],
  bags: [
    {
      name: 'every property',
      bag: fresh({
        Name: 'tg',
        Protocol: 'HTTP',
        Port: 80,
        VpcId: 'vpc-1',
        TargetType: 'instance',
        ProtocolVersion: 'HTTP1',
        IpAddressType: 'ipv4',
        HealthCheckProtocol: 'HTTP',
        HealthCheckPort: '8081',
        HealthCheckPath: '/health',
        HealthCheckEnabled: true,
        HealthCheckIntervalSeconds: 30,
        HealthCheckTimeoutSeconds: 5,
        HealthyThresholdCount: 3,
        UnhealthyThresholdCount: 2,
        Matcher: { HttpCode: '200', GrpcCode: '0' },
        TargetControlPort: 9000,
        TargetGroupAttributes: [
          { Key: 'deregistration_delay.timeout_seconds', Value: '30' },
          { Key: 'stickiness.enabled', Value: 'false' },
        ],
        // A Port other than the group's, so a removed one (defaulted to the
        // group port, elbv2-provider.ts:339-372) is another tuple. The first
        // entry's QuicServerId alone changing takes the deregister-first arm
        // (go-to-k/cdkd#5398, elbv2-provider.ts:2479-2500).
        Targets: [
          {
            Id: 'i-1',
            Port: 8080,
            AvailabilityZone: 'us-east-1a',
            QuicServerId: '0x1111111111111111',
          },
          { Id: 'i-2' },
        ],
        Tags: ELBV2_TAG_LIST,
      }),
      expectedSilent: {
        ...Object.fromEntries(
          [
            'HealthCheckProtocol',
            'HealthCheckPath',
            'HealthCheckEnabled',
            'HealthCheckIntervalSeconds',
            'HealthCheckTimeoutSeconds',
            'HealthyThresholdCount',
            'UnhealthyThresholdCount',
            'Matcher',
            'Matcher.HttpCode',
            'Matcher.GrpcCode',
          ].map((label) => [`update-remove:${label}`, ELBV2_HEALTH_CHECK_RETAINED])
        ),
        ...elbv2AttributeRemovals('TargetGroupAttributes'),
        'update-vary:TargetControlPort':
          'TargetControlPort has no modify API: every in-place change is refused before any call and replaced by the engine (elbv2-provider.ts:2330-2359); create-vary reads its value',
      },
      expectedRemovalThrows: {
        ...TAG_THROWS(ELBV2_ALL_DIRECTIONS, 2),
        ...Object.fromEntries(
          ELBV2_ALL_DIRECTIONS.flatMap((d) => [
            [`${d}:Targets.0.Id`, ELBV2_TARGETS_REFUSED],
            [`${d}:Targets.1.Id`, ELBV2_TARGETS_REFUSED],
          ])
        ),
        'update-add:TargetControlPort': ELBV2_TARGET_CONTROL_PORT_REFUSED,
        'update-remove:TargetControlPort': ELBV2_TARGET_CONTROL_PORT_REFUSED,
      },
    },
  ],
};

// --- AWS::ElasticLoadBalancingV2::Listener ---------------------------------------

function armElbv2Listener(): void {
  setOutputOverrides({
    CreateListenerCommand: () => ({ Listeners: [{ ListenerArn: ELBV2_LISTENER_ARN }] }),
  });
}

/**
 * ModifyListener is built from the desired bag alone: a nested change re-sends
 * the whole DefaultActions / Certificates / MutualAuthentication, and a removed
 * top-level is left in place, as CloudFormation leaves each of them (CFn A/B
 * us-east-1 2026-10-20, LISTENER_LEFT_IN_PLACE_ON_REMOVAL,
 * elbv2-provider.ts:559-576, 2885-2937); DefaultActions is required.
 * ListenerAttributes and Tags are diffed against the previous side.
 */
const LISTENER_FROM_NEXT = {
  keys: (key: string) => key !== 'ListenerAttributes' && key !== 'Tags',
  reason:
    'ModifyListener is a full send from the desired bag; a removed property is left in place as CloudFormation leaves it (CFn A/B 2026-10-20, elbv2-provider.ts:559-576, 2920-2937)',
};

const ELBV2_TG_ARN_2 = `${ELBV2_PREFIX}:targetgroup/tg2/0123456789abcdef`;
const ELBV2_USER_POOL = `arn:aws:cognito-idp:us-east-1:${ACCOUNT}:userpool/us-east-1_abc`;

const LISTENER_CASE: TypeCase = {
  resourceType: 'AWS::ElasticLoadBalancingV2::Listener',
  provider: () => new ELBv2Provider(),
  physicalId: ELBV2_LISTENER_ARN,
  createOnly: createOnlyOf('AWS::ElasticLoadBalancingV2::Listener'),
  arm: () => armElbv2Listener(),
  wholeFromNext: LISTENER_FROM_NEXT,
  exempt: {},
  targets: ELBV2_TAG_TARGETS,
  bags: [
    {
      name: 'every property, one action of each kind',
      bag: fresh({
        LoadBalancerArn: ELBV2_LB_ARN,
        Port: 443,
        Protocol: 'HTTPS',
        SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
        Certificates: [
          { CertificateArn: `arn:aws:acm:us-east-1:${ACCOUNT}:certificate/c1` },
          { CertificateArn: `arn:aws:acm:us-east-1:${ACCOUNT}:certificate/c2` },
        ],
        AlpnPolicy: ['HTTP2Preferred'],
        MutualAuthentication: {
          Mode: 'verify',
          TrustStoreArn: `${ELBV2_PREFIX}:truststore/ts/0123456789abcdef`,
          IgnoreClientCertificateExpiry: false,
          AdvertiseTrustStoreCaNames: 'on',
        },
        ListenerAttributes: [
          { Key: 'routing.http.response.server.enabled', Value: 'false' },
          { Key: 'routing.http.response.x_frame_options.header_value', Value: 'DENY' },
        ],
        DefaultActions: [
          {
            Type: 'authenticate-cognito',
            Order: 1,
            AuthenticateCognitoConfig: {
              UserPoolArn: ELBV2_USER_POOL,
              UserPoolClientId: 'client',
              UserPoolDomain: 'domain',
              SessionCookieName: 'cookie',
              Scope: 'openid',
              SessionTimeout: 3600,
              OnUnauthenticatedRequest: 'authenticate',
              AuthenticationRequestExtraParams: { display: 'page', prompt: 'login' },
            },
          },
          {
            Type: 'authenticate-oidc',
            Order: 2,
            AuthenticateOidcConfig: {
              Issuer: 'https://idp.example',
              AuthorizationEndpoint: 'https://idp.example/authorize',
              TokenEndpoint: 'https://idp.example/token',
              UserInfoEndpoint: 'https://idp.example/userinfo',
              ClientId: 'oidc-client',
              ClientSecret: 'oidc-secret',
              SessionCookieName: 'oidc-cookie',
              Scope: 'openid email',
              SessionTimeout: 7200,
              OnUnauthenticatedRequest: 'deny',
              UseExistingClientSecret: false,
              AuthenticationRequestExtraParams: { a: '1', b: '2' },
            },
          },
          {
            Type: 'jwt-validation',
            Order: 3,
            JwtValidationConfig: {
              JwksEndpoint: 'https://idp.example/jwks',
              Issuer: 'https://idp.example',
              AdditionalClaims: [
                { Format: 'string-array', Name: 'scope', Values: ['read', 'write'] },
                { Format: 'single-string', Name: 'aud', Values: ['api'] },
              ],
            },
          },
          {
            Type: 'forward',
            Order: 4,
            TargetGroupArn: ELBV2_TG_ARN,
            ForwardConfig: {
              TargetGroups: [
                { TargetGroupArn: ELBV2_TG_ARN, Weight: 1 },
                { TargetGroupArn: ELBV2_TG_ARN_2, Weight: 2 },
              ],
              TargetGroupStickinessConfig: { Enabled: true, DurationSeconds: 300 },
            },
          },
          {
            Type: 'redirect',
            Order: 5,
            RedirectConfig: {
              Protocol: 'HTTPS',
              Port: '443',
              Host: '#{host}',
              Path: '/#{path}',
              Query: '#{query}',
              StatusCode: 'HTTP_301',
            },
          },
          {
            Type: 'fixed-response',
            Order: 6,
            FixedResponseConfig: {
              StatusCode: '200',
              ContentType: 'text/plain',
              MessageBody: 'ok',
            },
          },
        ],
        Tags: ELBV2_TAG_LIST,
      }),
      expectedSilent: elbv2AttributeRemovals('ListenerAttributes'),
      expectedRemovalThrows: TAG_THROWS(ELBV2_ALL_DIRECTIONS, 2),
    },
  ],
};

const CASES_12_ELBV2: TypeCase[] = [LOAD_BALANCER_CASE, TARGET_GROUP_CASE, LISTENER_CASE];

// === FirehoseProvider ======================================================

/**
 * The Firehose delivery stream's wire case (#3723, batch 12)
 * (`@aws-sdk/client-firehose`, whose provider builds its own clients, a create
 * client among them). Destinations are mutually exclusive, so each handled
 * destination is carried by bags of its own: a full one, and one with the
 * alternatives (a KMS-encrypted bucket where the full bag declares
 * `NoEncryptionConfig`, a VPC, the other serializer / deserializer, a Secrets
 * Manager credential). `IcebergDestinationConfiguration`,
 * `SnowflakeDestinationConfiguration` and the source configurations other
 * than Kinesis are not handled, so no bag carries them.
 */

const FIREHOSE_STREAM = 'stream';
const FIREHOSE_ARN = `arn:aws:firehose:us-east-1:${ACCOUNT}:deliverystream/${FIREHOSE_STREAM}`;
const FIREHOSE_ROLE = `arn:aws:iam::${ACCOUNT}:role/firehose`;
const FIREHOSE_KMS = `arn:aws:kms:us-east-1:${ACCOUNT}:key/k1`;
const FIREHOSE_DESTINATION_ID = 'destinationId-000000000001';
const FIREHOSE_ENCRYPTION = 'DeliveryStreamEncryptionConfigurationInput';
const FIREHOSE_ALL_DIRECTIONS = ['create', 'update-add', 'update-remove'];

/**
 * The live stream for `bag`: ACTIVE (the create's wait), with a version and a
 * destination id (every `UpdateDestination` reads both first), and encrypted
 * as `bag` declares. A Start / Stop moves the encryption to its end state, so
 * the wait after it ends on its first read.
 */
function armFirehose(_physicalId: string, bag: Bag): void {
  const declared = bag[FIREHOSE_ENCRYPTION] as Record<string, unknown> | undefined;
  let encryption: Record<string, unknown> =
    typeof declared?.['KeyType'] === 'string'
      ? {
          Status: 'ENABLED',
          KeyType: declared['KeyType'],
          ...(declared['KeyARN'] !== undefined && { KeyARN: declared['KeyARN'] }),
        }
      : { Status: 'DISABLED' };
  setOutputOverrides({
    DescribeDeliveryStreamCommand: () => ({
      DeliveryStreamDescription: {
        DeliveryStreamName: FIREHOSE_STREAM,
        DeliveryStreamARN: FIREHOSE_ARN,
        DeliveryStreamStatus: 'ACTIVE',
        DeliveryStreamType: 'DirectPut',
        VersionId: '1',
        Destinations: [{ DestinationId: FIREHOSE_DESTINATION_ID }],
        HasMoreDestinations: false,
        DeliveryStreamEncryptionConfiguration: encryption,
      },
    }),
    StartDeliveryStreamEncryptionCommand: (input) => {
      const requested = input['DeliveryStreamEncryptionConfigurationInput'] as Record<
        string,
        unknown
      >;
      encryption = {
        Status: 'ENABLED',
        KeyType: requested['KeyType'],
        ...(requested['KeyARN'] !== undefined && { KeyARN: requested['KeyARN'] }),
      };
      return {};
    },
    StopDeliveryStreamEncryptionCommand: () => {
      encryption = { Status: 'DISABLED' };
      return {};
    },
  });
}

// --- shared blocks: each a function, so no two bags share an object ----------------

const firehoseBuffering = () => ({ IntervalInSeconds: 60, SizeInMBs: 5 });
const firehoseRetry = () => ({ DurationInSeconds: 300 });
const firehoseLogging = () => ({ Enabled: true, LogGroupName: 'lg', LogStreamName: 'ls' });
const firehoseProcessing = () => ({
  Enabled: true,
  Processors: [
    {
      Type: 'Lambda',
      Parameters: [
        {
          ParameterName: 'LambdaArn',
          ParameterValue: `arn:aws:lambda:us-east-1:${ACCOUNT}:function:f`,
        },
        { ParameterName: 'NumberOfRetries', ParameterValue: '3' },
      ],
    },
  ],
});
const firehoseSecrets = () => ({
  Enabled: true,
  RoleARN: FIREHOSE_ROLE,
  SecretARN: `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:s-AbCdEf`,
});
const firehoseVpc = () => ({
  RoleARN: FIREHOSE_ROLE,
  SubnetIds: ['subnet-1', 'subnet-2'],
  SecurityGroupIds: ['sg-1', 'sg-2'],
});

/** Every `S3DestinationConfiguration` member, unencrypted. */
const firehoseS3Full = (bucket: string) => ({
  BucketARN: `arn:aws:s3:::${bucket}`,
  RoleARN: FIREHOSE_ROLE,
  Prefix: 'p/',
  ErrorOutputPrefix: 'e/',
  CompressionFormat: 'GZIP',
  BufferingHints: firehoseBuffering(),
  EncryptionConfiguration: { NoEncryptionConfig: 'NoEncryption' },
  CloudWatchLoggingOptions: firehoseLogging(),
});

/** The KMS alternative of {@link firehoseS3Full}'s `EncryptionConfiguration`. */
const firehoseS3Kms = (bucket: string) => ({
  BucketARN: `arn:aws:s3:::${bucket}`,
  RoleARN: FIREHOSE_ROLE,
  EncryptionConfiguration: { KMSEncryptionConfig: { AWSKMSKeyARN: FIREHOSE_KMS } },
});

const FIREHOSE_TAG_KEY_REFUSED: Throw = {
  why: 'a Tags entry without its Key is refused before any call (firehose-provider.ts:406-415, 1007-1031; go-to-k/cdkd#3948)',
  says: /is not a list of tags with a Key/,
};

/**
 * The fixed backup mode of the three OpenSearch / Elasticsearch destinations
 * (go-to-k/cdkd#5386, #5388): their `UpdateDestination` shapes have no
 * `S3BackupMode` member, so a changed mode is not sent (it IS sent on create,
 * as the create probes observe) and is warned instead.
 */
const FIREHOSE_FIXED_BACKUP_MODE =
  'S3BackupMode of this destination cannot change on an existing stream: the Update shape has no member for it, so a change is warned and not sent, as CloudFormation keeps the mode (CFn A/B measured 2026-10-27, firehose-provider.ts:214-245, 1166-1189, 2126-2131)';

// --- AWS::KinesisFirehose::DeliveryStream -----------------------------------------

const firehoseExtendedS3Full = () => ({
  ...firehoseS3Full('dest'),
  S3BackupMode: 'Enabled',
  S3BackupConfiguration: firehoseS3Full('backup'),
  ProcessingConfiguration: firehoseProcessing(),
  DataFormatConversionConfiguration: {
    Enabled: true,
    InputFormatConfiguration: {
      Deserializer: {
        OpenXJsonSerDe: {
          CaseInsensitive: true,
          ColumnToJsonKeyMappings: { ts: 'timestamp', id: 'identifier' },
          ConvertDotsInJsonKeysToUnderscores: true,
        },
      },
    },
    OutputFormatConfiguration: {
      Serializer: {
        OrcSerDe: {
          BlockSizeBytes: 268435456,
          BloomFilterColumns: ['a', 'b'],
          BloomFilterFalsePositiveProbability: 0.05,
          Compression: 'SNAPPY',
          DictionaryKeyThreshold: 0.8,
          EnablePadding: true,
          FormatVersion: 'V0_12',
          PaddingTolerance: 0.05,
          RowIndexStride: 10000,
          StripeSizeBytes: 67108864,
        },
      },
    },
    SchemaConfiguration: {
      CatalogId: ACCOUNT,
      DatabaseName: 'db',
      Region: 'us-east-1',
      RoleARN: FIREHOSE_ROLE,
      TableName: 't',
      VersionId: 'LATEST',
    },
  },
  DynamicPartitioningConfiguration: { Enabled: true, RetryOptions: firehoseRetry() },
  FileExtension: '.json.gz',
  CustomTimeZone: 'Asia/Tokyo',
});

/** The legacy destination: `update()` refuses any change to it (see below). */
const FIREHOSE_LEGACY_S3_REFUSED: Throw = {
  why: 'an in-place change to the legacy S3DestinationConfiguration is refused with ResourceUpdateNotSupportedError before any call (firehose-provider.ts:866-871, 986-1000): AWS deprecated the shape for ExtendedS3DestinationConfiguration, which CDK always emits. CloudFormation updates it in place: go-to-k/cdkd#5439',
  says: /In-place update for 'S3DestinationConfiguration'/,
};

/**
 * A legacy-destination bag's expectations: every update probe under
 * `S3DestinationConfiguration` meets the refusal, so each add / remove throws
 * and each leaf's update-vary (whose `before` side throws too) is silent.
 * Its create probes observe delivery.
 */
function firehoseLegacyS3(bag: Bag): Pick<BagCase, 'expectedSilent' | 'expectedRemovalThrows'> {
  const under = paths(bag).filter((p) => p[0] === 'S3DestinationConfiguration');
  const leaves = under.filter((p) => {
    let node: unknown = bag;
    for (const seg of p) node = (node as Record<string | number, unknown>)[seg];
    return node === null || typeof node !== 'object';
  });
  return {
    expectedRemovalThrows: Object.fromEntries(
      under.flatMap((p) =>
        ['update-add', 'update-remove'].map((d) => [
          `${d}:${p.join('.')}`,
          FIREHOSE_LEGACY_S3_REFUSED,
        ])
      )
    ),
    expectedSilent: Object.fromEntries(
      leaves.map((p) => [
        `update-vary:${p.join('.')}`,
        'the legacy S3DestinationConfiguration cannot be updated in place: both sides of the vary are the refusal (firehose-provider.ts:866-871, 986-1000; go-to-k/cdkd#5439)',
      ])
    ),
  };
}

const FIREHOSE_LEGACY_FULL_BAG: Bag = {
  DeliveryStreamName: FIREHOSE_STREAM,
  S3DestinationConfiguration: firehoseS3Full('legacy'),
};
const FIREHOSE_LEGACY_KMS_BAG: Bag = {
  DeliveryStreamName: FIREHOSE_STREAM,
  S3DestinationConfiguration: firehoseS3Kms('legacy'),
};

/** The full and the alternatives bag of one OpenSearch-family destination. */
function firehoseSearchBags(
  key:
    | 'ElasticsearchDestinationConfiguration'
    | 'AmazonopensearchserviceDestinationConfiguration'
    | 'AmazonOpenSearchServerlessDestinationConfiguration'
): BagCase[] {
  const serverless = key === 'AmazonOpenSearchServerlessDestinationConfiguration';
  const target = serverless
    ? { CollectionEndpoint: 'https://c1.us-east-1.aoss.amazonaws.com' }
    : {
        DomainARN: `arn:aws:es:us-east-1:${ACCOUNT}:domain/d`,
        TypeName: 'type',
        IndexRotationPeriod: 'OneDay',
        DocumentIdOptions: { DefaultDocumentIdFormat: 'NO_DOCUMENT_ID' },
      };
  return [
    {
      name: `${key}, every member`,
      bag: {
        DeliveryStreamName: FIREHOSE_STREAM,
        [key]: {
          ...target,
          IndexName: 'index',
          RoleARN: FIREHOSE_ROLE,
          BufferingHints: firehoseBuffering(),
          RetryOptions: firehoseRetry(),
          S3BackupMode: 'AllDocuments',
          S3Configuration: firehoseS3Full('backup'),
          CloudWatchLoggingOptions: firehoseLogging(),
          ProcessingConfiguration: firehoseProcessing(),
        },
      },
      variants: { [`${key}.S3BackupMode`]: 'FailedDocumentsOnly' },
      expectedSilent: { [`update-vary:${key}.S3BackupMode`]: FIREHOSE_FIXED_BACKUP_MODE },
    },
    {
      // The alternatives: a cluster endpoint for the domain, a VPC (create-only,
      // so only its create probes run), a KMS-encrypted backup bucket.
      name: `${key}, VPC and a KMS-encrypted backup bucket`,
      bag: {
        DeliveryStreamName: FIREHOSE_STREAM,
        [key]: {
          ...(serverless
            ? { CollectionEndpoint: 'https://c1.us-east-1.aoss.amazonaws.com' }
            : { ClusterEndpoint: 'https://search-d.us-east-1.es.amazonaws.com' }),
          IndexName: 'index',
          RoleARN: FIREHOSE_ROLE,
          S3Configuration: firehoseS3Kms('backup'),
          VpcConfiguration: firehoseVpc(),
        },
      },
    },
  ];
}

const FIREHOSE_CASE: TypeCase = {
  resourceType: 'AWS::KinesisFirehose::DeliveryStream',
  provider: () => new FirehoseProvider(),
  physicalId: FIREHOSE_STREAM,
  createOnly: createOnlyOf('AWS::KinesisFirehose::DeliveryStream'),
  arm: armFirehose,
  exempt: {},
  targets: [
    // UntagDeliveryStream takes the removed keys only.
    { path: ['Tags', 0], command: 'UntagDeliveryStreamCommand', names: 'k1', notNames: 'k2' },
    { path: ['Tags', 1], command: 'UntagDeliveryStreamCommand', names: 'k2', notNames: 'k1' },
  ],
  bags: [
    {
      name: 'extended S3, every member, encryption and tags',
      bag: {
        DeliveryStreamName: FIREHOSE_STREAM,
        ExtendedS3DestinationConfiguration: firehoseExtendedS3Full(),
        [FIREHOSE_ENCRYPTION]: { KeyType: 'CUSTOMER_MANAGED_CMK', KeyARN: FIREHOSE_KMS },
        Tags: [
          { Key: 'k1', Value: 'v1' },
          { Key: 'k2', Value: 'v2' },
        ],
      },
      variants: { [`${FIREHOSE_ENCRYPTION}.KeyType`]: 'AWS_OWNED_CMK' },
      expectedRemovalThrows: {
        ...Object.fromEntries(
          FIREHOSE_ALL_DIRECTIONS.flatMap((d) => [
            [`${d}:Tags.0.Key`, FIREHOSE_TAG_KEY_REFUSED],
            [`${d}:Tags.1.Key`, FIREHOSE_TAG_KEY_REFUSED],
          ])
        ),
        [`update-remove:${FIREHOSE_ENCRYPTION}.KeyType`]: {
          why: 'KeyType is required by the CloudFormation schema: a block without it is refused before any call (firehose-provider.ts:949-964)',
          says: /is not an object with a string KeyType/,
        },
      },
    },
    {
      name: 'extended S3, the alternative serializer / deserializer and KMS buckets',
      bag: {
        DeliveryStreamName: FIREHOSE_STREAM,
        ExtendedS3DestinationConfiguration: {
          ...firehoseS3Kms('dest'),
          S3BackupMode: 'Enabled',
          S3BackupConfiguration: firehoseS3Kms('backup'),
          DataFormatConversionConfiguration: {
            Enabled: true,
            InputFormatConfiguration: {
              Deserializer: { HiveJsonSerDe: { TimestampFormats: ['yyyy-MM-dd', 'millis'] } },
            },
            OutputFormatConfiguration: {
              Serializer: {
                ParquetSerDe: {
                  BlockSizeBytes: 268435456,
                  Compression: 'SNAPPY',
                  EnableDictionaryCompression: true,
                  MaxPaddingBytes: 0,
                  PageSizeBytes: 1048576,
                  WriterVersion: 'V1',
                },
              },
            },
          },
        },
      },
    },
    {
      name: 'Kinesis stream source',
      bag: {
        DeliveryStreamName: FIREHOSE_STREAM,
        DeliveryStreamType: 'KinesisStreamAsSource',
        KinesisStreamSourceConfiguration: {
          KinesisStreamARN: `arn:aws:kinesis:us-east-1:${ACCOUNT}:stream/source`,
          RoleARN: FIREHOSE_ROLE,
        },
        ExtendedS3DestinationConfiguration: {
          BucketARN: 'arn:aws:s3:::dest',
          RoleARN: FIREHOSE_ROLE,
        },
      },
    },
    {
      name: 'legacy S3, every member',
      bag: FIREHOSE_LEGACY_FULL_BAG,
      ...firehoseLegacyS3(FIREHOSE_LEGACY_FULL_BAG),
    },
    {
      name: 'legacy S3, KMS-encrypted',
      bag: FIREHOSE_LEGACY_KMS_BAG,
      ...firehoseLegacyS3(FIREHOSE_LEGACY_KMS_BAG),
    },
    {
      name: 'Redshift, every member but the Secrets Manager credential',
      bag: {
        DeliveryStreamName: FIREHOSE_STREAM,
        RedshiftDestinationConfiguration: {
          ClusterJDBCURL: 'jdbc:redshift://c.us-east-1.redshift.amazonaws.com:5439/db',
          RoleARN: FIREHOSE_ROLE,
          CopyCommand: { DataTableName: 't', DataTableColumns: 'a,b', CopyOptions: "JSON 'auto'" },
          Username: 'user',
          Password: 'Passw0rd!',
          S3Configuration: firehoseS3Full('stage'),
          S3BackupMode: 'Enabled',
          S3BackupConfiguration: firehoseS3Full('backup'),
          CloudWatchLoggingOptions: firehoseLogging(),
          ProcessingConfiguration: firehoseProcessing(),
          RetryOptions: { DurationInSeconds: 3600 },
        },
      },
    },
    {
      name: 'Redshift, Secrets Manager credential and KMS buckets',
      bag: {
        DeliveryStreamName: FIREHOSE_STREAM,
        RedshiftDestinationConfiguration: {
          ClusterJDBCURL: 'jdbc:redshift://c.us-east-1.redshift.amazonaws.com:5439/db',
          RoleARN: FIREHOSE_ROLE,
          CopyCommand: { DataTableName: 't' },
          S3Configuration: firehoseS3Kms('stage'),
          S3BackupMode: 'Enabled',
          S3BackupConfiguration: firehoseS3Kms('backup'),
          SecretsManagerConfiguration: firehoseSecrets(),
        },
      },
    },
    {
      name: 'HTTP endpoint, every member but the Secrets Manager credential',
      bag: {
        DeliveryStreamName: FIREHOSE_STREAM,
        HttpEndpointDestinationConfiguration: {
          EndpointConfiguration: { Url: 'https://example.com/ingest', Name: 'ep', AccessKey: 'key' },
          RoleARN: FIREHOSE_ROLE,
          BufferingHints: firehoseBuffering(),
          CloudWatchLoggingOptions: firehoseLogging(),
          RequestConfiguration: {
            ContentEncoding: 'GZIP',
            CommonAttributes: [
              { AttributeName: 'a1', AttributeValue: 'v1' },
              { AttributeName: 'a2', AttributeValue: 'v2' },
            ],
          },
          ProcessingConfiguration: firehoseProcessing(),
          RetryOptions: firehoseRetry(),
          S3BackupMode: 'AllData',
          S3Configuration: firehoseS3Full('backup'),
        },
      },
      variants: { 'HttpEndpointDestinationConfiguration.S3BackupMode': 'FailedDataOnly' },
    },
    {
      name: 'HTTP endpoint, Secrets Manager credential and a KMS bucket',
      bag: {
        DeliveryStreamName: FIREHOSE_STREAM,
        HttpEndpointDestinationConfiguration: {
          EndpointConfiguration: { Url: 'https://example.com/ingest' },
          S3Configuration: firehoseS3Kms('backup'),
          SecretsManagerConfiguration: firehoseSecrets(),
        },
      },
    },
    {
      name: 'Splunk, every member but the Secrets Manager credential',
      bag: {
        DeliveryStreamName: FIREHOSE_STREAM,
        SplunkDestinationConfiguration: {
          HECEndpoint: 'https://splunk.example.com:8088',
          HECEndpointType: 'Raw',
          HECToken: 'token',
          HECAcknowledgmentTimeoutInSeconds: 180,
          RetryOptions: firehoseRetry(),
          S3BackupMode: 'AllEvents',
          S3Configuration: firehoseS3Full('backup'),
          CloudWatchLoggingOptions: firehoseLogging(),
          ProcessingConfiguration: firehoseProcessing(),
          BufferingHints: firehoseBuffering(),
        },
      },
      variants: { 'SplunkDestinationConfiguration.S3BackupMode': 'FailedEventsOnly' },
    },
    {
      name: 'Splunk, Secrets Manager credential and a KMS bucket',
      bag: {
        DeliveryStreamName: FIREHOSE_STREAM,
        SplunkDestinationConfiguration: {
          HECEndpoint: 'https://splunk.example.com:8088',
          HECEndpointType: 'Event',
          S3Configuration: firehoseS3Kms('backup'),
          SecretsManagerConfiguration: firehoseSecrets(),
        },
      },
    },
    ...firehoseSearchBags('ElasticsearchDestinationConfiguration'),
    ...firehoseSearchBags('AmazonopensearchserviceDestinationConfiguration'),
    ...firehoseSearchBags('AmazonOpenSearchServerlessDestinationConfiguration'),
  ],
};

const CASES_12_FIREHOSE: TypeCase[] = [FIREHOSE_CASE];

// === ASGProvider ===========================================================

/**
 * The twelfth batch's Auto Scaling group case (#3723): `ASGProvider` builds its
 * own `@aws-sdk/client-auto-scaling` clients (a create client among them), so
 * `sdk-wire-coverage-12.test.ts` mocks that package, and EC2's, which the
 * provider constructs for its delete path.
 */

const ASG_DIRECTIONS = ['create', 'update-add', 'update-remove'];
const ASG_REQUIRED = (why: string, says: RegExp): Throw => ({ why, says });


const ASG_NAME = 'asg';
const ASG_TG = (name: string): string =>
  `arn:aws:elasticloadbalancing:us-east-1:${ACCOUNT}:targetgroup/${name}/0123456789abcdef`;
const ASG_TOPIC = (name: string): string => `arn:aws:sns:us-east-1:${ACCOUNT}:${name}`;
const ASG_ROLE = (name: string): string => `arn:aws:iam::${ACCOUNT}:role/${name}`;

/**
 * The live target groups: the previous bag's, as the last deploy attached
 * them, with every Attach / Detach this run already sent applied. Update's
 * convergence poll (asg-provider.ts:2714-2794) reads them back until they
 * match the desired set, so a fixed answer would spin it for 30s.
 */
function asgLiveTargetGroups(bag: Bag): string[] {
  const live = new Set(
    Array.isArray(bag['TargetGroupARNs'])
      ? (bag['TargetGroupARNs'] as unknown[]).filter((v): v is string => typeof v === 'string')
      : []
  );
  for (const line of wire) {
    const entry = JSON.parse(line) as unknown[];
    const command = entry[0];
    if (
      command !== 'AttachLoadBalancerTargetGroupsCommand' &&
      command !== 'DetachLoadBalancerTargetGroupsCommand'
    ) {
      continue;
    }
    const params = new URLSearchParams(String(entry[entry.length - 1]));
    for (const [key, value] of params) {
      if (!key.startsWith('TargetGroupARNs.member.')) continue;
      if (command === 'AttachLoadBalancerTargetGroupsCommand') live.add(value);
      else live.delete(value);
    }
  }
  return [...live];
}

function armAsg(physicalId: string, bag: Bag): void {
  setOutputOverrides({
    DescribeAutoScalingGroupsCommand: () => ({
      AutoScalingGroups: [{ AutoScalingGroupName: physicalId, TargetGroupARNs: asgLiveTargetGroups(bag) }],
    }),
  });
}

// --- Why a probe is silent ---------------------------------------------------------

/**
 * Removed from the template, CloudFormation sends nothing and KEEPS the live
 * value (real CloudFormation A/Bs, go-to-k/cdkd#5004 and #1160), so cdkd sends
 * nothing either (asg-provider.ts:611-628, 1365-1405).
 */
const ASG_KEPT: Record<string, string> = {
  MinSize:
    'MinSize is CloudFormation-required (definitionRequired #top), so no deployable template removes it (asg-provider.ts:1372-1373)',
  MaxSize:
    'MaxSize is CloudFormation-required (definitionRequired #top), so no deployable template removes it (asg-provider.ts:1372-1373)',
  DesiredCapacity:
    'KEPT by CloudFormation on removal: it sends nothing and the live value stays (#1160 A/B, asg-provider.ts:1371-1373)',
  ServiceLinkedRoleARN:
    'KEPT by CloudFormation on removal: it sends nothing and the live value stays (#1160 A/B, asg-provider.ts:1371-1373)',
  LaunchTemplate:
    'CloudFormation sends only the launch member the template now declares, as cdkd does (#1160 A/B, asg-provider.ts:1374-1378)',
  MixedInstancesPolicy:
    'CloudFormation sends only the launch member the template now declares, as cdkd does (#1160 A/B, asg-provider.ts:1374-1378)',
  VPCZoneIdentifier:
    'CloudFormation sends only the member the template now declares and AWS keeps the subnets, parity (#1160 A/B, asg-provider.ts:1374-1378)',
  AvailabilityZones:
    'CloudFormation sends only the member the template now declares, as cdkd does (#1160 A/B, asg-provider.ts:1374-1378)',
  SkipZonalShiftValidation:
    'write-only per-request flag in the CloudFormation schema, never read back: nothing to reset (asg-provider.ts:1379-1380)',
  Context:
    '"Reserved": AWS refuses any value an account sets, so no deployable template removes one (asg-provider.ts:1381-1383)',
  ...Object.fromEntries(
    [
      'HealthCheckType',
      'HealthCheckGracePeriod',
      'Cooldown',
      'DefaultCooldown',
      'TerminationPolicies',
      'NewInstancesProtectedFromScaleIn',
      'CapacityRebalance',
      'DesiredCapacityType',
      'DefaultInstanceWarmup',
      'DeletionProtection',
    ].map((key) => [
      key,
      'KEPT by CloudFormation on removal: it sends nothing and the live value stays (#5004 A/B, asg-provider.ts:619-628, 1400-1405; DefaultCooldown is the Cooldown alias)',
    ])
  ),
};

/**
 * A member inside a value `UpdateAutoScalingGroup` re-sends WHOLE from the
 * desired bag (asg-provider.ts:1469-1536): removing it leaves `next` equal on
 * both sides, and its `update-add` probe observes the delivery.
 */
const ASG_NESTED: Record<string, string> = {
  LaunchTemplate:
    'the launch template specification is re-sent whole from the desired bag (asg-provider.ts:1352, 1477, 2157-2200); Version is CloudFormation-required (nestedRequired LaunchTemplate)',
  MixedInstancesPolicy:
    'the policy is re-sent whole from the desired bag (asg-provider.ts:1478-1480); its update-add probe observes delivery',
  VPCZoneIdentifier:
    'the subnet list is re-sent whole, comma-joined, from the desired bag (asg-provider.ts:1353, 1481, 2228-2237)',
  AvailabilityZones:
    'the zone list is re-sent whole from the desired bag (asg-provider.ts:1482-1484)',
  TerminationPolicies:
    'the policy list is re-sent whole from the desired bag (asg-provider.ts:1494-1496)',
  InstanceMaintenancePolicy:
    'a kept-but-partial policy is passed through: AWS refuses one percentage alone, and CloudFormation submits the same partial object (asg-provider.ts:1385-1393)',
  CapacityReservationSpecification:
    'a kept-but-partial specification is passed through verbatim; whether AWS keeps a previous CapacityReservationTarget is unprobed (asg-provider.ts:1385-1387, 1394-1397), and CapacityReservationPreference is CloudFormation-required',
  AvailabilityZoneDistribution:
    'its single member is passed through inside the kept object (asg-provider.ts:1385-1387, 1398)',
  AvailabilityZoneImpairmentPolicy:
    'both members are CloudFormation-required (nestedRequired AvailabilityZoneImpairmentPolicy), so only a whole-policy removal is deployable, which resets (asg-provider.ts:1446-1467)',
};

/** The `update-remove` silences of `bag`: each kept top-level, and every path under a re-sent value. */
function asgSilent(bag: Bag): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(bag)) {
    if (key in ASG_KEPT) out[`update-remove:${key}`] = ASG_KEPT[key]!;
    if (key in ASG_NESTED) {
      for (const p of paths(value)) out[`update-remove:${[key, ...p].join('.')}`] = ASG_NESTED[key]!;
    }
  }
  return out;
}

/** An entry list refused before any call when an entry lacks its identity member. */
function asgEntryThrows(key: string, member: string, count: number, says: RegExp): Record<string, Throw> {
  return Object.fromEntries(
    ASG_DIRECTIONS.flatMap((d) =>
      Array.from({ length: count }, (_, i) => [
        `${d}:${key}.${i}.${member}`,
        ASG_REQUIRED(
          `an entry without its ${member} is refused on either side before any call (asg-provider.ts:133-150, 182-238, 857-880, 2486-2500); CloudFormation requires it too`,
          says
        ),
      ])
    )
  );
}

// --- Bags --------------------------------------------------------------------------

const ASG_EVERY: Bag = {
  AutoScalingGroupName: ASG_NAME,
  LaunchTemplate: { LaunchTemplateId: 'lt-0123456789abcdef0', Version: '3' },
  MinSize: 1,
  MaxSize: 4,
  DesiredCapacity: 2,
  VPCZoneIdentifier: ['subnet-1', 'subnet-2'],
  HealthCheckType: 'ELB',
  HealthCheckGracePeriod: 300,
  Cooldown: 120,
  // Both `true`: an absent PropagateAtLaunch is sent as `false` on create
  // (asg-provider.ts:2220), so only `true` differs from its removal.
  Tags: [
    { Key: 'k1', Value: 'v1', PropagateAtLaunch: true },
    { Key: 'k2', Value: 'v2', PropagateAtLaunch: true },
  ],
  TerminationPolicies: ['OldestInstance', 'Default'],
  NewInstancesProtectedFromScaleIn: true,
  CapacityRebalance: true,
  ServiceLinkedRoleARN: `arn:aws:iam::${ACCOUNT}:role/aws-service-role/autoscaling.amazonaws.com/AWSServiceRoleForAutoScaling_custom`,
  MaxInstanceLifetime: 86400,
  LoadBalancerNames: ['clb-one', 'clb-two'],
  TargetGroupARNs: [ASG_TG('tg-one'), ASG_TG('tg-two')],
  MetricsCollection: [{ Granularity: '1Minute', Metrics: ['GroupMinSize', 'GroupMaxSize'] }],
  LifecycleHookSpecificationList: [
    {
      LifecycleHookName: 'hook-one',
      LifecycleTransition: 'autoscaling:EC2_INSTANCE_LAUNCHING',
      RoleARN: ASG_ROLE('hooks'),
      NotificationTargetARN: ASG_TOPIC('hook-topic'),
      NotificationMetadata: 'meta',
      HeartbeatTimeout: 600,
      DefaultResult: 'CONTINUE',
    },
    { LifecycleHookName: 'hook-two', LifecycleTransition: 'autoscaling:EC2_INSTANCE_TERMINATING' },
  ],
  Context: 'ctx',
  DesiredCapacityType: 'units',
  DefaultInstanceWarmup: 60,
  TrafficSources: [
    { Identifier: ASG_TG('ts-one'), Type: 'elbv2' },
    {
      Identifier: `arn:aws:vpc-lattice:us-east-1:${ACCOUNT}:targetgroup/tg-0123456789abcdef0`,
      Type: 'vpc-lattice',
    },
  ],
  NotificationConfigurations: [
    {
      TopicARN: ASG_TOPIC('topic-one'),
      NotificationTypes: ['autoscaling:EC2_INSTANCE_LAUNCH', 'autoscaling:EC2_INSTANCE_TERMINATE'],
    },
    { TopicARN: ASG_TOPIC('topic-two'), NotificationTypes: ['autoscaling:TEST_NOTIFICATION'] },
  ],
  AvailabilityZoneDistribution: { CapacityDistributionStrategy: 'balanced-only' },
  AvailabilityZoneImpairmentPolicy: {
    ZonalShiftEnabled: true,
    ImpairedZoneHealthCheckBehavior: 'IgnoreUnhealthy',
  },
  SkipZonalShiftValidation: true,
  CapacityReservationSpecification: {
    CapacityReservationPreference: 'capacity-reservations-only',
    CapacityReservationTarget: {
      CapacityReservationIds: ['cr-1', 'cr-2'],
      CapacityReservationResourceGroupArns: [
        `arn:aws:resource-groups:us-east-1:${ACCOUNT}:group/rg-one`,
        `arn:aws:resource-groups:us-east-1:${ACCOUNT}:group/rg-two`,
      ],
    },
  },
  InstanceMaintenancePolicy: { MinHealthyPercentage: 90, MaxHealthyPercentage: 120 },
  DeletionProtection: 'prevent-force-deletion',
};

const ASG_TRAFFIC_TYPE =
  'Type is CloudFormation-required (nestedRequired TrafficSources) and an Identifier names exactly one source kind, so no deployable template drops or changes it on a kept Identifier; the diff attaches and detaches by Identifier (asg-provider.ts:2952-2977)';

const ASG_MIXED: Bag = {
  AutoScalingGroupName: ASG_NAME,
  MinSize: 1,
  MaxSize: 4,
  MixedInstancesPolicy: {
    InstancesDistribution: {
      OnDemandAllocationStrategy: 'prioritized',
      OnDemandBaseCapacity: 1,
      OnDemandPercentageAboveBaseCapacity: 50,
      SpotAllocationStrategy: 'price-capacity-optimized',
      SpotInstancePools: 2,
      SpotMaxPrice: '0.5',
      DistributionSegments: [
        { TargetCapacityTypes: ['on-demand', 'spot'] },
        { TargetCapacityTypes: ['spot', 'on-demand'] },
      ],
    },
    LaunchTemplate: {
      LaunchTemplateSpecification: { LaunchTemplateId: 'lt-0123456789abcdef0', Version: '1' },
      Overrides: [
        {
          InstanceType: 'm5.large',
          ImageId: 'ami-0123456789abcdef0',
          WeightedCapacity: '2',
          LaunchTemplateSpecification: { LaunchTemplateName: 'lt-override', Version: '2' },
        },
        {
          InstanceType: 'c5.large',
          LaunchTemplateSpecification: { LaunchTemplateId: 'lt-0fedcba9876543210', Version: '4' },
        },
        {
          InstanceRequirements: {
            VCpuCount: { Min: 2, Max: 8 },
            MemoryMiB: { Min: 4096, Max: 16384 },
            CpuManufacturers: ['intel', 'amd'],
            MemoryGiBPerVCpu: { Min: 1, Max: 4 },
            ExcludedInstanceTypes: ['t2.*', 't3.*'],
            InstanceGenerations: ['current', 'previous'],
            SpotMaxPricePercentageOverLowestPrice: 40,
            MaxSpotPriceAsPercentageOfOptimalOnDemandPrice: 50,
            OnDemandMaxPricePercentageOverLowestPrice: 30,
            BareMetal: 'excluded',
            BurstablePerformance: 'included',
            RequireHibernateSupport: true,
            NetworkInterfaceCount: { Min: 1, Max: 4 },
            LocalStorage: 'required',
            LocalStorageTypes: ['ssd', 'hdd'],
            TotalLocalStorageGB: { Min: 10, Max: 500 },
            BaselineEbsBandwidthMbps: { Min: 100, Max: 1000 },
            AcceleratorTypes: ['gpu', 'fpga'],
            AcceleratorCount: { Min: 1, Max: 2 },
            AcceleratorManufacturers: ['nvidia', 'amd'],
            AcceleratorNames: ['t4', 'a100'],
            AcceleratorTotalMemoryMiB: { Min: 1024, Max: 8192 },
            NetworkBandwidthGbps: { Min: 1, Max: 25 },
            AllowedInstanceTypes: ['m5.*', 'c5.*'],
            BaselinePerformanceFactors: {
              Cpu: { References: [{ InstanceFamily: 'c6i' }, { InstanceFamily: 'm6i' }] },
            },
          },
        },
      ],
    },
  },
};

// The policy's own launch template named rather than addressed by id.
const ASG_MIXED_BY_NAME: Bag = {
  AutoScalingGroupName: ASG_NAME,
  MinSize: 1,
  MaxSize: 2,
  MixedInstancesPolicy: {
    LaunchTemplate: {
      LaunchTemplateSpecification: { LaunchTemplateName: 'lt-by-name', Version: '$Default' },
    },
  },
};

const ASG_BY_NAME: Bag = {
  AutoScalingGroupName: ASG_NAME,
  MinSize: 1,
  MaxSize: 2,
  LaunchTemplate: { LaunchTemplateName: 'lt-by-name', Version: '$Latest' },
  AvailabilityZones: ['us-east-1a', 'us-east-1b'],
  DefaultCooldown: 60,
};

const ASG_CASE: TypeCase = {
  resourceType: 'AWS::AutoScaling::AutoScalingGroup',
  provider: () => new ASGProvider(),
  physicalId: ASG_NAME,
  createOnly: createOnlyOf('AWS::AutoScaling::AutoScalingGroup'),
  arm: armAsg,
  exempt: {},
  targets: [
    // Each list's per-element call names the removed element only.
    { path: ['Tags', 0], command: 'DeleteTagsCommand', names: 'k1', notNames: 'k2' },
    { path: ['Tags', 1], command: 'DeleteTagsCommand', names: 'k2', notNames: 'k1' },
    { path: ['LoadBalancerNames', 0], command: 'DetachLoadBalancersCommand', names: 'clb-one', notNames: 'clb-two' },
    { path: ['LoadBalancerNames', 1], command: 'DetachLoadBalancersCommand', names: 'clb-two', notNames: 'clb-one' },
    { path: ['TargetGroupARNs', 0], command: 'DetachLoadBalancerTargetGroupsCommand', names: 'tg-one', notNames: 'tg-two' },
    { path: ['TargetGroupARNs', 1], command: 'DetachLoadBalancerTargetGroupsCommand', names: 'tg-two', notNames: 'tg-one' },
    { path: ['MetricsCollection', 0, 'Metrics', 0], command: 'DisableMetricsCollectionCommand', names: 'GroupMinSize', notNames: 'GroupMaxSize' },
    { path: ['MetricsCollection', 0, 'Metrics', 1], command: 'DisableMetricsCollectionCommand', names: 'GroupMaxSize', notNames: 'GroupMinSize' },
    { path: ['LifecycleHookSpecificationList', 0], command: 'DeleteLifecycleHookCommand', names: 'hook-one', notNames: 'hook-two' },
    { path: ['LifecycleHookSpecificationList', 1], command: 'DeleteLifecycleHookCommand', names: 'hook-two', notNames: 'hook-one' },
    { path: ['TrafficSources', 0], command: 'DetachTrafficSourcesCommand', names: 'ts-one', notNames: 'vpc-lattice' },
    { path: ['TrafficSources', 1], command: 'DetachTrafficSourcesCommand', names: 'vpc-lattice', notNames: 'ts-one' },
    { path: ['NotificationConfigurations', 0], command: 'DeleteNotificationConfigurationCommand', names: 'topic-one', notNames: 'topic-two' },
    { path: ['NotificationConfigurations', 1], command: 'DeleteNotificationConfigurationCommand', names: 'topic-two', notNames: 'topic-one' },
  ],
  bags: [
    {
      name: 'launch template id, every list and policy',
      bag: fresh(ASG_EVERY),
      expectedSilent: {
        ...asgSilent(ASG_EVERY),
        'update-add:TrafficSources.0.Type': ASG_TRAFFIC_TYPE,
        'update-add:TrafficSources.1.Type': ASG_TRAFFIC_TYPE,
        'update-remove:TrafficSources.0.Type': ASG_TRAFFIC_TYPE,
        'update-remove:TrafficSources.1.Type': ASG_TRAFFIC_TYPE,
      },
      expectedRemovalThrows: {
        ...asgEntryThrows('Tags', 'Key', 2, /is not a list of tags with a Key/),
        ...asgEntryThrows('MetricsCollection', 'Granularity', 1, /entries with a Granularity/),
        ...asgEntryThrows(
          'LifecycleHookSpecificationList',
          'LifecycleHookName',
          2,
          /entries with a LifecycleHookName/
        ),
        ...asgEntryThrows('TrafficSources', 'Identifier', 2, /entries with an Identifier/),
        ...asgEntryThrows('NotificationConfigurations', 'TopicARN', 2, /entries with a TopicARN/),
      },
    },
    {
      name: 'launch template by name, availability zones, DefaultCooldown',
      bag: fresh(ASG_BY_NAME),
      expectedSilent: asgSilent(ASG_BY_NAME),
    },
    {
      name: 'mixed instances policy',
      bag: fresh(ASG_MIXED),
      expectedSilent: asgSilent(ASG_MIXED),
    },
    {
      name: 'mixed instances policy, launch template by name',
      bag: fresh(ASG_MIXED_BY_NAME),
      expectedSilent: asgSilent(ASG_MIXED_BY_NAME),
    },
  ],
};

const CASES_12_ASG: TypeCase[] = [ASG_CASE];

export const CASES_12: TypeCase[] = [
  ...CASES_12_APIGWV2,
  ...CASES_12_ECS,
  ...CASES_12_ELBV2,
  ...CASES_12_FIREHOSE,
  ...CASES_12_ASG,
];
