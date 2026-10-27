import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { NotFoundException } from '@aws-sdk/client-sns';
import {
  ACCOUNT,
  REGION,
  TAG_THROWS,
  createOnlyOf,
  record,
  setOutputOverrides,
  type Bag,
  type Throw,
  type TypeCase,
} from './sdk-wire-harness.js';
import { DagBuilder } from '../../../src/analyzer/dag-builder.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import {
  withNestedStackContext,
  type NestedStackProviderContext,
} from '../../../src/provisioning/nested-stack-context.js';
import { ApiGatewayProvider } from '../../../src/provisioning/providers/apigateway-provider.js';
import { CognitoUserPoolProvider } from '../../../src/provisioning/providers/cognito-provider.js';
import { NestedStackProvider } from '../../../src/provisioning/providers/nested-stack-provider.js';
import {
  S3BucketProvider,
  resetS3BucketCreateRetryStateForTests,
} from '../../../src/provisioning/providers/s3-bucket-provider.js';
import { SNSTopicProvider } from '../../../src/provisioning/providers/sns-topic-provider.js';
import type { ResourceProvider } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

/**
 * The thirteenth batch of wire cases (#3723): every type `ApiGatewayProvider`,
 * `CognitoUserPoolProvider`, `S3BucketProvider` and `NestedStackProvider`
 * handle, run by `sdk-wire-coverage-13.test.ts`.
 */

/**
 * A copy sharing no object with any other bag: the harness's `without` is a
 * `structuredClone`, which KEEPS shared references, so a block reused in two
 * places would lose a path in both at once.
 */
const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// === ApiGatewayProvider ======================================================

/**
 * The thirteenth batch's API Gateway (REST, v1) cases (#3723): every type
 * `ApiGatewayProvider` handles. The provider takes its shared client from
 * `getAwsClients().apiGateway` and builds its own `CreateAuthorizer` /
 * `CreateDeployment` client (`getCreateClient`), so the runner wraps
 * `@aws-sdk/client-api-gateway` and every instance is captured.
 *
 * Updates go out as JSON-patch `patchOperations` lists (`UpdateAccount` /
 * `UpdateAuthorizer` / `UpdateDeployment` / `UpdateStage` / `UpdateMethod`),
 * plus the Method's integration and response sub-resource calls
 * (`methodChildCalls`, go-to-k/cdkd#5140). Covers go-to-k/cdkd#5403 (Method
 * `Integration.IntegrationTarget`, Authorizer `Type` and Deployment
 * `Description` updated in place) and go-to-k/cdkd#5421 (Authorizer
 * `ProviderARNs` and Method `AuthorizationScopes` patched per element, pinned
 * by `targets`; a removed `AuthorizerUri` kept).
 */

const APIGW_SRC = 'apigateway-provider.ts';
const APIGW_API_ID = 'api-1';
const APIGW_ROLE = `arn:aws:iam::${ACCOUNT}:role/apigw`;
const APIGW_FN_URI = `arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:${ACCOUNT}:function:f/invocations`;
const APIGW_POOL = (n: number): string =>
  `arn:aws:cognito-idp:us-east-1:${ACCOUNT}:userpool/us-east-1_pool${n}`;
const APIGW_ALL_DIRECTIONS = ['create', 'update-add', 'update-remove'];
const APIGW_TAG_LIST = [
  { Key: 'k1', Value: 'v1' },
  { Key: 'k2', Value: 'v2' },
];

/** `create:<key>` -> the provider's own required-members refusal, for each key. */
const apigwRequired = (keys: string[], at: string, says: RegExp): Record<string, Throw> =>
  Object.fromEntries(
    keys.map((key) => [
      `create:${key}`,
      {
        why: `create() refuses a resource without ${keys.join(' / ')} before any call (${APIGW_SRC}:${at})`,
        says,
      },
    ])
  );

// --- AWS::ApiGateway::Account -------------------------------------------------------

const APIGW_ACCOUNT_CASE: TypeCase = {
  resourceType: 'AWS::ApiGateway::Account',
  provider: () => new ApiGatewayProvider(),
  physicalId: 'ApiGatewayAccount',
  createOnly: createOnlyOf('AWS::ApiGateway::Account'),
  exempt: {},
  targets: [],
  bags: [
    // A removed CloudWatchRoleArn is cleared through `removalDefaults`
    // (`replace /cloudwatchRoleArn ''`, CFn A/B #1160), so every probe reaches
    // the wire.
    { name: 'a CloudWatch role', bag: { CloudWatchRoleArn: APIGW_ROLE } },
  ],
};

// --- AWS::ApiGateway::Authorizer ----------------------------------------------------

const APIGW_AUTHORIZER_REQUIRED = apigwRequired(
  ['RestApiId', 'Name', 'Type'],
  '809-815',
  /RestApiId, Name, and Type are required for API Gateway Authorizer/
);

const APIGW_AUTHORIZER_CASE: TypeCase = {
  resourceType: 'AWS::ApiGateway::Authorizer',
  provider: () => new ApiGatewayProvider(),
  physicalId: 'auth-1',
  createOnly: createOnlyOf('AWS::ApiGateway::Authorizer'),
  exempt: {},
  targets: [
    // `ProviderARNs` is patched per element: a dropped pool is ONE
    // `remove /providerARNs` naming that pool alone (go-to-k/cdkd#5408, #5421).
    {
      path: ['ProviderARNs', 0],
      command: 'UpdateAuthorizerCommand',
      names: 'pool1',
      notNames: 'pool2',
    },
    {
      path: ['ProviderARNs', 1],
      command: 'UpdateAuthorizerCommand',
      names: 'pool2',
      notNames: 'pool1',
    },
  ],
  bags: [
    {
      name: 'a Cognito authorizer with two user pools',
      bag: {
        RestApiId: APIGW_API_ID,
        Name: 'cognito',
        Type: 'COGNITO_USER_POOLS',
        AuthType: 'cognito_user_pools',
        IdentitySource: 'method.request.header.Authorization',
        ProviderARNs: [APIGW_POOL(1), APIGW_POOL(2)],
        AuthorizerResultTtlInSeconds: 300,
      },
      variants: { Type: 'TOKEN' },
      expectedRemovalThrows: APIGW_AUTHORIZER_REQUIRED,
    },
    {
      name: 'a TOKEN authorizer with every Lambda-authorizer property',
      bag: {
        RestApiId: APIGW_API_ID,
        Name: 'auth',
        Type: 'TOKEN',
        AuthType: 'custom',
        AuthorizerUri: APIGW_FN_URI,
        AuthorizerCredentials: APIGW_ROLE,
        IdentitySource: 'method.request.header.Authorization',
        IdentityValidationExpression: '^Bearer .+$',
        AuthorizerResultTtlInSeconds: 300,
      },
      variants: { Type: 'REQUEST' },
      expectedSilent: {
        'update-remove:AuthorizerUri': `left in place on removal: CloudFormation keeps the URI (real CloudFormation A/B in us-east-1, go-to-k/cdkd#5408), and API Gateway refuses an empty URI on a TOKEN / REQUEST authorizer (${APIGW_SRC}:996-1003)`,
      },
      expectedRemovalThrows: APIGW_AUTHORIZER_REQUIRED,
    },
  ],
};

// --- AWS::ApiGateway::Resource ------------------------------------------------------

const APIGW_RESOURCE_CASE: TypeCase = {
  resourceType: 'AWS::ApiGateway::Resource',
  provider: () => new ApiGatewayProvider(),
  physicalId: 'res-1',
  // Every handled property is create-only, so the engine replaces on any
  // change and every update comparison is skipped.
  createOnly: createOnlyOf('AWS::ApiGateway::Resource'),
  exempt: {},
  targets: [],
  bags: [
    {
      name: 'a path part under a parent',
      bag: { RestApiId: APIGW_API_ID, ParentId: 'root-1', PathPart: 'pets' },
      expectedRemovalThrows: apigwRequired(
        ['RestApiId', 'ParentId', 'PathPart'],
        '1148-1154',
        /RestApiId, ParentId, and PathPart are required for API Gateway Resource/
      ),
    },
  ],
};

// --- AWS::ApiGateway::Deployment ----------------------------------------------------

const APIGW_DEPLOYMENT_CASE: TypeCase = {
  resourceType: 'AWS::ApiGateway::Deployment',
  provider: () => new ApiGatewayProvider(),
  physicalId: 'dep-1',
  // StageName / StageDescription / DeploymentCanarySettings are
  // `unhandledByDesign`, so no bag carries them; the nested-path check reads
  // carried top-levels only.
  createOnly: createOnlyOf('AWS::ApiGateway::Deployment'),
  exempt: {},
  targets: [],
  bags: [
    {
      // Description is updated in place (`replace /description`, go-to-k/cdkd#5403).
      name: 'a described deployment',
      bag: { RestApiId: APIGW_API_ID, Description: 'd' },
      expectedRemovalThrows: apigwRequired(
        ['RestApiId'],
        '1388-1394',
        /RestApiId is required for API Gateway Deployment/
      ),
    },
  ],
};

// --- AWS::ApiGateway::Stage ---------------------------------------------------------

const APIGW_METHOD_SETTING = (resourcePath: string, httpMethod: string, n: number): Bag => ({
  ResourcePath: resourcePath,
  HttpMethod: httpMethod,
  ThrottlingRateLimit: 100 + n,
  ThrottlingBurstLimit: 50 + n,
  MetricsEnabled: true,
  LoggingLevel: 'INFO',
  DataTraceEnabled: true,
  CachingEnabled: true,
  CacheTtlInSeconds: 300 + n,
  CacheDataEncrypted: true,
});

const APIGW_STAGE_CASE: TypeCase = {
  resourceType: 'AWS::ApiGateway::Stage',
  provider: () => new ApiGatewayProvider(),
  physicalId: 'prod',
  createOnly: createOnlyOf('AWS::ApiGateway::Stage'),
  exempt: {},
  targets: [
    { path: ['Tags', 0], command: 'UntagResourceCommand', names: '"k1"', notNames: '"k2"' },
    { path: ['Tags', 1], command: 'UntagResourceCommand', names: '"k2"', notNames: '"k1"' },
    {
      path: ['Variables', 'V1'],
      command: 'UpdateStageCommand',
      names: '/variables/V1',
      notNames: '/variables/V2',
    },
    {
      path: ['Variables', 'V2'],
      command: 'UpdateStageCommand',
      names: '/variables/V2',
      notNames: '/variables/V1',
    },
    {
      path: ['CanarySetting', 'StageVariableOverrides', 'O1'],
      command: 'UpdateStageCommand',
      names: 'stageVariableOverrides/O1',
      notNames: 'stageVariableOverrides/O2',
    },
    {
      path: ['CanarySetting', 'StageVariableOverrides', 'O2'],
      command: 'UpdateStageCommand',
      names: 'stageVariableOverrides/O2',
      notNames: 'stageVariableOverrides/O1',
    },
    {
      path: ['MethodSettings', 0],
      command: 'UpdateStageCommand',
      names: '~1pets/GET',
      notNames: '~1pets/POST',
    },
    {
      path: ['MethodSettings', 1],
      command: 'UpdateStageCommand',
      names: '~1pets/POST',
      notNames: '~1pets/GET',
    },
  ],
  bags: [
    {
      name: 'every declared property',
      bag: {
        RestApiId: APIGW_API_ID,
        StageName: 'prod',
        DeploymentId: 'dep-1',
        Description: 'd',
        TracingEnabled: true,
        Variables: { V1: 'a', V2: 'b' },
        CacheClusterEnabled: true,
        CacheClusterSize: '0.5',
        ClientCertificateId: 'cert-1',
        DocumentationVersion: '1.0',
        AccessLogSetting: {
          DestinationArn: `arn:aws:logs:us-east-1:${ACCOUNT}:log-group:access`,
          Format: '$context.requestId',
        },
        CanarySetting: {
          DeploymentId: 'dep-2',
          PercentTraffic: 10,
          UseStageCache: true,
          StageVariableOverrides: { O1: 'x', O2: 'y' },
        },
        MethodSettings: [
          APIGW_METHOD_SETTING('/~1pets', 'GET', 1),
          APIGW_METHOD_SETTING('/~1pets', 'POST', 2),
        ],
        Tags: fresh(APIGW_TAG_LIST),
      },
      variants: { CacheClusterSize: '1.6' },
      expectedSilent: {
        'update-remove:DeploymentId': `a stage always points at a deployment: create() refuses a stage without one (${APIGW_SRC}:1652-1658), and update() patches /deploymentId only to a declared value, so a removal leaves the live deployment (${APIGW_SRC}:1838-1842). CloudFormation is unmeasured for this removal`,
        'update-remove:CacheClusterSize': `deliberately not cleared on removal: /cacheClusterSize takes only an enum value (no empty clear) and dropping CacheClusterEnabled tears the cluster down with its size (${APIGW_SRC}:1883-1905). CloudFormation is unmeasured for this removal`,
      },
      expectedRemovalThrows: {
        ...apigwRequired(
          ['RestApiId', 'StageName', 'DeploymentId'],
          '1652-1658',
          /RestApiId, StageName, and DeploymentId are required for API Gateway Stage/
        ),
        ...TAG_THROWS(APIGW_ALL_DIRECTIONS, 2),
      },
    },
  ],
};

// --- AWS::ApiGateway::Method --------------------------------------------------------

const APIGW_INTEGRATION_WITHOUT_TYPE = `an Integration block without Type is \`readCurrentState\`'s read-back shape, which update() leaves alone on either side (\`isCfnMethodChildShape\`, ${APIGW_SRC}:3663-3673, 3723-3728); CloudFormation requires Integration.Type, so no deployable template removes it`;

const APIGW_METHOD_CASE: TypeCase = {
  resourceType: 'AWS::ApiGateway::Method',
  provider: () => new ApiGatewayProvider(),
  physicalId: `${APIGW_API_ID}|res-1|GET`,
  createOnly: createOnlyOf('AWS::ApiGateway::Method'),
  exempt: {},
  targets: [
    {
      path: ['RequestParameters', 'method.request.querystring.a'],
      command: 'UpdateMethodCommand',
      names: 'querystring.a',
      notNames: 'querystring.b',
    },
    {
      path: ['RequestModels', 'application/json'],
      command: 'UpdateMethodCommand',
      names: 'application~1json',
      notNames: 'text~1plain',
    },
    // `AuthorizationScopes` is patched per element: a dropped scope is ONE
    // `remove /authorizationScopes` naming that scope alone (go-to-k/cdkd#5421).
    {
      path: ['AuthorizationScopes', 0],
      command: 'UpdateMethodCommand',
      names: 'scope/a',
      notNames: 'scope/b',
    },
    {
      path: ['AuthorizationScopes', 1],
      command: 'UpdateMethodCommand',
      names: 'scope/b',
      notNames: 'scope/a',
    },
    // `PutIntegration` re-sends the whole integration: the remaining key only.
    {
      path: ['Integration', 'CacheKeyParameters', 0],
      command: 'PutIntegrationCommand',
      names: 'method.request.querystring.b',
      notNames: 'method.request.querystring.a',
    },
  ],
  bags: [
    {
      name: 'every declared property, an HTTP integration with responses',
      bag: {
        RestApiId: APIGW_API_ID,
        ResourceId: 'res-1',
        HttpMethod: 'GET',
        AuthorizationType: 'COGNITO_USER_POOLS',
        AuthorizerId: 'auth-1',
        ApiKeyRequired: true,
        OperationName: 'getPets',
        RequestParameters: {
          'method.request.querystring.a': true,
          'method.request.querystring.b': false,
        },
        RequestModels: {
          'application/json': 'PetModel',
          'text/plain': 'Empty',
        },
        RequestValidatorId: 'val-1',
        AuthorizationScopes: ['scope/a', 'scope/b'],
        Integration: {
          Type: 'HTTP',
          IntegrationHttpMethod: 'POST',
          Uri: 'https://example.com/pets',
          ConnectionType: 'VPC_LINK',
          ConnectionId: 'vpclink-1',
          Credentials: APIGW_ROLE,
          RequestParameters: {
            'integration.request.header.x': 'method.request.header.h',
            'integration.request.header.y': 'method.request.header.i',
          },
          RequestTemplates: { 'application/json': '{"a":1}', 'text/plain': 'a' },
          PassthroughBehavior: 'WHEN_NO_TEMPLATES',
          ContentHandling: 'CONVERT_TO_TEXT',
          TimeoutInMillis: 5000,
          CacheNamespace: 'ns',
          CacheKeyParameters: ['method.request.querystring.a', 'method.request.querystring.b'],
          // go-to-k/cdkd#5403: the ALB / NLB of a private integration.
          IntegrationTarget: `arn:aws:elasticloadbalancing:us-east-1:${ACCOUNT}:loadbalancer/app/alb/1`,
          ResponseTransferMode: 'STREAM',
          IntegrationResponses: [
            {
              StatusCode: '200',
              SelectionPattern: '2\\d{2}',
              ResponseParameters: { 'method.response.header.X': "'x'" },
              ResponseTemplates: { 'application/json': '{}' },
              ContentHandling: 'CONVERT_TO_TEXT',
            },
            {
              StatusCode: '400',
              SelectionPattern: '4\\d{2}',
              ResponseParameters: { 'method.response.header.Y': "'y'" },
              ResponseTemplates: { 'application/json': '{"e":1}' },
              ContentHandling: 'CONVERT_TO_BINARY',
            },
          ],
        },
        MethodResponses: [
          {
            StatusCode: '200',
            ResponseModels: { 'application/json': 'Empty' },
            ResponseParameters: { 'method.response.header.X': true },
          },
          {
            StatusCode: '400',
            ResponseModels: { 'application/json': 'Error' },
            ResponseParameters: { 'method.response.header.Y': false },
          },
        ],
      },
      expectedSilent: {
        'update-add:Integration.Type': APIGW_INTEGRATION_WITHOUT_TYPE,
        'update-remove:Integration.Type': APIGW_INTEGRATION_WITHOUT_TYPE,
      },
      expectedRemovalThrows: apigwRequired(
        ['RestApiId', 'ResourceId', 'HttpMethod'],
        '2318-2324',
        /RestApiId, ResourceId, and HttpMethod are required for API Gateway Method/
      ),
    },
  ],
};

const APIGW_CASES: TypeCase[] = [
  APIGW_ACCOUNT_CASE,
  APIGW_AUTHORIZER_CASE,
  APIGW_RESOURCE_CASE,
  APIGW_DEPLOYMENT_CASE,
  APIGW_STAGE_CASE,
  APIGW_METHOD_CASE,
];

// === CognitoUserPoolProvider =================================================

/**
 * The thirteenth batch's Cognito case (#3723): `CognitoUserPoolProvider`, which
 * handles `AWS::Cognito::UserPool` alone (`@aws-sdk/client-cognito-identity-provider`,
 * a client the provider builds itself, a create client among them).
 */

const COGNITO_SRC = 'cognito-provider.ts';
const COGNITO_POOL_ID = 'us-east-1_pool';
const COGNITO_FN = (name: string): string =>
  `arn:aws:lambda:us-east-1:${ACCOUNT}:function:${name}`;
const COGNITO_ROLE = `arn:aws:iam::${ACCOUNT}:role/sms`;

/**
 * The properties `UpdateUserPool` has no member for: `update()` refuses a
 * change to one before any call (cognito-provider.ts:3193-3216,
 * `createTimeOnlyChanges` at :408-440), as CloudFormation's handler does
 * ("Updates are not allowed for property", measured there). The schema lists
 * no create-only path for the type (:396-397), so the case marks them itself;
 * `describeCognitoExtras` pins each refusal.
 */
const COGNITO_CREATE_TIME_ONLY = [
  'UsernameAttributes',
  'AliasAttributes',
  'UsernameConfiguration',
];

const COGNITO_SMS_CONFIGURATION = {
  SnsCallerArn: COGNITO_ROLE,
  ExternalId: 'ext',
  SnsRegion: 'us-east-1',
};

const COGNITO_SCHEMA = [
  {
    Name: 'tenant',
    AttributeDataType: 'String',
    DeveloperOnlyAttribute: false,
    Mutable: true,
    Required: false,
    StringAttributeConstraints: { MinLength: '1', MaxLength: '64' },
  },
  {
    Name: 'level',
    AttributeDataType: 'Number',
    DeveloperOnlyAttribute: false,
    Mutable: true,
    Required: false,
    NumberAttributeConstraints: { MinValue: '0', MaxValue: '9' },
  },
];

const COGNITO_FULL: Bag = {
  UserPoolName: 'pool',
  AutoVerifiedAttributes: ['email', 'phone_number'],
  UsernameAttributes: ['email', 'phone_number'],
  UsernameConfiguration: { CaseSensitive: false },
  Policies: {
    PasswordPolicy: {
      MinimumLength: 12,
      PasswordHistorySize: 3,
      RequireLowercase: true,
      RequireNumbers: true,
      RequireSymbols: false,
      RequireUppercase: true,
      TemporaryPasswordValidityDays: 7,
    },
    SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD'] },
  },
  Schema: fresh(COGNITO_SCHEMA),
  LambdaConfig: {
    CreateAuthChallenge: COGNITO_FN('create-auth'),
    CustomEmailSender: { LambdaArn: COGNITO_FN('email-sender'), LambdaVersion: 'V1_0' },
    CustomMessage: COGNITO_FN('custom-message'),
    CustomSMSSender: { LambdaArn: COGNITO_FN('sms-sender'), LambdaVersion: 'V1_0' },
    DefineAuthChallenge: COGNITO_FN('define-auth'),
    InboundFederation: { LambdaArn: COGNITO_FN('federation'), LambdaVersion: 'V1_0' },
    KMSKeyID: `arn:aws:kms:us-east-1:${ACCOUNT}:key/k1`,
    PostAuthentication: COGNITO_FN('post-auth'),
    PostConfirmation: COGNITO_FN('post-confirm'),
    PreAuthentication: COGNITO_FN('pre-auth'),
    PreSignUp: COGNITO_FN('pre-sign-up'),
    PreTokenGeneration: COGNITO_FN('pre-token'),
    PreTokenGenerationConfig: { LambdaArn: COGNITO_FN('pre-token-v2'), LambdaVersion: 'V2_0' },
    UserMigration: COGNITO_FN('migration'),
    VerifyAuthChallengeResponse: COGNITO_FN('verify-auth'),
  },
  MfaConfiguration: 'ON',
  EnabledMfas: ['SMS_MFA', 'SOFTWARE_TOKEN_MFA', 'EMAIL_OTP'],
  WebAuthnRelyingPartyID: 'example.com',
  WebAuthnUserVerification: 'required',
  WebAuthnFactorConfiguration: 'SINGLE_FACTOR',
  UserPoolTags: { k1: 'v1', k2: 'v2' },
  AdminCreateUserConfig: {
    AllowAdminCreateUserOnly: true,
    InviteMessageTemplate: {
      EmailMessage: 'hi {username} {####}',
      EmailSubject: 'invite',
      SMSMessage: 'hi {username} {####}',
    },
    UnusedAccountValidityDays: 7,
  },
  AccountRecoverySetting: {
    RecoveryMechanisms: [
      { Name: 'verified_email', Priority: 1 },
      { Name: 'verified_phone_number', Priority: 2 },
    ],
  },
  UserAttributeUpdateSettings: {
    AttributesRequireVerificationBeforeUpdate: ['email', 'phone_number'],
  },
  DeletionProtection: 'ACTIVE',
  EmailConfiguration: {
    EmailSendingAccount: 'DEVELOPER',
    SourceArn: `arn:aws:ses:us-east-1:${ACCOUNT}:identity/example.com`,
    From: 'noreply@example.com',
    ReplyToEmailAddress: 'reply@example.com',
    ConfigurationSet: 'config-set',
  },
  SmsConfiguration: {
    ...fresh(COGNITO_SMS_CONFIGURATION),
    EumsSms: {
      CallerArn: COGNITO_ROLE,
      ConfigurationSetName: 'sms-set',
      ExternalId: 'eums-ext',
      InEntityId: 'entity',
      InTemplateId: 'template',
      OriginationIdentity: 'origin',
      Region: 'us-east-1',
    },
  },
  VerificationMessageTemplate: {
    DefaultEmailOption: 'CONFIRM_WITH_LINK',
    EmailMessage: 'code {####}',
    EmailMessageByLink: 'link {##Verify##}',
    EmailSubject: 'verify',
    EmailSubjectByLink: 'verify by link',
    SmsMessage: 'sms {####}',
  },
  DeviceConfiguration: {
    ChallengeRequiredOnNewDevice: true,
    DeviceOnlyRememberedOnUserPrompt: true,
  },
  UserPoolAddOns: {
    AdvancedSecurityMode: 'AUDIT',
    AdvancedSecurityAdditionalFlows: { CustomAuthMode: 'AUDIT' },
  },
  EmailVerificationMessage: 'verify {####}',
  EmailVerificationSubject: 'verify subject',
  SmsAuthenticationMessage: 'auth {####}',
  SmsVerificationMessage: 'sms verify {####}',
  UserPoolTier: 'PLUS',
};

const COGNITO_VARIANTS = {
  MfaConfiguration: 'OPTIONAL',
  DeletionProtection: 'INACTIVE',
  UserPoolTier: 'ESSENTIALS',
  WebAuthnFactorConfiguration: 'MULTI_FACTOR_WITH_USER_VERIFICATION',
};

/**
 * The Schema probes that throw: `update()` refuses any change to an existing
 * custom attribute (a removal, or a member added to or dropped from it) as
 * immutable, before `AddCustomAttributes` (cognito-provider.ts:3677-3708), and
 * a Schema entry without a `Name` (:3652-3665). Only an ADDED custom attribute
 * is applied in place, which `update-add:Schema` / `update-add:Schema.<i>`
 * observe.
 */
const COGNITO_SCHEMA_IMMUTABLE: Throw = {
  why: `update() refuses a changed or removed existing custom attribute as immutable, before any write (${COGNITO_SRC}:3677-3708)`,
  says: /is immutable on AWS/,
};
const COGNITO_SCHEMA_NAMELESS: Throw = {
  why: `update() refuses a Schema entry with no Name before any write (${COGNITO_SRC}:3652-3665)`,
  says: /has a Schema attribute with no Name/,
};

function cognitoSchemaThrows(): Record<string, Throw> {
  const out: Record<string, Throw> = {
    'update-remove:Schema': COGNITO_SCHEMA_IMMUTABLE,
  };
  COGNITO_SCHEMA.forEach((attr, i) => {
    out[`update-remove:Schema.${i}`] = COGNITO_SCHEMA_IMMUTABLE;
    for (const [member, value] of Object.entries(attr)) {
      const nested =
        value !== null && typeof value === 'object'
          ? Object.keys(value).map((k) => `${member}.${k}`)
          : [];
      for (const path of [member, ...nested]) {
        const throwOf = member === 'Name' ? COGNITO_SCHEMA_NAMELESS : COGNITO_SCHEMA_IMMUTABLE;
        out[`update-add:Schema.${i}.${path}`] = throwOf;
        out[`update-remove:Schema.${i}.${path}`] = throwOf;
      }
    }
  });
  return out;
}

/**
 * A constraint leaf's update-vary base drops the constraints block, so both
 * sides MODIFY an existing attribute, which `update()` refuses
 * (cognito-provider.ts:3677-3708): the value is observed by `create-vary`.
 */
function cognitoSchemaVarySilent(): Record<string, string> {
  const out: Record<string, string> = {};
  COGNITO_SCHEMA.forEach((attr, i) => {
    for (const [member, value] of Object.entries(attr)) {
      if (value === null || typeof value !== 'object') continue;
      for (const k of Object.keys(value)) {
        out[`update-vary:Schema.${i}.${member}.${k}`] =
          `the vary base drops ${member}, so both sides modify the existing attribute, which update() refuses before any write (${COGNITO_SRC}:3677-3708); create-vary observes the value`;
      }
    }
  });
  return out;
}

/** A removal both UpdateUserPool and CloudFormation keep (real CloudFormation A/B, #1160). */
const cognitoKept = (member: string): string =>
  `left in place on removal: UpdateUserPool keeps an omitted ${member} and CloudFormation keeps it on the same edit (real CloudFormation A/B, #1160), so update() only warns (${COGNITO_SRC}:516-527, 3034-3064)`;

const COGNITO_POLICIES_KEPT =
  `left in place on removal: UpdateUserPool keeps an omitted Policies sub-key and CloudFormation keeps it on the same edit (real CloudFormation A/B, #1979), so update() only warns (${COGNITO_SRC}:2009-2050, 3263-3269)`;

const COGNITO_NAME_KEPT =
  `a dropped UserPoolName sends no PoolName and the pool keeps its live name, which CloudFormation does on the same edit (measured, ${COGNITO_SRC}:3294-3301)`;

const COGNITO_MFA_WITH_FACTOR =
  `with an MFA factor still declared, SetUserPoolMfaConfig carries MfaConfiguration, built from the desired bag and defaulting a removed value (${COGNITO_SRC}:965-973); the turn-off arm reads the previous side only when no factor is left (${COGNITO_SRC}:3272-3279)`;

const USER_POOL_CASE: TypeCase = {
  resourceType: 'AWS::Cognito::UserPool',
  provider: () => new CognitoUserPoolProvider(),
  physicalId: COGNITO_POOL_ID,
  createOnly: new Set([...createOnlyOf('AWS::Cognito::UserPool'), ...COGNITO_CREATE_TIME_ONLY]),
  wholeFromNext: {
    keys: (key) => key !== 'UserPoolTags' && key !== 'MfaConfiguration' && key !== 'Schema',
    reason:
      `UpdateUserPool and SetUserPoolMfaConfig are built from the desired bag alone (${COGNITO_SRC}:3290-3409, 795-973); the previous side is read only to warn about a kept removal (${COGNITO_SRC}:3263-3270). So an omitted member is simply not sent. What AWS does on that omission is measured only for the members the provider's ledgers name (UpdateUserPool: AutoVerifiedAttributes, LambdaConfig, UserPoolAddOns, VerificationMessageTemplate, SmsAuthenticationMessage, DeviceConfiguration and AdminCreateUserConfig.AllowAdminCreateUserOnly reset, ${COGNITO_SRC}:2680-2696; SetUserPoolMfaConfig: MfaConfiguration and WebAuthnConfiguration.FactorConfiguration, ${COGNITO_SRC}:2715-2729), and a member CloudFormation keeps on removal is named in the bag's expectedSilent; for every other member (EnabledMfas, the WebAuthn relying party and verification, the email-OTP message and subject, AdminCreateUserConfig.InviteMessageTemplate / UnusedAccountValidityDays, the email / SMS verification messages, UserAttributeUpdateSettings: ${COGNITO_SRC}:120-151) both the omission and CloudFormation's removal are unmeasured`,
  },
  exempt: {},
  targets: [
    {
      path: ['UserPoolTags', 'k1'],
      command: 'UntagResourceCommand',
      names: '"k1"',
      notNames: '"k2"',
    },
    {
      path: ['UserPoolTags', 'k2'],
      command: 'UntagResourceCommand',
      names: '"k2"',
      notNames: '"k1"',
    },
  ],
  bags: [
    {
      name: 'every property, username attributes, MFA factors',
      bag: fresh(COGNITO_FULL),
      variants: COGNITO_VARIANTS,
      expectedSilent: {
        'update-remove:AccountRecoverySetting': cognitoKept('AccountRecoverySetting'),
        'update-remove:SmsConfiguration': cognitoKept('SmsConfiguration'),
        'update-remove:UserPoolTier': cognitoKept('UserPoolTier'),
        'update-remove:DeletionProtection': cognitoKept('DeletionProtection'),
        'update-remove:Policies': COGNITO_POLICIES_KEPT,
        'update-remove:Policies.PasswordPolicy': COGNITO_POLICIES_KEPT,
        'update-remove:Policies.SignInPolicy': COGNITO_POLICIES_KEPT,
        'update-remove:UserPoolName': COGNITO_NAME_KEPT,
        'update-remove:MfaConfiguration': COGNITO_MFA_WITH_FACTOR,
        ...cognitoSchemaVarySilent(),
      },
      expectedRemovalThrows: cognitoSchemaThrows(),
    },
    {
      name: 'alias attributes, MFA on UpdateUserPool',
      bag: {
        UserPoolName: 'pool',
        AliasAttributes: ['email', 'preferred_username'],
        AutoVerifiedAttributes: ['phone_number'],
        MfaConfiguration: 'ON',
        SmsConfiguration: fresh(COGNITO_SMS_CONFIGURATION),
      },
      variants: { MfaConfiguration: 'OPTIONAL' },
      expectedSilent: {
        'update-remove:SmsConfiguration': cognitoKept('SmsConfiguration'),
        'update-remove:UserPoolName': COGNITO_NAME_KEPT,
      },
    },
    {
      // The EmailMfaConfiguration block IS the email-OTP factor: a bare
      // message / subject sends it without EMAIL_OTP listed (cognito-provider.ts:872-887).
      name: 'email-OTP message and subject beside a software token',
      bag: {
        MfaConfiguration: 'ON',
        EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
        EmailAuthenticationMessage: 'code {####}',
        EmailAuthenticationSubject: 'your code',
      },
      variants: { MfaConfiguration: 'OPTIONAL' },
      expectedSilent: { 'update-remove:MfaConfiguration': COGNITO_MFA_WITH_FACTOR },
    },
  ],
};

const COGNITO_CASES: TypeCase[] = [USER_POOL_CASE];

/** Direct-call checks the bag probes cannot make. */
export function describeCognitoExtras(): void {
  describe('AWS::Cognito::UserPool create-time-only properties on update', () => {
    const bagWith = (member: string): Bag =>
      USER_POOL_CASE.bags.map((b) => b.bag).find((b) => member in b)!;
    const changed = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.slice(1);
      const obj = value as Bag;
      const key = Object.keys(obj)[0]!;
      return { ...obj, [key]: !(obj[key] as boolean) };
    };
    const refusal = async (member: string, next: Bag, prev: Bag): Promise<void> => {
      let thrown: unknown;
      setOutputOverrides(undefined);
      const outcome = await record(async () => {
        try {
          await new CognitoUserPoolProvider().update(
            'L',
            COGNITO_POOL_ID,
            'AWS::Cognito::UserPool',
            structuredClone(next),
            structuredClone(prev)
          );
        } catch (error) {
          thrown = error;
        }
      });
      expect(outcome).toEqual({ threw: false, wire: '' });
      expect(thrown).toBeInstanceOf(ResourceUpdateNotSupportedError);
      expect((thrown as Error).message).toContain(
        `${member} cannot be changed on an existing user pool`
      );
    };
    it.each(COGNITO_CREATE_TIME_ONLY)('refuses a changed %s and sends nothing', async (member) => {
      const bag = bagWith(member);
      await refusal(member, { ...bag, [member]: changed(bag[member]) }, bag);
    });
    it.each(COGNITO_CREATE_TIME_ONLY)('refuses a removed %s and sends nothing', async (member) => {
      const bag = bagWith(member);
      const { [member]: _omit, ...next } = bag;
      await refusal(member, next, bag);
    });
  });
}

// === S3BucketProvider ========================================================

/**
 * The thirteenth batch's S3 bucket cases (#3723): `AWS::S3::Bucket`, the one
 * type `S3BucketProvider` handles. The provider takes its shared client from
 * `getAwsClients().s3` and builds its own `CreateBucket` client, so
 * `sdk-wire-coverage-13.test.ts` mocks `@aws-sdk/client-s3` and answers an
 * `eu-west-1` client (outside us-east-1 `create()` sends no pre-flight). That
 * runner puts the bucket name and the `x-amz-*` member headers into the
 * captured request, which the top-level `ObjectLockEnabled` (a `CreateBucket`
 * header) and `LifecycleConfiguration.TransitionDefaultMinimumObjectSize` (a
 * lifecycle Put header) need.
 *
 * The update path diffs each sub-configuration (`applySubConfigDiffs`), so most
 * removals reach the wire as a `Delete*` or a reset; the silent ones are each
 * a documented CloudFormation parity or an invalid template.
 */

const S3_SRC = 's3-bucket-provider.ts';
const S3_REGION = 'eu-west-1';
const S3_BUCKET = 'bucket';
const S3_DEST_ARN = 'arn:aws:s3:::dest-bucket';
const S3_ALL_DIRECTIONS = ['create', 'update-add', 'update-remove'];

/**
 * The live bucket the bag describes: in this stack's region (the update's
 * `GetBucketLocation` region guard), Object Lock on when the bag declares it.
 * The create-retry module state (issue #4639) is reset per call, so a create
 * whose applier threw cannot hold a leftover for the next one.
 */
const s3Arm = (_physicalId: string, bag: Bag): void => {
  resetS3BucketCreateRetryStateForTests();
  const nested = bag['ObjectLockConfiguration'] as Record<string, unknown> | undefined;
  const locked = bag['ObjectLockEnabled'] === true || nested?.['ObjectLockEnabled'] === 'Enabled';
  setOutputOverrides({
    GetBucketLocationCommand: () => ({ LocationConstraint: S3_REGION }),
    GetObjectLockConfigurationCommand: () => ({
      ObjectLockConfiguration: locked ? { ObjectLockEnabled: 'Enabled' } : {},
    }),
  });
};

/** A declared collection emptied by the removal: CloudFormation refuses it, the provider skips. */
const s3EmptyCollection = (key: string, ab: string, at: string): string =>
  `removing the only entry leaves ${key} declaring an empty collection, which CloudFormation refuses as an invalid template rather than a removal (real CloudFormation A/B, ${ab}); the provider warns and leaves the live configuration in place (${S3_SRC}:${at})`;

/** A required rules list removed from its declared block: no deployable template does that. */
const s3RequiredList = (path: string): string =>
  `${path} is CloudFormation-required, so no deployable template declares the block without it; the provider warns and leaves the live configuration in place, as for an empty list (${S3_SRC}:5403-5422)`;

const S3_PAB_KEPT = `left in place on removal: PublicAccessBlockConfiguration is re-sent whole from the desired side on every update and never removed, because CloudFormation also leaves the block in place when the property is removed (real CloudFormation A/B, #1466; ${S3_SRC}:5551-5555, 4914-4919)`;

const S3_OBJECT_LOCK_TOP = `the top-level ObjectLockEnabled reaches S3 only through CreateBucket (${S3_SRC}:7164-7166): on an existing bucket update() writes nothing for it and only warns, as CloudFormation does (real CloudFormation A/B, go-to-k/cdkd#5395; ${S3_SRC}:7877-7950)`;

const S3_NESTED_LOCK_CONSTANT = `the provider always sends ObjectLockConfiguration.ObjectLockEnabled: 'Enabled', the only value the member takes, whether or not it is declared (${S3_SRC}:4767-4769); CloudFormation is unmeasured for an omitted member`;

const S3_VERSIONING_LOCKED = `suspending versioning is refused on an Object Lock bucket (this bag declares ObjectLockEnabled and the live bucket reads locked): the provider warns and leaves versioning enabled, since S3 does not allow suspending it there (${S3_SRC}:6205-6262); the 'versioning without object lock' bag observes the suspend`;

const S3_REPLICATION_DESTINATION: Throw = {
  why: `Destination is CloudFormation-required on a replication rule; with it absent the provider reads Bucket off the missing block and throws (a TypeError, not a refusal) before that configuration's call (${S3_SRC}:4629, 4510)`,
  says: /Cannot read properties of undefined \(reading 'Bucket'\)/,
};

const S3_NO_DESTINATION_BUCKET = (what: string): Throw => ({
  why: `${what} Destination.BucketArn is required by CloudFormation and by S3; without it the provider refuses the item before that configuration's call (${S3_SRC}:3818-3825)`,
  says: /has no destination bucket \(BucketArn\)/,
});

const FULL: Bag = {
  BucketName: S3_BUCKET,
  ObjectLockEnabled: true,
  VersioningConfiguration: { Status: 'Enabled' },
  Tags: [
    { Key: 'tk1', Value: 'tv1' },
    { Key: 'tk2', Value: 'tv2' },
  ],
  OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
  PublicAccessBlockConfiguration: {
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  },
  BucketEncryption: {
    ServerSideEncryptionConfiguration: [
      {
        ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: 'key-1' },
        BucketKeyEnabled: true,
        BlockedEncryptionTypes: { EncryptionType: ['SSE-C'] },
      },
    ],
  },
  CorsConfiguration: {
    CorsRules: [
      {
        Id: 'cors1',
        AllowedHeaders: ['h1'],
        AllowedMethods: ['GET'],
        AllowedOrigins: ['https://a.example'],
        ExposedHeaders: ['e1'],
        MaxAge: 300,
      },
    ],
  },
  LifecycleConfiguration: {
    TransitionDefaultMinimumObjectSize: 'all_storage_classes_128K',
    Rules: [
      {
        Id: 'lc1',
        Status: 'Disabled',
        Prefix: 'p1/',
        ExpirationInDays: 400,
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
        NoncurrentVersionExpiration: { NoncurrentDays: 60, NewerNoncurrentVersions: 2 },
        Transitions: [{ StorageClass: 'GLACIER', TransitionInDays: 90 }],
        NoncurrentVersionTransitions: [
          { StorageClass: 'GLACIER', TransitionInDays: 30, NewerNoncurrentVersions: 1 },
        ],
        ObjectSizeGreaterThan: 100,
        ObjectSizeLessThan: 10000,
      },
      {
        Id: 'lc2',
        Status: 'Disabled',
        TagFilters: [{ Key: 'lk', Value: 'lv' }],
        ExpirationDate: '2031-01-01T00:00:00.000Z',
        Transition: { StorageClass: 'GLACIER', TransitionDate: '2030-01-01T00:00:00.000Z' },
        NoncurrentVersionTransition: {
          StorageClass: 'STANDARD_IA',
          TransitionInDays: 45,
          NewerNoncurrentVersions: 3,
        },
        NoncurrentVersionExpirationInDays: 120,
      },
      {
        Id: 'lc3',
        Status: 'Disabled',
        ExpiredObjectDeleteMarker: true,
        Transition: { StorageClass: 'GLACIER', TransitionInDays: 60 },
      },
      {
        Id: 'lc4',
        Status: 'Disabled',
        Transitions: [{ StorageClass: 'DEEP_ARCHIVE', TransitionDate: '2032-01-01T00:00:00.000Z' }],
      },
    ],
  },
  LoggingConfiguration: {
    DestinationBucketName: 'log-bucket',
    LogFilePrefix: 'logs/',
    TargetObjectKeyFormat: { PartitionedPrefix: { PartitionDateSource: 'EventTime' } },
  },
  WebsiteConfiguration: {
    IndexDocument: 'index.html',
    ErrorDocument: 'error.html',
    RoutingRules: [
      {
        RedirectRule: {
          HostName: 'h.example',
          HttpRedirectCode: '301',
          Protocol: 'https',
          ReplaceKeyPrefixWith: 'new/',
        },
        RoutingRuleCondition: { HttpErrorCodeReturnedEquals: '404', KeyPrefixEquals: 'old/' },
      },
      {
        RedirectRule: { ReplaceKeyWith: 'k.html' },
        RoutingRuleCondition: { KeyPrefixEquals: 'x/' },
      },
    ],
  },
  AccelerateConfiguration: { AccelerationStatus: 'Enabled' },
  NotificationConfiguration: {
    EventBridgeConfiguration: { EventBridgeEnabled: true },
    LambdaConfigurations: [
      {
        Event: 's3:ObjectCreated:*',
        Function: `arn:aws:lambda:${S3_REGION}:${ACCOUNT}:function:f`,
        Filter: { S3Key: { Rules: [{ Name: 'prefix', Value: 'l/' }] } },
      },
    ],
    QueueConfigurations: [
      {
        Event: 's3:ObjectRemoved:*',
        Queue: `arn:aws:sqs:${S3_REGION}:${ACCOUNT}:q`,
        Filter: { S3Key: { Rules: [{ Name: 'suffix', Value: '.q' }] } },
      },
    ],
    TopicConfigurations: [
      {
        Event: 's3:ObjectRestore:*',
        Topic: `arn:aws:sns:${S3_REGION}:${ACCOUNT}:t`,
        Filter: { S3Key: { Rules: [{ Name: 'prefix', Value: 't/' }] } },
      },
    ],
  },
  ReplicationConfiguration: {
    Role: `arn:aws:iam::${ACCOUNT}:role/repl`,
    Rules: [
      {
        Id: 'r1',
        Priority: 1,
        Status: 'Disabled',
        Filter: { Prefix: 'a/' },
        DeleteMarkerReplication: { Status: 'Enabled' },
        Destination: {
          Bucket: S3_DEST_ARN,
          Account: '210987654321',
          StorageClass: 'STANDARD_IA',
          AccessControlTranslation: { Owner: 'Destination' },
          EncryptionConfiguration: { ReplicaKmsKeyID: 'replica-key' },
          Metrics: { Status: 'Enabled', EventThreshold: { Minutes: 15 } },
          ReplicationTime: { Status: 'Enabled', Time: { Minutes: 15 } },
        },
        SourceSelectionCriteria: {
          ReplicaModifications: { Status: 'Enabled' },
          SseKmsEncryptedObjects: { Status: 'Enabled' },
        },
      },
      {
        Id: 'r2',
        Priority: 2,
        Status: 'Disabled',
        Filter: { TagFilter: { Key: 'rk', Value: 'rv' } },
        DeleteMarkerReplication: { Status: 'Disabled' },
        Destination: { Bucket: S3_DEST_ARN },
      },
      {
        Id: 'r3',
        Priority: 3,
        Status: 'Disabled',
        Filter: { And: { Prefix: 'b/', TagFilters: [{ Key: 'ak', Value: 'av' }] } },
        DeleteMarkerReplication: { Status: 'Disabled' },
        Destination: { Bucket: S3_DEST_ARN },
      },
    ],
  },
  ObjectLockConfiguration: {
    ObjectLockEnabled: 'Enabled',
    Rule: {
      DefaultRetention: { Mode: 'GOVERNANCE', Days: 1, DefaultEventHold: { Days: 2 } },
    },
  },
  MetricsConfigurations: [
    {
      Id: 'm1',
      Prefix: 'mp/',
      TagFilters: [{ Key: 'mk', Value: 'mv' }],
      AccessPointArn: `arn:aws:s3:${S3_REGION}:${ACCOUNT}:accesspoint/ap`,
    },
    { Id: 'm2', Prefix: 'mq/' },
  ],
  AnalyticsConfigurations: [
    {
      Id: 'a1',
      Prefix: 'ap/',
      TagFilters: [{ Key: 'ank', Value: 'anv' }],
      StorageClassAnalysis: {
        DataExport: {
          OutputSchemaVersion: 'V_1',
          Destination: {
            BucketArn: S3_DEST_ARN,
            BucketAccountId: ACCOUNT,
            Format: 'CSV',
            Prefix: 'an/',
          },
        },
      },
    },
    { Id: 'a2', StorageClassAnalysis: {} },
  ],
  IntelligentTieringConfigurations: [
    {
      Id: 'it1',
      Status: 'Disabled',
      Prefix: 'itp/',
      TagFilters: [{ Key: 'itk', Value: 'itv' }],
      Tierings: [{ AccessTier: 'ARCHIVE_ACCESS', Days: 90 }],
    },
    {
      Id: 'it2',
      Status: 'Disabled',
      Tierings: [{ AccessTier: 'DEEP_ARCHIVE_ACCESS', Days: 180 }],
    },
  ],
  InventoryConfigurations: [
    {
      Id: 'inv1',
      Enabled: false,
      IncludedObjectVersions: 'Current',
      ScheduleFrequency: 'Daily',
      Prefix: 'ip/',
      OptionalFields: ['Size', 'ETag'],
      Destination: {
        BucketArn: S3_DEST_ARN,
        BucketAccountId: ACCOUNT,
        Format: 'ORC',
        Prefix: 'inv/',
      },
    },
    {
      Id: 'inv2',
      Enabled: false,
      IncludedObjectVersions: 'Current',
      ScheduleFrequency: 'Daily',
      Destination: { BucketArn: S3_DEST_ARN, Format: 'Parquet' },
    },
  ],
};

/** The shapes FULL cannot carry beside its own: each is exclusive of a FULL sibling. */
const ALT: Bag = {
  BucketName: S3_BUCKET,
  LoggingConfiguration: {
    DestinationBucketName: 'log-bucket',
    TargetObjectKeyFormat: { SimplePrefix: {} },
  },
  WebsiteConfiguration: {
    RedirectAllRequestsTo: { HostName: 'r.example', Protocol: 'https' },
  },
  ObjectLockConfiguration: {
    ObjectLockEnabled: 'Enabled',
    Rule: {
      DefaultRetention: { Mode: 'COMPLIANCE', Years: 1, DefaultEventHold: { Years: 1 } },
    },
  },
  ReplicationConfiguration: {
    Role: `arn:aws:iam::${ACCOUNT}:role/repl`,
    Rules: [
      { Id: 'legacy', Prefix: 'l/', Status: 'Disabled', Destination: { Bucket: S3_DEST_ARN } },
    ],
  },
};

/** The nested-lock constant's three probes, on every bag declaring the block. */
const S3_NESTED_LOCK_SILENT = {
  'create:ObjectLockConfiguration.ObjectLockEnabled': S3_NESTED_LOCK_CONSTANT,
  'create-vary:ObjectLockConfiguration.ObjectLockEnabled': S3_NESTED_LOCK_CONSTANT,
  'update-vary:ObjectLockConfiguration.ObjectLockEnabled': S3_NESTED_LOCK_CONSTANT,
};

/** Removing element 0 of a two-element list sends one Put / Delete naming only what it must. */
const s3Target = (
  path: (string | number)[],
  command: string,
  names: string,
  notNames: string
): TypeCase['targets'][number] => ({ path, command, names, notNames });

// --- AWS::S3::Bucket -----------------------------------------------------------

const BUCKET_CASE: TypeCase = {
  resourceType: 'AWS::S3::Bucket',
  provider: () => new S3BucketProvider(),
  physicalId: S3_BUCKET,
  createOnly: createOnlyOf('AWS::S3::Bucket'),
  arm: s3Arm,
  wholeFromNext: { keys: (key) => key === 'PublicAccessBlockConfiguration', reason: S3_PAB_KEPT },
  exempt: {},
  targets: [
    // PutBucketTagging replaces the whole set with the remaining tag.
    s3Target(['Tags', 0], 'PutBucketTaggingCommand', '<Key>tk2</Key>', '<Key>tk1</Key>'),
    s3Target(['Tags', 1], 'PutBucketTaggingCommand', '<Key>tk1</Key>', '<Key>tk2</Key>'),
    // The per-Id configurations delete the removed Id only (in the query).
    s3Target(['MetricsConfigurations', 0], 'DeleteBucketMetricsConfigurationCommand', '"m1"', '"m2"'),
    s3Target(['MetricsConfigurations', 1], 'DeleteBucketMetricsConfigurationCommand', '"m2"', '"m1"'),
    s3Target(
      ['AnalyticsConfigurations', 0],
      'DeleteBucketAnalyticsConfigurationCommand',
      '"a1"',
      '"a2"'
    ),
    s3Target(
      ['AnalyticsConfigurations', 1],
      'DeleteBucketAnalyticsConfigurationCommand',
      '"a2"',
      '"a1"'
    ),
    s3Target(
      ['IntelligentTieringConfigurations', 0],
      'DeleteBucketIntelligentTieringConfigurationCommand',
      '"it1"',
      '"it2"'
    ),
    s3Target(
      ['IntelligentTieringConfigurations', 1],
      'DeleteBucketIntelligentTieringConfigurationCommand',
      '"it2"',
      '"it1"'
    ),
    s3Target(
      ['InventoryConfigurations', 0],
      'DeleteBucketInventoryConfigurationCommand',
      '"inv1"',
      '"inv2"'
    ),
    s3Target(
      ['InventoryConfigurations', 1],
      'DeleteBucketInventoryConfigurationCommand',
      '"inv2"',
      '"inv1"'
    ),
    // The lifecycle and replication Puts replace every rule with the remaining ones.
    s3Target(
      ['LifecycleConfiguration', 'Rules', 0],
      'PutBucketLifecycleConfigurationCommand',
      '<ID>lc2</ID>',
      '<ID>lc1</ID>'
    ),
    s3Target(
      ['ReplicationConfiguration', 'Rules', 0],
      'PutBucketReplicationCommand',
      '<ID>r2</ID>',
      '<ID>r1</ID>'
    ),
  ],
  bags: [
    {
      name: 'every property',
      bag: fresh(FULL),
      variants: {
        'LifecycleConfiguration.Rules.1.ExpirationDate': '2031-06-01T00:00:00.000Z',
        'LifecycleConfiguration.Rules.1.Transition.TransitionDate': '2030-06-01T00:00:00.000Z',
        'LifecycleConfiguration.Rules.3.Transitions.0.TransitionDate': '2032-06-01T00:00:00.000Z',
      },
      expectedSilent: {
        'update-add:ObjectLockEnabled': S3_OBJECT_LOCK_TOP,
        'update-remove:ObjectLockEnabled': S3_OBJECT_LOCK_TOP,
        'update-vary:ObjectLockEnabled': S3_OBJECT_LOCK_TOP,
        ...S3_NESTED_LOCK_SILENT,
        'update-remove:VersioningConfiguration': S3_VERSIONING_LOCKED,
        'update-remove:VersioningConfiguration.Status': S3_VERSIONING_LOCKED,
        'update-remove:BucketEncryption.ServerSideEncryptionConfiguration.0': s3EmptyCollection(
          'BucketEncryption.ServerSideEncryptionConfiguration',
          '#1713',
          '5048-5056, 5403-5422'
        ),
        'update-remove:OwnershipControls.Rules.0': s3EmptyCollection(
          'OwnershipControls.Rules',
          '#1713',
          '5048-5056, 5403-5422'
        ),
        'update-remove:CorsConfiguration.CorsRules': s3RequiredList('CorsConfiguration.CorsRules'),
        'update-remove:CorsConfiguration.CorsRules.0': s3EmptyCollection(
          'CorsConfiguration.CorsRules',
          '#1671',
          '5361-5375, 5403-5422'
        ),
        'update-remove:LifecycleConfiguration.Rules': s3RequiredList('LifecycleConfiguration.Rules'),
        'create:NotificationConfiguration.EventBridgeConfiguration.EventBridgeEnabled': `EventBridgeEnabled is CloudFormation-required, so no deployable template removes it; a declared block without it reads as enabled, which this bag declares (${S3_SRC}:683-688)`,
        'create:AnalyticsConfigurations.0.StorageClassAnalysis.DataExport.OutputSchemaVersion': `OutputSchemaVersion is CloudFormation-required and takes one value, V_1, which the provider sends when it is absent (${S3_SRC}:4003-4009)`,
        'create:AnalyticsConfigurations.0.StorageClassAnalysis.DataExport.Destination.Format': `Destination.Format is CloudFormation-required, and an analytics export takes only CSV, which the provider sends when it is absent (${S3_SRC}:4024-4029)`,
        'create:AnalyticsConfigurations.1.StorageClassAnalysis': `StorageClassAnalysis is CloudFormation-required, and the empty block this item declares is what the provider sends when it is absent (${S3_SRC}:3898-3901)`,
      },
      expectedRemovalThrows: {
        ...TAG_THROWS(S3_ALL_DIRECTIONS, 2),
        ...Object.fromEntries(
          [0, 1, 2].flatMap((i) => [
            [`create:ReplicationConfiguration.Rules.${i}.Destination`, S3_REPLICATION_DESTINATION],
            [
              `update-remove:ReplicationConfiguration.Rules.${i}.Destination`,
              S3_REPLICATION_DESTINATION,
            ],
          ])
        ),
        ...Object.fromEntries(
          ['create', 'update-remove'].flatMap((d) => [
            [
              `${d}:AnalyticsConfigurations.0.StorageClassAnalysis.DataExport.Destination.BucketArn`,
              S3_NO_DESTINATION_BUCKET('An analytics export'),
            ],
            [
              `${d}:InventoryConfigurations.0.Destination.BucketArn`,
              S3_NO_DESTINATION_BUCKET('An inventory'),
            ],
            [
              `${d}:InventoryConfigurations.1.Destination.BucketArn`,
              S3_NO_DESTINATION_BUCKET('An inventory'),
            ],
          ])
        ),
      },
    },
    {
      // No Object Lock declared, so removing the versioning block suspends it.
      name: 'versioning without object lock',
      bag: { BucketName: S3_BUCKET, VersioningConfiguration: { Status: 'Enabled' } },
    },
    {
      name: 'the alternative shapes',
      bag: fresh(ALT),
      expectedSilent: { ...S3_NESTED_LOCK_SILENT },
      expectedRemovalThrows: {
        'create:ReplicationConfiguration.Rules.0.Destination': S3_REPLICATION_DESTINATION,
        'update-remove:ReplicationConfiguration.Rules.0.Destination': S3_REPLICATION_DESTINATION,
      },
    },
  ],
};

const S3_CASES: TypeCase[] = [BUCKET_CASE];

// === NestedStackProvider ===================================================
//
// The provider makes no SDK call of its own: `create()` / `update()` read the
// child template from `ctx.nestedTemplates[logicalId]` and deploy it through a
// child `DeployEngine` (nested-stack-provider.ts:292-327, :406-442), handing it
// `Parameters` as `DeployEngineOptions.parameters` (:954). So the wire a
// `Parameters` member reaches is the CHILD's resources' SDK calls. The case runs
// the REAL child engine (real `DagBuilder` / `DiffCalculator`, an in-memory
// state backend) over a one-topic child template whose `DisplayName` and tag
// value are `Ref`s to two child parameters: a dropped parameter falls back to
// its child `Default` and the topic's `CreateTopic` / `SetTopicAttributes` /
// `TagResource` request changes.

const NESTED_LOGICAL_ID = 'L';
const NESTED_PARENT = 'Parent';
const NESTED_CHILD_STACK = `${NESTED_PARENT}~${NESTED_LOGICAL_ID}`;
// The name the child engine generates for the topic (stack, logical id, instance id).
const NESTED_TOPIC_ARN = `arn:aws:sns:${REGION}:${ACCOUNT}:Parent-L-Topic-b664773b1b8f`;
const NESTED_STACK_INSTANCE_ID = '00000000-0000-4000-8000-000000000000';
const NESTED_DEFAULTS = { Display: 'display-default', TagValue: 'tag-default' };

const NESTED_CHILD_TEMPLATE = {
  Parameters: {
    Display: { Type: 'String', Default: NESTED_DEFAULTS.Display },
    TagValue: { Type: 'String', Default: NESTED_DEFAULTS.TagValue },
  },
  Resources: {
    Topic: {
      Type: 'AWS::SNS::Topic',
      Properties: {
        DisplayName: { Ref: 'Display' },
        Tags: [{ Key: 'k', Value: { Ref: 'TagValue' } }],
      },
    },
  },
};

const NESTED_TEMPLATE_PATH = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-wire-nested-'));
  const file = join(dir, 'child.nested.template.json');
  writeFileSync(file, JSON.stringify(NESTED_CHILD_TEMPLATE));
  return file;
})();

/** The child's state.json, keyed by stack name; `arm` seeds it per call. */
const nestedStates = new Map<string, StackState>();

/**
 * The child record a deploy of `bag` leaves: the topic as the child engine
 * resolves it from `bag`'s `Parameters` (each absent one at its `Default`).
 */
function nestedChildState(bag: Bag): StackState {
  const params = (bag['Parameters'] ?? {}) as Record<string, unknown>;
  // The provider's own coercion (nested-stack-provider.ts:1344-1354): a
  // number to its string, a list joined with `,`.
  const wireValue = (v: unknown, dflt: string): string =>
    v === undefined ? dflt : Array.isArray(v) ? v.map(String).join(',') : String(v);
  const properties = {
    DisplayName: wireValue(params['Display'], NESTED_DEFAULTS.Display),
    Tags: [{ Key: 'k', Value: wireValue(params['TagValue'], NESTED_DEFAULTS.TagValue) }],
  };
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    region: REGION,
    stackName: NESTED_CHILD_STACK,
    outputs: {},
    lastModified: 0,
    stackInstanceId: NESTED_STACK_INSTANCE_ID,
    resources: {
      Topic: {
        physicalId: NESTED_TOPIC_ARN,
        resourceType: 'AWS::SNS::Topic',
        properties,
        observedProperties: properties,
        attributes: {},
        dependencies: [],
      },
    },
  } as StackState;
}

/**
 * Before each provider call: the child's state is what deploying the
 * PREVIOUS bag left (none on a create), so an update's child diff runs
 * against the live child as the harness intends.
 */
function armNestedChild(_physicalId: string, bag: Bag): void {
  nestedStates.clear();
  if (Object.keys(bag).length > 0) {
    nestedStates.set(NESTED_CHILD_STACK, nestedChildState(bag));
    setOutputOverrides(undefined);
    return;
  }
  // No child yet: the generated topic name is free (the create's name probe).
  setOutputOverrides({
    GetTopicAttributesCommand: () => {
      throw new NotFoundException({ message: 'Topic does not exist', $metadata: {} });
    },
  });
}

/** An in-memory state backend: get / save hold the child state, the rest answers nothing. */
const nestedStateBackend = new Proxy(
  {
    getState: async (stackName: string) => {
      const state = nestedStates.get(stackName);
      return state ? { state: structuredClone(state), etag: 'e' } : null;
    },
    // A first write mints the child's instance id; a fixed one keeps it deterministic.
    stackInstanceIdForFirstWrite: async () => NESTED_STACK_INSTANCE_ID,
    saveState: async (stackName: string, _region: string, state: StackState) => {
      nestedStates.set(stackName, structuredClone(state));
      return 'e';
    },
  } as Record<string, unknown>,
  {
    get: (target, key) =>
      key in target ? target[key as string] : typeof key === 'string' ? async () => null : undefined,
  }
);

function nestedContext(topicProvider: SNSTopicProvider): NestedStackProviderContext {
  return {
    stateBackend: nestedStateBackend as never,
    lockManager: {
      acquireLockWithRetry: async () => true,
      releaseLock: async () => undefined,
    } as never,
    providerRegistry: {
      getProvider: () => topicProvider,
      getProviderFor: () => ({ provider: topicProvider, provisionedBy: 'sdk' }),
      getRegisteredTypes: () => ['AWS::SNS::Topic'],
      validateResourceTypes: () => undefined,
      validateResourceProperties: () => undefined,
    } as never,
    parentStackName: NESTED_PARENT,
    parentRegion: REGION,
    accountId: ACCOUNT,
    awsClients: {} as never,
    stateBucket: 'state-bucket',
    nestedTemplates: { [NESTED_LOGICAL_ID]: NESTED_TEMPLATE_PATH },
    dagBuilder: new DagBuilder(),
    diffCalculator: new DiffCalculator(),
    options: { dryRun: false },
  };
}

/**
 * The real provider, its create / update run inside the nested-stack context
 * the deploy entry point binds around them (`withNestedStackContext`).
 */
function nestedProvider(): ResourceProvider {
  const p = new NestedStackProvider();
  const ctx = nestedContext(new SNSTopicProvider());
  const create = p.create.bind(p);
  const update = p.update.bind(p);
  p.create = (...args) => withNestedStackContext(ctx, () => create(...args));
  p.update = (...args) => withNestedStackContext(ctx, () => update(...args));
  return p;
}

const NESTED_TEMPLATE_URL_SILENT =
  'TemplateURL is informational: the child template is read from the local ' +
  "Metadata['aws:asset:path'] file in ctx.nestedTemplates (nested-stack-provider.ts:213-216, " +
  ':292, :406), never from the URL; a changed URL is only what makes the parent diff call update()';

const NESTED_TEMPLATE_URL_SILENTS = Object.fromEntries(
  ['create', 'update-add', 'update-remove', 'create-vary', 'update-vary'].map((d) => [
    `${d}:TemplateURL`,
    NESTED_TEMPLATE_URL_SILENT,
  ])
);

const NESTED_CASES: TypeCase[] = [
  {
    resourceType: 'AWS::CloudFormation::Stack',
    provider: nestedProvider,
    physicalId: `arn:cdkd-local:${REGION}:${ACCOUNT}:nested-stack/${NESTED_PARENT}/${NESTED_LOGICAL_ID}`,
    createOnly: createOnlyOf('AWS::CloudFormation::Stack'),
    arm: armNestedChild,
    exempt: {},
    targets: [],
    bags: [
      {
        name: 'every declared property',
        bag: fresh({
          TemplateURL: 'https://s3.us-east-1.amazonaws.com/assets/child.nested.template.json',
          Parameters: { Display: 'display-v', TagValue: 'tag-v' },
        }),
        expectedSilent: NESTED_TEMPLATE_URL_SILENTS,
      },
      {
        // A number is stringified and a list-typed value joined with `,`
        // (nested-stack-provider.ts:1344-1354): each element reaches the wire.
        name: 'number and list parameter values',
        bag: fresh({
          TemplateURL: 'https://s3.us-east-1.amazonaws.com/assets/child.nested.template.json',
          Parameters: { Display: 42, TagValue: ['a', 'b'] },
        }),
        expectedSilent: NESTED_TEMPLATE_URL_SILENTS,
      },
    ],
  },
];

export const CASES_13: TypeCase[] = [
  ...APIGW_CASES,
  ...COGNITO_CASES,
  ...S3_CASES,
  ...NESTED_CASES,
];
